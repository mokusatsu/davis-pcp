"""Unit tests for LOESS regression algorithm."""
from __future__ import annotations

import numpy as np
import pytest

from app.algorithms.regression.loess import compute_loess
from app.services.import_service import build_builtin_iris


def test_loess_iris():
    df = build_builtin_iris()
    res = compute_loess(
        df=df,
        x_col="petal_length_cm",
        y_col="petal_width_cm",
        span=0.5,
        degree=1,
        n_points=50,
    )

    assert res["xCol"] == "petal_length_cm"
    assert res["yCol"] == "petal_width_cm"
    assert len(res["points"]) == 150
    assert len(res["curve"]) == 50
    assert res["rSquared"] > 0.8  # Strong positive relationship in Iris

    # Confidence interval bounds
    for pt in res["curve"]:
        assert pt["ciLower"] <= pt["fitted"] <= pt["ciUpper"]

    # Check outliers
    assert "outlierCount" in res
    assert "outlierRowIds" in res
