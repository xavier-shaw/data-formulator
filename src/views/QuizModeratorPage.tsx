// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * QuizModeratorPage — the researcher's quiz configuration surface.
 *
 * Reached at /quiz-moderator (URL only — participants never see a link to
 * it). With no ?session= it shows the SESSION PANEL — id, name, save time,
 * chart count — and the moderator picks the participant's session from there.
 * With ?session=<id>&name=<n> it moderates that session.
 *
 * The page keeps the session's THREAD VIEW: every
 * chart sits in its lineage chain, as a row of thumbnails in creation order,
 * so the moderator reads the quiz against the analysis it will probe.
 *
 * Two tabs, one per task:
 *
 *   • Recognition — runs the real quiz generation and overlays it on the
 *     threads: which charts are asked (Q1…Qn), which were skipped and why,
 *     which are excluded. The moderator toggles the asked set per chart. An
 *     inspector below shows the exact option matrix the participant will see,
 *     plus every perturbation each axis can make, with a pin control to
 *     prefer specific lures.
 *
 *   • Provenance — overlays the sampled moves on the same threads: which
 *     lineage edges became items, and which charts each item offers as
 *     options. The moderator toggles any edge as an asked move and sets each
 *     item's distractors from dropdowns.
 *
 * Every choice is saved immediately as this session's moderator config
 * (app/quizModeratorConfig.ts); the participant quiz reads that config when it
 * generates. Researcher-facing, so the strings are deliberately not localized.
 */

import React, { FC, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import {
    Box, Button, Chip, CircularProgress, IconButton, LinearProgress, MenuItem,
    Select, Tab, Tabs, TextField, Tooltip, Typography, alpha, useTheme,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ReplayIcon from '@mui/icons-material/Replay';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { DataFormulatorState } from '../app/dfSlice';
import { borderColor, radius } from '../app/tokens';
import { WorkspaceSummary, listWorkspaces } from '../app/workspaceService';
import { GeneratedQuiz, generateQuizForSession, authorViewForChart } from '../app/quizGeneration';
import { loadTraceMaterial, TraceChart, TraceMaterial } from '../app/reasoningTrace';
import { buildProvenanceMaterial, ProvenanceItem } from '../app/provenanceQuiz';
import {
    QuizModeratorConfig, clearModeratorConfig, loadModeratorConfig, lureKey,
    saveModeratorConfig, transitionKey,
} from '../app/quizModeratorConfig';
import { AuthoredChart, Method, QuizItem, QuizOption } from '../lib/quiz-distractors';

const METHOD_COLOR: Record<Method, string> = {
    'visual': '#C4652A',
    'data': '#2E8B6B',
    'combined': '#7A5EA8',
};

const svgUri = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/^<\?xml[^>]*\?>\s*/, ''))}`;

const lureTag = (opt: { method?: Method; dim?: string; band?: string }) =>
    opt.method === 'visual' ? `visual · ${opt.band ?? ''}`.trim()
        : opt.method === 'data' ? `data · ${opt.dim ?? ''}`.trim()
        : opt.method === 'combined' ? `combined · ${opt.band ?? ''}+${opt.dim ?? ''}`
        : '';

/** One lineage chain: the root chart and every descendant, in creation order. */
interface ThreadRow { rootId: string; charts: TraceChart[] }

const buildThreads = (material: TraceMaterial): ThreadRow[] => {
    const byId = new Map(material.charts.map(c => [c.chartId, c]));
    const rootOf = (c: TraceChart): TraceChart => {
        let cur = c;
        const seen = new Set<string>();
        while (cur.parentChartId && !seen.has(cur.chartId)) {
            seen.add(cur.chartId);
            const parent = byId.get(cur.parentChartId);
            if (!parent) break;
            cur = parent;
        }
        return cur;
    };
    const groups = new Map<string, TraceChart[]>();
    for (const c of material.charts) {
        const rootId = rootOf(c).chartId;
        const list = groups.get(rootId) ?? [];
        list.push(c);
        groups.set(rootId, list);
    }
    return [...groups.entries()].map(([rootId, charts]) => ({ rootId, charts }));
};

export const QuizModeratorPage: FC = () => {
    const theme = useTheme();
    const navigate = useNavigate();
    const [params] = useSearchParams();

    const activeWorkspace = useSelector((state: DataFormulatorState) => state.activeWorkspace);
    // No fallback to the active session here: with no ?session= the page shows
    // the SESSION PANEL, so the moderator picks the participant's session
    // explicitly rather than silently getting whatever happens to be open.
    const sessionId = params.get('session') || '';
    const sessionName = params.get('name')
        || (sessionId === activeWorkspace?.id ? activeWorkspace?.displayName : '')
        || sessionId;

    // Live slices for the ACTIVE session, same as ChartMemoryPage: autosave
    // lags, and current focus time is still accumulating in memory.
    const charts = useSelector((state: DataFormulatorState) => state.charts);
    const tables = useSelector((state: DataFormulatorState) => state.tables);
    const conceptShelfItems = useSelector((state: DataFormulatorState) => state.conceptShelfItems);
    const chartUsage = useSelector((state: DataFormulatorState) => state.chartUsage);
    const liveState = useMemo(
        () => ({ charts, tables, conceptShelfItems, chartUsage }),
        [charts, tables, conceptShelfItems, chartUsage],
    );
    const stateForSession = activeWorkspace?.id === sessionId ? liveState : undefined;
    // Read once through a ref: the live slices tick (chart-usage telemetry),
    // and regenerating the whole preview under the moderator would be hostile.
    const stateRef = useRef(stateForSession);
    stateRef.current = stateForSession;

    const [tab, setTab] = useState<'recognition' | 'provenance'>('recognition');

    // ── the landing panel's session list (only loaded when no session is open) ──
    const [sessions, setSessions] = useState<WorkspaceSummary[] | 'loading' | 'failed'>('loading');
    useEffect(() => {
        if (sessionId) return;
        let live = true;
        setSessions('loading');
        listWorkspaces()
            .then(s => { if (live) setSessions(s); })
            .catch(() => { if (live) setSessions('failed'); });
        return () => { live = false; };
    }, [sessionId]);

    // ── the moderator config: draft == saved, every change writes through ──
    const [config, setConfig] = useState<QuizModeratorConfig>(
        () => loadModeratorConfig(sessionId) ?? { sessionId, updatedAt: '' });
    useEffect(() => {
        setConfig(loadModeratorConfig(sessionId) ?? { sessionId, updatedAt: '' });
    }, [sessionId]);
    const updateConfig = useCallback((mut: (c: QuizModeratorConfig) => QuizModeratorConfig) => {
        setConfig(prev => {
            const next = { ...mut(prev), updatedAt: new Date().toISOString() };
            saveModeratorConfig(next);
            return next;
        });
    }, []);

    // ── shared material: threads + lineage, one load per session ──
    const [material, setMaterial] = useState<TraceMaterial | 'loading' | 'failed'>('loading');
    useEffect(() => {
        if (!sessionId) return;
        let live = true;
        setMaterial('loading');
        loadTraceMaterial({ sessionId, liveState: stateRef.current })
            .then(m => { if (live) setMaterial(m); })
            .catch(() => { if (live) setMaterial('failed'); });
        return () => { live = false; };
    }, [sessionId]);

    const threads = useMemo(
        () => (typeof material === 'object' ? buildThreads(material) : []),
        [material]);
    const chartById = useMemo(
        () => new Map(typeof material === 'object' ? material.charts.map(c => [c.chartId, c]) : []),
        [material]);

    // ── recognition preview: the real generation, re-run on demand ──
    const [quiz, setQuiz] = useState<GeneratedQuiz | null>(null);
    const [quizError, setQuizError] = useState<string | null>(null);
    const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
    const [stale, setStale] = useState(false);
    const runIdRef = useRef(0);

    const regenerate = useCallback(async (cfg: QuizModeratorConfig) => {
        const runId = ++runIdRef.current;
        setQuiz(null); setQuizError(null); setStale(false);
        try {
            const generated = await generateQuizForSession({
                sessionId, sessionName, liveState: stateRef.current,
                config: cfg,
                onProgress: (done, total, label) => {
                    if (runIdRef.current === runId) setProgress({ done, total, label });
                },
            });
            if (runIdRef.current === runId) setQuiz(generated);
        } catch (e: any) {
            if (runIdRef.current === runId) setQuizError(e?.message || 'The quiz could not be generated.');
        }
    }, [sessionId, sessionName]);

    // First generation on entry. Config changes only mark the preview stale —
    // regenerating re-renders every option, so the moderator decides when.
    useEffect(() => {
        if (!sessionId) return;
        regenerate(loadModeratorConfig(sessionId) ?? { sessionId, updatedAt: '' });
    }, [sessionId, regenerate]);

    // ── recognition selection state ──
    const [inspectedId, setInspectedId] = useState<string | null>(null);
    const [authored, setAuthored] = useState<Record<string, AuthoredChart | 'loading' | 'failed'>>({});

    const inspect = useCallback(async (chartId: string) => {
        setInspectedId(prev => (prev === chartId ? null : chartId));
        if (authored[chartId]) return;
        setAuthored(prev => ({ ...prev, [chartId]: 'loading' }));
        try {
            const built = await authorViewForChart({ sessionId, liveState: stateRef.current, chartId });
            setAuthored(prev => ({ ...prev, [chartId]: built ?? 'failed' }));
        } catch {
            setAuthored(prev => ({ ...prev, [chartId]: 'failed' }));
        }
    }, [authored, sessionId]);

    /** The asked charts, in question order: the config's explicit list, else
     *  what the automatic generation picked. */
    const askedIds = useMemo(
        () => config.recognition?.chartIds ?? quiz?.items.map(i => i.chartId) ?? [],
        [config, quiz]);

    const toggleAsked = useCallback((chartId: string) => {
        const cur = new Set(askedIds);
        cur.has(chartId) ? cur.delete(chartId) : cur.add(chartId);
        // Order by the automatic (focus-time) ranking, so toggling never
        // scrambles the question order.
        const rankedIds = (quiz?.ranked ?? []).map(r => r.chartId);
        const ordered = [
            ...rankedIds.filter(id => cur.has(id)),
            ...[...cur].filter(id => !rankedIds.includes(id)),
        ];
        updateConfig(c => ({ ...c, recognition: { ...c.recognition, chartIds: ordered } }));
        setStale(true);
    }, [askedIds, quiz, updateConfig]);

    const togglePin = useCallback((chartId: string, method: 'visual' | 'data', key: string) => {
        updateConfig(c => {
            const preferred = { ...(c.recognition?.preferred ?? {}) };
            const forChart = { ...(preferred[chartId] ?? {}) };
            const list = [...(forChart[method] ?? [])];
            const at = list.indexOf(key);
            at >= 0 ? list.splice(at, 1) : list.push(key);
            forChart[method] = list;
            preferred[chartId] = forChart;
            return { ...c, recognition: { ...c.recognition, preferred } };
        });
        setStale(true);
    }, [updateConfig]);

    // ── provenance preview: synchronous, follows the config instantly ──
    const provPreview = useMemo(() => {
        if (typeof material !== 'object') return null;
        const p = config.provenance;
        return buildProvenanceMaterial(material, {
            count: p?.count,
            overrides: p ? { transitions: p.transitions, distractors: p.distractors } : undefined,
        });
    }, [material, config]);

    /** The moves currently asked, in item order — configured or sampled. */
    const askedTransitions = useMemo(
        () => config.provenance?.transitions
            ?? provPreview?.items.map(i => ({ from: i.from.chartId, to: i.answerChartId }))
            ?? [],
        [config, provPreview]);

    const toggleTransition = useCallback((from: string, to: string) => {
        const list = [...askedTransitions];
        const at = list.findIndex(t => t.from === from && t.to === to);
        at >= 0 ? list.splice(at, 1) : list.push({ from, to });
        updateConfig(c => ({ ...c, provenance: { ...c.provenance, transitions: list } }));
    }, [askedTransitions, updateConfig]);

    const setDistractor = useCallback((item: ProvenanceItem, slot: number, chartId: string) => {
        const key = transitionKey(item.from.chartId, item.answerChartId);
        const current = item.options.filter(o => o.chartId !== item.answerChartId).map(o => o.chartId);
        const next = [...current];
        next[slot] = chartId;
        updateConfig(c => ({
            ...c,
            provenance: { ...c.provenance, distractors: { ...(c.provenance?.distractors ?? {}), [key]: next } },
        }));
    }, [updateConfig]);

    const resetAll = useCallback(() => {
        clearModeratorConfig(sessionId);
        const fresh = { sessionId, updatedAt: '' };
        setConfig(fresh);
        regenerate(fresh);
    }, [sessionId, regenerate]);

    const moderated = !!(config.recognition || config.provenance);

    // ── provenance derivations ───────────────────────────────────────────
    // Hooks, so they MUST sit above the landing panel's early return — the
    // hook count may not change between the panel render and a session render.

    /** chartId → the roles it plays in the previewed items. */
    const provRoles = useMemo(() => {
        const roles = new Map<string, { label: string; color: string; title: string }[]>();
        const add = (id: string, label: string, color: string, title: string) => {
            const list = roles.get(id) ?? [];
            list.push({ label, color, title });
            roles.set(id, list);
        };
        (provPreview?.items ?? []).forEach((item, k) => {
            add(item.from.chartId, `Q${k + 1} from`, theme.palette.info.dark, 'the chart the participant stands on');
            add(item.answerChartId, `Q${k + 1} answer`, theme.palette.success.main, 'the chart they really made next');
            for (const o of item.options) {
                if (o.chartId !== item.answerChartId) add(o.chartId, `Q${k + 1} lure`, theme.palette.warning.dark, 'offered as a distractor');
            }
        });
        return roles;
    }, [provPreview, theme]);

    /** Charts shown on screen by more than one item leak answers across items. */
    const provConflicts = useMemo(() => {
        const shownBy = new Map<string, number[]>();
        (provPreview?.items ?? []).forEach((item, k) => {
            const shown = [item.previous?.chartId, item.from.chartId, item.answerChartId].filter(Boolean) as string[];
            for (const id of shown) {
                const list = shownBy.get(id) ?? [];
                list.push(k + 1);
                shownBy.set(id, list);
            }
        });
        return [...shownBy.entries()]
            .filter(([, items]) => items.length > 1)
            .map(([id, items]) => `#${chartById.get(id)?.num ?? '?'} appears in Q${items.join(' and Q')}`);
    }, [provPreview, chartById]);

    // ── early exits ──────────────────────────────────────────────────────

    // ── the landing panel: pick the participant's session ────────────────
    if (!sessionId) {
        const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');
        return (
            <Box sx={{ height: '100%', overflowY: 'auto', backgroundColor: 'white' }}>
                <Box sx={{ p: 3, maxWidth: 980, mx: 'auto' }}>
                    <Typography sx={{ fontSize: 18, fontWeight: 700 }}>Quiz moderator</Typography>
                    <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mb: 2 }}>
                        Pick the participant's session to configure its quiz.
                    </Typography>
                    {sessions === 'loading' && (
                        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                            <CircularProgress size={14} />
                            <Typography sx={{ fontSize: 12.5 }}>Loading the sessions…</Typography>
                        </Box>
                    )}
                    {sessions === 'failed' && (
                        <Typography sx={{ fontSize: 12.5, color: 'error.main' }}>
                            The session list could not be read.
                        </Typography>
                    )}
                    {Array.isArray(sessions) && sessions.length === 0 && (
                        <Typography sx={{ fontSize: 12.5, color: 'text.secondary' }}>
                            No sessions yet — run an analysis first.
                        </Typography>
                    )}
                    {Array.isArray(sessions) && sessions.map(s => {
                        const hasConfig = !!loadModeratorConfig(s.id);
                        const isActive = s.id === activeWorkspace?.id;
                        return (
                            <Box key={s.id}
                                onClick={() => navigate(`/quiz-moderator?session=${encodeURIComponent(s.id)}&name=${encodeURIComponent(s.display_name || s.id)}`)}
                                sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 1.5, py: 1, mb: 0.75,
                                      border: `1px solid ${borderColor.view}`, borderRadius: radius.sm, cursor: 'pointer',
                                      '&:hover': { borderColor: theme.palette.primary.main,
                                                   background: alpha(theme.palette.primary.main, 0.03) } }}>
                                <Box sx={{ flex: 1, minWidth: 0 }}>
                                    <Typography component="div" noWrap sx={{ fontSize: 13, fontWeight: 600 }}>
                                        {s.display_name || s.id}
                                        {isActive && <Chip size="small" label="open now" sx={{ ml: 1, height: 16, fontSize: 9,
                                            backgroundColor: alpha(theme.palette.success.main, 0.12), color: 'success.main' }} />}
                                        {hasConfig && <Chip size="small" label="moderated" sx={{ ml: 0.5, height: 16, fontSize: 9,
                                            backgroundColor: alpha(theme.palette.primary.main, 0.12), color: 'primary.main' }} />}
                                    </Typography>
                                    <Typography noWrap sx={{ fontSize: 10.5, color: 'text.disabled', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                                        {s.id}
                                    </Typography>
                                </Box>
                                <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
                                    <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
                                        {s.chart_count != null ? `${s.chart_count} chart(s)` : ''}
                                        {s.table_count != null ? ` · ${s.table_count} table(s)` : ''}
                                    </Typography>
                                    <Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>
                                        saved {fmt(s.saved_at)}
                                    </Typography>
                                </Box>
                            </Box>
                        );
                    })}
                    <Button size="small" startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />}
                        onClick={() => navigate('/app')} sx={{ mt: 1, textTransform: 'none', fontSize: 11.5 }}>
                        Back to the app
                    </Button>
                </Box>
            </Box>
        );
    }

    // ── small pieces ─────────────────────────────────────────────────────

    const badge = (label: string, color: string, title?: string) => (
        <Tooltip key={label} title={title ?? ''} disableHoverListener={!title}>
            <Chip size="small" label={label}
                sx={{ height: 17, fontSize: 9.5, backgroundColor: alpha(color, 0.14), color }} />
        </Tooltip>
    );

    /**
     * One chart card in a thread row. The overlays differ per tab, so they
     * arrive as children; the card itself is the shared shape.
     */
    const chartCard = (c: TraceChart, opts: {
        selected?: boolean; dimmed?: boolean; onClick?: () => void; overlays: ReactNode;
    }) => (
        <Box key={c.chartId}
            onClick={opts.onClick}
            sx={{ width: 168, flexShrink: 0, border: `2px solid ${opts.selected ? theme.palette.primary.main : borderColor.view}`,
                  borderRadius: radius.sm, p: 0.75, background: '#fff', cursor: opts.onClick ? 'pointer' : 'default',
                  opacity: opts.dimmed ? 0.45 : 1,
                  '&:hover': opts.onClick ? { borderColor: theme.palette.primary.main } : {} }}>
            <img src={svgUri(c.svg)} alt="" style={{ width: '100%', height: 92, objectFit: 'contain', display: 'block' }} />
            <Typography noWrap sx={{ fontSize: 10.5, fontWeight: 600, mt: 0.25 }}>
                #{c.num} <Box component="span" sx={{ fontWeight: 400, color: 'text.secondary' }}>{c.title}</Box>
            </Typography>
            <Box sx={{ display: 'flex', gap: 0.4, flexWrap: 'wrap', mt: 0.4, minHeight: 18 }}>
                {opts.overlays}
            </Box>
        </Box>
    );

    const threadRows = (renderCard: (c: TraceChart) => ReactNode) => (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
            {threads.map(row => (
                <Box key={row.rootId} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5,
                        overflowX: 'auto', p: 1, border: `1px solid ${borderColor.view}`, borderRadius: radius.sm,
                        background: alpha(theme.palette.primary.main, 0.015) }}>
                    {row.charts.map((c, i) => (
                        <React.Fragment key={c.chartId}>
                            {i > 0 && (
                                <Box sx={{ alignSelf: 'center', color: 'text.disabled', fontSize: 14, px: 0.25, flexShrink: 0 }}>
                                    →
                                </Box>
                            )}
                            {renderCard(c)}
                        </React.Fragment>
                    ))}
                </Box>
            ))}
            {typeof material === 'object' && material.skipped.length > 0 && (
                <Typography sx={{ fontSize: 10.5, color: 'text.disabled' }}>
                    Not shown (did not render): {material.skipped.join(', ')}
                </Typography>
            )}
        </Box>
    );

    // ── recognition tab ──────────────────────────────────────────────────

    const itemByChart = new Map<string, QuizItem>((quiz?.items ?? []).map(i => [i.chartId, i]));
    const skipByChart = new Map((quiz?.skipped ?? []).map(s => [s.chartId, s.reason]));
    const focusByChart = new Map((quiz?.ranked ?? []).map(r => [r.chartId, r.focusMs]));

    const recognitionCard = (c: TraceChart) => {
        const asked = askedIds.includes(c.chartId);
        const qNum = askedIds.indexOf(c.chartId);
        const skipReason = skipByChart.get(c.chartId);
        const overlays: ReactNode[] = [];
        if (asked && !skipReason) overlays.push(badge(`Q${qNum + 1}`, theme.palette.primary.main, 'asked in the recognition quiz'));
        if (asked && skipReason) overlays.push(badge('skipped', theme.palette.error.main, skipReason));
        if (!asked) overlays.push(badge('not asked', theme.palette.text.disabled as string));
        const focusMs = focusByChart.get(c.chartId) ?? 0;
        if (focusMs > 0) overlays.push(badge(`${Math.round(focusMs / 1000)}s`, theme.palette.text.secondary as string, 'focus time'));
        overlays.push(
            <Chip key="toggle" size="small"
                label={asked ? 'exclude' : 'ask'}
                onClick={(e) => { e.stopPropagation(); toggleAsked(c.chartId); }}
                sx={{ height: 17, fontSize: 9.5, cursor: 'pointer' }} />,
        );
        return chartCard(c, {
            selected: inspectedId === c.chartId,
            dimmed: !asked,
            onClick: () => inspect(c.chartId),
            overlays,
        });
    };

    /** The exact option matrix the participant will see for one asked chart. */
    const matrixPreview = (item: QuizItem) => (
        <Box sx={{ mb: 1.5 }}>
            <Typography sx={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'primary.main', mb: 0.5 }}>
                The option matrix, as generated ({item.options.length} options)
            </Typography>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 1 }}>
                {[...item.options].sort((a, b) => a.cell.v - b.cell.v || a.cell.d - b.cell.d).map((o: QuizOption) => (
                    <Box key={o.id} sx={{ border: `2px solid ${o.id === item.correctId ? theme.palette.success.main : borderColor.view}`,
                            borderRadius: radius.sm, p: 0.5, background: '#fff' }}>
                        <img src={svgUri(o.svg)} alt="" style={{ width: '100%', height: 110, objectFit: 'contain', display: 'block' }} />
                        <Typography sx={{ fontSize: 9.5, color: o.method ? METHOD_COLOR[o.method] : 'success.main', mt: 0.25 }}>
                            {o.method ? `${lureTag(o)} · ${o.label ?? o.op}` : 'the real chart'}
                            {o.method && <Box component="span" sx={{ color: 'text.disabled' }}> · form {o.specDist} · values {o.dataDist}</Box>}
                        </Typography>
                    </Box>
                ))}
            </Box>
        </Box>
    );

    /** Every perturbation an axis can make, with a pin to prefer it. */
    const perturbationList = (chartId: string) => {
        const state = authored[chartId];
        if (!state || state === 'loading') {
            return (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1 }}>
                    <CircularProgress size={14} />
                    <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>Building every perturbation…</Typography>
                </Box>
            );
        }
        if (state === 'failed') {
            return <Typography sx={{ fontSize: 11.5, color: 'error.main', py: 1 }}>
                This chart could not be rendered, so no perturbations could be made.
            </Typography>;
        }
        const preferred = config.recognition?.preferred?.[chartId];
        return (
            <Box>
                <Typography sx={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'text.secondary', mb: 0.5 }}>
                    Every perturbation, by axis — pin the ones the matrix should try first, then regenerate
                </Typography>
                {state.byMethod.map(group => (
                    <Box key={group.method} sx={{ mb: 1 }}>
                        <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: METHOD_COLOR[group.method], mb: 0.5 }}>
                            {group.method} · {group.lures.length}
                        </Typography>
                        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 1 }}>
                            {group.lures.map(lure => {
                                const key = lureKey(lure.op, lure.label);
                                const pinnable = group.method !== 'combined';
                                const pinned = pinnable && (preferred?.[group.method as 'visual' | 'data'] ?? []).includes(key);
                                return (
                                    <Box key={lure.id} sx={{ border: `1px solid ${borderColor.view}`,
                                            borderTop: `3px solid ${METHOD_COLOR[lure.method]}`,
                                            borderRadius: radius.sm, p: 0.75, background: '#fff',
                                            opacity: lure.quizEligible ? 1 : 0.6, position: 'relative' }}>
                                        {pinnable && (
                                            <Tooltip title={pinned ? 'unpin — back to automatic order' : 'pin — try this lure first'}>
                                                <IconButton size="small"
                                                    onClick={() => togglePin(chartId, group.method as 'visual' | 'data', key)}
                                                    sx={{ position: 'absolute', top: 2, right: 2, p: 0.25,
                                                          color: pinned ? 'primary.main' : 'text.disabled' }}>
                                                    {pinned ? <PushPinIcon sx={{ fontSize: 14 }} /> : <PushPinOutlinedIcon sx={{ fontSize: 14 }} />}
                                                </IconButton>
                                            </Tooltip>
                                        )}
                                        <img src={svgUri(lure.svg)} alt="" style={{ width: '100%', height: 110, objectFit: 'contain', display: 'block' }} />
                                        <Typography sx={{ fontSize: 10.5, fontWeight: 500, mt: 0.25 }}>{lure.label}</Typography>
                                        <Typography sx={{ fontSize: 9.5, color: METHOD_COLOR[lure.method] }}>
                                            {lureTag(lure)} · form {lure.specDist} · values {lure.dataDist}
                                        </Typography>
                                        {!lure.quizEligible && (
                                            <Typography sx={{ fontSize: 9, color: 'text.disabled' }}>not eligible: {lure.caveat}</Typography>
                                        )}
                                    </Box>
                                );
                            })}
                        </Box>
                    </Box>
                ))}
                {state.rejected.length > 0 && (
                    <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
                        Rejected by the render guard: {state.rejected.map(r => `${r.label} (${r.reason})`).join('; ')}
                    </Typography>
                )}
            </Box>
        );
    };

    const recognitionBody = () => {
        if (typeof material !== 'object') {
            return material === 'failed'
                ? <Typography sx={{ p: 2, fontSize: 12.5, color: 'error.main' }}>The session's charts could not be prepared.</Typography>
                : <Box sx={{ p: 2, display: 'flex', gap: 1, alignItems: 'center' }}>
                    <CircularProgress size={14} /><Typography sx={{ fontSize: 12.5 }}>Laying out the threads…</Typography>
                  </Box>;
        }
        const inspected = inspectedId ? chartById.get(inspectedId) : null;
        const inspectedItem = inspectedId ? itemByChart.get(inspectedId) : null;
        return (
            <Box sx={{ p: 1.5 }}>
                {/* generation status */}
                {!quiz && !quizError && (
                    <Box sx={{ mb: 1 }}>
                        <LinearProgress variant={progress.total ? 'determinate' : 'indeterminate'}
                            value={progress.total ? (100 * progress.done) / progress.total : 0} />
                        <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mt: 0.25 }}>
                            Generating the quiz preview… {progress.label}
                        </Typography>
                    </Box>
                )}
                {quizError && <Typography sx={{ fontSize: 12, color: 'error.main', mb: 1 }}>{quizError}</Typography>}
                {stale && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, p: 0.75,
                            background: alpha(theme.palette.warning.main, 0.08), borderRadius: radius.sm }}>
                        <Typography sx={{ fontSize: 11.5, color: 'warning.dark', flex: 1 }}>
                            The selection changed — regenerate to preview the updated quiz. The participant quiz already uses the saved selection.
                        </Typography>
                        <Button size="small" startIcon={<ReplayIcon sx={{ fontSize: 14 }} />}
                            onClick={() => regenerate(config)} sx={{ fontSize: 11.5, textTransform: 'none' }}>
                            Regenerate preview
                        </Button>
                    </Box>
                )}
                {quiz && (
                    <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mb: 1 }}>
                        {askedIds.length} chart(s) selected of {quiz.chartsConsidered} · {quiz.items.length} question(s) generated
                        {quiz.skipped.length > 0 && ` · ${quiz.skipped.length} skipped`}
                        {config.recognition?.chartIds ? ' · selection: moderated' : ' · selection: automatic (focus time)'}
                    </Typography>
                )}
                {threadRows(recognitionCard)}
                {/* inspector */}
                {inspected && (
                    <Box sx={{ mt: 1.5, p: 1.25, border: `1px solid ${borderColor.view}`, borderRadius: radius.sm }}>
                        <Typography sx={{ fontSize: 12.5, fontWeight: 600, mb: 1 }}>
                            #{inspected.num} {inspected.title}
                        </Typography>
                        {inspectedItem
                            ? matrixPreview(inspectedItem)
                            : <Typography sx={{ fontSize: 11, color: 'text.disabled', mb: 1 }}>
                                {skipByChart.get(inspected.chartId)
                                    ? `No question for this chart — ${skipByChart.get(inspected.chartId)}.`
                                    : 'No question generated for this chart in the current preview.'}
                              </Typography>}
                        {perturbationList(inspected.chartId)}
                    </Box>
                )}
            </Box>
        );
    };

    // ── provenance tab ───────────────────────────────────────────────────

    const provenanceCard = (c: TraceChart) => {
        const overlays: ReactNode[] = [];
        // The edge chip: this chart's own lineage move (parent → it), toggleable.
        if (c.parentChartId) {
            const parent = chartById.get(c.parentChartId);
            const at = askedTransitions.findIndex(t => t.from === c.parentChartId && t.to === c.chartId);
            overlays.push(
                <Chip key="edge" size="small"
                    label={at >= 0 ? `Q${at + 1} · move #${parent?.num}→#${c.num}` : `move #${parent?.num}→#${c.num}`}
                    onClick={() => toggleTransition(c.parentChartId!, c.chartId)}
                    sx={{ height: 17, fontSize: 9.5, cursor: 'pointer',
                          backgroundColor: at >= 0 ? alpha(theme.palette.primary.main, 0.16) : undefined,
                          color: at >= 0 ? 'primary.main' : 'text.secondary' }} />,
            );
        }
        for (const r of provRoles.get(c.chartId) ?? []) overlays.push(badge(r.label, r.color, r.title));
        return chartCard(c, { overlays });
    };

    /** One previewed item, with its distractors editable. */
    const provItemCard = (item: ProvenanceItem, k: number) => {
        const distractors = item.options.filter(o => o.chartId !== item.answerChartId);
        const excluded = new Set([item.from.chartId, item.answerChartId, item.previous?.chartId].filter(Boolean) as string[]);
        const thumb = (c: TraceChart, label: string, color: string) => (
            <Box sx={{ width: 128 }}>
                <Typography sx={{ fontSize: 9, color, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</Typography>
                <img src={svgUri(c.svg)} alt="" style={{ width: '100%', height: 74, objectFit: 'contain', display: 'block',
                    border: `1px solid ${borderColor.view}`, borderRadius: 4, background: '#fff' }} />
                <Typography noWrap sx={{ fontSize: 9.5, color: 'text.secondary' }}>#{c.num} {c.title}</Typography>
            </Box>
        );
        return (
            <Box key={item.id} sx={{ border: `1px solid ${borderColor.view}`, borderRadius: radius.sm, p: 1, mb: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                    <Typography sx={{ fontSize: 11.5, fontWeight: 600 }}>Q{k + 1}</Typography>
                    <Typography sx={{ fontSize: 10.5, color: 'text.secondary' }}>
                        standing on #{item.from.num} — which chart came next?
                    </Typography>
                    {config.provenance?.transitions && (
                        <Tooltip title="remove this move from the quiz">
                            <IconButton size="small" onClick={() => toggleTransition(item.from.chartId, item.answerChartId)}
                                sx={{ p: 0.25, ml: 'auto', color: 'text.disabled' }}>
                                <DeleteOutlineIcon sx={{ fontSize: 15 }} />
                            </IconButton>
                        </Tooltip>
                    )}
                </Box>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    {item.previous && thumb(item.previous, 'context (before)', theme.palette.text.disabled as string)}
                    {thumb(item.from, 'standing on', theme.palette.info.dark)}
                    {thumb(chartById.get(item.answerChartId)!, 'answer — made next', theme.palette.success.main)}
                    {distractors.map((d, slot) => (
                        <Box key={`${item.id}_d${slot}`} sx={{ width: 150 }}>
                            <Typography sx={{ fontSize: 9, color: 'warning.dark', textTransform: 'uppercase', letterSpacing: '.05em' }}>
                                distractor {slot + 1}
                            </Typography>
                            <img src={svgUri(d.svg)} alt="" style={{ width: '100%', height: 74, objectFit: 'contain', display: 'block',
                                border: `1px solid ${borderColor.view}`, borderRadius: 4, background: '#fff' }} />
                            <Select size="small" value={d.chartId}
                                onChange={e => setDistractor(item, slot, e.target.value)}
                                sx={{ mt: 0.25, width: '100%', fontSize: 10.5, '& .MuiSelect-select': { py: 0.25 } }}>
                                {(typeof material === 'object' ? material.charts : [])
                                    .filter(c => !excluded.has(c.chartId)
                                        || c.chartId === d.chartId)
                                    .filter(c => c.chartId === d.chartId
                                        || !distractors.some((other, oi) => oi !== slot && other.chartId === c.chartId))
                                    .map(c => (
                                        <MenuItem key={c.chartId} value={c.chartId} sx={{ fontSize: 10.5 }}>
                                            #{c.num} {c.title}
                                        </MenuItem>
                                    ))}
                            </Select>
                        </Box>
                    ))}
                </Box>
            </Box>
        );
    };

    const provenanceBody = () => {
        if (typeof material !== 'object') {
            return material === 'failed'
                ? <Typography sx={{ p: 2, fontSize: 12.5, color: 'error.main' }}>The session's charts could not be prepared.</Typography>
                : <Box sx={{ p: 2, display: 'flex', gap: 1, alignItems: 'center' }}>
                    <CircularProgress size={14} /><Typography sx={{ fontSize: 12.5 }}>Laying out the threads…</Typography>
                  </Box>;
        }
        const auto = !config.provenance?.transitions;
        return (
            <Box sx={{ p: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, flexWrap: 'wrap' }}>
                    <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
                        {provPreview?.items.length ?? 0} item(s) of {provPreview?.transitionsAvailable ?? 0} possible move(s)
                        · sampling: {auto ? 'automatic (seeded)' : 'moderated'}
                    </Typography>
                    {auto && (
                        <TextField size="small" type="number" label="items" value={config.provenance?.count ?? 4}
                            onChange={e => {
                                const n = Math.max(1, Number(e.target.value) || 1);
                                updateConfig(c => ({ ...c, provenance: { ...c.provenance, count: n } }));
                            }}
                            sx={{ width: 76, '& input': { fontSize: 11.5, py: 0.5 } }} InputLabelProps={{ sx: { fontSize: 11.5 } }} />
                    )}
                    {!auto && (
                        <Button size="small" onClick={() => updateConfig(c => ({
                                ...c, provenance: { ...c.provenance, transitions: undefined } }))}
                            sx={{ fontSize: 11, textTransform: 'none' }}>
                            Back to automatic sampling
                        </Button>
                    )}
                </Box>
                <Typography sx={{ fontSize: 10.5, color: 'text.disabled', mb: 1 }}>
                    Click a chart's "move" chip to ask (or stop asking) that move. The items below update immediately, and the participant quiz follows.
                </Typography>
                {provConflicts.length > 0 && (
                    <Typography sx={{ fontSize: 11, color: 'warning.dark', mb: 1 }}>
                        ⚠ Overlapping items can leak answers: {provConflicts.join('; ')}.
                    </Typography>
                )}
                {threadRows(provenanceCard)}
                <Typography sx={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.06em', color: 'text.secondary', mt: 1.5, mb: 0.75 }}>
                    The items, as the participant will get them
                </Typography>
                {(provPreview?.items ?? []).map(provItemCard)}
                {(provPreview?.items.length ?? 0) === 0 && (
                    <Typography sx={{ fontSize: 11.5, color: 'text.disabled' }}>
                        No items — the session needs at least one lineage move (and two other charts as options).
                    </Typography>
                )}
            </Box>
        );
    };

    // ── shell ────────────────────────────────────────────────────────────

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: 'white' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 0.75, borderBottom: `1px solid ${borderColor.view}`, gap: 1, flexShrink: 0 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                    {/* component="div": a Chip (a div) may not sit inside a <p> */}
                    <Typography component="div" sx={{ fontSize: 13, fontWeight: 500 }}>
                        Quiz moderator
                        {moderated && <Chip size="small" label="moderated" sx={{ ml: 1, height: 17, fontSize: 9.5,
                            backgroundColor: alpha(theme.palette.primary.main, 0.12), color: 'primary.main' }} />}
                    </Typography>
                    <Typography noWrap sx={{ fontSize: 11, color: 'text.disabled' }}>
                        {sessionName}
                        {config.updatedAt && ` · saved ${new Date(config.updatedAt).toLocaleTimeString()}`}
                    </Typography>
                </Box>
                <Button size="small" startIcon={<ArrowBackIcon sx={{ fontSize: 14 }} />}
                    onClick={() => navigate('/quiz-moderator')}
                    sx={{ fontSize: 11.5, textTransform: 'none' }}>
                    All sessions
                </Button>
                <Button size="small" startIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
                    onClick={() => navigate(`/chart-memory?session=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(sessionName)}`)}
                    sx={{ fontSize: 11.5, textTransform: 'none' }}>
                    Open the quiz
                </Button>
                <Button size="small" color="warning" onClick={resetAll} sx={{ fontSize: 11.5, textTransform: 'none' }}>
                    Clear all overrides
                </Button>
            </Box>
            <Tabs value={tab} onChange={(_, v) => setTab(v)}
                sx={{ minHeight: 34, borderBottom: `1px solid ${borderColor.view}`, flexShrink: 0,
                      '& .MuiTab-root': { minHeight: 34, fontSize: 12, textTransform: 'none', py: 0 } }}>
                <Tab value="recognition" label="Recognition task" />
                <Tab value="provenance" label="Provenance task" />
            </Tabs>
            <Box sx={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                <Box sx={{ maxWidth: 1560, mx: 'auto', width: '100%' }}>
                    {tab === 'recognition' ? recognitionBody() : provenanceBody()}
                </Box>
            </Box>
        </Box>
    );
};
