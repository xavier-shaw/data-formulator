// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * FieldRecallStep — part 1 of the memory quiz.
 *
 * "Which attributes do you remember exploring?" The participant sees the data
 * they started from and clicks the attributes they used. Selection is the ONLY
 * way to answer: there is no search box and nothing can be typed, so the answer
 * is always a subset of the columns offered, and every participant reports the
 * same vocabulary in the same words.
 *
 * One flat set here, deliberately: grouping those attributes into the
 * combinations they charted is its own part (`ComboRecallStep`), asked next.
 * Doing both jobs on one screen made a step heavier to explain than either
 * question is alone, and the flat set is what part 2 then builds on.
 *
 * The data preview is `RecallDataPreview` — the canvas's own grid, shared with
 * part 2 so both recall parts show the table the same way.
 *
 * Nothing here scores or reveals anything: the correct attributes are the
 * answer to the chart questions that follow, so the result only appears on the
 * quiz's results screen.
 */

import { FC } from 'react';
import { Box, Button, Chip, Typography, alpha, useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { RecallMaterial } from '../app/fieldRecall';
import { RecallDataPreview } from './RecallDataPreview';
import { borderColor, radius } from '../app/tokens';

const mono = { fontFamily: 'ui-monospace, Menlo, monospace' };

/**
 * One attribute button — shared with part 2, which asks over the same palette
 * and must offer the same target.
 *
 * Sized to be read and clicked rather than to be compact: these carry names
 * like `PHASE_OF_FLIGHT`, and they are now the ONLY control on either step.
 * `restingBg`/`restingText` are part 2's accent for the attributes named in
 * part 1; the border stays black in every resting state, because telling one
 * button from the next matters more than telling the two lists apart.
 */
export const attributeChipSx = (opts: {
    /** the accent a picked (or hovered) button takes */
    color: string;
    picked: boolean;
    restingBg?: string;
    restingText?: string;
}) => ({
    // The palettes lay these out in a grid, so a button fills its cell: every
    // attribute gets the same target, whatever its name is worth in pixels.
    width: '100%',
    justifyContent: 'flex-start',
    height: 30,
    fontSize: 12,
    ...mono,
    borderRadius: radius.sm,
    background: opts.picked ? alpha(opts.color, 0.16) : opts.restingBg ?? '#fff',
    // Black rather than the panel's hairline grey: the buttons sit shoulder to
    // shoulder in a dense wrapped list, and a 12%-opacity edge left it unclear
    // where one attribute ended and the next began.
    border: `1px solid ${opts.picked ? opts.color : borderColor.strong}`,
    color: opts.picked ? opts.color : opts.restingText ?? 'text.primary',
    fontWeight: opts.picked ? 600 : 400,
    transition: 'background-color .1s, border-color .1s',
    '&:hover': {
        background: alpha(opts.color, opts.picked ? 0.24 : 0.08),
        borderColor: opts.color,
    },
});

/**
 * The attribute palette's layout: a FIXED number of buttons per row rather
 * than a wrapped list. Names like `PHASE_OF_FLIGHT` used to pack a row
 * shoulder to shoulder while the next row held two; a grid gives every
 * attribute the same target and keeps the rows apart.
 */
export const paletteGridSx = (wide: boolean) => ({
    display: 'grid',
    gridTemplateColumns: `repeat(${wide ? 4 : 2}, minmax(0, 1fr))`,
    columnGap: 1.5,
    rowGap: 1.5,
});

interface FieldRecallStepProps {
    material: RecallMaterial;
    /** the attributes named so far, in the order they were added */
    fields: string[];
    onChange: (fields: string[]) => void;
    /** Move on to the chart questions. Disabled while they are still generating. */
    onContinue: () => void;
    continueDisabled?: boolean;
    /** narrow layouts get a shorter table */
    wide?: boolean;
}

export const FieldRecallStep: FC<FieldRecallStepProps> = ({
    material, fields, onChange, onContinue, continueDisabled, wide = true,
}) => {
    const { t } = useTranslation();
    const theme = useTheme();

    const chosen = new Set(fields);

    const toggle = (name: string) =>
        onChange(chosen.has(name) ? fields.filter(f => f !== name) : [...fields, name]);

    return (
        <Box sx={{ p: 1.5 }}>
            {/* Just the question — the how-to lives on the quiz's intro tab. */}
            <Typography sx={{ fontSize: 18, fontWeight: 700, mb: 2 }}>
                {t('quiz.recallTitle', { defaultValue: 'Which attributes do you remember exploring?' })}
            </Typography>

            {/* The data, in the canvas's own grid. */}
            <RecallDataPreview
                table={material.table}
                height={wide ? 260 : 190}
                emptyNote={t('quiz.recallNoTable', { defaultValue: 'The data table for this session could not be read, so only the attribute names are shown.' })}
            />

            {/* What has been named so far. */}
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center', mt: 2.5, minHeight: 27 }}>
                <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mr: 0.5 }}>
                    {t('quiz.recallChosen', { count: fields.length, defaultValue: `Your attributes (${fields.length}):` })}
                </Typography>
                {fields.length === 0
                    ? (
                        <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
                            {t('quiz.recallNoneYet', { defaultValue: 'none yet — click one below' })}
                        </Typography>
                    )
                    : fields.map(name => (
                        <Chip
                            key={name} size="small" label={name}
                            onDelete={() => onChange(fields.filter(f => f !== name))}
                            sx={{ height: 24, fontSize: 11.5, ...mono }}
                        />
                    ))}
            </Box>

            {/* Every column, click to add or remove — a fixed count per row, so
                the list reads as rows of equal buttons rather than a packed
                block of text. */}
            <Box sx={{ ...paletteGridSx(wide), mt: 2 }}>
                {material.fields.map(name => (
                    <Chip
                        key={name} size="small" clickable onClick={() => toggle(name)}
                        label={name}
                        sx={attributeChipSx({ color: theme.palette.primary.main, picked: chosen.has(name) })}
                    />
                ))}
            </Box>

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 2.5 }}>
                <Button variant="contained" onClick={onContinue} disabled={continueDisabled}
                    sx={{ fontSize: 13, textTransform: 'none', px: 2.5 }}>
                    {t('quiz.confirm', { defaultValue: 'Confirm' })}
                </Button>
            </Box>
        </Box>
    );
};
