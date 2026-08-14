// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TraceWalkthroughStep — reasoning-trace form B: narrate the thread.
 *
 * The charts are shown in the order they were made — a data thread reduced to
 * its chart nodes — and for each one the participant writes what they were
 * trying to find out and what the chart told them. Order is GIVEN here, so
 * unlike form A this does not test structural memory; it probes the rationale.
 * The prompt that actually produced each chart is stored silently next to the
 * typed recollection (never shown), so the two can be compared offline.
 */

import { FC, useRef, useState } from 'react';
import { Box, Button, TextField, Typography, alpha, useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { borderColor, radius } from '../app/tokens';
import { TraceMaterial, TraceWalkthroughAnswer } from '../app/reasoningTrace';

const svgUri = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/^<\?xml[^>]*\?>\s*/, ''))}`;

interface TraceWalkthroughStepProps {
    material: TraceMaterial;
    onDone: (answer: TraceWalkthroughAnswer) => void;
    wide?: boolean;
}

export const TraceWalkthroughStep: FC<TraceWalkthroughStepProps> = ({ material, onDone, wide = true }) => {
    const { t } = useTranslation();
    const theme = useTheme();
    const startRef = useRef(Date.now());

    // chartId → the two texts; uncontrolled-ish but kept simple in one record.
    const [texts, setTexts] = useState<Record<string, { goal: string; finding: string }>>({});
    const get = (id: string) => texts[id] ?? { goal: '', finding: '' };
    const set = (id: string, patch: Partial<{ goal: string; finding: string }>) =>
        setTexts(prev => ({ ...prev, [id]: { ...get(id), ...patch } }));

    // Something written for every chart — a walkthrough with silent steps is
    // not a walkthrough. One field per chart is enough to continue.
    const answeredAll = material.charts.every(c => {
        const v = get(c.chartId);
        return v.goal.trim() || v.finding.trim();
    });

    const handleDone = () => {
        onDone({
            form: 'thread',
            seconds: Math.round((Date.now() - startRef.current) / 1000),
            entries: material.charts.map(c => ({
                chartId: c.chartId,
                num: c.num,
                title: c.title,
                goal: get(c.chartId).goal.trim(),
                finding: get(c.chartId).finding.trim(),
                actualPrompt: c.actualPrompt,
                promptSource: c.promptSource,
            })),
        });
    };

    return (
        <Box sx={{ p: 1.5 }}>
            <Typography sx={{ fontSize: 12.5 }}>
                {t('quiz.traceThreadIntro', { defaultValue:
                    'Here are your charts, in the order you made them. Walk us through your analysis: for each chart, what were you trying to find out, and what did it tell you?' })}
            </Typography>
            <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 1.5 }}>
                {t('quiz.traceThreadHint', { defaultValue:
                    'Answer from memory — there is no need to be word-perfect. A short sentence per box is plenty.' })}
            </Typography>
            {material.charts.map((c, i) => (
                <Box key={c.chartId} sx={{ display: 'flex', gap: 1.5, position: 'relative', pb: 2 }}>
                    {/* thread spine: number bubble + connector to the next chart */}
                    <Box sx={{ width: 26, flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <Box sx={{ width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                                   background: alpha(theme.palette.primary.main, 0.12), color: 'primary.main',
                                   display: 'flex', alignItems: 'center', justifyContent: 'center',
                                   fontSize: 11, fontWeight: 600 }}>
                            {c.num}
                        </Box>
                        {i < material.charts.length - 1 && (
                            <Box sx={{ width: 2, flex: 1, background: alpha(theme.palette.primary.main, 0.18), mt: 0.5 }} />
                        )}
                    </Box>
                    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', gap: 1.5, flexDirection: wide ? 'row' : 'column' }}>
                        <Box sx={{ width: wide ? 260 : '100%', flexShrink: 0, border: `1px solid ${borderColor.view}`,
                                   borderRadius: radius.sm, background: '#fff', p: 0.75, alignSelf: 'flex-start' }}>
                            <img src={svgUri(c.svg)} alt="" style={{ width: '100%', maxHeight: 180, objectFit: 'contain', display: 'block' }} />
                            <Typography noWrap sx={{ fontSize: 10.5, color: 'text.secondary', mt: 0.25 }}>{c.title}</Typography>
                        </Box>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                            <TextField
                                fullWidth multiline minRows={2} size="small" value={get(c.chartId).goal}
                                onChange={e => set(c.chartId, { goal: e.target.value })}
                                label={t('quiz.traceThreadGoal', { defaultValue: 'What were you trying to find out here?' })}
                                sx={{ mb: 1, '& .MuiInputBase-root': { fontSize: 12.5 }, '& .MuiInputLabel-root': { fontSize: 12.5 } }}
                            />
                            <TextField
                                fullWidth multiline minRows={2} size="small" value={get(c.chartId).finding}
                                onChange={e => set(c.chartId, { finding: e.target.value })}
                                label={i < material.charts.length - 1
                                    ? t('quiz.traceThreadFinding', { defaultValue: 'What did you find, and where did it take you next?' })
                                    : t('quiz.traceThreadFindingLast', { defaultValue: 'What did you find?' })}
                                sx={{ '& .MuiInputBase-root': { fontSize: 12.5 }, '& .MuiInputLabel-root': { fontSize: 12.5 } }}
                            />
                        </Box>
                    </Box>
                </Box>
            ))}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Button size="small" variant="contained" disabled={!answeredAll} onClick={handleDone}
                        sx={{ fontSize: 12, textTransform: 'none' }}>
                    {t('quiz.traceThreadDone', { defaultValue: 'Done — that is my analysis' })}
                </Button>
                {!answeredAll && (
                    <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                        {t('quiz.traceThreadAnswerAll', { defaultValue: 'Write at least a sentence for every chart.' })}
                    </Typography>
                )}
            </Box>
        </Box>
    );
};
