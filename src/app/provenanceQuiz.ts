// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * provenanceQuiz — material and scoring for the provenance question of the
 * reasoning-trace step (part 5).
 *
 * One item asks a single move: the participant sees where they were (the chart
 * before it, then the chart itself) and picks, out of three real charts from
 * their own session, the one they actually made next. Confirming reveals the
 * true next chart. The item scores memory of the SEQUENCE, and records how
 * sure they were of it before the reveal.
 *
 * Transition sampling is STRATIFIED by report membership: half of the items
 * stand on a stretch that touches a chart the participant put in their
 * findings report, half on a stretch that does not. Within each half the draw
 * is random (seeded, so a retake and an offline rebuild give the same items).
 * Distractors stay fully random. Choosing them deliberately — within-thread vs
 * between-thread moves, distractors balanced for creation time and shared
 * attributes — is the next question; `sampleTransitions` and `pickDistractors`
 * are the two seams where that will land.
 */

import { PromptSource } from './analysisHybridGraph';
import { TraceChart, TraceMaterial } from './reasoningTrace';

/** Options offered per item: the real next chart plus two look-alike-free lures. */
export const OPTIONS_PER_ITEM = 3;
/** Items in one run, when the session affords that many transitions. */
export const DEFAULT_ITEM_COUNT = 4;
export const DEFAULT_PROVENANCE_SEED = 20260814;

export interface ProvenanceItem {
    id: string;
    /** the chart made before `from` — context only, may be absent for a first move */
    previous: TraceChart | null;
    /** where the participant was standing: the move starts here */
    from: TraceChart;
    /** OPTIONS_PER_ITEM real charts from the session, shuffled; one is the answer */
    options: TraceChart[];
    answerChartId: string;
    /** true when the item's shown stretch (previous, from, answer) touches a report chart */
    touchesReport: boolean;
}

export interface ProvenanceMaterial {
    sessionId: string;
    items: ProvenanceItem[];
    /** transitions the session offered, before sampling — for the answer file */
    transitionsAvailable: number;
}

export interface ProvenanceResponse {
    itemId: string;
    fromChartId: string;
    fromNum: number;
    answerChartId: string;
    answerNum: number;
    pickedChartId: string;
    pickedNum: number;
    correct: boolean;
    /** whether the item stood on a stretch with a report chart (the sampling bucket) */
    touchesReport: boolean;
    /** creation numbers of the three options, as offered — lets an offline pass
     *  check whether the item was guessable from recency alone */
    optionNums: number[];
    /** the prompt that actually produced the next chart; never shown in the step */
    actualPrompt: string;
    promptSource: PromptSource;
    /** 0-100, very unsure → very sure, given before the answer was revealed */
    confidence: number;
    /** false = the rater was left at its midpoint default, never touched */
    confidenceSet: boolean;
    seconds: number;
}

export interface ProvenanceAnswer {
    form: 'provenance';
    seconds: number;
    responses: ProvenanceResponse[];
    score: { correct: number; total: number };
}

/** Deterministic RNG — the same seed must rebuild the same quiz. */
const makeRng = (seed: number) => {
    let h = seed >>> 0;
    return () => {
        h = (h * 1103515245 + 12345) & 0x7fffffff;
        return h / 0x7fffffff;
    };
};

const shuffle = <T>(items: T[], rnd: () => number): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
};

/**
 * Which moves to ask about. Stratified by report membership: half of the
 * items must show a stretch that touches a report chart, half a stretch that
 * does not. Within each half the draw is random (see the module note). Never
 * two moves that share a chart: item A's context ("before that #8, you were
 * here #9") would otherwise hand over item B's answer, since B asks what
 * followed #8. Items therefore stand on DISJOINT stretches of the analysis.
 *
 * A transition is a ground-truth lineage edge: `from` led to `to`. A bucket
 * that runs out of eligible edges cedes its open slots to the other bucket,
 * so a session with no report (or an all-report one) still yields full items.
 */
export const sampleTransitions = (
    edges: { from: string; to: string }[],
    count: number,
    rnd: () => number,
    parentOf: (chartId: string) => string | null,
    inReport?: (chartId: string) => boolean,
): { from: string; to: string }[] => {
    const picked: { from: string; to: string }[] = [];
    const used = new Set<string>();
    // the three charts this item would put on screen as its own trace
    const shownOf = (edge: { from: string; to: string }) =>
        [edge.from, edge.to, parentOf(edge.from)].filter(Boolean) as string[];
    const take = (edge: { from: string; to: string }): boolean => {
        const shown = shownOf(edge);
        if (shown.some(id => used.has(id))) return false;
        picked.push(edge);
        for (const id of shown) used.add(id);
        return true;
    };

    const shuffled = shuffle(edges, rnd);

    if (inReport) {
        const reportQuota = Math.ceil(count / 2);
        const quotas = { report: reportQuota, other: count - reportQuota };
        const counts = { report: 0, other: 0 };
        for (const edge of shuffled) {
            if (counts.report >= quotas.report && counts.other >= quotas.other) break;
            const bucket = shownOf(edge).some(inReport) ? 'report' : 'other';
            if (counts[bucket] >= quotas[bucket]) continue;
            if (take(edge)) counts[bucket]++;
        }
    }

    // Fill pass (and the whole draw when no report predicate is given). An
    // already-picked edge cannot repeat: its charts sit in `used`.
    for (const edge of shuffled) {
        if (picked.length >= count) break;
        take(edge);
    }
    return picked;
};

/**
 * The two charts offered alongside the real next chart. Random for now, drawn
 * from the participant's OWN charts: a synthetic look-alike would re-ask part
 * 3's recognition question instead of this one's "what came next".
 */
export const pickDistractors = (
    pool: TraceChart[],
    exclude: Set<string>,
    count: number,
    rnd: () => number,
): TraceChart[] => shuffle(pool.filter(c => !exclude.has(c.chartId)), rnd).slice(0, count);

export interface ProvenanceOverrides {
    /** ask exactly these moves, in this order (must be real lineage edges) */
    transitions?: { from: string; to: string }[];
    /** per move (keyed `"from>to"`), the distractor chart ids to offer */
    distractors?: Record<string, string[]>;
}

/**
 * Build the items from trace material already loaded for part 4 (the same
 * charts, renders and lineage the tree form is scored against).
 *
 * The moderator can override both draws: `overrides.transitions` replaces the
 * seeded transition sampling, and `overrides.distractors` replaces the random
 * distractor pick per item. A short or invalid override is completed with the
 * seeded draw, so a partial config still yields well-formed items.
 */
export function buildProvenanceMaterial(
    material: TraceMaterial,
    opts: { count?: number; seed?: number; overrides?: ProvenanceOverrides } = {},
): ProvenanceMaterial {
    const { count = DEFAULT_ITEM_COUNT, seed = DEFAULT_PROVENANCE_SEED, overrides } = opts;
    const rnd = makeRng(seed);
    const byId = new Map(material.charts.map(c => [c.chartId, c]));

    const parentOf = (chartId: string) => byId.get(chartId)?.parentChartId ?? null;

    // Only real ground-truth edges are askable — a made-up move has no answer.
    const isEdge = (t: { from: string; to: string }) =>
        material.edges.some(e => e.from === t.from && e.to === t.to);
    const inReport = (chartId: string) => byId.get(chartId)?.inReport ?? false;
    const chosen = overrides?.transitions?.length
        ? overrides.transitions.filter(isEdge)
        : sampleTransitions(material.edges, count, rnd, parentOf, inReport);

    const items: ProvenanceItem[] = [];
    for (const edge of chosen) {
        const from = byId.get(edge.from);
        const answer = byId.get(edge.to);
        if (!from || !answer) continue;

        // Neither the chart being stood on nor the one before it can be an
        // option: "you made this next" would be answerable by elimination.
        const previous = from.parentChartId ? byId.get(from.parentChartId) ?? null : null;
        const exclude = new Set([from.chartId, answer.chartId, previous?.chartId].filter(Boolean) as string[]);
        // The moderator's distractors first (deduplicated, and only valid
        // ones), then the seeded draw fills whatever is still open.
        const pinnedIds = overrides?.distractors?.[`${edge.from}>${edge.to}`] ?? [];
        const pinned = [...new Set(pinnedIds)]
            .map(id => byId.get(id))
            .filter((c): c is TraceChart => !!c && !exclude.has(c.chartId))
            .slice(0, OPTIONS_PER_ITEM - 1);
        for (const c of pinned) exclude.add(c.chartId);
        const lures = [
            ...pinned,
            ...pickDistractors(material.charts, exclude, OPTIONS_PER_ITEM - 1 - pinned.length, rnd),
        ];
        // A two-option item is a coin flip; drop it rather than weaken the run.
        if (lures.length < OPTIONS_PER_ITEM - 1) continue;

        items.push({
            id: `prov-${from.chartId}-${answer.chartId}`,
            previous,
            from,
            options: shuffle([answer, ...lures], rnd),
            answerChartId: answer.chartId,
            touchesReport: [previous, from, answer].some(c => !!c?.inReport),
        });
    }

    return { sessionId: material.sessionId, items, transitionsAvailable: material.edges.length };
}

/** Score a finished run: the pick is right or wrong; the confidence and the
 *  real prompt behind the move are read offline. */
export function buildProvenanceAnswer(responses: ProvenanceResponse[], seconds: number): ProvenanceAnswer {
    return {
        form: 'provenance',
        seconds,
        responses,
        score: { correct: responses.filter(r => r.correct).length, total: responses.length },
    };
}
