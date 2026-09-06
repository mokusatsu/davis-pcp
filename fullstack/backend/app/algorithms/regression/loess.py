"""Locally Estimated Scatterplot Smoothing (LOESS / LOWESS) regression core."""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl

from ...domain.errors import BizError


def compute_loess(
    df: pl.DataFrame,
    x_col: str,
    y_col: str,
    span: float = 0.5,
    degree: int = 1,
    n_points: int = 100,
    row_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Compute non-parametric LOESS curve with 95% confidence intervals and residual diagnostics."""
    if "__rowId__" not in df.columns:
        df = df.with_columns(pl.int_range(0, df.height).cast(pl.String).alias("__rowId__"))

    if row_ids is not None:
        wanted = set(row_ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))

    for col in [x_col, y_col]:
        if col not in df.columns:
            raise BizError("LOESS_COLUMN_NOT_FOUND", f"列 '{col}' が見つかりません。")

    sub_df = df.select(["__rowId__", x_col, y_col]).drop_nulls()
    n = sub_df.height
    if n < 5:
        raise BizError("LOESS_INSUFFICIENT_DATA", "Loess平滑化には最低5行以上の有効データが必要です。", details={"count": n})

    rids = [str(x) for x in sub_df["__rowId__"].to_list()]
    x = sub_df[x_col].to_numpy().astype(float)
    y = sub_df[y_col].to_numpy().astype(float)

    # Sort by x
    sort_idx = np.argsort(x)
    x_sorted = x[sort_idx]
    y_sorted = y[sort_idx]
    rids_sorted = [rids[i] for i in sort_idx]

    k = int(max(3, np.ceil(span * n)))
    span_clamped = max(0.05, min(1.0, span))
    degree_clamped = 2 if degree >= 2 else 1

    # Local regression helper at point x0
    def fit_local(x0: float) -> tuple[float, float]:
        dists = np.abs(x_sorted - x0)
        # Find k nearest neighbors
        nn_indices = np.argsort(dists)[:k]
        d_max = np.max(dists[nn_indices])
        if d_max <= 1e-12:
            d_max = 1.0

        u = dists[nn_indices] / d_max
        # Tricube weight: (1 - u^3)^3
        w = (1.0 - u**3)**3
        w = np.clip(w, 0.0, None)

        X_local = np.vander(x_sorted[nn_indices] - x0, degree_clamped + 1)
        y_local = y_sorted[nn_indices]
        W = np.diag(w)

        try:
            # Weighted least squares: (X^T W X) beta = X^T W y
            XTW = X_local.T @ W
            beta = np.linalg.pinv(XTW @ X_local) @ (XTW @ y_local)
            y_pred = float(beta[-1])  # Constant term for centered (x - x0)
            # Leverage estimate (H_ii)
            H = X_local @ np.linalg.pinv(XTW @ X_local) @ XTW
            lev = float(np.mean(np.diag(H)))
            return y_pred, lev
        except Exception:
            return float(np.mean(y_local)), 0.1

    # Fitted values at all data points
    y_fitted = np.zeros(n, dtype=float)
    leverages = np.zeros(n, dtype=float)
    for i in range(n):
        y_pred, lev = fit_local(x_sorted[i])
        y_fitted[i] = y_pred
        leverages[i] = lev

    residuals = y_sorted - y_fitted
    se_residual = float(np.std(residuals))
    if se_residual == 0:
        se_residual = 1e-6

    # Outlier threshold: |residual| > 2.5 * se
    outlier_thresh = 2.5 * se_residual
    outliers: list[str] = []
    points_res: list[dict[str, Any]] = []

    for i in range(n):
        rid = rids_sorted[i]
        res_val = float(residuals[i])
        is_outlier = bool(abs(res_val) > outlier_thresh)
        if is_outlier:
            outliers.append(rid)

        points_res.append({
            "id": rid,
            "x": round(float(x_sorted[i]), 5),
            "y": round(float(y_sorted[i]), 5),
            "fitted": round(float(y_fitted[i]), 5),
            "residual": round(res_val, 5),
            "isOutlier": is_outlier,
        })

    # Generate smooth grid points for curve and 95% confidence band
    x_min, x_max = float(x_sorted[0]), float(x_sorted[-1])
    grid_x = np.linspace(x_min, x_max, num=n_points)
    curve_pts: list[dict[str, Any]] = []

    for gx in grid_x:
        gy, g_lev = fit_local(gx)
        # Approximate standard error of fit: se_residual * sqrt(leverage)
        ci_half = 1.96 * se_residual * np.sqrt(max(0.01, min(1.0, g_lev)))
        curve_pts.append({
            "x": round(float(gx), 5),
            "fitted": round(float(gy), 5),
            "ciLower": round(float(gy - ci_half), 5),
            "ciUpper": round(float(gy + ci_half), 5),
        })

    # Summary metrics
    ss_tot = float(np.sum((y_sorted - np.mean(y_sorted))**2))
    ss_res = float(np.sum(residuals**2))
    r_squared = max(0.0, 1.0 - (ss_res / ss_tot)) if ss_tot > 0 else 0.0

    return {
        "xCol": x_col,
        "yCol": y_col,
        "span": span,
        "degree": degree,
        "rSquared": round(r_squared, 4),
        "residualStd": round(se_residual, 5),
        "outlierCount": len(outliers),
        "outlierRowIds": outliers,
        "points": points_res,
        "curve": curve_pts,
        "xRange": [x_min, x_max],
        "yRange": [float(np.min(y_sorted)), float(np.max(y_sorted))],
    }
