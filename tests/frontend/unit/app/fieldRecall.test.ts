// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * Scoring for the quiz's two recall parts: the attributes (part 1) and the
 * combinations over them (part 2).
 *
 * Both are answered by selection, so what a participant reports is a palette
 * spelling. The cases that matter are therefore the joins and the shape of the
 * ground truth: a palette name reaching the field a chart encoded even when the
 * two are spelled differently, a derived field nobody could pick scoring as a
 * miss, and one combination counting once however many charts drew it.
 */

import { describe, it, expect } from 'vitest';
import {
    scoreRecall, buildRecallAnswer, scoreCombos, truthCombos, buildComboAnswer,
    ChartTruth, RecallMaterial,
} from '../../../../src/app/fieldRecall';

const PALETTE = ['PHASE_OF_FLIGHT', 'DAMAGE_LEVEL', 'HEIGHT', 'SPEED'];

const CHARTS: ChartTruth[] = [
    { id: 'c1', title: 'damage by phase', fields: ['PHASE_OF_FLIGHT', 'strike_count'] },
    { id: 'c2', title: 'height vs speed', fields: ['HEIGHT', 'SPEED'] },
];

const MATERIAL = { fields: PALETTE, charts: CHARTS } as RecallMaterial;

describe('scoreRecall', () => {
    it('joins a palette name to the field a chart encoded across spelling', () => {
        // The palette spells it `PHASE_OF_FLIGHT`; a chart may carry any casing
        // or separator for the same column.
        const score = scoreRecall(['PHASE_OF_FLIGHT'], [
            { id: 'c1', title: 'damage by phase', fields: ['phase of flight'] },
        ], PALETTE);
        expect(score.fieldHits).toEqual(['PHASE_OF_FLIGHT']);
        expect(score.fieldIntrusions).toEqual([]);
    });

    it('counts a picked attribute no chart used as an intrusion', () => {
        const score = scoreRecall(['HEIGHT', 'DAMAGE_LEVEL'], CHARTS, PALETTE);
        expect(score.fieldHits).toEqual(['HEIGHT']);
        expect(score.fieldIntrusions).toEqual(['DAMAGE_LEVEL']);
    });

    it('reports what was never named, derived fields included', () => {
        // `strike_count` is derived, so it is not in the palette and cannot be
        // picked — it is a miss for every participant, by design.
        const score = scoreRecall(['HEIGHT', 'SPEED'], CHARTS, PALETTE);
        expect(score.fieldMisses).toEqual(['PHASE_OF_FLIGHT', 'strike_count']);
    });
});

describe('buildRecallAnswer', () => {
    it('records the picks in the order they were made', () => {
        const answer = buildRecallAnswer(['SPEED', 'HEIGHT'], MATERIAL, 12_000);
        expect(answer.fields).toEqual(['SPEED', 'HEIGHT']);
        expect(answer.seconds).toBe(12);
        expect(answer.score.fieldHits).toEqual(['HEIGHT', 'SPEED']);
    });
});

// ── part 2: the combinations ─────────────────────────────────────────────

/** Two charts over the SAME attributes — the shape a real session has. */
const VARIANTS: ChartTruth[] = [
    { id: 'c1', title: 'damage by phase', fields: ['PHASE_OF_FLIGHT', 'strike_count'] },
    { id: 'c2', title: 'damage by phase, sorted', fields: ['strike_count', 'PHASE_OF_FLIGHT'] },
    { id: 'c3', title: 'height vs speed', fields: ['HEIGHT', 'SPEED'] },
    { id: 'c4', title: 'how many strikes', fields: ['strike_count'] },
];

describe('truthCombos', () => {
    it('counts a combination once however many charts drew it, and drops single attributes', () => {
        expect(truthCombos(VARIANTS)).toEqual([
            ['PHASE_OF_FLIGHT', 'strike_count'],
            ['HEIGHT', 'SPEED'],
        ]);
    });
});

describe('scoreCombos', () => {
    it('scores a group of picked attributes against a charted combination', () => {
        const score = scoreCombos([['HEIGHT', 'SPEED']], VARIANTS, PALETTE);
        expect(score.hits).toEqual([['HEIGHT', 'SPEED']]);
        // The other combination needs `strike_count`, which is derived and so
        // cannot be picked — unreachable, and a miss for everyone.
        expect(score.misses).toEqual([['PHASE_OF_FLIGHT', 'strike_count']]);
        expect(score.partial).toEqual([]);
    });

    it('reaches full marks from one group per combination, not one per chart', () => {
        // Three charts, two distinct combinations: naming each once is full marks.
        const score = scoreCombos(
            [['PHASE_OF_FLIGHT', 'strike_count'], ['HEIGHT', 'SPEED']], VARIANTS, PALETTE);
        expect(score.hits).toHaveLength(2);
        expect(score.misses).toEqual([]);
    });

    it('reports a near miss against the combination it was reaching for', () => {
        const score = scoreCombos([['HEIGHT', 'SPEED', 'DAMAGE_LEVEL']], VARIANTS, PALETTE);
        expect(score.hits).toEqual([]);
        expect(score.partial).toEqual([{
            group: ['DAMAGE_LEVEL', 'HEIGHT', 'SPEED'],
            closest: ['HEIGHT', 'SPEED'],
            overlap: 0.67,
        }]);
    });

    it('keeps a group sharing nothing with any chart as an intrusion', () => {
        const score = scoreCombos([['DAMAGE_LEVEL', 'AC_CLASS']], VARIANTS, PALETTE);
        expect(score.intrusions).toEqual([['AC_CLASS', 'DAMAGE_LEVEL']]);
        expect(score.partial).toEqual([]);
    });

    it('leaves a group of one attribute out of the scoring', () => {
        const score = scoreCombos([['HEIGHT']], VARIANTS, PALETTE);
        expect(score.partial).toEqual([]);
        expect(score.intrusions).toEqual([]);
        expect(score.misses).toHaveLength(2);
    });
});

describe('buildComboAnswer', () => {
    it('records the groups exactly as they were built', () => {
        const material = { fields: PALETTE, charts: VARIANTS } as RecallMaterial;
        const answer = buildComboAnswer([['SPEED', 'HEIGHT']], material, 30_000);
        expect(answer.groups).toEqual([['SPEED', 'HEIGHT']]);
        expect(answer.seconds).toBe(30);
        expect(answer.score.hits).toEqual([['HEIGHT', 'SPEED']]);
    });
});
