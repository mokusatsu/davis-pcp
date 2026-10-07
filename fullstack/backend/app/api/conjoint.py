"""Conjoint analysis API (Feature 034, production).

POST /models/conjoint (method=conjoint), POST /models/conjoint/expand-scope,
POST /models/conjoint/{resultId}/simulate. Common rows/select/predict/
materialize/export go through api/analysis_results.py delegation.
"""
from __future__ import annotations

import hashlib
import json
import math
import time
from typing import Any

import numpy as np
import polars as pl
from fastapi import APIRouter, Body
from pydantic import ValidationError
from scipy import stats as _stats
from scipy.special import logsumexp as _logsumexp

from ..algorithms.models import conjoint_choice as _choice
from ..algorithms.models import conjoint_covariance as _cov
from ..algorithms.models import conjoint_encoding as _enc
from ..algorithms.models import conjoint_ratings as _ratings
from ..algorithms.models import conjoint_simulation as _sim
from ..algorithms.survey.model_covariance import build_regression_design_frame
from ..domain.analysis_contracts import (
    ConjointExpandScopeRequest,
    ConjointRequest,
    SimulateRequest,
)
from ..domain.codebook_adapter import normalize_code
from ..domain.context import AnalysisContext, collect_revisions, scope_hash
from ..domain.errors import BizError
from ..services import conjoint_service as cj
from ..services import conjoint_fit as cf
from ..services.analysis_service import (
    build_meta,
    check_json_finite,
    model_fingerprint,
    new_result_id,
)
from ..storage import analysis_result_store as result_store
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()
ALGORITHM_VERSION = cj.ALGORITHM_VERSION
SCHEMA_VERSION = "analysis-result/1.0"


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _parse_conjoint(payload):
    if not isinstance(payload, dict):
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422)
    if payload.get("method") is not None and payload.get("method") != "conjoint":
        _err("ANALYSIS_REQUEST_INVALID",
             "このAPIはmethod=conjointのみ受け付けます。", 422)
    body = {k: v for k, v in payload.items() if k != "method"}
    try:
        return ConjointRequest.model_validate(body)
    except ValidationError as exc:
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422,
             {"errors": [e.get("msg", "") for e in exc.errors()][:10]})


def _design_column_id(term_id, descriptors):
    canon = json.dumps([term_id, descriptors], ensure_ascii=False,
                       separators=(",", ":"), allow_nan=False)
    return "design:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _category_id(column_id, kind, code):
    canon = json.dumps([column_id, kind, code], ensure_ascii=False,
                       separators=(",", ":"), allow_nan=False)
    return "cat:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _stale_state(manifest):
    meta = dict(manifest.get("meta", {}))
    ds = manifest.get("ownerDatasetId")
    try:
        cur_meta = store.get_meta(ds)
        cur_code = store.load_codebook(ds) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
    except BizError as exc:
        if exc.code == "DATASET_NOT_FOUND":
            raise BizError("ANALYSIS_RESULT_NOT_FOUND", "dataset deleted",
                           status_code=404)
        raise
    stale = (cur_rev["dataRevision"] != meta.get("dataRevision")
             or cur_rev["schemaRevision"] != meta.get("schemaRevision"))
    meta["currentDataRevision"] = cur_rev["dataRevision"]
    meta["currentSchemaRevision"] = cur_rev["schemaRevision"]
    meta["resultState"] = "stale" if stale else "current"
    return meta, stale, cur_rev


def conjoint_rows(result_id, manifest, meta, offset, limit, axes):
    if axes is not None:
        _err("ANALYSIS_REQUEST_INVALID",
             "conjoint は axes を受け付けません。", 422)
    try:
        offset = int(offset)
        limit = int(limit)
    except (TypeError, ValueError):
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    if offset < 0 or limit < 1 or limit > 10000:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    total = int(rows_df.height)
    if offset >= total:
        out = {"status": "success", "resultId": result_id,
               "offset": offset, "limit": limit, "total": total,
               "nextOffset": None, "axes": None, "rows": [],
               "meta": {"dataRevision": meta.get("dataRevision"),
                        "schemaRevision": meta.get("schemaRevision"),
                        "resultState": meta.get("resultState")}}
        check_json_finite(out)
        return out
    part = rows_df.slice(offset, limit)
    rows = []
    for rec in part.rows(named=True):
        rows.append({
            "rowId": str(rec.get("rowId")),
            "respondentId": str(rec.get("respondentId")),
            "taskId": str(rec.get("taskId")),
            "alternativeId": str(rec.get("alternativeId")),
            "observed": rec.get("observed"),
            "predictedRating": rec.get("predictedRating"),
            "probability": rec.get("probability"),
            "residual": rec.get("residual"),
            "predictionStatus": str(rec.get("predictionStatus") or "ok"),
        })
    nxt = offset + len(rows) if offset + len(rows) < total else None
    out = {"status": "success", "resultId": result_id,
           "offset": offset, "limit": limit, "total": total,
           "nextOffset": nxt, "axes": None, "rows": rows,
           "meta": {"dataRevision": meta.get("dataRevision"),
                    "schemaRevision": meta.get("schemaRevision"),
                    "resultState": meta.get("resultState")}}
    check_json_finite(out)
    return out


def conjoint_select_ids(result_id, manifest, sel):
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    fit_ids = [str(v) for v in rows_df["rowId"].to_list()]
    kind = sel.kind if isinstance(sel, str) else getattr(sel, "kind", None)
    if kind == "row_ids":
        wanted = [str(v) for v in (getattr(sel, "rowIds", []) or [])]
        fit_set = set(fit_ids)
        return [v for v in wanted if v in fit_set]
    if kind == "respondents":
        wanted = {str(v) for v in
                  (getattr(sel, "respondentIds", []) or [])}
        return [str(r.get("rowId")) for r in rows_df.rows(named=True)
                if str(r.get("respondentId")) in wanted]
    _err("ANALYSIS_SELECTOR_UNSUPPORTED",
         "この結果では未対応のselectorです。", 422,
         details={"allowedKinds": ["respondents", "row_ids"]})


def conjoint_predict(result_id, manifest, req):
    import uuid as _uuid
    opts = getattr(req, "options", None)
    if opts is None:
        interval, evaluate = "none", True
    elif isinstance(opts, dict):
        interval, evaluate = (opts.get("interval", "none"),
                              bool(opts.get("evaluate", True)))
    else:
        interval, evaluate = (getattr(opts, "interval", "none"),
                              bool(getattr(opts, "evaluate", True)))
    if interval != "none":
        _err("ANALYSIS_REQUEST_INVALID",
             "conjoint の predict は interval=none のみ対応です。", 422)
    meta, stale, cur = _stale_state(manifest)
    if stale:
        _err("ANALYSIS_INPUT_STALE", "stale result", 409)
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH",
             "結果の所有データセットと一致しません。", 422)
    from ..domain.context import check_revisions as _check
    _check(cur, ctx.get("expectedSchemaRevision"),
           ctx.get("expectedDataRevision"))
    encoding = manifest.get("encoding") or {}
    details = manifest.get("details") or {}
    summary = manifest.get("summary") or {}
    mode = str(summary.get("mode") or encoding.get("mode"))
    dataset_id = manifest.get("ownerDatasetId")
    legacy = AnalysisContext(
        datasetId=dataset_id,
        expectedDataRevision=ctx.get("expectedDataRevision"),
        expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
        scope=ctx.get("scope"), rowIds=ctx.get("rowIds"),
        activeRowIds=ctx.get("activeRowIds"),
        selectedRowIds=ctx.get("selectedRowIds"),
        sampledRowIds=ctx.get("sampledRowIds"))
    with store.lock(dataset_id):
        codebook = store.load_codebook(dataset_id) or {}
        df_all = store.get_dataframe(dataset_id, columns=None)
    all_ids = [str(v) for v in df_all["__rowId__"].to_list()]
    from ..domain.context import resolve_scope as _scope
    scope_ids = _scope(all_ids, legacy)
    arrays = result_store.load_arrays(result_id)
    beta = np.asarray(arrays["beta"], dtype=np.float64)
    stored_maps = encoding.get("catalog") or {}
    dictionary = {"designColumns": [], "levelMaps": stored_maps,
                  "linearCenters": encoding.get("linearCenters", {}) or {},
                  "nParams": len(beta), "ascOffset": encoding.get("ascOffset")}
    attrs = encoding.get("attributes") or []
    off = 0
    for attr in attrs:
        cid = str(attr.get("columnId"))
        if str(attr.get("kind")) == "categorical":
            lm = stored_maps.get(cid, {})
            width = len((lm.get("codes") or {})) - (1 if lm.get("codes") else 0)
            if width <= 0:
                width = sum(1 for c in (details.get("coefficients") or [])
                            if c.get("termId") == f"main:{cid}")
            for pos in range(width):
                dictionary["designColumns"].append(
                    {"columnId": cid, "kind": "categorical", "position": pos,
                     "width": width, "offset": off + pos})
            off += width
        else:
            dictionary["designColumns"].append(
                {"columnId": cid, "kind": "linear", "position": 0,
                 "width": 1, "offset": off})
            off += 1
    has_asc = bool(encoding.get("hasOptOutAsc"))
    # Column-name lookup for raw predict rows. CJ-R002: fit accepts both
    # column names and columnIds; resolve by either, like the service.
    spec_by_id = {s.get("columnId"): s for s in
                  (codebook.get("columns", []) or []) if isinstance(s, dict)}
    spec_by_name = {s.get("name"): s for s in
                    (codebook.get("columns", []) or []) if isinstance(s, dict)}

    def _resolve_col(ref):
        if not ref:
            return None
        hit = spec_by_id.get(ref) or spec_by_name.get(ref)
        return hit.get("name") if hit else None

    colname = {}
    for key in ("respondentId", "taskId", "alternativeId", "response",
                "availability", "optOutIndicator"):
        colname[key] = _resolve_col((encoding.get("columns") or {}).get(key))
    for attr in attrs:
        cid = str(attr.get("columnId"))
        colname[cid] = _resolve_col(cid)
    # Raw predict records keyed by attribute columnId (not display name).
    predict_key_of = {cid: cid for cid in
                      [str(a.get("columnId")) for a in attrs]}
    for key in ("respondentId", "taskId", "alternativeId", "response",
                "availability", "optOutIndicator"):
        predict_key_of[key] = key
    id_of = {r: i for i, r in enumerate(all_ids)}
    recs = []
    for rid in scope_ids:
        i = id_of.get(rid)
        if i is None:
            continue
        row = {"__rowId__": rid}
        for ck, cn in colname.items():
            if cn and cn in df_all.columns:
                row[predict_key_of.get(ck, ck)] = df_all[cn][i]
        recs.append(row)
    # CJ-R003: task completeness against the full dataset task index.
    # The requested scope must contain every raw row of each touched task.
    full_task_of: dict[str, tuple[str, str]] = {}
    full_task_members: dict[tuple[str, str], list[str]] = {}
    for i, rid in enumerate(all_ids):
        rr = df_all[colname["respondentId"]][i] \
            if colname.get("respondentId") else None
        tt = df_all[colname["taskId"]][i] \
            if colname.get("taskId") else None
        if rr is None or tt is None:
            continue
        key = (str(rr), str(tt))
        full_task_of[rid] = key
        full_task_members.setdefault(key, []).append(rid)
    if mode in ("choice", "ranking"):
        touched = {full_task_of[r] for r in scope_ids
                   if r in full_task_of}
        partial = sorted([list(k) for k in touched
                          if any(m not in set(scope_ids)
                                 for m in full_task_members.get(k, []))])
        if partial:
            _err("CONJOINT_PARTIAL_TASK",
                 "予測はタスク全体を対象にしてください。", 422,
                 {"tasks": partial[:20]})
    # Group into tasks; every requested row is emitted (never dropped).
    by_task: dict[tuple[str, str], list[dict]] = {}
    status_of: dict[str, str] = {}
    for rec in recs:
        rr = rec.get("respondentId")
        tt = rec.get("taskId")
        if rr is None or tt is None:
            status_of[rec["__rowId__"]] = "missing"
            continue
        by_task.setdefault((str(rr), str(tt)), []).append(rec)
    pred_rows: list[dict] = []
    ok_count, fail_count = 0, 0
    status_counts: dict[str, int] = {}
    fit_overlap = 0
    fit_overlap_respondents: set[str] = set()
    fit_set = set()
    fit_respondents = set()
    try:
        fit_df = result_store.load_rows(result_id)
        fit_set = {str(v) for v in fit_df["rowId"].to_list()}
        fit_respondents = {str(v) for v in
                           fit_df["respondentId"].to_list()}
    except Exception:
        fit_set = set()
        fit_respondents = set()
    for (resp, task), members in sorted(by_task.items()):
        if mode in ("choice", "ranking"):
            # Encode all candidates; any unknown/missing fails the task.
            vecs = []
            task_ok = True
            task_status = "ok"
            for m in members:
                avail_raw = m.get("availability")
                avail = True
                if avail_raw is not None:
                    try:
                        avail = cj._parse_bool_cell(avail_raw,
                                                    allow_missing=True)
                        avail = True if avail is None else bool(avail)
                    except BizError:
                        task_ok, task_status = False, "invalid"
                        break
                if not avail:
                    vecs.append(None)
                    continue
                is_opt = bool(m.get("optOutIndicator")) and has_asc
                if is_opt:
                    v = np.zeros((len(beta),))
                    v[int(dictionary["ascOffset"])] = 1.0
                    vecs.append(v)
                    continue
                row_vals = {}
                bad = False
                for attr in attrs:
                    cid = str(attr.get("columnId"))
                    raw = m.get(cid)
                    if str(attr.get("kind")) == "linear":
                        try:
                            num = float(raw)
                            import math as _math
                            if not _math.isfinite(num):
                                raise ValueError()
                        except (TypeError, ValueError):
                            bad = True
                            break
                        row_vals[cid] = num
                    else:
                        lm = stored_maps.get(cid, {})
                        code = normalize_code(raw)
                        if code is None:
                            bad = True
                            break
                        if code not in (lm.get("codes") or {}):
                            task_ok, task_status = False, "unknown_category"
                            bad = True
                            break
                        row_vals[cid] = code
                if not task_ok:
                    break
                if bad:
                    task_ok, task_status = False, "missing"
                    break
                try:
                    v, _ = _enc.encode_row(row_vals, dictionary)
                except ValueError:
                    task_ok, task_status = False, "unknown_category"
                    break
                if has_asc:
                    full = np.zeros((len(beta),))
                    full[: len(v)] = v
                    v = full
                vecs.append(v)
            if not task_ok:
                for m in members:
                    pred_rows.append({
                        "rowId": m["__rowId__"],
                        "respondentId": resp, "taskId": task,
                        "alternativeId": m.get("alternativeId"),
                        "predictedRating": None, "probability": None,
                        "residual": None, "observed": None,
                        "predictionStatus": task_status})
                    fail_count += 1
                    status_counts[task_status] = \
                        status_counts.get(task_status, 0) + 1
                continue
            avail_idx = [i for i, (m, v) in enumerate(zip(members, vecs))
                         if v is not None]
            if len(avail_idx) < 2:
                for m in members:
                    pred_rows.append({
                        "rowId": m["__rowId__"],
                        "respondentId": resp, "taskId": task,
                        "alternativeId": m.get("alternativeId"),
                        "predictedRating": None, "probability": None,
                        "residual": None, "observed": None,
                        "predictionStatus": "unavailable"})
                    fail_count += 1
                    status_counts["unavailable"] = \
                        status_counts.get("unavailable", 0) + 1
                continue
            X = np.vstack([vecs[i] for i in avail_idx])
            vv = X @ beta
            probs = np.exp(vv - float(_logsumexp(vv)))
            # Evaluate against stored response when requested.
            obs_map = {}
            for m in members:
                y, ys = cj._parse_response(mode, m.get("response"))
                obs_map[m["__rowId__"]] = (y, ys)
            for k, i in enumerate(avail_idx):
                m = members[i]
                y, ys = obs_map[m["__rowId__"]]
                resid = None
                if evaluate and ys == "ok" and mode == "choice":
                    resid = float((1.0 if y == 1 else 0.0) - probs[k])
                pred_rows.append({
                    "rowId": m["__rowId__"], "respondentId": resp,
                    "taskId": task,
                    "alternativeId": m.get("alternativeId"),
                    "predictedRating": None,
                    "probability": float(probs[k]),
                    "residual": resid,
                    "observed": (y if evaluate and ys == "ok" else None),
                    "predictionStatus": "ok"})
                ok_count += 1
                status_counts["ok"] = status_counts.get("ok", 0) + 1
                if m["__rowId__"] in fit_set:
                    fit_overlap += 1
                # CJ-R005: respondent-level overlap alongside row counts.
                if resp in fit_respondents:
                    fit_overlap_respondents.add(resp)
            for i, m in enumerate(members):
                if i in avail_idx:
                    continue
                pred_rows.append({
                    "rowId": m["__rowId__"], "respondentId": resp,
                    "taskId": task,
                    "alternativeId": m.get("alternativeId"),
                    "predictedRating": None, "probability": None,
                    "residual": None, "observed": None,
                    "predictionStatus": "unavailable"})
                fail_count += 1
                status_counts["unavailable"] = \
                    status_counts.get("unavailable", 0) + 1
        else:
            for m in members:
                is_opt = False
                row_vals = {}
                bad_status = None
                for attr in attrs:
                    cid = str(attr.get("columnId"))
                    raw = m.get(cid)
                    if str(attr.get("kind")) == "linear":
                        try:
                            num = float(raw)
                            import math as _math
                            if not _math.isfinite(num):
                                raise ValueError()
                        except (TypeError, ValueError):
                            bad_status = "missing"
                            break
                        row_vals[cid] = num
                    else:
                        lm = stored_maps.get(cid, {})
                        code = normalize_code(raw)
                        if code is None:
                            bad_status = "missing"
                            break
                        if code not in (lm.get("codes") or {}):
                            bad_status = "unknown_category"
                            break
                        row_vals[cid] = code
                if bad_status:
                    pred_rows.append({
                        "rowId": m["__rowId__"], "respondentId": resp,
                        "taskId": task,
                        "alternativeId": m.get("alternativeId"),
                        "predictedRating": None, "probability": None,
                        "residual": None, "observed": None,
                        "predictionStatus": bad_status})
                    fail_count += 1
                    status_counts[bad_status] = \
                        status_counts.get(bad_status, 0) + 1
                    continue
                try:
                    v, _ = _enc.encode_row(row_vals, dictionary)
                except ValueError:
                    pred_rows.append({
                        "rowId": m["__rowId__"], "respondentId": resp,
                        "taskId": task,
                        "alternativeId": m.get("alternativeId"),
                        "predictedRating": None, "probability": None,
                        "residual": None, "observed": None,
                        "predictionStatus": "unknown_category"})
                    fail_count += 1
                    status_counts["unknown_category"] = \
                        status_counts.get("unknown_category", 0) + 1
                    continue
                if has_asc:
                    full = np.zeros((len(beta),))
                    full[: len(v)] = v
                    v = full
                # CJ-R004: known respondents use the fitted alpha_i,
                # new respondents the mean intercept. Pooled keeps the
                # common intercept.
                alphas = encoding.get("alphas") or {}
                rating_effects = (
                    (summary.get("ratingEffects")
                     or encoding.get("ratingEffects") or "pooled"))
                if rating_effects == "respondent_fixed" and resp in alphas:
                    pred = float(v @ beta + float(alphas[resp]))
                    assumption = "fitted_respondent_intercept"
                elif rating_effects == "respondent_fixed":
                    pred = float(v @ beta + float(
                        encoding.get("meanIntercept", 0.0) or 0.0))
                    assumption = "population_mean_intercept"
                else:
                    pred = float(v @ beta
                                 + float(encoding.get("intercept", 0.0)))
                    assumption = "pooled_intercept"
                y, ys = cj._parse_response(mode, m.get("response"))
                resid = (float(y - pred) if evaluate and ys == "ok"
                         else None)
                pred_rows.append({
                    "rowId": m["__rowId__"], "respondentId": resp,
                    "taskId": task,
                    "alternativeId": m.get("alternativeId"),
                    "predictedRating": pred, "probability": None,
                    "residual": resid,
                    "observed": (y if evaluate and ys == "ok" else None),
                    "predictionStatus": "ok",
                    "predictionAssumption": assumption})
                ok_count += 1
                status_counts["ok"] = status_counts.get("ok", 0) + 1
                if m["__rowId__"] in fit_set:
                    fit_overlap += 1
                if resp in fit_respondents:
                    fit_overlap_respondents.add(resp)
    # CJ-R002: every requested row is emitted; pending ID-missing rows
    # recorded above become explicit missing rows here.
    emitted = {p["rowId"] for p in pred_rows}
    for rec in recs:
        if rec["__rowId__"] in emitted:
            continue
        pred_rows.append({
            "rowId": rec["__rowId__"],
            "respondentId": rec.get("respondentId"),
            "taskId": rec.get("taskId"),
            "alternativeId": rec.get("alternativeId"),
            "predictedRating": None, "probability": None,
            "residual": None, "observed": None,
            "predictionStatus": status_of.get(rec["__rowId__"],
                                              "missing")})
        fail_count += 1
        st = status_of.get(rec["__rowId__"], "missing")
        status_counts[st] = status_counts.get(st, 0) + 1
    prediction_id = new_result_id()
    pdf = pl.DataFrame(pred_rows) if pred_rows else pl.DataFrame({
        "rowId": [], "respondentId": [], "taskId": [], "alternativeId": [],
        "predictedRating": [], "probability": [], "residual": [],
        "observed": [], "predictionStatus": []})
    result_store.save_prediction_rows(result_id, prediction_id, pdf)
    evaluation = None
    if evaluate:
        ok_respondents = sorted({str(p.get("respondentId"))
                                 for p in pred_rows
                                 if p.get("predictionStatus") == "ok"
                                 and p.get("respondentId") is not None})
        new_task_overlap = sorted(
            {f"{p.get('respondentId')}/{p.get('taskId')}"
             for p in pred_rows
             if p.get("predictionStatus") == "ok"
             and str(p.get("respondentId")) in fit_respondents
             and p.get("rowId") not in fit_set})
        evaluation = {"fitOverlapCount": fit_overlap,
                      "fitOverlapRespondentCount": len(
                          fit_overlap_respondents),
                      "fitOverlapRespondents": sorted(
                          fit_overlap_respondents),
                      "newTaskKnownRespondentCount": len(new_task_overlap),
                      "nonFitEvaluationCount": max(ok_count - fit_overlap, 0),
                      "note": ("学習行を含む集計をholdout精度と呼ばない。"
                               "同じ回答者の新タスクは回答者外検証と呼ばない。"),
                      "metrics": None}
    out = {"status": "success", "resultId": result_id,
           "predictionId": prediction_id,
           "summary": {"requestedCount": len(pred_rows),
                       "successfulPredictions": ok_count,
                       "failedPredictions": fail_count,
                       "statusCounts": status_counts,
                       "evaluation": evaluation},
           "meta": meta, "unavailableReasons": {}}
    check_json_finite(out)
    return out


def conjoint_materialize(result_id, manifest, req):
    import re as _re
    from ..domain.provenance import new_operation_id
    from ..services.dataset_service import now_iso

    def receipt(operation, replay):
        out = {**operation["params"]["cjResponse"],
               "operationId": operation["operationId"],
               "dataRevision": operation["outputDataRevision"],
               "schemaRevision": operation["outputSchemaRevision"],
               "idempotentReplay": replay}
        check_json_finite(out)
        return out

    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH",
             "結果の所有データセットと一致しません。", 422)
    dataset_id = manifest.get("ownerDatasetId")
    scope = ctx.get("scope", "all")
    norm: dict = {"scope": scope}
    for key in ("rowIds", "activeRowIds", "selectedRowIds", "sampledRowIds"):
        value = ctx.get(key)
        if value is not None:
            norm[key] = sorted({str(v) for v in value})
    cols = req.columns if isinstance(req.columns, list) else []
    payload_norm = {"source": req.source,
                    "columns": [{k: (c.get(k) if isinstance(c, dict)
                                     else getattr(c, k, None))
                                 for k in ("sourceField", "name", "label")}
                                for c in cols],
                    "scope": norm}
    with store.lock(dataset_id):
        # Same-key retries resolve before stale checks, even at a newer head.
        prov = store.load_provenance(dataset_id) or {}
        for op in prov.get("operations", []) or []:
            params = op.get("params") or {}
            if params.get("cjIdempotencyKey") == req.idempotencyKey and \
                    params.get("cjResultId") == result_id:
                import json as _json
                if _json.dumps(params.get("cjPayload"), sort_keys=True) == \
                        _json.dumps(payload_norm, sort_keys=True, default=str):
                    return receipt(op, True)
                _err("IDEMPOTENCY_CONFLICT",
                     "idempotencyKey が別payloadで使用済みです。", 409)
        _, stale, cur = _stale_state(manifest)
        if stale:
            _err("ANALYSIS_INPUT_STALE", "stale result", 409)
        from ..domain.context import check_revisions as _check
        _check(cur, ctx.get("expectedSchemaRevision"),
               ctx.get("expectedDataRevision"))
        caps = manifest.get("capabilities") or {}
        summary = manifest.get("summary") or {}
        mode = str(summary.get("mode") or "choice")
        allowed_by_mode = {
            "ratings": {"predicted_rating", "residual"},
            "choice": {"probability", "residual"},
            "ranking": {"probability"},
        }[mode]
        source = req.source
        if source == "fit":
            rows_df = result_store.load_rows(result_id)
            if rows_df is None:
                _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
            values = {}
            for r in rows_df.rows(named=True):
                rid = str(r.get("rowId"))
                entry = {}
                if r.get("predictedRating") is not None:
                    entry["predicted_rating"] = float(r.get("predictedRating"))
                if r.get("probability") is not None:
                    entry["probability"] = float(r.get("probability"))
                if r.get("residual") is not None:
                    entry["residual"] = float(r.get("residual"))
                values[rid] = entry
        else:
            pdf = result_store.load_prediction_rows(result_id, source)
            if pdf is None:
                _err("ANALYSIS_RESULT_NOT_FOUND",
                     "prediction が見つかりません。", 404)
            values = {}
            for r in pdf.rows(named=True):
                if str(r.get("predictionStatus") or "ok") != "ok":
                    continue
                rid = str(r.get("rowId"))
                entry = {}
                if r.get("predictedRating") is not None:
                    entry["predicted_rating"] = float(r.get("predictedRating"))
                if r.get("probability") is not None:
                    entry["probability"] = float(r.get("probability"))
                if r.get("residual") is not None:
                    entry["residual"] = float(r.get("residual"))
                values[rid] = entry
        # Method-gated fields: reject unprovided sourceFields per capabilities.
        for c in cols:
            src = c.get("sourceField") if isinstance(c, dict) \
                else getattr(c, "sourceField", None)
            if src not in allowed_by_mode:
                _err("ANALYSIS_REQUEST_INVALID",
                     f"この mode では保存できません: {src}", 422)
        # Resolve scope and append columns under the same write lock.
        from ..domain.context import resolve_scope as _scope
        # Write derived columns atomically via dataset store.
        new_cols = []
        for c in cols:
            src = c.get("sourceField") if isinstance(c, dict) \
                else getattr(c, "sourceField", None)
            name = c.get("name") if isinstance(c, dict) \
                else getattr(c, "name", None)
            label = (c.get("label") if isinstance(c, dict)
                     else getattr(c, "label", "")) or ""
            if not name or not isinstance(name, str):
                _err("ANALYSIS_REQUEST_INVALID", "列名が不正です。", 422)
            if _re.fullmatch(r"\s*", name):
                _err("ANALYSIS_REQUEST_INVALID", "列名が不正です。", 422)
            new_cols.append({"sourceField": src, "name": name,
                             "label": label})
        created = []
        written_rows = 0
        df_ids = store.get_dataframe(dataset_id, columns=["__rowId__"])
        all_ids = [str(v) for v in df_ids["__rowId__"].to_list()]
        legacy = AnalysisContext(
            datasetId=dataset_id,
            expectedDataRevision=ctx.get("expectedDataRevision"),
            expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
            scope=scope, rowIds=ctx.get("rowIds"),
            activeRowIds=ctx.get("activeRowIds"),
            selectedRowIds=ctx.get("selectedRowIds"),
            sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = set(_scope(all_ids, legacy))
        df = store.get_dataframe(dataset_id, columns=None)
        codebook = store.load_codebook(dataset_id) or {}
        existing = {s.get("name") for s in
                    (codebook.get("columns", []) or [])
                    if isinstance(s, dict)}
        existing.update(df.columns)
        for nc in new_cols:
            if nc["name"] in existing:
                _err("COLUMN_ALREADY_EXISTS", "列名が既存です。", 409)
            existing.add(nc["name"])
        id_list = [str(v) for v in df["__rowId__"].to_list()]
        for nc in new_cols:
            src = nc["sourceField"]
            col_vals = []
            for rid in id_list:
                if rid in scope_ids and rid in values \
                        and src in values[rid]:
                    col_vals.append(values[rid][src])
                    if values[rid][src] is not None:
                        pass
                else:
                    col_vals.append(None)
            non_null = sum(1 for v in col_vals if v is not None)
            written_rows = max(written_rows, non_null)
            df = df.with_columns(pl.Series(nc["name"], col_vals))
            created.append({"columnId": nc["name"], "name": nc["name"],
                            "label": nc["label"], "sourceField": src,
                            "nonNullCount": non_null})
        # Assemble the complete schema before publishing the structural change.
        meta_now = store.get_meta(dataset_id)
        cb = store.load_codebook(dataset_id) or {}
        cols_spec = cb.get("columns", []) or []
        for nc in new_cols:
            cols_spec.append({"columnId": nc["name"], "name": nc["name"],
                              "label": nc["label"] or nc["name"],
                              "scaleType": "interval", "role": "other",
                              "derived": True})
        cb["columns"] = cols_spec
        schema = list(meta_now.get("schema", []) or [])
        for nc in new_cols:
            schema.append({"columnId": nc["name"], "name": nc["name"],
                           "semanticType": "numeric"})
        meta_now["schema"] = schema
        cb["schemaRevision"] = cur["schemaRevision"] + 1
        meta_now["schemaRevision"] = cb["schemaRevision"]
        meta_now["columnCount"] = df.width - 1
        receipt_facts = {"status": "success", "resultId": result_id,
                         "source": source, "datasetId": dataset_id,
                         "createdColumns": created,
                         "writtenRowCount": int(written_rows)}
        check_json_finite(receipt_facts)
        step = {"operationId": new_operation_id(),
                "parentOperationId": prov.get("currentOperationId"),
                "operation": "calculate",
                "params": {"resultId": result_id,
                           "cjIdempotencyKey": req.idempotencyKey,
                           "cjResultId": result_id,
                           "cjPayload": payload_norm,
                           "cjResponse": receipt_facts},
                "targetRowIds": sorted(scope_ids), "targetCells": [],
                "inputSchemaRevision": cur["schemaRevision"],
                "outputSchemaRevision": int(cb.get("schemaRevision")
                                             or meta_now.get("schemaRevision")
                                             or 1),
                "algorithmVersion": ALGORITHM_VERSION,
                "timestamp": now_iso(), "createdBy": "local-session"}
        committed = store.commit_data_change(
            dataset_id, meta_now, df, codebook=cb, step=step)
        return receipt(committed["provenance"]["operations"][-1], False)


def conjoint_export_table(manifest, meta, result_id, req):
    import csv as _csv
    import io as _io
    import json as _json
    table = req.table
    fmt = req.format
    limit = int(req.limit)
    offset = int(req.offset)
    if table == "manifest":
        body = {"resultId": result_id, "method": manifest.get("method"),
                "meta": meta, "config": manifest.get("config"),
                "capabilities": manifest.get("capabilities")}
        out = {"status": "success", "mime": "application/json",
               "fileName": f"{result_id}-manifest.json",
               "encoding": "utf-8",
               "payload": _json.dumps(body, ensure_ascii=False,
                                      allow_nan=False),
               "offset": 0, "total": 1, "nextOffset": None,
               "hasHeader": False,
               "snapshot": {"datasetId": meta.get("datasetId"),
                            "dataRevision": meta.get("dataRevision"),
                            "schemaRevision": meta.get("schemaRevision"),
                            "resultId": result_id}}
        check_json_finite(out)
        return out
    if table == "coefficients":
        details = manifest.get("details") or {}
        header = ["designColumnId", "termId", "label", "estimate",
                  "standardError", "statistic", "pValue", "ciLower",
                  "ciUpper"]
        rows_all = [[c.get("designColumnId"), c.get("termId"),
                     c.get("label"), c.get("estimate"),
                     c.get("standardError"), c.get("statistic"),
                     c.get("pValue"), c.get("ciLower"), c.get("ciUpper")]
                    for c in details.get("coefficients") or []]
    elif table == "utilities":
        details = manifest.get("details") or {}
        header = ["attributeId", "levelCode", "label", "utility",
                  "standardError", "ciLower", "ciUpper", "referenceLevel"]
        rows_all = [[u.get("attributeId"), u.get("levelCode"),
                     u.get("label"), u.get("utility"),
                     u.get("standardError"), u.get("ciLower"),
                     u.get("ciUpper"), u.get("referenceLevel")]
                    for u in details.get("levelUtilities") or []]
    elif table in ("diagnostics", "rows"):
        rows_df = result_store.load_rows(result_id)
        if rows_df is None:
            _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
        if table == "diagnostics":
            # G007-04/G008-04: 実際のタスク／ステージ診断を返す。details の
            # 索引（total/subtables）と実体を一致させる。診断0件は空表と
            # 理由を返し、通常行を診断として返さない。
            details = manifest.get("details") or {}
            task_diag = details.get("taskDiagnostics") or {}
            diag_rows = details.get("diagnosticRows") or []
            header = ["kind", "respondentId", "taskId", "stageIndex",
                      "rowId", "chosenRowId", "setSize",
                      "logLikelihood", "chosenProbability",
                      "intercept", "value", "note"]
            rows_all = [[d.get("kind"), d.get("respondentId"),
                         d.get("taskId"), d.get("stageIndex"),
                         d.get("rowId"), d.get("chosenRowId"),
                         d.get("setSize"), d.get("logLikelihood"),
                         d.get("chosenProbability"),
                         d.get("intercept"), d.get("value"), None]
                        for d in diag_rows]
            if not rows_all:
                subtables = task_diag.get("subtables") or []
                note = ("診断はありません"
                        + ("（対象: "
                           + "/".join(subtables) + "）" if subtables
                           else "（このモデルに診断はありません）"))
                rows_all = [[None, None, None, None,
                             None, None, None, None, None, None, None,
                             note]]
        else:
            header = ["rowId", "respondentId", "taskId", "alternativeId",
                      "observed", "predictedRating", "probability",
                      "residual", "predictionStatus"]
            rows_all = [[str(r.get("rowId")),
                         str(r.get("respondentId")), str(r.get("taskId")),
                         str(r.get("alternativeId")), r.get("observed"),
                         r.get("predictedRating"), r.get("probability"),
                         r.get("residual"),
                         str(r.get("predictionStatus") or "ok")]
                        for r in rows_df.rows(named=True)]
    else:
        _err("ANALYSIS_EXPORT_UNSUPPORTED", "bad table", 422)
    total = len(rows_all)
    part = rows_all[offset:offset + limit]
    if fmt == "json":
        payload = _json.dumps({"columns": header, "rows": part},
                              ensure_ascii=False, allow_nan=False)
        mime = "application/json"
    else:
        buf = _io.StringIO()
        w = _csv.writer(buf, lineterminator="\n")
        w.writerow(header)
        for row in part:
            w.writerow([("" if v is None else v) for v in row])
        payload = buf.getvalue()
        mime = "text/csv"
    nxt = offset + len(part) if offset + len(part) < total else None
    out = {"status": "success", "mime": mime,
           "fileName": f"{result_id}-{table}.{fmt}",
           "encoding": "utf-8", "payload": payload, "offset": offset,
           "total": total, "nextOffset": nxt, "hasHeader": fmt == "csv",
           "snapshot": {"datasetId": meta.get("datasetId"),
                        "dataRevision": meta.get("dataRevision"),
                        "schemaRevision": meta.get("schemaRevision"),
                        "resultId": result_id}}
    check_json_finite(out)
    return out


def conjoint_prediction_rows(result_id, manifest, meta, prediction_id,
                             offset, limit, axes):
    if axes is not None:
        _err("ANALYSIS_REQUEST_INVALID",
             "conjoint は axes を受け付けません。", 422)
    try:
        offset = int(offset)
        limit = int(limit)
    except (TypeError, ValueError):
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    if offset < 0 or limit < 1 or limit > 10000:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    pdf = result_store.load_prediction_rows(result_id, prediction_id)
    if pdf is None:
        _err("ANALYSIS_RESULT_NOT_FOUND", "prediction が見つかりません。",
             404)
    total = int(pdf.height)
    if offset >= total:
        out = {"status": "success", "resultId": result_id,
               "predictionId": prediction_id, "offset": offset,
               "limit": limit, "total": total, "nextOffset": None,
               "axes": None, "rows": [],
               "meta": {"dataRevision": meta.get("dataRevision"),
                        "schemaRevision": meta.get("schemaRevision"),
                        "resultState": meta.get("resultState")}}
        check_json_finite(out)
        return out
    part = pdf.slice(offset, limit)
    rows = []
    for rec in part.rows(named=True):
        rows.append({
            "rowId": str(rec.get("rowId")),
            "respondentId": rec.get("respondentId"),
            "taskId": rec.get("taskId"),
            "alternativeId": rec.get("alternativeId"),
            "predictedRating": rec.get("predictedRating"),
            "probability": rec.get("probability"),
            "residual": rec.get("residual"),
            "observed": rec.get("observed"),
            "predictionStatus": str(rec.get("predictionStatus") or "ok"),
        })
    nxt = offset + len(rows) if offset + len(rows) < total else None
    out = {"status": "success", "resultId": result_id,
           "predictionId": prediction_id, "offset": offset,
           "limit": limit, "total": total, "nextOffset": nxt,
           "axes": None, "rows": rows,
           "meta": {"dataRevision": meta.get("dataRevision"),
                    "schemaRevision": meta.get("schemaRevision"),
                    "resultState": meta.get("resultState")}}
    check_json_finite(out)
    return out


CJ_FIT_FIELDS = {"predicted_rating", "probability", "residual"}
CJ_FIRST_PROB_COL = "CJ_FirstChoiceProbability"


@router.post("/models/conjoint")
def run_conjoint(payload: dict = Body(...)):
    req = _parse_conjoint(payload)
    ctx = req.context.model_dump()
    started = time.perf_counter()
    attributes = [a.model_dump() for a in req.attributes]
    columns = req.columns.model_dump()
    try:
        frame = cj.prepare_conjoint_frame(
            dataset_id=ctx["datasetId"], context_dict=ctx,
            mode=str(req.mode), columns=columns,
            attributes=attributes, store=store)
    except BizError:
        raise
    from ..services import conjoint_run as _run
    try:
        est = _run.run_conjoint_estimation(
            frame=frame, req=req, ctx=ctx, store=store,
            max_iterations=int(req.maxIterations),
            confidence_level=float(req.confidenceLevel))
    except BizError:
        raise
    request_json = json.loads(req.model_dump_json())
    effective_config = dict(request_json)
    effective_config["method"] = "conjoint"
    fingerprint = model_fingerprint({
        "datasetId": ctx["datasetId"],
        "dataRevision": frame["revisions"]["dataRevision"],
        "schemaRevision": frame["revisions"]["schemaRevision"],
        "scopeHash": scope_hash(frame["scopeIds"]),
        "fitRowIdsHash": scope_hash(est["fitRowIds"]),
        "effectiveConfig": effective_config,
        "catalog": est["dictionary"].get("levelMaps", {}).get("__keys__", None) or {
            cid: lm.get("levels") for cid, lm in
            (est["dictionary"].get("levelMaps") or {}).items()
            if isinstance(lm, dict)},
        "resolvedWeight": {"applied": frame["weightApplied"],
                           "type": frame["weightType"], "column": None},
        "algorithmVersion": ALGORITHM_VERSION,
    })
    scope_count = len(frame["scopeIds"])
    fit_count = len(est["fitRowIds"])
    weight_applied = bool(frame["weightApplied"])
    weight_type = est.get("weightType")
    sum_w = None
    kish = None
    if weight_applied and weight_type == "frequency":
        sum_w = float(sum(float(v) for v in est["respondentWeight"].values()))
        kish = float(len(est["respondentIds"]))
    elif weight_applied:
        rw = [float(est["respondentWeight"].get(r, 0.0))
              for r in est["respondentIds"]]
        sum_w = float(sum(rw))
        den = float(sum(v * v for v in rw))
        kish = (sum_w * sum_w / den) if den > 0 else None
    else:
        kish = float(len(est["respondentIds"]))
    freq_n = (est["summary"].get("frequencyRespondentN")
              if weight_type == "frequency" else None)
    meta = build_meta(
        dataset_id=ctx["datasetId"], revisions=frame["revisions"],
        snapshot_fingerprint=None, scope=ctx.get("scope", "all"),
        scope_ids=[str(v) for v in frame["scopeIds"]],
        fit_count=fit_count,
        exclusion_counts=dict(est["exclusionCounts"]),
        analysis_unit="profile_row",
        weight_applied=weight_applied, weight_type=weight_type,
        weight_column=None, sum_weights=sum_w,
        kish_effective_n=kish, frequency_n=freq_n,
        mask_revision=None, fingerprint=fingerprint,
        algorithm_version=ALGORITHM_VERSION,
        warnings=list(est["warnings"]))
    meta["scopeCount"] = scope_count
    result_id = new_result_id()
    mode = str(req.mode)
    if mode == "ratings":
        fit_fields = ["predicted_rating", "residual"]
        pred_fields = ["predicted_rating", "residual"]
    elif mode == "choice":
        fit_fields = ["probability", "residual"]
        pred_fields = ["probability", "residual"]
    else:
        fit_fields = ["probability"]
        pred_fields = ["probability"]
    capabilities = {
        "rows": True, "projection": True, "materialize": True,
        "selectionKinds": ["row_ids", "respondents"],
        "exportTables": ["manifest", "coefficients", "diagnostics",
                         "rows", "utilities"],
        "materializeFitFields": fit_fields,
        "materializePredictionFields": pred_fields,
        "predictionIntervals": ["none"], "simulation": True,
    }
    encoding = {
        "mode": mode, "attributes": attributes, "columns": columns,
        "ratingEffects": str(req.ratingEffects),
        "priceAttribute": req.priceAttribute,
        "confidenceLevel": float(req.confidenceLevel),
        "designColumns": est["details"]["designColumns"],
        "linearCenters": est["dictionary"].get("linearCenters", {}),
        "linearRanges": est["dictionary"].get("linearRanges", {}),
        "referenceLevels": est["details"]["encoding"]["referenceLevels"],
        "catalog": est["dictionary"].get("levelMaps", {}),
        "hasOptOutAsc": bool(columns.get("optOutIndicator")),
        "meanIntercept": est["meanIntercept"],
        "intercept": float(est["intercept"]),
        "alphas": dict(est["alphas"]),
        "ascOffset": est["dictionary"].get("ascOffset"),
        "missingPolicy": "exclude",
    }
    manifest = {"schemaVersion": SCHEMA_VERSION, "resultId": result_id,
                "method": "conjoint", "ownerDatasetId": ctx["datasetId"],
                "config": effective_config, "meta": meta,
                "capabilities": capabilities, "summary": est["summary"],
                "details": est["details"], "encoding": encoding,
                "summaryKeys": list(est["summary"].keys()),
                "unavailableReasons": est["unavailable"]}
    beta = np.asarray(est["beta"], dtype=np.float64)
    cov = (np.asarray(est["covariance"], dtype=np.float64)
           if est["covariance"] is not None else np.zeros((len(beta), len(beta))))
    arrays = {"beta": beta, "bread": np.zeros_like(cov), "cov": cov,
              "hasCov": np.array([est["covariance"] is not None])}
    rows_df = pl.DataFrame(est["rowRecords"]) if est["rowRecords"] else pl.DataFrame({
        "rowId": [], "respondentId": [], "taskId": [], "alternativeId": [],
        "observed": [], "predictedRating": [], "probability": [],
        "residual": [], "predictionStatus": []})
    excl_df = pl.DataFrame([
        {"rowId": rid, "reason": why}
        for rid, why in sorted(
            {r["rowId"]: "fit" for r in frame["rows"] if
             r["rowId"] in set(est["fitRowIds"])}.items())]
    ) if est["fitRowIds"] else None
    manifest["meta"]["numericalRuntimeSeconds"] = float(
        time.perf_counter() - started)
    with store.lock(ctx["datasetId"]):
        cur_meta = store.get_meta(ctx["datasetId"])
        cur_code = store.load_codebook(ctx["datasetId"]) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
        base_rev = frame["revisions"]
        if (cur_rev["dataRevision"] != base_rev["dataRevision"]
                or cur_rev["schemaRevision"] != base_rev["schemaRevision"]):
            raise BizError("ANALYSIS_INPUT_STALE",
                           "計算中にデータが更新されました。再実行してください。",
                           status_code=409)
        result_store.save_result(result_id, manifest, arrays,
                                 members=None, exclusions=excl_df,
                                 rows=rows_df)
    out = {"status": "success", "resultId": result_id,
           "method": "conjoint", "meta": meta,
           "config": effective_config, "capabilities": capabilities,
           "summary": est["summary"], "details": est["details"],
           "unavailableReasons": est["unavailable"]}
    check_json_finite(out)
    return out


@router.post("/models/conjoint/expand-scope")
def expand_conjoint_scope(payload: dict = Body(...)):
    try:
        req = ConjointExpandScopeRequest.model_validate(payload)
    except ValidationError as exc:
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422,
             {"errors": [e.get("msg", "") for e in exc.errors()][:10]})
    ctx = req.context.model_dump()
    columns = req.columns.model_dump()
    id_names: dict[str, str] = {}
    with store.lock(ctx["datasetId"]):
        meta = store.get_meta(ctx["datasetId"])
        codebook = store.load_codebook(ctx["datasetId"]) or {}
        rev = collect_revisions(meta, codebook)
        from ..domain.context import check_revisions as _check
        _check(rev, ctx.get("expectedSchemaRevision"),
               ctx.get("expectedDataRevision"))

        def _nm(ref):
            if not ref:
                return None
            for spec in (codebook.get("columns", []) or []):
                if isinstance(spec, dict) and (
                        spec.get("columnId") == ref
                        or spec.get("name") == ref):
                    return spec.get("name")
            return None

        for key in ("respondentId", "taskId", "alternativeId"):
            nm = _nm(columns.get(key))
            if nm is None:
                _err("CONJOINT_COLUMN_UNRESOLVED",
                     f"列を解決できません: {columns.get(key)}", 422)
            id_names[key] = nm
        df = store.get_dataframe(ctx["datasetId"],
                                 columns=["__rowId__", id_names["respondentId"],
                                          id_names["taskId"],
                                          id_names["alternativeId"]])
    all_ids = [str(v) for v in df["__rowId__"].to_list()]
    resp_col = df[id_names["respondentId"]].to_list()
    task_col = df[id_names["taskId"]].to_list()
    alt_col = df[id_names["alternativeId"]].to_list()
    # ID validation on the full dataset.
    seen_alt: set[tuple[str, str, str]] = set()
    for i, rid in enumerate(all_ids):
        rr, tt, aa = resp_col[i], task_col[i], alt_col[i]
        if rr is None or tt is None or aa is None or str(rr) == "" \
                or str(tt) == "" or str(aa) == "":
            _err("CONJOINT_INVALID_ID", "ID列に欠損があります。", 422,
                 {"rowIds": [rid]})
        key = (str(rr), str(tt), str(aa))
        if key in seen_alt:
            _err("CONJOINT_DUPLICATE_ALTERNATIVE",
                 "タスク内で alternativeId が重複しています。", 422)
        seen_alt.add(key)
    task_of: dict[str, tuple[str, str]] = {}
    members: dict[tuple[str, str], list[str]] = {}
    for i, rid in enumerate(all_ids):
        key = (str(resp_col[i]), str(task_col[i]))
        task_of[rid] = key
        members.setdefault(key, []).append(rid)
    legacy = AnalysisContext(
        datasetId=ctx["datasetId"],
        expectedDataRevision=ctx.get("expectedDataRevision"),
        expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
        scope=ctx.get("scope"), rowIds=ctx.get("rowIds"),
        activeRowIds=ctx.get("activeRowIds"),
        selectedRowIds=ctx.get("selectedRowIds"),
        sampledRowIds=ctx.get("sampledRowIds"))
    from ..domain.context import resolve_scope as _scope
    scope_ids = _scope(all_ids, legacy)
    if not scope_ids:
        out = {"status": "success", "datasetId": ctx["datasetId"],
               "dataRevision": rev["dataRevision"],
               "schemaRevision": rev["schemaRevision"],
               "originalRowCount": 0, "expandedRowCount": 0,
               "addedRowCount": 0, "expandedRowIds": [],
               "scopeHash": scope_hash([])}
        check_json_finite(out)
        return out
    touched = {task_of[r] for r in scope_ids if r in task_of}
    expanded: list[str] = []
    seen: set[str] = set()
    for rid in all_ids:  # stored order, deduplicated
        if task_of.get(rid) in touched and rid not in seen:
            seen.add(rid)
            expanded.append(rid)
    original = len(set(scope_ids))
    out = {"status": "success", "datasetId": ctx["datasetId"],
           "dataRevision": rev["dataRevision"],
           "schemaRevision": rev["schemaRevision"],
           "originalRowCount": original,
           "expandedRowCount": len(expanded),
           "addedRowCount": len(expanded) - original,
           "expandedRowIds": expanded,
           "scopeHash": scope_hash(expanded)}
    check_json_finite(out)
    return out


@router.post("/models/conjoint/{result_id}/simulate")
def simulate_conjoint(result_id: str, payload: dict = Body(...)):
    try:
        req = SimulateRequest.model_validate(payload)
    except ValidationError as exc:
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422,
             {"errors": [e.get("msg", "") for e in exc.errors()][:10]})
    ctx = req.context.model_dump()
    manifest = result_store.load_manifest(result_id)
    if manifest.get("method") != "conjoint":
        _err("ANALYSIS_OPERATION_UNSUPPORTED",
             "conjoint 結果ではありません。", 422)
    meta, stale, cur = _stale_state(manifest)
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH",
             "結果の所有データセットと一致しません。", 422)
    from ..domain.context import check_revisions as _check
    _check(cur, ctx.get("expectedSchemaRevision"),
           ctx.get("expectedDataRevision"))
    encoding = manifest.get("encoding") or {}
    details = manifest.get("details") or {}
    summary = manifest.get("summary") or {}
    mode = str((summary.get("mode") or encoding.get("mode") or "choice"))
    arrays = result_store.load_arrays(result_id)
    beta = np.asarray(arrays["beta"], dtype=np.float64)
    cov = None
    try:
        has_cov = bool(np.asarray(arrays.get("hasCov", [False])).ravel()[0])
    except Exception:
        has_cov = False
    if has_cov:
        cov = np.asarray(arrays.get("cov"), dtype=np.float64)
    intercept = float(encoding.get("intercept", 0.0))
    level_maps = encoding.get("catalog") or {}
    # Rebuild a minimal dictionary for profile encoding.
    dictionary = {"designColumns": [],
                  "levelMaps": {}, "linearCenters": {},
                  "nParams": len(beta), "ascOffset": encoding.get("ascOffset")}
    # Recover design column layout from details designColumns order:
    # categorical effect blocks (K-1 each) then linear then ASC.
    coeffs = details.get("coefficients") or []
    offset = 0
    # NOTE: dictionary rebuilt structurally from stored encoding below.
    stored_maps = encoding.get("catalog") or {}
    dictionary["levelMaps"] = stored_maps
    dictionary["linearCenters"] = encoding.get("linearCenters", {}) or {}
    # Reconstruct designColumns with offsets from details order.
    dictionary["designColumns"] = []
    # Simplest robust path: re-derive offsets from encoding attributes.
    attrs = encoding.get("attributes") or []
    off = 0
    for attr in attrs:
        cid = str(attr.get("columnId"))
        if str(attr.get("kind")) == "categorical":
            lm = stored_maps.get(cid, {})
            non_ref = [lv for lv in (lm.get("levels") or [])
                       if lv != lm.get("referenceLevel")]
            # Stored levelMaps use 'codes'; rebuild nonRef list.
            codes = lm.get("codes", {})
            non_ref = [lv for lv in (lm.get("levels") or [])
                       if lv != lm.get("referenceLevel")]
            width = max(len(non_ref), len(codes) - (1 if codes else 0))
            if width <= 0:
                # Fall back to coefficient count for this attribute.
                width = sum(1 for c in coeffs
                            if c.get("termId") == f"main:{cid}")
            for pos in range(width):
                dictionary["designColumns"].append(
                    {"columnId": cid, "kind": "categorical",
                     "position": pos, "width": width, "offset": off + pos})
            off += width
        else:
            dictionary["designColumns"].append(
                {"columnId": cid, "kind": "linear", "position": 0,
                 "width": 1, "offset": off})
            off += 1
    if encoding.get("hasOptOutAsc"):
        dictionary["ascOffset"] = off
    profiles_in = [p.model_dump() for p in req.profiles]
    if mode in ("choice", "ranking") and len(profiles_in) < 2:
        _err("CONJOINT_SIMULATE_TOO_FEW",
             "choice/ranking のシミュレーションは2件以上必要です。", 422)
    has_asc = bool(encoding.get("hasOptOutAsc"))
    enc_profiles: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    for prof in profiles_in:
        alt = str(prof["alternativeId"])
        is_opt = bool(prof.get("optOut"))
        vals = dict(prof.get("values") or {})
        if is_opt:
            if vals:
                _err("ANALYSIS_REQUEST_INVALID",
                     "opt-out プロフィールは values={} としてください。", 422)
            if not has_asc:
                _err("CONJOINT_SIMULATE_OPTOUT_UNSUPPORTED",
                     "学習モデルに opt-out ASC がありません。", 422)
            vec = np.zeros((len(beta),))
            vec[int(dictionary["ascOffset"])] = 1.0
            enc_profiles.append({"alternativeId": alt, "x": vec})
            continue
        # Regular profile: all attribute keys, no extras.
        attr_keys = {str(a.get("columnId")) for a in attrs}
        if set(vals.keys()) != attr_keys:
            _err("CONJOINT_SIMULATE_UNKNOWN_ATTRIBUTE",
                 "プロフィールは全属性キーのみ指定してください。", 422,
                 {"alternativeIds": [alt]})
        row_vals: dict[str, Any] = {}
        for attr in attrs:
            cid = str(attr.get("columnId"))
            raw = vals[cid]
            if str(attr.get("kind")) == "linear":
                if isinstance(raw, bool):
                    _err("CONJOINT_SIMULATE_INVALID_VALUE",
                         "数値が不正です。", 422)
                try:
                    num = float(raw)
                except (TypeError, ValueError):
                    _err("CONJOINT_SIMULATE_INVALID_VALUE",
                         "数値が不正です。", 422)
                import math as _math
                if not _math.isfinite(num):
                    _err("CONJOINT_SIMULATE_INVALID_VALUE",
                         "数値が不正です。", 422)
                row_vals[cid] = num
                # Extrapolation warning vs stored fit range.
                rg = (encoding.get("linearRanges") or {}).get(cid, {})
                if rg and (num < float(rg.get("fitMin", num))
                           or num > float(rg.get("fitMax", num))):
                    warnings.append({"code": "CONJOINT_SIMULATE_EXTRAPOLATION",
                                     "message": "学習範囲外の値です。",
                                     "count": 1, "columnIds": [cid]})
            else:
                lm = stored_maps.get(cid, {})
                code = normalize_code(raw)
                if code is None or code not in (lm.get("codes") or {}):
                    _err("CONJOINT_SIMULATE_UNKNOWN_LEVEL",
                         "未知/未観測水準です。", 422,
                         {"alternativeIds": [alt]})
                row_vals[cid] = code
        try:
            vec, _ = _enc.encode_row(row_vals, dictionary)
        except ValueError:
            _err("CONJOINT_SIMULATE_UNKNOWN_LEVEL",
                 "未知/未観測水準です。", 422)
        if has_asc:
            full = np.zeros((len(beta),))
            full[: len(vec)] = vec
            vec = full
        enc_profiles.append({"alternativeId": alt, "x": vec})
    rows = _sim.simulate_set(mode=mode, beta=beta, intercept=intercept,
                             profiles=enc_profiles)
    # Importance from stored utilityRange (fixed; not recomputed on profiles).
    importance = details.get("attributeImportance")
    wtp = None
    if req.includeWtp:
        wtp = details.get("wtp")
    out = {"status": "success", "resultId": result_id, "profiles": rows,
           "attributeImportance": importance, "wtp": wtp,
           "warnings": warnings}
    check_json_finite(out)
    return out
