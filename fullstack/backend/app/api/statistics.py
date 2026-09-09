"""API endpoints for advanced statistics (Covariance, Precision matrix)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel
import polars as pl

from ..algorithms.statistics.covariance import compute_covariance
from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore
from ..domain.analysis_columns import resolve_analysis_columns
from ..domain.codebook_adapter import CodebookAdapter
from .multi_response import _check_revisions, _collect_revisions, _scope_hash

router = APIRouter()
store = DatasetStore()


class CovarianceRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    columns: list[str] | None = None
    rowIds: list[str] | None = None
    row_ids: list[str] | None = None
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None


@router.post("/statistics/covariance")
def get_covariance(req: CovarianceRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = _collect_revisions(meta, codebook)
        _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        plan = resolve_analysis_columns(codebook, req.columns,
            scales={'interval', 'ratio', 'ordinal'} if req.columns is not None else {'interval', 'ratio'})
        if not plan.names:
            raise BizError('EMPTY_ANALYSIS_INPUT', '共分散の対象変数を選択してください。', status_code=422)
        df = store.get_dataframe(dataset_id, columns=['__rowId__', *plan.dependencies])
        wanted_rows = req.rowIds if req.rowIds is not None else req.row_ids
        if wanted_rows is not None:
            df = df.filter(pl.col('__rowId__').is_in(wanted_rows))
        scope = _scope_hash(df['__rowId__'].to_list())
        df = CodebookAdapter(df, codebook).analysis_frame()
        incomplete = df.height - df.select(plan.names).drop_nulls().height
        result = compute_covariance(df=df, columns=plan.names)
        return {**result, 'datasetId': dataset_id, **revisions, 'scopeHash': scope,
                'usedColumns': plan.names, 'excludedCounts': {'incompleteRows': incomplete}, 'method': 'covariance-complete-case'}
