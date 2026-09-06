"""API endpoints for Robustness & Sensitivity Analysis (Feature 03)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.robustness.engine import evaluate_robustness
from ..domain.errors import BizError
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


@router.post("/robustness/evaluate")
def run_robustness_evaluation(req: RobustnessRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
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
    return result
