# Quiz distractor framework: message-anchored lures

Status: design v6 (2026-08-18). This document governs `src/lib/quiz-distractors/`.

v5 restored the v3 idea: the typical transformations of each chart type are
**declared per chart type**, in curated tables (`curated.ts`). The derived
target roster of v4 is gone. v5 also changed the item composition: each quiz
item is an **option matrix** (3×3 target, 2×2 minimum) with **combined**
lures in the cross cells. The v4 machinery stays below the tables as a
backstop: gates, the compile probe, the purity contract, and the render
guard.

v6 replaces the v5 tables with tables the researcher reviewed, one chart
type at a time (2026-08-18). The review made most lists SHORTER: a lure
must be a transformation a participant would see as a plausible tool or a
plausible finding, and near-duplicates (Scatter ↔ Regression, Strip ↔
Scatter) do not count. The review also admitted lures the machinery cannot
build yet; these are listed under "Deferred machinery" and are NOT in
`curated.ts`.

Written in ASD-STE100 Simplified Technical English.

Terminology in this document:

- **Visual perturbation** = keep the underlying data; change the mark type.
  The finding stays the same. The lure tests whether the participant
  remembers the **tool** they used to get the finding.
- **Data perturbation** = keep the visual representation; change the
  underlying data distribution. The finding becomes different. The lure
  tests whether the participant remembers the **finding** itself.
- **Combined perturbation** = the visual lure's drawing over the data
  lure's rows. Both changed. A participant who picks it encoded neither
  the tool nor the finding.

## The option matrix

Each item shows the options as a cross of the two axes:

|              | original data | data lure D1 | data lure D2 |
|---|---|---|---|
| **original mark** | the correct answer | data lure | data lure |
| **mark lure V1**  | visual lure | combined V1×D1 | combined V1×D2 |
| **mark lure V2**  | visual lure | combined V2×D1 | combined V2×D2 |

- The target is 3×3: the original + 2 visual + 2 data + 4 combined = 9
  options.
- A chart type that admits only one lure on an axis shrinks the matrix
  (2×3, 3×2, or 2×2). Below 2×2 the quiz skips the chart.
- Every option carries its cell `(v, d)`. The original is (0,0). The
  answer record keeps the cell, so the analysis can place each miss.
- The participant sees the options shuffled, not as a grid.

## Core concept: the message statistic

Each chart type shows one primary takeaway. We call this the **message
statistic**. A data perturbation must change this statistic. A visual
perturbation must keep it. This rule did not change from v3.

## P1 — Visual perturbation

The permitted mark transitions are DECLARED per chart type in `curated.ts`,
in preference order. A curated target must still pass, on this chart's data:

1. **The plausibility gates.** A radial target needs non-negative values
   and few categories (`nonNeg`, `maxCats8`). A trend target needs an
   ordered x axis (`orderedX`). A fitted line needs a quantitative x axis
   (`quantX`).
2. **The same-fields check.** The adapted encoding must show exactly the
   fields the original shows — no dropped series, no new column.
3. **The compile probe.** The target must compile through the app's own
   assembler over the same rows.
4. **The purity contract.** A visual lure does not touch the rows, the
   sort, or the aggregate.

The difficulty band (near / mid / far) is COMPUTED from the mark-transition
cost in `distance.ts`. It is never declared in the tables.

## P2 — Data perturbation

The permitted operators are DECLARED per chart type in `curated.ts`, by
operator id, in preference order. An id names one MESSAGE ATTACK, not one
mechanic: several mechanics can share an id — one per data type
(categorical, bivariate, distributional, signed) — and the chart's data
type selects which one runs. The answer file keeps the mechanic in the
lure's label.

| Dimension | Question probed | Operator ids and their per-data-type mechanics |
|---|---|---|
| **Direction** | Which way did it go? | `reverse` — categorical: the values move to the labels in the opposite order; bivariate: the y ranks flip; distributional: the skew mirrors; signed deltas: every value changes its sign (this mechanic wins when the signs are mixed). `exchange` — two series trade all their values (needs 2+ series on one scale). |
| **Location** | Where was the peak or the leader? | `move` — categorical: a cyclic move along the label axis (~40% of the labels); distributional: every value moves by 30% of the range. `swap` — the top two trade values; implemented, but no v6 table uses it: a swap moves only two values, which is too subtle (review 2026-08-18). |
| **Existence** | Was there a pattern at all? | `shuffle` — categorical: the values mix among the labels; bivariate: y mixes among the points until the relation is gone. `flatten` — all values move to the mean (categorical). |
| **Strength** | How big was the effect? | `shrink` — categorical: deviations × 0.45; bivariate: residuals × 2.2, so the relation loosens; distributional: deviations × 1.8, so the peak widens and weakens. `amplify` — categorical: deviations × 1.7; bivariate: residuals × 0.35, so the relation tightens. |

The factors ×0.45 and ×1.7 come from the v3 tables (their gap-reduce and
gap-exaggerate rows).

Every operator keeps its GATE (refuse before work) and its FLOOR (verify
after work): an operator that did not change the message enough is dropped,
whatever its name says. The sorted-profile rule also stays: a decoy on a
size-sorted axis goes back into the sorted order, so the profile shape does
not give the answer away.

The raw-value mechanics (the distributional rows of `move`, `reverse`,
`shrink`) are new in v5. A Histogram or a Density Plot has no label axis,
so the label mechanics cannot run there; the raw-value mechanics work on
the raw values of the one quantitative field, per series.

## Combined perturbation

A combined lure takes a visual candidate and a data candidate that each
passed their own axis, and pairs them: the visual lure's spec over the data
lure's rows. The pairing must compile and render. Its purity rule is the
inverse of the pure axes: it MUST change both the rows and the drawing.

## The framework tables (reviewed 2026-08-18)

These tables mirror `curated.ts`, which is the source of truth. Each visual
list is in preference order (nearest first). Each data list is in operator
preference order; the selector takes two, on two different dimensions where
possible. "Review:" names what the review changed against v5.

### Points

| Chart type | Visual targets | Data operators | Notes from the review |
|---|---|---|---|
| Scatter Plot | Heatmap (binned) | reverse, shuffle, shrink, amplify | Scatter ↔ Regression does not count (too close); Strip Plot reads the same as a scatter. A binned Histogram is admitted by design — deferred (same-fields exemption). |
| Regression | Heatmap (binned) | the same as Scatter Plot | the same |
| Ranged Dot Plot | Grouped Bar Chart, Stacked Bar Chart, Strip Plot, Scatter Plot | exchange, shuffle, shrink | Stacked Bar and Strip/Scatter added; Lollipop dropped. Rank swap replaced by shuffle: a swap moves only two values. |
| Strip Plot | Boxplot | shuffle, reverse | Scatter dropped (reads the same); the category swap dropped. |

### Bars

| Chart type | Visual targets | Data operators | Notes from the review |
|---|---|---|---|
| Bar Chart | Lollipop Chart, Bar Table, Pie Chart | reverse, flatten | Heatmap dropped; rank swap and the gap-scaling pair dropped. Line / Area stay banned: a nominal axis shows a trend that is not real. |
| Lollipop Chart | Bar Chart, Bar Table, Pie Chart | the same as Bar Chart | the same |
| Bar Table | Bar Chart, Lollipop Chart, Pie Chart | the same as Bar Chart | the same |
| Grouped Bar Chart | Stacked Bar Chart, Line Chart (ordered x), Scatter Plot | exchange, shrink, flatten | Heatmap dropped; the one-group leader swap dropped. Scatter added (2026-08-19): points per category stay honest on a nominal x, where the line is refused. |
| Stacked Bar Chart | Grouped Bar Chart, Line Chart + series (ordered x), Scatter Plot | exchange, reverse, flatten | Streamgraph and stacked Area dropped; the multi-line added. Scatter added (2026-08-19), same reason as Grouped Bar. |
| Waterfall Chart | Bar Chart (the same signed deltas) | move, reverse | The sign flip added; swap and shrink dropped. A running-sum Line is admitted by design — deferred (needs a derive). |

### Distributions

| Chart type | Visual targets | Data operators | Notes from the review |
|---|---|---|---|
| Histogram | Density Plot, Strip Plot, Boxplot | move, reverse, shrink | Unchanged. |
| Density Plot | Histogram, Strip Plot, Boxplot | the same as Histogram | Unchanged. |
| Boxplot | Strip Plot, Density Plot (grouped, ≤ 6 categories) | reverse, shuffle | Grouped Density added; the top-median swap dropped. |
| Pyramid Chart | Grouped Bar Chart, Line Chart (the two side profiles) | exchange, move, shrink | The side-profile lines added. |
| Candlestick Chart | none shipped | none shipped | The review ADMITS: a close-only Line (and possibly Ranged Dot of high–low, or a Waterfall of the moves), open/close reversal, big-day rotation. All need machinery — see "Deferred machinery". Until then the type is skipped. |

### Lines & Areas

| Chart type | Visual targets | Data operators | Notes from the review |
|---|---|---|---|
| Line Chart | Area Chart, Bar Chart, Scatter Plot (points) | reverse, move, shrink, amplify | Bump dropped as a target; detrend (flatten) dropped. Pie / Rose stay banned: they destroy the ordered axis. |
| Area Chart | Line Chart, Bar Chart, Scatter Plot (points) | the same as Line Chart | Streamgraph dropped. |
| Bump Chart | Line Chart (values) | reverse, move, shuffle | Unchanged. |
| Streamgraph | Area Chart, Stacked Bar Chart, Line Chart + series | exchange, move, shrink, flatten | The unstacked multi-line added. |

### Circular

| Chart type | Visual targets | Data operators | Notes from the review |
|---|---|---|---|
| Pie Chart | Rose Chart, Bar Chart | reverse, flatten | The dominant-share swap and the majority flip dropped. |
| Rose Chart | Pie Chart, Bar Chart | reverse, flatten | The rotation dropped. |
| Radar Chart | Rose Chart, Bar Chart | reverse, flatten | The spike swap and the flatten dropped. |

### Tables & Maps

| Chart type | Visual targets | Data operators | Notes from the review |
|---|---|---|---|
| Heatmap | Grouped Bar Chart, Scatter Plot (size), Stacked Bar Chart | reverse, shrink, shuffle | Stacked Bar added; the hotspot swap dropped from the data axis. |
| US Map | Bar Chart (regions as categories) | shuffle, reverse, flatten | The basemap swap dropped — a wrong basemap is implausible on sight. Rank swap replaced by shuffle: a swap moves only two values, and a shuffle moves the hotspot with the whole pattern. |
| World Map | the same as US Map | the same as US Map | the same |
| KPI Card | none | none — one collapsed number has no look-alike space | — |

## Deferred machinery

The review admitted these lures by design. The code cannot build them yet,
so they are NOT in `curated.ts`. Each names the machinery it waits for.

1. **Scatter / Regression → binned Histogram.** The target shows one of the
   two measures, so the same-fields rule needs a per-pair exemption, and
   the purity check needs the "declared derivation" extension (the rows of
   the lure are a recorded deterministic transform of the originals).
2. **Waterfall → Line of the running-sum levels.** Needs a cumulative
   derive of the delta column, under the same declared-derivation rule.
3. **Candlestick → close-only Line** (and possibly Ranged Dot of high–low,
   or a Waterfall of close-to-close moves). Needs the same-fields
   exemption; the roles resolver must also learn the open/high/low/close
   channels before any data operator can run on this type.
4. **Candlestick data operators: open/close reversal, big-day rotation.**
   The reversal is a per-row swap of two fields (consistency holds by
   construction); the rotation must rebuild the chain across periods.

## Selection

`select.ts` assembles each item:

1. Render the original. Every later option must differ from every accepted
   option by render hash, and must not draw `NaN` / `undefined`.
2. Walk the curated visual candidates; keep up to 2 that render. The
   stripped-picture compare also runs here, so two targets that draw the
   same marks under different titles cannot both appear.
3. Walk the curated data candidates; keep up to 2 that render, on two
   different dimensions where possible, with the same-story dedupe.
4. Fill the cross cells with combined lures. Try the largest rectangle
   first (2×2 of lures); when a cell fails, shrink toward one lure per
   axis. When no cell can be made, skip the chart.
5. `verifyQuizItems` asserts the invariants at runtime: a full rectangle,
   the correct answer at (0,0), each cell's method and payload matched to
   its coordinates, no two options that render identically.

## Implementation map

| Concern | File |
|---|---|
| The per-chart tables (this document's source of truth) | `curated.ts` |
| Candidate generation, combined pairing, purity | `generators.ts` |
| Message operators, gates, floors, signatures | `messageOps.ts` |
| Matrix assembly, scoring, invariants | `select.ts` |
| Render guard (hash, strip, degenerate text) | `guard.ts` |
| Distances (bands are computed here) | `distance.ts` |

## Change log

- **v3 (2026-08-12).** Per-chart tables for form and content. Never fully
  implemented.
- **v4 (2026-08-16).** Derived visual roster; visual axis without a quota;
  transpose and recolor removed. The data axis kept generic operators.
- **v5 (2026-08-17).** The v3 tables return, on the v4 machinery. The item
  becomes an option matrix with combined lures. `amplify` moves to ×1.7
  (the v3 value). The raw-value operators give Histogram / Density Plot a
  data axis. Transpose and recolor stay removed.
- **v6 (2026-08-18).** The tables reviewed with the researcher, one chart
  type at a time. Most lists become shorter; near-duplicate retargets
  (Scatter ↔ Regression, Strip ↔ Scatter) no longer count. The sign flip
  added for signed deltas. Candlestick admitted by design but deferred. The
  basemap swap for maps dropped in favor of a regions bar chart. Later the
  same day: `swap` removed from the last three tables (Ranged Dot,
  US/World Map) — a swap moves only two values, which is too subtle;
  shuffle takes its place, so those tables probe direction + existence.
- **Operator rename (2026-08-19).** An id now names one MESSAGE ATTACK; the
  chart's data type selects the mechanic, and the lure's label still names
  it. Eight ids remain: reverse, exchange, move, swap, shuffle, flatten,
  shrink, amplify. Old → new: reassign-reverse, antitone, negate and
  dist-mirror → reverse; series-exchange → exchange; reassign-rotate and
  dist-shift → move; reassign-swap → swap; decorrelate → shuffle;
  equalize → flatten; attenuate, attenuate-relation and dist-widen →
  shrink; polarize and polarize-relation → amplify. The behavior of each
  mechanic did not change. Answer files and moderator pins made before
  this date use the old ids; with those files, chart type + old id gives
  the mechanic directly.
