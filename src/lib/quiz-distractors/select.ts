// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/select.ts — turn a session into scored, guarded quiz items.
 *
 * This is the one place the quiz's *judgement calls* live, so the in-app quiz
 * and the offline pipeline cannot drift apart on them:
 *
 *  • an item's composition: exactly one lure per axis (see QUIZ_METHODS)
 *  • which charts are fair to ask about (all three axes must fill)
 *  • how hard the lures should be (nearest-first within each axis)
 *
 * Rendering is INJECTED (`RenderSvg`) because the two callers rasterize
 * differently — the app runs vega in the browser, the offline pipeline shells
 * out to `vl2svg`. Everything else is shared.
 */

import { SessionChart, SessionData, ChartLevelSpec, FieldMeta, compileToVegaLite } from './extract';
import {
    generateAll, generateCandidates, enforcePurity, pairKey,
    chartRoles, DistractorCandidate, Method,
} from './generators';
import { SpecEdit, specDiff, specDistance, dataDistance, mergeEdits, DataDistance } from './distance';
import { renderHash, degenerateText, stripSvgText } from './guard';
import { withSeededRandom } from './seeded';

/** Compile a chart-level spec and render it; returns the SVG string. */
export type RenderSvg = (vlSpec: any, id: string) => Promise<string | null>;

/**
 * Every quiz item carries exactly one lure per axis, in this order:
 *
 *   form      the drawing changed, the data did not — a wrong pick here means
 *             the participant did not encode HOW their chart looked.
 *   content   the data changed, the drawing did not — a wrong pick here means
 *             they did not encode WHAT the data said.
 *   combined  one form edit composed with one content edit.
 *
 * Because the content lure always keeps the original's chart type, the correct
 * answer is never the only chart of its kind on screen — the old chart-family
 * fairness guard is satisfied by construction.
 */
export const QUIZ_METHODS: readonly Method[] = ['form', 'content', 'combined'];

/** How many distractors one item shows besides the correct answer. */
export const LURES_PER_ITEM = QUIZ_METHODS.length;

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
    /** the specific operation behind a lure, e.g. 'mark', 'sort-value' */
    op?: string;
    label?: string;
    specDist?: number;
    dataDist?: number;
    chartType: string;
    /** on the combined lure: the ids of the form and content options it composes */
    composedOf?: [string, string];
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
    /** hard cap on renders spent searching one chart for its (A, B, A+B) triple */
    maxRendersPerChart?: number;
    onProgress?: (done: number, total: number, label: string) => void;
    /** called between charts so a UI can paint */
    yieldToUi?: () => Promise<void>;
}

export const DEFAULT_SEED = 20260807;

/** A rendered candidate that already passed the per-option guard. */
interface Rendered { svg: string; hash: string; blind: string }

/**
 * Build quiz items for the charts the participant focused on longest.
 *
 * Candidate generation happens for ALL charts up front, inside one seeded
 * synchronous block — both because the seeded `Math.random` patch is only safe
 * synchronously, and so the draw sequence does not depend on how rendering is
 * scheduled. The composition grid is materialized there too, since composing
 * later (after an await) would draw from an unseeded `Math.random`.
 *
 * An item is a 2×2: the original, a form lure A, a content lure B, and A+B —
 * the same two edits composed. Assembly therefore SEARCHES for a triple rather
 * than filling each axis independently: A and B are walked in preference order,
 * and a pair is only accepted when all four options render, survive the guard,
 * and are pairwise distinct (with text and without it). Renders are cached per
 * candidate, so backtracking to a different B never re-renders A.
 */
export async function buildQuizItems(opts: BuildQuizOptions): Promise<BuildQuizResult> {
    const {
        session, render, topN = 12, seed = DEFAULT_SEED,
        // Bounds the A × B search. A chart usually settles on its first or
        // second pair; the cap only bites on charts where many edits are inert
        // (a Bar Table renders every sort variant identically).
        maxRendersPerChart = 30, onProgress, yieldToUi,
    } = opts;

    // Phase 1 — all candidate specs and the composition grid, one seeded
    // stream, fully synchronous.
    const generated = withSeededRandom(seed, () =>
        session.charts.map(chart => ({ chart, candidates: generateCandidates(chart, session) })));

    // Phase 2 — score (cheap, no rendering) and order charts by focus time.
    const scoredPerChart = generated.map(({ chart, candidates }) => {
        const usable = (cs: DistractorCandidate[]) =>
            scoreCandidates(chart, enforcePurity(chart, cs))
                .filter(c => !c.caveat)
                // hardest first: the nearest lure on both axes
                .sort((a, b) => (a.specDist + a.dataDist) - (b.specDist + b.dataDist));
        return {
            chart,
            form: usable(candidates.form),
            content: usable(candidates.content),
            pairs: candidates.pairs,
        };
    });
    scoredPerChart.sort((a, b) => (b.chart.focusMs ?? 0) - (a.chart.focusMs ?? 0));

    const ranked = scoredPerChart.map(({ chart }) => ({
        chartId: chart.id, title: chart.title, focusMs: chart.focusMs ?? 0,
    }));

    const items: QuizItem[] = [];
    const skipped: SkippedChart[] = [];
    const total = Math.min(topN, scoredPerChart.length);

    /** per axis: how often each op has already supplied a lure (for rotation) */
    const opUse = new Map<Method, Map<string, number>>(QUIZ_METHODS.map(m => [m, new Map()]));

    /**
     * Rotate operations across items: strictly nearest-first would hand the
     * same cheapest op to every question (the color shift is always the closest
     * form lure, the category filter the closest content lure), and twelve
     * questions probing the same two memories measure less than twelve probing
     * different ones. Least-used op first, nearest-first within it.
     */
    const rotate = (cands: ScoredCandidate[], method: Method): ScoredCandidate[] => {
        const use = opUse.get(method)!;
        return cands
            .map((c, i) => ({ c, i }))
            .sort((a, b) => (use.get(a.c.op) ?? 0) - (use.get(b.c.op) ?? 0) || a.i - b.i)
            .map(x => x.c);
    };

    for (const { chart, form, content, pairs } of scoredPerChart) {
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
        const orig: Rendered = {
            svg: origSvg,
            hash: renderHash(origSvg),
            // Step 1 hides all text, so a lure must also differ from the
            // original once the labels are gone. Otherwise a text-only change —
            // the label-substitution perturbation relabels a single category and
            // leaves every mark where it was — would put two identical pictures
            // on screen and make step 1 unanswerable.
            blind: renderHash(stripSvgText(origSvg)),
        };

        // Render once per candidate, cached: the A × B search revisits the same
        // A for many Bs, and a rejected candidate must stay rejected.
        const cache = new Map<string, Rendered | null>();
        let budget = maxRendersPerChart;
        const rendered = async (cand: ScoredCandidate | DistractorCandidate, key: string): Promise<Rendered | null> => {
            if (cache.has(key)) return cache.get(key)!;
            if (budget <= 0) return null;
            budget--;
            let svg: string | null = null;
            try {
                svg = await render(compileToVegaLite(cand.spec, cand.rows, cand.metadata), `${chart.id}_${key}`);
            } catch { svg = null; }
            const ok = svg && !degenerateText(svg).length ? svg : null;
            let result: Rendered | null = null;
            if (ok) {
                const hash = renderHash(ok);
                const blind = renderHash(stripSvgText(ok));
                // A lure that renders like the original is a second correct
                // answer; one that matches it blind is unanswerable in step 1.
                if (hash !== orig.hash && blind !== orig.blind) result = { svg: ok, hash, blind };
            }
            cache.set(key, result);
            return result;
        };

        // Search for the triple. A and B are independent probes, so preference
        // order runs over A outermost — the form lure is the one a chart is
        // most likely to run out of.
        let chosen: { a: ScoredCandidate; b: ScoredCandidate; ab: DistractorCandidate;
                      ra: Rendered; rb: Rendered; rab: Rendered } | null = null;
        let sawA = false, sawB = false;

        outer:
        for (const a of rotate(form, 'form')) {
            const ra = await rendered(a, `form${a.formIndex}`);
            if (!ra) continue;
            sawA = true;
            for (const b of rotate(content, 'content')) {
                const rb = await rendered(b, `content${b.contentIndex}`);
                if (!rb) continue;
                sawB = true;
                if (rb.hash === ra.hash || rb.blind === ra.blind) continue;
                const ab = pairs.get(pairKey(a.formIndex!, b.contentIndex!));
                if (!ab) continue;
                const rab = await rendered(ab, `both${a.formIndex}_${b.contentIndex}`);
                if (!rab) continue;
                // A+B must be its own picture: if composing B onto A changed
                // nothing visible, the item would show a duplicate option.
                if (rab.hash === ra.hash || rab.hash === rb.hash) continue;
                if (rab.blind === ra.blind || rab.blind === rb.blind) continue;
                chosen = { a, b, ab, ra, rb, rab };
                break outer;
            }
        }

        if (!chosen) {
            skip(!sawA ? 'no usable form look-alike; an item needs one'
                : !sawB ? 'no usable content look-alike; an item needs one'
                : 'no form and content pair composes into a distinct third chart');
            if (yieldToUi) await yieldToUi();
            continue;
        }

        const { a, b, ab, ra, rb, rab } = chosen;
        opUse.get('form')!.set(a.op, (opUse.get('form')!.get(a.op) ?? 0) + 1);
        opUse.get('content')!.set(b.op, (opUse.get('content')!.get(b.op) ?? 0) + 1);

        const scoredAb = scoreCandidates(chart, [ab])[0];
        const formId = `${chart.id}_dForm`;
        const contentId = `${chart.id}_dContent`;
        const option = (id: string, r: Rendered, c: { method: Method; op: string; label: string; specDist: number; dataDist: number; spec: ChartLevelSpec }): QuizOption => ({
            id, svg: r.svg, method: c.method, op: c.op, label: c.label,
            specDist: c.specDist, dataDist: c.dataDist, chartType: c.spec.chartType,
        });

        items.push({
            chartId: chart.id,
            title: chart.title,
            chartType: chart.spec.chartType,
            focusMs: chart.focusMs ?? 0,
            correctId: `${chart.id}_orig`,
            options: [
                { id: `${chart.id}_orig`, svg: orig.svg, chartType: chart.spec.chartType },
                option(formId, ra, a),
                option(contentId, rb, b),
                { ...option(`${chart.id}_dBoth`, rab, scoredAb), composedOf: [formId, contentId] },
            ],
        });

        if (yieldToUi) await yieldToUi();
    }

    onProgress?.(items.length, total, '');
    return { items, skipped, ranked };
}

// ── author view ──────────────────────────────────────────────────────────

/**
 * One look-alike as the author view shows it: the render plus the reasoning —
 * which method made it, what it changed, and how far that moved it.
 */
export interface AuthoredLure {
    id: string;
    svg: string;
    method: Method;
    /** the specific operation, e.g. 'mark', 'sort-value', 'perturb-invert' */
    op: string;
    label: string;
    rationale: string;
    chartType: string;
    /** the atomic spec edits, each with its cost */
    edits: { op: string; detail: string; cost: number }[];
    specDist: number;
    dataDist: number;
    /** rank / magnitude / label / order breakdown behind dataDist */
    dataDetail: DataDistance;
    /** set when the rows differ from the original's */
    dataEditNote?: string;
    /** set when the participant also saw a version of this chart */
    caveat?: string;
    /** would the quiz be allowed to use this lure? */
    quizEligible: boolean;
}

export interface AuthoredChart {
    chartId: string;
    title: string;
    chartType: string;
    focusMs: number;
    originalSvg: string;
    /** every kept look-alike, grouped by the method that made it */
    byMethod: { method: Method; lures: AuthoredLure[] }[];
    /** candidates rejected by the render guard, with the reason */
    rejected: { method: Method; label: string; reason: string }[];
}

/** Per-method cap in the author view — enough to show a method's range. */
export const AUTHOR_PER_METHOD = 5;

/** Spread a method's candidates across its distance range instead of taking the nearest N. */
function spreadAcrossRange<T extends { specDist: number; dataDist: number }>(cands: T[], n: number): T[] {
    if (cands.length <= n) return cands;
    const sorted = [...cands].sort((a, b) => (a.specDist + a.dataDist) - (b.specDist + b.dataDist));
    const picked: T[] = [];
    for (let i = 0; i < n; i++) picked.push(sorted[Math.round(i * (sorted.length - 1) / (n - 1))]);
    return [...new Set(picked)];
}

/**
 * Build the author view for ONE chart: every method's look-alikes, with the
 * operations each performed and the distances they produced.
 *
 * Deliberately per-chart and therefore lazy — rendering every method's output
 * for a whole session is hundreds of charts, so a panel should ask for one
 * chart at a time rather than freezing while it renders them all.
 *
 * Unlike the quiz this keeps charts the quiz skips: the point is to inspect
 * what the generators do, so a chart that cannot fill all three axes is still
 * worth opening here.
 */
export async function buildAuthorViewForChart(
    chart: SessionChart,
    session: SessionData,
    render: RenderSvg,
    opts: { seed?: number; perMethod?: number } = {},
): Promise<AuthoredChart | null> {
    const { seed = DEFAULT_SEED, perMethod = AUTHOR_PER_METHOD } = opts;

    const candidates = withSeededRandom(seed, () => generateAll(chart, session));
    const scored = scoreCandidates(chart, candidates);

    const originalSvg = await render(compileToVegaLite(chart.spec, chart.rows, chart.metadata), `${chart.id}_orig`);
    if (!originalSvg) return null;
    const origHash = renderHash(originalSvg);

    // Group first, then spread within each method, so a method with a narrow
    // range still gets shown rather than being crowded out by a broader one.
    const groups = new Map<Method, ScoredCandidate[]>();
    for (const c of scored) {
        if (!groups.has(c.method)) groups.set(c.method, []);
        groups.get(c.method)!.push(c);
    }

    const byMethod: AuthoredChart['byMethod'] = [];
    const rejected: AuthoredChart['rejected'] = [];
    let n = 0;

    for (const [method, cands] of groups) {
        const lures: AuthoredLure[] = [];
        for (const cand of spreadAcrossRange(cands, perMethod)) {
            let svg: string | null = null;
            try {
                svg = await render(compileToVegaLite(cand.spec, cand.rows, cand.metadata), `${chart.id}_a${n++}`);
            } catch { svg = null; }
            if (!svg) { rejected.push({ method, label: cand.label, reason: 'did not render' }); continue; }
            const broken = degenerateText(svg);
            if (broken.length) { rejected.push({ method, label: cand.label, reason: `drew ${broken.join('/')}` }); continue; }
            if (renderHash(svg) === origHash) {
                rejected.push({ method, label: cand.label, reason: 'renders the same as the original' });
                continue;
            }
            lures.push({
                id: `${chart.id}_a${n}`,
                svg,
                method: cand.method,
                op: cand.op,
                label: cand.label,
                rationale: cand.rationale,
                chartType: cand.spec.chartType,
                edits: cand.edits.map(e => ({ op: e.op, detail: e.detail, cost: e.cost })),
                specDist: cand.specDist,
                dataDist: cand.dataDist,
                dataDetail: cand.dataDetail,
                dataEditNote: cand.dataEditNote,
                caveat: cand.caveat,
                quizEligible: !cand.caveat,
            });
        }
        if (lures.length) byMethod.push({ method, lures });
    }

    return {
        chartId: chart.id,
        title: chart.title,
        chartType: chart.spec.chartType,
        focusMs: chart.focusMs ?? 0,
        originalSvg,
        byMethod,
        rejected,
    };
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
        for (const method of QUIZ_METHODS) {
            if (item.options.filter(o => o.method === method).length !== 1) {
                problems.push(`"${item.title}": expected exactly one ${method} lure`);
            }
        }
        // The combined lure must be the composition of THIS item's own form and
        // content lures — an independently drawn pair would break the 2×2 the
        // analysis reads (A alone, B alone, A and B together).
        const a = item.options.find(o => o.method === 'form');
        const b = item.options.find(o => o.method === 'content');
        const ab = item.options.find(o => o.method === 'combined');
        if (a && b && ab) {
            if (ab.composedOf?.[0] !== a.id || ab.composedOf?.[1] !== b.id) {
                problems.push(`"${item.title}": the combined lure does not name this item's form and content lures`);
            }
            if (ab.op !== `${a.op}+${b.op}`) {
                problems.push(`"${item.title}": combined op "${ab.op}" is not "${a.op}+${b.op}"`);
            }
        }
    }
    return problems;
}
