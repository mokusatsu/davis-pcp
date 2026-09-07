"""Descriptive statistics and selection summaries."""
from __future__ import annotations

import numpy as np
import polars as pl


def numeric_summary(values: np.ndarray) -> dict:
    clean = values[~np.isnan(values)]
    if clean.size == 0:
        return {"count": 0, "missing": int(values.size)}
    q1, med, q3 = np.percentile(clean, [25, 50, 75])
    return {
        "count": int(clean.size),
        "missing": int(values.size - clean.size),
        "min": float(clean.min()),
        "max": float(clean.max()),
        "mean": float(clean.mean()),
        "median": float(med),
        "std": float(clean.std(ddof=1)) if clean.size > 1 else 0.0,
        "q1": float(q1),
        "q3": float(q3),
        "iqr": float(q3 - q1),
    }


def categorical_summary(series: pl.Series) -> dict:
    non_null = series.drop_nulls()
    counts: dict[str, int] = {}
    for value in non_null.to_list():
        key = str(value)
        counts[key] = counts.get(key, 0) + 1
    return {
        "count": int(non_null.len()),
        "missing": int(series.null_count()),
        "uniqueCount": len(counts),
        "frequencies": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
    }


def summarize(df: pl.DataFrame, column_types: dict[str, str]) -> dict:
    result: dict[str, dict] = {}
    for name in df.columns:
        if name == "__rowId__":
            continue
        if column_types.get(name) == "numeric":
            values = np.array([np.nan if v is None else float(v) for v in df[name].to_list()])
            result[name] = numeric_summary(values)
        else:
            result[name] = categorical_summary(df[name])
    return result


def correlation_matrix_df(df: pl.DataFrame, columns: list[str]) -> list[list[float | None]]:
    p = len(columns)
    if p == 0:
        return []
    if df.height == 0:
        return [[None] * p for _ in range(p)]

    # Extract numeric columns as float numpy arrays
    col_arrays = []
    for c in columns:
        col_arrays.append(np.array([np.nan if v is None else float(v) for v in df[c].to_list()], dtype=np.float64))

    mat: list[list[float | None]] = [[None] * p for _ in range(p)]

    for i in range(p):
        valid_i = ~np.isnan(col_arrays[i])
        if np.sum(valid_i) >= 2 and np.std(col_arrays[i][valid_i]) > 1e-12:
            mat[i][i] = 1.0
        else:
            mat[i][i] = None

    for i in range(p):
        for j in range(i + 1, p):
            valid = ~np.isnan(col_arrays[i]) & ~np.isnan(col_arrays[j])
            if np.sum(valid) >= 2:
                xi = col_arrays[i][valid]
                xj = col_arrays[j][valid]
                std_i = float(np.std(xi, ddof=1))
                std_j = float(np.std(xj, ddof=1))
                if std_i > 1e-12 and std_j > 1e-12:
                    r = float(np.corrcoef(xi, xj)[0, 1])
                    if not np.isnan(r):
                        mat[i][j] = round(r, 4)
                        mat[j][i] = round(r, 4)
    return mat

