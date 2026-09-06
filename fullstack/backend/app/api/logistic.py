"""Logistic Regression API (Feature 12)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..algorithms.models.logistic import run_logistic_regression
from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class LogisticRequestSchema(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    targetColumn: str | None = None
    target_column: str | None = None
    featureColumns: list[str] | None = None
    feature_columns: list[str] | None = None
    activeRowIds: list[str] | None = None
    active_row_ids: list[str] | None = None
    intercept: bool = True
    regularization: str = "none"
    cValue: float = 1.0
    cutoff: float = Field(0.5, ge=0.0, le=1.0)


@router.post("/models/logistic")
def fit_logistic(req: LogisticRequestSchema) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    target_column = req.targetColumn or req.target_column
    if not target_column:
        raise BizError("LOGISTIC_TARGET_REQUIRED", "targetColumn は必須です。")

    feature_columns = req.featureColumns or req.feature_columns
    if not feature_columns:
        raise BizError("LOGISTIC_FEATURES_REQUIRED", "featureColumns は必須です。")

    active_rows = req.activeRowIds or req.active_row_ids
    df = store.get_dataframe(dataset_id)

    return run_logistic_regression(
        df=df,
        target_column=target_column,
        feature_columns=feature_columns,
        active_row_ids=active_rows,
        intercept=req.intercept,
        regularization=req.regularization,
        c_value=req.cValue,
        cutoff=req.cutoff,
    )
