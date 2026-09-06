"""Tests for QQ-Plot computation."""
from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from app.algorithms.summaries.qqplot import compute_qqplot


def test_qqplot_normal_distribution():
    np.random.seed(42)
    normal_data = np.random.normal(loc=10.0, scale=2.0, size=100)
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(100)],
        "norm_val": normal_data,
    })
    res = compute_qqplot(df, "norm_val")
    assert res["count"] == 100
    assert len(res["points"]) == 100
    assert res["normalityTest"]["shapiroWilkW"] > 0.95
    assert res["normalityTest"]["isNormalAlpha05"] is True
    # Reference line slope should be close to std (2.0)
    assert 1.2 < res["referenceLine"]["slope"] < 2.8


def test_qqplot_skewed_distribution():
    np.random.seed(42)
    exp_data = np.random.exponential(scale=2.0, size=150)
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(150)],
        "exp_val": exp_data,
    })
    res = compute_qqplot(df, "exp_val")
    assert res["normalityTest"]["skewness"] > 1.0
    assert res["normalityTest"]["isNormalAlpha05"] is False
