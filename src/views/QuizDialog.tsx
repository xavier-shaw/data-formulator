// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * QuizDialog — the in-app chart-recognition quiz.
 *
 * Asks the participant, for each of the charts they spent the most time on,
 * which of four charts is the one they actually made. Three are generated
 * look-alikes (src/lib/quiz-distractors). Each answer is scored immediately, and
 * a miss records how far the chosen look-alike sat from the real chart — on the
 * form axis and the values axis — which is what tells us *what* was
 * misremembered rather than merely that something was.
 *
 * Generation runs in the browser and takes a few seconds, so the dialog opens on
 * a progress view and hands over to the questions when the set is ready.
 */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Dialog, DialogTitle, DialogContent, DialogActions,
    Box, Button, IconButton, Typography, LinearProgress, Table, TableBody,
    TableCell, TableHead, TableRow, Tooltip, alpha, useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import ReplayIcon from '@mui/icons-material/Replay';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import { useTranslation } from 'react-i18next';
import { borderColor, radius } from '../app/tokens';
import {
    generateQuizForSession, buildQuizResult,
    GeneratedQuiz, QuizAnswer,
} from '../app/quizGeneration';
import { QuizItem, QuizOption } from '../lib/quiz-distractors';

interface QuizDialogProps {
    open: boolean;
    onClose: () => void;
    sessionId: string;
    sessionName: string;
    /** live Redux slices, passed when the target session is the active one */
    liveState?: unknown;
}

/** Deterministic-per-item shuffle so re-renders don't reshuffle under the user. */
function shuffledOptions(item: QuizItem): QuizOption[] {
    const out = [...item.options];
    // Fisher-Yates seeded off the chart id: stable across re-renders, different
    // per question, and the correct answer is not biased to a position.
    let h = 0;
    for (const ch of item.chartId) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    for (let i = out.length - 1; i > 0; i--) {
        h = (h * 1103515245 + 12345) & 0x7fffffff;
        const j = h % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

const svgDataUri = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/^<\?xml[^>]*\?>\s*/, ''))}`;

export const QuizDialog: FC<QuizDialogProps> = ({ open, onClose, sessionId, sessionName, liveState }) => {
    const { t } = useTranslation();
    const theme = useTheme();

    const [quiz, setQuiz] = useState<GeneratedQuiz | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState<{ done: number; total: number; label: string }>({ done: 0, total: 0, label: '' });
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<QuizAnswer[]>([]);
    const [picked, setPicked] = useState<string | null>(null);
    const [finished, setFinished] = useState(false);
    // Guards against a stale generation run writing into a reopened dialog.
    const runIdRef = useRef(0);

    const reset = useCallback(() => {
        setQuiz(null); setError(null); setIndex(0); setAnswers([]);
        setPicked(null); setFinished(false); setProgress({ done: 0, total: 0, label: '' });
    }, []);

    // Generate when the dialog opens.
    useEffect(() => {
        if (!open) return;
        const runId = ++runIdRef.current;
        reset();
        (async () => {
            try {
                const generated = await generateQuizForSession({
                    sessionId, sessionName, liveState,
                    onProgress: (done, total, label) => {
                        if (runIdRef.current === runId) setProgress({ done, total, label });
                    },
                });
                if (runIdRef.current !== runId) return;
                if (generated.items.length === 0) {
                    setError(t('quiz.noQuestions', {
                        defaultValue: 'No chart in this session has enough look-alikes to ask about yet. Make a few more charts and try again.',
                    }));
                    return;
                }
                setQuiz(generated);
            } catch (e: any) {
                if (runIdRef.current !== runId) return;
                setError(e?.message || t('quiz.generateFailed', { defaultValue: 'The quiz could not be made for this session.' }));
            }
        })();
    }, [open, sessionId, sessionName, liveState, reset, t]);

    const item = quiz?.items[index];
    const options = useMemo(() => (item ? shuffledOptions(item) : []), [item]);

    const handlePick = useCallback((optionId: string) => {
        if (!item || picked) return;
        setPicked(optionId);
        const chosen = item.options.find(o => o.id === optionId);
        const correct = optionId === item.correctId;
        setAnswers(prev => [...prev, {
            n: index + 1,
            chartId: item.chartId,
            title: item.title,
            chartType: item.chartType,
            correct,
            pickedId: optionId,
            method: correct ? undefined : chosen?.method,
            label: correct ? undefined : chosen?.label,
            specDist: correct ? undefined : chosen?.specDist,
            dataDist: correct ? undefined : chosen?.dataDist,
        }]);
    }, [item, picked, index]);

    const handleNext = useCallback(() => {
        if (!quiz) return;
        if (index + 1 >= quiz.items.length) { setFinished(true); return; }
        setIndex(i => i + 1);
        setPicked(null);
    }, [quiz, index]);

    const handleDownload = useCallback(() => {
        if (!quiz) return;
        const result = buildQuizResult(quiz, answers, new Date().toISOString());
        const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `quiz-${sessionName || sessionId}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }, [quiz, answers, sessionName, sessionId]);

    const correctCount = answers.filter(a => a.correct).length;

    // ── option card ──────────────────────────────────────────────────────
    const renderOption = (opt: QuizOption) => {
        const isCorrect = item && opt.id === item.correctId;
        const isPicked = picked === opt.id;
        let border = borderColor.view;
        let shadow = 'none';
        if (picked) {
            if (isCorrect) { border = theme.palette.success.main; shadow = `0 0 0 3px ${alpha(theme.palette.success.main, 0.18)}`; }
            else if (isPicked) { border = theme.palette.error.main; shadow = `0 0 0 3px ${alpha(theme.palette.error.main, 0.18)}`; }
        }
        return (
            <Box
                key={opt.id}
                component="button"
                disabled={!!picked}
                onClick={() => handlePick(opt.id)}
                sx={{
                    p: 1, background: '#fff', cursor: picked ? 'default' : 'pointer',
                    border: `2px solid ${border}`, boxShadow: shadow, borderRadius: radius.md,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    minHeight: 190, transition: 'border-color .12s, box-shadow .12s',
                    '&:hover': picked ? {} : { borderColor: theme.palette.primary.main },
                }}
            >
                <img
                    src={svgDataUri(opt.svg)}
                    alt=""
                    style={{ maxWidth: '100%', maxHeight: 240, height: 'auto' }}
                />
            </Box>
        );
    };

    // ── body states ──────────────────────────────────────────────────────
    let body: React.ReactNode;
    if (error) {
        body = <Typography sx={{ fontSize: 14, color: 'text.secondary', py: 2 }}>{error}</Typography>;
    } else if (!quiz) {
        const pct = progress.total ? (100 * progress.done) / progress.total : 0;
        body = (
            <Box sx={{ py: 3 }}>
                <Typography sx={{ fontSize: 14, mb: 1.5 }}>
                    {t('quiz.generating', { defaultValue: 'Making the look-alike charts…' })}
                </Typography>
                <LinearProgress variant={progress.total ? 'determinate' : 'indeterminate'} value={pct} />
                <Typography sx={{ fontSize: 12, color: 'text.disabled', mt: 1 }}>
                    {progress.label
                        ? t('quiz.generatingChart', { chart: progress.label, defaultValue: `Working on “${progress.label}”` })
                        : t('quiz.generatingWait', { defaultValue: 'This takes a few seconds.' })}
                </Typography>
            </Box>
        );
    } else if (finished) {
        body = (
            <Box sx={{ py: 1 }}>
                <Typography sx={{ fontSize: 32, fontWeight: 700, lineHeight: 1.1 }}>
                    {correctCount}
                    <Typography component="span" sx={{ fontSize: 16, color: 'text.disabled', fontWeight: 500 }}>
                        {' '}/ {quiz.items.length} {t('quiz.correctSuffix', { defaultValue: 'correct' })}
                    </Typography>
                </Typography>
                <Typography sx={{ fontSize: 13, color: 'text.secondary', mt: 0.5, mb: 1.5 }}>
                    {/* Singular/plural picked explicitly rather than via i18next
                        plural suffixes: English and Chinese disagree on which
                        forms exist, and the two phrasings differ by more than
                        an "s" ("look-alike is" vs "look-alikes are"). */}
                    {(() => {
                        const missCount = answers.length - correctCount;
                        if (missCount === 0) return t('quiz.noMisses', { defaultValue: 'You recognized every chart.' });
                        if (missCount === 1) return t('quiz.missesOne', { defaultValue: '1 miss — the look-alike that fooled you is listed below.' });
                        return t('quiz.missesMany', {
                            count: missCount,
                            defaultValue: `${missCount} misses — the look-alikes that fooled you are listed below.`,
                        });
                    })()}
                </Typography>
                <Box sx={{ overflowX: 'auto' }}>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={{ fontSize: 11 }}>#</TableCell>
                                <TableCell sx={{ fontSize: 11 }}>{t('quiz.colChart', { defaultValue: 'Chart' })}</TableCell>
                                <TableCell sx={{ fontSize: 11 }}>{t('quiz.colResult', { defaultValue: 'Result' })}</TableCell>
                                <TableCell sx={{ fontSize: 11 }}>{t('quiz.colChosen', { defaultValue: 'If missed: look-alike chosen' })}</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {answers.map(a => (
                                <TableRow key={a.n}>
                                    <TableCell sx={{ fontSize: 12 }}>{a.n}</TableCell>
                                    <TableCell sx={{ fontSize: 12 }}>{a.title}</TableCell>
                                    <TableCell sx={{ fontSize: 12 }}>
                                        {a.correct
                                            ? <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'success.main' }}>
                                                <CheckCircleOutlineIcon sx={{ fontSize: 14 }} />
                                                {t('quiz.correct', { defaultValue: 'correct' })}
                                              </Box>
                                            : <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'error.main' }}>
                                                <HighlightOffIcon sx={{ fontSize: 14 }} />
                                                {t('quiz.missed', { defaultValue: 'missed' })}
                                              </Box>}
                                    </TableCell>
                                    <TableCell sx={{ fontSize: 12, color: 'text.secondary' }}>
                                        {a.correct ? '—' : `${a.label ?? ''} (${t('quiz.form', { defaultValue: 'form' })} ${a.specDist}, ${t('quiz.values', { defaultValue: 'values' })} ${a.dataDist})`}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </Box>
                {quiz.problems.length > 0 && (
                    <Typography sx={{ fontSize: 11, color: 'warning.main', mt: 1 }}>
                        {quiz.problems.join('; ')}
                    </Typography>
                )}
            </Box>
        );
    } else if (item) {
        const chosen = picked ? item.options.find(o => o.id === picked) : undefined;
        const gotIt = picked === item.correctId;
        body = (
            <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1.5 }}>
                    <LinearProgress
                        variant="determinate"
                        value={(100 * index) / quiz.items.length}
                        sx={{ flex: 1, height: 6, borderRadius: 99 }}
                    />
                    <Typography sx={{ fontSize: 12, color: 'text.disabled', whiteSpace: 'nowrap' }}>
                        {index + 1} / {quiz.items.length}
                    </Typography>
                </Box>
                <Typography sx={{ fontSize: 14, mb: 1.5 }}>
                    {t('quiz.questionPrompt', {
                        seconds: Math.round(item.focusMs / 1000),
                        defaultValue: `Which of these did you make? You spent about ${Math.round(item.focusMs / 1000)}s on it.`,
                    })}
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1.5 }}>
                    {options.map(renderOption)}
                </Box>
                <Typography sx={{ fontSize: 13, mt: 1.5, minHeight: 24, color: gotIt ? 'success.main' : 'error.main' }}>
                    {picked
                        ? (gotIt
                            ? t('quiz.verdictCorrect', { defaultValue: 'Correct — that is the chart from your session.' })
                            : t('quiz.verdictWrong', {
                                form: chosen?.specDist, values: chosen?.dataDist,
                                defaultValue: `Not this one — it is a look-alike (form ${chosen?.specDist}, values ${chosen?.dataDist}). The real chart is outlined in green.`,
                            }))
                        : ''}
                </Typography>
            </Box>
        );
    }

    return (
        <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', fontSize: 16, pb: 1 }}>
                <Box sx={{ flex: 1 }}>
                    {t('quiz.title', { defaultValue: 'Which chart did you make?' })}
                    <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>{sessionName}</Typography>
                </Box>
                <IconButton size="small" onClick={onClose}><CloseIcon sx={{ fontSize: 18 }} /></IconButton>
            </DialogTitle>
            <DialogContent dividers>{body}</DialogContent>
            <DialogActions>
                {finished && quiz && (
                    <>
                        <Tooltip title={t('quiz.downloadHint', { defaultValue: 'Save every answer, with the distances, as JSON' })}>
                            <Button size="small" startIcon={<DownloadIcon sx={{ fontSize: 16 }} />} onClick={handleDownload}>
                                {t('quiz.download', { defaultValue: 'Download answers' })}
                            </Button>
                        </Tooltip>
                        <Button size="small" startIcon={<ReplayIcon sx={{ fontSize: 16 }} />} onClick={() => { setIndex(0); setAnswers([]); setPicked(null); setFinished(false); }}>
                            {t('quiz.again', { defaultValue: 'Take it again' })}
                        </Button>
                    </>
                )}
                {!finished && quiz && (
                    <Button size="small" variant="contained" disabled={!picked} onClick={handleNext}>
                        {index + 1 >= quiz.items.length
                            ? t('quiz.seeResults', { defaultValue: 'See results' })
                            : t('quiz.next', { defaultValue: 'Next' })}
                    </Button>
                )}
                <Button size="small" onClick={onClose}>{t('quiz.close', { defaultValue: 'Close' })}</Button>
            </DialogActions>
        </Dialog>
    );
};
