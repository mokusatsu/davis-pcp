"""Weight diagnostics.

These describe *how much information the weights cost*; they are not a
substitute for a design-based test. Kish N, CV and DEFF are scale invariant;
the absolute weight sum is not and may exceed the finite numeric range.
"""
from __future__ import annotations

import numpy as np

from .weight_arithmetic import absolute_weight_sum, normalized_weights


def weight_diagnostics(weights: np.ndarray | list[float]) -> dict[str, float | int | str | None]:
    """Weight sum, Kish effective N, weight CV and the Kish weighting DEFF."""
    values = np.asarray([w for w in weights if w is not None], dtype=float)
    values = values[np.isfinite(values)]
    if values.size == 0:
        return {"weightSum": None, "weightSumStatus": "empty", "kishEffectiveN": None, "weightCv": None,
                "weightingDeff": None, "positiveWeightN": 0, "weightN": 0}
    weight_sum = absolute_weight_sum(values)
    positive = values[values > 0]
    normalized = normalized_weights(positive)
    squared_sum = float(np.dot(normalized, normalized))
    kish = (1.0 / squared_sum) if squared_sum > 0 else None
    mean = float(normalized.mean()) if positive.size else 0.0
    cv = float(normalized.std(ddof=1) / mean) if positive.size > 1 and mean > 0 else (
        0.0 if positive.size == 1 else None)
    deff = (positive.size / kish) if kish and kish > 0 and positive.size else None
    return {
        "weightSum": weight_sum,
        "weightSumStatus": "ok" if weight_sum is not None else "out_of_range",
        "kishEffectiveN": float(kish) if kish is not None else None,
        "weightCv": cv,
        "weightingDeff": float(deff) if deff is not None else None,
        "positiveWeightN": int(positive.size),
        "weightN": int(values.size),
    }
