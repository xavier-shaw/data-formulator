// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ComboRecallStep — part 2 of the memory quiz.
 *
 * "Which attributes did you look at together?" Part 1 asked for a flat set;
 * this one asks for the structure over it — one group per combination the
 * participant remembers charting.
 *
 * The palette leads with what they named in part 1, in its own colour, and the
 * rest of the columns follow. Both are offered on purpose: leading with their
 * own answer makes the grouping a continuation of the recall they just did,
 * while keeping the full table means a combination they only remember once the
 * pairs are in front of them is still reachable.
 *
 * Selection is the ONLY way to answer here too — no search box, nothing typed
 * — so a group is always a set of real column names.
 *
 * It reads the LIVE part-1 selection, not the frozen answer, so the step works
 * whether it is reached by the continue button or by jumping straight to the
 * tab (in which case the palette is simply unaccented).
 *
 * Nothing here is scored or revealed — the combinations are the answer to the
 * chart questions that follow, so the result appears only on the results tab.
 */

import { FC, useMemo, useState } from 'react';
import { Box, Button, Chip, IconButton, Tooltip, Typography, alpha, useTheme } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useTranslation } from 'react-i18next';
import { ComboGroup, RecallMaterial, loose } from '../app/fieldRecall';
import { RecallDataPreview } from './RecallDataPreview';
// Part 2 offers the same buttons as part 1 over the same palette, so it takes
// part 1's own button style rather than a lookalike.
import { attributeChipSx } from './FieldRecallStep';
import { borderColor, radius } from '../app/tokens';

const mono = { fontFamily: 'ui-monospace, Menlo, monospace' };

/** Two names mean the same attribute — the scorer's own rule, so what reads as
 *  one chip here is what is compared there. */
const same = (a: string, b: string) => loose(a) === loose(b);

interface ComboRecallStepProps {
    material: RecallMaterial;
    /** what part 1 named, live — shown first in the palette, in its own colour */
    recalled: string[];
    /** the combinations built so far, in the order they were made */
    groups: ComboGroup[];
    onChange: (groups: ComboGroup[]) => void;
    onContinue: () => void;
    /** narrow layouts get a shorter table */
    wide?: boolean;
}

export const ComboRecallStep: FC<ComboRecallStepProps> = ({
    material, recalled, groups: given, onChange, onContinue, wide = true,
}) => {
    const { t } = useTranslation();
    const theme = useTheme();
    /** which combination the palette clicks land in */
    const [active, setActive] = useState(0);

    // There is always one group on screen to click into. It only becomes a real
    // answer once something is put in it, so an untouched step reports nothing.
    const groups = given.length ? given : [[]];
    const activeIndex = Math.min(active, groups.length - 1);
    const activeGroup = groups[activeIndex] ?? [];

    /** Colour of the "you named this in part 1" accent. */
    const accent = theme.palette.secondary.main;

    // Their part-1 attributes first, then everything else they could still use.
    // A part-1 name that is not a column of the table (a derived concept they
    // typed) belongs in the first list, which is why this is not a filter over
    // `material.fields`.
    const [mine, rest] = useMemo(() => {
        const named = recalled.filter(Boolean);
        return [
            named,
            material.fields.filter(f => !named.some(n => same(n, f))),
        ];
    }, [recalled, material.fields]);

    const writeGroup = (index: number, fields: string[]) => {
        const next = groups.map((g, i) => (i === index ? fields : g));
        onChange(next);
    };

    /** Palette click: put the attribute in the active combination, or take it out. */
    const toggle = (name: string) => {
        const inGroup = activeGroup.some(f => same(f, name));
        writeGroup(activeIndex, inGroup ? activeGroup.filter(f => !same(f, name)) : [...activeGroup, name]);
    };

    const addGroup = () => {
        onChange([...groups, []]);
        setActive(groups.length);
    };

    const removeGroup = (index: number) => {
        const next = groups.filter((_, i) => i !== index);
        onChange(next);
        setActive(a => (a >= next.length ? Math.max(0, next.length - 1) : a));
    };

    /** One palette chip. `own` = named in part 1, which only tints it. */
    const paletteChip = (name: string, own: boolean) => (
        <Chip
            key={name} size="small" clickable onClick={() => toggle(name)}
            label={name}
            sx={attributeChipSx({
                color: own ? accent : theme.palette.primary.main,
                picked: activeGroup.some(f => same(f, name)),
                restingBg: own ? alpha(accent, 0.05) : undefined,
                restingText: own ? accent : undefined,
            })}
        />
    );

    return (
        <Box sx={{ p: 1.5 }}>
            <Typography sx={{ fontSize: 15, fontWeight: 600 }}>
                {t('quiz.comboTitle', { defaultValue: 'Which attributes did you look at together?' })}
            </Typography>
            <Typography sx={{ fontSize: 12.5, color: 'text.secondary', maxWidth: 820, mb: 1.5 }}>
                {t('quiz.comboIntro', {
                    defaultValue: 'Make one group for each combination of attributes you remember charting together. Click a combination to make it the one you are filling, then click the attributes that went into it. The attributes you named a moment ago come first.',
                })}
            </Typography>

            {/* The same data, in the same grid as part 1. */}
            <RecallDataPreview
                table={material.table}
                height={wide ? 200 : 160}
                emptyNote={t('quiz.recallNoTable', { defaultValue: 'The data table for this session could not be read, so only the attribute names are shown.' })}
            />

            {/* The answer: one card per combination, the active one outlined. */}
            <Box sx={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: 1, mb: 1.5 }}>
                {groups.map((group, i) => {
                    const isActive = i === activeIndex;
                    return (
                        <Box
                            key={i} onClick={() => setActive(i)}
                            sx={{ p: 1, cursor: 'pointer', background: '#fff', borderRadius: radius.sm,
                                  border: `2px solid ${isActive ? theme.palette.primary.main : borderColor.view}`,
                                  boxShadow: isActive ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.12)}` : 'none',
                                  transition: 'border-color .12s, box-shadow .12s' }}
                        >
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
                                <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: isActive ? 'primary.main' : 'text.secondary', flex: 1 }}>
                                    {t('quiz.comboGroupN', { n: i + 1, defaultValue: `Combination ${i + 1}` })}
                                    {isActive && (
                                        <Typography component="span" sx={{ fontSize: 10.5, color: 'text.disabled', ml: 0.75, fontWeight: 400 }}>
                                            {t('quiz.comboFilling', { defaultValue: 'clicks land here' })}
                                        </Typography>
                                    )}
                                </Typography>
                                {groups.length > 1 && (
                                    <Tooltip title={t('quiz.comboRemove', { defaultValue: 'Remove this combination' })}>
                                        <IconButton size="small" sx={{ p: 0.25 }}
                                            onClick={e => { e.stopPropagation(); removeGroup(i); }}>
                                            <DeleteOutlineIcon sx={{ fontSize: 15, color: 'text.disabled' }} />
                                        </IconButton>
                                    </Tooltip>
                                )}
                            </Box>
                            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, minHeight: 24 }}>
                                {group.length === 0
                                    ? (
                                        <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
                                            {isActive
                                                ? t('quiz.comboEmptyActive', { defaultValue: 'empty — click the attributes below' })
                                                : t('quiz.comboEmpty', { defaultValue: 'empty' })}
                                        </Typography>
                                    )
                                    : group.map(name => (
                                        <Chip
                                            key={name} size="small" label={name}
                                            onDelete={() => writeGroup(i, group.filter(f => !same(f, name)))}
                                            sx={{ height: 24, fontSize: 11.5, ...mono }}
                                        />
                                    ))}
                            </Box>
                        </Box>
                    );
                })}
            </Box>

            <Button size="small" startIcon={<AddIcon sx={{ fontSize: 16 }} />} onClick={addGroup}
                // A second empty card teaches nothing; fill this one first.
                disabled={activeGroup.length === 0}
                sx={{ fontSize: 12, textTransform: 'none', mb: 1.5 }}>
                {t('quiz.comboAdd', { defaultValue: 'Add another combination' })}
            </Button>

            {/* The palette: their own attributes first, then the rest. */}
            {mine.length > 0 && (
                <Box sx={{ mt: 1.5 }}>
                    <Typography sx={{ fontSize: 11, color: accent, mb: 0.5 }}>
                        {t('quiz.comboMine', { count: mine.length, defaultValue: `The attributes you named (${mine.length})` })}
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                        {mine.map(name => paletteChip(name, true))}
                    </Box>
                </Box>
            )}
            {rest.length > 0 && (
                <Box sx={{ mt: 1.5 }}>
                    <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 0.5 }}>
                        {mine.length > 0
                            ? t('quiz.comboRest', { defaultValue: 'The rest of the columns' })
                            : t('quiz.comboAll', { defaultValue: 'The columns of your data' })}
                    </Typography>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                        {rest.map(name => paletteChip(name, false))}
                    </Box>
                </Box>
            )}

            <Box sx={{ mt: 2.5 }}>
                <Button size="small" variant="contained" onClick={onContinue} sx={{ fontSize: 12, textTransform: 'none' }}>
                    {t('quiz.comboContinue', { defaultValue: 'Done — continue to the charts' })}
                </Button>
            </Box>
        </Box>
    );
};
