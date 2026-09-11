"""API endpoints for Regression and Smoothing suite (LOESS)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.regression.loess import compute_loess
from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class LoessRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    xCol: str | None = None
    x_col: str | None = None
    yCol: str | None = None
    y_col: str | None = None
    span: float = 0.5
    degree: int = 1
    nPoints: int = 100
    rowIds: list[str] | None = None
    row_ids: list[str] | None = None


@router.post("/regression/loess")
def get_loess(req: LoessRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    x_col = req.xCol or req.x_col
    y_col = req.yCol or req.y_col
    if not x_col or not y_col:
        raise BizError("COLUMNS_REQUIRED", "xCol と yCol の両方を指定してください。")

    from ..domain.codebook_adapter import CodebookAdapter

    codebook = store.load_codebook(dataset_id) or {}
    df = store.get_dataframe(dataset_id)
    wanted_rows = req.rowIds if req.row_ids is None else req.row_ids
    if x_col in df.columns and y_col in df.columns:
        adapter = CodebookAdapter(df, codebook)
        df = df.with_columns([
            adapter.analysis_series(x_col).alias(x_col),
            adapter.analysis_series(y_col).alias(y_col),
        ])

    return compute_loess(
        df=df,
        x_col=x_col,
        y_col=y_col,
        span=req.span,
        degree=req.degree,
        n_points=req.nPoints,
        row_ids=wanted_rows,
    )
