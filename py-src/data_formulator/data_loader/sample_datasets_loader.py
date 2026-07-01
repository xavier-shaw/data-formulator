# Copyright (c) Microsoft Corporation.
# Licensed under the MIT License.

"""Sample datasets data loader.

Exposes the built-in ``EXAMPLE_DATASETS`` catalog as a virtual data
connector that behaves exactly like any other connector.  No auth, no
external service of its own.

Each table entry declares its data source as either:
  * ``url``  — fetched on demand over HTTP from a public URL, or
  * ``path`` — a file bundled with the repo, read directly from disk
               (resolved relative to the ``data_formulator`` package dir,
               e.g. ``"example_datasets/mydata.csv"``).

A table may omit ``sample``; for a bundled ``path`` the catalog preview
(columns + first rows) is then read cheaply from the file's head.

The connector is registered unconditionally at startup so that even in
``--disable_database`` mode users still have a zero-config way to load
data and explore Data Formulator.
"""

from __future__ import annotations

import io
import json
import logging
import threading
from pathlib import Path
from typing import Any

import pandas as pd
import pyarrow as pa

from data_formulator.data_loader.external_data_loader import ExternalDataLoader
from data_formulator.data_loader import probe_utils
from data_formulator.datalake.parquet_utils import (
    df_to_safe_records,
    sanitize_dataframe_for_arrow,
)

logger = logging.getLogger(__name__)

# In-process cache for sample dataset DataFrames keyed by (source_key, format),
# where source_key is the URL or the resolved local path. These sources are
# static, so caching is safe and dramatically speeds up repeat previews/loads.
# Bounded by a soft cap; eviction is simple FIFO since access is interactive.
_SAMPLE_CACHE: dict[tuple[str, str], pd.DataFrame] = {}
_SAMPLE_CACHE_ORDER: list[tuple[str, str]] = []
_SAMPLE_CACHE_LOCK = threading.Lock()
_SAMPLE_CACHE_MAX = 64

# Base dir for datasets bundled with the repo (a table's ``path`` is resolved
# against this). Kept as the ``data_formulator`` package dir so bundled files
# ship with the package and resolve regardless of the working directory.
_BUNDLED_BASE_DIR = Path(__file__).resolve().parent.parent


def _resolve_bundled_path(rel_path: str) -> Path:
    """Resolve a table ``path`` against the package dir, refusing anything that
    escapes it (zip-slip / traversal) or is missing. Raises ``ValueError``."""
    candidate = (_BUNDLED_BASE_DIR / rel_path).resolve()
    if _BUNDLED_BASE_DIR not in candidate.parents:
        raise ValueError(f"dataset path escapes the package directory: {rel_path!r}")
    if not candidate.is_file():
        raise ValueError(f"bundled dataset file not found: {rel_path!r}")
    return candidate


class SampleDatasetsLoader(ExternalDataLoader):
    """Browse and import the built-in sample datasets."""

    # ------------------------------------------------------------------
    # Metadata
    # ------------------------------------------------------------------

    @staticmethod
    def list_params() -> list[dict[str, Any]]:
        return []

    @staticmethod
    def auth_instructions() -> str:
        return (
            "Built-in sample datasets are always available. "
            "No configuration or credentials required."
        )

    @staticmethod
    def auth_mode() -> str:
        # ``"none"`` declares that this loader needs no authentication and no
        # connection setup. The connector framework treats such loaders as
        # always-on: they cannot be connected/disconnected, expose no
        # credentials UI, and are always reported as ``connected: true``.
        return "none"

    @staticmethod
    def auth_config() -> dict:
        # Mirror :meth:`auth_mode` for the modern auth interface. The base
        # class defaults ``auth_config`` to ``{"mode": "credentials"}``
        # independently of ``auth_mode``, and ``_loader_auth_mode`` prefers
        # ``auth_config``. Without this override the no-auth loader would be
        # mis-classified as credential-based, breaking catalog/preview/import
        # (which require a connection) whenever no loader was eagerly cached
        # — e.g. in ephemeral / ``--disable-data-connectors`` deployments.
        return {"mode": "none"}

    @staticmethod
    def catalog_hierarchy() -> list[dict[str, str]]:
        return [
            {"key": "dataset", "label": "Dataset"},
            {"key": "table", "label": "Table"},
        ]

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def __init__(self, params: dict[str, Any] | None = None):
        self.params = params or {}

    def test_connection(self) -> bool:
        return True

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _datasets(self) -> list[dict[str, Any]]:
        from data_formulator.example_datasets_config import EXAMPLE_DATASETS
        return EXAMPLE_DATASETS

    @staticmethod
    def _table_stem(table_entry: dict[str, Any], idx: int) -> str:
        # Derive the table name from the file name of either the url or path.
        ref = table_entry.get("url") or table_entry.get("path") or ""
        last = ref.replace("\\", "/").split("/")[-1].split("?")[0]
        stem = last.rsplit(".", 1)[0] if "." in last else last
        return stem or f"table_{idx}"

    def _columns_from_sample(self, sample: Any, fmt: str) -> tuple[list[dict], list[dict]]:
        """Infer ``(columns, sample_rows)`` from an embedded preview payload."""
        columns: list[dict] = []
        sample_rows: list[dict] = []
        if isinstance(sample, list) and sample:
            first = sample[0] if isinstance(sample[0], dict) else {}
            for name, value in first.items():
                ctype = type(value).__name__ if value is not None else "string"
                columns.append({"name": str(name), "type": ctype})
            sample_rows = [r for r in sample[:10] if isinstance(r, dict)]
        elif isinstance(sample, str) and sample.strip():
            sep = "," if (fmt or "csv").lower() == "csv" else "\t"
            try:
                df = pd.read_csv(io.StringIO(sample.strip()), sep=sep)
                columns = [
                    {"name": str(c), "type": str(df[c].dtype)}
                    for c in df.columns
                ]
                sample_rows = df_to_safe_records(df.head(10))
            except Exception:
                logger.debug("Failed to parse sample CSV preview", exc_info=True)
        return columns, sample_rows

    def _columns_from_local_head(
        self, path: Path, fmt: str, n: int = 10
    ) -> tuple[list[dict], list[dict]]:
        """Infer ``(columns, sample_rows)`` from the head of a bundled file.

        Cheap even for large files: only the first ``n`` rows are parsed for
        csv/tsv. For json the file is loaded once (cached) and sliced.
        """
        try:
            if fmt == "csv":
                df = pd.read_csv(path, nrows=n)
            elif fmt == "tsv":
                df = pd.read_csv(path, sep="\t", nrows=n)
            else:
                df = self._load_local_dataframe(path, fmt).head(n)
            columns = [{"name": str(c), "type": str(df[c].dtype)} for c in df.columns]
            return columns, df_to_safe_records(df.head(n))
        except Exception:
            logger.debug("Failed to read local dataset head: %s", path, exc_info=True)
            return [], []

    def _preview(self, t: dict[str, Any], fmt: str) -> tuple[list[dict], list[dict]]:
        """Return ``(columns, sample_rows)`` for the catalog: from an embedded
        ``sample`` when present, else from the head of a bundled ``path``."""
        if t.get("sample") is not None:
            return self._columns_from_sample(t.get("sample"), fmt)
        path = t.get("path")
        if path:
            try:
                return self._columns_from_local_head(_resolve_bundled_path(path), fmt)
            except ValueError:
                logger.warning("Bundled dataset path unavailable for preview: %r", path)
        return [], []

    def _resolve(self, source_table: str) -> tuple[dict, dict, int] | None:
        """Look up ``(dataset, table_entry, table_idx)`` by ``"Dataset/stem"``.

        Also accepts the bare dataset name when the dataset has a single
        table, for convenience.
        """
        if not source_table:
            return None
        parts = source_table.split("/", 1)
        ds_name = parts[0]
        wanted_stem = parts[1] if len(parts) == 2 else None
        for ds in self._datasets():
            if ds.get("name") != ds_name:
                continue
            tables = ds.get("tables", []) or []
            if wanted_stem is None and len(tables) == 1:
                return ds, tables[0], 0
            for idx, t in enumerate(tables):
                if self._table_stem(t, idx) == wanted_stem:
                    return ds, t, idx
        return None

    # ------------------------------------------------------------------
    # Catalog
    # ------------------------------------------------------------------

    def list_tables(self, table_filter: str | None = None) -> list[dict[str, Any]]:
        needle = (table_filter or "").strip().lower()
        results: list[dict[str, Any]] = []
        for ds in self._datasets():
            ds_name = ds["name"]
            desc = ds.get("description", "") or ""
            tables = ds.get("tables", []) or []
            # Collapse single-table datasets to a single top-level entry so the
            # sidebar doesn't render dozens of folders containing one child.
            # Multi-table datasets keep the 2-level (dataset / table) hierarchy.
            collapse = len(tables) == 1
            for idx, t in enumerate(tables):
                stem = self._table_stem(t, idx)
                if collapse:
                    source_id = ds_name
                    path = [ds_name]
                else:
                    source_id = f"{ds_name}/{stem}"
                    path = [ds_name, stem]
                if needle and needle not in source_id.lower() and needle not in desc.lower():
                    continue
                fmt = (t.get("format") or "json").lower()
                columns, sample_rows = self._preview(t, fmt)
                results.append({
                    "name": source_id,
                    "table_key": source_id,
                    "path": path,
                    "metadata": {
                        "description": desc,
                        "columns": columns,
                        "sample_rows": sample_rows,
                        "row_count": None,
                        "_source_name": source_id,
                        "_format": fmt,
                        "_url": t.get("url", ""),
                        "_path": t.get("path", ""),
                        "_live": bool(ds.get("live", False)),
                        "_refresh_interval_seconds": ds.get("refreshIntervalSeconds"),
                    },
                })
        return results

    def get_column_types(self, source_table: str) -> dict[str, Any]:
        resolved = self._resolve(source_table)
        if not resolved:
            return {}
        ds, t, _ = resolved
        fmt = (t.get("format") or "json").lower()
        columns, _rows = self._preview(t, fmt)
        return {
            "columns": columns,
            "description": ds.get("description", ""),
        }

    # ------------------------------------------------------------------
    # Data fetch
    # ------------------------------------------------------------------

    def fetch_data_as_arrow(
        self,
        source_table: str,
        import_options: dict[str, Any] | None = None,
    ) -> pa.Table:
        resolved = self._resolve(source_table)
        if not resolved:
            raise ValueError(f"Unknown sample table: {source_table!r}")
        _ds, t, _idx = resolved
        fmt = (t.get("format") or "json").lower()
        path = t.get("path")
        url = t.get("url", "")

        if path:
            df = self._load_local_dataframe(_resolve_bundled_path(path), fmt)
        elif url:
            df = self._load_full_dataframe(url, fmt, source_table)
        else:
            raise ValueError(
                f"Sample table {source_table!r} has neither 'path' nor 'url' configured"
            )

        # Capture the true total BEFORE any slicing so callers can report
        # the real row count even when ``size`` truncates the preview.
        self._last_total_rows = len(df)

        opts = import_options or {}
        size = opts.get("size")
        if isinstance(size, int) and size > 0 and len(df) > size:
            df = df.head(size)

        logger.info("Returning %d / %d rows from sample dataset: %s",
                    len(df), self._last_total_rows, source_table)
        # Public sample JSON/CSV files frequently contain mixed-type object
        # columns (e.g. movies.json's ``Title`` holds both strings and
        # numeric values), which makes ``pa.Table.from_pandas`` raise
        # ArrowTypeError. Coerce such columns to a consistent type first.
        return pa.Table.from_pandas(
            sanitize_dataframe_for_arrow(df), preserve_index=False
        )

    def probe(self, path: list[str], query: dict[str, Any]) -> dict[str, Any]:
        """Read the sample file into DuckDB and compute the SPJQ there."""
        # Sample tables are addressed as ``"Dataset/stem"`` (slash-joined),
        # not dotted, so build the identifier ``_resolve`` expects.
        source_table = "/".join(str(p) for p in path if p not in (None, ""))
        return probe_utils.run_probe_on_duckdb(
            self, path, query, source_table=source_table,
        )

    # ------------------------------------------------------------------
    # Internal: cached full-dataset fetch
    # ------------------------------------------------------------------

    def _parse_text(self, text: str, fmt: str) -> pd.DataFrame:
        """Parse raw file/response text into a DataFrame by format."""
        if fmt == "csv":
            return pd.read_csv(io.StringIO(text))
        if fmt == "tsv":
            return pd.read_csv(io.StringIO(text), sep="\t")
        payload = json.loads(text)
        if isinstance(payload, dict):
            # Common JSON shapes: {data: [...]}, {rows: [...]}, or a single record
            for k in ("data", "rows", "records", "items"):
                if isinstance(payload.get(k), list):
                    payload = payload[k]
                    break
            else:
                payload = [payload]
        return pd.DataFrame(payload)

    def _cache_get_or_set(self, key: tuple[str, str], produce) -> pd.DataFrame:
        """Return a cached DataFrame for ``key`` or produce, cache, and return it.

        Returns a shallow copy so downstream slicing (``.head(size)``) doesn't
        mutate views the cache might re-emit later.
        """
        with _SAMPLE_CACHE_LOCK:
            cached = _SAMPLE_CACHE.get(key)
        if cached is not None:
            return cached.copy(deep=False)

        df = produce()

        with _SAMPLE_CACHE_LOCK:
            if key not in _SAMPLE_CACHE:
                _SAMPLE_CACHE[key] = df
                _SAMPLE_CACHE_ORDER.append(key)
                while len(_SAMPLE_CACHE_ORDER) > _SAMPLE_CACHE_MAX:
                    evict = _SAMPLE_CACHE_ORDER.pop(0)
                    _SAMPLE_CACHE.pop(evict, None)
        return df.copy(deep=False)

    def _load_full_dataframe(self, url: str, fmt: str, source_table: str) -> pd.DataFrame:
        """Return the full parsed DataFrame for a sample dataset URL (cached)."""
        def produce() -> pd.DataFrame:
            import requests
            logger.info("Fetching sample dataset over network: %s (%s)", source_table, url)
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            return self._parse_text(resp.text, fmt)

        return self._cache_get_or_set((url, fmt), produce)

    def _load_local_dataframe(self, path: Path, fmt: str) -> pd.DataFrame:
        """Return the full parsed DataFrame for a bundled local file (cached)."""
        def produce() -> pd.DataFrame:
            logger.info("Reading bundled sample dataset: %s (%s)", path, fmt)
            if fmt == "csv":
                return pd.read_csv(path)
            if fmt == "tsv":
                return pd.read_csv(path, sep="\t")
            return self._parse_text(path.read_text(encoding="utf-8"), fmt)

        return self._cache_get_or_set((str(path), fmt), produce)
