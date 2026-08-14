// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * FindingsPanel — the "My findings" side panel (user study).
 *
 * A plain chart collection that replaced the participant-authored TipTap
 * report: participants only SELECT charts as findings, they don't write a
 * document. Each entry is one chart group — preview + title + caption —
 * added and removed as a whole (no per-part editing). The header shows the
 * running count. Membership is first-class state (`state.findingsChartIds`);
 * add/remove events are logged to `state.reportChartAdds` for the study.
 *
 * Mounted in DataFormulator's third Allotment pane in the study conditions
 * (the Default condition keeps the legacy ReportView there).
 */

import React, { FC } from 'react';
import {
    Box,
    IconButton,
    Tooltip,
    Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { useDispatch, useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';

import { DataFormulatorState, dfActions } from '../app/dfSlice';
import { getCachedChart } from '../app/chartCache';
import { floatingPillSx } from '../app/tokens';

// Stable fallback so the selector never fabricates a fresh [] per call
// (pre-feature persisted states can lack the field).
const EMPTY_FINDINGS_IDS: string[] = [];

/** Chart preview: prefer the full-size cached PNG, fall back to the thumbnail
 *  (same source order as the analysis graph's side panel). */
const FindingPreview: FC<{ chartId: string }> = ({ chartId }) => {
    const { t } = useTranslation();
    const thumbnail = useSelector((s: DataFormulatorState) => s.chartThumbnails?.[chartId]);
    const src = getCachedChart(chartId)?.fullPngDataUrl || thumbnail;

    if (!src) {
        return (
            <Box sx={{
                height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: theme => `1px dashed ${theme.palette.divider}`, borderRadius: 1,
                fontSize: 11, color: 'text.disabled',
            }}>{t('findings.previewPending')}</Box>
        );
    }
    return (
        <Box component="img" src={src} alt=""
            sx={{
                width: '100%', maxHeight: 180, objectFit: 'contain', display: 'block',
                backgroundColor: 'background.paper',
            }} />
    );
};

export const FindingsPanel: FC = () => {
    const { t } = useTranslation();
    const dispatch = useDispatch();

    const findingsChartIds = useSelector((s: DataFormulatorState) => s.findingsChartIds) ?? EMPTY_FINDINGS_IDS;
    const charts = useSelector((s: DataFormulatorState) => s.charts);

    // Defensive: render only ids that still resolve to a chart (delete cascades
    // already prune state, but a stale persisted session must not crash here).
    const entries = findingsChartIds
        .map(id => charts.find(c => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c);

    return (
        <Box sx={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* Header: title + running count, close on the right. Title and count
                stack vertically so the header survives the panel's narrow default
                width (~200px) instead of wrapping mid-phrase. */}
            <Box sx={{
                display: 'flex', alignItems: 'center', gap: 1,
                px: 1.5, py: 1.25, flexShrink: 0,
                borderBottom: theme => `1px solid ${theme.palette.divider}`,
            }}>
                <Box sx={{ minWidth: 0 }}>
                    <Typography noWrap sx={{ fontSize: 14, fontWeight: 500, lineHeight: 1.35 }}>
                        {t('report.myFindingsTitle')}
                    </Typography>
                    <Typography noWrap sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.35 }}>
                        {t('findings.chartCount', { count: entries.length })}
                    </Typography>
                </Box>
                <Box sx={{ ml: 'auto', flexShrink: 0 }}>
                    <Tooltip title={t('findings.closePanel')} placement="left">
                        <IconButton
                            size="small"
                            onClick={() => dispatch(dfActions.closeReportView())}
                            sx={floatingPillSx}
                        >
                            <CloseIcon sx={{ fontSize: 18 }} />
                        </IconButton>
                    </Tooltip>
                </Box>
            </Box>

            {/* Chart groups */}
            <Box sx={{ flex: 1, overflowY: 'auto', px: 1.5, py: 1.5, display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                {entries.length === 0 && (
                    <Typography sx={{ fontSize: 12, color: 'text.secondary', textAlign: 'center', my: 'auto', px: 1, lineHeight: 1.6 }}>
                        {t('findings.emptyHint')}
                    </Typography>
                )}
                {entries.map((chart, idx) => {
                    const title = chart.title?.trim()
                        || t('report.chartNumberFallback', { number: idx + 1 });
                    return (
                        <Box
                            key={chart.id}
                            onClick={() => dispatch(dfActions.setFocused({ type: 'chart', chartId: chart.id }))}
                            sx={{
                                border: theme => `1px solid ${theme.palette.divider}`,
                                borderRadius: 1.5,
                                p: 1.25,
                                cursor: 'pointer',
                                position: 'relative',
                                transition: 'border-color 0.15s, box-shadow 0.15s',
                                '&:hover': {
                                    borderColor: 'primary.main',
                                    boxShadow: theme => `0 1px 6px ${theme.palette.action.hover}`,
                                },
                                '&:hover .findings-remove-btn': { opacity: 1 },
                            }}
                        >
                            {/* Remove the whole group */}
                            <Tooltip title={t('findings.removeChart')} placement="left">
                                <IconButton
                                    className="findings-remove-btn"
                                    size="small"
                                    onClick={(event) => {
                                        event.stopPropagation();
                                        dispatch(dfActions.removeChartFromFindings({ chartId: chart.id }));
                                    }}
                                    sx={{
                                        position: 'absolute', top: 6, right: 6, zIndex: 2,
                                        opacity: 0, transition: 'opacity 0.15s',
                                        backgroundColor: 'background.paper',
                                        border: theme => `1px solid ${theme.palette.divider}`,
                                        '&:hover': { color: 'error.main', backgroundColor: 'background.paper' },
                                    }}
                                >
                                    <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                                </IconButton>
                            </Tooltip>
                            <Typography sx={{ fontSize: 13, fontWeight: 500, mb: 0.75, pr: 4 }}>
                                {title}
                            </Typography>
                            <FindingPreview chartId={chart.id} />
                        </Box>
                    );
                })}
            </Box>
        </Box>
    );
};
