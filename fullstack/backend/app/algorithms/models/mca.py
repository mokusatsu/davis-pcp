"""Multiple Correspondence Analysis pure numeric kernel (Feature 030, production).

Implements the Feature 030 indicator design on an already-clean indicator
matrix Z (n x K): P=a_i Z_ik / m, S=sqrt(a)(Z-p)/sqrt(m p), exact thin SVD,
individual/category principal + standard coordinates, contributions, cos2,
full-spectrum raw eigenvalues, and the Bénzécri adjusted series.
"""
from __future__ import annotations

from typing import Any

import numpy as np

from ..analysis_numerics import check_ratio_bounds, degenerate_blocks, thin_svd


def benzecri_adjusted(eigenvalues: np.ndarray, m: int) -> tuple[np.ndarray, list[float | None], str | None]:
    """Adjusted eigenvalues and ratios; null ratios with a reason when all zero."""
    eig = np.asarray(eigenvalues, dtype=np.float64)
    factor = (m / (m - 1)) ** 2 if m > 1 else 0.0
    adjusted = factor * np.square(np.maximum(eig - 1.0 / m, 0.0)) if m > 1 else np.zeros_like(eig)
    total = float(adjusted.sum())
    if total <= 0:
        return adjusted, [None] * len(eig), "NO_EIGENVALUE_ABOVE_BENZECRI_THRESHOLD"
    return adjusted, [float(v) / total for v in adjusted.tolist()], None


def run_mca_numeric(
    z: np.ndarray,
    *,
    weights: np.ndarray | list[float] | None,
    m: int,
    category_index: list[int],
) -> dict[str, Any]:
    """Run indicator MCA on indicator matrix Z with positive weights.

    ``category_index`` maps each Z column to its category slot (0..K-1) and is
    validated (unique, contiguous) so callers cannot silently permute columns.
    """
    mat = np.asarray(z, dtype=np.float64)
    if mat.ndim != 2:
        raise ValueError("MCA kernel requires a 2D indicator matrix")
    n, k = mat.shape
    if m < 2:
        raise ValueError("MCA_TOO_FEW_VARIABLES")
    if k == 0:
        raise ValueError("MCA_CATEGORY_REQUIRED")
    idx = [int(v) for v in category_index]
    if len(idx) != k or sorted(idx) != list(range(k)):
        raise ValueError("MCA_INVALID_INDICATOR")
    if not np.isfinite(mat).all() or ((mat != 0.0) & (mat != 1.0)).any():
        raise ValueError("MCA_INVALID_INDICATOR")
    row_sums = mat.sum(axis=1)
    if not np.allclose(row_sums, float(m)):
        raise ValueError("MCA_INVALID_INDICATOR")
    w = np.ones(n, dtype=np.float64) if weights is None else np.asarray(weights, dtype=np.float64)
    if w.shape != (n,) or not np.isfinite(w).all() or (w <= 0).any():
        raise ValueError("MCA kernel requires finite positive weights")
    total_w = float(w.sum())
    if not np.isfinite(total_w) or total_w <= 0:
        raise ValueError("MCA kernel requires finite positive weights")
    a = w / total_w
    p = a @ mat
    if (p <= 0).any():
        raise ValueError("MCA_ZERO_MASS_CATEGORY")
    c = p / float(m)
    denom = m * p
    s_mat = np.sqrt(a)[:, None] * (mat - p[None, :]) / np.sqrt(denom)[None, :]
    if not np.isfinite(s_mat).all():
        raise ValueError("MCA_INVALID_INDICATOR")
    u, s, v, total_inertia, svd_info = thin_svd(s_mat)
    rank = int(len(s))
    if rank == 0:
        raise ValueError("MCA_ZERO_INERTIA")
    expected = float((k - m) / m)
    if abs(total_inertia - expected) > max(1e-9, 1e-9 * abs(expected)):
        raise ValueError("ANALYSIS_NUMERICAL_INVARIANT_FAILED")
    max_rank = min(n - 1, k - m)
    if max_rank >= 0 and rank > max_rank:
        excess = float(np.square(s[max_rank:]).sum()) if rank > max_rank else 0.0
        if excess > 1e-12:
            raise ValueError("ANALYSIS_NUMERICAL_INVARIANT_FAILED")
        u, s, v = u[:, :max_rank], s[:max_rank], v[:, :max_rank]
        rank = int(len(s))
        if rank == 0:
            raise ValueError("MCA_ZERO_INERTIA")
    eigenvalues = s * s
    sqrt_a = np.sqrt(a)
    sqrt_c = np.sqrt(c)
    f = u * s / sqrt_a[:, None]
    g = v * s / sqrt_c[:, None]
    gamma = v / sqrt_c[:, None]
    for axis in range(rank):
        col = g[:, axis]
        pos = int(np.argmax(np.abs(col)))
        if col[pos] < 0:
            u[:, axis] *= -1
            v[:, axis] *= -1
            f[:, axis] *= -1
            g[:, axis] *= -1
            gamma[:, axis] *= -1
    inertia_ratio = eigenvalues / total_inertia if total_inertia > 0 else np.zeros_like(eigenvalues)
    cumulative = np.cumsum(inertia_ratio)
    row_dist2 = np.array([
        float(np.sum(((mat[i, :] / m) - c) ** 2 / c)) for i in range(n)
    ])
    cat_dist2 = (1.0 - p) / p
    row_contrib = np.array([
        [a[i] * f[i, axis] ** 2 / eigenvalues[axis] if eigenvalues[axis] > 0 else 0.0
         for axis in range(rank)]
        for i in range(n)
    ])
    cat_contrib = np.array([
        [c[j] * g[j, axis] ** 2 / eigenvalues[axis] if eigenvalues[axis] > 0 else 0.0
         for axis in range(rank)]
        for j in range(k)
    ])
    row_cos2 = np.array([
        [f[i, axis] ** 2 / row_dist2[i] if row_dist2[i] > 0 else np.nan
         for axis in range(rank)]
        for i in range(n)
    ])
    cat_cos2 = np.array([
        [g[j, axis] ** 2 / cat_dist2[j] if cat_dist2[j] > 0 else np.nan
         for axis in range(rank)]
        for j in range(k)
    ])
    check_ratio_bounds("contribution", np.concatenate([row_contrib.ravel(), cat_contrib.ravel()]))
    for name, arr in (("row_cos2", row_cos2), ("cat_cos2", cat_cos2)):
        finite = arr[np.isfinite(arr)]
        if finite.size and ((finite < -1e-10).any() or (finite > 1.0 + 1e-10).any()):
            from ...domain.errors import BizError
            raise BizError("ANALYSIS_NUMERICAL_INVARIANT_FAILED",
                           f"{name} が範囲外です。", status_code=500)
    adjusted_eig, adjusted_ratio, adjusted_reason = benzecri_adjusted(eigenvalues, m)
    return {
        "m": int(m),
        "k": int(k),
        "n": int(n),
        "a": a,
        "p": p,
        "c": c,
        "u": u,
        "s": s,
        "v": v,
        "eigenvalues": eigenvalues,
        "totalInertia": total_inertia,
        "expectedTotalInertia": expected,
        "discardedNumericalInertia": float(svd_info.get("discardedNumericalInertia", 0.0)),
        "rank": rank,
        "rankTol": float(svd_info.get("rankTol", 0.0)),
        "f": f,
        "g": g,
        "gamma": gamma,
        "inertiaRatio": inertia_ratio,
        "cumulativeInertiaRatio": cumulative,
        "rowDistance2": row_dist2,
        "catDistance2": np.asarray(cat_dist2, dtype=np.float64),
        "rowContrib": row_contrib,
        "catContrib": cat_contrib,
        "rowCos2": row_cos2,
        "catCos2": cat_cos2,
        "adjustedEigenvalues": adjusted_eig,
        "adjustedInertiaRatio": adjusted_ratio,
        "adjustedReason": adjusted_reason,
        "degenerateBlocks": degenerate_blocks(eigenvalues),
        "svdInfo": svd_info,
    }


def project_mca_rows(
    z_new: np.ndarray,
    *,
    c: np.ndarray,
    v: np.ndarray,
    m: int,
) -> np.ndarray:
    """Project new indicator rows onto a fitted MCA space (row-vector form)."""
    mat = np.asarray(z_new, dtype=np.float64)
    cc = np.asarray(c, dtype=np.float64)
    vv = np.asarray(v, dtype=np.float64)
    if mat.ndim != 2 or mat.shape[1] != cc.shape[0] or vv.shape[0] != cc.shape[0]:
        raise ValueError("MCA projection shape mismatch")
    if not np.isfinite(mat).all() or ((mat != 0.0) & (mat != 1.0)).any():
        raise ValueError("MCA_INVALID_INDICATOR")
    if not np.allclose(mat.sum(axis=1), float(m)):
        raise ValueError("MCA_INVALID_INDICATOR")
    scale = vv / np.sqrt(cc)[:, None]
    return (mat / float(m) - cc[None, :]) @ scale
