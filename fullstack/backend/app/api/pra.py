"""API endpoints for Penalty-Reward Analysis (Feature 05)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.pra.engine import evaluate_penalty_reward
from ..domain.errors import BizError
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


@router.post("/pra/evaluate")
def run_pra_evaluation(req: PraRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    meta = store.get_meta(dataset_id)
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
        return result
    except ValueError as e:
        raise BizError("PRA_EXECUTION_ERROR", str(e), status_code=400)
