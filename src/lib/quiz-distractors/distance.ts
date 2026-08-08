// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * distractor-lab/distance.ts — quantitative distance between a distractor
 * and the original chart, on two orthogonal axes:
 *
 *  1. SPEC DISTANCE — GraphScape-inspired edit cost between chart-level
 *     specs (mark type, encoding fields, channels, sort). Computed by
 *     *diffing* two specs and summing atomic edit costs, so every
 *     generation method gets comparable numbers regardless of how the
 *     distractor was produced.
 *
 *  2. DATA DISTANCE — how different the *plotted values* are (rank
 *     agreement, magnitude change, label overlap). Captures perturbations
 *     GraphScape has no vocabulary for (same spec, different data).
 *
 * The quiz analysis this feeds: when a participant mis-recognizes, the
 * (specDist, dataDist) of the lure they chose tells us *what* they actually
 * encoded in memory — visual form (low specDist lures fool them) vs data
 * pattern (low dataDist lures fool them).
 *
 * Cost model follows GraphScape's ordering (Kim et al., CHI 2017):
 * within-family mark transitions < transpose < channel moves <
 * add/remove encoding < field replacement. Absolute values are our own
 * calibration, since GraphScape's learned weights target full VL specs.
 */

import { ChartLevelSpec, FieldMeta } from './extract';

// ── Edit cost table ──────────────────────────────────────────────────────

export const EDIT_COSTS = {
    SORT_FLIP: 0.5,
    CONFIG_TWEAK: 0.3,       // interpolate style, corner radius, ...
    MARK_NEAR: 1.0,          // same family: bar ↔ lollipop, line ↔ area
    MARK_MID: 1.8,           // adjacent family: bar ↔ line, line ↔ scatter
    MARK_FAR: 2.6,           // remote family: bar ↔ pie, line ↔ heatmap
    TRANSPOSE: 1.0,          // x/y swap
    CHANNEL_MOVE: 1.2,       // same field moves to a different channel
    ADD_ENCODING: 1.4,
    REMOVE_ENCODING: 1.4,
    AGGREGATE_CHANGE: 1.0,
    FIELD_REPLACE_SAME_TYPE: 2.0,
    FIELD_REPLACE_DIFF_TYPE: 2.8,
} as const;

/** Mark families for mark-transition cost. */
const MARK_FAMILIES: Record<string, string> = {
    'Bar Chart': 'bar', 'Bar Table': 'bar', 'Grouped Bar Chart': 'bar',
    'Stacked Bar Chart': 'bar', 'Pyramid Chart': 'bar', 'Lollipop Chart': 'bar',
    'Histogram': 'bar', 'Waterfall Chart': 'bar',
    'Line Chart': 'line', 'Area Chart': 'line', 'Bump Chart': 'line', 'Streamgraph': 'line',
    'Scatter Plot': 'point', 'Strip Plot': 'point', 'Ranged Dot Plot': 'point', 'Regression': 'point',
    'Pie Chart': 'radial', 'Rose Chart': 'radial', 'Radar Chart': 'radial',
    'Heatmap': 'grid',
};

/** Family adjacency: which families are perceptually "one step" apart. */
const FAMILY_ADJACENT: Record<string, string[]> = {
    bar: ['line', 'point'],
    line: ['bar', 'point'],
    point: ['bar', 'line', 'grid'],
    grid: ['point'],
    radial: [],
};

export function markTransitionCost(a: string, b: string): number {
    if (a === b) return 0;
    const fa = MARK_FAMILIES[a] ?? 'other';
    const fb = MARK_FAMILIES[b] ?? 'other';
    if (fa === fb) return EDIT_COSTS.MARK_NEAR;
    if (FAMILY_ADJACENT[fa]?.includes(fb)) return EDIT_COSTS.MARK_MID;
    return EDIT_COSTS.MARK_FAR;
}

// ── Spec diff → edit list + cost ─────────────────────────────────────────

export interface SpecEdit { op: string; detail: string; cost: number }

/**
 * Merge generator-DECLARED edits with diff-recovered ones.
 *
 * Some edits are invisible to a spec diff — a sort flip expressed on the
 * category channel changes the *rendered order* but the two chart-level
 * specs can differ only in a field a naive diff already accounts for, and a
 * row-order change is not a chart-level property at all. Those lures would
 * score (spec 0, data 0), i.e. the exact coordinate that means "identical" —
 * which would silently drop real misrecall events out of the analysis.
 *
 * So generators may declare edits at construction time; declared edits win
 * over a diffed edit of the same op, and are unioned with the rest.
 */
export function mergeEdits(declared: SpecEdit[] | undefined, diffed: SpecEdit[]): SpecEdit[] {
    if (!declared || declared.length === 0) return diffed;
    const declaredOps = new Set(declared.map(e => e.op));
    return [...declared, ...diffed.filter(e => !declaredOps.has(e.op))];
}

/**
 * Diff two chart-level specs into an approximate GraphScape edit list.
 * Handles: mark change, transpose (x/y swap counted once), channel moves,
 * field replacement, add/remove encoding, sort + aggregate changes.
 */
export function specDiff(
    original: ChartLevelSpec,
    variant: ChartLevelSpec,
    metadata: Record<string, FieldMeta>,
): SpecEdit[] {
    const edits: SpecEdit[] = [];

    if (original.chartType !== variant.chartType) {
        edits.push({
            op: 'MARK',
            detail: `${original.chartType} → ${variant.chartType}`,
            cost: markTransitionCost(original.chartType, variant.chartType),
        });
    }

    const oEnc = original.encodings, vEnc = variant.encodings;
    const handled = new Set<string>();

    // Transpose detection: x/y fields exactly swapped.
    // 'group' mirrors x on Grouped Bar; 'y' on Bar Table plays x's axis role —
    // treat the positional pair as (x|y) only.
    const ox = oEnc.x?.field, oy = oEnc.y?.field;
    const vx = vEnc.x?.field, vy = vEnc.y?.field;
    if (ox && oy && ox === vy && oy === vx) {
        edits.push({ op: 'TRANSPOSE', detail: `${ox} ⇄ ${oy}`, cost: EDIT_COSTS.TRANSPOSE });
        handled.add('x'); handled.add('y');
    }

    const channels = new Set([...Object.keys(oEnc), ...Object.keys(vEnc)]);
    for (const ch of channels) {
        if (handled.has(ch)) continue;
        const o = oEnc[ch], v = vEnc[ch];
        if (o?.field === v?.field) {
            // same field — check modifiers
            if (o && v) {
                if ((o.sortOrder ?? '') !== (v.sortOrder ?? '')) {
                    edits.push({ op: 'SORT', detail: `${ch}: ${o.sortOrder ?? 'default'} → ${v.sortOrder ?? 'default'}`, cost: EDIT_COSTS.SORT_FLIP });
                }
                if ((o.aggregate ?? '') !== (v.aggregate ?? '')) {
                    edits.push({ op: 'AGGREGATE', detail: `${ch}: ${o.aggregate ?? 'none'} → ${v.aggregate ?? 'none'}`, cost: EDIT_COSTS.AGGREGATE_CHANGE });
                }
            }
            continue;
        }
        if (o?.field && !v?.field) {
            // removed — unless the field re-appears on another channel (move)
            const movedTo = Object.entries(vEnc).find(([ch2, e2]) => ch2 !== ch && e2.field === o.field && oEnc[ch2]?.field !== o.field);
            if (movedTo) {
                edits.push({ op: 'MOVE', detail: `${o.field}: ${ch} → ${movedTo[0]}`, cost: EDIT_COSTS.CHANNEL_MOVE });
                handled.add(movedTo[0]);
            } else {
                edits.push({ op: 'REMOVE', detail: `${ch}: ${o.field}`, cost: EDIT_COSTS.REMOVE_ENCODING });
            }
            continue;
        }
        if (!o?.field && v?.field) {
            const movedFrom = Object.entries(oEnc).find(([ch2, e2]) => ch2 !== ch && e2.field === v.field && vEnc[ch2]?.field !== v.field);
            if (movedFrom) continue; // counted as MOVE above / below
            edits.push({ op: 'ADD', detail: `${ch}: ${v.field}`, cost: EDIT_COSTS.ADD_ENCODING });
            continue;
        }
        if (o?.field && v?.field) {
            const sameType = (metadata[o.field]?.type ?? '?') === (metadata[v.field]?.type ?? '??');
            edits.push({
                op: 'FIELD',
                detail: `${ch}: ${o.field} → ${v.field}`,
                cost: sameType ? EDIT_COSTS.FIELD_REPLACE_SAME_TYPE : EDIT_COSTS.FIELD_REPLACE_DIFF_TYPE,
            });
        }
    }

    // config tweaks (interpolate etc.)
    const oCfg = JSON.stringify(original.config ?? {});
    const vCfg = JSON.stringify(variant.config ?? {});
    if (oCfg !== vCfg) {
        edits.push({ op: 'CONFIG', detail: 'chart property tweak', cost: EDIT_COSTS.CONFIG_TWEAK });
    }

    return edits;
}

export function specDistance(edits: SpecEdit[]): number {
    return +edits.reduce((s, e) => s + e.cost, 0).toFixed(2);
}

// ── Data distance ────────────────────────────────────────────────────────

function spearman(a: number[], b: number[]): number {
    const n = a.length;
    if (n < 2) return 1;
    const rank = (xs: number[]) => {
        const idx = xs.map((v, i) => [v, i] as [number, number]).sort((p, q) => p[0] - q[0]);
        const r = new Array(n).fill(0);
        idx.forEach(([, i], k) => { r[i] = k; });
        return r;
    };
    const ra = rank(a), rb = rank(b);
    const d2 = ra.reduce((s, r, i) => s + (r - rb[i]) ** 2, 0);
    return 1 - (6 * d2) / (n * (n * n - 1));
}

export interface DataDistance {
    /** 0 = identical ranks, 1 = fully reversed */
    rank: number;
    /** normalized RMSE of the measure, relative to its range */
    magnitude: number;
    /** 1 - Jaccard overlap of category label sets */
    label: number;
    /**
     * Normalized Kendall-tau distance of the *displayed* row sequence.
     * Filled in by the caller via `displayedOrder()` on the compiled specs —
     * `dataDistance` alone cannot see it, since a sort lure changes no rows.
     * Reported for diagnostics only, deliberately NOT folded into `overall`:
     * presentation order is a spec property (GraphScape counts sort as a spec
     * edit), so a sort flip must move the lure along the spec axis, not data.
     */
    order: number;
    /** headline number: max of the VALUE components (a lure is only as "same" as its most-changed aspect) */
    overall: number;
}

/**
 * The order the viewer actually sees, read off the COMPILED spec.
 *
 * Row order in the data is not the displayed order: a sort lure leaves rows
 * untouched and reorders at render time via the spec's sort directive, and a
 * Bar Table always re-sorts into an explicit domain array regardless of rows.
 * Reading the compiled spec is the only way to compare what was on screen.
 */
export function displayedOrder(vl: any, categoryField: string | undefined, rows: any[]): string[] {
    if (!categoryField) return [];
    const dataOrder = () => rows.map(r => String(r[categoryField]));

    // Find the sort directive on whichever channel encodes the category field.
    let sort: any;
    const unescape = (s: string) => String(s).replace(/\\/g, '');
    const walk = (o: any): void => {
        if (!o || typeof o !== 'object' || sort !== undefined) return;
        if (typeof o.field === 'string' && unescape(o.field) === categoryField && 'sort' in o && o.sort != null) {
            sort = o.sort;
            return;
        }
        for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v);
    };
    walk(vl);

    const byField = (field: string, dir: number) => [...rows]
        .sort((a, b) => dir * (Number(a[field]) - Number(b[field])))
        .map(r => String(r[categoryField]));

    if (Array.isArray(sort)) return sort.map(String);
    if (sort === 'ascending') return [...new Set(dataOrder())].sort();
    if (sort === 'descending') return [...new Set(dataOrder())].sort().reverse();
    if (sort && typeof sort === 'object' && typeof sort.field === 'string') {
        return byField(unescape(sort.field), sort.order === 'descending' ? -1 : 1);
    }
    // Vega-Lite channel shorthand: "y" / "-y" — sort the discrete axis by the
    // field encoded on that channel. Emitted whenever sortBy is used.
    if (typeof sort === 'string' && /^-?(x|y|color)$/.test(sort)) {
        const ch = sort.replace('-', '');
        let refField: string | undefined;
        const findCh = (o: any): void => {
            if (!o || typeof o !== 'object' || refField) return;
            if (o[ch] && typeof o[ch].field === 'string') { refField = unescape(o[ch].field); return; }
            for (const v of Object.values(o)) if (v && typeof v === 'object') findCh(v);
        };
        findCh(vl.encoding ?? vl);
        if (refField) return byField(refField, sort.startsWith('-') ? -1 : 1);
    }
    return dataOrder();
}

/** Normalized Kendall-tau distance between two orderings of the same key set. */
export function kendallTauDistance(a: string[], b: string[]): number {
    const pos = new Map(b.map((k, i) => [k, i]));
    const seq = a.map(k => pos.get(k)).filter((v): v is number => v !== undefined);
    const n = seq.length;
    if (n < 2) return 0;
    let inversions = 0;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) if (seq[i] > seq[j]) inversions++;
    }
    return inversions / ((n * (n - 1)) / 2);
}

/**
 * Compare plotted values of two row sets, keyed by the chart's category
 * field, over its measure field.
 */
export function dataDistance(
    origRows: any[],
    varRows: any[],
    categoryField: string | undefined,
    measureField: string | undefined,
): DataDistance {
    const zero: DataDistance = { rank: 0, magnitude: 0, label: 0, order: 0, overall: 0 };
    if (!measureField) return zero;

    const key = (r: any, i: number) => categoryField ? String(r[categoryField]) : String(i);
    const oMap = new Map(origRows.map((r, i) => [key(r, i), Number(r[measureField])]));
    const vMap = new Map(varRows.map((r, i) => [key(r, i), Number(r[measureField])]));

    const oKeys = new Set(oMap.keys());
    const vKeys = new Set(vMap.keys());
    const shared = [...oKeys].filter(k => vKeys.has(k));
    const union = new Set([...oKeys, ...vKeys]);
    const label = union.size ? 1 - shared.length / union.size : 0;

    let rank = 0, magnitude = 0;
    const oVals = shared.map(k => oMap.get(k)!).filter(v => Number.isFinite(v));
    const vVals = shared.map(k => vMap.get(k)!).filter(v => Number.isFinite(v));
    if (oVals.length >= 2 && oVals.length === vVals.length) {
        rank = Math.min(1, Math.max(0, (1 - spearman(oVals, vVals)) / 2));
        const range = Math.max(...oVals) - Math.min(...oVals) || 1;
        const rmse = Math.sqrt(oVals.reduce((s, v, i) => s + (v - vVals[i]) ** 2, 0) / oVals.length);
        magnitude = Math.min(1, rmse / range);
    }

    // Row-order fallback; the caller overwrites this with the compiled-spec
    // display order, which is what the participant actually saw.
    const order = kendallTauDistance(
        origRows.map((r, i) => key(r, i)),
        varRows.map((r, i) => key(r, i)),
    );

    const overall = Math.max(rank, magnitude, label);
    const r2 = (x: number) => +x.toFixed(3);
    return { rank: r2(rank), magnitude: r2(magnitude), label: r2(label), order: r2(order), overall: r2(overall) };
}
