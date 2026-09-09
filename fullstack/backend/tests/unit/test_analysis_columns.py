import polars as pl
import pytest

from app.domain.analysis_columns import resolve_analysis_columns
from app.domain.errors import BizError


@pytest.fixture
def codebook():
    return {'columns': [
        {'columnId': 'ca', 'name': 'a', 'role': 'question', 'scaleType': 'nominal', 'multiResponseGroup': 'q', 'missingCodes': ['99']},
        {'columnId': 'cb', 'name': 'b', 'role': 'question', 'scaleType': 'nominal', 'multiResponseGroup': 'q', 'missingCodes': ['99']},
        {'columnId': 'cx', 'name': 'x', 'role': 'attribute', 'scaleType': 'ratio'},
        {'columnId': 'ci', 'name': 'ID', 'role': 'id', 'scaleType': 'id'},
    ]}


def test_default_excludes_ma_and_explicit_empty_stays_empty(codebook):
    assert resolve_analysis_columns(codebook, None, scales={'ratio', 'nominal'}, allow_ma_options=True).names == ['x']
    assert resolve_analysis_columns(codebook, [], scales={'ratio'}).dependencies == []
    with pytest.raises(BizError):
        resolve_analysis_columns(codebook, ['ca'], scales={'ratio'})


def test_unrequested_sibling_only_controls_valid_population(codebook):
    plan = resolve_analysis_columns(codebook, ['ca', 'a', 'cx'], scales={'ratio'}, allow_ma_options=True)
    assert plan.names == ['a', 'x']
    assert plan.dependencies == ['a', 'x', 'b']
    frame = pl.DataFrame({'__rowId__': ['r1', 'r2', 'r3'], 'a': [1, 1, 0], 'b': [0, 99, 1], 'x': [2, 3, 4]})
    prepared, counts = plan.prepare(frame)
    assert prepared.columns == ['__rowId__', 'a', 'x']
    assert prepared['__rowId__'].to_list() == ['r1', 'r3']
    assert prepared['a'].to_list() == [1, 0]
    assert prepared['a'].dtype == pl.UInt8
    assert counts['q']['partial'] == 1


def test_explicit_role_and_unknown_column_validation(codebook):
    for names in [['missing'], ['ci'], ['ca']]:
        with pytest.raises(BizError):
            resolve_analysis_columns(codebook, names, scales={'ratio'}, roles={'attribute'}, allow_ma_options=True)
