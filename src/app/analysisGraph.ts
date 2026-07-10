// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Analysis graph — a structural, analysis-centered representation of a session,
// complementary to the (user-centered, temporal) data thread. Both are derived
// from the same source state; this one answers "what was explored, how deep,
// how broad" rather than "what did the user do, in order".
//
// Model (Battle & Heer 2019 §6.1, after Wongsuphasawat et al.):
//   "an analysis state is the set of attributes currently being analyzed, for
//    which a user may specify visual encodings, apply filters, or group and
//    aggregate the data."
//
// Nodes: distinct RAW-attribute sets. DF charts mostly encode derived measure
// columns with per-table names (e.g. `serious_damage_rate`), so we resolve each
// chart to the raw source-dataset attributes it analyzes: encoded fields that
// are raw columns, plus raw columns referenced by the backing table's
// derivation code (the DF analog of Tableau's encoding+filter shelves).
//
// Edges (purely structural — no behavioral/temporal meaning):
//   - refinement: A → B iff attrs(A) ⊂ attrs(B) with no observed intermediate
//     (the Hasse diagram of the containment partial order). The structural twin
//     of Battle & Heer's "added an attribute" forward edge.
//   - overlap: a maximum-spanning-forest over Jaccard similarity between nodes
//     not already connected by containment. Keeps thematic hubs (e.g. seven
//     states sharing DAMAGE_LEVEL) connected without a similarity hairball.
//
// Time and engagement are node PROPERTIES (overlays), never edges — the thread
// owns ordering; this graph stays order-free.

import { Chart, DictTable, FieldItem } from '../components/ComponentType';

/** Structural stand-in for the study build's `studyTelemetry` slice section.
 *  Declared locally (not imported from dfSlice) so this module works on
 *  branches without the study instrumentation; pass `undefined` when absent
 *  and engagement overlays are simply omitted. */
export interface TelemetryLike {
    focusEvents: { f: { type: string; chartId?: string } | null; t: number; visible: boolean }[];
    interactionEvents: { action: string; chartId?: string; t: number }[];
}

// ─── tunables ────────────────────────────────────────────────────────────────
export const OVERLAP_JACCARD_MIN = 0.2;   // overlap edges below this are never drawn
export const ANCHOR_ATTR_SHARE = 0.6;     // attr present in ≥ this share of a component's nodes = anchor

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
    id: string;                // canonical: sorted attributes joined with '␟'
    attributes: string[];      // sorted canonical raw-attribute names
    charts: StateChartRef[];
    tableIds: string[];
    tFirst: number | null;     // earliest chart realization
    tLast: number | null;
    depthLevel: number;        // longest containment chain ending at this node (1-based)
    componentId: number;
    engagement?: { dwellMs: number; visits: number; edits: number };
}

export type AnalysisEdgeKind = 'refinement' | 'overlap';

export interface AnalysisGraphEdge {
    source: string;            // node id (for refinement: the smaller set)
    target: string;
    kind: AnalysisEdgeKind;
    /** overlap only: Jaccard similarity of the two attribute sets */
    jaccard?: number;
    /** overlap only: the shared attributes */
    shared?: string[];
}

export interface AttributeStat {
    name: string;
    states: number;            // # states containing it
    charts: number;            // # charts analyzing it
    maxDepth: number;          // deepest containment chain among states containing it
}

export interface AnalysisComponentInfo {
    id: number;
    nodeIds: string[];
    anchorAttributes: string[];  // attributes shared by most of the component
}

export interface AnalysisGraphMetrics {
    chartCount: number;
    stateCount: number;          // breadth: distinct states explored
    componentCount: number;      // breadth: separate lines of inquiry
    leafCount: number;           // maximal states (no observed superset)
    maxDepth: number;            // longest containment chain (nodes)
    maxBreadth: number;          // widest depth-level (states at one level)
    aspectRatio: number | null;  // maxBreadth / maxDepth (B&H: <1 = depth-oriented)
    attributeCoverage: { used: number; total: number };
    attributeStats: AttributeStat[];    // sorted by states desc
    deepestChain: string[];      // node ids along one longest chain
}

export interface AnalysisGraph {
    nodes: AnalysisStateNode[];
    edges: AnalysisGraphEdge[];
    components: AnalysisComponentInfo[];
    metrics: AnalysisGraphMetrics;
    universe: string[];          // all raw attributes available in the session
}

export const STATE_ID_SEP = '␟';

// ─── canonicalization ────────────────────────────────────────────────────────

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
 * attributes of derived parents (a step that reads a parent's output analyzes
 * whatever that parent analyzed).
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

// ─── graph construction ──────────────────────────────────────────────────────

const isSubset = (a: string[], b: Set<string>): boolean => a.every(x => b.has(x));

const jaccard = (a: Set<string>, b: Set<string>): { j: number; shared: string[] } => {
    const shared = [...a].filter(x => b.has(x));
    const union = a.size + b.size - shared.length;
    return { j: union === 0 ? 0 : shared.length / union, shared };
};

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

export const buildAnalysisGraph = (
    charts: Chart[],
    tables: DictTable[],
    conceptShelfItems: FieldItem[],
    telemetry?: TelemetryLike,
): AnalysisGraph => {
    const tablesById = new Map(tables.map(t => [t.id, t]));
    const fieldsById = new Map(conceptShelfItems.map(f => [f.id, f]));

    // Raw-attribute universe = columns of non-derived (source) tables.
    const universe = new Set<string>();
    for (const t of tables) {
        if (!t.derive) for (const n of t.names || []) universe.add(n);
    }

    // 1. Canonicalize each chart to an attribute set; group into state nodes.
    const memo = new Map<string, Set<string>>();
    const bySignature = new Map<string, { attrs: string[]; attrSet: Set<string>; charts: StateChartRef[]; tableIds: Set<string> }>();
    let chartCount = 0;
    for (const chart of charts) {
        if ((chart.source ?? 'user') !== 'user') continue;
        const { attrs, encodedFields } = chartAttributeSet(chart, tablesById, fieldsById, universe, memo);
        if (attrs.size === 0) continue;   // blank chart, no state
        chartCount++;
        const sorted = [...attrs].sort();
        const id = sorted.join(STATE_ID_SEP);
        let entry = bySignature.get(id);
        if (!entry) {
            entry = { attrs: sorted, attrSet: new Set(sorted), charts: [], tableIds: new Set() };
            bySignature.set(id, entry);
        }
        entry.charts.push({
            chartId: chart.id,
            chartType: chart.chartType,
            title: chart.title,
            tableId: chart.tableRef,
            encodedFields,
            tFirst: decodeChartTime(chart, tablesById.get(chart.tableRef)),
        });
        entry.tableIds.add(chart.tableRef);
    }

    const nodes: AnalysisStateNode[] = [...bySignature.entries()].map(([id, e]) => {
        const times = e.charts.map(c => c.tFirst).filter((t): t is number => t !== null);
        return {
            id,
            attributes: e.attrs,
            charts: e.charts,
            tableIds: [...e.tableIds],
            tFirst: times.length ? Math.min(...times) : null,
            tLast: times.length ? Math.max(...times) : null,
            depthLevel: 1,
            componentId: -1,
            engagement: chartEngagement(telemetry, e.charts.map(c => c.chartId)),
        };
    }).sort((a, b) => a.id.localeCompare(b.id));

    const nodeById = new Map(nodes.map(n => [n.id, n]));
    const attrSets = new Map(nodes.map(n => [n.id, new Set(n.attributes)]));

    // 2. Refinement edges: Hasse diagram of the ⊂ partial order.
    const properSubset = (a: AnalysisStateNode, b: AnalysisStateNode) =>
        a.attributes.length < b.attributes.length && isSubset(a.attributes, attrSets.get(b.id)!);
    const edges: AnalysisGraphEdge[] = [];
    for (const a of nodes) {
        for (const b of nodes) {
            if (!properSubset(a, b)) continue;
            // immediate cover: no observed c with a ⊂ c ⊂ b
            const hasIntermediate = nodes.some(c =>
                c.id !== a.id && c.id !== b.id && properSubset(a, c) && properSubset(c, b));
            if (!hasIntermediate) edges.push({ source: a.id, target: b.id, kind: 'refinement' });
        }
    }

    // 3. Overlap edges: maximum-spanning-forest over Jaccard between nodes not
    //    already connected via containment (in either direction, transitively).
    //    Union-find over refinement edges first, then greedily add best overlaps.
    const parent = new Map(nodes.map(n => [n.id, n.id]));
    const find = (x: string): string => {
        let r = x;
        while (parent.get(r) !== r) r = parent.get(r)!;
        parent.set(x, r);
        return r;
    };
    const union = (x: string, y: string) => { parent.set(find(x), find(y)); };
    for (const e of edges) union(e.source, e.target);

    const candidates: { a: string; b: string; j: number; shared: string[] }[] = [];
    for (let i = 0; i < nodes.length; i++) {
        for (let k = i + 1; k < nodes.length; k++) {
            const { j, shared } = jaccard(attrSets.get(nodes[i].id)!, attrSets.get(nodes[k].id)!);
            if (j >= OVERLAP_JACCARD_MIN && shared.length > 0) {
                candidates.push({ a: nodes[i].id, b: nodes[k].id, j, shared });
            }
        }
    }
    candidates.sort((x, y) => y.j - x.j || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
    for (const c of candidates) {
        if (find(c.a) !== find(c.b)) {
            union(c.a, c.b);
            edges.push({ source: c.a, target: c.b, kind: 'overlap', jaccard: c.j, shared: c.shared });
        }
    }

    // 4. Components (over all edges).
    const componentRoots = new Map<string, number>();
    let componentCount = 0;
    for (const n of nodes) {
        const root = find(n.id);
        if (!componentRoots.has(root)) componentRoots.set(root, componentCount++);
        n.componentId = componentRoots.get(root)!;
    }
    const components: AnalysisComponentInfo[] = [...componentRoots.values()].map(id => {
        const nodeIds = nodes.filter(n => n.componentId === id).map(n => n.id);
        const counts = new Map<string, number>();
        for (const nid of nodeIds) {
            for (const a of nodeById.get(nid)!.attributes) counts.set(a, (counts.get(a) || 0) + 1);
        }
        const anchorAttributes = [...counts.entries()]
            .filter(([, c]) => c >= Math.max(2, Math.ceil(nodeIds.length * ANCHOR_ATTR_SHARE)))
            .sort((x, y) => y[1] - x[1])
            .map(([a]) => a);
        return { id, nodeIds, anchorAttributes };
    }).sort((a, b) => a.id - b.id);

    // 5. Depth levels: longest containment chain ending at each node (DAG DP).
    const refinementIn = new Map<string, string[]>();
    for (const e of edges) {
        if (e.kind !== 'refinement') continue;
        if (!refinementIn.has(e.target)) refinementIn.set(e.target, []);
        refinementIn.get(e.target)!.push(e.source);
    }
    const ordered = [...nodes].sort((a, b) => a.attributes.length - b.attributes.length);
    const chainPrev = new Map<string, string | null>();
    for (const n of ordered) {
        let best = 1, prev: string | null = null;
        for (const p of refinementIn.get(n.id) || []) {
            const cand = nodeById.get(p)!.depthLevel + 1;
            if (cand > best) { best = cand; prev = p; }
        }
        n.depthLevel = best;
        chainPrev.set(n.id, prev);
    }

    // 6. Metrics.
    const maxDepth = nodes.length ? Math.max(...nodes.map(n => n.depthLevel)) : 0;
    const levelWidths = new Map<number, number>();
    for (const n of nodes) levelWidths.set(n.depthLevel, (levelWidths.get(n.depthLevel) || 0) + 1);
    const maxBreadth = nodes.length ? Math.max(...levelWidths.values()) : 0;

    const hasSuperset = new Set(edges.filter(e => e.kind === 'refinement').map(e => e.source));
    const leafCount = nodes.filter(n => !hasSuperset.has(n.id)).length;

    const deepestChain: string[] = [];
    const deepest = nodes.reduce<AnalysisStateNode | null>(
        (acc, n) => (acc === null || n.depthLevel > acc.depthLevel ? n : acc), null);
    for (let cur: string | null = deepest?.id ?? null; cur; cur = chainPrev.get(cur) ?? null) {
        deepestChain.unshift(cur);
    }

    const attrStats = new Map<string, AttributeStat>();
    for (const n of nodes) {
        for (const a of n.attributes) {
            const s = attrStats.get(a) || { name: a, states: 0, charts: 0, maxDepth: 0 };
            s.states++;
            s.charts += n.charts.length;
            s.maxDepth = Math.max(s.maxDepth, n.depthLevel);
            attrStats.set(a, s);
        }
    }

    const metrics: AnalysisGraphMetrics = {
        chartCount,
        stateCount: nodes.length,
        componentCount,
        leafCount,
        maxDepth,
        maxBreadth,
        aspectRatio: maxDepth > 0 ? maxBreadth / maxDepth : null,
        attributeCoverage: { used: attrStats.size, total: universe.size || attrStats.size },
        attributeStats: [...attrStats.values()].sort((a, b) => b.states - a.states || a.name.localeCompare(b.name)),
        deepestChain,
    };

    return { nodes, edges, components, metrics, universe: [...universe].sort() };
};
