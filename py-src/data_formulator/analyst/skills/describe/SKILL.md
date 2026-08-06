---
name: describe
description: >-
  Attach a one-sentence caption to a chart created this run. The caption is
  shown beneath the chart and becomes the pre-filled, editable takeaway text
  when the user adds that chart to their findings report.
when_to_use: >-
  Auto-loaded in the study chat modes (executor / analyst_guided); never
  loaded manually.
actions:
  - describe_chart
---

# Chart captions

`describe_chart(chart_id, description)` attaches a short caption to a chart
you created this run.

- `chart_id` — the id reported in the chart's visualize observation (the
  "**Chart id**" line).
- `description` — the caption text. Your mode instructions define exactly what
  kind of content belongs in it; follow them precisely.

Caption a chart **after** reading its visualize observation, so the caption
states what the result data actually showed rather than what you expected.
One caption per chart; calling the action again for the same chart replaces
the earlier caption.
