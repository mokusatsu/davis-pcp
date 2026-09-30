"""Pearson ML factor extraction kernel (Feature 033 EFA).

Design: DAVIS-FEAT-033-DESIGN.md section 4.2. Pearson path only.
Model R ~= Sigma = L L' + Psi, Psi = diag(psi), psi in [lower, 1].

For fixed psi: C = diag(psi)^-1/2 R diag(psi)^-1/2 = E diag(d) E';
L(psi) = diag(sqrt(psi)) E_q diag(sqrt(max(d - 1, 0))).
Full objective always: F(psi) = logdet(Sigma) + trace(R Sigma^-1)
- logdet(R) - p. No reduced q-only substitution even when d_q <= 1.
Sigma logdet/solve via Cholesky; theoretical F >= 0, only rounding
down to -1e-10 is clipped to 0. Large negatives are internal errors.

Profile gradient in differentiable regions:
diag(Sigma^-1 - Sigma^-1 R Sigma^-1), computed as A = solve(Sigma, I),
gradient = diag(A - A R A). L-BFGS-B with analytic jac, ftol=1e-12,
gtol=1e-7, maxls=50. Initial psi_0 = clip((1 - 0.5 q/p)/diag(R^-1));
extra starts seeded PCG64 Uniform(max(lower, .05), .95) per component.
Success: solver success, finite, projectedGradientInfNorm <= 1e-5
(boundary components count gradient as 0 when pointing outward).
Adopt min F; ties within 1e-10 prefer smaller start index.
All-start failure is FA_NONCONVERGENCE: no partial loadings as success.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import linalg, optimize

FTOL = 1e-12
GTOL = 1e-7
MAXLS = 50
GRAD_TOL = 1e-5
TIE_TOL = 1e-10


def ml_profile(psi: np.ndarray, r: np.ndarray, q: int) -> tuple[float, np.ndarray, float]:
    """Full ML objective, loadings, logdet(Sigma) for diagonal psi."""
    psi = np.asarray(psi, dtype=float)
    p = r.shape[0]
    sq = np.sqrt(np.clip(psi, 1e-12, None))
    c = (r / sq[:, None]) / sq[None, :]
    d, e = linalg.eigh(c)
    order = np.argsort(d)[::-1]
    d = d[order]
    e = e[:, order]
    lam = np.maximum(d[:q] - 1.0, 0.0)
    loadings = (sq[:, None] * e[:, :q]) * np.sqrt(lam)[None, :]
    sigma = loadings @ loadings.T + np.diag(psi)
    chol, low = linalg.cho_factor(sigma, check_finite=False)
    logdet_sigma = 2.0 * float(np.sum(np.log(np.diag(chol))))
    sign_r, logdet_r = np.linalg.slogdet(r)
    trace_term = float(np.trace(linalg.cho_solve((chol, low), r, check_finite=False)))
    f = logdet_sigma + trace_term - float(logdet_r) - p
    if f < 0 and f >= -1e-10:
        f = 0.0
    return float(f), loadings, float(logdet_sigma)


def ml_profile_gradient(psi: np.ndarray, r: np.ndarray, q: int) -> np.ndarray:
    """Analytic profile gradient diag(Sigma^-1 - Sigma^-1 R Sigma^-1)."""
    psi = np.asarray(psi, dtype=float)
    _, loadings, _ = ml_profile(psi, r, q)
    sigma = loadings @ loadings.T + np.diag(psi)
    a = linalg.solve(sigma, np.eye(sigma.shape[0]), assume_a="pos")
    return np.asarray(np.diag(a - a @ r @ a), dtype=float).ravel()


def _initial_psi(r: np.ndarray, q: int, lower: float) -> np.ndarray:
    p = r.shape[0]
    try:
        inv = linalg.solve(r, np.eye(p), assume_a="pos")
        smc = 1.0 / np.clip(np.diag(inv), 1e-12, None)
    except Exception:
        smc = np.full(p, 0.5)
    base = (1.0 - 0.5 * q / p) / np.clip(smc, 1e-12, None)
    return np.clip(base, lower, 1.0)


def _projected_grad_norm(grad: np.ndarray, psi: np.ndarray, lower: float) -> float:
    g = np.asarray(grad, dtype=float)
    psi = np.asarray(psi, dtype=float)
    proj = g.copy()
    at_lower = psi <= lower + 1e-12
    at_upper = psi >= 1.0 - 1e-12
    proj[at_lower & (g > 0)] = 0.0
    proj[at_upper & (g < 0)] = 0.0
    return float(np.max(np.abs(proj))) if proj.size else 0.0


def fit_ml_profile(r: np.ndarray, q: int, *, lower: float = 0.005,
                   n_starts: int = 5, maxiter: int = 2000,
                   seed: int = 42) -> dict[str, Any]:
    """Constrained multi-start ML profile optimization."""
    r = np.asarray(r, dtype=float)
    p = r.shape[0]
    rng = np.random.default_rng(seed)
    inits = [_initial_psi(r, q, lower)]
    lo_rand = max(lower, 0.05)
    for _ in range(max(0, n_starts - 1)):
        inits.append(rng.uniform(lo_rand, 0.95, size=p))
    bounds = [(float(lower), 1.0)] * p
    starts: list[dict[str, Any]] = []
    for s, psi0 in enumerate(inits):
        try:
            res = optimize.minimize(
                fun=lambda v: ml_profile(np.asarray(v), r, q)[0],
                x0=np.asarray(psi0, dtype=float),
                jac=lambda v: ml_profile_gradient(np.asarray(v), r, q),
                method="L-BFGS-B", bounds=bounds,
                options={"ftol": FTOL, "gtol": GTOL, "maxiter": int(maxiter),
                         "maxls": MAXLS})
        except Exception as exc:
            starts.append({"startIndex": s,
                           "initialPsi": [float(v) for v in np.asarray(psi0).tolist()],
                           "status": "failed", "reasonCode": "FA_NONCONVERGENCE",
                           "detail": str(exc)[:200]})
            continue
        psi = np.asarray(res.x, dtype=float)
        try:
            val, loadings = ml_profile(psi, r, q)[:2]
            grad = ml_profile_gradient(psi, r, q)
        except Exception:
            starts.append({"startIndex": s,
                           "initialPsi": [float(v) for v in np.asarray(psi0).tolist()],
                           "status": "failed", "reasonCode": "FA_NONCONVERGENCE",
                           "detail": "profile evaluation failed"})
            continue
        pgn = _projected_grad_norm(grad, psi, lower)
        ok = bool(res.success) and bool(np.isfinite(val)) and pgn <= GRAD_TOL
        starts.append({"startIndex": s,
                       "initialPsi": [float(v) for v in np.asarray(psi0).tolist()],
                       "status": "success" if ok else "failed",
                       "reasonCode": None if ok else "FA_NONCONVERGENCE",
                       "iterations": int(getattr(res, "nit", 0) or 0),
                       "objective": float(val) if np.isfinite(val) else None,
                       "projectedGradientNorm": float(pgn),
                       "solutionPsi": [float(v) for v in psi.tolist()]})
    winners = [s for s in starts if s["status"] == "success" and s["objective"] is not None]
    if not winners:
        return {"status": "failed", "reasonCode": "FA_NONCONVERGENCE", "starts": starts,
                "loadings": None, "psi": None, "communality": None, "objective": None,
                "selectedStartIndex": None}
    best_val = min(s["objective"] for s in winners)
    tied = [s for s in winners if abs(s["objective"] - best_val) <= TIE_TOL]
    best = min(tied, key=lambda s: s["startIndex"])
    psi = np.asarray(best["solutionPsi"], dtype=float)
    _, loadings, _ = ml_profile(psi, r, q)
    h2 = np.asarray(np.diag(loadings @ loadings.T), dtype=float).ravel()
    rank = int(np.sum(np.sqrt(np.maximum(np.diag(loadings.T @ loadings), 0.0)) > 1e-8))
    return {"status": "success", "reasonCode": None, "starts": starts,
            "loadings": loadings, "psi": np.asarray(psi, dtype=float),
            "communality": h2, "objective": float(best["objective"]),
            "selectedStartIndex": int(best["startIndex"]),
            "effectiveFactorRank": rank}


def ml_fit_measures(objective: float, n: int, p: int, q: int,
                    r: np.ndarray, boundary: bool = False) -> dict[str, Any]:
    """Reference chi-square/df/p/RMSEA per section 6.3 (Pearson+ML only)."""
    df = ((p - q) ** 2 - p - q) / 2.0
    out: dict[str, Any] = {"df": int(df) if float(df).is_integer() else float(df),
                            "statistic": None, "pValue": None, "rmsea": None,
                            "reasonCode": None}
    c = (n - 1) - (2 * p + 5) / 6.0 - 2.0 * q / 3.0
    if df <= 0 or c <= 0:
        out["reasonCode"] = "FA_INFERENCE_UNAVAILABLE"
        return out
    if boundary:
        out["reasonCode"] = "BOUNDARY_UNIQUENESS"
        return out
    from scipy import stats as _stats

    t = c * objective
    out["statistic"] = float(t)
    out["pValue"] = float(_stats.chi2.sf(t, df))
    out["rmsea"] = float(np.sqrt(max((t - df) / (df * (n - 1)), 0.0)))
    return out


def kmo_measure(r: np.ndarray) -> float | None:
    """KMO from invertible R; null when the denominator is 0."""
    try:
        inv = np.linalg.inv(np.asarray(r, dtype=float))
    except Exception:
        return None
    p = inv.shape[0]
    num = 0.0
    den = 0.0
    for i in range(p):
        for j in range(p):
            if i == j:
                continue
            rij = float(r[i, j])
            pij = -float(inv[i, j]) / math_sqrt(inv[i, i] * inv[j, j])
            num += rij * rij
            den += rij * rij + pij * pij
    if den <= 0:
        return None
    return float(num / den)


def math_sqrt(v: float) -> float:
    import math as _m

    return _m.sqrt(max(v, 1e-300))


def bartlett_sphericity(r: np.ndarray, n: int) -> dict[str, Any]:
    """Reference Bartlett sphericity test (Pearson+ML only, positive coef)."""
    p = np.asarray(r).shape[0]
    coef = (n - 1) - (2 * p + 5) / 6.0
    if coef <= 0:
        return {"statistic": None, "df": int(p * (p - 1) / 2), "pValue": None,
                "reasonCode": "FA_INFERENCE_UNAVAILABLE"}
    sign, logdet = np.linalg.slogdet(np.asarray(r, dtype=float))
    if sign <= 0 or not np.isfinite(logdet):
        return {"statistic": None, "df": int(p * (p - 1) / 2), "pValue": None,
                "reasonCode": "FA_NON_POSITIVE_DEFINITE"}
    from scipy import stats as _stats

    t = -coef * logdet
    df = int(p * (p - 1) / 2)
    return {"statistic": float(t), "df": df, "pValue": float(_stats.chi2.sf(t, df)),
            "reasonCode": None}
