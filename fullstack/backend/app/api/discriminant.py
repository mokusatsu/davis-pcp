"""Discriminant Analysis API (Feature 13)."""
from __future__ import annotations

from typing import Any, Union
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.models.discriminant import run_discriminant_analysis
from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class StepwiseConfigSchema(BaseModel):
    fEnter: float = 3.84
    fRemove: float = 2.71
    maxSteps: int = 20


class DiscriminantRequestSchema(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    targetColumn: str | None = None
    target_column: str | None = None
    featureColumns: list[str] | None = None
    feature_columns: list[str] | None = None
    activeRowIds: list[str] | None = None
    active_row_ids: list[str] | None = None
    method: str = "lda"  # 'lda' | 'qda' | 'stepwise'
    shrinkage: Union[str, float] = "none"
    priors: str = "proportional"
    stepwiseConfig: StepwiseConfigSchema | None = None


@router.post("/models/discriminant")
def fit_discriminant(req: DiscriminantRequestSchema) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    target_column = req.targetColumn or req.target_column
    if not target_column:
        raise BizError("DISCRIMINANT_TARGET_REQUIRED", "targetColumn は必須です。")

    feature_columns = req.featureColumns or req.feature_columns
    if not feature_columns:
        raise BizError("DISCRIMINANT_FEATURES_REQUIRED", "featureColumns は必須です。")

    active_rows = req.activeRowIds or req.active_row_ids
    df = store.get_dataframe(dataset_id)

    stepwise_dict = req.stepwiseConfig.model_dump() if req.stepwiseConfig else None

    return run_discriminant_analysis(
        df=df,
        target_column=target_column,
        feature_columns=feature_columns,
        active_row_ids=active_rows,
        method=req.method,
        shrinkage=req.shrinkage,
        priors=req.priors,
        stepwise_config=stepwise_dict,
    )
