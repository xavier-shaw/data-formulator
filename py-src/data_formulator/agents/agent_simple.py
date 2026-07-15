# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Lightweight single-turn agents that wrap a system prompt + one LLM call.

Each method takes a ``Client`` instance plus task-specific parameters and
returns a plain dict result (no streaming, no workspace access).
"""

import json
import logging

from data_formulator.agent_config import reasoning_effort_for
from data_formulator.agents.agent_utils import extract_json_objects
from data_formulator.agents.agent_language import inject_language_instruction

logger = logging.getLogger(__name__)

_AGENT_ID = "simple"


# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------

_NL_FILTER_SYSTEM_PROMPT = """\
You are a data loading assistant. The user wants to load a subset of a database table \
based on a natural language description. Your job is to translate their request into a \
structured JSON query specification (Selection, Projection-free, Join-free — SPJ without projection).

You will be given:
- A table's column schema (name + type)
- A user's natural language description of what data they want

Return a JSON object with:
{
  "conditions": [
    {"column": "<col_name>", "operator": "<op>", "value": <val>}
  ],
  "sort_columns": ["<col>"],   // optional — include if the user mentions ordering
  "sort_order": "asc" | "desc", // optional, default "asc"
  "limit": <number>             // optional — include if the user mentions a row limit
}

All columns will be selected (no projection). Focus on filtering (WHERE), sorting (ORDER BY), and limiting (LIMIT).

Valid operators: =, !=, >, <, >=, <=, LIKE, NOT LIKE, IN, NOT IN, BETWEEN, IS NULL, IS NOT NULL
- For LIKE: use SQL wildcards (e.g. "value": "%pattern%")
- For IN / NOT IN: "value" is an array
- For BETWEEN: "value" is [lo, hi]
- For IS NULL / IS NOT NULL: omit "value"

Rules:
- Only use column names from the provided schema.
- Infer reasonable filter values from context (e.g. "recent" → sort by date desc + limit, \
"last year" → date >= '2025-01-01').
- If the user mentions sorting or limiting, include sort_columns/sort_order/limit.
- If the instruction is empty or unclear, return {"conditions": []}.
- Return ONLY the JSON object, no markdown fences or explanation."""

_WORKSPACE_NAME_SYSTEM_PROMPT = (
    "You name data analysis workspaces for display in the product UI. "
    "Generate a very short workspace/session display name based on the context below. "
    "The name is user-visible, so it must follow the user's interface language. "
    "Keep it concise: 3-5 words for English, or a similarly short phrase for other languages. "
    "Return ONLY the name, no quotes, no explanation, no trailing punctuation."
)


_CHART_INTENT_SYSTEM_PROMPT = (
    "Route a chart edit request to one of two agents.\n"
    "\n"
    "The test: does the request change the set of fields bound to chart\n"
    "encodings (x, y, color, size, shape, row, column, facet, theta, etc.)?\n"
    "\n"
    "STYLE — encoding fields are unchanged. The user is refining the same\n"
    "chart that answers the same question. This includes:\n"
    "  - filter / sort / top-N / limit (even on fields not currently encoded,\n"
    "    as long as the field already exists in the data)\n"
    "  - layering or overlay on the same encoded fields (trend line, error bars)\n"
    "  - aggregation / bin changes on an already-encoded field\n"
    "  - any visual change: theme, colors, fonts, legend, axes, mark\n"
    "    size/opacity, donut hole, tooltip text\n"
    "\n"
    "DATA — encoding fields change, or a new field must be computed/joined:\n"
    "  - replace, add, or remove an encoded field (e.g. \"color by region\",\n"
    "    \"use quantity instead of price on y\", \"drop size\")\n"
    "  - change chart type in a way that requires different fields\n"
    "  - pivot / unpivot / reshape, bring in a field from another table\n"
    "  - compute a new derived field beyond a simple Vega-Lite calculate\n"
    "    (moving average, percentile rank, etc.)\n"
    "\n"
    "Requests may be in any language. Reply with one word: STYLE or DATA."
)


_SEMANTIC_THREADS_SYSTEM_PROMPT = """\
You reconstruct the topical structure of a data analysis session.

You are given the dataset name(s) and the charts an analyst created, in creation \
order. Each chart has:
- "num": creation-order number
- "title": the chart's title
- "attributes": the dataset columns the chart analyzes
- "prompt": the question or instruction that produced it (may be empty)

Group the charts into SEMANTIC THREADS. A thread is one topic or direction of \
inquiry — a coherent line of questions about the same subject (e.g. "damage \
severity by species" or "strike frequency across airports"). Charts in a thread \
continue, refine, or deepen one another; a new thread starts when the analysis \
pivots to a different subject.

Rules:
- Every chart belongs to exactly ONE thread.
- Judge primarily by the semantic meaning of titles and prompts; use attribute \
overlap as supporting evidence. Charts sharing attributes may still be different \
topics, and one topic may span different attributes.
- Within a thread, order charts as a narrative progression — broad overview \
first, deeper or more specific views after. Follow creation order unless the \
semantics clearly suggest a better progression.
- Order threads by the creation number of their earliest chart.
- Prefer fewer coherent threads over many fragments, but never force unrelated \
topics together. A single chart may stand alone if it is a genuine one-off pivot.
- "topic" is a short noun phrase (2-6 words) naming the thread's subject; \
"summary" is one sentence on what the analyst investigated in it.

Return ONLY a JSON object, no markdown fences and no explanation:
{
  "threads": [
    {"topic": "...", "summary": "...", "charts": [<num>, <num>, ...]}
  ]
}"""


# ---------------------------------------------------------------------------
# Class
# ---------------------------------------------------------------------------

class SimpleAgents:
    """Collection of lightweight single-turn LLM agents."""

    def __init__(self, client, language_instruction: str = ""):
        self.client = client
        self.language_instruction = language_instruction

    # -- NL → structured filter conditions ----------------------------------

    def nl_to_filter(self, columns: list[dict], instruction: str) -> dict:
        """Translate *instruction* into structured filter conditions.

        Parameters
        ----------
        columns : list[dict]
            Column schema, each entry ``{"name": ..., "type": ...}``.
        instruction : str
            Natural-language filter description from the user.

        Returns
        -------
        dict with keys ``conditions``, ``sort_columns``, ``sort_order``, ``limit``.
        """
        col_desc = "\n".join(
            f"  - {c['name']} ({c.get('type', 'unknown')})"
            + (f": {c['description']}" if c.get('description') else "")
            for c in columns
        )
        user_msg = f"Table columns:\n{col_desc}\n\nFilter instruction: {instruction}"

        messages = [
            {"role": "system", "content": _NL_FILTER_SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ]

        logger.info("[SimpleAgents.nl_to_filter] run start")
        response = self.client.get_completion(messages=messages, reasoning_effort=reasoning_effort_for(_AGENT_ID, self.client.model))
        raw = response.choices[0].message.content.strip()

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]
            raw = raw.strip()

        result = json.loads(raw)

        # Validate: only allow known column names
        known_cols = {c["name"] for c in columns}
        valid_conditions = [
            cond for cond in (result.get("conditions") or [])
            if cond.get("column") in known_cols
        ]

        out = {
            "conditions": valid_conditions,
            "sort_columns": result.get("sort_columns"),
            "sort_order": result.get("sort_order"),
            "limit": result.get("limit"),
        }
        logger.info(f"[SimpleAgents.nl_to_filter] done | {len(valid_conditions)} conditions")
        return out

    # -- Workspace display name / auto-name ---------------------------------

    def workspace_name(self, table_names: list[str], user_query: str = "") -> str:
        """Generate a short display name for a workspace.

        Returns the display name string (already truncated to 60 chars).
        """
        prompt_parts = []
        if table_names:
            prompt_parts.append(f"Data tables: {', '.join(table_names)}")
        if user_query:
            prompt_parts.append(f"User's first request: {user_query}")

        context_str = ". ".join(prompt_parts) if prompt_parts else "A data analysis session"

        system_prompt = inject_language_instruction(
            _WORKSPACE_NAME_SYSTEM_PROMPT, self.language_instruction,
        )

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": context_str},
        ]

        logger.info("[SimpleAgents.workspace_name] run start")
        response = self.client.get_completion(messages=messages, reasoning_effort=reasoning_effort_for(_AGENT_ID, self.client.model))
        display_name = response.choices[0].message.content.strip().strip("\"'")
        if len(display_name) > 60:
            display_name = display_name[:57] + "..."

        logger.info(f"[SimpleAgents.workspace_name] done | \"{display_name}\"")
        return display_name

    # -- Chart prompt intent classifier -------------------------------------

    def classify_chart_intent(self, instruction: str) -> str:
        """Classify a chart-prompt as STYLE or DATA.

        Used by the encoding-shelf input on Enter to decide whether to send
        the prompt to the chart-restyle agent (cheap, single LLM call,
        modifies vlSpec only) or to the full data agent (data shape changes,
        new fields, chart-type changes, etc.).

        Multilingual by design — keyword heuristics are too brittle for
        non-English prompts. Returns 'style' or 'data' (always lowercase).

        On any failure, returns 'data' as the safe default — the data agent
        can handle anything; mistakenly sending a style request there is
        slower but produces a usable result.
        """
        text = (instruction or "").strip()
        if not text:
            return "data"

        messages = [
            {"role": "system", "content": _CHART_INTENT_SYSTEM_PROMPT},
            {"role": "user", "content": text},
        ]

        try:
            response = self.client.get_completion(messages=messages, reasoning_effort=reasoning_effort_for(_AGENT_ID, self.client.model))
            raw = (response.choices[0].message.content or "").strip().upper()
        except Exception as e:
            logger.warning("[SimpleAgents.classify_chart_intent] LLM call failed: %s", e)
            return "data"

        # The model may add stray punctuation/quotes despite the prompt; be lenient.
        if "STYLE" in raw and "DATA" not in raw:
            verdict = "style"
        else:
            verdict = "data"
        logger.info("[SimpleAgents.classify_chart_intent] %r -> %s", text[:80], verdict)
        return verdict

    # -- Semantic analysis threads (topic clustering of session charts) -----

    def semantic_threads(self, dataset_names: list[str], charts: list[dict]) -> dict:
        """Cluster a session's charts into semantic topic threads.

        Parameters
        ----------
        dataset_names : list[str]
            Display names of the source dataset(s) under analysis.
        charts : list[dict]
            One entry per chart, in creation order:
            ``{"num": int, "title": str, "attributes": [str], "prompt": str}``.

        Returns
        -------
        dict ``{"threads": [{"topic", "summary", "charts": [num, ...]}]}``.
        The frontend re-validates chart numbers and reassigns strays, so this
        only guarantees structural shape, not referential integrity.
        """
        chart_json = json.dumps(charts, ensure_ascii=False, indent=1)
        user_msg = (
            f"Dataset(s): {', '.join(dataset_names) if dataset_names else 'unknown'}\n\n"
            f"Charts (creation order):\n{chart_json}"
        )

        system_prompt = inject_language_instruction(
            _SEMANTIC_THREADS_SYSTEM_PROMPT, self.language_instruction,
        )
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_msg},
        ]

        logger.info(f"[SimpleAgents.semantic_threads] run start | {len(charts)} charts")
        response = self.client.get_completion(
            messages=messages,
            reasoning_effort=reasoning_effort_for("semantic_threads", self.client.model),
        )
        raw = (response.choices[0].message.content or "").strip()

        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
            if raw.endswith("```"):
                raw = raw[:-3]
            raw = raw.strip()

        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            candidates = [b for b in extract_json_objects(raw) if isinstance(b, dict) and "threads" in b]
            if not candidates:
                raise
            result = candidates[0]

        threads = []
        for t in result.get("threads") or []:
            if not isinstance(t, dict):
                continue
            nums = [int(n) for n in (t.get("charts") or []) if isinstance(n, (int, float))]
            threads.append({
                "topic": str(t.get("topic") or "").strip(),
                "summary": str(t.get("summary") or "").strip(),
                "charts": nums,
            })

        logger.info(f"[SimpleAgents.semantic_threads] done | {len(threads)} threads")
        return {"threads": threads}
