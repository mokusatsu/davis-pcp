"""INT-04/05/06/07: missing-only transforms preserve typed source identities."""
from __future__ import annotations

from decimal import Decimal
import math

import polars as pl
import pytest
from pydantic import ValidationError

from app.algorithms.transform import core
from app.domain.codebook import CodebookColumnPatch
from app.domain.errors import BizError


def frame(values, dtype=None):
    return pl.DataFrame({
        "__rowId__": [f"row-{i * 7 + 3}" for i in range(len(values))],
        "q": pl.Series("q", values, dtype=dtype),
    })


def assert_source(actual, original):
    assert actual.select(original.columns).schema == original.schema
    assert actual.select(original.columns).equals(original)


@pytest.mark.parametrize("values,dtype,expected", [
    ([True, False, None], pl.Boolean, {"q_False": [0, 1, None], "q_True": [1, 0, None]}),
    (["True", "False", "true", "false", None], pl.String,
     {"q_False": [0, 1, 0, 0, None], "q_True": [1, 0, 0, 0, None],
      "q_false": [0, 0, 0, 1, None], "q_true": [0, 0, 1, 0, None]}),
])
def test_typed_category_equality_and_literal_boolean_text(values, dtype, expected):
    original = frame(values, dtype)
    actual, names = core.nominal_to_binary(original, "q")
    assert names == sorted(expected)
    assert actual.select(names).to_dict(as_series=False) == expected
    assert all(actual[name].dtype == pl.Int32 for name in names)
    assert_source(actual, original)


@pytest.mark.parametrize("policy,expected_missing", [("as_missing", None), ("as_category", 0), ("as_zero", 0)])
def test_explicit_missing_only_contract_keeps_raw_invalid_and_reason_only_codes(policy, expected_missing):
    original = frame([1., 2., 7., 8., 99., None, float("nan"), float("inf")])
    book = {"columns": [{"name": "q", "columnId": "stable-q", "scaleType": "ordinal",
                         "categoryOrder": ["1", "2", "99"], "isReversed": True,
                         "missingCodes": ["99"], "missingReasons": {"7": "not_applicable"}}]}
    actual, names = core.nominal_to_binary(original, "q", codebook=book, handle_null=policy)
    assert names[:4] == ["q_1.0", "q_2.0", "q_7.0", "q_8.0"]
    assert actual["q_7.0"].to_list() == [0, 0, 1, 0, *([expected_missing] * 4)]
    if policy == "as_category":
        assert actual["q_null"].to_list() == [0, 0, 0, 0, 1, 1, 1, 1]
    preview = core.preview_binning(original, "q", num_bins=2, codebook=book)
    binned, name, bins = core.bin_numeric(original, "q", num_bins=2, codebook=book)
    assert preview["count"] == 4
    assert preview["edges"] == [1., 4.5, 8.]
    assert preview["bins"] == bins
    assert binned[name].to_list() == [1, 1, 2, 2, None, None, None, None]
    assert_source(actual, original)
    assert_source(binned, original)


def test_shared_name_allocator_reserves_null_literal_sanitized_names_prefix_and_repeats():
    original = frame(["a b", "a/b", "null", None]).with_columns(
        pl.Series("chosen_a_b", [10, 20, 30, 40]),
        pl.Series("chosen_a_b_1", [11, 21, 31, 41]),
        pl.Series("chosen_null", [100, 200, 300, 400]),
    )
    first, first_names = core.nominal_to_binary(original, "q", prefix="chosen", handle_null="as_category")
    assert first_names == ["chosen_a_b_2", "chosen_a_b_3", "chosen_null_1", "chosen_null_2"]
    assert first.select(first_names).to_dict(as_series=False) == {
        "chosen_a_b_2": [1, 0, 0, 0], "chosen_a_b_3": [0, 1, 0, 0],
        "chosen_null_1": [0, 0, 1, 0], "chosen_null_2": [0, 0, 0, 1],
    }
    second, second_names = core.nominal_to_binary(first, "q", prefix="chosen", handle_null="as_category")
    assert not set(second_names).intersection(first.columns)
    assert len(set(second_names)) == 4
    assert_source(first, original)
    assert_source(second, first)


def test_invalid_destination_batch_is_rejected_before_attachment(monkeypatch):
    original = frame(["a", "b", None])
    before = original.clone()
    monkeypatch.setattr(core, "_allocate_column_name", lambda *_: "q")
    with pytest.raises(BizError) as error:
        core.nominal_to_binary(original, "q", handle_null="as_category")
    assert error.value.code == "TRANSFORM_INVALID_OUTPUT"
    assert original.equals(before)


def test_narrow_four_bins_keep_integer_identities_separate_from_rounded_labels():
    original = frame([1.001, 1.002, 1.003, 1.004])
    actual, name, bins = core.bin_numeric(original, "q", num_bins=4)
    oracle_edges = [float(Decimal("1.001") + Decimal("0.00075") * k) for k in range(5)]
    assert actual[name].dtype == pl.Int32
    assert actual[name].to_list() == [1, 2, 3, 4]
    assert [item["binId"] for item in bins] == [1, 2, 3, 4]
    assert [item["count"] for item in bins] == [1, 1, 1, 1]
    assert [item["min"] for item in bins] + [bins[-1]["max"]] == pytest.approx(oracle_edges, abs=1e-15)
    assert len({item["label"] for item in bins}) < 4
    assert [item["lowerInclusive"] for item in bins] == [True] * 4
    assert [item["upperInclusive"] for item in bins] == [False, False, False, True]
    assert core.preview_binning(original, "q", num_bins=4)["bins"] == bins
    assert_source(actual, original)


@pytest.mark.parametrize("shift,scale", [(0., 1.), (-123., 1e-6), (1e8, 10.), (0., 1e-12)])
def test_bin_membership_is_independent_of_display_precision_shift_and_scale(shift, scale):
    values = [shift + scale * x for x in [0., 1., 2., 3., 4.]] + [None]
    original = frame(values)
    actual, name, bins = core.bin_numeric(original, "q", num_bins=4)
    # Internal cut points belong to the bin on their right; the final endpoint
    # belongs to the final bin. This oracle does not call product bin helpers.
    expected = []
    oracle_edges = [values[0] + (values[4] - values[0]) * index / 4 for index in range(5)]
    assert [item["min"] for item in bins] + [bins[-1]["max"]] == oracle_edges
    for value in values:
        expected.append(None if value is None else next(
            index + 1 for index in range(4)
            if oracle_edges[index] <= value
            and (value < oracle_edges[index + 1] or index == 3 and value <= oracle_edges[index + 1])))
    assert actual[name].to_list() == expected
    assert sum(item["count"] for item in bins) == 5
    assert len(set(actual[name].drop_nulls())) == 4
    assert_source(actual, original)


@pytest.mark.parametrize("values,options,expected,edges", [
    ([0., 1., 2., None], {"method": "custom", "custom_cuts": [1.]}, [1, 2, 2, None], [0., 1., 2.]),
    ([0.] * 4 + [1.] * 4, {"method": "quantile", "num_bins": 4}, [1] * 4 + [2] * 4, [0., .5, 1.]),
    ([7., 7., None], {"num_bins": 4}, [1, 1, None], [6.5, 7.5]),
])
def test_custom_quantile_duplicate_and_constant_bins(values, options, expected, edges):
    original = frame(values)
    actual, name, bins = core.bin_numeric(original, "q", **options, labels_format="bin_number")
    preview = core.preview_binning(original, "q", **options, labels_format="bin_number")
    assert actual[name].to_list() == expected
    assert preview["edges"] == edges
    assert preview["bins"] == bins
    assert [item["label"] for item in bins] == [f"Bin {k + 1}" for k in range(len(bins))]


def test_bin_definitions_reject_ambiguous_nonfinite_or_nonpartition_metadata():
    valid = [dict(binId=1, min=0., max=1., lowerInclusive=True, upperInclusive=False),
             dict(binId=2, min=1., max=2., lowerInclusive=True, upperInclusive=True)]
    assert CodebookColumnPatch(binDefinitions=valid).binDefinitions is not None
    for index, changes in [
        (0, {"binId": 2}), (0, {"binId": True}), (0, {"min": float("inf")}),
        (0, {"max": 0.}), (0, {"upperInclusive": True}), (1, {"min": 1.5}),
        (1, {"lowerInclusive": False}), (1, {"extra": "unexpected"}),
    ]:
        malformed = [dict(item) for item in valid]
        malformed[index].update(changes)
        with pytest.raises(ValidationError):
            CodebookColumnPatch(binDefinitions=malformed)


@pytest.mark.parametrize("operation", [core.nominal_to_binary, core.bin_numeric, core.preview_binning])
def test_all_missing_sources_fail_without_mutating_raw_values(operation):
    original = frame([99., None, float("nan")])
    before = original.clone()
    book = {"columns": [{"name": "q", "missingCodes": ["99"]}]}
    with pytest.raises(BizError) as error:
        operation(original, "q", codebook=book)
    assert error.value.code == "TRANSFORM_EMPTY_COLUMN"
    assert original.equals(before)


FLOAT64_MAX = float.fromhex("0x1.fffffffffffffp+1023")
RESOLUTION_CASES = [
    [1e20, 1e20], [-1e20, -1e20], [FLOAT64_MAX, FLOAT64_MAX], [-FLOAT64_MAX, -FLOAT64_MAX],
    [1e20, math.nextafter(1e20, math.inf)], [-1e20, math.nextafter(-1e20, math.inf)],
    [math.nextafter(FLOAT64_MAX, -math.inf), FLOAT64_MAX],
    [-FLOAT64_MAX, math.nextafter(-FLOAT64_MAX, math.inf)],
]


@pytest.mark.parametrize("values", RESOLUTION_CASES)
def test_representable_constant_and_adjacent_bounds_preserve_membership_and_preview(values):
    original = frame([*values, None])
    actual, name, bins = core.bin_numeric(original, "q", num_bins=4)
    preview = core.preview_binning(original, "q", num_bins=4)
    if values[0] == values[1]:
        lower = math.nextafter(values[0], -math.inf)
        upper = math.nextafter(values[0], math.inf)
        expected_edges = [lower if math.isfinite(lower) else values[0],
                          upper if math.isfinite(upper) else values[0]]
    else:
        expected_edges = values
    assert preview["edges"] == expected_edges
    assert actual[name].to_list() == [1, 1, None]
    assert len(bins) == 1
    assert bins[0]["count"] == preview["count"] == 2
    assert bins[0]["lowerInclusive"] is bins[0]["upperInclusive"] is True
    assert preview["bins"] == bins
    histogram_edges = preview["histogram"]["edges"]
    assert all(math.isfinite(value) for value in histogram_edges)
    assert all(low < high for low, high in zip(histogram_edges, histogram_edges[1:]))
    assert sum(preview["histogram"]["counts"]) == 2
    assert_source(actual, original)


@pytest.mark.parametrize("values,lower,upper,expected_counts", [
    ([7., 7., None], 6.5, 7.5, [0, 0, 0, 0, 0, 2, 0, 0, 0, 0]),
    ([0., 1., 2., 3., 4.], 0., 4., [1, 0, 1, 0, 0, 1, 0, 1, 0, 1]),
])
def test_ordinary_preview_histogram_bounds_shape_and_counts_are_preserved(values, lower, upper, expected_counts):
    preview = core.preview_binning(frame(values), "q")
    histogram = preview["histogram"]
    assert histogram["edges"] == pytest.approx([lower + (upper - lower) * i / 10 for i in range(11)])
    assert histogram["counts"] == expected_counts
