"""Summaries API with fingerprint-based caching."""
from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.summaries.core import correlation_matrix_df, summarize
from ..storage.dataset_store import DatasetStore
from ..domain.codebook_adapter import CodebookAdapter
from ..domain.codebook_adapter import normalize_code
from ..domain.errors import BizError
from ..domain.analysis_columns import resolve_analysis_columns
from .multi_response import _check_revisions, _collect_revisions

router = APIRouter()
store = DatasetStore()
_cache: dict[tuple, dict] = {}


class SummaryRequest(BaseModel):
    datasetId: str
    rowIds: list[str] | None = None
    columns: list[str] | None = None
    correlation: bool = False
    selectedRowIds: list[str] | None = None
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None


@router.post("/summaries")
def summaries(req: SummaryRequest) -> dict:
    with store.lock(req.datasetId):
        return _summaries(req)


def _summaries(req: SummaryRequest) -> dict:
    meta = store.get_meta(req.datasetId)
    column_types = {c["name"]: c["semanticType"] for c in meta["schema"]}
    columns = list(dict.fromkeys(req.columns if req.columns is not None else column_types))
    if any(c not in column_types for c in columns):
        raise BizError("COLUMN_NOT_FOUND", "指定列が存在しません。", status_code=422)
    codebook = store.load_codebook(req.datasetId)
    revisions = _collect_revisions(meta, codebook or {})
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
    schema_revision = (codebook or {}).get("schemaRevision", meta.get("schemaRevision", 1))
    codebook_dict = codebook
    for spec in (codebook or {}).get("columns", []):
        column_types[spec["name"]] = "numeric" if spec.get("scaleType") in ("ordinal", "interval", "ratio") else "categorical"
    row_ids_key = tuple(sorted(req.rowIds)) if req.rowIds is not None else None
    key = (req.datasetId, row_ids_key,
           tuple(sorted(columns)), req.correlation, meta["fingerprint"], schema_revision)
    cached = key in _cache
    df = None
    if not cached:
        df = store.get_dataframe(req.datasetId, columns=["__rowId__", *columns])
        if req.rowIds is not None:
            df = df.filter(pl.col("__rowId__").is_in(req.rowIds))
        subset = df.select(columns)
        payload = {
        "datasetId": req.datasetId,
        "schemaRevision": schema_revision,
        "fingerprint": meta["fingerprint"],
        "rowCount": df.height,
        "columns": summarize(subset, {k: v for k, v in column_types.items() if k in set(columns)}, codebook=codebook_dict),
        "evidenceClass": "MODERN-EXTENSION",
        }
        if req.correlation:
            numeric_cols = [c for c in columns if column_types.get(c) == "numeric"]
            normalized = CodebookAdapter(subset, codebook).analysis_frame()
            payload["correlation"] = {"columns": numeric_cols, "matrix": correlation_matrix_df(normalized, numeric_cols)}
        _cache[key] = payload
        if len(_cache) > 200:
            _cache.pop(next(iter(_cache)))
    payload = {**_cache[key], "cacheHit": cached, **revisions}
    if req.selectedRowIds is not None:
        counts = {c: {} for c in columns}
        if req.selectedRowIds and columns:
            if df is None:
                df = store.get_dataframe(req.datasetId, columns=["__rowId__", *columns])
                if req.rowIds is not None:
                    df = df.filter(pl.col("__rowId__").is_in(req.rowIds))
            selected = df.filter(pl.col("__rowId__").is_in(req.selectedRowIds))
            for column in columns:
                for raw in selected[column]:
                    code = normalize_code(raw)
                    code = "__null__" if code is None else code
                    counts[column][code] = counts[column].get(code, 0) + 1
        payload["selectedCountByCode"] = counts
    return payload


class ColumnMatchRequest(BaseModel):
    columnId: str
    code: str | None = None
    rowIds: list[str] | None = None
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None


@router.post("/datasets/{dataset_id}/column-matches")
def column_matches(dataset_id: str, req: ColumnMatchRequest) -> dict:
    with store.lock(dataset_id):
        return _column_matches(dataset_id, req)


def _column_matches(dataset_id: str, req: ColumnMatchRequest) -> dict:
    meta = store.get_meta(dataset_id)
    codebook = store.load_codebook(dataset_id) or {}
    revisions = _collect_revisions(meta, codebook)
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
    column = next((c for c in codebook.get("columns", []) if c["columnId"] == req.columnId), None)
    if column is None:
        raise BizError("COLUMN_NOT_FOUND", "指定列が存在しません。", status_code=422)
    if column.get("multiResponseGroup"):
        raise BizError("MA_METHOD_UNSUPPORTED", "MA設問の選択条件を使用してください。", status_code=422)
    frame = store.get_dataframe(dataset_id, columns=["__rowId__", column["name"]])
    if req.rowIds is not None:
        frame = frame.filter(pl.col("__rowId__").is_in(req.rowIds))
    ids = [row_id for row_id, value in frame.iter_rows() if normalize_code(value) == req.code]
    return {"datasetId": dataset_id, **revisions, "rowIds": ids, "count": len(ids)}


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
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None


@router.post("/summaries/line_mosaic")
def line_mosaic_summary(req: LineMosaicRequest) -> dict:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        from ..domain.errors import BizError
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    with store.lock(dataset_id):
        return _line_mosaic_summary(dataset_id, req)


def _line_mosaic_summary(dataset_id: str, req: LineMosaicRequest) -> dict:
    from ..algorithms.summaries.line_mosaic import compute_line_mosaic

    col_vars = req.columnVariables if req.columnVariables is not None else req.column_variables
    row_vars = req.rowVariables if req.rowVariables is not None else req.row_variables
    target_var = req.targetVariable if req.targetVariable is not None else req.target_variable
    row_ids = req.rowIds if req.rowIds is not None else req.row_ids

    codebook = store.load_codebook(dataset_id) or {}
    revisions = _collect_revisions(store.get_meta(dataset_id), codebook)
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
    def resolve(names):
        return resolve_analysis_columns(codebook, names, scales={'nominal', 'ordinal', 'interval', 'ratio'}, allow_ma_options=True)
    col_vars = resolve(col_vars or []).names
    row_vars = resolve(row_vars or []).names
    if not col_vars and not row_vars:
        raise BizError('MOSAIC_NO_VARIABLES', '行変数または列変数を指定してください。', status_code=422)
    target_var = resolve([target_var]).names[0] if target_var else None
    plan = resolve([*col_vars, *row_vars, *([target_var] if target_var else [])])
    df = store.get_dataframe(dataset_id, columns=['__rowId__', *plan.dependencies])
    if row_ids is not None:
        df = df.filter(pl.col('__rowId__').is_in(row_ids))
    scope_count = df.height
    df, excluded = plan.prepare(df)
    # The prepared MA values have a different domain from the source codes.
    prepared_codebook = {**codebook, 'columns': [
        {**spec, 'missingCodes': [], 'categoryOrder': ['0', '1'],
         'valueLabels': {'0': '非選択', '1': '選択'}, 'isReversed': False}
        if spec.get('multiResponseGroup') and spec['name'] in plan.names else spec
        for spec in codebook.get('columns', [])]}
    result = compute_line_mosaic(
        df=df,
        column_variables=col_vars,
        row_variables=row_vars,
        target_variable=target_var,
        codebook=prepared_codebook,
    )
    return {**result, **revisions, 'scopeCount': scope_count,
            'usedRows': sum(cell['totalCount'] for cell in result['cells']),
            'usedColumns': plan.names, 'excludedCounts': excluded,
            'excludedRowCount': scope_count - df.height}
