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
        data: ['reassign-reverse', 'equalize'],
    },
    'Lollipop Chart': {
        visual: ['Bar Chart', 'Bar Table', 'Pie Chart'],
        data: ['reassign-reverse', 'equalize'],
    },
    'Bar Table': {
        visual: ['Bar Chart', 'Lollipop Chart', 'Pie Chart'],
        data: ['reassign-reverse', 'equalize'],
    },
    // Message: the interaction. Review: Heatmap and Ranged Dot dropped;
    // the one-group leader swap dropped.
    'Grouped Bar Chart': {
        visual: ['Stacked Bar Chart', 'Line Chart'],
        data: ['series-exchange', 'attenuate', 'equalize'],
    },
    // Message: the composition and the total ranking. Review: Streamgraph
    // and Area dropped; a multi-line series added instead.
    'Stacked Bar Chart': {
        visual: ['Grouped Bar Chart', 'Line Chart'],
        data: ['series-exchange', 'reassign-reverse', 'equalize'],
    },
    // Message: which steps add, which remove, and the end level. Review:
    // the deltas may also negate (gains become losses). A running-sum line
    // is admitted by design but needs a derive — deferred.
    'Waterfall Chart': {
        visual: ['Bar Chart'],
        data: ['reassign-rotate', 'negate'],
    },

    // ── Lines & Areas ────────────────────────────────────────────────────
    // Message: the trend shape. Pie/Rose are NOT offered (they destroy the
    // ordered axis). Review: Bump dropped as a target; detrend dropped.
    'Line Chart': {
        visual: ['Area Chart', 'Bar Chart', 'Scatter Plot'],
        data: ['reassign-reverse', 'reassign-rotate', 'attenuate', 'polarize'],
    },
    'Area Chart': {
        visual: ['Line Chart', 'Bar Chart', 'Scatter Plot'],
        data: ['reassign-reverse', 'reassign-rotate', 'attenuate', 'polarize'],
    },
    // Message: who is above whom, and where they overtake.
    'Bump Chart': {
        visual: ['Line Chart'],
        data: ['reassign-reverse', 'reassign-rotate', 'shuffle'],
    },
    // Message: the width of the whole flow and the growth of each band.
    // Review: the unstacked multi-line added.
    'Streamgraph': {
        visual: ['Area Chart', 'Stacked Bar Chart', 'Line Chart'],
        data: ['series-exchange', 'reassign-rotate', 'attenuate', 'equalize'],
    },

    // ── Points ───────────────────────────────────────────────────────────
    // Message: the association — sign, strength, outliers. Review: the
    // Scatter ↔ Regression pair does not count (too close), and Strip Plot
    // reads the same as a scatter. A binned Histogram is admitted by design
    // but needs a same-fields exemption — deferred.
    'Scatter Plot': {
        visual: ['Heatmap'],
        data: ['antitone', 'decorrelate', 'attenuate-relation', 'polarize-relation'],
    },
    'Regression': {
        visual: ['Heatmap'],
        data: ['antitone', 'decorrelate', 'attenuate-relation', 'polarize-relation'],
    },
    // Message: the gap between the two conditions, per category. Review:
    // Stacked Bar and Strip/Scatter added; Lollipop dropped. Rank swap
    // replaced by shuffle (2026-08-18: a swap moves only two values).
    'Ranged Dot Plot': {
        visual: ['Grouped Bar Chart', 'Stacked Bar Chart', 'Strip Plot', 'Scatter Plot'],
        data: ['series-exchange', 'shuffle', 'attenuate'],
    },
    // Message: the density and the outliers, with no aggregation. Review:
    // Scatter dropped (reads the same); category swap dropped.
    'Strip Plot': {
        visual: ['Boxplot'],
        data: ['shuffle', 'reassign-reverse'],
    },

    // ── Distributions ────────────────────────────────────────────────────
    // Message: the modes, the skew, the center, and the spread. The
    // raw-value operators (dist-*) work on the one quantitative field.
    'Histogram': {
        visual: ['Density Plot', 'Strip Plot', 'Boxplot'],
        data: ['dist-shift', 'dist-mirror', 'dist-widen'],
    },
    'Density Plot': {
        visual: ['Histogram', 'Strip Plot', 'Boxplot'],
        data: ['dist-shift', 'dist-mirror', 'dist-widen'],
    },
    // Message: the medians, the spreads, and the outliers, per category.
    // Review: grouped Density added; the top-median swap dropped.
    'Boxplot': {
        visual: ['Strip Plot', 'Density Plot'],
        data: ['reassign-reverse', 'shuffle'],
    },
    // Message: the asymmetry between the two sides, and the bulges.
    // Review: the two side profiles as lines added.
    'Pyramid Chart': {
        visual: ['Grouped Bar Chart', 'Line Chart'],
        data: ['series-exchange', 'reassign-rotate', 'attenuate'],
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
        data: ['reassign-reverse', 'equalize'],
    },
    'Rose Chart': {
        visual: ['Pie Chart', 'Bar Chart'],
        data: ['reassign-reverse', 'equalize'],
    },
    // Message: the shape of the profile. Review: spike swap and flatten
    // dropped.
    'Radar Chart': {
        visual: ['Rose Chart', 'Bar Chart'],
        data: ['reassign-reverse', 'equalize'],
    },

    // ── Tables & Maps ────────────────────────────────────────────────────
    // Message: the hotspot locations and the gradient direction. Review:
    // Stacked Bar added; the hotspot swap dropped from the data axis.
    'Heatmap': {
        visual: ['Grouped Bar Chart', 'Scatter Plot', 'Stacked Bar Chart'],
        data: ['reassign-reverse', 'attenuate', 'shuffle'],
    },
    // Message: the spatial pattern. Review: the basemap swap dropped —
    // the regions become bar categories instead. Rank swap replaced by
    // shuffle (2026-08-18: a swap moves only two values; a shuffle moves
    // the whole pattern, and the hotspot with it).
    'US Map': {
        visual: ['Bar Chart'],
        data: ['shuffle', 'reassign-reverse', 'equalize'],
    },
    'World Map': {
        visual: ['Bar Chart'],
        data: ['shuffle', 'reassign-reverse', 'equalize'],
    },
    // One collapsed number has no look-alike space.
    'KPI Card': { visual: [], data: [] },
};

/** The curated entry for a chart type; empty axes when the type is unknown. */
export function curatedFor(chartType: string): CuratedEntry {
    return CURATED[chartType] ?? { visual: [], data: [] };
}
