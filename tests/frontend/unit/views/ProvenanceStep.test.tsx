// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProvenanceStep } from '../../../../src/views/ProvenanceStep';
import { ProvenanceMaterial } from '../../../../src/app/provenanceQuiz';
import { TraceChart } from '../../../../src/app/reasoningTrace';

// The step is translated; render the default copy so assertions read as the
// participant sees them.
vi.mock('react-i18next', () => ({
    initReactI18next: { type: '3rdParty', init: () => {} },
    useTranslation: () => ({
        t: (_key: string, params?: Record<string, any>) => params?.defaultValue ?? _key,
    }),
}));

const chart = (id: string, num: number): TraceChart => ({
    chartId: id, num, title: `chart ${id}`, chartType: 'bar', tableId: `t-${id}`,
    svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', parentChartId: null,
    actualPrompt: `prompt ${id}`, promptSource: 'user', inReport: false,
});

const material = (): ProvenanceMaterial => ({
    sessionId: 's1',
    transitionsAvailable: 3,
    items: [{
        id: 'item-1',
        previous: chart('a', 1),
        from: chart('b', 2),
        options: [chart('c', 3), chart('d', 4), chart('e', 5)],
        answerChartId: 'c',
        touchesReport: false,
    }],
});

describe('ProvenanceStep', () => {
    it('asks for the next chart, then commits the pick with one confirm', () => {
        const onDone = vi.fn();
        render(<ProvenanceStep material={material()} onDone={onDone} />);

        // The context is shown and the question is a forced choice.
        expect(screen.getByText('you were here')).toBeInTheDocument();
        expect(screen.getByText('before that')).toBeInTheDocument();
        expect(screen.getByText('Which chart did you make next?')).toBeInTheDocument();
        const confirm = screen.getByRole('button', { name: 'Confirm' });
        expect(confirm).toBeDisabled();

        // ONE confirm commits the pick and ends the run — the participant is
        // told nothing, as in part 4.
        fireEvent.click(screen.getByText('chart d'));
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);
        expect(screen.queryByText(/outlined in green/)).not.toBeInTheDocument();
        expect(screen.queryByText(/that is the chart you made next/i)).not.toBeInTheDocument();

        expect(onDone).toHaveBeenCalledTimes(1);
        const answer = onDone.mock.calls[0][0];
        expect(answer.form).toBe('provenance');
        expect(answer.score).toEqual({ correct: 0, total: 1 });
        expect(answer.responses[0]).toMatchObject({
            fromChartId: 'b', answerChartId: 'c', pickedChartId: 'd', correct: false,
            // the sampling bucket travels with the response for offline analysis
            touchesReport: false,
            // ground truth for the offline comparison — the prompt of the REAL
            // next chart, not of the one the participant picked
            actualPrompt: 'prompt c',
        });
        expect(answer.responses[0].optionNums.sort()).toEqual([3, 4, 5]);
    });

    it('scores a right pick as remembered', () => {
        const onDone = vi.fn();
        render(<ProvenanceStep material={material()} onDone={onDone} />);
        fireEvent.click(screen.getByText('chart c'));
        fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
        expect(onDone.mock.calls[0][0].score).toEqual({ correct: 1, total: 1 });
    });

    it('keeps the true next chart for the researcher\'s eye only', () => {
        render(<ProvenanceStep material={material()} onDone={vi.fn()} />);

        // Nothing marks the answer until the toggle is pressed.
        const eye = screen.getByRole('button', { name: 'Show the chart that came next' });
        const answerCard = () => screen.getByText('chart c').closest('button')!;
        expect(answerCard()).not.toHaveStyle({ borderColor: 'rgb(46, 125, 50)' });

        fireEvent.click(eye);
        expect(screen.getByRole('button', { name: 'Hide the chart that came next' })).toBeInTheDocument();
        expect(answerCard()).toHaveStyle({ borderColor: 'rgb(46, 125, 50)' });
    });
});
