// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * TraceTreeStep — reasoning-trace form A: rebuild the analysis as a tree.
 *
 * The participant sees their charts in a SHUFFLED palette (creation order would
 * give the structure away), drags them onto a canvas, and draws an arrow from
 * each chart to the chart it led to. The result is scored against the
 * ground-truth lineage in reasoningTrace.ts — edge precision and recall — but
 * nothing is revealed here; the score surfaces on the results screen.
 *
 * react-flow (@xyflow/react) does the canvas: free placement, handle-to-handle
 * connections, edge deletion. Each chart is one custom node showing the
 * rendered thumbnail; the top handle receives "came from", the bottom handle
 * starts "led to".
 */

import React, { FC, useCallback, useMemo, useRef, useState } from 'react';
import { Box, Button, Typography, alpha, useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import {
    ReactFlow, ReactFlowProvider, Background, Controls, MarkerType,
    Handle, Position, addEdge, useNodesState, useEdgesState, useReactFlow,
    Connection, Edge, Node, NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { borderColor, radius } from '../app/tokens';
import {
    TraceMaterial, TraceChart, TraceTreeAnswer, scoreTraceTree, shuffledTraceCharts,
} from '../app/reasoningTrace';

const svgUri = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/^<\?xml[^>]*\?>\s*/, ''))}`;

const DRAG_MIME = 'application/x-trace-chart';

type ChartNodeType = Node<{ chart: TraceChart }, 'chart'>;

/** One placed chart: thumbnail + title, a target handle above, a source below. */
const ChartNode: FC<NodeProps<ChartNodeType>> = ({ data, selected }) => {
    const theme = useTheme();
    return (
        <Box sx={{ width: 180, background: '#fff', borderRadius: radius.sm, p: 0.5,
                   border: `2px solid ${selected ? theme.palette.primary.main : borderColor.view}`,
                   boxShadow: selected ? `0 0 0 3px ${alpha(theme.palette.primary.main, 0.16)}` : '0 1px 3px rgba(0,0,0,0.08)' }}>
            <Handle type="target" position={Position.Top} style={{ width: 9, height: 9 }} />
            <img src={svgUri(data.chart.svg)} alt="" draggable={false}
                 style={{ width: '100%', height: 110, objectFit: 'contain', display: 'block', pointerEvents: 'none' }} />
            <Typography noWrap sx={{ fontSize: 10, color: 'text.secondary', px: 0.25, pt: 0.25 }}>
                {data.chart.title}
            </Typography>
            <Handle type="source" position={Position.Bottom} style={{ width: 9, height: 9 }} />
        </Box>
    );
};

const nodeTypes = { chart: ChartNode };

interface TraceTreeStepProps {
    material: TraceMaterial;
    onDone: (answer: TraceTreeAnswer) => void;
    wide?: boolean;
}

const Canvas: FC<TraceTreeStepProps> = ({ material, onDone, wide = true }) => {
    const { t } = useTranslation();
    const theme = useTheme();
    const { screenToFlowPosition } = useReactFlow();

    const [nodes, setNodes, onNodesChange] = useNodesState<ChartNodeType>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const startRef = useRef(Date.now());

    // Shuffled once; placed charts leave the palette.
    const palette = useMemo(() => shuffledTraceCharts(material.charts), [material]);
    const placedIds = useMemo(() => new Set(nodes.map(n => n.id)), [nodes]);
    const unplaced = palette.filter(c => !placedIds.has(c.chartId));

    const onConnect = useCallback((conn: Connection) => {
        // One incoming edge per chart keeps the drawing a tree, matching the
        // instruction "each chart grew out of at most one other chart".
        setEdges(eds => addEdge(
            { ...conn, markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 } },
            eds.filter(e => e.target !== conn.target),
        ));
    }, [setEdges]);

    const place = useCallback((chartId: string, position?: { x: number; y: number }) => {
        const chart = material.charts.find(c => c.chartId === chartId);
        if (!chart) return;
        setNodes(nds => {
            if (nds.some(n => n.id === chartId)) return nds;
            // No position (click-to-place) → next slot of a loose grid, so the
            // node lands somewhere visible rather than under an existing one.
            const p = position ?? { x: 30 + (nds.length % 3) * 230, y: 30 + Math.floor(nds.length / 3) * 210 };
            return [...nds, { id: chartId, type: 'chart' as const, position: p, data: { chart } }];
        });
    }, [material, setNodes]);

    const onDrop = useCallback((event: React.DragEvent) => {
        event.preventDefault();
        const chartId = event.dataTransfer.getData(DRAG_MIME);
        if (chartId) place(chartId, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }, [place, screenToFlowPosition]);

    const handleDone = useCallback(() => {
        const drawn = edges.map(e => ({ from: e.source, to: e.target }));
        onDone({
            form: 'tree',
            seconds: Math.round((Date.now() - startRef.current) / 1000),
            placed: nodes.map(n => ({ chartId: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
            edges: drawn,
            score: scoreTraceTree(drawn, material.edges),
            groundTruth: material.edges,
        });
    }, [edges, nodes, material, onDone]);

    const allPlaced = unplaced.length === 0;

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <Typography sx={{ fontSize: 12.5, px: 1.5, pt: 1 }}>
                {t('quiz.traceTreeIntro', { defaultValue:
                    'Rebuild your analysis from memory. Drag (or click) every chart to put it on the canvas, then draw an arrow from a chart to the chart it led to. Charts that started directly from the data get no incoming arrow.' })}
            </Typography>
            <Typography sx={{ fontSize: 11, color: 'text.disabled', px: 1.5, pb: 0.75 }}>
                {t('quiz.traceTreeHint', { defaultValue:
                    'Connect the dot at the bottom of one chart to the dot at the top of the next. Select an arrow and press Backspace to remove it.' })}
            </Typography>
            <Box sx={{ display: 'flex', flex: 1, minHeight: 0, borderTop: `1px solid ${borderColor.view}` }}>
                {/* palette — shuffled so creation order does not leak */}
                <Box sx={{ width: wide ? 190 : 140, flexShrink: 0, overflowY: 'auto',
                           borderRight: `1px solid ${borderColor.view}`, p: 1,
                           background: alpha(theme.palette.primary.main, 0.02) }}>
                    <Typography sx={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em', color: 'text.disabled', mb: 0.75 }}>
                        {t('quiz.traceTreePalette', { count: unplaced.length,
                            defaultValue: `Your charts — ${unplaced.length} left to place` })}
                    </Typography>
                    {unplaced.map(c => (
                        // Draggable, but a plain click also places it — dragging
                        // is unreliable on trackpads and impossible on touch.
                        <Box key={c.chartId} draggable
                            onDragStart={e => { e.dataTransfer.setData(DRAG_MIME, c.chartId); e.dataTransfer.effectAllowed = 'move'; }}
                            onClick={() => place(c.chartId)}
                            sx={{ border: `1px solid ${borderColor.view}`, borderRadius: radius.sm, p: 0.5, mb: 0.75,
                                  background: '#fff', cursor: 'grab', '&:hover': { borderColor: theme.palette.primary.main } }}>
                            <img src={svgUri(c.svg)} alt="" draggable={false}
                                 style={{ width: '100%', height: 72, objectFit: 'contain', display: 'block', pointerEvents: 'none' }} />
                            <Typography noWrap sx={{ fontSize: 9.5, color: 'text.secondary' }}>{c.title}</Typography>
                        </Box>
                    ))}
                    {allPlaced && (
                        <Typography sx={{ fontSize: 10.5, color: 'success.main' }}>
                            {t('quiz.traceTreeAllPlaced', { defaultValue: 'All charts placed — now draw the arrows.' })}
                        </Typography>
                    )}
                </Box>
                {/* canvas */}
                <Box sx={{ flex: 1, minWidth: 0 }} onDrop={onDrop} onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}>
                    <ReactFlow
                        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
                        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
                        deleteKeyCode={['Backspace', 'Delete']}
                        defaultViewport={{ x: 0, y: 0, zoom: 0.9 }} minZoom={0.2}
                        proOptions={{ hideAttribution: true }}
                    >
                        <Background gap={18} />
                        <Controls showInteractive={false} />
                    </ReactFlow>
                </Box>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderTop: `1px solid ${borderColor.view}` }}>
                <Button size="small" variant="contained" disabled={!allPlaced} onClick={handleDone}
                        sx={{ fontSize: 12, textTransform: 'none' }}>
                    {t('quiz.traceTreeDone', { defaultValue: 'Done — this is how I remember it' })}
                </Button>
                {!allPlaced && (
                    <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>
                        {t('quiz.traceTreePlaceAll', { count: unplaced.length,
                            defaultValue: `Place the remaining ${unplaced.length} chart(s) first.` })}
                    </Typography>
                )}
            </Box>
        </Box>
    );
};

export const TraceTreeStep: FC<TraceTreeStepProps> = (props) => (
    <ReactFlowProvider>
        <Canvas {...props} />
    </ReactFlowProvider>
);
