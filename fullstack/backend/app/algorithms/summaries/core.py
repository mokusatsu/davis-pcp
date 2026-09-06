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


def correlation_matrix_df(df: pl.DataFrame, columns: list[str]) -> list[list[float]]:
    data = np.array([
        [np.nan if v is None else float(v) for v in df[c].to_list()] for c in columns
    ])
    if data.shape[1] < 2:
        return [[1.0] * len(columns) for _ in columns]
    corr = np.corrcoef(data)
    corr = np.nan_to_num(corr, nan=0.0)
    return corr.tolist()
