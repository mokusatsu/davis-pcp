"""Numerically stable arithmetic for already-validated nonnegative weights.

Ratios use a dimensionless scale; reported totals always retain the original
units. A finite input does not imply that its absolute sum fits in a float.
"""
from __future__ import annotations

import math
from collections.abc import Iterable

import numpy as np


def normalized_weights(values: np.ndarray) -> np.ndarray:
    """Return weights summing to one without summing/squaring their raw scale."""
    values = np.asarray(values, dtype=float)
    maximum = float(np.max(values)) if values.size else 0.0
    if maximum <= 0:
        return np.zeros_like(values)
    scaled = values / maximum
    return scaled / math.fsum(scaled.flat)


def absolute_weight_sum(values: Iterable[float]) -> float | None:
    """Original-unit sum, or None when it exceeds the finite numeric range."""
    try:
        value = math.fsum(values)
    except OverflowError:
        return None
    return value if math.isfinite(value) else None


def display_weight_total(value: float | None) -> float | None:
    """Keep legacy precision, but never round a positive denominator to zero."""
    if value is None:
        return None
    rounded = round(value, 4)
    return value if value > 0 and rounded == 0 else rounded


def weight_total_warning() -> dict[str, str]:
    return {
        "code": "WEIGHT_TOTAL_OUT_OF_RANGE",
        "message": "ウェイト合計が数値範囲を超えています。範囲外の絶対加重件数は表示できません。比率・平均は正規化したウェイトで計算しています。",
    }
