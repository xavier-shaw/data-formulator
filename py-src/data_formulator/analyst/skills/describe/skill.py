# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""describe skill — the ``describe_chart`` action handler.

Attaches a short caption to a chart created this run. The caption's *content
policy* (executor: computable Level-2 data facts; analyst_guided: Level-3
perceived patterns) lives in the mode prompt files, not here — this handler is
mode-agnostic mechanics: validate the arguments, resolve the chart id against
the run's registered charts, and emit one ``chart_description`` event that the
frontend stores on the chart (caption under the chart + report-takeaway
prefill).
"""

from __future__ import annotations

import logging
from typing import Any, Generator

from data_formulator.analyst.skills.base import (
    Event,
    SkillContext,
    ToolResult,
)

logger = logging.getLogger(__name__)


class DescribeSkill:
    """Processor for the ``describe_chart`` committing action."""

    def handle_tool(
        self,
        name: str,
        args: dict[str, Any],
        ctx: SkillContext,
    ) -> ToolResult:
        return ToolResult(text=f"describe has no tool '{name}'.")

    def handle_action(
        self,
        action: str,
        spec: dict[str, Any],
        ctx: SkillContext,
    ) -> Generator[Event, None, str | None]:
        if action != "describe_chart":
            yield {
                "type": "error",
                "message": f"describe cannot handle action '{action}'.",
                "message_code": "agent.unknownAction",
            }
            return f"describe cannot handle action '{action}'."

        chart_id = str(spec.get("chart_id") or "").strip()
        description = " ".join(str(spec.get("description") or "").split())

        if not description:
            # Recoverable: the agent reads this observation and retries.
            return "[ERROR] describe_chart requires a non-empty 'description'."

        charts = (ctx.payload or {}).get("charts") or []
        known_ids = [c.get("chart_id") for c in charts if c.get("chart_id")]
        if chart_id not in known_ids:
            known = ", ".join(f"`{cid}`" for cid in known_ids) or "(none)"
            return (
                f"[ERROR] Unknown chart_id {chart_id!r}. Use the id from the "
                f"visualize observation's '**Chart id**' line. Known chart ids: {known}."
            )

        yield {
            "type": "chart_description",
            "chart_id": chart_id,
            "description": description,
        }
        return (
            f"[OBSERVATION] Caption attached to chart `{chart_id}`. It is shown "
            "beneath the chart and pre-fills the takeaway when the user adds the "
            "chart to their findings report."
        )


def get_skill() -> DescribeSkill:
    """Factory used by the registry's eager instantiation."""
    return DescribeSkill()
