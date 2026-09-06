"""Unit tests for AST expression evaluation and variable addition."""
from __future__ import annotations

import polars as pl
import pytest

from app.algorithms.transformation.expression import evaluate_expression, preview_expression
from app.domain.errors import BizError


def test_arithmetic_expressions():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3"],
        "a": [1.0, 2.0, 3.0],
        "b": [10.0, 20.0, 30.0],
    })
    updated_df, s, meta = evaluate_expression(df, "a + b * 2", "res")
    assert "res" in updated_df.columns
    assert s.to_list() == [21.0, 42.0, 63.0]
    assert meta["stats"]["min"] == 21.0
    assert meta["stats"]["max"] == 63.0


def test_math_functions_log_sqrt_zscore():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3"],
        "x": [1.0, 4.0, 9.0],
    })
    _, s_sqrt, _ = evaluate_expression(df, "sqrt(x)", "sqrt_x")
    assert s_sqrt.to_list() == [1.0, 2.0, 3.0]

    _, s_z, _ = evaluate_expression(df, "zscore(x)", "z_x")
    assert len(s_z) == 3
    assert abs(sum(s_z.to_list())) < 1e-6  # zero mean


def test_conditional_where():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3"],
        "score": [40.0, 75.0, 90.0],
    })
    _, s_pass, _ = evaluate_expression(df, "where(score >= 70, 'Pass', 'Fail')", "status")
    assert s_pass.to_list() == ["Fail", "Pass", "Pass"]


def test_preview_expression():
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(20)],
        "val": list(range(20)),
    })
    prev = preview_expression(df, "val * 10", "val10")
    assert prev["valid"] is True
    assert prev["error"] is None
    assert len(prev["previewValues"]) == 10
    assert prev["previewValues"][1] == 10.0

    # Invalid syntax
    bad_prev = preview_expression(df, "val +++ ", "bad")
    assert bad_prev["valid"] is False
    assert bad_prev["error"] is not None
