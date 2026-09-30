"""Multiple linear regression API (Feature 032, production)."""
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

from ..algorithms.models.linear_regression import (
    solve_weighted_least_squares,
    classical_covariance,
    hc3_covariance,
    fit_statistics,
    gaussian_loglik_aic_bic,
    t_inference,
    joint_wald_test,
    standardized_effects,
    non_survey_diagnostics,
    survey_leverage,
    weighted_vif,
    qq_positions,
)
from ..algorithms.survey.model_covariance import (
    build_regression_design_frame,
    taylor_model_covariance,
)
from ..domain.analysis_contracts import LinearRegressionRequest
from ..domain.analysis_frame import prepare_regression_frame
from ..domain.codebook_adapter import normalize_code
from ..domain.context import check_revisions, collect_revisions
from ..domain.errors import BizError
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
ALGORITHM_VERSION = "davis.linear_regression.1.0.0"
SCHEMA_VERSION = "analysis-result/1.0"


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _parse_request(payload):
    try:
        return LinearRegressionRequest.model_validate(payload)
    except ValidationError:
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422)


def _design_column_id(term_id, descriptors):
    canon = json.dumps([term_id, descriptors], ensure_ascii=False,
                       separators=(",", ":"), allow_nan=False)
    return "design:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _category_id(column_id, kind, code):
    canon = json.dumps([column_id, kind, code], ensure_ascii=False,
                       separators=(",", ":"), allow_nan=False)
    return "cat:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _resolve_covariance(requested, weight_type, weight_applied):
    if requested == "auto":
        if weight_applied and weight_type == "survey":
            return "taylor"
        return "hc3"
    if requested == "classical" and weight_applied and weight_type == "survey":
        _err("LR_COVARIANCE_WEIGHT_CONFLICT",
             "classical は survey 重みと併用できません。", 422)
    if requested == "hc3" and weight_applied and weight_type == "survey":
        _err("LR_COVARIANCE_WEIGHT_CONFLICT",
             "hc3 は survey 重みと併用できません。", 422)
    if requested == "taylor" and (not weight_applied or weight_type != "survey"):
        _err("LR_COVARIANCE_WEIGHT_CONFLICT",
             "taylor は survey 重みが必要です。", 422)
    return requested


def _pred_order_ids(predictor_specs):
    return [str(p.get("columnId")) for p in predictor_specs]


def _build_design_matrix(frame, predictor_specs, interactions, references, omitted_out):
    n = len(frame.row_ids)
    name_by_id = {}
    for nm, vid in {**frame.numeric_ids, **frame.category_ids}.items():
        name_by_id[str(vid)] = nm
    ordered = []
    for pref in predictor_specs:
        cid = str(pref.get("columnId"))
        nm = name_by_id.get(cid)
        if nm is None:
            _err("LR_SCALE_INVALID", "列を解決できません: " + cid, 422)
        ordered.append((pref, nm, cid))
    columns = []
    terms = []
    col_ids = []
    labels = []
    numeric_main_pos = {}
    cat_ref_solutions = {}
    for pref, nm, cid in ordered:
        if pref.get("kind") == "numeric":
            spec = frame.numeric_specs[nm]
            label = spec.get("label") or nm
            ordinal = frame.numeric_ordinal.get(nm)
            vals = [float(v) for v in frame.numeric_inputs[nm]]
            term_id = "main:" + cid
            desc = [{"columnId": cid,
                     "coding": "ordered_rank" if ordinal is not None else "identity"}]
            did = _design_column_id(term_id, desc)
            pos = len(columns)
            columns.append(np.asarray(vals, dtype=np.float64))
            terms.append({"termId": term_id, "kind": "numeric_main",
                          "columnId": cid, "label": label})
            col_ids.append(did)
            if ordinal is not None:
                labels.append(label + "（順序得点・等間隔仮定）")
            else:
                labels.append(label)
            numeric_main_pos[pos] = True
        else:
            spec = frame.category_specs[nm]
            label = spec.get("label") or nm
            catalog = frame.catalogs[nm]
            fit_vals = [frame.category_inputs[nm][i] for i in range(n)]
            declared_values = [c for c in catalog.order
                               if catalog.kind_by_code.get(c) == "value"]
            for c in declared_values:
                if c not in fit_vals:
                    omitted_out.append({"variableId": cid, "code": c,
                                        "kind": "value", "reason": "unobserved"})
            observed_values = sorted({v for v in fit_vals
                                      if catalog.kind_by_code.get(v) == "value"})
            if not observed_values:
                _err("LR_NO_REFERENCE_CATEGORY",
                     "基準にできる通常水準がありません: " + label, 422,
                     details={"columnIds": [cid]})
            requested_ref = references.get(cid)
            ref_code = None
            if requested_ref is not None:
                norm_ref = normalize_code(requested_ref)
                if norm_ref not in observed_values:
                    _err("LR_REFERENCE_UNOBSERVED",
                         "指定基準が学習行にありません: " + label, 422,
                         details={"columnIds": [cid]})
                ref_code = norm_ref
            else:
                for c in catalog.order:
                    if c in observed_values:
                        ref_code = c
                        break
                if ref_code is None:
                    ref_code = observed_values[0]
            cat_ref_solutions[cid] = {"reference": ref_code,
                                      "observed": observed_values,
                                      "variableLabel": label}
            for level in catalog.order:
                if level == ref_code:
                    continue
                if catalog.kind_by_code.get(level) != "value":
                    continue
                if level not in observed_values:
                    continue
                col = np.array([1.0 if frame.category_inputs[nm][i] == level
                                else 0.0 for i in range(n)])
                term_id = "main:" + cid
                did = _design_column_id(term_id, [{"columnId": cid,
                                                   "coding": "treatment",
                                                   "level": level,
                                                   "reference": ref_code}])
                pos = len(columns)
                columns.append(col)
                terms.append({"termId": term_id, "kind": "dummy",
                              "columnId": cid, "level": level,
                              "reference": ref_code,
                              "label": label + "=" + str(catalog.labels.get(level, level))})
                col_ids.append(did)
                labels.append(label + "=" + str(catalog.labels.get(level, level)) +
                              "（基準: " + str(catalog.labels.get(ref_code, ref_code)) + "）")
                numeric_main_pos[pos] = False
            for sentinel in catalog.order:
                if catalog.kind_by_code.get(sentinel) not in ("missing", "not_applicable"):
                    continue
                if sentinel not in fit_vals:
                    continue
                col = np.array([1.0 if frame.category_inputs[nm][i] == sentinel
                                else 0.0 for i in range(n)])
                term_id = "main:" + cid
                did = _design_column_id(term_id, [{"columnId": cid,
                                                   "coding": "missing_indicator",
                                                   "level": str(sentinel)}])
                pos = len(columns)
                columns.append(col)
                terms.append({"termId": term_id, "kind": "missing_dummy",
                              "columnId": cid, "level": str(sentinel),
                              "label": label + "（" +
                              str(catalog.labels.get(sentinel, sentinel)) + "）"})
                col_ids.append(did)
                labels.append(label + "（" +
                              str(catalog.labels.get(sentinel, sentinel)) + "）")
                numeric_main_pos[pos] = False
    col_of_predictor = {}
    for j, t in enumerate(terms):
        col_of_predictor.setdefault(t.get("columnId"), []).append(j)
    order_ids = _pred_order_ids(predictor_specs)
    for pair in interactions or []:
        a, b = str(pair[0]), str(pair[1])
        cols_a = col_of_predictor.get(a, [])
        cols_b = col_of_predictor.get(b, [])
        if not cols_a or not cols_b:
            _err("LR_INTERACTION_INVALID",
                 "交互作用の主効果が展開されませんでした。", 422)
        if order_ids.index(a) < order_ids.index(b):
            first, second = a, b
        else:
            first, second = b, a
        cols_first = col_of_predictor[first]
        cols_second = col_of_predictor[second]
        for ja in cols_first:
            for jb in cols_second:
                inter = columns[ja] * columns[jb]
                term_id = "interaction:" + first + "*" + second
                did = _design_column_id(term_id, [
                    {"columnId": first, "sourceColumn": col_ids[ja]},
                    {"columnId": second, "sourceColumn": col_ids[jb]}])
                pos = len(columns)
                columns.append(inter)
                terms.append({"termId": term_id, "kind": "interaction",
                              "columns": [first, second],
                              "label": terms[ja]["label"] + "×" + terms[jb]["label"]})
                col_ids.append(did)
                labels.append(terms[ja]["label"] + "×" + terms[jb]["label"])
                numeric_main_pos[pos] = False
    x_mat = np.column_stack(columns) if columns else np.zeros((n, 0))
    return x_mat, terms, col_ids, labels, numeric_main_pos, cat_ref_solutions


def _model_formula(target_label, predictor_specs, frame, cat_ref_solutions,
                   intercept, interactions):
    parts = []
    for pref in predictor_specs:
        cid = str(pref.get("columnId"))
        if pref.get("kind") == "numeric":
            nm = next((n for n, v in frame.numeric_ids.items() if v == cid), cid)
            spec = frame.numeric_specs.get(nm, {})
            label = spec.get("label") or nm
            if frame.numeric_ordinal.get(nm) is not None:
                parts.append(label + "（順序得点・等間隔仮定）")
            else:
                parts.append(label)
        else:
            sol = cat_ref_solutions.get(cid, {})
            label = sol.get("variableLabel", cid)
            ref = sol.get("reference")
            parts.append(label + "（基準: " + str(ref) + "・treatment）")
    rhs = " + ".join(parts) if parts else "(no predictors)"
    if interactions:
        pairs = [" × ".join([str(a) for a in pair]) for pair in interactions]
        rhs += " + " + " + ".join(pairs)
    if not intercept:
        rhs += "（切片なし・非中心化）"
    return target_label + " ~ " + rhs


@router.post("/models/linear-regression")
def run_linear_regression(payload: dict = Body(...)):
    req = _parse_request(payload)
    ctx = req.context.model_dump()
    started = time.perf_counter()
    predictor_specs = [p.model_dump() for p in req.predictors]
    references = {}
    for p in predictor_specs:
        if p.get("kind") == "categorical" and p.get("referenceCategory") is not None:
            references[str(p.get("columnId"))] = p.get("referenceCategory")
    try:
        frame = prepare_regression_frame(
            dataset_id=ctx["datasetId"], context_dict=ctx,
            target_ref=req.target, predictor_specs=predictor_specs,
            interactions=[list(v) for v in (req.interactions or [])],
            store=store)
    except BizError:
        raise
    omitted: list[dict[str, Any]] = []
    try:
        x_mat, terms, col_ids, labels, numeric_main_pos, cat_solutions = \
            _build_design_matrix(frame, predictor_specs,
                                 [list(v) for v in (req.interactions or [])],
                                 references, omitted)
    except BizError:
        raise
    if req.intercept:
        x_full = np.column_stack([np.ones(len(frame.row_ids)), x_mat]) \
            if x_mat.shape[1] else np.ones((len(frame.row_ids), 1))
        full_terms = [{"termId": "intercept", "kind": "intercept",
                       "label": "切片"}] + terms
        full_ids = [_design_column_id("intercept", [])] + col_ids
        full_labels = ["切片"] + labels
        full_numeric = {0: False}
        for k, v in numeric_main_pos.items():
            full_numeric[k + 1] = v
    else:
        x_full = x_mat
        full_terms = terms
        full_ids = col_ids
        full_labels = labels
        full_numeric = dict(numeric_main_pos)
    n = int(x_full.shape[0])
    p = int(x_full.shape[1])
    if n == 0 or p == 0:
        _err("LR_DESIGN_EMPTY", "有効な学習行または設計列がありません。", 422)
    w_vec = None
    if frame.weights is not None:
        w_vec = np.array([float(v) for v in frame.weights], dtype=np.float64)
    y_vec = np.array([float(v) for v in frame.target_values], dtype=np.float64)
    weight_type = frame.weight_type if frame.weight_applied else None
    cov_method = _resolve_covariance(req.covariance, weight_type,
                                     bool(frame.weight_applied))
    freq_int = None
    if weight_type == "frequency":
        freq_int = np.array([int(round(float(v))) for v in frame.weights],
                            dtype=np.float64)
        if ((freq_int - w_vec) ** 2).max() > 1e-9:
            _err("WEIGHT_FREQUENCY_NONINTEGER",
                 "頻度ウェイトには非負整数を指定してください。", 422)
    # Frequency safety: JS-safe integer total.
    frequency_n = float(freq_int.sum()) if freq_int is not None else None
    if frequency_n is not None and frequency_n > 9007199254740991:
        _err("FREQUENCY_TOTAL_UNSAFE", "頻度合計が安全整数を超えています。",
             422)
    n_stat = None
    if weight_type == "frequency":
        n_stat = float(frequency_n)
    elif weight_type is None:
        n_stat = float(n)
    try:
        sol = solve_weighted_least_squares(x_full, y_vec, w_vec)
    except ValueError as exc:
        if str(exc) == "LR_RANK_DEFICIENT":
            raise BizError("LR_RANK_DEFICIENT",
                           "モデル行列がランク欠損です。列を削除せず終了します。",
                           status_code=422,
                           details={"rankTol": float(np.finfo(float).eps *
                                                     max(x_full.shape) *
                                                     1.0) if x_full.size else 0.0,
                                    "candidateColumns": [
                                        full_labels[i] for i in
                                        _null_candidates(x_full, w_vec)]})
        _err("LR_DESIGN_EMPTY", "最小二乗解が得られません。", 422)
    beta = sol["beta"]
    bread = sol["bread"]
    sse = float(sol["sse"])
    resid = sol["residual"]
    cond_number = float(sol["conditionNumber"])
    rank_tol = float(sol["rankTol"])
    stats = fit_statistics(y_vec, w_vec, sse, bool(req.intercept),
                           n_stat, p)
    residual_df = stats["residualDf"]
    # Inference branch.
    cov = None
    sigma2 = None
    reference_df = None
    inference_status = "available"
    unavailable: dict[str, Any] = {}
    warnings: list[dict[str, Any]] = []
    hc3_flag = None
    survey_info: dict[str, Any] = {}
    if cov_method == "classical":
        if n_stat is None:
            _err("LR_COVARIANCE_WEIGHT_CONFLICT",
                 "classical は survey 重みと併用できません。", 422)
        if residual_df is None or residual_df <= 0:
            cov = None
            inference_status = "unavailable"
            unavailable["/details/coefficients"] = {
                "code": "LR_RESIDUAL_DF_NONPOSITIVE",
                "message": "残差自由度が不足しています。",
                "relatedFields": ["/summary/residualDf"]}
        else:
            try:
                cov, sigma2 = classical_covariance(sse, float(n_stat), p,
                                                   bread)
            except ValueError:
                cov = None
                inference_status = "unavailable"
                unavailable["/details/coefficients"] = {
                    "code": "LR_RESIDUAL_DF_NONPOSITIVE",
                    "message": "残差自由度が不足しています。",
                    "relatedFields": ["/summary/residualDf"]}
        reference_df = residual_df
    elif cov_method == "hc3":
        try:
            cov, h0_vec, _bad = hc3_covariance(x_full, resid, w_vec, bread)
            hc3_flag = None
        except ValueError as exc:
            if str(exc) == "HC3_LEVERAGE_ONE":
                cov = None
                hc3_flag = "HC3_LEVERAGE_ONE"
                inference_status = "unavailable"
                unavailable["/details/coefficients"] = {
                    "code": "HC3_LEVERAGE_ONE",
                    "message": "leverage が1に近く HC3 が未定義です。",
                    "relatedFields": ["/details/coefficients"]}
            else:
                raise
        if weight_type == "frequency":
            reference_df = float(frequency_n) - p \
                if frequency_n is not None else None
        else:
            reference_df = float(n) - p
        if sigma2 is None and residual_df is not None and residual_df > 0:
            sigma2 = sse / residual_df
    else:
        # survey Taylor: full design frame, scope-outside score 0.
        design_weights = [float(v) if v is not None else 0.0
                          for v in frame.design_weights_full]
        # Weight/design-ID missing rows cannot form a complete design.
        missing_design = [i for i, v in
                          enumerate(frame.design_weights_full) if v is None]
        if missing_design:
            cov = None
            inference_status = "unavailable"
            unavailable["/details/coefficients"] = {
                "code": "SURVEY_DESIGN_MISSING",
                "message": "重み・設計ID欠損のため完全設計を構成できません。",
                "relatedFields": ["/details/coefficients"]}
            reference_df = None
            survey_info = {"designAssumption": "incomplete_design",
                           "designDf": None}
        else:
            full_x = np.zeros((len(frame.design_row_ids), p),
                              dtype=np.float64)
            for k, pos in enumerate(frame.fit_pos_in_design):
                full_x[pos, :] = x_full[k, :]
            full_resid = np.zeros(len(frame.design_row_ids))
            for k, pos in enumerate(frame.fit_pos_in_design):
                full_resid[pos] = float(resid[k])
            full_w = np.array(design_weights, dtype=np.float64)
            scores = (full_w * full_resid)[:, None] * full_x
            try:
                design_frame = build_regression_design_frame(
                    row_ids=list(frame.design_row_ids),
                    weights=[float(v) for v in design_weights],
                    strata=list(frame.design_strata)
                    if frame.design_strata is not None else None,
                    psu=list(frame.design_psu)
                    if frame.design_psu is not None else None,
                    fpc=list(frame.design_fpc)
                    if frame.design_fpc is not None else None)
            except BizError as exc:
                if exc.status_code == 422:
                    raise
                cov = None
                inference_status = "unavailable"
                unavailable["/details/coefficients"] = {
                    "code": "INFERENCE_UNAVAILABLE",
                    "message": "調査設計から分散を構成できません。",
                    "relatedFields": ["/details/coefficients"]}
                reference_df = None
                survey_info = {"designAssumption": "unavailable",
                               "designDf": None}
                design_frame = None
            if design_frame is not None:
                taylor = taylor_model_covariance(
                    design_frame=design_frame, scores=scores,
                    bread=bread, n_params=p,
                    intercept=bool(req.intercept))
                survey_info = {"designAssumption": taylor.get("designAssumption"),
                               "designDf": taylor.get("designDf"),
                               "singletonStrata": taylor.get("singletonStrata", [])}
                if taylor.get("status") == "available":
                    cov = np.asarray(taylor["covariance"], dtype=np.float64)
                    reference_df = taylor.get("referenceDf")
                elif taylor.get("status") == "available_no_reference":
                    cov = np.asarray(taylor["covariance"], dtype=np.float64)
                    reference_df = taylor.get("referenceDf")
                    inference_status = "unavailable"
                    unavailable["/details/coefficients"] = {
                        "code": "REFERENCE_DF_NONPOSITIVE",
                        "message": "参照自由度が不足しています。",
                        "relatedFields": ["/summary/referenceDf"]}
                else:
                    cov = None
                    inference_status = "unavailable"
                    code = taylor.get("reason") or "INFERENCE_UNAVAILABLE"
                    unavailable["/details/coefficients"] = {
                        "code": code,
                        "message": "調査設計から推測統計を得られません。",
                        "relatedFields": ["/details/coefficients"]}
                    reference_df = taylor.get("referenceDf")
    if cov is not None and not np.isfinite(cov).all():
        cov = None
        inference_status = "unavailable"
        unavailable["/details/coefficients"] = {
            "code": "INFERENCE_UNAVAILABLE",
            "message": "共分散が非有限です。",
            "relatedFields": ["/details/coefficients"]}
    if reference_df is not None and (not np.isfinite(reference_df)):
        reference_df = None
    t_rows = t_inference(beta, cov, reference_df, float(req.confidenceLevel))
    # Classical joint F + robust Wald F distinction.
    slope_pos = [j for j in range(p)
                 if not (bool(req.intercept) and j == 0)]
    joint_kind = "classical_f" if cov_method == "classical" else "robust_wald_f"
    joint = joint_wald_test(beta, cov, slope_pos, reference_df, joint_kind)
    if cov_method == "classical" and cov is not None:
        classical_f = joint
    elif cov_method == "classical":
        classical_f = joint
    else:
        classical_f = None
    std_rows = standardized_effects(x_full, y_vec, w_vec, beta,
                                    full_numeric)
    # Diagnostics.
    fitted = sol["fitted"]
    if weight_type == "survey":
        lev_total = survey_leverage(x_full, w_vec, bread)
        diag_block = {"leveragePerReplica": [None] * n,
                      "leverageTotal": [float(v) for v in lev_total],
                      "studentizedResidual": [None] * n,
                      "cooksDistance": [None] * n,
                      "surveyNote": "leverageTotal は幾何的診断。Cook距離・"
                      "studentized residual は設計補正済みとしない。"}
    else:
        diag = non_survey_diagnostics(x_full, resid, w_vec, bread,
                                      sigma2, p)
        diag_block = diag
    # VIF per design column (skip intercept position).
    try:
        vif_rows = weighted_vif(x_full, w_vec, bool(req.intercept),
                                full_ids)
    except Exception:
        vif_rows = [{"designColumnId": did, "value": None,
                     "status": "perfect_collinearity"} for did in full_ids
                    if not (bool(req.intercept) and did == full_ids[0])]
    qq = qq_positions(resid, w_vec if weight_type == "frequency" else None)
    # Near-perfect fit warning + SSE=0 logLik null handled in helper.
    tss_val = stats.get("totalSumSquares")
    if tss_val is not None and np.isfinite(tss_val) and tss_val > 0:
        if sse <= float(np.finfo(float).eps) * max(1.0, float(tss_val)):
            warnings.append({"code": "LR_NEAR_PERFECT_FIT",
                             "message": "残差がほぼ0です。誤差分散の推定が不安定です。",
                             "count": n, "columnIds": []})
    if cond_number is not None and np.isfinite(cond_number) and cond_number > 1e10:
        warnings.append({"code": "LR_HIGH_CONDITION_NUMBER",
                         "message": "条件数が大きく多重共線性の疑いがあります。",
                         "count": p, "columnIds": []})
    if weight_type == "survey" and survey_info.get("designAssumption") == "independent_units":
        warnings.append({"code": "SURVEY_INDEPENDENT_UNITS_APPROX",
                         "message": "PSU指定なしのため回答者を独立単位とした近似です。",
                         "count": n, "columnIds": []})
    if frame.fit_count < 30:
        warnings.append({"code": "LR_SMALL_SAMPLE",
                         "message": "有効行が少ないです（n=" +
                         str(frame.fit_count) + "）。解釈に注意してください。",
                         "count": frame.fit_count, "columnIds": []})
    if cov_method in ("hc3", "taylor"):
        like_block = {"logLikelihood": None, "aic": None, "bic": None,
                      "kAic": p + 1}
    elif weight_type == "survey":
        like_block = {"logLikelihood": None, "aic": None, "bic": None,
                      "kAic": p + 1}
    else:
        like_block = gaussian_loglik_aic_bic(sse, float(n_stat), p) \
            if n_stat is not None else {"logLikelihood": None,
                                        "aic": None, "bic": None,
                                        "kAic": p + 1}
    # Coefficients payload (estimate kept even when inference unavailable).
    coefficients = []
    for j in range(p):
        row = t_rows[j]
        std = std_rows[j] if j < len(std_rows) else {"value": None,
                                                     "reason": None}
        coefficients.append({
            "designColumnId": full_ids[j],
            "termId": full_terms[j].get("termId"),
            "label": full_labels[j],
            "estimate": float(beta[j]),
            "standardError": row.get("standardError"),
            "statistic": row.get("statistic"),
            "pValue": row.get("pValue"),
            "ciLower": row.get("ciLower"),
            "ciUpper": row.get("ciUpper"),
            "standardizedEstimate": std.get("value"),
            "standardizedReason": std.get("reason"),
            "inferenceReason": row.get("reason")})
    # Per-design-column VIF aligned with coefficients (intercept null).
    vif_by_id = {r["designColumnId"]: r for r in vif_rows}
    vif_out = []
    for j in range(p):
        if bool(req.intercept) and j == 0:
            vif_out.append({"designColumnId": full_ids[j], "value": None,
                            "status": "intercept"})
            continue
        hit = vif_by_id.get(full_ids[j])
        if hit is None:
            vif_out.append({"designColumnId": full_ids[j], "value": None,
                            "status": "perfect_collinearity"})
        else:
            vif_out.append(hit)
    # designColumns + category references.
    design_columns = []
    for j in range(p):
        design_columns.append({"designColumnId": full_ids[j],
                               "termId": full_terms[j].get("termId"),
                               "label": full_labels[j],
                               "kind": full_terms[j].get("kind")})
    category_refs = []
    for cid, sol_ref in cat_solutions.items():
        category_refs.append({
            "columnId": cid,
            "referenceCategoryId": _category_id(cid, "value",
                                                sol_ref["reference"]),
            "referenceCode": sol_ref["reference"],
            "observedCategoryIds": [_category_id(cid, "value", c) for c in
                                    sol_ref["observed"]],
            "coding": "treatment"})
    omitted_levels = []
    for entry in omitted:
        omitted_levels.append({
            "variableId": entry.get("variableId"),
            "categoryId": _category_id(entry.get("variableId"),
                                       entry.get("kind", "value"),
                                       entry.get("code")),
            "code": entry.get("code"), "reason": entry.get("reason")})
    # numeric_specs contains predictors only; resolve the target's display
    # label from its canonical codebook entry, not its generated column ID.
    target_spec = next((column for column in
                        (store.load_codebook(frame.dataset_id) or {}).get("columns", [])
                        if column.get("columnId") == frame.target_id), {})
    target_label = target_spec.get("label") or frame.target_name
    formula = _model_formula(target_label, predictor_specs, frame,
                             cat_solutions, bool(req.intercept),
                             [list(v) for v in (req.interactions or [])])
    request_json = json.loads(req.model_dump_json())
    effective_config = dict(request_json)
    effective_config["covariance"] = cov_method
    effective_config["resolvedReferences"] = {
        cid: sol_ref["reference"] for cid, sol_ref in cat_solutions.items()}
    summary = {
        "targetLabel": target_label,
        "nDesignColumns": p,
        "rank": p,
        "conditionNumber": cond_number if np.isfinite(cond_number) else None,
        "rSquared": stats.get("rSquared"),
        "rSquaredType": stats.get("rSquaredType"),
        "adjustedRSquared": stats.get("adjustedRSquared")
        if weight_type != "survey" else None,
        "rmse": stats.get("rmse"),
        "residualStdError": stats.get("residualStdError")
        if weight_type != "survey" else None,
        "residualDf": residual_df if weight_type != "survey" else None,
        "referenceDf": reference_df,
        "logLikelihood": like_block.get("logLikelihood"),
        "aic": like_block.get("aic"),
        "bic": like_block.get("bic"),
        "kAic": like_block.get("kAic"),
        "inferenceStatus": inference_status,
        "covarianceMethod": cov_method,
        "jointTest": joint,
        "classicalJointTest": classical_f,
        "frequencyN": frequency_n,
        "modelFormula": formula,
    }
    if weight_type == "survey":
        summary["adjustedRSquared"] = None
        summary["residualStdError"] = None
        summary["residualDf"] = None
        unavailable.setdefault("/summary/adjustedRSquared", {
            "code": "UNSUPPORTED_FOR_SURVEY",
            "message": "survey では調整済R2を提供しません。",
            "relatedFields": ["/summary/adjustedRSquared"]})
        unavailable.setdefault("/summary/aic", {
            "code": "UNSUPPORTED_FOR_SURVEY",
            "message": "survey では AIC/BIC を提供しません。",
            "relatedFields": ["/summary/aic"]})
    if hc3_flag is not None:
        unavailable.setdefault("/details/coefficients", {
            "code": hc3_flag,
            "message": "leverage が1に近く HC3 が未定義です。",
            "relatedFields": ["/details/coefficients"]})
    details = {
        "designColumns": design_columns,
        "coefficients": coefficients,
        "categoryReferences": category_refs,
        "vif": vif_out,
        "omittedLevels": omitted_levels,
        "designDiagnostics": {
            "fitted": [float(v) for v in np.asarray(fitted).tolist()],
            "residual": [float(v) for v in np.asarray(resid).tolist()],
            "leveragePerReplica": diag_block.get("leveragePerReplica"),
            "leverageTotal": diag_block.get("leverageTotal"),
            "studentizedResidual": diag_block.get("studentizedResidual"),
            "cooksDistance": diag_block.get("cooksDistance"),
            "qq": qq,
            "surveyNote": diag_block.get("surveyNote"),
        },
        "modelFormula": formula,
    }
    w_list = ([float(v) for v in frame.weights]
              if frame.weights is not None else [1.0] * len(frame.row_ids))
    sum_w = float(sum(w_list)) if frame.weight_applied else None
    denom = float(sum(v * v for v in w_list))
    if frame.weight_applied and sum_w and denom > 0:
        kish = sum_w * sum_w / denom
    elif not frame.weight_applied:
        kish = float(len(frame.row_ids))
    else:
        kish = None
    fp_payload = {
        "datasetId": ctx["datasetId"],
        "dataRevision": frame.revisions["dataRevision"],
        "schemaRevision": frame.revisions["schemaRevision"],
        "maskRevision": frame.mask_revision,
        "snapshotFingerprint": frame.data_fingerprint,
        "scopeHash": None, "fitRowIdsHash": None,
        "effectiveConfig": effective_config,
        "catalogs": {cid: {"reference": sol_ref["reference"],
                           "observed": sol_ref["observed"]}
                     for cid, sol_ref in cat_solutions.items()},
        "resolvedWeight": {"applied": frame.weight_applied,
                           "type": frame.weight_type,
                           "column": frame.weight_column},
        "algorithmVersion": ALGORITHM_VERSION,
    }
    from ..domain.context import scope_hash as _sh
    fp_payload["scopeHash"] = _sh([str(v) for v in frame.scope_ids])
    fp_payload["fitRowIdsHash"] = _sh([str(v) for v in frame.row_ids])
    fingerprint = model_fingerprint(fp_payload)
    meta = build_meta(
        dataset_id=ctx["datasetId"], revisions=frame.revisions,
        snapshot_fingerprint=frame.data_fingerprint,
        scope=ctx.get("scope", "all"),
        scope_ids=[str(v) for v in frame.scope_ids],
        fit_count=frame.fit_count,
        exclusion_counts=dict(frame.exclusion_counts),
        analysis_unit="respondent_row",
        weight_applied=frame.weight_applied,
        weight_type=frame.weight_type,
        weight_column=frame.weight_column,
        sum_weights=sum_w, kish_effective_n=kish,
        frequency_n=frequency_n,
        mask_revision=frame.mask_revision,
        imputed_cell_count=int(frame.imputed_cell_count or 0),
        imputed_row_count=int(frame.imputed_row_count or 0),
        fingerprint=fingerprint, algorithm_version=ALGORITHM_VERSION,
        warnings=warnings)
    result_id = new_result_id()
    # Capabilities: only feasible fields/intervals.
    fit_fields = ["fitted", "residual", "leverage_total",
                  "leverage_per_replica"]
    pred_fields = ["predicted", "mean_ci_lower", "mean_ci_upper"]
    intervals: list[str] = ["none", "mean_ci"]
    if cov_method == "classical" and weight_type != "survey":
        pred_fields += ["individual_pi_lower", "individual_pi_upper"]
        intervals.append("individual_pi")
    capabilities = {
        "rows": True, "projection": True, "materialize": True,
        "selectionKinds": ["diagnostic_rectangle", "row_ids"],
        "exportTables": ["manifest", "coefficients", "diagnostics", "rows"],
        "materializeFitFields": fit_fields,
        "materializePredictionFields": pred_fields,
        "predictionIntervals": intervals, "simulation": False,
    }
    encoding = {
        "target": {"columnId": frame.target_id,
                   "columnName": frame.target_name},
        "predictors": predictor_specs,
        "interactions": [list(v) for v in (req.interactions or [])],
        "intercept": bool(req.intercept),
        "covariance": cov_method,
        "confidenceLevel": float(req.confidenceLevel),
        "designColumns": [{"designColumnId": full_ids[j],
                           "termId": full_terms[j].get("termId"),
                           "label": full_labels[j],
                           "kind": full_terms[j].get("kind"),
                           "columnId": full_terms[j].get("columnId"),
                           "level": full_terms[j].get("level"),
                           "reference": full_terms[j].get("reference"),
                           "columns": full_terms[j].get("columns")}
                          for j in range(p)],
        "categoryReferences": cat_solutions,
        "numericOrdinal": {k: {"order": v["order"],
                               "reversed": v["reversed"]}
                          for k, v in frame.numeric_ordinal.items()},
        "numericRanges": _fit_numeric_ranges(frame, x_mat, predictor_specs),
        "missingPolicy": ctx.get("missingPolicy", "exclude"),
    }
    manifest = {"schemaVersion": SCHEMA_VERSION, "resultId": result_id,
                "method": "linear_regression",
                "ownerDatasetId": ctx["datasetId"],
                "config": effective_config, "meta": meta,
                "capabilities": capabilities, "summary": summary,
                "details": details, "encoding": encoding,
                "summaryKeys": list(summary.keys()),
                "unavailableReasons": unavailable}
    arrays = {"beta": np.asarray(beta, dtype=np.float64),
              "bread": np.asarray(bread, dtype=np.float64),
              "cov": np.asarray(cov, dtype=np.float64) if cov is not None
              else np.zeros((p, p)),
              "hasCov": np.array([cov is not None]),
              "fitted": np.asarray(fitted, dtype=np.float64),
              "residual": np.asarray(resid, dtype=np.float64),
              "design": np.asarray(x_full, dtype=np.float64),
              "sigma2": np.array([sigma2 if sigma2 is not None else np.nan]),
              "referenceDf": np.array([reference_df if reference_df is not None
                                       else np.nan]),
              "weights": np.asarray(w_list, dtype=np.float64)}
    rows_df = pl.DataFrame({
        "rowId": list(frame.row_ids),
        "observed": [float(v) for v in frame.target_values],
        "fitted": [float(v) for v in np.asarray(fitted).tolist()],
        "residual": [float(v) for v in np.asarray(resid).tolist()],
        "leverageTotal": [float(v) if v is not None else None
                          for v in diag_block.get("leverageTotal", [])],
        "leveragePerReplica": [float(v) if v is not None else None
                               for v in diag_block.get("leveragePerReplica", [])],
        "studentizedResidual": [float(v) if v is not None else None
                                for v in diag_block.get("studentizedResidual", [])],
        "cooksDistance": [float(v) if v is not None else None
                          for v in diag_block.get("cooksDistance", [])],
    })
    numerical_runtime = time.perf_counter() - started
    manifest["meta"]["numericalRuntimeSeconds"] = float(numerical_runtime)
    with store.lock(ctx["datasetId"]):
        cur_meta = store.get_meta(ctx["datasetId"])
        cur_code = store.load_codebook(ctx["datasetId"]) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
        base_rev = frame.revisions
        if (cur_rev["dataRevision"] != base_rev["dataRevision"]
                or cur_rev["schemaRevision"] != base_rev["schemaRevision"]):
            raise BizError("ANALYSIS_INPUT_STALE",
                           "計算中にデータが更新されました。再実行してください。",
                           status_code=409)
        result_store.save_result(result_id, manifest, arrays,
                                 members=None, exclusions=None,
                                 rows=rows_df)
    out = {"status": "success", "resultId": result_id,
           "method": "linear_regression", "meta": meta,
           "config": effective_config, "capabilities": capabilities,
           "summary": summary, "details": details,
           "unavailableReasons": unavailable}
    check_json_finite(out)
    return out


def _null_candidates(x_mat, w_vec):
    try:
        from scipy import linalg as _linalg
        import numpy as _np
        sqrt_w = _np.sqrt(_np.asarray(
            w_vec if w_vec is not None else _np.ones(x_mat.shape[0])))
        xw = sqrt_w[:, None] * _np.asarray(x_mat, dtype=float)
        _u, _s, _vt = _linalg.svd(xw, full_matrices=True,
                                  check_finite=True)
        tail = _vt[_s.shape[0]:, :] if _vt.shape[0] > _s.shape[0] else \
            _np.zeros((0, x_mat.shape[1]))
        out = []
        for row in tail:
            if _np.isfinite(row).all() and float(_np.abs(row).max()) > 0:
                out.append(int(_np.argmax(_np.abs(row))))
        return sorted(set(out))[:3]
    except Exception:
        return []


def _fit_numeric_ranges(frame, x_mat, predictor_specs):
    ranges = {}
    for pref in predictor_specs:
        if pref.get("kind") != "numeric":
            continue
        cid = str(pref.get("columnId"))
        nm = next((n for n, v in frame.numeric_ids.items() if v == cid),
                  None)
        if nm is None:
            continue
        vals = [float(v) for v in frame.numeric_inputs[nm]]
        if vals:
            ranges[cid] = {"min": float(min(vals)),
                           "max": float(max(vals))}
    return ranges


def _lr_stale_state(manifest):
    from ..domain.context import collect_revisions as _collect
    meta = dict(manifest.get("meta", {}))
    ds = manifest.get("ownerDatasetId")
    try:
        cur_meta = store.get_meta(ds)
        cur_code = store.load_codebook(ds) or {}
        cur_rev = _collect(cur_meta, cur_code)
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


def _lr_rows(result_id, manifest, meta, offset, limit, axes):
    if axes is not None:
        _err("ANALYSIS_REQUEST_INVALID",
             "linear_regression は axes を受け付けません。", 422)
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
            "observed": float(rec.get("observed")),
            "fitted": float(rec.get("fitted")),
            "residual": float(rec.get("residual")),
            "leverageTotal": (None if rec.get("leverageTotal") is None
                              else float(rec.get("leverageTotal"))),
            "leveragePerReplica": (None if rec.get("leveragePerReplica") is None
                                   else float(rec.get("leveragePerReplica"))),
            "studentizedResidual": (None if rec.get("studentizedResidual") is None
                                    else float(rec.get("studentizedResidual"))),
            "cooksDistance": (None if rec.get("cooksDistance") is None
                              else float(rec.get("cooksDistance"))),
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


def lr_prediction_rows(result_id, manifest, meta, prediction_id, offset,
                       limit, axes):
    if axes is not None:
        _err("ANALYSIS_REQUEST_INVALID",
             "linear_regression は axes を受け付けません。", 422)
    try:
        offset = int(offset)
        limit = int(limit)
    except (TypeError, ValueError):
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    if offset < 0 or limit < 1 or limit > 10000:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    pdf = result_store.load_prediction_rows(result_id, prediction_id)
    if pdf is None:
        _err("ANALYSIS_RESULT_NOT_FOUND",
             "prediction が見つかりません。", 404)
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
        def _f(key):
            v = rec.get(key)
            return None if v is None else float(v)
        obs = rec.get("observed")
        res = rec.get("residual")
        rows.append({
            "rowId": str(rec.get("rowId")),
            "predicted": _f("predicted"),
            "observed": (None if obs is None else float(obs)),
            "residual": (None if res is None else float(res)),
            "meanCiLower": _f("meanCiLower"),
            "meanCiUpper": _f("meanCiUpper"),
            "individualPiLower": _f("individualPiLower"),
            "individualPiUpper": _f("individualPiUpper"),
            "predictionStatus": str(rec.get("status")),
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


def _lr_predict_options(req):
    opts = getattr(req, "options", None)
    if opts is None:
        return "none", True
    if isinstance(opts, dict):
        return (opts.get("interval", "none"), bool(opts.get("evaluate", True)))
    return (getattr(opts, "interval", "none"),
            bool(getattr(opts, "evaluate", True)))


def _lr_build_predict_matrix(manifest, codebook, records, scope_ids):
    """Fixed-transform design rows. Returns (X, statuses, extras)."""
    import numpy as _np
    from ..domain.codebook_adapter import is_not_applicable_reason as _is_na

    enc = manifest.get("encoding") or {}
    design_cols = list(enc.get("designColumns") or [])
    p = len(design_cols)
    predictors = list(enc.get("predictors") or [])
    interactions = [list(v) for v in (enc.get("interactions") or [])]
    intercept = bool(enc.get("intercept", True))
    missing_policy = enc.get("missingPolicy", "exclude")
    cat_refs = enc.get("categoryReferences") or {}
    num_ord = enc.get("numericOrdinal") or {}
    num_ranges = enc.get("numericRanges") or {}
    target = enc.get("target") or {}
    target_cid = str(target.get("columnId", ""))
    target_name = target.get("columnName")

    spec_by_id = {s.get("columnId"): s for s in
                  (codebook.get("columns", []) or []) if isinstance(s, dict)}
    spec_by_name = {s.get("name"): s for s in
                    (codebook.get("columns", []) or []) if isinstance(s, dict)}

    # predictor columnId -> raw column name + kind + numeric ordinal info
    pred_info = {}
    for pref in predictors:
        cid = str(pref.get("columnId"))
        spec = spec_by_id.get(cid)
        cname = spec.get("name") if spec else None
        if cname is None and target_cid and cid == target_cid:
            cname = target_name
        entry = {"kind": pref.get("kind"), "name": cname, "spec": spec}
        if pref.get("kind") == "numeric":
            nm = None
            if spec is not None:
                nm = spec.get("name")
            # numericOrdinal keyed by frame numeric name; match via ordinal entries
            # by comparing columnId (stored value has columnId).
            for oname, oinfo in (num_ord.items() if isinstance(num_ord, dict) else []):
                if isinstance(oinfo, dict) and str(oinfo.get("columnId", "")) == cid:
                    nm = oname
                    break
            oinfo = num_ord.get(nm) if isinstance(num_ord, dict) else None
            entry["ordinal"] = oinfo
            entry["frameName"] = nm
        pred_info[cid] = entry

    # design column position lookups
    pos_of_did = {d.get("designColumnId"): j for j, d in enumerate(design_cols)}
    main_pos_by_cid = {}
    for j, d in enumerate(design_cols):
        if d.get("termId", "").startswith("main:"):
            main_pos_by_cid.setdefault(str(d.get("columnId")), []).append(j)
    # interaction sources: same canonical order as _build_design_matrix
    # (predictor-spec order), same descriptor -> same designColumnId.
    order_ids = [str(p.get("columnId")) for p in predictors]
    inter_src = []
    for pair in interactions:
        a, b = str(pair[0]), str(pair[1])
        try:
            first, second = (a, b) if order_ids.index(a) <= order_ids.index(b) \
                else (b, a)
        except ValueError:
            first, second = (a, b) if a <= b else (b, a)
        cols_first = list(main_pos_by_cid.get(first, []))
        cols_second = list(main_pos_by_cid.get(second, []))
        for ja in cols_first:
            for jb in cols_second:
                term_id = "interaction:" + first + "*" + second
                did = _design_column_id(term_id, [
                    {"columnId": first,
                     "sourceColumn": design_cols[ja].get("designColumnId")},
                    {"columnId": second,
                     "sourceColumn": design_cols[jb].get("designColumnId")}])
                j = pos_of_did.get(did)
                if j is not None:
                    inter_src.append((j, ja, jb))

    # category reference/observed sets + dummy column map
    dummy_pos = {}  # (cid, level) -> j
    missing_dummy_pos = {}  # (cid, label-kind) -> j
    ref_of = {}
    observed_of = {}
    for cid, sol in (cat_refs.items() if isinstance(cat_refs, dict) else []):
        if not isinstance(sol, dict):
            continue
        ref_of[str(cid)] = sol.get("reference")
        observed_of[str(cid)] = set(sol.get("observed", []) or [])
    for j, d in enumerate(design_cols):
        kind = d.get("kind")
        cid = str(d.get("columnId") or "")
        if kind == "dummy":
            dummy_pos[(cid, d.get("level"))] = j
        elif kind == "missing_dummy":
            missing_dummy_pos[(cid, str(d.get("level")))] = j
    # missing sentinel label -> kind: need codebook labels? design level holds
    # the sentinel code string; map via catalog kind at fit is unavailable, so
    # fall back to label text stored in designColumns label suffix? Simpler:
    # look up both sentinel keys when resolving missing levels.
    by_id = {str(r.get("__rowId__")): r for r in records}

    n = len(scope_ids)
    X = _np.zeros((n, p), dtype=float)
    statuses = []
    extras = []  # per-row dict: extrapolate_cids, observed, weight
    if intercept:
        # intercept is always position 0 when present
        pass
    for i, rid in enumerate(scope_ids):
        rec = by_id.get(str(rid))
        status = "ok"
        extra = {"extrapolate": [], "observed": None, "weight": None}
        if rec is None:
            status = "invalid"
            statuses.append(status)
            extras.append(extra)
            continue
        row = _np.zeros((p,), dtype=float)
        if intercept and p > 0 and design_cols and \
                design_cols[0].get("kind") == "intercept":
            row[0] = 1.0
        row_ok = True
        for cid, info in pred_info.items():
            if not row_ok:
                break
            cname = info.get("name")
            raw = rec.get(cname) if cname else None
            if info.get("kind") == "numeric":
                oinfo = info.get("ordinal")
                if oinfo is not None:
                    order = list(oinfo.get("order", []) or [])
                    rev = bool(oinfo.get("reversed", False))
                    code = normalize_code(raw)
                    spec = info.get("spec") or {}
                    mc = {normalize_code(v) for v in
                          (spec.get("missingCodes") or [])}
                    mc.discard(None)
                    if code is None or code in mc:
                        status = "missing"
                        row_ok = False
                        break
                    try:
                        rank = order.index(code) + 1
                    except ValueError:
                        status = "invalid"
                        row_ok = False
                        break
                    k = len(order)
                    score = (k + 1 - rank) if rev else rank
                    for j in main_pos_by_cid.get(cid, []):
                        row[j] = float(score)
                    rng = num_ranges.get(cid) if isinstance(num_ranges, dict) else None
                    if isinstance(rng, dict):
                        try:
                            lo, hi = float(rng["min"]), float(rng["max"])
                            if math.isfinite(lo) and math.isfinite(hi) and \
                                    (float(score) < lo or float(score) > hi):
                                extra["extrapolate"].append(cid)
                        except (TypeError, ValueError, KeyError):
                            pass
                else:
                    spec = info.get("spec") or {}
                    mc = {normalize_code(v) for v in
                          (spec.get("missingCodes") or [])}
                    mc.discard(None)
                    code = normalize_code(raw)
                    if code is None or code in mc:
                        status = "missing"
                        row_ok = False
                        break
                    if isinstance(raw, bool):
                        status = "invalid"
                        row_ok = False
                        break
                    try:
                        val = float(raw) if raw is not None and raw != "" else None
                    except (TypeError, ValueError):
                        val = None
                        status = "invalid"
                        row_ok = False
                        break
                    if val is None or not math.isfinite(val):
                        if raw is None or (isinstance(raw, str) and raw.strip() == ""):
                            status = "missing"
                        else:
                            status = "invalid"
                        row_ok = False
                        break
                    for j in main_pos_by_cid.get(cid, []):
                        row[j] = float(val)
                    rng = num_ranges.get(cid) if isinstance(num_ranges, dict) else None
                    if isinstance(rng, dict):
                        try:
                            lo, hi = float(rng["min"]), float(rng["max"])
                            if math.isfinite(lo) and math.isfinite(hi) and \
                                    (float(val) < lo or float(val) > hi):
                                extra["extrapolate"].append(cid)
                        except (TypeError, ValueError, KeyError):
                            pass
            else:
                spec = info.get("spec") or {}
                if spec is None or not spec:
                    status = "invalid"
                    row_ok = False
                    break
                code = normalize_code(raw)
                mc = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
                mc.discard(None)
                reasons = spec.get("missingReasons") or {}
                if code is None or code in mc:
                    reason = reasons.get(code, "") if isinstance(reasons, dict) else ""
                    want_na = (missing_policy == "separate_not_applicable"
                               and _is_na(reason))
                    if missing_policy == "exclude":
                        status = "missing"
                        row_ok = False
                        break
                    # map to missing dummy column if present
                    hit = None
                    for key, j in missing_dummy_pos.items():
                        if key[0] != cid:
                            continue
                        # level string compare against code
                        if key[1] == code or (
                                want_na and "非該当" in str(key[1])) or (
                                not want_na and key[1] in ("__missing__", "欠損",
                                                          code)):
                            hit = j
                            break
                    # fallback: any missing dummy of this variable
                    if hit is None:
                        for key, j in missing_dummy_pos.items():
                            if key[0] == cid:
                                hit = j
                                break
                    if hit is None:
                        status = "missing"
                        row_ok = False
                        break
                    row[hit] = 1.0
                    continue
                # closed domain check
                order_raw = spec.get("categoryOrder") or []
                declared = {normalize_code(v) for v in order_raw}
                declared.discard(None)
                declared -= mc
                if declared and code not in declared:
                    status = "invalid"
                    row_ok = False
                    break
                ref = ref_of.get(cid)
                obs = observed_of.get(cid, set())
                if code == ref:
                    continue  # all dummies 0
                j = dummy_pos.get((cid, code))
                if j is None:
                    status = "unknown_category"
                    row_ok = False
                    break
                row[j] = 1.0
        if row_ok:
            for (j, ja, jb) in inter_src:
                row[j] = float(row[ja]) * float(row[jb])
            X[i, :] = row
        statuses.append(status)
        extras.append(extra)
    return X, statuses, extras


def lr_predict(result_id, manifest, req):
    import uuid as _uuid

    import numpy as _np
    import polars as _pl

    from ..domain.context import (AnalysisContext as _AC,
                                  check_revisions as _check,
                                  resolve_scope as _scope)

    meta, stale, cur = _lr_stale_state(manifest)
    if stale:
        _err("ANALYSIS_INPUT_STALE", "stale result", 409)
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH",
             "結果の所有データセットと一致しません。", 422)
    _check(cur, ctx.get("expectedSchemaRevision"),
           ctx.get("expectedDataRevision"))
    interval, evaluate = _lr_predict_options(req)
    enc = manifest.get("encoding") or {}
    caps = manifest.get("capabilities") or {}
    dataset_id = manifest.get("ownerDatasetId")
    df_ids = [str(v) for v in store.get_dataframe(
        dataset_id, columns=["__rowId__"])["__rowId__"].to_list()]
    legacy = _AC(datasetId=dataset_id,
                 expectedDataRevision=ctx.get("expectedDataRevision"),
                 expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
                 scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"),
                 activeRowIds=ctx.get("activeRowIds"),
                 selectedRowIds=ctx.get("selectedRowIds"),
                 sampledRowIds=ctx.get("sampledRowIds"))
    scope_ids = _scope(df_ids, legacy)

    codebook = store.load_codebook(dataset_id) or {}
    # raw columns needed: predictors + target(name) for evaluation
    predictors = list(enc.get("predictors") or [])
    target = enc.get("target") or {}
    spec_by_id = {s.get("columnId"): s for s in
                  (codebook.get("columns", []) or []) if isinstance(s, dict)}
    need = {"__rowId__"}
    for pref in predictors:
        spec = spec_by_id.get(str(pref.get("columnId")))
        if spec and spec.get("name"):
            need.add(spec.get("name"))
    if target.get("columnName"):
        need.add(target.get("columnName"))
    else:
        tspec = spec_by_id.get(str(target.get("columnId", "")))
        if tspec and tspec.get("name"):
            need.add(tspec.get("name"))
    full_df = store.get_dataframe(dataset_id, columns=sorted(need))
    records = full_df.rows(named=True)

    X, statuses, extras = _lr_build_predict_matrix(
        manifest, codebook, records, scope_ids)
    arrays = result_store.load_arrays(result_id)
    beta = _np.asarray(arrays["beta"], dtype=float)
    cov = _np.asarray(arrays["cov"], dtype=float)
    has_cov = bool(_np.asarray(arrays["hasCov"]).tolist()[0]) \
        if "hasCov" in arrays else False
    ref_df = float(_np.asarray(arrays["referenceDf"]).tolist()[0]) \
        if "referenceDf" in arrays else float("nan")
    sigma2 = float(_np.asarray(arrays["sigma2"]).tolist()[0]) \
        if "sigma2" in arrays else float("nan")
    conf = float(enc.get("confidenceLevel", 0.95))
    alpha = 1.0 - conf
    intervals = set(caps.get("predictionIntervals", ["none"]))
    want_mean = interval in ("mean_ci", "individual_pi")
    want_pi = interval == "individual_pi" and "individual_pi" in intervals
    can_mean = want_mean and has_cov and math.isfinite(ref_df) and ref_df > 0
    can_pi = (want_pi and has_cov and math.isfinite(ref_df) and ref_df > 0
              and math.isfinite(sigma2))
    try:
        tcrit = float(_stats.t.ppf(1.0 - alpha / 2.0, ref_df)) \
            if (can_mean and math.isfinite(alpha)) else float("nan")
    except Exception:
        tcrit = float("nan")
    if not math.isfinite(tcrit):
        can_mean = can_pi = False

    tspec = spec_by_id.get(str(target.get("columnId", "")))
    tname = target.get("columnName") or (tspec.get("name") if tspec else None)
    fit_ids = set()
    try:
        _rows_df = result_store.load_rows(result_id)
        if _rows_df is not None:
            fit_ids = {str(v) for v in _rows_df["rowId"].to_list()}
    except Exception:
        fit_ids = set()
    by_id = {str(r.get("__rowId__")): r for r in records}

    preds, obs_list, res_list = [], [], []
    mlo, mhi, plo, phi = [], [], [], []
    warnings = []
    interval_unavail = False
    for i, rid in enumerate(scope_ids):
        st = statuses[i]
        if st != "ok":
            preds.append(None)
            obs_list.append(None)
            res_list.append(None)
            mlo.append(None)
            mhi.append(None)
            plo.append(None)
            phi.append(None)
            continue
        x = X[i, :]
        yhat = float(x @ beta)
        if not math.isfinite(yhat):
            statuses[i] = "invalid"
            preds.append(None)
            obs_list.append(None)
            res_list.append(None)
            mlo.append(None)
            mhi.append(None)
            plo.append(None)
            phi.append(None)
            continue
        preds.append(yhat)
        if extras[i].get("extrapolate"):
            warnings.append({"code": "LR_EXTRAPOLATION",
                             "message": "学習範囲外の数値があります。",
                             "count": 1,
                             "columnIds": sorted(set(
                                 extras[i]["extrapolate"]))})
        # observed for evaluation (never affects predicted/CI).
        # Target missingCodes honored: sentinel numerics are missing
        # (excluded from evaluation), never fitted values.
        rec = by_id.get(str(rid))
        yobs = None
        if tname and rec is not None:
            raw = rec.get(tname)
            tcode = normalize_code(raw)
            tmc = set()
            if tspec is not None:
                tmc = {normalize_code(v) for v in
                       (tspec.get("missingCodes") or [])}
                tmc.discard(None)
            if tcode is None or tcode in tmc:
                yobs = None
            else:
                try:
                    if raw is not None and not (isinstance(raw, str)
                                                and raw.strip() == ""):
                        v = float(raw)
                        if math.isfinite(v) and not isinstance(raw, bool):
                            yobs = v
                except (TypeError, ValueError):
                    yobs = None
        obs_list.append(yobs)
        res_list.append(float(yobs - yhat) if yobs is not None else None)
        if want_mean and can_mean:
            try:
                xvx = float(x @ cov @ x)
            except Exception:
                xvx = float("nan")
            if math.isfinite(xvx) and xvx >= 0:
                half = tcrit * math.sqrt(xvx)
                mlo.append(yhat - half)
                mhi.append(yhat + half)
            else:
                mlo.append(None)
                mhi.append(None)
        else:
            mlo.append(None)
            mhi.append(None)
            if want_mean:
                interval_unavail = True
        if want_pi and can_pi:
            try:
                xvx = float(x @ cov @ x)
            except Exception:
                xvx = float("nan")
            tot = xvx + sigma2
            if math.isfinite(tot) and tot >= 0:
                half = tcrit * math.sqrt(tot)
                plo.append(yhat - half)
                phi.append(yhat + half)
            else:
                plo.append(None)
                phi.append(None)
        else:
            plo.append(None)
            phi.append(None)
            if want_pi:
                interval_unavail = True
    if interval_unavail:
        warnings.append({"code": "LR_INTERVAL_UNAVAILABLE",
                         "message": "要求された区間を構成できません。",
                         "count": 1, "columnIds": []})
    # dedupe extrapolation warnings
    if warnings:
        seen = {}
        for w in warnings:
            key = (w.get("code"), str(w.get("columnIds")))
            if key not in seen:
                seen[key] = dict(w)
                seen[key]["count"] = 0
            seen[key]["count"] += 1
        warnings = list(seen.values())

    # evaluation (weights read but never alter predicted/CI).
    # Predict-context weights resolved through the common weight
    # chain (dataset default incl. declared-type gate, column override,
    # none disables). Missing/zero rows leave evaluation; invalid
    # weights follow the common validation errors.
    evaluation = None
    if evaluate:
        from ..domain.survey_weight import (
            check_weights_valid as _check_w,
            extract_weights as _extract_w,
            resolve_weight_column as _resolve_wcol,
            resolve_weight_config as _resolve_wtype,
            validate_weight_semantics as _validate_wsem,
        )
        from ..domain.weight_mode import (
            resolve_weight_request as _resolve_wreq,
        )
        wmap: dict[str, float | None] = {}
        try:
            wcodebook = codebook
            wmode, wref = _resolve_wreq(
                wcodebook, weight_mode=ctx.get("weightMode", "dataset"),
                weight_column=ctx.get("weightColumn"),
                weight_type=ctx.get("weightType"))
            try:
                from ..domain.survey_weight import (
                    declared_weight_column_id as _declared_w,
                )
                _declared = _declared_w(wcodebook)
            except Exception:
                _declared = None
            if wmode == "dataset" and wref is None and _declared:
                wref = _declared
            wspec = _resolve_wcol(wcodebook, wref)
            wtype = _resolve_wtype(wcodebook, wref) if wspec else None
            if ctx.get("weightType") is not None and wtype is not None \
                    and ctx["weightType"] != wtype:
                from ..domain.errors import BizError as _Biz

                raise _Biz("WEIGHT_TYPE_MISMATCH",
                           "weightType が保存済み設定と一致しません。",
                           status_code=422)
            if wspec is not None:
                wname = wspec.get("name")
                wdf = store.get_dataframe(dataset_id,
                                          columns=["__rowId__", wname])
                wvals, _wmiss, _winvalid = _extract_w(
                    wdf, wname or "", wspec)
                _check_w(wvals, _winvalid)
                _validate_wsem(wvals, wtype)
                ids = [str(v) for v in
                       wdf["__rowId__"].to_list()]
                for rid_key, wv in zip(ids, wvals):
                    if wv is None or wv == 0:
                        wmap[rid_key] = None
                    else:
                        wmap[rid_key] = float(wv)
        except BizError:
            raise
        except Exception:
            wmap = {}
        ys, yhs, ws = [], [], []
        fit_overlap = 0
        non_fit_eval = 0
        for i, rid in enumerate(scope_ids):
            if statuses[i] != "ok" or obs_list[i] is None:
                continue
            w = wmap.get(str(rid), 1.0) if wmap else 1.0
            if w is None:
                continue
            ys.append(obs_list[i])
            yhs.append(preds[i])
            ws.append(float(w))
            if str(rid) in fit_ids:
                fit_overlap += 1
            else:
                non_fit_eval += 1
        if ys:
            import numpy as _nn
            ya = _nn.asarray(ys, dtype=float)
            ha = _nn.asarray(yhs, dtype=float)
            wa = _nn.asarray(ws, dtype=float)
            sw = float(wa.sum())
            rmse = float(_nn.sqrt(float(((ya - ha) ** 2 * wa).sum() / sw))) \
                if sw > 0 else None
            mae = float(float((abs(ya - ha) * wa).sum() / sw)) \
                if sw > 0 else None
            ybar = float((ya * wa).sum() / sw) if sw > 0 else None
            tss = float(((ya - ybar) ** 2 * wa).sum()) \
                if ybar is not None else None
            rss = float(((ya - ha) ** 2 * wa).sum())
            r2 = (1.0 - rss / tss) if tss else None
            metrics = {"rmse": rmse, "mae": mae, "rSquared": r2}
        else:
            metrics = {"rmse": None, "mae": None, "rSquared": None}
        evaluation = {"evaluatedCount": len(ys),
                      "fitOverlapCount": fit_overlap,
                      "nonFitEvaluationCount": non_fit_eval,
                      "metrics": metrics}

    prediction_id = f"pred-{_uuid.uuid4().hex[:12]}"
    pdf = _pl.DataFrame({
        "rowId": scope_ids,
        "status": statuses,
        "predicted": preds,
        "observed": obs_list,
        "residual": res_list,
        "meanCiLower": mlo,
        "meanCiUpper": mhi,
        "individualPiLower": plo,
        "individualPiUpper": phi,
    })
    result_store.save_prediction_rows(result_id, prediction_id, pdf)
    counts = {k: 0 for k in ("ok", "unknown_category", "missing",
                             "invalid", "unavailable")}
    for s in statuses:
        counts[s if s in counts else "unavailable"] += 1
    out_meta = dict(meta)
    if warnings:
        out_meta = {**meta, "warnings": warnings}
    out = {"status": "success", "resultId": result_id,
           "predictionId": prediction_id,
           "summary": {"requestedCount": len(scope_ids),
                       "successfulPredictions": counts["ok"],
                       "failedPredictions": len(scope_ids) - counts["ok"],
                       "statusCounts": counts,
                       "evaluation": evaluation},
           "meta": out_meta, "unavailableReasons": {}}
    check_json_finite(out)
    return out


def _lr_materialize_scope_norm(ctx) -> dict:
    scope = ctx.get("scope", "all")
    norm: dict = {"scope": scope}
    for key in ("rowIds", "activeRowIds", "selectedRowIds", "sampledRowIds"):
        value = ctx.get(key)
        if value is not None:
            norm[key] = sorted({str(v) for v in value})
    return norm


LR_FIT_FIELD_MAP = {
    "fitted": "fitted",
    "residual": "residual",
    "leverage_total": "leverageTotal",
    "leverage_per_replica": "leveragePerReplica",
}
LR_PRED_FIELD_MAP = {
    "predicted": "predicted",
    "mean_ci_lower": "meanCiLower",
    "mean_ci_upper": "meanCiUpper",
    "individual_pi_lower": "individualPiLower",
    "individual_pi_upper": "individualPiUpper",
}


def lr_materialize(result_id, manifest, req):
    import json as _json
    import os as _os
    import re as _re
    import uuid as _uuid

    import polars as _pl

    from ..domain.context import (AnalysisContext as _AC,
                                  check_revisions as _check,
                                  collect_revisions as _collect,
                                  resolve_scope as _scope)

    meta, stale, cur = _lr_stale_state(manifest)
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH",
             "結果の所有データセットと一致しません。", 422)
    dataset_id = manifest.get("ownerDatasetId")
    scope_norm = _lr_materialize_scope_norm(ctx)
    cols = req.columns if isinstance(req.columns, list) else []
    payload_norm = {"source": req.source,
                    "columns": [{k: (c.get(k) if isinstance(c, dict)
                                     else getattr(c, k, None))
                                 for k in ("sourceField", "name", "label")}
                                for c in cols],
                    "scope": scope_norm}
    prov = store.load_provenance(dataset_id) or {}
    for op in prov.get("operations", []) or []:
        params = op.get("params") or {}
        if params.get("lrIdempotencyKey") == req.idempotencyKey and \
                params.get("lrResultId") == result_id:
            if _json.dumps(params.get("lrPayload"), sort_keys=True) == \
                    _json.dumps(payload_norm, sort_keys=True, default=str):
                replay = dict(params.get("lrResponse") or {})
                replay["idempotentReplay"] = True
                check_json_finite(replay)
                return replay
            _err("IDEMPOTENCY_CONFLICT",
                 "idempotencyKey が別payloadで使用済みです。", 409)
    if stale:
        _err("ANALYSIS_INPUT_STALE", "stale result", 409)
    _check(cur, ctx.get("expectedSchemaRevision"),
           ctx.get("expectedDataRevision"))
    caps = manifest.get("capabilities") or {}
    source = req.source
    if source == "fit":
        rows_df = result_store.load_rows(result_id)
        if rows_df is None:
            _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
        allowed = set(caps.get("materializeFitFields", []))
        fmap = LR_FIT_FIELD_MAP
        values = {str(r["rowId"]): {k: r.get(v) for k, v in fmap.items()}
                  for r in rows_df.rows(named=True)}
    else:
        pdf = result_store.load_prediction_rows(result_id, source)
        if pdf is None:
            _err("ANALYSIS_RESULT_NOT_FOUND",
                 "prediction が見つかりません。", 404)
        allowed = set(caps.get("materializePredictionFields", []))
        fmap = LR_PRED_FIELD_MAP
        values = {}
        for r in pdf.rows(named=True):
            if str(r.get("status")) != "ok":
                continue
            values[str(r["rowId"])] = {k: r.get(v) for k, v in fmap.items()}
    fields = []
    for col in cols:
        src = col.get("sourceField") if isinstance(col, dict) \
            else getattr(col, "sourceField", None)
        name = col.get("name") if isinstance(col, dict) \
            else getattr(col, "name", None)
        label = (col.get("label") if isinstance(col, dict)
                 else getattr(col, "label", "")) or ""
        if str(src or "") not in allowed:
            _err("ANALYSIS_REQUEST_INVALID",
                 f"保存できないfieldです: {src}", 422)
        if not name or not _re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",
                                         str(name)):
            _err("ANALYSIS_REQUEST_INVALID",
                 f"列名が不正です: {name}", 422)
        fields.append({"sourceField": str(src), "name": str(name),
                       "label": str(label)})
    with store.lock(dataset_id):
        cur_meta = store.get_meta(dataset_id)
        cur_code = store.load_codebook(dataset_id) or {}
        cur_rev = _collect(cur_meta, cur_code)
        fit_rev = {"dataRevision": int(meta.get("dataRevision", 0)),
                   "schemaRevision": int(meta.get("schemaRevision", 0))}
        if cur_rev["dataRevision"] != fit_rev["dataRevision"] or \
                cur_rev["schemaRevision"] != fit_rev["schemaRevision"]:
            raise BizError("ANALYSIS_INPUT_STALE",
                           "書込時にデータ版が更新されています。再実行してください。",
                           status_code=409)
        if int(ctx.get("expectedDataRevision", cur_rev["dataRevision"])) != \
                cur_rev["dataRevision"] or \
                int(ctx.get("expectedSchemaRevision",
                            cur_rev["schemaRevision"])) != cur_rev["schemaRevision"]:
            raise BizError("ANALYSIS_INPUT_STALE",
                           "書込時にデータ版が更新されています。再実行してください。",
                           status_code=409)
        codebook = cur_code
        existing = {c.get("name") for c in
                    (codebook.get("columns", []) or [])}
        existing |= {c.get("name") for c in
                     (cur_meta.get("schema", []) or [])}
        for f in fields:
            if f["name"] in existing:
                _err("COLUMN_ALREADY_EXISTS",
                     f"既存列への上書きは禁止です: {f['name']}", 409)
        df = store.get_dataframe(dataset_id)
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = _AC(datasetId=dataset_id,
                     expectedDataRevision=ctx.get("expectedDataRevision"),
                     expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
                     scope=ctx.get("scope", "all"),
                     rowIds=ctx.get("rowIds"),
                     activeRowIds=ctx.get("activeRowIds"),
                     selectedRowIds=ctx.get("selectedRowIds"),
                     sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = set(_scope(all_ids, legacy))
        # all-null guard per field over scope intersection
        for f in fields:
            hit = sum(1 for rid in all_ids
                      if rid in values and rid in scope_ids
                      and values[rid].get(f["sourceField"]) is not None)
            if hit == 0:
                _err("LR_FIELD_UNAVAILABLE",
                     f"値が存在しないfieldです: {f['sourceField']}", 422)
        for f in fields:
            col_vals = [float(values[rid][f["sourceField"]])
                        if (rid in values and rid in scope_ids
                            and values[rid].get(f["sourceField"]) is not None)
                        else None for rid in all_ids]
            df = df.with_columns([_pl.Series(f["name"], col_vals,
                                             dtype=_pl.Float64)])
        from ..domain.provenance import new_operation_id
        from ..services.dataset_service import now_iso
        meta_now = cur_meta
        cb = codebook
        for f in fields:
            col_id = f"col-{_uuid.uuid4().hex[:12]}"
            f["columnId"] = col_id
            cb.setdefault("columns", []).append({
                "columnId": col_id, "name": f["name"],
                "label": f["label"] or f["name"],
                "role": "other", "scaleType": "interval", "derived": True,
                "origin": {"method": "linear_regression",
                           "resultId": result_id, "source": source,
                           "sourceField": f["sourceField"]}})
        cb["schemaRevision"] = int(cb.get(
            "schemaRevision", meta_now.get("schemaRevision", 1))) + 1
        provenance_before = store.load_provenance(dataset_id) or {}
        step = {"operationId": new_operation_id(),
                "parentOperationId": provenance_before.get(
                    "currentOperationId"),
                "operation": "calculate",
                "params": {"lrResultId": result_id, "lrSource": source,
                           "lrFields": fields,
                           "lrIdempotencyKey": req.idempotencyKey,
                           "lrPayload": payload_norm},
                "targetRowIds": sorted(scope_ids),
                "targetCells": [],
                "inputSchemaRevision": int(cb.get("schemaRevision", 1)),
                "outputSchemaRevision": int(cb.get("schemaRevision", 1)),
                "algorithmVersion": ALGORITHM_VERSION,
                "timestamp": now_iso(), "createdBy": "local-session"}
        schema = list(meta_now.get("schema", []) or [])
        for f in fields:
            schema.append({"columnId": f["columnId"], "name": f["name"],
                           "semanticType": "numeric"})
        meta_now["schema"] = schema
        meta_now["schemaRevision"] = int(cb.get("schemaRevision", 1))
        store.commit_data_change(dataset_id, meta_now, df, codebook=cb,
                                 step=step)
        fresh_meta = store.get_meta(dataset_id)
        fresh_cb = store.load_codebook(dataset_id) or {}
        non_null = {}
        for f in fields:
            non_null[f["name"]] = int(df[f["name"]].drop_nulls().len())
        created = [{"columnId": f["columnId"], "name": f["name"],
                    "label": f["label"] or f["name"],
                    "sourceField": f["sourceField"],
                    "nonNullCount": non_null[f["name"]]} for f in fields]
        written = int(sum(1 for rid in all_ids
                          if rid in values and rid in scope_ids
                          and any(values[rid].get(f["sourceField"]) is not None
                                  for f in fields)))
        resp = {"status": "success", "resultId": result_id,
                "source": source, "operationId": step["operationId"],
                "datasetId": dataset_id,
                "dataRevision": int(fresh_meta.get("dataRevision", 1)),
                "schemaRevision": int(fresh_cb.get(
                    "schemaRevision", fresh_meta.get("schemaRevision", 1))),
                "createdColumns": created, "writtenRowCount": written,
                "idempotentReplay": False}
        prov2 = store.load_provenance(dataset_id) or {}
        for op in prov2.get("operations", []) or []:
            if op.get("operationId") == step["operationId"]:
                op.setdefault("params", {})["lrResponse"] = resp
        ppath = store._provenance_path(dataset_id)
        tmp = ppath.with_suffix(".tmp")
        tmp.write_bytes(_json.dumps(prov2, ensure_ascii=False,
                                    indent=2).encode("utf-8"))
        _os.replace(tmp, ppath)
        check_json_finite(resp)
        return resp


LR_SELECTION_KINDS = ("diagnostic_rectangle", "row_ids")


def lr_select_ids(result_id, manifest, sel):
    """Return matched fit rowIds for an LR selector (no scope intersection)."""
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    fit_ids = [str(v) for v in rows_df["rowId"].to_list()]
    kind = sel.kind if isinstance(sel, str) else getattr(sel, "kind", None)
    if kind not in LR_SELECTION_KINDS:
        _err("ANALYSIS_SELECTOR_UNSUPPORTED",
             "この結果では未対応のselectorです。", 422,
             details={"allowedKinds": sorted(
                 (manifest.get("capabilities") or {}).get(
                     "selectionKinds", list(LR_SELECTION_KINDS)))})
    if kind == "row_ids":
        wanted = [str(v) for v in (getattr(sel, "rowIds", []) or [])]
        fit_set = set(fit_ids)
        return [v for v in wanted if v in fit_set]
    # diagnostic_rectangle
    xf = getattr(sel, "xField", None)
    yf = getattr(sel, "yField", None)
    xb = list(getattr(sel, "xBounds", []) or [])
    yb = list(getattr(sel, "yBounds", []) or [])
    for f in (xf, yf):
        if f not in ("fitted", "residual", "leverage"):
            _err("ANALYSIS_REQUEST_INVALID",
                 "diagnostic field が不正です。", 422)
    for b in (xb, yb):
        if len(b) != 2:
            _err("ANALYSIS_REQUEST_INVALID", "bounds が不正です。", 422)
        try:
            lo, hi = float(b[0]), float(b[1])
        except (TypeError, ValueError):
            _err("ANALYSIS_REQUEST_INVALID", "bounds が不正です。", 422)
        if not (math.isfinite(lo) and math.isfinite(hi)) or lo > hi:
            _err("ANALYSIS_REQUEST_INVALID", "bounds が不正です。", 422)

    def _triple(rec):
        vals = {
            "fitted": float(rec.get("fitted")),
            "residual": float(rec.get("residual")),
            "leverage": (float(rec.get("leverageTotal"))
                         if rec.get("leverageTotal") is not None else None),
        }
        return vals
    xlo, xhi = float(xb[0]), float(xb[1])
    ylo, yhi = float(yb[0]), float(yb[1])
    matched = []
    for rec in rows_df.rows(named=True):
        t = _triple(rec)
        xv, yv = t.get(xf), t.get(yf)
        if xv is None or yv is None:
            continue
        if xlo <= xv <= xhi and ylo <= yv <= yhi:
            matched.append(str(rec.get("rowId")))
    return matched





def lr_export_table(manifest, meta, result_id, req):
    """Feature 032 export tables: coefficients/diagnostics/rows (+manifest)."""
    import csv as _csv
    import io as _io
    import json as _json

    from ..services.analysis_service import check_json_finite as _finite
    from ..services.analysis_service import escape_formula_prefix as _esc
    from ..storage import analysis_result_store as _store

    table = req.table
    fmt = req.format
    limit = int(req.limit)
    offset = int(req.offset)
    if table == "manifest":
        body = {"resultId": result_id, "method": manifest.get("method"),
                "meta": meta, "config": manifest.get("config"),
                "capabilities": manifest.get("capabilities")}
        out = {"status": "success", "mime": "application/json",
               "fileName": f"{result_id}-manifest.json", "encoding": "utf-8",
               "payload": _json.dumps(body, ensure_ascii=False, allow_nan=False),
               "offset": 0, "total": 1, "nextOffset": None, "hasHeader": False,
               "snapshot": {"datasetId": meta.get("datasetId"),
                            "dataRevision": meta.get("dataRevision"),
                            "schemaRevision": meta.get("schemaRevision"),
                            "resultId": result_id}}
        _finite(out)
        return out
    if table == "coefficients":
        details = manifest.get("details") or {}
        header = ["designColumnId", "termId", "label", "estimate",
                  "standardError", "statistic", "pValue", "ciLower",
                  "ciUpper", "standardizedEstimate"]
        rows_all = []
        for c in details.get("coefficients") or []:
            rows_all.append([c.get("designColumnId"), c.get("termId"),
                             c.get("label"), c.get("estimate"),
                             c.get("standardError"), c.get("statistic"),
                             c.get("pValue"), c.get("ciLower"),
                             c.get("ciUpper"),
                             c.get("standardizedEstimate")])
    elif table in ("diagnostics", "rows"):
        rows_df = _store.load_rows(result_id)
        if rows_df is None:
            _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
        if table == "diagnostics":
            header = ["rowId", "observed", "fitted", "residual",
                      "leverageTotal", "leveragePerReplica",
                      "studentizedResidual", "cooksDistance"]
            rows_all = [[str(r.get("rowId")), r.get("observed"),
                         r.get("fitted"), r.get("residual"),
                         r.get("leverageTotal"),
                         r.get("leveragePerReplica"),
                         r.get("studentizedResidual"),
                         r.get("cooksDistance")]
                        for r in rows_df.rows(named=True)]
        else:
            header = ["rowId", "observed", "fitted", "residual"]
            rows_all = [[str(r.get("rowId")), r.get("observed"),
                         r.get("fitted"), r.get("residual")]
                        for r in rows_df.rows(named=True)]
    else:
        _err("ANALYSIS_EXPORT_UNSUPPORTED", "bad table", 422)
    total = len(rows_all)
    part = rows_all[offset:offset + limit]
    nxt = offset + len(part) if offset + len(part) < total else None
    if fmt == "json":
        body = {"columns": header, "rows": part}
        payload_text = _json.dumps(body, ensure_ascii=False,
                                   allow_nan=False)
        mime = "application/json"
    else:
        buf = _io.StringIO()
        w = _csv.writer(buf)
        w.writerow(header)
        for row in part:
            w.writerow([(_esc(str(v)) if isinstance(v, str)
                         else ("" if v is None else repr(float(v))
                               if isinstance(v, float) else v))
                        for v in row])
        payload_text = buf.getvalue()
        mime = "text/csv"
    out = {"status": "success", "mime": mime,
           "fileName": f"{result_id}-{table}.{fmt}",
           "encoding": "utf-8", "payload": payload_text,
           "offset": offset, "total": total, "nextOffset": nxt,
           "hasHeader": fmt == "csv",
           "snapshot": {"datasetId": meta.get("datasetId"),
                        "dataRevision": meta.get("dataRevision"),
                        "schemaRevision": meta.get("schemaRevision"),
                        "resultId": result_id}}
    _finite(out)
    return out
