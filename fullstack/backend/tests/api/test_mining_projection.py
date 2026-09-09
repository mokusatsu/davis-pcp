import polars as pl
from fastapi.testclient import TestClient

from app.api import mining
from app.main import app
from app.storage.dataset_store import DatasetStore


def test_mining_uses_selected_ma_rate_and_only_explicit_features(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    store.save('d', {'datasetId': 'd', 'schemaRevision': 1}, pl.DataFrame({
        '__rowId__': [f'r{i}' for i in range(40)], 'x': ['F'] * 20 + ['M'] * 20,
        'a': [2] * 20 + [3] * 20, 'b': [99] + [3] * 39, 'unused': [7] * 40,
    }))
    store.save_codebook('d', {'datasetId': 'd', 'schemaRevision': 1, 'columns': [
        {'columnId': 'x', 'name': 'x', 'scaleType': 'nominal', 'role': 'attribute'},
        *[{'columnId': name, 'name': name, 'scaleType': 'nominal', 'role': 'question', 'multiResponseGroup': 'q',
           'missingCodes': ['0', '99'], 'valueLabels': {'2': 'yes', '3': 'no'}} for name in ['a', 'b']],
    ], 'multiResponseGroups': [{'groupId': 'q', 'label': 'Q', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]})
    monkeypatch.setattr(mining, 'store', store)
    calls = []
    read = store.get_dataframe
    def projected(dataset_id, columns=None):
        calls.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', projected)
    with TestClient(app) as client:
        req = {'datasetId': 'd', 'attributeCols': ['x'], 'targetQuestions': ['a'], 'mode': 'standard', 'minGroupSize': 5,
               'maxDepth': 1, 'expectedDataRevision': 1, 'expectedSchemaRevision': 1}
        response = client.post('/api/v1/mining/modern-subgroup', json=req)
        assert response.status_code == 200, response.text
        result = response.json()
        assert result['usedRows'] == 39
        assert result['usedColumns'] == ['x', 'a']
        assert result['excludedCounts']['q']['partial'] == 1
        assert calls == [['__rowId__', 'x', 'a', 'b']]
        selected_group = [insight for insight in result['insights'] if insight['rule']['conditions'][0]['value'] == 'F']
        assert selected_group and selected_group[0]['target_stats']['subgroup_proportion'] == 1
        assert 'r0' not in selected_group[0]['coverage']['row_ids']
        scoped = client.post('/api/v1/mining/modern-subgroup', json={**req, 'rowIds': ['r0', 'r1', 'r2'], 'selectedRowIds': ['r1', 'r3']}).json()
        assert scoped['scopeCount'] == scoped['usedRows'] == 1
        assert scoped['excludedCounts']['q']['partial'] == 0
        empty = client.post('/api/v1/mining/modern-subgroup', json={**req, 'rowIds': []}).json()
        assert empty['usedRows'] == 0 and empty['insights'] == []
        assert client.post('/api/v1/mining/modern-subgroup', json={**req, 'attributeCols': []}).status_code == 422
        assert client.post('/api/v1/mining/modern-subgroup', json={**req, 'targetQuestions': ['x']}).status_code == 422
        assert client.post('/api/v1/mining/modern-subgroup', json={**req, 'expectedDataRevision': 9}).status_code == 409
