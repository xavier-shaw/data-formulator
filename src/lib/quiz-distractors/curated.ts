// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

/**
 * quiz-distractors/curated.ts — the per-chart-type framework tables.
 *
 * This module is the v6 rule set (docs/quiz-distractor-framework.md): the
 * typical transformations of each chart type are DECLARED, per type. The
 * tables below were reviewed with the researcher one chart type at a time
 * (2026-08-18); the review's rationale lives in the framework doc.
 *
 * Each entry lists, in preference order:
 *
 *   visual  the typical mark-type transitions. The first entries are the
 *           near lures. The difficulty band is still COMPUTED from the
 *           transition cost in distance.ts, not declared here.
 *   data    the message operators that attack THIS chart type's message
 *           statistic, by id (see messageOps.ts). The selector takes the
 *           first two that pass their gates and floors, and it prefers two
 *           different message dimensions.
 *
 * The tables sit ON TOP of the shared machinery, which stays as a backstop:
 * per-target gates (non-negative values, category counts, ordered axes),
 * the same-fields check, the compile probe, the purity contract, and the
 * render guard all still run. A curated pair that fails a gate on this
 * data is not offered.
 *
 * A chart type with an empty axis cannot fill the matrix, and the quiz
 * skips it. Candlestick is such a type today: its reviewed lures (a
 * close-only line; open/close reversal) need machinery that does not exist
 * yet — see "Deferred machinery" in the framework doc.
 */

export interface CuratedEntry {
    /** permitted mark-type transitions, best first */
    visual: string[];
    /** message-operator ids from messageOps.ts, best first */
    data: string[];
}

export const CURATED: Record<string, CuratedEntry> = {
    // ── Bars ─────────────────────────────────────────────────────────────
    // Message: the ranking and the gap sizes. Line/Area are NOT offered (a
    // nominal axis shows a trend that is not real). Review: Heatmap dropped;
    // rank swap and the gap-scaling pair dropped from the data axis.
    'Bar Chart': {
        visual: ['Lollipop Chart', 'Bar Table', 'Pie Chart'],
        data: ['reverse', 'flatten'],
    },
    'Lollipop Chart': {
        visual: ['Bar Chart', 'Bar Table', 'Pie Chart'],
        data: ['reverse', 'flatten'],
    },
    'Bar Table': {
        visual: ['Bar Chart', 'Lollipop Chart', 'Pie Chart'],
        data: ['reverse', 'flatten'],
    },
    // Message: the interaction. Review: Heatmap and Ranged Dot dropped;
    // the one-group leader swap dropped. Scatter added (2026-08-19): points
    // per category stay honest on a nominal x, where the orderedX gate
    // rightly refuses the line.
    'Grouped Bar Chart': {
        visual: ['Stacked Bar Chart', 'Line Chart', 'Scatter Plot'],
        data: ['exchange', 'shrink', 'flatten'],
    },
    // Message: the composition and the total ranking. Review: Streamgraph
    // and Area dropped; a multi-line series added instead. Scatter added
    // (2026-08-19), same reason as Grouped Bar.
    'Stacked Bar Chart': {
        visual: ['Grouped Bar Chart', 'Line Chart', 'Scatter Plot'],
        data: ['exchange', 'reverse', 'flatten'],
    },
    // Message: which steps add, which remove, and the end level. Review:
    // the deltas may also flip their signs (gains become losses). A
    // running-sum line is admitted by design but needs a derive — deferred.
    'Waterfall Chart': {
        visual: ['Bar Chart'],
        data: ['move', 'reverse'],
    },

    // ── Lines & Areas ────────────────────────────────────────────────────
    // Message: the trend shape. Pie/Rose are NOT offered (they destroy the
    // ordered axis). Review: Bump dropped as a target; detrend dropped.
    'Line Chart': {
        visual: ['Area Chart', 'Bar Chart', 'Scatter Plot'],
        data: ['reverse', 'move', 'shrink', 'amplify'],
    },
    'Area Chart': {
        visual: ['Line Chart', 'Bar Chart', 'Scatter Plot'],
        data: ['reverse', 'move', 'shrink', 'amplify'],
    },
    // Message: who is above whom, and where they overtake.
    'Bump Chart': {
        visual: ['Line Chart'],
        data: ['reverse', 'move', 'shuffle'],
    },
    // Message: the width of the whole flow and the growth of each band.
    // Review: the unstacked multi-line added.
    'Streamgraph': {
        visual: ['Area Chart', 'Stacked Bar Chart', 'Line Chart'],
        data: ['exchange', 'move', 'shrink', 'flatten'],
    },

    // ── Points ───────────────────────────────────────────────────────────
    // Message: the association — sign, strength, outliers. Review: the
    // Scatter ↔ Regression pair does not count (too close), and Strip Plot
    // reads the same as a scatter. A binned Histogram is admitted by design
    // but needs a same-fields exemption — deferred.
    'Scatter Plot': {
        visual: ['Heatmap'],
        data: ['reverse', 'shuffle', 'shrink', 'amplify'],
    },
    'Regression': {
        visual: ['Heatmap'],
        data: ['reverse', 'shuffle', 'shrink', 'amplify'],
    },
    // Message: the gap between the two conditions, per category. Review:
    // Stacked Bar and Strip/Scatter added; Lollipop dropped. Rank swap
    // replaced by shuffle (2026-08-18: a swap moves only two values).
    'Ranged Dot Plot': {
        visual: ['Grouped Bar Chart', 'Stacked Bar Chart', 'Strip Plot', 'Scatter Plot'],
        data: ['exchange', 'shuffle', 'shrink'],
    },
    // Message: the density and the outliers, with no aggregation. Review:
    // Scatter dropped (reads the same); category swap dropped.
    'Strip Plot': {
        visual: ['Boxplot'],
        data: ['shuffle', 'reverse'],
    },

    // ── Distributions ────────────────────────────────────────────────────
    // Message: the modes, the skew, the center, and the spread. The ids
    // resolve to the raw-value mechanics here (move the center, mirror the
    // skew, widen the spread) — a distribution has no label axis.
    'Histogram': {
        visual: ['Density Plot', 'Strip Plot', 'Boxplot'],
        data: ['move', 'reverse', 'shrink'],
    },
    'Density Plot': {
        visual: ['Histogram', 'Strip Plot', 'Boxplot'],
        data: ['move', 'reverse', 'shrink'],
    },
    // Message: the medians, the spreads, and the outliers, per category.
    // Review: grouped Density added; the top-median swap dropped.
    'Boxplot': {
        visual: ['Strip Plot', 'Density Plot'],
        data: ['reverse', 'shuffle'],
    },
    // Message: the asymmetry between the two sides, and the bulges.
    // Review: the two side profiles as lines added.
    'Pyramid Chart': {
        visual: ['Grouped Bar Chart', 'Line Chart'],
        data: ['exchange', 'move', 'shrink'],
    },
    // Reviewed lures (close-only line; open/close reversal; big-day
    // rotation) all need machinery that does not exist yet, so the type
    // still leaves the quiz. See "Deferred machinery" in the doc.
    'Candlestick Chart': { visual: [], data: [] },

    // ── Circular ─────────────────────────────────────────────────────────
    // Message: the dominant share and the majority boundary. Review: the
    // dominant-share swap and the majority flip dropped.
    'Pie Chart': {
        visual: ['Rose Chart', 'Bar Chart'],
        data: ['reverse', 'flatten'],
    },
    'Rose Chart': {
        visual: ['Pie Chart', 'Bar Chart'],
        data: ['reverse', 'flatten'],
    },
    // Message: the shape of the profile. Review: the spike swap and the
    // v3 profile-flatten lure dropped.
    'Radar Chart': {
        visual: ['Rose Chart', 'Bar Chart'],
        data: ['reverse', 'flatten'],
    },

    // ── Tables & Maps ────────────────────────────────────────────────────
    // Message: the hotspot locations and the gradient direction. Review:
    // Stacked Bar added; the hotspot swap dropped from the data axis.
    'Heatmap': {
        visual: ['Grouped Bar Chart', 'Scatter Plot', 'Stacked Bar Chart'],
        data: ['reverse', 'shrink', 'shuffle'],
    },
    // Message: the spatial pattern. Review: the basemap swap dropped —
    // the regions become bar categories instead. Rank swap replaced by
    // shuffle (2026-08-18: a swap moves only two values; a shuffle moves
    // the whole pattern, and the hotspot with it).
    'US Map': {
        visual: ['Bar Chart'],
        data: ['shuffle', 'reverse', 'flatten'],
    },
    'World Map': {
        visual: ['Bar Chart'],
        data: ['shuffle', 'reverse', 'flatten'],
    },
    // One collapsed number has no look-alike space.
    'KPI Card': { visual: [], data: [] },
};

/** The curated entry for a chart type; empty axes when the type is unknown. */
export function curatedFor(chartType: string): CuratedEntry {
    return CURATED[chartType] ?? { visual: [], data: [] };
}
