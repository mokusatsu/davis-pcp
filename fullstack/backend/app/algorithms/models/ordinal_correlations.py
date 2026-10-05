"""Pearson + polychoric (tetrachoric) correlation kernels (Feature 033 EFA).

Local/Pyodide shared kernel: NumPy + SciPy only, no polars/fastapi I/O.
Design: feature/analysis-specs/tasks/DAVIS-FEAT-033-DESIGN.md sections 3-3.3.

- Pearson: same fit set, ddof=1 sample covariance/std, R = D^-1 S D^-1.
- Polychoric: two-stage estimation with thresholds shared across all pairs
  (common complete-case set). Pair cell counts n_kl vs latent standard
  bivariate-normal rectangle probabilities p_kl(rho); minimize
  -sum(n_kl log p_kl) over rho in [-0.9999, 0.9999]. 2x2 uses the same
  formula and is recorded as tetrachoric. No 0.5 addition, no category
  merging, no probability clipping, no matrix correction.
- Rectangle probability uses the conditional 1-D integral::

      P = integral_a^b phi(z) { Phi((d-rho z)/s) - Phi((c-rho z)/s) } dz

  with s = sqrt(1-rho^2), absolute/relative tolerance 1e-10.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import integrate, optimize, stats

RHO_BOUND = 0.9999
RHO_ATOL = 1e-8
QUAD_EPSABS = 1e-10
QUAD_EPSREL = 1e-10
BOUNDARY_MARGIN = 1e-5

_GL96 = np.polynomial.legendre.leggauss(96)
_GL48 = np.polynomial.legendre.leggauss(48)


def pearson_correlation(x: np.ndarray) -> dict[str, Any]:
    """Pearson sample correlation from one shared fit matrix (n, p)."""
    x = np.asarray(x, dtype=np.float64)
    n, p = x.shape
    mean = x.mean(axis=0)
    xc = x - mean
    cov = (xc.T @ xc) / max(n - 1, 1)
    sd = np.sqrt(np.clip(np.diag(cov), 0.0, None))
    if np.any(sd <= 0):
        bad = [int(i) for i in np.where(sd <= 0)[0].tolist()]
        raise ValueError(f"PEARSON_CONSTANT_COLUMN:{bad}")
    d_inv = 1.0 / sd
    r = cov * d_inv[:, None] * d_inv[None, :]
    # Symmetrize only rounding-level asymmetry; keep a record for diagnostics.
    asym = float(np.max(np.abs(r - r.T))) if p else 0.0
    r = (r + r.T) / 2.0
    np.fill_diagonal(r, 1.0)
    return {"correlation": r, "mean": mean, "std": sd, "covariance": cov,
            "n": int(n), "maxAsymmetry": asym}


def validate_correlation_matrix(r: np.ndarray) -> dict[str, Any]:
    """Validate R: finite, unit diagonal, symmetric, in-range, PD + Cholesky."""
    r = np.asarray(r, dtype=np.float64)
    p = r.shape[0]
    diags = {
        "finite": bool(np.all(np.isfinite(r))),
        "unitDiagonal": bool(np.allclose(np.diag(r), 1.0, atol=1e-8)),
        "symmetric": bool(np.allclose(r, r.T, atol=1e-8)),
        "inRange": bool(np.all(r >= -1.0 - 1e-8) and np.all(r <= 1.0 + 1e-8)),
    }
    out: dict[str, Any] = {"checks": diags, "positiveDefinite": False,
                            "minEigenvalue": None, "maxEigenvalue": None,
                            "choleskyOk": False, "reasonCode": None}
    if not all(diags.values()):
        out["reasonCode"] = "FA_CORRELATION_INVALID"
        return out
    try:
        eig = np.linalg.eigvalsh(r)
    except Exception:
        out["reasonCode"] = "FA_NON_POSITIVE_DEFINITE"
        return out
    out["minEigenvalue"] = float(eig[0])
    out["maxEigenvalue"] = float(eig[-1])
    if not (eig[0] > 1e-10 * max(eig[-1], 0.0)):
        out["reasonCode"] = "FA_NON_POSITIVE_DEFINITE"
        return out
    try:
        np.linalg.cholesky(r)
        out["choleskyOk"] = True
        out["positiveDefinite"] = True
    except Exception:
        out["reasonCode"] = "FA_NON_POSITIVE_DEFINITE"
    return out


def thresholds_from_cumulative(cum: np.ndarray) -> np.ndarray:
    """Finite interior thresholds tau = Phi^-1(F); endpoints are +-inf."""
    tau = stats.norm.ppf(np.asarray(cum, dtype=float))
    if not np.all(np.isfinite(tau)):
        raise ValueError("FA_UNOBSERVED_CATEGORY")
    return tau


def _norm_cdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def rectangle_probability(a: float, b: float, c: float, d: float,
                          rho: float) -> tuple[float, float]:
    """Latent bivariate-normal rectangle probability via conditional integral.

    Use fast fixed Gauss-Legendre quadrature when its 48/96 comparison meets
    the declared tolerance. Refine otherwise with adaptive integration over
    the full interval; a quadrature limit must not become a false rho bound.
    """
    s2 = 1.0 - rho * rho
    if s2 <= 0:
        raise ValueError("FA_CORRELATION_BOUNDARY")
    s = math.sqrt(s2)
    if not (np.isfinite(a) or np.isfinite(b)) or not (np.isfinite(c) or np.isfinite(d)):
        raise ValueError("FA_CORRELATION_INVALID")
    lo_z = a if np.isfinite(a) else -10.0
    hi_z = b if np.isfinite(b) else 10.0
    try:
        from scipy.special import ndtr as _ndtr
        have_ndtr = True
    except Exception:
        have_ndtr = False
    xs96, w96 = _GL96
    xs48, w48 = _GL48
    mid = 0.5 * (lo_z + hi_z)
    half = 0.5 * (hi_z - lo_z)

    def _rule(xs: np.ndarray, w: np.ndarray) -> float:
        z = mid + half * xs
        phi = np.exp(-0.5 * z * z) / math.sqrt(2.0 * math.pi)
        hi = (d - rho * z) / s if np.isfinite(d) else np.full_like(z, np.inf)
        lo = (c - rho * z) / s if np.isfinite(c) else np.full_like(z, -np.inf)
        if have_ndtr:
            # Subtract survival probabilities in the positive tail, where
            # subtracting two CDFs near one erases small positive cells.
            diff = np.where(lo > 0, _ndtr(-lo) - _ndtr(-hi), _ndtr(hi) - _ndtr(lo))
        else:
            diff = np.asarray([_norm_cdf(float(-l)) - _norm_cdf(float(-h)) if l > 0
                               else _norm_cdf(float(h)) - _norm_cdf(float(l))
                               for l, h in zip(lo, hi)])
        return float(half * np.sum(w * phi * diff))

    val = _rule(xs96, w96) if hi_z > lo_z else 0.0
    coarse = _rule(xs48, w48) if hi_z > lo_z else 0.0
    err = abs(val - coarse)
    tolerance = max(QUAD_EPSABS, QUAD_EPSREL * abs(val))
    if not np.isfinite(val) or val <= 0 or err > tolerance:
        cdf = _ndtr if have_ndtr else _norm_cdf

        def integrand(z: float) -> float:
            upper = (d - rho * z) / s
            lower = (c - rho * z) / s
            probability = (cdf(-lower) - cdf(-upper) if lower > 0
                           else cdf(upper) - cdf(lower))
            return float(math.exp(-0.5 * z * z) / math.sqrt(2.0 * math.pi) * probability)

        # Near unit rho the conditional CDF changes sharply at these points.
        # Segmenting also supports infinite outer endpoints without clipping.
        splits = sorted({float(edge / rho) for edge in (c, d)
                         if rho != 0 and np.isfinite(edge) and a < edge / rho < b})
        edges = [float(a), *splits, float(b)]
        values, errors = [], []
        for left, right in zip(edges[:-1], edges[1:]):
            integral = integrate.quad(integrand, left, right,
                epsabs=QUAD_EPSABS / (len(edges) - 1), epsrel=QUAD_EPSREL,
                limit=200, full_output=1)
            if len(integral) > 3:
                raise ArithmeticError("FA_CORRELATION_INTEGRATION_FAILED: " + str(integral[3])[:200])
            values.append(float(integral[0]))
            errors.append(float(integral[1]))
        val, err = math.fsum(values), math.fsum(errors)
    return float(val), float(err)


def polychoric_pair(counts: np.ndarray, tau_row: np.ndarray,
                    tau_col: np.ndarray) -> dict[str, Any]:
    """Two-stage polychoric correlation for one item pair.

    counts: (Kr, Kc) cell counts; thresholds include +-inf endpoints,
    i.e. len(tau_row) == Kr + 1.
    No continuity correction, no clipping: non-finite probabilities or
    integral errors are estimation failures.
    """
    counts = np.asarray(counts, dtype=float)
    kr, kc = counts.shape
    edges_r = np.concatenate([[-np.inf], np.asarray(tau_row, dtype=float), [np.inf]])
    edges_c = np.concatenate([[-np.inf], np.asarray(tau_col, dtype=float), [np.inf]])
    assert len(edges_r) == kr + 1 and len(edges_c) == kc + 1
    n = float(counts.sum())
    zero_cells = int(np.sum(counts == 0))
    small_cells = int(np.sum((counts > 0) & (counts < 5)))
    integration_failures: list[dict[str, Any]] = []
    integration_failure_count = 0
    max_integration_error = 0.0

    def failed(evaluations: int) -> dict[str, Any]:
        return {"rho": None, "status": "failed", "reasonCode": "FA_CORRELATION_NONCONVERGENCE",
                "n": n, "zeroCells": zero_cells, "smallCells": small_cells,
                "evaluations": evaluations, "integrationError": max_integration_error,
                "integrationFailureCount": integration_failure_count,
                "integrationFailures": integration_failures, "boundary": False}

    def negloglik(rho: float) -> float:
        nonlocal integration_failure_count, max_integration_error
        total = 0.0
        for i in range(kr):
            for j in range(kc):
                nij = counts[i, j]
                if nij == 0:
                    continue
                err = None
                try:
                    p, err = rectangle_probability(edges_r[i], edges_r[i + 1],
                                                   edges_c[j], edges_c[j + 1], float(rho))
                    if np.isfinite(err) and err >= 0:
                        max_integration_error = max(max_integration_error, float(err))
                    if (not np.isfinite(err) or err < 0 or not np.isfinite(p) or p < 0
                            or err > max(QUAD_EPSABS, QUAD_EPSREL * abs(p))):
                        raise ArithmeticError("rectangle probability did not meet integration tolerance")
                except (ArithmeticError, ValueError, RuntimeError) as exc:
                    integration_failure_count += 1
                    if len(integration_failures) < 3:
                        integration_failures.append({"rowCategory": i, "columnCategory": j,
                                                     "rho": float(rho), "detail": str(exc)[:200],
                                                     "estimatedError": float(err) if err is not None and np.isfinite(err) else None})
                    return np.inf
                # Incompatible extreme rhos can legitimately underflow an
                # occupied cell's probability. This is infinite likelihood,
                # distinct from a failed integration/refinement certificate.
                if p == 0.0:
                    return np.inf
                total += float(nij) * math.log(p)
        if not np.isfinite(total):
            return np.inf
        return -total

    # Coarse grid to bracket the optimum, then bounded scalar minimization.
    grid = np.linspace(-RHO_BOUND, RHO_BOUND, 21)
    vals = [negloglik(float(g)) for g in grid]
    if integration_failure_count:
        return failed(len(grid))
    finite = [(v, float(g)) for v, g in zip(vals, grid) if np.isfinite(v)]
    if not finite:
        return failed(len(grid))
    best_rho = min(finite)[1]
    span = 2 * RHO_BOUND / 20
    lo = max(-RHO_BOUND, best_rho - span)
    hi = min(RHO_BOUND, best_rho + span)
    try:
        res = optimize.minimize_scalar(negloglik, bounds=(lo, hi), method="bounded",
                                       options={"xatol": RHO_ATOL, "maxiter": 1000})
    except Exception:
        return failed(len(grid))
    if integration_failure_count or (not res.success) or (not np.isfinite(res.fun)) or (not np.isfinite(res.x)):
        return failed(len(grid) + int(getattr(res, "nfev", 0)))
    rho = float(np.clip(res.x, -RHO_BOUND, RHO_BOUND))
    boundary = bool(abs(abs(rho) - RHO_BOUND) < BOUNDARY_MARGIN or
                    abs(rho) >= RHO_BOUND - BOUNDARY_MARGIN)
    if boundary:
        return {"rho": rho, "status": "boundary", "reasonCode": "FA_CORRELATION_BOUNDARY",
                "n": n, "zeroCells": zero_cells, "smallCells": small_cells,
                "evaluations": len(grid) + int(getattr(res, "nfev", 0)),
                "integrationError": max_integration_error, "boundary": True}
    return {"rho": rho, "status": "success", "reasonCode": None,
            "n": n, "zeroCells": zero_cells, "smallCells": small_cells,
            "evaluations": len(grid) + int(getattr(res, "nfev", 0)),
            "integrationError": max_integration_error, "boundary": False,
            "negLogLik": float(res.fun)}


def polychoric_matrix(codes: np.ndarray, n_categories: list[int]) -> dict[str, Any]:
    """Full polychoric matrix from integer rank codes (n, p), shared thresholds.

    codes: 0-based ranks per item; thresholds derived from pooled cumulative
    proportions. Returns thresholds (interior, probit scale), R, pair records.
    """
    codes = np.asarray(codes)
    n, p = codes.shape
    thresholds: list[np.ndarray] = []
    for j in range(p):
        k = int(n_categories[j])
        col = codes[:, j]
        cum = np.array([np.mean(col < t) for t in range(1, k)], dtype=float)
        thresholds.append(thresholds_from_cumulative(cum))
    r = np.eye(p)
    pairs: list[dict[str, Any]] = []
    for a in range(p):
        for b in range(a + 1, p):
            ka, kb = int(n_categories[a]), int(n_categories[b])
            tab = np.zeros((ka, kb))
            for i in range(n):
                tab[int(codes[i, a]), int(codes[i, b])] += 1.0
            rec = polychoric_pair(tab, thresholds[a], thresholds[b])
            rec.update({"pair": [a, b], "tetrachoric": bool(ka == 2 and kb == 2)})
            pairs.append(rec)
            if rec["rho"] is None:
                return {"correlation": None, "thresholds": thresholds, "pairs": pairs,
                        "status": "failed",
                        "reasonCode": rec.get("reasonCode") or "FA_CORRELATION_NONCONVERGENCE"}
            r[a, b] = r[b, a] = float(rec["rho"])
    boundary = any(rec.get("boundary") for rec in pairs)
    return {"correlation": r, "thresholds": thresholds, "pairs": pairs,
            "status": "boundary" if boundary else "success",
            "reasonCode": "FA_CORRELATION_BOUNDARY" if boundary else None}
