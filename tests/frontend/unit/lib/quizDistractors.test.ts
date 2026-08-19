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
    generateVisualCandidates,
    generateDataCandidates,
    combineCandidates,
    purityViolation,
    specSignature,
    curatedFor,
    MATRIX_PER_AXIS,
} from '../../../../src/lib/quiz-distractors';

/**
 * A minimal but realistic session: one derived table with a category column and
 * three numeric columns, plotted as a bar chart. Enough for the generators to
 * produce mark retargets and the message operators.
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
 * Stand-in renderer: every distinct spec+data renders distinctly. The mark
 * carries a hash of the WHOLE compiled spec — a prefix would collide for data
 * lures, which permute the same values inside an identical spec.
 */
const djb2 = (s: string) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
};
const fakeRender = async (vlSpec: any) => {
    const sig = djb2(JSON.stringify(vlSpec));
    return `<svg><path class="mark" data-sig="${sig}" d="M0,0"/><text>${sig}</text></svg>`;
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
        expect(bare).toContain('<path class="mark" d="M0,0L5,5"/>');
        expect(bare).toContain('<rect width="3" height="4"/>');
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
        expect(Math.random).toBe(before);
    });
});

describe('buildQuizItems', () => {
    it('builds a full 3×3 option matrix for a common bar chart', async () => {
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        expect(items).toHaveLength(1);
        const visual = items[0].options.filter(o => o.method === 'visual');
        const data = items[0].options.filter(o => o.method === 'data');
        const combined = items[0].options.filter(o => o.method === 'combined');
        expect(items[0].correctId).toBe('chart-1_orig');
        expect(items[0].options.some(o => o.id === items[0].correctId)).toBe(true);
        // A bar chart admits two lures on each axis, so the matrix is full:
        // 1 original + 2 visual + 2 data + 4 combined = 9 options.
        expect(visual).toHaveLength(MATRIX_PER_AXIS);
        expect(data).toHaveLength(MATRIX_PER_AXIS);
        expect(combined).toHaveLength(MATRIX_PER_AXIS * MATRIX_PER_AXIS);
        expect(items[0].options).toHaveLength(9);
        expect(verifyQuizItems(items)).toEqual([]);
    });

    it('places every option at its matrix cell', async () => {
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        const byCell = new Map(items[0].options.map(o => [`${o.cell.v}:${o.cell.d}`, o]));
        expect(byCell.get('0:0')!.id).toBe(items[0].correctId);
        expect(byCell.get('1:0')!.method).toBe('visual');
        expect(byCell.get('0:1')!.method).toBe('data');
        expect(byCell.get('1:1')!.method).toBe('combined');
        // A combined cell shares its drawing with its visual sibling and its
        // dimension with its data sibling.
        expect(byCell.get('1:1')!.chartType).toBe(byCell.get('1:0')!.chartType);
        expect(byCell.get('1:1')!.dim).toBe(byCell.get('0:1')!.dim);
    });

    it('takes the visual lures from the curated table, in its order', async () => {
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        const types = items[0].options.filter(o => o.method === 'visual').map(o => o.chartType);
        expect(new Set(types).size).toBe(types.length);      // no repeated target
        const table = curatedFor('Bar Chart').visual;
        for (const t of types) expect(table).toContain(t);
    });

    it('never redraws a chart as a type outside its curated table', async () => {
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        const types = items[0].options
            .filter(o => o.method === 'visual' || o.method === 'combined')
            .map(o => o.chartType);
        // These recompute the measure (bin, summarize, rank, accumulate),
        // need data the source does not have, or draw a trend that is not in
        // the data — the v3 tables exclude them for a nominal bar chart.
        for (const banned of ['Histogram', 'Density Plot', 'Boxplot', 'Bump Chart',
                              'Waterfall Chart', 'Candlestick Chart', 'KPI Card',
                              'US Map', 'World Map', 'Pyramid Chart',
                              'Line Chart', 'Area Chart']) {
            expect(types).not.toContain(banned);
        }
    });

    it('spreads the two data lures across two different message dimensions', async () => {
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        const dims = items[0].options.filter(o => o.method === 'data').map(o => o.dim);
        expect(dims).toHaveLength(2);
        expect(new Set(dims).size).toBe(2);
    });

    it('gives every data lure the original chart type — the correct answer is never the only one of its kind', async () => {
        const session = extractSession(makeState());
        const { items } = await buildQuizItems({ session, render: fakeRender });
        for (const item of items) {
            for (const o of item.options.filter(o => o.method === 'data')) {
                expect(o.chartType).toBe(item.chartType);
            }
        }
    });

    it('drops a lure that renders like the original rather than shipping two right answers', async () => {
        const session = extractSession(makeState());
        // Every render identical → no lure can ever differ from the original.
        const constant = async () => '<svg><text>same</text></svg>';
        const { items, skipped } = await buildQuizItems({ session, render: constant });
        expect(items).toHaveLength(0);
        expect(skipped[0].reason).toMatch(/no visual look-alike at all|look-alikes could be made/);
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

    it('splits the questions between report charts and intermediate charts', async () => {
        const state = makeState();
        state.charts.push(
            {
                id: 'chart-2', chartType: 'Bar Chart', tableRef: 'derived_1', title: 'Incidents by phase',
                encodingMap: { x: { fieldID: 'c-phase' }, y: { fieldID: 'c-incidents' } },
            } as any,
            {
                id: 'chart-3', chartType: 'Bar Chart', tableRef: 'derived_1', title: 'Serious by phase',
                encodingMap: { x: { fieldID: 'c-phase' }, y: { fieldID: 'c-serious' } },
            } as any,
        );
        (state.chartUsage as any)['chart-2'] = { focusMs: 99000, visits: 1 };
        (state.chartUsage as any)['chart-3'] = { focusMs: 1000, visits: 1 };
        (state as any).findingsChartIds = ['chart-3'];

        const session = extractSession(state);
        const { items } = await buildQuizItems({ session, render: fakeRender, topN: 2 });
        // chart-3 was looked at least, but it holds the report half of the
        // quota; chart-1 (42s of focus) loses its slot to it.
        expect(items.map(i => i.chartId).sort()).toEqual(['chart-2', 'chart-3']);
        expect(items.find(i => i.chartId === 'chart-3')?.inReport).toBe(true);
        expect(items.find(i => i.chartId === 'chart-2')?.inReport).toBe(false);
    });

    it('cedes report slots to intermediate charts when there is no report', async () => {
        const state = makeState();
        state.charts.push({
            id: 'chart-2', chartType: 'Bar Chart', tableRef: 'derived_1', title: 'Incidents by phase',
            encodingMap: { x: { fieldID: 'c-phase' }, y: { fieldID: 'c-incidents' } },
        } as any);
        (state.chartUsage as any)['chart-2'] = { focusMs: 99000, visits: 1 };

        const session = extractSession(state);
        const both = await buildQuizItems({ session, render: fakeRender, topN: 2 });
        expect(both.items.map(i => i.chartId).sort()).toEqual(['chart-1', 'chart-2']);
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
    const mkOption = (id: string, svg: string, cell: { v: number; d: number }, method?: string, extra: Record<string, any> = {}) =>
        ({ id, svg, chartType: method === 'data' || !method ? 'Bar Chart' : 'Lollipop Chart', method, cell, ...extra });

    /** A full 2×2 matrix: original, one visual, one data, one combined. */
    const validOptions = () => [
        mkOption('c_orig', '<svg>0</svg>', { v: 0, d: 0 }),
        mkOption('c_v0', '<svg>v0</svg>', { v: 1, d: 0 }, 'visual', { band: 'near' }),
        mkOption('c_d0', '<svg>d0</svg>', { v: 0, d: 1 }, 'data', { dim: 'direction' }),
        mkOption('c_c00', '<svg>c00</svg>', { v: 1, d: 1 }, 'combined', { band: 'near', dim: 'direction' }),
    ];

    const item = (options: any[]) => ([{
        chartId: 'c', title: 'T', chartType: 'Bar Chart', focusMs: 0, inReport: false,
        correctId: 'c_orig', options,
    }]);

    it('accepts a well-formed 2×2 matrix item', () => {
        expect(verifyQuizItems(item(validOptions()) as any)).toEqual([]);
    });

    it('catches an item with two identical options', () => {
        const options = validOptions();
        options[1] = { ...options[1], svg: options[2].svg };
        expect(verifyQuizItems(item(options) as any).join(' ')).toMatch(/render identically/);
    });

    it('catches a missing correct answer', () => {
        const options = validOptions().filter(o => o.id !== 'c_orig');
        expect(verifyQuizItems(item(options) as any).join(' ')).toMatch(/correct answer is not among/);
    });

    it('catches a matrix with a hole in it', () => {
        const options = validOptions().filter(o => o.id !== 'c_c00');
        expect(verifyQuizItems(item(options) as any).join(' ')).toMatch(/do not form a full/);
    });

    it('catches an option whose method does not match its cell', () => {
        const options = validOptions();
        options[1] = { ...options[1], method: 'data', chartType: 'Bar Chart', dim: 'location' };
        expect(verifyQuizItems(item(options) as any).join(' ')).toMatch(/is data, expected visual/);
    });

    it('catches a data lure that changed the chart type', () => {
        const options = validOptions();
        options[2] = { ...options[2], chartType: 'Pie Chart' };
        expect(verifyQuizItems(item(options) as any).join(' ')).toMatch(/changed the chart type/);
    });

    it('catches a combined lure that kept the chart type', () => {
        const options = validOptions();
        options[3] = { ...options[3], chartType: 'Bar Chart' };
        expect(verifyQuizItems(item(options) as any).join(' ')).toMatch(/kept the chart type/);
    });
});

describe('axis purity', () => {
    // The lure's axis is the MEANING of a wrong answer, so each axis must only
    // change what it claims to change.
    it('visual lures keep the data; data lures keep the drawing', () => {
        const session = extractSession(makeState());
        const chart = session.charts[0];
        const candidates = withSeededRandom(1, () => generateAll(chart, session));

        const byMethod = (m: string) => candidates.filter(c => c.method === m);
        expect(byMethod('visual').length).toBeGreaterThan(0);
        expect(byMethod('data').length).toBeGreaterThan(0);

        for (const c of byMethod('visual')) {
            // same row array by IDENTITY — the data is untouched
            expect(c.rows).toBe(chart.rows);
        }
        for (const c of byMethod('data')) {
            expect(specSignature(c.spec)).toBe(specSignature(chart.spec));
            expect(c.dim).toBeTruthy();
        }
    });

    it('never redraws a nominal bar chart as a line or area (the banned targets)', () => {
        const session = extractSession(makeState());
        const chart = session.charts[0];
        const visual = withSeededRandom(1, () => generateVisualCandidates(chart));
        const types = visual.map(c => c.spec.chartType);
        expect(types).not.toContain('Line Chart');
        expect(types).not.toContain('Area Chart');
    });

    it('every data candidate already cleared its floor: the message really changed', () => {
        const session = extractSession(makeState());
        const chart = session.charts[0];
        const data = withSeededRandom(1, () => generateDataCandidates(chart));
        expect(data.length).toBeGreaterThanOrEqual(2);
        // A candidate that tells the same story as the original is useless;
        // the generator must have filtered those out already.
        const stories = data.map(c => c.signature);
        for (const s of stories) expect(s).toBeTruthy();
    });

    it('only offers operators from the chart type\'s curated table', () => {
        const session = extractSession(makeState());
        const chart = session.charts[0];
        const data = withSeededRandom(1, () => generateDataCandidates(chart));
        const table = curatedFor('Bar Chart').data;
        for (const c of data) expect(table).toContain(c.op);
    });

    it('a combined lure changes both the rows and the drawing, and purity accepts it', () => {
        const session = extractSession(makeState());
        const chart = session.charts[0];
        const { visual, data } = withSeededRandom(1, () => ({
            visual: generateVisualCandidates(chart),
            data: generateDataCandidates(chart),
        }));
        const combined = combineCandidates(chart, visual[0], data[0]);
        expect(combined).toBeTruthy();
        expect(combined!.method).toBe('combined');
        expect(combined!.rows).not.toBe(chart.rows);
        expect(specSignature(combined!.spec)).not.toBe(specSignature(chart.spec));
        expect(purityViolation(chart, combined!)).toBeNull();
        expect(combined!.dim).toBe(data[0].dim);
        expect(combined!.band).toBe(visual[0].band);
    });

    it('gives a histogram a data axis through the raw-value operators', () => {
        const state = makeState();
        state.tables[0].rows = Array.from({ length: 24 }, (_, i) => ({
            // right-skewed: many small heights, few large ones
            HEIGHT: [3, 4, 4, 5, 5, 5, 6, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 21, 25, 30, 36, 44, 55, 70][i],
        })) as any;
        state.tables[0].metadata = {
            HEIGHT: { type: 'number', semanticType: 'Number', levels: [] },
        } as any;
        state.charts = [{
            id: 'chart-h', chartType: 'Histogram', tableRef: 'derived_1', title: 'Strike heights',
            encodingMap: { x: { fieldID: 'c-height' } },
        }] as any;
        state.conceptShelfItems = [{ id: 'c-height', name: 'HEIGHT' }] as any;
        (state.chartUsage as any) = { 'chart-h': { focusMs: 10000, visits: 1 } };

        const session = extractSession(state);
        const data = withSeededRandom(1, () => generateDataCandidates(session.charts[0]));
        expect(data.length).toBeGreaterThanOrEqual(2);
        for (const c of data) expect(c.op.startsWith('dist-')).toBe(true);
        // The skewed sample admits all three: the center moves, the skew
        // mirrors, the spread widens.
        expect(new Set(data.map(c => c.dim)).size).toBeGreaterThanOrEqual(2);
    });

    it('refuses to combine two candidates from the same axis', () => {
        const session = extractSession(makeState());
        const chart = session.charts[0];
        const { visual, data } = withSeededRandom(1, () => ({
            visual: generateVisualCandidates(chart),
            data: generateDataCandidates(chart),
        }));
        expect(combineCandidates(chart, visual[0], visual[1] ?? visual[0])).toBeNull();
        expect(combineCandidates(chart, data[0], data[0])).toBeNull();
    });
});
