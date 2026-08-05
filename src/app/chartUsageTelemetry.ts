// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// Passive per-chart viewing telemetry.
//
// While a chart is focused on the canvas, `useChartUsageTracker` (mounted once
// in App) accumulates ACTIVE viewing time into `state.chartUsage`, so the
// analysis graph can show a facilitator where the analyst's attention went.
//
// "Active" means all of:
//   - the focused item is a chart (the report side panel may be open too —
//     the canvas stays visible next to it, so viewing still counts),
//   - the browser tab is visible,
//   - the user has produced some input (pointer/key/wheel) within the last
//     IDLE_MS — reading a chart hands-off still counts, walking away doesn't,
//   - no overlay has paused tracking (the analysis graph dialog pauses, so a
//     facilitator reading the graph doesn't inflate the chart behind it).
//
// Time is credited in small deltas via `recordChartUsage`: a heartbeat flush
// every TICK_MS keeps redux (and thus workspace auto-save) near-live, so a
// crash or reload loses at most one tick. A "visit" is counted each time a
// chart gains focus, so `visits` reads as "how many times the analyst came
// back to this chart".

import { useEffect, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { ChartUsageEntry, DataFormulatorState, dfActions } from './dfSlice';
import type { AppDispatch } from './store';

/** Input gap after which viewing no longer counts (user walked away). */
const IDLE_MS = 90_000;
/**
 * Heartbeat flush interval — bounds data loss on a crash/reload and keeps
 * displays fresh. Kept coarse on purpose: every flush is a redux write, and
 * redux writes re-arm the (3s-debounced) workspace auto-save, so a hot
 * heartbeat would turn quiet chart-reading into a steady stream of saves.
 */
const TICK_MS = 15_000;

// ─── pause registry (modal overlays) ─────────────────────────────────────────

let pauseCount = 0;
const pauseListeners = new Set<() => void>();
const notifyPause = () => { for (const l of pauseListeners) l(); };

/**
 * Suspend usage tracking while an overlay hides the canvas (e.g. the analysis
 * graph dialog). Returns a release function; calling it more than once is
 * safe. Nested pauses stack.
 */
export const pushChartUsagePause = (): (() => void) => {
    pauseCount += 1;
    notifyPause();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        pauseCount -= 1;
        notifyPause();
    };
};

const isPaused = () => pauseCount > 0;

// ─── the tracker ─────────────────────────────────────────────────────────────

/**
 * Mount once (App). Watches the focused chart and credits active viewing time
 * to `state.chartUsage` (see module header for the counting rules).
 */
export const useChartUsageTracker = () => {
    const dispatch = useDispatch<AppDispatch>();
    const focusedId = useSelector((s: DataFormulatorState) => s.focusedId);
    const sessionLoading = useSelector((s: DataFormulatorState) => s.sessionLoading);

    const trackedId = !sessionLoading && focusedId?.type === 'chart'
        ? focusedId.chartId : null;

    const trackedRef = useRef<string | null>(null);
    trackedRef.current = trackedId;
    /** The open countable segment — it knows which chart it belongs to, so a
     *  close after focus already moved on still credits the right chart. */
    const segRef = useRef<{ chartId: string; start: number } | null>(null);
    const lastActivityRef = useRef<number>(Date.now());

    // Stable across the app's lifetime — everything reads through refs.
    const dispatchRef = useRef(dispatch);
    dispatchRef.current = dispatch;

    // Segment open/close live in a ref so window listeners never go stale.
    const controlsRef = useRef({
        /** Credit the open segment up to `until` (default now) and close it. */
        close(until?: number) {
            const seg = segRef.current;
            segRef.current = null;
            if (!seg) return;
            const end = Math.max(seg.start, until ?? Date.now());
            if (end - seg.start >= 250) {   // ignore sub-noise slivers
                dispatchRef.current(dfActions.recordChartUsage({ chartId: seg.chartId, focusMs: end - seg.start }));
            }
        },
        /** Open a segment if every "active" condition currently holds. */
        maybeOpen() {
            if (segRef.current != null) return;
            const chartId = trackedRef.current;
            if (!chartId || isPaused()) return;
            if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
            if (Date.now() - lastActivityRef.current > IDLE_MS) return;
            segRef.current = { chartId, start: Date.now() };
        },
    });

    // Focus changes: close the old chart's segment, count a visit on the new
    // one, open its segment. (Runs on mount too — restoring a session onto a
    // focused chart legitimately starts a new viewing session.)
    useEffect(() => {
        const c = controlsRef.current;
        c.close();
        if (trackedId) {
            dispatchRef.current(dfActions.recordChartUsage({ chartId: trackedId, focusMs: 0, visit: true }));
            c.maybeOpen();
        }
    }, [trackedId]);

    // Global listeners + heartbeat: mounted once.
    useEffect(() => {
        const c = controlsRef.current;

        const onActivity = () => {
            lastActivityRef.current = Date.now();
            c.maybeOpen();   // re-engage after an idle close
        };
        const activityEvents: (keyof WindowEventMap)[] = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart'];
        for (const ev of activityEvents) window.addEventListener(ev, onActivity, { passive: true, capture: true });

        const onVisibility = () => {
            if (document.visibilityState === 'visible') { lastActivityRef.current = Date.now(); c.maybeOpen(); }
            else c.close();
        };
        document.addEventListener('visibilitychange', onVisibility);

        const onPageHide = () => c.close();
        window.addEventListener('pagehide', onPageHide);
        window.addEventListener('beforeunload', onPageHide);

        const onPauseChange = () => { if (isPaused()) c.close(); else c.maybeOpen(); };
        pauseListeners.add(onPauseChange);

        const timer = window.setInterval(() => {
            const seg = segRef.current;
            if (!seg) { c.maybeOpen(); return; }
            const now = Date.now();
            if (now - lastActivityRef.current > IDLE_MS) {
                // went idle: credit only up to the moment idleness took over
                c.close(lastActivityRef.current + IDLE_MS);
            } else {
                c.close(now);                                    // flush this tick…
                segRef.current = { chartId: seg.chartId, start: now };   // …and keep rolling
            }
        }, TICK_MS);

        return () => {
            for (const ev of activityEvents) window.removeEventListener(ev, onActivity, { capture: true } as EventListenerOptions);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('pagehide', onPageHide);
            window.removeEventListener('beforeunload', onPageHide);
            pauseListeners.delete(onPauseChange);
            window.clearInterval(timer);
            c.close();
        };
    }, []);
};

// ─── display helpers ─────────────────────────────────────────────────────────

/**
 * Human duration for view-time labels.
 *   long:    "42s", "3m 05s", "1h 12m"   (side panel, tooltips)
 *   compact: "42s", "3m", "1h12m"        (tight card rows)
 */
export const formatViewDuration = (ms: number, style: 'long' | 'compact' = 'long'): string => {
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 1) return '<1s';
    if (totalSec < 60) return `${totalSec}s`;
    const totalMin = Math.floor(totalSec / 60);
    if (totalMin < 60) {
        if (style === 'compact') return `${totalMin}m`;
        const s = totalSec % 60;
        return s > 0 ? `${totalMin}m ${String(s).padStart(2, '0')}s` : `${totalMin}m`;
    }
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return style === 'compact' ? `${h}h${String(m).padStart(2, '0')}m` : `${h}h ${String(m).padStart(2, '0')}m`;
};

/** One-line tooltip: "Viewed 3m 05s · 4 visits". */
export const describeChartUsage = (entry: ChartUsageEntry | undefined): string =>
    entry && entry.focusMs > 0
        ? `Viewed ${formatViewDuration(entry.focusMs)} · ${entry.visits} visit${entry.visits === 1 ? '' : 's'}`
        : 'Not viewed yet';

/** Total active viewing time across a set of charts. */
export const totalChartUsageMs = (
    usage: Record<string, ChartUsageEntry> | undefined,
    chartIds: Iterable<string>,
): number => {
    let sum = 0;
    for (const id of chartIds) sum += usage?.[id]?.focusMs ?? 0;
    return sum;
};
