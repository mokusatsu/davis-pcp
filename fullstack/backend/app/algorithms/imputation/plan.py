"""Explicit imputation plan shared by preview and apply (IMPUTE-03 / E04).

The audit found that preview imputed a single column while apply imputed the
whole selection, so the two built different feature matrices and produced
different values for the same settings.  An imputation is now described by an
``ImputationPlan``: the explicit list of columns that get values written back
(*targets*) and the explicit list of columns that condition them
(*predictors*).  Preview and apply both build the plan from the same request,
so their values agree by construction.

Predictors default to "every other usable column", which is what makes
conditional imputation actually conditional.  A target is never its own
predictor — that was the audit finding itself, and it is rejected outright.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

import polars as pl
from pydantic import BaseModel, Field

from ...domain.errors import BizError

NUMERIC_DTYPES = (
    pl.Float32, pl.Float64,
    pl.Int8, pl.Int16, pl.Int32, pl.Int64,
    pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64,
)

ROW_ID_COLUMN = "__rowId__"

# Reasons recorded in ``excludedColumns``.  Only categorical is a *warning*;
# the rest are structural (a target cannot condition itself) or silently
# ineligible (the row id carries no signal).
REASON_CATEGORICAL = "PREDICTOR_CATEGORICAL_IGNORED"
REASON_TARGET = "PREDICTOR_IS_TARGET"
REASON_MULTI_RESPONSE = "PREDICTOR_MULTI_RESPONSE_EXCLUDED"
REASON_WEIGHT = "PREDICTOR_WEIGHT_EXCLUDED"


class ExcludedColumn(BaseModel):
    column: str
    columnId: str | None = None
    reason: str


class ImputationPlan(BaseModel):
    datasetId: str
    dataRevision: int
    targetColumns: list[str]
    predictorColumns: list[str]
    excludedColumns: list[ExcludedColumn] = Field(default_factory=list)
    strategy: str
    options: dict[str, Any] = Field(default_factory=dict)
    seed: int = 42
    planHash: str = ""


def is_numeric_dtype(dtype: Any) -> bool:
    return dtype in NUMERIC_DTYPES


def canonical_json(payload: Any) -> str:
    """Stable serialization: sorted keys, no incidental whitespace."""
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def compute_plan_hash(
    dataset_id: str,
    data_revision: int,
    target_columns: list[str],
    predictor_columns: list[str],
    strategy: str,
    options: dict[str, Any] | None,
    seed: int,
) -> str:
    payload = canonical_json({
        "datasetId": dataset_id,
        "dataRevision": int(data_revision),
        "targetColumns": list(target_columns),
        "predictorColumns": list(predictor_columns),
        "strategy": strategy,
        "options": options or {},
        "seed": int(seed),
    })
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def codebook_specs(codebook: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    specs: dict[str, dict[str, Any]] = {}
    for spec in (codebook or {}).get("columns", []) or []:
        if isinstance(spec, dict) and isinstance(spec.get("name"), str):
            specs[spec["name"]] = spec
    return specs


def _data_columns(df: pl.DataFrame) -> list[str]:
    return [c for c in df.columns if c != ROW_ID_COLUMN]


def default_predictors(
    df: pl.DataFrame,
    codebook: dict[str, Any] | None,
    target_columns: list[str],
) -> tuple[list[str], list[ExcludedColumn]]:
    """Every column that can carry signal for ``target_columns``.

    Excludes the targets themselves, the row id, multi-response members (their
    coding is a group-level construct) and survey/sampling weight columns
    (a design variable, not a respondent attribute).  The refusals are
    reported so the response explains the feature set it actually used.
    """
    specs = codebook_specs(codebook)
    targets = set(target_columns)
    chosen: list[str] = []
    excluded: list[ExcludedColumn] = []
    for name in _data_columns(df):
        if name in targets:
            continue
        spec = specs.get(name) or {}
        if spec.get("multiResponseGroup"):
            excluded.append(ExcludedColumn(column=name, columnId=spec.get("columnId"),
                                           reason=REASON_MULTI_RESPONSE))
            continue
        if spec.get("role") == "weight":
            excluded.append(ExcludedColumn(column=name, columnId=spec.get("columnId"),
                                           reason=REASON_WEIGHT))
            continue
        chosen.append(name)
    return chosen, excluded


def build_imputation_plan(
    df: pl.DataFrame,
    codebook: dict[str, Any] | None = None,
    target_columns: list[str] | None = None,
    predictor_columns: list[str] | None = None,
    strategy: str = "tabdiff",
    options: dict[str, Any] | None = None,
    *,
    dataset_id: str = "",
    data_revision: int = 1,
) -> ImputationPlan:
    """Resolve a request into a concrete, hashable plan.

    Raises ``IMPUTATION_NO_COLUMNS`` when no target survives, and
    ``IMPUTATION_SELF_PREDICTOR`` / ``IMPUTATION_PREDICTOR_NOT_FOUND`` (both
    422) on an inconsistent predictor list.
    """
    opts = dict(options or {})
    seed = int(opts.get("seed", 42))
    specs = codebook_specs(codebook)
    order = _data_columns(df)
    order_set = set(order)

    requested_targets = order if target_columns is None else [c for c in target_columns]
    unknown_targets = [c for c in requested_targets if c not in order_set]
    if unknown_targets:
        raise BizError("COLUMN_NOT_FOUND",
                       f"列 '{unknown_targets[0]}' が見つかりません。", status_code=422)
    target_set = set(requested_targets)
    # Dataset column order keeps the hash — and therefore the values — stable
    # no matter what order the caller listed the columns in.
    targets = [c for c in order if c in target_set]
    if not targets:
        raise BizError("IMPUTATION_NO_COLUMNS", "補完対象の列が指定されていないか、存在しません。")

    excluded: list[ExcludedColumn] = []
    if predictor_columns is None:
        candidates, excluded = default_predictors(df, codebook, targets)
    else:
        unknown = [c for c in predictor_columns if c not in order_set]
        if unknown:
            raise BizError("IMPUTATION_PREDICTOR_NOT_FOUND",
                           f"説明変数 '{unknown[0]}' が見つかりません。", status_code=422)
        self_predictors = [c for c in predictor_columns if c in target_set]
        if self_predictors:
            raise BizError(
                "IMPUTATION_SELF_PREDICTOR",
                f"補完対象の列 '{self_predictors[0]}' を説明変数には指定できません。",
                status_code=422,
            )
        candidates = list(dict.fromkeys(predictor_columns))

    predictors: list[str] = []
    for name in candidates:
        column_id = (specs.get(name) or {}).get("columnId")
        if name in target_set:
            # Only reachable through the default list; a request that names a
            # target as a predictor is rejected above.
            excluded.append(ExcludedColumn(column=name, columnId=column_id, reason=REASON_TARGET))
            continue
        if not is_numeric_dtype(df.schema[name]):
            excluded.append(ExcludedColumn(column=name, columnId=column_id, reason=REASON_CATEGORICAL))
            continue
        predictors.append(name)
    predictors = [c for c in order if c in set(predictors)]

    plan_hash = compute_plan_hash(dataset_id, data_revision, targets, predictors,
                                  strategy, opts, seed)
    return ImputationPlan(
        datasetId=dataset_id,
        dataRevision=int(data_revision),
        targetColumns=targets,
        predictorColumns=predictors,
        excludedColumns=excluded,
        strategy=strategy,
        options=opts,
        seed=seed,
        planHash=plan_hash,
    )


def conditioning_columns(plan: ImputationPlan, df: pl.DataFrame) -> list[str]:
    """Feature columns of the diffusion: predictors plus numeric targets.

    Kept in dataset column order so the covariance matrix — and therefore the
    generated values — does not depend on how the request listed the columns.
    """
    wanted = set(plan.predictorColumns)
    for name in plan.targetColumns:
        if name in df.columns and is_numeric_dtype(df.schema[name]):
            wanted.add(name)
    return [c for c in _data_columns(df) if c in wanted]


def plan_warnings(plan: ImputationPlan, df: pl.DataFrame) -> list[dict[str, str]]:
    warnings: list[dict[str, str]] = []
    ignored = [e.column for e in plan.excludedColumns if e.reason == REASON_CATEGORICAL]
    if ignored:
        warnings.append({
            "code": REASON_CATEGORICAL,
            "message": "非数値の列は条件付けに使えないため説明変数から除外しました: "
                       + ", ".join(ignored),
        })
    if plan.strategy == "tabdiff":
        cat_targets = [c for c in plan.targetColumns if c in df.columns and not is_numeric_dtype(df.schema[c])]
        if cat_targets:
            warnings.append({
                "code": "CATEGORICAL_CONDITIONAL_NOT_APPLIED",
                "message": "カテゴリ列は条件付き補完の対象外です（最頻値／多項サンプルで補完）: "
                           + ", ".join(cat_targets),
            })
    return warnings
