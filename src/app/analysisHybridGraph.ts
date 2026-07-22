// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Hybrid analysis graph — Battle & Heer's attribute-set states fused with the
// data thread's charts and prompts.
//
//   NODE = one unique ATTRIBUTE SET (the B&H analysis state). Every chart that
//     analyzes the same set collapses into one node (global merge → a true
//     graph, not a tree). The node is NAMED by the titles of its charts, each
//     tagged with a creation-time number (#1, #2, …), so you can read what the
//     state is about and when it was visited.
//
//   EDGE = a prompt-driven transition. Each chart contributes an edge from the
//     state of the table it was DERIVED from (`derive.trigger.tableId`) to its
//     own state, labeled with the prompt (the user's question, else the agent's
//     instruction) that produced it. Classification (checked in this order):
//       - lineage parent is a source/root table      → new thread from the root
//       - child set == parent set                    → self-loop (refine in place)
//       - child shares ≥1 attribute with the parent  → edge (related continuation)
//       - child shares NO attribute (disjoint pivot) → new thread from the root
//     i.e. an unrelated question starts a fresh thread rather than a misleading
//     edge to the previous chart.
//
// LAYOUT is driven by a spanning tree of BIRTH EDGES: each state is placed under
// the earliest (lowest-numbered) chart that reached it. Birth edges form a
// clean single-parent tree (a table can't derive from a later one; the first
// arrival at a new state is never a self-loop), so the tidy-tree layout applies
// directly. Self-loops and later re-arrivals at an already-born state are drawn
// as overlay arcs, and don't move a node from where it was first discovered.

import { Chart, DictTable, FieldItem, InteractionEntry } from '../components/ComponentType';
import { STATE_ID_SEP, chartAttributeSet } from './analysisGraph';
import { chartDisplayTitle } from './chartTitle';

export const ROOT_PREFIX = 'root:';

export interface HybridChartRef {
    num: number;                // creation-time index (1-based)
    chartId: string;
    chartType: string;
    title: string;              // display name — never an id (see chartTitle.ts)
}

export interface HybridNode {
    id: string;                 // state id (sorted attrs, STATE_ID_SEP) or `root:<tableId>`
    isRoot: boolean;
    attributes: string[];       // [] for roots
    label: string;              // root: dataset name; else all chart titles
    charts: HybridChartRef[];   // charts realizing this state (sorted by num)
    parentId: string | null;    // BIRTH-edge parent (layout tree); null for roots
    depth: number;              // root = 0
    firstNum: number;           // lowest chart number that reached this state
}

export type HybridEdgeKind = 'thread' | 'edge' | 'self-loop';

/** Who authored the prompt that drove a transition. */
export type PromptSource = 'user' | 'agent' | null;

export interface HybridEdge {
    from: string;
    to: string;
    label: string;              // clamped prompt (falls back to full)
    full: string;               // untruncated prompt
    source: PromptSource;       // user question vs agent instruction
    num: number;                // earliest chart number that caused this edge (birth-tree only)
    kind: HybridEdgeKind;
    isBirth: boolean;           // true = this is `to`'s placement (tree) edge
}

export interface HybridGraph {
    nodes: HybridNode[];        // includes roots
    edges: HybridEdge[];
    rootIds: string[];
    metrics: {
        chartCount: number;
        stateCount: number;     // non-root nodes
        threadCount: number;    // edges leaving a root (distinct exploratory threads)
        selfLoops: number;
        maxDepth: number;
    };
}

const stripMarkers = (s: string): string => s.replace(/\*\*([^*]+)\*\*/g, '$1');

/** The prompt that drove a step: the user's question, else the agent's instruction.
 *  Legacy sessions (and the bundled demos) recorded user asks as role
 *  'instruction'; anything `from: 'user'` is a user prompt regardless. */
export const promptOfTable = (t: DictTable | undefined): { text: string; source: PromptSource } => {
    const inter = t?.derive?.trigger?.interaction as InteractionEntry[] | undefined;
    let userPrompt = '', agentInstruction = '';
    for (const e of inter || []) {
        if (e.from === 'user' && (e.role === 'prompt' || e.role === 'instruction') && !userPrompt) {
            userPrompt = stripMarkers((e.displayContent || e.content || '').replace(/\s+/g, ' ').trim());
        } else if (e.from !== 'user' && e.role === 'instruction') {
            agentInstruction = stripMarkers((e.displayContent || e.content || '').replace(/\s+/g, ' ').trim());
        }
    }
    if (userPrompt) return { text: userPrompt, source: 'user' };
    if (agentInstruction) return { text: agentInstruction, source: 'agent' };
    return { text: '', source: null };
};

/** Creation time for ordering charts into #1..#N. */
export const chartTime = (chart: Chart, table: DictTable | undefined): number => {
    const explicit = (chart as { createdAt?: number }).createdAt;
    if (typeof explicit === 'number') return explicit;
    const inter = table?.derive?.trigger?.interaction as InteractionEntry[] | undefined;
    const ts = inter?.find(e => typeof e.timestamp === 'number')?.timestamp;
    if (typeof ts === 'number') return ts;
    const m = /^chart-(\d{10,})/.exec(chart.id);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
};

export const buildHybridGraph = (
    tables: DictTable[],
    charts: Chart[],
    conceptShelfItems: FieldItem[],
): HybridGraph => {
    const tablesById = new Map(tables.map(t => [t.id, t]));
    const fieldsById = new Map(conceptShelfItems.map(f => [f.id, f]));

    // Raw-attribute universe = columns of non-derived (source) tables.
    const universe = new Set<string>();
    for (const t of tables) if (!t.derive) for (const n of t.names || []) universe.add(n);
    const memo = new Map<string, Set<string>>();

    // 1. Every committed chart → its attribute-set state, ordered by time → #1..#N.
    const visits: { chart: Chart; table: DictTable; stateId: string; attrs: string[]; t: number }[] = [];
    for (const chart of charts) {
        if ((chart.source ?? 'user') !== 'user') continue;
        const table = tablesById.get(chart.tableRef);
        if (!table) continue;
        const { attrs } = chartAttributeSet(chart, tablesById, fieldsById, universe, memo);
        if (attrs.size === 0) continue;
        const sorted = [...attrs].sort();
        visits.push({ chart, table, stateId: sorted.join(STATE_ID_SEP), attrs: sorted, t: chartTime(chart, table) });
    }
    visits.sort((a, b) => a.t - b.t);

    // tableId → state of the (first) chart on it; used to resolve lineage parents.
    const stateByTable = new Map<string, string>();
    for (const v of visits) if (!stateByTable.has(v.table.id)) stateByTable.set(v.table.id, v.stateId);

    // Walk up `trigger.tableId` to the nearest CHARTED table (→ its state) or the
    // source dataset (→ a root node id). Skips transform-only, chartless steps.
    const nearestParent = (tableId: string): string => {
        const seen = new Set<string>();
        let cur: DictTable | undefined = tablesById.get(tableId);
        while (cur && cur.derive && !seen.has(cur.id)) {
            seen.add(cur.id);
            const st = stateByTable.get(cur.id);
            if (st) return st;
            const next = cur.derive.trigger?.tableId || cur.derive.source?.[0];
            cur = next ? tablesById.get(next) : undefined;
        }
        // Hit a source table (or dead end) → that dataset is the root.
        return ROOT_PREFIX + (cur?.id ?? tableId);
    };

    // The source dataset at the top of a table's lineage → its root node id.
    const datasetRoot = (tableId: string): string => {
        const seen = new Set<string>();
        let cur: DictTable | undefined = tablesById.get(tableId);
        while (cur && cur.derive && !seen.has(cur.id)) {
            seen.add(cur.id);
            const next = cur.derive.trigger?.tableId || cur.derive.source?.[0];
            cur = next ? tablesById.get(next) : undefined;
        }
        return ROOT_PREFIX + (cur?.id ?? tableId);
    };

    // 2. Nodes: group charts by state; give each a number in visit order.
    const nodesById = new Map<string, HybridNode>();
    const ensureRoot = (rootId: string) => {
        if (nodesById.has(rootId)) return;
        const tid = rootId.slice(ROOT_PREFIX.length);
        nodesById.set(rootId, {
            id: rootId, isRoot: true, attributes: [],
            label: tablesById.get(tid)?.displayId || tid,
            charts: [], parentId: null, depth: 0, firstNum: 0,
        });
    };
    visits.forEach((v, i) => {
        const num = i + 1;
        let node = nodesById.get(v.stateId);
        if (!node) {
            node = {
                id: v.stateId, isRoot: false, attributes: v.attrs, label: '',
                charts: [], parentId: null, depth: 0, firstNum: num,
            };
            nodesById.set(v.stateId, node);
        }
        node.charts.push({
            num, chartId: v.chart.id, chartType: v.chart.chartType,
            title: chartDisplayTitle(v.chart, fieldsById),
        });
    });
    for (const n of nodesById.values()) {
        if (!n.isRoot) n.label = n.charts.map(c => c.title).join('\n');
    }

    // 3. Edges: one per chart (deduped by from/to/prompt), classified.
    const attrsOf = (stateId: string): string[] => stateId ? stateId.split(STATE_ID_SEP) : [];
    const edgeMap = new Map<string, HybridEdge>();
    visits.forEach((v, i) => {
        const num = i + 1;
        const childId = v.stateId;
        const parentTableId = v.table.derive?.trigger?.tableId;
        const parentRef = parentTableId ? nearestParent(parentTableId) : datasetRoot(v.table.id);

        let from: string, kind: HybridEdgeKind;
        if (parentRef.startsWith(ROOT_PREFIX)) {
            ensureRoot(parentRef);
            from = parentRef; kind = 'thread';
        } else if (parentRef === childId) {
            from = childId; kind = 'self-loop';
        } else if (attrsOf(parentRef).some(a => v.attrs.includes(a))) {
            from = parentRef; kind = 'edge';
        } else {
            // disjoint pivot → new thread from this chart's dataset root
            const r = datasetRoot(v.table.id);
            ensureRoot(r);
            from = r; kind = 'thread';
        }

        const { text: full, source } = promptOfTable(v.table);
        const key = `${from} ${childId} ${full}`;
        const existing = edgeMap.get(key);
        if (existing) {
            existing.num = Math.min(existing.num, num);
        } else {
            edgeMap.set(key, { from, to: childId, label: full, full, source, num, kind, isBirth: false });
        }
    });
    const edges = [...edgeMap.values()];

    // 4. Birth edges = spanning tree for layout. Each non-root node's placement
    //    parent is the earliest non-self-loop edge into it.
    for (const n of nodesById.values()) {
        if (n.isRoot) continue;
        let birth: HybridEdge | null = null;
        for (const e of edges) {
            if (e.to !== n.id || e.kind === 'self-loop') continue;
            if (!birth || e.num < birth.num) birth = e;
        }
        if (birth) { birth.isBirth = true; n.parentId = birth.from; }
    }

    // depth via birth-parent chain (acyclic: parent.firstNum < child.firstNum).
    const depthOf = (n: HybridNode, seen = new Set<string>()): number => {
        if (!n.parentId || seen.has(n.id)) return 0;
        seen.add(n.id);
        const p = nodesById.get(n.parentId);
        return p ? depthOf(p, seen) + 1 : 0;
    };
    for (const n of nodesById.values()) n.depth = depthOf(n);

    const nodes = [...nodesById.values()];
    const rootIds = nodes.filter(n => n.isRoot).map(n => n.id);
    const nonRoot = nodes.filter(n => !n.isRoot);
    const rootSet = new Set(rootIds);

    return {
        nodes,
        edges,
        rootIds,
        metrics: {
            chartCount: visits.length,
            stateCount: nonRoot.length,
            threadCount: edges.filter(e => rootSet.has(e.from)).length,
            selfLoops: edges.filter(e => e.kind === 'self-loop').length,
            maxDepth: nodes.length ? Math.max(...nodes.map(n => n.depth)) : 0,
        },
    };
};
