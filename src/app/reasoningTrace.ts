// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * reasoningTrace — material and scoring for the reasoning-trace memory step
 * (part 4 of the quiz, after chart recognition).
 *
 * The step asks whether the participant remembers not just their charts but the
 * PROCESS: which chart led to which, and why each step was taken. Two prototype
 * forms share this material:
 *
 *   • tree       — rebuild the analysis as a tree on a canvas (structure memory,
 *                  scored against the ground-truth lineage below)
 *   • provenance — one move at a time: which chart came next, and why
 *                  (app/provenanceQuiz.ts builds its items from this material;
 *                  the prompt that really drove the move is stored next to the
 *                  typed rationale for offline comparison, never shown)
 *
 * Ground truth: the same lineage the analysis graph uses. A chart's parent is
 * the previous chart on its own table (a refinement chain), else the latest
 * earlier chart on the nearest charted ancestor table (walking
 * `derive.trigger.tableId`), else nothing — the chart starts a thread from the
 * dataset itself. Chart-level rather than attribute-set-level on purpose: the
 * participant drags CHARTS, so the truth has to be stated in charts too.
 */

import { extractSession, compileToVegaLite, SessionChart, SessionStateLike } from '../lib/quiz-distractors';
import { renderVegaLiteToSvg } from './vegaRender';
import { promptOfTable, chartTime, PromptSource } from './analysisHybridGraph';
import { chartDisplayTitle } from './chartTitle';
import { resolveSessionState } from './quizGeneration';
import { ProvenanceAnswer } from './provenanceQuiz';

export interface TraceChart {
    chartId: string;
    /** creation-order index, 1-based — the thread form shows charts in this order */
    num: number;
    title: string;
    chartType: string;
    tableId: string;
    svg: string;
    /** ground truth: the chart this one grew out of; null = started from the data */
    parentChartId: string | null;
    /** the prompt that produced the chart's table — ground truth for the thread form */
    actualPrompt: string;
    promptSource: PromptSource;
}

export interface TraceMaterial {
    sessionId: string;
    charts: TraceChart[];
    /** ground-truth edges, parent → child, one per non-root chart */
    edges: { from: string; to: string }[];
    /** charts that would not render and so are absent from the step */
    skipped: string[];
}

/**
 * A participant-drawn edge, parent → child ("this chart led to that one").
 */
export interface TraceEdge { from: string; to: string }

export interface TraceTreeScore {
    /** participant edges that match a ground-truth parent→child pair (either direction) */
    hits: number;
    /** ground-truth edges the participant did not draw */
    misses: number;
    /** participant edges with no ground-truth counterpart */
    extras: number;
    precision: number;
    recall: number;
}

export interface TraceTreeAnswer {
    form: 'tree';
    seconds: number;
    /** where each chart ended up on the canvas */
    placed: { chartId: string; x: number; y: number }[];
    edges: TraceEdge[];
    score: TraceTreeScore;
    /** the truth the score was computed against, for the analysis file */
    groundTruth: TraceEdge[];
}

export type TraceAnswer = TraceTreeAnswer | ProvenanceAnswer;

/**
 * Build the trace material for a session: its user-made charts in creation
 * order, each rendered once, with the ground-truth lineage between them.
 */
export async function loadTraceMaterial(args: { sessionId: string; liveState?: unknown }): Promise<TraceMaterial> {
    const state: SessionStateLike & { tables?: any[]; charts?: any[] } =
        await resolveSessionState(args.sessionId, args.liveState);

    const session = extractSession(state);
    const byId = new Map<string, SessionChart>(session.charts.map(c => [c.id, c]));
    const tablesById = new Map<string, any>((state.tables ?? []).map((t: any) => [t.id, t]));
    const fieldsById = new Map<string, any>((state.conceptShelfItems ?? []).map((f: any) => [f.id, f]));

    // Creation order over the raw charts (extractSession keeps no timestamps).
    // Agent-proposed charts are not part of the participant's own trace, mirroring
    // the analysis graph's filter.
    const ordered = (state.charts ?? [])
        .filter((c: any) => (c.source ?? 'user') === 'user' && byId.has(c.id))
        .map((c: any) => ({ raw: c, t: chartTime(c, tablesById.get(c.tableRef)) }))
        .sort((a, b) => a.t - b.t);

    const charts: TraceChart[] = [];
    const skipped: string[] = [];
    /** tableId → charts already traced on it, in order */
    const chartsOnTable = new Map<string, TraceChart[]>();

    // Latest already-traced chart on this table, else on the nearest charted
    // ancestor (walking the derive chain), else null → the chart is a root.
    const findParent = (tableId: string): TraceChart | null => {
        const seen = new Set<string>();
        let cur: any = tablesById.get(tableId);
        while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            const here = chartsOnTable.get(cur.id);
            if (here?.length) return here[here.length - 1];
            if (!cur.derive) return null;
            const next = cur.derive.trigger?.tableId || cur.derive.source?.[0];
            cur = next ? tablesById.get(next) : undefined;
        }
        return null;
    };

    for (const { raw } of ordered) {
        const sc = byId.get(raw.id)!;
        let svg: string | null = null;
        try {
            svg = await renderVegaLiteToSvg(compileToVegaLite(sc.spec, sc.rows, sc.metadata));
        } catch (e: any) {
            console.warn(`[trace] chart did not render (${sc.id}): ${e?.message}`);
        }
        if (!svg) { skipped.push(sc.title); continue; }

        const parent = findParent(sc.tableId);
        const { text, source } = promptOfTable(tablesById.get(sc.tableId));
        const chart: TraceChart = {
            chartId: sc.id,
            num: charts.length + 1,
            // A display name, never an id — participants see these labels.
            title: chartDisplayTitle(raw, fieldsById),
            chartType: sc.spec.chartType,
            tableId: sc.tableId,
            svg,
            parentChartId: parent?.chartId ?? null,
            actualPrompt: text,
            promptSource: source,
        };
        charts.push(chart);
        const list = chartsOnTable.get(sc.tableId) ?? [];
        list.push(chart);
        chartsOnTable.set(sc.tableId, list);
    }

    return {
        sessionId: args.sessionId,
        charts,
        edges: charts.filter(c => c.parentChartId).map(c => ({ from: c.parentChartId!, to: c.chartId })),
        skipped,
    };
}

/** Undirected pair key: a mis-directed but correctly-paired edge still counts. */
const pairKey = (e: TraceEdge) => [e.from, e.to].sort().join('→');

export function scoreTraceTree(drawn: TraceEdge[], truth: TraceEdge[]): TraceTreeScore {
    const truthKeys = new Set(truth.map(pairKey));
    const drawnKeys = new Set(drawn.map(pairKey));
    const hits = [...drawnKeys].filter(k => truthKeys.has(k)).length;
    return {
        hits,
        misses: truthKeys.size - hits,
        extras: drawnKeys.size - hits,
        precision: drawnKeys.size ? hits / drawnKeys.size : 0,
        recall: truthKeys.size ? hits / truthKeys.size : 1,
    };
}

/**
 * The palette order for the tree form. Deterministically shuffled — creation
 * order would leak the very structure the step asks the participant to recall.
 */
export function shuffledTraceCharts(charts: TraceChart[], seed = 20260813): TraceChart[] {
    const out = [...charts];
    let h = seed >>> 0;
    for (let i = out.length - 1; i > 0; i--) {
        h = (h * 1103515245 + 12345) & 0x7fffffff;
        const j = h % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
