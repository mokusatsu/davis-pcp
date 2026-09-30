"""Regression cases from the September 2026 survey-analysis QA report."""
import json
import math

import numpy as np
import polars as pl
import pytest
from starlette.responses import JSONResponse

from app.algorithms.models.logistic import run_logistic_regression
from app.algorithms.models.pca import compute_pca
from app.algorithms.summaries.crosstab import compute_crosstab
from app.algorithms.summaries.inference import unweighted_inference
from app.domain.errors import BizError


def logistic_fixture(step):
    return pl.DataFrame({'x': [0.0] * 10 + [step] * 10,
                         'y': [0] * 9 + [1] + [0] + [1] * 9})


@pytest.mark.parametrize('step', [0.1, -0.1])
def test_logistic_representable_large_and_small_odds_are_not_clipped(step):
    result = run_logistic_regression(logistic_fixture(step), 'y', ['x'])
    coefficient = result['coefficients'][1]
    beta = 2 * math.log(9) / step
    assert result['fitMetrics']['converged']
    assert result['diagnostics']['completeSeparation'] is False
    assert coefficient['coefficient'] == pytest.approx(beta, rel=1e-6)
    for field, log_field in [('oddsRatio', 'logOddsRatio'), ('ciLower', 'logCiLower'), ('ciUpper', 'logCiUpper')]:
        assert coefficient[field] == pytest.approx(math.exp(coefficient[log_field]), rel=1e-13)
        assert coefficient['exponentiationStatus'][field] == 'finite'
    assert coefficient['ciLower'] < coefficient['oddsRatio'] < coefficient['ciUpper']
    assert coefficient['oddsRatio'] == pytest.approx(math.exp(beta), rel=1e-5)
    assert math.exp(coefficient['logOddsRatio'] * step) == pytest.approx(81, rel=1e-5)
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize('step,status', [(0.001, 'overflow'), (-0.001, 'underflow')])
def test_logistic_exponentiation_out_of_range_is_explicit_and_json_safe(step, status):
    result = run_logistic_regression(logistic_fixture(step), 'y', ['x'])
    coefficient = result['coefficients'][1]
    assert coefficient['oddsRatio'] is None
    assert coefficient['exponentiationStatus']['oddsRatio'] == status
    assert math.isfinite(coefficient['logOddsRatio'])
    assert any(w['code'] == 'LOGISTIC_EXPONENTIATION_RANGE' for w in result['warnings'])
    JSONResponse(result)


@pytest.mark.parametrize('use_correlation', [True, False])
def test_all_constant_pca_is_a_clear_error(use_correlation):
    with pytest.raises(BizError) as error:
        compute_pca(pl.DataFrame({'x': [1, 1, 1], 'y': [2, 2, 2]}), use_correlation=use_correlation)
    assert error.value.code == 'PCA_ZERO_VARIANCE'
    assert error.value.details['columns'] == ['x', 'y']


@pytest.mark.parametrize('use_correlation', [True, False])
def test_partial_constant_pca_excludes_named_columns_and_warns(use_correlation):
    result = compute_pca(pl.DataFrame({'fixed': [1, 1, 1, 1], 'x': [1, 2, 3, 4], 'y': [4, 1, 2, 3]}),
                         use_correlation=use_correlation)
    assert result['columns'] == ['x', 'y']
    assert result['excludedConstantColumns'] == ['fixed']
    assert result['warnings'][0]['code'] == 'PCA_CONSTANT_COLUMNS_EXCLUDED'
    assert set(result['loadings']) == {'x', 'y'}
    assert sum(result['explainedVarianceRatio']) == pytest.approx(1, abs=0.0001)
    JSONResponse(result)


def test_pca_constants_are_detected_in_complete_case_scope():
    frame = pl.DataFrame({'__rowId__': ['a', 'b', 'c', 'd'], 'x': [1, 1, 2, 3], 'y': [2, 2, 3, 4]})
    with pytest.raises(BizError) as error:
        compute_pca(frame, row_ids=['a', 'b'])
    assert error.value.code == 'PCA_ZERO_VARIANCE'


@pytest.mark.parametrize('counts,status,p_value', [
    ([[5, 0], [0, 5]], 'infinite', 1 / 126),
    ([[0, 5], [5, 0]], 'finite', 1 / 126),
    ([[6, 2], [1, 4]], 'finite', None),
    ([[5, 0], [0, 0]], 'undefined', 1.0),
])
def test_fisher_preserves_p_value_and_serializes_nonfinite_odds(counts, status, p_value):
    result = unweighted_inference(np.array(counts), method='fisher_exact')
    payload = result.to_payload()
    assert payload['status'] == 'ok'
    assert payload['statisticStatus'] == status
    if p_value is not None:
        assert payload['pValue'] == pytest.approx(p_value)
    if status != 'finite':
        assert payload['statistic'] is None
        assert result.warnings[0]['code'] == 'CROSSTAB_FISHER_ODDS_RATIO_NONFINITE'
    JSONResponse(payload)


def test_empty_crosstab_has_complete_descriptive_contract():
    frame = pl.DataFrame({'a': [], 'b': []}, schema={'a': pl.String, 'b': pl.String})
    result = compute_crosstab(frame, 'a', 'b', codebook={'columns': [
        {'name': name, 'scaleType': 'nominal'} for name in ['a', 'b']]})
    assert result['descriptiveAssociation'] == {'pearsonChi2': None, 'df': 0,
        'cramersV': None, 'weightedCramersV': None, 'weighted': False}


def test_fisher_still_ignores_unobserved_extra_display_categories():
    frame = pl.DataFrame({'a': ['A'] * 5 + ['B'] * 5, 'b': ['X'] * 5 + ['Y'] * 5})
    codebook = {'columns': [
        {'name': 'a', 'scaleType': 'nominal', 'categoryOrder': ['A', 'B', 'unobserved']},
        {'name': 'b', 'scaleType': 'nominal', 'categoryOrder': ['X', 'Y']}]}
    result = compute_crosstab(frame, 'a', 'b', codebook=codebook, inference='fisher_exact')
    assert len(result['rowCategories']) == 3
    assert result['inference']['pValue'] == pytest.approx(1 / 126)
    JSONResponse(result)
