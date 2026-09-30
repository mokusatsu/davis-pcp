"""Conjoint choice/ranking stage-likelihood kernel (Feature 034, production).

Implements DAVIS-FEAT-034-DESIGN sections 5.1-5.2 on encoded design rows:

- choice stages are tasks; ranking expands to J-1 sequential stages that
  keep the original task/respondent identity (no stage is treated as an
  independent respondent).
- logsumexp probabilities, analytic score/Hessian, internal RMS scaling
  restored to original units, L-BFGS-B without regularization or bounds.
- Complete/quasi-complete separation is checked with a HiGHS LP on the
  chosen-vs-other difference matrix. LP failure or unavailability is
  CONJOINT_SEPARATION_CHECK_FAILED, never a silent pass.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy.optimize import linprog, minimize
from scipy.special import logsumexp

SEPARATION_TOL = 1e-8
SCORE_TOL = 1e-6


def expand_stages(
    *,
    tasks: list[dict[str, Any]],
    mode: str,
) -> list[dict[str, Any]]:
    """Expand choice tasks / ranking tasks into likelihood stages.

    Each task: {respondentId, taskId, rows: [{rowId, x, chosen|rank, weight}]}.
    Ranking rows carry integer rank 1..J (best first); choice rows carry
    chosen bool. Stages keep respondentId/taskId/w_respondent.
    """
    stages: list[dict[str, Any]] = []
    for task in tasks:
        rows = list(task["rows"])
        w = float(task.get("respondentWeight", 1.0))
        if mode == "choice":
            chosen = [r for r in rows if r.get("chosen")]
            stages.append({
                "respondentId": task["respondentId"], "taskId": task["taskId"],
                "stageIndex": 0,
                "members": [{"rowId": r["rowId"], "x": np.asarray(r["x"], dtype=np.float64)}
                            for r in rows],
                "chosenRowId": chosen[0]["rowId"] if chosen else None,
                "weight": w, "setSize": len(rows),
            })
        elif mode == "ranking":
            ordered = sorted(rows, key=lambda r: int(r["rank"]))
            remaining = list(ordered)
            for s in range(len(ordered) - 1):
                if len(remaining) < 2:
                    break
                stages.append({
                    "respondentId": task["respondentId"], "taskId": task["taskId"],
                    "stageIndex": s,
                    "members": [{"rowId": r["rowId"], "x": np.asarray(r["x"], dtype=np.float64)}
                                for r in remaining],
                    "chosenRowId": remaining[0]["rowId"],
                    "weight": w, "setSize": len(remaining),
                })
                remaining = remaining[1:]
        else:
            raise ValueError("CONJOINT_UNKNOWN_MODE")
    return stages


def stage_loglik(beta: np.ndarray, stages: list[dict[str, Any]]) -> float:
    total = 0.0
    for st in stages:
        X = np.vstack([m["x"] for m in st["members"]])
        v = X @ beta
        lse = float(logsumexp(v))
        idx = next(i for i, m in enumerate(st["members"])
                   if m["rowId"] == st["chosenRowId"])
        total += float(st["weight"]) * (float(v[idx]) - lse)
    return total


def stage_score_hessian(
    beta: np.ndarray, stages: list[dict[str, Any]]
) -> tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]:
    """Analytic score/Hessian plus per-respondent score sums U_i."""
    p = int(np.asarray(beta).shape[0])
    score = np.zeros((p,), dtype=np.float64)
    hess = np.zeros((p, p), dtype=np.float64)
    per_resp: dict[str, np.ndarray] = {}
    for st in stages:
        X = np.vstack([m["x"] for m in st["members"]])
        v = X @ beta
        probs = np.exp(v - float(logsumexp(v)))
        idx = next(i for i, m in enumerate(st["members"])
                   if m["rowId"] == st["chosenRowId"])
        s = X[idx] - probs @ X
        diff = X - (probs @ X)[None, :]
        h = (diff * probs[:, None]).T @ diff
        w = float(st["weight"])
        score += w * s
        hess += w * h
        key = str(st["respondentId"])
        per_resp[key] = per_resp.get(key, np.zeros((p,))) + s
    return score, hess, per_resp


def rms_scales(stages: list[dict[str, Any]], p: int) -> np.ndarray:
    acc = np.zeros((p,), dtype=np.float64)
    cnt = 0
    for st in stages:
        X = np.vstack([m["x"] for m in st["members"]])
        centered = X - X.mean(axis=0, keepdims=True)
        acc += (centered * centered).sum(axis=0)
        cnt += X.shape[0]
    with np.errstate(divide="ignore", invalid="ignore"):
        scales = np.sqrt(acc / max(1, cnt))
    scales[~np.isfinite(scales) | (scales <= 0)] = 1.0
    return scales


def check_separation(
    stages: list[dict[str, Any]], p: int,
) -> dict[str, Any]:
    """HiGHS LP separation check on the chosen-vs-other difference matrix.

    Maximizes sum(D v) s.t. D v >= 0, -1 <= v_j <= 1 over nonzero-RMS
    scaled columns. Positive optimum > 1e-8 means an improving direction
    exists (complete/quasi-complete separation).
    """
    rows: list[np.ndarray] = []
    for st in stages:
        X = np.vstack([m["x"] for m in st["members"]])
        idx = next(i for i, m in enumerate(st["members"])
                   if m["rowId"] == st["chosenRowId"])
        for j in range(X.shape[0]):
            if j != idx:
                rows.append(X[idx] - X[j])
    if not rows:
        return {"status": "ok", "maxImprovement": 0.0}
    D = np.vstack(rows)
    rms = np.sqrt((D * D).mean(axis=0))
    keep = np.isfinite(rms) & (rms > 0)
    if not keep.any():
        return {"status": "ok", "maxImprovement": 0.0}
    Ds = D[:, keep] / rms[keep]
    q = int(Ds.shape[1])
    c = -Ds.sum(axis=0)
    try:
        res = linprog(c, A_ub=-Ds, b_ub=np.zeros((Ds.shape[0],)),
                      bounds=[(-1.0, 1.0)] * q, method="highs")
    except Exception as exc:
        raise ValueError("CONJOINT_SEPARATION_CHECK_FAILED") from exc
    if res.status != 0 or not np.isfinite(res.fun):
        raise ValueError("CONJOINT_SEPARATION_CHECK_FAILED")
    improvement = float(-res.fun)
    if improvement > SEPARATION_TOL:
        return {"status": "separated", "maxImprovement": improvement}
    return {"status": "ok", "maxImprovement": improvement}


def fit_conditional_logit(
    stages: list[dict[str, Any]],
    p: int,
    *,
    max_iterations: int = 1000,
) -> dict[str, Any]:
    """Fit the shared stage-likelihood kernel. No regularization, no caps."""
    # Task-centered rank check: a common intercept would lose rank.
    centered_rows: list[np.ndarray] = []
    for st in stages:
        X = np.vstack([m["x"] for m in st["members"]])
        centered_rows.append(X - X.mean(axis=0, keepdims=True))
    C = np.vstack(centered_rows) if centered_rows else np.zeros((0, p))
    if C.shape[0] >= 1:
        sv = np.linalg.svd(C, compute_uv=False)
        tol = max(1e-12, float(np.finfo(float).eps) * max(C.shape)
                  * (float(sv[0]) if len(sv) else 0.0))
        if int((sv > tol).sum()) < p:
            raise ValueError("CONJOINT_DESIGN_RANK_DEFICIENT")
    sep = check_separation(stages, p)
    if sep["status"] == "separated":
        raise ValueError("CONJOINT_SEPARATION")
    scales = rms_scales(stages, p)
    scaled_stages = []
    for st in stages:
        scaled_stages.append({
            **st,
            "members": [{"rowId": m["rowId"], "x": m["x"] / scales}
                        for m in st["members"]],
        })

    def nll(bs: np.ndarray) -> float:
        return -stage_loglik(bs, scaled_stages)

    def jac(bs: np.ndarray) -> np.ndarray:
        s, _, _ = stage_score_hessian(bs, scaled_stages)
        return -s

    res = minimize(nll, np.zeros((p,)), jac=jac, method="L-BFGS-B",
                   options={"ftol": 1e-12, "gtol": 1e-7,
                            "maxiter": int(max_iterations), "maxls": 50})
    beta_scaled = np.asarray(res.x, dtype=np.float64)
    score, hess_scaled, _ = stage_score_hessian(beta_scaled, scaled_stages)
    total_w = float(sum(float(st["weight"]) for st in scaled_stages)) or 1.0
    score_norm = float(np.abs(score).max() / total_w)
    logl = float(-res.fun)
    converged = bool(res.success) and score_norm <= SCORE_TOL and math.isfinite(logl)
    if not converged:
        raise ValueError("CONJOINT_NONCONVERGENCE")
    # Positive-definite + full rank information check in scaled units.
    try:
        eig = np.linalg.eigvalsh(hess_scaled)
    except Exception as exc:
        raise ValueError("CONJOINT_INFORMATION_SINGULAR") from exc
    if not np.all(np.isfinite(eig)) or not bool((eig > 0).all()):
        raise ValueError("CONJOINT_INFORMATION_SINGULAR")
    sv_h = np.linalg.svd(hess_scaled, compute_uv=False)
    tol_h = max(1e-12, float(np.finfo(float).eps) * max(hess_scaled.shape)
                * (float(sv_h[0]) if len(sv_h) else 0.0))
    if int((sv_h > tol_h).sum()) < p:
        raise ValueError("CONJOINT_INFORMATION_SINGULAR")
    inv_scaled = np.linalg.inv(hess_scaled)
    beta = beta_scaled / scales
    bread = (np.diag(1.0 / scales) @ inv_scaled @ np.diag(1.0 / scales))
    return {
        "beta": np.asarray(beta, dtype=np.float64),
        "bread": np.asarray(bread, dtype=np.float64),
        "scales": scales,
        "logLikelihood": logl,
        "scoreInfNorm": score_norm,
        "iterations": int(getattr(res, "nit", 0) or 0),
        "optimizerMessage": str(getattr(res, "message", ""))[:200],
    }
