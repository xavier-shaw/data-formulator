// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quizGeneration — build a chart-recognition quiz for one session, in the browser.
 *
 * Asks: "which of these four charts did you actually make?" The three wrong
 * answers are generated look-alikes (see src/lib/quiz-distractors), rendered
 * through the app's own Flint chart pipeline so they sit visually alongside the
 * participant's real charts rather than looking like something else entirely.
 *
 * Charts are ranked by how long the participant actually looked at them
 * (`state.chartUsage.focusMs`), so the quiz asks about the work they engaged
 * with rather than every chart they happened to produce.
 *
 * All of this runs client-side: the generators are pure TypeScript and vega is
 * already in the bundle, so no backend call is involved.
 */

import {
    extractSession, buildQuizItems, verifyQuizItems, buildAuthorViewForChart,
    QuizItem, SkippedChart, AuthoredChart, DEFAULT_SEED,
} from '../lib/quiz-distractors';
import { renderVegaLiteToSvg } from './vegaRender';
import { loadWorkspace } from './workspaceService';
import { readRecallMaterial, ComboAnswer, RecallAnswer, RecallMaterial } from './fieldRecall';

export interface GeneratedQuiz {
    sessionId: string;
    sessionName: string;
    seed: number;
    items: QuizItem[];
    skipped: SkippedChart[];
    /**
     * Every chart considered, in focus-time order — including the ones the quiz
     * did not ask about. Author mode lists these, since inspecting a chart's
     * look-alikes is worthwhile even when the quiz refused to use them.
     */
    ranked: { chartId: string; title: string; focusMs: number }[];
    /** how many charts the session offered before selection */
    chartsConsidered: number;
    /** invariant violations; non-empty means something is wrong with the set */
    problems: string[];
}

export interface GenerateQuizArgs {
    sessionId: string;
    sessionName: string;
    /**
     * The live Redux state, when the target session is the active one. Preferred
     * over the stored copy: autosave lags, and the focus time of the chart being
     * viewed right now is still accumulating in memory.
     */
    liveState?: unknown;
    topN?: number;
    seed?: number;
    onProgress?: (done: number, total: number, label: string) => void;
}

/** Let the browser paint between charts so a progress bar actually moves. */
const yieldToUi = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Return the state with freshly-copied table rows.
 *
 * Vega stamps every datum it renders with a `Symbol(vega_id)` property. Redux
 * Toolkit freezes store state, so handing it a row straight from the live slice
 * fails with "Cannot add property Symbol(vega_id), object is not extensible" —
 * and because the failure happens per chart, the quiz would silently come up
 * short of questions rather than erroring. (ChartRenderService copies rows for
 * the same reason before rendering thumbnails.)
 *
 * Copied once per table here, so every chart and all of its look-alikes still
 * share one row array — the property the render guard depends on.
 */
function thawRows(state: any): any {
    if (!Array.isArray(state?.tables)) return state;
    return {
        ...state,
        tables: state.tables.map((t: any) => ({
            ...t,
            rows: Array.isArray(t?.rows) ? t.rows.map((r: any) => ({ ...r })) : [],
        })),
    };
}

/**
 * The session's charts, from live state when it is the open session and from
 * storage otherwise. Reading a stored session is a pure read — it does not
 * switch the user's active session.
 *
 * Exported for reasoningTrace, which needs the same state (with the same row
 * thaw — its charts render through vega too) plus the derive lineage that
 * `extractSession` drops.
 */
export async function resolveSessionState(sessionId: string, liveState: unknown) {
    let stateLike: any = liveState;
    if (!stateLike) {
        const loaded = await loadWorkspace(sessionId);
        if (!loaded?.state) {
            throw new Error('This session could not be read, so no quiz can be made from it.');
        }
        stateLike = loaded.state;
    }
    return thawRows(stateLike);
}

async function resolveSession(sessionId: string, liveState: unknown) {
    return extractSession(await resolveSessionState(sessionId, liveState));
}

/**
 * The material for the field-recall step: the table the participant started
 * from, the attributes available to them, and what their charts encoded.
 *
 * Separate from `generateQuizForSession` because it needs no rendering — the
 * step can be answered while the look-alike charts are still being made.
 */
export async function loadRecallMaterial(args: { sessionId: string; liveState?: unknown }): Promise<RecallMaterial> {
    return readRecallMaterial(await resolveSessionState(args.sessionId, args.liveState));
}

/** Render a spec, reporting a failure rather than throwing: a chart that will
 *  not render is simply not offered. */
const renderOrNull = (vlSpec: any, id: string) =>
    renderVegaLiteToSvg(vlSpec).catch((e) => {
        console.warn(`[quiz] chart did not render (${id}): ${e?.message}`);
        return null;
    });

export async function generateQuizForSession(args: GenerateQuizArgs): Promise<GeneratedQuiz> {
    const { sessionId, sessionName, liveState, topN = 12, seed = DEFAULT_SEED, onProgress } = args;

    const session = await resolveSession(sessionId, liveState);
    if (session.charts.length === 0) {
        throw new Error('This session has no charts to ask about.');
    }

    const { items, skipped, ranked } = await buildQuizItems({
        session,
        topN,
        seed,
        render: renderOrNull,
        onProgress,
        yieldToUi,
    });

    if (skipped.length) {
        // Surfaced because "why are there only N questions?" is otherwise
        // invisible: some chart types cannot be given believable look-alikes.
        console.info(
            `[quiz] ${items.length} question(s) from ${session.charts.length} chart(s); ` +
            `${skipped.length} skipped:`,
            skipped.map(s => `${s.title} [${s.chartType}] — ${s.reason}`),
        );
    }

    return {
        sessionId,
        sessionName,
        seed,
        items,
        skipped,
        ranked,
        chartsConsidered: session.charts.length,
        // Render hashes are not comparable to the offline pipeline's (browser
        // vega and node vl2svg measure text differently), so the meaningful
        // check here is the invariants, not a count match.
        problems: verifyQuizItems(items),
    };
}

// ── author mode ──────────────────────────────────────────────────────────

export interface AuthorViewArgs {
    sessionId: string;
    liveState?: unknown;
    chartId: string;
    seed?: number;
}

/**
 * Build the author view for a single chart: each axis's look-alikes (form,
 * content, combined) with the operations behind them. One chart at a time, on
 * demand — rendering a whole session's lures at once is hundreds of charts and
 * would stall the panel.
 */
export async function authorViewForChart(args: AuthorViewArgs): Promise<AuthoredChart | null> {
    const { sessionId, liveState, chartId, seed = DEFAULT_SEED } = args;
    const session = await resolveSession(sessionId, liveState);
    const chart = session.charts.find(c => c.id === chartId);
    if (!chart) return null;
    return buildAuthorViewForChart(chart, session, renderOrNull, { seed });
}

// ── answer recording ─────────────────────────────────────────────────────

/**
 * One answer, recorded across both steps of a question.
 *
 * Each chart is asked twice: first with all text stripped from the options
 * (axis labels, tick values, legend text), then again with the text shown. That
 * separates two different memories — the shape of a chart, and what was written
 * on it — and `changedAfterText` says whether reading the labels overturned the
 * judgement the shape alone produced.
 */
export interface QuizAnswer {
    n: number;
    chartId: string;
    title: string;
    chartType: string;

    /** step 1: chosen while all text was hidden */
    blindPickedId: string;
    blindCorrect: boolean;

    /** step 2 (final): chosen with the text visible */
    correct: boolean;
    pickedId: string;
    /** did seeing the text change the answer? */
    changedAfterText: boolean;

    /** set only on a final miss: which axis produced the chosen look-alike (form / content / combined) */
    method?: string;
    /** the specific operation behind it, e.g. 'mark', 'sort-value', 'perturb-invert' */
    op?: string;
    label?: string;
    /** the misrecall distances: how far the chosen look-alike sat from the real chart */
    specDist?: number;
    dataDist?: number;
}

export interface QuizResult {
    sessionId: string;
    sessionName: string;
    seed: number;
    completedAt: string;
    total: number;
    correct: number;
    answers: QuizAnswer[];
    /** part 1: the attributes named, and how they scored (absent if skipped) */
    recall?: RecallAnswer;
    /** part 2: the combinations they were grouped into (absent if skipped) */
    combos?: ComboAnswer;
}

export function buildQuizResult(
    quiz: GeneratedQuiz, answers: QuizAnswer[], completedAt: string,
    recall?: RecallAnswer, combos?: ComboAnswer,
): QuizResult {
    return {
        sessionId: quiz.sessionId,
        sessionName: quiz.sessionName,
        seed: quiz.seed,
        completedAt,
        total: quiz.items.length,
        correct: answers.filter(a => a.correct).length,
        answers,
        recall,
        combos,
    };
}
