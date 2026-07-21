import { describe, expect, it } from 'vitest';
import { Chart, DictTable, FieldItem, InteractionEntry } from '../../../../src/components/ComponentType';
import { Type } from '../../../../src/data/types';
import {
    SemanticChartItem, collectSemanticChartItems, normalizeSemanticThreads, semanticThreadsSignature,
} from '../../../../src/app/analysisSemanticThreads';

// Semantic threads = LLM-clustered topics over the session's charts. These
// tests cover the deterministic halves: collecting numbered chart items (same
// eligibility/numbering as the hybrid graph, so #N matches across views) and
// normalizing a model response against the real chart list.

const field = (name: string, tableRef: string): FieldItem =>
    ({ id: `${tableRef}--${name}`, name, source: 'original', tableRef } as FieldItem);

const rawTable = (id: string, cols: string[]): DictTable => ({
    kind: 'table', id, displayId: id, names: cols,
    metadata: Object.fromEntries(cols.map(c => [c, { type: Type.String, semanticType: '', levels: [] }])) as any,
    rows: [], virtual: { tableId: id, rowCount: 0 }, anchored: true, description: '',
});

const userPrompt = (text: string, t: number): InteractionEntry =>
    ({ from: 'user', to: 'data-agent', role: 'prompt', content: text, timestamp: t });

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

const fixture = () => {
    const src = rawTable('src', ['A', 'B', 'C']);
    const t1 = step('t1', 'src', ['A'], userPrompt('damage rate?', 1));
    const t2 = step('t2', 't1', ['A', 'B'], userPrompt('by species', 2));
    const t3 = step('t3', 't2', ['C'], userPrompt('airports now', 3));
    const tables = [src, t1, t2, t3];
    const conceptShelfItems = tables.flatMap(t => t.names.map(n => field(n, t.id)));
    const charts = [
        chart('c3', 't3', ['C'], 3, 'Strikes per airport'),
        chart('c1', 't1', ['A'], 1, 'Damage rate overall'),
        chart('c2', 't2', ['A', 'B'], 2, 'Damage rate by species'),
    ];
    return { tables, charts, conceptShelfItems };
};

const items = (): SemanticChartItem[] => {
    const { tables, charts, conceptShelfItems } = fixture();
    return collectSemanticChartItems(tables, charts, conceptShelfItems);
};

describe('collectSemanticChartItems', () => {
    it('numbers charts by creation time and carries title/attrs/prompt/dataset', () => {
        const out = items();
        expect(out.map(i => i.num)).toEqual([1, 2, 3]);
        expect(out.map(i => i.title)).toEqual(
            ['Damage rate overall', 'Damage rate by species', 'Strikes per airport']);
        expect(out[1].attributes).toEqual(['A', 'B']);
        expect(out[2].prompt).toBe('airports now');
        expect(out[2].promptSource).toBe('user');
        expect(out.every(i => i.datasetName === 'src')).toBe(true);
    });

    it('names an untitled chart from its encodings, never by id', () => {
        const { tables, charts, conceptShelfItems } = fixture();
        const untitled = charts.map(c => (c.id === 'c2' ? { ...c, title: undefined } : c));
        const out = collectSemanticChartItems(tables, untitled, conceptShelfItems);
        const c2 = out.find(i => i.chartId === 'c2')!;
        expect(c2.title).toBe('B by A');                 // y=B, x=A
        expect(out.every(i => i.title !== i.chartId)).toBe(true);
    });

    it('skips non-user charts and charts on unknown tables', () => {
        const { tables, charts, conceptShelfItems } = fixture();
        const extra = [
            { ...chart('cx', 't1', ['A'], 0, 'agent scratch'), source: 'agent' } as Chart,
            chart('cy', 'missing', ['A'], 0, 'orphan'),
        ];
        const out = collectSemanticChartItems(tables, [...charts, ...extra], conceptShelfItems);
        expect(out.map(i => i.chartId)).toEqual(['c1', 'c2', 'c3']);
    });
});

describe('semanticThreadsSignature', () => {
    it('changes when a title changes, stable otherwise', () => {
        const a = items(), b = items();
        expect(semanticThreadsSignature(a)).toBe(semanticThreadsSignature(b));
        b[0] = { ...b[0], title: 'renamed' };
        expect(semanticThreadsSignature(a)).not.toBe(semanticThreadsSignature(b));
    });
});

describe('normalizeSemanticThreads', () => {
    it('keeps model thread and chart order, resolving nums to items', () => {
        const out = normalizeSemanticThreads({
            threads: [
                { topic: 'Airports', summary: 'where', charts: [3] },
                { topic: 'Damage', summary: 'how bad', charts: [2, 1] },   // model reordered
            ],
        }, items());
        expect(out.threads.map(t => t.topic)).toEqual(['Airports', 'Damage']);
        expect(out.threads[1].charts.map(c => c.num)).toEqual([2, 1]);
        expect(out.metrics).toEqual({ chartCount: 3, threadCount: 2, maxThreadLength: 2 });
    });

    it('drops unknown nums, dedupes across threads, buckets leftovers', () => {
        const out = normalizeSemanticThreads({
            threads: [
                { topic: 'Damage', charts: [1, 99] },      // 99 doesn't exist
                { topic: 'Damage again', charts: [1] },     // duplicate → empty → dropped
            ],
        }, items());
        expect(out.threads.map(t => t.topic)).toEqual(['Damage', 'Ungrouped']);
        const fallback = out.threads[1];
        expect(fallback.isFallback).toBe(true);
        expect(fallback.charts.map(c => c.num)).toEqual([2, 3]);
    });

    it('handles empty/missing responses by bucketing everything', () => {
        const out = normalizeSemanticThreads(null, items());
        expect(out.threads).toHaveLength(1);
        expect(out.threads[0].isFallback).toBe(true);
        expect(out.threads[0].charts).toHaveLength(3);
        expect(normalizeSemanticThreads({ threads: [] }, []).threads).toHaveLength(0);
    });

    it('fills in a topic when the model omits one', () => {
        const out = normalizeSemanticThreads({ threads: [{ charts: [1, 2, 3] }] }, items());
        expect(out.threads[0].topic).toBe('Thread 1');
    });
});
