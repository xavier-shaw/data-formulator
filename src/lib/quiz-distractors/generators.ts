// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/generators.ts — look-alike generation on two axes.
 *
 * A chart leaves two separable memories, and each lure targets exactly one
 * (or deliberately both):
 *
 *  FORM      how it was drawn — chart/mark type, orientation, color.
 *            The data is untouched: same rows, same sort, same aggregation.
 *
 *  CONTENT   what the data said — sort order, scale, aggregation, filtering,
 *            and value perturbation. The drawing is untouched: same chart
 *            type, same field-to-channel mapping, same colors.
 *
 *  COMBINED  form edit A composed with content edit B — and specifically the
 *            SAME A and B that the item's other two lures carry, so a quiz
 *            item is a clean 2×2: original, A, B, A+B.
 *
 * Purity is enforced, not just intended: `enforcePurity` drops (with a console
 * warning) any form candidate whose rows changed and any content candidate
 * whose chart type or field mapping changed. That keeps the quiz's analysis
 * honest — when a participant picks a form lure, the only thing it differed
 * in was form.
 *
 * Every candidate compiles through the app's own assembler, so lures are
 * visually in-distribution with the charts participants actually saw.
 */

import {
    ChartLevelSpec, FieldMeta, SessionChart, SessionData,
    cloneSpec, compiles, isQuantitative, specSignature,
} from './extract';
import { SpecEdit, EDIT_COSTS } from './distance';
import { vlAdaptChart } from '../agents-chart';

export type Method = 'form' | 'content' | 'combined';

export interface DistractorCandidate {
    method: Method;
    /** the specific operation, e.g. 'mark', 'sort-value', 'perturb-invert' */
    op: string;
    label: string;
    rationale: string;
    spec: ChartLevelSpec;
    rows: any[];
    metadata: Record<string, FieldMeta>;
    /** set when rows differ from the original chart's rows */
    dataEditNote?: string;
    /** flags a lure that needs special quiz phrasing */
    caveat?: string;
    /** which form edit produced it (set on form and combined lures) */
    formIndex?: number;
    /** which content edit produced it (set on content and combined lures) */
    contentIndex?: number;
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

/** find the channel a field sits on in a (possibly form-edited) spec */
function channelOf(spec: ChartLevelSpec, field: string | undefined): string | undefined {
    if (!field) return undefined;
    return Object.entries(spec.encodings).find(([, e]) => e.field === field)?.[0];
}

/**
 * Channels a sort directive may name. `sortBy` compiles to Vega-Lite's channel
 * shorthand ("y" / "-y"), which only exists for these; naming any other channel
 * makes VL log `sort error > <channel>` and ignore the sort — which a composed
 * lure can otherwise reach, since a mark change may move the measure to
 * `column` or `size`.
 */
const SORTABLE_CHANNELS = new Set(['x', 'y', 'color']);

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/**
 * Reorder an edit list so the operations take turns, keeping each operation's
 * own order. The composition grid is capped, and a cap applied to a list
 * grouped by operation would amputate whole operations — a bar chart offers
 * eight mark targets before it offers transpose or a recolor, so a cap of eight
 * would leave every form lure in the study a mark swap.
 */
function interleaveByOp<T extends { op: string }>(edits: T[]): T[] {
    const queues = new Map<string, T[]>();
    for (const e of edits) {
        if (!queues.has(e.op)) queues.set(e.op, []);
        queues.get(e.op)!.push(e);
    }
    const out: T[] = [];
    const lists = [...queues.values()];
    for (let i = 0; out.length < edits.length; i++) {
        for (const list of lists) if (i < list.length) out.push(list[i]);
    }
    return out;
}

// ═════════════════════════════════════════════════════════════════════════
// Atomic edits — each returns undefined when it does not apply
// ═════════════════════════════════════════════════════════════════════════

/** A form edit rewrites the spec; the rows are never touched. */
interface FormEdit {
    op: string;
    label: string;
    rationale: string;
    apply: (spec: ChartLevelSpec) => ChartLevelSpec | undefined;
    declaredEdits?: SpecEdit[];
}

/**
 * A content edit changes what the data says; the drawing stays. It receives
 * the spec it must preserve (which, for combined lures, is already
 * form-edited) and locates its channels by FIELD NAME, not by position, so it
 * composes correctly after a transpose or mark change.
 */
interface ContentEdit {
    op: string;
    label: string;
    rationale: string;
    apply: (spec: ChartLevelSpec, rows: any[]) => {
        spec: ChartLevelSpec; rows: any[];
        dataEditNote?: string; declaredEdits?: SpecEdit[];
    } | undefined;
}

// ── form edits ───────────────────────────────────────────────────────────

/** mark targets per band, filtered by compile-probe later */
const NEAR_MARKS: Record<string, string[]> = {
    'Bar Chart': ['Lollipop Chart', 'Bar Table'],
    'Bar Table': ['Bar Chart', 'Lollipop Chart'],
    'Grouped Bar Chart': ['Stacked Bar Chart', 'Bar Chart'],
    'Line Chart': ['Area Chart'],
};
const MID_MARKS = ['Line Chart', 'Scatter Plot', 'Area Chart', 'Bar Chart'];
const FAR_MARKS = ['Pie Chart', 'Heatmap', 'Rose Chart'];

function formEdits(chart: SessionChart): FormEdit[] {
    const edits: FormEdit[] = [];
    const semTypes = semanticTypeMap(chart.metadata);

    const markEdit = (target: string, band: string): FormEdit => ({
        op: 'mark',
        label: `mark → ${target}`,
        rationale: `Same data, same values — redrawn as a ${target} (${band} mark swap). Do they remember HOW it was drawn?`,
        apply: (spec) => {
            if (spec.chartType === target) return undefined;
            try {
                const adapted = vlAdaptChart(spec.chartType, target, encFieldMap(spec), chart.rows, semTypes);
                if (Object.keys(adapted).length === 0) return undefined;
                return fromFieldMap(target, adapted, spec.config);
            } catch { return undefined; }
        },
    });

    for (const t of NEAR_MARKS[chart.spec.chartType] ?? []) edits.push(markEdit(t, 'near-family'));
    for (const t of MID_MARKS.filter(t => t !== chart.spec.chartType)) edits.push(markEdit(t, 'cross-family'));
    for (const t of FAR_MARKS.filter(t => t !== chart.spec.chartType)) edits.push(markEdit(t, 'remote-family'));

    // Transpose is meaningless for a Bar Table: its two channels are a label
    // column and a bar column, not interchangeable axes.
    if (chart.spec.chartType !== 'Bar Table') {
        edits.push({
            op: 'transpose',
            label: 'transposed',
            rationale: 'Axes swapped — vertical vs horizontal orientation memory.',
            apply: (spec) => {
                if (!spec.encodings.x?.field || !spec.encodings.y?.field) return undefined;
                const s = cloneSpec(spec);
                const tmp = s.encodings.x; s.encodings.x = s.encodings.y; s.encodings.y = tmp;
                return s;
            },
        });
    }

    // Color shift: the compiled chart is repainted with a rotated palette (see
    // extract.ts recolorVl). The render-identity guard drops charts where the
    // palette turns out not to show (e.g. everything grayscale already).
    for (const shift of [1, 2]) {
        edits.push({
            op: 'color',
            label: `recolored (variant ${shift})`,
            rationale: 'Identical marks in different colors — pure color memory, nothing else changed.',
            declaredEdits: [{ op: 'COLOR', detail: `palette variant ${shift}`, cost: EDIT_COSTS.COLOR_SHIFT }],
            apply: (spec) => {
                const s = cloneSpec(spec);
                s.config = { ...s.config, _quizColorShift: shift };
                return s;
            },
        });
    }

    return edits;
}

// ── content edits ────────────────────────────────────────────────────────

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

function contentEdits(chart: SessionChart, session: SessionData): ContentEdit[] {
    const edits: ContentEdit[] = [];
    const roles = chartRoles(chart);
    const m = roles.measure;
    const seriesField = roles.colorField && roles.colorField !== roles.category ? roles.colorField : undefined;

    // — sorting —
    //
    // Sort goes on the CATEGORY channel. Probed against the real compiler:
    //   • sortOrder on the *measure* channel is inert — it compiles to a sort
    //     of a quantitative scale, so the spec changes but the render never
    //     does.
    //   • sortOrder alone on the category channel gives an ALPHABETICAL order.
    //   • sortBy — a CHANNEL reference, not a field name — turns it into a
    //     BY-VALUE sort (VL's "y"/"-y" shorthand): "was the largest bar at the
    //     top or the bottom?" Works for Bar Table too.
    // The render-identity guard drops whichever turns out inert.
    if (roles.category && m) {
        for (const dir of ['ascending', 'descending'] as const) {
            edits.push({
                op: 'sort-value',
                label: `sorted ${dir} by value`,
                rationale: `Same fields and same values, ranked ${dir} — was the largest ${roles.category} at the top or the bottom?`,
                apply: (spec, rows) => {
                    const catCh = channelOf(spec, roles.category);
                    const meaCh = channelOf(spec, m);
                    if (!catCh || !meaCh || !SORTABLE_CHANNELS.has(meaCh)) return undefined;
                    const s = cloneSpec(spec);
                    s.encodings[catCh].sortBy = meaCh;
                    s.encodings[catCh].sortOrder = dir;
                    return {
                        spec: s, rows,
                        declaredEdits: [{ op: 'SORT', detail: `${catCh}: by ${m} ${dir}`, cost: EDIT_COSTS.SORT_FLIP }],
                    };
                },
            });
        }
    }
    if (roles.category) {
        for (const dir of ['ascending', 'descending'] as const) {
            edits.push({
                op: 'sort-label',
                label: `sorted ${dir} by label`,
                rationale: `Same fields and values, ordered alphabetically by ${roles.category} instead of by size.`,
                apply: (spec, rows) => {
                    const catCh = channelOf(spec, roles.category);
                    if (!catCh || !SORTABLE_CHANNELS.has(catCh)) return undefined;
                    if (spec.encodings[catCh].sortOrder === dir) return undefined;
                    const s = cloneSpec(spec);
                    s.encodings[catCh].sortOrder = dir;
                    return {
                        spec: s, rows,
                        declaredEdits: [{ op: 'SORT', detail: `${catCh}: label ${dir}`, cost: EDIT_COSTS.SORT_FLIP }],
                    };
                },
            });
        }
    }

    // — aggregation — only offered when the chart aggregates explicitly, so
    // the flip provably changes what is computed, not just the spec text.
    if (m) {
        const currentAgg = roles.measureCh ? chart.spec.encodings[roles.measureCh]?.aggregate : undefined;
        if (currentAgg) {
            for (const agg of ['sum', 'mean', 'max'].filter(a => a !== currentAgg).slice(0, 2)) {
                edits.push({
                    op: 'aggregate',
                    label: `aggregate → ${agg}`,
                    rationale: `Same fields, ${agg} instead of ${currentAgg} — do they remember WHAT was being counted?`,
                    apply: (spec, rows) => {
                        const meaCh = channelOf(spec, m);
                        if (!meaCh) return undefined;
                        const s = cloneSpec(spec);
                        s.encodings[meaCh].aggregate = agg;
                        return { spec: s, rows };
                    },
                });
            }
        }
    }

    // — scale — linear → log on the measure axis; strictly-positive measures
    // with real spread only, so the log rendering is valid and visibly different.
    if (m) {
        const vals = chart.rows.map(r => Number(r[m])).filter(Number.isFinite);
        const min = Math.min(...vals), max = Math.max(...vals);
        if (vals.length >= 3 && min > 0 && max / min >= 8) {
            edits.push({
                op: 'scale',
                label: 'log scale',
                rationale: 'Same values on a log axis — the differences flatten. Do they remember how dramatic the gap looked?',
                apply: (spec, rows) => {
                    const s = cloneSpec(spec);
                    s.config = { ...s.config, _quizLogScaleField: m };
                    return {
                        spec: s, rows,
                        declaredEdits: [{ op: 'SCALE', detail: `${m}: linear → log`, cost: EDIT_COSTS.SCALE_CHANGE }],
                    };
                },
            });
        }
    }

    // — filtering — a category the participant saw is gone, or the tail is cut.
    if (roles.category && m) {
        const cat = roles.category;
        const catVals = uniq(chart.rows.map(r => r[cat]));
        if (catVals.length >= 4) {
            edits.push({
                op: 'filter',
                label: 'one category removed',
                rationale: 'The #2 item is simply missing — do they remember WHO was in the chart?',
                apply: (spec, rows) => {
                    const order = [...rows].sort((a, b) => Number(b[m]) - Number(a[m]));
                    const target = order[Math.min(1, order.length - 1)]?.[cat];
                    if (target == null) return undefined;
                    const filtered = rows.filter(r => r[cat] !== target);
                    if (filtered.length === rows.length) return undefined;
                    return {
                        spec: cloneSpec(spec), rows: filtered,
                        dataEditNote: `category "${String(target).slice(0, 24)}" filtered out`,
                    };
                },
            });
        }
        if (catVals.length >= 6) {
            edits.push({
                op: 'filter',
                label: 'bottom quartile dropped',
                rationale: 'Only the leaders remain — was the chart this short, or did it have a long tail?',
                apply: (spec, rows) => {
                    const totals = new Map<any, number>();
                    for (const r of rows) totals.set(r[cat], (totals.get(r[cat]) ?? 0) + Number(r[m]));
                    const keepN = Math.ceil(totals.size * 0.75);
                    const keep = new Set([...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, keepN).map(e => e[0]));
                    const filtered = rows.filter(r => keep.has(r[cat]));
                    if (filtered.length === rows.length) return undefined;
                    return {
                        spec: cloneSpec(spec), rows: filtered,
                        dataEditNote: `bottom ${totals.size - keepN} categor${totals.size - keepN === 1 ? 'y' : 'ies'} filtered out`,
                    };
                },
            });
        }
        if ((chart.spec.chartType === 'Line Chart' || chart.spec.chartType === 'Area Chart') && catVals.length >= 8) {
            edits.push({
                op: 'filter',
                label: 'series truncated at 75%',
                rationale: 'The series stops early — do they remember how far it ran?',
                apply: (spec, rows) => {
                    const seen: any[] = [];
                    for (const r of rows) if (!seen.includes(r[cat])) seen.push(r[cat]);
                    const keep = new Set(seen.slice(0, Math.ceil(seen.length * 0.75)));
                    const filtered = rows.filter(r => keep.has(r[cat]));
                    if (filtered.length === rows.length) return undefined;
                    return {
                        spec: cloneSpec(spec), rows: filtered,
                        dataEditNote: `last ${seen.length - keep.size} ${cat} value(s) truncated`,
                    };
                },
            });
        }
    }

    // — value perturbation — same spec, same rows count, different numbers.
    if (m) {
        const mk = (op: string, label: string, note: string, rationale: string, fn: (vals: number[]) => number[]): ContentEdit => ({
            op, label, rationale,
            apply: (spec, rows) => ({
                spec: cloneSpec(spec),
                rows: perturbMeasure(rows, m, seriesField, fn),
                dataEditNote: note,
            }),
        });

        edits.push(mk('perturb-rank', 'rank swap (1↔3)', 'top item swapped with #3',
            'Do they remember WHICH item led, or just that something did?',
            vals => {
                const v = [...vals];
                if (v.length >= 2) {
                    const order = v.map((x, i) => [x, i] as [number, number]).sort((a, b) => b[0] - a[0]);
                    const i1 = order[0][1], i2 = order[Math.min(2, v.length - 1)][1];
                    [v[i1], v[i2]] = [v[i2], v[i1]];
                }
                return v;
            }));

        edits.push(mk('perturb-invert', 'pattern inverted', 'values mirrored in range',
            'Trend/ranking fully reversed — the strongest pattern-memory probe.',
            vals => {
                const lo = Math.min(...vals), hi = Math.max(...vals);
                return vals.map(v => hi + lo - v);
            }));

        edits.push(mk('perturb-flatten', 'effect flattened', 'deviations × 0.45',
            'Same ranking, much weaker effect — do they remember the magnitude?',
            vals => {
                const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
                return vals.map(v => mean + (v - mean) * 0.45);
            }));

        edits.push(mk('perturb-exaggerate', 'effect exaggerated', 'deviations × 1.7',
            'Same ranking, stronger effect — magnitude memory, other direction.',
            vals => {
                const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
                const lo = Math.min(...vals);
                return vals.map(v => Math.max(lo >= 0 ? 0 : -Infinity, mean + (v - mean) * 1.7));
            }));

        if (chart.spec.chartType === 'Line Chart' || chart.spec.chartType === 'Area Chart') {
            edits.push(mk('perturb-peakshift', 'peak shifted', 'series rotated by 25%',
                'Shape preserved but displaced in x — do they remember WHERE the peak was?',
                vals => {
                    const k = Math.max(1, Math.round(vals.length * 0.25));
                    return vals.map((_, i) => vals[(i + k) % vals.length]);
                }));
        }

        // label substitution: a prominent category renamed to a plausible sibling
        if (roles.category && session.sourceTable) {
            const col = roles.category;
            const srcVals = session.sourceTable.metadata[col]
                ? uniq(session.sourceTable.rows.map(r => r[col]).filter(v => v != null && v !== 'UNKNOWN'))
                : [];
            const present = new Set(chart.rows.map(r => r[col]));
            const pool = srcVals.filter(v => !present.has(v));
            if (pool.length) {
                edits.push({
                    op: 'perturb-label',
                    label: 'one label swapped',
                    rationale: 'Every mark identical except one label — pure item-identity memory probe.',
                    apply: (spec, rows) => {
                        const order = [...rows].sort((a, b) => Number(b[m]) - Number(a[m]));
                        const target = order[Math.min(1, order.length - 1)]?.[col]; // rank-2 label
                        const replacement = pool[Math.floor(pool.length / 2)];
                        if (target == null) return undefined;
                        return {
                            spec: cloneSpec(spec),
                            rows: rows.map(r => r[col] === target ? { ...r, [col]: replacement } : { ...r }),
                            dataEditNote: `"${String(target).slice(0, 18)}" relabeled "${String(replacement).slice(0, 18)}" (real sibling value)`,
                        };
                    },
                });
            }
        }
    }

    return edits;
}

// ═════════════════════════════════════════════════════════════════════════
// Materialization — one edit, or a composed pair
// ═════════════════════════════════════════════════════════════════════════

/**
 * Apply a form edit, a content edit, or BOTH (form first, then content) and
 * return the resulting candidate. Returns null when an edit does not apply to
 * this chart or the result will not compile.
 *
 * A composed candidate is exactly "A then B" — the same two edits its sibling
 * single-axis lures carry. That is what makes a quiz item a clean 2×2: the
 * participant sees the original, A, B, and A+B, so a wrong pick says which
 * axis failed and the combined option says whether either alone was enough.
 */
export function materialize(
    chart: SessionChart,
    form: { edit: FormEdit; index: number } | undefined,
    content: { edit: ContentEdit; index: number } | undefined,
): DistractorCandidate | null {
    if (!form && !content) return null;

    let spec = chart.spec;
    let rows = chart.rows;
    let dataEditNote: string | undefined;
    const declaredEdits: SpecEdit[] = [...(form?.edit.declaredEdits ?? [])];

    if (form) {
        const next = form.edit.apply(spec);
        if (!next) return null;
        spec = next;
    }
    if (content) {
        const r = content.edit.apply(spec, rows);
        if (!r) return null;
        spec = r.spec;
        rows = r.rows;
        dataEditNote = r.dataEditNote;
        declaredEdits.push(...(r.declaredEdits ?? []));
    }
    if (specSignature(spec) === specSignature(chart.spec) && rows === chart.rows) return null;
    if (!compiles(spec, rows, chart.metadata)) return null;

    const method: Method = form && content ? 'combined' : form ? 'form' : 'content';
    const label = form && content ? `${form.edit.label} + ${content.edit.label}`
        : (form?.edit.label ?? content!.edit.label);
    const op = form && content ? `${form.edit.op}+${content.edit.op}`
        : (form?.edit.op ?? content!.edit.op);
    const rationale = form && content
        ? `Both axes at once. ${form.edit.rationale} And: ${content.edit.rationale}`
        : (form?.edit.rationale ?? content!.edit.rationale);

    return {
        method, op, label, rationale,
        spec, rows, metadata: chart.metadata,
        dataEditNote,
        declaredEdits: declaredEdits.length ? declaredEdits : undefined,
        formIndex: form?.index,
        contentIndex: content?.index,
    };
}

/**
 * Caps on the composition grid. Every (form, content) pair inside the caps is
 * materialized, because the quiz must be able to compose whichever A and B it
 * ends up choosing — a pair generated at random would not be the same A and B.
 * The caps bound that grid at 10 × 14 = 140 compile probes per chart, which is
 * cheap next to one render. Applied AFTER `interleaveByOp`, so what they trim
 * is a third mark target or a fourth filter, never a whole operation.
 */
export const FORM_CAP = 10;
export const CONTENT_CAP = 14;

export interface ChartCandidates {
    form: DistractorCandidate[];
    content: DistractorCandidate[];
    /** key `${formIndex}:${contentIndex}` → the composed candidate */
    pairs: Map<string, DistractorCandidate>;
}

export const pairKey = (formIndex: number, contentIndex: number) => `${formIndex}:${contentIndex}`;

/**
 * Every candidate for one chart: single-axis lures plus the full composition
 * grid over them. Must run inside `withSeededRandom` — mark edits call Flint's
 * recommender, which draws random numbers.
 */
export function generateCandidates(chart: SessionChart, session: SessionData): ChartCandidates {
    const fEdits = interleaveByOp(formEdits(chart)).slice(0, FORM_CAP);
    const cEdits = interleaveByOp(contentEdits(chart, session)).slice(0, CONTENT_CAP);

    const form: DistractorCandidate[] = [];
    const content: DistractorCandidate[] = [];
    const pairs = new Map<string, DistractorCandidate>();

    // Dedupe singles per axis; a duplicate spec is a duplicate option.
    const seenForm = new Set<string>();
    fEdits.forEach((edit, index) => {
        const c = materialize(chart, { edit, index }, undefined);
        if (!c) return;
        const sig = specSignature(c.spec);
        if (seenForm.has(sig)) return;
        seenForm.add(sig);
        form.push(c);
    });

    const seenContent = new Set<string>();
    cEdits.forEach((edit, index) => {
        const c = materialize(chart, undefined, { edit, index });
        if (!c) return;
        // rows can differ per edit, so key the dedupe on spec + operation
        const sig = `${specSignature(c.spec)}||${edit.op}:${edit.label}`;
        if (seenContent.has(sig)) return;
        seenContent.add(sig);
        content.push(c);
    });

    // Only pairs whose two halves both survived as singles: the quiz picks A
    // and B from those lists, so a pair over a dropped half is unreachable.
    for (const f of form) {
        for (const c of content) {
            const pair = materialize(
                chart,
                { edit: fEdits[f.formIndex!], index: f.formIndex! },
                { edit: cEdits[c.contentIndex!], index: c.contentIndex! },
            );
            if (pair) pairs.set(pairKey(f.formIndex!, c.contentIndex!), pair);
        }
    }

    return { form, content, pairs };
}

// ═════════════════════════════════════════════════════════════════════════

/**
 * Axis-purity violations. A form lure that changed the data, or a content
 * lure that changed the drawing, would corrupt the quiz's analysis — the
 * lure's axis is the *meaning* of a wrong answer.
 */
export function purityViolation(chart: SessionChart, c: DistractorCandidate): string | null {
    if (c.method === 'form') {
        if (c.rows !== chart.rows) return 'form lure changed the rows';
        const origEnc = chart.spec.encodings, newEnc = c.spec.encodings;
        for (const ch of Object.keys(newEnc)) {
            const o = Object.values(origEnc).find(e => e.field === newEnc[ch].field);
            if (o && ((o.sortOrder ?? '') !== (newEnc[ch].sortOrder ?? '')
                || (o.aggregate ?? '') !== (newEnc[ch].aggregate ?? ''))) {
                return 'form lure changed sort/aggregate';
            }
        }
    }
    if (c.method === 'content') {
        if (c.spec.chartType !== chart.spec.chartType) return 'content lure changed the chart type';
        const a = JSON.stringify(encFieldMap(chart.spec)), b = JSON.stringify(encFieldMap(c.spec));
        if (a !== b) return 'content lure changed the field mapping';
    }
    if (c.method === 'combined' && (c.formIndex === undefined || c.contentIndex === undefined)) {
        return 'combined lure is not a composition of a form and a content edit';
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
export function generateAll(chart: SessionChart, session: SessionData): DistractorCandidate[] {
    const { form, content, pairs } = generateCandidates(chart, session);
    return enforcePurity(chart, [...form, ...content, ...pairs.values()]);
}
