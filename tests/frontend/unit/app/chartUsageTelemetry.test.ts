import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { dataFormulatorReducer, dfActions } from '../../../../src/app/dfSlice';
import {
    describeChartUsage, formatViewDuration, pushChartUsagePause, totalChartUsageMs,
    useChartUsageTracker,
} from '../../../../src/app/chartUsageTelemetry';

// Passive per-chart viewing telemetry: the reducer accumulates deltas, the
// tracker hook decides when time counts (chart focused + editor mode + tab
// visible + not idle + not paused by an overlay). The hook tests drive a real
// store under fake timers, since the interesting behavior IS the timing.

const TICK = 15_000;    // heartbeat (chartUsageTelemetry TICK_MS)
const IDLE = 90_000;    // idle cutoff (chartUsageTelemetry IDLE_MS)

describe('formatViewDuration', () => {
    it('renders long form across magnitudes', () => {
        expect(formatViewDuration(300)).toBe('<1s');
        expect(formatViewDuration(42_000)).toBe('42s');
        expect(formatViewDuration(180_000)).toBe('3m');
        expect(formatViewDuration(185_000)).toBe('3m 05s');
        expect(formatViewDuration(4_320_000)).toBe('1h 12m');
    });
    it('renders compact form for tight rows', () => {
        expect(formatViewDuration(42_000, 'compact')).toBe('42s');
        expect(formatViewDuration(185_000, 'compact')).toBe('3m');
        expect(formatViewDuration(4_320_000, 'compact')).toBe('1h12m');
    });
});

describe('describeChartUsage / totalChartUsageMs', () => {
    it('describes usage, including the never-viewed case', () => {
        expect(describeChartUsage(undefined)).toBe('Not viewed yet');
        expect(describeChartUsage({ focusMs: 0, visits: 0 })).toBe('Not viewed yet');
        expect(describeChartUsage({ focusMs: 65_000, visits: 1 })).toBe('Viewed 1m 05s · 1 visit');
        expect(describeChartUsage({ focusMs: 65_000, visits: 3 })).toBe('Viewed 1m 05s · 3 visits');
    });
    it('sums usage over a chart-id set, tolerating gaps', () => {
        const usage = { a: { focusMs: 1000, visits: 1 }, b: { focusMs: 500, visits: 2 } };
        expect(totalChartUsageMs(usage, ['a', 'b', 'missing'])).toBe(1500);
        expect(totalChartUsageMs(undefined, ['a'])).toBe(0);
    });
});

describe('recordChartUsage reducer', () => {
    it('creates, accumulates, and counts visits', () => {
        let s = dataFormulatorReducer(undefined, { type: '@@init' } as any);
        s = dataFormulatorReducer(s, dfActions.recordChartUsage({ chartId: 'c1', focusMs: 0, visit: true }));
        s = dataFormulatorReducer(s, dfActions.recordChartUsage({ chartId: 'c1', focusMs: 4000 }));
        s = dataFormulatorReducer(s, dfActions.recordChartUsage({ chartId: 'c1', focusMs: 6000, visit: true }));
        expect(s.chartUsage['c1'].focusMs).toBe(10_000);
        expect(s.chartUsage['c1'].visits).toBe(2);
        expect(s.chartUsage['c1'].firstViewedAt).toBeDefined();
        expect(s.chartUsage['c1'].lastViewedAt).toBeDefined();
    });
    it('tolerates pre-telemetry states with no chartUsage map', () => {
        const init = dataFormulatorReducer(undefined, { type: '@@init' } as any);
        const legacy = { ...init, chartUsage: undefined } as any;
        const s = dataFormulatorReducer(legacy, dfActions.recordChartUsage({ chartId: 'c1', focusMs: 1000 }));
        expect(s.chartUsage['c1'].focusMs).toBe(1000);
    });
});

// ─── the tracker hook, under fake timers ─────────────────────────────────────

const Tracker: React.FC = () => { useChartUsageTracker(); return null; };

const setup = () => {
    const store = configureStore({
        reducer: dataFormulatorReducer,
        middleware: (g: any) => g({ serializableCheck: false }),
    });
    const view = render(React.createElement(Provider, { store }, React.createElement(Tracker)));
    return { store, view };
};

const focusChart = (store: any, chartId: string) =>
    act(() => { store.dispatch(dfActions.setFocused({ type: 'chart', chartId })); });
const focusTable = (store: any, tableId: string) =>
    act(() => { store.dispatch(dfActions.setFocused({ type: 'table', tableId })); });
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('useChartUsageTracker', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('credits focused time via heartbeats and on unfocus, and counts visits', () => {
        const { store, view } = setup();
        focusChart(store, 'c1');
        advance(2 * TICK);                     // two heartbeat flushes
        advance(4000);                         // partial segment…
        focusTable(store, 't1');               // …flushed by the focus switch
        const entry = store.getState().chartUsage['c1'];
        expect(entry.visits).toBe(1);
        expect(entry.focusMs).toBe(2 * TICK + 4000);
        view.unmount();
    });

    it('counts a fresh visit each time the chart regains focus', () => {
        const { store, view } = setup();
        focusChart(store, 'c1');
        advance(1000);
        focusChart(store, 'c2');
        advance(1000);
        focusChart(store, 'c1');
        advance(1000);
        focusTable(store, 't1');
        const s = store.getState();
        expect(s.chartUsage['c1'].visits).toBe(2);
        expect(s.chartUsage['c2'].visits).toBe(1);
        expect(s.chartUsage['c1'].focusMs).toBe(2000);
        expect(s.chartUsage['c2'].focusMs).toBe(1000);
        view.unmount();
    });

    it('stops counting once the user goes idle, capped at the idle cutoff', () => {
        const { store, view } = setup();
        focusChart(store, 'c1');
        // No input events at all: idleness dates from mount. Run well past the
        // cutoff — only time up to (lastActivity + IDLE) may be credited.
        advance(20 * TICK);
        focusTable(store, 't1');
        expect(store.getState().chartUsage['c1'].focusMs).toBeLessThanOrEqual(IDLE);
        expect(store.getState().chartUsage['c1'].focusMs).toBeGreaterThan(0);
        view.unmount();
    });

    it('resumes counting when input activity returns after idle', () => {
        const { store, view } = setup();
        focusChart(store, 'c1');
        advance(20 * TICK);                    // idle out (credits ≤ IDLE)
        const idled = store.getState().chartUsage['c1'].focusMs;
        act(() => { window.dispatchEvent(new Event('pointermove')); });   // re-engage
        advance(TICK);
        focusTable(store, 't1');
        expect(store.getState().chartUsage['c1'].focusMs).toBe(idled + TICK);
        view.unmount();
    });

    it('does not count while paused by an overlay, and resumes on release', () => {
        const { store, view } = setup();
        focusChart(store, 'c1');
        advance(1000);
        let release!: () => void;
        act(() => { release = pushChartUsagePause(); });   // e.g. analysis graph opens
        advance(3 * TICK);                                  // reading the graph: no credit
        act(() => { window.dispatchEvent(new Event('pointermove')); });   // stay non-idle
        act(() => { release(); });
        advance(TICK);
        focusTable(store, 't1');
        expect(store.getState().chartUsage['c1'].focusMs).toBe(1000 + TICK);
        expect(release).toBeDefined();
        view.unmount();
    });

    it('does not count while the tab is hidden', () => {
        const { store, view } = setup();
        focusChart(store, 'c1');
        advance(1000);
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        advance(3 * TICK);
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        advance(TICK);
        focusTable(store, 't1');
        expect(store.getState().chartUsage['c1'].focusMs).toBe(1000 + TICK);
        delete (document as any).visibilityState;   // drop the instance shadow over the prototype getter
        view.unmount();
    });
});
