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
                                                                    ▼
                                              build_gallery.mjs ─▶ gallery.html
```

## The guard (why rendering is part of the build)

A lure that renders **pixel-identical to the original is a broken quiz item** —
the participant is shown two correct answers. This is not hypothetical: the
first version of this exploration shipped 17 such lures plus 22 duplicate pairs,
and a gallery that had been "verified" by screenshot didn't reveal any of them.

Spec-level identity is **not sufficient** to catch this class: `Bar Chart` and
`Stacked Bar Chart` with no color channel are different chart types, different
specs, identical renders. So every candidate is rendered and hashed, and the
build **exits non-zero** if anything degenerate survives. Three drop reasons:

| Reason | What it catches |
|---|---|
| `identical-to-original` | degenerate edits — perturbing an all-zero measure, a mark swap the compiler collapses back, a sort the renderer ignores |
| `duplicate-of-kept-lure` | two methods reaching the same chart; first keeps it, the other is recorded as `alsoFoundBy` |
| `degenerate-render` | chart draws `NaN`/`undefined` labels — visibly broken, so a participant eliminates it on sight and accuracy is inflated |

A pass over zero charts proves nothing, so an empty or shrunken run is itself
a failure.

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

| Method | Idea | Distance profile |
|---|---|---|
| `enumeration` | CompassQL-style sweep of plausible charts over the same table, seeded by Flint's `vlRecommendEncodings` | spec > 0, data = 0 |
| `graphscape` | Atomic edits (re-sort, transpose, mark change, field replace) composed into near/mid/far bands | spec 0.5–5+, data = 0 |
| `data-perturb` | Same spec, perturbed values: rank swap, inversion, flatten/exaggerate, peak shift, label substitution | spec = 0, data > 0 |
| `sibling-measure` | Swap the measure for a REAL unplotted column of the same derived table | spec ≈ 2, data = 0 |
| `session-hybrid` | This chart's form × another session chart's content (shared measure/dimension) | both > 0 |

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
