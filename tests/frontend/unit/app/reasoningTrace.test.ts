// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from 'vitest';
import { scoreTraceTree, shuffledTraceCharts, TraceChart } from '../../../../src/app/reasoningTrace';

const truth = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'a', to: 'd' },
];

describe('scoreTraceTree', () => {
    it('scores a perfect reconstruction as full recall and precision', () => {
        const s = scoreTraceTree(truth, truth);
        expect(s).toMatchObject({ hits: 3, misses: 0, extras: 0, precision: 1, recall: 1 });
    });

    it('counts a mis-directed edge as a hit — the pair was remembered', () => {
        const s = scoreTraceTree([{ from: 'b', to: 'a' }], truth);
        expect(s.hits).toBe(1);
        expect(s.extras).toBe(0);
        expect(s.misses).toBe(2);
    });

    it('separates invented links from missing ones', () => {
        const s = scoreTraceTree([{ from: 'a', to: 'b' }, { from: 'c', to: 'd' }], truth);
        expect(s).toMatchObject({ hits: 1, misses: 2, extras: 1 });
        expect(s.precision).toBeCloseTo(0.5);
        expect(s.recall).toBeCloseTo(1 / 3);
    });

    it('handles an empty drawing: nothing invented, everything missed', () => {
        const s = scoreTraceTree([], truth);
        expect(s).toMatchObject({ hits: 0, misses: 3, extras: 0, precision: 0, recall: 0 });
    });
});

describe('shuffledTraceCharts', () => {
    const charts = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id, i) => ({
        chartId: id, num: i + 1,
    })) as TraceChart[];

    it('is deterministic and keeps every chart', () => {
        const a = shuffledTraceCharts(charts);
        const b = shuffledTraceCharts(charts);
        expect(a.map(c => c.chartId)).toEqual(b.map(c => c.chartId));
        expect([...a].map(c => c.chartId).sort()).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    });

    it('does not present creation order', () => {
        const a = shuffledTraceCharts(charts);
        expect(a.map(c => c.num)).not.toEqual([1, 2, 3, 4, 5, 6]);
    });
});
