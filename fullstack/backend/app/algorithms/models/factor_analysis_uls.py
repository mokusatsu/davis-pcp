"""Single ULS-family MINRES engine (objectiveId=uls_profile_full_v1).

Design: DAVIS-FEAT-033-DESIGN.md section 4.1. NumPy + SciPy only.

For diagonal parameters u in [lower, 1]: A(u) = R - diag(u); from the top-q
eigendecomposition L(u) = E_q diag(sqrt(max(d, 0))); profile objective
F_profile(u) = ||A(u) - L(u) L(u)'||_F^2 (diagonal residuals included).
The representative off-diagonal diagnostic F_off = sum_{i<j}(R - L L')^2
is reported separately and never confused with the optimized objective.

Optimizer: L-BFGS-B, ftol=1e-12, gtol=1e-7, maxls=50, configurable maxiter.
Analytic gradient in differentiable regions: -2 diag(A - L L').
Initial u = clip(1/diag(R^-1), lower, 1); extra starts are seeded PCG64
Uniform(max(lower, .05), .95) per component. Success requires finite value,
solver success, projectedGradientInfNorm <= 1e-5. Adopt min objective;
ties within 1e-10 prefer the smaller start index.

Final communality h^2 = diag(L L'); reported uniqueness psi = 1 - h^2.
The optimized diagonal u is NOT the reported psi; both are returned.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import linalg, optimize

OBJECTIVE_ID = "uls_profile_full_v1"
FTOL = 1e-12
GTOL = 1e-7
MAXLS = 50
GRAD_TOL = 1e-5
TIE_TOL = 1e-10


def _top_q_loadings(a: np.ndarray, q: int) -> tuple[np.ndarray, np.ndarray]:
    d, e = linalg.eigh(a)
    idx = np.argsort(d)[::-1][:q]
    dq = np.maximum(d[idx], 0.0)
    eq = e[:, idx]
    loadings = eq * np.sqrt(dq)[None, :]
    return loadings, d


def uls_profile_objective(u: np.ndarray, r: np.ndarray, q: int) -> tuple[float, np.ndarray]:
    """Profile objective and loadings for diagonal u."""
    u = np.asarray(u, dtype=float)
    a = r - np.diag(u)
    loadings, _ = _top_q_loadings(a, q)
    resid = a - loadings @ loadings.T
    return float(np.sum(resid * resid)), loadings


def uls_profile_gradient(u: np.ndarray, r: np.ndarray, q: int) -> np.ndarray:
    """Analytic gradient -2 diag(A - L L') in differentiable regions."""
    u = np.asarray(u, dtype=float)
    a = r - np.diag(u)
    loadings, _ = _top_q_loadings(a, q)
    resid = a - loadings @ loadings.T
    return -2.0 * np.diag(resid)


def _initial_u(r: np.ndarray, lower: float) -> np.ndarray:
    p = r.shape[0]
    try:
        inv = linalg.solve(r, np.eye(p), assume_a="pos")
        smc = 1.0 / np.clip(np.diag(inv), 1e-12, None)
    except Exception:
        smc = np.full(p, 0.5)
    return np.clip(smc, lower, 1.0)


def _projected_grad_norm(grad: np.ndarray, u: np.ndarray, lower: float) -> float:
    g = np.asarray(grad, dtype=float)
    u = np.asarray(u, dtype=float)
    proj = g.copy()
    at_lower = u <= lower + 1e-12
    at_upper = u >= 1.0 - 1e-12
    proj[at_lower & (g > 0)] = 0.0
    proj[at_upper & (g < 0)] = 0.0
    return float(np.max(np.abs(proj))) if proj.size else 0.0


def fit_uls_profile(r: np.ndarray, q: int, *, lower: float = 0.005,
                    n_starts: int = 5, maxiter: int = 2000,
                    seed: int = 42) -> dict[str, Any]:
    """Fit the single ULS-family engine with constrained multi-starts."""
    r = np.asarray(r, dtype=float)
    p = r.shape[0]
    rng = np.random.default_rng(seed)
    inits = [_initial_u(r, lower)]
    lo_rand = max(lower, 0.05)
    for _ in range(max(0, n_starts - 1)):
        inits.append(rng.uniform(lo_rand, 0.95, size=p))
    bounds = [(float(lower), 1.0)] * p
    starts: list[dict[str, Any]] = []
    for s, u0 in enumerate(inits):
        try:
            res = optimize.minimize(
                fun=lambda u: uls_profile_objective(np.asarray(u), r, q)[0],
                x0=np.asarray(u0, dtype=float),
                jac=lambda u: uls_profile_gradient(np.asarray(u), r, q),
                method="L-BFGS-B", bounds=bounds,
                options={"ftol": FTOL, "gtol": GTOL, "maxiter": int(maxiter),
                         "maxls": MAXLS})
        except Exception as exc:
            starts.append({"startIndex": s, "initialU": [float(v) for v in np.asarray(u0).tolist()],
                           "status": "failed", "reasonCode": "FA_NONCONVERGENCE",
                           "detail": str(exc)[:200]})
            continue
        u = np.asarray(res.x, dtype=float)
        val, loadings = uls_profile_objective(u, r, q)
        grad = uls_profile_gradient(u, r, q)
        pgn = _projected_grad_norm(grad, u, lower)
        ok = bool(res.success) and bool(np.isfinite(val)) and pgn <= GRAD_TOL
        starts.append({"startIndex": s, "initialU": [float(v) for v in np.asarray(u0).tolist()],
                       "status": "success" if ok else "failed",
                       "reasonCode": None if ok else "FA_NONCONVERGENCE",
                       "iterations": int(getattr(res, "nit", 0) or 0),
                       "objective": float(val) if np.isfinite(val) else None,
                       "projectedGradientNorm": float(pgn),
                       "solutionU": [float(v) for v in u.tolist()]})
    winners = [s for s in starts if s["status"] == "success" and s["objective"] is not None]
    if not winners:
        return {"status": "failed", "reasonCode": "FA_NONCONVERGENCE",
                "objectiveId": OBJECTIVE_ID, "starts": starts,
                "loadings": None, "u": None, "psi": None, "communality": None,
                "objective": None, "offDiagonalSse": None, "selectedStartIndex": None}
    best_val = min(s["objective"] for s in winners)
    tied = [s for s in winners if abs(s["objective"] - best_val) <= TIE_TOL]
    best = min(tied, key=lambda s: s["startIndex"])
    u = np.asarray(best["solutionU"], dtype=float)
    _, loadings = uls_profile_objective(u, r, q)
    h2 = np.asarray(np.diag(loadings @ loadings.T), dtype=float).ravel()
    psi = 1.0 - h2
    f_off = float(np.sum(np.triu(r - loadings @ loadings.T, k=1) ** 2))
    return {"status": "success", "reasonCode": None, "objectiveId": OBJECTIVE_ID,
            "starts": starts, "loadings": loadings, "u": u, "psi": psi,
            "communality": h2, "objective": float(best["objective"]),
            "offDiagonalSse": f_off, "selectedStartIndex": int(best["startIndex"])}


def finite_difference_gradient(fun, u: np.ndarray, eps: float = 1e-7) -> np.ndarray:
    """Central finite-difference gradient for analytic-gradient verification."""
    u = np.asarray(u, dtype=float)
    g = np.zeros_like(u)
    for i in range(u.size):
        du = np.zeros_like(u)
        du[i] = eps
        g[i] = (fun(u + du) - fun(u - du)) / (2 * eps)
    return g
