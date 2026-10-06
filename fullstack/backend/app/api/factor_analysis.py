"""Exploratory factor analysis API (Feature 033 EFA, production)."""
from __future__ import annotations

import threading
import time
from typing import Any

import numpy as np
import polars as pl
from fastapi import APIRouter, Body
from pydantic import ValidationError

from ..domain.analysis_contracts import EFARequest
from ..domain.context import collect_revisions, scope_hash
from ..domain.errors import BizError
from ..services.analysis_service import (
    build_meta,
    check_json_finite,
    model_fingerprint,
    new_result_id,
)
from ..services import factor_analysis_service as fa_svc
from ..storage import analysis_result_store as result_store
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()
ALGORITHM_VERSION = fa_svc.ALGORITHM_VERSION
SCHEMA_VERSION = "factor_extensions.1"
ULS_ID = "uls_profile_full_v1"

_attempts: dict[str, dict] = {}
_comparisons: dict[str, dict] = {}
# E011 3rd round: background sensitivity workers + cancel flags + locks.
# The main POST publishes first; the comparison continues in a daemon
# thread with chunked cancel checks and progress (completedIterations /
# totalIterations) so GET can poll and POST cancel genuinely interrupts.
_comparison_threads: dict[str, threading.Thread] = {}
_comparison_cancel: dict[str, threading.Event] = {}
_comparison_locks: dict[str, threading.Lock] = {}


def _comparison_lock(comparison_id: str) -> threading.Lock:
    lock = _comparison_locks.get(comparison_id)
    if lock is None:
        lock = threading.Lock()
        _comparison_locks[comparison_id] = lock
    return lock


def _remember_attempt(rec: dict) -> None:
    # E011 2nd round: persistence failures propagate instead of leaving a
    # memory-only success. The in-memory entry is written first so a later
    # read in the same process still resolves after a disk failure.
    _attempts[rec["attemptId"]] = rec
    try:
        result_store.save_artifact("analysis-attempts", rec["attemptId"], rec)
    except Exception as exc:
        raise BizError("ANALYSIS_ARTIFACT_PERSIST_FAILED",
                       "試行の保存に失敗しました。", status_code=500,
                       details={"attemptId": rec["attemptId"],
                                "reason": str(exc)[:200]})


def _remember_comparison(rec: dict) -> None:
    _comparisons[rec["comparisonId"]] = rec
    try:
        result_store.save_artifact("analysis-comparisons", rec["comparisonId"], rec)
    except Exception as exc:
        raise BizError("ANALYSIS_ARTIFACT_PERSIST_FAILED",
                       "比較の保存に失敗しました。", status_code=500,
                       details={"comparisonId": rec["comparisonId"],
                                "reason": str(exc)[:200]})


def _load_attempt(attempt_id: str) -> dict:
    rec = _attempts.get(str(attempt_id))
    if rec is not None:
        return rec
    return result_store.load_artifact("analysis-attempts", str(attempt_id))


def _load_comparison(comparison_id: str) -> dict:
    rec = _comparisons.get(str(comparison_id))
    if rec is not None:
        return rec
    return result_store.load_artifact("analysis-comparisons", str(comparison_id))


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _parse_request(payload):
    if not isinstance(payload, dict):
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422)
    if payload.get("method") is not None and payload.get("method") != "efa":
        _err("ANALYSIS_REQUEST_INVALID",
             "このAPIはmethod=efaのみ受け付けます。旧入力の自動変換は行いません。",
             422)
    if payload.get("schemaVersion") is not None and payload.get("schemaVersion") != SCHEMA_VERSION:
        _err("ANALYSIS_REQUEST_INVALID", "schemaVersionが不正です。", 422)
    body = {k: v for k, v in payload.items() if k not in ("method", "schemaVersion")}
    try:
        return EFARequest.model_validate(body)
    except ValidationError as exc:
        _err("ANALYSIS_REQUEST_INVALID", "リクエストが不正です。", 422,
             {"errors": [e.get("msg", "") for e in exc.errors()][:10]})


def _save_attempt(dataset_id: str, payload: dict, stage: str, code: str,
                  message: str, diagnostics: list | None = None) -> str:
    attempt_id = new_result_id()
    try:
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        rev = collect_revisions(meta, codebook)
    except Exception:
        rev = {"dataRevision": None, "schemaRevision": None}
    rec = {
        "attemptId": attempt_id, "datasetId": dataset_id,
        "dataRevision": rev.get("dataRevision"),
        "schemaRevision": rev.get("schemaRevision"),
        "request": payload, "stage": stage,
        "status": "failed", "code": code, "message": message,
        "diagnostics": list(diagnostics or []),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    _remember_attempt(rec)
    return attempt_id


def _finite_matrix(m) -> list:
    a = np.asarray(m, dtype=float)
    if not np.all(np.isfinite(a)):
        raise ValueError("non-finite matrix")
    return a.tolist()


def _pa_payload(pa_rec: dict) -> dict:
    return {
        "enabled": bool(pa_rec.get("enabled", True)),
        "status": pa_rec.get("status") or "not_requested",
        "iterationsRequested": pa_rec.get("iterationsRequested", 0),
        "iterationsSucceeded": pa_rec.get("iterationsSucceeded", 0),
        "iterationsFailed": pa_rec.get("iterationsFailed", 0),
        "seed": pa_rec.get("seed"),
        "rng": pa_rec.get("rng", "PCG64"),
        "nullGenerator": pa_rec.get("nullGenerator", "independent_column_permutation"),
        "quantile": pa_rec.get("quantile"),
        "quantileMethod": pa_rec.get("quantileMethod", "linear"),
        "eigenvalueDefinition": pa_rec.get("eigenvalueDefinition", "full_correlation"),
        "observedEigenvalues": pa_rec.get("observedEigenvalues"),
        "referenceQuantiles": (
            [float(v) for v in np.asarray(pa_rec["referenceQuantiles"]).tolist()]
            if pa_rec.get("referenceQuantiles") is not None else None),
        "suggestedFactors": pa_rec.get("suggestedFactors"),
        "exceedanceRanks": list(pa_rec.get("exceedanceRanks") or []),
        "reasonCode": pa_rec.get("reasonCode"),
    }


def _build_details(variables, prep, corr_rec, qrec, pa_rec, comps,
                   sens: dict | None) -> dict:
    p = len(variables)
    cids = [str(v["columnId"]) for v in variables]
    r = np.asarray(corr_rec["correlation"], dtype=float)
    rep = np.asarray(qrec["reproduced"], dtype=float)
    resid = np.asarray(qrec["residual"], dtype=float)
    details: dict[str, Any] = {
        "variables": [],
        "factorIds": [f"F{i+1}" for i in range(int(qrec["q"]))],
        "factorLabels": [f"因子{i+1}" for i in range(int(qrec["q"]))],
        "pattern": _finite_matrix(qrec["pattern"]),
        "structure": _finite_matrix(qrec["structure"]),
        "factorCorrelation": _finite_matrix(qrec["phi"]),
        "rotationTransform": _finite_matrix(qrec["rotationTransform"]),
        "communality": [float(v) for v in np.asarray(qrec["communality"]).tolist()],
        "uniqueness": [float(v) for v in np.asarray(qrec["uniqueness"]).tolist()],
        "sampleCorrelation": _finite_matrix(r),
        "reproducedCorrelation": _finite_matrix(rep),
        "residualCorrelation": _finite_matrix(resid),
        "thresholds": None,
        "optimizerStarts": qrec.get("starts"),
        "ssLoadings": None,
        "varianceRatios": None,
        "parallelAnalysis": _pa_payload(pa_rec),
        "factorComparisons": comps,
        "distributionProfiles": prep["distributions"],
        # E012: expose reference inference + pair diagnostics for display.
        "referenceInference": qrec.get("inference"),
        "correlationPairs": corr_rec.get("pairs"),
        "solutionDiagnostics": qrec.get("diagnostics"),
    }
    for j in range(p):
        dist = prep["distributions"][j]
        mean = (None if corr_rec.get("mean") is None
                else float(np.asarray(corr_rec["mean"]).ravel()[j]))
        sd = (None if corr_rec.get("std") is None
              else float(np.asarray(corr_rec["std"]).ravel()[j]))
        details["variables"].append({
            "columnId": cids[j],
            "label": prep["nameByCid"][cids[j]],
            "order": dist.get("finalOrder") if dist.get("kind") == "ordinal" else None,
            "reverseApplied": bool(prep["resolutions"][j].get("reverse", False)),
            "mean": mean, "sampleScale": sd,
        })
    if corr_rec.get("thresholds") is not None:
        details["thresholds"] = [
            {"columnId": cids[j],
             "cuts": [float(v) for v in np.asarray(t).tolist()],
             "scale": "standard_normal"}
            for j, t in enumerate(corr_rec["thresholds"])]
    if qrec.get("appliedRotation") in ("none", "varimax"):
        ss = [float(v) for v in
              np.sum(np.asarray(qrec["pattern"]) ** 2, axis=0).tolist()]
        details["ssLoadings"] = ss
        details["varianceRatios"] = [float(v / p) for v in ss] if p else []
    if sens is not None:
        details["sensitivityAnalysis"] = {
            "enabled": True, "comparisonId": sens.get("comparisonId"),
            "status": sens.get("status"),
        }
    return details


def _cancel_requested(comparison_id: str) -> bool:
    ev = _comparison_cancel.get(comparison_id)
    return bool(ev is not None and ev.is_set())


def _note_progress(comparison_id: str, stage: str, done: int, total: int) -> bool:
    """Persist chunked progress; return False to abort on cancel."""
    if _cancel_requested(comparison_id):
        return False
    try:
        with _comparison_lock(comparison_id):
            rec = _load_comparison(comparison_id)
            if _cancel_requested(comparison_id) or rec.get("status") != "running":
                return False
            rec["stage"] = stage
            rec["completedIterations"] = int(done)
            rec["totalIterations"] = int(total)
            rec["progress"] = (int(done) / max(int(total), 1))
            _remember_comparison(rec)
    except Exception:
        pass
    return not _cancel_requested(comparison_id)


def _finish_comparison(comparison_id: str, updates: dict) -> tuple[dict, str]:
    """Publish a terminal state without losing progress or a concurrent cancel."""
    with _comparison_lock(comparison_id):
        current = _load_comparison(comparison_id)
        if current.get("status") == "cancelled":
            return current, comparison_id
        entry = {**current, **updates}
        if _cancel_requested(comparison_id):
            entry = {**current, "status": "cancelled", "stage": "cancelled",
                     "assessment": None, "reasonCode": "COMPARISON_CANCELLED"}
        _remember_comparison(entry)
        return entry, comparison_id


def _run_sensitivity_worker(dataset_id, payload, rd, prep, fit, r, qrec, pa_rec,
                            comparison_id) -> None:
    try:
        # _run_sensitivity publishes its terminal update atomically. Rewriting
        # the returned snapshot could erase a primary-result link saved later.
        _run_sensitivity(dataset_id, payload, rd, prep, fit, r, qrec, pa_rec,
                         comparison_id=comparison_id)
    except Exception as exc:
        try:
            _finish_comparison(comparison_id, {
                "status": "failed", "stage": "failed",
                "assessment": "indeterminate",
                "reasonCode": "COMPARISON_WORKER_FAILED",
                "diagnostics": {"error": str(exc)[:300]},
            })
        except Exception:
            pass


def _run_sensitivity(dataset_id: str, payload: dict, rd: dict, prep: dict,
                     fit: dict, r: np.ndarray, qrec: dict,
                     pa_rec: dict,
                     comparison_id: str | None = None) -> tuple[dict, str]:
    import numpy as _np
    sa = rd.get("sensitivityAnalysis") or {}
    q = int(rd["nFactors"])
    treatments = [str(v["treatment"]) for v in rd["variables"]]
    # Both sides use the same complete cases and already ordered/reversed
    # ordinal ranks, regardless of the primary treatment. The main fit can
    # contain numeric scores and must not be passed to the polychoric path.
    ordinal_fit = {
        "kind": "codes",
        "codes": _np.asarray(prep["rankCodes"][prep["fitIndex"], :], dtype=int),
        "nCats": fit["nCats"],
    }
    # Pearson side: final rank positions 1..K (never raw code spacing).
    pearson_x = ordinal_fit["codes"].astype(float) + 1.0
    pearson_fit = {"kind": "scores", "x": pearson_x, "nCats": fit.get("nCats")}
    pearson_corr = fa_svc.estimate_correlation(
        pearson_fit, {**rd, "correlation": "pearson"})
    if comparison_id is None:
        comparison_id = new_result_id()
        base_entry: dict[str, Any] = {
            "comparisonId": comparison_id, "primaryResultId": None,
            "status": "running", "stage": "sensitivity",
            "datasetId": dataset_id, "q": q,
            "dataRevision": prep["revisions"]["dataRevision"],
            "schemaRevision": prep["revisions"]["schemaRevision"],
            "stale": False,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _remember_comparison(base_entry)
    if pearson_corr.get("correlation") is None or pearson_corr.get("status") in ("failed", "boundary"):
        entry = {"status": "failed",
                 "reasonCode": pearson_corr.get("reasonCode"),
                 "assessment": "indeterminate",
                 "diagnostics": {"failedSide": "pearson",
                                 "pairCount": len(pearson_corr.get("pairs") or [])
                                 if isinstance(pearson_corr.get("pairs"), list)
                                 else None}}
        return _finish_comparison(comparison_id, entry)
    r_p = _np.asarray(pearson_corr["correlation"], dtype=float)
    mcheck = fa_svc.validate_correlation_matrix(r_p)
    if not mcheck.get("positiveDefinite"):
        entry = {"status": "failed",
                 "reasonCode": "FA_NON_POSITIVE_DEFINITE",
                 "assessment": "indeterminate",
                 "diagnostics": {"failedSide": "pearson",
                                 "minEigenvalue": mcheck.get("minEigenvalue")}}
        return _finish_comparison(comparison_id, entry)
    minres_req = {**rd, "correlation": "pearson", "extraction": "minres",
                  "scoreMethod": "none"}
    res_p = fa_svc.fit_single_q(r_p, minres_req, q, fit_n=len(prep["fitIds"]))
    if res_p.get("status") != "success":
        entry = {"status": "failed",
                 "reasonCode": res_p.get("reasonCode"),
                 "assessment": "indeterminate",
                 "diagnostics": {"failedSide": "pearson",
                                 "extractionStarts": res_p.get("starts")}}
        return _finish_comparison(comparison_id, entry)
    # Polychoric side: reuse the main result when the main path is already
    # Polychoric-MINRES; otherwise fit a comparison Polychoric-MINRES model
    # with identical q/rotation/starts (never replacing the main ML model).
    if rd.get("correlation") == "polychoric" and rd.get("extraction") == "minres":
        res_o = qrec
        r_o = _np.asarray(r, dtype=float)
    else:
        poly_corr = fa_svc.estimate_correlation(
            ordinal_fit, {**rd, "correlation": "polychoric"})
        if poly_corr.get("correlation") is None or poly_corr.get("status") in ("failed", "boundary"):
            entry = {"status": "failed",
                     "reasonCode": poly_corr.get("reasonCode"),
                     "assessment": "indeterminate",
                     "diagnostics": {
                         "failedSide": "polychoric",
                         "polychoricPairCount": len(poly_corr.get("pairs") or [])}}
            return _finish_comparison(comparison_id, entry)
        r_o = _np.asarray(poly_corr["correlation"], dtype=float)
        mcheck = fa_svc.validate_correlation_matrix(r_o)
        if not mcheck.get("positiveDefinite"):
            entry = {"status": "failed",
                     "reasonCode": mcheck.get("reasonCode") or "FA_NON_POSITIVE_DEFINITE",
                     "assessment": "indeterminate",
                     "diagnostics": {"failedSide": "polychoric",
                                     "minEigenvalue": mcheck.get("minEigenvalue")}}
            return _finish_comparison(comparison_id, entry)
        res_o = fa_svc.fit_single_q(
            r_o, {**rd, "correlation": "polychoric", "extraction": "minres",
                  "scoreMethod": "none"}, q, fit_n=len(prep["fitIds"]))
        if res_o.get("status") != "success":
            entry = {"status": "failed",
                     "reasonCode": res_o.get("reasonCode"),
                     "assessment": "indeterminate",
                     "diagnostics": {
                         "polychoricPairCount": len(
                             (poly_corr.get("pairs") or [])),
                         "failedSide": "polychoric",
                         "extractionStarts": res_o.get("starts")}}
            return _finish_comparison(comparison_id, entry)
    # Shared permutation stream for both PA sides: one (iterations, n, p)
    # index array, independent per replicate AND per column (E001).
    from ..services.factor_analysis_service import (
        run_parallel_analysis as _run_pa,
    )
    pa_cfg = rd.get("parallelAnalysis") or {}
    _seed = int(pa_cfg.get("seed", 42))
    _iters = int(pa_cfg.get("iterations", 500))
    _n, _p = pearson_x.shape
    _rng = np.random.default_rng(_seed)
    _shared_perm = _np.stack(
        [_np.stack([_rng.permutation(_n) for _ in range(_p)], axis=1)
         for _ in range(_iters)])
    def _pa_progress(done: int, total: int) -> bool:
        # Chunked progress for cancellable background execution; both PA
        # sides share the same stream so progress is reported per side.
        return _note_progress(comparison_id, "parallel_analysis", done, total * 2)

    pa_p = _run_pa(pearson_fit, {**rd, "correlation": "pearson"}, r_p,
                   perm_index=_shared_perm, progress=_pa_progress)
    if _cancel_requested(comparison_id) or pa_p.get("status") == "cancelled":
        entry = {"status": "cancelled", "stage": "cancelled",
                 "assessment": None, "reasonCode": "COMPARISON_CANCELLED",
                 "cancelNote": "cancelled during Pearson parallel analysis"}
        return _finish_comparison(comparison_id, entry)
    _note_progress(comparison_id, "parallel_analysis",
                   _iters, _iters * 2)

    def _pa_progress_o(done: int, total: int) -> bool:
        return _note_progress(comparison_id, "parallel_analysis", _iters + done,
                              total * 2)

    pa_o = _run_pa(ordinal_fit, {**rd, "correlation": "polychoric"}, r_o,
                   perm_index=_shared_perm, progress=_pa_progress_o)
    if _cancel_requested(comparison_id) or pa_o.get("status") == "cancelled":
        entry = {"status": "cancelled", "stage": "cancelled",
                 "assessment": None, "reasonCode": "COMPARISON_CANCELLED",
                 "cancelNote": "cancelled during Polychoric parallel analysis"}
        return _finish_comparison(comparison_id, entry)
    res_p = {**res_p, "correlation": r_p,
             "parallelSuggested": pa_p.get("suggestedFactors")}
    res_o = {**res_o, "correlation": r_o,
             "parallelSuggested": pa_o.get("suggestedFactors")}
    comp = fa_svc.run_sensitivity_comparison(prep, rd, q, pearson_fit, ordinal_fit,
                                             res_p, res_o)
    entry = {"status": "completed"
             if comp.get("status") == "completed" else comp.get("status", "failed"),
             "stage": "done", "methods": {
                 "pearson": {"solutionStatus": res_p.get("solutionStatus"),
                             "parallelSuggested": pa_p.get("suggestedFactors")},
                 "polychoric": {"solutionStatus": res_o.get("solutionStatus"),
                                "parallelSuggested": pa_o.get("suggestedFactors")}},
             "alignment": comp.get("alignment"), "metrics": comp.get("metrics"),
             "items": comp.get("items"),
             "factorCountComparison": comp.get("paComparison"),
             "assessment": comp.get("assessment"),
             "thresholds": comp.get("thresholds"),
             "reasonCode": comp.get("reasonCode"),
             "permutationStream": {"seed": int((rd.get("parallelAnalysis") or {}).get("seed", 42)),
                                   "rng": "PCG64", "sharedAcrossSides": True,
                                   "columnPermutation": True},
             "treatments": treatments,
             "diagnostics": {
                 "pearsonStarts": res_p.get("starts"),
                 "polychoricStarts": res_o.get("starts"),
                 "pearsonParallel": {k: pa_p.get(k) for k in (
                     "status", "iterationsSucceeded", "iterationsFailed",
                     "reasonCode")},
                 "polychoricParallel": {k: pa_o.get(k) for k in (
                     "status", "iterationsSucceeded", "iterationsFailed",
                     "reasonCode")}}}
    return _finish_comparison(comparison_id, entry)


@router.post("/models/factor-analysis")
def run_factor_analysis(payload: dict = Body(...)):
    req = _parse_request(payload)
    rd = req.model_dump()
    ctx = rd["context"]
    dataset_id = ctx["datasetId"]
    started = time.perf_counter()
    try:
        prep = fa_svc.prepare_efa_frame(dataset_id, rd, store)
    except BizError as exc:
        aid = _save_attempt(dataset_id, payload, "input", exc.code, exc.message)
        exc.details = {**(exc.details or {}), "attemptId": aid}
        raise
    n = len(prep["fitIds"])
    p = len(rd["variables"])
    all_q = sorted({int(rd["nFactors"]), *[int(v) for v in (rd.get("compareFactors") or [])]})
    try:
        fa_svc.check_identification(n, p, all_q)
    except BizError as exc:
        aid = _save_attempt(dataset_id, payload, "input", exc.code, exc.message)
        exc.details = {**(exc.details or {}), "attemptId": aid}
        raise
    if n == 0:
        aid = _save_attempt(dataset_id, payload, "input", "FA_NO_FIT_ROWS",
                            "完全ケースがありません。")
        _err("FA_NO_FIT_ROWS", "完全ケースがありません。", 422,
             {"attemptId": aid})
    try:
        fit = fa_svc.build_fit_matrices(prep, rd)
    except BizError as exc:
        aid = _save_attempt(dataset_id, payload, "input", exc.code, exc.message,
                            [{"code": exc.code, "severity": "error", "stage": "input"}])
        exc.details = {**(exc.details or {}), "attemptId": aid}
        raise
    corr_rec = fa_svc.estimate_correlation(fit, rd)
    if corr_rec["correlation"] is None or corr_rec.get("status") in ("failed", "boundary"):
        aid = _save_attempt(
            dataset_id, payload, "correlation",
            corr_rec.get("reasonCode") or "FA_CORRELATION_NONCONVERGENCE",
            "相関推定に失敗しました。抽出へは進みません。",
            [{"code": corr_rec.get("reasonCode") or "FA_CORRELATION_NONCONVERGENCE",
              "severity": "error", "stage": "correlation",
              "status": corr_rec.get("status"),
              "pairs": corr_rec.get("pairs") or []}])
        _err(corr_rec.get("reasonCode") or "FA_CORRELATION_NONCONVERGENCE",
             "相関推定に失敗しました。抽出へは進みません。", 422,
             {"attemptId": aid})
    r = np.asarray(corr_rec["correlation"], dtype=float)
    mcheck = fa_svc.validate_correlation_matrix(r)
    if not mcheck.get("positiveDefinite"):
        aid = _save_attempt(dataset_id, payload, "correlation",
                            "FA_NON_POSITIVE_DEFINITE", "相関行列が正定値ではありません。",
                            [{"code": "FA_NON_POSITIVE_DEFINITE", "severity": "error",
                              "stage": "correlation",
                              "value": mcheck.get("minEigenvalue")}])
        _err("FA_NON_POSITIVE_DEFINITE", "相関行列が正定値ではありません。補正は行いません。",
             422, {"attemptId": aid,
                   "minEigenvalue": mcheck.get("minEigenvalue")})
    score_z = score_mean = score_sd = None
    score_ok = (rd.get("scoreMethod", "none") != "none"
                and rd.get("correlation") == "pearson" and fit["kind"] == "scores")
    if score_ok:
        x = np.asarray(fit["x"], dtype=float)
        score_mean = x.mean(axis=0)
        score_sd = x.std(axis=0, ddof=1)
        score_z = (x - score_mean) / score_sd
    q = int(rd["nFactors"])
    qrec = fa_svc.fit_single_q(r, rd, q, score_z=score_z,
                               score_mean=score_mean, score_sd=score_sd,
                               fit_n=n)
    if qrec.get("status") != "success":
        aid = _save_attempt(dataset_id, payload, "extraction",
                            qrec.get("reasonCode") or "FA_NONCONVERGENCE",
                            "抽出に失敗しました。",
                            [{"code": qrec.get("reasonCode"), "severity": "error",
                              "stage": "extraction"}])
        _err(qrec.get("reasonCode") or "FA_NONCONVERGENCE",
             "抽出に失敗しました。別手法への置換は行いません。", 422,
             {"attemptId": aid})
    pa_rec = fa_svc.run_parallel_analysis(fit, rd, r)
    qrec["parallelSuggested"] = pa_rec.get("suggestedFactors")
    comps = []
    for qc in all_q:
        if qc == q:
            comps.append({"q": qc, "status": "success",
                          "objective": qrec.get("objective"),
                          "rmsr": qrec.get("rmsr"),
                          "solutionStatus": qrec.get("solutionStatus"),
                          "diagnostics": qrec.get("diagnostics")})
            continue
        rec = fa_svc.fit_single_q(r, rd, qc, fit_n=n)
        if rec.get("status") == "success":
            comps.append({"q": qc, "status": "success",
                          "objective": rec.get("objective"),
                          "rmsr": rec.get("rmsr"),
                          "solutionStatus": rec.get("solutionStatus"),
                          "diagnostics": rec.get("diagnostics")})
        else:
            comps.append({"q": qc, "status": "failed",
                          "reasonCode": rec.get("reasonCode"),
                          "starts": rec.get("starts")})
    # E011 3rd round: the main result publishes FIRST; the sensitivity
    # comparison continues in a background daemon thread (chunked cancel
    # checks + progress). The POST response carries a running comparisonId
    # the client can poll (GET) and cancel (POST cancel) independently.
    sens_out = None
    comparison_id = None
    sa_req = rd.get("sensitivityAnalysis") or {}
    if sa_req.get("enabled"):
        import copy as _copy
        comparison_id = new_result_id()
        base_entry: dict[str, Any] = {
            "comparisonId": comparison_id, "primaryResultId": None,
            "status": "running", "stage": "sensitivity",
            "datasetId": dataset_id, "q": q,
            "dataRevision": prep["revisions"]["dataRevision"],
            "schemaRevision": prep["revisions"]["schemaRevision"],
            "stale": False, "completedIterations": 0, "totalIterations": None,
            "progress": 0.0,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        _remember_comparison(base_entry)
        _comparison_cancel.pop(comparison_id, None)
        worker_payload = _copy.deepcopy(payload)
        worker_rd = _copy.deepcopy(rd)

        import os as _os
        if _os.environ.get("DAVIS_PCP_WASM") == "1" or _os.environ.get("PYTEST_CURRENT_TEST"):
            # Single-threaded WASM / deterministic tests: run inline but
            # keep the running→terminal transition observable via GET.
            sens_out, comparison_id = _run_sensitivity(
                dataset_id, payload, rd, prep, fit, r, qrec, pa_rec,
                comparison_id=comparison_id)
        else:
            th = threading.Thread(target=_run_sensitivity_worker,
                                  args=(dataset_id, worker_payload, worker_rd,
                                        prep, fit, r, qrec, pa_rec, comparison_id),
                                  daemon=True,
                                  name=f"efa-comparison-{comparison_id[:8]}")
            _comparison_threads[comparison_id] = th
            th.start()
            sens_out = {"comparisonId": comparison_id, "status": "running",
                        "stage": "sensitivity"}
    out = _publish_result(dataset_id, payload, rd, prep, fit, corr_rec,
                          qrec, pa_rec, comps, sens_out, comparison_id,
                          score_mean, score_sd, started, n, p)
    if comparison_id is not None:
        try:
            with _comparison_lock(comparison_id):
                cur = _load_comparison(comparison_id)
                if cur.get("primaryResultId") is None:
                    cur["primaryResultId"] = out.get("resultId")
                    _remember_comparison(cur)
                    if sens_out is not None:
                        sens_out["primaryResultId"] = out.get("resultId")
        except Exception:
            pass
    return out


def _publish_result(dataset_id: str, payload: dict, rd: dict, prep: dict,
                    fit: dict, corr_rec: dict, qrec: dict, pa_rec: dict,
                    comps: list, sens: dict | None, comparison_id: str | None,
                    score_mean, score_sd, started: float,
                    n: int, p: int) -> dict:
    import numpy as _np
    ctx = rd["context"]
    q = int(qrec["q"])
    model_df = ((p - q) ** 2 - p - q) / 2.0
    details = _build_details(rd["variables"], prep, corr_rec, qrec, pa_rec,
                             comps, sens)
    # --- summary ---
    summary: dict[str, Any] = {
        "computationStatus": "completed",
        "solutionStatus": qrec.get("solutionStatus"),
        "nVariables": p, "nFactors": q,
        "modelDf": int(model_df) if float(model_df).is_integer() else float(model_df),
        "objective": {"id": qrec.get("objectiveId") or (
            ULS_ID if rd.get("extraction") == "minres" else "ml_profile_full_v1"),
            "value": qrec.get("objective"),
            "offDiagonalSse": qrec.get("offDiagonalSse"),
            "optimizerDiagonalParametersRef": (
                "details.optimizerStarts" if rd.get("extraction") == "minres"
                else None)},
        "rmsr": qrec.get("rmsr"),
        "totalCommunalityRatio": qrec.get("totalCommunalityRatio"),
        "selectedStartIndex": qrec.get("selectedStartIndex"),
        "effectiveFactorRank": qrec.get("effectiveFactorRank"),
        "scoreMethod": rd.get("scoreMethod", "none"),
        "scoreInterpretation": None,
        "inferenceStatus": (qrec.get("inference") or {}).get("status",
                                                             "not_implemented"),
    }
    if rd.get("scoreMethod", "none") != "none":
        if any(str(v["treatment"]) == "continuous_approximation"
               for v in rd["variables"]):
            summary["scoreInterpretation"] = "continuous_approximation"
        else:
            summary["scoreInterpretation"] = "latent_estimate"
    # scores capability: suitable Pearson solution + explicit method only.
    scores_ok = (qrec.get("scores") is not None
                 and qrec.get("solutionStatus") == "admissible"
                 and rd.get("correlation") == "pearson")
    capabilities = {
        "rows": bool(scores_ok), "projection": bool(scores_ok),
        "materialize": bool(scores_ok),
        "selectionKinds": ["rectangle", "row_ids"] if scores_ok else [],
        "exportTables": ["manifest", "variables", "diagnostics",
                         "parallel_analysis", "factor_comparisons"]
        + (["rows"] if scores_ok else []),
        "materializeFitFields": [f"score:{i+1}" for i in range(q)] if scores_ok else [],
        "materializePredictionFields": [f"score:{i+1}" for i in range(q)] if scores_ok else [],
        "simulation": False,
    }
    unavailable: dict[str, Any] = dict((qrec.get("inference") or {}).get("unavailable") or {})
    if not scores_ok:
        unavailable["/capabilities/rows"] = {
            "code": "FA_SCORE_UNAVAILABLE",
            "message": "得点は適切なPearson解の明示選択時のみ有効です。",
        }
    # --- fingerprint / meta ---
    fp_payload = {
        "datasetId": dataset_id,
        "dataRevision": prep["revisions"]["dataRevision"],
        "schemaRevision": prep["revisions"]["schemaRevision"],
        "scopeHash": scope_hash([str(v) for v in prep["scopeIds"]]),
        "fitRowIdsHash": scope_hash([str(v) for v in prep["fitIds"]]),
        "measurement": [(str(v["columnId"]), str(v["measurement"]),
                         str(v["treatment"])) for v in rd["variables"]],
        "orders": [prep["resolutions"][j].get("originalOrder")
                   for j in range(p)],
        "appliedOrders": [(prep["distributions"][j].get("finalOrder")
                           if prep["distributions"][j].get("kind") == "ordinal"
                           else None) for j in range(p)],
        "reverse": [bool(v.get("reverse", False)) for v in rd["variables"]],
        "requestedMethod": {"correlation": rd.get("correlation"),
                            "extraction": rd.get("extraction"),
                            "rotation": rd.get("rotation")},
        "appliedMethod": {"appliedRotation": qrec.get("appliedRotation"),
                          "objectiveId": qrec.get("objectiveId")},
        "options": {"nFactors": q, "compareFactors": rd.get("compareFactors"),
                    "uniquenessLower": rd.get("uniquenessLower"),
                    "nStarts": rd.get("nStarts"),
                    "maxIterations": rd.get("maxIterations"),
                    "seed": rd.get("seed"),
                    "parallelAnalysis": rd.get("parallelAnalysis"),
                    "sensitivityAnalysis": {
                        "enabled": bool((rd.get("sensitivityAnalysis") or {}).get("enabled", False))}},
        "algorithmVersion": ALGORITHM_VERSION,
    }
    fingerprint = model_fingerprint(fp_payload)
    # E006 3rd round: notApplicable is folded into the common-contract
    # "missing" bucket for scopeCount=fitCount+excludedCount, and reported
    # separately in details for diagnosis (never double-counted).
    excl = {"invalid": int(prep["invalidCount"]),
            "missing": int(prep["missingCount"]) + int(prep.get("notApplicableCount") or 0),
            "missing_weight": 0, "zero_weight": 0, "structural_task_exclusion": 0}
    meta = build_meta(
        dataset_id=dataset_id, revisions=prep["revisions"],
        snapshot_fingerprint=None, scope=ctx.get("scope", "all"),
        scope_ids=[str(v) for v in prep["scopeIds"]], fit_count=n,
        exclusion_counts=excl, analysis_unit="respondent_row",
        weight_applied=False, weight_type=None, weight_column=None,
        sum_weights=None, kish_effective_n=None, frequency_n=None,
        mask_revision=prep.get("maskRevision"),
        imputed_cell_count=int(prep.get("imputedCells") or 0),
        imputed_row_count=int(prep.get("imputedRows") or 0),
        fingerprint=fingerprint,
        algorithm_version=ALGORITHM_VERSION, warnings=[])
    meta.update({
        "analysisPurpose": "exploratory", "isExplorative": True,
        "requestedMethod": fp_payload["requestedMethod"],
        "appliedMethod": fp_payload["appliedMethod"],
        "methodSwitchReason": qrec.get("methodSwitchReason"),
        "matrixCorrection": {"applied": False, "method": None},
        "measurementResolution": prep["resolutions"],
        "engineManifest": {"algorithmVersion": ALGORITHM_VERSION,
                           "objectiveId": qrec.get("objectiveId"),
                           "runtime": "local"},
        "fitRowsRef": {"count": n,
                       "hash": scope_hash([str(v) for v in prep["fitIds"]])},
        "excludedRowsRef": {"count": len(prep["excludedIds"]),
                            "hash": scope_hash([str(v) for v in prep["excludedIds"]])},
        "exclusionBreakdown": {"invalid": int(prep["invalidCount"]),
                               "missing": int(prep["missingCount"]),
                               "notApplicable": int(prep.get("notApplicableCount") or 0)},
    })
    config = {"method": "efa", "schemaVersion": SCHEMA_VERSION,
              "variables": rd["variables"], "correlation": rd["correlation"],
              "extraction": rd["extraction"], "nFactors": q,
              "compareFactors": rd.get("compareFactors"),
              "rotation": rd.get("rotation"), "scoreMethod": rd.get("scoreMethod"),
              "parallelAnalysis": rd.get("parallelAnalysis"),
              "sensitivityAnalysis": rd.get("sensitivityAnalysis"),
              "uniquenessLower": rd.get("uniquenessLower"),
              "nStarts": rd.get("nStarts"),
              "maxIterations": rd.get("maxIterations"), "seed": rd.get("seed")}
    result_id = new_result_id()
    arrays: dict[str, _np.ndarray] = {
        "pattern": _np.asarray(qrec["pattern"], dtype=float),
        "structure": _np.asarray(qrec["structure"], dtype=float),
        "phi": _np.asarray(qrec["phi"], dtype=float),
        "rotation": _np.asarray(qrec["rotationTransform"], dtype=float),
        "communality": _np.asarray(qrec["communality"], dtype=float),
        "uniqueness": _np.asarray(qrec["uniqueness"], dtype=float),
        "sampleCorrelation": _np.asarray(corr_rec["correlation"], dtype=float),
        "reproduced": _np.asarray(qrec["reproduced"], dtype=float),
    }
    rows_df = None
    if scores_ok:
        scores = _np.asarray(qrec["scores"], dtype=float)
        coef = _np.asarray(qrec["scoreCoefficients"], dtype=float)
        arrays["scoreCoefficients"] = coef
        arrays["scoreMean"] = _np.asarray(score_mean, dtype=float)
        arrays["scoreSd"] = _np.asarray(score_sd, dtype=float)
        rows_df = pl.DataFrame({
            "rowId": list(prep["fitIds"]),
            **{f"score{i+1}": [float(v) for v in scores[:, i].tolist()]
               for i in range(q)},
        })
    manifest = {"schemaVersion": SCHEMA_VERSION, "resultId": result_id,
                "method": "efa", "ownerDatasetId": dataset_id,
                "config": config, "meta": meta, "capabilities": capabilities,
                "summary": summary, "details": details,
                "encoding": {"scoreMean": (None if score_mean is None else
                                           [float(v) for v in
                                            _np.asarray(score_mean).tolist()]),
                             "scoreSd": (None if score_sd is None else
                                         [float(v) for v in
                                          _np.asarray(score_sd).tolist()]),
                             "comparisonId": comparison_id},
                "summaryKeys": list(summary.keys()),
                "unavailableReasons": unavailable}
    manifest["meta"]["numericalRuntimeSeconds"] = float(time.perf_counter() - started)
    with store.lock(dataset_id):
        cur_meta = store.get_meta(dataset_id)
        cur_code = store.load_codebook(dataset_id) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
        base_rev = prep["revisions"]
        if (cur_rev["dataRevision"] != base_rev["dataRevision"]
                or cur_rev["schemaRevision"] != base_rev["schemaRevision"]):
            raise BizError("ANALYSIS_INPUT_STALE",
                           "計算中にデータが更新されました。再実行してください。",
                           status_code=409)
        result_store.save_result(result_id, manifest, arrays,
                                 members=None, exclusions=None, rows=rows_df)
    if sens is not None and comparison_id is not None:
        with _comparison_lock(comparison_id):
            entry = _load_comparison(comparison_id)
            entry["primaryResultId"] = result_id
            _remember_comparison(entry)
    out = {"status": "success", "resultId": result_id, "method": "efa",
           "meta": meta, "config": config, "capabilities": capabilities,
           "summary": summary, "details": details,
           "unavailableReasons": unavailable}
    check_json_finite(out)
    return out


EFA_SELECTION_KINDS = ("rectangle", "row_ids")


def efa_select_ids(result_id, manifest, sel):
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    fit_ids = [str(v) for v in rows_df["rowId"].to_list()]
    kind = sel.kind if isinstance(sel, str) else getattr(sel, "kind", None)
    if kind not in EFA_SELECTION_KINDS:
        _err("ANALYSIS_SELECTOR_UNSUPPORTED",
             "この結果では未対応のselectorです。", 422,
             details={"allowedKinds": sorted(
                 (manifest.get("capabilities") or {}).get(
                     "selectionKinds", list(EFA_SELECTION_KINDS)))})
    if kind == "row_ids":
        wanted = [str(v) for v in (getattr(sel, "rowIds", []) or [])]
        fit_set = set(fit_ids)
        return [v for v in wanted if v in fit_set]
    import math as _math
    axes = [int(v) for v in (getattr(sel, "axes", []) or [])]
    bounds = [list(b) for b in (getattr(sel, "bounds", []) or [])]
    q = int((manifest.get("summary") or {}).get("nFactors", 0))
    if not axes or len(axes) != len(bounds) or len(set(axes)) != len(axes):
        _err("ANALYSIS_REQUEST_INVALID", "axes/bounds が不正です。", 422)
    if any(a < 1 or a > q for a in axes):
        _err("ANALYSIS_REQUEST_INVALID", "存在しない因子です。", 422)
    cols = {}
    for a in axes:
        col = f"score{a}"
        if col not in rows_df.columns:
            _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
        cols[a] = rows_df[col].to_list()
    norm = []
    for b in bounds:
        if len(b) != 2:
            _err("ANALYSIS_REQUEST_INVALID", "bounds が不正です。", 422)
        try:
            lo, hi = float(b[0]), float(b[1])
        except (TypeError, ValueError):
            _err("ANALYSIS_REQUEST_INVALID", "bounds が不正です。", 422)
        if not (_math.isfinite(lo) and _math.isfinite(hi)) or lo > hi:
            _err("ANALYSIS_REQUEST_INVALID", "bounds が不正です。", 422)
        norm.append((lo, hi))
    matched = []
    for pos, rid in enumerate(fit_ids):
        ok = True
        for a, (lo, hi) in zip(axes, norm):
            v = cols[a][pos]
            if v is None or not _math.isfinite(float(v)):
                ok = False
                break
            if not (lo <= float(v) <= hi):
                ok = False
                break
        if ok:
            matched.append(rid)
    return matched


def efa_rows(result_id, manifest, meta, offset=0, limit=5000, axes=None):
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    if limit < 1 or limit > 10000 or offset < 0:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    q = int((manifest.get("summary") or {}).get("nFactors", 0))
    if axes is None:
        axis_list = list(range(1, q + 1))
    else:
        try:
            axis_list = [int(v) for v in str(axes).split(",") if str(v).strip() != ""]
        except ValueError:
            _err("ANALYSIS_REQUEST_INVALID", "axes が不正です。", 422)
        if len(set(axis_list)) != len(axis_list) or any(a < 1 or a > q for a in axis_list):
            _err("ANALYSIS_REQUEST_INVALID", "axes が不正です。", 422)
    total = int(rows_df.height)
    if offset >= total:
        out = {"status": "success", "resultId": result_id, "offset": offset,
               "limit": limit, "total": total, "nextOffset": None,
               "axes": axis_list, "rows": [],
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
            "scores": [None if rec.get(f"score{a}") is None else float(rec.get(f"score{a}"))
                       for a in axis_list],
        })
    nxt = offset + part.height if offset + part.height < total else None
    out = {"status": "success", "resultId": result_id, "offset": offset,
           "limit": limit, "total": total, "nextOffset": nxt,
           "axes": axis_list, "rows": out_rows,
           "meta": {"dataRevision": meta.get("dataRevision"),
                    "schemaRevision": meta.get("schemaRevision"),
                    "resultState": meta.get("resultState")}}
    check_json_finite(out)
    return out


def _efa_scope_ids(manifest, req) -> list:
    from ..domain.context import AnalysisContext as _AC
    from ..domain.context import resolve_scope as _resolve
    ctx = req.context.model_dump() if hasattr(req.context, "model_dump") else req.context
    df = store.get_dataframe(manifest.get("ownerDatasetId"), columns=["__rowId__"])
    all_ids = [str(v) for v in df["__rowId__"].to_list()]
    legacy = _AC(datasetId=manifest.get("ownerDatasetId"),
                 expectedDataRevision=ctx.get("expectedDataRevision"),
                 expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
                 scope=ctx.get("scope", "all"), rowIds=ctx.get("rowIds"),
                 activeRowIds=ctx.get("activeRowIds"),
                 selectedRowIds=ctx.get("selectedRowIds"),
                 sampledRowIds=ctx.get("sampledRowIds"))
    return _resolve(all_ids, legacy)


def _efa_check_fresh(manifest, req_ctx: dict, *, op: str) -> None:
    """E007: refuse new predictions/saves from a stale fit (409).

    Compares the request revisions against the CURRENT dataset revisions
    and the FIT revisions stored in the manifest. A fit followed by a
    materialize (schema bump) must not accept predict/materialize with a
    fresh context on the old resultId -- except an idempotent materialize
    replay, which is handled by the caller before this check.
    """
    from ..domain.context import collect_revisions as _cr
    dataset_id = manifest.get("ownerDatasetId")
    if req_ctx.get("datasetId") != dataset_id:
        _err("ANALYSIS_DATASET_MISMATCH", "結果の所有データセットと一致しません。", 422,
             details={"ownerDatasetId": dataset_id})
    meta = manifest.get("meta") or {}
    fit_data_rev = meta.get("dataRevision")
    fit_schema_rev = meta.get("schemaRevision")
    try:
        cur_meta = store.get_meta(dataset_id)
        cur_code = store.load_codebook(dataset_id) or {}
        cur_rev = _cr(cur_meta, cur_code)
    except Exception:
        _err("ANALYSIS_RESULT_NOT_FOUND", "dataset deleted", 404)
    if (cur_rev["dataRevision"] != fit_data_rev
            or cur_rev["schemaRevision"] != fit_schema_rev):
        _err("ANALYSIS_INPUT_STALE", "古い結果での新規操作はできません。再実行してください。",
             409, details={"operation": op,
                           "fitDataRevision": fit_data_rev,
                           "fitSchemaRevision": fit_schema_rev,
                           "currentDataRevision": cur_rev["dataRevision"],
                           "currentSchemaRevision": cur_rev["schemaRevision"]})
    if (req_ctx.get("expectedDataRevision") != fit_data_rev
            or req_ctx.get("expectedSchemaRevision") != fit_schema_rev):
        _err("ANALYSIS_INPUT_STALE", "入力の世代が更新されています。", 409,
             details={"operation": op})


def efa_predict(result_id, manifest, req):
    import uuid as _uuid
    from ..domain.analysis_contracts import PredictRequest as _PR
    if not isinstance(req, _PR):
        try:
            req = _PR.model_validate(req.model_dump() if hasattr(req, "model_dump") else req)
        except ValidationError:
            _err("ANALYSIS_REQUEST_INVALID", "bad predict", 422)
    _efa_check_fresh(manifest, req.context.model_dump(), op="predict")
    arrays = result_store.load_arrays(result_id)
    encoding = manifest.get("encoding") or {}
    mean = encoding.get("scoreMean")
    sd = encoding.get("scoreSd")
    if mean is None or sd is None or "scoreCoefficients" not in arrays:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "scores unavailable", 422,
             details={"reason": "FA_SCORE_UNAVAILABLE"})
    coef = np.asarray(arrays["scoreCoefficients"], dtype=float)
    mean_a = np.asarray(mean, dtype=float)
    sd_a = np.asarray(sd, dtype=float)
    config = manifest.get("config") or {}
    variables = config.get("variables") or []
    codebook = store.load_codebook(manifest.get("ownerDatasetId")) or {}
    name_by_cid = {}
    for v in variables:
        cid = str(v.get("columnId"))
        for spec in (codebook.get("columns", []) or []):
            if isinstance(spec, dict) and (
                    spec.get("columnId") == cid or spec.get("name") == cid):
                name_by_cid[cid] = spec["name"]
                break
        name_by_cid.setdefault(cid, cid)
    scope_ids = _efa_scope_ids(manifest, req)
    df = store.get_dataframe(manifest.get("ownerDatasetId"),
                             columns=["__rowId__", *[name_by_cid[str(v.get("columnId"))]
                                                     for v in variables]])
    by_id = {str(rr["__rowId__"]): rr for rr in df.rows(named=True)}
    q = int((manifest.get("summary") or {}).get("nFactors", 0))
    statuses: list = []
    rows_out: list = []
    from ..domain.codebook_adapter import normalize_code as _nc
    for rid in scope_ids:
        rec = by_id.get(str(rid))
        if rec is None:
            statuses.append("invalid")
            rows_out.append({"rowId": str(rid), "scores": [None] * q,
                             "predictionStatus": "invalid"})
            continue
        vec = []
        missing = False
        for v in variables:
            cid = str(v.get("columnId"))
            name = name_by_cid[cid]
            raw = rec.get(name)
            treat = str(v.get("treatment", "continuous"))
            if treat == "continuous":
                # Same判定 as fit: missingCodes (codes + numeric values) ->
                # missing; non-numeric non-missing -> invalid(=missing row).
                spec = next((s for s in (codebook.get("columns", []) or [])
                             if isinstance(s, dict) and (
                                 s.get("columnId") == cid or s.get("name") == name)),
                            {})
                mcodes = {c for c in (_nc(c) for c in (spec.get("missingCodes") or []))
                          if c is not None}
                mnums: set = set()
                for mc in mcodes:
                    try:
                        mnums.add(float(mc))
                    except (ValueError, TypeError):
                        pass
                code = _nc(raw)
                f = float("nan")
                if raw is not None and code is not None and code not in mcodes:
                    try:
                        f = float(raw)
                    except (TypeError, ValueError):
                        f = float("nan")
                if code is None or code in mcodes or (np.isfinite(f) and f in mnums):
                    missing = True
                    break
                if not np.isfinite(f):
                    missing = True
                    break
                vec.append(f)
            else:
                order = [str(c) for c in (v.get("categoryOrder") or [])]
                pos = {c: i for i, c in enumerate(order)}
                code = _nc(raw)
                if code is None or code not in pos:
                    missing = True
                    break
                r = pos[code]
                if v.get("reverse"):
                    r = len(order) - 1 - r
                vec.append(float(r + 1))
        if missing:
            statuses.append("missing")
            rows_out.append({"rowId": str(rid), "scores": [None] * q,
                             "predictionStatus": "missing"})
            continue
        z = (np.asarray(vec, dtype=float) - mean_a) / sd_a
        s = (z @ coef).tolist()
        statuses.append("ok")
        rows_out.append({"rowId": str(rid),
                         "scores": [float(v) for v in s],
                         "predictionStatus": "ok"})
    prediction_id = f"pred-{_uuid.uuid4().hex[:12]}"
    pdf = pl.DataFrame({
        "rowId": [r["rowId"] for r in rows_out],
        "status": statuses,
        **{f"score{a+1}": [(r["scores"][a] if r["scores"][a] is not None else None)
                           for r in rows_out] for a in range(q)},
    })
    result_store.save_prediction_rows(result_id, prediction_id, pdf)
    status_counts = {k: 0 for k in ("ok", "unknown_category", "missing",
                                    "invalid", "unavailable")}
    for s in statuses:
        status_counts[s if s in status_counts else "unavailable"] += 1
    out = {"status": "success", "resultId": result_id,
           "predictionId": prediction_id,
           "summary": {"requestedCount": len(scope_ids),
                       "successfulPredictions": status_counts["ok"],
                       "failedPredictions": len(scope_ids) - status_counts["ok"],
                       "statusCounts": status_counts, "evaluation": None},
           "meta": {"resultState": "current"},
           "unavailableReasons": {}}
    check_json_finite(out)
    return out


def efa_materialize(result_id, manifest, req):
    import re as _re
    from ..domain.analysis_contracts import MaterializeRequest as _MR
    if not isinstance(req, _MR):
        try:
            req = _MR.model_validate(req.model_dump() if hasattr(req, "model_dump") else req)
        except ValidationError:
            _err("ANALYSIS_REQUEST_INVALID", "bad materialize", 422)
    caps = manifest.get("capabilities") or {}
    if not caps.get("materialize"):
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "materialize unavailable", 422,
             details={"reason": "FA_SCORE_UNAVAILABLE"})
    ctx = req.context.model_dump()
    if ctx.get("datasetId") != manifest.get("ownerDatasetId"):
        _err("ANALYSIS_DATASET_MISMATCH", "結果の所有データセットと一致しません。", 422)
    rows_df = result_store.load_rows(result_id)
    if rows_df is None:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
    import hashlib as _hl
    import json as _js
    import uuid as _uuid2
    # E008 (2nd round): the idempotency KEY is the user key + resultId
    # only. Source and request scope/columns are part of the STORED
    # payload, so resends with a different source or range conflict
    # instead of aliasing. Context scope ids are normalized to sorted
    # lists so equivalent requests hash identically.
    source = str(getattr(req, "source", "fit") or "fit")
    if source == "fit":
        allowed = set((caps.get("materializeFitFields", [])))
    else:
        allowed = set((caps.get("materializePredictionFields", [])))
    mappings: list[tuple[str, str]] = []
    for col in (req.columns or []):
        src = str(col.get("source", ""))
        dest = str(col.get("name", ""))
        if src not in allowed:
            _err("ANALYSIS_REQUEST_INVALID", "未対応の保存列です。", 422)
        if not dest or not _re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", dest):
            _err("ANALYSIS_REQUEST_INVALID", "列名が不正です。", 422)
        mappings.append((src, dest))

    def _norm_ids(v) -> list | None:
        if v is None:
            return None
        try:
            return sorted({str(x) for x in v})
        except TypeError:
            return None

    payload_canon = _js.dumps({"resultId": result_id, "source": source,
                               "columns": req.columns,
                               "scope": ctx.get("scope", "all"),
                               "rowIds": _norm_ids(ctx.get("rowIds")),
                               "activeRowIds": _norm_ids(ctx.get("activeRowIds")),
                               "selectedRowIds": _norm_ids(ctx.get("selectedRowIds")),
                               "sampledRowIds": _norm_ids(ctx.get("sampledRowIds"))},
                              ensure_ascii=False, sort_keys=True,
                              separators=(",", ":"), default=str)
    payload_hash = _hl.sha256(payload_canon.encode()).hexdigest()
    idem_key = f"efa:{result_id}:{req.idempotencyKey}"
    with store.lock(manifest.get("ownerDatasetId")):
        from ..domain.context import collect_revisions as _cr
        from ..domain.provenance import new_operation_id
        from ..services.dataset_service import now_iso
        provenance_before = store.load_provenance(manifest.get("ownerDatasetId")) or {}
        for op in (provenance_before.get("operations") or []):
            params = op.get("params") or {}
            if params.get("efaIdempotencyKey") == idem_key:
                if params.get("efaPayloadHash") != payload_hash:
                    _err("IDEMPOTENCY_CONFLICT",
                         "idempotencyKey が別payloadで使用済みです。", 409)
                out = {"status": "success", "resultId": result_id,
                       "idempotentReplay": True,
                       "columns": params.get("efaColumns"),
                       "datasetId": manifest.get("ownerDatasetId"),
                       "dataRevision": op["outputDataRevision"],
                       "schemaRevision": op["outputSchemaRevision"]}
                check_json_finite(out)
                return out
        # E007: stale-fit guard BEFORE writing, but AFTER the replay check
        # so an identical resend still returns the stored response.
        _efa_check_fresh(manifest, ctx, op="materialize")
        meta_now = store.get_meta(manifest.get("ownerDatasetId"))
        codebook = store.load_codebook(manifest.get("ownerDatasetId")) or {}
        cur = _cr(meta_now, codebook)
        if (cur["dataRevision"] != ctx.get("expectedDataRevision")
                or cur["schemaRevision"] != ctx.get("expectedSchemaRevision")):
            _err("ANALYSIS_INPUT_STALE", "入力の世代が更新されています。", 409)
        df = store.get_dataframe(manifest.get("ownerDatasetId"))
        existing = {c.get("name") for c in (codebook.get("columns", []) or [])}
        existing |= {c.get("name") for c in (meta_now.get("schema", []) or [])}
        existing.update(df.columns)
        clash = []
        for _, dest in mappings:
            if dest in existing:
                clash.append(dest)
            existing.add(dest)
        if clash:
            _err("COLUMN_ALREADY_EXISTS", "列が既に存在します。", 409,
                 details={"columns": clash})
        scope_ids = set(_efa_scope_ids(manifest, req))
        if source == "fit":
            src_frame = rows_df
            src_col = lambda idx: f"score{idx+1}"
        else:
            src_frame = result_store.load_prediction_rows(result_id, source)
            if src_frame is None:
                _err("ANALYSIS_RESULT_NOT_FOUND", "prediction が見つかりません。", 404)
            src_col = lambda idx: f"score{idx+1}"
        by_id = {str(r["rowId"]): r for r in src_frame.rows(named=True)}
        fields = []
        for src, dest in mappings:
            idx = int(src.split(":")[1]) - 1
            vals = []
            for rid in [str(v) for v in df["__rowId__"].to_list()]:
                rec = by_id.get(rid) if rid in scope_ids else None
                vals.append(None if rec is None else rec.get(src_col(idx)))
            if all(v is None for v in vals):
                _err("LR_FIELD_UNAVAILABLE", "保存できる値がありません。", 422)
            fields.append({"source": src, "name": dest, "values": vals,
                           "label": dest})
        for f in fields:
            df = df.with_columns(pl.Series(f["name"], f["values"], dtype=pl.Float64))
        for f in fields:
            col_id = f"col-{_uuid2.uuid4().hex[:12]}"
            f["columnId"] = col_id
            codebook.setdefault("columns", []).append({
                "columnId": col_id, "name": f["name"],
                "label": f["label"] or f["name"],
                "role": "other", "scaleType": "interval", "derived": True,
                "origin": {"method": "efa", "resultId": result_id,
                           "source": source, "sourceField": f["source"]}})
        codebook["schemaRevision"] = int(codebook.get(
            "schemaRevision", meta_now.get("schemaRevision", 1))) + 1
        schema = list(meta_now.get("schema", []) or [])
        for f in fields:
            schema.append({"columnId": f["columnId"], "name": f["name"],
                           "semanticType": "numeric"})
        meta_now["schema"] = schema
        meta_now["schemaRevision"] = int(codebook.get("schemaRevision", 1))
        step = {"operationId": new_operation_id(),
                "parentOperationId": provenance_before.get("currentOperationId"),
                "operation": "calculate",
                "params": {"efaResultId": result_id, "efaSource": source,
                           "efaFields": fields,
                           "efaIdempotencyKey": idem_key,
                           "efaPayloadHash": payload_hash,
                           "efaColumns": [{"source": k, "name": v}
                                          for k, v in mappings]},
                "targetRowIds": sorted(scope_ids),
                "targetCells": [],
                "inputSchemaRevision": int(codebook.get("schemaRevision", 1)) - 1,
                "outputSchemaRevision": int(codebook.get("schemaRevision", 1)),
                "algorithmVersion": ALGORITHM_VERSION,
                "timestamp": now_iso(), "createdBy": "local-session"}
        store.commit_data_change(manifest.get("ownerDatasetId"), meta_now, df,
                                 codebook=codebook, step=step)
        fresh_meta = store.get_meta(manifest.get("ownerDatasetId"))
        fresh_cb = store.load_codebook(manifest.get("ownerDatasetId")) or {}
    out = {"status": "success", "resultId": result_id,
           "idempotentReplay": False,
           "columns": [{"source": k, "name": v} for k, v in mappings],
           "datasetId": manifest.get("ownerDatasetId"),
           "dataRevision": int(fresh_meta.get("dataRevision", 1)),
           "schemaRevision": int(fresh_cb.get(
               "schemaRevision", fresh_meta.get("schemaRevision", 1)))}
    check_json_finite(out)
    return out


def efa_export_table(manifest, meta, result_id, req):
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
    details = manifest.get("details") or {}
    summary = manifest.get("summary") or {}
    if table == "variables":
        cids = [v.get("columnId") for v in (details.get("variables") or [])]
        pat = details.get("pattern") or []
        struct = details.get("structure") or []
        comm = details.get("communality") or []
        uniq = details.get("uniqueness") or []
        q = int(summary.get("nFactors", 0))
        header = (["columnId", "label", "communality", "uniqueness"]
                  + [f"pattern_F{i+1}" for i in range(q)]
                  + [f"structure_F{i+1}" for i in range(q)])
        rows_all = []
        for j, cid in enumerate(cids):
            v = (details.get("variables") or [])[j]
            rows_all.append(
                [cid, v.get("label"),
                 comm[j] if j < len(comm) else None,
                 uniq[j] if j < len(uniq) else None]
                + [(pat[j][a] if j < len(pat) and a < len(pat[j]) else None)
                   for a in range(q)]
                + [(struct[j][a] if j < len(struct) and a < len(struct[j]) else None)
                   for a in range(q)])
    elif table == "diagnostics":
        r = details.get("sampleCorrelation") or []
        rep = details.get("reproducedCorrelation") or []
        resid = details.get("residualCorrelation") or []
        p = len(r)
        header = ["row", "column", "observed", "reproduced", "residual"]
        rows_all = [[i, j, r[i][j], rep[i][j], resid[i][j]]
                    for i in range(p) for j in range(p)
                    if i < len(rep) and j < len(rep[i])]
    elif table == "parallel_analysis":
        pa = details.get("parallelAnalysis") or {}
        obs = pa.get("observedEigenvalues") or []
        ref = pa.get("referenceQuantiles") or []
        header = ["rank", "observed", "referenceQuantile"]
        rows_all = [[i + 1, obs[i] if i < len(obs) else None,
                     ref[i] if i < len(ref) else None]
                    for i in range(max(len(obs), len(ref)))]
    elif table == "factor_comparisons":
        header = ["q", "status", "objective", "rmsr", "solutionStatus",
                  "reasonCode"]
        rows_all = [[c.get("q"), c.get("status"), c.get("objective"),
                     c.get("rmsr"), c.get("solutionStatus"),
                     c.get("reasonCode")]
                    for c in (details.get("factorComparisons") or [])]
    elif table == "rows":
        rows_df = _store.load_rows(result_id)
        if rows_df is None:
            _err("ANALYSIS_OPERATION_UNSUPPORTED", "no rows", 422)
        header = ["rowId"] + [c for c in rows_df.columns if c != "rowId"]
        rows_all = [[str(rec.get("rowId"))] + [rec.get(c) for c in header[1:]]
                    for rec in rows_df.rows(named=True)]
    else:
        _err("ANALYSIS_EXPORT_UNSUPPORTED", "bad table", 422)
    total = len(rows_all)
    part = rows_all[offset:offset + limit]
    nxt = offset + len(part) if offset + len(part) < total else None
    if fmt == "json":
        body = {"columns": header, "rows": part}
        payload_text = _json.dumps(body, ensure_ascii=False, allow_nan=False)
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


@router.get("/analysis-attempts/{attempt_id}")
def get_attempt(attempt_id: str):
    try:
        rec = _load_attempt(attempt_id)
    except BizError:
        _err("ANALYSIS_ATTEMPT_NOT_FOUND", "試行が見つかりません。", 404)
    return {"status": "success", **rec}


@router.get("/analysis-attempts/{attempt_id}/diagnostics")
def get_attempt_diagnostics(attempt_id: str, offset: int = 0, limit: int = 500):
    try:
        rec = _load_attempt(attempt_id)
    except BizError:
        _err("ANALYSIS_ATTEMPT_NOT_FOUND", "試行が見つかりません。", 404)
    if limit < 1 or limit > 10000 or offset < 0:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    diags = list(rec.get("diagnostics") or [])
    total = len(diags)
    part = diags[offset:offset + limit]
    nxt = offset + len(part) if offset + len(part) < total else None
    out = {"status": "success", "attemptId": str(attempt_id), "offset": offset,
           "limit": limit, "total": total, "nextOffset": nxt,
           "diagnostics": part}
    check_json_finite(out)
    return out


@router.get("/analysis-comparisons/{comparison_id}")
def get_comparison(comparison_id: str):
    try:
        rec = _load_comparison(comparison_id)
    except BizError:
        _err("ANALYSIS_COMPARISON_NOT_FOUND", "比較が見つかりません。", 404)
    _check_comparison_fresh(rec)
    out = {"status": "success", **rec}
    check_json_finite(out)
    return out


def _check_comparison_fresh(rec: dict) -> None:
    """E011: comparisons report dataset deletion / revision drift as stale."""
    dataset_id = rec.get("datasetId")
    if not dataset_id:
        return
    try:
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        rev = collect_revisions(meta, codebook)
    except BizError as exc:
        if exc.code == "DATASET_NOT_FOUND":
            rec["stale"] = True
            rec["staleReason"] = "DATASET_DELETED"
            return
        raise
    if (rev.get("dataRevision") != rec.get("dataRevision")
            or rev.get("schemaRevision") != rec.get("schemaRevision")):
        rec["stale"] = True
        rec["staleReason"] = "DATASET_REVISION_CHANGED"
    else:
        rec["stale"] = False
        rec.pop("staleReason", None)


@router.get("/analysis-comparisons/{comparison_id}/export")
def export_comparison(comparison_id: str, table: str = "manifest",
                      offset: int = 0, limit: int = 500):
    import json as _json
    try:
        rec = _load_comparison(comparison_id)
    except BizError:
        _err("ANALYSIS_COMPARISON_NOT_FOUND", "比較が見つかりません。", 404)
    if limit < 1 or limit > 10000 or offset < 0:
        _err("ANALYSIS_REQUEST_INVALID", "offset/limit が不正です。", 422)
    if table == "manifest":
        body = {"comparisonId": comparison_id,
                "status": rec.get("status"),
                "assessment": rec.get("assessment"),
                "alignment": rec.get("alignment"),
                "metrics": rec.get("metrics")}
        payload_text = _json.dumps(body, ensure_ascii=False, allow_nan=False)
    elif table in ("items", "metrics", "diagnostics"):
        rows = rec.get("items") if table == "items" else [rec.get("metrics")]
        body = {"columns": ["payload"],
                "rows": [[_json.dumps(rows, ensure_ascii=False)]]}
        payload_text = _json.dumps(body, ensure_ascii=False, allow_nan=False)
    else:
        _err("ANALYSIS_EXPORT_UNSUPPORTED", "bad table", 422)
    out = {"status": "success", "mime": "application/json",
           "fileName": f"{comparison_id}-{table}.json", "encoding": "utf-8",
           "payload": payload_text, "offset": offset,
           "total": 1, "nextOffset": None, "hasHeader": False,
           "snapshot": {"comparisonId": comparison_id}}
    check_json_finite(out)
    return out


@router.post("/analysis-comparisons/{comparison_id}/cancel")
def cancel_comparison(comparison_id: str):
    with _comparison_lock(comparison_id):
        try:
            rec = _load_comparison(comparison_id)
        except BizError:
            _err("ANALYSIS_COMPARISON_NOT_FOUND", "比較が見つかりません。", 404)
        if rec.get("status") in ("completed", "failed", "cancelled"):
            out = {"status": "success", "comparisonId": comparison_id,
                   "cancelled": False, "comparisonStatus": rec.get("status")}
            check_json_finite(out)
            return out
        ev = _comparison_cancel.get(comparison_id)
        if ev is None:
            ev = threading.Event()
            _comparison_cancel[comparison_id] = ev
        ev.set()
    # E011 3rd round: signal the background worker via the cancel event;
    # the worker observes it at the next PA chunk boundary and persists a
    # cancelled record itself. Set the flag under lock, then join briefly
    # so GET observes a settled state quickly.
    th = _comparison_threads.get(comparison_id)
    if th is not None and th.is_alive():
        th.join(timeout=30.0)
    try:
        with _comparison_lock(comparison_id):
            cur = _load_comparison(comparison_id)
            if cur.get("status") == "running":
                cur["status"] = "cancelled"
                cur["stage"] = "cancelled"
                cur["reasonCode"] = "COMPARISON_CANCELLED"
                cur["assessment"] = None
                cur["cancelNote"] = ("cancel requested; worker did not settle "
                                     "in time, marked cancelled, main result untouched")
                _remember_comparison(cur)
            rec = cur
    except Exception:
        pass
    out = {"status": "success", "comparisonId": comparison_id,
           "cancelled": True, "comparisonStatus": rec.get("status")}
    check_json_finite(out)
    return out
