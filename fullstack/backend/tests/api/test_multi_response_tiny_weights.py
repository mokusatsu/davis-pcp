"""STAT-03: positive MR weights retain their meaning at small scales."""
from __future__ import annotations
import polars as pl
import pytest
from fastapi.testclient import TestClient

@pytest.fixture
def audit_api(tmp_path, monkeypatch):
    from app.config import settings
    from app.main import app
    from app.api import datasets, summaries, multi_response, conjoint, analysis_results
    from app.storage.dataset_store import DatasetStore
    monkeypatch.setattr(settings, 'workspace_dir', tmp_path)
    settings.ensure_dirs()
    store = DatasetStore(tmp_path)
    for module in [datasets, summaries, multi_response, conjoint, analysis_results]:
        monkeypatch.setattr(module, 'store', store)
    multi_response._summary_cache.clear()
    with TestClient(app) as client:
        yield client, store
    multi_response._summary_cache.clear()


@pytest.mark.parametrize('scale', [1., 1e-6, 1e6, 1e-12])
def test_stat03_mr_small_positive_weights_remain_applied(audit_api, scale):
    client, store = audit_api
    book = {'datasetId': 'ma', 'schemaRevision': 1, 'columns': [
        {'name': name, 'columnId': name, 'role': 'question', 'scaleType': 'nominal', 'multiResponseGroup': 'q', 'missingCodes': []} for name in ['a', 'b']
    ] + [{'name': 'w', 'columnId': 'w', 'role': 'weight', 'scaleType': 'ratio'},
         {'name': 'area', 'columnId': 'area', 'role': 'attribute', 'scaleType': 'nominal'}],
        'multiResponseGroups': [{'groupId': 'q', 'label': 'Q'}]}
    frame = pl.DataFrame({'__rowId__': ['r1', 'r2', 'r3', 'r4'], 'a': [1, 0, 1, 0], 'b': [0, 1, 0, 1], 'area': ['X'] * 4, 'w': [scale, 3 * scale, 0., None]})
    store.save('ma', {'datasetId': 'ma', 'schemaRevision': 1}, frame, codebook=book)
    for endpoint, args in [('/summaries/multi-response', {'groupIds': ['q']}), ('/summaries/multi-response/comparison', {'groupId': 'q', 'attributeColumnId': 'area'})]:
        response = client.post('/api/v1' + endpoint, json={'datasetId': 'ma', 'weightColumn': 'w', **args})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['weightStatus'] == 'applied'
        assert result['weightedN'] == pytest.approx(4 * scale, rel=1e-12, abs=0)
        assert result['weightMissingCount'] == 1
        assert result['weightZeroCount'] == 1
        group = result['groups'][0] if 'groups' in result else result['strata'][0]['summary']
        assert [item['pctRespondent'] for item in group['items']] == pytest.approx([25., 75.])



def test_stat03_all_zero_weights_keep_the_explicit_fallback(audit_api):
    client, store = audit_api
    book = {'datasetId': 'zero', 'columns': [
        {'name': n, 'columnId': n, 'role': 'question', 'scaleType': 'nominal', 'multiResponseGroup': 'q'} for n in ['a', 'b']
    ] + [{'name': 'w', 'columnId': 'w', 'role': 'weight', 'scaleType': 'ratio'}],
        'multiResponseGroups': [{'groupId': 'q'}]}
    frame = pl.DataFrame({'__rowId__': ['r1', 'r2'], 'a': [1, 0], 'b': [0, 1], 'w': [0., 0.]})
    store.save('zero', {'datasetId': 'zero', 'schemaRevision': 1}, frame, codebook=book)
    response = client.post('/api/v1/summaries/multi-response', json={'datasetId': 'zero', 'groupIds': ['q'], 'weightColumn': 'w'})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['weightStatus'] == 'no_positive_weight'
    assert result['weightedN'] is None
    assert result['weightZeroCount'] == 2
    assert [i['pctRespondent'] for i in result['groups'][0]['items']] == [50., 50.]


def test_stat03_weight_cache_distinguishes_tiny_mass_and_changed_ratios(audit_api):
    client, store = audit_api
    book = {'datasetId': 'cache', 'columns': [
        {'name': n, 'columnId': n, 'role': 'question', 'scaleType': 'nominal', 'multiResponseGroup': 'q'} for n in ['a', 'b']
    ] + [{'name': 'w', 'columnId': 'w', 'role': 'weight', 'scaleType': 'ratio'}],
        'multiResponseGroups': [{'groupId': 'q'}]}
    for weights, expected in [([1., 3.], [25., 75.]), ([1e-6, 3e-6], [25., 75.]), ([3e-6, 1e-6], [75., 25.])]:
        frame = pl.DataFrame({'__rowId__': ['r1', 'r2'], 'a': [1, 0], 'b': [0, 1], 'w': weights})
        store.save('cache', {'datasetId': 'cache', 'schemaRevision': 1}, frame, codebook=book)
        response = client.post('/api/v1/summaries/multi-response', json={'datasetId': 'cache', 'groupIds': ['q'], 'weightColumn': 'w'})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['weightStatus'] == 'applied'
        assert [i['pctRespondent'] for i in result['groups'][0]['items']] == pytest.approx(expected)


def test_stat03_original_two_row_fixture_through_import_and_codebook(audit_api):
    client, _ = audit_api
    original_csv = 'a,b,w,w_small\n1,0,1,0.000001\n0,1,3,0.000003\n'
    response = client.post('/api/v1/datasets/import', files={
        'file': ('original-tiny-weights.csv', original_csv, 'text/csv'),
    })
    assert response.status_code == 200, response.text
    dataset_id = response.json()['datasetId']
    book = client.get(f'/api/v1/datasets/{dataset_id}/codebook').json()
    by_name = {c['name']: c for c in book['columns']}
    changes = [
        {'columnId': by_name[name]['columnId'], 'role': 'question', 'scaleType': 'nominal', 'multiResponseGroup': 'ma'}
        for name in ['a', 'b']
    ] + [
        {'columnId': by_name[name]['columnId'], 'role': 'weight', 'scaleType': 'ratio'}
        for name in ['w', 'w_small']
    ]
    response = client.put(f'/api/v1/datasets/{dataset_id}/codebook', json={
        'columns': changes,
        'weightConfig': {'weightColumnId': by_name['w']['columnId'], 'weightType': 'survey'},
    })
    assert response.status_code == 200, response.text
    meta = client.get(f'/api/v1/datasets/{dataset_id}').json()
    book = client.get(f'/api/v1/datasets/{dataset_id}/codebook').json()
    for name, expected_mass in [('w', 4.), ('w_small', 4e-6)]:
        response = client.post('/api/v1/summaries/multi-response', json={
            'datasetId': dataset_id, 'groupIds': ['ma'], 'weightColumn': name,
            'expectedDataRevision': meta['dataRevision'], 'expectedSchemaRevision': book['schemaRevision'],
        })
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['weightStatus'] == 'applied'
        assert result['weightedN'] == pytest.approx(expected_mass, rel=1e-12, abs=0)
        assert [i['pctRespondent'] for i in result['groups'][0]['items']] == pytest.approx([25., 75.])
