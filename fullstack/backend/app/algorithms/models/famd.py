"""Factor Analysis of Mixed Data pure numeric kernel (Feature 031, production).

Independent FAMD implementation per DAVIS-FEAT-031-DESIGN: numeric columns are
weighted-standardized with ddof=0 (two-step centered variance), categorical
indicator columns use B=(G-p)/sqrt(p) (never sqrt(p(1-p)) nor MCA sqrt(m)),
thin exact SVD on A=diag(sqrt(a)) X, individuals F=X V, eigenvalues s^2.
"""
from __future__ import annotations

from typing import Any

import numpy as np

from ..analysis_numerics import check_ratio_bounds, degenerate_blocks, thin_svd


def run_famd_numeric(
    numeric: np.ndarray,
    indicator: np.ndarray,
    *,
    weights: np.ndarray | list[float] | None,
    category_blocks: list[tuple[int, int]],
) -> dict[str, Any]:
    """Run FAMD on cleaned numeric matrix + complete indicator matrix G.

    ``category_blocks`` are (start, end) column slices of ``indicator``, one per
    categorical variable, each with >= 2 positive-mass categories. Caller splits
    zero-mass declared categories into omittedCategories (never passed here).
    """
    y = np.asarray(numeric, dtype=np.float64)
    g = np.asarray(indicator, dtype=np.float64)
    if y.ndim != 2 or g.ndim != 2:
        raise ValueError("FAMD kernel requires 2D matrices")
    n = y.shape[0]
    if g.shape[0] != n:
        raise ValueError("FAMD_INVALID_MATRIX")
    p = y.shape[1]
    if p < 1:
        raise ValueError("FAMD_MIXED_INPUT_REQUIRED")
    if not category_blocks:
        raise ValueError("FAMD_MIXED_INPUT_REQUIRED")
    if not np.isfinite(y).all() or not np.isfinite(g).all():
        raise ValueError("FAMD_INVALID_MATRIX")
    if ((g != 0.0) & (g != 1.0)).any():
        raise ValueError("FAMD_INVALID_MATRIX")
    m = len(category_blocks)
    k_total = g.shape[1]
    seen = 0
    for start, end in category_blocks:
        if int(start) != seen or int(end) <= int(start):
            raise ValueError("FAMD_INVALID_MATRIX")
        seen = int(end)
    if seen != k_total:
        raise ValueError("FAMD_INVALID_MATRIX")
    # Each categorical variable row must select exactly one category.
    for start, end in category_blocks:
        block = g[:, start:end]
        if block.shape[1] < 2:
            raise ValueError("FAMD_CONSTANT_VARIABLE")
        if not np.allclose(block.sum(axis=1), 1.0):
            raise ValueError("FAMD_INVALID_MATRIX")
    w = np.ones(n, dtype=np.float64) if weights is None else np.asarray(weights, dtype=np.float64)
    if w.shape != (n,) or not np.isfinite(w).all() or (w <= 0).any():
        raise ValueError("FAMD kernel requires finite positive weights")
    total_w = float(w.sum())
    if not np.isfinite(total_w) or total_w <= 0:
        raise ValueError("FAMD kernel requires finite positive weights")
    a = w / total_w
    # Weighted mean + two-step centered variance (never E[x^2]-E[x]^2).
    mu = a @ y
    centered = y - mu[None, :]
    var = a @ np.square(centered)
    if not np.isfinite(var).all() or (var <= 0).any():
        raise ValueError("FAMD_CONSTANT_VARIABLE")
    sigma = np.sqrt(var)
    z = centered / sigma[None, :]
    # Category probabilities + sqrt(p) normalization (never sqrt(p(1-p))).
    pk = a @ g
    if not np.isfinite(pk).all() or (pk <= 0).any():
        raise ValueError("FAMD_ZERO_MASS_CATEGORY")
    b = (g - pk[None, :]) / np.sqrt(pk)[None, :]
    x = np.column_stack([z, b])
    amat = np.sqrt(a)[:, None] * x
    u, s, v, total_inertia, svd_info = thin_svd(amat)
    rank = int(len(s))
    if rank == 0:
        raise ValueError("FAMD_ZERO_INERTIA")
    per_var_k = [end - start for start, end in category_blocks]
    expected = float(p + sum(kj - 1 for kj in per_var_k))
    if abs(total_inertia - expected) > max(1e-9, 1e-9 * abs(expected)):
        raise ValueError("ANALYSIS_NUMERICAL_INVARIANT_FAILED")
    max_rank = min(n - 1, p + k_total - m)
    if max_rank >= 0 and rank > max_rank:
        excess = float(np.square(s[max_rank:]).sum()) if rank > max_rank else 0.0
        if excess > 1e-12:
            raise ValueError("ANALYSIS_NUMERICAL_INVARIANT_FAILED")
        u, s, v = u[:, :max_rank], s[:max_rank], v[:, :max_rank]
        rank = int(len(s))
        if rank == 0:
            raise ValueError("FAMD_ZERO_INERTIA")
    eigenvalues = s * s
    f = x @ v
    # Sign convention: max-|component| of each right singular vector positive.
    for axis in range(rank):
        col = v[:, axis]
        pos = int(np.argmax(np.abs(col)))
        if col[pos] < 0:
            u[:, axis] *= -1
            v[:, axis] *= -1
            f[:, axis] *= -1
    inertia_ratio = eigenvalues / total_inertia if total_inertia > 0 else np.zeros_like(eigenvalues)
    cumulative = np.cumsum(inertia_ratio)
    row_dist2 = np.square(x).sum(axis=1)
    row_contrib = np.array([
        [a[i] * f[i, axis] ** 2 / eigenvalues[axis] if eigenvalues[axis] > 0 else 0.0
         for axis in range(rank)]
        for i in range(n)
    ])
    row_cos2 = np.array([
        [f[i, axis] ** 2 / row_dist2[i] if row_dist2[i] > 0 else np.nan
         for axis in range(rank)]
        for i in range(n)
    ])
    # Numeric variable geometry: correlations, V^2 contributions, r^2 cos2.
    v_num = v[:p, :]
    correlations = v_num * np.sqrt(eigenvalues)[None, :]
    num_contrib = np.square(v_num)
    num_cos2 = np.square(correlations)
    # Category geometry: weighted barycenters, V^2 contributions.
    bary = (g.T @ (a[:, None] * f)) / pk[:, None]
    v_cat = v[p:, :]
    cat_contrib = np.square(v_cat)
    # Barycenter distance squared in the full transformed feature space.
    b_feat = np.zeros((k_total, p + k_total), dtype=np.float64)
    for start, end in category_blocks:
        for local, col in enumerate(range(start, end)):
            members = g[:, col] > 0.5
            if members.any():
                b_feat[col, :] = (a[members, None] * x[members, :]).sum(axis=0) / pk[col]
    cat_dist2 = np.square(b_feat).sum(axis=1)
    cat_cos2 = np.array([
        [bary[col, axis] ** 2 / cat_dist2[col] if cat_dist2[col] > 0 else np.nan
         for axis in range(rank)]
        for col in range(k_total)
    ])
    check_ratio_bounds("famd_contribution", np.concatenate(
        [row_contrib.ravel(), num_contrib.ravel(), cat_contrib.ravel()]))
    for name, arr in (("famd_row_cos2", row_cos2), ("famd_num_cos2", num_cos2),
                      ("famd_cat_cos2", cat_cos2)):
        finite = np.asarray(arr, dtype=float)[np.isfinite(np.asarray(arr, dtype=float))]
        if finite.size and ((finite < -1e-10).any() or (finite > 1.0 + 1e-10).any()):
            from ...domain.errors import BizError
            raise BizError("ANALYSIS_NUMERICAL_INVARIANT_FAILED",
                           f"{name} が範囲外です。", status_code=500)
    # Variable-level quantities: contributions sum to 1 per axis; eta2 separate.
    var_contrib = np.zeros((p + m, rank), dtype=np.float64)
    var_contrib[:p, :] = num_contrib
    eta2 = np.zeros((m, rank), dtype=np.float64)
    for j, (start, end) in enumerate(category_blocks):
        cols = np.arange(start, end)
        var_contrib[p + j, :] = cat_contrib[cols, :].sum(axis=0)
        for axis in range(rank):
            lam = float(eigenvalues[axis])
            eta2[j, axis] = float((pk[cols] * np.square(bary[cols, axis])).sum() / lam) if lam > 0 else 0.0
    finite_eta = eta2[np.isfinite(eta2)]
    if finite_eta.size and ((finite_eta < -1e-10).any() or (finite_eta > 1.0 + 1e-10).any()):
        from ...domain.errors import BizError
        raise BizError("ANALYSIS_NUMERICAL_INVARIANT_FAILED",
                       "eta2 が範囲外です。", status_code=500)
    for axis in range(rank):
        if abs(float(var_contrib[:, axis].sum()) - 1.0) > 1e-9:
            raise ValueError("ANALYSIS_NUMERICAL_INVARIANT_FAILED")
    return {
        "n": int(n), "p": int(p), "m": int(m), "k": int(k_total),
        "a": a, "mu": mu, "sigma": sigma, "pk": pk,
        "u": u, "s": s, "v": v,
        "eigenvalues": eigenvalues,
        "totalInertia": float(total_inertia),
        "expectedTotalInertia": float(expected),
        "discardedNumericalInertia": float(svd_info.get("discardedNumericalInertia", 0.0)),
        "rank": rank,
        "rankTol": float(svd_info.get("rankTol", 0.0)),
        "f": f,
        "inertiaRatio": inertia_ratio,
        "cumulativeInertiaRatio": cumulative,
        "rowDistance2": row_dist2,
        "rowContrib": row_contrib,
        "rowCos2": row_cos2,
        "correlations": correlations,
        "numContrib": num_contrib,
        "numCos2": num_cos2,
        "barycenters": bary,
        "catContrib": cat_contrib,
        "catCos2": cat_cos2,
        "catDistance2": np.asarray(cat_dist2, dtype=np.float64),
        "varContrib": var_contrib,
        "eta2": eta2,
        "perVarK": per_var_k,
        "degenerateBlocks": degenerate_blocks(eigenvalues),
        "svdInfo": svd_info,
    }


def project_famd_rows(
    numeric_new: np.ndarray,
    indicator_new: np.ndarray,
    *,
    mu: np.ndarray,
    sigma: np.ndarray,
    pk: np.ndarray,
    v: np.ndarray,
) -> np.ndarray:
    """Project new rows with fitted mu/sigma/pk/column order/V (row-vector form)."""
    y = np.asarray(numeric_new, dtype=np.float64)
    g = np.asarray(indicator_new, dtype=np.float64)
    mm = np.asarray(mu, dtype=np.float64)
    ss = np.asarray(sigma, dtype=np.float64)
    pp = np.asarray(pk, dtype=np.float64)
    vv = np.asarray(v, dtype=np.float64)
    if y.ndim != 2 or g.ndim != 2 or y.shape[0] != g.shape[0]:
        raise ValueError("FAMD projection shape mismatch")
    if y.shape[1] != mm.shape[0] or g.shape[1] != pp.shape[0]:
        raise ValueError("FAMD projection shape mismatch")
    if vv.shape[0] != y.shape[1] + g.shape[1]:
        raise ValueError("FAMD projection shape mismatch")
    if not np.isfinite(y).all() or not np.isfinite(g).all():
        raise ValueError("FAMD projection requires finite inputs")
    if ((g != 0.0) & (g != 1.0)).any():
        raise ValueError("FAMD projection requires indicator rows")
    if (ss <= 0).any() or (pp <= 0).any():
        raise ValueError("FAMD projection requires fitted scales")
    z = (y - mm[None, :]) / ss[None, :]
    b = (g - pp[None, :]) / np.sqrt(pp)[None, :]
    return np.column_stack([z, b]) @ vv
