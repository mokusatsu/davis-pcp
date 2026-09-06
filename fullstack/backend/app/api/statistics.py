"""API endpoints for advanced statistics (Covariance, Precision matrix)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.statistics.covariance import compute_covariance
from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class CovarianceRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    columns: list[str] | None = None
    rowIds: list[str] | None = None
    row_ids: list[str] | None = None


@router.post("/statistics/covariance")
def get_covariance(req: CovarianceRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    wanted_rows = req.rowIds if req.row_ids is None else req.row_ids

    return compute_covariance(
        df=df,
        columns=req.columns,
        row_ids=wanted_rows,
    )
