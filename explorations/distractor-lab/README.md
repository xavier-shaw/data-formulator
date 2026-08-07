# Distractor Lab — chart-recognition quiz exploration

Generates "which chart did you actually see?" distractors for every chart in a
Data Formulator study session, compares five generation strategies, and scores
each lure on two orthogonal distance axes for the misrecall analysis.

Part of the `study-quiz` branch exploration. See `docs/quiz-module-plan.md` for
the surrounding quiz-module plan.

## Pipeline

```
state.json ──▶ main.ts ──▶ out/specs/*.vl.json ──▶ vl2svg ──▶ out/svg/*.svg
 (session)     (extract +      (compiled via            (headless render)
                generate +      assembleVegaLite,
                score)          the app's own pipeline)
                                        │
                                        ▼
                     build_gallery.mjs ──▶ distractor-gallery.html
```

Run:

```bash
# 1. bundle + generate specs & manifest
node_modules/.bin/esbuild explorations/distractor-lab/main.ts --bundle \
  --platform=node --format=cjs --outfile=/tmp/distractor-lab.cjs
node /tmp/distractor-lab.cjs \
  "py-src/data_formulator/example_analysis/Nic- FAA Wildlife Strikes/state.json" out

# 2. render all specs (parallel)
cd out && mkdir -p svg && ls specs/*.vl.json | sed 's|specs/||; s|\.vl\.json||' | \
  xargs -P 8 -I {} <repo>/node_modules/.bin/vl2svg specs/{}.vl.json svg/{}.svg

# 3. build the gallery
node explorations/distractor-lab/build_gallery.mjs out distractor-gallery.html
```

## Generation methods

| Method | Idea | Distance profile |
|---|---|---|
| `enumeration` | CompassQL-style sweep of plausible charts over the same table, seeded by Flint's `vlRecommendEncodings` | spec > 0, data = 0 |
| `graphscape` | Atomic edits (sort flip, transpose, mark change, field replace) composed into near/mid/far bands | spec 0.5–5+, data = 0 |
| `data-perturb` | Same spec, perturbed values: rank swap, inversion, flatten/exaggerate, peak shift, label substitution | spec = 0, data > 0 |
| `sibling-measure` | Swap the measure for a REAL unplotted column of the same derived table | spec ≈ 2, data = 0 |
| `session-hybrid` | This chart's form × another session chart's content (shared measure/dimension) | both > 0 |

## Distances

- **Spec distance** — GraphScape-inspired edit cost recovered by *diffing* any
  lure against the original (`distance.ts`), so all methods are comparable.
  Cost ordering follows Kim et al. CHI 2017; absolute weights are ours.
- **Data distance** — max(rank disagreement, normalized RMSE, label turnover)
  of plotted values, in [0, 1].

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

- Session-hybrid lures between two *versions* of the same analysis are flagged
  (`caveat`) — the participant saw both, so they only work as "which was your
  final version?" items.
- An LLM QuizGenAgent could author additional semantically-plausible lures as
  Flint specs; `sibling-measure` + `session-hybrid` are its deterministic core.
- Perturbation magnitudes (×0.45, ×1.7, 25% shift) are uncalibrated — pilot
  data should set them so near lures sit at threshold.
