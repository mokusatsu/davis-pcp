"""SparsePCA fitting and method-specific result handlers."""
from __future__ import annotations

import csv
import io
import json
import re

from fastapi import APIRouter, Body
from pydantic import ValidationError
from ..domain.context import AnalysisContext, resolve_scope
from ..domain.errors import BizError
from ..domain.sparse_pca_contracts import SparsePcaRequest
from ..services import sparse_pca_service as service
from ..services.analysis_service import escape_formula_prefix
from ..storage import analysis_result_store as result_store

router = APIRouter()
store = service.store


def _err(code, message, status=422):
    raise BizError(code, message, status_code=status)


@router.post("/models/sparse-pca")
def fit_sparse_pca(payload: dict = Body(...)):
    try:
        request = SparsePcaRequest.model_validate(payload)
    except ValidationError as exc:
        raise BizError("ANALYSIS_REQUEST_INVALID", "SparsePCAの設定が不正です。", status_code=422,
                       details={"fields": [list(e["loc"]) for e in exc.errors()]}) from exc
    return service.fit_and_save(request)


def validate_axes(axes, count: int, *, maximum=2):
    if axes is None:
        selected = list(range(1, min(2, count) + 1))
    elif isinstance(axes, str):
        parts = axes.split(",")
        if any(not re.fullmatch(r"[0-9]+", p.strip()) for p in parts):
            _err("ANALYSIS_REQUEST_INVALID", "axesには存在する成分番号を指定してください。")
        selected = [int(p.strip()) for p in parts]
    else:
        selected = list(axes)
    if not 1 <= len(selected) <= maximum or len(set(selected)) != len(selected) or any(type(a) is not int or not 1 <= a <= count for a in selected):
        _err("ANALYSIS_REQUEST_INVALID", "axesは重複のない有効な成分番号を最大2個指定してください。")
    return selected


def _rows(result_id):
    frame = result_store.load_rows(result_id)
    if frame is None:
        _err("ANALYSIS_RESULT_NOT_FOUND", "保存得点が見つかりません。", 404)
    return frame


def sparse_pca_rows(result_id, manifest, meta, offset=0, limit=5000, axes=None):
    if offset < 0 or not 1 <= limit <= 10000:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limitが不正です。")
    selected = validate_axes(axes, manifest["summary"]["nComponents"])
    frame = _rows(result_id)
    part = frame.slice(offset, limit)
    return {"status": "success", "resultId": result_id, "offset": offset, "limit": limit,
        "total": frame.height, "nextOffset": offset + part.height if offset + part.height < frame.height else None,
        "axes": selected, "rows": [{"rowId": row["rowId"], "coordinates": [row[f"SP{a}"] for a in selected]}
                                   for row in part.to_dicts()], "meta": meta}


def sparse_pca_select(result_id, manifest, req):
    selector = req.selector
    frame = _rows(result_id)
    records = frame.to_dicts()
    if selector.kind == "row_ids":
        selected = set(selector.rowIds)
        wanted = [row["rowId"] for row in records if row["rowId"] in selected]
    elif selector.kind == "rectangle":
        axes = validate_axes(selector.axes, manifest["summary"]["nComponents"])
        wanted = [row["rowId"] for row in records if all(lo <= row[f"SP{a}"] <= hi
                  for a, (lo, hi) in zip(axes, selector.bounds))]
    else:
        _err("ANALYSIS_SELECTOR_UNSUPPORTED", "SparsePCAでは行IDまたは得点矩形を選択してください。")
    ctx = req.context.model_dump()
    all_ids = [str(v) for v in store.get_dataframe(manifest["ownerDatasetId"], columns=["__rowId__"])["__rowId__"].to_list()]
    scope = set(resolve_scope(all_ids, AnalysisContext(**ctx)))
    intersection = [rid for rid in wanted if rid in scope]
    return {"status": "success", "resultId": result_id, "rowIds": intersection,
        "matchedCount": len(wanted), "fitMatchedCount": len(wanted),
        "contextIntersectionCount": len(intersection), "selectionLabel": "SparsePCA 得点の選択"}


def sparse_pca_export(manifest, meta, result_id, req):
    details = manifest["details"]
    if req.table not in service.CAPABILITIES["exportTables"]:
        _err("ANALYSIS_EXPORT_UNSUPPORTED", "SparsePCAで出力できない表です。")
    if req.table == "manifest":
        body = {k: manifest[k] for k in ("schemaVersion", "resultId", "method", "config", "capabilities", "summary", "details", "unavailableReasons", "meanings")}
        body["meta"] = meta
        payload = json.dumps(body, ensure_ascii=False, indent=2, allow_nan=False)
        total, page, next_offset = 1, [], None
    else:
        columns, source = [], []
        if req.table == "coefficients":
            columns = ["variableId", "variableName", "variableLabel", "component", "reconstructionCoefficient", "scoreCoefficient", "exactZero"]
            for j, variable in enumerate(details["variables"]):
                for i, name in enumerate(details["componentOrder"]):
                    b = details["components"][i][j]
                    source.append([variable["columnId"], variable["name"], variable["label"], name, b,
                                   details["scoreCoefficients"][j][i], b == 0])
        elif req.table == "variables":
            columns = ["variableId", "variableName", "variableLabel", "component", "correlation", "reason"]
            for j, variable in enumerate(details["variables"]):
                for i, name in enumerate(details["componentOrder"]):
                    source.append([variable["columnId"], variable["name"], variable["label"], name,
                        details["variableScoreCorrelations"][j][i], details["variableScoreCorrelationReasons"][j][i]])
        elif req.table == "diagnostics":
            columns = ["componentX", "componentY", "correlation", "reason"]
            for i, x in enumerate(details["componentOrder"]):
                for j, y in enumerate(details["componentOrder"]):
                    source.append([x, y, details["scoreCorrelations"][i][j], details["scoreCorrelationReasons"][i][j]])
        elif req.table == "rows":
            columns = ["rowId", *details["componentOrder"]]
            source = [[row[column] for column in columns] for row in _rows(result_id).to_dicts()]
        total = len(source)
        page = source[req.offset:req.offset + req.limit]
        next_offset = req.offset + len(page) if req.offset + len(page) < total else None
        if req.format == "json":
            body = {"columns": columns, "rows": page}
            if req.table == "diagnostics":
                body["summary"] = manifest["summary"]
            payload = json.dumps(body, ensure_ascii=False, allow_nan=False)
        else:
            stream = io.StringIO(); writer = csv.writer(stream)
            writer.writerow(columns)
            writer.writerows([[escape_formula_prefix(value) if isinstance(value, str) else value for value in row] for row in page])
            payload = stream.getvalue()
    return {"status": "success", "fileName": f"{result_id}-{req.table}.{req.format}",
        "mime": "application/json" if req.format == "json" else "text/csv", "payload": payload,
        "encoding": "utf-8", "offset": req.offset, "total": total, "nextOffset": next_offset,
        "hasHeader": req.format == "csv", "snapshot": {"datasetId": meta["datasetId"],
            "dataRevision": meta["dataRevision"], "schemaRevision": meta["schemaRevision"], "resultId": result_id}}
