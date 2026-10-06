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


def _lr_rows(result_id, manifest, meta, offset=0, limit=5000, axes=None):
    """Feature 032 fit rows paging (LR rejects axes)."""
    if axes is not None:
        _err("ANALYSIS_REQUEST_INVALID", "回帰では axes を指定できません。", 422)
    if limit < 1 or limit > 10000 or offset < 0:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    total = int(rows_df.height)
    if offset >= total:
        out = {"status": "success", "resultId": result_id, "offset": offset,
               "limit": limit, "total": total, "nextOffset": None,
               "axes": None, "rows": [],
               "meta": {"dataRevision": meta.get("dataRevision"),
                        "schemaRevision": meta.get("schemaRevision"),
                        "resultState": meta.get("resultState")}}
        check_json_finite(out)
        return out
    part = rows_df.slice(offset, limit)
    out_rows = []
    for rec in part.rows(named=True):
        out_rows.append({
            "rowId": str(rec.get("rowId")),
            "observed": None if rec.get("observed") is None else float(rec.get("observed")),
            "fitted": None if rec.get("fitted") is None else float(rec.get("fitted")),
            "residual": None if rec.get("residual") is None else float(rec.get("residual")),
            "leverageTotal": None if rec.get("leverageTotal") is None else float(rec.get("leverageTotal")),
            "leveragePerReplica": None if rec.get("leveragePerReplica") is None else float(rec.get("leveragePerReplica")),
            "studentizedResidual": None if rec.get("studentizedResidual") is None else float(rec.get("studentizedResidual")),
            "cooksDistance": None if rec.get("cooksDistance") is None else float(rec.get("cooksDistance")),
        })
    nxt = offset + part.height if offset + part.height < total else None
    out = {"status": "success", "resultId": result_id, "offset": offset,
           "limit": limit, "total": total, "nextOffset": nxt,
           "axes": None, "rows": out_rows,
           "meta": {"dataRevision": meta.get("dataRevision"),
                    "schemaRevision": meta.get("schemaRevision"),
                    "resultState": meta.get("resultState")}}
    check_json_finite(out)
    return out


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
    if manifest.get("method") == "sparse_pca":
        stale = stale or store.mask_revision(ds) != meta.get("maskRevision")
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
    if manifest.get("method") == "regularized_regression":
        payload["portableModel"] = manifest["portableModel"]
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
    sel = req.selector
    allowed_kinds = set((manifest.get("capabilities") or {}).get("selectionKinds", []))
    if sel.kind not in allowed_kinds:
        _err("ANALYSIS_SELECTOR_UNSUPPORTED", "この結果では未対応のselectorです。", 422,
             details={"allowedKinds": sorted(allowed_kinds)})
    if manifest.get("method") == "sparse_pca":
        from .sparse_pca import sparse_pca_select
        return sparse_pca_select(result_id, manifest, req)
    if manifest.get("method") == "efa":
        from ..api.factor_analysis import efa_select_ids as _efa_select

        wanted = _efa_select(result_id, manifest, sel)
        pool = list(wanted)
        matched = len(set(pool))
        df = store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__"])
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=manifest.get("ownerDatasetId"), expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = set(resolve_scope(all_ids, legacy))
        inter = sorted(set(wanted) & scope_ids)
        out = {"status": "success", "resultId": result_id, "rowIds": inter, "matchedCount": matched, "fitMatchedCount": matched, "contextIntersectionCount": len(inter), "selectionLabel": "EFA 因子得点の選択"}
        check_json_finite(out)
        return out
    if manifest.get("method") == "conjoint":
        from ..api.conjoint import conjoint_select_ids as _cj_select

        wanted = _cj_select(result_id, manifest, sel)
        pool = list(wanted)
        matched = len(set(pool))
        df = store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__"])
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=manifest.get("ownerDatasetId"), expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = set(resolve_scope(all_ids, legacy))
        inter = sorted(set(wanted) & scope_ids)
        out = {"status": "success", "resultId": result_id, "rowIds": inter, "matchedCount": matched, "fitMatchedCount": matched, "contextIntersectionCount": len(inter), "selectionLabel": "コンジョイントの選択"}
        check_json_finite(out)
        return out
    if manifest.get("method") == "linear_regression":
        from ..api.linear_regression import lr_select_ids as _lr_select

        wanted = _lr_select(result_id, manifest, sel)
        pool = list(wanted)
        matched = len(set(pool))
        df = store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__"])
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=manifest.get("ownerDatasetId"), expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = set(resolve_scope(all_ids, legacy))
        inter = sorted(set(wanted) & scope_ids)
        out = {"status": "success", "resultId": result_id, "rowIds": inter, "matchedCount": matched, "fitMatchedCount": matched, "contextIntersectionCount": len(inter), "selectionLabel": "重回帰 診断図の選択" if sel.kind == "diagnostic_rectangle" else "rows"}
        check_json_finite(out)
        return out
    members = result_store.load_members(result_id)
    if members is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no members", 422)
    if sel.kind == "row_ids":
        wanted = [str(v) for v in sel.rowIds]
        pool = members["rowId"].to_list()
    elif sel.kind == "rectangle" and manifest.get("method") in ("mca", "famd"):
        wanted = _mca_rectangle_ids(result_id, manifest, sel)
        pool = wanted
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
        elif manifest.get("method") in ("mca", "famd"):
            var_of = {}
            for cat in (manifest.get("details") or {}).get("categories", []) or []:
                var_of[cat.get("categoryId")] = cat.get("variableId")
            sides = {}
            for c in sel.categoryIds:
                s = var_of.get(c) or str(members.filter(members["categoryId"] == c)["side"].to_list()[0])
                sides.setdefault(s, []).append(c)
            per_side = [set().union(*[set(by_cat.get(c, [])) for c in cats]) if cats else set() for cats in sides.values()]
            if sel.betweenVariables == "or" or len(per_side) <= 1:
                sets = [set().union(*per_side)] if per_side else [set()]
            else:
                base = set(per_side[0])
                for s in per_side[1:]:
                    base &= set(s)
                sets = [base]
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
    if sel.kind == "categories" and manifest.get("method") in ("mca", "famd"):
        label = _mca_category_label(manifest, sel)
    else:
        label = "CA categories" if sel.kind == "categories" else "rows"
    out = {"status": "success", "resultId": result_id, "rowIds": inter, "matchedCount": matched, "fitMatchedCount": matched, "contextIntersectionCount": len(inter), "selectionLabel": label}
    check_json_finite(out)
    return out


def _mca_category_label(manifest, sel) -> str:
    details = manifest.get("details") or {}
    var_of = {}
    for cat in details.get("categories", []) or []:
        var_of[cat.get("categoryId")] = (cat.get("variableId"), cat.get("label"))
    parts = [f"{var_of.get(c, (c, c))[0]}:{var_of.get(c, (c, c))[1]}" for c in sel.categoryIds]
    mode = getattr(sel, "betweenVariables", "and").upper()
    return f"MCA categories ({mode}: {', '.join(parts)})"


def _mca_rectangle_ids(result_id: str, manifest, sel) -> list[str]:
    import numpy as _np

    arrays = result_store.load_arrays(result_id)
    rows_df = result_store.load_rows(result_id)
    if rows_df is None or "rowId" not in rows_df.columns:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    for axis in sel.axes:
        if int(axis) < 1 or int(axis) > rank:
            _err("ANALYSIS_REQUEST_INVALID", f"存在しない軸です: {axis}", 422)
    f = _np.asarray(arrays["f"])
    row_ids = [str(v) for v in rows_df["rowId"].to_list()]
    matched: list[str] = []
    for pos, rid in enumerate(row_ids):
        ok = True
        for axis, (lo, hi) in zip(sel.axes, sel.bounds):
            val = float(f[pos, int(axis) - 1])
            if not (float(lo) <= val <= float(hi)):
                ok = False
                break
        if ok:
            matched.append(rid)
    return matched


@router.get("/analysis-results/{result_id}/rows")
def get_result_rows(result_id: str, offset: int = 0, limit: int = 5000, axes: str | None = None):
    from fastapi import Query as _Q  # noqa: F401 (documented query params)

    manifest = result_store.load_manifest(result_id)
    meta, stale, cur = _stale_state(manifest)
    if manifest.get("method") == "sparse_pca":
        from .sparse_pca import sparse_pca_rows
        return sparse_pca_rows(result_id, manifest, meta, offset, limit, axes)
    if manifest.get("method") == "regularized_regression":
        from .regularized_regression import rr_rows
        return rr_rows(result_id, manifest, meta, offset, limit, axes)
    if manifest.get("method") == "linear_regression":
        return _lr_rows(result_id, manifest, meta, offset, limit, axes)
    if manifest.get("method") == "conjoint":
        from ..api.conjoint import conjoint_rows as _cj_rows

        return _cj_rows(result_id, manifest, meta, offset, limit, axes)
    if manifest.get("method") == "efa":
        from ..api.factor_analysis import efa_rows as _efa_rows

        return _efa_rows(result_id, manifest, meta, offset, limit, axes)
    if manifest.get("method") not in ("mca", "famd"):
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "rows unsupported", 422)
    if limit < 1 or limit > 10000 or offset < 0:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    arrays = result_store.load_arrays(result_id)
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    if axes is None:
        axis_list = list(range(1, min(2, rank) + 1))
    else:
        try:
            axis_list = [int(v) for v in str(axes).split(",") if str(v).strip() != ""]
        except ValueError:
            _err("ANALYSIS_REQUEST_INVALID", "axes が不正です。", 422)
        if len(set(axis_list)) != len(axis_list) or any(a < 1 or a > rank for a in axis_list):
            _err("ANALYSIS_REQUEST_INVALID", "axes が不正です。", 422)
    import numpy as _np

    f = _np.asarray(arrays["f"])
    contrib = _np.asarray(arrays["rowContrib"])
    cos2raw = _np.asarray(arrays["rowCos2"])
    cos2 = _np.where(cos2raw < -0.5, _np.nan, cos2raw)
    dist2 = _np.asarray(arrays["rowDist2"])
    mass = _np.asarray(arrays["a"])
    total = int(rows_df.height)
    if offset >= total:
        out = {"status": "success", "resultId": result_id, "offset": offset, "limit": limit,
               "total": total, "nextOffset": None, "axes": axis_list, "rows": [],
               "meta": {"dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"),
                        "resultState": meta.get("resultState")}}
        check_json_finite(out)
        return out
    part = rows_df.slice(offset, limit)
    ids = [str(v) for v in part["rowId"].to_list()]
    all_ids = [str(v) for v in rows_df["rowId"].to_list()]
    pos_of = {rid: i for i, rid in enumerate(all_ids)}
    out_rows = []
    for rid in ids:
        i = pos_of[rid]
        out_rows.append({
            "rowId": rid,
            "coordinates": [float(f[i, a - 1]) for a in axis_list],
            "contributions": [float(contrib[i, a - 1]) for a in axis_list],
            "cos2": [(None if not _np.isfinite(cos2[i, a - 1]) else float(cos2[i, a - 1])) for a in axis_list],
            "mass": float(mass[i]),
            "distanceSquared": float(dist2[i]),
        })
    nxt = offset + len(ids) if offset + len(ids) < total else None
    out = {"status": "success", "resultId": result_id, "offset": offset, "limit": limit,
           "total": total, "nextOffset": nxt, "axes": axis_list, "rows": out_rows,
           "meta": {"dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"),
                    "resultState": meta.get("resultState")}}
    check_json_finite(out)
    return out


@router.post("/analysis-results/{result_id}/predict")
def predict_result(result_id: str, payload: dict = Body(...)):
    from ..domain.analysis_contracts import PredictRequest as _PredictRequest

    try:
        req = _PredictRequest.model_validate(payload)
    except ValidationError:
        _err("ANALYSIS_REQUEST_INVALID", "bad predict", 422)
    manifest = result_store.load_manifest(result_id)
    if manifest.get("method") == "regularized_regression":
        from .regularized_regression import rr_predict
        return rr_predict(result_id, manifest, req)
    if manifest.get("method") == "mca":
        return _mca_predict(result_id, manifest, req)
    if manifest.get("method") == "famd":
        return _famd_predict(result_id, manifest, req)
    if manifest.get("method") == "linear_regression":
        from ..api.linear_regression import lr_predict as _lr_predict

        return _lr_predict(result_id, manifest, req)
    if manifest.get("method") == "conjoint":
        from ..api.conjoint import conjoint_predict as _cj_predict

        return _cj_predict(result_id, manifest, req)
    if manifest.get("method") == "efa":
        from ..api.factor_analysis import efa_predict as _efa_predict

        return _efa_predict(result_id, manifest, req)
    _err("ANALYSIS_OPERATION_UNSUPPORTED", "CA predict unsupported", 422)


@router.post("/analysis-results/{result_id}/materialize")
def materialize_result(result_id: str, payload: dict = Body(...)):
    from ..domain.analysis_contracts import MaterializeRequest as _MaterializeRequest

    try:
        req = _MaterializeRequest.model_validate(payload)
    except ValidationError:
        _err("ANALYSIS_REQUEST_INVALID", "bad materialize", 422)
    manifest = result_store.load_manifest(result_id)
    if manifest.get("method") == "mca":
        return _mca_materialize(result_id, manifest, req)
    if manifest.get("method") == "famd":
        return _famd_materialize(result_id, manifest, req)
    if manifest.get("method") == "linear_regression":
        from ..api.linear_regression import lr_materialize as _lr_materialize

        return _lr_materialize(result_id, manifest, req)
    if manifest.get("method") == "conjoint":
        from ..api.conjoint import conjoint_materialize as _cj_materialize

        return _cj_materialize(result_id, manifest, req)
    if manifest.get("method") == "efa":
        from ..api.factor_analysis import efa_materialize as _efa_materialize

        return _efa_materialize(result_id, manifest, req)
    _err("ANALYSIS_OPERATION_UNSUPPORTED", "CA materialize unsupported", 422)


def _mca_predict(result_id: str, manifest, req):
    import uuid as _uuid

    import numpy as _np
    import polars as _pl

    from ..algorithms.models.mca import project_mca_rows as _project
    from ..domain.codebook_adapter import normalize_code as _nc
    from ..domain.multi_response import prepare_classifier as _prepare_classifier

    meta, stale, cur = _stale_state(manifest)
    if stale:
        _err("ANALYSIS_INPUT_STALE", "stale result", 409)
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH", "結果の所有データセットと一致しません。", 422)
    check_revisions(cur, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
    details = manifest.get("details") or {}
    encoding = manifest.get("encoding") or {}
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    missing_policy = encoding.get("missingPolicy", "exclude")
    # Fit scope resolution (same rules as select context).
    df_ids = [str(v) for v in store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__"])["__rowId__"].to_list()]
    legacy = AnalysisContext(datasetId=manifest.get("ownerDatasetId"), expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
    scope_ids = resolve_scope(df_ids, legacy)
    arrays = result_store.load_arrays(result_id)
    c = _np.asarray(arrays["c"])
    v = _np.asarray(arrays["v"])
    m_vars = len(details.get("variables", []) or [])
    # Fixed fit transform: fitted categories/order + missing policy + MA parent verdicts.
    cat_order: list[dict] = []
    for cat in encoding.get("categories", []) or []:
        cat_order.append({"variableId": cat.get("variableId"), "code": cat.get("code"),
                          "kind": cat.get("kind"), "categoryId": cat.get("categoryId")})
    codebook = store.load_codebook(manifest.get("ownerDatasetId")) or {}
    spec_by_id = {s.get("columnId"): s for s in (codebook.get("columns", []) or []) if isinstance(s, dict)}
    spec_by_name = {s.get("name"): s for s in (codebook.get("columns", []) or []) if isinstance(s, dict)}
    enc_specs = encoding.get("specByVariable", {}) or {}
    ma_groups = encoding.get("maGroups", []) or []
    group_by_parent: dict[str, dict] = {}
    classifiers: dict[str, Any] = {}
    try:
        from ..domain.multi_response import resolve_groups as _resolve_groups, validate_group as _validate_group
        for group in _resolve_groups(codebook):
            try:
                _validate_group(group)
            except ValueError:
                continue
            group_by_parent[group["groupId"]] = group
            classifiers[group["groupId"]] = _prepare_classifier(group)
    except (ValueError, KeyError):
        pass
    # Raw column reads: fitted column names first, MA parents read all member columns.
    need_names: set[str] = set()
    ma_members: dict[str, list[str]] = {}
    for var in details.get("variables", []) or []:
        vid = var.get("variableId")
        info = enc_specs.get(vid, {}) or {}
        cname = info.get("columnName")
        if cname:
            need_names.add(cname)
        parent = info.get("maParentId")
        if parent and parent in group_by_parent and parent not in ma_members:
            members = [col.get("name") for col in group_by_parent[parent].get("columns", [])]
            ma_members[parent] = members
            need_names.update(members)
        elif parent and parent not in group_by_parent:
            # MA definition vanished after fit: rows needing it are invalid.
            ma_members[parent] = []
    full_df = store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__", *sorted(need_names)])
    full_by_id = {str(r["__rowId__"]): r for r in full_df.rows(named=True)}
    missing_by_var: dict[str, set] = {}
    reason_by_var: dict[str, dict] = {}
    for var in details.get("variables", []) or []:
        vid = var.get("variableId")
        spec = spec_by_id.get(vid)
        if spec is None:
            continue
        missing_by_var[vid] = {_nc(x) for x in (spec.get("missingCodes") or [])}
        missing_by_var[vid].discard(None)
        reasons = spec.get("missingReasons") or {}
        reason_by_var[vid] = reasons if isinstance(reasons, dict) else {}
    z_rows: list[list[float]] = []
    statuses: list[str] = []
    ok_idx: list[int] = []
    for pos, rid in enumerate(scope_ids):
        # Read raw values per variable via fitted encoding (fixed transform).
        row: list[float] = [0.0] * len(cat_order)
        status = "ok"
        col_pos = 0
        rec = full_by_id.get(str(rid))
        if rec is None:
            status = "invalid"
        else:
            for var in details.get("variables", []) or []:
                if status != "ok":
                    break
                vid = var.get("variableId")
                info = enc_specs.get(vid, {}) or {}
                parent = info.get("maParentId")
                group_vars = [cc for cc in cat_order if cc["variableId"] == vid]
                if parent:
                    members = ma_members.get(parent, [])
                    group = group_by_parent.get(parent)
                    if group is None or not members:
                        status = "invalid"
                        break
                    try:
                        verdict, _sel = classifiers[parent]([rec.get(mn) for mn in members])
                    except (ValueError, KeyError, TypeError):
                        status = "invalid"
                        break
                    if verdict == "valid":
                        cname = info.get("columnName")
                        code = _nc(rec.get(cname)) if cname else None
                        hit = next((g for g in group_vars
                                    if g["kind"] == "value" and g["code"] == code), None)
                        if hit is None:
                            # Closed-domain violation at predict time.
                            if code is None or code in missing_by_var.get(vid, set()):
                                status = "missing" if missing_policy == "exclude" else "unknown_category"
                            else:
                                status = "invalid"
                            break
                        row[col_pos + [g["categoryId"] for g in group_vars].index(hit["categoryId"])] = 1.0
                    elif verdict == "partial":
                        status = "missing"
                        break
                    elif verdict == "notApplicable":
                        if missing_policy == "exclude":
                            status = "missing"
                        else:
                            hit = next((g for g in group_vars if g["kind"] == "not_applicable"), None)
                            if hit is None:
                                hit = next((g for g in group_vars if g["kind"] == "missing"), None)
                            if hit is None:
                                status = "missing"
                                break
                        if status == "ok":
                            row[col_pos + [g["categoryId"] for g in group_vars].index(hit["categoryId"])] = 1.0
                    elif verdict == "missing":
                        if missing_policy == "exclude":
                            status = "missing"
                        else:
                            hit = next((g for g in group_vars if g["kind"] == "missing"), None)
                            if hit is None:
                                status = "missing"
                                break
                        if status == "ok":
                            row[col_pos + [g["categoryId"] for g in group_vars].index(hit["categoryId"])] = 1.0
                    else:
                        status = "invalid"
                        break
                    col_pos += len(group_vars)
                    continue
                spec = spec_by_id.get(vid)
                if spec is None:
                    status = "invalid"
                    break
                cname = info.get("columnName") or spec.get("name")
                raw = rec.get(cname) if cname else None
                code = _nc(raw)
                if code is None or code in missing_by_var.get(vid, set()):
                    if missing_policy == "exclude":
                        status = "missing"
                        break
                    reason = reason_by_var.get(vid, {}).get(code, "")
                    from ..domain.codebook_adapter import is_not_applicable_reason as _is_na
                    want_na = missing_policy == "separate_not_applicable" and _is_na(reason)
                    hit = next((g for g in group_vars
                                if g["kind"] == ("not_applicable" if want_na else "missing")), None)
                    if hit is None:
                        status = "missing"
                        break
                    row[col_pos + [g["categoryId"] for g in group_vars].index(hit["categoryId"])] = 1.0
                    col_pos += len(group_vars)
                    continue
                hit = next((g for g in group_vars if g["kind"] == "value" and g["code"] == code), None)
                if hit is None:
                    declared = {(g["code"], g["kind"]) for g in group_vars if g["kind"] == "value"}
                    if code in {cc for cc, _kk in declared}:
                        status = "unknown_category"
                    else:
                        status = "invalid"
                    break
                row[col_pos + [g["categoryId"] for g in group_vars].index(hit["categoryId"])] = 1.0
                col_pos += len(group_vars)
        # Row-sum guard (incomplete rows -> missing).
        if status == "ok" and abs(sum(row) - m_vars) > 1e-9:
            status = "missing"
        z_rows.append(row)
        statuses.append(status)
        if status == "ok":
            ok_idx.append(pos)
    coords = [[None] * rank for _ in scope_ids]
    if ok_idx:
        mat = _np.asarray([z_rows[i] for i in ok_idx], dtype=float)
        proj = _project(mat, c=c, v=v, m=m_vars)
        for k, i in enumerate(ok_idx):
            coords[i] = [float(x) for x in proj[k, :].tolist()]
    prediction_id = f"pred-{_uuid.uuid4().hex[:12]}"
    pdf = _pl.DataFrame({"rowId": scope_ids, "status": statuses,
                         **{f"axis{a+1}": [(c[a] if c[a] is not None else None) for c in coords] for a in range(rank)}})
    result_store.save_prediction_rows(result_id, prediction_id, pdf)
    status_counts = {k: 0 for k in ("ok", "unknown_category", "missing", "invalid", "unavailable")}
    for s in statuses:
        status_counts[s if s in status_counts else "unavailable"] += 1
    out = {"status": "success", "resultId": result_id, "predictionId": prediction_id,
           "summary": {"requestedCount": len(scope_ids),
                       "successfulPredictions": status_counts["ok"],
                       "failedPredictions": len(scope_ids) - status_counts["ok"],
                       "statusCounts": status_counts, "evaluation": None},
           "meta": meta, "unavailableReasons": {}}
    check_json_finite(out)
    return out


@router.get("/analysis-results/{result_id}/predictions/{prediction_id}/rows")
def get_prediction_rows(result_id: str, prediction_id: str, offset: int = 0, limit: int = 5000,
                        axes: str | None = None):
    manifest = result_store.load_manifest(result_id)
    meta, stale, cur = _stale_state(manifest)
    if manifest.get("method") == "regularized_regression":
        from .regularized_regression import rr_prediction_rows
        if axes is not None:
            _err("ANALYSIS_REQUEST_INVALID", "回帰では axes を指定できません。", 422)
        return rr_prediction_rows(result_id, manifest, meta, prediction_id, offset, limit)
    if manifest.get("method") == "linear_regression":
        from ..api.linear_regression import lr_prediction_rows as _lr_rows

        return _lr_rows(result_id, manifest, meta, prediction_id, offset,
                        limit, axes)
    if manifest.get("method") == "conjoint":
        from ..api.conjoint import conjoint_prediction_rows as _cj_rows

        return _cj_rows(result_id, manifest, meta, prediction_id, offset,
                        limit, axes)
    if manifest.get("method") not in ("mca", "famd"):
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "rows unsupported", 422)
    if limit < 1 or limit > 10000 or offset < 0:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    pdf = result_store.load_prediction_rows(result_id, prediction_id)
    if pdf is None:
        _err("ANALYSIS_RESULT_NOT_FOUND", "prediction が見つかりません。", 404)
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    if axes is None:
        axis_list = list(range(1, min(2, rank) + 1))
    else:
        try:
            axis_list = [int(v) for v in str(axes).split(",") if str(v).strip() != ""]
        except ValueError:
            _err("ANALYSIS_REQUEST_INVALID", "axes が不正です。", 422)
        if len(set(axis_list)) != len(axis_list) or any(a < 1 or a > rank for a in axis_list):
            _err("ANALYSIS_REQUEST_INVALID", "axes が不正です。", 422)
    total = int(pdf.height)
    if offset >= total:
        out = {"status": "success", "resultId": result_id, "predictionId": prediction_id,
               "offset": offset, "limit": limit, "total": total, "nextOffset": None,
               "axes": axis_list, "rows": [],
               "meta": {"dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"),
                        "resultState": meta.get("resultState")}}
        check_json_finite(out)
        return out
    part = pdf.slice(offset, limit)
    rows = []
    for rec in part.rows(named=True):
        full = [rec.get(f"axis{a}") for a in range(1, rank + 1)]
        rows.append({"rowId": str(rec.get("rowId")),
                     "coordinates": [(None if full[a - 1] is None else float(full[a - 1])) for a in axis_list],
                     "contributions": None, "mass": None,
                     "predictionStatus": str(rec.get("status"))})
    nxt = offset + part.height if offset + part.height < total else None
    out = {"status": "success", "resultId": result_id, "predictionId": prediction_id,
           "offset": offset, "limit": limit, "total": total, "nextOffset": nxt,
           "axes": axis_list, "rows": rows,
           "meta": {"dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"),
                    "resultState": meta.get("resultState")}}
    check_json_finite(out)
    return out


def _materialize_scope_norm(ctx, dataset_id: str) -> dict:
    """Scope portion of the materialize idempotency payload (M002)."""
    scope = ctx.get("scope", "all")
    norm: dict = {"scope": scope}
    for key in ("rowIds", "activeRowIds", "selectedRowIds", "sampledRowIds"):
        value = ctx.get(key)
        if value is not None:
            norm[key] = sorted({str(v) for v in value})
    return norm


def _mca_materialize(result_id: str, manifest, req):
    import re as _re

    import polars as _pl

    meta, stale, cur = _stale_state(manifest)
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH", "結果の所有データセットと一致しません。", 422)
    dataset_id = manifest.get("ownerDatasetId")
    # Idempotency: same key+payload replays the saved response even when stale.
    # The payload covers everything that changes the write: source, columns,
    # and the requested scope set. Version expectations may differ on replay.
    scope_norm = _materialize_scope_norm(ctx, dataset_id)
    payload_norm = {"source": req.source,
                    "columns": [{k: c.get(k) if isinstance(c, dict) else getattr(c, k, None)
                                 for k in ("sourceField", "name", "label")} for c in req.columns],
                    "scope": scope_norm}
    prov = store.load_provenance(dataset_id) or {}
    for op in prov.get("operations", []) or []:
        params = (op.get("params") or {})
        if params.get("mcaIdempotencyKey") == req.idempotencyKey and params.get("mcaResultId") == result_id:
            if json.dumps(params.get("mcaPayload"), sort_keys=True) == json.dumps(
                    payload_norm, sort_keys=True, default=str):
                replay = dict(params.get("mcaResponse") or {})
                replay["idempotentReplay"] = True
                check_json_finite(replay)
                return replay
            _err("IDEMPOTENCY_CONFLICT", "idempotencyKey が別payloadで使用済みです。", 409)
    if stale:
        _err("ANALYSIS_INPUT_STALE", "stale result", 409)
    check_revisions(cur, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    source = req.source
    if source == "fit":
        rows_df = result_store.load_rows(result_id)
        if rows_df is None:
            _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
        values = {str(r["rowId"]): [r.get(f"axis{a}") for a in range(1, rank + 1)]
                  for r in rows_df.rows(named=True)}
    else:
        pdf = result_store.load_prediction_rows(result_id, source)
        if pdf is None:
            _err("ANALYSIS_RESULT_NOT_FOUND", "prediction が見つかりません。", 404)
        values = {str(r["rowId"]): [r.get(f"axis{a}") for a in range(1, rank + 1)]
                  for r in pdf.rows(named=True) if str(r.get("status")) == "ok"}
    fields = []
    for col in req.columns:
        src = col.get("sourceField") if isinstance(col, dict) else getattr(col, "sourceField", None)
        name = col.get("name") if isinstance(col, dict) else getattr(col, "name", None)
        label = (col.get("label") if isinstance(col, dict) else getattr(col, "label", "")) or ""
        m = _re.fullmatch(r"coordinate:(\d+)", str(src or ""))
        if not m or int(m.group(1)) < 1 or int(m.group(1)) > rank:
            _err("ANALYSIS_REQUEST_INVALID", f"保存できないfieldです: {src}", 422)
        if not name or not _re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(name)):
            _err("ANALYSIS_REQUEST_INVALID", f"列名が不正です: {name}", 422)
        fields.append({"axis": int(m.group(1)), "name": str(name), "label": str(label), "sourceField": str(src)})
    with store.lock(dataset_id):
        # Re-verify versions inside the write lock (M003): no side effects on mismatch.
        cur_meta = store.get_meta(dataset_id)
        cur_code = store.load_codebook(dataset_id) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
        fit_rev = {"dataRevision": int(meta.get("dataRevision", 0)),
                   "schemaRevision": int(meta.get("schemaRevision", 0))}
        if (cur_rev["dataRevision"] != fit_rev["dataRevision"]
                or cur_rev["schemaRevision"] != fit_rev["schemaRevision"]):
            raise BizError("ANALYSIS_INPUT_STALE", "書込時にデータ版が更新されています。再実行してください。",
                           status_code=409)
        if (int(ctx.get("expectedDataRevision", cur_rev["dataRevision"])) != cur_rev["dataRevision"]
                or int(ctx.get("expectedSchemaRevision", cur_rev["schemaRevision"])) != cur_rev["schemaRevision"]):
            raise BizError("ANALYSIS_INPUT_STALE", "書込時にデータ版が更新されています。再実行してください。",
                           status_code=409)
        codebook = cur_code
        existing_names = {c.get("name") for c in (codebook.get("columns", []) or [])}
        existing_names |= {c.get("name") for c in (cur_meta.get("schema", []) or [])}
        df = store.get_dataframe(dataset_id)
        existing_names.update(df.columns)
        for f in fields:
            if f["name"] in existing_names:
                _err("COLUMN_ALREADY_EXISTS", f"既存列への上書きは禁止です: {f['name']}", 409)
            existing_names.add(f["name"])
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        # Context intersection: only requested scope members receive values.
        legacy = AnalysisContext(datasetId=dataset_id, expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = set(resolve_scope(all_ids, legacy))
        for f in fields:
            col_vals = [float(values[rid][f["axis"] - 1]) if (rid in values and rid in scope_ids and values[rid][f["axis"] - 1] is not None) else None for rid in all_ids]
            df = df.with_columns([_pl.Series(f["name"], col_vals, dtype=_pl.Float64)])
        from ..domain.provenance import new_operation_id
        from ..services.dataset_service import now_iso

        meta_now = cur_meta
        cb = codebook
        # Append derived column specs (interval/other) and bump schema revision.
        import uuid as _uuid

        for f in fields:
            col_id = f"col-{_uuid.uuid4().hex[:12]}"
            f["columnId"] = col_id
            cb.setdefault("columns", []).append({
                "columnId": col_id, "name": f["name"], "label": f["label"] or f["name"],
                "role": "other", "scaleType": "interval", "derived": True,
                "origin": {"method": "mca", "resultId": result_id, "source": source,
                           "sourceField": f["sourceField"]}})
        cb["schemaRevision"] = int(cb.get("schemaRevision", meta_now.get("schemaRevision", 1))) + 1
        provenance_before = store.load_provenance(dataset_id) or {}
        step = {"operationId": new_operation_id(),
                "parentOperationId": provenance_before.get("currentOperationId"),
                "operation": "calculate",
                "params": {"mcaResultId": result_id, "mcaSource": source,
                           "mcaFields": fields, "mcaIdempotencyKey": req.idempotencyKey,
                           "mcaPayload": payload_norm},
                "targetRowIds": sorted(scope_ids),
                "targetCells": [],
                "inputSchemaRevision": int(cb.get("schemaRevision", 1)),
                "outputSchemaRevision": int(cb.get("schemaRevision", 1)),
                "algorithmVersion": "davis.mca.1.0.0",
                "timestamp": now_iso(), "createdBy": "local-session"}
        # Re-derive schema entries for the new numeric columns.
        schema = list(meta_now.get("schema", []) or [])
        for f in fields:
            schema.append({"columnId": f["columnId"], "name": f["name"], "semanticType": "numeric"})
        meta_now["schema"] = schema
        meta_now["schemaRevision"] = int(cb.get("schemaRevision", 1))
        meta_now["columnCount"] = df.width - 1
        commit = store.commit_data_change(dataset_id, meta_now, df, codebook=cb, step=step)
        fresh_meta = store.get_meta(dataset_id)
        fresh_cb = store.load_codebook(dataset_id) or {}
        non_null = {}
        for f in fields:
            non_null[f["name"]] = int(df[f["name"]].drop_nulls().len())
        created = [{"columnId": f["columnId"], "name": f["name"],
                    "label": f["label"] or f["name"], "sourceField": f["sourceField"],
                    "nonNullCount": non_null[f["name"]]} for f in fields]
        written = int(sum(1 for rid in all_ids if any(
            rid in values and rid in scope_ids and (values[rid][a - 1] is not None)
            for a in [f["axis"] for f in fields])))
        resp = {"status": "success", "resultId": result_id, "source": source,
                "operationId": step["operationId"], "datasetId": dataset_id,
                "dataRevision": int(fresh_meta.get("dataRevision", 1)),
                "schemaRevision": int(fresh_cb.get("schemaRevision", fresh_meta.get("schemaRevision", 1))),
                "createdColumns": created, "writtenRowCount": written,
                "idempotentReplay": False}
        # Record the response inside provenance params for replay (same commit already
        # stores key+payload; attach response via a follow-up provenance read is
        # unnecessary because the replay path returns the stored params copy below).
        # Persist replay payload by updating the step params in place.
        prov2 = store.load_provenance(dataset_id) or {}
        for op in prov2.get("operations", []) or []:
            if op.get("operationId") == step["operationId"]:
                op.setdefault("params", {})["mcaResponse"] = resp
        # Rewrite provenance sidecar atomically (same lock).
        import json as _json

        ppath = store._provenance_path(dataset_id)
        tmp = ppath.with_suffix(".tmp")
        tmp.write_bytes(_json.dumps(prov2, ensure_ascii=False, indent=2).encode("utf-8"))
        import os as _os

        _os.replace(tmp, ppath)
        check_json_finite(resp)
        return resp


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
    if manifest.get("method") == "sparse_pca":
        from .sparse_pca import sparse_pca_export
        return sparse_pca_export(manifest, meta, result_id, req)
    if manifest.get("method") == "regularized_regression":
        from .regularized_regression import rr_export_table
        return rr_export_table(manifest, meta, result_id, req)
    if manifest.get("method") == "efa" and req.table in (
            "variables", "diagnostics", "parallel_analysis", "factor_comparisons",
            "rows"):
        from ..api.factor_analysis import efa_export_table as _efa_export

        return _efa_export(manifest, meta, result_id, req)
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
    if req.table == "rows" and manifest.get("method") in ("mca", "famd"):
        return _export_mca_rows(manifest, meta, result_id, req)
    if req.table == "variables" and manifest.get("method") == "famd":
        return _export_famd_variables(manifest, meta, result_id, req)
    if manifest.get("method") == "linear_regression":
        from ..api.linear_regression import lr_export_table as _lr_export

        return _lr_export(manifest, meta, result_id, req)
    if manifest.get("method") == "conjoint":
        from ..api.conjoint import conjoint_export_table as _cj_export

        return _cj_export(manifest, meta, result_id, req)
    details = manifest.get("details") or {}
    if manifest.get("method") in ("mca", "famd"):
        cat_rows = list(details.get("categories") or [])
    else:
        cat_rows = list(details.get("rowCategories") or []) + list(details.get("columnCategories") or [])
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    is_famd = manifest.get("method") == "famd"
    if is_famd:
        header = ["categoryId", "variableId", "code", "kind", "label", "probability"] + [f"barycenter{i+1}" for i in range(rank)] + [f"contribution{i+1}" for i in range(rank)] + [f"cos2_{i+1}" for i in range(rank)]
    else:
        header = ["categoryId", "side", "variableId", "code", "kind", "label", "mass"] + [f"principal{i+1}" for i in range(rank)] + [f"contribution{i+1}" for i in range(rank)] + [f"cos2_{i+1}" for i in range(rank)]
    rows_all = []
    for e in cat_rows:
        princ = list(e.get("principalCoordinates") or e.get("barycenterCoordinates") or [])
        contrib = list(e.get("contributions") or [])
        cos2 = list(e.get("cos2") or [])
        if is_famd:
            rows_all.append([e.get("categoryId"), e.get("variableId"), e.get("code"), e.get("kind"), e.get("label"), e.get("probability")] + [princ[i] if i < len(princ) else None for i in range(rank)] + [contrib[i] if i < len(contrib) else None for i in range(rank)] + [cos2[i] if i < len(cos2) else None for i in range(rank)])
            continue
        # MCA uses categoryMass/categoryProbability; CA uses mass (M007).
        mass_val = e.get("mass")
        if manifest.get("method") == "mca" and mass_val is None:
            mass_val = e.get("categoryMass")
        rows_all.append([e.get("categoryId"), e.get("side"), e.get("variableId"), e.get("code"), e.get("kind"), e.get("label"), mass_val] + [princ[i] if i < len(princ) else None for i in range(rank)] + [contrib[i] if i < len(contrib) else None for i in range(rank)] + [cos2[i] if i < len(cos2) else None for i in range(rank)])
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


def _export_mca_rows(manifest, meta, result_id, req):
    import numpy as _np

    arrays = result_store.load_arrays(result_id)
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    f = _np.asarray(arrays["f"])
    contrib = _np.asarray(arrays["rowContrib"])
    cos2raw = _np.asarray(arrays["rowCos2"])
    cos2 = _np.where(cos2raw < -0.5, _np.nan, cos2raw)
    dist2 = _np.asarray(arrays["rowDist2"])
    mass = _np.asarray(arrays["a"])
    ids = [str(v) for v in rows_df["rowId"].to_list()]
    long_rows = []
    for i, rid in enumerate(ids):
        for a in range(1, rank + 1):
            c2 = cos2[i, a - 1]
            long_rows.append([rid, a, float(f[i, a - 1]), float(contrib[i, a - 1]),
                              (None if not _np.isfinite(c2) else float(c2)),
                              float(mass[i]), float(dist2[i])])
    total = len(long_rows)
    part = long_rows[req.offset:req.offset + req.limit]
    nxt = req.offset + len(part) if req.offset + len(part) < total else None
    if req.format == "json":
        body = {"columns": ["rowId", "axis", "coordinate", "contribution", "cos2", "mass", "distanceSquared"],
                "rows": part}
        payload_text = json.dumps(body, ensure_ascii=False, allow_nan=False)
        mime = "application/json"
    else:
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["rowId", "axis", "coordinate", "contribution", "cos2", "mass", "distanceSquared"])
        for row in part:
            w.writerow([escape_formula_prefix(str(row[0])), row[1], repr(float(row[2])),
                        repr(float(row[3])), ("" if row[4] is None else repr(float(row[4]))),
                        repr(float(row[5])), repr(float(row[6]))])
        payload_text = buf.getvalue()
        mime = "text/csv"
    out = {"status": "success", "mime": mime, "fileName": f"{result_id}-rows.{req.format}", "encoding": "utf-8", "payload": payload_text, "offset": req.offset, "total": total, "nextOffset": nxt, "hasHeader": req.format == "csv", "snapshot": {"datasetId": meta.get("datasetId"), "dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"), "resultId": result_id}}
    check_json_finite(out)
    return out


def _famd_materialize(result_id: str, manifest, req):
    import re as _re

    import polars as _pl

    meta, stale, cur = _stale_state(manifest)
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH", "結果の所有データセットと一致しません。", 422)
    dataset_id = manifest.get("ownerDatasetId")
    scope_norm = _materialize_scope_norm(ctx, dataset_id)
    payload_norm = {"source": req.source,
                    "columns": [{k: c.get(k) if isinstance(c, dict) else getattr(c, k, None)
                                 for k in ("sourceField", "name", "label")} for c in req.columns],
                    "scope": scope_norm}
    prov = store.load_provenance(dataset_id) or {}
    for op in prov.get("operations", []) or []:
        params = (op.get("params") or {})
        if params.get("famdIdempotencyKey") == req.idempotencyKey and params.get("famdResultId") == result_id:
            if json.dumps(params.get("famdPayload"), sort_keys=True) == json.dumps(
                    payload_norm, sort_keys=True, default=str):
                replay = dict(params.get("famdResponse") or {})
                replay["idempotentReplay"] = True
                check_json_finite(replay)
                return replay
            _err("IDEMPOTENCY_CONFLICT", "idempotencyKey が別payloadで使用済みです。", 409)
    if stale:
        _err("ANALYSIS_INPUT_STALE", "stale result", 409)
    check_revisions(cur, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    source = req.source
    if source == "fit":
        rows_df = result_store.load_rows(result_id)
        if rows_df is None:
            _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
        values = {str(r["rowId"]): [r.get(f"axis{a}") for a in range(1, rank + 1)]
                  for r in rows_df.rows(named=True)}
    else:
        pdf = result_store.load_prediction_rows(result_id, source)
        if pdf is None:
            _err("ANALYSIS_RESULT_NOT_FOUND", "prediction が見つかりません。", 404)
        values = {str(r["rowId"]): [r.get(f"axis{a}") for a in range(1, rank + 1)]
                  for r in pdf.rows(named=True) if str(r.get("status")) == "ok"}
    fields = []
    for col in req.columns:
        src = col.get("sourceField") if isinstance(col, dict) else getattr(col, "sourceField", None)
        name = col.get("name") if isinstance(col, dict) else getattr(col, "name", None)
        label = (col.get("label") if isinstance(col, dict) else getattr(col, "label", "")) or ""
        m = _re.fullmatch(r"coordinate:(\d+)", str(src or ""))
        if not m or int(m.group(1)) < 1 or int(m.group(1)) > rank:
            _err("ANALYSIS_REQUEST_INVALID", f"保存できないfieldです: {src}", 422)
        if not name or not _re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(name)):
            _err("ANALYSIS_REQUEST_INVALID", f"列名が不正です: {name}", 422)
        fields.append({"axis": int(m.group(1)), "name": str(name), "label": str(label), "sourceField": str(src)})
    with store.lock(dataset_id):
        cur_meta = store.get_meta(dataset_id)
        cur_code = store.load_codebook(dataset_id) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
        fit_rev = {"dataRevision": int(meta.get("dataRevision", 0)),
                   "schemaRevision": int(meta.get("schemaRevision", 0))}
        if (cur_rev["dataRevision"] != fit_rev["dataRevision"]
                or cur_rev["schemaRevision"] != fit_rev["schemaRevision"]):
            raise BizError("ANALYSIS_INPUT_STALE", "書込時にデータ版が更新されています。再実行してください。",
                           status_code=409)
        if (int(ctx.get("expectedDataRevision", cur_rev["dataRevision"])) != cur_rev["dataRevision"]
                or int(ctx.get("expectedSchemaRevision", cur_rev["schemaRevision"])) != cur_rev["schemaRevision"]):
            raise BizError("ANALYSIS_INPUT_STALE", "書込時にデータ版が更新されています。再実行してください。",
                           status_code=409)
        codebook = cur_code
        existing_names = {c.get("name") for c in (codebook.get("columns", []) or [])}
        existing_names |= {c.get("name") for c in (cur_meta.get("schema", []) or [])}
        df = store.get_dataframe(dataset_id)
        existing_names.update(df.columns)
        for f in fields:
            if f["name"] in existing_names:
                _err("COLUMN_ALREADY_EXISTS", f"既存列への上書きは禁止です: {f['name']}", 409)
            existing_names.add(f["name"])
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=dataset_id, expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = set(resolve_scope(all_ids, legacy))
        for f in fields:
            col_vals = [float(values[rid][f["axis"] - 1]) if (rid in values and rid in scope_ids and values[rid][f["axis"] - 1] is not None) else None for rid in all_ids]
            df = df.with_columns([_pl.Series(f["name"], col_vals, dtype=_pl.Float64)])
        from ..domain.provenance import new_operation_id
        from ..services.dataset_service import now_iso

        meta_now = cur_meta
        cb = codebook
        import uuid as _uuid

        for f in fields:
            col_id = f"col-{_uuid.uuid4().hex[:12]}"
            f["columnId"] = col_id
            cb.setdefault("columns", []).append({
                "columnId": col_id, "name": f["name"], "label": f["label"] or f["name"],
                "role": "other", "scaleType": "interval", "derived": True,
                "origin": {"method": "famd", "resultId": result_id, "source": source,
                           "sourceField": f["sourceField"]}})
        cb["schemaRevision"] = int(cb.get("schemaRevision", meta_now.get("schemaRevision", 1))) + 1
        provenance_before = store.load_provenance(dataset_id) or {}
        step = {"operationId": new_operation_id(),
                "parentOperationId": provenance_before.get("currentOperationId"),
                "operation": "calculate",
                "params": {"famdResultId": result_id, "famdSource": source,
                           "famdFields": fields, "famdIdempotencyKey": req.idempotencyKey,
                           "famdPayload": payload_norm},
                "targetRowIds": sorted(scope_ids),
                "targetCells": [],
                "inputSchemaRevision": int(cb.get("schemaRevision", 1)),
                "outputSchemaRevision": int(cb.get("schemaRevision", 1)),
                "algorithmVersion": "davis.famd.1.0.0",
                "timestamp": now_iso(), "createdBy": "local-session"}
        schema = list(meta_now.get("schema", []) or [])
        for f in fields:
            schema.append({"columnId": f["columnId"], "name": f["name"], "semanticType": "numeric"})
        meta_now["schema"] = schema
        meta_now["schemaRevision"] = int(cb.get("schemaRevision", 1))
        meta_now["columnCount"] = df.width - 1
        store.commit_data_change(dataset_id, meta_now, df, codebook=cb, step=step)
        fresh_meta = store.get_meta(dataset_id)
        fresh_cb = store.load_codebook(dataset_id) or {}
        non_null = {}
        for f in fields:
            non_null[f["name"]] = int(df[f["name"]].drop_nulls().len())
        created = [{"columnId": f["columnId"], "name": f["name"],
                    "label": f["label"] or f["name"], "sourceField": f["sourceField"],
                    "nonNullCount": non_null[f["name"]]} for f in fields]
        written = int(sum(1 for rid in all_ids if any(
            rid in values and rid in scope_ids and (values[rid][a - 1] is not None)
            for a in [f["axis"] for f in fields])))
        resp = {"status": "success", "resultId": result_id, "source": source,
                "operationId": step["operationId"], "datasetId": dataset_id,
                "dataRevision": int(fresh_meta.get("dataRevision", 1)),
                "schemaRevision": int(fresh_cb.get("schemaRevision", fresh_meta.get("schemaRevision", 1))),
                "createdColumns": created, "writtenRowCount": written,
                "idempotentReplay": False}
        prov2 = store.load_provenance(dataset_id) or {}
        for op in prov2.get("operations", []) or []:
            if op.get("operationId") == step["operationId"]:
                op.setdefault("params", {})["famdResponse"] = resp
        import json as _json

        ppath = store._provenance_path(dataset_id)
        tmp = ppath.with_suffix(".tmp")
        tmp.write_bytes(_json.dumps(prov2, ensure_ascii=False, indent=2).encode("utf-8"))
        import os as _os

        _os.replace(tmp, ppath)
        check_json_finite(resp)
        return resp


def _famd_predict(result_id: str, manifest, req):
    import uuid as _uuid

    import numpy as _np
    import polars as _pl

    from ..algorithms.models.famd import project_famd_rows as _project
    from ..domain.codebook_adapter import normalize_code as _nc
    from ..domain.analysis_frame import _numeric_value as _num

    meta, stale, cur = _stale_state(manifest)
    if stale:
        _err("ANALYSIS_INPUT_STALE", "stale result", 409)
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH", "結果の所有データセットと一致しません。", 422)
    check_revisions(cur, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
    details = manifest.get("details") or {}
    encoding = manifest.get("encoding") or {}
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    missing_policy = encoding.get("missingPolicy", "exclude")
    df_ids = [str(v) for v in store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__"])["__rowId__"].to_list()]
    legacy = AnalysisContext(datasetId=manifest.get("ownerDatasetId"), expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
    scope_ids = resolve_scope(df_ids, legacy)
    arrays = result_store.load_arrays(result_id)
    mu = _np.asarray(arrays["mu"])
    sigma = _np.asarray(arrays["sigma"])
    pk = _np.asarray(arrays["pk"])
    vv = _np.asarray(arrays["v"])
    num_order = list(encoding.get("numericOrder") or [])
    cat_order = list(encoding.get("categories") or [])
    spec_map = dict(encoding.get("specByVariable") or {})
    blocks = [tuple(b) for b in (encoding.get("categoryBlocks") or [])]
    p = len(num_order)
    codebook = store.load_codebook(manifest.get("ownerDatasetId")) or {}
    spec_by_id = {s.get("columnId"): s for s in (codebook.get("columns", []) or []) if isinstance(s, dict)}
    num_spec_by_id: dict[str, dict] = {}
    for entry in num_order:
        info = entry if isinstance(entry, dict) else {}
        vid = info.get("variableId")
        if vid and vid in spec_by_id:
            num_spec_by_id[vid] = spec_by_id[vid]
    missing_by_var: dict[str, set] = {}
    reason_by_var: dict[str, dict] = {}
    for var in details.get("categoricalVariables", []) or []:
        vid = var.get("variableId")
        spec = spec_by_id.get(vid)
        if spec is None:
            continue
        missing_by_var[vid] = {_nc(x) for x in (spec.get("missingCodes") or [])}
        missing_by_var[vid].discard(None)
        reasons = spec.get("missingReasons") or {}
        reason_by_var[vid] = reasons if isinstance(reasons, dict) else {}
    need_names: set[str] = set()
    for entry in num_order:
        info = entry if isinstance(entry, dict) else {}
        if info.get("columnName"):
            need_names.add(info["columnName"])
    for var in details.get("categoricalVariables", []) or []:
        info = spec_map.get(var.get("variableId"), {}) or {}
        if info.get("columnName"):
            need_names.add(info["columnName"])
    full_df = store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__", *sorted(need_names)])
    full_by_id = {str(r["__rowId__"]): r for r in full_df.rows(named=True)}
    num_lookup = {e.get("variableId"): e for e in num_order if isinstance(e, dict)}
    cat_vars = list(details.get("categoricalVariables", []) or [])
    z_rows: list[list[float]] = []
    statuses: list[str] = []
    warnings: list[dict] = []
    ok_idx: list[int] = []
    for pos, rid in enumerate(scope_ids):
        rec = full_by_id.get(str(rid))
        status = "ok"
        y_new: list[float] = []
        g_new: list[float] = [0.0] * len(cat_order)
        if rec is None:
            status = "invalid"
        else:
            for j, entry in enumerate(num_order):
                info = entry if isinstance(entry, dict) else {}
                raw = rec.get(info.get("columnName")) if info.get("columnName") else None
                val, reason = _num(raw, num_spec_by_id.get(info.get("variableId")))
                if reason != "ok" or val is None:
                    status = "missing" if reason == "missing" else "invalid"
                    break
                y_new.append(float(val))
            if status == "ok":
                col_pos = 0
                for var in cat_vars:
                    if status != "ok":
                        break
                    vid = var.get("variableId")
                    info = spec_map.get(vid, {}) or {}
                    spec = spec_by_id.get(vid)
                    if spec is None:
                        status = "invalid"
                        break
                    cname = info.get("columnName") or spec.get("name")
                    raw = rec.get(cname) if cname else None
                    code = _nc(raw)
                    group_vars = [cc for cc in cat_order if cc.get("variableId") == vid]
                    if code is None or code in missing_by_var.get(vid, set()):
                        if missing_policy == "exclude":
                            status = "missing"
                            break
                        from ..domain.codebook_adapter import is_not_applicable_reason as _is_na
                        reason = reason_by_var.get(vid, {}).get(code, "")
                        want_na = missing_policy == "separate_not_applicable" and _is_na(reason)
                        hit = next((g for g in group_vars
                                    if g.get("kind") == ("not_applicable" if want_na else "missing")), None)
                        if hit is None:
                            status = "unknown_category"
                            break
                        g_new[col_pos + [g.get("categoryId") for g in group_vars].index(hit["categoryId"])] = 1.0
                        col_pos += len(group_vars)
                        continue
                    hit = next((g for g in group_vars if g.get("kind") == "value" and g.get("code") == code), None)
                    if hit is None:
                        status = "unknown_category"
                        break
                    g_new[col_pos + [g.get("categoryId") for g in group_vars].index(hit["categoryId"])] = 1.0
                    col_pos += len(group_vars)
            # Row completeness across category variables.
            if status == "ok":
                expect = sum(len([cc for cc in cat_order if cc.get("variableId") == v.get("variableId")])
                             for v in cat_vars)
                if abs(sum(g_new) - len(cat_vars)) > 1e-9 or len(g_new) != expect:
                    status = "missing"
        z_rows.append([*y_new, *g_new] if status == "ok" else [0.0] * (p + len(cat_order)))
        statuses.append(status)
        if status == "ok":
            ok_idx.append(pos)
            for j, entry in enumerate(num_order):
                info = entry if isinstance(entry, dict) else {}
                try:
                    lo = float(info.get("min", float("nan")))
                    hi = float(info.get("max", float("nan")))
                    val = float(y_new[j])
                except (TypeError, ValueError):
                    continue
                import math as _math
                if _math.isfinite(lo) and _math.isfinite(hi) and (val < lo or val > hi):
                    warnings.append({"code": "FAMD_EXTRAPOLATION",
                                     "message": f"数値が学習範囲外です: {info.get('variableId')}",
                                     "count": 1, "columnIds": [info.get("variableId")]})
                    break
    coords = [[None] * rank for _ in scope_ids]
    cos2_out: list[list[float | None]] = [[None] * rank for _ in scope_ids]
    if ok_idx:
        ymat = _np.asarray([z_rows[i][:p] for i in ok_idx], dtype=float)
        gmat = _np.asarray([z_rows[i][p:] for i in ok_idx], dtype=float)
        proj = _project(ymat, gmat, mu=mu, sigma=sigma, pk=pk, v=vv)
        d2 = _np.square(_np.column_stack([(ymat - mu[None, :]) / sigma[None, :],
                                          (gmat - pk[None, :]) / _np.sqrt(pk)[None, :]])).sum(axis=1)
        for k, i in enumerate(ok_idx):
            coords[i] = [float(x) for x in proj[k, :].tolist()]
            denom = float(d2[k])
            cos2_out[i] = [(float(proj[k, a] ** 2 / denom) if denom > 0 else None) for a in range(rank)]
    prediction_id = f"pred-{_uuid.uuid4().hex[:12]}"
    pdf = _pl.DataFrame({"rowId": scope_ids, "status": statuses,
                         **{f"axis{a+1}": [(c[a] if c[a] is not None else None) for c in coords] for a in range(rank)}})
    result_store.save_prediction_rows(result_id, prediction_id, pdf)
    status_counts = {k: 0 for k in ("ok", "unknown_category", "missing", "invalid", "unavailable")}
    for s in statuses:
        status_counts[s if s in status_counts else "unavailable"] += 1
    seen_warn: dict[str, dict] = {}
    for w in warnings:
        key = (w.get("code"), str(w.get("columnIds")))
        if key not in seen_warn:
            seen_warn[key] = dict(w)
            seen_warn[key]["count"] = 0
        seen_warn[key]["count"] += 1
    out = {"status": "success", "resultId": result_id, "predictionId": prediction_id,
           "summary": {"requestedCount": len(scope_ids),
                       "successfulPredictions": status_counts["ok"],
                       "failedPredictions": len(scope_ids) - status_counts["ok"],
                       "statusCounts": status_counts, "evaluation": None},
           "meta": {**meta, "warnings": list(seen_warn.values())}, "unavailableReasons": {}}
    check_json_finite(out)
    return out


def _export_famd_variables(manifest, meta, result_id, req):
    details = manifest.get("details") or {}
    rank = int((manifest.get("summary") or {}).get("rank", 0))
    header = ["variableId", "kind", "label"] + [f"relation{a+1}" for a in range(rank)] + [f"contribution{a+1}" for a in range(rank)]
    var_rows = list(details.get("variableRelation") or [])
    rows_all = []
    num_by_id = {v.get("variableId"): v for v in (details.get("numericVariables") or [])}
    cat_by_id = {v.get("variableId"): v for v in (details.get("categoricalVariables") or [])}
    for e in var_rows:
        rel = list(e.get("relationStrength") or [])
        contrib = list(e.get("contributions") or [])
        src = num_by_id.get(e.get("variableId")) if e.get("kind") == "numeric" else cat_by_id.get(e.get("variableId"))
        label = (src or {}).get("label", e.get("variableId"))
        rows_all.append([e.get("variableId"), e.get("kind"), label]
                        + [rel[i] if i < len(rel) else None for i in range(rank)]
                        + [contrib[i] if i < len(contrib) else None for i in range(rank)])
    total = len(rows_all)
    part = rows_all[req.offset:req.offset + req.limit]
    nxt = req.offset + len(part) if req.offset + len(part) < total else None
    if req.format == "json":
        body = {"columns": header, "rows": part}
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
    out = {"status": "success", "mime": mime, "fileName": f"{result_id}-variables.{req.format}", "encoding": "utf-8", "payload": payload_text, "offset": req.offset, "total": total, "nextOffset": nxt, "hasHeader": req.format == "csv", "snapshot": {"datasetId": meta.get("datasetId"), "dataRevision": meta.get("dataRevision"), "schemaRevision": meta.get("schemaRevision"), "resultId": result_id}}
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
