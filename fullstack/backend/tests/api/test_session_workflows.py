"""Workspace session identity is enforced at HTTP and SQLite boundaries."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.api import sessions as session_api
from app.storage.session_store import SessionStore
from app.domain.errors import BizError


@pytest.fixture()
def client(tmp_path, monkeypatch):
    store = SessionStore(tmp_path)
    monkeypatch.setattr(session_api, "sessions", store)
    monkeypatch.setattr(session_api.store, "get_meta", lambda dataset_id: {"datasetId": dataset_id})
    return TestClient(app)


def test_http_create_rejects_dataset_mismatch_without_writing(client):
    response = client.post('/api/v1/sessions', json={"name": "A", "datasetId": "a", "state": {"workspaceVersion": 1, "datasetId": "b"}})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'SESSION_DATASET_MISMATCH'
    assert client.get('/api/v1/sessions').json()['sessions'] == []


@pytest.mark.parametrize('state', [{"datasetId": "b"}, {"workspaceVersion": 1}, {}])
def test_http_update_rejects_foreign_or_removed_identity_and_preserves_record(client, state):
    created = client.post('/api/v1/sessions', json={"name": "A", "datasetId": "a", "state": {"workspaceVersion": 1, "datasetId": "a", "activeRowIds": ["a1"]}}).json()
    path = f"/api/v1/sessions/{created['sessionId']}"
    response = client.put(path, json={"name": "B", "state": state, "versionToken": created['versionToken']})
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'SESSION_DATASET_MISMATCH'
    assert client.get(path).json() == created


def test_http_token_required_conflict_then_current_token_recovers(client):
    created = client.post('/api/v1/sessions', json={"name": "A", "datasetId": "a", "state": {"datasetId": "a"}}).json()
    path = f"/api/v1/sessions/{created['sessionId']}"
    body = {"name": "A renamed", "state": {"datasetId": "a", "activeRowIds": ["a2"]}}
    missing = client.put(path, json=body)
    assert missing.status_code == 409
    assert missing.json()['error']['code'] == 'SESSION_VERSION_REQUIRED'
    assert client.get(path).json() == created
    updated = client.put(path, json={**body, 'versionToken': created['versionToken']}).json()
    assert updated['revision'] == 2
    assert updated['name'] == 'A renamed'
    assert updated['datasetId'] == updated['state']['datasetId'] == 'a'
    assert updated['versionToken'] != created['versionToken']
    conflict = client.put(path, json={**body, 'versionToken': created['versionToken']})
    assert conflict.status_code == 409
    assert conflict.json()['error']['code'] == 'SESSION_CONFLICT'
    assert client.get(path).json() == updated
    assert client.put(path, json={**body, 'versionToken': updated['versionToken']}).json()['revision'] == 3


def test_sqlite_direct_boundary_rejects_mismatch(tmp_path):
    store = SessionStore(tmp_path)
    with pytest.raises(BizError, match='一致しません'):
        store.create('mismatch', 'a', {'datasetId': 'b'})
    created = store.create('valid', 'a', {'datasetId': 'a'})
    with pytest.raises(BizError, match='一致しません'):
        store.update(created['sessionId'], {'datasetId': 'b'}, created['versionToken'])
    assert store.get(created['sessionId']) == created


def test_two_sqlite_instances_cannot_accept_the_same_revision(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    stores = [SessionStore(tmp_path), SessionStore(tmp_path)]
    record = stores[0].create('A', 'a', {'datasetId': 'a', 'writer': 'initial'})
    start = Barrier(2)
    def update(index):
        start.wait(timeout=5)
        try:
            value = stores[index].update(record['sessionId'], {'datasetId': 'a', 'writer': index}, record['versionToken'])
            return ('success', value)
        except BizError as error:
            return (error.code, None)
    with ThreadPoolExecutor(max_workers=2) as workers:
        result = list(workers.map(update, [0, 1]))
    assert sorted(value[0] for value in result) == ['SESSION_CONFLICT', 'success']
    winner = next(value[1] for value in result if value[0] == 'success')
    assert winner['revision'] == 2
    assert stores[0].get(record['sessionId']) == winner


def test_session_list_returns_summaries_without_materializing_snapshots(client):
    created = client.post('/api/v1/sessions', json={"name": "A", "datasetId": "a", "state": {"datasetId": "a", "activeRowIds": ["a1"]}}).json()
    summaries = client.get('/api/v1/sessions').json()['sessions']
    assert len(summaries) == 1
    assert summaries[0]['sessionId'] == created['sessionId']
    assert summaries[0]['revision'] == created['revision']
    assert 'state' not in summaries[0]
    assert client.get(f"/api/v1/sessions/{created['sessionId']}").json()['state'] == created['state']
