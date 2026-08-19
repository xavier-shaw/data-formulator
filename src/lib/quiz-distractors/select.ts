// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/select.ts — turn a session into scored, guarded quiz items.
 *
 * This is the one place the quiz's *judgement calls* live, so the in-app quiz
 * and the offline pipeline cannot drift apart on them:
 *
 *  • an item's composition: an OPTION MATRIX. One axis holds the visual
 *    perturbations, the other the data perturbations, and the cross cells
 *    hold the combined lures. The target is 3×3 (original + 2 visual +
 *    2 data + 4 combined = 9 options); when a chart type admits less, the
 *    matrix shrinks toward 2×2 (4 options). Below 2×2 the chart is skipped.
 *  • which charts are fair to ask about (each axis must fill, and at least
 *    one combined cell must render)
 *  • how the lures are chosen (curated preference order per chart type,
 *    band spread on the visual axis, distinct dimensions first on the data
 *    axis, same-story dedupe)
 *
 * Rendering is INJECTED (`RenderSvg`) because the two callers rasterize
 * differently — the app runs vega in the browser, the offline pipeline shells
 * out to `vl2svg`. Everything else is shared.
 */

import { SessionChart, SessionData, ChartLevelSpec, FieldMeta, compileToVegaLite } from './extract';
import {
    generateAll, generateCandidates, enforcePurity, combineCandidates,
    purityViolation, chartRoles, DistractorCandidate, Method, VisualBand,
} from './generators';
import { DataDim } from './messageOps';
import { SpecEdit, specDiff, specDistance, dataDistance, mergeEdits, DataDistance } from './distance';
import { renderHash, degenerateText, stripSvgText } from './guard';
import { withSeededRandom } from './seeded';

/** Compile a chart-level spec and render it; returns the SVG string. */
export type RenderSvg = (vlSpec: any, id: string) => Promise<string | null>;

/**
 * Every quiz item carries lures of three kinds:
 *
 *   visual    the drawing changed, the data did not — a wrong pick here means
 *             the participant did not encode HOW their chart looked.
 *   data      the data changed, the drawing did not — a wrong pick here means
 *             they did not encode WHAT the data said.
 *   combined  both changed — a wrong pick here means they encoded neither.
 */
export const QUIZ_METHODS: readonly Method[] = ['visual', 'data', 'combined'];

/**
 * How many lures each matrix axis aims for. 2 gives the 3×3 item (with the
 * original row and column); a chart type that admits only 1 on an axis
 * shrinks the matrix toward 2×2 (user decision 2026-08-17: aim for 3×3,
 * 2×2 is acceptable).
 */
export const MATRIX_PER_AXIS = 2;

/** Below one lure per axis the matrix cannot form, and the chart is skipped. */
export const MIN_PER_AXIS = 1;

/** The four message dimensions the data axis prefers to spread across. */
export const DATA_DIMS: readonly DataDim[] = ['direction', 'location', 'existence', 'strength'];

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
    /** the specific operation: 'mark' on the visual axis, the operator id on the data axis */
    op?: string;
    label?: string;
    /** data and combined lures: the message dimension the lure attacks */
    dim?: DataDim;
    /** visual and combined lures: how far the representation moved */
    band?: VisualBand;
    specDist?: number;
    dataDist?: number;
    chartType: string;
    /**
     * Where this option sits in the matrix. v counts the visual axis, d the
     * data axis; 0 means "kept the original" on that axis. The original is
     * (0,0), a visual lure (i,0), a data lure (0,j), a combined lure (i,j).
     */
    cell: { v: number; d: number };
}

export interface QuizItem {
    chartId: string;
    title: string;
    chartType: string;
    focusMs: number;
    /** true when the chart was in the participant's findings report */
    inReport: boolean;
    correctId: string;
    /** correct answer first; the caller shuffles for presentation */
    options: QuizOption[];
}

export interface SkippedChart { chartId: string; title: string; chartType: string; reason: string }

export interface BuildQuizResult {
    items: QuizItem[];
    skipped: SkippedChart[];
    /** charts considered, in focus-time order */
    ranked: { chartId: string; title: string; focusMs: number; inReport: boolean }[];
}

export interface BuildQuizOptions {
    session: SessionData;
    render: RenderSvg;
    /**
     * How many questions to keep. Half the slots go to report charts and half
     * to intermediate ones (focus-time order within each half); a short half
     * cedes its open slots to the other.
     */
    topN?: number;
    seed?: number;
    /** hard cap on renders spent filling one chart's two quotas */
    maxRendersPerChart?: number;
    onProgress?: (done: number, total: number, label: string) => void;
    /** called between charts so a UI can paint */
    yieldToUi?: () => Promise<void>;
    /**
     * Moderator override: ask about exactly these charts, in this order,
     * instead of the focus-time top N. Unknown ids are ignored; a listed chart
     * that cannot form its option matrix is still skipped with a reason.
     */
    chartOrder?: string[];
    /**
     * Moderator override: per chart, the lures to try first on each axis,
     * keyed by `"${op}::${label}"`. Everything else keeps its automatic order,
     * and all render guards still apply.
     */
    preferredLures?: Record<string, { visual?: string[]; data?: string[] }>;
}

export const DEFAULT_SEED = 20260807;

/** A rendered candidate that already passed the per-option guard. */
interface Rendered { svg: string; hash: string; picture: string }

/**
 * Order the visual candidates for picking: spread across the bands (near,
 * mid, far, near, …) so an item does not spend all four slots on one
 * difficulty.
 */
function visualPickOrder(cands: ScoredCandidate[]): ScoredCandidate[] {
    const byBand = new Map<VisualBand, ScoredCandidate[]>([['near', []], ['mid', []], ['far', []]]);
    for (const c of cands) byBand.get(c.band ?? 'near')!.push(c);
    const out: ScoredCandidate[] = [];
    const queues = [...byBand.values()];
    for (let i = 0; out.length < cands.length; i++) {
        for (const q of queues) if (i < q.length) out.push(q[i]);
    }
    return out;
}

/**
 * Order the data candidates for picking: the first pass walks the four
 * dimensions and takes each dimension's best surviving operator; the second
 * pass fills the remaining slots from whatever else survived. Candidates
 * arrive already floor-checked and in per-dimension preference order.
 */
function dataPickOrder(cands: ScoredCandidate[]): ScoredCandidate[] {
    const byDim = new Map<DataDim, ScoredCandidate[]>(DATA_DIMS.map(d => [d, []]));
    for (const c of cands) if (c.dim) byDim.get(c.dim)!.push(c);
    const first: ScoredCandidate[] = [];
    const rest: ScoredCandidate[] = [];
    for (const dim of DATA_DIMS) {
        const [head, ...tail] = byDim.get(dim)!;
        if (head) first.push(head);
        rest.push(...tail);
    }
    return [...first, ...rest];
}

/**
 * Build quiz items, stratified by report membership: half the questions ask
 * about charts the participant put in their findings report, half about
 * intermediate charts. Within each half, the charts the participant focused
 * on longest come first.
 *
 * Candidate generation happens for ALL charts up front, inside one seeded
 * synchronous block — both because the seeded `Math.random` patch is only safe
 * synchronously, and so the draw sequence does not depend on how rendering is
 * scheduled.
 *
 * An item is an OPTION MATRIX around the original chart. The visual axis
 * takes up to MATRIX_PER_AXIS mark retargets from the chart type's curated
 * table; the data axis takes up to MATRIX_PER_AXIS message operators, with
 * two different dimensions preferred. Every chosen (visual, data) pair fills
 * its cross cell with a combined lure. Every option must render, survive the
 * degenerate-text guard, and differ from every other option by render hash;
 * two data lures that tell the same story (same takeaway signature) cannot
 * both appear. A chart is skipped when an axis stays empty, or when no
 * combined cell can be made.
 */
export async function buildQuizItems(opts: BuildQuizOptions): Promise<BuildQuizResult> {
    const {
        session, render, topN = 6, seed = DEFAULT_SEED,
        // Bounded per chart: the original, the walks along both axes, and up
        // to four cross cells.
        maxRendersPerChart = 40, onProgress, yieldToUi,
        chartOrder, preferredLures,
    } = opts;

    // Phase 1 — all candidate specs, one seeded stream, fully synchronous.
    const generated = withSeededRandom(seed, () =>
        session.charts.map(chart => ({ chart, candidates: generateCandidates(chart, session) })));

    /** Moderator preference: move the named lures to the front, keep the rest. */
    const preferOrder = (cands: ScoredCandidate[], keys: string[] | undefined): ScoredCandidate[] => {
        if (!keys?.length) return cands;
        const keyOf = (c: ScoredCandidate) => `${c.op}::${c.label}`;
        const pinned = keys
            .map(k => cands.find(c => keyOf(c) === k))
            .filter(Boolean) as ScoredCandidate[];
        return [...pinned, ...cands.filter(c => !pinned.includes(c))];
    };

    // Phase 2 — score (cheap, no rendering) and order charts by focus time.
    const scoredPerChart = generated.map(({ chart, candidates }) => {
        const usable = (cs: DistractorCandidate[]) =>
            scoreCandidates(chart, enforcePurity(chart, cs)).filter(c => !c.caveat);
        const preferred = preferredLures?.[chart.id];
        return {
            chart,
            visual: preferOrder(visualPickOrder(usable(candidates.visual)), preferred?.visual),
            data: preferOrder(dataPickOrder(usable(candidates.data)), preferred?.data),
        };
    });
    scoredPerChart.sort((a, b) => (b.chart.focusMs ?? 0) - (a.chart.focusMs ?? 0));

    const ranked = scoredPerChart.map(({ chart }) => ({
        chartId: chart.id, title: chart.title, focusMs: chart.focusMs ?? 0,
        inReport: chart.inReport ?? false,
    }));

    // The moderator's explicit list replaces the focus-ranked walk: exactly
    // those charts, in exactly that order. `ranked` stays the full focus-time
    // ordering, so an inspector can still show what the automatic pick was.
    const byId = new Map(scoredPerChart.map(entry => [entry.chart.id, entry]));
    const walk = chartOrder
        ? chartOrder.map(id => byId.get(id)).filter(Boolean) as typeof scoredPerChart
        : scoredPerChart;
    const quota = chartOrder ? walk.length : topN;

    const items: QuizItem[] = [];
    const skipped: SkippedChart[] = [];
    const total = Math.min(quota, walk.length);

    /** Try to build one chart's option matrix; true = an item was added. */
    const attempt = async ({ chart, visual, data }: (typeof scoredPerChart)[number]): Promise<boolean> => {
        onProgress?.(items.length, total, chart.title);

        const skip = (reason: string) =>
            skipped.push({ chartId: chart.id, title: chart.title, chartType: chart.spec.chartType, reason });

        // The original must render before anything can be compared to it.
        let origSvg: string | null = null;
        try {
            origSvg = await render(compileToVegaLite(chart.spec, chart.rows, chart.metadata), `${chart.id}_orig`);
        } catch { origSvg = null; }
        if (!origSvg) { skip('the original chart did not render'); return false; }

        // Every accepted option's hash — a lure that matches ANY of them puts
        // two identical pictures on screen.
        //
        // TWO hashes per option, and the second one is load-bearing. The full
        // hash includes the drawn text, so two templates that lay out the same
        // marks under different axis titles hash differently while looking the
        // same: a Bar Chart, a Grouped Bar Chart with no group field, and a
        // Stacked Bar Chart with no color field are three chart types, three
        // specs, and one picture. Comparing the text-stripped render as well
        // catches that — without it an item shipped the correct answer three
        // times over.
        const acceptedHashes = new Set<string>([renderHash(origSvg)]);
        const acceptedPictures = new Set<string>([renderHash(stripSvgText(origSvg))]);
        let budget = maxRendersPerChart;

        const rendered = async (
            cand: ScoredCandidate, key: string, comparePicture: boolean,
        ): Promise<Rendered | null> => {
            if (budget <= 0) return null;
            budget--;
            let svg: string | null = null;
            try {
                svg = await render(compileToVegaLite(cand.spec, cand.rows, cand.metadata), `${chart.id}_${key}`);
            } catch { svg = null; }
            if (!svg || degenerateText(svg).length) return null;
            const hash = renderHash(svg);
            const picture = renderHash(stripSvgText(svg));
            if (acceptedHashes.has(hash)) return null;
            if (comparePicture && acceptedPictures.has(picture)) return null;
            return { svg, hash, picture };
        };

        /**
         * Walk one axis's candidates. `quota` of Infinity takes them all.
         *
         * `comparePicture` is on for the visual axis and OFF for the data
         * axis, and that asymmetry is deliberate. A data lure on a chart whose
         * labels came out sorted keeps the bars exactly where they were and
         * moves the names between them — that is the point of the sorted-
         * profile rule, since otherwise the shape of the profile gives the
         * answer away. Such a lure is identical once the text is stripped, so
         * comparing pictures here would delete the very lures the data axis
         * depends on. The text is always visible in the question, so a
         * label-only difference is perfectly answerable.
         */
        const fill = async (
            cands: ScoredCandidate[], quota: number, prefix: string, comparePicture: boolean,
        ) => {
            const picked: { cand: ScoredCandidate; r: Rendered }[] = [];
            const stories = new Set<string>();
            for (const cand of cands) {
                if (picked.length >= quota) break;
                // Two data lures with the same story give the item two
                // defensible answers; only one of them can be used.
                if (cand.signature && stories.has(cand.signature)) continue;
                const r = await rendered(cand, `${prefix}${picked.length}_${cand.op}`, comparePicture);
                if (!r) continue;
                acceptedHashes.add(r.hash);
                if (comparePicture) acceptedPictures.add(r.picture);
                if (cand.signature) stories.add(cand.signature);
                picked.push({ cand, r });
            }
            return picked;
        };

        const pickedData = await fill(data, MATRIX_PER_AXIS, 'd', false);
        const pickedVisual = await fill(visual, MATRIX_PER_AXIS, 'v', true);

        if (pickedVisual.length < MIN_PER_AXIS || pickedData.length < MIN_PER_AXIS) {
            const side = pickedVisual.length < MIN_PER_AXIS
                ? 'no visual look-alike at all'
                : 'no data look-alike at all';
            skip(`${side} could be made for this chart`);
            return false;
        }

        // ── the cross cells ──────────────────────────────────────────────
        // A cell is the visual lure's drawing over the data lure's rows.
        // Cells render lazily and are memoized, so trying a smaller
        // rectangle does not re-render a cell the larger one already tried.
        const cellCache = new Map<string, { cand: ScoredCandidate; r: Rendered } | null>();
        const cellFor = async (vi: number, dj: number) => {
            const key = `${vi}:${dj}`;
            if (cellCache.has(key)) return cellCache.get(key)!;
            let out: { cand: ScoredCandidate; r: Rendered } | null = null;
            const combined = combineCandidates(chart, pickedVisual[vi].cand, pickedData[dj].cand);
            if (combined && !purityViolation(chart, combined)) {
                const [scored] = scoreCandidates(chart, [combined]);
                // Full-hash guard only (like the data axis): a cell shares its
                // drawing with its visual sibling and its rows with its data
                // sibling, but never both, so the stripped-picture compare
                // would be too eager here.
                const r = await rendered(scored, `c${vi}${dj}`, false);
                if (r) out = { cand: scored, r };
            }
            cellCache.set(key, out);
            return out;
        };

        // Rectangles in order of size. The first rectangle whose cells all
        // render, and stay pairwise distinct, becomes the matrix.
        const nV = pickedVisual.length, nD = pickedData.length;
        const rects: { vs: number[]; ds: number[] }[] = [];
        const all = (n: number) => Array.from({ length: n }, (_, i) => i);
        if (nV > 1 && nD > 1) rects.push({ vs: [0, 1], ds: [0, 1] });
        if (nV > 1) for (const d of all(nD)) rects.push({ vs: [0, 1], ds: [d] });
        if (nD > 1) for (const v of all(nV)) rects.push({ vs: [v], ds: [0, 1] });
        for (const v of all(nV)) for (const d of all(nD)) rects.push({ vs: [v], ds: [d] });

        let matrix: { vs: number[]; ds: number[]; cells: Map<string, { cand: ScoredCandidate; r: Rendered }> } | null = null;
        for (const rect of rects) {
            const cells = new Map<string, { cand: ScoredCandidate; r: Rendered }>();
            const cellHashes = new Set<string>();
            let ok = true;
            for (const vi of rect.vs) {
                for (const dj of rect.ds) {
                    const cell = await cellFor(vi, dj);
                    if (!cell || cellHashes.has(cell.r.hash)) { ok = false; break; }
                    cellHashes.add(cell.r.hash);
                    cells.set(`${vi}:${dj}`, cell);
                }
                if (!ok) break;
            }
            if (ok) { matrix = { ...rect, cells }; break; }
        }

        if (!matrix) {
            skip('no combined cell could be made, so the option matrix cannot form');
            return false;
        }

        const option = (idSuffix: string, r: Rendered, c: ScoredCandidate, cell: { v: number; d: number }): QuizOption => ({
            id: `${chart.id}_${idSuffix}`,
            svg: r.svg,
            method: c.method,
            op: c.op,
            label: c.label,
            dim: c.dim,
            band: c.band,
            specDist: c.specDist,
            dataDist: c.dataDist,
            chartType: c.spec.chartType,
            cell,
        });

        // The matrix may have dropped a picked lure whose cross cells failed;
        // only the rows and columns of the chosen rectangle become options.
        const vSel = matrix.vs.map(i => pickedVisual[i]);
        const dSel = matrix.ds.map(j => pickedData[j]);
        const options: QuizOption[] = [
            { id: `${chart.id}_orig`, svg: origSvg, chartType: chart.spec.chartType, cell: { v: 0, d: 0 } },
            ...vSel.map((p, i) => option(`v${i}`, p.r, p.cand, { v: i + 1, d: 0 })),
            ...dSel.map((p, j) => option(`d${j}`, p.r, p.cand, { v: 0, d: j + 1 })),
        ];
        matrix.vs.forEach((vi, i) => matrix!.ds.forEach((dj, j) => {
            const cell = matrix!.cells.get(`${vi}:${dj}`)!;
            options.push(option(`c${i}${j}`, cell.r, cell.cand, { v: i + 1, d: j + 1 }));
        }));

        items.push({
            chartId: chart.id,
            title: chart.title,
            chartType: chart.spec.chartType,
            focusMs: chart.focusMs ?? 0,
            inReport: chart.inReport ?? false,
            correctId: `${chart.id}_orig`,
            options,
        });
        return true;
    };

    if (chartOrder) {
        // The moderator's explicit list: exactly those charts, in that order.
        for (const entry of walk) {
            if (items.length >= quota) break;
            await attempt(entry);
            if (yieldToUi) await yieldToUi();
        }
    } else {
        // Stratified walk. Half the slots go to report charts, half to
        // intermediate charts; each bucket is walked in focus-time order.
        const reportQuota = Math.ceil(topN / 2);
        const quotas = { report: reportQuota, intermediate: topN - reportQuota };
        const counts = { report: 0, intermediate: 0 };
        const attempted = new Set<string>();
        for (const entry of walk) {
            if (counts.report >= quotas.report && counts.intermediate >= quotas.intermediate) break;
            const bucket = entry.chart.inReport ? 'report' : 'intermediate';
            if (counts[bucket] >= quotas[bucket]) continue;
            attempted.add(entry.chart.id);
            if (await attempt(entry)) counts[bucket]++;
            if (yieldToUi) await yieldToUi();
        }
        // Fill pass: a bucket that could not fill its half (too few charts, or
        // they all failed the guards) cedes the open slots to the other bucket.
        for (const entry of walk) {
            if (items.length >= quota) break;
            if (attempted.has(entry.chart.id)) continue;
            await attempt(entry);
            if (yieldToUi) await yieldToUi();
        }
    }

    onProgress?.(items.length, total, '');
    return { items, skipped, ranked };
}

// ── author view ──────────────────────────────────────────────────────────

/**
 * One look-alike as the author view shows it: the render plus the reasoning —
 * which axis made it, what it changed, and how far that moved it.
 */
export interface AuthoredLure {
    id: string;
    svg: string;
    method: Method;
    /** the specific operation: 'mark' on the visual axis, the operator id on the data axis */
    op: string;
    label: string;
    rationale: string;
    chartType: string;
    /** data lures: the message dimension */
    dim?: DataDim;
    /** visual lures: the framework band */
    band?: VisualBand;
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
    /** every kept look-alike, grouped by the axis that made it */
    byMethod: { method: Method; lures: AuthoredLure[] }[];
    /** candidates rejected by the render guard, with the reason */
    rejected: { method: Method; label: string; reason: string }[];
}

/** Per-axis cap in the author view — enough to show an axis's range. */
export const AUTHOR_PER_METHOD = 8;

/**
 * Build the author view for ONE chart: every axis's look-alikes, with the
 * operations each performed and the distances they produced.
 *
 * Deliberately per-chart and therefore lazy — rendering every axis's output
 * for a whole session is hundreds of charts, so a panel should ask for one
 * chart at a time rather than freezing while it renders them all.
 *
 * Unlike the quiz this keeps charts the quiz skips: the point is to inspect
 * what the generators do, so a chart that cannot fill both quotas is still
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
        for (const cand of cands.slice(0, perMethod)) {
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
                dim: cand.dim,
                band: cand.band,
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
        const orig = item.options.find(o => o.id === item.correctId);
        if (!orig) {
            problems.push(`"${item.title}": the correct answer is not among the options`);
        } else if (orig.cell.v !== 0 || orig.cell.d !== 0) {
            problems.push(`"${item.title}": the correct answer is not at cell (0,0)`);
        }

        // The options must form a FULL rectangle: every (v,d) cell exactly
        // once, with at least one lure on each axis.
        const nV = Math.max(...item.options.map(o => o.cell.v));
        const nD = Math.max(...item.options.map(o => o.cell.d));
        const cells = new Set(item.options.map(o => `${o.cell.v}:${o.cell.d}`));
        if (nV < MIN_PER_AXIS || nD < MIN_PER_AXIS) {
            problems.push(`"${item.title}": the matrix is ${nV}×${nD} lures, below the minimum of ${MIN_PER_AXIS} per axis`);
        }
        if (cells.size !== item.options.length || item.options.length !== (nV + 1) * (nD + 1)) {
            problems.push(`"${item.title}": ${item.options.length} options do not form a full ${nV + 1}×${nD + 1} matrix`);
        }

        // Each cell's method and payload must match its coordinates.
        for (const o of item.options) {
            if (o.id === item.correctId) continue;
            const expect: Method = o.cell.v > 0 && o.cell.d > 0 ? 'combined'
                : o.cell.v > 0 ? 'visual' : 'data';
            if (o.method !== expect) {
                problems.push(`"${item.title}": the option at (${o.cell.v},${o.cell.d}) is ${o.method}, expected ${expect}`);
            }
            if (expect === 'data' && o.chartType !== item.chartType) {
                problems.push(`"${item.title}": data lure "${o.label}" changed the chart type`);
            }
            if (expect !== 'data' && o.chartType === item.chartType) {
                problems.push(`"${item.title}": ${expect} lure "${o.label}" kept the chart type`);
            }
            if (expect !== 'visual' && !o.dim) {
                problems.push(`"${item.title}": ${expect} lure "${o.label}" carries no dimension`);
            }
            if (expect !== 'data' && !o.band) {
                problems.push(`"${item.title}": ${expect} lure "${o.label}" carries no band`);
            }
        }
    }
    return problems;
}
