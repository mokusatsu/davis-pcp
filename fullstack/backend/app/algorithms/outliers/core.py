"""Outlier detection: IQR, robust z (MAD), Isolation Forest, LOF.

All methods are MODERN-EXTENSION: later DAVIS materials show outlier
coloring propagating to PCP and Box Plot, but the exact algorithm was
never recoverable from the initial JAR.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.neighbors import LocalOutlierFactor


def iqr_rule(values: np.ndarray, factor: float = 1.5) -> np.ndarray:
    """Per-axis box plot IQR rule; True = outlier in any axis."""
    outlier = np.zeros(values.shape[0], dtype=bool)
    for col in range(values.shape[1]):
        series = values[:, col]
        clean = series[~np.isnan(series)]
        if clean.size == 0:
            continue
        q1, q3 = np.percentile(clean, [25, 75])
        iqr = q3 - q1
        lo, hi = q1 - factor * iqr, q3 + factor * iqr
        finite = ~np.isnan(series)
        outlier |= finite & ((series < lo) | (series > hi))
    return outlier


def robust_zscore(values: np.ndarray, threshold: float = 3.5) -> np.ndarray:
    """MAD-based robust z-score per axis; True = outlier."""
    outlier = np.zeros(values.shape[0], dtype=bool)
    for col in range(values.shape[1]):
        series = values[:, col]
        clean = series[~np.isnan(series)]
        if clean.size == 0:
            continue
        med = np.median(clean)
        mad = np.median(np.abs(clean - med))
        if mad == 0:
            std = np.std(clean)
            if std == 0:
                continue
            scores = np.abs(series - med) / (1.4826 * std)
        else:
            scores = np.abs(series - med) / (1.4826 * mad)
        col_outlier = np.nan_to_num(scores, nan=0.0) > threshold
        outlier |= col_outlier
    return outlier


def isolation_forest(values: np.ndarray, contamination: float = 0.05,
                     seed: int = 42) -> dict[str, Any]:
    model = IsolationForest(contamination=contamination, random_state=seed)
    predictions = model.fit_predict(values)
    flags = predictions == -1
    return {
        "flags": flags.tolist(),
        "count": int(flags.sum()),
        "method": "isolation_forest",
        "evidenceClass": "MODERN-EXTENSION",
        "algorithmVersion": f"sklearn-IsolationForest",
        "diagnostics": {"contamination": contamination, "seed": seed,
                        "scores": (-model.score_samples(values)).tolist()},
    }


def local_outlier_factor(values: np.ndarray, n_neighbors: int = 20,
                         contamination: float = 0.05) -> dict[str, Any]:
    model = LocalOutlierFactor(n_neighbors=min(n_neighbors, len(values) - 1),
                               contamination=contamination)
    predictions = model.fit_predict(values)
    flags = predictions == -1
    return {
        "flags": flags.tolist(),
        "count": int(flags.sum()),
        "method": "local_outlier_factor",
        "evidenceClass": "MODERN-EXTENSION",
        "algorithmVersion": "sklearn-LocalOutlierFactor",
        "diagnostics": {"nNeighbors": n_neighbors,
                        "negativeFactors": (-model.negative_outlier_factor_).tolist()},
    }


def detect(method: str, values: np.ndarray, *, contamination: float = 0.05,
           seed: int = 42, threshold: float = 3.5) -> dict[str, Any]:
    """Dispatch univariate-per-axis or multivariate detection."""
    if method == "iqr":
        flags = iqr_rule(values)
    elif method == "robust_z":
        flags = robust_zscore(values, threshold)
    elif method == "isolation_forest":
        return isolation_forest(values, contamination, seed)
    elif method == "lof":
        return local_outlier_factor(values, contamination=contamination)
    else:
        raise ValueError(f"unknown outlier method: {method}")
    return {
        "flags": flags.tolist(),
        "count": int(flags.sum()),
        "method": method,
        "evidenceClass": "MODERN-EXTENSION",
        "algorithmVersion": "2.0.0",
        "diagnostics": {"perAxis": True},
    }
