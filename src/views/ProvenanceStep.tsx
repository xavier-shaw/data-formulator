// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ProvenanceStep — reasoning-trace form B: which chart did you make next?
 *
 * One item at a time. The context — the chart made before this one, then the
 * chart itself — and three real charts from the session to choose between.
 *
 * The answer mechanism is part 4's: ONE pick, one confirm, and the next item
 * follows. The participant gets no feedback — neither the true next chart nor
 * whether they had it. Only the researcher's eye toggle (bottom right)
 * outlines the chart that really came next.
 *
 * The step FILLS the height it is given and never scrolls: the two chart rows
 * take every pixel the question, the rating and the button leave, so an item
 * is always one view. That is why the rows are flex weights rather than
 * pixel heights — no constant has to be kept in step with the text above.
 *
 * Material and scoring live in app/provenanceQuiz.ts.
 */

import { FC, useMemo, useRef, useState } from 'react';
import { Box, Button, IconButton, Tooltip, Typography, alpha, useTheme } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useTranslation } from 'react-i18next';
import { borderColor, radius } from '../app/tokens';
import { CONFIDENCE_DEFAULT, ConfidenceRater } from './ConfidenceRater';
import { TraceChart } from '../app/reasoningTrace';
import {
    ProvenanceAnswer, ProvenanceMaterial, ProvenanceResponse, buildProvenanceAnswer,
} from '../app/provenanceQuiz';

const svgUri = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/^<\?xml[^>]*\?>\s*/, ''))}`;

/**
 * One chart thumbnail, filling the height of its row. `tone` colours the
 * border; `caption` sits underneath.
 */
const ChartCard: FC<{
    chart: TraceChart;
    width: number | string;
    tone?: string;
    dim?: boolean;
    caption?: string;
    onClick?: () => void;
}> = ({ chart, width, tone, dim, caption, onClick }) => (
    <Box component={onClick ? 'button' : 'div'} onClick={onClick} type={onClick ? 'button' : undefined}
        sx={{
            width, height: '100%', minWidth: 0, minHeight: 0, p: 0.75, background: '#fff', textAlign: 'left',
            // This route has no CSS reset, so the default content-box would
            // add the padding and the border ON TOP of the 100% and push the
            // card past the row it is given.
            boxSizing: 'border-box',
            display: 'flex', flexDirection: 'column',
            border: `2px solid ${tone ?? borderColor.view}`, borderRadius: radius.sm,
            opacity: dim ? 0.6 : 1, cursor: onClick ? 'pointer' : 'default',
            transition: 'border-color .12s, box-shadow .12s',
            ...(onClick ? { '&:hover': { borderColor: 'primary.main' } } : {}),
            ...(tone ? { boxShadow: `0 0 0 3px ${alpha(tone, 0.16)}` } : {}),
        }}>
        {/* The title heads the card, centred over its chart. Two clamped lines
            with a fixed block height, so a wrapped title on one candidate does
            not shrink its chart against the other two. The full text stays
            available on hover. */}
        <Typography title={chart.title} sx={{
            flexShrink: 0, fontSize: 12.5, fontWeight: 600, color: 'text.primary', textAlign: 'center',
            lineHeight: 1.25, minHeight: '2.5em', mb: 0.5,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>{chart.title}</Typography>
        <img src={svgUri(chart.svg)} alt="" draggable={false}
            style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, width: '100%', objectFit: 'contain', display: 'block' }} />
        {caption && (
            <Typography sx={{ flexShrink: 0, fontSize: 9.5, color: 'text.disabled', textAlign: 'center', mt: 0.25,
                              textTransform: 'uppercase', letterSpacing: '.06em' }}>
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
    // The researcher's eye toggle (bottom right): when on, the chart that
    // really came next is outlined. Never shown to the participant by default.
    const [showAnswer, setShowAnswer] = useState(false);
    // Confidence in the pick, committed with it and reset for every move.
    const [confidence, setConfidence] = useState(CONFIDENCE_DEFAULT);
    const [confidenceSet, setConfidenceSet] = useState(false);
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
            touchesReport: item.touchesReport,
            optionNums: item.options.map(o => o.num),
            actualPrompt: answer.actualPrompt,
            promptSource: answer.promptSource,
            confidence,
            confidenceSet,
            seconds: Math.round((Date.now() - itemStartRef.current) / 1000),
        }];
        setResponses(next);
        if (index + 1 >= material.items.length) {
            onDone(buildProvenanceAnswer(next, Math.round((Date.now() - startRef.current) / 1000)));
            return;
        }
        setIndex(i => i + 1);
        setPicked(null);
        setConfidence(CONFIDENCE_DEFAULT); setConfidenceSet(false);
        itemStartRef.current = Date.now();
    };

    /** Border colour for an option. Selecting is a neutral highlight; the
     *  right answer is never marked for the participant, and is outlined only
     *  while the researcher's eye toggle is on. */
    const optionTone = (chartId: string): string | undefined => {
        if (picked === chartId) return theme.palette.primary.main;
        if (showAnswer && chartId === answer.chartId) return theme.palette.success.main;
        return undefined;
    };

    return (
        <Box sx={{ p: 1.5, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
                   // Without this the step's own padding is added to the 100%
                   // it is given, and the whole quiz page scrolls by 24px.
                   boxSizing: 'border-box', overflow: 'hidden' }}>
            <Typography sx={{ flexShrink: 0, fontSize: 11, color: 'text.disabled', mb: 0.75 }}>
                {t('quiz.provProgress', { n: index + 1, total: material.items.length,
                    defaultValue: `Move ${index + 1} of ${material.items.length}` })}
            </Typography>

            {/* ── context: the chart before, then the one the move starts from.
                   Just the two charts — the question line below already says a
                   next chart is being asked for. ── */}
            <Box sx={{ flex: '4 1 0', minHeight: 0, display: 'flex', alignItems: 'stretch', gap: 1, mb: 1.5 }}>
                {item.previous && (
                    <>
                        <ChartCard chart={item.previous} width={wide ? '40%' : '48%'} dim
                            caption={t('quiz.provBefore', { defaultValue: 'before that' })} />
                        <ArrowForwardIcon sx={{ flexShrink: 0, alignSelf: 'center', fontSize: 16, color: 'text.disabled' }} />
                    </>
                )}
                <ChartCard chart={item.from} width={wide ? '46%' : '48%'}
                    tone={theme.palette.primary.main}
                    caption={t('quiz.provHere', { defaultValue: 'you were here' })} />
            </Box>

            <Typography sx={{ flexShrink: 0, fontSize: 15, fontWeight: 600, mb: 0.75 }}>
                {t('quiz.provPickPrompt', { defaultValue: 'Which chart did you make next?' })}
            </Typography>

            {/* A 3-column grid, not a wrapped row: the three candidates must
                share ONE row at any window width. They take the larger share of
                the height — they are what the participant compares. */}
            <Box sx={{ flex: '5 1 0', minHeight: 0, display: 'grid',
                       gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                       gridTemplateRows: 'minmax(0, 1fr)', gap: 1, mb: 1 }}>
                {item.options.map(opt => (
                    <ChartCard key={opt.chartId} chart={opt} width="100%"
                        tone={optionTone(opt.chartId)}
                        onClick={() => setPicked(opt.chartId)} />
                ))}
            </Box>

            {/* Below the candidates: the rating is about the pick, and the
                confirm commits both and moves on. */}
            <Box sx={{ flexShrink: 0 }}>
                <ConfidenceRater
                    value={confidence}
                    onChange={setConfidence}
                    onTouch={() => setConfidenceSet(true)}
                    action={
                        <Button variant="contained" disabled={!picked} onClick={handleNext}
                            sx={{ fontSize: 13, textTransform: 'none', px: 2.5 }}>
                            {t('quiz.confirm', { defaultValue: 'Confirm' })}
                        </Button>
                    }
                />
            </Box>

            {/* The researcher's eye, as in part 4: sits just above the
                system-messages info button (MessageSnackbar, bottom 16 right
                16). On, it outlines the chart that really came next; the
                participant never sees this by default. */}
            <Tooltip placement="left" title={showAnswer
                ? t('quiz.provAnswerHide', { defaultValue: 'Hide the chart that came next' })
                : t('quiz.provAnswerShow', { defaultValue: 'Show the chart that came next' })}>
                <IconButton
                    onClick={() => setShowAnswer(v => !v)}
                    sx={{
                        position: 'fixed', bottom: 52, right: 16,
                        width: 30, height: 30, zIndex: 10,
                        backgroundColor: 'white',
                        border: '1px solid',
                        borderColor: showAnswer ? 'primary.main' : 'grey.400',
                        color: showAnswer ? 'primary.main' : 'text.disabled',
                        boxShadow: '0 0 6px rgba(0,0,0,0.1)',
                        opacity: showAnswer ? 1 : 0.6,
                        transition: 'all 0.3s ease',
                        '&:hover': { transform: 'scale(1.1)', backgroundColor: 'white' },
                    }}
                >
                    {showAnswer ? <VisibilityIcon sx={{ fontSize: 18 }} /> : <VisibilityOutlinedIcon sx={{ fontSize: 18 }} />}
                </IconButton>
            </Tooltip>
        </Box>
    );
};
