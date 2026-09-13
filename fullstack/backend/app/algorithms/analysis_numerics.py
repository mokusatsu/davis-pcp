"""Shared numeric primitives for Features 029-034 (production).

thin_svd: scipy gesdd with one gesvd fallback, numeric rank, full spectrum.
Sign convention: applied per-axis by callers on their defined loading vectors.
"""
from __future__ import annotations

import warnings
from typing import Any

import numpy as np
from scipy import linalg


def thin_svd(a: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, float, dict[str, Any]]:
    a = np.asarray(a, dtype=np.float64)
    if a.ndim != 2 or not np.isfinite(a).all():
        raise ValueError("thin_svd requires a finite 2D float64 matrix")
    info: dict[str, Any] = {"driver": "gesdd", "fallback": False}
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            u, s, vt = linalg.svd(a, full_matrices=False, lapack_driver="gesdd", check_finite=True)
    except Exception:
        u, s, vt = linalg.svd(a, full_matrices=False, lapack_driver="gesvd", check_finite=True)
        info = {"driver": "gesdd", "fallback": True, "warning": "SVD_FALLBACK_GESVD"}
    s0 = float(s[0]) if len(s) else 0.0
    rank_tol = max(1e-12, float(np.finfo(float).eps) * max(a.shape) * s0)
    keep = s > rank_tol
    total_inertia = float(np.square(a).sum())
    discarded = float(np.square(s[~keep]).sum()) if keep.size else 0.0
    return u[:, keep], s[keep], vt[keep].T, total_inertia, {**info, "rankTol": rank_tol,
                                                           "discardedNumericalInertia": discarded}


def degenerate_blocks(eigenvalues: np.ndarray, tol: float = 1e-10) -> list[dict[str, Any]]:
    eig = [float(v) for v in np.asarray(eigenvalues, dtype=float).tolist()]
    blocks: list[dict[str, Any]] = []
    start = 0
    while start < len(eig):
        end = start
        while end + 1 < len(eig) and abs(eig[end + 1] - eig[start]) <= tol * max(1.0, abs(eig[start])):
            end += 1
        if end > start:
            blocks.append({"axisIds": list(range(start + 1, end + 2)), "relativeGapTolerance": tol})
        start = end + 1
    return blocks


def check_ratio_bounds(name: str, values: np.ndarray) -> None:
    arr = np.asarray(values, dtype=float)
    finite = arr[np.isfinite(arr)]
    if finite.size and (finite < -1e-10).any():
        raise ValueError(f"{name} below zero")
    if finite.size and (finite > 1.0 + 1e-10).any():
        from ..domain.errors import BizError
        raise BizError("ANALYSIS_NUMERICAL_INVARIANT_FAILED",
                       f"{name} が1を超過しました。", status_code=500)
