// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * ChartMemoryPage — the chart-recognition quiz as a full-width page.
 *
 * A page rather than a docked pane because both modes need room: the quiz shows
 * four charts side by side, and author mode shows a method's whole range of
 * look-alikes. Squeezed into a third of the window they were unreadable.
 *
 * The session to work on comes from the query string (`?session=<id>&name=<n>`),
 * so the view is linkable and survives a reload. Navigating here does not
 * disturb the analysis session: the store outlives the route, so going back to
 * /app restores the canvas exactly as it was.
 */

import { FC, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { Box, Button, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useTranslation } from 'react-i18next';
import { DataFormulatorState } from '../app/dfSlice';
import { QuizPanel } from './QuizPanel';

export const ChartMemoryPage: FC = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [params] = useSearchParams();

    const activeWorkspace = useSelector((state: DataFormulatorState) => state.activeWorkspace);

    // Fall back to the open session, so reaching this page from the top nav
    // (with no query string) quizzes whatever the user is working on.
    const sessionId = params.get('session') || activeWorkspace?.id || '';
    const sessionName = params.get('name') || activeWorkspace?.displayName || sessionId;

    // For the ACTIVE session read the live slices rather than the stored copy:
    // autosave lags, and the focus time of the chart most recently viewed is
    // still accumulating in memory.
    const charts = useSelector((state: DataFormulatorState) => state.charts);
    const tables = useSelector((state: DataFormulatorState) => state.tables);
    const conceptShelfItems = useSelector((state: DataFormulatorState) => state.conceptShelfItems);
    const chartUsage = useSelector((state: DataFormulatorState) => state.chartUsage);
    const liveState = useMemo(
        () => ({ charts, tables, conceptShelfItems, chartUsage }),
        [charts, tables, conceptShelfItems, chartUsage],
    );

    if (!sessionId) {
        return (
            <Box sx={{ p: 4, maxWidth: 640, mx: 'auto' }}>
                <Typography sx={{ fontSize: 15, mb: 1 }}>
                    {t('quiz.noSession', { defaultValue: 'Open a session first, or pick one from the sessions list to test your memory of it.' })}
                </Typography>
                <Button size="small" startIcon={<ArrowBackIcon sx={{ fontSize: 16 }} />} onClick={() => navigate('/app')} sx={{ textTransform: 'none' }}>
                    {t('quiz.backToApp', { defaultValue: 'Back to the app' })}
                </Button>
            </Box>
        );
    }

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', backgroundColor: 'white' }}>
            <QuizPanel
                sessionId={sessionId}
                sessionName={sessionName}
                liveState={activeWorkspace?.id === sessionId ? liveState : undefined}
                layout="page"
                onClose={() => navigate('/app')}
            />
        </Box>
    );
};
