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
    actualPrompt: `prompt ${id}`, promptSource: 'user',
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
    }],
});

describe('ProvenanceStep', () => {
    it('asks for the next chart, reveals the truth, then asks why', () => {
        const onDone = vi.fn();
        render(<ProvenanceStep material={material()} onDone={onDone} />);

        // Beat 1 — context is shown and the question is a forced choice.
        expect(screen.getByText('you were here')).toBeInTheDocument();
        expect(screen.getByText('before that')).toBeInTheDocument();
        expect(screen.getByText('Which chart did you make next?')).toBeInTheDocument();
        const confirm = screen.getByRole('button', { name: 'That is the one' });
        expect(confirm).toBeDisabled();

        // A wrong pick still reveals the real next chart …
        fireEvent.click(screen.getByText('chart d'));
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);
        expect(screen.getByText(/outlined in green/)).toBeInTheDocument();

        // … and the rationale is asked all the same, gated on some text.
        const done = screen.getByRole('button', { name: 'Done' });
        expect(done).toBeDisabled();
        fireEvent.change(screen.getByLabelText('Why did you move from one to the other?'),
            { target: { value: 'I wanted the damage split' } });
        expect(done).toBeEnabled();
        fireEvent.click(done);

        expect(onDone).toHaveBeenCalledTimes(1);
        const answer = onDone.mock.calls[0][0];
        expect(answer.form).toBe('provenance');
        expect(answer.score).toEqual({ correct: 0, total: 1 });
        expect(answer.responses[0]).toMatchObject({
            fromChartId: 'b', answerChartId: 'c', pickedChartId: 'd', correct: false,
            rationale: 'I wanted the damage split',
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
        fireEvent.click(screen.getByRole('button', { name: 'That is the one' }));
        expect(screen.getByText(/that is the chart you made next/i)).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText('Why did you move from one to the other?'),
            { target: { value: 'seasonality next' } });
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onDone.mock.calls[0][0].score).toEqual({ correct: 1, total: 1 });
    });
});
