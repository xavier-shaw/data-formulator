// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from 'vitest';
import { TraceChart, TraceMaterial } from '../../../../src/app/reasoningTrace';
import {
    OPTIONS_PER_ITEM, buildProvenanceAnswer, buildProvenanceMaterial, ProvenanceResponse,
} from '../../../../src/app/provenanceQuiz';

/** A chain a→b→c→d plus a second branch off a, so `previous` is exercised both ways. */
const chart = (id: string, num: number, parent: string | null, inReport = false): TraceChart => ({
    chartId: id, num, title: `chart ${id}`, chartType: 'bar', tableId: `t-${id}`,
    svg: '<svg/>', parentChartId: parent, actualPrompt: `prompt ${id}`, promptSource: 'user',
    inReport,
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
        const made = new Set(material().charts.map(c => c.chartId));
        expect(m.items.length).toBeGreaterThan(0);
        for (const item of m.items) {
            expect(item.options).toHaveLength(OPTIONS_PER_ITEM);
            expect(item.options.map(o => o.chartId)).toContain(item.answerChartId);
            // every option is a chart the participant actually made
            for (const o of item.options) expect(made.has(o.chartId)).toBe(true);
            // no duplicate option
            expect(new Set(item.options.map(o => o.chartId)).size).toBe(OPTIONS_PER_ITEM);
        }
    });

    it('never lets one item show the move another item asks about', () => {
        // The context reads "before that X, you were here Y" — which states that
        // Y followed X, and so answers any item asking what came after X.
        for (const seed of [1, 20260814, 77, 4242]) {
            const items = buildProvenanceMaterial(material(), { seed }).items;
            const asked = new Set(items.map(i => `${i.from.chartId}→${i.answerChartId}`));
            for (const item of items) {
                if (item.previous) {
                    expect(asked.has(`${item.previous.chartId}→${item.from.chartId}`)).toBe(false);
                }
            }
            // stronger, and what the sampler actually guarantees: an item's own
            // trace shares no chart with another's
            const shown = items.flatMap(i =>
                [i.previous?.chartId, i.from.chartId, i.answerChartId].filter(Boolean));
            expect(new Set(shown).size).toBe(shown.length);
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
        // A long enough chain that disjoint items are actually available: each
        // item claims three charts, so a short session yields fewer than asked.
        const chain = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
            .map((id, i) => chart(id, i + 1, i === 0 ? null : String.fromCharCode(96 + i)));
        const long: TraceMaterial = {
            sessionId: 's3', charts: chain, skipped: [],
            edges: chain.filter(c => c.parentChartId).map(c => ({ from: c.parentChartId!, to: c.chartId })),
        };
        expect(buildProvenanceMaterial(long, { count: 2 }).items).toHaveLength(2);
        expect(buildProvenanceMaterial(long).transitionsAvailable).toBe(9);
    });

    it('balances the items between report-touching and report-free stretches', () => {
        // Two separate threads of 8 charts each: one fully in the report, one
        // fully intermediate. Four items must land 2 + 2 across them.
        const thread = (prefix: string, inReport: boolean) =>
            Array.from({ length: 8 }, (_, i) =>
                chart(`${prefix}${i}`, i + 1, i === 0 ? null : `${prefix}${i - 1}`, inReport));
        const charts = [...thread('r', true), ...thread('i', false)];
        const mixed: TraceMaterial = {
            sessionId: 's4', charts, skipped: [],
            edges: charts.filter(c => c.parentChartId).map(c => ({ from: c.parentChartId!, to: c.chartId })),
        };
        for (const seed of [1, 20260814, 77, 4242]) {
            const items = buildProvenanceMaterial(mixed, { seed }).items;
            expect(items).toHaveLength(4);
            expect(items.filter(i => i.touchesReport)).toHaveLength(2);
        }
    });

    it('fills from the other bucket when a session has no report charts', () => {
        // The default material has no report chart at all; the report half of
        // the draw must cede its slots rather than shrink the run.
        const m = buildProvenanceMaterial(material());
        expect(m.items.length).toBeGreaterThan(0);
        for (const item of m.items) expect(item.touchesReport).toBe(false);
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
        touchesReport: false,
        optionNums: [2, 3, 4], confidence: 70, confidenceSet: true,
        actualPrompt: 'prompt b', promptSource: 'user', seconds: 9,
    });

    it('scores the picks and keeps every response', () => {
        const a = buildProvenanceAnswer([response(true), response(false), response(true)], 42);
        expect(a.form).toBe('provenance');
        expect(a.score).toEqual({ correct: 2, total: 3 });
        expect(a.seconds).toBe(42);
        // The confidence travels with the pick — calibration is read offline.
        expect(a.responses.every(r => r.confidence === 70)).toBe(true);
    });
});
