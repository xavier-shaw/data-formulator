// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ProvenanceStep — reasoning-trace form B: which chart did you make next?
 *
 * One item at a time. The context — the chart made before this one, then the
 * chart itself — and three real charts from the session to choose between.
 * Confirming REVEALS the true next chart, and the next item follows.
 *
 * The step FILLS the height it is given and never scrolls: the two chart rows
 * take every pixel the question, the rating and the button leave, so an item
 * is always one view. That is why the rows are flex weights rather than
 * pixel heights — no constant has to be kept in step with the text above.
 *
 * Material and scoring live in app/provenanceQuiz.ts.
 */

import { FC, useMemo, useRef, useState } from 'react';
import { Box, Button, Typography, alpha, useTheme } from '@mui/material';
import ArrowForwardIcon from '@mui/icons-material/ArrowForward';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
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
    const [revealed, setRevealed] = useState(false);
    // Confidence in the PICK, so it is asked before the reveal and frozen by
    // it — the rater goes read-only the moment the true chart is outlined,
    // otherwise the rating could be revised once the answer is on screen.
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
        setPicked(null); setRevealed(false);
        setConfidence(CONFIDENCE_DEFAULT); setConfidenceSet(false);
        itemStartRef.current = Date.now();
    };

    const correct = revealed && picked === answer.chartId;

    /** Border colour for an option: neutral while choosing, verdict once revealed. */
    const optionTone = (chartId: string): string | undefined => {
        if (!revealed) return picked === chartId ? theme.palette.primary.main : undefined;
        if (chartId === answer.chartId) return theme.palette.success.main;
        return picked === chartId ? theme.palette.error.main : undefined;
    };

    return (
        <Box sx={{ p: 1.5, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column',
                   overflow: 'hidden' }}>
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
                        onClick={revealed ? undefined : () => setPicked(opt.chartId)} />
                ))}
            </Box>

            {/* The verdict keeps its row whether or not it says anything, so
                revealing an answer never moves the rating or the button. */}
            <Box sx={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 0.5, minHeight: 22, mb: 0.5 }}>
                {revealed && (correct
                    ? <CheckCircleOutlineIcon sx={{ fontSize: 16, color: 'success.main' }} />
                    : <HighlightOffIcon sx={{ fontSize: 16, color: 'error.main' }} />)}
                <Typography sx={{ fontSize: 11.5, color: correct ? 'success.main' : 'error.main' }}>
                    {revealed
                        ? (correct
                            ? t('quiz.provRight', { defaultValue: 'Yes — that is the chart you made next.' })
                            : t('quiz.provWrong', { defaultValue: 'Not that one. The chart you actually made next is outlined in green.' }))
                        : ''}
                </Typography>
            </Box>

            {/* Below the candidates: the rating is about the pick, so it shares
                the row with the button that commits it, and confirming freezes
                it. Once revealed, the same button moves on. */}
            <Box sx={{ flexShrink: 0 }}>
                <ConfidenceRater
                    value={confidence}
                    onChange={setConfidence}
                    onTouch={() => setConfidenceSet(true)}
                    disabled={revealed}
                    action={
                        <Button variant="contained" disabled={!picked}
                            onClick={revealed ? handleNext : () => setRevealed(true)}
                            sx={{ fontSize: 13, textTransform: 'none', px: 2.5 }}>
                            {t('quiz.confirm', { defaultValue: 'Confirm' })}
                        </Button>
                    }
                />
            </Box>
        </Box>
    );
};
