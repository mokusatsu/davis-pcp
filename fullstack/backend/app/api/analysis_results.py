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
    arrays = result_store.load_arrays(result_id)
    summary = {"rank": int(arrays["eigenvalues"].shape[0]), "eigenvalues": [float(v) for v in arrays["eigenvalues"].tolist()]}
    payload = {"status": "success", "resultId": result_id, "method": manifest.get("method"), "meta": meta, "config": manifest.get("config"), "capabilities": manifest.get("capabilities"), "summary": summary, "details": {"note": "full details available from POST /models/ca response or export"} , "unavailableReasons": manifest.get("unavailableReasons", {})}
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
    check_revisions(cur, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
    members = result_store.load_members(result_id)
    if members is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no members", 422)
    sel = req.selector
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
            sets = [set(by_cat.get(c, [])) for c in sel.categoryIds]
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
    allowed = set((manifest.get("capabilities") or {}).get("exportTables", []))
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
    cats = members.rows(named=True) if members is not None else []
    rows_all = [{"categoryId": r["categoryId"], "rowId": r["rowId"], "side": r["side"]} for r in cats]
    total = len(rows_all)
    part = rows_all[offset:offset + limit]
    nxt = offset + len(part) if offset + len(part) < total else None
    if req.format == "json":
        body = {"columns": ["categoryId", "rowId", "side"], "rows": [[p["categoryId"], escape_formula_prefix(str(p["rowId"])), p["side"]] for p in part]}
        payload_text = json.dumps(body, ensure_ascii=False, allow_nan=False)
        mime = "application/json"
    else:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["categoryId", "rowId", "side"])
        for p in part:
            w.writerow([p["categoryId"], escape_formula_prefix(str(p["rowId"])), p["side"]])
        payload_text = buf.getvalue()
        mime = "text/csv"
    out = {"status": "success", "mime": mime, "fileName": f"{result_id}-categories.{req.format}", "encoding": "utf-8", "payload": payload_text, "offset": offset, "total": total, "nextOffset": nxt, "hasHeader": req.format == "csv", "snapshot": {"datasetId": meta.get("datasetId"), "dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"), "resultId": result_id}}
    check_json_finite(out)
    return out
