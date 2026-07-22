// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// In-app rendering of the analysis graph, in two modes:
//
//   TOPICS (default, src/app/analysisSemanticThreads.ts) — an LLM clusters the
//   session's charts (titles + attribute sets + driving prompts) into semantic
//   threads: one column per direction of inquiry, charts ordered as a
//   narrative progression within it. Breadth = how many topics were explored,
//   depth = how far each went. Results are cached per chart-set signature.
//
//   STRUCTURE (src/app/analysisHybridGraph.ts) — the deterministic hybrid
//   graph: Battle & Heer's attribute-set states fused with the data thread's
//   charts and prompts. A node is a unique attribute set, named by the titles
//   of its charts (each numbered by creation time). An edge is the prompt that
//   moved the analysis from one set to the next; ↻ lines are in-place
//   refinements. Layout follows the birth-edge spanning tree.
//
// Both modes share one visual language, aimed at a facilitator monitoring the
// analysis process:
//   - ROLE — who drove each chart (user vs agent, from the prompt behind it) —
//     is shown as a colored left edge + badge on every chart card, in the same
//     colors the data thread uses (user = warm `custom`, agent = `primary`).
//   - VIEWING TIME — captured passively by src/app/chartUsageTelemetry.ts —
//     appears as a neutral heat chip on every chart (background intensity =
//     share of the most-viewed chart), so attention hotspots pop out.
//
// Chart numbers (#1..#N, creation order) match across both modes. Opened from
// a floating button on the thread pane. Selecting a chart previews it in the
// side panel — the dialog stays open, so the graph remains the place you read
// the analysis from; an explicit "Open on canvas" button is the way out.
// While the dialog is open, usage tracking is paused (reading the graph must
// not inflate the chart focused behind it).

import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
    Box, Button, Chip, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton,
    ToggleButton, ToggleButtonGroup, Tooltip, Typography, useTheme,
} from '@mui/material';
import { Theme, alpha } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import RefreshIcon from '@mui/icons-material/Refresh';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { ChartUsageEntry, DataFormulatorState, dfActions, dfSelectors } from '../app/dfSlice';
import { AppDispatch } from '../app/store';
import {
    HybridEdge, HybridGraph, HybridNode, PromptSource, buildHybridGraph,
} from '../app/analysisHybridGraph';
import {
    SemanticChartItem, SemanticThreadsResult, collectSemanticChartItems, fetchSemanticThreads,
    semanticThreadsSignature,
} from '../app/analysisSemanticThreads';
import {
    describeChartUsage, formatViewDuration, pushChartUsagePause, totalChartUsageMs,
} from '../app/chartUsageTelemetry';
import { getCachedChart } from '../app/chartCache';

// ─── roles (who drove a chart) ───────────────────────────────────────────────

// Prompt-source colors, matched to the data thread: the user's warm `custom`
// palette (DataThread colors user entries with `palette.custom.main`) and the
// agent's `primary` accent (the toy/summary color).
const srcMain = (theme: Theme, source: PromptSource): string =>
    source === 'agent' ? theme.palette.primary.main : theme.palette.custom.main;
const srcText = (theme: Theme, source: PromptSource): string =>
    source === 'agent' ? (theme.palette.primary.textColor || theme.palette.primary.main)
        : (theme.palette.custom.textColor || theme.palette.custom.main);

/** A chart with no prompt behind it was built manually — still the user. */
const roleLabel = (source: PromptSource): string => (source === 'agent' ? 'Agent' : 'User');
const sourceLabel = (source: PromptSource): string =>
    source === 'user' ? 'Driven by a user prompt'
        : source === 'agent' ? 'Initiated by the agent'
            : 'Built manually by the user';

/** Small person/robot glyph tinted in the role's thread color. */
const SourceIcon: FC<{ source: PromptSource; size?: number }> = ({ source, size = 12 }) => {
    const theme = useTheme();
    const color = srcMain(theme, source);
    return source === 'agent'
        ? <SmartToyOutlinedIcon sx={{ fontSize: size, color, flexShrink: 0 }} />
        : <PersonIcon sx={{ fontSize: size, color, flexShrink: 0 }} />;
};

/** The obvious who-made-this marker: icon + "User"/"Agent" pill. */
const RoleBadge: FC<{ source: PromptSource }> = ({ source }) => {
    const theme = useTheme();
    const color = srcMain(theme, source);
    return (
        <Tooltip title={sourceLabel(source)}>
            <Box sx={{
                display: 'inline-flex', alignItems: 'center', gap: '3px', flexShrink: 0,
                padding: '0px 6px 0px 4px', borderRadius: '9px', lineHeight: '15px',
                backgroundColor: alpha(color, 0.1), border: `1px solid ${alpha(color, 0.35)}`,
                color: srcText(theme, source), fontSize: 9.5, fontWeight: 700,
                textTransform: 'uppercase', letterSpacing: 0.3,
            }}>
                {source === 'agent'
                    ? <SmartToyOutlinedIcon sx={{ fontSize: 11 }} />
                    : <PersonIcon sx={{ fontSize: 11 }} />}
                {roleLabel(source)}
            </Box>
        </Tooltip>
    );
};

// ─── viewing-time chips (chart usage telemetry) ──────────────────────────────

/** Compact dwell-time chip; background heat = share of the most-viewed chart.
 *  Neutral gray on purpose — hues here belong to roles and topics. */
const UsageChip: FC<{ entry?: ChartUsageEntry; maxMs: number }> = ({ entry, maxMs }) => {
    const theme = useTheme();
    const ms = entry?.focusMs ?? 0;
    const share = maxMs > 0 ? ms / maxMs : 0;
    return (
        <Tooltip title={describeChartUsage(entry)}>
            <Box sx={{
                display: 'inline-flex', alignItems: 'center', gap: '3px', flexShrink: 0,
                padding: '0px 6px', borderRadius: '9px', lineHeight: '15px',
                backgroundColor: alpha(theme.palette.text.primary, ms > 0 ? 0.06 + 0.22 * share : 0.03),
                color: ms > 0 ? 'text.secondary' : 'text.disabled',
                fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
            }}>
                <AccessTimeIcon sx={{ fontSize: 11 }} />
                {ms > 0 ? formatViewDuration(ms, 'compact') : '—'}
            </Box>
        </Tooltip>
    );
};

/** Legend strip shown under the dialog title — one line explaining the two
 *  role colors and the time chips, shared by both modes. */
const GraphLegend: FC = () => {
    const theme = useTheme();
    const item = (icon: React.ReactNode, text: string) => (
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
            {icon}
            <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>{text}</Typography>
        </Box>
    );
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, px: 3, pb: 1, flexShrink: 0 }}>
            {item(<PersonIcon sx={{ fontSize: 13, color: theme.palette.custom.main }} />, 'User-driven')}
            {item(<SmartToyOutlinedIcon sx={{ fontSize: 13, color: theme.palette.primary.main }} />, 'Agent-driven')}
            {item(<AccessTimeIcon sx={{ fontSize: 12, color: 'text.secondary' }} />, 'time actively viewed (darker = more)')}
        </Box>
    );
};

// ─── side-panel chart preview ────────────────────────────────────────────────

/** The chart itself, drawn in the side panel.
 *
 *  ChartRenderService renders every chart off-screen, writing a full-size PNG
 *  to the module-level chart cache and a thumbnail to redux. The module cache
 *  is not reactive, so subscribe to the thumbnail — the two are written
 *  together, so that subscription is what re-renders us once the full-size PNG
 *  is available (and it doubles as the fallback source). */
const ChartPreview: FC<{ chartId: string; chartType: string; height?: number }> = ({
    chartId, chartType, height = 150,
}) => {
    const thumbnail = useSelector((s: DataFormulatorState) => s.chartThumbnails?.[chartId]);
    const src = getCachedChart(chartId)?.fullPngDataUrl || thumbnail;

    const placeholder = (msg: string) => (
        <Box sx={{
            height, display: 'flex', alignItems: 'center', justifyContent: 'center',
            border: t => `1px dashed ${t.palette.divider}`, borderRadius: 1,
            fontSize: 11, color: 'text.disabled',
        }}>{msg}</Box>
    );
    if (chartType === 'Table' || chartType === '?') return placeholder('No chart preview');
    if (!src) return placeholder('Rendering…');
    return (
        <Box component="img" src={src} alt=""
            sx={{
                width: '100%', height, objectFit: 'contain', display: 'block',
                backgroundColor: 'background.paper',
                border: t => `1px solid ${t.palette.divider}`, borderRadius: 1,
            }} />
    );
};

/** Side-panel entry for one chart: name, role, preview, viewing time, and a
 *  way out to the canvas. */
const ChartPanelCard: FC<{
    num: number; title: string; chartType: string; chartId: string;
    accent: string; role?: PromptSource; usage?: ChartUsageEntry;
    onOpen: () => void; children?: React.ReactNode;
}> = ({ num, title, chartType, chartId, accent, role, usage, onOpen, children }) => {
    const theme = useTheme();
    return (
        <Box sx={{
            p: 1, border: t => `1px solid ${t.palette.divider}`, borderRadius: 1,
            borderLeft: role !== undefined ? `3px solid ${srcMain(theme, role)}` : undefined,
            display: 'flex', flexDirection: 'column', gap: 0.75,
        }}>
            <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75 }}>
                <Typography variant="body2" sx={{ fontWeight: 550, lineHeight: 1.3, flex: 1, minWidth: 0 }}>
                    <span style={{ color: accent, fontWeight: 700 }}>#{num}</span>&nbsp;{title}
                </Typography>
                {role !== undefined && <RoleBadge source={role} />}
            </Box>
            <ChartPreview chartId={chartId} chartType={chartType} />
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
                <AccessTimeIcon sx={{ fontSize: 12 }} />
                <Typography variant="caption">{describeChartUsage(usage)}</Typography>
            </Box>
            {children}
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                <Typography variant="caption" color="text.secondary">{chartType}</Typography>
                <Button size="small" onClick={onOpen}
                    sx={{ textTransform: 'none', fontSize: 11, minWidth: 0, py: 0 }}>
                    Open on canvas →
                </Button>
            </Box>
        </Box>
    );
};

// ─── Structure mode layout ───────────────────────────────────────────────────

const NW = 228, GX = 260, GY = 192, PAD = 40;
const ROOT_H = 38, ROOT_W = 168;
const MAX_TITLES = 3, MAX_LOOPS = 2;
const LABEL_W = 210;

/** Card height grows with the titles + self-loop lines it shows. */
const nodeHeight = (n: HybridNode, loops: number): number => {
    if (n.isRoot) return ROOT_H;
    const titleLines = Math.min(n.charts.length, MAX_TITLES);
    const loopLines = Math.min(loops, MAX_LOOPS);
    return 18 + titleLines * 18 + 15 + loopLines * 15 + (n.charts.length > MAX_TITLES ? 13 : 0);
};

interface Placed { node: HybridNode; x: number; y: number; h: number; }

const layout = (graph: HybridGraph, loopsByNode: Map<string, HybridEdge[]>) => {
    const children = new Map<string, HybridNode[]>();
    for (const n of graph.nodes) {
        if (!n.parentId) continue;
        if (!children.has(n.parentId)) children.set(n.parentId, []);
        children.get(n.parentId)!.push(n);
    }
    for (const kids of children.values()) kids.sort((a, b) => a.firstNum - b.firstNum);

    const centers = new Map<string, number>();
    let nextSlot = 0;
    const assign = (id: string): number => {
        const kids = children.get(id) || [];
        if (kids.length === 0) {
            const c = PAD + nextSlot * GX + NW / 2;
            nextSlot++;
            centers.set(id, c);
            return c;
        }
        const kc = kids.map(k => assign(k.id));
        const c = (kc[0] + kc[kc.length - 1]) / 2;
        centers.set(id, c);
        return c;
    };
    for (const rid of graph.rootIds) assign(rid);
    for (const n of graph.nodes) if (!centers.has(n.id)) centers.set(n.id, PAD + (nextSlot++) * GX + NW / 2);

    const maxDepth = graph.nodes.length ? Math.max(...graph.nodes.map(n => n.depth)) : 0;
    const placed: Placed[] = graph.nodes.map(n => ({
        node: n,
        x: centers.get(n.id)! - (n.isRoot ? ROOT_W : NW) / 2,
        y: PAD + n.depth * GY,
        h: nodeHeight(n, (loopsByNode.get(n.id) || []).length),
    }));
    return { placed, width: PAD * 2 + Math.max(1, nextSlot) * GX, height: PAD * 2 + (maxDepth + 1) * GY };
};

const treeEdge = (px: number, pB: number, cx: number, cT: number): string => {
    const my = (pB + cT) / 2;
    return `M${px},${pB} C${px},${my} ${cx},${my} ${cx},${cT - 3}`;
};

// ─── Topics mode (LLM semantic threads) ──────────────────────────────────────

// Thread hues: Vega-Lite's tableau10, the same categorical scheme the app's
// charts default to, so topic colors read as "categories" here too.
const THREAD_HUES = ['#4c78a8', '#f58518', '#54a24b', '#b279a2', '#e45756', '#72b7b2', '#eeca3b', '#9d755d'];
const threadHue = (i: number, fallback: boolean): string | null => (fallback ? null : THREAD_HUES[i % THREAD_HUES.length]);

const COL_W = 252;

/** One thread = one column: topic header, then charts top-to-bottom in the
 *  model's narrative order, linked by a vertical spine. */
const SemanticThreadsView: FC<{
    result: SemanticThreadsResult;
    usage: Record<string, ChartUsageEntry> | undefined;
    maxUsageMs: number;
    selectedChartId: string | null;
    onSelectChart: (chartId: string) => void;
}> = ({ result, usage, maxUsageMs, selectedChartId, onSelectChart }) => {
    const theme = useTheme();
    const border = theme.palette.divider;
    return (
        <Box sx={{ display: 'flex', gap: 3, p: 2.5, alignItems: 'flex-start' }}>
            {result.threads.map((t, ti) => {
                const hue = threadHue(ti, t.isFallback) ?? theme.palette.text.disabled;
                const threadMs = totalChartUsageMs(usage, t.charts.map(c => c.chartId));
                return (
                    <Box key={ti} sx={{ width: COL_W, flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
                        <Tooltip title={t.summary} placement="top">
                            <Box sx={{
                                borderRadius: '8px 8px 0 0', borderLeft: `4px solid ${hue}`,
                                backgroundColor: alpha(hue, 0.09), padding: '7px 10px',
                            }}>
                                <Typography sx={{ fontSize: 13, fontWeight: 700, lineHeight: 1.25 }}>
                                    {t.topic}
                                </Typography>
                                <Typography sx={{ fontSize: 11, color: 'text.secondary' }}>
                                    {t.charts.length} chart{t.charts.length > 1 ? 's' : ''}
                                    {threadMs > 0 && ` · ${formatViewDuration(threadMs, 'compact')} viewed`}
                                    {t.isFallback ? ' · unassigned' : ''}
                                </Typography>
                            </Box>
                        </Tooltip>
                        {t.summary && (
                            <Typography sx={{
                                fontSize: 11, color: 'text.secondary', fontStyle: 'italic',
                                padding: '6px 2px 2px', lineHeight: 1.35,
                            }}>{t.summary}</Typography>
                        )}
                        {t.charts.map((c, ci) => {
                            const sel = selectedChartId === c.chartId;
                            return (
                                <React.Fragment key={c.chartId}>
                                    {/* spine segment between consecutive charts */}
                                    <Box sx={{
                                        width: 0, alignSelf: 'center', height: ci === 0 ? 10 : 22,
                                        borderLeft: `2px solid ${alpha(hue, 0.55)}`,
                                    }} />
                                    <Box onClick={() => onSelectChart(c.chartId)}
                                        title={c.prompt ? `${sourceLabel(c.promptSource)}: ${c.prompt}` : sourceLabel(c.promptSource)}
                                        sx={{
                                            border: `${sel ? 2 : 1}px solid ${sel ? hue : border}`,
                                            borderLeft: `3px solid ${srcMain(theme, c.promptSource)}`,
                                            borderRadius: 2, cursor: 'pointer',
                                            backgroundColor: 'background.paper', padding: '8px 10px',
                                            display: 'flex', flexDirection: 'column', gap: 0.5,
                                            '&:hover': { borderColor: hue, borderLeftColor: srcMain(theme, c.promptSource), boxShadow: `0 1px 5px ${alpha(hue, 0.3)}` },
                                        }}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                                            <Typography sx={{ fontSize: 12.5, fontWeight: 700, color: hue, lineHeight: 1 }}>
                                                #{c.num}
                                            </Typography>
                                            <RoleBadge source={c.promptSource} />
                                            <Box sx={{ flex: 1 }} />
                                            <UsageChip entry={usage?.[c.chartId]} maxMs={maxUsageMs} />
                                        </Box>
                                        <Typography sx={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.3 }}>
                                            {c.title}
                                        </Typography>
                                        <Typography sx={{
                                            fontSize: 10.5, color: 'text.disabled', whiteSpace: 'nowrap',
                                            overflow: 'hidden', textOverflow: 'ellipsis',
                                        }}>{`{ ${c.attributes.join(', ')} }`}</Typography>
                                        {c.prompt && (
                                            <Typography sx={{
                                                fontSize: 10.5, fontStyle: 'italic', color: 'text.secondary',
                                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                            }}>“{c.prompt}”</Typography>
                                        )}
                                    </Box>
                                </React.Fragment>
                            );
                        })}
                    </Box>
                );
            })}
        </Box>
    );
};

/** Cross-dialog cache: one clustering per chart-set signature per session. */
const semanticCache = new Map<string, SemanticThreadsResult>();

type GraphMode = 'topics' | 'structure';

export const AnalysisGraphDialog: FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
    const dispatch = useDispatch<AppDispatch>();
    const theme = useTheme();
    const tables = useSelector((s: DataFormulatorState) => s.tables);
    const charts = useSelector(dfSelectors.getAllCharts);
    const conceptShelfItems = useSelector((s: DataFormulatorState) => s.conceptShelfItems);
    const chartUsage = useSelector((s: DataFormulatorState) => s.chartUsage);
    const activeModel = useSelector(dfSelectors.getActiveModel);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedChartId, setSelectedChartId] = useState<string | null>(null);
    const [mode, setMode] = useState<GraphMode>('topics');

    // Facilitator reading the graph ≠ analyst viewing the chart behind the
    // modal: suspend usage tracking while open (numbers also hold still).
    useEffect(() => {
        if (!open) return;
        return pushChartUsagePause();
    }, [open]);

    const graph = useMemo(
        () => (open ? buildHybridGraph(tables, charts, conceptShelfItems) : null),
        [open, tables, charts, conceptShelfItems],
    );
    const loopsByNode = useMemo(() => {
        const m = new Map<string, HybridEdge[]>();
        for (const e of graph?.edges || []) {
            if (e.kind !== 'self-loop') continue;
            (m.get(e.to) || m.set(e.to, []).get(e.to)!).push(e);
        }
        return m;
    }, [graph]);
    const placed = useMemo(() => (graph ? layout(graph, loopsByNode) : null), [graph, loopsByNode]);

    // ── chart items (both modes): numbering, roles, usage rollups ────────────
    const items = useMemo<SemanticChartItem[]>(
        () => (open ? collectSemanticChartItems(tables, charts, conceptShelfItems) : []),
        [open, tables, charts, conceptShelfItems],
    );
    const roleByChart = useMemo(() => new Map(items.map(i => [i.chartId, i.promptSource])), [items]);
    const maxUsageMs = useMemo(
        () => items.reduce((mx, i) => Math.max(mx, chartUsage?.[i.chartId]?.focusMs ?? 0), 0),
        [items, chartUsage],
    );
    const totalUsageMs = useMemo(
        () => totalChartUsageMs(chartUsage, items.map(i => i.chartId)),
        [items, chartUsage],
    );

    // ── topics mode: LLM clustering, cached per chart-set signature ──────────
    const sig = useMemo(() => semanticThreadsSignature(items), [items]);
    const [semantic, setSemantic] = useState<{ sig: string; result: SemanticThreadsResult } | null>(null);
    const [semanticLoading, setSemanticLoading] = useState(false);
    const [semanticError, setSemanticError] = useState<{ sig: string; message: string } | null>(null);
    const requestSeq = useRef(0);

    const runClustering = (force: boolean) => {
        if (items.length === 0 || !activeModel) return;
        if (!force) {
            const hit = semanticCache.get(sig);
            if (hit) { setSemantic({ sig, result: hit }); setSemanticError(null); return; }
        }
        const req = ++requestSeq.current;
        setSemanticLoading(true);
        setSemanticError(null);
        fetchSemanticThreads(items, activeModel)
            .then(result => {
                semanticCache.set(sig, result);
                if (req === requestSeq.current) setSemantic({ sig, result });
            })
            .catch(err => {
                console.warn('[semanticThreads] clustering failed', err);
                if (req === requestSeq.current) {
                    setSemanticError({ sig, message: err instanceof Error ? err.message : String(err) });
                }
            })
            .finally(() => { if (req === requestSeq.current) setSemanticLoading(false); });
    };

    useEffect(() => {
        if (!open || mode !== 'topics' || semanticLoading) return;
        if (semantic?.sig === sig || semanticError?.sig === sig) return;   // done or failed for this input
        runClustering(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, mode, sig]);

    if (!graph || !placed) {
        return (
            <Dialog open={open} onClose={onClose} maxWidth="sm">
                <DialogTitle>Analysis graph</DialogTitle>
            </Dialog>
        );
    }

    const posById = new Map(placed.placed.map(p => [p.node.id, p]));
    const m = graph.metrics;
    const selected = selectedId ? graph.nodes.find(n => n.id === selectedId) : null;
    const blue = theme.palette.primary.main;
    const border = theme.palette.divider;

    /** Explicit escape hatch — only the side panel's button calls this. */
    const openOnCanvas = (chartId: string) => {
        dispatch(dfActions.setFocused({ type: 'chart', chartId }));
        onClose();
    };

    const semResult = semantic?.sig === sig ? semantic.result : null;
    const sm = semResult?.metrics ?? null;
    const selectedTopic = selectedChartId
        ? semResult?.threads.find(t => t.charts.some(c => c.chartId === selectedChartId)) ?? null
        : null;
    const selectedItem = selectedTopic?.charts.find(c => c.chartId === selectedChartId) ?? null;

    const totalViewedChip = totalUsageMs > 0 && (
        <Tooltip title="Total active viewing time across all charts (visible tab, non-idle)">
            <Chip size="small" icon={<AccessTimeIcon sx={{ fontSize: 13 }} />}
                label={`${formatViewDuration(totalUsageMs)} viewed`} />
        </Tooltip>
    );

    return (
        <Dialog open={open} onClose={onClose} maxWidth={false}
            sx={{ '& .MuiDialog-paper': { width: '92vw', maxWidth: '92vw', height: '88vh', display: 'flex', flexDirection: 'column' } }}>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 2, pb: 0.5 }}>
                <Typography component="span" sx={{ fontWeight: 600 }}>Analysis graph</Typography>
                <ToggleButtonGroup size="small" exclusive value={mode}
                    onChange={(_, v) => { if (v) setMode(v); }}
                    sx={{ '& .MuiToggleButton-root': { py: 0.25, px: 1.25, fontSize: 12, textTransform: 'none' } }}>
                    <ToggleButton value="topics">Topics</ToggleButton>
                    <ToggleButton value="structure">Structure</ToggleButton>
                </ToggleButtonGroup>
                <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', flex: 1, alignItems: 'center' }}>
                    {mode === 'structure' ? (
                        <>
                            <Chip size="small" label={`${m.stateCount} states · ${m.chartCount} charts`} />
                            <Chip size="small" label={`${m.threadCount} threads`} />
                            <Chip size="small" label={`depth ${m.maxDepth}`} />
                            {m.selfLoops > 0 && <Chip size="small" label={`↻ ${m.selfLoops}`} />}
                            {totalViewedChip}
                        </>
                    ) : sm && (
                        <>
                            <Chip size="small" label={`${sm.threadCount} topics · ${sm.chartCount} charts`} />
                            <Chip size="small" label={`deepest ${sm.maxThreadLength}`} />
                            {totalViewedChip}
                            <Tooltip title="Re-cluster with the model">
                                <span>
                                    <IconButton size="small" disabled={semanticLoading} onClick={() => runClustering(true)}>
                                        <RefreshIcon sx={{ fontSize: 16 }} />
                                    </IconButton>
                                </span>
                            </Tooltip>
                        </>
                    )}
                </Box>
                <IconButton onClick={onClose} size="small"><CloseIcon fontSize="small" /></IconButton>
            </DialogTitle>
            <GraphLegend />
            {mode === 'topics' ? (
                <DialogContent sx={{ flex: 1, display: 'flex', gap: 2, overflow: 'hidden', pt: 0 }}>
                    <Box sx={{ flex: 1, overflow: 'auto', border: `1px solid ${border}`, borderRadius: 1, backgroundColor: theme.palette.action.hover }}>
                        {items.length === 0 ? (
                            <Typography sx={{ p: 3, color: 'text.secondary', fontSize: 13 }}>
                                No charts to cluster yet.
                            </Typography>
                        ) : !activeModel ? (
                            <Typography sx={{ p: 3, color: 'text.secondary', fontSize: 13 }}>
                                Select a model to cluster the analysis into topics.
                            </Typography>
                        ) : semanticLoading ? (
                            <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5 }}>
                                <CircularProgress size={26} />
                                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                                    Clustering {items.length} charts into topics…
                                </Typography>
                            </Box>
                        ) : semanticError?.sig === sig ? (
                            <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1.5 }}>
                                <Typography sx={{ fontSize: 13, color: 'error.main', maxWidth: 480, textAlign: 'center' }}>
                                    Failed to cluster charts: {semanticError.message}
                                </Typography>
                                <Button size="small" variant="outlined" onClick={() => runClustering(true)}>Retry</Button>
                            </Box>
                        ) : semResult ? (
                            <SemanticThreadsView result={semResult} usage={chartUsage} maxUsageMs={maxUsageMs}
                                selectedChartId={selectedChartId} onSelectChart={setSelectedChartId} />
                        ) : null}
                    </Box>
                    <Box sx={{ width: 330, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
                        {selectedItem && selectedTopic ? (
                            <>
                                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                                    {selectedTopic.topic}
                                </Typography>
                                <ChartPanelCard num={selectedItem.num} title={selectedItem.title}
                                    chartType={selectedItem.chartType} chartId={selectedItem.chartId}
                                    accent={threadHue(semResult!.threads.indexOf(selectedTopic), selectedTopic.isFallback) ?? blue}
                                    role={selectedItem.promptSource} usage={chartUsage?.[selectedItem.chartId]}
                                    onOpen={() => openOnCanvas(selectedItem.chartId)}>
                                    {selectedItem.prompt && (
                                        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
                                            <Tooltip title={sourceLabel(selectedItem.promptSource)}>
                                                <Box sx={{ display: 'flex', mt: '2px' }}>
                                                    <SourceIcon source={selectedItem.promptSource} />
                                                </Box>
                                            </Tooltip>
                                            <Typography variant="caption" sx={{ color: srcText(theme, selectedItem.promptSource) }}>
                                                {selectedItem.prompt}
                                            </Typography>
                                        </Box>
                                    )}
                                </ChartPanelCard>
                                <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, mt: 0.5 }}>
                                    Attributes ({selectedItem.attributes.length})
                                </Typography>
                                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}>
                                    {selectedItem.attributes.map(a => (
                                        <Chip key={a} size="small" variant="outlined" label={a}
                                            sx={{ maxWidth: '100%', fontFamily: 'monospace', '& .MuiChip-label': { fontSize: 12 } }} />
                                    ))}
                                </Box>
                            </>
                        ) : (
                            <>
                                <Typography variant="subtitle2">How to read this</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Each column is a <b>topic</b> — one direction of inquiry, clustered by a language
                                    model from the charts' titles, attributes, and the questions behind them. Charts run
                                    top-to-bottom as a narrative, so the number of columns is how <b>broad</b> the
                                    analysis was and the length of a column is how <b>deep</b> it went.
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                    A card's colored edge and badge say <b>who drove it</b> (user or agent); the gray
                                    clock chip is how long it was <b>actively viewed</b> on the canvas — darker means
                                    more of the session's attention.
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Select a chart to preview it here.
                                </Typography>
                            </>
                        )}
                    </Box>
                </DialogContent>
            ) : (
            <DialogContent sx={{ flex: 1, display: 'flex', gap: 2, overflow: 'hidden', pt: 0 }}>
                <Box sx={{ flex: 1, overflow: 'auto', border: `1px solid ${border}`, borderRadius: 1, backgroundColor: theme.palette.action.hover }}>
                    <svg width={placed.width} height={placed.height} style={{ display: 'block' }}>
                        {/* edges */}
                        {placed.placed.map(({ node, x, y }) => {
                            const birth = graph.edges.find(e => e.to === node.id && e.isBirth);
                            if (!birth) return null;
                            const parent = posById.get(birth.from);
                            if (!parent) return null;
                            const px = parent.x + (parent.node.isRoot ? ROOT_W : NW) / 2;
                            const pB = parent.y + parent.h;
                            const cx = x + NW / 2;
                            const midY = (pB + y) / 2;
                            const dashed = birth.kind === 'thread' && !parent.node.isRoot; // (rare) re-approach
                            return (
                                <g key={`e-${node.id}`}>
                                    <path d={treeEdge(px, pB, cx, y)} fill="none" stroke={blue}
                                        strokeWidth={1.4} opacity={0.5} strokeDasharray={dashed ? '4 3' : undefined} />
                                    {birth.label && (
                                    <foreignObject x={cx - LABEL_W / 2} y={midY - 27} width={LABEL_W} height={54}>
                                        <div title={`${sourceLabel(birth.source)} · ${birth.full}`} style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
                                        }}>
                                            <Box sx={{
                                                display: 'inline-flex', alignItems: 'center', gap: 0.5,
                                                fontSize: 11, lineHeight: 1.25, color: srcText(theme, birth.source),
                                                backgroundColor: 'background.paper',
                                                border: `1px solid ${alpha(srcMain(theme, birth.source), 0.5)}`,
                                                borderRadius: '6px', padding: '3px 8px', maxWidth: '100%',
                                            }}>
                                                <SourceIcon source={birth.source} />
                                                <Box component="span" sx={{
                                                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                                                    overflow: 'hidden', textAlign: 'left', minWidth: 0,
                                                }}>{birth.label}</Box>
                                            </Box>
                                        </div>
                                    </foreignObject>
                                    )}
                                </g>
                            );
                        })}

                        {/* nodes */}
                        {placed.placed.map(({ node, x, y, h }) => {
                            if (node.isRoot) {
                                return (
                                    <foreignObject key={node.id} x={x} y={y} width={ROOT_W} height={ROOT_H}>
                                        <div style={{
                                            height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                            borderRadius: 19, backgroundColor: theme.palette.background.paper,
                                            border: `1px solid ${border}`, padding: '0 14px', boxSizing: 'border-box',
                                        }}>
                                            <span style={{
                                                fontSize: 12, fontWeight: 600, color: theme.palette.text.secondary,
                                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                            }}>{node.label}</span>
                                        </div>
                                    </foreignObject>
                                );
                            }
                            const sel = selectedId === node.id;
                            const loops = loopsByNode.get(node.id) || [];
                            const extraTitles = node.charts.length - MAX_TITLES;
                            // One role edge when every chart in the state agrees; mixed states rely on per-row icons.
                            const nodeRoles = new Set(node.charts.map(c => roleByChart.get(c.chartId) === 'agent' ? 'agent' : 'user'));
                            const roleEdgeColor = nodeRoles.size === 1
                                ? srcMain(theme, [...nodeRoles][0] as PromptSource) : border;
                            return (
                                <foreignObject key={node.id} x={x} y={y} width={NW} height={h}>
                                    <div onClick={() => setSelectedId(node.id)}
                                        title={`{ ${node.attributes.join(', ')} }`} style={{
                                            height: '100%', boxSizing: 'border-box', cursor: 'pointer',
                                            borderRadius: 8, backgroundColor: theme.palette.background.paper,
                                            border: `${sel ? 2 : 1}px solid ${sel ? blue : border}`,
                                            borderLeft: `3px solid ${roleEdgeColor}`,
                                            padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 2,
                                            overflow: 'hidden',
                                        }}>
                                        {node.charts.slice(0, MAX_TITLES).map(c => {
                                            const cRole = roleByChart.get(c.chartId) ?? null;
                                            const cUsage = chartUsage?.[c.chartId];
                                            return (
                                                <div key={c.chartId} title={`${sourceLabel(cRole)} · ${describeChartUsage(cUsage)}`}
                                                    style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                                                    <b style={{ fontSize: 12.5, color: blue, fontWeight: 700, flexShrink: 0 }}>#{c.num}</b>
                                                    <SourceIcon source={cRole} size={11} />
                                                    <span style={{
                                                        flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 600,
                                                        color: theme.palette.text.primary, lineHeight: 1.25,
                                                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                                    }}>{c.title}</span>
                                                    {(cUsage?.focusMs ?? 0) > 0 && (
                                                        <span style={{
                                                            flexShrink: 0, fontSize: 10, fontWeight: 600,
                                                            fontVariantNumeric: 'tabular-nums',
                                                            color: theme.palette.text.secondary,
                                                            backgroundColor: alpha(theme.palette.text.primary,
                                                                0.06 + 0.22 * (maxUsageMs > 0 ? (cUsage!.focusMs / maxUsageMs) : 0)),
                                                            borderRadius: 8, padding: '0 5px', lineHeight: '14px',
                                                        }}>{formatViewDuration(cUsage!.focusMs, 'compact')}</span>
                                                    )}
                                                </div>
                                            );
                                        })}
                                        {extraTitles > 0 && (
                                            <span style={{ fontSize: 10.5, color: theme.palette.text.disabled }}>+{extraTitles} more</span>
                                        )}
                                        <span style={{
                                            fontSize: 10.5, color: theme.palette.text.disabled,
                                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                        }}>{`{ ${node.attributes.join(', ')} }`}</span>
                                        {loops.slice(0, MAX_LOOPS).map((lp, li) => (
                                            <Box key={li} title={`↻ ${sourceLabel(lp.source)} · ${lp.full}`} sx={{
                                                display: 'flex', alignItems: 'center', gap: 0.5,
                                                fontSize: 10.5, fontStyle: 'italic', color: srcText(theme, lp.source),
                                                minWidth: 0,
                                            }}>
                                                <span style={{ fontStyle: 'normal', flexShrink: 0 }}>↻</span>
                                                <SourceIcon source={lp.source} size={11} />
                                                <Box component="span" sx={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{lp.label}</Box>
                                            </Box>
                                        ))}
                                    </div>
                                </foreignObject>
                            );
                        })}
                    </svg>
                </Box>
                <Box sx={{ width: 330, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {selected && !selected.isRoot ? (
                        <>
                            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
                                Attributes ({selected.attributes.length})
                            </Typography>
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}>
                                {selected.attributes.map(a => (
                                    <Chip key={a} size="small" variant="outlined" label={a}
                                        sx={{ maxWidth: '100%', fontFamily: 'monospace', '& .MuiChip-label': { fontSize: 12 } }} />
                                ))}
                            </Box>
                            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                                attribute-set state · {selected.charts.length} chart{selected.charts.length > 1 ? 's' : ''}
                            </Typography>
                            {selected.charts.map(c => (
                                <ChartPanelCard key={c.chartId} num={c.num} title={c.title}
                                    chartType={c.chartType} chartId={c.chartId} accent={blue}
                                    role={roleByChart.get(c.chartId) ?? null} usage={chartUsage?.[c.chartId]}
                                    onOpen={() => openOnCanvas(c.chartId)} />
                            ))}
                            {(loopsByNode.get(selected.id) || []).length > 0 && (
                                <Box sx={{ mt: 0.5 }}>
                                    <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>Refined in place (↻)</Typography>
                                    {(loopsByNode.get(selected.id) || []).map((lp, li) => (
                                        <Box key={li} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, mt: 0.5 }}>
                                            <Tooltip title={sourceLabel(lp.source)}><Box sx={{ display: 'flex', mt: '2px' }}><SourceIcon source={lp.source} /></Box></Tooltip>
                                            <Typography variant="caption" sx={{ color: srcText(theme, lp.source) }}>{lp.full}</Typography>
                                        </Box>
                                    ))}
                                </Box>
                            )}
                        </>
                    ) : (
                        <>
                            <Typography variant="subtitle2">How to read this</Typography>
                            <Typography variant="caption" color="text.secondary">
                                Each node is a unique <b>attribute set</b> (a Battle &amp; Heer analysis state), named by the
                                charts that analyze it (numbered by creation time). Each edge is the <b>prompt</b> — the
                                question or instruction — that moved the analysis from one set to the next. A ↻ line is a
                                set refined in place; a new thread from the dataset starts whenever a question is unrelated
                                to the previous one.
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                                A node's colored edge and the icons on its rows say <b>who drove each chart</b> (user or
                                agent); the gray clock chips are how long each was <b>actively viewed</b> — darker means
                                more of the session's attention.
                            </Typography>
                            <Typography variant="subtitle2" sx={{ mt: 1 }}>Threads</Typography>
                            {graph.rootIds.map(rid => {
                                const root = graph.nodes.find(n => n.id === rid)!;
                                return (
                                    <Box key={rid} sx={{ p: 1, border: `1px solid ${border}`, borderRadius: 1 }}>
                                        <Typography variant="caption" sx={{ fontWeight: 600 }}>{root.label}</Typography>
                                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                            {graph.edges.filter(e => e.from === rid).length} thread(s) from this dataset
                                        </Typography>
                                    </Box>
                                );
                            })}
                        </>
                    )}
                </Box>
            </DialogContent>
            )}
        </Dialog>
    );
};

/** Floating opener for the thread pane. */
export const AnalysisGraphButton: FC = () => {
    const [open, setOpen] = useState(false);
    const chartCount = useSelector((s: DataFormulatorState) => dfSelectors.getAllCharts(s).length);
    if (chartCount === 0) return null;
    return (
        <>
            <Tooltip title="Show analysis graph" placement="right">
                <IconButton size="small" onClick={() => setOpen(true)}
                    sx={{ position: 'absolute', top: 6, left: 6, zIndex: 5, color: 'text.secondary',
                        backgroundColor: 'background.paper', border: 1, borderColor: 'divider',
                        '&:hover': { color: 'primary.main' } }}>
                    <AccountTreeOutlinedIcon sx={{ fontSize: 18 }} />
                </IconButton>
            </Tooltip>
            <AnalysisGraphDialog open={open} onClose={() => setOpen(false)} />
        </>
    );
};
