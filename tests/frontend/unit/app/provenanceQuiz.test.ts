// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from 'vitest';
import { TraceChart, TraceMaterial } from '../../../../src/app/reasoningTrace';
import {
    OPTIONS_PER_ITEM, buildProvenanceAnswer, buildProvenanceMaterial, ProvenanceResponse,
} from '../../../../src/app/provenanceQuiz';

/** A chain a→b→c→d plus a second branch off a, so `previous` is exercised both ways. */
const chart = (id: string, num: number, parent: string | null): TraceChart => ({
    chartId: id, num, title: `chart ${id}`, chartType: 'bar', tableId: `t-${id}`,
    svg: '<svg/>', parentChartId: parent, actualPrompt: `prompt ${id}`, promptSource: 'user',
});

const material = (): TraceMaterial => {
    const charts = [
        chart('a', 1, null), chart('b', 2, 'a'), chart('c', 3, 'b'),
        chart('d', 4, 'c'), chart('e', 5, 'a'),
    ];
    return {
        sessionId: 's1',
        charts,
        edges: charts.filter(c => c.parentChartId).map(c => ({ from: c.parentChartId!, to: c.chartId })),
        skipped: [],
    };
};

describe('buildProvenanceMaterial', () => {
    it('offers three real charts per item, one of them the true next chart', () => {
        const m = buildProvenanceMaterial(material());
        expect(m.items.length).toBeGreaterThan(0);
        for (const item of m.items) {
            expect(item.options).toHaveLength(OPTIONS_PER_ITEM);
            expect(item.options.map(o => o.chartId)).toContain(item.answerChartId);
            // every option is a chart the participant actually made
            for (const o of item.options) expect(m.items.length && o.svg).toBeDefined();
            // no duplicate option
            expect(new Set(item.options.map(o => o.chartId)).size).toBe(OPTIONS_PER_ITEM);
        }
    });

    it('never offers the context charts as an answer — they are visible above', () => {
        for (const item of buildProvenanceMaterial(material()).items) {
            const ids = item.options.map(o => o.chartId);
            expect(ids).not.toContain(item.from.chartId);
            if (item.previous) expect(ids).not.toContain(item.previous.chartId);
        }
    });

    it('asks about real lineage moves, and shows the step before each one', () => {
        const truth = new Set(material().edges.map(e => `${e.from}→${e.to}`));
        for (const item of buildProvenanceMaterial(material()).items) {
            expect(truth.has(`${item.from.chartId}→${item.answerChartId}`)).toBe(true);
            expect(item.previous?.chartId ?? null).toBe(item.from.parentChartId);
        }
    });

    it('repeats exactly for a seed, and varies with a different one', () => {
        const key = (m: ReturnType<typeof buildProvenanceMaterial>) =>
            m.items.map(i => `${i.from.chartId}>${i.options.map(o => o.chartId).join(',')}`).join('|');
        expect(key(buildProvenanceMaterial(material()))).toBe(key(buildProvenanceMaterial(material())));
        expect(key(buildProvenanceMaterial(material(), { seed: 7 })))
            .not.toBe(key(buildProvenanceMaterial(material(), { seed: 999 })));
    });

    it('honours the item count and reports what the session had to offer', () => {
        const m = buildProvenanceMaterial(material(), { count: 2 });
        expect(m.items).toHaveLength(2);
        expect(m.transitionsAvailable).toBe(4);
    });

    it('produces nothing rather than a two-option item when charts run out', () => {
        const thin: TraceMaterial = {
            sessionId: 's2',
            charts: [chart('a', 1, null), chart('b', 2, 'a')],
            edges: [{ from: 'a', to: 'b' }],
            skipped: [],
        };
        expect(buildProvenanceMaterial(thin).items).toHaveLength(0);
    });
});

describe('buildProvenanceAnswer', () => {
    const response = (correct: boolean): ProvenanceResponse => ({
        itemId: 'i', fromChartId: 'a', fromNum: 1, answerChartId: 'b', answerNum: 2,
        pickedChartId: correct ? 'b' : 'c', pickedNum: correct ? 2 : 3, correct,
        optionNums: [2, 3, 4], rationale: 'wanted the split by year',
        actualPrompt: 'prompt b', promptSource: 'user', seconds: 9,
    });

    it('scores the picks and keeps every rationale', () => {
        const a = buildProvenanceAnswer([response(true), response(false), response(true)], 42);
        expect(a.form).toBe('provenance');
        expect(a.score).toEqual({ correct: 2, total: 3 });
        expect(a.seconds).toBe(42);
        expect(a.responses.every(r => r.rationale.length > 0)).toBe(true);
    });
});
