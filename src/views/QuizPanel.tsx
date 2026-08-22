// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * QuizPanel — the memory quiz, one tab per part.
 *
 *  Every part opens on its own INTRO PAGE — the part's instructions live
 *  there, behind a start button, so the question view itself carries only the
 *  question and the charts get the room.
 *
 *  • 1 · Questions    — the three questions they would ask this dataset next.
 *                       FIRST, and free text: every later part shows the
 *                       session's charts back to them, which would seed it.
 *  • 2 · Attributes   — which columns do you remember exploring?
 *  • 3 · Combinations — which of them did you look at together? Their part-2
 *                       attributes lead the palette; the groups they build are
 *                       scored against the field sets their charts encoded.
 *  • 4 · Charts       — which of these did you make? One step: pick from the
 *                       option matrix (3×3, 3×2 or 2×2): the original, visual
 *                       look-alikes, data look-alikes, and combined
 *                       look-alikes. A miss records which axis (and which
 *                       message dimension) fooled them, and how far the chosen
 *                       look-alike sat from the real chart.
 *  • 5 · Path         — the reasoning trace: which chart came next, and why
 *                       (the provenance question).
 *
 *  Parts 4 and 5 also ask HOW SURE they are, on a 0-100 scale, before the
 *  answer is committed. Neither gives feedback: a confirm goes straight to
 *  the next question, and only the researcher's eye toggle (bottom right)
 *  shows what each look-alike changed (part 4) or which chart really came
 *  next (part 5).
 *  • Results          — scores of whatever has been answered so far + download.
 *
 * Every tab is DIRECTLY reachable — a pilot can jump to part 5 without
 * answering the questions — but the guided flow is preserved: each part's
 * continue button advances to the next tab, and ticks mark answered parts.
 * The ordering the tabs suggest still matters for a real run: 1 before all the
 * rest (nothing may seed the questions), 2 before 3 (the groups are built over
 * the attributes just named), 3 before 4 (the chart options name both), and 5
 * before Results (the results table reveals the true order and lineage).
 */

import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Box, Button, IconButton, Typography, LinearProgress, Tabs, Tab, Chip,
    Table, TableBody, TableCell, TableHead, TableRow, Tooltip,
    CircularProgress, alpha, useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DownloadIcon from '@mui/icons-material/Download';
import ReplayIcon from '@mui/icons-material/Replay';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HighlightOffIcon from '@mui/icons-material/HighlightOff';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { useTranslation } from 'react-i18next';
import { borderColor, radius } from '../app/tokens';
import {
    generateQuizForSession, buildQuizResult, loadRecallMaterial,
    GeneratedQuiz, QuizAnswer, NextQuestionsAnswer,
} from '../app/quizGeneration';
import {
    ComboAnswer, ComboGroup, RecallAnswer, RecallMaterial, buildComboAnswer, buildRecallAnswer,
} from '../app/fieldRecall';
import { FieldRecallStep } from './FieldRecallStep';
import { ComboRecallStep } from './ComboRecallStep';
import { loadTraceMaterial, TraceMaterial } from '../app/reasoningTrace';
import { ProvenanceStep } from './ProvenanceStep';
import { CONFIDENCE_DEFAULT, ConfidenceRater } from './ConfidenceRater';
import { NEXT_QUESTION_SLOTS, NextQuestionsStep } from './NextQuestionsStep';
import { ProvenanceAnswer, buildProvenanceMaterial } from '../app/provenanceQuiz';
import { loadModeratorConfig } from '../app/quizModeratorConfig';
import { QuizItem, QuizOption, Method, DEFAULT_SEED } from '../lib/quiz-distractors';

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

/** One accent per axis so a lure's origin reads at a glance. */
const METHOD_COLOR: Record<Method, string> = {
    'visual': '#C4652A',
    'data': '#2E8B6B',
    'combined': '#7A5EA8',
};

/** What a lure changed, compact: the axis plus its band or dimension. */
const lureTag = (opt: { method?: Method; dim?: string; band?: string }) =>
    opt.method === 'visual' ? `visual · ${opt.band ?? ''}`.trim()
        : opt.method === 'data' ? `data · ${opt.dim ?? ''}`.trim()
        : opt.method === 'combined' ? `combined · ${opt.band ?? ''}+${opt.dim ?? ''}`
        : '';

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
    // The recognition options should all sit in ONE view — no scroll to
    // compare them. The option count follows the item's matrix (9, 6 or 4), so
    // the grid is derived per question in `optionGrid` below rather than
    // declared here. The narrow docked column cannot fit that many charts at
    // once; it keeps two columns and scrolls.
    const size = wide
        ? { maxW: 1560, optionMin: 96, lureCols: 'repeat(auto-fill, minmax(300px, 1fr))', lureH: 260, pad: 2.5 }
        : { maxW: 'none', optionCols: '1fr 1fr', optionH: 180, optionMin: 140, lureCols: '1fr 1fr', lureH: 190, pad: 1.5 };

    /**
     * Lay `n` charts out so they all fit one screen, in a FULL rectangle — no
     * ragged last row. An item is an option matrix of (visual + 1) × (data + 1)
     * charts with at most two lures per axis, so `n` is 9, 6 or 4 and the tidy
     * shape is 3×3, 3×2 or 2×2. The options themselves stay shuffled, so the
     * grid never mirrors the matrix that made them. Any other count falls back
     * to a near-square grid.
     *
     * The row height is what the viewport has left once the header, tabs,
     * prompt, verdict and the rating row that carries the button (~450px) are
     * accounted for.
     */
    const optionGrid = useCallback((n: number) => {
        if (!wide) return { cols: size.optionCols!, h: size.optionH! as number | string };
        const tidy: Record<number, number> = { 4: 2, 6: 3, 9: 3 };
        const cols = tidy[n] ?? Math.min(6, Math.max(2, Math.ceil(Math.sqrt(n * 1.35))));
        const rows = Math.ceil(n / cols);
        return {
            cols: `repeat(${cols}, 1fr)`,
            h: `max(${size.optionMin}px, calc((100vh - 450px) / ${rows}))`,
        };
    }, [wide, size.optionCols, size.optionH, size.optionMin]);

    // Every part is a tab, directly reachable — a pilot can jump to part 5
    // without answering the chart questions. The guided flow still exists:
    // each part opens on its intro page, and each part's continue button
    // advances to the next tab.
    type PanelTab = 'ask' | 'recall' | 'combos' | 'charts' | 'trace' | 'results';
    // Part 1 is the open question about what to explore NEXT. It opens the quiz
    // because every later part puts the session's charts back on screen, which
    // would seed the answer.
    const [tab, setTab] = useState<PanelTab>('ask');

    // Which parts' intro pages have been dismissed. Each part opens on its own
    // intro — instructions live there, behind a start button — and shows its
    // questions only after the start. A session switch resets all four.
    const [startedParts, setStartedParts] = useState<Set<number>>(new Set());
    const startPart = (n: number) => setStartedParts(prev => { const next = new Set(prev); next.add(n); return next; });

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

    // ── parts 2 and 3: the attributes, then the combinations over them ──
    // Kept OUTSIDE the generation effect's reset list on purpose: that effect
    // re-fires whenever the live slices tick, and wiping a participant's fields
    // or groups mid-answer would be unrecoverable.
    // ── part 1: the three questions they would ask next ──
    const [askQuestions, setAskQuestions] = useState<string[]>(
        () => Array.from({ length: NEXT_QUESTION_SLOTS }, () => ''));
    const [askAnswer, setAskAnswer] = useState<NextQuestionsAnswer | null>(null);
    const askStartRef = useRef<number>(Date.now());

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
    // Each question is one pick: choose an option, confirm, and the next
    // question appears. The participant gets no feedback — neither the
    // correct answer nor what a look-alike changed.
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<QuizAnswer[]>([]);
    // Confidence for the question on screen, reset for every question.
    const [confidence, setConfidence] = useState(CONFIDENCE_DEFAULT);
    const [confidenceSet, setConfidenceSet] = useState(false);
    const [picked, setPicked] = useState<string | null>(null);
    const [finished, setFinished] = useState(false);
    // The researcher's eye toggle (bottom right): when on, each look-alike
    // carries the chip that names its mechanism, and the real chart is
    // outlined. Never shown to the participant by default.
    const [showMechanism, setShowMechanism] = useState(false);

    // ── part 5: reasoning trace ──
    // One question form: which chart came next, and why (the provenance
    // question). The material is built when the tab is first opened.
    const [traceMaterial, setTraceMaterial] = useState<TraceMaterial | 'loading' | 'failed' | null>(null);
    const [traceProvAnswer, setTraceProvAnswer] = useState<ProvenanceAnswer | null>(null);

    useEffect(() => {
        const runId = ++runIdRef.current;
        setQuiz(null); setError(null); setIndex(0); setAnswers([]);
        setPicked(null);
        setFinished(false);
        setTraceMaterial(null); setTraceProvAnswer(null);
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

    // Back to the first intro when the panel is pointed at a different session
    // — but ONLY then. The generation effect above re-fires on live-slice
    // ticks, and yanking the tab away mid-part would be hostile.
    useEffect(() => {
        setTab('ask'); setStartedParts(new Set());
        // The typed answers go with it. They are kept out of the generation
        // effect above (a live-slice tick would wipe them mid-answer), so this
        // is the only place a cross-session carry-over can be cleared.
        setAskQuestions(Array.from({ length: NEXT_QUESTION_SLOTS }, () => ''));
        setAskAnswer(null);
        setRecallFields([]); setRecallAnswer(null);
        setComboGroups([]); setComboAnswer(null);
    }, [sessionId]);

    // Part 2 is timed from when it is opened, not from when its material loaded
    // — the material is part 2's, and timing from there would charge part 3 for
    // the whole of part 2. Every entry re-stamps it, so `seconds` reports the
    // visit the answer was confirmed in rather than the wall clock since first
    // sight of the tab.
    useEffect(() => { if (tab === 'combos') comboStartRef.current = Date.now(); }, [tab]);
    useEffect(() => { if (tab === 'ask') askStartRef.current = Date.now(); }, [tab]);

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
    // A moderator config, when one exists for this session, replaces the
    // seeded draws with the moves and distractors the moderator picked.
    const provMaterial = useMemo(
        () => {
            if (!traceMaterial || traceMaterial === 'loading' || traceMaterial === 'failed') return null;
            const provConfig = loadModeratorConfig(sessionId)?.provenance;
            return buildProvenanceMaterial(traceMaterial, {
                count: provConfig?.count,
                overrides: provConfig
                    ? { transitions: provConfig.transitions, distractors: provConfig.distractors }
                    : undefined,
            });
        },
        [traceMaterial, sessionId]);

    const item = quiz?.items[index];
    const options = useMemo(() => (item ? shuffledOptions(item) : []), [item]);
    const correctCount = answers.filter(a => a.correct).length;

    /** Select an option. Nothing is scored until the pick is confirmed. */
    const handlePick = useCallback((optionId: string) => {
        setPicked(optionId);
    }, []);

    /** Confirm the pick: record it, score it, and go straight to the next
     *  question. No feedback is given. */
    const handleConfirm = useCallback(() => {
        if (!quiz || !item || !picked) return;
        const chosen = item.options.find(o => o.id === picked);
        const correct = picked === item.correctId;
        setAnswers(prev => [...prev, {
            n: index + 1, chartId: item.chartId, title: item.title, chartType: item.chartType,
            inReport: item.inReport,
            correct,
            pickedId: picked,
            method: correct ? undefined : chosen?.method,
            op: correct ? undefined : chosen?.op,
            label: correct ? undefined : chosen?.label,
            dim: correct ? undefined : chosen?.dim,
            band: correct ? undefined : chosen?.band,
            specDist: correct ? undefined : chosen?.specDist,
            dataDist: correct ? undefined : chosen?.dataDist,
            cell: chosen?.cell,
            // Recorded whether the pick was right or wrong — calibration needs
            // the confident misses as much as the confident hits.
            confidence,
            confidenceSet,
        }]);
        // After the last question the guided flow moves on to part 5.
        if (index + 1 >= quiz.items.length) { setFinished(true); setTab('trace'); return; }
        setIndex(i => i + 1);
        setPicked(null);
        setConfidence(CONFIDENCE_DEFAULT); setConfidenceSet(false);
    }, [quiz, item, picked, index, confidence, confidenceSet]);

    /** Restart part 4 only; the other parts' answers are kept. */
    const handleRetake = useCallback(() => {
        setIndex(0); setAnswers([]); setPicked(null);
        setConfidence(CONFIDENCE_DEFAULT); setConfidenceSet(false);
        setFinished(false); setTab('charts');
    }, []);

    /** Part 1's continue: freeze the three questions and move on. Revisiting the
     *  tab and pressing it again just updates them. */
    const handleFinishAsk = useCallback(() => {
        setAskAnswer({
            questions: askQuestions.map(q => q.trim()),
            seconds: Math.round((Date.now() - askStartRef.current) / 1000),
        });
        setTab('recall');
    }, [askQuestions]);

    /** Part 2's continue: freeze (or re-freeze) the named attributes and move on.
     *  Revisiting the tab and pressing it again simply updates the answer. */
    const handleFinishRecall = useCallback(() => {
        if (!recallMaterial) return;
        setRecallAnswer(buildRecallAnswer(recallFields, recallMaterial, Date.now() - recallStartRef.current));
        setTab('combos');
    }, [recallFields, recallMaterial]);

    /** Part 3's continue: freeze the combinations and move on to the charts.
     *  Empty groups are dropped — they are scaffolding, not an answer. */
    const handleFinishCombos = useCallback(() => {
        if (!recallMaterial) return;
        const groups = comboGroups.filter(g => g.length > 0);
        setComboAnswer(buildComboAnswer(groups, recallMaterial, Date.now() - comboStartRef.current));
        setTab('charts');
    }, [comboGroups, recallMaterial]);

    // Build the trace material the first time part 5 is opened. Only a null
    // state starts a build: 'failed' must stay failed, or the effect would
    // retry in a loop through its own dependency.
    useEffect(() => {
        if (tab !== 'trace' || traceMaterial !== null) return;
        setTraceMaterial('loading');
        loadTraceMaterial({ sessionId, liveState: liveStateRef.current })
            .then(m => setTraceMaterial(m))
            .catch(e => {
                console.warn('[quiz] trace material could not be built:', e?.message);
                setTraceMaterial('failed');
            });
    }, [tab, traceMaterial, sessionId]);

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
        const withAsk = askAnswer ? { ...base, nextQuestions: askAnswer } : base;
        const result = traceProvAnswer
            ? { ...withAsk, trace: { provenance: traceProvAnswer } }
            : withAsk;
        const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `quiz-${sessionName || sessionId}.json`; a.click();
        URL.revokeObjectURL(url);
    }, [quiz, answers, recallAnswer, comboAnswer, traceProvAnswer, askAnswer, sessionName, sessionId]);

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
    // The tabs are NUMBERED ONLY. Naming the parts up there would tell a
    // participant on part 1 that attributes, charts and a path are coming,
    // and every later part is a memory test the name would prepare them for.
    // What each part asks stays on its own intro page.
    const partTab = (n: number) => t('quiz.tabPart', { n, defaultValue: `Part ${n}` });
    const tabs = (
        <Tabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            sx={{ minHeight: 34, borderBottom: `1px solid ${borderColor.view}`, flexShrink: 0,
                  '& .MuiTab-root': { minHeight: 34, fontSize: 12, textTransform: 'none', py: 0, minWidth: 0 } }}
        >
            <Tab value="ask" label={tick(!!askAnswer, partTab(1))} />
            <Tab value="recall" label={tick(!!recallAnswer, partTab(2))} />
            <Tab value="combos" label={tick(!!comboAnswer, partTab(3))} />
            <Tab value="charts" label={tick(finished, partTab(4))} />
            <Tab value="trace" label={tick(!!traceProvAnswer, partTab(5))} />
            <Tab value="results" label={t('quiz.tabResults', { defaultValue: 'Results' })} />
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

    const optionCard = (opt: QuizOption, cellH: number | string) => {
        const isCorrect = item && opt.id === item.correctId;
        const isPicked = picked === opt.id;

        // Selecting is a neutral highlight. The right answer is never marked
        // for the participant; only the researcher's eye toggle outlines it.
        let bc = borderColor.view, sh = 'none';
        if (isPicked) {
            bc = theme.palette.primary.main; sh = `0 0 0 3px ${alpha(theme.palette.primary.main, 0.16)}`;
        } else if (showMechanism && isCorrect) {
            bc = theme.palette.success.main; sh = `0 0 0 3px ${alpha(theme.palette.success.main, 0.18)}`;
        }

        return (
            <Box key={opt.id} sx={{ position: 'relative', display: 'flex' }}>
                <Box
                    component="button"
                    onClick={() => handlePick(opt.id)}
                    aria-pressed={isPicked}
                    sx={{ flex: 1, p: 0.75, background: '#fff', cursor: 'pointer',
                          border: `2px solid ${bc}`, boxShadow: sh, borderRadius: radius.sm,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: size.optionMin,
                          transition: 'border-color .12s, box-shadow .12s',
                          '&:hover': { borderColor: theme.palette.primary.main } }}
                >
                    <img
                        // Width 100% scales the SVG up to the card, so the
                        // details stay readable on a large screen.
                        src={svgUri(opt.svg)}
                        alt=""
                        style={{ width: '100%', height: cellH, objectFit: 'contain' }}
                    />
                </Box>
                {/* With the eye toggle on, name what each look-alike changed:
                    its axis, its band or dimension, and the operation. */}
                {showMechanism && opt.method && (
                    <Chip
                        size="small"
                        label={`${lureTag(opt)} · ${opt.label}`}
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

    /** Part 1 read back. Nothing is scored — the questions are read offline,
     *  against the analysis the session really produced. */
    const askSummary = (ask: NextQuestionsAnswer) => {
        const written = ask.questions.filter(q => q.trim().length > 0);
        return (
            <Box sx={{ mb: 1.5, p: 1.25, background: alpha(theme.palette.info.main, 0.05), borderRadius: radius.sm }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>
                    {t('quiz.askResultTitle', { count: written.length,
                        defaultValue: `Questions you would ask next: ${written.length}` })}
                </Typography>
                {written.map((q, i) => (
                    <Typography key={i} sx={{ fontSize: 11.5, color: 'text.secondary', mb: 0.25 }}>
                        {i + 1}. {q}
                    </Typography>
                ))}
                <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 0.5 }}>
                    {t('quiz.askSeconds', { seconds: ask.seconds,
                        defaultValue: `Written in ${ask.seconds}s.` })}
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

    // ── part 5: reasoning trace ──────────────────────────────────────────

    /** The way on when the part cannot be asked at all — a failed build, or a
     *  session with too few charts. Not a skip: there is nothing to answer. */
    const traceToResults = (
        <Button variant="contained" onClick={() => setTab('results')}
            sx={{ fontSize: 13, textTransform: 'none', px: 2.5 }}>
            {t('quiz.confirm', { defaultValue: 'Confirm' })}
        </Button>
    );

    const traceBody = () => {
        // The intro reads while the trace material loads (the effect above
        // starts the build as soon as the tab opens).
        if (!startedParts.has(5)) {
            return partIntro(5, partName('quiz.tabTrace', '5 · Path'),
                t('quiz.introP5', { defaultValue:
                    'One move at a time: you see where you were, and three charts from your session. Pick the chart you made next, then say why you made that move.' }));
        }
        // Already answered: opening the tab again must not restart the moves.
        // Redo is explicit, and clears the old answer for a fresh run.
        if (traceProvAnswer) {
            return (
                <Box sx={{ p: 1.5 }}>
                    <Typography sx={{ fontSize: 12.5, mb: 1 }}>
                        {t('quiz.provDone', { defaultValue: 'This part is answered — your moves are recorded.' })}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                        <Button variant="contained" onClick={() => setTab('results')}
                            sx={{ fontSize: 13, textTransform: 'none', px: 2.5 }}>
                            {t('quiz.confirm', { defaultValue: 'Confirm' })}
                        </Button>
                        <Button size="small" startIcon={<ReplayIcon sx={{ fontSize: 15 }} />}
                            onClick={() => setTraceProvAnswer(null)}
                            sx={{ fontSize: 12, textTransform: 'none' }}>
                            {t('quiz.again', { defaultValue: 'Take it again' })}
                        </Button>
                    </Box>
                </Box>
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
                    {traceToResults}
                </Box>
            );
        }
        if (provMaterial && provMaterial.items.length === 0) {
            return (
                <Box sx={{ p: 2 }}>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 1 }}>
                        {t('quiz.provNoItems', { defaultValue:
                            'This session does not have enough charts to ask where one led to another.' })}
                    </Typography>
                    {traceToResults}
                </Box>
            );
        }

        // The instructions live on the intro tab, so the step itself carries
        // nothing but the question.
        return (
            <ProvenanceStep material={provMaterial!} wide={wide}
                onDone={a => { setTraceProvAnswer(a); setTab('results'); }} />
        );
    };

    // ── per-part intro pages ─────────────────────────────────────────────
    // ALL the instruction text lives on these five pages. The question views
    // themselves show only the question, so the charts can take the space.

    const partIntro = (n: number, title: string, desc: string) => (
        <Box sx={{ p: 3, maxWidth: 860 }}>
            <Typography sx={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.07em', color: 'primary.main', mb: 0.5 }}>
                {t('quiz.partN', { n, defaultValue: `Part ${n} of 5` })}
            </Typography>
            <Typography sx={{ fontSize: 20, fontWeight: 700, mb: 1 }}>{title}</Typography>
            {n === 1 && (
                <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 1 }}>
                    {t('quiz.introLead', { defaultValue:
                        'This quiz is about the session you just worked on. It has five short parts. Answer from memory. Your answers change nothing in the session, and the results come at the end.' })}
                </Typography>
            )}
            <Typography sx={{ fontSize: 13, color: 'text.secondary', mb: 2 }}>{desc}</Typography>
            {n === 1 && (
                <Typography sx={{ fontSize: 11.5, color: 'text.disabled', mb: 2 }}>
                    {t('quiz.introOrder', { defaultValue:
                        'Do the parts in order — a later part gives away answers to an earlier one.' })}
                </Typography>
            )}
            <Button variant="contained" onClick={() => startPart(n)} sx={{ fontSize: 13, textTransform: 'none' }}>
                {t('quiz.introStart', { defaultValue: 'Start this part' })}
            </Button>
        </Box>
    );

    /** The part's display name, for the heading of its own INTRO page — the
     *  tabs carry the number alone. The "N · " prefix the keys still hold is
     *  dropped, so the heading reads as a name. */
    const partName = (key: string, def: string) => t(key, { defaultValue: def }).replace(/^\d+ · /, '');

    // ── part 1: the questions they would ask next ────────────────────────

    const askBody = () => {
        if (!startedParts.has(1)) {
            return partIntro(1, partName('quiz.tabAsk', '1 · Questions'),
                t('quiz.introP1', { defaultValue:
                    'Before you look back at anything you made: what would you ask this dataset next? Write three questions, in your own words.' }));
        }
        return (
            <NextQuestionsStep
                questions={askQuestions}
                onChange={setAskQuestions}
                onContinue={handleFinishAsk}
                // The same table parts 2 and 3 open on.  It loads on mount,
                // independent of the tab, so it is usually here already; the
                // part renders without it either way and never waits.
                table={recallMaterial?.table}
                wide={wide}
            />
        );
    };

    // ── part 2: attribute recall ─────────────────────────────────────────

    const recallBody = () => {
        if (!startedParts.has(2)) {
            return partIntro(2, partName('quiz.tabRecall', '2 · Attributes'),
                t('quiz.introP2', { defaultValue:
                    'You see the data you started from. Click every attribute you remember using in your analysis. Click one again to take it back.' }));
        }
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

    // ── part 3: the combinations over those attributes ───────────────────

    const combosBody = () => {
        if (!startedParts.has(3)) {
            return partIntro(3, partName('quiz.tabCombos', '3 · Combinations'),
                t('quiz.introP3', { defaultValue:
                    'Make one group for each combination of attributes you remember charting together. Click a group to fill it, then click the attributes that went into it. The attributes you named in part 2 come first.' }));
        }
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

    // ── part 4: chart recognition ────────────────────────────────────────

    const chartsBody = () => {
        if (!startedParts.has(4)) {
            return partIntro(4, partName('quiz.tabCharts', '4 · Charts'),
                t('quiz.introP4', { defaultValue:
                    'Each question shows nine charts. One is a chart you made; eight are look-alikes. Some look-alikes are drawn differently, and some show different data. Pick the chart you made, then confirm.' }));
        }
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
                    <Typography sx={{ fontSize: 12.5, mb: 1 }}>
                        {t('quiz.chartsDone', { count: quiz.items.length,
                            defaultValue: `All ${quiz.items.length} questions answered.` })}
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                        <Button variant="contained" onClick={() => setTab('trace')}
                            sx={{ fontSize: 13, textTransform: 'none', px: 2.5 }}>
                            {t('quiz.confirm', { defaultValue: 'Confirm' })}
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
        const grid = optionGrid(options.length);
        return (
            <Box sx={{ p: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <LinearProgress variant="determinate" value={(100 * index) / quiz.items.length}
                        sx={{ flex: 1, height: 5, borderRadius: 99 }} />
                    <Typography sx={{ fontSize: 11, color: 'text.disabled', whiteSpace: 'nowrap' }}>
                        {index + 1} / {quiz.items.length}
                    </Typography>
                </Box>
                <Typography sx={{ fontSize: 15, mb: 1 }}>
                    <Box component="span" sx={{ fontWeight: 700 }}>{item!.title}</Box>
                    {' — '}
                    {t('quiz.questionPrompt', {
                        defaultValue: 'Which of these did you make?' })}
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: grid.cols, gap: wide ? 1.25 : 1, mb: 1.25 }}>
                    {options.map(o => optionCard(o, grid.h))}
                </Box>
                {/* Below the charts: the rating is about the pick, and the
                    confirm commits both and moves on. */}
                <ConfidenceRater
                    value={confidence}
                    onChange={setConfidence}
                    onTouch={() => setConfidenceSet(true)}
                    action={
                        <Button variant="contained" disabled={!picked} onClick={handleConfirm}
                            sx={{ fontSize: 13, textTransform: 'none', px: 2.5 }}>
                            {t('quiz.confirm', { defaultValue: 'Confirm' })}
                        </Button>
                    }
                />
                {/* The researcher's eye: sits just above the system-messages
                    info button (MessageSnackbar, bottom 16 right 16). On, it
                    shows each look-alike's mechanism and outlines the real
                    chart; the participant never sees this by default. */}
                <Tooltip placement="left" title={showMechanism
                    ? t('quiz.mechanismHide', { defaultValue: 'Hide the look-alike mechanisms' })
                    : t('quiz.mechanismShow', { defaultValue: 'Show the look-alike mechanisms' })}>
                    <IconButton
                        onClick={() => setShowMechanism(v => !v)}
                        sx={{
                            position: 'fixed', bottom: 52, right: 16,
                            width: 30, height: 30, zIndex: 10,
                            backgroundColor: 'white',
                            border: '1px solid',
                            borderColor: showMechanism ? 'primary.main' : 'grey.400',
                            color: showMechanism ? 'primary.main' : 'text.disabled',
                            boxShadow: '0 0 6px rgba(0,0,0,0.1)',
                            opacity: showMechanism ? 1 : 0.6,
                            transition: 'all 0.3s ease',
                            '&:hover': { transform: 'scale(1.1)', backgroundColor: 'white' },
                        }}
                    >
                        {showMechanism ? <VisibilityIcon sx={{ fontSize: 18 }} /> : <VisibilityOutlinedIcon sx={{ fontSize: 18 }} />}
                    </IconButton>
                </Tooltip>
            </Box>
        );
    };

    // ── results (live: shows whatever has been answered so far) ──────────

    const resultsBody = () => {
        const total = quiz?.items.length ?? 0;
        const nothingYet = answers.length === 0 && !askAnswer && !recallAnswer && !comboAnswer && !traceProvAnswer;
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
                                        defaultValue: `Part 4 is still underway — ${answers.length} of ${total} questions answered so far.` })}
                                </Typography>
                            )}
                            <Typography sx={{ fontSize: 12, color: 'text.secondary', mt: 0.5, mb: 1 }}>
                                {missCount === 0
                                    ? (finished ? t('quiz.noMisses', { defaultValue: 'You recognized every chart.' }) : '')
                                    : missCount === 1
                                        ? t('quiz.missesOne', { defaultValue: '1 miss — the look-alike that fooled you is listed below.' })
                                        : t('quiz.missesMany', { count: missCount, defaultValue: `${missCount} misses — the look-alikes that fooled you are listed below.` })}
                            </Typography>
                        </>
                    )}
                    {askAnswer && askSummary(askAnswer)}
                    {recallAnswer && recallSummary(recallAnswer)}
                    {comboAnswer && comboSummary(comboAnswer)}
                    {/* part 4, when it was answered — revealing the true order
                        costs nothing here */}
                    {traceProvAnswer && (
                        <Box sx={{ mb: 1.5, p: 1.25, background: alpha(theme.palette.primary.main, 0.04), borderRadius: radius.sm }}>
                            <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>
                                {t('quiz.traceResultTitle', { defaultValue: 'Your analysis path' })}
                            </Typography>
                            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                                {t('quiz.traceProvResult', {
                                    correct: traceProvAnswer.score.correct,
                                    total: traceProvAnswer.score.total,
                                    seconds: traceProvAnswer.seconds,
                                    defaultValue: `What came next: ${traceProvAnswer.score.correct} of ${traceProvAnswer.score.total} moves remembered in ${traceProvAnswer.seconds}s — the moves are in the downloaded file, next to the prompts you really wrote.`,
                                })}
                            </Typography>
                        </Box>
                    )}
                    {answers.length > 0 && <Box sx={{ overflowX: 'auto' }}>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>#</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colChart', { defaultValue: 'Chart' })}</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colResult', { defaultValue: 'Result' })}</TableCell>
                                    <TableCell sx={{ fontSize: 10, px: 0.5 }}>{t('quiz.colConfidence', { defaultValue: 'Sure?' })}</TableCell>
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
                                        <TableCell sx={{ fontSize: 11, px: 0.5, color: a.confidenceSet ? 'text.primary' : 'text.disabled' }}>
                                            {a.confidence}
                                        </TableCell>
                                        <TableCell sx={{ fontSize: 11, px: 0.5, color: 'text.secondary' }}>
                                            {a.correct
                                                ? '—'
                                                : `${a.method === 'data' ? `data · ${a.dim}`
                                                    : a.method === 'combined' ? `combined · ${a.band}+${a.dim}`
                                                    : `visual · ${a.band}`} — ${a.label ?? ''} (${a.specDist}, ${a.dataDist})`}
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


    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {header}
            {tabs}
            <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                {/* The path step sizes itself against the height it is given,
                    so its wrapper passes one down. Every other part flows and
                    scrolls as usual. */}
                <Box sx={{ maxWidth: size.maxW, mx: 'auto', width: '100%',
                           ...(tab === 'trace' ? { height: '100%' } : {}) }}>
                    {/* Every part handles its own error case — parts 1, 2 and 3
                        need no look-alikes and stay answerable, and reportable,
                        without them. */}
                    {tab === 'ask' ? askBody()
                        : tab === 'recall' ? recallBody()
                        : tab === 'combos' ? combosBody()
                        : tab === 'charts' ? chartsBody()
                        : tab === 'trace' ? traceBody()
                        : resultsBody()}
                </Box>
            </Box>
        </Box>
    );
};
