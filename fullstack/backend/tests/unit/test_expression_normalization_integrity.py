"""INT-03: normalization preserves availability and is independent of units."""
from decimal import Decimal, localcontext
import math

import polars as pl
import pytest

from app.algorithms.transformation.expression import evaluate_expression


VECTORS = {
    "constant": [1.0, None, 1.0],
    "all_null": [None, None, None],
    "all_unavailable": [float("nan"), float("inf"), -float("inf"), None],
    "empty": [],
    "single_observation": [None, -7.0, None],
    "signed_zero": [-0.0, None, 0.0],
    "ordinary": [1.0, 2.0, 3.0, None],
    "tiny": [1e-14, 2e-14, 3e-14, None],
    "translated": [101.0, 102.0, 103.0, None],
    "negative_scale": [-3e-14, -6e-14, -9e-14, None],
    "large_offset": [1e16, 1e16 + 2.0, 1e16 + 4.0, None],
    "subnormal": [math.ulp(0.0), 2 * math.ulp(0.0), 3 * math.ulp(0.0), None],
    "extreme_span": [-1e308, 0.0, 1e308, None],
    "nonfinite": [1.0, float("nan"), 2.0, float("inf"), 3.0, -float("inf"), None],
}


def decimal_oracle(values, method):
    """Direct population formula on exact float values, without float scaling."""
    valid = [v for v in values if v is not None and math.isfinite(v)]
    if not valid:
        return [None] * len(values)
    with localcontext() as context:
        context.prec = 100
        exact = [Decimal.from_float(v) for v in valid]
        mean = sum(exact) / len(exact)
        scale = (sum((v - mean) ** 2 for v in exact) / len(exact)).sqrt()
        low, high = min(exact), max(exact)
        expected = []
        for value in values:
            if value is None or not math.isfinite(value):
                expected.append(None)
            elif high == low:
                expected.append(0.0)
            else:
                value = Decimal.from_float(value)
                expected.append(float((value - mean) / scale if method == "zscore"
                                      else (value - low) / (high - low)))
        return expected


@pytest.mark.parametrize("method", ["zscore", "minmax"])
@pytest.mark.parametrize("name", VECTORS)
def test_normalization_matches_independent_decimal_oracle(name, method):
    values = VECTORS[name]
    frame = pl.DataFrame({"x": pl.Series(values, dtype=pl.Float64)})
    expected = decimal_oracle(values, method)
    updated, series, meta = evaluate_expression(frame, f"{method}(x)", "normalized")
    actual = series.to_list()
    assert [v is None for v in actual] == [v is None for v in expected]
    assert [v for v in actual if v is not None] == pytest.approx(
        [v for v in expected if v is not None], abs=2e-14, rel=2e-14)
    assert series.to_arrow().is_valid().to_pylist() == [v is not None for v in expected]
    assert meta["stats"]["count"] == sum(v is not None for v in expected)
    assert meta["stats"]["nullCount"] == expected.count(None)
    assert updated["x"].equals(frame["x"])


@pytest.mark.parametrize("method", ["zscore", "minmax"])
def test_null_typed_input_is_unavailable_not_an_observation(method):
    frame = pl.DataFrame({"x": [None, None]})
    _, result, meta = evaluate_expression(frame, f"{method}(x)", "normalized")
    assert result.to_list() == [None, None]
    assert meta["stats"] == {"count": 0, "nullCount": 2}


@pytest.mark.parametrize("method", ["zscore", "minmax"])
def test_scalar_normalization_broadcasts_observed_zero(method):
    _, series, meta = evaluate_expression(pl.DataFrame({"x": [1, None, 2]}), f"{method}(7)", "result")
    assert series.to_list() == [0.0, 0.0, 0.0]
    assert meta["stats"]["count"] == 3


@pytest.mark.parametrize("method,expected", [
    ("zscore", [-math.sqrt(1.5), 0, math.sqrt(1.5), None]),
    ("minmax", [0, 0.5, 1, None]),
])
def test_positive_affine_units_preserve_analytic_result(method, expected):
    for values in ([1.0, 2.0, 3.0, None], [1e-14, 2e-14, 3e-14, None],
                   [1e16, 1e16 + 2.0, 1e16 + 4.0, None]):
        frame = pl.DataFrame({"x": values})
        _, result, _ = evaluate_expression(frame, f"{method}(x)", "normalized")
        assert result.to_list() == pytest.approx(expected, abs=2e-14)
