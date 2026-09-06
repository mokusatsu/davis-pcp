"""API endpoints for Distribution suite (FEDF, etc.)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.distribution.fedf import compute_fedf
from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class FedfRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    columns: list[str] | None = None
    mode: str = "standard"
    gridSize: int = 100
    rowIds: list[str] | None = None
    row_ids: list[str] | None = None


@router.post("/distribution/fedf")
def get_fedf(req: FedfRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    wanted_rows = req.rowIds if req.row_ids is None else req.row_ids
    return compute_fedf(
        df=df,
        columns=req.columns,
        mode=req.mode,
        grid_size=req.gridSize,
        row_ids=wanted_rows,
    )
