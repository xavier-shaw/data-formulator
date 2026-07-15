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
// Chart numbers (#1..#N, creation order) match across both modes. Opened from
// a floating button on the thread pane; clicking a chart focuses it on the
// canvas.

import React, { FC, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
    Box, Button, Chip, CircularProgress, Dialog, DialogContent, DialogTitle, IconButton,
    ToggleButton, ToggleButtonGroup, Tooltip, Typography, useTheme,
} from '@mui/material';
import { Theme, alpha } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import PersonIcon from '@mui/icons-material/Person';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { DataFormulatorState, dfActions, dfSelectors } from '../app/dfSlice';
import { AppDispatch } from '../app/store';
import {
    HybridEdge, HybridGraph, HybridNode, PromptSource, ROOT_PREFIX, buildHybridGraph,
} from '../app/analysisHybridGraph';
import {
    SemanticChartItem, SemanticThreadsResult, collectSemanticChartItems, fetchSemanticThreads,
    semanticThreadsSignature,
} from '../app/analysisSemanticThreads';

// Prompt-source colors, matched to the data thread: the user's warm `custom`
// palette (DataThread colors user entries with `palette.custom.main`) and the
// agent's `primary` accent (the toy/summary color).
const srcMain = (theme: Theme, source: PromptSource): string =>
    source === 'user' ? theme.palette.custom.main
        : source === 'agent' ? theme.palette.primary.main
            : theme.palette.text.secondary;
const srcText = (theme: Theme, source: PromptSource): string =>
    source === 'user' ? (theme.palette.custom.textColor || theme.palette.custom.main)
        : source === 'agent' ? (theme.palette.primary.textColor || theme.palette.primary.main)
            : theme.palette.text.secondary;

/** Small person/robot glyph marking whether a prompt was authored by the user
 *  or the agent, tinted in that source's thread color. */
const SourceIcon: FC<{ source: PromptSource; size?: number }> = ({ source, size = 12 }) => {
    const theme = useTheme();
    const color = srcMain(theme, source);
    if (source === 'user') return <PersonIcon sx={{ fontSize: size, color, flexShrink: 0 }} />;
    if (source === 'agent') return <SmartToyOutlinedIcon sx={{ fontSize: size, color, flexShrink: 0 }} />;
    return null;
};

const sourceLabel = (source: PromptSource): string =>
    source === 'user' ? 'User prompt' : source === 'agent' ? 'Agent instruction' : '';

const NW = 228, GX = 260, GY = 184, PAD = 40;
const ROOT_H = 38, ROOT_W = 168;
const MAX_TITLES = 3, MAX_LOOPS = 2;
const LABEL_W = 210;

/** Card height grows with the titles + self-loop lines it shows. */
const nodeHeight = (n: HybridNode, loops: number): number => {
    if (n.isRoot) return ROOT_H;
    const titleLines = Math.min(n.charts.length, MAX_TITLES);
    const loopLines = Math.min(loops, MAX_LOOPS);
    return 14 + titleLines * 17 + 15 + loopLines * 15 + (n.charts.length > MAX_TITLES ? 13 : 0);
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
    onFocusChart: (chartId: string) => void;
}> = ({ result, onFocusChart }) => {
    const theme = useTheme();
    const border = theme.palette.divider;
    return (
        <Box sx={{ display: 'flex', gap: 3, p: 2.5, alignItems: 'flex-start' }}>
            {result.threads.map((t, ti) => {
                const hue = threadHue(ti, t.isFallback) ?? theme.palette.text.disabled;
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
                        {t.charts.map((c, ci) => (
                            <React.Fragment key={c.chartId}>
                                {/* spine segment between consecutive charts */}
                                <Box sx={{
                                    width: 0, alignSelf: 'center', height: ci === 0 ? 10 : 22,
                                    borderLeft: `2px solid ${alpha(hue, 0.55)}`,
                                }} />
                                <Box onClick={() => onFocusChart(c.chartId)}
                                    title={c.prompt ? `Prompt: ${c.prompt}` : undefined}
                                    sx={{
                                        border: `1px solid ${border}`, borderRadius: 2, cursor: 'pointer',
                                        backgroundColor: 'background.paper', padding: '8px 10px',
                                        display: 'flex', flexDirection: 'column', gap: 0.25,
                                        '&:hover': { borderColor: hue, boxShadow: `0 1px 5px ${alpha(hue, 0.3)}` },
                                    }}>
                                    <Typography sx={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.3 }}>
                                        <span style={{ color: hue, fontWeight: 700 }}>#{c.num}</span>&nbsp;{c.title}
                                    </Typography>
                                    <Typography sx={{
                                        fontSize: 10.5, color: 'text.disabled', whiteSpace: 'nowrap',
                                        overflow: 'hidden', textOverflow: 'ellipsis',
                                    }}>{`{ ${c.attributes.join(', ')} }`}</Typography>
                                    {c.prompt && (
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                                            <SourceIcon source={c.promptSource} size={11} />
                                            <Typography sx={{
                                                fontSize: 10.5, fontStyle: 'italic', color: 'text.secondary',
                                                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                            }}>{c.prompt}</Typography>
                                        </Box>
                                    )}
                                </Box>
                            </React.Fragment>
                        ))}
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
    const activeModel = useSelector(dfSelectors.getActiveModel);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [mode, setMode] = useState<GraphMode>('topics');

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

    // ── topics mode: LLM clustering, cached per chart-set signature ──────────
    const items = useMemo<SemanticChartItem[]>(
        () => (open ? collectSemanticChartItems(tables, charts, conceptShelfItems) : []),
        [open, tables, charts, conceptShelfItems],
    );
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

    const focusChart = (chartId: string) => {
        dispatch(dfActions.setFocused({ type: 'chart', chartId }));
        onClose();
    };

    const sm = semantic?.sig === sig ? semantic.result.metrics : null;

    return (
        <Dialog open={open} onClose={onClose} maxWidth={false}
            sx={{ '& .MuiDialog-paper': { width: '92vw', maxWidth: '92vw', height: '88vh', display: 'flex', flexDirection: 'column' } }}>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 2, pb: 1 }}>
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
                        </>
                    ) : sm && (
                        <>
                            <Chip size="small" label={`${sm.threadCount} topics · ${sm.chartCount} charts`} />
                            <Chip size="small" label={`deepest ${sm.maxThreadLength}`} />
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
            {mode === 'topics' ? (
                <DialogContent sx={{ flex: 1, display: 'flex', overflow: 'hidden', pt: 0 }}>
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
                        ) : semantic?.sig === sig ? (
                            <SemanticThreadsView result={semantic.result} onFocusChart={focusChart} />
                        ) : null}
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
                                    <foreignObject x={cx - LABEL_W / 2} y={midY - 27} width={LABEL_W} height={54}>
                                        <div title={`${sourceLabel(birth.source)} · ${birth.full}`} style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
                                        }}>
                                            <Box sx={{
                                                display: 'inline-flex', alignItems: 'center', gap: 0.5,
                                                fontSize: 11, lineHeight: 1.25, color: srcText(theme, birth.source),
                                                backgroundColor: 'background.paper',
                                                border: `1px solid ${birth.source ? alpha(srcMain(theme, birth.source), 0.5) : border}`,
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
                            return (
                                <foreignObject key={node.id} x={x} y={y} width={NW} height={h}>
                                    <div onClick={() => setSelectedId(node.id)}
                                        title={`{ ${node.attributes.join(', ')} }`} style={{
                                            height: '100%', boxSizing: 'border-box', cursor: 'pointer',
                                            borderRadius: 8, backgroundColor: theme.palette.background.paper,
                                            border: `${sel ? 2 : 1}px solid ${sel ? blue : border}`,
                                            padding: '7px 9px', display: 'flex', flexDirection: 'column', gap: 2,
                                            overflow: 'hidden',
                                        }}>
                                        {node.charts.slice(0, MAX_TITLES).map(c => (
                                            <span key={c.chartId} style={{
                                                fontSize: 12, fontWeight: 600, color: theme.palette.text.primary,
                                                lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                            }}>
                                                <b style={{ color: blue, fontWeight: 700 }}>#{c.num}</b>&nbsp;{c.title || c.chartId}
                                            </span>
                                        ))}
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
                                <Box key={c.chartId} onClick={() => focusChart(c.chartId)}
                                    sx={{ p: 1, border: `1px solid ${border}`, borderRadius: 1, cursor: 'pointer', '&:hover': { borderColor: blue } }}>
                                    <Typography variant="body2" sx={{ fontWeight: 550 }}>
                                        <span style={{ color: blue, fontWeight: 700 }}>#{c.num}</span>&nbsp;{c.title || c.chartId}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">{c.chartType} · open on canvas →</Typography>
                                </Box>
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
