# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Render the full assembled system prompt for one analyst study mode.

The per-mode markdown files (``modes/*.md``) hold only each mode's deltas, so no
single file shows a mode's complete prompt. This command assembles and prints it,
so you can read the whole thing end-to-end while still editing the small deltas.

Usage:
    python -m data_formulator.analyst.preview_mode analyst_guided
    python -m data_formulator.analyst.preview_mode executor
    python -m data_formulator.analyst.preview_mode default
"""

from __future__ import annotations

import sys

from data_formulator.analyst.agent import AnalystAgent
from data_formulator.analyst.modes import load_mode


def render(name: str) -> str:
    """Assemble the full system prompt for mode ``name`` (all conditional spans on)."""
    mode = load_mode(name)
    agent = AnalystAgent(client=None, workspace=None, prompt_profile=mode.profile)
    return agent._build_system_prompt(
        has_primary_tables=True,
        has_focused_thread=True,
        has_other_threads=True,
        has_attached_images=True,
        has_charts=True,
    )


def main() -> None:
    name = sys.argv[1] if len(sys.argv) > 1 else "analyst_guided"
    try:
        prompt = render(name)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    mode = load_mode(name)
    budget = mode.max_iterations if mode.max_iterations is not None else "(from request)"
    print(f"# ===== mode: {name}  |  max_iterations: {budget}  |  {len(prompt)} chars =====\n",
          file=sys.stderr)
    print(prompt)


if __name__ == "__main__":
    main()
