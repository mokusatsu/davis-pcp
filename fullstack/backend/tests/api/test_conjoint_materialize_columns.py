"""Conjoint saves must preserve physical row identity and existing columns.

Exercise real import/fit/predict/materialize routes and persistence. Only
workspace roots are redirected; numerics, routes and storage are not mocked.
"""
from __future__ import annotations

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.domain.context import collect_revisions
from app.main import app
from app.storage.dataset_store import DatasetStore
from app.storage.session_store import JobStore, SessionStore


@pytest.fixture
def conjoint_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    settings.ensure_dirs()

    from app.api import analysis_results, conjoint, datasets, sessions
    from app.jobs.manager import manager

    store = DatasetStore(tmp_path)
    for module in (datasets, analysis_results, conjoint):
        monkeypatch.setattr(module, "store", store)
    monkeypatch.setattr(sessions, "sessions", SessionStore(tmp_path))
    monkeypatch.setattr(manager, "store", JobStore(tmp_path))
    with TestClient(app) as client:
        yield client, store


def _workspace_bytes(store):
    """Include original imports, revisions, masks, provenance and results."""
    root = store.root.parent
    return {str(path.relative_to(root)): path.read_bytes()
            for path in sorted(root.rglob("*")) if path.is_file()}


def _prepare(client, store, source_kind, scope):
    rows = []
    for respondent in range(1, 9):
        for alternative, brand in (("A1", "A"), ("A2", "B")):
            index = len(rows)
            rows.append({
                "respondent_id": f"P{respondent}", "task_id": "T1",
                "alternative_id": alternative, "brand": brand,
                "chosen": int((brand == "A") == (respondent % 4 != 0)),
                "original_integer": 100 + index,
                "original_decimal": index + .125,
                "original_text": f"untouched-{index:02d}",
            })
    original = pl.DataFrame(rows)
    response = client.post(
        "/api/v1/datasets/import",
        files={"file": ("conjoint.csv", original.write_csv().encode(), "text/csv")},
    )
    assert response.status_code == 200, response.text
    dataset_id = response.json()["datasetId"]
    context = {"datasetId": dataset_id, "expectedDataRevision": 1,
               "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none",
               "missingPolicy": "exclude", "imputationPolicy": "use_current_values"}
    response = client.post("/api/v1/models/conjoint", json={
        "context": context, "mode": "choice", "method": "conjoint",
        "columns": {"respondentId": "respondent_id", "taskId": "task_id",
                    "alternativeId": "alternative_id", "response": "chosen"},
        "attributes": [{"columnId": "brand", "kind": "categorical"}],
    })
    assert response.status_code == 200, response.text
    fit = response.json()
    assert fit["method"] == "conjoint"
    assert fit["capabilities"]["materialize"]
    result_id = fit["resultId"]
    source = "fit"
    endpoint = f"/api/v1/analysis-results/{result_id}"
    if source_kind == "prediction":
        response = client.post(endpoint + "/predict", json={
            "context": context, "options": {"interval": "none", "evaluate": True},
        })
        assert response.status_code == 200, response.text
        prediction = response.json()
        assert prediction["summary"]["successfulPredictions"] == original.height
        source = prediction["predictionId"]
        endpoint += f"/predictions/{source}"
    response = client.get(endpoint + "/rows", params={"offset": 0, "limit": 1000})
    assert response.status_code == 200, response.text
    source_rows = response.json()["rows"]
    assert len(source_rows) == original.height
    assert all(row["probability"] is not None and
               (source_kind == "fit" or row["predictionStatus"] == "ok")
               for row in source_rows)
    values = {row["rowId"]: row["probability"] for row in source_rows}
    frame = store.get_dataframe(dataset_id)
    assert frame.select(original.columns).equals(original)
    row_ids = frame["__rowId__"].to_list()
    assert frame.schema["__rowId__"] == pl.String
    assert len(set(row_ids)) == frame.height and None not in row_ids
    assert set(values) == set(row_ids)
    assert "__rowId__" not in {c["name"] for c in store.get_meta(dataset_id)["schema"]}
    assert "__rowId__" not in {c["name"] for c in store.load_codebook(dataset_id)["columns"]}
    # Select four complete choice tasks, leaving eight rows outside the scope.
    chosen = row_ids[:8] if scope == "selected" else row_ids
    if scope == "selected":
        context = dict(context, scope=scope, selectedRowIds=chosen)
    expected = [values[row_id] if row_id in chosen else None for row_id in row_ids]
    payload = {"context": context, "source": source,
               "columns": [{"sourceField": "probability", "name": "SAFE_CJ_PROBABILITY",
                            "label": "saved probability"}],
               "idempotencyKey": "unique-save"}
    return dataset_id, result_id, frame, payload, expected


def _save(client, result_id, payload):
    return client.post(f"/api/v1/analysis-results/{result_id}/materialize", json=payload)


def _assert_rejected(client, store, result_id, payload, before, code, status=409):
    response = _save(client, result_id, payload)
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code
    assert _workspace_bytes(store) == before


@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_collisions_and_stale_revisions_rejected_without_writes(
    conjoint_workspace, source_kind, scope,
):
    client, store = conjoint_workspace
    dataset_id, result_id, frame, payload, _ = _prepare(client, store, source_kind, scope)
    before = _workspace_bytes(store)
    assert any(".revisions/" in path for path in before)
    assert any(path.startswith("analysis-results/") for path in before)
    assert "sessions/sessions.db" in before
    assert "jobs/jobs.db" in before
    ordinary = {**payload, "columns": [{"sourceField": "probability", "name": "brand"}],
                "idempotencyKey": "ordinary-collision"}
    _assert_rejected(client, store, result_id, ordinary, before, "COLUMN_ALREADY_EXISTS")
    reserved = {**payload, "columns": [{"sourceField": "probability", "name": "__rowId__"}],
                "idempotencyKey": "reserved-collision"}
    # Stale revisions must keep precedence over the destination collision.
    for revision in ("expectedDataRevision", "expectedSchemaRevision"):
        _assert_rejected(
            client, store, result_id,
            {**reserved, "context": dict(payload["context"], **{revision: 999})},
            before, "ANALYSIS_INPUT_STALE",
        )
    _assert_rejected(client, store, result_id, reserved, before, "COLUMN_ALREADY_EXISTS")
    saved = store.get_dataframe(dataset_id)
    assert saved.schema == frame.schema
    assert saved.equals(frame)


@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_unique_destination_preserves_values_scope_counts_and_replay(
    conjoint_workspace, source_kind, scope,
):
    client, store = conjoint_workspace
    dataset_id, result_id, frame, payload, expected = _prepare(
        client, store, source_kind, scope,
    )
    before = _workspace_bytes(store)
    # Existing source-field and blank-name validation remains unchanged.
    for field, name in (("unsupported", "__rowId__"), ("probability", " ")):
        _assert_rejected(
            client, store, result_id,
            {**payload, "columns": [{"sourceField": field, "name": name}]},
            before, "ANALYSIS_REQUEST_INVALID", status=422,
        )
    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    first = response.json()
    saved = store.get_dataframe(dataset_id)
    name = payload["columns"][0]["name"]
    assert saved.columns == frame.columns + [name]
    assert saved.select(frame.columns).schema == frame.schema
    assert saved.select(frame.columns).equals(frame)
    assert saved.schema[name] == pl.Float64
    assert saved[name].to_list() == expected
    assert saved[name].null_count() == (8 if scope == "selected" else 0)
    count = sum(value is not None for value in expected)
    assert count == (8 if scope == "selected" else frame.height)
    assert first["status"] == "success"
    assert first["datasetId"] == dataset_id
    assert first["resultId"] == result_id
    assert first["source"] == payload["source"]
    assert first["idempotentReplay"] is False
    assert first["writtenRowCount"] == count
    assert first["createdColumns"] == [{
        "columnId": name, "name": name, "label": "saved probability",
        "sourceField": "probability", "nonNullCount": count,
    }]
    revisions = collect_revisions(store.get_meta(dataset_id), store.load_codebook(dataset_id))
    assert first["dataRevision"] == revisions["dataRevision"]
    assert first["schemaRevision"] == revisions["schemaRevision"]
    after = _workspace_bytes(store)
    # Replays precede stale/collision checks and must not write again. The
    # completeness of Conjoint's replay receipt is a separate contract.
    current_context = dict(payload["context"],
                           expectedDataRevision=revisions["dataRevision"],
                           expectedSchemaRevision=revisions["schemaRevision"])
    for context in (payload["context"], current_context):
        replay = _save(client, result_id, {**payload, "context": context})
        assert replay.status_code == 200, replay.text
        assert replay.json().get("idempotentReplay") is True
        assert _workspace_bytes(store) == after
