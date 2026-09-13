"""Factor Analysis of Mixed Data API (Feature 031, production).

FAMD: weighted standardized numerics (ddof=0) + indicator B=(G-p)/sqrt(p),
exact thin SVD, weighted individual barycenters, eta2/r2 variable relation,
fit rows + fitted transform persisted, paged rows, rectangle/category/row_id
selection, fixed-transform projection, materialize, export.
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

from ..algorithms.models.famd import project_famd_rows, run_famd_numeric
from ..domain.analysis_contracts import FAMDRequest
from ..domain.analysis_frame import prepare_famd_frame
from ..domain.context import check_revisions, collect_revisions
from ..domain.errors import BizError
from ..services.analysis_service import build_meta, check_json_finite, model_fingerprint, new_result_id
from ..storage import analysis_result_store as result_store
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()
ALGORITHM_VERSION = "davis.famd.1.0.0"
SCHEMA_VERSION = "analysis-result/1.0"


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _parse_request(payload):
    try:
        return FAMDRequest.model_validate(payload)
    except ValidationError:
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422)


def _category_id(column_id, kind, code):
    canon = json.dumps([column_id, kind, code], ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return "cat:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _map_kernel_error(exc):
    msg = str(exc)
    if msg in ("FAMD_MIXED_INPUT_REQUIRED", "FAMD_SCALE_INVALID", "FAMD_MA_UNSUPPORTED",
               "FAMD_CONSTANT_VARIABLE", "FAMD_ZERO_INERTIA", "FAMD_ZERO_MASS_CATEGORY",
               "FAMD_INVALID_MATRIX", "FAMD_UNKNOWN_CATEGORY"):
        code = msg if msg.startswith("FAMD_") else "FAMD_SCALE_INVALID"
        _err(code, "FAMDの入力または推定条件を満たしません。", 422)
    if msg == "ANALYSIS_NUMERICAL_INVARIANT_FAILED":
        raise BizError("ANALYSIS_NUMERICAL_INVARIANT_FAILED", "数値不変条件を満たしません。",
                       status_code=500)
    _err("FAMD_SCALE_INVALID", "FAMDの入力が不正です。", 422)


@router.post("/models/famd")
def run_famd(payload: dict = Body(...)):
    req = _parse_request(payload)
    ctx = req.context.model_dump()
    started = time.perf_counter()
    try:
        frame = prepare_famd_frame(dataset_id=ctx["datasetId"], context_dict=ctx,
                                   numeric_refs=list(req.numericVariables),
                                   categorical_refs=list(req.categoricalVariables),
                                   store=store)
    except BizError:
        raise
    n = len(frame.row_ids)
    p = len(frame.numeric_names)
    if p < 1 or not frame.variables:
        _err("FAMD_MIXED_INPUT_REQUIRED",
             "数値変数とカテゴリ変数をそれぞれ1列以上指定してください。", 422)
    y = np.asarray(frame.numeric_values, dtype=np.float64).T if n else np.zeros((0, p))
    kept_vars: list[dict[str, Any]] = []
    omitted: list[dict[str, Any]] = []
    g_blocks: list[np.ndarray] = []
    cat_slots: list[dict[str, Any]] = []
    blocks: list[tuple[int, int]] = []
    for var in frame.variables:
        cats = [c for c in var["categories"] if c["count"] > 0]
        if len(cats) < 2:
            _err("FAMD_CONSTANT_VARIABLE", f"カテゴリ変数の有効水準が1つだけです: {var['label']}",
                 422, details={"columnIds": [var["variableId"]]})
        start = len(cat_slots)
        for cat in cats:
            col = np.zeros(n, dtype=np.float64)
            col[np.asarray(cat["rows"], dtype=int)] = 1.0
            g_blocks.append(col)
            cat_slots.append({"variable": var, "category": cat, "slot": len(cat_slots),
                              "code": cat["code"], "kind": cat["kind"]})
        blocks.append((start, len(cat_slots)))
        for cat in var["categories"]:
            if cat["count"] <= 0:
                omitted.append({
                    "categoryId": _category_id(var["variableId"], cat["kind"],
                                               cat["code"] if cat["kind"] == "value" else None),
                    "variableId": var["variableId"], "code": cat["code"] if cat["kind"] == "value" else None,
                    "kind": cat["kind"], "label": cat["label"], "reason": "zero_mass"})
        kept_vars.append(var)
    g = np.column_stack(g_blocks) if g_blocks else np.zeros((n, 0))
    weights = ([float(v) for v in frame.weights] if frame.weights is not None else None)
    try:
        kern = run_famd_numeric(y, g, weights=weights, category_blocks=blocks)
    except ValueError as exc:
        _map_kernel_error(exc)
    return _publish(req, ctx, started, kern, frame, kept_vars, cat_slots, blocks, omitted)


def _weighted_warning_rows(frame, cat_slots):
    warnings: list[dict[str, Any]] = []
    if frame.fit_count < 30:
        warnings.append({"code": "FAMD_SMALL_SAMPLE",
                         "message": f"有効回答者数が少ないです（n={frame.fit_count}）。解釈に注意してください。",
                         "count": frame.fit_count, "columnIds": []})
    w = ([float(v) for v in frame.weights] if frame.weights is not None else [1.0] * len(frame.row_ids))
    total_w = float(sum(w)) if w else 0.0
    rare_ids = []
    for slot in cat_slots:
        phys = int(slot["category"]["count"])
        share = float(np.sum([w[i] for i in slot["category"]["rows"]]) / total_w) if total_w > 0 else 0.0
        if phys < 5 or share < 0.01:
            rare_ids.append(slot)
    if rare_ids:
        warnings.append({"code": "FAMD_RARE_CATEGORY",
                         "message": f"稀少カテゴリが{len(rare_ids)}件あります。重心が不安定になりやすく、解釈に注意してください。",
                         "count": len(rare_ids), "columnIds": sorted({s["variable"]["variableId"] for s in rare_ids})})
    return warnings


def _publish(req, ctx, started, kern, frame, kept_vars, cat_slots, blocks, omitted):
    request_json = json.loads(req.model_dump_json())
    rank = int(kern["rank"])
    eig = [float(v) for v in kern["eigenvalues"].tolist()]
    total_inertia = float(kern["totalInertia"])
    ratio = [float(v) for v in kern["inertiaRatio"].tolist()]
    cum = [float(v) for v in kern["cumulativeInertiaRatio"].tolist()]
    warnings = _weighted_warning_rows(frame, cat_slots)
    categories = []
    members: list[tuple[str, str]] = []
    pk = [float(v) for v in kern["pk"].tolist()]
    for pos, slot in enumerate(cat_slots):
        var = slot["variable"]
        cat = slot["category"]
        kind = slot["kind"]
        code = cat["code"] if kind == "value" else None
        cid = _category_id(var["variableId"], kind, code)
        bary = [float(v) for v in kern["barycenters"][pos, :].tolist()]
        contrib = [float(v) for v in kern["catContrib"][pos, :].tolist()]
        cosrow = kern["catCos2"][pos, :]
        cos2 = [None if not np.isfinite(v) else float(v) for v in cosrow.tolist()]
        categories.append({
            "categoryId": cid, "variableId": var["variableId"], "code": code, "kind": kind,
            "label": cat["label"], "physicalCount": int(cat["count"]),
            "probability": float(pk[pos]),
            "barycenterCoordinates": bary, "contributions": contrib, "cos2": cos2,
            "distanceSquared": float(kern["catDistance2"][pos])})
        for row_pos in cat["rows"]:
            members.append((cid, frame.row_ids[row_pos]))
    numeric_details = []
    for j, name in enumerate(frame.numeric_names):
        corr = [float(v) for v in kern["correlations"][j, :].tolist()]
        contrib = [float(v) for v in kern["numContrib"][j, :].tolist()]
        cos2 = [float(v) for v in kern["numCos2"][j, :].tolist()]
        numeric_details.append({
            "variableId": frame.numeric_ids[j], "label": frame.numeric_specs[j].get("label") or name,
            "mean": float(kern["mu"][j]), "scale": float(kern["sigma"][j]),
            "correlations": corr, "contributions": contrib, "cos2": cos2})
    categorical_details = []
    for j, var in enumerate(kept_vars):
        ids = [_category_id(var["variableId"], s["kind"],
                            s["code"] if s["kind"] == "value" else None)
               for s in cat_slots if s["variable"] is var]
        rel = [float(v) for v in kern["eta2"][j, :].tolist()]
        contrib = [float(v) for v in kern["varContrib"][len(frame.numeric_names) + j, :].tolist()]
        categorical_details.append({
            "variableId": var["variableId"], "label": var["label"],
            "categoryIds": ids, "relationStrength": rel, "contributions": contrib})
    var_relation = []
    for j, name in enumerate(frame.numeric_names):
        r2 = [float(v) for v in np.square(kern["correlations"][j, :]).tolist()]
        contrib = [float(v) for v in kern["numContrib"][j, :].tolist()]
        var_relation.append({"variableId": frame.numeric_ids[j], "kind": "numeric",
                             "relationStrength": r2, "contributions": contrib})
    for j, var in enumerate(kept_vars):
        rel = [float(v) for v in kern["eta2"][j, :].tolist()]
        contrib = [float(v) for v in kern["varContrib"][len(frame.numeric_names) + j, :].tolist()]
        var_relation.append({"variableId": var["variableId"], "kind": "categorical",
                             "relationStrength": rel, "contributions": contrib})
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
        "rank": rank,
        "totalInertia": total_inertia,
        "eigenvalues": eig,
        "inertiaRatio": ratio,
        "cumulativeInertiaRatio": cum,
        "nNumericVariables": len(frame.numeric_names),
        "nCategoricalVariables": len(kept_vars),
        "nCategories": len(cat_slots),
        "coordinateConvention": "weighted_individual_barycenter",
        "discardedNumericalInertia": float(kern.get("discardedNumericalInertia", 0.0)),
        "degenerateBlocks": kern.get("degenerateBlocks", []),
        "rankTol": float(kern.get("rankTol", 0.0)),
    }
    details = {"numericVariables": numeric_details, "categoricalVariables": categorical_details,
               "categories": categories, "variableRelation": var_relation,
               "omittedCategories": omitted, "rowCount": len(rows)}
    w_list = ([float(v) for v in frame.weights] if frame.weights is not None
              else [1.0] * len(frame.row_ids))
    sum_w = float(sum(w_list)) if frame.weight_applied else None
    denom = float(sum(v * v for v in w_list))
    kish = (sum_w * sum_w / denom) if (frame.weight_applied and sum_w and denom > 0) else (
        float(len(frame.row_ids)) if not frame.weight_applied else None)
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
    capabilities = {
        "rows": True, "projection": True, "materialize": True,
        "selectionKinds": ["rectangle", "categories", "row_ids"],
        "exportTables": ["manifest", "eigenvalues", "categories", "variables", "rows"],
        "materializeFitFields": [f"coordinate:{i+1}" for i in range(rank)],
        "materializePredictionFields": [f"coordinate:{i+1}" for i in range(rank)],
        "predictionIntervals": ["none"], "simulation": False,
    }
    encoding = {"numericOrder": [
        {"variableId": frame.numeric_ids[j], "columnName": frame.numeric_names[j],
         "mean": float(kern["mu"][j]), "scale": float(kern["sigma"][j]),
         "min": float(frame.numeric_ranges[j]["min"]), "max": float(frame.numeric_ranges[j]["max"])}
        for j in range(len(frame.numeric_names))],
        "categories": [
            {"categoryId": c["categoryId"], "variableId": c["variableId"],
             "code": c["code"], "kind": c["kind"]} for c in categories],
        "missingPolicy": ctx.get("missingPolicy", "exclude"),
        "specByVariable": {
            v["variableId"]: {"columnName": v["columnName"]}
            for v in kept_vars},
        "categoryBlocks": [[int(a), int(b)] for a, b in blocks]}
    manifest = {"schemaVersion": SCHEMA_VERSION, "resultId": result_id, "method": "famd",
                "ownerDatasetId": ctx["datasetId"], "config": request_json, "meta": meta,
                "capabilities": capabilities, "summary": summary, "details": details,
                "encoding": encoding,
                "summaryKeys": list(summary.keys()), "unavailableReasons": {}}
    arrays = {"eigenvalues": np.asarray(eig, dtype=np.float64),
              "f": np.asarray(kern["f"]), "v": np.asarray(kern["v"]),
              "s": np.asarray(kern["s"]),
              "a": np.asarray(kern["a"]), "mu": np.asarray(kern["mu"]),
              "sigma": np.asarray(kern["sigma"]), "pk": np.asarray(kern["pk"]),
              "rowContrib": np.asarray(kern["rowContrib"]),
              "rowCos2": np.asarray(np.nan_to_num(kern["rowCos2"], nan=-1.0)),
              "rowDist2": np.asarray(kern["rowDistance2"]),
              "bary": np.asarray(kern["barycenters"]),
              "catContrib": np.asarray(kern["catContrib"]),
              "catDist2": np.asarray(kern["catDistance2"]),
              "corr": np.asarray(kern["correlations"]),
              "numContrib": np.asarray(kern["numContrib"]),
              "eta2": np.asarray(kern["eta2"]),
              "varContrib": np.asarray(kern["varContrib"])}
    mem_df = pl.DataFrame({"categoryId": [a for a, _ in members],
                           "rowId": [b for _, b in members],
                           "side": ["category"] * len(members)})
    rows_df = pl.DataFrame({
        "rowId": [r["rowId"] for r in rows],
        **{f"axis{i+1}": [r["coordinates"][i] for r in rows] for i in range(rank)},
    }) if rows else pl.DataFrame({"rowId": []})
    numerical_runtime = time.perf_counter() - started
    manifest["meta"]["numericalRuntimeSeconds"] = float(numerical_runtime)
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
    out = {"status": "success", "resultId": result_id, "method": "famd", "meta": meta,
           "config": request_json, "capabilities": capabilities, "summary": summary,
           "details": details, "unavailableReasons": {}}
    check_json_finite(out)
    return out
