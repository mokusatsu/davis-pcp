"""Common analysis result API (Features 029-034, CA slice)."""
from __future__ import annotations
import csv
import io
import json
from typing import Any
from fastapi import APIRouter, Body
from pydantic import ValidationError
from ..domain.analysis_contracts import ExportRequest, SelectRequest
from ..domain.context import AnalysisContext, check_revisions, collect_revisions, resolve_scope
from ..domain.errors import BizError
from ..services.analysis_service import check_json_finite, escape_formula_prefix
from ..storage import analysis_result_store as result_store
from ..storage.dataset_store import DatasetStore
router = APIRouter()
store = DatasetStore()


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _stale_state(manifest):
    meta = manifest.get("meta", {})
    ds = manifest.get("ownerDatasetId")
    try:
        cur_meta = store.get_meta(ds)
        cur_code = store.load_codebook(ds) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
    except BizError as exc:
        if exc.code == "DATASET_NOT_FOUND":
            raise BizError("ANALYSIS_RESULT_NOT_FOUND", "dataset deleted", status_code=404)
        raise
    stale = (cur_rev["dataRevision"] != meta.get("dataRevision") or cur_rev["schemaRevision"] != meta.get("schemaRevision"))
    out_meta = dict(meta)
    out_meta["currentDataRevision"] = cur_rev["dataRevision"]
    out_meta["currentSchemaRevision"] = cur_rev["schemaRevision"]
    out_meta["resultState"] = "stale" if stale else "current"
    return out_meta, stale, cur_rev


@router.get("/analysis-results/{result_id}")
def get_result(result_id):
    manifest = result_store.load_manifest(result_id)
    meta, stale, cur = _stale_state(manifest)
    summary = manifest.get("summary") or {}
    details = manifest.get("details") or {}
    if not summary or not details:
        arrays = result_store.load_arrays(result_id)
        summary = {"rank": int(arrays["eigenvalues"].shape[0]), "eigenvalues": [float(v) for v in arrays["eigenvalues"].tolist()]}
        details = {"note": "full details available from POST /models/ca response or export"}
    payload = {"status": "success", "resultId": result_id, "method": manifest.get("method"), "meta": meta, "config": manifest.get("config"), "capabilities": manifest.get("capabilities"), "summary": summary, "details": details, "unavailableReasons": manifest.get("unavailableReasons", {})}
    check_json_finite(payload)
    return payload


@router.delete("/analysis-results/{result_id}", status_code=204)
def delete_result(result_id):
    result_store.delete_result(result_id)
    from fastapi.responses import Response as _R
    return _R(status_code=204)


@router.post("/analysis-results/{result_id}/select")
def select_result(result_id: str, payload: dict = Body(...)):
    try:
        req = SelectRequest.model_validate(payload)
    except ValidationError:
        _err("ANALYSIS_REQUEST_INVALID", "bad select", 422)
    manifest = result_store.load_manifest(result_id)
    meta, stale, cur = _stale_state(manifest)
    if stale:
        _err("ANALYSIS_INPUT_STALE", "stale result", 409)
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH", "結果の所有データセットと一致しません。", 422,
             details={"ownerDatasetId": manifest.get("ownerDatasetId")})
    check_revisions(cur, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
    members = result_store.load_members(result_id)
    if members is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no members", 422)
    sel = req.selector
    allowed_kinds = set((manifest.get("capabilities") or {}).get("selectionKinds", []))
    if sel.kind not in allowed_kinds:
        _err("ANALYSIS_SELECTOR_UNSUPPORTED", "この結果では未対応のselectorです。", 422,
             details={"allowedKinds": sorted(allowed_kinds)})
    if sel.kind == "row_ids":
        wanted = [str(v) for v in sel.rowIds]
        pool = members["rowId"].to_list()
    elif sel.kind == "categories":
        known = set(members["categoryId"].to_list())
        unknown = [c for c in sel.categoryIds if c not in known]
        if unknown:
            _err("ANALYSIS_SELECT_UNKNOWN_CATEGORY", "unknown category", 422)
        by_cat = {}
        for cid, rid, side in members.iter_rows():
            by_cat.setdefault(cid, []).append(str(rid))
        method = manifest.get("method")
        config = manifest.get("config", {})
        table_mode = isinstance(config.get("input"), dict) and config["input"].get("kind") == "contingency"
        if table_mode:
            cols = [c for c in sel.categoryIds if str(members.filter(members["categoryId"] == c)["side"].to_list()[0]) == "column"] if sel.categoryIds else []
            if cols:
                _err("CA_TABLE_COLUMN_SELECT_UNSUPPORTED", "use highlight", 422)
            union = set()
            for c in sel.categoryIds:
                union |= set(by_cat.get(c, []))
            sets = [union]
        else:
            sides = {}
            for c in sel.categoryIds:
                s = str(members.filter(members["categoryId"] == c)["side"].to_list()[0])
                sides.setdefault(s, []).append(c)
            per_side = [set().union(*[set(by_cat.get(c, [])) for c in cats]) if cats else set() for cats in sides.values()]
            if sel.betweenVariables == "or" or len(per_side) <= 1:
                sets = [set().union(*per_side)] if per_side else [set()]
            else:
                base = set(per_side[0])
                for s in per_side[1:]:
                    base &= set(s)
                sets = [base]
        wanted = sorted(sets[0]) if sets else []
        pool = wanted
    else:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "bad selector", 422)
    matched = len(set(pool))
    df = store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__"])
    all_ids = [str(v) for v in df["__rowId__"].to_list()]
    legacy = AnalysisContext(datasetId=manifest.get("ownerDatasetId"), expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
    scope_ids = set(resolve_scope(all_ids, legacy))
    inter = sorted(set(wanted) & scope_ids)
    label = "CA categories" if sel.kind == "categories" else "rows"
    out = {"status": "success", "resultId": result_id, "rowIds": inter, "matchedCount": matched, "fitMatchedCount": matched, "contextIntersectionCount": len(inter), "selectionLabel": label}
    check_json_finite(out)
    return out


@router.post("/analysis-results/{result_id}/predict")
def predict_result(result_id: str, payload: dict = Body(...)):
    _err("ANALYSIS_OPERATION_UNSUPPORTED", "CA predict unsupported", 422)


@router.post("/analysis-results/{result_id}/materialize")
def materialize_result(result_id: str, payload: dict = Body(...)):
    _err("ANALYSIS_OPERATION_UNSUPPORTED", "CA materialize unsupported", 422)


@router.post("/analysis-results/{result_id}/export")
def export_result(result_id: str, payload: dict = Body(...)):
    try:
        req = ExportRequest.model_validate(payload)
    except ValidationError:
        _err("ANALYSIS_REQUEST_INVALID", "bad export", 422)
    manifest = result_store.load_manifest(result_id)
    meta, stale, cur = _stale_state(manifest)
    allowed = set((manifest.get("capabilities") or {}).get("exportTables", [])) | {"members"}
    if req.table not in allowed:
        _err("ANALYSIS_EXPORT_UNSUPPORTED", "bad table", 422)
    arrays = result_store.load_arrays(result_id)
    members = result_store.load_members(result_id)
    limit = int(req.limit)
    offset = int(req.offset)
    if req.table == "manifest":
        body = {"resultId": result_id, "method": manifest.get("method"), "meta": meta, "config": manifest.get("config"), "capabilities": manifest.get("capabilities")}
        out = {"status": "success", "mime": "application/json", "fileName": f"{result_id}-manifest.json", "encoding": "utf-8", "payload": json.dumps(body, ensure_ascii=False, allow_nan=False), "offset": 0, "total": 1, "nextOffset": None, "hasHeader": False, "snapshot": {"datasetId": meta.get("datasetId"), "dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"), "resultId": result_id}}
        check_json_finite(out)
        return out
    if req.table == "eigenvalues":
        eig = [float(v) for v in arrays["eigenvalues"].tolist()]
        total = len(eig)
        part = eig[offset:offset + limit]
        nxt = offset + len(part) if offset + len(part) < total else None
        if req.format == "json":
            body = {"columns": ["axis", "eigenvalue"], "rows": [[i + 1, v] for i, v in enumerate(part, start=offset)]}
            payload_text = json.dumps(body, ensure_ascii=False, allow_nan=False)
            mime = "application/json"
        else:
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["axis", "eigenvalue"])
            for i, v in enumerate(part, start=offset):
                w.writerow([i + 1, repr(float(v))])
            payload_text = buf.getvalue()
            mime = "text/csv"
        out = {"status": "success", "mime": mime, "fileName": f"{result_id}-eigenvalues.{req.format}", "encoding": "utf-8", "payload": payload_text, "offset": offset, "total": total, "nextOffset": nxt, "hasHeader": req.format == "csv", "snapshot": {"datasetId": meta.get("datasetId"), "dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"), "resultId": result_id}}
        check_json_finite(out)
        return out
    if req.table == "table":
        return _export_table(manifest, meta, result_id, req)
    if req.table == "members":
        mem = result_store.load_members(result_id)
        rows = [[str(a), str(b), str(c)] for a, b, c in (mem.iter_rows() if mem is not None else [])]
        total = len(rows)
        part = rows[offset:offset + limit]
        nxt = offset + len(part) if offset + len(part) < total else None
        body = {"columns": ["categoryId", "rowId", "side"], "rows": part}
        out = {"status": "success", "mime": "application/json", "fileName": f"{result_id}-members.json", "encoding": "utf-8", "payload": json.dumps(body, ensure_ascii=False, allow_nan=False), "offset": offset, "total": total, "nextOffset": nxt, "hasHeader": False, "snapshot": {"datasetId": meta.get("datasetId"), "dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"), "resultId": result_id}}
        check_json_finite(out)
        return out
    details = manifest.get("details") or {}
    cat_rows = list(details.get("rowCategories") or []) + list(details.get("columnCategories") or [])
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    header = ["categoryId", "side", "variableId", "code", "kind", "label", "mass"] + [f"principal{i+1}" for i in range(rank)] + [f"contribution{i+1}" for i in range(rank)] + [f"cos2_{i+1}" for i in range(rank)]
    rows_all = []
    for e in cat_rows:
        princ = list(e.get("principalCoordinates") or [])
        contrib = list(e.get("contributions") or [])
        cos2 = list(e.get("cos2") or [])
        rows_all.append([e.get("categoryId"), e.get("side"), e.get("variableId"), e.get("code"), e.get("kind"), e.get("label"), e.get("mass")] + [princ[i] if i < len(princ) else None for i in range(rank)] + [contrib[i] if i < len(contrib) else None for i in range(rank)] + [cos2[i] if i < len(cos2) else None for i in range(rank)])
    total = len(rows_all)
    part = rows_all[offset:offset + limit]
    nxt = offset + len(part) if offset + len(part) < total else None
    if req.format == "json":
        body = {"columns": header, "rows": [[(escape_formula_prefix(str(v)) if isinstance(v, str) else v) for v in row] for row in part]}
        payload_text = json.dumps(body, ensure_ascii=False, allow_nan=False)
        mime = "application/json"
    else:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(header)
        for row in part:
            w.writerow([(escape_formula_prefix(str(v)) if isinstance(v, str) else ("" if v is None else repr(float(v)) if isinstance(v, float) else v)) for v in row])
        payload_text = buf.getvalue()
        mime = "text/csv"
    out = {"status": "success", "mime": mime, "fileName": f"{result_id}-categories.{req.format}", "encoding": "utf-8", "payload": payload_text, "offset": offset, "total": total, "nextOffset": nxt, "hasHeader": req.format == "csv", "snapshot": {"datasetId": meta.get("datasetId"), "dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"), "resultId": result_id}}
    check_json_finite(out)
    return out


def _export_table(manifest, meta, result_id, req):
    details = manifest.get("details") or {}
    table = details.get("table") or []
    row_ids = details.get("tableRowCategoryIds") or []
    col_ids = details.get("tableColumnCategoryIds") or []
    long_rows = []
    for i, row in enumerate(table):
        for j, v in enumerate(row):
            long_rows.append([row_ids[i] if i < len(row_ids) else i, col_ids[j] if j < len(col_ids) else j, float(v)])
    total = len(long_rows)
    part = long_rows[req.offset:req.offset + req.limit]
    nxt = req.offset + len(part) if req.offset + len(part) < total else None
    if req.format == "json":
        body = {"columns": ["rowCategoryId", "columnCategoryId", "value"], "rows": part}
        payload_text = json.dumps(body, ensure_ascii=False, allow_nan=False)
        mime = "application/json"
    else:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["rowCategoryId", "columnCategoryId", "value"])
        for row in part:
            w.writerow([row[0], row[1], repr(float(row[2]))])
        payload_text = buf.getvalue()
        mime = "text/csv"
    out = {"status": "success", "mime": mime, "fileName": f"{result_id}-table.{req.format}", "encoding": "utf-8", "payload": payload_text, "offset": req.offset, "total": total, "nextOffset": nxt, "hasHeader": req.format == "csv", "snapshot": {"datasetId": meta.get("datasetId"), "dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"), "resultId": result_id}}
    check_json_finite(out)
    return out
