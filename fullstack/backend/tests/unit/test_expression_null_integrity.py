"""INT-09: expression output uses true nulls without inventing missing strings."""
import math

import polars as pl
import pytest

from app.algorithms.transformation.expression import evaluate_expression, preview_expression


@pytest.mark.parametrize("expression,expected,dtype", [
    ("text", ["a", None, "b"], pl.String),
    ("x * 2", [2.0, None, 4.0], pl.Float64),
    ("flag", [True, None, False], pl.Boolean),
    ("7", [7, 7, 7], pl.Int64),
    ("True", [True, True, True], pl.Boolean),
    ("'None'", ["None", "None", "None"], pl.String),
    ("None", [None, None, None], None),
    ("x > 1", [False, False, True], pl.Boolean),
    ("where(x == x, x, 7)", [1.0, 7.0, 2.0], pl.Float64),
    ("ifelse(x == x, x, 7)", [1.0, 7.0, 2.0], pl.Float64),
    ("x if x == x else 7", [1.0, 7.0, 2.0], pl.Float64),
    ("where(x == 1, x, None)", [1.0, None, None], pl.Float64),
    ("where(x == 1, None, x)", [None, None, 2.0], pl.Float64),
    ("where(x == 2, 'two', x)", ["1.0", None, "two"], pl.String),
    ("where(x == x, 'present', x)", ["present", None, "present"], pl.String),
    ("where(x == x, x, 'NaN')", ["1.0", "NaN", "2.0"], pl.String),
    ("where(x == x, flag, False)", [True, False, False], pl.Boolean),
    ("where(x == 1, True, None)", [True, None, None], pl.Boolean),
    ("x ** 0", [1.0, 1.0, 1.0], pl.Float64),
])
def test_actual_selected_result_controls_validity_and_type(expression, expected, dtype):
    frame = pl.DataFrame({"x": [1.0, None, 2.0], "text": ["a", None, "b"],
                          "flag": pl.Series([True, None, False], dtype=pl.Boolean),
                          "unrelated": [None, None, None]})
    updated, series, meta = evaluate_expression(frame, expression, "result")
    assert series.to_list() == expected
    if dtype is not None:
        assert series.dtype == dtype
    assert series.to_arrow().is_valid().to_pylist() == [v is not None for v in expected]
    assert meta["stats"]["count"] == sum(v is not None for v in expected)
    assert meta["stats"]["nullCount"] == expected.count(None)
    assert updated.drop("result").equals(frame)
    preview = preview_expression(frame, expression, "result")
    assert preview["valid"] is True
    # Preserve the existing UI contract: Boolean/integer samples are displayed
    # as text; React's direct child rendering would hide Boolean JSON values.
    expected_preview = [round(v, 4) if isinstance(v, float)
                        else None if v is None else str(v) for v in expected]
    assert preview["previewValues"] == expected_preview
    assert preview["stats"] == meta["stats"]


def test_missing_looking_strings_remain_literal_observations():
    values = ["None", "NaN", "nan", "inf", "-inf", "", None]
    frame = pl.DataFrame({"text": pl.Series(values, dtype=pl.String)})
    _, series, meta = evaluate_expression(frame, "text", "result")
    assert series.to_list() == values
    assert meta["stats"] == {"count": 6, "nullCount": 1}
    assert preview_expression(frame, "text")["previewValues"] == values


@pytest.mark.parametrize("expression,expected", [
    ("x", [1.0, None, None, None, None, 0.0]),
    ("1 / x", [1.0, None, 0.0, -0.0, None, None]),
    ("exp(x)", [math.e, None, None, 0.0, None, 1.0]),
    ("where(x == 1, x, 9)", [1.0, 9.0, 9.0, 9.0, 9.0, 9.0]),
])
def test_only_nonfinite_outputs_become_null(expression, expected):
    frame = pl.DataFrame({"x": [1.0, float("nan"), float("inf"), -float("inf"), None, 0.0]})
    _, series, meta = evaluate_expression(frame, expression, "result")
    assert series.to_list() == expected
    assert meta["stats"]["nullCount"] == expected.count(None)
    assert all(v is None or math.isfinite(v) for v in series.to_list())


def test_raw_code_arithmetic_remains_raw():
    frame = pl.DataFrame({"q": [1, 2, 99]})
    _, series, _ = evaluate_expression(frame, "q * 2", "result")
    assert series.to_list() == [2.0, 4.0, 198.0]


@pytest.mark.parametrize("expression,expected", [
    ("sqrt(where(x > 0, x, 0))", [1.0, 0.0, 2.0]),
    ("sqrt(where(x > 0, x, None))", [1.0, None, 2.0]),
    ("sqrt(where(cond=x > 0, a=x, b=None))", [1.0, None, 2.0]),
    ("sqrt(where(x < 0, x, None))", [None, None, None]),
    ("ifelse(x > 0, x, 0) + 2", [3.0, 2.0, 6.0]),
    ("sqrt(where(x > 0, ifelse(x > 1, x, 9), 0))", [3.0, 0.0, 2.0]),
    ("minmax(where(x > 0, x, None))", [0.0, None, 1.0]),
    ("zscore(where(x > 0, x, 0))", [-2 / math.sqrt(26), -5 / math.sqrt(26), 7 / math.sqrt(26)]),
])
def test_numeric_conditional_intermediates_remain_composable(expression, expected):
    frame = pl.DataFrame({"x": [1.0, None, 4.0]})
    _, series, _ = evaluate_expression(frame, expression, "result")
    assert series.to_list() == pytest.approx(expected)
