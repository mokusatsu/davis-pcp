"""Multiple Correspondence Analysis API (Feature 030, production).

Indicator MCA: P=Z/(n m), full-spectrum eigenvalues, Benzecri adjusted
series kept separate, fit rows + fitted transform persisted, paged rows,
rectangle/category/row_id selection, projection, materialize, export.
"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any

import numpy as np
import polars as pl
from fastapi import APIRouter, Body
from pydantic import ValidationError

from ..algorithms.models.mca import project_mca_rows, run_mca_numeric
from ..domain.analysis_contracts import MCARequest
from ..domain.analysis_frame import prepare_mca_frame
from ..domain.context import check_revisions, collect_revisions
from ..domain.errors import BizError
from ..services.analysis_service import build_meta, check_json_finite, model_fingerprint, new_result_id
from ..storage import analysis_result_store as result_store
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()
ALGORITHM_VERSION = "davis.mca.1.0.0"
SCHEMA_VERSION = "analysis-result/1.0"


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _parse_request(payload):
    try:
        return MCARequest.model_validate(payload)
    except ValidationError:
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422)


def _category_id(column_id, kind, code):
    canon = json.dumps([column_id, kind, code], ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return "cat:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _map_kernel_error(exc):
    msg = str(exc)
    if msg in ("MCA_TOO_FEW_VARIABLES", "MCA_CATEGORY_REQUIRED", "MCA_CONSTANT_VARIABLE",
               "MCA_MA_UNSUPPORTED", "MCA_ZERO_INERTIA", "MCA_INVALID_INDICATOR",
               "MCA_ZERO_MASS_CATEGORY"):
        _err(msg, "MCAの入力または推定条件を満たしません。", 422)
    if msg == "ANALYSIS_NUMERICAL_INVARIANT_FAILED":
        raise BizError("ANALYSIS_NUMERICAL_INVARIANT_FAILED", "数値不変条件を満たしません。",
                       status_code=500)
    _err("MCA_INVALID_INDICATOR", "指示行列が不正です。", 422)


def _reject_legacy_keys(payload: dict) -> None:
    legacy = [k for k in ("n_components", "nComponents", "includeRowCoordinates",
                           "rowOffset", "rowLimit", "row_coordinates") if k in payload]
    if legacy:
        _err("ANALYSIS_REQUEST_INVALID",
             f"旧MCA入力キーは使用できません: {', '.join(legacy)}。新契約へ更新してください。",
             422, details={"legacyKeys": legacy})


@router.post("/models/mca")
def run_mca(payload: dict = Body(...)):
    _reject_legacy_keys(payload if isinstance(payload, dict) else {})
    req = _parse_request(payload)
    ctx = req.context.model_dump()
    started = time.perf_counter()
    try:
        frame = prepare_mca_frame(dataset_id=ctx["datasetId"], context_dict=ctx,
                                  variable_refs=list(req.variables),
                                  ma_mode=req.maMode, store=store)
    except BizError:
        raise
    m = len(frame.variables)
    if m < 2:
        _err("MCA_TOO_FEW_VARIABLES", "分析変数は2つ以上必要です。", 422)
    # Constant-variable guard + zero-mass catalog split.
    kept_vars: list[dict[str, Any]] = []
    omitted: list[dict[str, Any]] = []
    z_blocks: list[np.ndarray] = []
    cat_slots: list[dict[str, Any]] = []
    for var in frame.variables:
        cats = [c for c in var["categories"] if c["count"] > 0]
        if len(cats) < 2:
            _err("MCA_CONSTANT_VARIABLE", f"変数の有効カテゴリが1つだけです: {var['label']}",
                 422, details={"columnIds": [var["variableId"]]})
        for slot, cat in enumerate(cats, start=len(cat_slots)):
            col = np.zeros(len(frame.row_ids), dtype=np.float64)
            col[np.asarray(cat["rows"], dtype=int)] = 1.0
            z_blocks.append(col)
            cat_slots.append({"variable": var, "category": cat, "slot": slot,
                              "code": cat["code"], "kind": cat["kind"]})
        for cat in var["categories"]:
            if cat["count"] <= 0:
                omitted.append({
                    "categoryId": _category_id(var["variableId"], cat["kind"],
                                               cat["code"] if cat["kind"] == "value" else None),
                    "variableId": var["variableId"], "code": cat["code"] if cat["kind"] == "value" else None,
                    "kind": cat["kind"], "label": cat["label"], "reason": "zero_mass"})
        kept_vars.append(var)
    z = np.column_stack(z_blocks)
    if z.shape[1] == 0:
        _err("MCA_CATEGORY_REQUIRED", "有効カテゴリがありません。", 422)
    weights = ([float(v) for v in frame.weights] if frame.weights is not None
               else None)
    try:
        kern = run_mca_numeric(z, weights=weights, m=m,
                               category_index=list(range(z.shape[1])))
    except ValueError as exc:
        _map_kernel_error(exc)
    return _publish(req, ctx, started, kern, frame, kept_vars, cat_slots, omitted, z)


def _publish(req, ctx, started, kern, frame, kept_vars, cat_slots, omitted, z):
    request_json = json.loads(req.model_dump_json())
    rank = int(kern["rank"])
    eig = [float(v) for v in kern["eigenvalues"].tolist()]
    total_inertia = float(kern["totalInertia"])
    ratio = [float(v) for v in kern["inertiaRatio"].tolist()]
    cum = [float(v) for v in kern["cumulativeInertiaRatio"].tolist()]
    adj_eig = [float(v) for v in np.asarray(kern["adjustedEigenvalues"]).tolist()]
    adj_ratio = [(None if v is None else float(v)) for v in kern["adjustedInertiaRatio"]]
    if req.inertiaAdjustment == "raw":
        adj_eig_out = None
        adj_ratio_out = None
    else:
        adj_eig_out = adj_eig
        adj_ratio_out = adj_ratio
    # Warnings: small-n, rare categories, MA block weighting.
    warnings: list[dict[str, Any]] = []
    if frame.fit_count < 30:
        warnings.append({"code": "MCA_SMALL_SAMPLE",
                         "message": f"有効回答者数が少ないです（n={frame.fit_count}）。解釈に注意してください。",
                         "count": frame.fit_count, "columnIds": []})
    rare_ids = []
    w = ([float(v) for v in frame.weights] if frame.weights is not None else [1.0] * len(frame.row_ids))
    total_w = float(sum(w)) if w else 0.0
    for slot in cat_slots:
        phys = int(slot["category"]["count"])
        share = float(np.sum([w[i] for i in slot["category"]["rows"]]) / total_w) if total_w > 0 else 0.0
        if phys < 5 or share < 0.01:
            rare_ids.append(slot)
    if rare_ids:
        warnings.append({"code": "MCA_RARE_CATEGORY",
                         "message": f"稀少カテゴリが{len(rare_ids)}件あります。距離が大きくなりやすく、解釈に注意してください。",
                         "count": len(rare_ids), "columnIds": sorted({s["variable"]["variableId"] for s in rare_ids})})
    if frame.ma_diagnostics:
        multi = [d for d in frame.ma_diagnostics if len(d.get("selectedChildIds", [])) > 1]
        if multi:
            warnings.append({
                "code": "MA_OPTION_BLOCK_WEIGHTING",
                "message": "MA親の複数選択肢を別変数として使用しています。1設問より強く関与し得ます。",
                "count": len(multi),
                "columnIds": [d["parentId"] for d in multi]})
    # Category entries.
    categories = []
    members: list[tuple[str, str]] = []
    for pos, slot in enumerate(cat_slots):
        var = slot["variable"]
        cat = slot["category"]
        kind = slot["kind"]
        code = cat["code"] if kind == "value" else None
        cid = _category_id(var["variableId"], kind, code)
        princ = [float(v) for v in kern["g"][pos, :].tolist()]
        std = [float(v) for v in kern["gamma"][pos, :].tolist()]
        contrib = [float(v) for v in kern["catContrib"][pos, :].tolist()]
        cosrow = kern["catCos2"][pos, :]
        cos2 = [None if not np.isfinite(v) else float(v) for v in cosrow.tolist()]
        phys_count = int(cat["count"])
        p_val = float(kern["p"][pos])
        c_val = float(kern["c"][pos])
        categories.append({
            "categoryId": cid, "variableId": var["variableId"], "code": code, "kind": kind,
            "label": cat["label"], "physicalCount": phys_count,
            "categoryProbability": p_val, "categoryMass": c_val,
            "principalCoordinates": princ, "standardCoordinates": std,
            "contributions": contrib, "cos2": cos2,
            "distanceSquared": float(kern["catDistance2"][pos])})
        for row_pos in cat["rows"]:
            members.append((cid, frame.row_ids[row_pos]))
    variables = [{
        "variableId": var["variableId"], "label": var["label"],
        "categoryIds": [_category_id(var["variableId"], s["kind"],
                                     s["code"] if s["kind"] == "value" else None)
                        for s in cat_slots if s["variable"] is var],
        "isMaOption": bool(var.get("isMaOption", False)),
        "maParentId": var.get("maParentId"),
    } for var in kept_vars]
    # Fit rows (all axes).
    rows = []
    for i, rid in enumerate(frame.row_ids):
        coords = [float(v) for v in kern["f"][i, :].tolist()]
        contrib = [float(v) for v in kern["rowContrib"][i, :].tolist()]
        cosrow = kern["rowCos2"][i, :]
        cos2 = [None if not np.isfinite(v) else float(v) for v in cosrow.tolist()]
        rows.append({"rowId": rid, "coordinates": coords, "contributions": contrib,
                     "cos2": cos2, "mass": float(kern["a"][i]),
                     "distanceSquared": float(kern["rowDistance2"][i])})
    summary = {
        "nVariables": m if (m := len(kept_vars)) else 0,
        "nCategories": len(cat_slots),
        "rank": rank,
        "totalInertia": total_inertia,
        "eigenvalues": eig,
        "rawInertiaRatio": ratio,
        "rawCumulativeInertiaRatio": cum,
        "inertiaAdjustment": req.inertiaAdjustment,
        "adjustedEigenvalues": adj_eig_out,
        "adjustedInertiaRatio": adj_ratio_out,
        "adjustedReason": kern.get("adjustedReason"),
        "discardedNumericalInertia": float(kern.get("discardedNumericalInertia", 0.0)),
        "degenerateBlocks": kern.get("degenerateBlocks", []),
        "rankTol": float(kern.get("rankTol", 0.0)),
    }
    details = {"categories": categories, "variables": variables,
               "omittedCategories": omitted, "maDiagnostics": frame.ma_diagnostics,
               "rowCount": len(rows)}
    w_list = ([float(v) for v in frame.weights] if frame.weights is not None
              else [1.0] * len(frame.row_ids))
    sum_w = float(sum(w_list)) if frame.weight_applied else None
    kish = (sum_w * sum_w / float(sum(v * v for v in w_list))) if (frame.weight_applied and sum_w and sum(v * v for v in w_list) > 0) else (float(len(frame.row_ids)) if not frame.weight_applied else None)
    freq_n = float(sum(int(round(v)) for v in w_list)) if (frame.weight_applied and frame.weight_type == "frequency") else None
    fp_payload = {
        "datasetId": ctx["datasetId"], "dataRevision": frame.revisions["dataRevision"],
        "schemaRevision": frame.revisions["schemaRevision"], "maskRevision": frame.mask_revision,
        "snapshotFingerprint": frame.data_fingerprint, "scopeHash": None, "fitRowIdsHash": None,
        "effectiveConfig": request_json,
        "catalogs": {v["variableId"]: {"order": [str(c["code"]) for c in v["categories"]]} for v in kept_vars},
        "resolvedWeight": {"applied": frame.weight_applied, "type": frame.weight_type,
                           "column": frame.weight_column},
        "algorithmVersion": ALGORITHM_VERSION,
    }
    from ..domain.context import scope_hash as _sh
    fp_payload["scopeHash"] = _sh([str(v) for v in frame.scope_ids])
    fp_payload["fitRowIdsHash"] = _sh([str(v) for v in frame.row_ids])
    fingerprint = model_fingerprint(fp_payload)
    meta = build_meta(
        dataset_id=ctx["datasetId"], revisions=frame.revisions,
        snapshot_fingerprint=frame.data_fingerprint, scope=ctx.get("scope", "all"),
        scope_ids=[str(v) for v in frame.scope_ids], fit_count=frame.fit_count,
        exclusion_counts=dict(frame.exclusion_counts), analysis_unit="respondent_row",
        weight_applied=frame.weight_applied, weight_type=frame.weight_type,
        weight_column=frame.weight_column, sum_weights=sum_w, kish_effective_n=kish,
        frequency_n=freq_n, mask_revision=frame.mask_revision,
        imputed_cell_count=int(getattr(frame, "imputed_cell_count", 0) or 0),
        imputed_row_count=int(getattr(frame, "imputed_row_count", 0) or 0),
        fingerprint=fingerprint, algorithm_version=ALGORITHM_VERSION,
        warnings=warnings)
    result_id = new_result_id()
    rank_n = rank
    capabilities = {
        "rows": True, "projection": True, "materialize": True,
        "selectionKinds": ["rectangle", "categories", "row_ids"],
        "exportTables": ["manifest", "eigenvalues", "categories", "rows"],
        "materializeFitFields": [f"coordinate:{i+1}" for i in range(rank_n)],
        "materializePredictionFields": [f"coordinate:{i+1}" for i in range(rank_n)],
        "predictionIntervals": ["none"], "simulation": False,
    }
    encoding = {"categories": [
        {"categoryId": c["categoryId"], "variableId": c["variableId"],
         "code": c["code"], "kind": c["kind"]} for c in categories],
        "missingPolicy": ctx.get("missingPolicy", "exclude"),
        "maMode": req.maMode,
        "maGroups": [
            {"parentId": d.get("parentId"),
             "selectedChildIds": list(d.get("selectedChildIds", [])),
             "dependencyChildIds": list(d.get("dependencyChildIds", []))}
            for d in (frame.ma_diagnostics or [])],
        "specByVariable": {
            v["variableId"]: {"columnName": next(
                (vv.get("columnName") for vv in frame.variables
                 if vv.get("variableId") == v["variableId"]), v["variableId"]),
                "isMaOption": bool(v.get("isMaOption", False)),
                "maParentId": v.get("maParentId")}
            for v in kept_vars}}
    manifest = {"schemaVersion": SCHEMA_VERSION, "resultId": result_id, "method": "mca",
                "ownerDatasetId": ctx["datasetId"], "config": request_json, "meta": meta,
                "capabilities": capabilities, "summary": summary, "details": details,
                "encoding": encoding,
                "summaryKeys": list(summary.keys()), "unavailableReasons": {}}
    arrays = {"eigenvalues": np.asarray(eig, dtype=np.float64),
              "f": np.asarray(kern["f"]), "g": np.asarray(kern["g"]),
              "gamma": np.asarray(kern["gamma"]),
              "a": np.asarray(kern["a"]), "p": np.asarray(kern["p"]),
              "c": np.asarray(kern["c"]), "v": np.asarray(kern["v"]),
              "s": np.asarray(kern["s"]),
              "rowContrib": np.asarray(kern["rowContrib"]),
              "rowCos2": np.asarray(np.nan_to_num(kern["rowCos2"], nan=-1.0)),
              "rowDist2": np.asarray(kern["rowDistance2"])}
    mem_df = pl.DataFrame({"categoryId": [a for a, _ in members],
                           "rowId": [b for _, b in members],
                           "side": ["category"] * len(members)})
    rows_df = pl.DataFrame({
        "rowId": [r["rowId"] for r in rows],
        **{f"axis{i+1}": [r["coordinates"][i] for r in rows] for i in range(rank_n)},
    }) if rows else pl.DataFrame({"rowId": []})
    with store.lock(ctx["datasetId"]):
        cur_meta = store.get_meta(ctx["datasetId"])
        cur_code = store.load_codebook(ctx["datasetId"]) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
        base_rev = frame.revisions
        if (cur_rev["dataRevision"] != base_rev["dataRevision"]
                or cur_rev["schemaRevision"] != base_rev["schemaRevision"]):
            raise BizError("ANALYSIS_INPUT_STALE", "計算中にデータが更新されました。再実行してください。",
                           status_code=409)
        result_store.save_result(result_id, manifest, arrays, members=mem_df,
                                 exclusions=None, rows=rows_df)
    out = {"status": "success", "resultId": result_id, "method": "mca", "meta": meta,
           "config": request_json, "capabilities": capabilities, "summary": summary,
           "details": details, "unavailableReasons": {}}
    check_json_finite(out)
    return out
