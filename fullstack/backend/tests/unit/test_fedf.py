"""Unit tests for FEDF (Flipped Empirical Distribution Function) calculation."""
from __future__ import annotations

import numpy as np
import pytest

from app.algorithms.distribution.fedf import compute_fedf
from app.services.import_service import build_builtin_iris


def test_fedf_iris():
    df = build_builtin_iris()
    cols = ["sepal_length_cm", "petal_length_cm"]
    res = compute_fedf(df, columns=cols, mode="standard")

    assert res["totalRows"] == 150
    assert res["columns"] == cols
    assert "sepal_length_cm" in res["profiles"]
    assert "petal_length_cm" in res["profiles"]

    # Check statistics
    sl_stats = res["statistics"]["sepal_length_cm"]
    assert sl_stats["min"] == 4.3
    assert sl_stats["max"] == 7.9
    assert sl_stats["q25"] <= sl_stats["median"] <= sl_stats["q75"]
    assert sl_stats["validCount"] == 150

    # Check row coords
    coords = res["rowCoords"]
    assert len(coords) == 150
    first_id = list(coords.keys())[0]
    assert "sepal_length_cm" in coords[first_id]
    assert 0.0 <= coords[first_id]["sepal_length_cm"]["quantile"] <= 1.0
    assert 0.0 <= coords[first_id]["sepal_length_cm"]["folded"] <= 1.0

    # Check curve points
    curve = res["profiles"]["sepal_length_cm"]["curve"]
    assert len(curve) > 10
    # Values should be monotonically non-decreasing with quantile
    vals = [pt["val"] for pt in curve]
    for i in range(len(vals) - 1):
        assert vals[i] <= vals[i + 1]
