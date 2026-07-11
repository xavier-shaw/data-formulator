// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Analysis tree — a faithful reproduction of Battle & Heer's analysis graphs
// (Characterizing Exploratory Visual Analysis, EuroVis 2019, §6), complementary
// to the data thread: the thread is what the user chose to create, in order;
// the tree is the structure of the exploration itself.
//
// Model:
// - A node is an ANALYSIS STATE = the set of attributes currently being
//   analyzed (Wongsuphasawat et al.). In DF, a chart realizes a state; the
//   state is the set of RAW source attributes the chart analyzes (encoded raw
//   fields + raw columns referenced by the backing table's derivation code).
// - The session is a SEQUENCE of state visits (charts ordered by creation
//   time). Consecutive visits produce the raw transitions:
//     same set            → self-loop      (iterating in place — effort)
//     superset (added)    → forward edge   (deepening the current thread)
//     subset (removed)    → backward edge  (backtracking)
//     disjoint pivot      → implicit backtrack + branch: the new state
//                           attaches under the largest previously-VISITED
//                           subset of it (the dataset root when none exists).
// - Strip backward edges and self-loops → the SEARCH TREE, rooted at the
//   dataset. Paths are the analyst's exploratory trajectories.
//
// Metric semantics (Battle & Heer §6.2, replacing naive unique-state counts):
// - DEPTH = commitment to one thread: how far a line of inquiry is pushed
//   without backtracking (tree height; per-trajectory visit counts = effort).
// - BREADTH = number of distinct trajectories: each leaf is a separate
//   subtask, born from backtracking to an earlier state and striking off anew.
// - Self-loops mark states receiving extra iteration — effort landmarks.

import { Chart, DictTable, FieldItem } from '../components/ComponentType';

/** Structural stand-in for the study build's `studyTelemetry` slice section.
 *  Declared locally (not imported from dfSlice) so this module works on
 *  branches without the study instrumentation; pass `undefined` when absent
 *  and engagement overlays are simply omitted. */
export interface TelemetryLike {
    focusEvents: { f: { type: string; chartId?: string } | null; t: number; visible: boolean }[];
    interactionEvents: { action: string; chartId?: string; t: number }[];
}

// ─── types ───────────────────────────────────────────────────────────────────

export interface StateChartRef {
    chartId: string;
    chartType: string;
    title?: string;
    tableId: string;
    encodedFields: string[];   // display fields as encoded (incl. derived measures)
    tFirst: number | null;
}

export interface AnalysisStateNode {
    id: string;                // canonical: sorted attributes joined with '␟'; '' = root
    attributes: string[];      // sorted canonical raw-attribute names ([] = root)
    charts: StateChartRef[];   // chart realizations of this state (root: none)
    parentId: string | null;   // search-tree parent (null = root)
    depth: number;             // root = 0
    visits: number;            // times this state appears in the visit sequence
    selfLoops: number;         // consecutive re-visits (iteration in place)
    revisits: number;          // non-consecutive returns (backtracked to later)
    tFirst: number | null;
    engagement?: { dwellMs: number; visits: number; edits: number };
}

export type TransitionKind = 'forward' | 'backward' | 'self-loop' | 'pivot';

/** One consecutive step in the visit sequence (the raw graph's edges). */
export interface AnalysisTransition {
    from: string;              // state id
    to: string;
    kind: TransitionKind;
}

export interface AnalysisTrajectory {
    leafId: string;
    stateIds: string[];        // root → leaf path (root excluded)
    totalVisits: number;       // effort: visits (incl. self-loops) along the path
}

export interface AnalysisTreeMetrics {
    chartCount: number;
    stateCount: number;            // unique states (root excluded)
    height: number;                // max depth — DEPTH: commitment to one thread
    leafCount: number;             // trajectories — BREADTH: distinct threads
    maxWidth: number;              // widest depth level
    aspectRatio: number | null;    // maxWidth / height (B&H: <1 depth-oriented)
    totalSelfLoops: number;
    selfLoopStates: number;        // states iterated in place (effort landmarks)
    revisitedStates: number;       // states returned to after leaving
    attributeCoverage: { used: number; total: number };
    trajectories: AnalysisTrajectory[];   // sorted by totalVisits desc
}

export interface AnalysisTree {
    root: AnalysisStateNode;
    nodes: AnalysisStateNode[];    // excludes root; stable order (first visit)
    transitions: AnalysisTransition[];   // the raw graph, in sequence order
    metrics: AnalysisTreeMetrics;
    universe: string[];
}

export const STATE_ID_SEP = '␟';
export const ROOT_ID = '';

// ─── canonicalization (chart → raw-attribute state) ─────────────────────────

/** Quoted identifiers in derivation code — candidate raw-column references. */
const QUOTED_IDENT = /['"]([A-Za-z0-9_][A-Za-z0-9_ .\-]*)['"]/g;

const decodeChartTime = (chart: Chart, table: DictTable | undefined): number | null => {
    // Study builds stamp Chart.createdAt; read loosely so this compiles on
    // branches without that field and falls back to provenance timestamps.
    const explicit = (chart as { createdAt?: number }).createdAt;
    if (typeof explicit === 'number') return explicit;
    const instr = table?.derive?.trigger?.interaction?.find(e => e.role === 'instruction');
    if (instr?.timestamp) return instr.timestamp;
    const m = /^chart-(\d{10,})/.exec(chart.id);
    return m ? parseInt(m[1], 10) : null;
};

/**
 * Resolve the raw attributes a derived table analyzes: quoted identifiers in
 * its code that name raw-universe columns, recursively unioned with the raw
 * attributes of derived parents.
 */
const rawAttrsOfTable = (
    tableId: string,
    tablesById: Map<string, DictTable>,
    universe: Set<string>,
    memo: Map<string, Set<string>>,
    visiting: Set<string> = new Set(),
): Set<string> => {
    const cached = memo.get(tableId);
    if (cached) return cached;
    if (visiting.has(tableId)) return new Set();
    visiting.add(tableId);

    const table = tablesById.get(tableId);
    const out = new Set<string>();
    if (table?.derive) {
        const code = table.derive.code || '';
        for (const m of code.matchAll(QUOTED_IDENT)) {
            if (universe.has(m[1])) out.add(m[1]);
        }
        for (const parentId of table.derive.source || []) {
            const parent = tablesById.get(parentId);
            if (parent?.derive) {
                for (const a of rawAttrsOfTable(parentId, tablesById, universe, memo, visiting)) out.add(a);
            }
        }
    }
    visiting.delete(tableId);
    memo.set(tableId, out);
    return out;
};

/** The attribute set a chart analyzes (see module header). Empty = unresolvable. */
export const chartAttributeSet = (
    chart: Chart,
    tablesById: Map<string, DictTable>,
    fieldsById: Map<string, FieldItem>,
    universe: Set<string>,
    memo: Map<string, Set<string>>,
): { attrs: Set<string>; encodedFields: string[] } => {
    const encodedFields: string[] = [];
    const attrs = new Set<string>();
    for (const enc of Object.values(chart.encodingMap || {})) {
        const fid = (enc as any)?.fieldID;
        if (!fid) continue;
        const f = fieldsById.get(fid);
        if (!f) continue;
        if (!encodedFields.includes(f.name)) encodedFields.push(f.name);
        if (universe.has(f.name)) attrs.add(f.name);
    }
    for (const a of rawAttrsOfTable(chart.tableRef, tablesById, universe, memo)) attrs.add(a);
    // Fallback for fully-client-side sessions with no resolvable raw columns:
    // use the encoded field names themselves so the chart still forms a state.
    if (attrs.size === 0) for (const n of encodedFields) attrs.add(n);
    return { attrs, encodedFields };
};

// ─── construction ────────────────────────────────────────────────────────────

const isProperSubset = (a: string[], b: Set<string>): boolean =>
    a.length < b.size && a.every(x => b.has(x));

const chartEngagement = (telemetry: TelemetryLike | undefined, chartIds: string[]) => {
    if (!telemetry) return undefined;
    let dwellMs = 0, visits = 0, edits = 0;
    const ids = new Set(chartIds);
    const evs = telemetry.focusEvents;
    for (let i = 0; i < evs.length; i++) {
        const f = evs[i].f;
        if (f?.type === 'chart' && f.chartId && ids.has(f.chartId)) {
            visits++;
            if (i + 1 < evs.length && evs[i].visible) {
                dwellMs += Math.min(Math.max(0, evs[i + 1].t - evs[i].t), 120_000);
            }
        }
    }
    for (const e of telemetry.interactionEvents) {
        if (e.chartId && ids.has(e.chartId)) edits++;
    }
    return { dwellMs, visits, edits };
};

export const buildAnalysisTree = (
    charts: Chart[],
    tables: DictTable[],
    conceptShelfItems: FieldItem[],
    telemetry?: TelemetryLike,
): AnalysisTree => {
    const tablesById = new Map(tables.map(t => [t.id, t]));
    const fieldsById = new Map(conceptShelfItems.map(f => [f.id, f]));

    // Raw-attribute universe = columns of non-derived (source) tables.
    const universe = new Set<string>();
    for (const t of tables) {
        if (!t.derive) for (const n of t.names || []) universe.add(n);
    }

    // 1. The visit sequence: charts ordered by creation time (charts without a
    //    recoverable time keep their array order, after the timed ones).
    const memo = new Map<string, Set<string>>();
    const visits: { id: string; attrs: string[]; ref: StateChartRef }[] = [];
    for (const chart of charts) {
        if ((chart.source ?? 'user') !== 'user') continue;
        const { attrs, encodedFields } = chartAttributeSet(chart, tablesById, fieldsById, universe, memo);
        if (attrs.size === 0) continue;
        const sorted = [...attrs].sort();
        visits.push({
            id: sorted.join(STATE_ID_SEP),
            attrs: sorted,
            ref: {
                chartId: chart.id,
                chartType: chart.chartType,
                title: chart.title,
                tableId: chart.tableRef,
                encodedFields,
                tFirst: decodeChartTime(chart, tablesById.get(chart.tableRef)),
            },
        });
    }
    visits.sort((a, b) => (a.ref.tFirst ?? Number.MAX_SAFE_INTEGER) - (b.ref.tFirst ?? Number.MAX_SAFE_INTEGER));

    // 2. Walk the sequence: dedupe states, type each consecutive transition,
    //    and attach first-seen states to the search tree.
    const root: AnalysisStateNode = {
        id: ROOT_ID, attributes: [], charts: [], parentId: null,
        depth: 0, visits: 0, selfLoops: 0, revisits: 0, tFirst: null,
    };
    const nodesById = new Map<string, AnalysisStateNode>();
    const transitions: AnalysisTransition[] = [];
    let prevId: string | null = null;

    /** Search-tree parent for a newly seen state: the largest already-visited
     *  proper subset of it (most recently visited on ties); the root if none.
     *  This is B&H branching adapted to DF's non-incremental jumps: pivoting
     *  to a state that extends an earlier one = backtracking there + adding. */
    const attachParent = (attrs: string[]): AnalysisStateNode => {
        let best: AnalysisStateNode | null = null;
        const attrSet = new Set(attrs);
        for (const cand of nodesById.values()) {
            if (!isProperSubset(cand.attributes, attrSet)) continue;
            if (!best
                || cand.attributes.length > best.attributes.length
                || (cand.attributes.length === best.attributes.length && (cand.tFirst ?? 0) > (best.tFirst ?? 0))) {
                best = cand;
            }
        }
        return best ?? root;
    };

    for (const v of visits) {
        let node = nodesById.get(v.id);
        const isNew = !node;
        if (!node) {
            const parent = attachParent(v.attrs);
            node = {
                id: v.id, attributes: v.attrs, charts: [], parentId: parent.id,
                depth: parent.depth + 1, visits: 0, selfLoops: 0, revisits: 0,
                tFirst: v.ref.tFirst,
            };
            nodesById.set(v.id, node);
        }
        node.charts.push(v.ref);
        node.visits++;

        if (prevId !== null) {
            const prev = nodesById.get(prevId)!;
            let kind: TransitionKind;
            if (prevId === v.id) {
                kind = 'self-loop';
                node.selfLoops++;
            } else if (isProperSubset(prev.attributes, new Set(v.attrs))) {
                kind = 'forward';
            } else if (isProperSubset(v.attrs, new Set(prev.attributes))) {
                kind = 'backward';
            } else {
                kind = 'pivot';
            }
            transitions.push({ from: prevId, to: v.id, kind });
            if (!isNew && prevId !== v.id) node.revisits++;
        }
        prevId = v.id;
    }

    const nodes = [...nodesById.values()];
    for (const n of nodes) {
        n.engagement = chartEngagement(telemetry, n.charts.map(c => c.chartId));
    }

    // 3. Metrics (B&H tree-shape semantics).
    const childCount = new Map<string, number>();
    for (const n of nodes) {
        childCount.set(n.parentId!, (childCount.get(n.parentId!) || 0) + 1);
    }
    const leaves = nodes.filter(n => !childCount.has(n.id));
    const height = nodes.length ? Math.max(...nodes.map(n => n.depth)) : 0;
    const widthByDepth = new Map<number, number>();
    for (const n of nodes) widthByDepth.set(n.depth, (widthByDepth.get(n.depth) || 0) + 1);
    const maxWidth = nodes.length ? Math.max(...widthByDepth.values()) : 0;

    const pathOf = (leaf: AnalysisStateNode): string[] => {
        const path: string[] = [];
        for (let cur: AnalysisStateNode | undefined = leaf; cur && cur.id !== ROOT_ID;
            cur = nodesById.get(cur.parentId!)) {
            path.unshift(cur.id);
        }
        return path;
    };
    const trajectories: AnalysisTrajectory[] = leaves.map(leaf => {
        const stateIds = pathOf(leaf);
        return {
            leafId: leaf.id,
            stateIds,
            totalVisits: stateIds.reduce((s, id) => s + (nodesById.get(id)?.visits ?? 0), 0),
        };
    }).sort((a, b) => b.totalVisits - a.totalVisits || a.leafId.localeCompare(b.leafId));

    const usedAttrs = new Set<string>();
    for (const n of nodes) for (const a of n.attributes) usedAttrs.add(a);

    const metrics: AnalysisTreeMetrics = {
        chartCount: visits.length,
        stateCount: nodes.length,
        height,
        leafCount: leaves.length,
        maxWidth,
        aspectRatio: height > 0 ? maxWidth / height : null,
        totalSelfLoops: nodes.reduce((s, n) => s + n.selfLoops, 0),
        selfLoopStates: nodes.filter(n => n.selfLoops > 0).length,
        revisitedStates: nodes.filter(n => n.revisits > 0).length,
        attributeCoverage: { used: usedAttrs.size, total: universe.size || usedAttrs.size },
        trajectories,
    };

    return { root, nodes, transitions, metrics, universe: [...universe].sort() };
};
