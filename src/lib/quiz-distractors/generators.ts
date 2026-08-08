// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * distractor-lab/generators.ts — five distractor-generation strategies for
 * the chart-recognition quiz. Every generator emits chart-level specs that
 * compile through the app's own assembler, so lures are visually
 * in-distribution with the charts participants actually saw.
 *
 *  A. enumeration      — CompassQL-style sweep of plausible charts over the
 *                        same derived table (Flint's own recommender seeds it).
 *  B. graphscape       — controlled GraphScape-style edit walks from the
 *                        original, targeting near / mid / far distance bands.
 *  C. data-perturb     — identical spec, perturbed values (rank swaps, trend
 *                        inversion, flatten/exaggerate, label substitution).
 *                        Probes memory of the *pattern*, not the form.
 *  D. sibling-measure  — swap the plotted measure for a REAL sibling column
 *                        of the same derived table (internally consistent lure).
 *  E. session-hybrid   — chimera of this chart's form with a *different*
 *                        session chart's content (interference lure).
 */

import {
    ChartLevelSpec, FieldMeta, SessionChart, SessionData,
    cloneSpec, compiles, isQuantitative, specSignature,
} from './extract';
import { SpecEdit, EDIT_COSTS } from './distance';
import { vlAdaptChart, vlRecommendEncodings } from '../agents-chart';

export type Method = 'enumeration' | 'graphscape' | 'data-perturb' | 'sibling-measure' | 'session-hybrid';

export interface DistractorCandidate {
    method: Method;
    label: string;
    rationale: string;
    spec: ChartLevelSpec;
    rows: any[];
    metadata: Record<string, FieldMeta>;
    /** set when rows differ from the original chart's rows */
    dataEditNote?: string;
    /** flags a lure that needs special quiz phrasing (e.g. participant saw both) */
    caveat?: string;
    /**
     * Edits a spec diff cannot recover (see distance.ts mergeEdits).
     * Without these, order-only lures score (0, 0) — indistinguishable from
     * the original in the analysis.
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

function numericSiblings(chart: SessionChart, exclude: string[]): string[] {
    return Object.keys(chart.metadata).filter(f =>
        isQuantitative(f, chart.metadata) && !exclude.includes(f));
}

function categoricalSiblings(chart: SessionChart, exclude: string[]): string[] {
    const n = chart.rows.length;
    return Object.keys(chart.metadata).filter(f => {
        if (isQuantitative(f, chart.metadata) || exclude.includes(f)) return false;
        const card = new Set(chart.rows.map(r => r[f])).size;
        return card >= 2 && card <= Math.max(30, n); // plottable cardinality
    });
}

/** encodings as channel→field map (for vlAdaptChart) */
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
// A. Enumeration — plausible charts over the same table
// ═════════════════════════════════════════════════════════════════════════

const ENUM_CHART_TYPES = [
    'Bar Chart', 'Bar Table', 'Lollipop Chart', 'Line Chart', 'Area Chart',
    'Pie Chart', 'Heatmap', 'Scatter Plot', 'Grouped Bar Chart', 'Stacked Bar Chart',
];

export function genEnumeration(chart: SessionChart): DistractorCandidate[] {
    const out: DistractorCandidate[] = [];
    const seen = new Set<string>([specSignature(chart.spec)]);
    const semTypes = semanticTypeMap(chart.metadata);
    const roles = chartRoles(chart);

    const push = (spec: ChartLevelSpec, label: string, rationale: string) => {
        const sig = specSignature(spec);
        if (seen.has(sig)) return;
        if (!compiles(spec, chart.rows, chart.metadata)) return;
        seen.add(sig);
        out.push({ method: 'enumeration', label, rationale, spec, rows: chart.rows, metadata: chart.metadata });
    };

    // A1. Flint's own recommender, per chart type ("what would DF have suggested?")
    for (const ct of ENUM_CHART_TYPES) {
        try {
            const rec = vlRecommendEncodings(ct, chart.rows, semTypes);
            if (Object.keys(rec).length >= 2 || (ct === 'Pie Chart' && Object.keys(rec).length >= 1)) {
                push(fromFieldMap(ct, rec), `${ct} (Flint rec)`,
                    `Flint's recommender's own pick of encodings for a ${ct} over this table — a chart DF could plausibly have shown.`);
            }
        } catch { /* recommender may not support this table shape */ }
    }

    // A2. direct sweep: dimension × measure × a few chart forms
    const dims = uniq([roles.category, ...categoricalSiblings(chart, [])].filter(Boolean)) as string[];
    const measures = uniq([roles.measure, ...numericSiblings(chart, [])].filter(Boolean)) as string[];
    for (const d of dims.slice(0, 3)) {
        for (const m of measures.slice(0, 3)) {
            for (const ct of ['Bar Chart', 'Bar Table', 'Line Chart', 'Lollipop Chart']) {
                const map = ct === 'Bar Table' ? { y: d, x: m } : { x: d, y: m };
                push(fromFieldMap(ct, map), `${ct}: ${m} by ${d}`,
                    `Systematic sweep cell — ${m} plotted against ${d} as a ${ct}.`);
            }
        }
    }

    return out;
}

// ═════════════════════════════════════════════════════════════════════════
// B. GraphScape-style edit walks (near / mid / far)
// ═════════════════════════════════════════════════════════════════════════

/** mark targets per band, filtered by compile-probe later */
const NEAR_MARKS: Record<string, string[]> = {
    'Bar Chart': ['Lollipop Chart', 'Bar Table'],
    'Bar Table': ['Bar Chart', 'Lollipop Chart'],
    'Grouped Bar Chart': ['Stacked Bar Chart', 'Bar Chart'],
    'Line Chart': ['Area Chart'],
};
const MID_MARKS = ['Line Chart', 'Scatter Plot', 'Area Chart', 'Bar Chart'];
const FAR_MARKS = ['Pie Chart', 'Heatmap', 'Rose Chart'];

export function genGraphscape(chart: SessionChart): DistractorCandidate[] {
    const out: DistractorCandidate[] = [];
    const seen = new Set<string>([specSignature(chart.spec)]);
    const roles = chartRoles(chart);
    const semTypes = semanticTypeMap(chart.metadata);

    const push = (spec: ChartLevelSpec, label: string, rationale: string, declaredEdits?: SpecEdit[]) => {
        const sig = specSignature(spec);
        if (seen.has(sig) || !compiles(spec, chart.rows, chart.metadata)) return;
        seen.add(sig);
        out.push({ method: 'graphscape', label, rationale, spec, rows: chart.rows, metadata: chart.metadata, declaredEdits });
    };

    const markChange = (target: string): ChartLevelSpec | undefined => {
        try {
            const adapted = vlAdaptChart(chart.spec.chartType, target, encFieldMap(chart.spec), chart.rows, semTypes);
            if (Object.keys(adapted).length === 0) return undefined;
            return fromFieldMap(target, adapted, chart.spec.config);
        } catch { return undefined; }
    };

    // NEAR (≈1 edit, cheap): re-sort, near-family mark change, transpose
    //
    // Sort goes on the CATEGORY channel. Probed against the real compiler:
    //   • sortOrder on the *measure* channel is inert — it compiles to a sort
    //     of a quantitative scale, so the spec changes but the render never
    //     does. (This shipped as a no-op on all 13 charts before it was caught.)
    //   • sortOrder alone on the category channel gives an ALPHABETICAL order.
    //   • sortBy — which takes a CHANNEL reference, not a field name — turns it
    //     into a BY-VALUE sort (VL's "y" / "-y" shorthand). This is the lure
    //     that matters: "was the largest bar at the top or the bottom?"
    //     It works for Bar Table too, whose template otherwise hard-codes a
    //     descending domain array and ignores sortOrder on its own.
    // The render-identity guard in main.ts drops whichever turns out inert.
    if (roles.categoryCh && roles.measureCh) {
        for (const dir of ['ascending', 'descending'] as const) {
            const s = cloneSpec(chart.spec);
            s.encodings[roles.categoryCh].sortBy = roles.measureCh;
            s.encodings[roles.categoryCh].sortOrder = dir;
            push(s, `sorted ${dir} by value`,
                `Same fields and same values, ranked ${dir} — was the largest ${roles.category} at the top or the bottom?`,
                [{ op: 'SORT', detail: `${roles.categoryCh}: by ${roles.measure} ${dir}`, cost: EDIT_COSTS.SORT_FLIP }]);
        }
    }
    if (roles.categoryCh) {
        for (const dir of ['ascending', 'descending'] as const) {
            if (chart.spec.encodings[roles.categoryCh]?.sortOrder === dir) continue;
            const s = cloneSpec(chart.spec);
            s.encodings[roles.categoryCh].sortOrder = dir;
            push(s, `sorted ${dir} by label`,
                `Same fields and values, ordered alphabetically by ${roles.category} instead of by size.`,
                [{ op: 'SORT', detail: `${roles.categoryCh}: label ${dir}`, cost: EDIT_COSTS.SORT_FLIP }]);
        }
    }
    for (const t of NEAR_MARKS[chart.spec.chartType] ?? []) {
        const s = markChange(t);
        if (s) push(s, `mark → ${t}`, `Same data and fields, near-family mark swap (${chart.spec.chartType} → ${t}).`);
    }
    // Transpose is meaningless for a Bar Table: its two channels are a label
    // column and a bar column, not interchangeable axes. Swapping them puts the
    // measure in the label slot and the category in the bar slot, which renders
    // a column of NaN. (The plausibility guard in main.ts would drop it anyway.)
    if (chart.spec.encodings.x?.field && chart.spec.encodings.y?.field
        && chart.spec.chartType !== 'Bar Table') {
        const s = cloneSpec(chart.spec);
        const tmp = s.encodings.x; s.encodings.x = s.encodings.y; s.encodings.y = tmp;
        push(s, 'transposed', 'Axes swapped — vertical vs horizontal orientation memory.');
    }

    // MID (≈2 edits): mid-family mark, single field replacement
    for (const t of MID_MARKS.filter(t => t !== chart.spec.chartType)) {
        const s = markChange(t);
        if (s) push(s, `mark → ${t}`, `Cross-family re-expression of the same fields as a ${t}.`);
    }
    if (roles.category) {
        for (const d of categoricalSiblings(chart, [roles.category]).slice(0, 2)) {
            const s = cloneSpec(chart.spec);
            s.encodings[roles.categoryCh!].field = d;
            push(s, `dimension → ${d}`, `Category axis replaced with sibling dimension ${d}.`);
        }
    }
    if (roles.measure) {
        for (const m of numericSiblings(chart, [roles.measure]).slice(0, 2)) {
            const s = cloneSpec(chart.spec);
            s.encodings[roles.measureCh!].field = m;
            push(s, `measure → ${m}`, `Measure axis replaced with sibling measure ${m}.`);
        }
    }

    // FAR (≥2 substantial edits): far mark; field replace + mark change
    for (const t of FAR_MARKS) {
        const s = markChange(t);
        if (s) push(s, `mark → ${t}`, `Remote-family re-expression (${chart.spec.chartType} → ${t}).`);
    }
    const sibM = numericSiblings(chart, roles.measure ? [roles.measure] : []);
    if (sibM.length && roles.measureCh) {
        for (const t of MID_MARKS.filter(t => t !== chart.spec.chartType).slice(0, 2)) {
            const base = markChange(t);
            if (!base) continue;
            const mCh = Object.entries(base.encodings).find(([, e]) => isQuantitative(e.field, chart.metadata));
            if (!mCh) continue;
            const s = cloneSpec(base);
            s.encodings[mCh[0]].field = sibM[0];
            push(s, `mark → ${t} + measure → ${sibM[0]}`, 'Compound edit: mark family change plus measure replacement.');
        }
    }

    return out;
}

// ═════════════════════════════════════════════════════════════════════════
// C. Data perturbation — same spec, different values
// ═════════════════════════════════════════════════════════════════════════

function decimalsOf(vals: number[]): number {
    let d = 0;
    for (const v of vals.slice(0, 50)) {
        const s = String(v);
        const i = s.indexOf('.');
        if (i >= 0) d = Math.max(d, Math.min(4, s.length - i - 1));
    }
    return d;
}

/** group rows by an optional series field, apply fn to each group's measure values */
function perturbMeasure(
    rows: any[], measure: string, seriesField: string | undefined,
    fn: (vals: number[]) => number[],
): any[] {
    const groups = new Map<string, number[]>();
    rows.forEach((r, i) => {
        const k = seriesField ? String(r[seriesField]) : '_';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(i);
    });
    const out = rows.map(r => ({ ...r }));
    const dec = decimalsOf(rows.map(r => Number(r[measure])).filter(Number.isFinite));
    for (const idxs of groups.values()) {
        const vals = idxs.map(i => Number(rows[i][measure]));
        const newVals = fn(vals);
        idxs.forEach((rowIdx, j) => {
            const v = newVals[j];
            out[rowIdx][measure] = Number.isFinite(v) ? +v.toFixed(dec) : rows[rowIdx][measure];
        });
    }
    return out;
}

export function genDataPerturb(chart: SessionChart, session: SessionData): DistractorCandidate[] {
    const out: DistractorCandidate[] = [];
    const roles = chartRoles(chart);
    if (!roles.measure) return out;
    const m = roles.measure;
    const seriesField = roles.colorField && roles.colorField !== roles.category ? roles.colorField : undefined;

    const push = (rows: any[], label: string, note: string, rationale: string) => {
        out.push({
            method: 'data-perturb', label, rationale,
            spec: cloneSpec(chart.spec), rows, metadata: chart.metadata, dataEditNote: note,
        });
    };

    // C1. rank swap: top value trades places with rank-3 (or rank-2)
    push(perturbMeasure(chart.rows, m, seriesField, vals => {
        const v = [...vals];
        if (v.length >= 2) {
            const order = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => b[0] - a[0]);
            const i1 = order[0][1], i2 = order[Math.min(2, v.length - 1)][1];
            [v[i1], v[i2]] = [v[i2], v[i1]];
        }
        return v;
    }), 'rank swap (1↔3)', 'top item swapped with #3', 'Do they remember WHICH item led, or just that something did?');

    // C2. inverted pattern: mirror values within the range
    push(perturbMeasure(chart.rows, m, seriesField, vals => {
        const lo = Math.min(...vals), hi = Math.max(...vals);
        return vals.map(v => hi + lo - v);
    }), 'pattern inverted', 'values mirrored in range', 'Trend/ranking fully reversed — the strongest pattern-memory probe.');

    // C3. flattened: compress deviations toward the mean
    push(perturbMeasure(chart.rows, m, seriesField, vals => {
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        return vals.map(v => mean + (v - mean) * 0.45);
    }), 'effect flattened', 'deviations × 0.45', 'Same ranking, much weaker effect — do they remember the magnitude?');

    // C4. exaggerated: amplify deviations
    push(perturbMeasure(chart.rows, m, seriesField, vals => {
        const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
        const lo = Math.min(...vals);
        return vals.map(v => Math.max(lo >= 0 ? 0 : -Infinity, mean + (v - mean) * 1.7));
    }), 'effect exaggerated', 'deviations × 1.7', 'Same ranking, stronger effect — magnitude memory, other direction.');

    // C5. peak shifted (series/orderable x): cyclic shift moves the peak
    if (chart.spec.chartType === 'Line Chart' || chart.spec.chartType === 'Area Chart') {
        push(perturbMeasure(chart.rows, m, seriesField, vals => {
            const k = Math.max(1, Math.round(vals.length * 0.25));
            return vals.map((_, i) => vals[(i + k) % vals.length]);
        }), 'peak shifted', 'series rotated by 25%', 'Shape preserved but displaced in x — do they remember WHERE the peak was?');
    }

    // C6. label substitution: a prominent category renamed to a plausible sibling
    if (roles.category && session.sourceTable) {
        const col = roles.category;
        const srcVals = session.sourceTable.metadata[col]
            ? uniq(session.sourceTable.rows.map(r => r[col]).filter(v => v != null && v !== 'UNKNOWN'))
            : [];
        const present = new Set(chart.rows.map(r => r[col]));
        const pool = srcVals.filter(v => !present.has(v));
        if (pool.length) {
            const order = [...chart.rows].sort((a, b) => Number(b[m]) - Number(a[m]));
            const target = order[Math.min(1, order.length - 1)]?.[col]; // rank-2 label
            const replacement = pool[Math.floor(pool.length / 2)];
            if (target != null) {
                const rows = chart.rows.map(r => r[col] === target ? { ...r, [col]: replacement } : { ...r });
                push(rows, `label swap: ${String(target).slice(0, 18)} → ${String(replacement).slice(0, 18)}`,
                    'one category relabeled (real sibling value)',
                    'Every bar identical except one label — pure item-identity memory probe.');
            }
        }
    }

    return out;
}

// ═════════════════════════════════════════════════════════════════════════
// D. Sibling-measure lures — real alternative columns, real data
// ═════════════════════════════════════════════════════════════════════════

export function genSiblingMeasure(chart: SessionChart): DistractorCandidate[] {
    const out: DistractorCandidate[] = [];
    const roles = chartRoles(chart);
    if (!roles.measure || !roles.measureCh) return out;

    for (const m of numericSiblings(chart, [roles.measure])) {
        const s = cloneSpec(chart.spec);
        s.encodings[roles.measureCh].field = m;
        if (!compiles(s, chart.rows, chart.metadata)) continue;
        out.push({
            method: 'sibling-measure',
            label: `real measure: ${m}`,
            rationale: `The derived table really contains "${m}" — the participant's own transform computed it, but they plotted "${roles.measure}". An internally-consistent chart of data they never saw plotted.`,
            spec: s, rows: chart.rows, metadata: chart.metadata,
        });
    }
    return out;
}

// ═════════════════════════════════════════════════════════════════════════
// E. Session hybrids — this chart's form × another session chart's content
// ═════════════════════════════════════════════════════════════════════════

export function genSessionHybrid(chart: SessionChart, session: SessionData): DistractorCandidate[] {
    const out: DistractorCandidate[] = [];
    const roles = chartRoles(chart);
    const semTypesOf = (c: SessionChart) => semanticTypeMap(c.metadata);

    for (const other of session.charts) {
        if (other.id === chart.id || other.tableId === chart.tableId) continue;
        const oRoles = chartRoles(other);
        // relatedness: shared measure name or shared dimension name
        const sharedMeasure = roles.measure && oRoles.measure === roles.measure;
        const sharedDim = roles.category && oRoles.category === roles.category;
        if (!sharedMeasure && !sharedDim) continue;

        // Re-express the OTHER chart's content in THIS chart's form.
        let spec: ChartLevelSpec | undefined;
        if (other.spec.chartType === chart.spec.chartType) {
            spec = cloneSpec(other.spec);
            spec.config = chart.spec.config;
        } else {
            try {
                const adapted = vlAdaptChart(other.spec.chartType, chart.spec.chartType,
                    encFieldMap(other.spec), other.rows, semTypesOf(other));
                if (Object.keys(adapted).length) spec = fromFieldMap(chart.spec.chartType, adapted, chart.spec.config);
            } catch { /* skip */ }
        }
        if (!spec || !compiles(spec, other.rows, other.metadata)) continue;

        const sameAnalysis = sharedMeasure && sharedDim;
        out.push({
            method: 'session-hybrid',
            label: `content from “${other.title}”`,
            rationale: sharedMeasure
                ? `Interference lure: the participant analyzed "${roles.measure}" against several dimensions in this session. This shows the ${other.title.toLowerCase()} slice in this chart's visual form.`
                : `Interference lure: same dimension (${roles.category}) analyzed elsewhere in the session, shown in this chart's form.`,
            spec, rows: other.rows, metadata: other.metadata,
            dataEditNote: `rows from session chart “${other.title}”`,
            caveat: sameAnalysis
                ? 'Participant saw a version of this chart too — only usable as a "which was your final version?" item.'
                : undefined,
        });
    }
    return out;
}

// ═════════════════════════════════════════════════════════════════════════

export function generateAll(chart: SessionChart, session: SessionData): DistractorCandidate[] {
    return [
        ...genEnumeration(chart),
        ...genGraphscape(chart),
        ...genDataPerturb(chart, session),
        ...genSiblingMeasure(chart),
        ...genSessionHybrid(chart, session),
    ];
}
