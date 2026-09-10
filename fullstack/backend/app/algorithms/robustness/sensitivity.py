"""Numerical-outlier sensitivity comparison (Feature 24-S3).

Compares the same effect/CI estimator on baseline (all rows) vs. the
sensitivity set (standardized-deviation outliers removed). Never mutates the
dataset, the central selection, or applies survey weights implicitly.
"""
from __future__ import annotations

import math
import uuid
from typing import Any

import numpy as np
import polars as pl

from ...domain.errors import BizError


def _finite_values(frame: pl.DataFrame, column: str) -> np.ndarray:
    try:
        arr = frame[column].cast(pl.Float64, strict=False).to_numpy()
    except Exception:
        arr = np.array([float(v) if v is not None else np.nan for v in frame[column].to_list()])
    return arr[~np.isnan(arr)]


def _mean_ci(values: np.ndarray) -> tuple[float | None, list[float] | None]:
    n = int(len(values))
    if n == 0:
        return None, None
    mean = float(np.mean(values))
    if n < 2:
        return mean, None
    se = float(np.std(values, ddof=1) / math.sqrt(n))
    return mean, [round(mean - 1.96 * se, 4), round(mean + 1.96 * se, 4)]


def _direction(value: float | None, tolerance: float = 1e-12) -> str:
    if value is None or abs(value) <= tolerance:
        return "flat"
    return "positive" if value > 0 else "negative"


def _relative_change(baseline: float | None, sensitivity: float | None) -> float | None:
    if baseline is None or sensitivity is None:
        return None
    return round(abs(sensitivity - baseline) / max(abs(baseline), 1e-9), 4)


def _welch_diff_ci(g1: np.ndarray, g2: np.ndarray) -> tuple[float | None, list[float] | None]:
    """Independent two-group mean difference with Welch SE and df."""
    import math as _math

    from scipy import stats as _stats

    a = g1[np.isfinite(g1)]
    b = g2[np.isfinite(g2)]
    n1, n2 = int(len(a)), int(len(b))
    if n1 < 2 or n2 < 2:
        return None, None
    diff = float(np.mean(a) - np.mean(b))
    v1 = float(np.var(a, ddof=1))
    v2 = float(np.var(b, ddof=1))
    se = _math.sqrt(v1 / n1 + v2 / n2)
    if se <= 1e-12 or not _math.isfinite(se):
        return diff, None
    denom = (v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1)
    dof = (v1 / n1 + v2 / n2) ** 2 / denom if denom > 0 else 1.0
    critical = float(_stats.t.ppf(0.975, dof)) if dof > 0 else 1.96
    if not _math.isfinite(critical):
        critical = 1.96
    return diff, [round(diff - critical * se, 4), round(diff + critical * se, 4)]


def run_sensitivity_analysis(
    df: pl.DataFrame,
    target_column: str,
    group_column: str | None = None,
    compare_groups: list[str] | None = None,
    row_ids: list[str] | None = None,
    threshold: float = 3.0,
    seed: int = 42,
    scope_hash: str = "",
    bootstrap_b: int = 200,
) -> dict[str, Any]:
    _ = (seed, bootstrap_b)
    if target_column not in df.columns:
        raise BizError("SENSITIVITY_COLUMN_MISSING", "対象列が存在しません。", status_code=422)
    if row_ids is not None:
        df = df.filter(pl.col("__rowId__").is_in(row_ids))
    if df.height == 0:
        raise BizError("EMPTY_ANALYSIS_INPUT", "対象データ行が0件です。", status_code=422)
    if not math.isfinite(threshold) or threshold <= 0:
        raise BizError("SENSITIVITY_CONFIG_INVALID", "thresholdは正の有限値にしてください。",
                       status_code=422)

    numeric_cols = [target_column]
    frames: dict[str, np.ndarray] = {}
    for name in numeric_cols:
        try:
            frames[name] = df[name].cast(pl.Float64, strict=False).to_numpy()
        except Exception:
            frames[name] = np.array([float(v) if v is not None else np.nan for v in df[name].to_list()])

    target = frames[target_column]
    outlier_mask = np.zeros(df.height, dtype=bool)
    for name, arr in frames.items():
        finite = arr[~np.isnan(arr)]
        if len(finite) < 3:
            continue
        mean = float(np.mean(finite))
        std = float(np.std(finite, ddof=1)) if len(finite) > 1 else 0.0
        if std <= 1e-12:
            continue
        z_scores = np.abs((arr - mean) / std)
        outlier_mask |= (z_scores > threshold) & ~np.isnan(arr)
    outlier_ids = df.filter(pl.Series(outlier_mask))["__rowId__"].to_list() if "__rowId__" in df.columns else []
    keep_mask = ~outlier_mask

    def effect(mask: np.ndarray) -> tuple[float | None, list[float] | None, int]:
        sub = df.filter(pl.Series(mask))
        if group_column and compare_groups and len(compare_groups) >= 2:
            try:
                g1 = sub.filter(pl.col(group_column).cast(pl.String) == str(compare_groups[0]))[target_column]
                g2 = sub.filter(pl.col(group_column).cast(pl.String) == str(compare_groups[1]))[target_column]
                g1v = _finite_values(pl.DataFrame({target_column: g1}), target_column)
                g2v = _finite_values(pl.DataFrame({target_column: g2}), target_column)
            except Exception:
                return None, None, 0
            if len(g1v) == 0 or len(g2v) == 0:
                return None, None, 0
            diff, ci = _welch_diff_ci(g1v, g2v)
            n = int(len(g1v) + len(g2v))
            return diff, ci, n
        vals = _finite_values(sub, target_column)
        mean, ci = _mean_ci(vals)
        return mean, ci, int(len(vals))

    base_effect, base_ci, base_n = effect(np.ones(df.height, dtype=bool))
    sens_effect, sens_ci, sens_n = effect(keep_mask)
    if base_effect is None or sens_effect is None:
        raise BizError("VERIFICATION_INSUFFICIENT_DATA", "効果量を計算できません。",
                       status_code=422)
    relative = _relative_change(base_effect, sens_effect)
    base_crosses = base_ci is not None and base_ci[0] <= 0 <= base_ci[1]
    sens_crosses = sens_ci is not None and sens_ci[0] <= 0 <= sens_ci[1]
    direction_ok = _direction(base_effect) == _direction(sens_effect)
    is_robust = bool(direction_ok and (relative is not None and relative <= 0.20)
                     and base_crosses == sens_crosses)
    reason = ("direction_and_ci_status_preserved" if is_robust
              else "direction_or_ci_status_changed" if not direction_ok or base_crosses != sens_crosses
              else "relative_change_exceeded")
    return {
        "runId": str(uuid.uuid4()),
        "method": "standardized_deviation",
        "confidenceMethod": "welch_t_interval",
        "threshold": threshold,
        "bootstrapB": None,
        "seed": None,
        "baseline": {"n": base_n, "effectSize": round(base_effect, 4),
                     "confidenceInterval": base_ci, "direction": _direction(base_effect),
                     "scopeHash": scope_hash},
        "sensitivity": {"n": sens_n, "excludedN": int(base_n - sens_n),
                        "effectSize": round(sens_effect, 4),
                        "confidenceInterval": sens_ci, "direction": _direction(sens_effect),
                        "scopeHash": scope_hash},
        "comparison": {"relativeChange": relative,
                       "baselineCiCrossesZero": base_crosses,
                       "sensitivityCiCrossesZero": sens_crosses,
                       "directionPreserved": direction_ok,
                       "maxRelativeChange": 0.20, "isRobust": is_robust, "reason": reason},
        "outlierRowIds": [str(v) for v in outlier_ids],
        "weightApplied": False,
    }
