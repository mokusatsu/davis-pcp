"""Unit tests for missing values imputation (Mean, Median, Mode, Constant, KNN, TabDiff)."""
from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from app.algorithms.imputation.core import impute_dataframe, preview_imputation
from app.algorithms.imputation.tabdiff import tabdiff_impute


def test_baseline_imputation_mean_median_mode():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3", "r4"],
        "num": [10.0, None, 30.0, None],
        "cat": ["A", None, "A", "B"],
    })

    # Mean
    res_mean, _ = impute_dataframe(df, columns=["num"], strategy="mean")
    assert res_mean["num"].null_count() == 0
    assert res_mean["num"].to_list() == [10.0, 20.0, 30.0, 20.0]

    # Median
    res_med, _ = impute_dataframe(df, columns=["num"], strategy="median")
    assert res_med["num"].null_count() == 0
    assert res_med["num"].to_list() == [10.0, 20.0, 30.0, 20.0]

    # Mode
    res_mode, _ = impute_dataframe(df, columns=["cat"], strategy="mode")
    assert res_mode["cat"].null_count() == 0
    assert res_mode["cat"].to_list() == ["A", "A", "A", "B"]

    # Constant
    res_const, _ = impute_dataframe(df, columns=["num"], strategy="constant", options={"constant_value": -1.0})
    assert res_const["num"].to_list() == [10.0, -1.0, 30.0, -1.0]


def test_knn_imputation():
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(6)],
        "x": [1.0, 2.0, 3.0, 10.0, 11.0, 12.0],
        "y": [1.0, None, 3.0, 10.0, None, 12.0],
    })
    res, diag = impute_dataframe(df, columns=["y"], strategy="knn", options={"knn_neighbors": 2})
    assert res["y"].null_count() == 0
    y_vals = res["y"].to_list()
    # Row 1 (x=2) should be close to 1-3 range (~2.0)
    assert 1.0 <= y_vals[1] <= 3.0
    # Row 4 (x=11) should be close to 10-12 range (~11.0)
    assert 10.0 <= y_vals[4] <= 12.0


def test_tabdiff_tabular_diffusion():
    rng = np.random.default_rng(42)
    x = np.linspace(0, 10, 50)
    y = 2.0 * x + rng.normal(0, 0.5, 50)
    cats = ["X" if v < 5 else "Y" for v in x]

    # Introduce missing values in y and cats
    y_with_nan = y.copy()
    y_with_nan[::5] = np.nan
    cats_with_none = list(cats)
    for i in range(0, 50, 7):
        cats_with_none[i] = None

    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(50)],
        "x": x,
        "y": y_with_nan,
        "cat": cats_with_none,
    })

    res, diag = tabdiff_impute(df, columns=["y", "cat"], num_steps=10, temperature=1.0, seed=123)
    assert res["y"].null_count() == 0
    assert res["cat"].null_count() == 0
    assert diag["method"] == "tabdiff"
    assert "imputedCounts" in diag
    assert diag["imputedCounts"]["y"] == 10


def test_preview_imputation():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3", "r4", "r5"],
        "val": [1.0, None, 3.0, 4.0, None],
    })
    prev = preview_imputation(df, column="val", strategy="mean")
    assert prev["column"] == "val"
    assert prev["beforeStats"]["missingCount"] == 2
    assert prev["afterStats"]["missingCount"] == 0
    assert len(prev["histogram"]) > 0
