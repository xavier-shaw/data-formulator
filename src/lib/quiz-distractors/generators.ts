// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/generators.ts — look-alike generation on two axes.
 *
 * This module implements docs/quiz-distractor-framework.md (design v6). A
 * chart leaves two separable memories, and each lure targets one — or, in a
 * combined lure, both at once:
 *
 *  VISUAL    keep the underlying data; change the visual representation.
 *            The finding stays the same. The lure tests whether the
 *            participant remembers the TOOL they used to get the finding.
 *
 *  DATA      keep the visual representation; change what the data says.
 *            The finding becomes different. The lure tests whether the
 *            participant remembers the FINDING itself. Every data lure
 *            attacks one message dimension: direction, location, existence,
 *            or strength (see messageOps.ts).
 *
 *  COMBINED  a visual lure's drawing over a data lure's rows. It fills the
 *            cross cells of the option matrix (see select.ts): a participant
 *            who picks one encoded neither the tool nor the finding.
 *
 * The transformations are CURATED per chart type (curated.ts): each type
 * declares its typical mark transitions and its message operators, as the v3
 * design did. The machinery below stays as a backstop: plausibility gates,
 * the same-fields check, the compile probe, and the purity contract prune a
 * curated pair that does not fit this chart's data.
 *
 * Purity is enforced, not just intended: `enforcePurity` drops (with a console
 * warning) any visual candidate whose rows changed, any data candidate whose
 * drawing changed, and any combined candidate that failed to change both.
 *
 * Every candidate compiles through the app's own assembler, so lures are
 * visually in-distribution with the charts participants actually saw.
 */

import {
    ChartLevelSpec, FieldMeta, SessionChart, SessionData,
    cloneSpec, compiles, isQuantitative, specSignature,
} from './extract';
import { SpecEdit, EDIT_COSTS, markTransitionCost } from './distance';
import {
    DataDim, MESSAGE_OPS, resolveRoles, messageMetrics,
    sortedAxis, preserveSortedProfile, takeawaySignature,
} from './messageOps';
import { vlAdaptChart } from '../agents-chart';
import { curatedFor } from './curated';

export type Method = 'visual' | 'data' | 'combined';
export type VisualBand = 'near' | 'mid' | 'far';

export interface DistractorCandidate {
    method: Method;
    /** the specific operation: 'mark' on the visual axis, the operator id on the data axis */
    op: string;
    label: string;
    rationale: string;
    spec: ChartLevelSpec;
    rows: any[];
    metadata: Record<string, FieldMeta>;
    /** data lures: the message dimension the operator attacks */
    dim?: DataDim;
    /** visual lures: how far the representation moved (framework band) */
    band?: VisualBand;
    /** data lures: a short story signature — two lures with the same one tell the same story */
    signature?: string;
    /** set when rows differ from the original chart's rows */
    dataEditNote?: string;
    /** flags a lure that needs special quiz phrasing */
    caveat?: string;
    /**
     * Edits a spec diff cannot recover (see distance.ts mergeEdits).
     * Without these, config-carried lures score (0, 0) on the spec axis.
     */
    declaredEdits?: SpecEdit[];
}

// ── shared helpers ───────────────────────────────────────────────────────

/** channel that carries the measure (quantitative) vs the category */
export function chartRoles(chart: SessionChart): { measureCh?: string; measure?: string; categoryCh?: string; category?: string; colorField?: string } {
    const enc = chart.spec.encodings;
    let measureCh: string | undefined, categoryCh: string | undefined;
    for (const ch of ['y', 'x']) {
        const f = enc[ch]?.field;
        if (!f) continue;
        if (isQuantitative(f, chart.metadata) && !measureCh) { measureCh = ch; continue; }
        if (!categoryCh) categoryCh = ch;
    }
    // fallback: two quantitative axes → x is category-ish
    if (!categoryCh && enc.x && measureCh !== 'x') categoryCh = 'x';
    return {
        measureCh, measure: measureCh ? enc[measureCh].field : undefined,
        categoryCh, category: categoryCh ? enc[categoryCh].field : undefined,
        colorField: enc.color?.field ?? enc.group?.field,
    };
}

/** encodings as channel→field map (for vlAdaptChart and purity checks) */
function encFieldMap(spec: ChartLevelSpec): Record<string, string> {
    return Object.fromEntries(Object.entries(spec.encodings).map(([ch, e]) => [ch, e.field]));
}

function fromFieldMap(chartType: string, m: Record<string, string>, config?: Record<string, any>): ChartLevelSpec {
    const encodings: ChartLevelSpec['encodings'] = {};
    for (const [ch, f] of Object.entries(m)) if (f) encodings[ch] = { field: f };
    return { chartType, encodings, config: config ?? {} };
}

function semanticTypeMap(metadata: Record<string, FieldMeta>): Record<string, string> {
    return Object.fromEntries(Object.entries(metadata).map(([f, m]) => [f, m.semanticType]));
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

// ═════════════════════════════════════════════════════════════════════════
// Visual perturbation — the admissible-target tables
// ═════════════════════════════════════════════════════════════════════════

/**
 * Gate predicates, evaluated against the SOURCE chart's data semantics (the
 * framework's source-anchored rule). A gate that fails prunes the target.
 */
type GateId = 'nonNeg' | 'maxCats8' | 'maxCats6' | 'multiSeries';

function categoryValues(chart: SessionChart): any[] {
    const { category } = chartRoles(chart);
    return category ? uniq(chart.rows.map(r => r[category])) : [];
}

/** Does this field carry its own order (dates, years, binned ranges)? */
function fieldIsOrdered(field: string, chart: SessionChart): boolean {
    if (chart.metadata[field]?.type !== 'string') return true;
    const vals = chart.rows.map(r => String(r[field]));
    return vals.length > 0 && vals.every(v => /^\s*[-+]?\d/.test(v));
}

/**
 * Gates on the DATA. These read the source chart only, so they are the
 * framework's source-anchored gates.
 */
const GATES: Record<GateId, { test: (chart: SessionChart) => boolean; text: string }> = {
    nonNeg: {
        test: (chart) => {
            const { measure } = chartRoles(chart);
            if (!measure) return false;
            return chart.rows.every(r => Number(r[measure]) >= 0 || !Number.isFinite(Number(r[measure])));
        },
        text: 'the values must not be negative (the target chart needs a meaningful sum or baseline)',
    },
    maxCats8: {
        test: (chart) => categoryValues(chart).length > 0 && categoryValues(chart).length <= 8,
        text: 'a radial chart with more than 8 sectors is a pile of overlapping labels',
    },
    // No lower bound, unlike the radial gate above. A radial chart needs a
    // category to divide into sectors, but an overlay does not: a chart with
    // no category simply draws one shape. Requiring one refused the
    // Histogram → Density Plot pair, which is the doc's canonical near pair,
    // while leaving Density Plot → Histogram admissible — an asymmetry that
    // only showed up in the gallery counts.
    maxCats6: {
        test: (chart) => categoryValues(chart).length <= 6,
        text: 'an overlay of more than 6 shapes is not readable',
    },
    multiSeries: {
        test: (chart) => {
            const { colorField, category } = chartRoles(chart);
            return !!colorField && colorField !== category
                && uniq(chart.rows.map(r => r[colorField])).length >= 2;
        },
        text: 'the target chart needs more than one series',
    },
};

/**
 * Gates on the TARGET'S OWN X AXIS, checked after the adaptation.
 *
 * These cannot be source-anchored, and that is not a violation of the
 * framework's rule — it is the same rule read correctly. `orderedCat` asks
 * "does the chart this lure produces draw a trend over an unordered domain?",
 * and only the adapted encoding says which field the target puts on x. A Bar
 * Table carries its measure on x and its labels on y, so a source-anchored
 * reading passed a Regression whose adapted x was the airport name.
 */
type AxisGateId = 'orderedX' | 'quantX';

const AXIS_GATES: Record<AxisGateId, { test: (field: string, chart: SessionChart) => boolean; text: string }> = {
    orderedX: {
        test: (field, chart) => fieldIsOrdered(field, chart),
        text: 'a trend over an unordered axis shows a rise that is not in the data',
    },
    quantX: {
        test: (field, chart) => isQuantitative(field, chart.metadata),
        text: 'a fitted line needs a quantitative x axis, or it invents a trend',
    },
};

/**
 * Gates that a TARGET puts on the source chart. These protect plausibility,
 * not correctness: a participant who rejects a lure because it cannot be true
 * has used no memory, and the item then measures nothing.
 */
const TARGET_GATES: Record<string, GateId[]> = {
    // A radial chart divides a whole, so the parts must be positive, and its
    // sectors must be few enough to label.
    'Pie Chart': ['nonNeg', 'maxCats8'],
    'Rose Chart': ['nonNeg', 'maxCats8'],
    'Radar Chart': ['nonNeg', 'maxCats8'],
    'Area Chart': ['nonNeg'],
    'Streamgraph': ['nonNeg'],
    'Stacked Bar Chart': ['nonNeg'],
    'Density Plot': ['maxCats6'],
};

/** Gates a target puts on whichever field it lands on its own x channel. */
const TARGET_AXIS_GATES: Record<string, AxisGateId[]> = {
    'Line Chart': ['orderedX'],
    'Area Chart': ['orderedX'],
    'Streamgraph': ['orderedX'],
    'Bump Chart': ['orderedX'],
    'Regression': ['quantX'],
};

/** The distinct fields a spec puts on a channel. */
function fieldSet(spec: ChartLevelSpec): Set<string> {
    return new Set(Object.values(spec.encodings).map(e => e.field).filter(Boolean));
}

const sameSet = (a: Set<string>, b: Set<string>) =>
    a.size === b.size && [...a].every(v => b.has(v));

/**
 * How far the representation moved, from the shared edit-cost model rather
 * than a hand-written band. `markTransitionCost` prices a transition inside a
 * mark family below one between adjacent families, and that below a remote
 * family — the GraphScape ordering `distance.ts` already uses to score lures.
 */
function bandOf(source: string, target: string): VisualBand {
    const cost = markTransitionCost(source, target);
    if (cost <= EDIT_COSTS.MARK_NEAR) return 'near';
    if (cost <= EDIT_COSTS.MARK_MID) return 'mid';
    return 'far';
}

/**
 * Every visual candidate for one chart, in the CURATED preference order for
 * its chart type (curated.ts). The first entries are the typical near
 * transitions; the later entries move further away.
 *
 * A visual lure is a MARK RETARGET and nothing else. Transpose and recolor
 * were removed (user decision 2026-08-16): they change the drawing without
 * changing the representation, so a miss on one of them says the participant
 * forgot a cosmetic detail rather than the tool they chose.
 *
 * Must run inside `withSeededRandom` — vlAdaptChart calls Flint's recommender,
 * which draws random numbers.
 */
export function generateVisualCandidates(chart: SessionChart): DistractorCandidate[] {
    const out: DistractorCandidate[] = [];
    const semTypes = semanticTypeMap(chart.metadata);
    const seen = new Set<string>([specSignature(chart.spec)]);

    const push = (c: DistractorCandidate | null) => {
        if (!c) return;
        const sig = specSignature(c.spec);
        if (seen.has(sig)) return;
        if (!compiles(c.spec, c.rows, c.metadata)) return;
        seen.add(sig);
        out.push(c);
    };

    const source = chart.spec.chartType;
    const sourceFields = fieldSet(chart.spec);

    // The geographic position pair IS the basemap. A non-geo target (US Map
    // → Bar Chart, per the reviewed tables) cannot show longitude/latitude,
    // so for a geo source the target must show the remaining fields exactly.
    const geoFields = new Set(
        ['longitude', 'latitude']
            .map(ch => chart.spec.encodings[ch]?.field)
            .filter((f): f is string => !!f));

    for (const target of curatedFor(source).visual) {
        if (target === source) continue;

        // (1) The target must be plausible on this data.
        if ((TARGET_GATES[target] ?? []).some(g => !GATES[g].test(chart))) continue;

        let adapted: Record<string, string>;
        const targetHasGeo = target === 'US Map' || target === 'World Map';
        if (geoFields.size && !targetHasGeo) {
            // Geo → non-geo (US Map → Bar Chart, per the reviewed tables):
            // `vlAdaptChart` maps channel names through and drags the position
            // pair onto nonsense channels, so build the encoding directly —
            // the region label on x, the measure on y.
            const rest = [...sourceFields].filter(f => !geoFields.has(f));
            const cat = rest.find(f => !isQuantitative(f, chart.metadata));
            const meas = rest.find(f => isQuantitative(f, chart.metadata));
            if (!cat || !meas) continue;
            adapted = { x: cat, y: meas };
        } else {
            try {
                adapted = vlAdaptChart(source, target, encFieldMap(chart.spec), chart.rows, semTypes);
            } catch { continue; }
        }
        if (Object.keys(adapted).length === 0) continue;

        // (2) The target must show exactly the fields the original shows.
        // vlAdaptChart reads the whole table, so without this it can drop a
        // series or pull in a column the participant never charted — either
        // way the lure would show different data, not a different drawing.
        const targetIsGeo = !!(adapted.longitude || adapted.latitude);
        const required = geoFields.size && !targetIsGeo
            ? new Set([...sourceFields].filter(f => !geoFields.has(f)))
            : sourceFields;
        const targetFields = new Set(Object.values(adapted).filter(Boolean));
        if (!sameSet(required, targetFields)) continue;

        // (3) The target's own x axis must suit what it draws there. Checked
        // after the adaptation, because only the adapted map says which field
        // the target puts on x.
        const xField = adapted.x;
        if ((TARGET_AXIS_GATES[target] ?? []).some(
            g => !xField || !AXIS_GATES[g].test(xField, chart))) continue;

        // The band is computed from the transition cost, never declared.
        const band = bandOf(source, target);
        push({
            method: 'visual',
            op: 'mark',
            band,
            label: `redrawn as a ${target}`,
            rationale: `Same data, same values — redrawn as a ${target} (${band} target). Do they remember HOW it was drawn?`,
            spec: fromFieldMap(target, adapted, chart.spec.config),
            rows: chart.rows,
            metadata: chart.metadata,
        });
    }

    return out;
}

// ═════════════════════════════════════════════════════════════════════════
// Data perturbation — the message operators
// ═════════════════════════════════════════════════════════════════════════

/**
 * The operators this chart type is permitted to use, in the curated
 * preference order (curated.ts). An operator that is not in the chart type's
 * table is never offered, whatever its gate says: it would attack a message
 * this chart type does not tell.
 */
function opPreference(chart: SessionChart): string[] {
    return curatedFor(chart.spec.chartType).data;
}

/**
 * Every data candidate for one chart, in preference order. Each candidate has
 * already passed its operator's gate AND its floor (the message really
 * changed), and carries a story signature for the same-story dedupe.
 *
 * Must run inside `withSeededRandom`: the stochastic operators (unlink,
 * shuffle, flatten) draw from Math.random.
 */
export function generateDataCandidates(chart: SessionChart): DistractorCandidate[] {
    const roles = resolveRoles(chart);
    if (!roles.measure) return [];
    const axis = sortedAxis(chart, roles);
    const origSignature = takeawaySignature(chart, roles, chart.rows);
    const out: DistractorCandidate[] = [];

    for (const id of opPreference(chart)) {
        // One id names one message attack, not one mechanic: several entries
        // can share the id, one per data type. The first entry whose gate
        // accepts this chart is the mechanic the id means here.
        const op = MESSAGE_OPS.filter(o => o.id === id).find(o => !o.gate(chart, roles));
        if (!op) continue;
        const applied = op.apply(chart, roles, Math.random);
        if (!applied) continue;

        // A chart whose labels came out of its derive step in order of size
        // must keep that order, or the profile alone gives the answer away.
        let rows = applied.rows;
        let note = applied.note;
        if (axis.sorted) {
            rows = preserveSortedProfile(chart, roles, rows, axis);
            note += '; put back into the original sorted order';
        }

        if (op.floor && !op.floor.test(messageMetrics(chart, roles, rows))) continue;

        const signature = takeawaySignature(chart, roles, rows);
        if (signature === origSignature) continue;

        out.push({
            method: 'data',
            op: op.id,
            dim: op.dim,
            label: op.label,
            rationale: `${op.message} ${op.what}`,
            spec: cloneSpec(chart.spec),
            rows,
            metadata: chart.metadata,
            dataEditNote: note,
            signature,
        });
    }
    return out;
}

// ═════════════════════════════════════════════════════════════════════════
// Combined perturbation — the cross cells of the option matrix
// ═════════════════════════════════════════════════════════════════════════

/**
 * A combined lure: the visual lure's drawing over the data lure's rows.
 *
 * Built from two candidates that each already passed their own axis's gates,
 * floors and purity, so the only new failure mode is the pairing itself —
 * the target chart type must also compile over the perturbed rows.
 */
export function combineCandidates(
    chart: SessionChart, visual: DistractorCandidate, data: DistractorCandidate,
): DistractorCandidate | null {
    if (visual.method !== 'visual' || data.method !== 'data') return null;
    const spec = cloneSpec(visual.spec);
    if (!compiles(spec, data.rows, chart.metadata)) return null;
    return {
        method: 'combined',
        op: `${visual.op}+${data.op}`,
        label: `${visual.label}; ${data.label}`,
        rationale: `Both changed: ${visual.label}, and ${data.label}. A pick here encoded neither the tool nor the finding.`,
        spec,
        rows: data.rows,
        metadata: chart.metadata,
        dim: data.dim,
        band: visual.band,
        signature: data.signature,
        dataEditNote: data.dataEditNote,
    };
}

// ═════════════════════════════════════════════════════════════════════════

export interface ChartCandidates {
    visual: DistractorCandidate[];
    data: DistractorCandidate[];
}

/**
 * Every candidate for one chart, in preference order per axis. Must run
 * inside `withSeededRandom` — both axes draw random numbers.
 *
 * The session argument stays for the callers' sake; the current generators
 * work from the chart alone.
 */
export function generateCandidates(chart: SessionChart, _session?: SessionData): ChartCandidates {
    return {
        visual: generateVisualCandidates(chart),
        data: generateDataCandidates(chart),
    };
}

/**
 * Axis-purity violations. A visual lure that changed the data, or a data lure
 * that changed the drawing, would corrupt the quiz's analysis — the lure's
 * axis is the *meaning* of a wrong answer.
 */
export function purityViolation(chart: SessionChart, c: DistractorCandidate): string | null {
    if (c.method === 'visual') {
        if (c.rows !== chart.rows) return 'visual lure changed the rows';
        const origEnc = chart.spec.encodings, newEnc = c.spec.encodings;
        for (const ch of Object.keys(newEnc)) {
            const o = Object.values(origEnc).find(e => e.field === newEnc[ch].field);
            if (o && ((o.sortOrder ?? '') !== (newEnc[ch].sortOrder ?? '')
                || (o.aggregate ?? '') !== (newEnc[ch].aggregate ?? ''))) {
                return 'visual lure changed sort/aggregate';
            }
        }
    }
    if (c.method === 'data') {
        if (specSignature(c.spec) !== specSignature(chart.spec)) {
            return 'data lure changed the drawing';
        }
        if (!c.dim) return 'data lure carries no message dimension';
    }
    if (c.method === 'combined') {
        if (c.rows === chart.rows) return 'combined lure kept the rows';
        if (specSignature(c.spec) === specSignature(chart.spec)) {
            return 'combined lure kept the drawing';
        }
        if (!c.dim || !c.band) return 'combined lure carries no dimension or band';
    }
    return null;
}

/** Drop anything that violates its axis contract, loudly. */
export function enforcePurity(chart: SessionChart, candidates: DistractorCandidate[]): DistractorCandidate[] {
    return candidates.filter(c => {
        const violation = purityViolation(chart, c);
        if (violation) {
            console.warn(`[quiz-distractors] dropped "${c.label}" (${c.method}/${c.op}): ${violation}`);
            return false;
        }
        return true;
    });
}

/** Flat candidate list — author view and the offline gallery show all of them. */
export function generateAll(chart: SessionChart, session?: SessionData): DistractorCandidate[] {
    const { visual, data } = generateCandidates(chart, session);
    return enforcePurity(chart, [...visual, ...data]);
}
