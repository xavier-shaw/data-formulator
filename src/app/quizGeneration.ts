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
    extractSession, buildQuizItems, verifyQuizItems,
    QuizItem, SkippedChart, DEFAULT_SEED,
} from '../lib/quiz-distractors';
import { renderVegaLiteToSvg } from './vegaRender';
import { loadWorkspace } from './workspaceService';

export interface GeneratedQuiz {
    sessionId: string;
    sessionName: string;
    seed: number;
    items: QuizItem[];
    skipped: SkippedChart[];
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

export async function generateQuizForSession(args: GenerateQuizArgs): Promise<GeneratedQuiz> {
    const { sessionId, sessionName, liveState, topN = 12, seed = DEFAULT_SEED, onProgress } = args;

    let stateLike: any = liveState;
    if (!stateLike) {
        // A different session than the one open: read its stored state. This is
        // a pure read — it does not switch the user's active session.
        const loaded = await loadWorkspace(sessionId);
        if (!loaded?.state) {
            throw new Error('This session could not be read, so no quiz can be made from it.');
        }
        stateLike = loaded.state;
    }

    const session = extractSession(thawRows(stateLike));
    if (session.charts.length === 0) {
        throw new Error('This session has no charts to ask about.');
    }

    const { items, skipped } = await buildQuizItems({
        session,
        topN,
        seed,
        render: (vlSpec, id) => renderVegaLiteToSvg(vlSpec).catch((e) => {
            // A candidate that will not render is simply not offered; log it so
            // a systematic failure (rather than one odd spec) is visible.
            console.warn(`[quiz] chart did not render (${id}): ${e?.message}`);
            return null;
        }),
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
        chartsConsidered: session.charts.length,
        // Render hashes are not comparable to the offline pipeline's (browser
        // vega and node vl2svg measure text differently), so the meaningful
        // check here is the invariants, not a count match.
        problems: verifyQuizItems(items),
    };
}

// ── answer recording ─────────────────────────────────────────────────────

export interface QuizAnswer {
    n: number;
    chartId: string;
    title: string;
    chartType: string;
    correct: boolean;
    pickedId: string;
    /** set only on a miss: which method produced the chosen look-alike */
    method?: string;
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
}

export function buildQuizResult(quiz: GeneratedQuiz, answers: QuizAnswer[], completedAt: string): QuizResult {
    return {
        sessionId: quiz.sessionId,
        sessionName: quiz.sessionName,
        seed: quiz.seed,
        completedAt,
        total: quiz.items.length,
        correct: answers.filter(a => a.correct).length,
        answers,
    };
}
