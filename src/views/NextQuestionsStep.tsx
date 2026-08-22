// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * NextQuestionsStep — the quiz's first part: three questions the participant
 * would ask next of this dataset.
 *
 * It comes FIRST on purpose. Every later part shows charts from the session
 * back to the participant, which would seed what they say they want to explore
 * next. Asked before any of that, the three answers are their own.
 *
 * The dataset itself is not a chart, so the part opens on the same table the
 * recall parts show — the participant asks of the data in front of them,
 * exactly as parts 2 and 3 do, and nothing they MADE is on the page.
 *
 * Free text, so nothing here is scored — the answers are read offline, next to
 * the analysis the session actually produced.
 */

import { FC } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { DictTable } from '../components/ComponentType';
import { RecallDataPreview } from './RecallDataPreview';

/** How many boxes the step offers. */
export const NEXT_QUESTION_SLOTS = 3;

export const NextQuestionsStep: FC<{
    questions: string[];
    onChange: (questions: string[]) => void;
    onContinue: () => void;
    /** the session's own table, shown on top as in parts 2 and 3.  Absent
     *  while it loads, and when it could not be read — the part carries no
     *  note for either case, because the questions never depend on it. */
    table?: DictTable;
    wide?: boolean;
}> = ({ questions, onChange, onContinue, table, wide = true }) => {
    const { t } = useTranslation();
    const setAt = (i: number, value: string) => {
        const next = [...questions];
        next[i] = value;
        onChange(next);
    };
    // At least one question, so continuing is never a way to skip the part by
    // accident. The other two stay optional — a forced third question invites
    // padding, and an empty slot is itself a finding.
    const ready = questions.some(q => q.trim().length > 0);

    return (
        // The table spans the panel, as it does in parts 2 and 3.  Under it,
        // one column down the middle of the page: nothing there competes for
        // the width, and three boxes pinned to the left edge of a wide panel
        // read as a form rather than as a question.
        <Box sx={{ p: wide ? 3 : 1.5 }}>
            {/* The data, in the canvas's own grid — the same view parts 2 and
                3 open on, at the same height. */}
            <RecallDataPreview table={table} height={wide ? 260 : 190} />

            <Box sx={{ maxWidth: 720, mx: 'auto' }}>
                <Typography sx={{ fontSize: 15, fontWeight: 600, mb: 3, textAlign: 'center' }}>
                    {t('quiz.askPrompt', { defaultValue:
                        'Give the next three questions you would ask to further explore this dataset.' })}
                </Typography>

                {/* Each slot is titled above its box, and the slots stand well
                    apart: three questions, not one three-line answer. */}
                {Array.from({ length: NEXT_QUESTION_SLOTS }, (_, i) => (
                    <Box key={i} sx={{ mb: 3.5 }}>
                        <Typography sx={{ fontSize: 13.5, fontWeight: 600, color: 'text.secondary', mb: 0.75 }}>
                            {t('quiz.askSlot', { n: i + 1, defaultValue: `Question ${i + 1}` })}
                        </Typography>
                        <TextField
                            fullWidth multiline minRows={2} size="small"
                            autoFocus={i === 0}
                            value={questions[i] ?? ''}
                            onChange={e => setAt(i, e.target.value)}
                            sx={{ '& .MuiInputBase-root': { fontSize: 13.5 } }}
                        />
                    </Box>
                ))}

                <Button variant="contained" disabled={!ready} onClick={onContinue}
                    sx={{ fontSize: 13, textTransform: 'none', px: 2.5 }}>
                    {t('quiz.confirm', { defaultValue: 'Confirm' })}
                </Button>
            </Box>
        </Box>
    );
};
