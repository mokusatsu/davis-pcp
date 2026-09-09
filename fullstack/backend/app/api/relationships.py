"""API endpoints for Surprise-First Association Scoring (Feature 02)."""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.relationships.surprise import compute_phik_and_surprise
from ..domain.errors import BizError
from ..domain.analysis_columns import resolve_analysis_columns
from ..domain.codebook_adapter import CodebookAdapter
from ..domain.multi_response import prepare_classifier
from .multi_response import _collect_revisions, _check_revisions, _scope_hash
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class RelationshipRequest(BaseModel):
    datasetId: str
    columns: list[str]
    rowIds: list[str] | None = None
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None


def _relationship_input(req: RelationshipRequest, *, scales=None, need_numeric=True):
    meta = store.get_meta(req.datasetId)
    codebook = store.load_codebook(req.datasetId) or {}
    revisions = _collect_revisions(meta, codebook)
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
    plan = resolve_analysis_columns(codebook, req.columns, scales=scales if scales is not None else {'interval', 'ratio', 'ordinal'}, allow_ma_options=True)
    frame = store.get_dataframe(req.datasetId, columns=['__rowId__', *plan.dependencies])
    if req.rowIds is not None:
        frame = frame.filter(pl.col('__rowId__').is_in(req.rowIds))
    scope_hash = _scope_hash(frame['__rowId__'].to_list())
    scope_count = frame.height
    specs = {column['name']: column for column in codebook.get('columns', [])}
    adapter = CodebookAdapter(frame, codebook)
    frame = frame.with_columns([adapter.analysis_series(name) for name in plan.names if not specs[name].get('multiResponseGroup')])
    excluded = {}
    replacements = []
    for group in plan.groups:
        classify = prepare_classifier(group)
        requested = [column for column in group['columns'] if column['name'] in plan.names]
        values = {column['name']: [] for column in requested}
        counts = {status: 0 for status in ['valid', 'missing', 'partial', 'notApplicable', 'invalid']}
        for row in frame.select([column['name'] for column in group['columns']]).iter_rows():
            status, selected = classify(list(row))
            counts[status] += 1
            for column in requested:
                values[column['name']].append(int(column['columnId'] in selected) if status == 'valid' else None)
        replacements.extend(pl.Series(name, data, dtype=pl.UInt8) for name, data in values.items())
        excluded[group['groupId']] = counts
    frame = frame.with_columns(replacements).select(['__rowId__', *plan.names])
    numeric = {name: frame[name].cast(pl.Float64, strict=False).to_numpy() for name in plan.names} if need_numeric else {}
    info = {'datasetId': req.datasetId, **revisions, 'scopeHash': scope_hash, 'scopeCount': scope_count,
            'usedColumns': plan.names, 'excludedCounts': excluded}
    return frame, numeric, info


@router.post('/relationships/matrix')
def relationship_matrix(req: RelationshipRequest) -> dict[str, Any]:
    with store.lock(req.datasetId):
        _, numeric, info = _relationship_input(req)
        columns = info['usedColumns']
        matrix = [[None for _ in columns] for _ in columns]
        counts = [[0 for _ in columns] for _ in columns]
        for i, left in enumerate(columns):
            x = numeric[left]
            for j in range(i, len(columns)):
                y = numeric[columns[j]]
                finite = np.isfinite(x) & np.isfinite(y)
                n = int(finite.sum())
                counts[i][j] = counts[j][i] = n
                if n < 2:
                    continue
                a, b = x[finite], y[finite]
                a = a / max(float(np.max(np.abs(a))), 1)
                b = b / max(float(np.max(np.abs(b))), 1)
                a, b = a - a.mean(), b - b.mean()
                denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
                value = float(np.clip(np.dot(a, b) / denominator, -1, 1)) if denominator > 0 else None
                matrix[i][j] = matrix[j][i] = value
        return {**info, 'columns': columns, 'matrix': matrix, 'counts': counts, 'method': 'pearson-pairwise'}


@router.post('/relationships/pair')
def relationship_pair(req: RelationshipRequest) -> dict[str, Any]:
    with store.lock(req.datasetId):
        frame, numeric, info = _relationship_input(req)
        if len(info['usedColumns']) != 2:
            raise BizError('EMPTY_ANALYSIS_INPUT', '焦点表示には異なる2変数を指定してください。', status_code=422)
        x, y = [numeric[name] for name in info['usedColumns']]
        finite = np.isfinite(x) & np.isfinite(y)
        row_ids = frame.filter(pl.Series(finite))['__rowId__'].to_list()
        return {**info, 'rowIds': row_ids, 'x': x[finite].tolist(), 'y': y[finite].tolist(),
                'usedRows': len(row_ids), 'method': 'pairwise-finite'}


class SurpriseAssociationRequest(BaseModel):
    rowIds: list[str] | None = None
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None
    includeSameMa: bool = False
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

    with store.lock(dataset_id):
        return _evaluate_surprise_associations(dataset_id, req)


def _evaluate_surprise_associations(dataset_id: str, req: SurpriseAssociationRequest) -> dict[str, Any]:
    codebook = store.load_codebook(dataset_id) or {}
    scales = {'nominal', 'ordinal', 'interval', 'ratio'}
    names = resolve_analysis_columns(codebook, req.columns, scales=scales, allow_ma_options=True).names
    df, _, info = _relationship_input(RelationshipRequest(datasetId=dataset_id, columns=names, rowIds=req.rowIds,
        expectedSchemaRevision=req.expectedSchemaRevision, expectedDataRevision=req.expectedDataRevision), scales=scales, need_numeric=False)
    schema = [{**column, 'semanticType': 'numeric' if column.get('scaleType') in {'interval', 'ratio'} else 'categorical'}
              for column in codebook.get('columns', []) if column['name'] in names]

    measure = req.primaryMeasure or req.primary_measure or "phik"
    mode = req.unexpectednessMode or req.unexpectedness_mode or "combined"
    w_s = req.wStrength if req.w_strength is None else req.w_strength
    w_u = req.wUnexpected if req.w_unexpected is None else req.w_unexpected
    max_lift = req.maxLiftCap if req.max_lift_cap is None else req.max_lift_cap

    result = compute_phik_and_surprise(
        df=df,
        columns=names,
        column_meta=schema,
        primary_measure=measure,
        unexpectedness_mode=mode,
        w_strength=w_s if w_s is not None else 0.5,
        w_unexpected=w_u if w_u is not None else 0.5,
        max_lift_cap=max_lift if max_lift is not None else 5.0,
        include_same_ma=req.includeSameMa,
    )
    return {**result, **info, 'method': 'surprise-associations'}
