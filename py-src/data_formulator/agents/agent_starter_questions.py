# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

import json
from data_formulator.agent_config import reasoning_effort_for
from data_formulator.agents.agent_utils import extract_json_objects
from data_formulator.agents.agent_language import inject_language_instruction
from data_formulator.analyst.suggestion_guidelines import SUGGESTION_GUIDELINES

import logging

logger = logging.getLogger(__name__)

_AGENT_ID = "starter_questions"


SYSTEM_PROMPT = '''You are a data analyst proposing next-step suggestions: concrete analysis moves the user could take next on their data.
You are given a summary of the available tables (their names, columns, and a few sample rows) and one designated "primary_table".
Once analysis is underway, you are also given the exploration so far: "focused_thread" — the charting steps taken on the current thread (each with its instruction, chart type, encodings, and finding), earliest first — and "other_threads", one-line summaries of the other exploration threads.
Propose suggestions following the shared guidelines below.

''' + SUGGESTION_GUIDELINES + '''

Grounding the two ranges:
- With a "focused_thread" (analysis underway): **near moves** ground in its
  latest charting steps — drill into a detail they surfaced, try a statistical
  technique on the same data, or pivot to a different angle on it. **Far
  moves** ground in the whole trajectory — other threads, other tables, angles
  the exploration has not touched yet.
- Fresh session (no "focused_thread"): **near moves** ground in the
  primary_table — a trend, a comparison, a distribution or breakdown, or a
  statistical cut of its own columns. **Far moves** broaden beyond it: relate
  the primary table to another table that shares a plausible key (at most ONE
  cross-table suggestion), or zoom out to a whole-table overview. With a
  single table, a far move is a table-level overview cut.
- Never repeat a charting step already listed in "focused_thread" or
  "other_threads".

Return ONLY a json object of the following form:

{
    "questions": ["<action (goal)>", "<action (goal)>", ...]
}

Example:

[INPUT]

{
    "primary_table": "sales",
    "tables": [
        {
            "name": "sales",
            "columns": ["date", "region", "product", "revenue", "units"],
            "sample_rows": [
                {"date": "2023-01-01", "region": "West", "product": "A", "revenue": 1200, "units": 30},
                {"date": "2023-01-02", "region": "East", "product": "B", "revenue": 800, "units": 20}
            ]
        }
    ]
}

[OUTPUT]

{
    "questions": ["Compare revenue across regions (see which region leads)", "Rank products by units sold (find the volume drivers)", "Chart monthly total revenue (see the overall trajectory)", "Break revenue down by product and region (spot region-product niches)"]
}
'''


class StarterQuestionsAgent(object):

    def __init__(self, client, language_instruction: str = ""):
        self.client = client
        self.language_instruction = language_instruction

    def run(self, tables, primary_table=None, n=2, focused_thread=None, other_threads=None):
        """Generate a short list of next-step suggestions.

        ``tables`` is a list of dicts with ``name``, optional ``description``
        and either ``columns`` and/or ``sample_rows``. ``primary_table`` is
        the name of the table the suggestions should center on. Optional
        ``focused_thread`` / ``other_threads`` carry the exploration so far
        (same Tier-2/Tier-3 shapes the analyst agent receives) so near moves
        ground in the latest charts; omitted on a fresh session, where the
        prompt falls back to starter grounding. Returns a list of suggestion
        strings (best effort, may be empty on failure).
        """

        input_obj = {"primary_table": primary_table, "tables": tables, "num_questions": n}
        if focused_thread:
            input_obj["focused_thread"] = focused_thread
        if other_threads:
            input_obj["other_threads"] = other_threads

        user_query = f"[INPUT]\n\n{json.dumps(input_obj, ensure_ascii=False, default=str)}\n\n[OUTPUT]"

        logger.info("[StarterQuestionsAgent] run start")

        system_prompt = inject_language_instruction(
            SYSTEM_PROMPT, self.language_instruction,
        )

        messages = [{"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_query}]

        response = self.client.get_completion(
            messages=messages,
            reasoning_effort=reasoning_effort_for(_AGENT_ID, self.client.model),
        )

        for choice in response.choices:
            logger.debug("\n=== Starter questions agent ===>\n")
            logger.debug(choice.message.content + "\n")

            content = choice.message.content or ""

            questions = []
            json_blocks = extract_json_objects(content + "\n")
            candidate = None
            if len(json_blocks) > 0:
                candidate = json_blocks[0]
            else:
                try:
                    candidate = json.loads(content + "\n")
                except (json.JSONDecodeError, ValueError, TypeError):
                    candidate = None

            if isinstance(candidate, dict):
                raw = candidate.get("questions", [])
                if isinstance(raw, list):
                    questions = [str(q).strip() for q in raw if str(q).strip()]
            elif isinstance(candidate, list):
                questions = [str(q).strip() for q in candidate if str(q).strip()]

            return questions[:n]

        return []
