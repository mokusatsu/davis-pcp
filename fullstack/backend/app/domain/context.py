"""Shared AnalysisContext / ResultMeta contract (Feature 25/26).

Single canonical model for analysis requests: revision expectations, scope
resolution, weight reference, and missing-data policy. Scope presets
(all/active/selected/sampled) resolve server-side; the client passes raw
state (active/selected/sampled row ids) and the server intersects against
the dataset's current rows so stale client sets never leak across datasets.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

import polars as pl
from pydantic import BaseModel, Field, model_validator

from .errors import BizError

ScopeName = Literal["all", "active", "selected", "sampled", "explicit"]

MISSING_POLICIES = ("exclude", "include_missing", "separate_not_applicable")


class AnalysisContext(BaseModel):
    datasetId: str
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None
    scope: ScopeName = "all"
    rowIds: list[str] | None = None
    activeRowIds: list[str] | None = None
    selectedRowIds: list[str] | None = None
    sampledRowIds: list[str] | None = None
    weightColumn: str | None = None
    missingPolicy: str = "exclude"
    imputationPolicy: str = "use_current_values"
    candidateSetHash: str | None = None

    @model_validator(mode="after")
    def _check_scope(self) -> "AnalysisContext":
        if self.scope == "explicit" and not self.rowIds:
            raise ValueError("scope=explicit requires rowIds")
        if self.missingPolicy not in MISSING_POLICIES:
            raise ValueError(f"missingPolicy must be one of {MISSING_POLICIES}")
        return self


def collect_revisions(meta: dict[str, Any], codebook: dict[str, Any] | None) -> dict[str, int]:
    codebook = codebook or {}
    return {
        "schemaRevision": int(codebook.get("schemaRevision", meta.get("schemaRevision", 1))),
        "dataRevision": int(meta.get("dataRevision", 1)),
    }


def check_revisions(
    revisions: dict[str, int],
    expected_schema_revision: int | None,
    expected_data_revision: int | None,
) -> None:
    if expected_schema_revision is not None and expected_schema_revision != revisions["schemaRevision"]:
        raise BizError(
            "ANALYSIS_INPUT_STALE",
            "保存・変換のため入力の世代が更新されています。",
            status_code=409,
            details={"schemaRevision": revisions["schemaRevision"],
                     "expectedSchemaRevision": expected_schema_revision},
        )
    if expected_data_revision is not None and expected_data_revision != revisions["dataRevision"]:
        raise BizError(
            "ANALYSIS_INPUT_STALE",
            "保存・変換のため入力の世代が更新されています。",
            status_code=409,
            details={"dataRevision": revisions["dataRevision"],
                     "expectedDataRevision": expected_data_revision},
        )


def require_revisions(context: AnalysisContext) -> None:
    """Migrated routes require explicit revision expectations."""
    if context.expectedDataRevision is None or context.expectedSchemaRevision is None:
        raise BizError(
            "ANALYSIS_CONTEXT_INCOMPLETE",
            "expectedDataRevision と expectedSchemaRevision は必須です。",
            status_code=422,
        )


def scope_hash(row_ids: list[str]) -> str:
    unique_sorted = sorted(set(str(v) for v in row_ids))
    payload = json.dumps(unique_sorted, ensure_ascii=False, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def resolve_scope(
    df_row_ids: list[str],
    context: AnalysisContext,
) -> list[str]:
    """Resolve the effective row id set for a context.

    Presets intersect client state against the dataset's current rows so a
    stale or foreign rowId set can never widen the scope. Unknown ids in
    explicit mode are rejected with 422.
    """
    current = [str(v) for v in df_row_ids]
    current_set = set(current)
    if context.scope == "all":
        return list(current)
    if context.scope == "active":
        if context.activeRowIds is None:
            return list(current)
        wanted = {str(v) for v in context.activeRowIds}
        return [v for v in current if v in wanted]
    if context.scope == "selected":
        if context.selectedRowIds is None:
            raise BizError(
                "ANALYSIS_SCOPE_INCOMPLETE",
                "scope=selectedではselectedRowIdsは必須です。",
                status_code=422,
            )
        wanted = {str(v) for v in context.selectedRowIds}
        return [v for v in current if v in wanted]
    if context.scope == "sampled":
        if context.sampledRowIds is None:
            return list(current)
        wanted = {str(v) for v in context.sampledRowIds}
        return [v for v in current if v in wanted]
    # explicit
    wanted_list = [str(v) for v in (context.rowIds or [])]
    unknown = sorted(set(wanted_list) - current_set)
    if unknown:
        raise BizError(
            "ANALYSIS_SCOPE_UNKNOWN_ROW",
            "存在しないrowIdが指定されています。",
            status_code=422,
            details={"unknownRowIds": unknown[:20], "unknownCount": len(unknown)},
        )
    seen: set[str] = set()
    ordered: list[str] = []
    for value in wanted_list:
        if value not in seen:
            seen.add(value)
            ordered.append(value)
    return ordered


def build_meta(
    *,
    dataset_id: str,
    revisions: dict[str, int],
    scope: str,
    scope_ids: list[str],
    effective_n: int,
    missing_count: int,
    weight_applied: bool = False,
    weight_column: str | None = None,
    mask_revision: int | None = None,
    algorithm_version: str = "",
    is_explorative: bool = True,
    warnings: list[Any] | None = None,
) -> dict[str, Any]:
    return {
        "datasetId": dataset_id,
        "dataRevision": revisions["dataRevision"],
        "schemaRevision": revisions["schemaRevision"],
        "scope": scope,
        "scopeHash": scope_hash(scope_ids),
        "scopeCount": len(scope_ids),
        "effectiveN": effective_n,
        "missingCount": missing_count,
        "weightApplied": weight_applied,
        "weightColumn": weight_column,
        "imputationMaskRevision": mask_revision,
        "algorithmVersion": algorithm_version,
        "isExplorative": is_explorative,
        "warnings": list(warnings or []),
    }


def filter_scope_frame(df: pl.DataFrame, scope_ids: list[str]) -> pl.DataFrame:
    if "__rowId__" not in df.columns:
        return df
    wanted = set(str(v) for v in scope_ids)
    return df.filter(pl.col("__rowId__").is_in(list(wanted)))
