# Quiz distractor framework: message-anchored lures

Status: design (2026-08-12). This document governs `src/lib/quiz-distractors/`.
It replaces the flat `NEAR_MARKS` / `MID_MARKS` / `FAR_MARKS` lists in
`generators.ts`. It also replaces the perturbation list that ignores the chart
type.

Written in ASD-STE100 Simplified Technical English.

## Problem

The current generator applies the same mark targets to all charts. It also
applies the same five perturbations to all charts. This causes bad lures.

Example 1: a bar chart with nominal categories becomes a line chart. The line
chart shows a trend that is not in the data.

Example 2: a time series becomes a pie chart. The pie chart removes the order
of the points.

A participant rejects these lures because they are not plausible. The
participant does not use memory. The quiz item measures nothing.

## Core concept: the message statistic

Each chart type shows one primary takeaway. We call this the **message
statistic**.

| Chart family | Message statistic |
|---|---|
| Bar / Lollipop / Bar Table | The ranking and the gap sizes |
| Grouped Bar | The interaction between two factors |
| Stacked Bar | The composition of each category and the total ranking |
| Line / Area | The trend shape: direction, peaks, slope, endpoints |
| Scatter | The association: sign, strength, outliers |
| Pie / Rose | The dominant share and the majority boundary |
| Heatmap | The hotspot location and the gradient direction |
| Histogram / Density / Boxplot | The distribution shape: modes, skew, center, spread |

We define the two lure axes with this statistic. The two axes point in
opposite directions.

## Chart type characterization

This table covers the full Data Formulator roster, in its six template
categories. The data type names the fields that the chart requires. The
message statistic is the takeaway that the encoding shows. A content
perturbation must change this statistic. A form swap must keep it.

### Points

| Chart type | Data type | Meaning / goal (message statistic) |
|---|---|---|
| Scatter Plot | Two quantitative fields (x, y) + one optional nominal field (color) + one optional quantitative field (size) | Show the relation between two measures. Message = the association: its sign, its strength, its clusters, and its outliers. |
| Regression | Two quantitative fields + a fitted line | Show the same relation, with the trend made explicit. Message = the direction and the strength of the linear relation. |
| Ranged Dot Plot | One nominal field (category) + one quantitative field measured at two conditions (dumbbell: line + two points) | Compare two conditions in each category. Message = the gap between the two points, and its direction, per category. |
| Strip Plot | One nominal field (category) + one quantitative field (each row = one mark, jittered) | Show each individual value in each category. Message = the density and the outliers, with no aggregation. |

### Bars

| Chart type | Data type | Meaning / goal (message statistic) |
|---|---|---|
| Bar Chart | One nominal field + one quantitative field | Compare magnitudes across categories. Message = the ranking and the gap sizes. |
| Grouped Bar Chart | Two nominal fields (x, group) + one quantitative field | Compare a measure across two factors, side by side. Message = the interaction: does the same series lead in each group? |
| Stacked Bar Chart | Two nominal fields (x, color) + one quantitative field. Gate: the sum has meaning. | Show the parts and the totals together. Message = the composition of each bar and the ranking of the totals. |
| Lollipop Chart | One nominal field + one quantitative field | The same as Bar Chart, with less ink. Message = the ranking and the gap sizes. |
| Waterfall Chart | One ordered field (sequence) + one quantitative field (signed deltas) | Show how sequential gains and losses build a total. Message = the running sum: which steps add, which steps remove, and the end level. |

### Distributions

| Chart type | Data type | Meaning / goal (message statistic) |
|---|---|---|
| Histogram | One quantitative field (binned; y = count) | Show the shape of one distribution. Message = the modes, the skew, the center, and the spread. |
| Density Plot | One quantitative field + one optional nominal field (color, for overlaid groups) | Show the same shape, smooth. With groups: compare distributions. Message = the shape, and the offset between group shapes. |
| Boxplot | One nominal field + one quantitative field | Compare distribution summaries across categories. Message = the medians, the spreads, and the outliers, per category. |
| Pyramid Chart | One ordered field (ordered bins, e.g. age) + one quantitative field, split by a binary nominal field (the two sides) | Compare two populations mirror-wise. Message = the asymmetry between the two sides, and the bulges. |
| Candlestick Chart | One ordered field (period) + four quantitative fields (open, high, low, close) | Show the movement inside each period. Message = the direction (up or down) and the range, per period, and the run across periods. |

### Lines & Areas

| Chart type | Data type | Meaning / goal (message statistic) |
|---|---|---|
| Line Chart | One ordered field + one quantitative field + one optional nominal field (color, series) | Show change across an ordered axis. Message = the trend shape: direction, peaks, slope, endpoints — and where series cross. |
| Bump Chart | One ordered field + one nominal field (series); y = rank, not value | Show the rank order across time. Message = who is above whom, and where they overtake. The values are gone; only the order stays. |
| Area Chart | One ordered field + one quantitative field ≥ 0. Gate: a zero baseline has meaning. | Show the trend and the accumulated magnitude. Message = the trend shape and the level. |
| Streamgraph | One ordered field + one nominal field (series) + one quantitative field ≥ 0 | Show how the total and its composition change together. Message = the width of the whole flow, and the growth or decay of each band. |

### Circular

| Chart type | Data type | Meaning / goal (message statistic) |
|---|---|---|
| Pie Chart | One nominal field (color) + one quantitative field (size = angle). Gate: the sum has meaning; values ≥ 0. | Show the part-to-whole. Message = the dominant share and the majority boundary (is one slice more than half?). |
| Rose Chart | One nominal field (often cyclic, e.g. months) + one quantitative field (radius) | Compare magnitudes around a cycle. Message = which sector is largest, and the cyclic pattern. |
| Radar Chart | One nominal field (the axes = dimensions) + one quantitative field + one optional nominal field (color, series) | Show the profile of one or more items across many dimensions. Message = the shape of the profile: balance against spikes, and the overlap between items. |

### Tables & Maps

| Chart type | Data type | Meaning / goal (message statistic) |
|---|---|---|
| Heatmap | Two nominal or ordered fields (x, y) + one quantitative field (color) | Show a pattern across a grid. Message = the hotspot locations and the gradient direction. |
| Bar Table | One nominal field (label column) + one quantitative field (bar column) | Look up and compare exact values. Message = the ranking, with each value readable. |
| US Map / World Map | Geographic position (longitude, latitude or region) + one quantitative field (color or size) | Show where the values sit. Message = the spatial pattern: which regions are high, which are low, and the clusters. |

## The two principles

**P1 — Form (mark swap): change the encoding. Do not change the message.**

A mark target is permitted only if:
- (a) It accepts the same field roles.
- (b) It shows the same message statistic.

The lure must be a chart that the participant could make for the same
question. Form lures test verbatim memory. Verbatim memory is memory of how
the chart was drawn.

**P2 — Content (data perturbation): change the message. Do not change the
encoding.**

A perturbation is permitted only if:
- (a) It changes the message statistic.
- (b) The result stays in distribution: same rows, same fields, plausible
  values.

A perturbation that keeps the message statistic is not detectable. It is not
permitted. Content lures test gist memory. Gist memory is memory of what the
data said.

These principles sit on top of the purity contract. The purity contract does
not change: a form edit does not touch the rows, and a content edit does not
touch the encoding.

## Derived difficulty

We do not declare difficulty. We compute it.

- **Form distance** = the number of steps on the Cleveland–McGill channel
  ranking: position → length → angle → area → color. The same channel is near
  (Bar → Lollipop). One step across is far (Bar → Pie: length → angle). The
  last channel is farthest (Bar → Heatmap: length → color).
- **Content distance** = the scope of the message change. A magnitude change
  (gap sizes) is smallest. A local identity change (one rank swap) is larger.
  A global pattern change (full inversion) is largest.

## The framework table

Each row is one transformation. A gate is a hard condition. The generator
tests the gate before it offers the edit. The generator never makes a
transformation that is not permitted.

### Bar Chart (family: Lollipop, Bar Table)

Goal: compare magnitudes across categories. Message = the ranking and the gap
sizes.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | → Lollipop | The same position channel. The nearest form lure. It tests only mark-shape memory. (near) | — |
| Form | → Bar Table | The same values as labeled bars. It tests layout memory. (near) | — |
| Form | → Pie | The length channel becomes the angle channel. (far) | Values ≥ 0. The sum has meaning. ≤ ~8 categories. |
| Form | → Heatmap strip | The length channel becomes the color channel. (farthest) | The message is a comparison, not exact values. |
| Form | ✗ → Line / Area | Not permitted. A nominal category axis shows a trend that is not real. | — |
| Content | Rank swap (1↔2 / 1↔3) | It changes which item leads. This is a local identity change. | ≥ 2 categories |
| Content | Rank inversion | It mirrors all values. It reverses the global pattern. The strongest gist probe. | — |
| Content | Gap flatten (×0.45) | The ranking stays. The effect becomes weaker. It tests magnitude memory. | — |
| Content | Gap exaggerate (×1.7) | The ranking stays. The effect becomes stronger. It tests magnitude memory. | — |
| Content | ✗ Jitter that keeps the ranks | Not permitted. It does not change the message. | — |

### Grouped Bar Chart

Goal: compare a measure across two factors. Message = the interaction.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | → Stacked Bar | The same fields. The emphasis moves from comparison to composition. (near) | The sum has meaning. |
| Form | → Line + color series | The groups become series. The position channel stays. (mid) | The x axis is ordinal or temporal. |
| Form | → Heatmap | A category × category grid. The value becomes color. (far) | Many groups. |
| Content | Leader swap in one group | The winner of one group changes. This is a local interaction change. | — |
| Content | Effect inversion | "A > B in each group" becomes "B > A in each group". A global change. | A constant effect exists. |
| Content | Flatten between groups | The groups become almost equal. It tests magnitude memory. | — |

### Stacked Bar Chart

Goal: show the part-to-whole of each category and the totals. Message = the
composition and the total ranking.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | → Grouped Bar | It unstacks the bars. Composition becomes comparison. (near) | — |
| Form | → Streamgraph / Area | The same composition across time. (mid) | The x axis is temporal. |
| Content | Move the shares, keep the totals | The bar heights stay. The segments change. It tests composition memory. | — |
| Content | Change the totals, keep the shares | The profile stays. The heights change. It tests magnitude memory. | — |
| Content | Dominant-segment swap | The largest segment of a bar changes owner. | — |

### Line Chart

Goal: show change across an ordered axis. Message = the trend shape.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | → Area | The same position channels, with fill. (near) | A zero baseline has meaning. |
| Form | → Bar on the same axis | Continuous position becomes discrete position. (mid) | — |
| Form | → Scatter (points only) | It removes the line. It removes the emphasis on continuity. (mid) | — |
| Form | → Bump Chart | The value becomes a rank. (far) | More than one series. The message is rank across time. |
| Form | ✗ → Pie / Rose | Not permitted. It destroys the ordered axis. | — |
| Content | Trend inversion (mirror) | A rise becomes a fall. A global pattern change. | — |
| Content | Peak shift (rotate ~25%) | The shape stays. It moves along x. It tests peak-location memory. | — |
| Content | Slope flatten / exaggerate | The direction stays. The steepness changes. It tests magnitude memory. | — |
| Content | Truncation | The series stops early. It tests endpoint memory. | ≥ 8 points |
| Content | Crossing swap | It changes which series overtakes, and when. | More than one series. The series cross. |

### Area Chart

Goal: show the trend and the accumulated magnitude. Message = the trend shape
and the level.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | → Line | It removes the fill. The reverse near pair. (near) | — |
| Form | → Streamgraph | The same fill, with a baseline that moves. (mid) | More than one series. |
| Content | (all Line Chart operators) | The message statistic is the same. | The same gates. |
| Content | Baseline shift | The shape stays. The level changes. It tests magnitude memory. | — |

### Scatter Plot

Goal: show the relation between two quantitative fields. Message = the
association.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | → Regression | The same marks, with a fitted line. It makes the message explicit. (near) | — |
| Form | → Heatmap (binned) | The position pair becomes color density. (far) | Sufficient points to bin. |
| Form | ✗ → Bar / Line | Not permitted. It requires aggregation. Aggregation is a content change. | — |
| Content | Sign flip | It reflects y in its range. A positive association becomes negative. | A visible association exists. |
| Content | Attenuation | It moves y toward the trend line. A strong association becomes weak. | — |
| Content | Move or remove an outlier | The point that the participant remembers moves, or is gone. | An outlier exists. |

### Pie Chart / Rose Chart

Goal: show the part-to-whole. Message = the dominant share and the majority
boundary.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | Rose ↔ Pie | Angle becomes radius. The same radial family. (near) | — |
| Form | → Bar Chart | Angle becomes position. The classic Cleveland–McGill contrast. (far) | — |
| Form | ✗ → Line / Area | Not permitted. There is no order to plot. | — |
| Content | Dominant-share swap | The largest slice and the second slice trade sizes. | ≥ 2 slices |
| Content | Majority flip | A slice above 50% goes below 50%. It crosses a category boundary in memory. | A majority slice exists. |
| Content | Equalization | The shares become almost equal. "Was one slice dominant?" | — |

### Heatmap

Goal: show a pattern across two dimensions with color. Message = the hotspot
location and the gradient direction.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | → Grouped Bar | Color becomes position. (far) | A grid of moderate size. |
| Form | → Scatter with size | Color becomes area. (mid) | A sparse grid. |
| Content | Hotspot relocation | The hot region moves. It tests location memory. | — |
| Content | Gradient inversion | Hot and cold trade places. A global change. | — |
| Content | Contrast flatten | The pattern stays. The contrast becomes weaker. It tests magnitude memory. | — |

### Histogram / Density / Boxplot

Goal: show the distribution shape. Message = the modes, the skew, the center,
and the spread.

| Axis | Transformation | Why | Gate |
|---|---|---|---|
| Form | Histogram ↔ Density | The same shape: binned against smooth. (near) | — |
| Form | → Strip Plot | The aggregate becomes individual marks. (mid) | — |
| Form | → Boxplot | The shape becomes a five-number summary. A large abstraction. (far) | — |
| Content | Skew mirror | A left skew becomes a right skew. A shape change. | A visible skew exists. |
| Content | Mode shift | The peak moves along x. It tests location memory. | — |
| Content | Spread change | The center stays. The spread becomes wider or narrower. | — |

## Implementation notes

1. Replace `NEAR_MARKS` / `MID_MARKS` / `FAR_MARKS` with a table of permitted
   targets for each chart type. Each target has a gate. Keep the compile probe
   as a backstop. Do not use the compile probe to select targets.
2. Select the content operators with the message statistic of the chart type.
   Keep the current operators where they apply. Add the new operators: sign
   flip (scatter), share reallocation (stacked), majority flip (pie), hotspot
   relocation (heatmap). Do not offer an operator that does not change the
   message of that chart type.
3. Compute the difficulty bands from the two distance definitions. Do not
   declare the bands in a list. Record the band on each candidate for the
   study analysis.
4. Do not change the purity contract in `enforcePurity`. It sits below this
   framework.
