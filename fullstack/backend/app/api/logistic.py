"""Logistic Regression API (Feature 12)."""
from __future__ import annotations

from typing import Any
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..algorithms.models.logistic import run_logistic_regression
from ..domain.errors import BizError
from ..domain.analysis_columns import resolve_analysis_columns
from ..domain.codebook_adapter import CodebookAdapter, normalize_code
from ..domain.weight_unsupported import weight_unsupported_block
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
    weightColumn: str | None = None


class LogisticTargetsRequestSchema(BaseModel):
    datasetId: str
    targetColumns: list[str]
    featureColumns: list[str] = Field(default_factory=list)
    activeRowIds: list[str] | None = None
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


def _prepare_logistic_frame(df, codebook, target_name, feature_names, plan):
    """One preparation contract for eligibility and fitting (including MA/listwise deletion)."""
    df, excluded = plan.prepare(df)
    ma_names = {column['name'] for group in plan.groups for column in group['columns']}
    adapter = CodebookAdapter(df, codebook)
    df = df.with_columns([adapter.analysis_series(name) for name in plan.names if name not in ma_names])
    numeric_names = [*feature_names]
    if df[target_name].dtype.is_numeric():
        numeric_names.append(target_name)
    df = df.with_columns([pl.when(pl.col(name).cast(pl.Float64, strict=False).is_finite())
        .then(pl.col(name)).otherwise(None).alias(name) for name in numeric_names])
    before_ordinary = df.height
    return df.drop_nulls(plan.names), excluded, before_ordinary, adapter


@router.post("/models/logistic/targets")
def logistic_targets(req: LogisticTargetsRequestSchema) -> dict[str, Any]:
    """Report binary eligibility in the next run's scope, never fit a model.

    Each candidate excludes itself and its MA siblings from the requested features,
    just as the form does when switching targets. Read the dependency union once;
    unrelated candidates must not impose their missingness on each other.
    """
    with store.lock(req.datasetId):
        codebook = store.load_codebook(req.datasetId) or {}
        revisions = _collect_revisions(store.get_meta(req.datasetId), codebook)
        _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        features = resolve_analysis_columns(codebook, req.featureColumns,
            scales={'ordinal', 'interval', 'ratio'}, allow_ma_options=True)
        specs = {column['name']: column for column in codebook.get('columns', [])}
        plans = []
        dependencies = ['__rowId__']
        by_id = {column['columnId']: column for column in codebook.get('columns', [])}
        for identifier in dict.fromkeys(req.targetColumns):
            name = (by_id.get(identifier) or specs.get(identifier) or {}).get('name', identifier)
            try:
                target = resolve_analysis_columns(codebook, [identifier],
                    scales={'nominal', 'ordinal', 'interval', 'ratio'}, allow_ma_options=True)
                name = target.names[0]
                group = specs[name].get('multiResponseGroup')
                feature_names = [feature for feature in features.names if feature != name
                    and (not group or specs[feature].get('multiResponseGroup') != group)]
                plan = resolve_analysis_columns(codebook, [*feature_names, name],
                    scales={'nominal', 'ordinal', 'interval', 'ratio'}, allow_ma_options=True)
                plans.append((name, feature_names, plan, None))
                dependencies.extend(column for column in plan.dependencies if column not in dependencies)
            except BizError as error:
                plans.append((name, [], None, error.message))
        frame = store.get_dataframe(req.datasetId, columns=dependencies)
        if req.activeRowIds is not None:
            frame = frame.filter(pl.col('__rowId__').is_in(req.activeRowIds))
        targets = []
        for name, feature_names, plan, planning_error in plans:
            if plan is None:
                targets.append({'name': name, 'classCount': None, 'eligible': False, 'reason': planning_error})
                continue
            try:
                candidate_frame = frame.select(['__rowId__', *plan.dependencies])
                prepared, _, _, _ = _prepare_logistic_frame(candidate_frame, codebook, name, feature_names, plan)
                # Same identity as the binary engine, not labels or normalized codes.
                count = len({str(value) for value in prepared[name].to_list() if value is not None})
                reason = None if count == 2 else f'有効な対象行では{count}クラスです（2クラス必要）。'
                targets.append({'name': name, 'classCount': count, 'eligible': count == 2, 'reason': reason})
            except BizError as error:
                targets.append({'name': name, 'classCount': None, 'eligible': False, 'reason': error.message})
        return {'datasetId': req.datasetId, **revisions, 'targets': targets}


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
    raw_target = df[target.names[0]]
    target_dtype = str(raw_target.dtype)
    raw_target_by_row_id = dict(zip(df['__rowId__'].to_list(), raw_target.to_list()))
    df, excluded, before_ordinary, adapter = _prepare_logistic_frame(
        df, codebook, target.names[0], features.names, plan)
    weight_info = weight_unsupported_block(codebook, req.weightColumn)

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
    # Join fitted membership to values captured before scoring or MA projection.
    # Canonical scalar text preserves literal strings, signed zero and large integers;
    # normalized codes are only for label lookup, never category deduplication.
    class_categories = [{}, {}]
    for sample in result['samples']:
        raw = raw_target_by_row_id[sample['rowId']]
        raw_value = str(raw)
        categories = class_categories[sample['actual']]
        if raw_value not in categories:
            categories[raw_value] = {
                'rawValue': raw_value,
                'code': normalize_code(raw),
                'label': adapter.label_for_value(target.names[0], raw),
            }
    return {**result, **weight_info, 'warnings': [*result['warnings'], *weight_info['warnings']],
            'datasetId': dataset_id, **revisions, 'scopeHash': scope_hash,
            'targetDtype': target_dtype,
            'classCategories': [[categories[raw] for raw in sorted(categories)] for categories in class_categories],
            'scopeCount': scope_count, 'usedRows': df.height, 'usedColumns': plan.names,
            'excludedRowCount': scope_count - df.height,
            'excludedCounts': {**excluded, 'ordinaryMissing': before_ordinary - df.height},
            'method': 'logistic-explicit-columns'}
