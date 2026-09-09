import polars as pl
from fastapi.testclient import TestClient

from app.api import statistics
from app.main import app
from app.storage.dataset_store import DatasetStore


def test_covariance_resolves_ids_masks_missing_and_excludes_ma(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    store.save('d', {'datasetId': 'd', 'schemaRevision': 1}, pl.DataFrame({
        '__rowId__': ['r1', 'r2', 'r3', 'r4', 'r5'], 'x': [1, 2, 4, 5, 99], 'y': [4, 1, 5, 3, 4], 'a': [1, 0, 1, 0, 1]}))
    store.save_codebook('d', {'datasetId': 'd', 'schemaRevision': 1, 'columns': [
        {'columnId': 'cx', 'name': 'x', 'role': 'attribute', 'scaleType': 'ratio', 'missingCodes': ['99']},
        {'columnId': 'cy', 'name': 'y', 'role': 'question', 'scaleType': 'ratio'},
        {'columnId': 'ca', 'name': 'a', 'role': 'question', 'scaleType': 'nominal', 'multiResponseGroup': 'q'},
    ]})
    monkeypatch.setattr(statistics, 'store', store)
    calls = []
    read = store.get_dataframe
    def projected(dataset_id, columns=None):
        calls.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', projected)
    with TestClient(app) as client:
        path = '/api/v1/statistics/covariance'
        for extra in [{}, {'columns': ['cx', 'cy']}]:
            result = client.post(path, json={'datasetId': 'd', **extra})
            assert result.status_code == 200, result.text
            assert result.json()['nRows'] == 4
            assert result.json()['usedColumns'] == ['x', 'y']
            assert result.json()['excludedCounts']['incompleteRows'] == 1
        assert all(c == ['__rowId__', 'x', 'y'] for c in calls)
        for extra in [{'columns': []}, {'columns': ['ca', 'cy']}]:
            assert client.post(path, json={'datasetId': 'd', **extra}).status_code == 422
        assert client.post(path, json={'datasetId': 'd', 'expectedDataRevision': 9}).status_code == 409
