"""Summaries API with fingerprint-based caching."""
from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel, model_validator

from ..algorithms.summaries.core import correlation_matrix_df, summarize
from ..storage.dataset_store import DatasetStore
from ..domain.codebook_adapter import CodebookAdapter
from ..domain.codebook_adapter import normalize_code
from ..domain.errors import BizError
from ..domain.context import ScopeName
from ..domain.analysis_columns import resolve_analysis_columns
from ..domain.survey_weight import (
    WEIGHT_UNSUPPORTED_MESSAGE,
    check_weights_valid,
    declared_weight_column_id,
    extract_weights,
    find_weight_spec,
    resolve_weight_column,
    weighted_status,
)
from .multi_response import _check_revisions, _collect_revisions, _scope_hash

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
    weightColumn: str | None = None
    weightMode: str | None = None
    weightType: str | None = None


@router.post("/summaries")
def summaries(req: SummaryRequest) -> dict:
    with store.lock(req.datasetId):
        return _summaries(req)


def _summaries(req: SummaryRequest) -> dict:
    meta = store.get_meta(req.datasetId)
    column_types = {c["name"]: c.get("semanticType", "categorical") for c in meta["schema"]}
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
    from ..domain.weight_mode import resolve_weight_request
    from ..domain.survey_weight import resolve_weight_config
    weight_mode, weight_reference = resolve_weight_request(
        codebook, weight_mode=req.weightMode, weight_column=req.weightColumn,
        weight_type=req.weightType)
    weight_spec = resolve_weight_column(codebook, weight_reference)
    weight_name = weight_spec["name"] if weight_spec is not None else None
    try:
        weight_type = resolve_weight_config(codebook, weight_reference) if weight_spec is not None else None
    except BizError:
        # Legacy callers name a role=weight column without a declared
        # weightConfig; treat it as unweighted-compatible frequency-style
        # aggregation on the summary path (the crosstab path keeps the
        # declared-type gate). The audit weightMode contract still applies:
        # only explicit none disables a declared dataset default.
        weight_type = None
        if weight_reference is not None and (codebook or {}).get("weightConfig") is not None:
            raise
    if req.weightType is not None and weight_type is not None and req.weightType != weight_type:
        raise BizError("WEIGHT_TYPE_MISMATCH", "weightType が保存済み設定と一致しません。",
                       status_code=422)
    if req.weightType is not None and weight_type is None and weight_spec is not None:
        weight_type = req.weightType
    read_columns = ["__rowId__", *columns] if weight_name is None else ["__rowId__", *dict.fromkeys([*columns, weight_name])]
    row_ids_key = tuple(sorted(req.rowIds)) if req.rowIds is not None else None
    # dataRevision / maskRevision are part of the key: an undone revision can
    # reproduce an earlier fingerprint, so the fingerprint alone cannot tell
    # "the summary of now" from "the summary of before the undo" (HIST-01).
    weight_mask = store.load_mask(req.datasetId) or {}
    key = (req.datasetId, row_ids_key,
           tuple(sorted(columns)), req.correlation, meta["fingerprint"], schema_revision,
           weight_spec["columnId"] if weight_spec is not None else None,
           int(meta.get("dataRevision", 1)), int(weight_mask.get("maskRevision", 0)))
    cached = key in _cache
    df = None
    weights: list[float | None] | None = None
    weight_missing = 0
    weight_status = "omitted"
    if not cached:
        df = store.get_dataframe(req.datasetId, columns=read_columns)
        if req.rowIds is not None:
            df = df.filter(pl.col("__rowId__").is_in(req.rowIds))
        subset = df.select(columns)
        if weight_spec is not None:
            from ..domain.survey_weight import validate_weight_semantics
            weights, weight_missing, has_invalid = extract_weights(df, weight_name or "", weight_spec)
            check_weights_valid(weights, has_invalid)
            validate_weight_semantics(weights, weight_type)
        payload = {
        "datasetId": req.datasetId,
        "schemaRevision": schema_revision,
        "fingerprint": meta["fingerprint"],
        "rowCount": df.height,
        "columns": summarize(subset, {k: v for k, v in column_types.items() if k in set(columns)}, codebook=codebook_dict, weights=weights),
        "evidenceClass": "MODERN-EXTENSION",
        }
        if req.correlation:
            numeric_cols = [c for c in columns if column_types.get(c) == "numeric"]
            normalized = CodebookAdapter(subset, codebook).analysis_frame()
            payload["correlation"] = {"columns": numeric_cols, "matrix": correlation_matrix_df(normalized, numeric_cols, weights=weights)}
        _cache[key] = payload
        if len(_cache) > 200:
            _cache.pop(next(iter(_cache)))
    payload = {**_cache[key], "cacheHit": cached, **revisions}
    scope_ids = _cache[key].get("_scopeIds")
    if scope_ids is None:
        if df is not None and "__rowId__" in df.columns:
            # df is already scope-filtered above when rowIds is not None;
            # when rowIds is None it holds all rows, so no extra read is needed.
            scope_ids = df["__rowId__"].to_list()
            _cache[key]["_scopeIds"] = scope_ids
        else:
            scope_frame = store.get_dataframe(req.datasetId, columns=["__rowId__"])
            if req.rowIds is not None:
                scope_frame = scope_frame.filter(pl.col("__rowId__").is_in(req.rowIds))
            scope_ids = scope_frame["__rowId__"].to_list()
            _cache[key]["_scopeIds"] = scope_ids
    else:
        scope_ids = list(scope_ids)
    weight_block: dict[str, Any] = {"weightStatus": "omitted", "weightApplied": False,
                                    "weightColumn": None, "weightColumnId": None,
                                    "unweightedN": len(scope_ids), "weightedN": None,
                                    "weightMissingCount": 0,
                                    "scopeHash": _scope_hash([str(v) for v in scope_ids])}
    if weight_spec is not None:
        from ..domain.survey_weight import validate_weight_semantics as _validate_semantics
        if df is None or weights is None:
            weight_df = store.get_dataframe(req.datasetId, columns=["__rowId__", weight_name or ""])
            if req.rowIds is not None:
                weight_df = weight_df.filter(pl.col("__rowId__").is_in(req.rowIds))
            weights, weight_missing, has_invalid = extract_weights(weight_df, weight_name or "", weight_spec)
            check_weights_valid(weights, has_invalid)
            _validate_semantics(weights, weight_type)
        else:
            weight_df = df
        positive_mass = sum(w for w in weights if w is not None and w > 0)
        weight_missing = sum(1 for w in weights if w is None)
        weight_status = weighted_status(True, positive_mass)
        weight_block = {"weightStatus": weight_status, "weightApplied": weight_status == "applied",
                        "weightColumn": weight_name, "weightColumnId": weight_spec["columnId"],
                        "unweightedN": len(scope_ids),
                        "weightedN": round(positive_mass, 4) if weight_status == "applied" else None,
                        "weightMissingCount": weight_missing,
                        "scopeHash": _scope_hash([str(v) for v in scope_ids])}
        if weight_status == "no_positive_weight":
            weight_block["warnings"] = [{"code": "WEIGHT_NO_POSITIVE",
                                         "message": "正のウェイトがないため加重値を返しません。"}]
    payload = {**payload, **weight_block}
    payload.pop("_scopeIds", None)
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
    from ..domain.codebook_adapter import CodebookAdapter
    codebook = store.load_codebook(req.datasetId) or {}
    df = store.get_dataframe(req.datasetId)
    if req.rowIds is not None:
        wanted = set(req.rowIds)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))
    if req.column in df.columns:
        adapter = CodebookAdapter(df, codebook)
        masked = adapter.mask_missing_values(req.column)
        analysis = adapter.analysis_series(req.column) if (adapter.get_column_spec_optional(req.column) or {}).get("scaleType") in ("ordinal", "interval", "ratio", "numeric") else masked
        df = df.with_columns(analysis.alias(req.column))
    return compute_qqplot(df, column=req.column, plotting_position=req.plottingPosition)


class CrosstabContext(BaseModel):
    datasetId: str
    expectedDataRevision: int
    expectedSchemaRevision: int
    scope: ScopeName = "all"
    rowIds: list[str] | None = None
    activeRowIds: list[str] | None = None
    selectedRowIds: list[str] | None = None
    sampledRowIds: list[str] | None = None
    weightColumn: str | None = None
    weightMode: str | None = None
    weightType: str | None = None
    missingPolicy: str = "exclude"

    @model_validator(mode="after")
    def check_scope_ids(self) -> "CrosstabContext":
        required = {"active": "activeRowIds", "selected": "selectedRowIds",
                    "sampled": "sampledRowIds", "explicit": "rowIds"}.get(self.scope)
        if required is not None and getattr(self, required) is None:
            raise ValueError(f"scope={self.scope} requires {required}; [] means empty")
        return self


class CrosstabRequest(BaseModel):
    context: CrosstabContext
    rowVariableId: str
    colVariableId: str
    includeRowIds: bool = True
    maxRowIdsPerCell: int = 10000
    # auto resolves on the weight's meaning: none for a survey weight, pearson
    # otherwise. Naming a method explicitly is a claim the server checks.
    inference: str = "auto"


class CrosstabCellRequest(BaseModel):
    context: CrosstabContext
    rowVariableId: str
    colVariableId: str
    rowCategoryId: str
    colCategoryId: str


@router.post("/summaries/crosstab")
def crosstab_summary(req: CrosstabRequest) -> dict:
    from ..algorithms.summaries.crosstab import compute_crosstab
    from ..algorithms.summaries.inference import REQUESTED_METHODS
    from ..domain.context import (
        build_meta,
        check_revisions,
        collect_revisions,
        resolve_scope,
    )
    from ..domain.survey_weight import (
        check_weights_valid,
        declared_weight_column_id,
        extract_weights,
        find_weight_spec,
        resolve_weight_column,
        resolve_weight_config,
        validate_weight_semantics,
        weighted_status,
    )

    context = req.context
    with store.lock(context.datasetId):
        meta = store.get_meta(context.datasetId)
        codebook = store.load_codebook(context.datasetId) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, context.expectedSchemaRevision, context.expectedDataRevision)
        if context.missingPolicy not in ("exclude", "include_missing", "separate_not_applicable"):
            raise BizError("CROSSTAB_MISSING_POLICY", "missingPolicy が不正です。",
                           status_code=422)
        if req.inference not in REQUESTED_METHODS:
            raise BizError("CROSSTAB_INFERENCE",
                           f"inferenceは{'/'.join(REQUESTED_METHODS)}のいずれかです。",
                           status_code=422)
        # FIX_SPEC §4.1: dataset (default) uses the saved weightConfig; only
        # explicit none disables it. Legacy omitted/null migrates to dataset.
        from ..domain.weight_mode import resolve_weight_request
        _weight_mode, weight_reference = resolve_weight_request(
            codebook, weight_mode=context.weightMode,
            weight_column=context.weightColumn, weight_type=context.weightType)
        weight_spec = resolve_weight_column(codebook, weight_reference)
        weight_name = weight_spec["name"] if weight_spec is not None else None
        weight_column_id = weight_spec["columnId"] if weight_spec is not None else None
        # The weight's *meaning* has to be declared before it is used; there is
        # no silent default (spec §26).
        weight_type = resolve_weight_config(codebook, weight_reference)
        if context.weightType is not None and weight_type is not None and context.weightType != weight_type:
            raise BizError("WEIGHT_TYPE_MISMATCH", "weightType が保存済み設定と一致しません。",
                           status_code=422)
        from ..domain.analysis_columns import resolve_analysis_columns

        if req.rowVariableId == req.colVariableId:
            raise BizError("CROSSTAB_SAME_VARIABLE", "行変数と列変数に同じ列を指定できません。",
                           status_code=422)
        try:
            plan = resolve_analysis_columns(
                codebook, [req.rowVariableId, req.colVariableId],
                scales={"nominal", "ordinal", "binary"}, allow_ma_options=False,
                roles={"question", "attribute", "weight", "numeric_axis",
                       "categorical_axis", "feature"})
        except BizError as exc:
            if exc.code in ("MA_METHOD_UNSUPPORTED", "COLUMN_NOT_FOUND"):
                raise BizError("CROSSTAB_CATEGORY_REQUIRED" if exc.code == "MA_METHOD_UNSUPPORTED"
                               else "CROSSTAB_COLUMN_NOT_FOUND", exc.message,
                               status_code=422) from exc
            raise
        if len(plan.names) != 2:
            raise BizError("CROSSTAB_COLUMN_NOT_FOUND", "行変数または列変数が存在しません。",
                           status_code=422)
        row_name, col_name = plan.names[0], plan.names[1]
        if row_name == col_name:
            raise BizError("CROSSTAB_SAME_VARIABLE", "行変数と列変数に同じ列を指定できません。",
                           status_code=422)
        # Sampling design columns only matter for a survey weight; a frequency
        # weight is a count, not a design.
        design_names: dict[str, str | None] = {}
        if weight_type == "survey":
            design = codebook.get("surveyDesign") if isinstance(codebook.get("surveyDesign"), dict) else {}
            for key in ("strataColumnId", "psuColumnId", "fpcColumnId"):
                spec = find_weight_spec(codebook, design.get(key)) if design.get(key) else None
                design_names[key] = spec["name"] if spec else None
        read_columns = ["__rowId__", row_name, col_name]
        if weight_name is not None:
            read_columns.append(weight_name)
        read_columns.extend(name for name in design_names.values() if name)
        df = store.get_dataframe(context.datasetId, columns=list(dict.fromkeys(read_columns)))
        scope_ids = resolve_scope([str(v) for v in df["__rowId__"].to_list()],
                                   __import__("app.domain.context", fromlist=["AnalysisContext"])
                                   .AnalysisContext(**context.model_dump()))
        df = df.filter(pl.col("__rowId__").is_in(scope_ids))
        weights: list[float | None] | None = None
        weight_missing = 0
        weight_status = "omitted"
        positive_mass = 0.0
        if weight_spec is not None:
            weights, weight_missing, has_invalid = extract_weights(df, weight_name or "", weight_spec)
            check_weights_valid(weights, has_invalid)
            validate_weight_semantics(weights, weight_type)
            positive_mass = sum(w for w in weights if w is not None and w > 0)
            if positive_mass <= 0:
                raise BizError("WEIGHT_NO_POSITIVE", "正のウェイトが存在しません。",
                               status_code=422)
            weight_status = weighted_status(True, positive_mass)
        result = compute_crosstab(
            df, row_name, col_name, codebook=codebook,
            missing_policy=context.missingPolicy, weights=weights,
            weight_type=weight_type, weight_column_id=weight_column_id,
            strata=df[design_names["strataColumnId"]].to_list() if design_names.get("strataColumnId") else None,
            psu=df[design_names["psuColumnId"]].to_list() if design_names.get("psuColumnId") else None,
            fpc=df[design_names["fpcColumnId"]].to_list() if design_names.get("fpcColumnId") else None,
            include_row_ids=req.includeRowIds,
            max_row_ids_per_cell=req.maxRowIdsPerCell,
            inference=req.inference,
            schema_revision=revisions.get("schemaRevision"),
        )
        mask_revision = store.mask_revision(context.datasetId)
        result_meta = build_meta(
            dataset_id=context.datasetId, revisions=revisions, scope=context.scope,
            scope_ids=scope_ids, effective_n=result["effectiveN"],
            missing_count=result["missingCount"],
            weight_applied=weight_status == "applied", weight_column=weight_name,
            mask_revision=mask_revision, algorithm_version=result["algorithmVersion"],
            is_explorative=False, warnings=result["warnings"])
        # ``weightedN`` is deliberately gone: a weight *sum* means a population
        # total, a normalized 1.0 or a rescaled sample size depending only on
        # how the weights were scaled, so calling it N asserted something the
        # number does not support (spec §8.2).
        return {**result, "meta": result_meta, "weightStatus": weight_status}


@router.post("/summaries/crosstab/cell-row-ids")
def crosstab_cell_row_ids(req: CrosstabCellRequest) -> dict:  # noqa: C901
    from ..algorithms.summaries.crosstab import _split_missing as _crosstab_split_missing
    from ..algorithms.summaries.crosstab import _category_spec as _crosstab_spec
    from ..domain.context import check_revisions, collect_revisions, resolve_scope

    context = req.context
    with store.lock(context.datasetId):
        meta = store.get_meta(context.datasetId)
        codebook = store.load_codebook(context.datasetId) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, context.expectedSchemaRevision, context.expectedDataRevision)
        from ..domain.analysis_columns import resolve_analysis_columns

        try:
            plan = resolve_analysis_columns(
                codebook, [req.rowVariableId, req.colVariableId],
                scales={"nominal", "ordinal", "binary"}, allow_ma_options=False,
                roles={"question", "attribute", "weight", "numeric_axis",
                       "categorical_axis", "feature"})
        except BizError as exc:
            if exc.code in ("MA_METHOD_UNSUPPORTED", "COLUMN_NOT_FOUND"):
                raise BizError("CROSSTAB_CATEGORY_REQUIRED" if exc.code == "MA_METHOD_UNSUPPORTED"
                               else "CROSSTAB_COLUMN_NOT_FOUND", exc.message,
                               status_code=422) from exc
            raise
        if len(plan.names) != 2:
            raise BizError("CROSSTAB_COLUMN_NOT_FOUND", "行変数または列変数が存在しません。",
                           status_code=422)
        row_name, col_name = plan.names[0], plan.names[1]
        df = store.get_dataframe(context.datasetId, columns=["__rowId__", row_name, col_name])
        scope_ids = resolve_scope([str(v) for v in df["__rowId__"].to_list()],
                                   __import__("app.domain.context", fromlist=["AnalysisContext"])
                                   .AnalysisContext(**context.model_dump()))
        df = df.filter(pl.col("__rowId__").is_in(scope_ids))
        row_spec = _crosstab_spec(codebook, req.rowVariableId)
        col_spec = _crosstab_spec(codebook, req.colVariableId)
        row_vals, _ = _crosstab_split_missing(df[row_name].to_list(), row_spec,
                                              context.missingPolicy,
                                              row_spec.get("missingReasons") or {})
        col_vals, _ = _crosstab_split_missing(df[col_name].to_list(), col_spec,
                                              context.missingPolicy,
                                              col_spec.get("missingReasons") or {})
        row_ids = [str(v) for v in df["__rowId__"].to_list()]

        matched = [row_id for row_id, row, col in zip(row_ids, row_vals, col_vals)
                   if row == req.rowCategoryId and col == req.colCategoryId]
        matched.sort()
        return {"datasetId": context.datasetId, **revisions,
                "rowCategoryId": req.rowCategoryId, "colCategoryId": req.colCategoryId,
                "rowIds": matched, "rowIdCount": len(matched), "rowIdsTruncated": False}


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
