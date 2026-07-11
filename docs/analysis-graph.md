# Analysis Tree — the session as a search tree (Battle & Heer)

The **data thread** is user-centered: a linear, temporal history of what the
user chose to create, for navigation. The **analysis tree** is
analysis-centered: the structure of the exploration itself, built from the same
source state. It is a faithful reproduction of the analysis graphs in Battle &
Heer 2019, *Characterizing Exploratory Visual Analysis* (§6), with states after
Wongsuphasawat et al.

## Model

- **Node = analysis state** = the set of attributes currently being analyzed.
  In DF, a chart realizes a state: the set of RAW source attributes it analyzes
  — encoded fields that are raw columns, plus raw columns referenced (as quoted
  identifiers) in the backing table's derivation code, recursively through
  derived parents. Charts with equal attribute sets merge into one state
  (13 thread steps → 10 states in the FAA example).
- **The session is a sequence of state visits** (charts ordered by creation
  time). Consecutive visits type the raw transitions:
  - same set → **self-loop** (iterating in place — effort);
  - attributes added → **forward** (deepening the current thread);
  - attributes removed → **backward** (backtracking);
  - wholesale replacement → **pivot** (implicit backtrack + branch).
- **Search tree** = strip backward edges and self-loops; rooted at the dataset.
  DF adaptation for pivots (Tableau edits shelves incrementally; DF jumps
  between ready-made charts): a first-seen state attaches under the **largest
  previously-visited subset** of it, the root when none exists. No states are
  invented.

## Metric semantics (B&H §6.2 — tree shape, not naive unique-state counts)

- **Depth = commitment to one thread**: tree height; per-trajectory effort =
  visits (incl. self-loops) along the root→leaf path. Greater depth = less
  backtracking, the analyst keeps building on the current state.
- **Breadth = number of distinct trajectories**: each leaf is a separate
  subtask, born from backtracking to an earlier state and striking off anew.
- **Aspect ratio = max width / height** (B&H's structural signature; < 1 =
  depth-oriented — their Tableau finding; the FAA Analyst-condition example
  scores 4.0, breadth-oriented).
- **Self-loops mark key states** ("indicators of significant analysis states")
  — in the FAA example they fall exactly on the two deepened threads' states.
- Also reported: revisited states (non-consecutive returns), attribute coverage.

## Files

- `src/app/analysisGraph.ts` — pure builder (`buildAnalysisTree`), unit-tested
  in `tests/frontend/unit/app/analysisGraph.test.ts`
- `src/views/AnalysisGraphView.tsx` — in-app dialog (tidy tree, depth vertical /
  breadth horizontal, ↻ self-loop badges, trajectory panel, click-through to
  canvas), opened from the thread pane's tree button
- Example: `py-src/data_formulator/example_analysis/Nic- FAA Wildlife Strikes.zip`
  → 13 charts, 10 states, height 2, 8 trajectories, aspect 4.0, 3 self-loops;
  effort concentrates on {AIRPORT}→{AIRPORT,SPECIES} and
  {PHASE_OF_FLIGHT}→{DAMAGE_LEVEL,PHASE_OF_FLIGHT}

## Known limits / choices

- Visits are chart creations; state grain is the pure attribute set (extend the
  signature with aggregation ops if a session over-merges).
- Code-scan canonicalization counts every referenced raw column as "analyzed"
  (filters count, consistent with the state definition).
- Engagement (dwell/edits from the study build's `studyTelemetry`) is an
  optional node overlay; absent on non-study branches.
- In agent-driven DF sessions most transitions are pivots (no incremental
  shelf edits), so tree structure comes from pivots landing on extensions of
  earlier states — report transition-type counts alongside the tree when
  comparing to Tableau numbers.
