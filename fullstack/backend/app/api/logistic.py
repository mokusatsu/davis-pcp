"""Logistic Regression API (Feature 12)."""
from __future__ import annotations

from typing import Any
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..algorithms.models.logistic import run_logistic_regression
from ..domain.errors import BizError
from ..domain.analysis_columns import resolve_analysis_columns
from ..domain.codebook_adapter import CodebookAdapter
from .multi_response import _check_revisions, _collect_revisions, _scope_hash
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class LogisticRequestSchema(BaseModel):
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None
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

    feature_columns = req.featureColumns if req.featureColumns is not None else req.feature_columns
    if not feature_columns:
        raise BizError("LOGISTIC_FEATURES_REQUIRED", "featureColumns は必須です。")

    with store.lock(dataset_id):
        return _fit_logistic(dataset_id, target_column, feature_columns, req)


def _fit_logistic(dataset_id, target_column, feature_columns, req):
    codebook = store.load_codebook(dataset_id) or {}
    revisions = _collect_revisions(store.get_meta(dataset_id), codebook)
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
    target = resolve_analysis_columns(codebook, [target_column], scales={'nominal', 'ordinal', 'interval', 'ratio'}, allow_ma_options=True)
    features = resolve_analysis_columns(codebook, feature_columns, scales={'ordinal', 'interval', 'ratio'}, allow_ma_options=True)
    if target.names[0] in features.names or {group['groupId'] for group in target.groups} & {group['groupId'] for group in features.groups}:
        raise BizError('MA_METHOD_UNSUPPORTED', '目的変数と同じ列・同じMA親の子列は説明変数にできません。', status_code=422)
    plan = resolve_analysis_columns(codebook, [*features.names, *target.names], scales={'nominal', 'ordinal', 'interval', 'ratio'}, allow_ma_options=True)
    df = store.get_dataframe(dataset_id, columns=['__rowId__', *plan.dependencies])
    active_rows = req.activeRowIds if req.activeRowIds is not None else req.active_row_ids
    if active_rows is not None:
        df = df.filter(pl.col('__rowId__').is_in(active_rows))
    scope_count, scope_hash = df.height, _scope_hash(df['__rowId__'].to_list())
    df, excluded = plan.prepare(df)
    ma_names = {column['name'] for group in plan.groups for column in group['columns']}
    adapter = CodebookAdapter(df, codebook)
    df = df.with_columns([adapter.analysis_series(name) for name in plan.names if name not in ma_names])
    numeric_names = [*features.names]
    if df[target.names[0]].dtype.is_numeric():
        numeric_names.append(target.names[0])
    df = df.with_columns([pl.when(pl.col(name).cast(pl.Float64, strict=False).is_finite())
        .then(pl.col(name)).otherwise(None).alias(name) for name in numeric_names])
    before_ordinary = df.height
    df = df.drop_nulls(plan.names)

    result = run_logistic_regression(
        df=df,
        target_column=target.names[0],
        feature_columns=features.names,
        active_row_ids=None,
        intercept=req.intercept,
        regularization=req.regularization,
        c_value=req.cValue,
        cutoff=req.cutoff,
    )
    feature_values = dict(zip(df['__rowId__'].to_list(), df.select(features.names).to_dicts()))
    result['samples'] = [{**sample, 'featureValues': feature_values[sample['rowId']]} for sample in result['samples']]
    return {**result, 'datasetId': dataset_id, **revisions, 'scopeHash': scope_hash,
            'scopeCount': scope_count, 'usedRows': df.height, 'usedColumns': plan.names,
            'excludedRowCount': scope_count - df.height,
            'excludedCounts': {**excluded, 'ordinaryMissing': before_ordinary - df.height},
            'method': 'logistic-explicit-columns'}
