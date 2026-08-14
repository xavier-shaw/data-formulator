// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * fieldRecall — the first two parts of the memory quiz, both asked over the
 * same material:
 *
 *   part 1 — which attributes do you remember exploring?  (a flat set)
 *   part 2 — which of them did you look at TOGETHER?      (groups)
 *
 * They run before the chart-recognition questions because they ask about the
 * analysis rather than the pictures: a participant can remember working on
 * budget and rating without remembering which of four bar charts they drew.
 * Asking them first also keeps the chart options from teaching the field
 * vocabulary they are about to be scored on.
 *
 * The two are separate parts rather than one screen with two jobs. Naming
 * attributes and grouping them are different recalls — the second is answered
 * with the first already on the table — and folding them together made a single
 * step that was heavier to explain than either question is on its own.
 *
 * This module is the pure half — session → recall material, answer → score.
 * The UI lives in `src/views/FieldRecallStep.tsx` (part 1) and
 * `src/views/ComboRecallStep.tsx` (part 2).
 */

import { DictTable } from '../components/ComponentType';
import { extractSession } from '../lib/quiz-distractors';

/** What one chart encoded — the ground truth an answer is scored against. */
export interface ChartTruth {
    id: string;
    title: string;
    fields: string[];
}

export interface RecallMaterial {
    /**
     * The table the participant started from, passed whole so the step can show
     * it in the canvas's own data grid rather than a lookalike.
     */
    table?: DictTable;
    /**
     * The palette: the source table's columns, and only those. Concepts the
     * participant created during the analysis are deliberately NOT offered —
     * listing them would hand back the very derivations the steps ask about.
     *
     * Both steps answer by selection, so this is now the WHOLE answer space: a
     * derived attribute cannot be reported at all, and every chart that
     * encoded one scores as a miss. See `readRecallMaterial`.
     */
    fields: string[];
    charts: ChartTruth[];
}

/**
 * The source table: the largest non-derived one. Same rule the distractor
 * pipeline uses (`extract.ts`), so the step shows the data the participant
 * started from rather than whichever table the agent produced last.
 */
export function pickSourceTable(tables: DictTable[]): DictTable | undefined {
    const original = tables.filter(t => !t.derive);
    const pool = original.length > 0 ? original : tables;
    return pool.slice().sort((a, b) => (b.rows?.length ?? 0) - (a.rows?.length ?? 0))[0];
}

function chartTruth(chart: any): ChartTruth {
    const enc = chart.spec.encodings as Record<string, { field: string }>;
    return {
        id: chart.id,
        title: chart.title,
        fields: Array.from(new Set(Object.values(enc).map(e => e.field).filter(Boolean))),
    };
}

/**
 * Read the recall material out of a session state (the shape `extractSession`
 * takes: charts / tables / conceptShelfItems / chartUsage).
 *
 * The palette is the source table's columns only. Since the steps no longer
 * accept typed names, a concept the participant built (`profit`,
 * `strike_count`) is unreportable: it counts as a miss in part 1, and every
 * combination containing one is unreachable in part 2. That is a deliberate
 * floor on what these two parts can measure — the charts a participant made
 * over derived fields are still asked about in part 3.
 */
export function readRecallMaterial(state: any): RecallMaterial {
    const tables: DictTable[] = state?.tables ?? [];
    const table = pickSourceTable(tables);
    const fields: string[] = table
        ? (table.names?.length ? table.names : Object.keys(table.metadata ?? {}))
        : [];
    return { table, fields, charts: extractSession(state).charts.map(chartTruth) };
}

// ── scoring ──────────────────────────────────────────────────────────────

export interface RecallScore {
    /** attributes named that a chart really encoded */
    fieldHits: string[];
    /** attributes a chart encoded that were never named */
    fieldMisses: string[];
    /** attributes named that no chart ever encoded */
    fieldIntrusions: string[];
}

const without = (a: Set<string>, b: Set<string>) => [...a].filter(x => !b.has(x)).sort();
const shared = (a: Set<string>, b: Set<string>) => [...a].filter(x => b.has(x)).sort();

/**
 * Loose key for one attribute: letters and digits only, so `strike_count`,
 * `Strike Count` and `strikecount` are one field.
 *
 * Both steps answer by selection now, so the names they report are already the
 * palette's own spellings — this exists for the join between the palette and
 * what a chart encoded, where the two can differ in case or separator.
 */
export const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Map each named attribute onto the real field it means, where one exists, so
 * a palette spelling and a chart's encoding of the same column compare equal.
 */
function canonicalizer(charts: ChartTruth[], palette: string[]) {
    const byLoose = new Map<string, string>();
    for (const name of [...palette, ...charts.flatMap(c => c.fields)]) {
        if (name && !byLoose.has(loose(name))) byLoose.set(loose(name), name);
    }
    return (name: string) => byLoose.get(loose(name)) ?? name.trim();
}

/** Score the named attributes against what the session's charts encoded. */
export function scoreRecall(named: string[], charts: ChartTruth[], palette: string[] = []): RecallScore {
    const canon = canonicalizer(charts, palette);
    const namedSet = new Set(named.map(canon).filter(Boolean));
    // BOTH sides go through the canonicaliser: a chart can encode a column
    // under a different casing or separator than the palette offers it, and an
    // attribute must not be a miss because the two disagree on punctuation.
    const truthFields = new Set(charts.flatMap(c => c.fields).map(canon));
    return {
        fieldHits: shared(namedSet, truthFields),
        fieldMisses: without(truthFields, namedSet),
        fieldIntrusions: without(namedSet, truthFields),
    };
}

// ── combinations (part 2) ────────────────────────────────────────────────

/** One combination: the attributes a participant says they looked at together. */
export type ComboGroup = string[];

/** A group that came close to a real combination without matching it. */
export interface ComboMatch {
    /** the group, canonicalised and sorted */
    group: string[];
    /** the charted combination it came closest to */
    closest: string[];
    /** shared / union against `closest`, 0–1 — how near the miss was */
    overlap: number;
}

export interface ComboScore {
    /** charted combinations named exactly */
    hits: string[][];
    /** groups that overlap a charted combination without matching it */
    partial: ComboMatch[];
    /** charted combinations never named exactly */
    misses: string[][];
    /** groups sharing no attribute with anything that was charted */
    intrusions: string[][];
}

const key = (fields: string[]) => fields.join('|');

/**
 * The distinct field sets the session's charts encoded — the answer part 2 is
 * scored against.
 *
 * Deduplicated on purpose. A session normally holds several charts over the
 * same attributes (three cuts of "damage by phase"), and one entry per chart
 * would both inflate the misses and make full marks unreachable for a
 * participant who names each combination once. A single-attribute chart is not
 * a combination, so it is left out.
 */
export function truthCombos(charts: ChartTruth[]): string[][] {
    const out = new Map<string, string[]>();
    for (const c of charts) {
        const set = [...new Set(c.fields)].sort();
        if (set.length < 2) continue;
        if (!out.has(key(set))) out.set(key(set), set);
    }
    return [...out.values()];
}

/**
 * Score the reported combinations against the ones the charts really encoded.
 *
 * Names inside a group go through the same canonicaliser as part 1, so a typed
 * derived attribute ("strike count") joins its real field before any set is
 * compared. Groups of fewer than two attributes are not combinations and are
 * left out of the scoring; they are still kept verbatim in the answer file.
 */
export function scoreCombos(groups: ComboGroup[], charts: ChartTruth[], palette: string[] = []): ComboScore {
    const canon = canonicalizer(charts, palette);
    // Canonicalise the truth as well as the answer, then dedupe again — mapping
    // two spellings onto one field can merge two combinations into one.
    const byKey = new Map<string, string[]>();
    for (const combo of truthCombos(charts)) {
        const set = [...new Set(combo.map(canon))].sort();
        if (set.length >= 2 && !byKey.has(key(set))) byKey.set(key(set), set);
    }
    const truth = [...byKey.values()];
    const truthKeys = new Set(truth.map(key));
    // A set, so two groups naming the SAME combination count once — the hits
    // are the combinations recalled, not the groups that named one.
    const matched = new Set<string>();
    const partial: ComboMatch[] = [];
    const intrusions: string[][] = [];

    for (const raw of groups) {
        const group = [...new Set(raw.map(canon).filter(Boolean))].sort();
        if (group.length < 2) continue;
        if (truthKeys.has(key(group))) { matched.add(key(group)); continue; }
        // Not exact: report the nearest real combination, which is what says
        // HOW it was misremembered (one attribute short, two merged, …).
        let best: ComboMatch | null = null;
        for (const t of truth) {
            const shared = group.filter(f => t.includes(f)).length;
            if (!shared) continue;
            const overlap = shared / new Set([...group, ...t]).size;
            if (!best || overlap > best.overlap) best = { group, closest: t, overlap };
        }
        if (best) partial.push({ ...best, overlap: Math.round(best.overlap * 100) / 100 });
        else intrusions.push(group);
    }

    return {
        hits: truth.filter(t => matched.has(key(t))),
        partial,
        misses: truth.filter(t => !matched.has(key(t))),
        intrusions,
    };
}

/** What gets written into the downloaded answers for part 2. */
export interface ComboAnswer {
    /** the groups exactly as they were built, unmodified */
    groups: ComboGroup[];
    /** seconds spent on the step */
    seconds: number;
    score: ComboScore;
}

export function buildComboAnswer(groups: ComboGroup[], material: RecallMaterial, ms: number): ComboAnswer {
    return {
        groups,
        seconds: Math.round(ms / 1000),
        score: scoreCombos(groups, material.charts, material.fields),
    };
}

/** What gets written into the downloaded answers. */
export interface RecallAnswer {
    /** exactly what was picked, in the order it was picked */
    fields: string[];
    /** seconds spent on the step */
    seconds: number;
    score: RecallScore;
}

export function buildRecallAnswer(fields: string[], material: RecallMaterial, ms: number): RecallAnswer {
    return {
        fields,
        seconds: Math.round(ms / 1000),
        score: scoreRecall(fields, material.charts, material.fields),
    };
}
