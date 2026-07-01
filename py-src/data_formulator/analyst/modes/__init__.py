# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Per-mode prompt definitions for the analyst agent (user study).

Each study mode is a single markdown file in this package — ``default.md``,
``executor.md``, ``analyst.md`` — so a mode's whole behavior can be read and
edited in one place. A file carries YAML frontmatter (``name``, optional
``max_iterations``) plus H1 sections that fill the three per-mode prompt spans:

    # Identity            -> {agent_identity} slot
    # Budget calibration  -> {budget_calibration} slot
    # Taxonomy            -> replaces the core skill's "## Choosing what to do"
                             section (omit the section to inherit the default)

The ~90% shared machinery (the SYSTEM_PROMPT frame and the core skill) stays
single-sourced in ``agent.py`` / ``skills/`` — only these deltas live per mode,
which is what keeps the three study conditions identical except in analytical
policy. ``load_mode(name)`` parses a file into a ``ModeDefinition``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

_MODES_DIR = Path(__file__).parent
_FRONT_MATTER_RE = re.compile(r"^---\n(.*?)\n---\n?(.*)$", re.DOTALL)


@dataclass(frozen=True)
class PromptProfile:
    """Per-mode analytical-policy swap. Shared execution machinery is untouched.

    Filled from a mode markdown file's H1 sections. ``taxonomy_override == ""``
    means "keep the core skill's default taxonomy" (the Default control).
    """
    identity: str
    budget_calibration: str
    taxonomy_override: str = ""


@dataclass(frozen=True)
class ModeDefinition:
    """A fully-resolved study mode: its budget and its prompt profile."""
    name: str
    max_iterations: int | None  # None => don't override (Default uses the request's value)
    profile: PromptProfile


def _parse_front_matter(content: str) -> tuple[dict, str]:
    """Return ``(frontmatter_dict, body)``. Degrades to ``({}, content)``."""
    m = _FRONT_MATTER_RE.match(content)
    if not m:
        return {}, content
    meta = yaml.safe_load(m.group(1)) or {}
    return (meta if isinstance(meta, dict) else {}), m.group(2)


def _split_h1_sections(body: str) -> dict[str, str]:
    """Split a markdown body into ``{lowercased H1 heading: stripped content}``.

    Only level-1 (``# ``) headings delimit sections, so a section body may itself
    contain ``## `` headings (e.g. the Taxonomy section's ``## Choosing what to do``)
    without being mis-split.
    """
    sections: dict[str, str] = {}
    current: str | None = None
    buf: list[str] = []
    for line in body.splitlines():
        if line.startswith("# "):  # H1 only ("## " does not match)
            if current is not None:
                sections[current] = "\n".join(buf).strip()
            current = line[2:].strip().lower()
            buf = []
        elif current is not None:
            buf.append(line)
    if current is not None:
        sections[current] = "\n".join(buf).strip()
    return sections


_cache: dict[str, ModeDefinition] = {}


def load_mode(name: str) -> ModeDefinition:
    """Load and cache the ``ModeDefinition`` for ``name`` (e.g. ``"analyst"``).

    Raises ``ValueError`` for an unknown mode or a Taxonomy section that would
    break the ``## Choosing what to do`` swap in ``agent.py``.
    """
    if name in _cache:
        return _cache[name]

    path = _MODES_DIR / f"{name}.md"
    if not path.is_file():
        raise ValueError(f"unknown analyst mode: {name!r}")

    meta, body = _parse_front_matter(path.read_text(encoding="utf-8"))
    sections = _split_h1_sections(body)

    taxonomy = sections.get("taxonomy", "")
    if taxonomy and not taxonomy.startswith("## Choosing what to do"):
        raise ValueError(
            f"mode {name!r}: the Taxonomy section must begin with "
            f"'## Choosing what to do' (it replaces that section of the core skill)."
        )

    profile = PromptProfile(
        identity=sections.get("identity", ""),
        budget_calibration=sections.get("budget calibration", ""),
        taxonomy_override=taxonomy,
    )
    mode = ModeDefinition(
        name=str(meta.get("name", name)),
        max_iterations=meta.get("max_iterations"),
        profile=profile,
    )
    _cache[name] = mode
    return mode
