// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * provenanceQuiz — material and scoring for the PROVENANCE form of the
 * reasoning-trace step (part 4, form B; form A is the tree in TraceTreeStep).
 *
 * One item asks a single move, in two parts:
 *
 *   1 · which came next — the participant sees where they were (the chart
 *       before it, then the chart itself) and picks, out of three real charts
 *       from their own session, the one they actually made next
 *   2 · why — after the true next chart is revealed, they say why they moved
 *       from one to the other
 *
 * The split is the point: part 1 scores memory of the SEQUENCE, part 2 the
 * memory of the LOGIC. Because the reveal comes first, a participant who
 * misremembers the order still writes a rationale about the move that really
 * happened, so the two are read independently.
 *
 * Transitions and distractors are drawn at RANDOM here (seeded, so a retake and
 * an offline rebuild give the same items). Choosing them deliberately — within-
 * thread vs between-thread moves, distractors balanced for creation time and
 * shared attributes — is the next question; `sampleTransitions` and
 * `pickDistractors` are the two seams where that will land.
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
    /** creation numbers of the three options, as offered — lets an offline pass
     *  check whether the item was guessable from recency alone */
    optionNums: number[];
    /** part 2: why the participant thinks they made this move */
    rationale: string;
    /** the prompt that actually produced the next chart; never shown in the step */
    actualPrompt: string;
    promptSource: PromptSource;
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
 * Which moves to ask about. Random for now — see the module note — but never
 * two moves that share a chart: item A's context ("before that #8, you were
 * here #9") would otherwise hand over item B's answer, since B asks what
 * followed #8. Items therefore stand on DISJOINT stretches of the analysis.
 *
 * A transition is a ground-truth lineage edge: `from` led to `to`.
 */
export const sampleTransitions = (
    edges: { from: string; to: string }[],
    count: number,
    rnd: () => number,
    parentOf: (chartId: string) => string | null,
): { from: string; to: string }[] => {
    const picked: { from: string; to: string }[] = [];
    const used = new Set<string>();
    for (const edge of shuffle(edges, rnd)) {
        if (picked.length >= count) break;
        // the three charts this item would put on screen as its own trace
        const shown = [edge.from, edge.to, parentOf(edge.from)].filter(Boolean) as string[];
        if (shown.some(id => used.has(id))) continue;
        picked.push(edge);
        for (const id of shown) used.add(id);
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

/**
 * Build the items from trace material already loaded for part 4 (the same
 * charts, renders and lineage the tree form is scored against).
 */
export function buildProvenanceMaterial(
    material: TraceMaterial,
    opts: { count?: number; seed?: number } = {},
): ProvenanceMaterial {
    const { count = DEFAULT_ITEM_COUNT, seed = DEFAULT_PROVENANCE_SEED } = opts;
    const rnd = makeRng(seed);
    const byId = new Map(material.charts.map(c => [c.chartId, c]));

    const parentOf = (chartId: string) => byId.get(chartId)?.parentChartId ?? null;

    const items: ProvenanceItem[] = [];
    for (const edge of sampleTransitions(material.edges, count, rnd, parentOf)) {
        const from = byId.get(edge.from);
        const answer = byId.get(edge.to);
        if (!from || !answer) continue;

        // Neither the chart being stood on nor the one before it can be an
        // option: "you made this next" would be answerable by elimination.
        const previous = from.parentChartId ? byId.get(from.parentChartId) ?? null : null;
        const exclude = new Set([from.chartId, answer.chartId, previous?.chartId].filter(Boolean) as string[]);
        const lures = pickDistractors(material.charts, exclude, OPTIONS_PER_ITEM - 1, rnd);
        // A two-option item is a coin flip; drop it rather than weaken the run.
        if (lures.length < OPTIONS_PER_ITEM - 1) continue;

        items.push({
            id: `prov-${from.chartId}-${answer.chartId}`,
            previous,
            from,
            options: shuffle([answer, ...lures], rnd),
            answerChartId: answer.chartId,
        });
    }

    return { sessionId: material.sessionId, items, transitionsAvailable: material.edges.length };
}

/** Score a finished run: part 1 is right or wrong, part 2 is read offline. */
export function buildProvenanceAnswer(responses: ProvenanceResponse[], seconds: number): ProvenanceAnswer {
    return {
        form: 'provenance',
        seconds,
        responses,
        score: { correct: responses.filter(r => r.correct).length, total: responses.length },
    };
}
