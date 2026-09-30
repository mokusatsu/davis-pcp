"""Exercise the actual JSON endpoints for the survey QA edge cases."""
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def client(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    from app.api import datasets, summaries, models, multi_response
    for module in (datasets, summaries, models, multi_response):
        monkeypatch.setattr(module, 'store', store)
    with TestClient(app) as client:
        yield client


def import_csv(client, text):
    response = client.post('/api/v1/datasets/import', files={'file': ('qa.csv', text, 'text/csv')})
    assert response.status_code == 200
    return response.json()['datasetId']


@pytest.mark.parametrize('text,expected_status,expected_p', [
    ('a,b\n' + 'A,X\n' * 5 + 'B,Y\n' * 5, 'infinite', 1 / 126),
    ('a,b\n' + 'A,X\n' * 5, 'undefined', 1.0),
])
def test_fisher_edge_json_endpoint(client, text, expected_status, expected_p):
    dataset_id = import_csv(client, text)
    codebook = client.get(f'/api/v1/datasets/{dataset_id}/codebook').json()
    columns = [{**column, 'scaleType': 'nominal', 'categoryOrder': ['A', 'B'] if column['name'] == 'a' else ['X', 'Y']}
               for column in codebook['columns']]
    saved = client.put(f'/api/v1/datasets/{dataset_id}/codebook', json={'columns': columns}).json()
    meta = client.get(f'/api/v1/datasets/{dataset_id}').json()
    response = client.post('/api/v1/summaries/crosstab', json={
        'context': {'datasetId': dataset_id, 'scope': 'all', 'weightMode': 'none',
                    'expectedDataRevision': meta['dataRevision'], 'expectedSchemaRevision': saved['schemaRevision']},
        'rowVariableId': 'a', 'colVariableId': 'b', 'inference': 'fisher_exact'})
    assert response.status_code == 200, response.text
    assert response.json()['inference']['statisticStatus'] == expected_status
    assert response.json()['inference']['pValue'] == pytest.approx(expected_p)


def test_pca_zero_variance_returns_domain_error_not_json_failure(client):
    dataset_id = import_csv(client, 'x,y\n1,2\n1,2\n1,2\n')
    response = client.post('/api/v1/models/pca', json={'datasetId': dataset_id, 'columns': ['x', 'y']})
    assert response.status_code == 400
    assert response.json()['error']['code'] == 'PCA_ZERO_VARIANCE'


def test_codebook_save_returns_the_normalized_saved_snapshot(client):
    dataset_id = import_csv(client, 'q,extra\n1,1\n2,2\n3,3\n4,4\n5,5\n6,6\n,7\n')
    before = client.get(f'/api/v1/datasets/{dataset_id}/codebook').json()
    q = next(c for c in before['columns'] if c['name'] == 'q')
    response = client.put(f'/api/v1/datasets/{dataset_id}/codebook', json={'columns': [
        {'columnId': q['columnId'], 'scaleType': 'ordinal', 'role': 'question', 'categoryOrder': []}]})
    assert response.status_code == 200
    saved = response.json()['codebook']
    fetched = client.get(f'/api/v1/datasets/{dataset_id}/codebook').json()
    assert saved == fetched
    assert next(c for c in saved['columns'] if c['name'] == 'q')['categoryOrder'] == ['1', '2', '3', '4', '5', '6']
