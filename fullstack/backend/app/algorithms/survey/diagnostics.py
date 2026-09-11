"""Weight diagnostics.

These describe *how much information the weights cost*; they are not a
substitute for a design-based test. Every quantity here is invariant to
multiplying all weights by a constant, which is what makes them safe to show
next to a survey weight whose scale is arbitrary.
"""
from __future__ import annotations

import numpy as np


def weight_diagnostics(weights: np.ndarray | list[float]) -> dict[str, float | int | None]:
    """Weight sum, Kish effective N, weight CV and the Kish weighting DEFF."""
    values = np.asarray([w for w in weights if w is not None], dtype=float)
    values = values[np.isfinite(values)]
    if values.size == 0:
        return {"weightSum": None, "kishEffectiveN": None, "weightCv": None,
                "weightingDeff": None, "positiveWeightN": 0, "weightN": 0}
    weight_sum = float(values.sum())
    squared_sum = float((values ** 2).sum())
    positive = values[values > 0]
    kish = (weight_sum ** 2 / squared_sum) if squared_sum > 0 else None
    mean = float(positive.mean()) if positive.size else 0.0
    cv = float(positive.std(ddof=1) / mean) if positive.size > 1 and mean > 0 else (
        0.0 if positive.size == 1 else None)
    deff = (positive.size / kish) if kish and kish > 0 and positive.size else None
    return {
        "weightSum": weight_sum,
        "kishEffectiveN": float(kish) if kish is not None else None,
        "weightCv": cv,
        "weightingDeff": float(deff) if deff is not None else None,
        "positiveWeightN": int(positive.size),
        "weightN": int(values.size),
    }
