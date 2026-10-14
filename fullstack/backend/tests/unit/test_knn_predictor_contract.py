"""Independent KNN predictor-geometry tests, not historical output snapshots."""
import polars as pl
import pytest

from app.algorithms.imputation.core import impute_dataframe, preview_imputation, preview_imputation_plan
from app.algorithms.imputation.plan import build_imputation_plan
from app.domain.errors import BizError


def impute(df, targets, predictors=None):
    return impute_dataframe(df, targets, 'knn', {'knn_neighbors': 1}, predictors=predictors)


@pytest.mark.parametrize('predictors', [None, ['x'], ['x', 'x2', 'x3']])
def test_exact_predictor_match_wins_over_target_mean(predictors):
    df = pl.DataFrame({'x': [0., 1., 100., 0.], 'y': [100., 0., 0., None],
                       'x2': [0., 1., 100., 0.], 'x3': [0., 1., 100., 0.]})
    out, diag = impute(df, ['y'], predictors)
    assert out['y'].to_list() == [100., 0., 0., 100.]
    expected = ['x', 'x2', 'x3'] if predictors is None else predictors
    assert diag['conditioningColumns'] == diag['predictorColumns'] == expected
    assert df['y'][-1] is None
    for c in expected:
        assert out[c].to_list() == df[c].to_list()


def test_selecting_another_target_does_not_change_explicit_predictor_geometry():
    df = pl.DataFrame({'x': [0., 80., 100., 0.], 'y': [0., 10., 10., None],
                       'z': [100., 0., 0., 0.]})
    for targets in (['y'], ['y', 'z'], ['z', 'y']):
        out, diag = impute(df, targets, ['x'])
        assert out['y'][-1] == 0.
        assert diag['conditioningColumns'] == ['x']


def test_default_excludes_every_target_and_explicit_omission_is_respected():
    df = pl.DataFrame({'x': [0., 1., 100., 0.], 'y': [100., 0., 0., None],
                       'z': [0., 100., 0., 100.]})
    default, diag = impute(df, ['y', 'z'])
    assert default['y'][-1] == 100.
    assert diag['conditioningColumns'] == ['x']
    explicit, diag = impute(df, ['y'], ['x'])
    assert explicit['y'][-1] == 100.
    assert diag['conditioningColumns'] == ['x']
    other, diag = impute(df, ['y'], ['z'])
    assert other['y'][-1] == 0.
    assert diag['conditioningColumns'] == ['z']


def test_plan_defaults_exclude_weight_multiresponse_and_categorical():
    df = pl.DataFrame({'x': [0., 1., 100., 0.], 'y': [100., 0., 0., None],
                       'weight': [0., 100., 0., 100.], 'ma': [0, 1, 0, 1],
                       'group': ['a', 'b', 'a', 'b']})
    cb = {'columns': [{'name': 'weight', 'role': 'weight'}, {'name': 'ma', 'multiResponseGroup': 'g'}]}
    plan = build_imputation_plan(df, cb, ['y'], strategy='knn', options={'knn_neighbors': 1})
    assert plan.predictorColumns == ['x']
    preview = preview_imputation_plan(df, plan)
    assert preview['diagnostics']['conditioningColumns'] == ['x']
    assert {e.reason for e in plan.excludedColumns} == {
        'PREDICTOR_WEIGHT_EXCLUDED', 'PREDICTOR_MULTI_RESPONSE_EXCLUDED', 'PREDICTOR_CATEGORICAL_IGNORED'}


@pytest.mark.parametrize('predictors', [None, [], ['group']])
def test_no_numeric_predictors_reject_instead_of_using_target(predictors):
    df = pl.DataFrame({'y': [100., 0., 0., None], 'group': ['a', 'b', 'a', 'b']})
    with pytest.raises(BizError) as error:
        impute(df, ['y'], predictors)
    assert error.value.code == 'IMPUTATION_NO_PREDICTORS'
    assert error.value.status_code == 422
    assert df['y'][-1] is None


def test_direct_self_predictor_is_rejected():
    with pytest.raises(BizError) as error:
        impute(pl.DataFrame({'y': [1., None]}), ['y'], ['y'])
    assert error.value.code == 'IMPUTATION_SELF_PREDICTOR'


def test_no_predictors_does_not_block_noop_or_categorical_mode_fallback():
    out, _ = impute(pl.DataFrame({'y': [1., 2.]}), ['y'], [])
    assert out['y'].to_list() == [1., 2.]
    out, _ = impute(pl.DataFrame({'y': ['a', None, 'a']}), ['y'], [])
    assert out['y'].to_list() == ['a', 'a', 'a']


def test_missing_predictor_mean_substitution_is_preserved():
    df = pl.DataFrame({'x': [0., 10., 20., None], 'y': [100., 7., 200., None]})
    out, diag = impute(df, ['y'], ['x'])
    assert out['y'][-1] == 7.  # Missing x maps to observed x mean=10.
    assert out['x'][-1] is None
    assert diag['conditioningColumns'] == ['x']


def test_single_column_preview_uses_default_non_target_predictors():
    df = pl.DataFrame({'x': [0., 1., 100., 0.], 'y': [100., 0., 0., None]})
    preview = preview_imputation(df, 'y', 'knn', {'knn_neighbors': 1})
    assert preview['afterStats']['mean'] == 50.
    assert preview['diagnostics']['conditioningColumns'] == ['x']


def test_selecting_all_numeric_columns_rejects_without_reintroducing_targets():
    df = pl.DataFrame({'x': [1., 2., 3.], 'y': [100., 0., None]})
    with pytest.raises(BizError) as error:
        impute(df, ['x', 'y'])
    assert error.value.code == 'IMPUTATION_NO_PREDICTORS'
