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
