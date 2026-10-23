"""Target choices use the fit's scoped, scored, complete-case population."""
import polars as pl
import pytest
from fastapi.testclient import TestClient
from app.api import logistic
from app.main import app
from app.storage.dataset_store import DatasetStore

@pytest.fixture
def saved(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(logistic, 'store', store)
    def save(values, overrides=None, groups=()):
        frame = pl.DataFrame({'__rowId__': [f'r{i}' for i in range(len(next(iter(values.values()))))], **values})
        columns = [{'columnId': f'{name}-id', 'name': name, 'role': 'question',
                    'scaleType': 'ratio' if name == 'x' else 'nominal', 'missingCodes': [],
                    **((overrides or {}).get(name, {}))} for name in values]
        store.save('d', {'datasetId': 'd', 'fingerprint': 'eligibility'}, frame,
                   codebook={'schemaRevision': 1, 'columns': columns, 'multiResponseGroups': list(groups)})
        return store
    return save

def candidates(targets, features=(), rows=None):
    return logistic.logistic_targets(logistic.LogisticTargetsRequestSchema(
        datasetId='d', targetColumns=targets, featureColumns=list(features), activeRowIds=rows,
        expectedDataRevision=1, expectedSchemaRevision=1))['targets']

def test_iris_species_scope_and_independent_candidates(saved):
    store = saved({'species': ['setosa', 'versicolor', 'virginica'] * 2,
                   'binary': [0, 1, 0, 1, 0, 1], 'missing': [None] * 6, 'x': list(range(6))})
    reads = []
    original = store.get_dataframe
    def read(dataset_id, columns=None):
        reads.append(columns)
        return original(dataset_id, columns)
    store.get_dataframe = read
    result = candidates(['species', 'binary', 'missing'], ['x'])
    assert [item['classCount'] for item in result] == [3, 2, 0]
    assert [item['eligible'] for item in result] == [False, True, False]
    assert result[0]['reason'] and result[1]['reason'] is None
    assert len(reads) == 1
    assert candidates(['species'], ['x'], ['r0', 'r1', 'r3', 'r4'])[0]['eligible'] is True
    assert candidates(['species'], ['x'], ['r0', 'r3'])[0]['classCount'] == 1
    assert candidates(['species'], ['x'], [])[0]['classCount'] == 0

@pytest.mark.parametrize('values, spec, expected', [
    ([0, 1, 99, None], {'missingCodes': ['99']}, 2),
    ([0, 1, 99, None], {'missingCodes': ['99', '1']}, 1),
    ([0., 1., float('inf'), float('nan')], {}, 2),
    (['01', '1', '01', '1'], {}, 2),
    (['a', 'b', 'c', None], {'scaleType': 'ordinal', 'categoryOrder': ['a', 'b']}, 2),
    ([9007199254740992, 9007199254740993] * 2, {}, 2),
    ([9007199254740992, 9007199254740993] * 2, {'scaleType': 'ratio'}, 1),
])
def test_counts_follow_analysis_values(saved, values, spec, expected):
    saved({'y': values}, {'y': {**spec, 'valueLabels': {'0': 'Same', '1': 'Same'}}})
    result = candidates(['y'])[0]
    assert result['classCount'] == expected
    assert result['eligible'] is (expected == 2)

def test_feature_missing_codes_and_self_exclusion(saved):
    saved({'y': [0, 0, 1, 1], 'x': [1, 2, 99, None]}, {'x': {'missingCodes': ['99']}})
    assert candidates(['y'])[0]['classCount'] == 2
    assert candidates(['y'], ['x'])[0]['classCount'] == 1
    assert candidates(['x'], ['x'])[0]['classCount'] == 2

def test_ma_parent_validity_and_sibling_exclusion(saved):
    saved({'A': [2, 3, 2, 3], 'B': [99, 3, 3, 3], 'x': [0, 1, 2, 3]},
          {name: {'multiResponseGroup': 'g', 'missingCodes': ['99']} for name in ['A', 'B']},
          [{'groupId': 'g', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}])
    assert candidates(['A'], ['B', 'x'])[0]['classCount'] == 2
    assert candidates(['A'], ['B', 'x'], ['r0', 'r1'])[0]['classCount'] == 1

def test_bad_codebook_does_not_hide_other_candidates(saved):
    saved({'bad': [1, 2], 'binary': [0, 1]}, {'bad': {'scaleType': 'ratio', 'isReversed': True}})
    bad, binary = candidates(['bad', 'binary'])
    assert bad['classCount'] is None and bad['eligible'] is False and bad['reason']
    assert binary['eligible'] is True

def test_route_revisions_and_no_fit(saved, monkeypatch):
    saved({'y': [0, 1, 0], 'x': [1, 2, 3]})
    def no_fit(*args, **kwargs):
        pytest.fail('Eligibility must not fit a model')
    monkeypatch.setattr(logistic, 'run_logistic_regression', no_fit)
    client = TestClient(app)
    request = {'datasetId': 'd', 'targetColumns': ['y'], 'featureColumns': ['x'],
               'expectedDataRevision': 1, 'expectedSchemaRevision': 1}
    response = client.post('/api/v1/models/logistic/targets', json=request)
    assert response.status_code == 200
    assert response.json()['targets'][0] == {'name': 'y', 'classCount': 2, 'eligible': True, 'reason': None}
    assert response.json()['dataRevision'] == response.json()['schemaRevision'] == 1
    for revision in ['expectedDataRevision', 'expectedSchemaRevision']:
        response = client.post('/api/v1/models/logistic/targets', json={**request, revision: 2})
        assert response.status_code == 409
        assert response.json()['error']['code'] == 'ANALYSIS_INPUT_STALE'


def test_invalid_ma_candidate_does_not_block_ordinary_candidates(saved):
    saved({'A': [0, 1], 'binary': [0, 1]}, {'A': {'multiResponseGroup': 'g'}},
          [{'groupId': 'g', 'selectedCodes': ['1'], 'unselectedCodes': ['1']}])
    bad, binary = candidates(['A', 'binary'])
    assert bad['classCount'] is None and bad['eligible'] is False and bad['reason']
    assert binary['eligible'] is True
