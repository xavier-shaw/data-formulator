// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * QuizPanel — the memory quiz, one tab per part.
 *
 *  • 1 · Attributes   — which columns do you remember exploring?
 *  • 2 · Combinations — which of them did you look at together? Their part-1
 *                       attributes lead the palette; the groups they build are
 *                       scored against the field sets their charts encoded.
 *  • 3 · Charts       — which of these four did you make? A miss records how far
 *                       the chosen look-alike sat from the real chart, which is
 *                       what says *what* was misremembered.
 *  • 4 · Path         — the reasoning trace: rebuild the analysis map, or walk
 *                       the thread (two piloted forms).
 *  • Results          — scores of whatever has been answered so far + download.
 *  • Author           — inspect, nothing to answer: every method's look-alikes
 *                       with their operations and distances, built per chart on
 *                       expand (a whole session at once is hundreds of renders).
 *
 * Every tab is DIRECTLY reachable — a pilot can jump to part 4 without
 * answering the questions — but the guided flow is preserved: each part's
 * continue button advances to the next tab, and ticks mark answered parts.
 * The ordering the tabs suggest still matters for a real run: 1 before 2 (the
 * groups are built over the attributes just named), 2 before 3 (the chart
 * options name both), 4 before Results (the results table reveals the true
 * order and lineage), and within 4, form A before form B.
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
    generateQuizForSession, buildQuizResult, authorViewForChart, loadRecallMaterial,
    GeneratedQuiz, QuizAnswer,
} from '../app/quizGeneration';
import {
    ComboAnswer, ComboGroup, RecallAnswer, RecallMaterial, buildComboAnswer, buildRecallAnswer,
} from '../app/fieldRecall';
import { FieldRecallStep } from './FieldRecallStep';
import { ComboRecallStep } from './ComboRecallStep';
import { loadTraceMaterial, TraceMaterial, TraceTreeAnswer } from '../app/reasoningTrace';
import { TraceTreeStep } from './TraceTreeStep';
import { ProvenanceStep } from './ProvenanceStep';
import { ProvenanceAnswer, buildProvenanceMaterial } from '../app/provenanceQuiz';
import { QuizItem, QuizOption, AuthoredChart, AuthoredLure, Method, stripSvgText, DEFAULT_SEED } from '../lib/quiz-distractors';

interface QuizPanelProps {
    sessionId: string;
    sessionName: string;
    /** live Redux slices, passed when the panel targets the active session */
    liveState?: unknown;
    /**
     * How much room there is. `page` (the default) centres the content and lets
     * charts grow; `narrow` keeps everything compact for a docked column.
     */
    layout?: 'page' | 'narrow';
    onClose: () => void;
}

const METHOD_LABEL: Record<Method, string> = {
    'form': 'Form — drawn differently',
    'content': 'Content — data says something else',
    'combined': 'Combined — both at once',
};

/** One accent per axis so a lure's origin reads at a glance. */
const METHOD_COLOR: Record<Method, string> = {
    'form': '#C4652A',
    'content': '#2E8B6B',
    'combined': '#8A63BF',
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

export const QuizPanel: FC<QuizPanelProps> = ({ sessionId, sessionName, liveState, layout = 'page', onClose }) => {
    const { t } = useTranslation();
    const theme = useTheme();

    // One place to tune for the two widths, so the JSX stays free of
    // layout conditionals.
    const wide = layout === 'page';
    const size = wide
        ? { maxW: 1240, optionCols: '1fr 1fr', optionH: 380, optionMin: 300, lureCols: 'repeat(auto-fill, minmax(300px, 1fr))', lureH: 260, pad: 2.5 }
        : { maxW: 'none', optionCols: '1fr 1fr', optionH: 200, optionMin: 130, lureCols: '1fr 1fr', lureH: 190, pad: 1.5 };

    // Every part is a tab, directly reachable — a pilot can jump to part 4
    // without answering the chart questions. The guided flow still exists:
    // each part's continue button advances to the next tab.
    type PanelTab = 'recall' | 'combos' | 'charts' | 'trace' | 'results' | 'author';
    const [tab, setTab] = useState<PanelTab>('recall');

    // The live slices arrive as a fresh object on every store tick — chart-usage
    // telemetry alone dispatches every 15s while a chart is focused — so they
    // are read through a ref and the builds below key on WHICH CHARTS exist
    // instead. Keying on the object itself rebuilt the quiz under a participant
    // mid-question, throwing them back to the first question of every part.
    const liveStateRef = useRef(liveState);
    liveStateRef.current = liveState;
    const liveKey = useMemo(() => {
        const s = liveState as { charts?: { id: string }[] } | undefined;
        return s ? (s.charts ?? []).map(c => c.id).join(',') : 'stored';
    }, [liveState]);

    // ── shared generation (quiz mode drives it; author mode reuses the session) ──
    const [quiz, setQuiz] = useState<GeneratedQuiz | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
    const runIdRef = useRef(0);

    // ── parts 1 and 2: the attributes, then the combinations over them ──
    // Kept OUTSIDE the generation effect's reset list on purpose: that effect
    // re-fires whenever the live slices tick, and wiping a participant's fields
    // or groups mid-answer would be unrecoverable.
    const [recallMaterial, setRecallMaterial] = useState<RecallMaterial | null>(null);
    const [recallFields, setRecallFields] = useState<string[]>([]);
    const [recallAnswer, setRecallAnswer] = useState<RecallAnswer | null>(null);
    /** the session's fields could not be read — skip parts 1 and 2 rather than stall on them */
    const [recallFailed, setRecallFailed] = useState(false);
    const recallStartRef = useRef<number>(Date.now());
    const [comboGroups, setComboGroups] = useState<ComboGroup[]>([]);
    const [comboAnswer, setComboAnswer] = useState<ComboAnswer | null>(null);
    const comboStartRef = useRef<number>(Date.now());

    // ── quiz state ──
    // Each question runs in three phases:
    //   blind    — options with every label and tick value stripped; pick on shape
    //   labeled  — the same options with their text shown; keep or change the pick
    //   revealed — the answer, and how far the chosen look-alike was
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<QuizAnswer[]>([]);
    const [phase, setPhase] = useState<'blind' | 'labeled' | 'revealed'>('blind');
    const [blindPick, setBlindPick] = useState<string | null>(null);
    const [picked, setPicked] = useState<string | null>(null);
    const [finished, setFinished] = useState(false);

    // ── part 4: reasoning trace ──
    // Two prototype FORMS over the same material; the chooser lets a pilot
    // participant try either (or both — the second run is practice, and the
    // answer file records each form separately).
    const [traceStage, setTraceStage] = useState<'choose' | 'tree' | 'provenance'>('choose');
    const [traceMaterial, setTraceMaterial] = useState<TraceMaterial | 'loading' | 'failed' | null>(null);
    const [traceTreeAnswer, setTraceTreeAnswer] = useState<TraceTreeAnswer | null>(null);
    const [traceProvAnswer, setTraceProvAnswer] = useState<ProvenanceAnswer | null>(null);

    // ── author state: one entry per chart, filled in on expand ──
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [authored, setAuthored] = useState<Record<string, AuthoredChart | 'loading' | 'failed'>>({});

    useEffect(() => {
        const runId = ++runIdRef.current;
        setQuiz(null); setError(null); setIndex(0); setAnswers([]);
        setPhase('blind'); setBlindPick(null); setPicked(null);
        setFinished(false); setExpanded(new Set()); setAuthored({});
        setTraceStage('choose'); setTraceMaterial(null);
        setTraceTreeAnswer(null); setTraceProvAnswer(null);
        (async () => {
            try {
                const generated = await generateQuizForSession({
                    sessionId, sessionName, liveState: liveStateRef.current,
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
        // `t` is deliberately absent: i18next hands back a new function when a
        // namespace finishes loading, which would restart the quiz.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, sessionName, liveKey]);

    // Back to part 1 when the panel is pointed at a different session — but
    // ONLY then. The generation effect above re-fires on live-slice ticks, and
    // yanking the tab away mid-part would be hostile.
    useEffect(() => { setTab('recall'); }, [sessionId]);

    // Part 2 is timed from when it is opened, not from when its material loaded
    // — the material is part 1's, and timing from there would charge part 2 for
    // the whole of part 1. Every entry re-stamps it, so `seconds` reports the
    // visit the answer was confirmed in rather than the wall clock since first
    // sight of the tab.
    useEffect(() => { if (tab === 'combos') comboStartRef.current = Date.now(); }, [tab]);

    // The recall step needs no rendering, so it loads immediately and the
    // participant answers it while the look-alike charts are still being made.
    useEffect(() => {
        let live = true;
        loadRecallMaterial({ sessionId, liveState: liveStateRef.current })
            .then(m => {
                if (!live) return;
                setRecallMaterial(m);
                // Time the step from when it becomes answerable, not from mount.
                recallStartRef.current = Date.now();
            })
            .catch(e => {
                console.warn('[quiz] recall material could not be read:', e?.message);
                // Otherwise step 1 would sit on its progress bar with no way out.
                if (live) setRecallFailed(true);
            });
        return () => { live = false; };
    }, [sessionId, liveKey]);

    // Form B's items, derived from the same trace material form A is scored
    // against — seeded, so re-entering the form does not reshuffle the moves.
    const provMaterial = useMemo(
        () => (traceMaterial && traceMaterial !== 'loading' && traceMaterial !== 'failed'
            ? buildProvenanceMaterial(traceMaterial)
            : null),
        [traceMaterial]);

    const item = quiz?.items[index];
    const options = useMemo(() => (item ? shuffledOptions(item) : []), [item]);
    const correctCount = answers.filter(a => a.correct).length;

    /** Select an option. Nothing is scored until the phase is confirmed. */
    const handlePick = useCallback((optionId: string) => {
        if (phase === 'revealed') return;
        setPicked(optionId);
    }, [phase]);

    /** Step 1 → step 2: lock in the shape-only choice, then show the text. */
    const handleConfirmBlind = useCallback(() => {
        if (!picked) return;
        setBlindPick(picked);
        setPhase('labeled');
        // `picked` carries over, so step 2 opens on the same choice and the
        // reader decides whether the labels change their mind.
    }, [picked]);

    /** Step 2 → reveal: record both picks and score the final one. */
    const handleConfirmFinal = useCallback(() => {
        if (!item || !picked || !blindPick) return;
        const chosen = item.options.find(o => o.id === picked);
        const correct = picked === item.correctId;
        setAnswers(prev => [...prev, {
            n: index + 1, chartId: item.chartId, title: item.title, chartType: item.chartType,
            blindPickedId: blindPick,
            blindCorrect: blindPick === item.correctId,
            correct,
            pickedId: picked,
            changedAfterText: picked !== blindPick,
            method: correct ? undefined : chosen?.method,
            op: correct ? undefined : chosen?.op,
            label: correct ? undefined : chosen?.label,
            specDist: correct ? undefined : chosen?.specDist,
            dataDist: correct ? undefined : chosen?.dataDist,
        }]);
        setPhase('revealed');
    }, [item, picked, blindPick, index]);

    const handleNext = useCallback(() => {
        if (!quiz) return;
        // After the last question the guided flow moves on to part 4.
        if (index + 1 >= quiz.items.length) { setFinished(true); setTab('trace'); return; }
        setIndex(i => i + 1);
        setPhase('blind'); setBlindPick(null); setPicked(null);
    }, [quiz, index]);

    /** Restart part 3 only; the other parts' answers are kept. */
    const handleRetake = useCallback(() => {
        setIndex(0); setAnswers([]); setPhase('blind'); setBlindPick(null); setPicked(null);
        setFinished(false); setTraceStage('choose'); setTab('charts');
    }, []);

    /** Part 1's continue: freeze (or re-freeze) the named attributes and move on.
     *  Revisiting the tab and pressing it again simply updates the answer. */
    const handleFinishRecall = useCallback(() => {
        if (!recallMaterial) return;
        setRecallAnswer(buildRecallAnswer(recallFields, recallMaterial, Date.now() - recallStartRef.current));
        setTab('combos');
    }, [recallFields, recallMaterial]);

    /** Part 2's continue: freeze the combinations and move on to the charts.
     *  Empty groups are dropped — they are scaffolding, not an answer. */
    const handleFinishCombos = useCallback(() => {
        if (!recallMaterial) return;
        const groups = comboGroups.filter(g => g.length > 0);
        setComboAnswer(buildComboAnswer(groups, recallMaterial, Date.now() - comboStartRef.current));
        setTab('charts');
    }, [comboGroups, recallMaterial]);

    /** Enter one of the trace forms, building the material the first time. */
    const handleEnterTrace = useCallback((form: 'tree' | 'provenance') => {
        setTraceStage(form);
        if (traceMaterial && traceMaterial !== 'failed') return;   // built or in flight
        setTraceMaterial('loading');
        loadTraceMaterial({ sessionId, liveState: liveStateRef.current })
            .then(m => setTraceMaterial(m))
            .catch(e => {
                console.warn('[quiz] trace material could not be built:', e?.message);
                setTraceMaterial('failed');
            });
    }, [traceMaterial, sessionId]);

    const handleDownload = useCallback(() => {
        const completedAt = new Date().toISOString();
        // Downloadable even when generation failed: parts 1 and 2 are then the
        // only thing the session produced, and losing them would be the worst of
        // the two failures.
        const base = quiz
            ? buildQuizResult(quiz, answers, completedAt, recallAnswer ?? undefined, comboAnswer ?? undefined)
            : {
                sessionId, sessionName, seed: DEFAULT_SEED, completedAt,
                total: 0, correct: 0, answers: [],
                recall: recallAnswer ?? undefined, combos: comboAnswer ?? undefined,
            };
        const result = (traceTreeAnswer || traceProvAnswer)
            ? { ...base, trace: { tree: traceTreeAnswer ?? undefined, provenance: traceProvAnswer ?? undefined } }
            : base;
        const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `quiz-${sessionName || sessionId}.json`; a.click();
        URL.revokeObjectURL(url);
    }, [quiz, answers, recallAnswer, comboAnswer, traceTreeAnswer, traceProvAnswer, sessionName, sessionId]);

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

    // A tick marks parts that already have an answer, so a pilot jumping
    // around can see what is still open.
    const tick = (done: boolean, label: string) => (done ? `${label} ✓` : label);
    const tabs = (
        <Tabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            sx={{ minHeight: 34, borderBottom: `1px solid ${borderColor.view}`, flexShrink: 0,
                  '& .MuiTab-root': { minHeight: 34, fontSize: 12, textTransform: 'none', py: 0, minWidth: 0 } }}
        >
            <Tab value="recall" label={tick(!!recallAnswer, t('quiz.tabRecall', { defaultValue: '1 · Attributes' }))} />
            <Tab value="combos" label={tick(!!comboAnswer, t('quiz.tabCombos', { defaultValue: '2 · Combinations' }))} />
            <Tab value="charts" label={tick(finished, t('quiz.tabCharts', { defaultValue: '3 · Charts' }))} />
            <Tab value="trace" label={tick(!!(traceTreeAnswer || traceProvAnswer), t('quiz.tabTrace', { defaultValue: '4 · Path' }))} />
            <Tab value="results" label={t('quiz.tabResults', { defaultValue: 'Results' })} />
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
        const revealed = phase === 'revealed';
        const isCorrect = item && opt.id === item.correctId;
        const isPicked = picked === opt.id;
        const wasBlindPick = blindPick === opt.id;

        // Selecting is a neutral highlight; right/wrong colour appears only once
        // the final answer is confirmed, so step 2 is a real second judgement
        // rather than a correction of feedback already given.
        let bc = borderColor.view, sh = 'none';
        if (revealed) {
            if (isCorrect) { bc = theme.palette.success.main; sh = `0 0 0 3px ${alpha(theme.palette.success.main, 0.18)}`; }
            else if (isPicked) { bc = theme.palette.error.main; sh = `0 0 0 3px ${alpha(theme.palette.error.main, 0.18)}`; }
        } else if (isPicked) {
            bc = theme.palette.primary.main; sh = `0 0 0 3px ${alpha(theme.palette.primary.main, 0.16)}`;
        }

        return (
            <Box key={opt.id} sx={{ position: 'relative', display: 'flex' }}>
                <Box
                    component="button" disabled={revealed}
                    onClick={() => handlePick(opt.id)}
                    aria-pressed={isPicked}
                    sx={{ flex: 1, p: 0.75, background: '#fff', cursor: revealed ? 'default' : 'pointer',
                          border: `2px solid ${bc}`, boxShadow: sh, borderRadius: radius.sm,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: size.optionMin,
                          transition: 'border-color .12s, box-shadow .12s',
                          '&:hover': revealed ? {} : { borderColor: theme.palette.primary.main } }}
                >
                    <img
                        // Step 1 shows the same render with its text removed, so
                        // the shape is judged before the labels can be read.
                        src={svgUri(phase === 'blind' ? stripSvgText(opt.svg) : opt.svg)}
                        alt=""
                        style={{ maxWidth: '100%', maxHeight: size.optionH, height: 'auto' }}
                    />
                </Box>
                {/* In step 2 and after, mark what shape alone had suggested. */}
                {phase !== 'blind' && wasBlindPick && (
                    <Chip
                        size="small"
                        label={t('quiz.firstChoice', { defaultValue: 'your first choice' })}
                        sx={{ position: 'absolute', top: 6, left: 6, height: 18, fontSize: 9.5,
                              backgroundColor: alpha(theme.palette.primary.main, 0.12), color: 'primary.main' }}
                    />
                )}
                {/* After the answer, name what each look-alike changed. The four
                    options are a 2×2 — original, A, B, A+B — and that only reads
                    as one if the three lures are labelled together. */}
                {revealed && opt.method && (
                    <Chip
                        size="small"
                        label={`${opt.method === 'combined' ? 'A + B' : opt.method === 'form' ? 'A' : 'B'} · ${opt.label}`}
                        sx={{ position: 'absolute', bottom: 6, left: 6, maxWidth: 'calc(100% - 12px)', height: 18,
                              fontSize: 9.5, backgroundColor: alpha(METHOD_COLOR[opt.method], 0.14),
                              color: METHOD_COLOR[opt.method] }}
                    />
                )}
            </Box>
        );
    };

    /**
     * How the named attributes scored. Shown only here, on the results screen:
     * naming the right attributes earlier would give away the chart questions.
     */
    const recallSummary = (recall: RecallAnswer) => {
        const s = recall.score;
        const line = (label: string, items: string[], color: string) => (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', mb: 0.25 }}>
                <Typography sx={{ fontSize: 11, width: 116, flexShrink: 0, color: 'text.secondary' }}>{label}</Typography>
                <Typography sx={{ fontSize: 11, color, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    {items.length ? items.join(', ') : '—'}
                </Typography>
            </Box>
        );
        return (
            <Box sx={{ mb: 1.5, p: 1.25, background: alpha(theme.palette.primary.main, 0.04), borderRadius: radius.sm }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>
                    {t('quiz.recallResultTitle', {
                        hits: s.fieldHits.length, total: s.fieldHits.length + s.fieldMisses.length,
                        defaultValue: `Attributes you recalled: ${s.fieldHits.length} of ${s.fieldHits.length + s.fieldMisses.length}`,
                    })}
                </Typography>
                {line(t('quiz.recallHit', { defaultValue: 'recalled' }), s.fieldHits, theme.palette.success.main)}
                {line(t('quiz.recallMissed', { defaultValue: 'missed' }), s.fieldMisses, theme.palette.warning.dark)}
                {line(t('quiz.recallExtra', { defaultValue: 'never charted' }), s.fieldIntrusions, theme.palette.text.disabled)}
                <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 0.5 }}>
                    {t('quiz.recallNamedCount', { named: recall.fields.length, seconds: recall.seconds,
                        defaultValue: `${recall.fields.length} attribute(s) named in ${recall.seconds}s.` })}
                </Typography>
            </Box>
        );
    };

    /**
     * How the combinations scored. Same shape as `recallSummary`, and shown in
     * the same place and for the same reason: naming the real combinations any
     * earlier would answer the chart questions.
     */
    const comboSummary = (combos: ComboAnswer) => {
        const s = combos.score;
        const set = (fields: string[]) => fields.join(' × ');
        const line = (label: string, rows: string[], color: string) => (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'baseline', mb: 0.25 }}>
                <Typography sx={{ fontSize: 11, width: 116, flexShrink: 0, color: 'text.secondary' }}>{label}</Typography>
                <Typography sx={{ fontSize: 11, color, fontFamily: 'ui-monospace, Menlo, monospace' }}>
                    {rows.length ? rows.join(';  ') : '—'}
                </Typography>
            </Box>
        );
        return (
            <Box sx={{ mb: 1.5, p: 1.25, background: alpha(theme.palette.secondary.main, 0.05), borderRadius: radius.sm }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>
                    {t('quiz.comboResultTitle', {
                        hits: s.hits.length, total: s.hits.length + s.misses.length,
                        defaultValue: `Combinations you recalled: ${s.hits.length} of ${s.hits.length + s.misses.length}`,
                    })}
                </Typography>
                {line(t('quiz.comboHit', { defaultValue: 'recalled' }), s.hits.map(set), theme.palette.success.main)}
                {/* A near miss says HOW it was misremembered, so it is reported
                    next to the combination it was reaching for. */}
                {line(t('quiz.comboNear', { defaultValue: 'nearly' }),
                    s.partial.map(p => `${set(p.group)} → ${set(p.closest)}`), theme.palette.warning.dark)}
                {line(t('quiz.comboMissed', { defaultValue: 'missed' }), s.misses.map(set), theme.palette.warning.dark)}
                {line(t('quiz.comboExtra', { defaultValue: 'never charted' }), s.intrusions.map(set), theme.palette.text.disabled)}
                <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 0.5 }}>
                    {t('quiz.comboNamedCount', { groups: combos.groups.length, seconds: combos.seconds,
                        defaultValue: `${combos.groups.length} combination(s) built in ${combos.seconds}s.` })}
                </Typography>
            </Box>
        );
    };

    // ── part 4: reasoning trace ──────────────────────────────────────────

    const traceBackButton = (
        <Button size="small" onClick={() => setTraceStage('choose')} sx={{ fontSize: 11, textTransform: 'none', color: 'text.secondary' }}>
            {t('quiz.traceBack', { defaultValue: '← Back to the two forms' })}
        </Button>
    );

    const traceBody = () => {
        const partLabel = (
            <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.07em', color: 'primary.main', px: 1.5, pt: 1.5 }}>
                {t('quiz.partFour', { defaultValue: 'Part 4 of 4 — your analysis path' })}
            </Typography>
        );

        if (traceStage === 'choose') {
            const anyDone = !!(traceTreeAnswer || traceProvAnswer);
            const formCard = (form: 'tree' | 'provenance', title: string, desc: string, done: boolean) => (
                <Box component="button" onClick={() => handleEnterTrace(form)}
                    sx={{ textAlign: 'left', p: 1.5, background: '#fff', cursor: 'pointer',
                          border: `2px solid ${done ? theme.palette.success.main : borderColor.view}`, borderRadius: radius.sm,
                          transition: 'border-color .12s',
                          '&:hover': { borderColor: theme.palette.primary.main } }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
                        <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{title}</Typography>
                        {done && <CheckCircleOutlineIcon sx={{ fontSize: 15, color: 'success.main' }} />}
                    </Box>
                    <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>{desc}</Typography>
                    {done && (
                        <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 0.5 }}>
                            {t('quiz.traceRedo', { defaultValue: 'Answered — open again to redo it.' })}
                        </Typography>
                    )}
                </Box>
            );
            return (
                <>
                    {partLabel}
                    <Box sx={{ p: 1.5 }}>
                        <Typography sx={{ fontSize: 12.5, mb: 1 }}>
                            {t('quiz.traceChooseIntro', { defaultValue:
                                'Last part: how well do you remember the PATH of your analysis — which chart led to which, and why? Two forms of this question are being piloted; pick one (you can try both).' })}
                        </Typography>
                        <Box sx={{ display: 'grid', gridTemplateColumns: wide ? '1fr 1fr' : '1fr', gap: 1.5, mb: 1.5 }}>
                            {formCard('tree',
                                t('quiz.traceFormTree', { defaultValue: 'A — Rebuild the map' }),
                                t('quiz.traceFormTreeDesc', { defaultValue:
                                    'Your charts, shuffled. Drag them onto a canvas and draw arrows to recreate how one chart led to the next.' }),
                                !!traceTreeAnswer)}
                            {formCard('provenance',
                                t('quiz.traceFormProv', { defaultValue: 'B — What came next?' }),
                                t('quiz.traceFormProvDesc', { defaultValue:
                                    'A chart you made, and three candidates for the one that followed it. Pick the right one, then say why you made that move.' }),
                                !!traceProvAnswer)}
                        </Box>
                        <Button size="small" variant={anyDone ? 'contained' : 'text'} onClick={() => setTab('results')}
                            sx={{ fontSize: 12, textTransform: 'none' }}>
                            {anyDone
                                ? t('quiz.traceContinue', { defaultValue: 'Continue to results' })
                                : t('quiz.traceSkip', { defaultValue: 'Skip this part' })}
                        </Button>
                    </Box>
                </>
            );
        }

        if (!traceMaterial || traceMaterial === 'loading') {
            return (
                <Box sx={{ p: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <CircularProgress size={14} />
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                        {t('quiz.traceBuilding', { defaultValue: 'Laying out your charts…' })}
                    </Typography>
                </Box>
            );
        }
        if (traceMaterial === 'failed') {
            return (
                <Box sx={{ p: 2 }}>
                    <Typography sx={{ fontSize: 12.5, color: 'error.main', mb: 1 }}>
                        {t('quiz.traceFailed', { defaultValue: 'The charts for this part could not be prepared.' })}
                    </Typography>
                    {traceBackButton}
                </Box>
            );
        }
        if (traceStage === 'tree' && traceMaterial.charts.length < 2) {
            return (
                <Box sx={{ p: 2 }}>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 1 }}>
                        {t('quiz.traceTooFew', { defaultValue: 'This session has fewer than two charts, so there is no map to rebuild.' })}
                    </Typography>
                    {traceBackButton}
                </Box>
            );
        }
        if (traceStage === 'provenance' && provMaterial && provMaterial.items.length === 0) {
            return (
                <Box sx={{ p: 2 }}>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 1 }}>
                        {t('quiz.provNoItems', { defaultValue:
                            'This session does not have enough charts to ask where one led to another.' })}
                    </Typography>
                    {traceBackButton}
                </Box>
            );
        }

        return (
            <>
                <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pt: 1.5 }}>
                    <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.07em', color: 'primary.main', flex: 1 }}>
                        {t('quiz.partFour', { defaultValue: 'Part 4 of 4 — your analysis path' })}
                    </Typography>
                    {traceBackButton}
                </Box>
                {traceStage === 'tree' ? (
                    // react-flow needs a real height; the panel's scroll container
                    // gives its children none.
                    <Box sx={{ height: wide ? '72vh' : 520, minHeight: 420 }}>
                        <TraceTreeStep material={traceMaterial} wide={wide}
                            onDone={a => { setTraceTreeAnswer(a); setTraceStage('choose'); }} />
                    </Box>
                ) : (
                    <ProvenanceStep material={provMaterial!} wide={wide}
                        onDone={a => { setTraceProvAnswer(a); setTraceStage('choose'); }} />
                )}
            </>
        );
    };

    // ── part 1: attribute recall ─────────────────────────────────────────

    const recallBody = () => {
        if (recallFailed) {
            return (
                <Box sx={{ p: 2 }}>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                        {t('quiz.recallUnavailable', { defaultValue: 'The attributes for this session could not be read — go on to the charts.' })}
                    </Typography>
                </Box>
            );
        }
        if (!recallMaterial) return generating;
        return (
            <>
                {/* "Part", not "Step": within a chart question, step 1/2 already
                    means shape-only vs with-text. */}
                <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.07em', color: 'primary.main', px: 1.5, pt: 1.5 }}>
                    {t('quiz.partOne', { defaultValue: 'Part 1 of 4 — the attributes' })}
                </Typography>
                {/* The tab is always revisitable; pressing continue again just
                    re-freezes the answer with the current selection. */}
                <FieldRecallStep
                    material={recallMaterial}
                    fields={recallFields}
                    onChange={setRecallFields}
                    onContinue={handleFinishRecall}
                    wide={wide}
                />
            </>
        );
    };

    // ── part 2: the combinations over those attributes ───────────────────

    const combosBody = () => {
        if (recallFailed) {
            return (
                <Box sx={{ p: 2 }}>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                        {t('quiz.recallUnavailable', { defaultValue: 'The attributes for this session could not be read — go on to the charts.' })}
                    </Typography>
                </Box>
            );
        }
        if (!recallMaterial) return generating;
        return (
            <>
                <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.07em', color: 'primary.main', px: 1.5, pt: 1.5 }}>
                    {t('quiz.partTwo', { defaultValue: 'Part 2 of 4 — the combinations' })}
                </Typography>
                {/* The LIVE part-1 selection, not the frozen answer: jumping
                    straight to this tab must still give a working step. */}
                <ComboRecallStep
                    material={recallMaterial}
                    recalled={recallFields}
                    groups={comboGroups}
                    onChange={setComboGroups}
                    onContinue={handleFinishCombos}
                    wide={wide}
                />
            </>
        );
    };

    // ── part 3: chart recognition ────────────────────────────────────────

    const chartsBody = () => {
        // Generation failed — said here; the results tab still downloads
        // whatever the other parts produced.
        if (error) {
            return (
                <Box sx={{ p: 1.5 }}>
                    <Typography sx={{ fontSize: 13, color: 'error.main' }}>{error}</Typography>
                </Box>
            );
        }
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
            return (
                <Box sx={{ p: 1.5 }}>
                    <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.07em', color: 'primary.main', mb: 0.75 }}>
                        {t('quiz.partThree', { defaultValue: 'Part 3 of 4 — the charts' })}
                    </Typography>
                    <Typography sx={{ fontSize: 12.5, mb: 1 }}>
                        {t('quiz.chartsDone', { count: quiz.items.length,
                            defaultValue: `All ${quiz.items.length} questions answered.` })}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                        <Button size="small" variant="contained" onClick={() => setTab('trace')} sx={{ fontSize: 12, textTransform: 'none' }}>
                            {t('quiz.goToTrace', { defaultValue: 'On to part 4' })}
                        </Button>
                        <Button size="small" onClick={() => setTab('results')} sx={{ fontSize: 12, textTransform: 'none' }}>
                            {t('quiz.seeResults', { defaultValue: 'See results' })}
                        </Button>
                        <Button size="small" startIcon={<ReplayIcon sx={{ fontSize: 15 }} />} onClick={handleRetake} sx={{ fontSize: 12, textTransform: 'none' }}>
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
                <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.07em', color: 'primary.main', mb: 0.75 }}>
                    {t('quiz.partThree', { defaultValue: 'Part 3 of 4 — the charts' })}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <LinearProgress variant="determinate" value={(100 * index) / quiz.items.length}
                        sx={{ flex: 1, height: 5, borderRadius: 99 }} />
                    <Typography sx={{ fontSize: 11, color: 'text.disabled', whiteSpace: 'nowrap' }}>
                        {index + 1} / {quiz.items.length}
                    </Typography>
                </Box>
                <Typography sx={{ fontSize: 12.5 }}>
                    {t('quiz.questionPrompt', { seconds: secs(item!.focusMs),
                        defaultValue: `Which of these did you make? You spent about ${secs(item!.focusMs)}s on it.` })}
                </Typography>
                {/* Which of the two steps this is, and what changes between them. */}
                <Typography sx={{ fontSize: 11.5, color: phase === 'blind' ? 'primary.main' : 'text.secondary', mb: 1 }}>
                    {phase === 'blind'
                        ? t('quiz.stepBlind', { defaultValue: 'Step 1 of 2 — labels and values are hidden. Go by the shape.' })
                        : phase === 'labeled'
                            ? t('quiz.stepLabeled', { defaultValue: 'Step 2 of 2 — the text is now shown. Keep your answer or change it.' })
                            : t('quiz.stepDone', { defaultValue: 'Answer recorded.' })}
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: size.optionCols, gap: wide ? 2 : 1 }}>
                    {options.map(optionCard)}
                </Box>
                <Typography sx={{ fontSize: 12, mt: 1, minHeight: 32, color: gotIt ? 'success.main' : 'error.main' }}>
                    {phase === 'revealed'
                        ? (gotIt
                            ? t('quiz.verdictCorrect', { defaultValue: 'Correct — that is the chart from your session.' })
                            : t('quiz.verdictWrong', { form: chosen?.specDist, values: chosen?.dataDist,
                                defaultValue: `Not this one — it is a look-alike (form ${chosen?.specDist}, values ${chosen?.dataDist}). The real chart is outlined in green.` }))
                        : ''}
                </Typography>
                {phase === 'revealed' && picked !== blindPick && (
                    <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mb: 1 }}>
                        {t('quiz.changedNote', { defaultValue: 'You changed your answer once the text appeared.' })}
                    </Typography>
                )}
                {phase === 'blind' && (
                    <Button size="small" variant="contained" disabled={!picked} onClick={handleConfirmBlind} sx={{ fontSize: 12, textTransform: 'none' }}>
                        {t('quiz.confirmBlind', { defaultValue: 'Confirm, then show the text' })}
                    </Button>
                )}
                {phase === 'labeled' && (
                    <Button size="small" variant="contained" disabled={!picked} onClick={handleConfirmFinal} sx={{ fontSize: 12, textTransform: 'none' }}>
                        {t('quiz.confirmFinal', { defaultValue: 'Confirm answer' })}
                    </Button>
                )}
                {phase === 'revealed' && (
                    <Button size="small" variant="contained" onClick={handleNext} sx={{ fontSize: 12, textTransform: 'none' }}>
                        {index + 1 >= quiz.items.length
                            ? t('quiz.toPartFour', { defaultValue: 'On to part 4' })
                            : t('quiz.next', { defaultValue: 'Next' })}
                    </Button>
                )}
            </Box>
        );
    };

    // ── results (live: shows whatever has been answered so far) ──────────

    const resultsBody = () => {
        const total = quiz?.items.length ?? 0;
        const nothingYet = answers.length === 0 && !recallAnswer && !comboAnswer && !traceTreeAnswer && !traceProvAnswer;
        if (nothingYet) {
            return (
                <Box sx={{ p: 2 }}>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                        {t('quiz.noResultsYet', { defaultValue: 'Nothing answered yet — results appear here as you complete the parts.' })}
                    </Typography>
                </Box>
            );
        }
        {
            const missCount = answers.length - correctCount;
            const blindCorrect = answers.filter(a => a.blindCorrect).length;
            const changed = answers.filter(a => a.changedAfterText).length;
            return (
                <Box sx={{ p: 1.5 }}>
                    {/* The tab is reachable mid-part-3, so everything here is
                        scored against what has been ANSWERED, not the item
                        count, and unfinished progress is said out loud. */}
                    {answers.length > 0 && (
                        <>
                            <Typography sx={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>
                                {correctCount}
                                <Typography component="span" sx={{ fontSize: 14, color: 'text.disabled', fontWeight: 500 }}>
                                    {' '}/ {answers.length} {t('quiz.correctSuffix', { defaultValue: 'correct' })}
                                </Typography>
                            </Typography>
                            {!finished && total > 0 && (
                                <Typography sx={{ fontSize: 11.5, color: 'warning.dark', mt: 0.25 }}>
                                    {t('quiz.partialAnswers', { done: answers.length, total,
                                        defaultValue: `Part 3 is still underway — ${answers.length} of ${total} questions answered so far.` })}
                                </Typography>
                            )}
                            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5 }}>
                                {missCount === 0
                                    ? (finished ? t('quiz.noMisses', { defaultValue: 'You recognized every chart.' }) : '')
                                    : missCount === 1
                                        ? t('quiz.missesOne', { defaultValue: '1 miss — the look-alike that fooled you is listed below.' })
                                        : t('quiz.missesMany', { count: missCount, defaultValue: `${missCount} misses — the look-alikes that fooled you are listed below.` })}
                            </Typography>
                            {/* The two-step split: what the shape alone got, and how
                                often reading the text changed the answer. */}
                            <Typography sx={{ fontSize: 12, color: 'text.secondary', mb: 1 }}>
                                {t('quiz.shapeOnlyScore', { blind: blindCorrect, total: answers.length,
                                    defaultValue: `From shape alone (step 1): ${blindCorrect} / ${answers.length}.` })}
                                {' '}
                                {changed === 0
                                    ? t('quiz.changedNone', { defaultValue: 'The text never changed your mind.' })
                                    : t('quiz.changedSome', { count: changed,
                                        defaultValue: `The text changed your answer on ${changed} of them.` })}
                            </Typography>
                        </>
                    )}
                    {recallAnswer && recallSummary(recallAnswer)}
                    {comboAnswer && comboSummary(comboAnswer)}
                    {/* part 4, when it was answered: the map score and/or the
                        walkthrough, now that revealing structure costs nothing */}
                    {(traceTreeAnswer || traceProvAnswer) && (
                        <Box sx={{ mb: 1.5, p: 1.25, background: alpha(theme.palette.primary.main, 0.04), borderRadius: radius.sm }}>
                            <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>
                                {t('quiz.traceResultTitle', { defaultValue: 'Your analysis path' })}
                            </Typography>
                            {traceTreeAnswer && (
                                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                                    {t('quiz.traceTreeResult', {
                                        hits: traceTreeAnswer.score.hits,
                                        total: traceTreeAnswer.score.hits + traceTreeAnswer.score.misses,
                                        extras: traceTreeAnswer.score.extras,
                                        seconds: traceTreeAnswer.seconds,
                                        defaultValue: `Map: ${traceTreeAnswer.score.hits} of ${traceTreeAnswer.score.hits + traceTreeAnswer.score.misses} links rebuilt correctly, ${traceTreeAnswer.score.extras} link(s) that never happened · ${traceTreeAnswer.seconds}s.`,
                                    })}
                                </Typography>
                            )}
                            {traceProvAnswer && (
                                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                                    {t('quiz.traceProvResult', {
                                        correct: traceProvAnswer.score.correct,
                                        total: traceProvAnswer.score.total,
                                        seconds: traceProvAnswer.seconds,
                                        defaultValue: `What came next: ${traceProvAnswer.score.correct} of ${traceProvAnswer.score.total} moves remembered in ${traceProvAnswer.seconds}s — your reasons are in the downloaded file, next to the prompts you really wrote.`,
                                    })}
                                </Typography>
                            )}
                        </Box>
                    )}
                    {answers.length > 0 && <Box sx={{ overflowX: 'auto' }}>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>#</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colChart', { defaultValue: 'Chart' })}</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colShape', { defaultValue: 'Shape only' })}</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colResult', { defaultValue: 'With text' })}</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colChosen', { defaultValue: 'If missed: look-alike chosen' })}</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {answers.map(a => (
                                    <TableRow key={a.n}>
                                        <TableCell sx={{ fontSize: 11, px: 0.5 }}>{a.n}</TableCell>
                                        <TableCell sx={{ fontSize: 11, px: 0.5 }}>{a.title}</TableCell>
                                        <TableCell sx={{ fontSize: 11, px: 0.5 }}>
                                            {a.blindCorrect
                                                ? <CheckCircleOutlineIcon sx={{ fontSize: 14, color: 'success.main' }} />
                                                : <HighlightOffIcon sx={{ fontSize: 14, color: 'error.main' }} />}
                                        </TableCell>
                                        <TableCell sx={{ fontSize: 11, px: 0.5 }}>
                                            {a.correct
                                                ? <CheckCircleOutlineIcon sx={{ fontSize: 14, color: 'success.main' }} />
                                                : <HighlightOffIcon sx={{ fontSize: 14, color: 'error.main' }} />}
                                            {a.changedAfterText && (
                                                <Typography component="span" sx={{ fontSize: 9.5, color: 'text.disabled', ml: 0.5 }}>
                                                    {t('quiz.changedTag', { defaultValue: 'changed' })}
                                                </Typography>
                                            )}
                                        </TableCell>
                                        <TableCell sx={{ fontSize: 11, px: 0.5, color: 'text.secondary' }}>
                                            {a.correct ? '—' : `${a.label ?? ''} (${a.specDist}, ${a.dataDist})`}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </Box>}
                    <Box sx={{ display: 'flex', gap: 0.5, mt: 1, flexWrap: 'wrap' }}>
                        <Button size="small" startIcon={<DownloadIcon sx={{ fontSize: 15 }} />} onClick={handleDownload} sx={{ fontSize: 12, textTransform: 'none' }}>
                            {t('quiz.download', { defaultValue: 'Download answers' })}
                        </Button>
                        <Button size="small" startIcon={<ReplayIcon sx={{ fontSize: 15 }} />}
                            onClick={handleRetake}
                            sx={{ fontSize: 12, textTransform: 'none' }}>
                            {t('quiz.again', { defaultValue: 'Take it again' })}
                        </Button>
                    </Box>
                </Box>
            );
        }
    };

    // ── author mode ──────────────────────────────────────────────────────

    const lureCard = (lure: AuthoredLure) => (
        <Box key={lure.id} sx={{ border: `1px solid ${borderColor.view}`,
                borderTop: `3px solid ${METHOD_COLOR[lure.method]}`,
                borderRadius: radius.sm, p: 0.75, background: '#fff', opacity: lure.quizEligible ? 1 : 0.75 }}>
            <img src={svgUri(lure.svg)} alt="" style={{ maxWidth: '100%', maxHeight: size.lureH, height: 'auto', display: 'block', margin: '0 auto' }} />
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
                                                        style={{ maxWidth: '100%', maxHeight: wide ? 320 : 210, height: 'auto', display: 'block', margin: '0 auto' }} />
                                                </Box>
                                            </Box>
                                            {state.byMethod.map(group => (
                                                <Box key={group.method} sx={{ mb: 1.25 }}>
                                                    <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em',
                                                        color: METHOD_COLOR[group.method], mb: 0.5 }}>
                                                        {METHOD_LABEL[group.method]} · {group.lures.length}
                                                    </Typography>
                                                    <Box sx={{ display: 'grid', gridTemplateColumns: size.lureCols, gap: 1 }}>
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
                <Box sx={{ maxWidth: size.maxW, mx: 'auto', width: '100%' }}>
                    {/* Author mode is nothing but the generated look-alikes, so a
                        failure there is terminal. The part tabs handle their own
                        error cases — parts 1, 2 and 4 need no look-alikes and stay
                        answerable, and reportable, without them. */}
                    {error && tab === 'author'
                        ? <Box sx={{ p: 2 }}><Typography sx={{ fontSize: 13, color: 'error.main' }}>{error}</Typography></Box>
                        : tab === 'recall' ? recallBody()
                        : tab === 'combos' ? combosBody()
                        : tab === 'charts' ? chartsBody()
                        : tab === 'trace' ? traceBody()
                        : tab === 'results' ? resultsBody()
                        : authorBody()}
                </Box>
            </Box>
        </Box>
    );
};
