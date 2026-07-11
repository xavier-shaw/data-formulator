// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// In-app rendering of the analysis tree (see src/app/analysisGraph.ts): Battle
// & Heer's search tree over analysis states, complementary to the data thread.
// Depth is vertical (root/dataset on top, deeper states below); breadth is
// horizontal (each leaf = one exploratory trajectory). Opened from a floating
// button on the thread pane; clicking a state focuses one of its charts.

import React, { FC, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import {
    Box, Chip, Dialog, DialogContent, DialogTitle, IconButton, Tooltip, Typography, useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import { DataFormulatorState, dfActions, dfSelectors } from '../app/dfSlice';
import { AppDispatch } from '../app/store';
import {
    AnalysisStateNode, AnalysisTree, ROOT_ID, TelemetryLike, buildAnalysisTree,
} from '../app/analysisGraph';

const NW = 168, NH = 52, GX = 188, GY = 108, PAD = 32;
const ROOT_W = 120, ROOT_H = 34;

interface PlacedNode { node: AnalysisStateNode; x: number; y: number; }

/**
 * Tidy tree layout, root at top: leaves take consecutive horizontal slots in
 * first-visit order; every parent is centered over its children. Depth = row.
 */
const layoutTree = (tree: AnalysisTree): { placed: PlacedNode[]; rootX: number; width: number; height: number } => {
    const children = new Map<string, AnalysisStateNode[]>();
    for (const n of tree.nodes) {
        if (!children.has(n.parentId!)) children.set(n.parentId!, []);
        children.get(n.parentId!)!.push(n);
    }
    for (const kids of children.values()) {
        kids.sort((a, b) => (a.tFirst ?? 0) - (b.tFirst ?? 0));
    }

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
        const kidCenters = kids.map(k => assign(k.id));
        const c = (kidCenters[0] + kidCenters[kidCenters.length - 1]) / 2;
        centers.set(id, c);
        return c;
    };
    const rootX = assign(ROOT_ID);

    const placed: PlacedNode[] = tree.nodes.map(n => ({
        node: n,
        x: centers.get(n.id)! - NW / 2,
        y: PAD + 20 + n.depth * GY,
    }));
    const maxDepth = tree.nodes.length ? Math.max(...tree.nodes.map(n => n.depth)) : 0;
    return {
        placed,
        rootX,
        width: PAD * 2 + Math.max(1, nextSlot) * GX,
        height: PAD + 20 + (maxDepth + 1) * GY + 20,
    };
};

/** Vertical parent→child connector, exiting the parent's bottom edge. */
const treeEdgePath = (px: number, pBottom: number, cx: number, cTop: number): string => {
    const my = (pBottom + cTop) / 2;
    return `M${px},${pBottom} C${px},${my} ${cx},${my} ${cx},${cTop - 4}`;
};

export const AnalysisGraphDialog: FC<{ open: boolean; onClose: () => void }> = ({ open, onClose }) => {
    const dispatch = useDispatch<AppDispatch>();
    const { t } = useTranslation();
    const theme = useTheme();
    const tables = useSelector((s: DataFormulatorState) => s.tables);
    const charts = useSelector(dfSelectors.getAllCharts);
    const conceptShelfItems = useSelector((s: DataFormulatorState) => s.conceptShelfItems);
    // Study builds carry a `studyTelemetry` journal; absent elsewhere, so read loosely.
    const telemetry = useSelector((s: DataFormulatorState) =>
        (s as unknown as { studyTelemetry?: TelemetryLike }).studyTelemetry);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const tree = useMemo(
        () => (open ? buildAnalysisTree(charts, tables, conceptShelfItems, telemetry) : null),
        [open, charts, tables, conceptShelfItems, telemetry],
    );
    const layout = useMemo(() => (tree ? layoutTree(tree) : null), [tree]);

    if (!tree || !layout) {
        return (
            <Dialog open={open} onClose={onClose} maxWidth="sm">
                <DialogTitle>{t('analysisGraph.title')}</DialogTitle>
            </Dialog>
        );
    }

    const posById = new Map(layout.placed.map(p => [p.node.id, p]));
    const m = tree.metrics;
    const selected = selectedId ? tree.nodes.find(n => n.id === selectedId) : null;
    const blue = theme.palette.primary.main;
    const border = theme.palette.divider;
    const rootLabel = tables.find(tb => !tb.derive)?.displayId || t('analysisGraph.rootLabel');
    const rootBottom = PAD + 20 - (GY - ROOT_H) / 2 + ROOT_H;

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
                    <Chip size="small" label={t('analysisGraph.depth', { depth: m.height })} />
                    <Chip size="small" label={t('analysisGraph.trajectories', { count: m.leafCount })} />
                    {m.aspectRatio !== null && (
                        <Chip size="small" color={m.aspectRatio > 1 ? 'info' : 'default'}
                            label={t('analysisGraph.aspect', { ratio: m.aspectRatio.toFixed(1) })} />
                    )}
                    {m.totalSelfLoops > 0 && (
                        <Chip size="small" label={t('analysisGraph.selfLoops', { count: m.totalSelfLoops })} />
                    )}
                </Box>
                <IconButton onClick={onClose} size="small"><CloseIcon fontSize="small" /></IconButton>
            </DialogTitle>
            <DialogContent sx={{ flex: 1, display: 'flex', gap: 2, overflow: 'hidden', pt: 0 }}>
                <Box sx={{ flex: 1, overflow: 'auto', border: `1px solid ${border}`, borderRadius: 1 }}>
                    <svg width={layout.width} height={layout.height}>
                        {/* axis hints */}
                        <text x={PAD} y={14} fontSize={10.5} fontWeight={600} letterSpacing="0.06em"
                            fill={theme.palette.text.disabled}>{t('analysisGraph.axisBreadth')}</text>
                        <text x={10} y={PAD + 30} fontSize={10.5} fontWeight={600} letterSpacing="0.06em"
                            fill={theme.palette.text.disabled} transform={`rotate(90 10 ${PAD + 30})`}>{t('analysisGraph.axisDepth')}</text>

                        {/* edges */}
                        {layout.placed.map(({ node, x, y }) => {
                            const parent = node.parentId === ROOT_ID ? null : posById.get(node.parentId!);
                            const px = parent ? parent.x + NW / 2 : layout.rootX;
                            const pBottom = parent ? parent.y + NH : rootBottom;
                            return <path key={`e-${node.id}`}
                                d={treeEdgePath(px, pBottom, x + NW / 2, y)}
                                fill="none" stroke={blue} strokeWidth={1.6} opacity={0.75} />;
                        })}

                        {/* root (the dataset) */}
                        <g transform={`translate(${layout.rootX - ROOT_W / 2},${rootBottom - ROOT_H})`}>
                            <rect width={ROOT_W} height={ROOT_H} rx={17}
                                fill={theme.palette.action.hover} stroke={border} />
                            <text x={ROOT_W / 2} y={21} textAnchor="middle" fontSize={11}
                                fontWeight={600} fill={theme.palette.text.secondary}>
                                {rootLabel.slice(0, 16)}
                            </text>
                        </g>

                        {/* state nodes */}
                        {layout.placed.map(({ node, x, y }) => (
                            <g key={node.id} transform={`translate(${x},${y})`} style={{ cursor: 'pointer' }}
                                onClick={() => setSelectedId(node.id)}>
                                <title>{node.charts.map(c => c.title || c.chartId).join('\n')}</title>
                                <rect width={NW} height={NH} rx={8}
                                    fill={theme.palette.background.paper}
                                    stroke={selectedId === node.id ? blue : border}
                                    strokeWidth={selectedId === node.id ? 2 : 1} />
                                <text x={10} y={20} fontSize={10.5} fontWeight={600} fill={theme.palette.text.primary}>
                                    {node.attributes.join(', ').slice(0, 25)}{node.attributes.join(', ').length > 25 ? '…' : ''}
                                </text>
                                <text x={10} y={38} fontSize={10} fill={theme.palette.text.secondary}>
                                    {t('analysisGraph.nodeSub', { charts: node.charts.length, level: node.depth })}
                                </text>
                                {node.selfLoops > 0 && (
                                    <g>
                                        <circle cx={NW - 4} cy={4} r={11} fill={blue} />
                                        <text x={NW - 4} y={8} textAnchor="middle" fontSize={10}
                                            fontWeight={700} fill={theme.palette.primary.contrastText}>
                                            ↻{node.selfLoops}
                                        </text>
                                    </g>
                                )}
                            </g>
                        ))}
                    </svg>
                </Box>
                <Box sx={{ width: 300, flexShrink: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {selected ? (
                        <>
                            <Typography variant="subtitle2">{`{ ${selected.attributes.join(', ')} }`}</Typography>
                            <Typography variant="caption" color="text.secondary">
                                {t('analysisGraph.stateStats', {
                                    visits: selected.visits, selfLoops: selected.selfLoops, revisits: selected.revisits,
                                })}
                            </Typography>
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
                            <Typography variant="subtitle2">{t('analysisGraph.trajectoriesHeading')}</Typography>
                            {m.trajectories.map(traj => (
                                <Box key={traj.leafId} sx={{ p: 1, border: `1px solid ${border}`, borderRadius: 1 }}>
                                    <Typography variant="caption" sx={{ display: 'block', lineHeight: 1.5 }}>
                                        {traj.stateIds.map(id => `{ ${id.split('␟').join(', ')} }`).join(' → ')}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        {t('analysisGraph.trajectoryEffort', { visits: traj.totalVisits })}
                                    </Typography>
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
                    <AccountTreeOutlinedIcon sx={{ fontSize: 18 }} />
                </IconButton>
            </Tooltip>
            <AnalysisGraphDialog open={open} onClose={() => setOpen(false)} />
        </>
    );
};
