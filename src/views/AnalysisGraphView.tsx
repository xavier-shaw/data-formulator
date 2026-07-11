// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// In-app rendering of the analysis graph (see src/app/analysisGraph.ts): the
// analysis-centered modality, complementary to the user-centered data thread.
// Opened from a floating button on the thread pane; clicking a state focuses
// one of its charts back on the canvas.

import React, { FC, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import {
    Box, Chip, Dialog, DialogContent, DialogTitle, IconButton, Tooltip, Typography, useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import { DataFormulatorState, dfActions, dfSelectors } from '../app/dfSlice';
import { AppDispatch } from '../app/store';
import {
    AnalysisGraph, AnalysisStateNode, TelemetryLike, buildAnalysisGraph,
} from '../app/analysisGraph';

const NW = 172, NH = 54, GX = 210, GY = 118, PAD = 36;

interface LaidOutNode { node: AnalysisStateNode; x: number; y: number; }

/**
 * Deterministic layered layout with DEPTH VERTICAL (level 1 on top, deeper
 * states below) and BREADTH HORIZONTAL — the picture is literally the
 * breadth/depth aspect ratio, matching how Battle & Heer draw search trees.
 *
 * Per component (components sit side by side): each depth level is a row.
 * Within a row, non-anchor nodes sit on the left and anchor-theme nodes in a
 * right-aligned band whose x-start is shared across rows, so the anchor hull
 * is a tight box. Nodes at level ≥ 2 are ordered by the mean x of their
 * refinement parents (barycenter) to keep arrows near-vertical.
 */
const layoutGraph = (graph: AnalysisGraph): { placed: LaidOutNode[]; hulls: { x: number; y: number; w: number; h: number; label: string }[]; width: number; height: number } => {
    const placed: LaidOutNode[] = [];
    const hulls: { x: number; y: number; w: number; h: number; label: string }[] = [];
    const posById = new Map<string, LaidOutNode>();
    const parentsOf = new Map<string, string[]>();
    for (const e of graph.edges) {
        if (e.kind !== 'refinement') continue;
        if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
        parentsOf.get(e.target)!.push(e.source);
    }

    let xOffset = PAD;
    let maxY = 0;

    for (const comp of graph.components) {
        const nodes = comp.nodeIds
            .map(id => graph.nodes.find(n => n.id === id)!)
            .filter(Boolean);
        const anchor = comp.anchorAttributes[0];
        const isAnchorNode = (n: AnalysisStateNode) => !!anchor && n.attributes.includes(anchor);

        const byLevel = new Map<number, AnalysisStateNode[]>();
        for (const n of nodes) {
            if (!byLevel.has(n.depthLevel)) byLevel.set(n.depthLevel, []);
            byLevel.get(n.depthLevel)!.push(n);
        }
        const levels = [...byLevel.keys()].sort((a, b) => a - b);

        // shared x-start of the anchor band = widest non-anchor prefix
        const maxNonAnchor = Math.max(0, ...levels.map(l => byLevel.get(l)!.filter(n => !isAnchorNode(n)).length));
        const maxAnchor = Math.max(0, ...levels.map(l => byLevel.get(l)!.filter(isAnchorNode).length));
        const anchorBandX = xOffset + maxNonAnchor * GX + (maxNonAnchor > 0 && maxAnchor > 0 ? 28 : 0);

        // order within a group: barycenter of already-placed parents, then time
        const orderKey = (n: AnalysisStateNode): number => {
            const ps = (parentsOf.get(n.id) || []).map(p => posById.get(p)?.x).filter((x): x is number => x !== undefined);
            if (ps.length) return ps.reduce((a, b) => a + b, 0) / ps.length;
            return n.tFirst ?? Number.MAX_SAFE_INTEGER;
        };

        // Greedy placement: a node sits at the mean x of its refinement parents
        // (barycenter) when that slot is free, so depth chains read as vertical
        // columns; otherwise it shifts right within its group band.
        const placeRowGroup = (group: AnalysisStateNode[], startX: number, y: number, out?: LaidOutNode[]) => {
            let cursor = startX;
            for (const n of group) {
                const ps = (parentsOf.get(n.id) || []).map(pid => posById.get(pid)?.x).filter((x): x is number => x !== undefined);
                const bary = ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : cursor;
                const x = Math.max(cursor, bary);
                const p: LaidOutNode = { node: n, x, y };
                placed.push(p); posById.set(n.id, p); out?.push(p);
                cursor = x + GX;
            }
        };
        const anchorPlaced: LaidOutNode[] = [];
        for (const lvl of levels) {
            const y = PAD + 26 + (lvl - 1) * GY;
            const row = byLevel.get(lvl)!;
            placeRowGroup(row.filter(n => !isAnchorNode(n)).sort((a, b) => orderKey(a) - orderKey(b)), xOffset, y);
            placeRowGroup(row.filter(isAnchorNode).sort((a, b) => orderKey(a) - orderKey(b)), anchorBandX, y, anchorPlaced);
            maxY = Math.max(maxY, y + NH);
        }

        if (anchorPlaced.length >= 2) {
            const hx = Math.min(...anchorPlaced.map(p => p.x)) - 14;
            const hy = Math.min(...anchorPlaced.map(p => p.y)) - 30;
            const hx2 = Math.max(...anchorPlaced.map(p => p.x)) + NW + 14;
            const hy2 = Math.max(...anchorPlaced.map(p => p.y)) + NH + 14;
            hulls.push({ x: hx, y: hy, w: hx2 - hx, h: hy2 - hy, label: `${anchor} · ${anchorPlaced.length}` });
        }

        // advance by the ACTUAL extent (greedy barycenter can exceed slot math)
        const compNodes = nodes.map(n => posById.get(n.id)!).filter(Boolean);
        const compMaxX = compNodes.length ? Math.max(...compNodes.map(p => p.x + NW)) : xOffset + GX;
        xOffset = compMaxX + 56;   // next component to the right
    }

    return { placed, hulls, width: xOffset + PAD, height: maxY + PAD + 20 };
};

const edgePath = (a: LaidOutNode, b: LaidOutNode): string => {
    const A = { cx: a.x + NW / 2, cy: a.y + NH / 2 };
    const B = { cx: b.x + NW / 2, cy: b.y + NH / 2 };
    // Same row: arc beneath the row so the line never crosses sibling cards.
    if (a.y === b.y) {
        const sx = A.cx, tx = B.cx;
        const sy = a.y + NH, ty = sy;
        const dip = sy + Math.min(56, 20 + Math.abs(tx - sx) / 12);
        return `M${sx},${sy} C${sx},${dip} ${tx},${dip} ${tx},${ty}`;
    }
    // Different depth rows: prefer vertical exit/entry (depth flows downward).
    const vertical = Math.abs(B.cy - A.cy) >= Math.abs(B.cx - A.cx) || Math.abs(B.cy - A.cy) > NH;
    const sx = vertical ? A.cx : A.cx + Math.sign(B.cx - A.cx) * NW / 2;
    const sy = vertical ? A.cy + Math.sign(B.cy - A.cy) * NH / 2 : A.cy;
    const tx = vertical ? B.cx : B.cx - Math.sign(B.cx - A.cx) * (NW / 2 + 4);
    const ty = vertical ? B.cy - Math.sign(B.cy - A.cy) * (NH / 2 + 4) : B.cy;
    if (vertical) {
        const my = (sy + ty) / 2;
        return `M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty}`;
    }
    const mx = (sx + tx) / 2;
    return `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
};

export const AnalysisGraphDialog: FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
    const dispatch = useDispatch<AppDispatch>();
    const { t } = useTranslation();
    const theme = useTheme();
    const tables = useSelector((s: DataFormulatorState) => s.tables);
    const charts = useSelector(dfSelectors.getAllCharts);
    const conceptShelfItems = useSelector((s: DataFormulatorState) => s.conceptShelfItems);
    // Study builds carry a `studyTelemetry` journal (focus dwell / edits) used
    // as an engagement overlay; absent on non-study branches, so read loosely.
    const telemetry = useSelector((s: DataFormulatorState) =>
        (s as unknown as { studyTelemetry?: TelemetryLike }).studyTelemetry);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const graph = useMemo(
        () => (open ? buildAnalysisGraph(charts, tables, conceptShelfItems, telemetry) : null),
        [open, charts, tables, conceptShelfItems, telemetry],
    );
    const layout = useMemo(() => (graph ? layoutGraph(graph) : null), [graph]);

    if (!graph || !layout) {
        return (
            <Dialog open={open} onClose={onClose} maxWidth="sm">
                <DialogTitle>{t('analysisGraph.title')}</DialogTitle>
            </Dialog>
        );
    }

    const posById = new Map(layout.placed.map(p => [p.node.id, p]));
    const m = graph.metrics;
    const selected = selectedId ? graph.nodes.find(n => n.id === selectedId) : null;
    const blue = theme.palette.primary.main;
    const border = theme.palette.divider;

    const focusChart = (n: AnalysisStateNode) => {
        const chartId = n.charts[0]?.chartId;
        if (chartId) {
            dispatch(dfActions.setFocused({ type: 'chart', chartId }));
            onClose();
        }
    };

    return (
        <Dialog open={open} onClose={onClose} maxWidth={false}
            sx={{ '& .MuiDialog-paper': { width: '92vw', maxWidth: '92vw', height: '88vh', display: 'flex', flexDirection: 'column' } }}>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 2, pb: 1 }}>
                <Typography component="span" sx={{ fontWeight: 600 }}>{t('analysisGraph.title')}</Typography>
                <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap', flex: 1 }}>
                    <Chip size="small" label={t('analysisGraph.statesOfCharts', { states: m.stateCount, charts: m.chartCount })} />
                    <Chip size="small" label={t('analysisGraph.depth', { depth: m.maxDepth })} />
                    <Chip size="small" label={t('analysisGraph.breadth', { breadth: m.maxBreadth })} />
                    {m.aspectRatio !== null && (
                        <Chip size="small" color={m.aspectRatio > 1 ? 'info' : 'default'}
                            label={t('analysisGraph.aspect', { ratio: m.aspectRatio.toFixed(1) })} />
                    )}
                    <Chip size="small" label={t('analysisGraph.coverage', { used: m.attributeCoverage.used, total: m.attributeCoverage.total })} />
                </Box>
                <IconButton onClick={onClose} size="small"><CloseIcon fontSize="small" /></IconButton>
            </DialogTitle>
            <DialogContent sx={{ flex: 1, display: 'flex', gap: 2, overflow: 'hidden', pt: 0 }}>
                <Box sx={{ flex: 1, overflow: 'auto', border: `1px solid ${border}`, borderRadius: 1 }}>
                    <svg width={layout.width} height={layout.height}>
                        {/* axis hints: breadth spreads horizontally, depth grows downward */}
                        <text x={PAD} y={16} fontSize={10.5} fontWeight={600} letterSpacing="0.06em"
                            fill={theme.palette.text.disabled}>{t('analysisGraph.axisBreadth')}</text>
                        <text x={12} y={PAD + 34} fontSize={10.5} fontWeight={600} letterSpacing="0.06em"
                            fill={theme.palette.text.disabled} transform={`rotate(90 12 ${PAD + 34})`}>{t('analysisGraph.axisDepth')}</text>
                        {layout.hulls.map((h, i) => (
                            <g key={`hull-${i}`}>
                                <rect x={h.x} y={h.y} width={h.w} height={h.h} rx={12}
                                    fill={theme.palette.success.light} fillOpacity={0.08}
                                    stroke={theme.palette.success.main} strokeDasharray="5 4" strokeOpacity={0.6} />
                                <text x={h.x + 12} y={h.y + 18} fontSize={11} fontWeight={600}
                                    fill={theme.palette.success.main}>{h.label}</text>
                            </g>
                        ))}
                        <defs>
                            <marker id="ag-arrow" viewBox="0 0 10 8" refX="9" refY="4" markerWidth="8" markerHeight="7" orient="auto-start-reverse">
                                <path d="M0,0 L10,4 L0,8 Z" fill={blue} />
                            </marker>
                        </defs>
                        {graph.edges.map((e, i) => {
                            const a = posById.get(e.source), b = posById.get(e.target);
                            if (!a || !b) return null;
                            const isRef = e.kind === 'refinement';
                            return <path key={`e-${i}`} d={edgePath(a, b)} fill="none"
                                stroke={isRef ? blue : theme.palette.text.disabled}
                                strokeWidth={isRef ? 2 : 1.2}
                                strokeDasharray={isRef ? undefined : '4 4'}
                                opacity={isRef ? 0.9 : 0.35}
                                markerEnd={isRef ? 'url(#ag-arrow)' : undefined} />;
                        })}
                        {layout.placed.map(({ node, x, y }) => (
                            <g key={node.id} transform={`translate(${x},${y})`} style={{ cursor: 'pointer' }}
                                onClick={() => setSelectedId(node.id)}>
                                <title>{node.charts.map(c => c.title || c.chartId).join('\n')}</title>
                                <rect width={NW} height={NH} rx={8}
                                    fill={theme.palette.background.paper}
                                    stroke={selectedId === node.id ? blue : border}
                                    strokeWidth={selectedId === node.id ? 2 : 1} />
                                <text x={10} y={20} fontSize={10.5} fontWeight={600} fill={theme.palette.text.primary}>
                                    {node.attributes.join(', ').slice(0, 26)}{node.attributes.join(', ').length > 26 ? '…' : ''}
                                </text>
                                <text x={10} y={40} fontSize={10} fill={theme.palette.text.secondary}>
                                    {t('analysisGraph.nodeSub', { charts: node.charts.length, level: node.depthLevel })}
                                </text>
                            </g>
                        ))}
                    </svg>
                </Box>
                <Box sx={{ width: 300, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {selected ? (
                        <>
                            <Typography variant="subtitle2">{`{ ${selected.attributes.join(', ')} }`}</Typography>
                            {selected.charts.map(c => (
                                <Box key={c.chartId}
                                    onClick={() => focusChart(selected)}
                                    sx={{ p: 1, border: `1px solid ${border}`, borderRadius: 1, cursor: 'pointer',
                                        '&:hover': { borderColor: blue } }}>
                                    <Typography variant="body2" sx={{ fontWeight: 550 }}>{c.title || c.chartId}</Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        {c.chartType} · {c.encodedFields.join(', ')}
                                    </Typography>
                                </Box>
                            ))}
                            <Typography variant="caption" color="text.secondary">{t('analysisGraph.clickChartHint')}</Typography>
                        </>
                    ) : (
                        <>
                            <Typography variant="subtitle2">{t('analysisGraph.attributesHeading')}</Typography>
                            {m.attributeStats.map(a => (
                                <Box key={a.name} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                    <Typography variant="caption" sx={{ width: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.name}</Typography>
                                    <Box sx={{ flex: 1, height: 10, bgcolor: 'action.hover', borderRadius: 0.5, overflow: 'hidden' }}>
                                        <Box sx={{ width: `${(a.states / m.attributeStats[0].states) * 100}%`, height: '100%', bgcolor: blue }} />
                                    </Box>
                                    <Typography variant="caption" color="text.secondary" sx={{ width: 30, textAlign: 'right' }}>{a.states}</Typography>
                                </Box>
                            ))}
                            <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>{t('analysisGraph.selectHint')}</Typography>
                        </>
                    )}
                </Box>
            </DialogContent>
        </Dialog>
    );
};

/** Floating opener for the thread pane. */
export const AnalysisGraphButton: FC = () => {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const chartCount = useSelector((s: DataFormulatorState) => dfSelectors.getAllCharts(s).length);
    if (chartCount === 0) return null;
    return (
        <>
            <Tooltip title={t('analysisGraph.openTooltip')} placement="right">
                <IconButton size="small" onClick={() => setOpen(true)}
                    sx={{ position: 'absolute', top: 6, left: 6, zIndex: 5, color: 'text.secondary',
                        backgroundColor: 'background.paper', border: 1, borderColor: 'divider',
                        '&:hover': { color: 'primary.main' } }}>
                    <HubOutlinedIcon sx={{ fontSize: 18 }} />
                </IconButton>
            </Tooltip>
            <AnalysisGraphDialog open={open} onClose={() => setOpen(false)} />
        </>
    );
};
