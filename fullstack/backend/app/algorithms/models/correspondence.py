"""Correspondence Analysis pure numeric kernel (Feature 029, production).

Implements the CA design formulas on an already-clean nonnegative table T:
P=T/t, S=D_r^-1/2 (P-rc') D_c^-1/2, thin SVD, principal/standard coordinates,
contributions, cos2, full-spectrum eigenvalues with total-inertia denominator.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import stats

from ..analysis_numerics import check_ratio_bounds, degenerate_blocks, thin_svd


def _normal_or_zero(values: np.ndarray) -> bool:
    return bool(np.isfinite(values).all()
                and ((values == 0) | (np.abs(values) >= np.finfo(np.float64).tiny)).all())


def _numerical_zero_profiles(p: np.ndarray, mass: np.ndarray, center: np.ndarray,
                             normalization_safe: bool) -> np.ndarray:
    """Recognize unresolved profile residuals on the received float64 table.

    For m x n cells, gamma_k = k*u/(1-k*u). The observed row profile has
    absolute error <= A*q, A=(gamma_n+2*u)/(1-u)^2: the common rounded grand
    total cancels from P/r. The opposite mass has error <= B*c, with
    B=(gamma_(mn-1)+gamma_m)/(1-gamma_m). Subtraction adds u*(q+c).
    Nonnegative sums use their worst-case addition count, not a NumPy tree.

    Evaluate this envelope at eps=2*u. Its positive coefficients are at
    least twice their u counterparts. k*eps<1/4 keeps gamma<1/3 and the
    denominator subtractions >2/3; the fixed small evaluation operation
    count has relative error far below 1/2 in the normal range. This
    headroom, not the final nextafter alone, protects the error envelope.
    Outside that model, decline only this extra classification and leave
    the caller's existing distance/zero/bounds behavior unchanged.
    """
    zero = np.zeros(p.shape[0], dtype=bool)
    if not normalization_safe:
        return zero
    m, n = p.shape
    eps = np.finfo(np.float64).eps
    if max(p.size - 1, m, n) * eps >= .25:
        return zero

    def gamma(k):
        return k * eps / (1 - k * eps)

    profile_factor = (gamma(n) + 2 * eps) / (1 - eps)**2 + eps
    center_factor = (gamma(p.size - 1) + gamma(m)) / (1 - gamma(m)) + eps
    with np.errstate(over="ignore", under="ignore", invalid="ignore", divide="ignore"):
        center_error = center_factor * center
        if not _normal_or_zero(center_error) or not (center_error > 0).all():
            return zero
        for i in range(m):
            profile = p[i, :] / mass[i]
            residual = profile - center
            profile_error = profile_factor * profile
            budget = profile_error + center_error
            if (not _normal_or_zero(profile) or not _normal_or_zero(residual)
                    or not _normal_or_zero(profile_error) or not _normal_or_zero(budget)
                    or not np.array_equal(profile == 0, p[i, :] == 0)
                    or not np.array_equal(profile_error == 0, profile == 0)):
                continue
            budget = np.nextafter(budget, np.inf)
            if np.isfinite(budget).all():
                zero[i] = bool((np.abs(residual) <= budget).all())
    return zero


def run_ca_numeric(
    t: np.ndarray,
    *,
    keep_row_index: list[int],
    keep_col_index: list[int],
) -> dict[str, Any]:
    table = np.asarray(t, dtype=np.float64)
    if table.ndim != 2 or not np.isfinite(table).all() or (table < 0).any():
        raise ValueError("CA kernel requires a finite nonnegative table")
    total = float(table.sum())
    if not np.isfinite(total) or total <= 0:
        raise ValueError("CA_EMPTY_TABLE")
    p = table / total
    r = p.sum(axis=1)
    c = p.sum(axis=0)
    if (r <= 0).any() or (c <= 0).any():
        raise ValueError("CA_ZERO_MASS_CATEGORY")
    s_mat = (p - np.outer(r, c)) / np.sqrt(np.outer(r, c))
    u, s, v, total_inertia, svd_info = thin_svd(s_mat)
    rank = int(len(s))
    if rank == 0:
        raise ValueError("CA_ZERO_INERTIA")
    max_rank = min(table.shape[0] - 1, table.shape[1] - 1)
    if rank > max_rank and max_rank >= 0:
        # Beyond rounding: internal invariant failure.
        excess = float(np.square(s[max_rank:]).sum()) if rank > max_rank else 0.0
        if excess > 1e-12:
            raise ValueError("ANALYSIS_NUMERICAL_INVARIANT_FAILED")
        u, s, v = u[:, :max_rank], s[:max_rank], v[:, :max_rank]
        rank = int(len(s))
        if rank == 0:
            raise ValueError("CA_ZERO_INERTIA")
    eigenvalues = s * s
    # Sign convention: column principal coordinate max-abs component positive, ties by catalog order.
    sqrt_r = np.sqrt(r)
    sqrt_c = np.sqrt(c)
    f = u * s / sqrt_r[:, None]
    g = v * s / sqrt_c[:, None]
    phi = u / sqrt_r[:, None]
    gamma = v / sqrt_c[:, None]
    for k in range(rank):
        col = g[:, k]
        idx = int(np.argmax(np.abs(col)))
        if col[idx] < 0:
            u[:, k] *= -1
            v[:, k] *= -1
            f[:, k] *= -1
            g[:, k] *= -1
            phi[:, k] *= -1
            gamma[:, k] *= -1
    total_check = float(np.square(s_mat).sum())
    inertia_ratio = eigenvalues / total_check if total_check > 0 else np.zeros_like(eigenvalues)
    cumulative = np.cumsum(inertia_ratio)
    row_dist2 = np.array([float(np.sum((p[a, :] / r[a] - c) ** 2 / c)) for a in range(p.shape[0])])
    col_dist2 = np.array([float(np.sum((p[:, b] / c[b] - r) ** 2 / r)) for b in range(p.shape[1])])
    normalization_safe = (total >= np.finfo(np.float64).tiny
                          and _normal_or_zero(table) and _normal_or_zero(p)
                          and _normal_or_zero(r) and _normal_or_zero(c)
                          and np.array_equal(p == 0, table == 0))
    row_dist2[_numerical_zero_profiles(p, r, c, normalization_safe)] = 0.0
    col_dist2[_numerical_zero_profiles(p.T, c, r, normalization_safe)] = 0.0
    row_contrib = np.array([[r[a] * f[a, k] ** 2 / eigenvalues[k] if eigenvalues[k] > 0 else 0.0
                             for k in range(rank)] for a in range(p.shape[0])])
    col_contrib = np.array([[c[b] * g[b, k] ** 2 / eigenvalues[k] if eigenvalues[k] > 0 else 0.0
                             for k in range(rank)] for b in range(p.shape[1])])
    row_cos2 = np.array([[f[a, k] ** 2 / row_dist2[a] if row_dist2[a] > 0 else np.nan
                          for k in range(rank)] for a in range(p.shape[0])])
    col_cos2 = np.array([[g[b, k] ** 2 / col_dist2[b] if col_dist2[b] > 0 else np.nan
                          for k in range(rank)] for b in range(p.shape[1])])
    check_ratio_bounds("contribution", np.concatenate([row_contrib.ravel(), col_contrib.ravel()]))
    for name, arr in (("row_cos2", row_cos2), ("col_cos2", col_cos2)):
        finite = arr[np.isfinite(arr)]
        if finite.size and ((finite < -1e-10).any() or (finite > 1.0 + 1e-10).any()):
            from ...domain.errors import BizError
            raise BizError("ANALYSIS_NUMERICAL_INVARIANT_FAILED",
                           f"{name} が範囲外です。", status_code=500)
    return {
        "total": total,
        "p": p,
        "r": r,
        "c": c,
        "u": u,
        "s": s,
        "v": v,
        "eigenvalues": eigenvalues,
        "totalInertia": total_check,
        "discardedNumericalInertia": float(svd_info.get("discardedNumericalInertia", 0.0)),
        "rank": rank,
        "rankTol": float(svd_info.get("rankTol", 0.0)),
        "f": f,
        "g": g,
        "phi": phi,
        "gamma": gamma,
        "inertiaRatio": inertia_ratio,
        "cumulativeInertiaRatio": cumulative,
        "rowDistance2": row_dist2,
        "colDistance2": col_dist2,
        "rowContrib": row_contrib,
        "colContrib": col_contrib,
        "rowCos2": row_cos2,
        "colCos2": col_cos2,
        "degenerateBlocks": degenerate_blocks(eigenvalues),
        "svdInfo": svd_info,
        "keepRowIndex": list(keep_row_index),
        "keepColIndex": list(keep_col_index),
    }


def pearson_reference(table: np.ndarray, r: np.ndarray, c: np.ndarray, total: float) -> dict[str, Any]:
    expected = total * np.outer(r, c)
    with np.errstate(divide="ignore", invalid="ignore"):
        pearson = float(np.sum((table - expected) ** 2 / expected))
    df = (table.shape[0] - 1) * (table.shape[1] - 1)
    p_value = float(stats.chi2.sf(pearson, df)) if df > 0 else None
    lt1 = int(np.sum(expected < 1))
    lt5 = int(np.sum(expected < 5))
    frac = float(lt5 / expected.size) if expected.size else None
    return {"statistic": pearson, "df": int(df), "pValue": p_value,
            "smallExpectedCellsLt1": lt1, "smallExpectedCellsLt5": lt5,
            "fractionExpectedLt5": frac}


def pearson_not_applicable(reason: str = "NON_INDEPENDENT_FREQUENCY_INPUT") -> dict[str, Any]:
    return {"statistic": None, "df": None, "pValue": None, "status": "not_applicable",
            "reason": reason, "smallExpectedCellsLt1": None, "smallExpectedCellsLt5": None,
            "fractionExpectedLt5": None}
