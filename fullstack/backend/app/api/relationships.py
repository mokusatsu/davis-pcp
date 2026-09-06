"""API endpoints for Surprise-First Association Scoring (Feature 02)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.relationships.surprise import compute_phik_and_surprise
from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class SurpriseAssociationRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    columns: list[str] | None = None
    primaryMeasure: str = "phik"
    primary_measure: str | None = None
    unexpectednessMode: str = "combined"
    unexpectedness_mode: str | None = None
    wStrength: float | None = None
    w_strength: float | None = None
    wUnexpected: float | None = None
    w_unexpected: float | None = None
    maxLiftCap: float | None = None
    max_lift_cap: float | None = None


@router.post("/relationships/surprise")
def evaluate_surprise_associations(req: SurpriseAssociationRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    meta = store.get_meta(dataset_id)
    schema = meta.get("schema", [])

    measure = req.primaryMeasure or req.primary_measure or "phik"
    mode = req.unexpectednessMode or req.unexpectedness_mode or "combined"
    w_s = req.wStrength if req.w_strength is None else req.w_strength
    w_u = req.wUnexpected if req.w_unexpected is None else req.w_unexpected
    max_lift = req.maxLiftCap if req.max_lift_cap is None else req.max_lift_cap

    result = compute_phik_and_surprise(
        df=df,
        columns=req.columns,
        column_meta=schema,
        primary_measure=measure,
        unexpectedness_mode=mode,
        w_strength=w_s if w_s is not None else 0.5,
        w_unexpected=w_u if w_u is not None else 0.5,
        max_lift_cap=max_lift if max_lift is not None else 5.0,
    )
    return result
