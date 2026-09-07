"""Summaries API with fingerprint-based caching."""
from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.summaries.core import correlation_matrix_df, summarize
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()
_cache: dict[tuple, dict] = {}


class SummaryRequest(BaseModel):
    datasetId: str
    rowIds: list[str] | None = None
    columns: list[str] | None = None
    correlation: bool = False


@router.post("/summaries")
def summaries(req: SummaryRequest) -> dict:
    meta = store.get_meta(req.datasetId)
    df = store.get_dataframe(req.datasetId)
    column_types = {c["name"]: c["semanticType"] for c in meta["schema"]}
    if req.rowIds is not None:
        wanted = set(req.rowIds)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))
    columns = req.columns or [c for c in df.columns if c != "__rowId__"]
    row_ids_key = tuple(sorted(req.rowIds)) if req.rowIds is not None else None
    key = (req.datasetId, row_ids_key,
           tuple(sorted(columns)), req.correlation, meta["fingerprint"])
    if key in _cache:
        return {**_cache[key], "cacheHit": True}
    subset = df.select([c for c in columns if c in df.columns])
    payload = {
        "datasetId": req.datasetId,
        "fingerprint": meta["fingerprint"],
        "rowCount": subset.height,
        "columns": summarize(subset, {k: v for k, v in column_types.items() if k in set(columns)}),
        "evidenceClass": "MODERN-EXTENSION",
    }
    if req.correlation:
        numeric_cols = [c for c in columns if column_types.get(c) == "numeric"]
        payload["correlation"] = {"columns": numeric_cols, "matrix": correlation_matrix_df(subset, numeric_cols)}
    _cache[key] = payload
    if len(_cache) > 200:
        _cache.pop(next(iter(_cache)))
    return payload


class QQPlotRequest(BaseModel):
    datasetId: str
    column: str
    plottingPosition: str = "blom"
    rowIds: list[str] | None = None


@router.post("/summaries/qqplot")
def qqplot_summary(req: QQPlotRequest) -> dict:
    from ..algorithms.summaries.qqplot import compute_qqplot
    df = store.get_dataframe(req.datasetId)
    if req.rowIds is not None:
        wanted = set(req.rowIds)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))
    return compute_qqplot(df, column=req.column, plotting_position=req.plottingPosition)


class LineMosaicRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    columnVariables: list[str] | None = None
    column_variables: list[str] | None = None
    rowVariables: list[str] | None = None
    row_variables: list[str] | None = None
    targetVariable: str | None = None
    target_variable: str | None = None
    rowIds: list[str] | None = None
    row_ids: list[str] | None = None


@router.post("/summaries/line_mosaic")
def line_mosaic_summary(req: LineMosaicRequest) -> dict:
    from ..algorithms.summaries.line_mosaic import compute_line_mosaic
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        from ..domain.errors import BizError
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    col_vars = req.columnVariables if req.columnVariables is not None else req.column_variables
    row_vars = req.rowVariables if req.rowVariables is not None else req.row_variables
    target_var = req.targetVariable if req.targetVariable is not None else req.target_variable
    row_ids = req.rowIds if req.rowIds is not None else req.row_ids

    return compute_line_mosaic(
        df=df,
        column_variables=col_vars,
        row_variables=row_vars,
        target_variable=target_var,
        row_ids=row_ids,
    )


