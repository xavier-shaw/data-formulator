// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quizGeneration — build a chart-recognition quiz for one session, in the browser.
 *
 * Asks: "which of these charts did you actually make?" The wrong answers are
 * generated look-alikes (see src/lib/quiz-distractors), arranged as an option
 * matrix of up to 3×3: VISUAL perturbations (same data, different
 * representation), DATA perturbations (same representation, different
 * message), and COMBINED perturbations (both changed) in the cross cells.
 * All are rendered through the app's own Flint chart pipeline so they sit
 * visually alongside the participant's real charts rather than looking like
 * something else entirely.
 *
 * Chart selection is stratified by report membership: half of the questions
 * ask about charts the participant put in their findings report
 * (`state.findingsChartIds`), half about intermediate charts. Within each
 * half, charts are ranked by how long the participant actually looked at them
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
import { loadModeratorConfig, QuizModeratorConfig } from './quizModeratorConfig';

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
    ranked: { chartId: string; title: string; focusMs: number; inReport: boolean }[];
    /** how many charts the session offered before selection */
    chartsConsidered: number;
    /** invariant violations; non-empty means something is wrong with the set */
    problems: string[];
    /** true when a moderator config drove the chart selection */
    moderated: boolean;
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
    /**
     * The moderator config to apply. Undefined = read the stored config for
     * this session (the participant path); null = ignore any stored config
     * (the moderator page passes its own draft explicitly).
     */
    config?: QuizModeratorConfig | null;
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
    const { sessionId, sessionName, liveState, topN = 6, seed = DEFAULT_SEED, onProgress } = args;

    const session = await resolveSession(sessionId, liveState);
    if (session.charts.length === 0) {
        throw new Error('This session has no charts to ask about.');
    }

    // The moderator's choices, when there are any: an explicit chart list and
    // preferred perturbations. Undefined config means "look it up"; null means
    // the caller wants the automatic behavior regardless.
    const config = args.config === undefined ? loadModeratorConfig(sessionId) : args.config;
    const recognition = config?.recognition;

    const { items, skipped, ranked } = await buildQuizItems({
        session,
        topN,
        seed,
        render: renderOrNull,
        onProgress,
        yieldToUi,
        chartOrder: recognition?.chartIds,
        preferredLures: recognition?.preferred,
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
        moderated: !!(recognition?.chartIds || recognition?.preferred),
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
 * Build the author view for a single chart: each axis's look-alikes (visual,
 * data) with the operations behind them. One chart at a time, on
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
 * One answer. A question is one step: the option matrix is shown with its
 * text, the participant picks one, and the pick is scored.
 */
export interface QuizAnswer {
    n: number;
    chartId: string;
    title: string;
    chartType: string;
    /** true when the asked-about chart was in the participant's findings report */
    inReport: boolean;

    correct: boolean;
    pickedId: string;

    /** set only on a miss: which axis produced the chosen look-alike (visual / data / combined) */
    method?: string;
    /** the specific operation behind it, e.g. 'mark', 'reassign-reverse', 'mark+attenuate' */
    op?: string;
    label?: string;
    /** data and combined lures: the message dimension the lure attacked (direction / location / existence / strength) */
    dim?: string;
    /** visual and combined lures: how far the representation moved (near / mid / far) */
    band?: string;
    /** where the pick sat in the option matrix; the original is (0,0) */
    cell?: { v: number; d: number };
    /** the misrecall distances: how far the chosen look-alike sat from the real chart */
    specDist?: number;
    dataDist?: number;

    /** 0-100, very unsure → very sure, given before the answer was revealed */
    confidence: number;
    /** false = the rater was left at its midpoint default, never touched */
    confidenceSet: boolean;
}

/** Part 1: the questions the participant would ask next. Free text, never
 *  scored — read offline against the analysis the session really produced. */
export interface NextQuestionsAnswer {
    /** exactly what was typed, in slot order; an empty slot stays empty */
    questions: string[];
    seconds: number;
}

export interface QuizResult {
    sessionId: string;
    sessionName: string;
    seed: number;
    completedAt: string;
    total: number;
    correct: number;
    answers: QuizAnswer[];
    /** part 2: the attributes named, and how they scored (absent if skipped) */
    recall?: RecallAnswer;
    /** part 3: the combinations they were grouped into (absent if skipped) */
    combos?: ComboAnswer;
    /** part 1: the three questions they would ask next (absent if skipped) */
    nextQuestions?: NextQuestionsAnswer;
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
