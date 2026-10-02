"""Accepted GUI audit D01/D03/D04/D06: semantic regressions, not bug snapshots."""
import numpy as np
import polars as pl
import pytest

from app.algorithms.summaries.core import question_summary
from app.algorithms.models.pca import compute_pca
from app.algorithms.pra.engine import ASYMMETRY_ALPHA, evaluate_penalty_reward
from app.services.dataset_service import generate_initial_codebook
from app.services.import_service import build_builtin_iris, probe_table


def inferred_spec(series):
    return generate_initial_codebook('audit', probe_table(series.to_frame(), len(series)))['columns'][0]


@pytest.mark.parametrize('values', [
    [f'ID-{i:03}' for i in range(150)],
    ['A'] * 100 + ['B'] * 100 + ['C'] * 50,
    [f'category-{i}' for i in range(101)],
])
def test_d01_inferred_categories_do_not_restrict_valid_domain(values):
    for ordered in (values, list(reversed(values))):
        series = pl.Series('answer', ordered)
        spec = inferred_spec(series)
        assert spec['categoryOrder'] == []
        result = question_summary(series, spec)
        assert result['denominators']['valid'] == len(values)
        assert result['denominators'].get('invalid', 0) == 0
        assert sum(d['count'] for d in result['distribution']) == len(values)


def test_d01_fresh_builtin_iris_ids_are_all_valid():
    df = build_builtin_iris()
    spec = next(c for c in generate_initial_codebook('iris', probe_table(df, df.height))['columns'] if c['name'] == 'id')
    assert spec['scaleType'] == 'id'
    assert question_summary(df['id'], spec)['denominators']['valid'] == 150


@pytest.mark.parametrize('values', [
    ['1'] * 200 + ['A'] * 50,
    ['1'] * 200 + ['001'] * 50,
    ['1'] * 249 + ['001'],
])
def test_d01_string_type_inference_uses_the_whole_column(values):
    for ordered in (values, list(reversed(values))):
        series = pl.Series('answer', ordered)
        spec = inferred_spec(series)
        assert spec['scaleType'] == 'nominal'
        result = question_summary(series, spec)
        assert result['denominators']['valid'] == len(values)
        assert result['denominators'].get('invalid', 0) == 0


def test_d01_numeric_string_inference_is_preserved():
    for ordered in (['1', '2', '3'] * 100, ['3', '2', '1'] * 100):
        spec = inferred_spec(pl.Series('answer', ordered))
        assert spec['scaleType'] == 'ratio'


def test_d01_explicit_declared_domain_remains_authoritative():
    series = pl.Series('answer', ['A', 'B', 'C', None, 'skip', 'missing'])
    spec = {'scaleType': 'nominal', 'categoryOrder': ['A', 'B'], 'missingCodes': ['skip', 'missing'], 'missingReasons': {'skip': '非該当'}}
    result = question_summary(series, spec)
    assert result['denominators'] == {'total': 6, 'target': 5, 'valid': 2, 'missing': 2, 'notApplicable': 1, 'invalid': 1}
    assert next(d for d in result['distribution'] if d['code'] == 'C')['isInvalid'] is True


@pytest.mark.parametrize('scale', ['ratio', 'interval', 'numeric'])
def test_d03_continuous_statistics_and_order_are_row_order_invariant(scale):
    series = build_builtin_iris()['sepal_length_cm']
    spec = {'scaleType': scale}
    result = question_summary(series, spec)
    reverse = question_summary(series.reverse(), spec)
    assert result == reverse
    assert 'top2Box' not in result['auxiliaryStats']
    assert 'bottom2Box' not in result['auxiliaryStats']
    assert 'meanNote' not in result['auxiliaryStats']
    values = [float(d['code']) for d in result['distribution']]
    assert values == sorted(values)


def test_d03_ordinal_boxes_reverse_and_exclude_missing_as_before():
    series = pl.Series('answer', [1, 1, 2, 3, 4, 5, 99])
    spec = {'scaleType': 'ordinal', 'categoryOrder': ['1', '2', '3', '4', '5'], 'missingCodes': ['99']}
    normal = question_summary(series, spec)['auxiliaryStats']
    reverse = question_summary(series, {**spec, 'isReversed': True})['auxiliaryStats']
    assert normal['top2Box']['n'] == 2
    assert normal['bottom2Box']['n'] == 3
    assert reverse['top2Box'] == normal['bottom2Box']
    assert reverse['bottom2Box'] == normal['top2Box']
    assert reverse['meanNote'] == '等間隔得点として計算'


def test_d04_response_discloses_distinct_coefficient_and_asymmetry_thresholds():
    df = build_builtin_iris()
    result = evaluate_penalty_reward(df, 'sepal_length_cm', ['sepal_width_cm', 'petal_length_cm', 'petal_width_cm'], alpha=0.05)
    assert result['model']['alpha'] == 0.05
    assert result['model']['asymmetry_alpha'] == ASYMMETRY_ALPHA == 0.15
    for attr in result['attributes']:
        assert attr['asymmetry_significant'] == (attr['asym_p'] < ASYMMETRY_ALPHA)
        assert '対称的に連動' not in attr['narrative']


def test_d06_covariance_loadings_keep_units_and_correlation_loadings_keep_values():
    df = build_builtin_iris()
    cols = ['sepal_length_cm', 'sepal_width_cm', 'petal_length_cm', 'petal_width_cm']
    covariance = compute_pca(df, columns=cols, use_correlation=False)
    correlation = compute_pca(df, columns=cols, use_correlation=True)
    assert abs(covariance['loadings']['petal_length_cm'][0]) > 1.7
    for result in (covariance, correlation):
        scores = np.array([row['pc'] for row in result['scores']])
        for col in cols:
            expected = np.corrcoef(df[col].to_numpy(), scores[:, 0])[0, 1]
            loading = result['loadings'][col][0]
            if not result['useCorrelation']:
                loading /= df[col].std()
            assert loading == pytest.approx(expected, abs=1e-10)
