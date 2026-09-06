"""Tests for variable transformation (One-Hot and Binning)."""
from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from app.algorithms.transform.core import bin_numeric, compute_bin_edges, nominal_to_binary, preview_binning
from app.domain.errors import BizError


def test_nominal_to_binary_basic():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3", "r4"],
        "category": ["A", "B", "A", "C"],
        "val": [1.0, 2.0, 3.0, 4.0],
    })
    res_df, new_cols = nominal_to_binary(df, "category")
    assert sorted(new_cols) == ["category_A", "category_B", "category_C"]
    assert res_df["category_A"].to_list() == [1, 0, 1, 0]
    assert res_df["category_B"].to_list() == [0, 1, 0, 0]
    assert res_df["category_C"].to_list() == [0, 0, 0, 1]


def test_nominal_to_binary_drop_first():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3"],
        "category": ["A", "B", "C"],
    })
    res_df, new_cols = nominal_to_binary(df, "category", drop_first=True)
    assert sorted(new_cols) == ["category_B", "category_C"]
    assert "category_A" not in res_df.columns


def test_bin_numeric_equal_width():
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(10)],
        "score": [0.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 100.0],
    })
    res_df, col_name, summaries = bin_numeric(df, "score", method="equal_width", num_bins=4)
    assert col_name == "score_bin4"
    assert len(summaries) == 4
    assert res_df["score_bin4"].null_count() == 0
    assert res_df["score_bin4"][0] == summaries[0]["label"]


def test_bin_numeric_quantile():
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(100)],
        "val": list(range(100)),
    })
    res_df, col_name, summaries = bin_numeric(df, "val", method="quantile", num_bins=4)
    assert len(summaries) == 4
    # Each bin should have approximately 25 items
    for s in summaries:
        assert 20 <= s["count"] <= 30


def test_preview_binning():
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(20)],
        "num": [float(i) for i in range(20)],
    })
    preview = preview_binning(df, "num", method="equal_width", num_bins=3)
    assert preview["count"] == 20
    assert len(preview["bins"]) == 3
    assert len(preview["histogram"]["counts"]) > 0
