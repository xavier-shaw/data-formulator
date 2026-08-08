// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * QuizPanel — chart-recognition panel, docked beside the canvas.
 *
 * Two modes over the same generated look-alikes:
 *
 *  • Quiz   — answer, one chart at a time: which of these four did you make?
 *             Scored as you go; a miss records how far the chosen look-alike sat
 *             from the real chart, which is what says *what* was misremembered.
 *  • Author — inspect, nothing to answer: every method's look-alikes for a
 *             chart, with the operations each performed and the distances they
 *             produced. Charts are expanded on demand, because rendering every
 *             method's output for a whole session is hundreds of charts.
 *
 * A panel rather than a dialog so the canvas stays visible and usable: the
 * charts under discussion are right there, and in author mode you want to
 * compare a look-alike against the real thing on screen.
 */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Box, Button, IconButton, Typography, LinearProgress, Tabs, Tab, Chip,
    Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Collapse,
    CircularProgress, alpha, useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import ReplayIcon from '@mui/icons-material/Replay';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useTranslation } from 'react-i18next';
import { borderColor, radius } from '../app/tokens';
import {
    generateQuizForSession, buildQuizResult, authorViewForChart,
    GeneratedQuiz, QuizAnswer,
} from '../app/quizGeneration';
import { QuizItem, QuizOption, AuthoredChart, AuthoredLure, Method } from '../lib/quiz-distractors';

interface QuizPanelProps {
    sessionId: string;
    sessionName: string;
    /** live Redux slices, passed when the panel targets the active session */
    liveState?: unknown;
    onClose: () => void;
}

const METHOD_LABEL: Record<Method, string> = {
    'graphscape': 'GraphScape walk',
    'enumeration': 'Enumeration',
    'data-perturb': 'Data perturbation',
    'sibling-measure': 'Sibling measure',
    'session-hybrid': 'Session hybrid',
};

/** One accent per method so a lure's origin reads at a glance. */
const METHOD_COLOR: Record<Method, string> = {
    'graphscape': '#C4652A',
    'enumeration': '#8A63BF',
    'data-perturb': '#2E8B6B',
    'sibling-measure': '#B5504B',
    'session-hybrid': '#9C8425',
};

const svgUri = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/^<\?xml[^>]*\?>\s*/, ''))}`;

/** Stable per-question shuffle: re-renders must not move the options. */
function shuffledOptions(item: QuizItem): QuizOption[] {
    const out = [...item.options];
    let h = 0;
    for (const ch of item.chartId) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff;
    for (let i = out.length - 1; i > 0; i--) {
        h = (h * 1103515245 + 12345) & 0x7fffffff;
        const j = h % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

const secs = (ms: number) => Math.round(ms / 1000);

export const QuizPanel: FC<QuizPanelProps> = ({ sessionId, sessionName, liveState, onClose }) => {
    const { t } = useTranslation();
    const theme = useTheme();

    const [mode, setMode] = useState<'quiz' | 'author'>('quiz');

    // ── shared generation (quiz mode drives it; author mode reuses the session) ──
    const [quiz, setQuiz] = useState<GeneratedQuiz | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
    const runIdRef = useRef(0);

    // ── quiz state ──
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<QuizAnswer[]>([]);
    const [picked, setPicked] = useState<string | null>(null);
    const [finished, setFinished] = useState(false);

    // ── author state: one entry per chart, filled in on expand ──
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [authored, setAuthored] = useState<Record<string, AuthoredChart | 'loading' | 'failed'>>({});

    useEffect(() => {
        const runId = ++runIdRef.current;
        setQuiz(null); setError(null); setIndex(0); setAnswers([]);
        setPicked(null); setFinished(false); setExpanded(new Set()); setAuthored({});
        (async () => {
            try {
                const generated = await generateQuizForSession({
                    sessionId, sessionName, liveState,
                    onProgress: (done, total, label) => {
                        if (runIdRef.current === runId) setProgress({ done, total, label });
                    },
                });
                if (runIdRef.current !== runId) return;
                setQuiz(generated);
            } catch (e: any) {
                if (runIdRef.current !== runId) return;
                setError(e?.message || t('quiz.generateFailed', { defaultValue: 'The quiz could not be made for this session.' }));
            }
        })();
    }, [sessionId, sessionName, liveState, t]);

    const item = quiz?.items[index];
    const options = useMemo(() => (item ? shuffledOptions(item) : []), [item]);
    const correctCount = answers.filter(a => a.correct).length;

    const handlePick = useCallback((optionId: string) => {
        if (!item || picked) return;
        setPicked(optionId);
        const chosen = item.options.find(o => o.id === optionId);
        const correct = optionId === item.correctId;
        setAnswers(prev => [...prev, {
            n: index + 1, chartId: item.chartId, title: item.title, chartType: item.chartType,
            correct, pickedId: optionId,
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
        a.href = url; a.download = `quiz-${sessionName || sessionId}.json`; a.click();
        URL.revokeObjectURL(url);
    }, [quiz, answers, sessionName, sessionId]);

    /** Expand a chart in author mode, generating its look-alikes the first time. */
    const toggleAuthorChart = useCallback(async (chartId: string) => {
        setExpanded(prev => {
            const next = new Set(prev);
            next.has(chartId) ? next.delete(chartId) : next.add(chartId);
            return next;
        });
        if (authored[chartId]) return;                    // already have it (or in flight)
        setAuthored(prev => ({ ...prev, [chartId]: 'loading' }));
        try {
            const built = await authorViewForChart({ sessionId, liveState, chartId });
            setAuthored(prev => ({ ...prev, [chartId]: built ?? 'failed' }));
        } catch {
            setAuthored(prev => ({ ...prev, [chartId]: 'failed' }));
        }
    }, [authored, sessionId, liveState]);

    // ── pieces ───────────────────────────────────────────────────────────

    const header = (
        <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.75, borderBottom: `1px solid ${borderColor.view}`, flexShrink: 0, gap: 1 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography sx={{ fontSize: 13, fontWeight: 500 }}>
                    {t('quiz.panelTitle', { defaultValue: 'Chart memory' })}
                </Typography>
                <Typography noWrap sx={{ fontSize: 11, color: 'text.disabled' }}>{sessionName}</Typography>
            </Box>
            <Tooltip title={t('quiz.close', { defaultValue: 'Close' })}>
                <IconButton size="small" onClick={onClose} sx={{ p: 0.25, color: 'text.disabled', '&:hover': { color: 'text.primary' } }}>
                    <CloseIcon sx={{ fontSize: 16 }} />
                </IconButton>
            </Tooltip>
        </Box>
    );

    const tabs = (
        <Tabs
            value={mode}
            onChange={(_, v) => setMode(v)}
            sx={{ minHeight: 34, borderBottom: `1px solid ${borderColor.view}`, flexShrink: 0,
                  '& .MuiTab-root': { minHeight: 34, fontSize: 12, textTransform: 'none', py: 0 } }}
        >
            <Tab value="quiz" label={t('quiz.tabQuiz', { defaultValue: 'Quiz' })} />
            <Tab value="author" label={t('quiz.tabAuthor', { defaultValue: 'Author' })} />
        </Tabs>
    );

    const generating = (
        <Box sx={{ p: 2 }}>
            <Typography sx={{ fontSize: 13, mb: 1 }}>
                {t('quiz.generating', { defaultValue: 'Making the look-alike charts…' })}
            </Typography>
            <LinearProgress
                variant={progress.total ? 'determinate' : 'indeterminate'}
                value={progress.total ? (100 * progress.done) / progress.total : 0}
            />
            <Typography sx={{ fontSize: 11, color: 'text.disabled', mt: 0.75 }}>
                {progress.label || t('quiz.generatingWait', { defaultValue: 'This takes a few seconds.' })}
            </Typography>
        </Box>
    );

    const optionCard = (opt: QuizOption) => {
        const isCorrect = item && opt.id === item.correctId;
        const isPicked = picked === opt.id;
        let bc = borderColor.view, sh = 'none';
        if (picked) {
            if (isCorrect) { bc = theme.palette.success.main; sh = `0 0 0 3px ${alpha(theme.palette.success.main, 0.18)}`; }
            else if (isPicked) { bc = theme.palette.error.main; sh = `0 0 0 3px ${alpha(theme.palette.error.main, 0.18)}`; }
        }
        return (
            <Box
                key={opt.id} component="button" disabled={!!picked}
                onClick={() => handlePick(opt.id)}
                sx={{ p: 0.75, background: '#fff', cursor: picked ? 'default' : 'pointer',
                      border: `2px solid ${bc}`, boxShadow: sh, borderRadius: radius.sm,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 130,
                      '&:hover': picked ? {} : { borderColor: theme.palette.primary.main } }}
            >
                <img src={svgUri(opt.svg)} alt="" style={{ maxWidth: '100%', maxHeight: 200, height: 'auto' }} />
            </Box>
        );
    };

    const quizBody = () => {
        if (!quiz) return generating;
        if (quiz.items.length === 0) {
            return (
                <Box sx={{ p: 2 }}>
                    <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                        {t('quiz.noQuestions', { defaultValue: 'No chart in this session has enough look-alikes to ask about yet. Make a few more charts and try again.' })}
                    </Typography>
                </Box>
            );
        }
        if (finished) {
            const missCount = answers.length - correctCount;
            return (
                <Box sx={{ p: 1.5 }}>
                    <Typography sx={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>
                        {correctCount}
                        <Typography component="span" sx={{ fontSize: 14, color: 'text.disabled', fontWeight: 500 }}>
                            {' '}/ {quiz.items.length} {t('quiz.correctSuffix', { defaultValue: 'correct' })}
                        </Typography>
                    </Typography>
                    <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, mb: 1 }}>
                        {missCount === 0
                            ? t('quiz.noMisses', { defaultValue: 'You recognized every chart.' })
                            : missCount === 1
                                ? t('quiz.missesOne', { defaultValue: '1 miss — the look-alike that fooled you is listed below.' })
                                : t('quiz.missesMany', { count: missCount, defaultValue: `${missCount} misses — the look-alikes that fooled you are listed below.` })}
                    </Typography>
                    <Box sx={{ overflowX: 'auto' }}>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>#</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colChart', { defaultValue: 'Chart' })}</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colResult', { defaultValue: 'Result' })}</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colChosen', { defaultValue: 'If missed: look-alike chosen' })}</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {answers.map(a => (
                                    <TableRow key={a.n}>
                                        <TableCell sx={{ fontSize: 11, px: 0.5 }}>{a.n}</TableCell>
                                        <TableCell sx={{ fontSize: 11, px: 0.5 }}>{a.title}</TableCell>
                                        <TableCell sx={{ fontSize: 11, px: 0.5 }}>
                                            {a.correct
                                                ? <CheckCircleOutlineIcon sx={{ fontSize: 14, color: 'success.main' }} />
                                                : <HighlightOffIcon sx={{ fontSize: 14, color: 'error.main' }} />}
                                        </TableCell>
                                        <TableCell sx={{ fontSize: 11, px: 0.5, color: 'text.secondary' }}>
                                            {a.correct ? '—' : `${a.label ?? ''} (${a.specDist}, ${a.dataDist})`}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </Box>
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 1, flexWrap: 'wrap' }}>
                        <Button size="small" startIcon={<DownloadIcon sx={{ fontSize: 15 }} />} onClick={handleDownload} sx={{ fontSize: 12, textTransform: 'none' }}>
                            {t('quiz.download', { defaultValue: 'Download answers' })}
                        </Button>
                        <Button size="small" startIcon={<ReplayIcon sx={{ fontSize: 15 }} />}
                            onClick={() => { setIndex(0); setAnswers([]); setPicked(null); setFinished(false); }}
                            sx={{ fontSize: 12, textTransform: 'none' }}>
                            {t('quiz.again', { defaultValue: 'Take it again' })}
                        </Button>
                    </Box>
                </Box>
            );
        }
        const chosen = picked ? item!.options.find(o => o.id === picked) : undefined;
        const gotIt = picked === item!.correctId;
        return (
            <Box sx={{ p: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <LinearProgress variant="determinate" value={(100 * index) / quiz.items.length}
                        sx={{ flex: 1, height: 5, borderRadius: 99 }} />
                    <Typography sx={{ fontSize: 11, color: 'text.disabled', whiteSpace: 'nowrap' }}>
                        {index + 1} / {quiz.items.length}
                    </Typography>
                </Box>
                <Typography sx={{ fontSize: 12.5, mb: 1 }}>
                    {t('quiz.questionPrompt', { seconds: secs(item!.focusMs),
                        defaultValue: `Which of these did you make? You spent about ${secs(item!.focusMs)}s on it.` })}
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                    {options.map(optionCard)}
                </Box>
                <Typography sx={{ fontSize: 12, mt: 1, minHeight: 32, color: gotIt ? 'success.main' : 'error.main' }}>
                    {picked
                        ? (gotIt
                            ? t('quiz.verdictCorrect', { defaultValue: 'Correct — that is the chart from your session.' })
                            : t('quiz.verdictWrong', { form: chosen?.specDist, values: chosen?.dataDist,
                                defaultValue: `Not this one — it is a look-alike (form ${chosen?.specDist}, values ${chosen?.dataDist}). The real chart is outlined in green.` }))
                        : ''}
                </Typography>
                <Button size="small" variant="contained" disabled={!picked} onClick={handleNext} sx={{ fontSize: 12, textTransform: 'none' }}>
                    {index + 1 >= quiz.items.length
                        ? t('quiz.seeResults', { defaultValue: 'See results' })
                        : t('quiz.next', { defaultValue: 'Next' })}
                </Button>
            </Box>
        );
    };

    // ── author mode ──────────────────────────────────────────────────────

    const lureCard = (lure: AuthoredLure) => (
        <Box key={lure.id} sx={{ border: `1px solid ${borderColor.view}`,
                borderTop: `3px solid ${METHOD_COLOR[lure.method]}`,
                borderRadius: radius.sm, p: 0.75, background: '#fff', opacity: lure.quizEligible ? 1 : 0.75 }}>
            <img src={svgUri(lure.svg)} alt="" style={{ maxWidth: '100%', maxHeight: 190, height: 'auto', display: 'block', margin: '0 auto' }} />
            <Typography sx={{ fontSize: 11.5, mt: 0.5, fontWeight: 500 }}>{lure.label}</Typography>
            <Box sx={{ display: 'flex', gap: 1, mt: 0.25, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 10.5, color: 'text.secondary' }}>
                <span>{t('quiz.form', { defaultValue: 'form' })} <b>{lure.specDist}</b></span>
                <span>{t('quiz.values', { defaultValue: 'values' })} <b>{lure.dataDist}</b></span>
                {lure.dataDetail.order > 0 && <span>{t('quiz.order', { defaultValue: 'order' })} <b>{lure.dataDetail.order}</b></span>}
            </Box>
            {/* what the method actually did */}
            <Box component="ul" sx={{ listStyle: 'none', pl: 0, my: 0.5, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 10 }}>
                {lure.edits.map((e, i) => (
                    <Box component="li" key={i} sx={{ color: 'text.secondary' }}>
                        <Box component="span" sx={{ color: METHOD_COLOR[lure.method], fontWeight: 700 }}>{e.op}</Box>
                        {' '}{e.detail}
                        <Box component="span" sx={{ float: 'right', color: 'text.disabled' }}>+{e.cost}</Box>
                    </Box>
                ))}
                {lure.dataEditNote && (
                    <Box component="li" sx={{ color: 'text.secondary' }}>
                        <Box component="span" sx={{ color: METHOD_COLOR[lure.method], fontWeight: 700 }}>DATA</Box>{' '}{lure.dataEditNote}
                    </Box>
                )}
            </Box>
            {(lure.dataDetail.rank > 0 || lure.dataDetail.magnitude > 0 || lure.dataDetail.label > 0) && (
                <Typography sx={{ fontSize: 10, color: 'text.disabled', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    rank {lure.dataDetail.rank} · magnitude {lure.dataDetail.magnitude} · label {lure.dataDetail.label}
                </Typography>
            )}
            <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 0.5 }}>{lure.rationale}</Typography>
            {!lure.quizEligible && (
                <Chip size="small" label={t('quiz.notInQuiz', { defaultValue: 'not used in the quiz' })}
                    sx={{ mt: 0.5, height: 18, fontSize: 9.5 }} />
            )}
        </Box>
    );

    const authorBody = () => {
        if (!quiz) return generating;
        const charts = quiz.ranked;
        if (charts.length === 0) {
            return <Box sx={{ p: 2 }}><Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                {t('quiz.noCharts', { defaultValue: 'This session has no charts to inspect.' })}
            </Typography></Box>;
        }
        return (
            <Box sx={{ p: 1 }}>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', px: 0.5, mb: 0.75 }}>
                    {t('quiz.authorIntro', {
                        defaultValue: 'Every look-alike each method can make, with what it changed. Open a chart to build them. Nothing to answer here.',
                    })}
                </Typography>
                {charts.map(c => {
                    const open = expanded.has(c.chartId);
                    const state = authored[c.chartId];
                    const inQuiz = quiz.items.some(i => i.chartId === c.chartId);
                    return (
                        <Box key={c.chartId} sx={{ borderBottom: `1px solid ${borderColor.view}` }}>
                            <Box component="button" onClick={() => toggleAuthorChart(c.chartId)}
                                sx={{ display: 'flex', alignItems: 'center', gap: 0.5, width: '100%', textAlign: 'left',
                                      background: 'none', border: 'none', cursor: 'pointer', py: 0.75, px: 0.5,
                                      '&:hover': { background: alpha(theme.palette.primary.main, 0.04) } }}>
                                {open ? <ExpandMoreIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                                      : <ChevronRightIcon sx={{ fontSize: 16, color: 'text.disabled' }} />}
                                <Typography sx={{ fontSize: 12, flex: 1, minWidth: 0 }}>{c.title}</Typography>
                                <Typography sx={{ fontSize: 10.5, color: 'text.disabled', whiteSpace: 'nowrap' }}>
                                    {secs(c.focusMs)}s
                                </Typography>
                                {!inQuiz && (
                                    <Tooltip title={t('quiz.notAsked', { defaultValue: 'not asked in the quiz' })}>
                                        <Chip size="small" label="—" sx={{ height: 16, fontSize: 9 }} />
                                    </Tooltip>
                                )}
                            </Box>
                            <Collapse in={open} unmountOnExit>
                                <Box sx={{ pb: 1.5, px: 0.5 }}>
                                    {state === 'loading' && (
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
                                            <CircularProgress size={14} />
                                            <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                                                {t('quiz.buildingLures', { defaultValue: 'Building the look-alikes for this chart…' })}
                                            </Typography>
                                        </Box>
                                    )}
                                    {state === 'failed' && (
                                        <Typography sx={{ fontSize: 11.5, color: 'error.main', py: 1 }}>
                                            {t('quiz.chartFailed', { defaultValue: 'This chart could not be rendered, so no look-alikes could be made.' })}
                                        </Typography>
                                    )}
                                    {state && state !== 'loading' && state !== 'failed' && (
                                        <>
                                            <Box sx={{ mb: 1 }}>
                                                <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'primary.main', mb: 0.5 }}>
                                                    {t('quiz.theRealChart', { defaultValue: 'The chart you made' })}
                                                </Typography>
                                                <Box sx={{ border: `2px solid ${theme.palette.primary.main}`, borderRadius: radius.sm, p: 0.75, background: '#fff' }}>
                                                    <img src={svgUri(state.originalSvg)} alt=""
                                                        style={{ maxWidth: '100%', maxHeight: 210, height: 'auto', display: 'block', margin: '0 auto' }} />
                                                </Box>
                                            </Box>
                                            {state.byMethod.map(group => (
                                                <Box key={group.method} sx={{ mb: 1.25 }}>
                                                    <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em',
                                                        color: METHOD_COLOR[group.method], mb: 0.5 }}>
                                                        {METHOD_LABEL[group.method]} · {group.lures.length}
                                                    </Typography>
                                                    <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
                                                        {group.lures.map(lureCard)}
                                                    </Box>
                                                </Box>
                                            ))}
                                            {state.rejected.length > 0 && (
                                                <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                                                    {t('quiz.rejectedCount', { count: state.rejected.length,
                                                        defaultValue: `${state.rejected.length} candidate(s) rejected by the render guard:` })}
                                                    {' '}
                                                    {state.rejected.map(r => `${r.label} (${r.reason})`).join('; ')}
                                                </Typography>
                                            )}
                                        </>
                                    )}
                                </Box>
                            </Collapse>
                        </Box>
                    );
                })}
            </Box>
        );
    };

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {header}
            {tabs}
            <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                {error
                    ? <Box sx={{ p: 2 }}><Typography sx={{ fontSize: 13, color: 'error.main' }}>{error}</Typography></Box>
                    : mode === 'quiz' ? quizBody() : authorBody()}
            </Box>
        </Box>
    );
};
