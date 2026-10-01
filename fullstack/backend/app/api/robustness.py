"""API endpoints for Robustness & Sensitivity Analysis (Feature 03)."""
from __future__ import annotations

from typing import Any, Literal
from fastapi import APIRouter
from pydantic import BaseModel
import polars as pl

from ..algorithms.robustness.engine import evaluate_robustness
from ..algorithms.robustness.sensitivity import run_sensitivity_analysis
from ..domain.errors import BizError
from ..domain.context import filter_scope_frame, resolve_row_ids
from ..domain.weight_unsupported import weight_unsupported_block
from .multi_response import _check_revisions, _collect_revisions, _scope_hash
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class RobustnessRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    conclusions: list[dict[str, Any]] | None = None
    removalFractions: list[float] | None = None
    removal_fractions: list[float] | None = None
    bootstrapB: int | None = None
    bootstrap_b: int | None = None
    topInfluenceCount: int | None = None
    top_influence_count: int | None = None
    qualityCol: str | None = None
    quality_col: str | None = None
    rowIds: list[str] | None = None
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


@router.post("/robustness/evaluate")
def run_robustness_evaluation(req: RobustnessRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        revisions = _collect_revisions(meta, store.load_codebook(dataset_id) or {})
        _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        df = store.get_dataframe(dataset_id)
        scope_ids = resolve_row_ids(df, dataset_id, req.rowIds)
        df = filter_scope_frame(df, scope_ids)
    if df.height == 0:
        raise BizError("EMPTY_ANALYSIS_INPUT", "対象データ行が0件です。", status_code=422)
    fractions = req.removalFractions if req.removal_fractions is None else req.removal_fractions
    b_count = req.bootstrapB if req.bootstrap_b is None else req.bootstrap_b
    top_n = req.topInfluenceCount if req.top_influence_count is None else req.top_influence_count
    q_col = req.qualityCol or req.quality_col

    result = evaluate_robustness(
        df=df,
        conclusions=req.conclusions,
        removal_fractions=fractions,
        bootstrap_b=b_count if b_count is not None else 100,
        top_influence_count=top_n if top_n is not None else 10,
        quality_col=q_col,
    )
    return {**result, "datasetId": dataset_id, **revisions,
            "scopeHash": _scope_hash(scope_ids), "scopeCount": len(scope_ids)}


class SensitivityCandidate(BaseModel):
    type: str = "subgroup_diff"
    groupColumn: str | None = None
    compareGroups: list[str] | None = None
    rowIds: list[str] | None = None


class SensitivityRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    targetColumn: str | None = None
    target_column: str | None = None
    candidate: SensitivityCandidate | None = None
    outlierMethod: str = "standardized_deviation"
    threshold: float = 3.0
    scopeRowIds: list[str] | None = None
    bootstrapB: int = 200
    seed: int = 42
    weightColumn: str | None = None
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None


@router.post("/robustness/sensitivity")
def run_sensitivity(req: SensitivityRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")
    target = req.targetColumn if req.target_column is None else req.target_column
    if not target:
        raise BizError("SENSITIVITY_COLUMN_MISSING", "対象列を指定してください。",
                       status_code=422)
    candidate = req.candidate or SensitivityCandidate()
    if candidate.type not in ("kpi", "subgroup_diff"):
        raise BizError("SENSITIVITY_CONFIG_INVALID", "candidate.typeはkpi/subgroup_diffです。",
                       status_code=422)
    if candidate.type == "subgroup_diff" and (
            not candidate.groupColumn or not candidate.compareGroups
            or len(candidate.compareGroups) < 2) and not candidate.rowIds:
        raise BizError("SENSITIVITY_CONFIG_INVALID",
                       "subgroup_diffにはgroupColumnと比較群(compareGroups 2件以上)が必要です。",
                       status_code=422)
    if (req.outlierMethod or "standardized_deviation") != "standardized_deviation":
        raise BizError("SENSITIVITY_CONFIG_INVALID", "outlierMethodはstandardized_deviationです。",
                       status_code=422)

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = _collect_revisions(meta, codebook)
        _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        weight = weight_unsupported_block(codebook, req.weightColumn)
        from ..domain.codebook_adapter import CodebookAdapter

        df = store.get_dataframe(dataset_id)
        # Candidate membership is separate from the analysis population. Resolve
        # the latter before excluding invalid values so unknown IDs still fail.
        scope_ids = resolve_row_ids(df, dataset_id, req.scopeRowIds)
        df = filter_scope_frame(df, scope_ids)
        try:
            adapter = CodebookAdapter(df, codebook)
            analysis = adapter.analysis_series(target)
            # analysis_series yields scores with missing/invalid as null; keep only
            # valid rows so baseline/sensitivity work on the analysis population.
            df = df.with_columns(analysis).filter(pl.col(target).is_not_null())
        except Exception:
            pass
        scope_hash = _scope_hash(df["__rowId__"].to_list())
        if df.height == 0:
            raise BizError("EMPTY_ANALYSIS_INPUT", "対象データ行が0件です。", status_code=422)
        group_column = candidate.groupColumn
        compare = candidate.compareGroups
        if candidate.rowIds:
            membership = {str(v) for v in candidate.rowIds}
            target_ids = [str(v) for v in df["__rowId__"].to_list()] if "__rowId__" in df.columns else []
            in_ids = sorted(v for v in target_ids if v in membership)
            out_ids = sorted(v for v in target_ids if v not in membership)
            if not in_ids or not out_ids:
                raise BizError("SENSITIVITY_CONFIG_INVALID",
                               "candidate.rowIdsでは対象群と補集合の両方に回答者が必要です。",
                               status_code=422)
            marker = "__sensitivity_candidate__"
            mapping = {v: "candidate" for v in in_ids} | {v: "complement" for v in out_ids}
            df = df.with_columns(
                pl.col("__rowId__").cast(pl.String).replace(mapping, default=None).alias(marker)
            )
            group_column = marker
            compare = ["candidate", "complement"]
        result = run_sensitivity_analysis(
            df=df,
            target_column=target,
            group_column=group_column,
            compare_groups=compare,
            row_ids=None,
            threshold=req.threshold if req.threshold is not None else 3.0,
            seed=req.seed if req.seed is not None else 42,
            scope_hash=scope_hash,
            bootstrap_b=req.bootstrapB,
        )
        return {"datasetId": dataset_id, **revisions, "scopeHash": scope_hash,
                "scopeCount": df.height, **weight, **result}
