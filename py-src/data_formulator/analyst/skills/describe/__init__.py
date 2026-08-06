# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""describe skill — per-chart captions for the study chat modes.

``SKILL.md`` declares the ``describe_chart`` action; ``skill.py`` exposes
``get_skill()``. The skill is auto-loaded (no ``load_skill`` step) for the
executor / analyst_guided study modes and unavailable everywhere else — see
the ``_DESCRIBE_MODES`` gate in ``analyst/agent.py``.
"""
