"""Range-safe centering/scaling for model inputs in finite float64 units."""
from __future__ import annotations

import numpy as np

from ...domain.errors import BizError


def normalized_columns(matrix: np.ndarray, error_code: str):
    """Keep physical units factored out of means, differences and squares.

    Computing std(x) directly squares the original units, which can overflow
    or underflow even when the standardized observations are ordinary numbers.
    Callers retain the max-absolute factors separately when restoring units.
    """
    values = np.asarray(matrix, dtype=np.float64)
    if not np.isfinite(values).all():
        raise BizError(error_code, "有限の数値で分析してください。", status_code=422,
                       details={"stage": "input"})
    scale = np.max(np.abs(values), axis=0)
    scale = np.where(scale > 0, scale, 1.0)
    unit = values / scale
    mean = np.mean(unit, axis=0)
    centered = unit - mean
    std = np.sqrt(np.sum(centered * centered, axis=0) / (len(values) - 1))
    if not np.isfinite(std).all() or np.any(std <= 0):
        raise BizError(error_code, "変数の標準化が数値の表現範囲を超えました。単位を変更してください。",
                       status_code=422, details={"stage": "standardization"})
    return unit, mean, std, scale
