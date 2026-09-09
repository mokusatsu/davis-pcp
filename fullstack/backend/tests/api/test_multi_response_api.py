import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import multi_response
from app.main import app
from app.storage.dataset_store import DatasetStore


def test_arrow_explicit_ma_axes_mask_nonvalid_rows_and_keep_dependencies_private(api, monkeypatch):
    import io
    from app.api import datasets
    client, calls = api
    monkeypatch.setattr(datasets, 'store', multi_response.store)
    # Partial responses must not leak known selected values into plotted axes.
    saved = multi_response.store.load_codebook('ma')
    saved['multiResponseGroups'] = [{'groupId': 'q', 'label': 'Q', 'selectedCodes': ['1'], 'unselectedCodes': ['0']}]
    multi_response.store.save_codebook('ma', saved)
    # Metadata is intentionally minimal in this fixture.
    meta = multi_response.store.get_meta('ma')
    meta['schema'] = [{'name': name} for name in ['a', 'b', 'unused']]
    multi_response.store.save_metadata('ma', meta, saved)
    req = {'columns': ['unused'], 'maAxes': [
        {'key': 'option', 'kind': 'maOption', 'groupId': 'q', 'columnId': 'a'},
        {'key': 'count', 'kind': 'maCount', 'groupId': 'q'},
    ], 'expectedDataRevision': 2, 'expectedSchemaRevision': 4}
    response = client.post('/api/v1/datasets/ma/view', json=req)
    assert response.status_code == 200, response.text
    frame = pl.read_ipc_stream(io.BytesIO(response.content))
    assert frame.columns == ['__rowId__', 'unused', 'option', 'count']
    assert frame['option'].to_list() == [1, 0, None]
    assert frame['count'].to_list() == [2, 1, None]
    assert frame['option'].dtype == pl.UInt8
    assert calls == [['__rowId__', 'unused', 'a', 'b']]
    empty = client.post('/api/v1/datasets/ma/view', json={**req, 'rowIds': []})
    assert pl.read_ipc_stream(io.BytesIO(empty.content)).height == 0
    assert client.post('/api/v1/datasets/ma/view', json={**req, 'expectedSchemaRevision': 3}).status_code == 409
    assert client.post('/api/v1/datasets/ma/view', json={**req, 'maAxes': [{**req['maAxes'][0], 'columnId': 'unused'}]}).status_code == 422


@pytest.fixture
def api(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    store.save('ma', {'datasetId': 'ma', 'schemaRevision': 4, 'dataRevision': 2},
               pl.DataFrame({'__rowId__': ['r1', 'r2', 'r3'], 'a': [1, 0, 1], 'b': [1, 1, 99], 'unused': [0, 0, 0]}))
    store.save_codebook('ma', {'datasetId': 'ma', 'schemaRevision': 4, 'columns': [
        {'columnId': n, 'name': n, 'multiResponseGroup': 'q', 'scaleType': 'nominal',
         'role': 'question', 'missingCodes': ['99']} for n in ['a', 'b']
    ]})
    monkeypatch.setattr(multi_response, 'store', store)
    calls = []
    read = store.get_dataframe
    def projected_read(dataset_id, columns=None):
        calls.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', projected_read)
    with TestClient(app) as client:
        yield client, calls


def test_summary_and_matches_revisions_scope_and_projection(api):
    client, calls = api
    req = dict(datasetId='ma', groupIds=['q'], expectedSchemaRevision=4, expectedDataRevision=2)
    response = client.post('/api/v1/summaries/multi-response', json=req)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['schemaRevision'] == 4 and body['dataRevision'] == 2
    assert body['groups'][0]['denominators']['valid'] == 2
    assert body['groups'][0]['denominators']['partial'] == 1
    assert all(c is not None and 'unused' not in c for c in calls)
    for item in body['groups'][0]['items']:
        result = client.post('/api/v1/datasets/ma/matches', json=dict(
            groupId='q', optionColumnIds=[item['columnId']], predicate='any', expectedSchemaRevision=4))
        assert result.status_code == 200, result.text
        assert result.json()['count'] == item['selectedN']
        assert result.json()['scopeHash'] == body['scopeHash']
        assert 'r3' not in result.json()['rowIds']
    empty = client.post('/api/v1/summaries/multi-response', json={**req, 'rowIds': []}).json()
    assert empty['groups'][0]['denominators']['total'] == 0
    assert client.post('/api/v1/summaries/multi-response', json={**req, 'groupIds': []}).json()['groups'] == []
    status = client.post('/api/v1/datasets/ma/matches', json={'groupId': 'q', 'predicate': 'status', 'status': 'partial'})
    assert status.json()['rowIds'] == ['r3']


@pytest.mark.parametrize('revision', [{'expectedSchemaRevision': 3}, {'expectedDataRevision': 1}])
def test_stale_inputs_rejected_by_both_endpoints(api, revision):
    client, _ = api
    for path, body in [('/summaries/multi-response', {'datasetId': 'ma', 'groupIds': ['q']}),
                       ('/datasets/ma/matches', {'groupId': 'q', 'optionColumnIds': ['a']})]:
        response = client.post('/api/v1' + path, json={**body, **revision})
        assert response.status_code == 409, response.text
        assert response.json()['error']['code'] == 'ANALYSIS_INPUT_STALE'


def test_unknown_group_does_not_expand_to_all(api):
    client, _ = api
    response = client.post('/api/v1/summaries/multi-response', json={'datasetId': 'ma', 'groupIds': ['unknown']})
    assert response.status_code == 422


def test_summary_cache_reuses_population_but_refreshes_selected_counts(api, monkeypatch):
    client, reads = api
    computed = []
    summarize = multi_response.summarize_group
    def tracked(frame, group, **kwargs):
        computed.append(frame.height)
        return summarize(frame, group, **kwargs)
    monkeypatch.setattr(multi_response, 'summarize_group', tracked)
    req = {'datasetId': 'ma', 'groupIds': ['q']}
    first = client.post('/api/v1/summaries/multi-response', json={**req, 'selectedRowIds': ['r1']}).json()['groups'][0]
    reads.clear()
    second = client.post('/api/v1/summaries/multi-response', json={**req, 'selectedRowIds': ['r2', 'r3']}).json()['groups'][0]
    assert computed == [3]
    assert reads == [['__rowId__']]
    assert first['denominators'] == second['denominators']
    assert [item['selectedN'] for item in second['items']] == [1, 2]
    assert [item['selectedInSelection'] for item in first['items']] == [1, 1]
    assert [item['selectedInSelection'] for item in second['items']] == [0, 1]  # partial r3 is excluded
    empty = client.post('/api/v1/summaries/multi-response', json={**req, 'selectedRowIds': []}).json()['groups'][0]
    assert all(item['selectedInSelection'] == 0 for item in empty['items'])
    assert computed == [3]
    cb = multi_response.store.load_codebook('ma')
    cb['schemaRevision'] += 1
    multi_response.store.save_codebook('ma', cb)
    client.post('/api/v1/summaries/multi-response', json=req).raise_for_status()
    client.post('/api/v1/summaries/multi-response', json={**req, 'rowIds': ['r2']}).raise_for_status()
    assert computed == [3, 3, 1]


def test_oversize_summary_is_computed_without_retention(api, monkeypatch):
    client, reads = api
    monkeypatch.setattr(multi_response, '_SUMMARY_CACHE_BYTES', 1)
    multi_response._summary_cache.clear()
    for _ in range(2):
        response = client.post('/api/v1/summaries/multi-response', json={'datasetId': 'ma', 'groupIds': ['q']})
        assert response.status_code == 200
    assert len([columns for columns in reads if 'a' in columns]) == 2
    assert not multi_response._summary_cache


def test_attribute_comparison_uses_disjoint_valid_populations(api):
    client, reads = api
    store = multi_response.store
    cb = store.load_codebook('ma')
    cb['columns'].append({'columnId': 'area', 'name': 'area', 'role': 'attribute', 'scaleType': 'nominal', 'missingCodes': ['99'], 'categoryOrder': ['M', 'F']})
    store.save('ma', store.get_meta('ma'), pl.DataFrame({'__rowId__': ['r1', 'r2', 'r3', 'r4', 'r5'],
        'a': [1, 0, 1, 1, 1], 'b': [0, 0, 1, 99, 0], 'area': ['F', 'F', 'M', 'M', '99'], 'unused': [0] * 5}), codebook=cb)
    reads.clear()
    req = {'datasetId': 'ma', 'groupId': 'q', 'attributeColumnId': 'area', 'selectedRowIds': ['r1', 'r3', 'r4']}
    response = client.post('/api/v1/summaries/multi-response/comparison', json=req)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['scopeCount'] == 5 and result['attributeMissingExcluded'] == 1
    assert [item['code'] for item in result['strata']] == ['M', 'F']
    summaries = {item['code']: item['summary'] for item in result['strata']}
    assert summaries['M']['denominators']['valid'] == 1
    assert summaries['M']['denominators']['partial'] == 1
    assert summaries['F']['denominators']['valid'] == 2
    assert summaries['M']['items'][0]['pctRespondent'] == 100
    assert summaries['F']['items'][0]['pctRespondent'] == 50
    assert sum(item['denominators']['total'] for item in summaries.values()) == 4
    assert reads == [['__rowId__', 'a', 'b', 'area']]
    empty = client.post('/api/v1/summaries/multi-response/comparison', json={**req, 'rowIds': []}).json()
    assert empty['strata'] == [] and empty['scopeCount'] == 0
    assert client.post('/api/v1/summaries/multi-response/comparison', json={**req, 'attributeColumnId': 'a'}).status_code == 422
    assert client.post('/api/v1/summaries/multi-response/comparison', json={**req, 'expectedDataRevision': 1}).status_code == 409

    match_req = {'groupId': 'q', 'optionColumnIds': ['a'], 'attributeFilter': {'columnId': 'area', 'code': 'M'}}
    path = '/api/v1/datasets/ma/matches'
    reads.clear()
    matched = client.post(path, json=match_req)
    assert matched.status_code == 200, matched.text
    assert matched.json()['rowIds'] == ['r3']
    assert reads == [['__rowId__'], ['__rowId__', 'a', 'b', 'area']]
    assert client.post(path, json={**match_req, 'rowIds': ['r1', 'r4']}).json()['rowIds'] == []
    assert client.post(path, json={**match_req, 'rowIds': []}).json()['rowIds'] == []
    assert client.post(path, json={**match_req, 'attributeFilter': {'columnId': 'area', 'code': 'F'}}).json()['rowIds'] == ['r1']
    assert client.post(path, json={**match_req, 'attributeFilter': {'columnId': 'area', 'code': '99'}}).json()['rowIds'] == []
    assert client.post(path, json={**match_req, 'attributeFilter': {'columnId': 'a', 'code': '1'}}).status_code == 422
    assert client.post(path, json={**match_req, 'expectedSchemaRevision': 1}).status_code == 409


def test_color_domains_exclude_missing_without_reading_unrelated_columns(api):
    client, calls = api
    response = client.post('/api/v1/datasets/ma/color-domains', json={'expectedSchemaRevision': 4})
    assert response.status_code == 200, response.text
    assert response.json()['domains'] == [
        {'key': 'a', 'codes': ['0', '1'], 'counts': [1, 2], 'numeric': True},
        {'key': 'b', 'codes': ['1'], 'counts': [2], 'numeric': True},
    ]
    assert calls == [['a', 'b']]
    assert client.post('/api/v1/datasets/ma/color-domains', json={'expectedDataRevision': 1}).status_code == 409


def test_table_pages_keep_partial_known_answers_and_project_columns(api):
    client, calls = api
    path = '/api/v1/datasets/ma/table-view'
    body = {'entityIds': [{'kind': 'ma', 'groupId': 'q'}], 'limit': 1, 'offset': 2}
    response = client.post(path, json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['total'] == 3
    assert data['rows'] == [{'rowId': 'r3', 'cells': [{
        'status': 'partial', 'selectedCount': 1, 'optionColumnIds': ['a'], 'labels': ['a']}]}]
    assert all(c is not None and 'unused' not in c for c in calls)
    assert client.post(path, json={**body, 'rowIds': []}).json()['total'] == 0
    empty = client.post(path, json={'entityIds': [], 'limit': 1}).json()
    assert empty['rows'] == [{'rowId': 'r1', 'cells': []}]
    assert calls[-1] == ['__rowId__']
    assert client.post(path, json={**body, 'expectedSchemaRevision': 1}).status_code == 409
    assert client.post(path, json={**body, 'sort': {'entityIndex': 0}}).status_code == 422
    raw = client.post(path, json={**body, 'displayMode': 'raw'}).json()
    assert raw['rows'][0]['cells'][0]['text'] == 'a=1, b=99'
    assert raw['entities'][0]['kind'] == 'ma'


def test_table_search_sort_precedes_paging_and_count_masks_partial(api):
    client, _ = api
    path = '/api/v1/datasets/ma/table-view'
    body = {'entityIds': [{'kind': 'maCount', 'groupId': 'q'}], 'limit': 1,
            'sort': {'entityIndex': 0, 'order': 'ascend'}}
    assert client.post(path, json=body).json()['rows'][0]['rowId'] == 'r2'
    result = client.post(path, json={**body, 'offset': 2}).json()
    assert result['rows'][0]['cells'][0]['value'] is None
    result = client.post(path, json={**body, 'search': 'r3'}).json()
    assert result['total'] == 1 and result['rows'][0]['rowId'] == 'r3'
    expanded = client.post(path, json={'entityIds': [{'kind': 'maOption', 'groupId': 'q', 'columnId': 'b'}], 'offset': 2}).json()
    assert expanded['rows'][0]['cells'][0]['value'] == 99
    assert expanded['rows'][0]['cells'][0]['status'] == 'partial'
    weighted = client.post(path, json={**body, 'sort': {'entityIndex': -1, 'order': 'descend'}, 'rowWeights': {'r3': 5}}).json()
    assert weighted['rows'][0]['rowId'] == 'r3'


def test_group_definition_save_delete_and_stale_write(tmp_path, monkeypatch):
    from app.api import datasets
    store = DatasetStore(tmp_path)
    frame = pl.DataFrame({'__rowId__': ['r'], 'a': [1], 'b': [0]})
    store.save('edit', {'datasetId': 'edit', 'schemaRevision': 1, 'schema': [], 'fingerprint': 'initial'}, frame)
    store.save_codebook('edit', {'datasetId': 'edit', 'schemaRevision': 1, 'columns': [
        {'columnId': n, 'name': n, 'scaleType': 'nominal', 'role': 'question', 'missingCodes': ['99']} for n in ['a', 'b']
    ]})
    monkeypatch.setattr(datasets, 'store', store)
    with TestClient(app) as client:
        path = '/api/v1/datasets/edit/codebook'
        original = store.load_codebook('edit')
        data_revision = store.get_meta('edit')['dataRevision']
        parquet_before = store._parquet_path('edit').read_bytes()
        invalid = client.put(path, json={'expectedSchemaRevision': 1, 'columns': [
            {'columnId': 'a', 'multiResponseGroup': 'q', 'scaleType': 'ratio'}]})
        assert invalid.status_code == 422
        assert store.load_codebook('edit') == original
        request = {'expectedSchemaRevision': 1, 'columns': [
            {'columnId': n, 'multiResponseGroup': 'q', 'multiResponseOptionLabel': f'option {n}'} for n in ['a', 'b']],
            'multiResponseGroups': [{'groupId': 'q', 'label': 'Services', 'optionOrder': ['b', 'a']}]}
        saved = client.put(path, json=request)
        assert saved.status_code == 200, saved.text
        assert saved.json()['schemaRevision'] == 2
        assert store.get_meta('edit')['dataRevision'] == data_revision
        assert store._parquet_path('edit').read_bytes() == parquet_before
        cb = client.get(path).json()
        assert cb['multiResponseGroups'][0]['optionOrder'] == ['b', 'a']
        assert 'columns' not in store.load_codebook('edit')['multiResponseGroups'][0]
        assert client.put(path, json=request).status_code == 409
        bad_order = client.put(path, json={'multiResponseGroups': [{'groupId': 'q', 'label': 'Services', 'optionOrder': ['bad', 'a']}]})
        assert bad_order.status_code == 422
        assert store.load_codebook('edit')['schemaRevision'] == 2
        exported = client.get(path + '/export?format=json').json()
        assert exported['multiResponseGroups'][0]['label'] == 'Services'
        assert exported['columns'][0]['multiResponseOptionLabel'] == 'option a'
        imported = client.post(path + '/import', files={'file': ('codebook.json', __import__('json').dumps(exported), 'application/json')})
        assert imported.status_code == 200, imported.text
        assert store.load_codebook('edit')['multiResponseGroups'][0]['optionOrder'] == ['b', 'a']
        assert store.load_codebook('edit')['schemaRevision'] == 3
        removed = client.delete(path + '/multi-response-groups/q?expectedSchemaRevision=3')
        assert removed.status_code == 200, removed.text
        assert all(c['multiResponseGroup'] is None for c in store.load_codebook('edit')['columns'])
        assert store.load_codebook('edit')['multiResponseGroups'] == []
        assert store.get_dataframe('edit').equals(frame)


def test_concurrent_dictionary_saves_do_not_overwrite_each_other(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from app.api import datasets
    from app.domain.errors import BizError
    store = DatasetStore(tmp_path)
    store.save('edit', {'datasetId': 'edit', 'schemaRevision': 1, 'schema': [], 'fingerprint': 'initial'},
               pl.DataFrame({'__rowId__': ['r'], 'a': [1]}))
    store.save_codebook('edit', {'datasetId': 'edit', 'schemaRevision': 1, 'columns': [
        {'columnId': 'a', 'name': 'a', 'scaleType': 'nominal', 'role': 'question', 'missingCodes': []}]})
    monkeypatch.setattr(datasets, 'store', store)
    def save(label):
        try:
            return datasets.update_codebook('edit', {'expectedSchemaRevision': 1, 'columns': [{'columnId': 'a', 'label': label}]})['schemaRevision']
        except BizError as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(save, ['first', 'second']))
    assert sorted(outcomes) == [2, 409]
    assert store.get_meta('edit')['dataRevision'] == 1
    assert store.get_meta('edit')['schemaRevision'] == store.load_codebook('edit')['schemaRevision'] == 2
