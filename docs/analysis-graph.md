# Analysis Graph — a second modality over the session

The **data thread** is user-centered: a linear, temporal history of what the user
chose to create, for navigation. The **analysis graph** is analysis-centered: an
order-free, structural view of *what was explored*, built from the same source
state. It answers "how deep did each line of inquiry go, how broad was the
exploration, what was the thematic anchor" — the post-analysis questions.

Grounding: Battle & Heer 2019, *Characterizing Exploratory Visual Analysis*
(§6.1), after Wongsuphasawat et al.: "an analysis state is the set of attributes
currently being analyzed, for which a user may specify visual encodings, apply
filters, or group and aggregate the data." Heer et al. 2008 (*Graphical
Histories*) supplies the underlying states-and-transitions model.

## Node = attribute-set state

A node is a distinct set of **raw source-dataset attributes** analyzed. DF
charts mostly encode derived measure columns with per-table names
(`serious_damage_rate`), so each chart is resolved to raw attributes by:

1. encoded fields that are raw columns, plus
2. raw columns referenced (as quoted identifiers) in the backing table's
   `derive.code`, recursively through derived parents — the DF analog of
   Tableau's encoding + filter shelves.

Charts with equal attribute sets merge into one state (dedup is the point:
13 thread steps → 10 states in the FAA example). Derived measures, chart types,
aggregations, timestamps, and engagement are node *properties*, not identity.

## Edges = purely structural, no behavioral meaning

- **refinement** (solid, directed): A → B iff attrs(A) ⊂ attrs(B) with no
  observed intermediate — the Hasse diagram of containment. The structural twin
  of Battle & Heer's temporal "added an attribute" edge.
- **overlap** (dashed): a maximum-spanning-forest over Jaccard similarity
  (≥ 0.2) between nodes not already connected via containment. Connects
  thematic hubs (e.g. seven states sharing DAMAGE_LEVEL) without a similarity
  hairball. Which specific pairs are drawn is a spanning-forest choice; the
  per-component **anchor attributes** (present in ≥ 60% of a component's nodes)
  are the meaningful unit and are rendered as a hull.

Time is a node property (first/last realization), never an edge — ordering
belongs to the thread. Engagement (dwell/visits/edits from the study build's
`studyTelemetry`) is an optional overlay.

## Metrics

- `stateCount`, `componentCount`, `leafCount`, `attributeCoverage` — breadth
- `maxDepth` (longest containment chain), `deepestChain`, per-attribute depth — depth & its direction
- `maxBreadth` (widest depth level), `aspectRatio = maxBreadth / maxDepth` —
  Battle & Heer's structural signature (<1 depth-oriented; Tableau EVA was
  depth-oriented; the FAA Analyst-condition example scores 4.0, breadth-oriented)
- `attributeStats` — states/charts/depth per attribute (the "what was the
  analysis about" readout)

## Files

- `src/app/analysisGraph.ts` — pure builder (`buildAnalysisGraph`), unit-tested
  in `tests/frontend/unit/app/analysisGraph.test.ts`
- `src/views/AnalysisGraphView.tsx` — in-app dialog (hub-and-chains layout,
  anchor hulls, click-through to canvas), opened from the thread pane's ⬡ button
- Example: `py-src/data_formulator/example_analysis/Nic- FAA Wildlife Strikes.zip`
  → 13 charts, 10 states, DAMAGE_LEVEL hub ×7, two refinement chains
  ({AIRPORT}→{AIRPORT,SPECIES}, {PHASE_OF_FLIGHT}→{DAMAGE_LEVEL,PHASE_OF_FLIGHT})

## Known limits / choices

- Code-scan canonicalization treats every referenced raw column as "analyzed"
  (filters count as analysis — consistent with the B&H definition); columns
  touched only for cleanup inflate a state's set slightly.
- No undo/branch history exists in DF, so branching comes from the structure
  itself (multiple supersets of one state), not from history manipulation.
- State grain is the pure attribute set; if a session over-merges (same fields,
  meaningfully different aggregation), extend the signature with aggregation ops.
