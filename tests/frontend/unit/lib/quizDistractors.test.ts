import { describe, expect, it, vi } from 'vitest';

import {
    extractSession,
    buildQuizItems,
    verifyQuizItems,
    withSeededRandom,
    renderHash,
    degenerateText,
    stripSvgText,
    generateAll,
    QUIZ_METHODS,
    LURES_PER_ITEM,
} from '../../../../src/lib/quiz-distractors';

/**
 * A minimal but realistic session: one derived table with a category column and
 * three numeric columns, plotted as a bar chart. Enough for the generators to
 * produce mark swaps, sibling measures and sort variants.
 */
function makeState(overrides: Record<string, any> = {}) {
    const rows = [
        { PHASE: 'Take-off', rate: 0.35, incidents: 120, serious: 42 },
        { PHASE: 'Climb', rate: 0.25, incidents: 300, serious: 75 },
        { PHASE: 'Approach', rate: 0.14, incidents: 500, serious: 70 },
        { PHASE: 'Descent', rate: 0.12, incidents: 220, serious: 26 },
        { PHASE: 'Landing', rate: 0.30, incidents: 180, serious: 54 },
    ];
    return {
        tables: [{
            id: 'derived_1',
            derive: { source: ['raw'], code: '', outputVariable: 'df' },
            rows,
            metadata: {
                PHASE: { type: 'string', semanticType: 'Category', levels: [] },
                rate: { type: 'number', semanticType: 'Percentage', levels: [] },
                incidents: { type: 'number', semanticType: 'Count', levels: [] },
                serious: { type: 'number', semanticType: 'Count', levels: [] },
            },
        }],
        charts: [{
            id: 'chart-1',
            chartType: 'Bar Chart',
            tableRef: 'derived_1',
            title: 'Damage rate by phase',
            encodingMap: {
                x: { fieldID: 'c-phase' },
                y: { fieldID: 'c-rate' },
            },
        }],
        conceptShelfItems: [
            { id: 'c-phase', name: 'PHASE' },
            { id: 'c-rate', name: 'rate' },
            { id: 'c-incidents', name: 'incidents' },
            { id: 'c-serious', name: 'serious' },
        ],
        chartUsage: { 'chart-1': { focusMs: 42000, visits: 2 } },
        ...overrides,
    };
}

/**
 * Stand-in renderer. Like a real chart, the per-spec difference lives in the
 * MARK, not only in the text — otherwise stripping the labels for step 1 would
 * make every option identical and the guard would (rightly) reject them all.
 */
const fakeRender = async (vlSpec: any) => {
    const sig = JSON.stringify(vlSpec);
    return `<svg><path class="mark" data-sig="${sig.length}:${encodeURIComponent(sig).slice(0, 80)}" d="M0,0"/>`
        + `<text>${sig.length}</text></svg>`;
};

describe('extractSession', () => {
    it('resolves field ids to names and carries focus telemetry', () => {
        const session = extractSession(makeState());
        expect(session.charts).toHaveLength(1);
        const chart = session.charts[0];
        expect(chart.spec.chartType).toBe('Bar Chart');
        expect(chart.spec.encodings.x.field).toBe('PHASE');
        expect(chart.spec.encodings.y.field).toBe('rate');
        expect(chart.focusMs).toBe(42000);
        expect(chart.visits).toBe(2);
    });

    it('gives a chart the same row array its distractors will use', () => {
        const state = makeState();
        const session = extractSession(state);
        // Same identity, not merely equal: an original rendered from one row set
        // and lures from another would be distinguishable by row count alone.
        expect(session.charts[0].rows).toBe(session.tables['derived_1'].rows);
    });

    it('skips charts with no encodings, and Auto/Table placeholders', () => {
        const state = makeState();
        state.charts.push(
            { id: 'c-auto', chartType: 'Auto', tableRef: 'derived_1', title: 'Auto', encodingMap: {} } as any,
            { id: 'c-empty', chartType: 'Bar Chart', tableRef: 'derived_1', title: 'Empty', encodingMap: {} } as any,
        );
        expect(extractSession(state).charts.map(c => c.id)).toEqual(['chart-1']);
    });

    it('tolerates a session with nothing in it', () => {
        expect(extractSession({}).charts).toEqual([]);
    });
});

describe('guard', () => {
    it('hashes the same render the same, and different renders differently', () => {
        expect(renderHash('<svg><text>a</text></svg>')).toBe(renderHash('<svg><text>a</text></svg>'));
        expect(renderHash('<svg><text>a</text></svg>')).not.toBe(renderHash('<svg><text>b</text></svg>'));
    });

    it('ignores the two kinds of noise it is documented to ignore', () => {
        // whitespace runs
        expect(renderHash('<svg><text>a   b</text></svg>')).toBe(renderHash('<svg><text>a b</text></svg>'));
        // float formatting jitter past 3 decimals
        expect(renderHash('<svg><path d="M0.123456"/></svg>')).toBe(renderHash('<svg><path d="M0.123999"/></svg>'));
        // but a real coordinate change still registers
        expect(renderHash('<svg><path d="M0.123456"/></svg>')).not.toBe(renderHash('<svg><path d="M0.987654"/></svg>'));
    });

    it('strips every drawn label but keeps the marks', () => {
        const svg = '<svg><path class="mark" d="M0,0L5,5"/><text x="1" y="2">Take-off Run</text>'
            + '<rect width="3" height="4"/><text transform="rotate(-90)">Strike Count</text></svg>';
        const bare = stripSvgText(svg);
        expect(bare).not.toMatch(/Take-off Run|Strike Count/);
        expect(bare).not.toMatch(/<text/);
        // the data marks — the thing step 1 asks about — must survive untouched
        expect(bare).toContain('<path class="mark" d="M0,0L5,5"/>');
        expect(bare).toContain('<rect width="3" height="4"/>');
    });

    it('removes text that would leak through the DOM or a screen reader', () => {
        const svg = '<svg><g aria-label="Gulls: 603"><path d="M0,0"/></g><title>tooltip text</title>'
            + '<text/></svg>';
        const bare = stripSvgText(svg);
        expect(bare).not.toMatch(/Gulls|603|tooltip text/);
        expect(bare).not.toMatch(/aria-label|<title>|<text/);
        expect(bare).toContain('<path d="M0,0"/>');
    });

    it('flags charts that drew broken labels', () => {
        expect(degenerateText('<svg><text>NaN</text></svg>')).toEqual(['NaN']);
        expect(degenerateText('<svg><text>undefined</text></svg>')).toEqual(['undefined']);
        expect(degenerateText('<svg><text>Take-off</text></svg>')).toEqual([]);
    });
});

describe('withSeededRandom', () => {
    it('restores Math.random afterwards', () => {
        const before = Math.random;
        withSeededRandom(1, () => Math.random());
        expect(Math.random).toBe(before);
    });

    it('produces the same draws for the same seed', () => {
        const draw = () => withSeededRandom(7, () => [Math.random(), Math.random()]);
        expect(draw()).toEqual(draw());
    });

    it('refuses an async function instead of leaking the patch', () => {
        const before = Math.random;
        expect(() => withSeededRandom(1, () => Promise.resolve(1) as any)).toThrow(/synchronous/);
        // The patch must be gone even though the call threw.
        expect(Math.random).toBe(before);
    });
});

describe('buildQuizItems', () => {
    it('builds a 4-option item and satisfies its own invariants', async () => {
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        expect(items).toHaveLength(1);
        expect(items[0].options).toHaveLength(LURES_PER_ITEM + 1);
        expect(items[0].correctId).toBe('chart-1_orig');
        expect(items[0].options.some(o => o.id === items[0].correctId)).toBe(true);
        expect(verifyQuizItems(items)).toEqual([]);
    });

    it('gives every item exactly one lure per axis: form, content, combined', async () => {
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            const lures = item.options.filter(o => o.method);
            expect(lures.map(o => o.method).sort()).toEqual([...QUIZ_METHODS].sort());
        }
    });

    it('rejects a lure that only differs in text, since step 1 hides text', async () => {
        const session = extractSession(makeState());
        // Renderer whose output differs ONLY inside <text>: with labels the
        // charts are distinct, with labels stripped they are identical, so no
        // option may survive except by accident of another difference.
        let n = 0;
        const textOnlyRender = async () => `<svg><path d="M0,0"/><text>${n++}</text></svg>`;
        const { items, skipped } = await buildQuizItems({ session, render: textOnlyRender });
        expect(items).toHaveLength(0);
        expect(skipped[0].reason).toMatch(/no usable \w+ look-alike/);
    });

    it('drops a lure that renders like the original rather than shipping two right answers', async () => {
        const session = extractSession(makeState());
        // Every render identical → no lure can ever differ from the original.
        const constant = async () => '<svg><text>same</text></svg>';
        const { items, skipped } = await buildQuizItems({ session, render: constant });
        expect(items).toHaveLength(0);
        expect(skipped[0].reason).toMatch(/no usable \w+ look-alike/);
    });

    it('makes the combined lure the composition of THIS item\'s own A and B', async () => {
        // The item is a 2×2 — original, A, B, A+B — so a wrong pick says which
        // axis failed and the combined option says whether either alone
        // sufficed. An independently drawn pair would not support that reading.
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        expect(items.length).toBeGreaterThan(0);
        for (const item of items) {
            const a = item.options.find(o => o.method === 'form')!;
            const b = item.options.find(o => o.method === 'content')!;
            const ab = item.options.find(o => o.method === 'combined')!;
            expect(ab.composedOf).toEqual([a.id, b.id]);
            expect(ab.op).toBe(`${a.op}+${b.op}`);
            expect(ab.label).toBe(`${a.label} + ${b.label}`);
        }
    });

    it('rejects an item whose combined lure is not made of its own A and B', () => {
        const item = {
            chartId: 'c', title: 'T', chartType: 'Bar Chart', focusMs: 0, correctId: 'c_orig',
            options: [
                { id: 'c_orig', svg: '<svg>0</svg>', chartType: 'Bar Chart' },
                { id: 'c_a', svg: '<svg>1</svg>', chartType: 'Bar Chart', method: 'form', op: 'mark' },
                { id: 'c_b', svg: '<svg>2</svg>', chartType: 'Bar Chart', method: 'content', op: 'filter' },
                // composed from some OTHER content edit than this item's B
                { id: 'c_ab', svg: '<svg>3</svg>', chartType: 'Bar Chart', method: 'combined',
                  op: 'mark+sort-value', composedOf: ['c_a', 'c_other'] },
            ],
        };
        expect(verifyQuizItems([item] as any).join(' ')).toMatch(/does not name this item|is not "mark\+filter"/);
    });

    it('never lets the correct answer be the only chart of its kind on screen', async () => {
        // The old chart-family fairness guard is now satisfied by construction:
        // the content lure keeps the original's chart type exactly, so every
        // item carries at least one same-type option besides the answer.
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        for (const item of items) {
            const content = item.options.find(o => o.method === 'content')!;
            expect(content.chartType).toBe(item.chartType);
        }
    });

    it('reports a chart whose original will not render', async () => {
        const session = extractSession(makeState());
        const { items, skipped } = await buildQuizItems({ session, render: async () => null });
        expect(items).toHaveLength(0);
        expect(skipped[0].reason).toMatch(/original chart did not render/);
    });

    it('ranks questions by focus time and honours topN', async () => {
        const state = makeState();
        state.charts.push({
            id: 'chart-2', chartType: 'Bar Chart', tableRef: 'derived_1', title: 'Incidents by phase',
            encodingMap: { x: { fieldID: 'c-phase' }, y: { fieldID: 'c-incidents' } },
        } as any);
        (state.chartUsage as any)['chart-2'] = { focusMs: 99000, visits: 1 };

        const session = extractSession(state);
        const both = await buildQuizItems({ session, render: fakeRender });
        expect(both.items.map(i => i.chartId)).toEqual(['chart-2', 'chart-1']);   // 99s before 42s

        const one = await buildQuizItems({ session, render: fakeRender, topN: 1 });
        expect(one.items.map(i => i.chartId)).toEqual(['chart-2']);
    });

    it('is reproducible for a given seed', async () => {
        const run = async () => {
            const { items } = await buildQuizItems({ session: extractSession(makeState()), render: fakeRender, seed: 4242 });
            return items.map(i => i.options.map(o => o.label ?? 'ORIGINAL'));
        };
        expect(await run()).toEqual(await run());
    });

    it('yields to the UI between charts so progress can paint', async () => {
        const session = extractSession(makeState());
        const yieldToUi = vi.fn(async () => { });
        const onProgress = vi.fn();
        await buildQuizItems({ session, render: fakeRender, yieldToUi, onProgress });
        expect(yieldToUi).toHaveBeenCalled();
        expect(onProgress).toHaveBeenCalled();
    });
});

describe('verifyQuizItems', () => {
    it('catches an item with two identical options', () => {
        const bad = [{
            chartId: 'c', title: 'T', chartType: 'Bar Chart', focusMs: 0, correctId: 'c_orig',
            options: [
                { id: 'c_orig', svg: '<svg><text>x</text></svg>', chartType: 'Bar Chart' },
                { id: 'c_d0', svg: '<svg><text>x</text></svg>', chartType: 'Bar Chart' },
                { id: 'c_d1', svg: '<svg><text>y</text></svg>', chartType: 'Bar Chart' },
                { id: 'c_d2', svg: '<svg><text>z</text></svg>', chartType: 'Bar Chart' },
            ],
        }];
        expect(verifyQuizItems(bad as any).join(' ')).toMatch(/render identically/);
    });

    it('catches a missing correct answer', () => {
        const bad = [{
            chartId: 'c', title: 'T', chartType: 'Bar Chart', focusMs: 0, correctId: 'not-here',
            options: [
                { id: 'a', svg: '<svg>1</svg>', chartType: 'Bar Chart' },
                { id: 'b', svg: '<svg>2</svg>', chartType: 'Bar Chart' },
                { id: 'c', svg: '<svg>3</svg>', chartType: 'Bar Chart' },
                { id: 'd', svg: '<svg>4</svg>', chartType: 'Bar Chart' },
            ],
        }];
        expect(verifyQuizItems(bad as any).join(' ')).toMatch(/correct answer is not among/);
    });
});

describe('axis purity', () => {
    // The lure's axis is the MEANING of a wrong answer, so each axis must only
    // change what it claims to change.
    it('form lures keep the data; content lures keep the drawing', () => {
        const session = extractSession(makeState());
        const chart = session.charts[0];
        const candidates = withSeededRandom(1, () => generateAll(chart, session));

        const byMethod = (m: string) => candidates.filter(c => c.method === m);
        expect(byMethod('form').length).toBeGreaterThan(0);
        expect(byMethod('content').length).toBeGreaterThan(0);
        expect(byMethod('combined').length).toBeGreaterThan(0);

        for (const c of byMethod('form')) {
            // same row array by IDENTITY — the data is untouched
            expect(c.rows).toBe(chart.rows);
        }
        const fieldMap = (spec: any) =>
            Object.fromEntries(Object.entries(spec.encodings).map(([ch, e]: any) => [ch, e.field]));
        for (const c of byMethod('content')) {
            expect(c.spec.chartType).toBe(chart.spec.chartType);
            expect(fieldMap(c.spec)).toEqual(fieldMap(chart.spec));
        }
    });
});
