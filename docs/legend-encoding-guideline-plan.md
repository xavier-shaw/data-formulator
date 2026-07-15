# Plan: Refining the Encoding Guideline for Legend Channels

**Approach: prompt refinement.** This plan refines the *generation prompts* so
the analyst stops producing low-value legends — starting with *redundant
encoding* (the same field mapped to both `color` and `size`, as in the "Total
Health Spending" map), and broadening to the full set of legend failure modes. A
code-level guard is deliberately **out of scope for now** (see §7).

**Scope note — the rule already exists.** The guideline already says, almost
verbatim, *"Never map the same field to two channels (e.g. the same quantity on
`color` and `size`)"* and *"do not use more than one continuous channel beyond the
axes"* — [SKILL.md:250-251](../py-src/data_formulator/analyst/skills/core/SKILL.md).
So this plan is **not** "add an anti-redundancy rule." It is about *why the
existing rule doesn't fire, and how to reword/reposition it so it does.*

---

## 1. What the prompt controls (targets)

The LLM emits `chart.encodings` **verbatim** — it flows from the `visualize`
tool call → `chart_spec` → `refined_goal` unchanged
([agent.py:1045,1099-1104](../py-src/data_formulator/analyst/agent.py)), then
onto a `Chart` via [resolveChartFields](../src/app/chartRecommendation.ts) and
into the `agents-chart` compiler. No template augments channels on this path (the
deterministic backend assigner in
[create_vl_plots.py](../py-src/data_formulator/workflows/create_vl_plots.py)
removes each field from the pool after use, so it *structurally cannot*
duplicate a field). **A redundant `color`+`size` pair can therefore only come
from the LLM emitting it directly — which is exactly what prompt refinement
targets.**

Two generation prompts drive this, and **both must be edited**:

| Path | File | Anti-redundancy rule today? |
|---|---|---|
| Full analyst (`visualize`) — includes maps | [core/SKILL.md](../py-src/data_formulator/analyst/skills/core/SKILL.md) §B | Yes, but buried (lines 250-251) |
| Mini analyst (single-chart) | [mini_agent.py](../py-src/data_formulator/analyst/mini_agent.py) `_MINI_CHART_REFERENCE` | **No rule at all** |

Legend-producing channels are defined in
[types.ts:32](../src/lib/agents-chart/core/types.ts):
`color, group, size, shape, text, opacity, strokeDash`. These are exactly the
channels this plan governs. Legends are otherwise **never reasoned about at
generation time** — the prompt gives zero legend guidance today.

---

## 2. Diagnosis — why the existing rule doesn't fire

1. **Wrong location.** The rule lives at the *end* of a ~15-item "Critical chart
   rules" bullet list, far below the Chart Type Reference table where the model
   actually picks channels. By the time it reads the rule it has already chosen.
2. **It's an unexplained absolute, and the model holds a competing prior.**
   Bubble maps (`size`+`color` on one measure) are a *recognized idiom*; the
   model has seen thousands of them. A blanket "never" with no acknowledged
   exception loses to that prior. Hardening the ban further won't help — it's
   already absolute and already overridden.
3. **The reference table invites it.** The table lists channels flat — `World
   Map | longitude, latitude, color, size` — with no signal that `color`/`size`
   are *optional legend channels that must each carry a distinct variable*. The
   model reads "these are the channels" and fills them.
4. **The second path (mini_agent) has no rule at all.**

---

## 3. The legend failure modes (broaden past the one example)

The screenshot shows **two** defects, and there are more worth pre-empting:

| # | Failure mode | In the screenshot? | Fixable by prompt? |
|---|---|---|---|
| a | **Redundant encoding** — same field on two legend channels (`color`=`size`=Total Health Spending) | ✅ | ✅ Yes — primary target |
| b | **Dual continuous scales** — two *independent* quantitative legend channels, forcing the reader to track two magnitude scales | — | ✅ Yes |
| c | **Unformatted magnitudes** — legend shows `1,000,000,000` not `$1B` | ✅ | ⚠️ Partly — prompt can fix the *semantic-type annotation*; size-legend format inheritance is compiler-side (§7) |
| d | **Over-cardinality categorical legend** — `color` with 30+ entries | — | ✅ Yes |
| e | **Legend that restates an axis** — a legend channel duplicating `x`/`y`; or a single-series legend | — | ✅ Yes |

Redundancy (a) is the headline; the plan keeps it central but addresses the class.

---

## 4. The plan — two prompt moves

### Move 1 — Relocate and proceduralize the guidance *at the point of choice*

Move legend guidance from the trailing bullet list to sit **with** the encoding
table in [SKILL.md §B](../py-src/data_formulator/analyst/skills/core/SKILL.md):

- **Annotate the reference table.** Mark legend-producing channels and their
  *intended distinct role* inline, e.g.
  `World Map | longitude, latitude, [color: a 2nd measure], [size: a 3rd measure]`
  — signalling they are optional and must each carry a *different* variable.
- **Add a compact "Legend channels — earn their place" subsection immediately
  after the table** (not 15 bullets later), containing the decision procedure of
  Move 2.
- **Add one pre-emit self-check line** to the `visualize` action description:
  *"Before emitting: no field appears on two channels; every `color`/`size`/
  `shape`/`opacity` channel encodes a variable not already on `x`/`y`."*

### Move 2 — A decision procedure with **named exceptions** (not a hardened ban)

Replace the absolute prohibition with a positive test keyed to *legend noise*,
and name the legitimate idioms so the model's prior is satisfied *within bounds*.
Draft text for the new subsection:

> **Legend channels — earn their place.** Each of `color`, `size`, `shape`,
> `opacity` adds a legend. Before using one, ask: *does it encode a variable not
> already shown?*
> - Repeats a field already on another channel → **drop it.** A field earns at
>   most one channel.
> - Two channels would each carry a *different continuous* measure → keep at most
>   one; move the extra to `facet` or a separate chart.
> - A categorical `color` with more than ~10–12 values → the legend is unreadable;
>   filter, bin, or facet instead.
> - **Sanctioned redundancy (do use):** (i) on maps, put a single measure on
>   `color` **OR** `size`, never both; (ii) `color`+`shape` on the *same
>   categorical* field, allowed *only* as an accessibility aid.

Naming the exact tempting case (the map) gives the model a rule it follows
*because it agrees with it*, rather than one it overrides.

### Apply to both paths

- **[mini_agent.py](../py-src/data_formulator/analyst/mini_agent.py)** — add one
  line to `_MINI_CHART_REFERENCE` (currently has no rule), e.g. *"One field per
  channel — never put the same measure on both `color` and `size`; leave a
  channel empty rather than echoing `x`/`y`."*

---

## 5. Concrete prompt edits (implementation-ready)

1. **[SKILL.md §B](../py-src/data_formulator/analyst/skills/core/SKILL.md)** —
   (i) annotate the Chart Type Reference table's legend channels; (ii) insert the
   "Legend channels — earn their place" subsection (draft text in §4) right after
   the table; (iii) add the pre-emit self-check line to the `visualize`
   description; (iv) *remove or shorten* the now-superseded lines 250-251 so the
   guidance isn't duplicated in two voices.
2. **[mini_agent.py](../py-src/data_formulator/analyst/mini_agent.py)** — add the
   one-line legend rule to `_MINI_CHART_REFERENCE`.
3. **Legend formatting (mode c), prompt part only** — strengthen §C so the
   measure driving a legend is annotated `Amount`/`Price` (→ `$,.0f`). The
   size-legend format-inheritance fix is compiler-side; see §7.

---

## 6. Validation

- **Repro set.** `health_spending_reduced.csv` is bundled and reproduces the map.
  Assemble a small set of prompts+datasets that historically triggered redundant
  / overloaded / unformatted legends.
- **Metrics, before vs. after the prompt edits:** redundant-encoding rate; count
  of legend channels per chart; categorical-legend cardinality. Run the same set
  through **both** the analyst and mini paths.
- **Live-confirm once:** run the health-spending prompt and inspect the emitted
  `encodings` to verify the LLM literally emits `{color: X, size: X}` (the static
  trace says it must; one live check removes all doubt) — and that the edited
  prompt stops it.

---

## 7. Out of scope for now (future defense-in-depth)

Deferred, not rejected — prompt refinement lowers frequency but can't guarantee
zero. When wanted later:

- **Deterministic guard** at the `agents-chart` assemble step (using the existing
  `ChartWarning` mechanism) that detects a field on ≥2 legend channels and
  warns/drops it, whitelisting the map bubble-idiom. Path-independent — catches
  whatever any prompt misses.
- **Size-legend format inheritance** so `Amount`-typed measures render `$1B` in a
  *size* legend, not `1,000,000,000` (mode c's compiler half).

---

## 8. Sequencing & risks

- **Order:** SKILL.md edits → mini_agent edit → semantic-type wording. All are
  reversible prompt changes; ship together and measure with §6.
- **Don't over-suppress.** The risk is instructing the model to strip *legitimate*
  legends. Move 2 sanctions the map and accessibility cases explicitly and frames
  the guidance as "earn its place," not "avoid legends."
- **Study timing.** This is the `study` branch mid–user-study. Changing generation
  guidance alters chart output and could affect study validity — decide whether to
  land now, gate behind a flag, or hold until after the study.
