"""APIs for multi-response summaries and matches."""
from __future__ import annotations

import hashlib
import json
import sys
from collections import OrderedDict
from copy import deepcopy
from threading import RLock
from typing import Any, Literal

import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..domain.errors import BizError
from ..domain.multi_response import prepare_classifier, match_group, resolve_groups, summarize_group, validate_group
from ..domain.codebook_adapter import normalize_code
from ..domain.survey_weight import extract_weights, resolve_weight_column
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()

# Descriptive ratios: the point estimate is weighted, but no design effect is
# estimated, so the warning says so rather than claiming a survey inference.
MA_WEIGHT_APPLIED_MESSAGE = "回答者重みで加重集計しました（設計効果は考慮しません）。"
_summary_cache: OrderedDict[tuple, tuple[dict, dict[str, int], tuple[str, ...], int]] = OrderedDict()
_summary_cache_lock = RLock()
_SUMMARY_CACHE_BYTES = 16 * 1024 * 1024


def _retained_size(value: Any) -> int:
    size = sys.getsizeof(value)
    if isinstance(value, dict):
        return size + sum(_retained_size(k) + _retained_size(v) for k, v in value.items())
    if isinstance(value, (list, tuple)):
        return size + sum(_retained_size(v) for v in value)
    return size


class MultiResponseRequestBase(BaseModel):
    datasetId: str
    rowIds: list[str] | None = None
    selectedRowIds: list[str] | None = None
    """Survey weight column (name or columnId). ``None`` = unweighted."""
    weightColumn: str | None = None
    expectedSchemaRevision: int | None = Field(default=None, gt=0)
    expectedDataRevision: int | None = Field(default=None, gt=0)


class MultiResponseSummaryRequest(MultiResponseRequestBase):
    groupIds: list[str]


class AttributeFilter(BaseModel):
    columnId: str
    code: str


class MultiResponseMatchRequest(BaseModel):
    groupId: str
    optionColumnIds: list[str] = Field(default_factory=list)
    predicate: Literal["any", "all", "unselected", "status"] = "any"
    status: Literal["valid", "partial", "missing", "notApplicable", "invalid"] | None = None
    rowIds: list[str] | None = None
    attributeFilter: AttributeFilter | None = None
    expectedSchemaRevision: int | None = Field(default=None, gt=0)
    expectedDataRevision: int | None = Field(default=None, gt=0)


class MultiResponseComparisonRequest(MultiResponseRequestBase):
    groupId: str
    attributeColumnId: str


def _load_meta_and_codebook(dataset_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    meta = store.get_meta(dataset_id)
    codebook = store.load_codebook(dataset_id) or {}
    return meta, codebook


def _collect_revisions(meta: dict[str, Any], codebook: dict[str, Any]) -> dict[str, int]:
    return {
        "schemaRevision": int(codebook.get("schemaRevision", meta.get("schemaRevision", 1))),
        "dataRevision": int(meta.get("dataRevision", 1)),
    }


def _check_revisions(
    revisions: dict[str, int],
    expected_schema_revision: int | None,
    expected_data_revision: int | None,
) -> None:
    if expected_schema_revision is not None and expected_schema_revision != revisions["schemaRevision"]:
        raise BizError(
            "ANALYSIS_INPUT_STALE",
            "保存・変換のため入力の世代が更新されています。",
            status_code=409,
            details={"schemaRevision": revisions["schemaRevision"], "expectedSchemaRevision": expected_schema_revision},
        )
    if expected_data_revision is not None and expected_data_revision != revisions["dataRevision"]:
        raise BizError(
            "ANALYSIS_INPUT_STALE",
            "保存・変換のため入力の世代が更新されています。",
            status_code=409,
            details={"dataRevision": revisions["dataRevision"], "expectedDataRevision": expected_data_revision},
        )


def _scope_row_ids(dataset_id: str, row_ids: list[str] | None) -> list[str]:
    scope_df = store.get_dataframe(dataset_id, columns=["__rowId__"])
    all_row_ids = [str(row_id) for row_id in scope_df["__rowId__"].to_list()]

    if row_ids is None:
        return all_row_ids

    wanted = {str(row_id) for row_id in row_ids}
    return [row_id for row_id in all_row_ids if row_id in wanted]


def _scope_hash(effective_row_ids: list[str]) -> str:
    unique_sorted = sorted(set(effective_row_ids))
    payload = json.dumps(unique_sorted, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _load_group_definitions(codebook: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        return resolve_groups(codebook)
    except ValueError as exc:
        raise BizError("MA_DEFINITION_INVALID", str(exc), status_code=422) from exc


def _select_groups(groups: list[dict[str, Any]], requested_group_ids: list[str]) -> list[dict[str, Any]]:
    by_group_id = {g["groupId"]: g for g in groups if isinstance(g, dict) and isinstance(g.get("groupId"), str)}
    seen: set[str] = set()
    selected: list[dict[str, Any]] = []

    for group_id in requested_group_ids:
        if not isinstance(group_id, str):
            raise BizError("MA_DEFINITION_INVALID", "groupId は文字列で指定してください。", status_code=422)
        if not group_id or not group_id.strip():
            raise BizError("MA_DEFINITION_INVALID", "groupId は空文字列にできません。", status_code=422)
        if group_id in seen:
            raise BizError("MA_DEFINITION_INVALID", f"groupId が重複しています: {group_id}", status_code=422)
        if group_id not in by_group_id:
            raise BizError("MA_DEFINITION_INVALID", f"存在しないgroupIdです: {group_id}", status_code=422)
        seen.add(group_id)
        selected.append(by_group_id[group_id])

    return selected


def _validate_groups(groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for group in groups:
        try:
            validate_group(group)
        except ValueError as exc:
            raise BizError("MA_DEFINITION_INVALID", str(exc), status_code=422) from exc
    return groups


def _member_names(group: dict[str, Any]) -> list[str]:
    return [
        str(column.get("name"))
        for column in (group.get("columns") or [])
        if isinstance(column, dict) and isinstance(column.get("name"), str)
    ]


def _apply_scope_filter(df: pl.DataFrame, row_ids: list[str] | None) -> pl.DataFrame:
    if row_ids is None:
        return df
    return df.filter(pl.col("__rowId__").is_in(row_ids))


def _weights_hash(row_ids: list[str], weights_by_row: dict[str, float | None]) -> str:
    """Hash of the resolved weights over the scope (same name, different values = different key)."""
    payload = json.dumps([[str(row_id), weights_by_row.get(str(row_id))] for row_id in row_ids],
                         ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _unsupported_weight(weight_column: str | None, column_id: str | None, message: str) -> dict[str, Any]:
    return {
        "weightStatus": "unsupported",
        "weightColumn": weight_column,
        "weightColumnId": column_id,
        "weightedN": None,
        "weightMissingCount": 0,
        "weightZeroCount": 0,
        "warnings": [{"code": "WEIGHT_UNSUPPORTED", "message": message}],
    }


def _weight_context(
    dataset_id: str,
    codebook: dict[str, Any],
    weight_column: str | None,
    effective_row_ids: list[str],
) -> tuple[dict[str, float | None] | None, str, dict[str, Any]]:
    """Resolve ``weightColumn`` for an MA aggregation (WEIGHT-03 / B05).

    Returns ``(weights_by_row | None, weights_hash, response block)``.  A
    reference that cannot be used (unknown column, wrong role, MA member,
    non-numeric scale, negative/non-finite values, no positive mass) degrades
    to unweighted aggregation with ``weightStatus: "unsupported"`` and a
    warning — the summary stays descriptive and the page keeps working.
    """
    if weight_column is None:
        return None, "", {"weightStatus": "omitted", "weightColumn": None, "weightColumnId": None,
                          "weightedN": None, "weightMissingCount": 0, "weightZeroCount": 0,
                          "warnings": []}
    try:
        spec = resolve_weight_column(codebook, weight_column)
    except BizError as error:
        return None, "", _unsupported_weight(weight_column, None, error.message)
    assert spec is not None
    frame = store.get_dataframe(dataset_id, columns=["__rowId__", spec["name"]])
    values, _missing, has_invalid = extract_weights(frame, spec["name"], spec)
    by_row = {str(row_id): weight for row_id, weight in zip(frame["__rowId__"].to_list(), values)}
    scoped = [by_row.get(str(row_id)) for row_id in effective_row_ids]
    if has_invalid:
        return None, "", _unsupported_weight(
            spec["name"], spec["columnId"],
            "ウェイト列に負値・非有限値・変換不能値が含まれているため、無加重で集計しました。")
    missing_count = sum(1 for weight in scoped if weight is None)
    zero_count = sum(1 for weight in scoped if weight == 0)
    positive_mass = round(sum(weight for weight in scoped if weight is not None and weight > 0), 4)
    if positive_mass <= 0:
        block = _unsupported_weight(spec["name"], spec["columnId"],
                                    "正のウェイトがないため、無加重で集計しました。")
        block["weightStatus"] = "no_positive_weight"
        block["weightMissingCount"] = missing_count
        block["weightZeroCount"] = zero_count
        return None, "", block
    return by_row, _weights_hash(effective_row_ids, by_row), {
        "weightStatus": "applied",
        "weightColumn": spec["name"],
        "weightColumnId": spec["columnId"],
        "weightedN": positive_mass,
        "weightMissingCount": missing_count,
        "weightZeroCount": zero_count,
        "warnings": [{"code": "MA_WEIGHT_APPLIED", "message": MA_WEIGHT_APPLIED_MESSAGE}],
    }


def _scope_weights(
    weights_by_row: dict[str, float | None] | None, df: pl.DataFrame
) -> list[float | None] | None:
    if weights_by_row is None:
        return None
    return [weights_by_row.get(str(row_id)) for row_id in df["__rowId__"].to_list()]


def _comparison_attribute(codebook: dict[str, Any], column_id: str) -> dict[str, Any]:
    attribute = next((column for column in codebook.get("columns", []) if column["columnId"] == column_id), None)
    if not attribute or attribute.get("role") != "attribute" or attribute.get("multiResponseGroup") or attribute.get("scaleType") in {"id", "text"}:
        raise BizError("MA_ATTRIBUTE_INVALID", "比較には通常の属性列を指定してください。", status_code=422)
    return attribute


def _attribute_codes(frame: pl.DataFrame, attribute: dict[str, Any]) -> list[str | None]:
    missing_codes = {normalize_code(value) for value in attribute.get("missingCodes", [])}
    return [code if code not in missing_codes else None
            for code in (normalize_code(value) for value in frame[attribute["name"]])]


@router.post("/summaries/multi-response/comparison")
def compare_multi_response(req: MultiResponseComparisonRequest) -> dict[str, Any]:
    with store.lock(req.datasetId):
        meta, codebook = _load_meta_and_codebook(req.datasetId)
        revisions = _collect_revisions(meta, codebook)
        _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        group = _validate_groups(_select_groups(_load_group_definitions(codebook), [req.groupId]))[0]
        attribute = _comparison_attribute(codebook, req.attributeColumnId)
        names = list(dict.fromkeys(["__rowId__", *_member_names(group), attribute["name"]]))
        frame = _apply_scope_filter(store.get_dataframe(req.datasetId, columns=names), req.rowIds)
        scope_ids = [str(row_id) for row_id in frame["__rowId__"].to_list()]
        scope = _scope_hash(scope_ids)
        weights_by_row, _weights_hash_value, weight_block = _weight_context(
            req.datasetId, codebook, req.weightColumn, scope_ids)
        codes = _attribute_codes(frame, attribute)
        missing_count = sum(code is None for code in codes)
        frame = frame.with_columns(pl.Series(attribute["name"], codes, dtype=pl.String))
        strata = []
        for (code,), subset in frame.filter(pl.col(attribute["name"]).is_not_null()).partition_by(attribute["name"], as_dict=True, maintain_order=True).items():
            summary = summarize_group(subset, group, selected_row_ids=req.selectedRowIds,
                                      weights=_scope_weights(weights_by_row, subset))
            strata.append({"code": code, "label": attribute.get("valueLabels", {}).get(code, code), "summary": summary})
        order = {code: index for index, code in enumerate(attribute.get("categoryOrder", []))}
        strata.sort(key=lambda item: (order.get(item["code"], len(order)), item["code"]))
        return {"datasetId": req.datasetId, **revisions, "scopeHash": scope, "scopeCount": len(codes),
                "attributeColumnId": req.attributeColumnId, "attributeMissingExcluded": missing_count,
                "groupId": req.groupId, "strata": strata, "usedColumns": names[1:],
                "method": "multiple-response-disjoint-attribute-strata", **weight_block}


@router.post("/summaries/multi-response")
def summarize_multi_response(req: MultiResponseSummaryRequest) -> dict[str, Any]:
    with store.lock(req.datasetId):
        return _summarize_multi_response(req)


def _summarize_multi_response(req: MultiResponseSummaryRequest) -> dict[str, Any]:
    meta, codebook = _load_meta_and_codebook(req.datasetId)
    revisions = _collect_revisions(meta, codebook)
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)

    effective_row_ids = _scope_row_ids(req.datasetId, req.rowIds)
    scope = _scope_hash(effective_row_ids)
    weights_by_row, weights_hash, weight_block = _weight_context(
        req.datasetId, codebook, req.weightColumn, effective_row_ids)

    groups = _load_group_definitions(codebook)
    if not req.groupIds:
        return {
            "datasetId": req.datasetId,
            "schemaRevision": revisions["schemaRevision"],
            "dataRevision": revisions["dataRevision"],
            "scopeHash": scope,
            "groups": [],
            "usedColumns": [],
            "excludedCounts": {},
            "method": "multiple-response-complete-case",
            **weight_block,
        }

    selected_groups = _select_groups(groups, req.groupIds)
    _validate_groups(selected_groups)

    used_columns: list[str] = []
    used_columns_set: set[str] = set()
    summaries: list[dict[str, Any]] = []
    excluded_counts: dict[str, dict[str, int]] = {}
    filter_ids = effective_row_ids if req.rowIds is not None else None
    # Imputed cells change what "complete case" means, so the mask revision
    # belongs in the cache key alongside the data revision.
    _mask_doc = store.load_mask(req.datasetId) or {}

    for group in selected_groups:
        group_columns = ["__rowId__", *_member_names(group)]
        key = (str(store.root.resolve()), req.datasetId, revisions["dataRevision"], revisions["schemaRevision"],
               meta.get("fingerprint"), scope, int((_mask_doc or {}).get("maskRevision", 0)),
               weight_block["weightColumnId"], weights_hash,
               json.dumps(group, sort_keys=True, ensure_ascii=False))
        with _summary_cache_lock:
            cached = _summary_cache.get(key)
            if cached is not None:
                _summary_cache.move_to_end(key)
        if cached is None:
            df = store.get_dataframe(req.datasetId, columns=group_columns)
            if filter_ids is not None:
                df = _apply_scope_filter(df, filter_ids)
            masks: dict[str, int] = {}
            try:
                base = summarize_group(df, group, selection_masks=masks,
                                       weights=_scope_weights(weights_by_row, df))
            except ValueError as exc:
                raise BizError("MA_DEFINITION_INVALID", str(exc), status_code=422) from exc
            row_ids = tuple(str(value) for value in df["__rowId__"].to_list())
            size = _retained_size((key, base, masks, row_ids)) + 1024
            cached = (base, masks, row_ids, size)
            if size <= _SUMMARY_CACHE_BYTES:
                with _summary_cache_lock:
                    _summary_cache[key] = cached
                    while sum(entry[3] for entry in _summary_cache.values()) > _SUMMARY_CACHE_BYTES:
                        _summary_cache.popitem(last=False)
        base, masks, row_ids, _ = cached
        selected = set(req.selectedRowIds or [])
        selected_bits = bytearray((len(row_ids) + 7) // 8)
        for index, row_id in enumerate(row_ids):
            if row_id in selected:
                selected_bits[index // 8] |= 1 << (index % 8)
        selected_mask = int.from_bytes(selected_bits, 'little')
        summary = deepcopy(base)
        for item in summary["items"]:
            item["selectedInSelection"] = (masks[item["columnId"]] & selected_mask).bit_count()

        summaries.append(summary)
        excluded_counts[summary["groupId"]] = summary["denominators"]

        for col_name in group_columns[1:]:
            if col_name not in used_columns_set:
                used_columns_set.add(col_name)
                used_columns.append(col_name)

    return {
        "datasetId": req.datasetId,
        "schemaRevision": revisions["schemaRevision"],
        "dataRevision": revisions["dataRevision"],
        "scopeHash": scope,
        "groups": summaries,
        "usedColumns": used_columns,
        "excludedCounts": excluded_counts,
        "method": "multiple-response-complete-case",
        **weight_block,
    }


@router.post("/datasets/{dataset_id}/matches")
def match_multi_response(dataset_id: str, req: MultiResponseMatchRequest) -> dict[str, Any]:
    with store.lock(dataset_id):
        return _match_multi_response(dataset_id, req)


def _match_multi_response(dataset_id: str, req: MultiResponseMatchRequest) -> dict[str, Any]:
    meta, codebook = _load_meta_and_codebook(dataset_id)
    revisions = _collect_revisions(meta, codebook)
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)

    groups = _load_group_definitions(codebook)
    selected = _select_groups(groups, [req.groupId])
    _validate_groups(selected)
    group = selected[0]

    group_columns = ["__rowId__", *_member_names(group)]
    attribute = _comparison_attribute(codebook, req.attributeFilter.columnId) if req.attributeFilter else None
    if attribute:
        group_columns.append(attribute["name"])
    effective_row_ids = _scope_row_ids(dataset_id, req.rowIds)
    scope = _scope_hash(effective_row_ids)
    filter_ids = effective_row_ids if req.rowIds is not None else None

    df = store.get_dataframe(dataset_id, columns=group_columns)
    if filter_ids is not None:
        df = _apply_scope_filter(df, filter_ids)

    if attribute and req.attributeFilter:
        wanted_code = normalize_code(req.attributeFilter.code)
        df = df.filter(pl.Series([code is not None and code == wanted_code for code in _attribute_codes(df, attribute)], dtype=pl.Boolean))

    try:
        matched = match_group(
            df=df,
            group=group,
            option_ids=req.optionColumnIds,
            mode=req.predicate,
            status=req.status,
        )
    except ValueError as exc:
        raise BizError("MA_DEFINITION_INVALID", str(exc), status_code=422) from exc

    return {
        "datasetId": dataset_id,
        "schemaRevision": revisions["schemaRevision"],
        "dataRevision": revisions["dataRevision"],
        "scopeHash": scope,
        "rowIds": matched,
        "count": len(matched),
    }


class TableEntity(BaseModel):
    kind: Literal["column", "ma", "maOption", "maCount"]
    columnId: str | None = None
    groupId: str | None = None


class ColorDomainRequest(BaseModel):
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None


@router.post("/datasets/{dataset_id}/color-domains")
def color_domains(dataset_id: str, req: ColorDomainRequest) -> dict[str, Any]:
    with store.lock(dataset_id):
        meta, codebook = _load_meta_and_codebook(dataset_id)
        revisions = _collect_revisions(meta, codebook)
        _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        specs = codebook.get("columns", [])
        domains = []
        for start in range(0, len(specs), 16):
            block = specs[start:start + 16]
            frame = store.get_dataframe(dataset_id, columns=[column["name"] for column in block])
            for column in block:
                counts = {}
                missing = set(column.get("missingCodes") or [])
                for raw in frame[column["name"]]:
                    code = normalize_code(raw)
                    if code is not None and code not in missing:
                        counts[code] = counts.get(code, 0) + 1
                    if len(counts) > 20:
                        break
                observed = set(counts)
                if not observed or len(observed) > 20:
                    continue
                numeric = frame[column["name"]].dtype.is_numeric()
                ordered = sorted(observed, key=lambda code: (float(code), code) if numeric else (code, code))
                declared = [code for code in column.get("categoryOrder", []) if code in observed]
                codes = list(dict.fromkeys([*declared, *ordered]))
                domains.append({"key": column["name"], "codes": codes, "counts": [counts[code] for code in codes], "numeric": numeric})
        return {"datasetId": dataset_id, **revisions, "domains": domains}


class TableSort(BaseModel):
    entityIndex: int = Field(ge=-1)
    order: Literal["ascend", "descend"] = "ascend"


class TableViewRequest(BaseModel):
    entityIds: list[TableEntity]
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=100, ge=1, le=200)
    rowIds: list[str] | None = None
    displayMode: Literal["labels", "raw"] = "labels"
    search: str = ""
    sort: TableSort | None = None
    rowWeights: dict[str, float] | None = None
    expectedSchemaRevision: int | None = Field(default=None, gt=0)
    expectedDataRevision: int | None = Field(default=None, gt=0)


def _table_value(value: Any, column: dict[str, Any], mode: str) -> dict[str, Any]:
    code = normalize_code(value)
    missing = code is None or code in (column.get("missingCodes") or [])
    reason = (column.get("missingReasons") or {}).get(code, "欠損" if missing else "")
    label = (column.get("valueLabels") or {}).get(code, code)
    text = (code or "") if mode == "raw" else (reason if missing else label)
    return {"value": value if code is not None else None, "text": text, "isMissing": missing}


@router.post("/datasets/{dataset_id}/table-view")
def table_view(dataset_id: str, req: TableViewRequest) -> dict[str, Any]:
    with store.lock(dataset_id):
        return _table_view(dataset_id, req)


def _table_view(dataset_id: str, req: TableViewRequest) -> dict[str, Any]:
    meta, codebook = _load_meta_and_codebook(dataset_id)
    revisions = _collect_revisions(meta, codebook)
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
    columns = {c["columnId"]: c for c in codebook.get("columns", [])}
    groups = {g["groupId"]: g for g in _load_group_definitions(codebook)}
    plans: list[tuple[TableEntity, dict[str, Any]]] = []
    used: list[str] = []
    for entity in req.entityIds:
        if entity.kind == "column":
            spec = columns.get(entity.columnId)
            if spec is None:
                raise BizError("TABLE_ENTITY_INVALID", "指定列が存在しません。", status_code=422)
            names = [spec["name"]]
        else:
            spec = groups.get(entity.groupId)
            if spec is None:
                raise BizError("MA_DEFINITION_INVALID", "指定設問が存在しません。", status_code=422)
            _validate_groups([spec])
            if entity.kind == "maOption" and entity.columnId not in {c["columnId"] for c in spec["columns"]}:
                raise BizError("MA_DEFINITION_INVALID", "指定選択肢は設問に所属していません。", status_code=422)
            names = _member_names(spec)
        used.extend(n for n in names if n not in used)
        plans.append((entity, spec))
    if req.sort and req.sort.entityIndex == -1 and req.rowWeights is None:
        raise BizError("TABLE_SORT_UNSUPPORTED", "行の重みが指定されていません。", status_code=422)
    if req.sort and req.sort.entityIndex != -1 and (req.sort.entityIndex >= len(plans) or plans[req.sort.entityIndex][0].kind not in {"column", "maCount"}):
        raise BizError("TABLE_SORT_UNSUPPORTED", "通常列または選択数を並べ替えてください。", status_code=422)
    frame = _apply_scope_filter(store.get_dataframe(dataset_id, columns=["__rowId__", *used]), req.rowIds)
    scope = _scope_hash(frame["__rowId__"].to_list())
    positions = {name: i for i, name in enumerate(frame.columns)}
    classifiers = {group_id: prepare_classifier(groups[group_id])
                   for group_id in {entity.groupId for entity, _ in plans if entity.kind != "column"}}

    def cell(row: tuple, entity: TableEntity, spec: dict) -> dict:
        if entity.kind == "column":
            return _table_value(row[positions[spec["name"]]], spec, req.displayMode)
        status, selected = classifiers[entity.groupId]([row[positions[c["name"]]] for c in spec["columns"]])
        if entity.kind == "maOption":
            column = columns[entity.columnId]
            return {**_table_value(row[positions[column["name"]]], column, req.displayMode), "status": status}
        if entity.kind == "maCount":
            value = len(selected) if status == "valid" else None
            return {"value": value, "text": str(value) if value is not None else "欠損", "status": status}
        members = {c["columnId"]: c for c in spec["columns"]}
        labels = [members[c].get("multiResponseOptionLabel") or members[c].get("label") or members[c]["name"] for c in selected]
        result = {"status": status, "selectedCount": len(selected), "optionColumnIds": selected, "labels": labels}
        if req.displayMode == "raw":
            result["text"] = ", ".join(f'{c["name"]}={normalize_code(row[positions[c["name"]]]) or ""}' for c in spec["columns"])
        return result

    # Only retain row positions and sort keys; page cells are formatted after scope/search/sort.
    indexes: list[tuple[int, Any]] = []
    query = req.search.strip().casefold()
    for index, row in enumerate(frame.iter_rows()):
        if query:
            texts = [str(row[positions["__rowId__"]])]
            for entity, spec in plans:
                value = cell(row, entity, spec)
                texts.extend([str(value.get("text", "")), str(value.get("value", "")), *value.get("labels", [])])
            if not any(query in t.casefold() for t in texts):
                continue
        key = None
        if req.sort and req.sort.entityIndex == -1:
            key = (req.rowWeights or {}).get(str(row[positions["__rowId__"]]), 1)
        elif req.sort:
            entity, spec = plans[req.sort.entityIndex]
            key = cell(row, entity, spec).get("value")
            if entity.kind == "column" and spec.get("scaleType") == "ordinal":
                order = spec.get("categoryOrder") or []
                if spec.get("isReversed"):
                    order = list(reversed(order))
                code = normalize_code(key)
                key = order.index(code) if code in order else None
        indexes.append((index, key))
    if req.sort:
        present = [(i, k) for i, k in indexes if k is not None]
        absent = [(i, k) for i, k in indexes if k is None]
        present.sort(key=lambda item: (0, item[1]) if isinstance(item[1], (int, float)) else (1, str(item[1])), reverse=req.sort.order == "descend")
        indexes = present + absent
    rows = []
    for index, _ in indexes[req.offset:req.offset + req.limit]:
        row = frame.row(index)
        rows.append({"rowId": str(row[positions["__rowId__"]]), "cells": [cell(row, entity, spec) for entity, spec in plans]})
    current_meta, current_cb = _load_meta_and_codebook(dataset_id)
    _check_revisions(_collect_revisions(current_meta, current_cb), revisions["schemaRevision"], revisions["dataRevision"])
    return {"datasetId": dataset_id, **revisions, "scopeHash": scope, "usedColumns": used,
            "excludedCounts": {}, "method": "table-view", "rows": rows, "total": len(indexes),
            "offset": req.offset, "limit": req.limit,
            "entities": [{**entity.model_dump(exclude_none=True), "label": spec.get("label") or spec.get("name") or spec.get("groupId"),
                          "sortable": entity.kind in {"column", "maCount"}} for entity, spec in plans]}
