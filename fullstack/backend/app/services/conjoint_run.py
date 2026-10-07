"""Conjoint estimation runner (Feature 034, production).

Orchestrates finalize -> encode -> branch fit -> covariance -> inference ->
utilities/importance/WTP -> summary/details/rows/manifest payload.
Thin service: mode-specific numerics live in algorithms/models/conjoint_*.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

import numpy as np
import polars as pl
from scipy import stats

from ..algorithms.models import conjoint_choice as _choice
from ..algorithms.models import conjoint_covariance as _cov
from ..algorithms.models import conjoint_encoding as _enc
from ..algorithms.models import conjoint_ratings as _ratings
from ..algorithms.models import conjoint_simulation as _sim
from ..algorithms.survey.model_covariance import build_regression_design_frame
from ..domain.errors import BizError
from . import conjoint_fit as cf
from . import conjoint_service as cj


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def run_conjoint_estimation(
    *,
    frame: dict[str, Any],
    req: Any,
    ctx: dict[str, Any],
    store,
    max_iterations: int,
    confidence_level: float,
) -> dict[str, Any]:
    mode = str(req.mode)
    columns = req.columns.model_dump()
    attributes = [a.model_dump() for a in req.attributes]
    has_opt = columns.get("optOutIndicator") is not None
    price_attr = req.priceAttribute
    weights = cj.resolve_conjoint_weights(frame)
    resp_weight = weights["respondentWeight"]
    fin = cj.finalize_fit_inputs(frame=frame, mode=mode, columns=columns,
                                 attributes=attributes, weights=weights)
    rows: list[dict[str, Any]] = frame["rows"]
    exclusions: dict[str, str] = fin["exclusions"]
    catalog: dict[str, list[str]] = fin["catalog"]
    warnings: list[dict[str, Any]] = list(fin["warnings"])
    dictionary = cf.build_encoding(
        attributes=attributes, catalog=catalog, finalized_rows=rows,
        fit_row_ids=fin["fitRowIds"], resp_weight=resp_weight,
        has_opt=has_opt, price_attr=price_attr)
    warnings.extend(dictionary.get("encodeWarnings", []))
    X_by_row = cf.encode_fit_matrix(dictionary=dictionary, rows=rows,
                                    fit_row_ids=fin["fitRowIds"],
                                    has_opt=has_opt)
    p = int(dictionary["nParams"])
    weight_type = frame["weightType"] if frame["weightApplied"] else None

    def row_w(rid: str) -> float:
        for r in rows:
            if r["rowId"] == rid:
                return float(resp_weight.get(r["respondentId"]) or 0.0)
        return 0.0

    beta: np.ndarray
    bread: np.ndarray
    intercept = 0.0
    alphas: dict[str, float] = {}
    mean_intercept = 0.0
    loglik: float | None = None
    stages: list[dict[str, Any]] = []
    optimizer_info: dict[str, Any] = {}
    fit_metrics: dict[str, Any] = {}
    respondent_scores: dict[str, np.ndarray] = {}
    fit_row_order: list[str] = []
    fitted_by_row: dict[str, float] = {}
    prob_by_row: dict[str, float | None] = {}
    resid_by_row: dict[str, float | None] = {}
    stage_detail_rows: list[dict[str, Any]] = []
    task_diag_rows: list[dict[str, Any]] = []

    if mode == "ratings":
        order = [r for r in rows if r["rowId"] in X_by_row]
        X = np.vstack([X_by_row[r["rowId"]] for r in order])
        # Drop ASC column for ratings (never set).
        Xa = X
        y = np.array([float(r["responseValue"]) for r in order])
        w = np.array([row_w(r["rowId"]) for r in order])
        resp_idx = [r["respondentId"] for r in order]
        if str(req.ratingEffects) == "respondent_fixed":
            within_rank_ok = True
            try:
                sol = _ratings.fit_fixed_ratings(Xa, y, w, resp_idx)
            except ValueError as exc:
                if str(exc) == "LR_RANK_DEFICIENT":
                    _err("CONJOINT_WITHIN_RANK_DEFICIENT",
                         "回答者内変動が不足しています。", 422)
                raise
            beta = np.asarray(sol["beta"])
            bread = np.asarray(sol["bread"])
            alphas = dict(sol["alphas"])
            rw = {r: float(resp_weight.get(r) or 0.0)
                  for r in {r["respondentId"] for r in order}}
            mean_intercept = _ratings.mean_intercept(alphas, rw)
            fitted = np.array([alphas[r["respondentId"]]
                               + X_by_row[r["rowId"]] @ beta for r in order])
            resid = y - fitted
            sse = float(np.dot(w, resid * resid))
            ybar_all = float(np.dot(w, y) / w.sum()) if w.sum() > 0 else 0.0
            tss = float(np.dot(w, (y - ybar_all) ** 2))
            # within R2 + overall R2.
            within_sse, within_tss = 0.0, 0.0
            by_resp: dict[str, list[int]] = {}
            for i, r in enumerate(order):
                by_resp.setdefault(r["respondentId"], []).append(i)
            for resp, idx in by_resp.items():
                yb = float(y[idx].mean())
                within_sse += float((((y[idx] - yb) - (Xa[idx] - Xa[idx].mean(axis=0)) @ beta) ** 2 * w[idx]).sum())
                within_tss += float(((y[idx] - yb) ** 2 * w[idx]).sum())
            rmse = float(math.sqrt(sse / w.sum())) if w.sum() > 0 else None
            mae = float(np.dot(w, np.abs(resid)) / w.sum()) if w.sum() > 0 else None
            fit_metrics = {
                "rmse": rmse, "mae": mae,
                "overallRSquared": (1 - sse / tss) if tss > 0 else None,
                "withinRSquared": (1 - within_sse / within_tss) if within_tss > 0 else None,
            }
            for i, r in enumerate(order):
                fitted_by_row[r["rowId"]] = float(fitted[i])
                resid_by_row[r["rowId"]] = float(resid[i])
                prob_by_row[r["rowId"]] = None
            fit_row_order = [r["rowId"] for r in order]
            # Respondent scores with within x.
            xbars = sol["xbars"]
            for i, r in enumerate(order):
                xw = Xa[i] - xbars[r["respondentId"]]
                u = xw * float(resid[i])
                respondent_scores[r["respondentId"]] = (
                    respondent_scores.get(
                        r["respondentId"], np.zeros((p,))) + u)
            optimizer_info = {"method": "ols_within",
                              "rankInfo": sol["rankInfo"]}
        else:
            try:
                sol = _ratings.fit_pooled_ratings(Xa, y, w)
            except ValueError as exc:
                if str(exc) == "LR_RANK_DEFICIENT":
                    _err("CONJOINT_DESIGN_RANK_DEFICIENT",
                         "モデル行列がランク欠損です。", 422)
                raise
            beta = np.asarray(sol["beta"])
            # Keep the fitted intercept in the sandwich. Taking the slope
            # block of bread first loses intercept/slope cross-covariances.
            bread = np.asarray(sol["breadFull"])
            intercept = float(sol["intercept"])
            fitted = np.asarray(sol["fitted"])
            resid = np.asarray(sol["residual"])
            sse = float(sol["sse"])
            ybar_all = float(np.dot(w, y) / w.sum()) if w.sum() > 0 else 0.0
            tss = float(np.dot(w, (y - ybar_all) ** 2))
            rmse = float(math.sqrt(sse / w.sum())) if w.sum() > 0 else None
            mae = float(np.dot(w, np.abs(resid)) / w.sum()) if w.sum() > 0 else None
            fit_metrics = {
                "rmse": rmse, "mae": mae,
                "overallRSquared": (1 - sse / tss) if tss > 0 else None,
                "withinRSquared": None,
            }
            for i, r in enumerate(order):
                fitted_by_row[r["rowId"]] = float(fitted[i])
                resid_by_row[r["rowId"]] = float(resid[i])
                prob_by_row[r["rowId"]] = None
            fit_row_order = [r["rowId"] for r in order]
            for i, r in enumerate(order):
                xa = np.zeros((p + 1,))
                xa[0] = 1.0
                xa[1:] = Xa[i]
                u = xa * float(resid[i])
                respondent_scores[r["respondentId"]] = (
                    respondent_scores.get(
                        r["respondentId"], np.zeros((p + 1,))) + u)
            optimizer_info = {"method": "ols_pooled",
                              "rankInfo": sol["rankInfo"]}
    else:
        # choice/ranking shared stage kernel.
        task_list = fin["tasks"]
        enc_tasks = []
        for t in task_list:
            enc_rows = []
            for m in t["rows"]:
                if m.get("optOut") and has_opt:
                    vec = np.zeros((p,))
                    vec[int(dictionary["ascOffset"])] = 1.0
                else:
                    vec = X_by_row[m["rowId"]]
                entry = {"rowId": m["rowId"], "x": vec}
                if mode == "choice":
                    entry["chosen"] = bool(m.get("chosen"))
                else:
                    entry["rank"] = int(m.get("rank"))
                enc_rows.append(entry)
            enc_tasks.append({"respondentId": t["respondentId"],
                              "taskId": t["taskId"], "rows": enc_rows,
                              "respondentWeight": t["respondentWeight"]})
        stages = _choice.expand_stages(tasks=enc_tasks, mode=mode)
        try:
            sol = _choice.fit_conditional_logit(
                stages, p, max_iterations=max_iterations)
        except ValueError as exc:
            code = str(exc)
            if code == "CONJOINT_SEPARATION":
                _err("CONJOINT_SEPARATION",
                     "完全/準完全分離のため有限最尤解がありません。", 422)
            if code == "CONJOINT_DESIGN_RANK_DEFICIENT":
                _err("CONJOINT_DESIGN_RANK_DEFICIENT",
                     "モデル行列がランク欠損です。", 422)
            if code == "CONJOINT_SEPARATION_CHECK_FAILED":
                _err("CONJOINT_SEPARATION_CHECK_FAILED",
                     "分離検査を実行できませんでした。", 422)
            if code == "CONJOINT_NONCONVERGENCE":
                _err("CONJOINT_NONCONVERGENCE",
                     "最適化が収束しませんでした。", 422)
            if code == "CONJOINT_INFORMATION_SINGULAR":
                _err("CONJOINT_INFORMATION_SINGULAR",
                     "情報行列が特異です。", 422)
            raise
        beta = np.asarray(sol["beta"])
        bread = np.asarray(sol["bread"])
        loglik = float(sol["logLikelihood"])
        optimizer_info = {"method": "l-bfgs-b",
                          "iterations": sol["iterations"],
                          "scoreInfNorm": sol["scoreInfNorm"],
                          "message": sol["optimizerMessage"]}
        _, _, per_resp = _choice.stage_score_hessian(beta, stages)
        respondent_scores = {k: np.asarray(v) for k, v in per_resp.items()}
        # Stage/task diagnostics + row probabilities (first-stage only).
        from scipy.special import logsumexp as _lse
        for st in stages:
            X = np.vstack([m["x"] for m in st["members"]])
            v = X @ beta
            probs = np.exp(v - float(_lse(v)))
            idx = next(i for i, m in enumerate(st["members"])
                       if m["rowId"] == st["chosenRowId"])
            stage_detail_rows.append({
                "kind": "stage", "respondentId": st["respondentId"],
                "taskId": st["taskId"], "stageIndex": st["stageIndex"],
                "setSize": st["setSize"],
                "logLikelihood": float(math.log(max(float(probs[idx]), 1e-300))),
                "chosenProbability": float(probs[idx]),
            })
            if st["stageIndex"] == 0:
                for i, m in enumerate(st["members"]):
                    prob_by_row[m["rowId"]] = float(probs[i])
                    obs = 1.0 if m["rowId"] == st["chosenRowId"] else 0.0
                    resid_by_row[m["rowId"]] = (float(obs - probs[i])
                                                if mode == "choice" else None)
                    fitted_by_row[m["rowId"]] = float(v[i])
        # Null log-likelihood + McFadden + hitRate.
        null_ll = 0.0
        for st in stages:
            null_ll += float(st["weight"]) * (-math.log(max(st["setSize"], 1)))
        total_w = float(sum(float(st["weight"]) for st in stages)) or 1.0
        mean_nll = -loglik / total_w
        mcf = 1 - loglik / null_ll if null_ll != 0 else None
        # Hit rate on first stages only.
        hits, total = 0.0, 0
        for st in stages:
            if st["stageIndex"] != 0:
                continue
            X = np.vstack([m["x"] for m in st["members"]])
            v = X @ beta
            best = float(v.max())
            tied = [m for m, vv in zip(st["members"], v) if vv == best]
            total += 1
            if any(m["rowId"] == st["chosenRowId"] for m in tied):
                hits += 1.0 / len(tied)
        fit_metrics = {
            "logLikelihood": loglik, "nullLogLikelihood": null_ll,
            "meanNegativeLogLikelihood": mean_nll,
            "mcfaddenRSquared": mcf,
            "hitRate": (hits / total) if total else None,
            "hitRateDefinition": ("first-stage max-probability choice; "
                                  "ties split evenly"),
        }
        fit_row_order = []
        for t in task_list:
            for m in t["rows"]:
                fit_row_order.append(m["rowId"])
        # Task diagnostics: observed choice/rank + predicted first prob.
        for t in task_list:
            task_diag_rows.append({
                "kind": "task", "respondentId": t["respondentId"],
                "taskId": t["taskId"],
                "chosenRowId": next((m["rowId"] for m in t["rows"]
                                     if m.get("chosen")), None),
            })

    # ---- Covariance branch.
    covariance: np.ndarray | None = None
    reference_df: float | None = None
    inference_status = "available"
    unavailable: dict[str, Any] = {}
    covariance_method = "respondent_cluster_CR1_G"
    design_assumption: str | None = None
    if weight_type == "survey":
        # Respondent-level design frame incl. scope-outside score 0.
        raw = frame["rawAll"]
        full_order: list[str] = frame["fullOrder"]
        resp_of = {str(r): i for i, r in enumerate(raw["respondent"])}
        # Unique respondents across the dataset.
        seen_r: list[str] = []
        for rr in raw["respondent"]:
            if rr is None:
                continue
            if str(rr) not in seen_r:
                seen_r.append(str(rr))
        dw = [float(resp_weight.get(r) or 0.0) for r in seen_r]
        strata = [raw["strata"][resp_of[r]] for r in seen_r]
        psu = [raw["psu"][resp_of[r]] for r in seen_r]
        fpc = [raw["fpc"][resp_of[r]] for r in seen_r]
        try:
            design_frame = build_regression_design_frame(
                row_ids=seen_r, weights=dw,
                strata=None if all(v is None for v in strata) else strata,
                psu=None if all(v is None for v in psu) else psu,
                fpc=None if all(v is None for v in fpc) else fpc)
        except BizError:
            raise
        # Scope-outside respondents keep score 0.
        full_scores = {r: respondent_scores.get(r, np.zeros((bread.shape[0],)))
                       for r in seen_r}
        surv = _cov.conjoint_survey_covariance(
            bread=bread, respondent_scores=full_scores,
            respondent_weights={r: float(resp_weight.get(r) or 0.0)
                                for r in seen_r},
            design_frame=design_frame)
        design_assumption = surv.get("designAssumption")
        if surv.get("status") == "available":
            covariance = np.asarray(surv["covariance"])
            reference_df = surv.get("referenceDf")
        elif surv.get("status") == "available_no_reference":
            covariance = np.asarray(surv["covariance"])
            reference_df = surv.get("referenceDf")
            inference_status = "unavailable"
            unavailable["/details/coefficients"] = {
                "code": surv.get("reason") or "REFERENCE_DF_NONPOSITIVE",
                "message": "参照自由度が不足しています。",
                "relatedFields": ["/summary/referenceDf"]}
        else:
            inference_status = "unavailable"
            unavailable["/details/coefficients"] = {
                "code": surv.get("reason") or "INFERENCE_UNAVAILABLE",
                "message": "調査設計から推測統計を得られません。",
                "relatedFields": ["/details/coefficients"]}
            reference_df = surv.get("referenceDf")
        covariance_method = "taylor_respondent"
        if design_assumption == "independent_units":
            warnings.append({"code": "SURVEY_INDEPENDENT_UNITS_APPROX",
                             "message": "PSU指定なしのため回答者を独立単位とした近似です。",
                             "count": len(seen_r), "columnIds": []})
    else:
        reps: dict[str, float] = {}
        if weight_type == "frequency":
            for r, w in resp_weight.items():
                reps[r] = float(w or 0.0)
        cr1 = _cov.respondent_cluster_cr1(
            bread=bread, respondent_scores=respondent_scores,
            respondent_replications=reps or None)
        if cr1.get("status") == "available":
            covariance = np.asarray(cr1["covariance"])
            reference_df = cr1.get("referenceDf")
        else:
            inference_status = "unavailable"
            unavailable["/details/coefficients"] = {
                "code": cr1.get("reason") or "INFERENCE_UNAVAILABLE",
                "message": "クラスター数が不足しています。",
                "relatedFields": ["/details/coefficients"]}
            reference_df = None
    if covariance is not None and not np.isfinite(np.asarray(covariance)).all():
        covariance = None
        inference_status = "unavailable"
        unavailable["/details/coefficients"] = {
            "code": "INFERENCE_UNAVAILABLE",
            "message": "共分散が非有限です。",
            "relatedFields": ["/details/coefficients"]}
    if covariance is not None and mode == "ratings" and str(req.ratingEffects) != "respondent_fixed":
        # Both CR1 and survey covariance now include the nuisance intercept.
        # Expose only the slope block after the complete sandwich and finite
        # check, matching the coefficient/utility parameterization.
        covariance = covariance[1:, 1:]
    trows = cf.t_rows(beta=beta, covariance=covariance,
                      reference_df=reference_df,
                      confidence_level=confidence_level)
    # ---- Coefficients payload with explicit names.
    design_columns: list[dict[str, Any]] = []
    coefficients: list[dict[str, Any]] = []
    for j, dc in enumerate(dictionary["designColumns"]):
        if dc["kind"] == "categorical" and dc["position"] != 0:
            continue
        cid = dc["columnId"]
        if dc["kind"] == "categorical":
            width = dc["width"]
            for k in range(width):
                jj = int(dc["offset"]) - int(dc["position"]) + k
                lv = dictionary["levelMaps"][cid]["nonRefLevels"][k]
                ref = dictionary["levelMaps"][cid]["referenceLevel"]
                term = f"main:{cid}"
                did = cf._design_column_id(
                    term, [{"columnId": cid, "coding": "effect",
                            "level": lv, "reference": ref}])
                tr = trows[jj] if jj < len(trows) else {}
                design_columns.append({"designColumnId": did,
                                       "termId": term, "label": f"{cid}={lv}",
                                       "kind": "effect"})
                coefficients.append({
                    "designColumnId": did, "termId": term,
                    "label": f"{cid}={lv}", "estimate": float(beta[jj]),
                    "standardError": tr.get("standardError"),
                    "statistic": tr.get("statistic"),
                    "pValue": tr.get("pValue"),
                    "ciLower": tr.get("ciLower"),
                    "ciUpper": tr.get("ciUpper"),
                    "reason": tr.get("reason")})
        else:
            jj = int(dc["offset"])
            term = f"main:{cid}"
            did = cf._design_column_id(
                term, [{"columnId": cid, "coding": "centered_linear",
                        "center": dictionary["linearCenters"].get(cid)}])
            tr = trows[jj] if jj < len(trows) else {}
            design_columns.append({"designColumnId": did, "termId": term,
                                   "label": f"{cid}（線形・中心化）",
                                   "kind": "linear"})
            coefficients.append({
                "designColumnId": did, "termId": term,
                "label": f"{cid}（線形・中心化）",
                "estimate": float(beta[jj]),
                "standardError": tr.get("standardError"),
                "statistic": tr.get("statistic"),
                "pValue": tr.get("pValue"),
                "ciLower": tr.get("ciLower"),
                "ciUpper": tr.get("ciUpper"),
                "reason": tr.get("reason")})
    if has_opt:
        jj = int(dictionary["ascOffset"])
        tr = trows[jj] if jj < len(trows) else {}
        did = cf._design_column_id("asc:optout", [{"coding": "optout_asc"}])
        design_columns.append({"designColumnId": did, "termId": "asc:optout",
                               "label": "opt-out ASC", "kind": "asc"})
        coefficients.append({
            "designColumnId": did, "termId": "asc:optout",
            "label": "opt-out ASC", "estimate": float(beta[jj]),
            "standardError": tr.get("standardError"),
            "statistic": tr.get("statistic"),
            "pValue": tr.get("pValue"),
            "ciLower": tr.get("ciLower"),
            "ciUpper": tr.get("ciUpper"),
            "reason": tr.get("reason")})
    # ---- Level utilities with propagated covariance.
    utilities, cat_ranges = _enc.level_utility_matrix(
        dictionary, beta, covariance)
    level_utils: list[dict[str, Any]] = []
    for u in utilities:
        cid = u["attributeId"]
        lv = u["levelCode"]
        se = u["standardError"]
        ci_lo = ci_hi = None
        if se is not None and reference_df is not None \
                and math.isfinite(reference_df) and reference_df > 0:
            crit = float(stats.t.ppf(0.5 + confidence_level / 2.0,
                                     reference_df))
            ci_lo, ci_hi = u["utility"] - crit * se, u["utility"] + crit * se
        elif se is not None:
            crit = float(stats.norm.ppf(0.5 + confidence_level / 2.0))
            ci_lo, ci_hi = u["utility"] - crit * se, u["utility"] + crit * se
        level_utils.append({
            "attributeId": cid,
            "categoryId": cf._category_id(cid, "value", lv),
            "levelCode": lv, "label": lv,
            "utility": float(u["utility"]), "standardError": se,
            "ciLower": ci_lo, "ciUpper": ci_hi,
            "referenceLevel": u["referenceLevel"]})
    # Linear slopes as levelUtilities entries for uniform export.
    for attr in attributes:
        if str(attr.get("kind")) != "linear":
            continue
        cid = str(attr["columnId"])
        jj = next((int(dc["offset"]) for dc in dictionary["designColumns"]
                   if dc["columnId"] == cid and dc["kind"] == "linear"), None)
        if jj is None:
            continue
        tr = trows[jj] if jj < len(trows) else {}
        level_utils.append({
            "attributeId": cid, "categoryId": None, "levelCode": None,
            "label": f"{cid}（傾き）", "utility": float(beta[jj]),
            "standardError": tr.get("standardError"),
            "ciLower": tr.get("ciLower"), "ciUpper": tr.get("ciUpper"),
            "referenceLevel": None})
    if has_opt:
        jj = int(dictionary["ascOffset"])
        tr = trows[jj] if jj < len(trows) else {}
        level_utils.append({
            "attributeId": "__optout__", "categoryId": None,
            "levelCode": "optout", "label": "opt-out ASC",
            "utility": float(beta[jj]),
            "standardError": tr.get("standardError"),
            "ciLower": tr.get("ciLower"), "ciUpper": tr.get("ciUpper"),
            "referenceLevel": None})
    # ---- Importance from stored utilityRange (opt-out ASC excluded).
    lin_specs = {}
    for cid, rg in dictionary.get("linearRanges", {}).items():
        jj = next((int(dc["offset"]) for dc in dictionary["designColumns"]
                   if dc["columnId"] == cid and dc["kind"] == "linear"), None)
        if jj is None:
            continue
        lin_specs[cid] = {"lower": rg["lower"], "upper": rg["upper"],
                          "beta": float(beta[jj])}
    importance = _sim.attribute_importance(
        utilities=[u for u in utilities], linear_specs=lin_specs)
    importance_rows: list[dict[str, Any]] | None = None
    if importance is not None:
        importance_rows = []
        for imp in importance:
            cid = imp["attributeId"]
            if imp["kind"] == "categorical":
                rg = cat_ranges.get(cid, {})
                importance_rows.append({
                    "attributeId": cid, "label": cid,
                    "kind": "categorical",
                    "range": float(imp["range"]),
                    "importance": float(imp["importance"]),
                    "rangeLower": float(rg.get("min", 0.0)),
                    "rangeUpper": float(rg.get("max", 0.0))})
            else:
                rg = dictionary["linearRanges"][cid]
                importance_rows.append({
                    "attributeId": cid, "label": cid, "kind": "linear",
                    "range": float(imp["range"]),
                    "importance": float(imp["importance"]),
                    "rangeLower": float(rg["lower"]),
                    "rangeUpper": float(rg["upper"])})
    # ---- WTP comparisons (fixed set; unstable -> null/WTP_UNSTABLE).
    wtp_rows: list[dict[str, Any]] | None = []
    if price_attr is not None:
        price_jj = next((int(dc["offset"])
                         for dc in dictionary["designColumns"]
                         if dc["columnId"] == price_attr
                         and dc["kind"] == "linear"), None)
        if price_jj is not None:
            pse = trows[price_jj].get("standardError") \
                if price_jj < len(trows) else None
            comps = []
            for u in utilities:
                if u["attributeId"] == price_attr:
                    continue
                ref = u["referenceLevel"]
                if u["levelCode"] == ref:
                    continue
                d = np.zeros((p,))
                # direction in beta space for level vs reference.
                lm = dictionary["levelMaps"][u["attributeId"]]
                base = next(int(dc["offset"]) - int(dc["position"])
                            for dc in dictionary["designColumns"]
                            if dc["columnId"] == u["attributeId"]
                            and dc["kind"] == "categorical")
                code = np.array(lm["codes"][u["levelCode"]])
                refcode = np.array(lm["codes"][ref])
                d[base: base + len(code)] = code - refcode
                comps.append({"attributeId": u["attributeId"],
                              "fromLevel": ref, "toLevel": u["levelCode"],
                              "direction": d})
            for cid, rg in dictionary.get("linearRanges", {}).items():
                if cid == price_attr:
                    continue
                jj = next((int(dc["offset"])
                           for dc in dictionary["designColumns"]
                           if dc["columnId"] == cid
                           and dc["kind"] == "linear"), None)
                if jj is None:
                    continue
                d = np.zeros((p,))
                d[jj] = float(rg["upper"]) - float(rg["lower"])
                comps.append({"attributeId": cid,
                              "fromLevel": str(rg["lower"]),
                              "toLevel": str(rg["upper"]), "direction": d})
            wtp_rows = _sim.wtp_table(
                beta=beta, covariance=covariance,
                price_attr=price_attr, price_index=price_jj,
                price_beta=float(beta[price_jj]), price_se=pse,
                reference_df=reference_df,
                confidence_level=confidence_level,
                comparisons=comps, price_unit="per recorded price unit")
    # ---- Respondent intercepts (ratings fixed only) + diagnostics index.
    intercepts_index: dict[str, Any] | None = None
    if mode == "ratings" and str(req.ratingEffects) == "respondent_fixed":
        intercepts_index = {
            "available": True,
            "total": len(alphas),
            "exportTable": "diagnostics",
            "subtables": ["respondent_intercept"],
            "_rows": [{"kind": "respondent_intercept",
                       "respondentId": r, "intercept": a}
                      for r, a in sorted(alphas.items())],
        }
    # G007-04: 診断の実体行を details に保持し、export と件数を一致させる。
    diagnostic_rows: list[dict[str, Any]] = []
    if intercepts_index:
        for entry in intercepts_index["_rows"]:
            diagnostic_rows.append({
                "kind": "respondent_intercept",
                "respondentId": entry.get("respondentId"),
                "taskId": None, "stageIndex": None, "rowId": None,
                "chosenRowId": None, "setSize": None,
                "logLikelihood": None, "chosenProbability": None,
                "intercept": entry.get("intercept"), "value": None,
            })
    for entry in stage_detail_rows:
        diagnostic_rows.append({
            "kind": "stage",
            "respondentId": entry.get("respondentId"),
            "taskId": entry.get("taskId"),
            "stageIndex": entry.get("stageIndex"),
            "rowId": None, "chosenRowId": None,
            "setSize": entry.get("setSize"),
            "logLikelihood": entry.get("logLikelihood"),
            "chosenProbability": entry.get("chosenProbability"),
            "intercept": None, "value": None,
        })
    for entry in task_diag_rows:
        diagnostic_rows.append({
            "kind": "task",
            "respondentId": entry.get("respondentId"),
            "taskId": entry.get("taskId"),
            "stageIndex": None, "rowId": None,
            "chosenRowId": entry.get("chosenRowId"), "setSize": None,
            "logLikelihood": None, "chosenProbability": None,
            "intercept": None, "value": None,
        })
    diag_index = {
        "available": True,
        "total": len(diagnostic_rows),
        "exportTable": "diagnostics",
        "subtables": (["respondent_intercept"] if intercepts_index else [])
        + (["stage", "task"] if mode != "ratings" else []),
    }
    by_id = {r["rowId"]: r for r in rows}
    row_records: list[dict[str, Any]] = []
    for rid in fin["fitRowIds"]:
        r = by_id[rid]
        if mode == "ratings":
            row_records.append({
                "rowId": rid, "respondentId": r["respondentId"],
                "taskId": r["taskId"], "alternativeId": r["alternativeId"],
                "observed": float(r["responseValue"]),
                "predictedRating": fitted_by_row.get(rid),
                "probability": None,
                "residual": resid_by_row.get(rid),
                "predictionStatus": "ok"})
        elif mode == "choice":
            row_records.append({
                "rowId": rid, "respondentId": r["respondentId"],
                "taskId": r["taskId"], "alternativeId": r["alternativeId"],
                "observed": int(1 if r.get("chosen") else 0),
                "predictedRating": None,
                "probability": prob_by_row.get(rid),
                "residual": resid_by_row.get(rid),
                "predictionStatus": "ok"})
        else:
            row_records.append({
                "rowId": rid, "respondentId": r["respondentId"],
                "taskId": r["taskId"], "alternativeId": r["alternativeId"],
                "observed": int(r.get("rank")),
                "predictedRating": None,
                "probability": prob_by_row.get(rid),
                "residual": None,
                "predictionStatus": "ok"})
    # Summary counts: respondents / tasks / profile rows / stages.
    if mode == "ratings":
        task_count = len({(r["respondentId"], r["taskId"]) for r in rows
                          if r["rowId"] in set(fin["fitRowIds"])})
        stage_count = len(fin["fitRowIds"])
    else:
        task_count = len(fin["tasks"])
        stage_count = len(stages)
    respondent_count = len(fin["respondentIds"])
    excl_counts = {"invalid": 0, "missing": 0, "missing_weight": 0,
                   "zero_weight": 0, "structural_task_exclusion": 0}
    for rid, why in exclusions.items():
        if why in excl_counts:
            excl_counts[why] += 1
        else:
            excl_counts["structural_task_exclusion"] += 1
    sum_resp_w = float(sum(float(resp_weight.get(r) or 0.0)
                           for r in fin["respondentIds"]))
    freq_resp_n = None
    if weight_type == "frequency":
        freq_resp_n = float(sum(float(resp_weight.get(r) or 0.0)
                                for r in fin["respondentIds"]))
    summary = {
        "mode": mode,
        "ratingEffects": str(req.ratingEffects),
        "respondentCount": respondent_count,
        "taskCount": task_count,
        "fitProfileCount": len(fin["fitRowIds"]),
        "stageCount": stage_count,
        "sumRespondentWeights": sum_resp_w,
        "frequencyRespondentN": freq_resp_n,
        "referenceDf": reference_df,
        "inferenceStatus": inference_status,
        "covarianceMethod": covariance_method,
        "converged": True,
        "fitMetrics": fit_metrics,
    }
    if mode != "ratings":
        summary["optimizer"] = optimizer_info
    details = {
        "attributes": attributes,
        "designColumns": design_columns,
        "coefficients": coefficients,
        "levelUtilities": level_utils,
        "attributeImportance": importance_rows,
        "wtp": wtp_rows,
        "omittedLevels": fin["omittedLevels"],
        "respondentIntercepts": intercepts_index,
        "taskDiagnostics": diag_index,
        "diagnosticRows": diagnostic_rows,
        "optimizer": optimizer_info,
        "encoding": {
            "linearCenters": dictionary.get("linearCenters", {}),
            "linearRanges": dictionary.get("linearRanges", {}),
            "referenceLevels": {cid: lm.get("referenceLevel")
                                for cid, lm in
                                dictionary.get("levelMaps", {}).items()
                                if lm.get("kind") == "categorical"},
            "catalog": catalog,
            "hasOptOutAsc": has_opt,
            "meanIntercept": mean_intercept if alphas else None,
        },
    }
    return {
        "beta": beta, "covariance": covariance, "intercept": intercept,
        "alphas": alphas, "meanIntercept": mean_intercept,
        "dictionary": dictionary, "summary": summary, "details": details,
        "rowRecords": row_records, "exclusionCounts": excl_counts,
        "auxCounts": fin["auxCounts"], "warnings": warnings,
        "unavailable": unavailable, "weightType": weight_type,
        "fitRowIds": fin["fitRowIds"], "respondentIds": fin["respondentIds"],
        "stages": stages, "tasks": fin["tasks"],
        "respondentWeight": {k: float(v or 0.0)
                             for k, v in resp_weight.items()},
        "stageDetailRows": stage_detail_rows,
        "taskDiagRows": task_diag_rows,
        "priceAttr": price_attr,
        "confidenceLevel": confidence_level,
    }
