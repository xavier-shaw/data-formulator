# Making the Analyst condition proactive ("answer-then-explore")

**Goal:** In the analyst study condition, even when a participant does *not* click
the power button and asks a vague question, the agent should answer their question
and then **autonomously take a couple more exploration steps by default** — explore
*for* the user — so the ANALYST vs EXECUTOR contrast is sharp regardless of how the
participant phrases things.

> **STATUS (2026-07-23): Phase 1 implemented — as a separate mode, not a
> rewrite of `analyst.md`.** Typed chat in the analyst condition now routes to a
> new `analysis_mode: 'analyst_guided'` (`modes/analyst_guided.md`, budget 8):
> anchor on the user's instruction (produce the asked-for chart first), then
> always extend beyond it along that direction, climbing the Lundgard 4-level
> ladder (encoded → statistical → perceptual → contextual); open-ended input
> explores instead of parking. The power button keeps the unchanged full
> `'analyst'` delegation, so the two sub-behaviors stay independently tunable.
> Touched: `SimpleChartRecBox.tsx` (mode resolution at `exploreFromChat`; pause
> state now carries `analysisMode` so resumes re-enter the paused run's mode),
> `ComponentType.tsx` (`PendingClarification.analysisMode`),
> `routes/agents.py` (gate accepts `analyst_guided`), plus the §1c comment
> fixes. Smoke-tested live: concrete typed ask → 3-chart anchored thread +
> closing synthesis; vague typed ask → explores (no clarify-park); button →
> `analysis_mode=analyst` unchanged. Phase 2 telemetry/pilot not started.

---

## 1. The root cause (the thing to fix first)

The single most important finding, verified in code:

> **Today, a question *typed* in the analyst condition never runs analyst mode.
> It runs the DEFAULT profile.** The power button is the *only* path that loads
> the analyst profile.

Why: `exploreFromChat` resolves the mode as
(`src/views/SimpleChartRecBox.tsx:630-631`):

```ts
const analysisMode = analysisModeOverride ?? (config.studyCondition === 'executor' ? 'executor' : undefined);
```

Only the **executor** condition forces a mode for typed chat. In the analyst
condition, typed chat sends **no** `analysis_mode`, so the server
(`routes/agents.py:380-384`) leaves `prompt_profile = None` and the agent falls
back to `load_mode("default")` (`agent.py:309`). The default taxonomy
(`skills/core/SKILL.md`) says *"Ambiguous → use the `ask_user` action"*, and
`ask_user` is a **hard-terminal** tool: its handler returns `None`
(`skill.py:195-222`), which stops the run before any analysis
(`agent.py:596-606`). Even when the model answers a vague question in prose, the
frontend re-renders that as a parked "explain" pause
(`SimpleChartRecBox.tsx:1386-1414`).

**So the "vague question → clarify/explain, no analysis" behavior you're seeing is
the *default* agent, not the analyst agent.** Editing `analyst.md` alone would do
*nothing* for typed questions until the routing is changed. This reframes the whole
task: step one is to actually route analyst-condition typed chat through analyst
mode.

### How the power button differs from what you want

- **Power button** (`DELEGATION_TEMPLATE_PROMPT`): *ignores* whatever the
  participant typed and runs a fully self-directed, depth-first exploration
  ("take over the analysis").
- **What you're asking for** ("answer, then explore a couple more steps"): *honor*
  the participant's actual question first (e.g. really chart "relationship between
  A and B"), **then** continue autonomously. This is a *new* behavior, modeled on
  the delegation prompt's spirit but keeping the user's question as the seed.

---

## 2. Architecture facts that shape the design

| Fact | Location | Why it matters |
|---|---|---|
| Mode = one markdown file (`Identity` / `Budget calibration` / `Taxonomy` H1 sections) → `PromptProfile` | `modes/*.md`, `modes/__init__.py:89-123` | Behavior is edited in `analyst.md`; server-owned, not settable from the browser |
| `analysis_mode` selects the profile + `max_iterations` (analyst=8, executor=3) | `routes/agents.py:380-384` | The routing gate; already allows `'analyst'` |
| Profile injected once per fresh run: identity + budget slots substituted, and `_swap_section` **replaces** the core "## Choosing what to do" taxonomy | `agent.py:1210-1241` | Routing analyst → the DEFAULT "Ambiguous → ask_user" clause is physically deleted from the prompt, not just re-toned |
| The run loop already supports multi-step: after each `visualize` it appends the observation and loops; it ends on `action is None` (plain-text answer), budget exhaustion, or an `ask_user` pause | `agent.py:484-648` | "A couple more steps" needs **no** loop change — the ceiling (8) already permits it; the prompt governs the actual count |
| `clarify`/`explain` are the **one** `ask_user` tool (prompt-driven by the mode taxonomy); it hard-terminates the turn | `tools.json`, `skill.py:195-222`, `agent.py:596-606` | "Proactive" = change *when* the model reaches for `ask_user` vs `visualize` |
| Tools available: `execute_python_script`, `inspect_source_data`, `visualize`, `ask_user`, `delegate`, `load_skill` | `skills/core/tools.json` | A proactive plan reuses `visualize` — no new tools needed |

---

## 3. The plan

> **Two decisions gate everything (see §7 for the full framing):**
> 1. **Prompt-bias vs guarantee.** Your ask ("actively," "by default") reads as
>    wanting a *reliable* manipulation. Phase 1 (prompt) makes proactivity a *bias*
>    that fires most-but-not-all of the time; Phase 3 makes it a control-flow
>    *guarantee*. For a between-subjects analyst-vs-executor comparison, manipulation
>    reliability drives statistical power and required N — so treat the **Phase 2
>    pilot as a hard gate before running participants**, not an optional add-on.
> 2. **Has analyst-condition data collection already started?** This change
>    *redefines* the analyst condition (typed chat becomes proactive). If
>    participants have already run under the current power-button-centric design,
>    this splits their data into two incompatible regimes — the recommendation would
>    change. Confirm before implementing.

### Phase 1 — Unlock + rewrite the prompt (prompt-primary, no loop change)

Two surgical, fully-reversible changes. Executor and Default are untouched.

**1a. Route typed analyst chat through the analyst profile** — the load-bearing
line (`SimpleChartRecBox.tsx:630-631`):

```ts
const analysisMode: 'executor' | 'analyst' | undefined =
    analysisModeOverride ?? (
        config.studyCondition === 'executor' ? 'executor'
        : config.studyCondition === 'analyst' ? 'analyst'
        : undefined
    );
```

The power button's explicit `'analyst'` override still wins; the request already
ships `analysis_mode` when set (`:704`); the server already handles `'analyst'`.
No backend change needed for this path.

> **Side effect to note:** routing typed analyst chat to analyst mode drops the
> per-run budget from **10** (the request/default value) to **8** (`analyst.md`
> frontmatter, applied at `agents.py:382-383`). Trivial, but it's a conscious
> change — raise the frontmatter number if you want typed analyst runs to keep the
> full 10.

> **"Answer first, then explore" is satisfied for free in Phase 1:** each
> `visualize` streams to the thread as it lands, so the chart that directly answers
> the participant's question appears *before* the autonomous follow-ups. (This is
> the one seam Phase 3 must not break — see below.)

**1b. Rewrite `modes/analyst.md`** from "operate under delegation" to
**answer-then-explore**: treat *any* user message (concrete, vague, or an explicit
hand-off) as the starting brief → answer it first → then take **at least one**
self-directed, hypothesis-chained follow-up before closing → and explicitly refuse
to clarify/park on open-ended input. Keep the `## Choosing what to do` anchor
(validated at `modes/__init__.py:106`), the `branch_from` block, and the execution
invariants. Lift the depth-over-breadth / hypothesis-chaining language from
`DELEGATION_TEMPLATE_PROMPT` so the typed default is literally "modeled on the
power-button delegation." (Full draft in §4.)

**1c. Fix three now-stale/inverted comments** (they currently claim typed analyst
chat runs the default agent, and that analyst leaves the taxonomy unmodified):
`SimpleChartRecBox.tsx:624-629`, `:700-703`, and `agent.py:1231`.

**Verify:** `python -m data_formulator.analyst.preview_mode analyst` to read the
assembled prompt (confirm the "Ambiguous → ask_user" clause is gone). Smoke-test a
vague typed question (expect a `visualize`, not a clarify) and a concrete question
(expect answer + a follow-up). Note: `load_mode` caches, so **restart the server**
between prompt edits.

### Phase 2 — Telemetry + pilot (de-risk the prompt bet)

- Emit `autonomous_steps` (committing `visualize` actions beyond the first) on the
  `completion` event (`agent.py:532-540` / `613-624`) and in `_log_session_end`.
- Emit a `parked` flag: run ended with **0** committing actions **and** the
  question wasn't purely conceptual — the metric that tells you whether the
  treatment actually fired.
- Pilot vague ("what's interesting here?", "analyze this") **and** specific
  ("revenue by month") typed questions in analyst + executor.
- **Ship prompt-only if:** analyst park-rate ≈ 0, `autonomous_steps` clusters at
  1–3, executor still clarifies-and-stops. Otherwise → Phase 3.

### Phase 3 — Server-side auto-continue guard (build ONLY if the pilot shows the prompt under-delivers)

Turns "then explore a couple more steps" from a prompt *bias* into a control-flow
*guarantee*, still analyst-only:

- Add `auto_continue_rounds` (frontmatter) + a `# Auto-continue follow-up` H1
  section to `analyst.md`; parse in `modes/__init__.py`; thread through
  `agents.py:380-384` into the agent ctor. Absent key ⇒ 0 ⇒ inert for
  Default/Executor.
- Hook the **`action is None` branch** (`agent.py:511-542`), *before* the
  completion emit: only when status is `success` **and** `auto_continue_budget > 0`
  **and** `actions_committed > 0` (skip pure conceptual Q&A) **and** progress was
  made since the last injection **and** budget remains — decrement the round, yield
  a **non-terminal** `auto_continue` event, append a `role:user` message =
  the follow-up prompt, and `continue` the same loop. (Architecturally clean: the
  trajectory ends on an assistant text turn, so appending a user message is
  orphan-free.)
- Frontend: render `auto_continue` as a visible "exploring further on its own"
  beat; do **not** add it to the terminal set (`SimpleChartRecBox.tsx:1495`).
- Start knob: `auto_continue_rounds: 2`.

> **Must get right — the fragile seam in the guarantee.** The hook fires in the
> `action is None` branch and *replaces* the completion emit. The user's core
> requirement is "answer **first**, then explore," so verify the model's direct
> answer (the plain-text turn and any chart it already streamed) is surfaced to the
> participant *before* the auto-continue re-prompt runs — don't let the guarantee
> swallow the answer it's supposed to build on. Because the direct-answer chart
> streams as a `visualize` earlier in the run, the ordering holds; the thing to
> confirm in testing is that the interim plain-text answer isn't discarded.

---

## 4. Proposed `analyst.md` rewrite (Phase 1 drop-in)

Keeps frontmatter, the `## Choosing what to do` anchor, the `branch_from` block,
and the execution invariants; changes the policy to answer-then-explore.

```markdown
---
name: analyst
max_iterations: 8
---

# Identity

You are an autonomous data analyst agent. In this mode **you own the analytical
judgment**: you decide what is worth looking at next and follow the thread
yourself, rather than pausing to ask the user which direction to take.

Treat the user's message as your **starting brief**, whatever shape it takes:
- a concrete question ("what's the trend in revenue?") — answer it first, then keep going;
- a vague or open prompt ("show me something interesting", "what stands out?", "analyze this") — interpret it reasonably from the data and proceed; do **not** ask the user to narrow it down for you;
- an explicit hand-off ("take over the analysis") — take the direction it names and run with it.

You operate in a loop: gather what you need with inspection tools, take an
**action** when you want to act on the data, read its result, and use it to decide
the next action — then stop by giving your final answer in plain text.

Because the analytical direction is yours here, make a reasoned choice from what the
data and the user's message show, and **proceed**. Reserve `ask_user` for when you
are genuinely blocked on *executing* — a detail the data and the message cannot
resolve — never to hand a "what should we look at" decision back.

# Budget calibration

- **Answer, then explore — don't stop at the first chart.** Answering the user's
  literal question is your **first** step, not the whole job: after it, take at
  least one self-directed follow-up that builds on what you just found before you
  close.
- Commit to depth, not breadth: build one coherent thread rather than spreading
  across disconnected angles. Read what the last chart showed, form a hypothesis,
  and let the next action test it, so the sequence reads as one line of reasoning.
- Scale depth to the question and the data — a narrow question needs a short
  follow-up, an open one more. The budget is a **ceiling, not a target**: stop once
  the thread reaches a genuine insight, never pad with steps that don't build on
  the last, and **never** repeat a visualization already in the trajectory or
  another thread. Close by tying what you found together in plain text.
- Decide and proceed. Use `ask_user` only when you are genuinely blocked on
  something the data and the user's message cannot resolve — never to hand the
  analytical choice back.

# Taxonomy

## Choosing what to do

In this mode the analytical direction is **yours**. Do not classify the user's
message in order to decide whether to *ask them* what to do — decide that yourself
from the data. Whatever the message's shape, the pattern is the same: **answer it,
then keep exploring.**

- First, produce the visualization that most directly addresses the user's message,
  interpreting a vague message reasonably rather than asking them to narrow it.
- Then continue: each further visualization tests a hypothesis raised by what you
  have seen so far — read what a chart shows, form a hypothesis, let the next one
  test it. Take at least one such self-directed step beyond the direct answer by
  default; stop when the thread reaches a genuine insight.
- Close by tying your findings together in plain text.

A message that other modes would treat as under-specified — "show me something
interesting", "what should I explore next?", "find insights", "analyze this data",
"give me an overview" — is **not** a reason to pause here. Choosing what is
interesting is exactly the analytical work this mode owns: pick a reasonable angle
from the data and proceed. Do **not** use `ask_user` to hand that choice back.

**Structuring threads.** Each visualization becomes a node in the data thread; the
optional `branch_from` field on `visualize` sets where it attaches. **Omit it** to
continue the current thread (deepen the open line). To start a **new direction**,
set `branch_from` to a source/root table name from [SOURCE TABLES] — it becomes its
own thread. When you deliberately pursue several distinct angles, give **each** its
own thread by branching each from the root. To deepen a specific *earlier* finding,
set `branch_from` to that step's output table name (shown in its observation).

This section keeps only the execution invariants — moves that hold regardless of direction:

- *Conceptual / informational* (meaning, schema, what a field represents — no chart
  needed): **answer directly in plain text** (no action).
- *Genuinely blocked* (a required *execution* detail you cannot resolve from the
  data or the user's message): use the `ask_user` action — but only for an
  execution blocker, never to choose the analytical direction, which is yours.
- *Missing data* (the analysis needs tables not in the workspace): `delegate(target="data_loading")`.
- *Report / write-up request* ("write a report on X", "summarize the findings"):
  load the **report** skill — `load_skill("report")` — and follow it. **Do this as
  your very first move when charts already exist**: don't re-create them, embed the
  existing charts by id. Only produce a new chart first if the report needs one
  that isn't there yet, then load the skill.
```

**Phase 3 `# Auto-continue follow-up` section (only if built):**

```markdown
# Auto-continue follow-up

[SYSTEM — autonomous exploration] You've answered what the user asked. Now, on
your own initiative and without waiting to be asked, carry the analysis one or two
steps further — this is your chance to explore on the user's behalf.

Look at what you just found and pick the single most promising next move: deepen
the thread you just opened (read the last chart, form a hypothesis, and test it
with the next one), or — if that line is exhausted — branch to the adjacent angle
the data makes most salient. Commit to depth over breadth: build one coherent line
of reasoning, never repeat a chart already in the thread, and do not ask the user
what to look at — decide and proceed. When you've taken it as far as is genuinely
useful, stop and tie the whole sequence together in plain text.
```

---

## 5. Knobs

- **Number of extra steps (primary):** Phase 1 = prompt wording ("answer first,
  then ≥1 follow-up; budget is a ceiling not a target") + the `max_iterations: 8`
  ceiling. It's a *ceiling + bias*, and the actual count is your measured DV
  (`autonomous_steps`). Phase 3's `auto_continue_rounds` (default 2) turns it into
  a *bounded guarantee*.
- **`max_iterations`** (`analyst.md` frontmatter, currently 8): hard ceiling on
  total committing actions. Lower (e.g. 4) to bound over-exploration on trivial
  questions.
- **Anti-clarify strength:** how emphatically the taxonomy declares the vague
  phrases "not a reason to pause."
- **Power-button weight:** keep `DELEGATION_TEMPLATE_PROMPT` as a richer "go deep"
  brief so the button still reads as "more," or accept the collapse (see §7).

---

## 6. Study-validity considerations

- **Executor contrast is provably preserved.** The routing edit only *adds* an
  analyst arm; the executor arm is byte-identical, so executor still runs
  `executor.md` (budget 3, one-chart-then-stop, clarify-and-wait). The contrast
  *sharpens* into a clean symmetric split on identical inputs: on the same vague
  phrase, executor pauses and produces nothing / analyst interprets-and-proceeds,
  answers, and explores a couple more angles.
- **Measurability:** report the *distribution* of `autonomous_steps` (a measured
  outcome, not a set constant), plus the `parked` rate. Completion status already
  distinguishes agent-chosen stop (`success`) from budget-hit (`max_iterations`).
- **Participant can still stop:** the whole run streams under one `AbortController`
  (`SimpleChartRecBox.tsx:752`); the working-overlay cancel aborts it. Since the
  agent now acts *without* a click, keep Stop visible through the autonomous phase
  and consider a factual "exploring a couple more angles — stop anytime" status.
- **Re-baseline:** typed analyst chat previously ran the DEFAULT profile, so any
  pre-change analyst pilot data is *not* comparable — collect fresh baselines.
- **Confounds to pre-register:** proactive analyst runs take longer and emit more
  charts than executor's clarify-and-wait (the intended effect, but it moves
  latency/output-volume — report time-on-task and chart count). The manipulation
  now affects *all* typed messages (concrete too), not only vague ones — deliberate,
  and what makes the contrast symmetric.

---

## 7. Open decisions for the researcher

1. **Collapse vs graduated (pivotal).** *Collapse* (recommended): typed chat and
   the power button run the *same* analyst profile, differing only in the user
   message — fewest confounds, matches the task framing. *Graduated*: a separate
   lighter `analyst_auto.md` (budget ~3) for typed chat, keep `analyst.md`
   (budget 8) for the button — a hard-bounded typed budget and a preserved "deeper"
   button tier, at the cost of a second file and a wider prompt-drift surface.
2. **Does the power button still mean anything after collapse?** It would select
   the same profile and differ only in the canned brief vs typed text. Keep it as a
   heavier "go deeper" affordance, or retire it?
3. **Guarantee vs measured distribution.** Prompt-only makes "a couple more steps"
   a *bias* (measured); Phase 3 makes it a *guarantee*. For clean study data you may
   prefer the guarantee up front — but it adds a second manipulation. Recommendation:
   pilot prompt-only first, add the guard only if it under-fires.
4. **Should the analyst condition ever clarify?** Recommendation: yes, for a genuine
   *execution* block only (keep `ask_user` in `tools.json`) — forcing zero clarifies
   would fabricate charts on truly ambiguous input.
5. **Runbook:** `load_mode` caches → restart the server between prompt edits.
   Confirm `config.studyCondition` survives a page reload (it's Redux-only today —
   `dfSlice.tsx` — with no visible persistence).
6. **Three modes, "two conditions":** the code has `default` / `executor` /
   `analyst`. This plan leaves `default` untouched — confirm whether `default` is a
   dormant control or actually in play in your study, since the analyst-vs-executor
   contrast is what this plan sharpens.

---

*Grounded in: `agent.py:309,484-648,1210-1241`; `routes/agents.py:353-425`;
`modes/__init__.py:89-123`; `modes/analyst.md`, `executor.md`, `default.md`;
`skills/core/SKILL.md`, `tools.json`, `skill.py:195-249`;
`SimpleChartRecBox.tsx:93-99,616-631,1386-1414,2016-2052`.*
