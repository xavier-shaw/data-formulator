// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/select.ts — turn a session into scored, guarded quiz items.
 *
 * This is the one place the quiz's *judgement calls* live, so the in-app quiz
 * and the offline pipeline cannot drift apart on them:
 *
 *  • which methods may supply a lure at all (see QUIZ_EXCLUDE_METHODS)
 *  • which charts are fair to ask about (see the family rule below)
 *  • how many lures an item needs, and how hard they should be
 *
 * Rendering is INJECTED (`RenderSvg`) because the two callers rasterize
 * differently — the app runs vega in the browser, the offline pipeline shells
 * out to `vl2svg`. Everything else is shared.
 */

import { SessionChart, SessionData, ChartLevelSpec, FieldMeta, compileToVegaLite } from './extract';
import { generateAll, chartRoles, DistractorCandidate, Method } from './generators';
import { SpecEdit, specDiff, specDistance, dataDistance, mergeEdits, DataDistance } from './distance';
import { renderHash, degenerateText } from './guard';
import { withSeededRandom } from './seeded';

/** Compile a chart-level spec and render it; returns the SVG string. */
export type RenderSvg = (vlSpec: any, id: string) => Promise<string | null>;

/**
 * Methods barred from supplying quiz lures.
 *
 * `data-perturb` keeps the exact chart form and nudges the values (spec
 * distance 0, data distance ~0.1). Empirically that is too subtle to notice —
 * every miss in a pilot run was one of these — so it produces gotcha items
 * rather than a memory test. The method stays available to the gallery, which
 * exists to showcase what each method can make.
 */
export const QUIZ_EXCLUDE_METHODS: ReadonlySet<Method> = new Set<Method>(['data-perturb']);

/** How many distractors one item shows besides the correct answer. */
export const LURES_PER_ITEM = 3;

/** Chart families — a lure in the same family is what makes an item non-obvious. */
const FAMILY: Record<string, string> = {
    'Bar Chart': 'bar', 'Bar Table': 'bar', 'Grouped Bar Chart': 'bar', 'Stacked Bar Chart': 'bar',
    'Lollipop Chart': 'bar', 'Pyramid Chart': 'bar', 'Histogram': 'bar', 'Waterfall Chart': 'bar',
    'Line Chart': 'line', 'Area Chart': 'line', 'Bump Chart': 'line', 'Streamgraph': 'line',
    'Scatter Plot': 'point', 'Strip Plot': 'point', 'Ranged Dot Plot': 'point', 'Regression': 'point',
    'Pie Chart': 'radial', 'Rose Chart': 'radial', 'Radar Chart': 'radial',
    'Heatmap': 'grid', 'US Map': 'geo', 'World Map': 'geo',
};
export const chartFamily = (chartType: string): string => FAMILY[chartType] ?? 'other';

// ── scoring ──────────────────────────────────────────────────────────────

export interface ScoredCandidate extends DistractorCandidate {
    edits: SpecEdit[];
    specDist: number;
    dataDist: number;
    dataDetail: DataDistance;
}

/** Score every candidate of one chart on the two distance axes. */
export function scoreCandidates(chart: SessionChart, candidates: DistractorCandidate[]): ScoredCandidate[] {
    const roles = chartRoles(chart);
    return candidates.map(c => {
        const diffed = specDiff(chart.spec, c.spec, { ...chart.metadata, ...c.metadata });
        const edits = mergeEdits(c.declaredEdits, diffed);
        const dd = dataDistance(chart.rows, c.rows, roles.category, roles.measure);
        return { ...c, edits, specDist: specDistance(edits), dataDist: dd.overall, dataDetail: dd };
    });
}

// ── quiz assembly ────────────────────────────────────────────────────────

export interface QuizOption {
    id: string;
    svg: string;
    /** absent on the correct answer */
    method?: Method;
    label?: string;
    specDist?: number;
    dataDist?: number;
    chartType: string;
}

export interface QuizItem {
    chartId: string;
    title: string;
    chartType: string;
    focusMs: number;
    correctId: string;
    /** correct answer first; the caller shuffles for presentation */
    options: QuizOption[];
}

export interface SkippedChart { chartId: string; title: string; chartType: string; reason: string }

export interface BuildQuizResult {
    items: QuizItem[];
    skipped: SkippedChart[];
    /** charts considered, in focus-time order */
    ranked: { chartId: string; title: string; focusMs: number }[];
}

export interface BuildQuizOptions {
    session: SessionData;
    render: RenderSvg;
    /** how many questions to keep (charts are ranked by focus time) */
    topN?: number;
    seed?: number;
    /** first render batch size, then escalates until enough lures survive */
    batchSize?: number;
    /** hard cap on lures rendered per chart */
    maxRenders?: number;
    onProgress?: (done: number, total: number, label: string) => void;
    /** called between charts so a UI can paint */
    yieldToUi?: () => Promise<void>;
}

export const DEFAULT_SEED = 20260807;

/**
 * Build quiz items for the charts the participant focused on longest.
 *
 * Candidate generation happens for ALL charts up front, inside one seeded
 * synchronous block — both because the seeded `Math.random` patch is only safe
 * synchronously, and so the draw sequence does not depend on how rendering is
 * scheduled.
 *
 * Rendering then proceeds nearest-first in escalating batches: the closest lures
 * are the hardest and therefore the ones worth asking about, but some of them
 * get dropped by the guard, so a chart is only declared unusable after the
 * budget is spent — never merely because the first batch came up short.
 */
export async function buildQuizItems(opts: BuildQuizOptions): Promise<BuildQuizResult> {
    const {
        session, render, topN = 12, seed = DEFAULT_SEED,
        batchSize = 6, maxRenders = 18, onProgress, yieldToUi,
    } = opts;

    // Phase 1 — all candidate specs, one seeded stream, fully synchronous.
    const generated = withSeededRandom(seed, () =>
        session.charts.map(chart => ({ chart, candidates: generateAll(chart, session) })));

    // Phase 2 — score (cheap, no rendering) and order charts by focus time.
    const scoredPerChart = generated.map(({ chart, candidates }) => ({
        chart,
        scored: scoreCandidates(chart, candidates)
            .filter(c => !c.caveat && !QUIZ_EXCLUDE_METHODS.has(c.method))
            // hardest first: the nearest lure on both axes
            .sort((a, b) => (a.specDist + a.dataDist) - (b.specDist + b.dataDist)),
    }));
    scoredPerChart.sort((a, b) => (b.chart.focusMs ?? 0) - (a.chart.focusMs ?? 0));

    const ranked = scoredPerChart.map(({ chart }) => ({
        chartId: chart.id, title: chart.title, focusMs: chart.focusMs ?? 0,
    }));

    const items: QuizItem[] = [];
    const skipped: SkippedChart[] = [];
    const total = Math.min(topN, scoredPerChart.length);

    for (const { chart, scored } of scoredPerChart) {
        if (items.length >= topN) break;
        onProgress?.(items.length, total, chart.title);

        const skip = (reason: string) =>
            skipped.push({ chartId: chart.id, title: chart.title, chartType: chart.spec.chartType, reason });

        // The original must render before anything can be compared to it.
        let origSvg: string | null = null;
        try {
            origSvg = await render(compileToVegaLite(chart.spec, chart.rows, chart.metadata), `${chart.id}_orig`);
        } catch { origSvg = null; }
        if (!origSvg) { skip('the original chart did not render'); continue; }
        const origHash = renderHash(origSvg);

        // Render nearest-first in batches; stop as soon as enough distinct
        // lures survive the guard.
        const kept: QuizOption[] = [];
        const keptHashes = new Set<string>();
        let cursor = 0;
        while (kept.length < LURES_PER_ITEM && cursor < scored.length && cursor < maxRenders) {
            const batch = scored.slice(cursor, cursor + batchSize);
            cursor += batch.length;
            for (const cand of batch) {
                if (kept.length >= LURES_PER_ITEM) break;
                let svg: string | null = null;
                try {
                    svg = await render(compileToVegaLite(cand.spec, cand.rows, cand.metadata), `${chart.id}_${kept.length}`);
                } catch { svg = null; }
                if (!svg) continue;
                if (degenerateText(svg).length) continue;      // visibly broken
                const h = renderHash(svg);
                if (h === origHash) continue;                  // would be a 2nd correct answer
                if (keptHashes.has(h)) continue;               // duplicate option
                keptHashes.add(h);
                kept.push({
                    id: `${chart.id}_d${kept.length}`,
                    svg,
                    method: cand.method,
                    label: cand.label,
                    specDist: cand.specDist,
                    dataDist: cand.dataDist,
                    chartType: cand.spec.chartType,
                });
            }
        }

        if (kept.length < LURES_PER_ITEM) {
            skip(`only ${kept.length} usable look-alike(s); an item needs ${LURES_PER_ITEM}`);
            if (yieldToUi) await yieldToUi();
            continue;
        }

        // Fairness: if no surviving lure shares the chart's family, the correct
        // answer is the only chart of its kind on screen and the participant can
        // pick it without remembering anything (a map among bar charts).
        const ownFamily = chartFamily(chart.spec.chartType);
        if (!kept.some(k => chartFamily(k.chartType) === ownFamily)) {
            skip(`no look-alike shares its chart family (${ownFamily}), so the answer would be obvious`);
            if (yieldToUi) await yieldToUi();
            continue;
        }

        items.push({
            chartId: chart.id,
            title: chart.title,
            chartType: chart.spec.chartType,
            focusMs: chart.focusMs ?? 0,
            correctId: `${chart.id}_orig`,
            options: [{ id: `${chart.id}_orig`, svg: origSvg, chartType: chart.spec.chartType }, ...kept],
        });

        if (yieldToUi) await yieldToUi();
    }

    onProgress?.(items.length, total, '');
    return { items, skipped, ranked };
}

/**
 * Invariants every assembled item must satisfy. Returns human-readable
 * violations; an empty array means the set is sound. Cheap enough to assert at
 * runtime, and the only meaningful check on the in-app path (render hashes are
 * not comparable to the offline run's, so counts cannot be compared).
 */
export function verifyQuizItems(items: QuizItem[]): string[] {
    const problems: string[] = [];
    for (const item of items) {
        const hashes = item.options.map(o => renderHash(o.svg));
        if (new Set(hashes).size !== hashes.length) {
            problems.push(`"${item.title}": two options render identically`);
        }
        if (item.options.length !== LURES_PER_ITEM + 1) {
            problems.push(`"${item.title}": ${item.options.length} options, expected ${LURES_PER_ITEM + 1}`);
        }
        if (!item.options.some(o => o.id === item.correctId)) {
            problems.push(`"${item.title}": the correct answer is not among the options`);
        }
    }
    return problems;
}
