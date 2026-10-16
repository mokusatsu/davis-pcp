"""Real import/preview/apply/history contract for integer precision rejection."""
from fastapi.testclient import TestClient
import pytest

from app.api import datasets
from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'workspace_dir', tmp_path)
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, 'store', store)
    with TestClient(app) as client:
        yield client, store


def snapshot(store):
    return {str(path.relative_to(store.root)): path.read_bytes()
            for path in store.root.rglob('*') if path.is_file()}


@pytest.mark.parametrize('mode', ['create', 'replace'])
@pytest.mark.parametrize('values,expression', [
    ([2**53, 2**53+1, 2**53+2], 'q - 9007199254740991'),
    ([2**53-1], 'q + 1'),
    ([1, 2, 3], 'q == 9007199254740993'),
    ([1] * 100 + [2**53+1], 'q'),
    ([1, 2], 'abs(4503599627370496) * 4096'),
    ([1, 2], 'where(True, 4503599627370496, 0) * 4096'),
    ([1, 2], '((q > 0) & (q < 2)) * 4503599627370496 * 4096'),
])
def test_rejected_preview_apply_leave_all_storage_unchanged(api, mode, values, expression):
    client, store = api
    payload = ('q,id\n' + '\n'.join(f'{v},row-{i}' for i, v in enumerate(values)) + '\n').encode()
    imported = client.post('/api/v1/datasets/import', files={'file': ('precision.csv', payload)})
    assert imported.status_code == 200, imported.text
    did = imported.json()['datasetId']
    original = store.get_dataframe(did)
    assert original['q'].to_list() == values  # byte import never passes through JS Number
    meta = store.get_meta(did)
    body = {'expression': expression, 'columnName': 'delta' if mode == 'create' else 'q', 'mode': mode}
    before = snapshot(store)
    preview = client.post(f'/api/v1/datasets/{did}/calculate/preview', json=body)
    assert preview.status_code == 200, preview.text
    assert preview.json()['valid'] is False
    apply = client.post(f'/api/v1/datasets/{did}/calculate', json={**body,
        'expectedDataRevision': meta['dataRevision'], 'expectedSchemaRevision': meta['schemaRevision']})
    assert apply.status_code == 422, apply.text
    assert apply.json()['error']['code'] == 'EXPRESSION_INTEGER_PRECISION'
    assert apply.json()['error']['message'] == preview.json()['error']
    assert snapshot(store) == before
    assert store.get_dataframe(did).equals(original)


def test_safe_apply_and_undo_remain_exact(api):
    client, store = api
    response = client.post('/api/v1/datasets/import', files={'file': ('safe.csv', b'q,id\n1,a\n2,b\n99,c\n')})
    assert response.status_code == 200, response.text
    did = response.json()['datasetId']
    original = store.get_dataframe(did)
    meta = store.get_meta(did)
    response = client.post(f'/api/v1/datasets/{did}/calculate', json={
        'expression': 'q * 2', 'columnName': 'delta', 'mode': 'create',
        'expectedDataRevision': meta['dataRevision'], 'expectedSchemaRevision': meta['schemaRevision']})
    assert response.status_code == 200, response.text
    assert store.get_dataframe(did)['delta'].to_list() == [2., 4., 198.]
    response = client.post(f'/api/v1/datasets/{did}/undo', json={})
    assert response.status_code == 200, response.text
    assert store.get_dataframe(did).equals(original)
