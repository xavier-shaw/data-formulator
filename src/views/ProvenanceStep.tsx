// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ProvenanceStep — reasoning-trace form B: which chart came next, and why.
 *
 * One item at a time, in two beats. First the context — the chart made before
 * this one, then the chart itself — and three real charts from the session to
 * choose between: which did you make next? Confirming REVEALS the true next
 * chart, and only then does the second beat ask why that move was made, so a
 * wrong pick still produces a rationale about the move that really happened.
 *
 * Material and scoring live in app/provenanceQuiz.ts.
 */

import { FC, useMemo, useRef, useState } from 'react';
import { Box, Button, TextField, Typography, alpha, useTheme } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import { useTranslation } from 'react-i18next';
import { borderColor, radius } from '../app/tokens';
import { TraceChart } from '../app/reasoningTrace';
import {
    ProvenanceAnswer, ProvenanceMaterial, ProvenanceResponse, buildProvenanceAnswer,
} from '../app/provenanceQuiz';

const svgUri = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/^<\?xml[^>]*\?>\s*/, ''))}`;

/** One chart thumbnail. `tone` colours the border; `caption` sits underneath. */
const ChartCard: FC<{
    chart: TraceChart;
    width: number | string;
    height: number;
    tone?: string;
    dim?: boolean;
    caption?: string;
    onClick?: () => void;
}> = ({ chart, width, height, tone, dim, caption, onClick }) => (
    <Box component={onClick ? 'button' : 'div'} onClick={onClick} type={onClick ? 'button' : undefined}
        sx={{
            width, p: 0.75, background: '#fff', textAlign: 'left', flexShrink: 0,
            border: `2px solid ${tone ?? borderColor.view}`, borderRadius: radius.sm,
            opacity: dim ? 0.6 : 1, cursor: onClick ? 'pointer' : 'default',
            transition: 'border-color .12s, box-shadow .12s',
            ...(onClick ? { '&:hover': { borderColor: 'primary.main' } } : {}),
            ...(tone ? { boxShadow: `0 0 0 3px ${alpha(tone, 0.16)}` } : {}),
        }}>
        <img src={svgUri(chart.svg)} alt="" draggable={false}
            style={{ width: '100%', height, objectFit: 'contain', display: 'block' }} />
        <Typography noWrap sx={{ fontSize: 10.5, color: 'text.secondary', mt: 0.25 }}>{chart.title}</Typography>
        {caption && (
            <Typography sx={{ fontSize: 10, color: 'text.disabled', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                {caption}
            </Typography>
        )}
    </Box>
);

interface ProvenanceStepProps {
    material: ProvenanceMaterial;
    onDone: (answer: ProvenanceAnswer) => void;
    wide?: boolean;
}

export const ProvenanceStep: FC<ProvenanceStepProps> = ({ material, onDone, wide = true }) => {
    const { t } = useTranslation();
    const theme = useTheme();
    const startRef = useRef(Date.now());
    const itemStartRef = useRef(Date.now());

    const [index, setIndex] = useState(0);
    const [picked, setPicked] = useState<string | null>(null);
    const [revealed, setRevealed] = useState(false);
    const [rationale, setRationale] = useState('');
    const [responses, setResponses] = useState<ProvenanceResponse[]>([]);

    const item = material.items[index];
    const answer = useMemo(
        () => item?.options.find(o => o.chartId === item.answerChartId) ?? null,
        [item],
    );

    if (!item || !answer) {
        return (
            <Box sx={{ p: 2 }}>
                <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                    {t('quiz.provNoItems', { defaultValue:
                        'This session does not have enough charts to ask where one led to another.' })}
                </Typography>
            </Box>
        );
    }

    const handleNext = () => {
        const chosen = item.options.find(o => o.chartId === picked)!;
        const next = [...responses, {
            itemId: item.id,
            fromChartId: item.from.chartId,
            fromNum: item.from.num,
            answerChartId: answer.chartId,
            answerNum: answer.num,
            pickedChartId: chosen.chartId,
            pickedNum: chosen.num,
            correct: chosen.chartId === answer.chartId,
            optionNums: item.options.map(o => o.num),
            rationale: rationale.trim(),
            actualPrompt: answer.actualPrompt,
            promptSource: answer.promptSource,
            seconds: Math.round((Date.now() - itemStartRef.current) / 1000),
        }];
        setResponses(next);
        if (index + 1 >= material.items.length) {
            onDone(buildProvenanceAnswer(next, Math.round((Date.now() - startRef.current) / 1000)));
            return;
        }
        setIndex(i => i + 1);
        setPicked(null); setRevealed(false); setRationale('');
        itemStartRef.current = Date.now();
    };

    const correct = revealed && picked === answer.chartId;
    const thumbW = wide ? 220 : '100%';

    /** Border colour for an option: neutral while choosing, verdict once revealed. */
    const optionTone = (chartId: string): string | undefined => {
        if (!revealed) return picked === chartId ? theme.palette.primary.main : undefined;
        if (chartId === answer.chartId) return theme.palette.success.main;
        return picked === chartId ? theme.palette.error.main : undefined;
    };

    return (
        <Box sx={{ p: 1.5 }}>
            <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 0.75 }}>
                {t('quiz.provProgress', { n: index + 1, total: material.items.length,
                    defaultValue: `Move ${index + 1} of ${material.items.length}` })}
            </Typography>

            {/* ── context: the chart before, then the one the move starts from ── */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
                {item.previous && (
                    <>
                        <ChartCard chart={item.previous} width={wide ? 180 : '100%'} height={100} dim
                            caption={t('quiz.provBefore', { defaultValue: 'before that' })} />
                        <ArrowForwardIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                    </>
                )}
                <ChartCard chart={item.from} width={wide ? 220 : '100%'} height={120}
                    tone={theme.palette.primary.main}
                    caption={t('quiz.provHere', { defaultValue: 'you were here' })} />
                <ArrowForwardIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                <Box sx={{ width: 60, height: 60, borderRadius: radius.sm, border: `2px dashed ${borderColor.view}`,
                           display: 'flex', alignItems: 'center', justifyContent: 'center',
                           fontSize: 20, color: theme.palette.text.disabled }}>?</Box>
            </Box>

            <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 0.75 }}>
                {t('quiz.provPickPrompt', { defaultValue: 'Which chart did you make next?' })}
            </Typography>

            <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
                {item.options.map(opt => (
                    <ChartCard key={opt.chartId} chart={opt} width={thumbW} height={130}
                        tone={optionTone(opt.chartId)}
                        onClick={revealed ? undefined : () => setPicked(opt.chartId)} />
                ))}
            </Box>

            {!revealed ? (
                <Button size="small" variant="contained" disabled={!picked}
                    onClick={() => setRevealed(true)}
                    sx={{ fontSize: 12, textTransform: 'none' }}>
                    {t('quiz.provConfirm', { defaultValue: 'That is the one' })}
                </Button>
            ) : (
                <>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                        {correct
                            ? <CheckCircleOutlineIcon sx={{ fontSize: 16, color: 'success.main' }} />
                            : <HighlightOffIcon sx={{ fontSize: 16, color: 'error.main' }} />}
                        <Typography sx={{ fontSize: 11.5, color: correct ? 'success.main' : 'error.main' }}>
                            {correct
                                ? t('quiz.provRight', { defaultValue: 'Yes — that is the chart you made next.' })
                                : t('quiz.provWrong', { defaultValue: 'Not that one. The chart you actually made next is outlined in green.' })}
                        </Typography>
                    </Box>
                    {/* Part 2 always asks about the REVEALED chart, so the rationale
                        stays readable even when the pick was wrong. */}
                    <TextField
                        fullWidth multiline minRows={2} size="small" autoFocus
                        value={rationale}
                        onChange={e => setRationale(e.target.value)}
                        label={t('quiz.provRationale', { defaultValue: 'Why did you move from one to the other?' })}
                        sx={{ mb: 1, '& .MuiInputBase-root': { fontSize: 12.5 }, '& .MuiInputLabel-root': { fontSize: 12.5 } }}
                    />
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Button size="small" variant="contained" disabled={!rationale.trim()} onClick={handleNext}
                            sx={{ fontSize: 12, textTransform: 'none' }}>
                            {index + 1 >= material.items.length
                                ? t('quiz.provFinish', { defaultValue: 'Done' })
                                : t('quiz.provNext', { defaultValue: 'Next move' })}
                        </Button>
                        {!rationale.trim() && (
                            <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                                {t('quiz.provRationaleHint', { defaultValue:
                                    'A sentence from memory is plenty — say what made you take this step.' })}
                            </Typography>
                        )}
                    </Box>
                </>
            )}
        </Box>
    );
};
