"""QQ-Plot computation: theoretical quantiles, reference line, and normality tests."""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl
from scipy import stats

from ...domain.errors import BizError


def compute_qqplot(
    df: pl.DataFrame,
    column: str,
    plotting_position: str = "blom",
) -> dict[str, Any]:
    """Compute theoretical normal quantiles, robust line, and normality diagnostics."""
    if column not in df.columns:
        raise BizError("QQPLOT_COLUMN_NOT_FOUND", f"列 '{column}' が存在しません。")

    # The row id is display metadata: synthesize positional ids when the
    # caller passes a bare frame (pure-function contract), instead of
    # refusing the computation.
    if "__rowId__" not in df.columns:
        df = df.with_columns(pl.int_range(0, df.height).cast(pl.String).alias("__rowId__"))

    # Select rowId and column, drop nulls
    subset = df.select(["__rowId__", column]).drop_nulls()
    if subset.height < 3:
        raise BizError("QQPLOT_INSUFFICIENT_DATA", f"列 '{column}' の有効データが少なすぎます（最低3件必要）。")

    row_ids = subset["__rowId__"].to_list()
    raw_vals = subset[column].to_numpy().astype(float)
    raw_vals = raw_vals[np.isfinite(raw_vals)]
    n = len(raw_vals)
    if n >= 1:
        finite_sorted = np.sort(raw_vals)
        if not np.isfinite(finite_sorted).all() or np.ptp(finite_sorted) <= 1e-12:
            return {
                "column": column,
                "count": n,
                "normalityTest": {
                    "shapiroWilkW": None,
                    "pValue": None,
                    "isNormalAlpha05": None,
                    "skewness": None,
                    "kurtosis": None,
                },
                "referenceLine": {
                    "slope": None,
                    "intercept": None,
                    "q1Sample": None,
                    "q3Sample": None,
                    "q1Theoretical": float(stats.norm.ppf(0.25)),
                    "q3Theoretical": float(stats.norm.ppf(0.75)),
                },
                "points": [],
                "minZ": None,
                "maxZ": None,
                "minVal": float(finite_sorted[0]),
                "maxVal": float(finite_sorted[-1]),
            }

    # Sort indices
    sort_idx = np.argsort(raw_vals)
    sorted_vals = raw_vals[sort_idx]
    sorted_row_ids = [row_ids[i] for i in sort_idx]

    # Plotting position p_i
    ranks = np.arange(1, n + 1)
    if plotting_position == "weisberg":
        p_i = (ranks - 0.5) / n
    else:  # blom (default)
        p_i = (ranks - 0.375) / (n + 0.25)

    # Theoretical normal quantiles
    theoretical_z = stats.norm.ppf(p_i)

    # Reference line based on Q1 and Q3
    q1_sample = float(np.percentile(sorted_vals, 25))
    q3_sample = float(np.percentile(sorted_vals, 75))
    q1_theo = float(stats.norm.ppf(0.25))
    q3_theo = float(stats.norm.ppf(0.75))

    slope = (q3_sample - q1_sample) / (q3_theo - q1_theo) if (q3_theo != q1_theo) else 1.0
    intercept = q1_sample - slope * q1_theo

    # Normality diagnostics
    try:
        shapiro_res = stats.shapiro(raw_vals)
        w_stat = float(shapiro_res.statistic)
        p_val = float(shapiro_res.pvalue)
    except Exception:
        w_stat = None
        p_val = None

    skewness = float(stats.skew(raw_vals))
    kurt = float(stats.kurtosis(raw_vals))

    points = []
    for i in range(n):
        points.append({
            "rowId": sorted_row_ids[i],
            "rank": int(ranks[i]),
            "sampleValue": float(sorted_vals[i]),
            "theoreticalQuantile": float(theoretical_z[i]),
        })

    return {
        "column": column,
        "count": n,
        "normalityTest": {
            "shapiroWilkW": w_stat,
            "pValue": p_val,
            "isNormalAlpha05": (p_val >= 0.05) if p_val is not None else None,
            "skewness": skewness,
            "kurtosis": kurt,
        },
        "referenceLine": {
            "slope": float(slope),
            "intercept": float(intercept),
            "q1Sample": q1_sample,
            "q3Sample": q3_sample,
            "q1Theoretical": q1_theo,
            "q3Theoretical": q3_theo,
        },
        "points": points,
        "minZ": float(theoretical_z[0]),
        "maxZ": float(theoretical_z[-1]),
        "minVal": float(sorted_vals[0]),
        "maxVal": float(sorted_vals[-1]),
    }
