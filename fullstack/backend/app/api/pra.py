"""API endpoints for Penalty-Reward Analysis (Feature 05)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.pra.engine import evaluate_penalty_reward
from ..domain.errors import BizError
from ..domain.context import (
    check_revisions, collect_revisions, filter_scope_frame, resolve_row_ids, scope_hash,
)
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class PraRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    outcome: str
    attributes: list[str] | None = None
    scaleMin: float | None = None
    scale_min: float | None = None
    scaleMax: float | None = None
    scale_max: float | None = None
    neutralPoint: float | None = None
    neutral_point: float | None = None
    alpha: float = 0.05
    rowIds: list[str] | None = None
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


@router.post("/pra/evaluate")
def run_pra_evaluation(req: PraRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        revisions = collect_revisions(meta, store.load_codebook(dataset_id))
        check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        df = store.get_dataframe(dataset_id)
        scope_ids = resolve_row_ids(df, dataset_id, req.rowIds)
        df = filter_scope_frame(df, scope_ids)
    if df.height == 0:
        raise BizError("EMPTY_ANALYSIS_INPUT", "対象データ行が0件です。", status_code=422)
    schema = meta.get("schema", [])

    s_min = req.scaleMin if req.scale_min is None else req.scale_min
    s_max = req.scaleMax if req.scale_max is None else req.scale_max
    neutral = req.neutralPoint if req.neutral_point is None else req.neutral_point

    try:
        result = evaluate_penalty_reward(
            df=df,
            outcome=req.outcome,
            attributes=req.attributes,
            column_meta=schema,
            scale_min=s_min,
            scale_max=s_max,
            neutral_point=neutral,
            alpha=req.alpha,
        )
        return {**result, "datasetId": dataset_id, **revisions,
                "scopeHash": scope_hash(scope_ids), "scopeCount": len(scope_ids)}
    except ValueError as e:
        raise BizError("PRA_EXECUTION_ERROR", str(e), status_code=400)
