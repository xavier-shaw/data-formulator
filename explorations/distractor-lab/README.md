# Distractor Lab — chart-recognition quiz exploration

Generates "which chart did you actually see?" distractors for every chart in a
Data Formulator study session, compares five generation strategies, and scores
each lure on two orthogonal distance axes for the misrecall analysis.

Part of the `study-quiz` branch exploration. See `docs/quiz-module-plan.md` for
the surrounding quiz-module plan.

## Pipeline

```
state.json ─▶ extract ─▶ generate ─▶ score ─▶ compile ─▶ render ─▶ GUARD ─▶ manifest
 (session)                                   (Flint)    (vl2svg)    │
                                                                    ├─▶ build_gallery.mjs ─▶ gallery.html
                                                                    └─▶ build_quiz.mjs    ─▶ quiz.html
```

Two artifacts read the same manifest + rendered SVGs:

- **`build_gallery.mjs`** — a comparison gallery: every method side by side per
  chart, with distances and the distance explainer. For inspecting the methods.
- **`build_quiz.mjs`** — a playable quiz: one question per chart, four options
  (the real chart + the 3 hardest look-alikes), records right/wrong, shows a
  score + misrecall distances, and downloads answers as JSON. Charts are picked
  by **focus time** (`state.chartUsage.focusMs`) — the ones the participant
  looked at longest — and only "fair" charts are used: a chart is skipped if the
  correct answer would be the only one of its chart family (e.g. a map among bar
  charts), because that is a giveaway, not a memory test. Usage:
  `node build_quiz.mjs <outDir> <quiz.html> [topN=12]`.

## The guard (why rendering is part of the build)

A lure that renders **identically to the original is a broken quiz item** — the
participant is shown two correct answers. This is not hypothetical: the first
version of this exploration shipped 17 such lures, and a gallery that had been
"verified" by screenshot didn't reveal any of them.

Spec-level identity is **not sufficient** to catch this class: `Bar Chart` and
`Stacked Bar Chart` with no color channel are different chart types, different
specs, identical renders. So every candidate is rendered and hashed, and the
build **exits non-zero** if anything degenerate survives.

| Reason | What it catches |
|---|---|
| `identical-to-original` | edits with no effect — perturbing an all-zero measure, a mark swap the compiler collapses back, a sort the renderer ignores |
| `degenerate-render` | chart draws `NaN`/`undefined` labels — visibly broken, so a participant eliminates it on sight and accuracy is inflated |

**Lures that duplicate each other are kept deliberately.** This gallery exists
to compare what each method can reach, so suppressing a chart because another
method produced it first would misrepresent the second method. Each copy is
cross-linked via `alsoProducedBy`, and the *quiz sampler* de-duplicates by
render hash when it assembles an item — verified over 390 sampled items, all
with 4 options and no repeated option.

`identical-to-original` and `degenerate-render` are **hard failures** — they
mean a broken item slipped through. A chart that yields fewer than 3 visually
distinct lures is **not** a failure: some chart types (maps, some heatmaps) the
generators barely support. Such a chart is marked `quizEligible: false` and the
quiz builder skips it; the gallery still shows whatever lures it has. Only a
totally empty run fails, so the guard can never pass vacuously.

## Reproducibility

Flint's recommender picks at random among equally-good fields
(`core/recommendation.ts` calls `Math.random`). Good variety for the app, wrong
for a study instrument: two runs over the same session produced different lure
sets. `main.ts` therefore seeds `Math.random` for the whole run. Set
`DISTRACTOR_SEED` to sample a different set; the default is fixed, so the same
session always yields the same items.

## Sort semantics (probed against the real compiler)

Every claim here was checked by compiling specs and diffing the output, not by
reading the code:

- `sortOrder` on the **measure** channel is visually inert everywhere. It
  compiles to a sort of a *quantitative* scale, which Vega-Lite renders
  identically. Setting it there was the original no-op bug — it shipped as a
  do-nothing lure on all 13 charts.
- `sortOrder` alone on the **category** channel gives an **alphabetical** order.
- `sortBy` takes a **channel reference** (`'x'`/`'y'`/`'color'`), *not* a field
  name — passing a field name throws inside the assembler. Paired with
  `sortOrder` it emits VL's `"y"` / `"-y"` shorthand, giving a **by-value**
  sort. This is the lure that matters: *was the largest bar at the top or the
  bottom?*
- **`Bar Table` is inert to sort on this session's data** — all four
  combinations above compile byte-identically, because its template derives an
  explicit domain array itself. (A synthetic table *did* respond to `sortBy`,
  so the behavior is data-dependent; the guard resolves it per chart rather
  than the generator assuming either way.)

Sort lures are therefore generated for every chart, and the render-identity
guard drops the ones that turn out inert — which is every Bar Table here.

## Run

From the repo root (main.ts resolves `vl2svg` from the cwd):

```bash
node_modules/.bin/esbuild explorations/distractor-lab/main.ts --bundle \
  --platform=node --format=cjs --outfile=/tmp/distractor-lab.cjs
node /tmp/distractor-lab.cjs \
  "py-src/data_formulator/example_analysis/Nic- FAA Wildlife Strikes/state.json" out
node explorations/distractor-lab/build_gallery.mjs out distractor-gallery.html
```

Rendering happens *inside* `main.ts` because the guard needs the rendered bytes;
the run exits non-zero if any degenerate lure survives.

## Generation methods

Descriptions use ASD-STE100 Simplified Technical English.

| Method | What it does | Distance profile |
|---|---|---|
| `enumeration` | Makes many charts from the same table. Uses each dimension with each measure, in different chart forms. Flint's `vlRecommendEncodings` selects the encodings. | spec > 0, data = 0 |
| `graphscape` | Changes the chart one step at a time. A step is a new sort, a swap of the axes, a different mark, or a different field. Puts the steps together to make small, medium, and large distances. | spec 0.5–5+, data = 0 |
| `data-perturb` | Keeps the form and changes the values. Exchanges two ranks, reverses the pattern, makes the effect smaller or larger, moves the peak, or replaces one label. | spec = 0, data > 0 |
| `sibling-measure` | Puts a real column of the same table on the measure axis. The participant computed the column but did not plot it. | spec ≈ 2, data = 0 |
| `session-hybrid` | Uses the form of this chart with the content of a different chart from the same session. | both > 0 |

## Distances

- **Spec distance** — GraphScape-inspired edit cost recovered by *diffing* any
  lure against the original (`distance.ts`), so all methods are comparable.
  Cost ordering follows Kim et al. CHI 2017; absolute weights are ours.
  Generators may additionally **declare** edits a diff cannot recover.
- **Data distance** — max(rank disagreement, normalized RMSE, label turnover)
  of plotted values, in [0, 1].
- **Order** — Kendall-tau distance of the *displayed* sequence, reported
  separately and deliberately **not** folded into data distance.

### Why order needed special handling

A re-sorted lure changes no values, so `dataDistance` (which keys rows by
category) scores it 0, and a spec diff recovers nothing because the rows are
untouched. Left alone such a lure lands at `(0, 0)` — the coordinate that means
*identical* — so a participant fooled by an order flip would be recorded as
though there were no difference at all, silently deleting those events from the
misrecall measure. Fixes: sort is a **declared** spec edit (0.5, matching
GraphScape's treatment), and `order` is computed from the **compiled spec**,
the only place the displayed sequence is knowable — a Bar Table re-sorts into
an explicit domain array regardless of the order its rows arrive in.

Study analysis this enables: on a miss, the chosen lure's (spec, data) pair is
the misrecall datapoint; the distribution over participants separates *form*
memory from *pattern* memory.

## Files

- `lib.ts` — session extraction + compilation via `src/lib/agents-chart` (Flint)
- `distance.ts` — edit-cost model + data distances
- `generators.ts` — the five methods
- `main.ts` — orchestrator (specs + manifest)
- `build_gallery.mjs` — self-contained HTML gallery (collapsible sections,
  method filters, per-chart quiz preview with miss-distance readout)

## Caveats / next steps

- Gallery: https://claude.ai/code/artifact/a21b8edc-9169-421a-a2c3-3bd5555d5068
- Session-hybrid lures between two *versions* of the same analysis are flagged
  (`caveat`) — the participant saw both, so they only work as "which was your
  final version?" items.
- An LLM QuizGenAgent could author additional semantically-plausible lures as
  Flint specs; `sibling-measure` + `session-hybrid` are its deterministic core.
- Perturbation magnitudes (×0.45, ×1.7, 25% shift) are uncalibrated — pilot
  data should set them so near lures sit at threshold.
