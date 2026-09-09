import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import relationships
from app.main import app
from app.storage.dataset_store import DatasetStore


def test_relationship_aggregate_and_pair_project_only_explicit_inputs(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    store.save('d', {'datasetId': 'd', 'schemaRevision': 1}, pl.DataFrame({
        '__rowId__': ['r1', 'r2', 'r3', 'r4'], 'x': [1, 2, 3, 99], 'y': [2, 4, 6, 8],
        'a': [2, 3, 2, 2], 'b': [3, 2, 99, 3], 'unused': [7, 7, 7, 7]}))
    store.save_codebook('d', {'datasetId': 'd', 'schemaRevision': 1, 'columns': [
        {'columnId': name, 'name': name, 'role': 'question', 'scaleType': 'nominal' if name in ['a', 'b'] else 'ratio',
         'multiResponseGroup': 'q' if name in ['a', 'b'] else None, 'missingCodes': ['99']} for name in ['x', 'y', 'a', 'b', 'unused']
    ], 'multiResponseGroups': [{'groupId': 'q', 'label': 'Q', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]})
    monkeypatch.setattr(relationships, 'store', store)
    calls = []
    read = store.get_dataframe
    def projected(dataset_id, columns=None):
        calls.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', projected)
    with TestClient(app) as client:
        req = {'datasetId': 'd', 'columns': ['x', 'y'], 'expectedDataRevision': 1, 'expectedSchemaRevision': 1}
        result = client.post('/api/v1/relationships/matrix', json=req)
        assert result.status_code == 200, result.text
        assert [value for row in result.json()['matrix'] for value in row] == pytest.approx([1, 1, 1, 1])
        assert result.json()['counts'] == [[3, 3], [3, 4]]
        assert 'rowIds' not in result.json()
        assert calls == [['__rowId__', 'x', 'y']]
        pair = client.post('/api/v1/relationships/pair', json={**req, 'columns': ['a', 'y']})
        assert pair.status_code == 200, pair.text
        assert pair.json()['rowIds'] == ['r1', 'r2', 'r4']
        assert pair.json()['x'] == [1, 0, 1]
        assert pair.json()['usedColumns'] == ['a', 'y']
        assert pair.json()['excludedCounts']['q']['partial'] == 1
        assert calls[-1] == ['__rowId__', 'a', 'y', 'b']
        mixed = client.post('/api/v1/relationships/matrix', json={**req, 'columns': ['x', 'y', 'a']}).json()
        assert mixed['counts'][0][1] == 3  # MA invalidity must not remove rows from an ordinary pair.
        assert mixed['counts'][1][2] == pair.json()['usedRows'] == 3
        empty = client.post('/api/v1/relationships/matrix', json={**req, 'rowIds': []}).json()
        assert empty['counts'] == [[0, 0], [0, 0]]
        assert empty['matrix'] == [[None, None], [None, None]]
        assert client.post('/api/v1/relationships/matrix', json={**req, 'columns': []}).json()['columns'] == []
        assert client.post('/api/v1/relationships/matrix', json={**req, 'expectedSchemaRevision': 2}).status_code == 409
