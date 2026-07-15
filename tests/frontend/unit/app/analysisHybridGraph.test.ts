import { describe, expect, it } from 'vitest';
import { Chart, DictTable, FieldItem, InteractionEntry } from '../../../../src/components/ComponentType';
import { Type } from '../../../../src/data/types';
import { ROOT_PREFIX, buildHybridGraph } from '../../../../src/app/analysisHybridGraph';

// The hybrid graph fuses B&H attribute-set states with the thread's charts and
// prompts: nodes are unique attribute sets (merged, named by chart titles);
// edges are the prompt that drove each lineage transition; a disjoint pivot
// (child shares no attribute with its lineage parent) starts a new thread.

const field = (name: string, tableRef: string): FieldItem =>
    ({ id: `${tableRef}--${name}`, name, source: 'original', tableRef } as FieldItem);

const rawTable = (id: string, cols: string[]): DictTable => ({
    kind: 'table', id, displayId: id, names: cols,
    metadata: Object.fromEntries(cols.map(c => [c, { type: Type.String, semanticType: '', levels: [] }])) as any,
    rows: [], virtual: { tableId: id, rowCount: 0 }, anchored: true, description: '',
});

const userPrompt = (text: string, t: number): InteractionEntry =>
    ({ from: 'user', to: 'data-agent', role: 'prompt', content: text, timestamp: t });

const agentInstr = (text: string, t: number): InteractionEntry =>
    ({ from: 'data-agent', to: 'user', role: 'instruction', content: text, timestamp: t });

const step = (id: string, parentTableId: string, cols: string[], prompt: InteractionEntry): DictTable => ({
    ...rawTable(id, cols), anchored: false,
    derive: {
        source: ['src'], code: cols.map(c => `'${c}'`).join(','), outputVariable: 'd', dialog: [],
        trigger: { tableId: parentTableId, resultTableId: id, interaction: [prompt] },
    },
});

const chart = (id: string, tableRef: string, fieldNames: string[], t: number, title: string): Chart => ({
    id, chartType: 'Bar Chart', tableRef, source: 'user', title, createdAt: t,
    encodingMap: Object.fromEntries(
        fieldNames.map((n, i) => [['x', 'y', 'color'][i], { fieldID: `${tableRef}--${n}` }]),
    ) as any,
} as Chart);

/**
 * src (root)
 *   ├─ #1 t1 {A}          "q1"            (thread)
 *   │   └─ #2 t2 {A}      "refine A"      (self-loop; merges into the {A} node)
 *   ├─ #3 t3 {B}          "q3 unrelated"  (lineage parent = t2 {A}, DISJOINT → new thread from root)
 *   │   └─ #4 t4 {B,C}    "q4"            (shares B → edge)
 */
const fixture = () => {
    const src = rawTable('src', ['A', 'B', 'C', 'D']);
    const t1 = step('t1', 'src', ['A'], userPrompt('q1', 1));
    const t2 = step('t2', 't1', ['A'], userPrompt('refine A', 2));
    const t3 = step('t3', 't2', ['B'], userPrompt('q3 unrelated', 3));
    const t4 = step('t4', 't3', ['B', 'C'], agentInstr('agent explores C', 4));
    const tables = [src, t1, t2, t3, t4];
    const conceptShelfItems = tables.flatMap(t => t.names.map(n => field(n, t.id)));
    const charts = [
        chart('c2', 't2', ['A'], 2, 'A refined'),
        chart('c1', 't1', ['A'], 1, 'A first'),      // out of array order — numbering follows time
        chart('c4', 't4', ['B', 'C'], 4, 'B and C'),
        chart('c3', 't3', ['B'], 3, 'B pivot'),
    ];
    return { tables, charts, conceptShelfItems };
};

describe('buildHybridGraph', () => {
    it('merges charts with the same attribute set into one node', () => {
        const { tables, charts, conceptShelfItems } = fixture();
        const g = buildHybridGraph(tables, charts, conceptShelfItems);
        expect(g.metrics.chartCount).toBe(4);
        expect(g.metrics.stateCount).toBe(3);            // {A}, {B}, {B,C}
        const a = g.nodes.find(n => n.attributes.join() === 'A')!;
        expect(a.charts.map(c => c.num).sort()).toEqual([1, 2]);   // #1 and #2 merged
        expect(a.charts.map(c => c.title)).toContain('A first');
    });

    it('numbers charts by creation time regardless of array order', () => {
        const { tables, charts, conceptShelfItems } = fixture();
        const g = buildHybridGraph(tables, charts, conceptShelfItems);
        const numOf = (title: string) => g.nodes.flatMap(n => n.charts).find(c => c.title === title)!.num;
        expect(numOf('A first')).toBe(1);
        expect(numOf('B and C')).toBe(4);
    });

    it('classifies edges: thread / self-loop / edge, and reroutes a disjoint pivot to root', () => {
        const { tables, charts, conceptShelfItems } = fixture();
        const g = buildHybridGraph(tables, charts, conceptShelfItems);
        const kindTo = (attrs: string, kind: string) =>
            g.edges.find(e => e.kind === kind && g.nodes.find(n => n.id === e.to)?.attributes.join() === attrs);

        // #1 opens {A} as a thread from root
        const openA = kindTo('A', 'thread')!;
        expect(openA.from.startsWith(ROOT_PREFIX)).toBe(true);
        expect(openA.label).toBe('q1');

        // #2 refines {A} in place → self-loop carrying its prompt
        const loopA = g.edges.find(e => e.kind === 'self-loop')!;
        expect(loopA.from).toBe(loopA.to);
        expect(loopA.label).toBe('refine A');

        // #3 {B} is disjoint from its lineage parent {A} → new thread from root, NOT an edge from {A}
        const openB = kindTo('B', 'thread')!;
        expect(openB.from.startsWith(ROOT_PREFIX)).toBe(true);
        expect(openB.label).toBe('q3 unrelated');

        // #4 {B,C} shares B with {B} → a related edge (not a new thread)
        const bc = kindTo('B,C', 'edge')!;
        expect(bc.from).toBe(g.nodes.find(n => n.attributes.join() === 'B')!.id);
    });

    it('tags each edge with its prompt source (user question vs agent instruction)', () => {
        const { tables, charts, conceptShelfItems } = fixture();
        const g = buildHybridGraph(tables, charts, conceptShelfItems);
        const toAttrs = (attrs: string) => g.edges.find(e => g.nodes.find(n => n.id === e.to)?.attributes.join() === attrs && e.kind !== 'self-loop')!;
        expect(toAttrs('A').source).toBe('user');       // "q1"
        expect(toAttrs('B,C').source).toBe('agent');     // "agent explores C"
        const loop = g.edges.find(e => e.kind === 'self-loop')!;
        expect(loop.source).toBe('user');               // "refine A"
    });

    it('births each state under the earliest edge into it (spanning tree for layout)', () => {
        const { tables, charts, conceptShelfItems } = fixture();
        const g = buildHybridGraph(tables, charts, conceptShelfItems);
        const node = (attrs: string) => g.nodes.find(n => n.attributes.join() === attrs)!;
        expect(node('A').parentId!.startsWith(ROOT_PREFIX)).toBe(true);   // thread head
        expect(node('B').parentId!.startsWith(ROOT_PREFIX)).toBe(true);   // disjoint pivot → root, not {A}
        expect(node('B,C').parentId).toBe(node('B').id);
        expect(node('B,C').depth).toBe(2);
        expect(g.metrics.threadCount).toBe(2);   // {A} and {B}
        expect(g.metrics.selfLoops).toBe(1);
    });
});
