"""FEDF (Flipped Empirical Distribution Function / Parallel FEDF) calculation engine.

Based on Moon Yul Huh (1995), "Exploring Multidimensional Data with the
Flipped Empirical Distribution Function", Journal of Computational and Graphical Statistics.
"""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl

from ...domain.errors import BizError


def compute_fedf(
    df: pl.DataFrame,
    columns: list[str] | None = None,
    mode: str = "standard",  # "standard" (0->1), "folded" (mountain plot |p - 0.5|), or "both"
    grid_size: int = 100,
    row_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Compute FEDF profile curves and row quantile coordinates for requested numeric columns.
    
    In traditional ECDF, x is value and y is cumulative probability F(x).
    In FEDF, the axes are flipped: y is value (aligned with PCP axes) and x is cumulative probability
    or folded distance from the median.
    """
    if "__rowId__" not in df.columns:
        df = df.with_columns(pl.int_range(0, df.height).cast(pl.String).alias("__rowId__"))

    if row_ids is not None:
        wanted = set(row_ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))

    n = df.height
    if n == 0:
        raise BizError("FEDF_EMPTY_DATA", "データセットに対象行が存在しません。")

    # Determine numeric columns
    numeric_dtypes = (
        pl.Float32, pl.Float64,
        pl.Int8, pl.Int16, pl.Int32, pl.Int64,
        pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64,
    )
    all_numeric = [c for c in df.columns if c != "__rowId__" and df[c].dtype in numeric_dtypes]

    if columns is None or len(columns) == 0:
        selected_cols = all_numeric
    else:
        selected_cols = [c for c in columns if c in all_numeric]

    if not selected_cols:
        return {
            "columns": [],
            "profiles": {},
            "rowCoords": {},
            "statistics": {},
            "totalRows": n,
            "mode": mode,
        }

    all_row_ids = [str(x) for x in df["__rowId__"].to_list()]
    profiles: dict[str, Any] = {}
    row_coords: dict[str, dict[str, Any]] = {rid: {} for rid in all_row_ids}
    statistics: dict[str, Any] = {}

    for col_name in selected_cols:
        series = df[col_name].drop_nulls()
        n_valid = len(series)
        if n_valid == 0:
            continue

        # Get values with row IDs
        sub_df = df.select(["__rowId__", col_name]).drop_nulls().sort(col_name)
        sorted_vals = sub_df[col_name].to_numpy()
        sorted_rids = [str(x) for x in sub_df["__rowId__"].to_list()]

        # Empirical probabilities: (i + 0.5) / n_valid (Hazen's plotting position)
        p_vals = (np.arange(n_valid) + 0.5) / n_valid
        # Folded / Mountain plot: 1.0 - 2.0 * abs(p - 0.5) -> peak = 1.0 at median
        m_vals = 1.0 - 2.0 * np.abs(p_vals - 0.5)

        # Store row coordinates
        for i in range(n_valid):
            rid = sorted_rids[i]
            val = float(sorted_vals[i])
            p = float(p_vals[i])
            m = float(m_vals[i])
            row_coords[rid][col_name] = {
                "val": val,
                "quantile": round(p, 5),
                "folded": round(m, 5),
                "rank": int(i + 1),
            }

        # Quantile statistics
        q0 = float(sorted_vals[0])
        q25 = float(np.percentile(sorted_vals, 25))
        q50 = float(np.percentile(sorted_vals, 50))
        q75 = float(np.percentile(sorted_vals, 75))
        q100 = float(sorted_vals[-1])
        iqr = q75 - q25

        statistics[col_name] = {
            "min": q0,
            "q25": q25,
            "median": q50,
            "q75": q75,
            "max": q100,
            "iqr": iqr,
            "mean": float(np.mean(sorted_vals)),
            "std": float(np.std(sorted_vals)),
            "validCount": n_valid,
        }

        # Generate smooth sampled profile points for SVG drawing
        eval_p = np.linspace(0.001, 0.999, num=min(grid_size, n_valid))
        sampled_vals = np.percentile(sorted_vals, eval_p * 100)
        eval_m = 1.0 - 2.0 * np.abs(eval_p - 0.5)

        profile_curve = []
        for p, v, m in zip(eval_p, sampled_vals, eval_m):
            profile_curve.append({
                "quantile": round(float(p), 4),
                "val": round(float(v), 5),
                "folded": round(float(m), 4),
            })

        profiles[col_name] = {
            "curve": profile_curve,
            "minVal": q0,
            "maxVal": q100,
        }

    return {
        "columns": selected_cols,
        "profiles": profiles,
        "rowCoords": row_coords,
        "statistics": statistics,
        "totalRows": n,
        "mode": mode,
    }
