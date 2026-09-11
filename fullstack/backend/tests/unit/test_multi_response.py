import copy
import json
from pathlib import Path

import polars as pl
import pytest

from app.domain.multi_response import classify_row, match_group, resolve_groups, summarize_group, validate_group
from app.storage.dataset_store import DatasetStore


def group():
    return resolve_groups({'columns': [
        {'columnId': name, 'name': name, 'multiResponseGroup': 'q', 'scaleType': 'nominal',
         'role': 'question', 'missingCodes': ['98', '99'], 'missingReasons': {'98': '非該当'}}
        for name in ['a', 'b']
    ]})[0]


@pytest.mark.parametrize('values,status', [
    ([1, 0], 'valid'), ([0, 0], 'valid'), ([1, 1], 'valid'),
    ([98, 98], 'notApplicable'), ([99, 99], 'missing'),
    ([1, 99], 'partial'), ([0, 99], 'partial'), ([98, 99], 'invalid'),
    ([98, 1], 'invalid'), ([2, 0], 'invalid'), ([None, None], 'missing'),
    ([float('nan'), 1], 'partial'), ([1.0, 0.0], 'valid'), (['01', 0], 'invalid'),
])
def test_response_states(values, status):
    assert classify_row(values, group())[0] == status


def test_column_specific_missing_and_all_zero_policy():
    g = group()
    g['columns'][1]['missingReasons'] = {'98': '無回答'}
    assert classify_row([98, 98], g)[0] == 'invalid'
    g['allUnselectedMeaning'] = 'missing'
    assert classify_row([0, 0], g)[0] == 'missing'
    g['allUnselectedMeaning'] = 'notApplicable'
    assert classify_row([0, 0], g)[0] == 'notApplicable'
    g['maxSelections'] = 1
    assert classify_row([1, 1], g)[0] == 'invalid'


def test_counts_match_exact_population_and_predicates():
    df = pl.DataFrame({'__rowId__': ['r1', 'r2', 'r3', 'r4', 'r5'],
                       'a': [1, 1, 0, 1, 98], 'b': [1, 0, 1, 99, 98]})
    g = group()
    result = summarize_group(df, g, ['r1', 'r4'])
    assert result['denominators'] == dict(total=5, target=4, valid=3, partial=1, missing=0, invalid=0, notApplicable=1)
    assert result['totalResponses'] == 4
    assert sum(i['pctRespondent'] for i in result['items']) > 100
    assert sum(i['pctResponse'] for i in result['items']) == pytest.approx(100)
    for item in result['items']:
        ids = match_group(df, g, [item['columnId']], 'any')
        assert len(ids) == item['selectedN']
        assert item['selectedInSelection'] == 1
    assert match_group(df, g, ['a', 'b'], 'any') == ['r1', 'r2', 'r3']
    assert match_group(df, g, ['a', 'b'], 'all') == ['r1']
    assert match_group(df, g, ['a'], 'unselected') == ['r3']
    assert match_group(df, g, [], 'status', 'partial') == ['r4']
    assert match_group(df, g, [], 'status', 'notApplicable') == ['r5']
    assert match_group(df, g, [], 'any') == []
    empty = summarize_group(df.head(0), g)
    assert empty['denominators']['total'] == 0
    assert all(i['pctRespondent'] is None and i['pctResponse'] is None for i in empty['items'])
    with pytest.raises(ValueError):
        match_group(df, g, [], 'bad-mode')


def test_weights_scale_selections_and_keep_the_plain_counts():
    """WEIGHT-03 / B05: counts stay integers, ratios become weighted."""
    df = pl.DataFrame({'__rowId__': ['r1', 'r2', 'r3', 'r4'],
                       'a': [1, 1, 0, 99], 'b': [0, 1, 0, 99]})
    g = group()
    unweighted = summarize_group(df, g)
    scaled = summarize_group(df, g, weights=[1.0, 1.0, 1.0, 1.0])
    assert scaled['items'] == unweighted['items']
    assert scaled['weightedValidN'] == 3.0 and unweighted['weightedValidN'] is None

    result = summarize_group(df, g, weights=[1.0, 3.0, 1.0, 1.0])
    assert result['denominators']['valid'] == 3
    assert result['weightedValidN'] == 5.0
    # r1 (weight 1) selects one option, r2 (weight 3) selects two, r3 none.
    assert result['weightedResponses'] == pytest.approx(1.0 + 2 * 3.0)
    assert [i['selectedN'] for i in result['items']] == [2, 1]
    assert [i['selectedWeighted'] for i in result['items']] == [4.0, 3.0]
    assert [i['pctRespondent'] for i in result['items']] == [80.0, 60.0]
    assert [i['pctRespondentUnweighted'] for i in result['items']] == [pytest.approx(200 / 3), pytest.approx(100 / 3)]

    # A respondent with no usable weight leaves the weighted denominator only.
    sparse = summarize_group(df, g, weights=[1.0, None, 1.0, 1.0])
    assert sparse['denominators']['valid'] == 3
    assert sparse['weightedValidN'] == 2.0
    assert sparse['items'][0]['selectedWeighted'] == 1.0
    assert sparse['items'][0]['pctRespondent'] == 50.0
    assert sparse['items'][0]['pctRespondentUnweighted'] == pytest.approx(200 / 3)
    # No positive weight at all → no weighted ratio, but the counts remain.
    empty = summarize_group(df, g, weights=[0.0, 0.0, 0.0, 0.0])
    assert empty['weightedValidN'] == 0.0
    assert all(i['pctRespondent'] is None and i['pctResponse'] is None for i in empty['items'])
    assert [i['selectedN'] for i in empty['items']] == [2, 1]


@pytest.mark.parametrize('patch', [
    {'selectedCodes': []}, {'selectedCodes': ['1', 1.0]}, {'selectedCodes': ['0']},
    {'selectedCodes': ['98']}, {'selectedCodes': [None, '1']}, {'maxSelections': True},
    {'maxSelections': 0}, {'optionOrder': ['a']}, {'allUnselectedMeaning': 'guess'},
])
def test_invalid_definitions(patch):
    with pytest.raises(ValueError):
        validate_group({**group(), **patch})


def test_real_survey_denominators():
    root = Path(__file__).resolve().parents[4]
    cb = json.loads((root / 'testdata/opendata_2025_survey_codebook.json').read_text(encoding='utf-8'))
    for c in cb['columns']:
        c['columnId'] = c['name']
    original = copy.deepcopy(cb)
    groups = {g['groupId']: g for g in resolve_groups(cb)}
    assert cb == original
    assert len(groups) == 15
    df = pl.read_csv(root / 'testdata/opendata_2025_survey_davis.csv').with_row_index('__rowId__')
    expected = {'q3s1': (1726, 23, 0, 757), 'q7s2': (1726, 10, 13, 757), 'q6s1': (2506, 0, 0, 0)}
    for gid, (valid, missing, partial, na) in expected.items():
        result = summarize_group(df, groups[gid])
        assert result['denominators'] == dict(total=2506, target=2506-na, valid=valid,
                                              missing=missing, partial=partial, invalid=0, notApplicable=na)
        if gid == 'q6s1':
            assert result['allUnselectedN'] == 66


def test_storage_projection(tmp_path):
    store = DatasetStore(tmp_path)
    store.save('test', {'datasetId': 'test'}, pl.DataFrame({'__rowId__': ['r'], 'a': [1], 'b': [2]}))
    assert store.get_dataframe('test', ['__rowId__', 'b']).columns == ['__rowId__', 'b']
    assert store.get_dataframe('test', []).width == 0
    assert store.get_dataframe('test').width == 3
    with pytest.raises(Exception):
        store.get_dataframe('test', ['unknown'])
