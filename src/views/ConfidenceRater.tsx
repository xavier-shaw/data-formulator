// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ConfidenceRater — a 0-100 "how sure are you?" scale.
 *
 * ONE component for both quiz parts that ask it (chart recognition and the
 * path form), because the two ratings are compared with each other: the same
 * range, the same anchors, the same wording. It sits below the chart choice
 * and shares its row with the button that commits the answer, and it must be
 * answered BEFORE the answer is revealed — every caller freezes it
 * (`disabled`) at the reveal.
 *
 * The value itself is never shown. It is recorded in full (0-100), but a
 * readout turns a felt rating into a number the participant argues with.
 *
 * The scale starts at 50 and the confirm button never waits for it: a
 * participant whose true answer is 50 could click the thumb without moving it,
 * and a gate would then trap them. `onTouch` fires on the first interaction
 * instead, so a run can tell "said 50" from "never touched it".
 */

import { FC, ReactNode } from 'react';
import { Box, Slider, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';

/** Where the scale starts — the midpoint, so it favours neither anchor. */
export const CONFIDENCE_DEFAULT = 50;

export const ConfidenceRater: FC<{
    value: number;
    onChange: (value: number) => void;
    /** first interaction, whether or not the value moved */
    onTouch?: () => void;
    disabled?: boolean;
    /** the part's confirm button, placed at the right end of the same row */
    action?: ReactNode;
}> = ({ value, onChange, onTouch, disabled, action }) => {
    const { t } = useTranslation();
    return (
        // The rating and the button that commits it share ONE row: the rating
        // is part of the answer, not a step before it. The button holds the
        // right end, the scale takes everything else.
        <Box sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
                   gap: 3, mb: 1.5, flexWrap: 'wrap' }}>
            {/* The scale keeps a floor width, so in the narrow docked column the
                button wraps to its own line instead of squeezing the slider. */}
            <Box sx={{ flex: '1 1 260px', minWidth: 0, opacity: disabled ? 0.6 : 1 }}
                onPointerDown={disabled ? undefined : onTouch}>
                <Typography sx={{ fontSize: 15, fontWeight: 600, color: 'text.primary', mb: 0.5 }}>
                    {t('quiz.confidencePrompt', { defaultValue: 'How sure are you of this answer?' })}
                </Typography>
                {/* The anchors head the two ends of the scale. The number is
                    deliberately not shown — it is recorded, not asked for, and
                    a visible readout invites a numeric answer instead of a
                    felt one. */}
                <Box sx={{ display: 'flex', justifyContent: 'space-between', px: 0.5 }}>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                        {t('quiz.confidenceLow', { defaultValue: 'very unsure' })}
                    </Typography>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                        {t('quiz.confidenceHigh', { defaultValue: 'very sure' })}
                    </Typography>
                </Box>
                <Slider
                    min={0} max={100} step={1}
                    value={value} disabled={disabled}
                    valueLabelDisplay="off"
                    onChange={(_, v) => onChange(v as number)}
                    sx={{
                        width: '100%', py: 1,
                        '& .MuiSlider-rail, & .MuiSlider-track': { height: 6 },
                        '& .MuiSlider-thumb': { width: 20, height: 20 },
                    }}
                />
            </Box>
            {action && <Box sx={{ flexShrink: 0, pb: 0.5 }}>{action}</Box>}
        </Box>
    );
};
