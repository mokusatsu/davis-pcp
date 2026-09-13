"""Common result envelope helpers for Features 029-034 (production, CA slice)."""
from __future__ import annotations

import hashlib
import json
import platform
import uuid
from typing import Any

import numpy as np
import polars as pl


def new_result_id() -> str:
    return str(uuid.uuid4())


def model_fingerprint(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":"), allow_nan=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def numerical_runtime(engine: str = "local") -> dict[str, Any]:
    versions: dict[str, Any] = {"engine": engine, "platform": platform.platform(), "blas": None}
    for name in ("numpy", "scipy", "polars", "pydantic"):
        try:
            module = __import__(name)
            versions[name] = getattr(module, "__version__", None) or getattr(module, "VERSION", None)
        except Exception:
            versions[name] = None
    try:
        import scipy  # noqa: F401
        versions["python"] = platform.python_version()
    except Exception:
        versions["python"] = None
    return versions


def check_json_finite(payload: Any) -> None:
    if isinstance(payload, dict):
        for value in payload.values():
            check_json_finite(value)
    elif isinstance(payload, (list, tuple)):
        for value in payload:
            check_json_finite(value)
    elif isinstance(payload, float):
        if payload != payload or payload in (float("inf"), float("-inf")):
            raise ValueError("non-finite JSON value")


def escape_formula_prefix(value: str) -> str:
    if value and value[0] in ("=", "+", "-", "@", "\t", "\r", "\n"):
        return "'" + value
    return value


def build_meta(
    *,
    dataset_id: str,
    revisions: dict[str, int],
    snapshot_fingerprint: str | None,
    scope: str,
    scope_ids: list[str],
    fit_count: int,
    exclusion_counts: dict[str, int],
    analysis_unit: str,
    weight_applied: bool,
    weight_type: str | None,
    weight_column: str | None,
    sum_weights: float | None,
    kish_effective_n: float | None,
    frequency_n: float | None,
    imputed_cell_count: int = 0,
    imputed_row_count: int = 0,
    mask_revision: int | None,
    fingerprint: str,
    algorithm_version: str,
    engine: str = "local",
    warnings: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    from ..domain.context import scope_hash

    excluded = int(sum(exclusion_counts.get(k, 0) for k in
                       ("invalid", "missing", "missing_weight", "zero_weight",
                        "structural_task_exclusion")))
    return {
        "datasetId": dataset_id,
        "dataRevision": revisions["dataRevision"],
        "schemaRevision": revisions["schemaRevision"],
        "maskRevision": mask_revision,
        "currentDataRevision": revisions["dataRevision"],
        "currentSchemaRevision": revisions["schemaRevision"],
        "resultState": "current",
        "scope": scope,
        "scopeHash": scope_hash(scope_ids),
        "scopeCount": len(scope_ids),
        "fitCount": fit_count,
        "effectiveN": fit_count,
        "excludedCount": excluded,
        "exclusionCounts": {k: int(exclusion_counts.get(k, 0)) for k in
                            ("invalid", "missing", "missing_weight", "zero_weight",
                             "structural_task_exclusion")},
        "analysisUnit": analysis_unit,
        "weightApplied": bool(weight_applied),
        "weightType": weight_type,
        "weightColumn": weight_column,
        "sumWeights": sum_weights,
        "kishEffectiveN": kish_effective_n,
        "frequencyN": frequency_n,
        "imputedCellCount": imputed_cell_count,
        "imputedRowCount": imputed_row_count,
        "modelFingerprint": fingerprint,
        "snapshotFingerprint": snapshot_fingerprint,
        "algorithmVersion": algorithm_version,
        "numericalRuntime": numerical_runtime(engine),
        "isExplorative": True,
        "warnings": list(warnings or []),
        "runtimeCapabilities": {"resultPersistence": "workspace", "logicalCancel": True,
                                "hardCancel": False},
    }
