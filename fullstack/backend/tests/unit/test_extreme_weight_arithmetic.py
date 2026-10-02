"""W01/W02: finite weight scales must not destroy ratios or design variance."""
from fractions import Fraction
import json

import numpy as np
import polars as pl
import pytest

from app.algorithms.summaries.core import summarize, correlation_matrix_df
from app.algorithms.summaries.crosstab import compute_crosstab
from app.algorithms.survey.covariance import mean_covariance
from app.algorithms.survey.design import build_design
from app.algorithms.survey.diagnostics import weight_diagnostics
from app.algorithms.survey.rao_scott import rao_scott_test


@pytest.mark.parametrize("factor", [1., 1e-160, 1e160, 1e307])
def test_diagnostics_against_exact_rational_oracle(factor):
    values = [1, 2, 3, 4, 5, 6]
    total = sum(map(Fraction, values))
    kish = total * total / sum(Fraction(w) ** 2 for w in values)
    mean = total / len(values)
    variance = sum((Fraction(w) - mean) ** 2 for w in values) / (len(values) - 1)
    actual = weight_diagnostics(np.array(values) * factor)
    assert actual['kishEffectiveN'] == pytest.approx(float(kish), rel=1e-14)
    assert actual['weightCv'] == pytest.approx(float(variance) ** .5 / float(mean), rel=1e-14)
    assert actual['weightingDeff'] == pytest.approx(float(len(values) / kish), rel=1e-14)
    assert actual['positiveWeightN'] == 6
    assert actual['weightSumStatus'] == ('out_of_range' if factor == 1e307 else 'ok')
    assert (actual['weightSum'] is None) == (factor == 1e307)
    json.dumps(actual, allow_nan=False)


@pytest.mark.parametrize("factor", [1e-160, 1e160, 1e308])
def test_equal_weight_diagnostics_are_exact_and_include_zero_count(factor):
    actual = weight_diagnostics([factor] * 8 + [0, None])
    assert actual['kishEffectiveN'] == 8
    assert actual['weightCv'] == 0
    assert actual['weightingDeff'] == 1
    assert actual['weightN'] == 9 and actual['positiveWeightN'] == 8


@pytest.mark.parametrize("factor", [1., 1e-160, 1e160, 1e308])
def test_summary_ratios_survive_weight_sum_overflow(factor):
    result = summarize(pl.DataFrame({'x': [1, 2, 3, 1, 2, 3, 1, 2]}), {'x': 'numeric'},
                       codebook={'columns': [{'name': 'x', 'scaleType': 'ratio'}]}, weights=[factor] * 8)
    weighted = result['x']['weighted']
    assert weighted['weightedMean'] == 1.875
    assert {d['code']: d['weightedPct'] for d in weighted['distribution']} == {'1': 37.5, '2': 37.5, '3': 25.}
    if factor == 1e308:
        assert weighted['weightedN'] is None
        assert weighted['weightedNStatus'] == 'out_of_range'
        assert weighted['warnings'][0]['code'] == 'WEIGHT_TOTAL_OUT_OF_RANGE'
        assert all(d['weightedCount'] is None and d['weightedCountStatus'] == 'out_of_range'
                   for d in weighted['distribution'])
    else:
        assert weighted['weightedN'] == pytest.approx(factor * 8, rel=1e-14, abs=0)
        assert weighted['weightedN'] > 0
    json.dumps(result, allow_nan=False)


def test_absolute_category_counts_are_not_replaced_by_normalized_counts():
    result = summarize(pl.DataFrame({'x': [1, 2]}), {'x': 'numeric'},
                       codebook={'columns': [{'name': 'x', 'scaleType': 'ratio'}]}, weights=[1e308] * 2)
    weighted = result['x']['weighted']
    assert weighted['weightedN'] is None and weighted['weightedMean'] == 1.5
    assert [d['weightedCount'] for d in weighted['distribution']] == [1e308, 1e308]
    assert [d['weightedPct'] for d in weighted['distribution']] == [50, 50]


@pytest.mark.parametrize("factor", [1., 1e-160, 1e160, 1e307])
def test_design_variance_matches_independent_psu_total_oracle(factor):
    weights = np.array([1., 2., 3., 4., 5., 6.])
    strata = np.array(['s1'] * 3 + ['s2'] * 3)
    psu = np.array(['a', 'b', 'c'] * 2)
    row = np.array([0, 1, 0, 1, 0, 1]); col = np.array([0, 0, 1, 1, 0, 1])
    indicator = np.eye(4)[row * 2 + col]
    probability = weights / 21
    mean = probability @ indicator
    linearized = probability[:, None] * (indicator - mean)
    expected = np.zeros((4, 4))
    for block in (linearized[:3], linearized[3:]):
        centered = block - block.mean(axis=0)
        expected += 1.5 * centered.T @ centered
    design = build_design(weights * factor, strata=strata, psu=psu)
    actual = mean_covariance(indicator, design)
    np.testing.assert_allclose(actual, expected, rtol=1e-13, atol=1e-17)
    assert np.linalg.eigvalsh(actual).min() >= -1e-15
    assert design.size == 6 and design.number_of_psus == 6 and design.design_df == 4
    table = np.zeros((2, 2)); np.add.at(table, (row, col), weights * factor)
    baseline = np.zeros((2, 2)); np.add.at(baseline, (row, col), weights)
    reference = rao_scott_test(baseline, row, col, build_design(weights, strata=strata, psu=psu))
    result = rao_scott_test(table, row, col, design)
    assert result is not None and reference is not None
    assert result.p_value == pytest.approx(reference.p_value, rel=1e-12)


def test_pairwise_weighted_correlation_survives_overflow():
    frame = pl.DataFrame({'x': [0, 1, 2, 10], 'y': [0, 1, 9, 1]})
    baseline = correlation_matrix_df(frame, ['x', 'y'], [1.] * 4)
    assert correlation_matrix_df(frame, ['x', 'y'], [1e308] * 4) == baseline


def test_frequency_replication_retains_absolute_sample_size():
    cells = [('A', 'X', 4), ('A', 'Y', 7), ('A', 'Z', 3),
             ('B', 'X', 11), ('B', 'Y', 5), ('B', 'Z', 13)]
    cb = {'columns': [{'name': 'a', 'scaleType': 'nominal'}, {'name': 'b', 'scaleType': 'nominal'}]}
    compressed = pl.DataFrame({'a': [a for a, _, _ in cells], 'b': [b for _, b, _ in cells]})
    expanded = pl.DataFrame({'a': [a for a, _, n in cells for _ in range(n)],
                             'b': [b for _, b, n in cells for _ in range(n)]})
    weighted = compute_crosstab(compressed, 'a', 'b', cb, weights=[n for _, _, n in cells], weight_type='frequency')
    ordinary = compute_crosstab(expanded, 'a', 'b', cb)
    doubled = compute_crosstab(compressed, 'a', 'b', cb, weights=[2 * n for _, _, n in cells], weight_type='frequency')
    assert weighted['inference']['pValue'] == pytest.approx(.0721803938951, abs=1e-12)
    assert weighted['inference']['statistic'] == pytest.approx(ordinary['inference']['statistic'], rel=1e-14)
    assert doubled['inference']['statistic'] == pytest.approx(2 * ordinary['inference']['statistic'], rel=1e-14)
    assert weighted['grandTotal']['count'] == 43


def test_unrepresentable_absolute_chi_square_keeps_valid_cramers_v():
    from app.algorithms.summaries.association import descriptive_association
    from app.algorithms.summaries.inference import frequency_inference
    counts = np.eye(3) * 5e307
    descriptive = descriptive_association(counts, weighted=True)
    assert descriptive['pearsonChi2'] is None
    assert descriptive['pearsonChi2Status'] == 'out_of_range'
    assert descriptive['weightedCramersV'] == pytest.approx(1.)
    inference = frequency_inference(counts)
    assert inference.status == 'unavailable' and inference.statistic_status == 'out_of_range'
    assert inference.p_value is None and inference.statistic is None
    assert inference.warnings[0]['code'] == 'CROSSTAB_PEARSON_OUT_OF_RANGE'
    json.dumps({'descriptive': descriptive, 'inference': inference.to_payload()}, allow_nan=False)
