"""Conjoint saves must preserve physical row identity and existing columns.

Exercise real import/fit/predict/materialize routes and persistence. Only
workspace roots are redirected; numerics, routes and storage are not mocked.
"""
from __future__ import annotations

import io
import json
import re

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


def _capture_publications(store, monkeypatch):
    publications = []
    publish = store._publish_files

    def record(payloads):
        publications.append(dict(payloads))
        return publish(payloads)

    monkeypatch.setattr(store, "_publish_files", record)
    return publications


def _assert_receipt(store, dataset_id, result_id, payload, expected, receipt, parent):
    provenance = store.load_provenance(dataset_id)
    operation = provenance["operations"][-1]
    assert re.fullmatch(r"op-[0-9a-f]{12}", receipt["operationId"])
    assert operation["operationId"] == receipt["operationId"]
    assert operation["parentOperationId"] == parent
    assert provenance["currentOperationId"] == provenance["cursorOperationId"] == receipt["operationId"]
    assert sum(op.get("operationId") == receipt["operationId"]
               for op in provenance["operations"]) == 1
    name = payload["columns"][0]["name"]
    count = sum(value is not None for value in expected)
    revisions = collect_revisions(store.get_meta(dataset_id), store.load_codebook(dataset_id))
    assert receipt == {
        "status": "success", "resultId": result_id, "source": payload["source"],
        "operationId": operation["operationId"], "datasetId": dataset_id,
        "dataRevision": revisions["dataRevision"], "schemaRevision": revisions["schemaRevision"],
        "createdColumns": [{"columnId": name, "name": name, "label": "saved probability",
                            "sourceField": "probability", "nonNullCount": count}],
        "writtenRowCount": count, "idempotentReplay": False,
    }
    assert operation["inputDataRevision"] == payload["context"]["expectedDataRevision"]
    assert operation["inputSchemaRevision"] == payload["context"]["expectedSchemaRevision"]
    assert operation["outputDataRevision"] == receipt["dataRevision"]
    assert operation["outputSchemaRevision"] == receipt["schemaRevision"]
    assert operation["params"]["cjResponse"] == {
        key: value for key, value in receipt.items()
        if key not in {"operationId", "dataRevision", "schemaRevision", "idempotentReplay"}
    }
    assert operation["params"]["cjIdempotencyKey"] == payload["idempotencyKey"]
    assert operation["params"]["cjResultId"] == result_id
    assert operation["params"]["cjPayload"]["source"] == payload["source"]
    assert operation["params"]["cjPayload"]["scope"]["scope"] == payload["context"]["scope"]
    assert operation["timestamp"] and operation["algorithmVersion"]
    saved = store.get_dataframe(dataset_id)
    scope_ids = payload["context"].get("selectedRowIds", saved["__rowId__"].to_list())
    assert operation["targetRowIds"] == sorted(set(scope_ids))
    assert saved[name].to_list() == expected
    return operation


def _assert_atomic_publication(store, dataset_id, publication, operation):
    # These are the actual bytes handed to the original publication routine,
    # before it wrote anything, rather than a later provenance sidecar rewrite.
    provenance = json.loads(publication[store._provenance_path(dataset_id)])
    assert provenance == store.load_provenance(dataset_id)
    assert provenance["operations"][-1] == operation
    assert json.loads(publication[store._codebook_path(dataset_id)]) == store.load_codebook(dataset_id)
    frame = pl.read_parquet(io.BytesIO(publication[store._parquet_path(dataset_id)]))
    assert frame.equals(store.get_dataframe(dataset_id))


@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_complete_receipt_identity_and_historical_replay(
    conjoint_workspace, monkeypatch, source_kind, scope,
):
    client, store = conjoint_workspace
    dataset_id, result_id, frame, payload, expected = _prepare(client, store, source_kind, scope)
    # Both conflict sources refer to real successful model outputs.
    alternate_source = "fit"
    if source_kind == "fit":
        prediction_context = dict(payload["context"], scope="all")
        prediction_context.pop("selectedRowIds", None)
        predicted = client.post(f"/api/v1/analysis-results/{result_id}/predict", json={
            "context": prediction_context,
            "options": {"interval": "none", "evaluate": True},
        })
        assert predicted.status_code == 200, predicted.text
        alternate_source = predicted.json()["predictionId"]
        assert predicted.json()["summary"]["successfulPredictions"] == frame.height
    if scope == "selected":
        ids = payload["context"]["selectedRowIds"]
        payload["context"]["selectedRowIds"] = list(reversed(ids)) + ids[:2]
    before = _workspace_bytes(store)
    original_meta = store.get_meta(dataset_id)
    parent = store.load_provenance(dataset_id)["currentOperationId"]
    publications = _capture_publications(store, monkeypatch)
    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    first = response.json()
    operation = _assert_receipt(store, dataset_id, result_id, payload, expected, first, parent)
    assert len(publications) == 1
    _assert_atomic_publication(store, dataset_id, publications[0], operation)
    saved_frame = store.get_dataframe(dataset_id)
    assert saved_frame.select(frame.columns).schema == frame.schema
    assert saved_frame.select(frame.columns).equals(frame)
    assert first["dataRevision"] == original_meta["dataRevision"] + 1
    for path, raw in before.items():
        if path.startswith("analysis-results/") or ".revisions/" in path or path.endswith(".raw.parquet"):
            assert _workspace_bytes(store)[path] == raw

    for later in (False, True):
        if later:
            changed = client.post(f"/api/v1/datasets/{dataset_id}/calculate", json={
                "expression": "original_integer * 2", "columnName": "LATER_CALCULATION", "mode": "create",
                "expectedDataRevision": first["dataRevision"],
                "expectedSchemaRevision": first["schemaRevision"],
            })
            assert changed.status_code == 200, changed.text
            current_frame = store.get_dataframe(dataset_id)
            assert current_frame.select(saved_frame.columns).equals(saved_frame)
            assert current_frame["LATER_CALCULATION"].to_list() == (frame["original_integer"] * 2).to_list()
            later_operation = store.load_provenance(dataset_id)["operations"][-1]
            assert later_operation["parentOperationId"] == first["operationId"]
        current = collect_revisions(store.get_meta(dataset_id), store.load_codebook(dataset_id))
        assert current["dataRevision"] == first["dataRevision"] + int(later)
        before_retry = _workspace_bytes(store)
        history = store.load_provenance(dataset_id)
        assert history["operations"][1] == operation
        publication_count = len(publications)
        original_pair = (payload["context"]["expectedDataRevision"],
                         payload["context"]["expectedSchemaRevision"])
        revision_pairs = [original_pair, (first["dataRevision"], first["schemaRevision"])]
        if later:
            revision_pairs.append((current["dataRevision"], current["schemaRevision"]))
        for data_revision, schema_revision in revision_pairs:
            context = dict(payload["context"], expectedDataRevision=data_revision,
                           expectedSchemaRevision=schema_revision)
            replay = _save(client, result_id, {**payload, "context": context})
            assert replay.status_code == 200, replay.text
            assert replay.json() == {**first, "idempotentReplay": True}
            assert _workspace_bytes(store) == before_retry
        if scope == "selected":
            canonical = dict(payload["context"], selectedRowIds=sorted(set(payload["context"]["selectedRowIds"])))
            replay = _save(client, result_id, {**payload, "context": canonical})
            assert replay.status_code == 200, replay.text
            assert replay.json() == {**first, "idempotentReplay": True}
            assert _workspace_bytes(store) == before_retry
        changed_scope = dict(payload["context"], scope="all" if scope == "selected" else "selected")
        if scope == "selected":
            changed_scope.pop("selectedRowIds")
        else:
            changed_scope["selectedRowIds"] = frame["__rowId__"].to_list()[:2]
        for change in (
            {"columns": [{"sourceField": "probability", "name": "DIFFERENT_DESTINATION"}]},
            {"source": alternate_source}, {"context": changed_scope},
        ):
            _assert_rejected(client, store, result_id, {**payload, **change}, before_retry, "IDEMPOTENCY_CONFLICT")
        for data_revision, schema_revision in (original_pair, (current["dataRevision"], current["schemaRevision"])):
            _assert_rejected(client, store, result_id, {
                **payload, "idempotencyKey": "unused-key",
                "context": dict(payload["context"], expectedDataRevision=data_revision,
                                expectedSchemaRevision=schema_revision),
                "columns": [{"sourceField": "probability", "name": "UNUSED_DESTINATION"}],
            }, before_retry, "ANALYSIS_INPUT_STALE")
        assert store.load_provenance(dataset_id) == history
        assert len(publications) == publication_count


@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_saved_conjoint_operation_undo_restores_exact_data_and_codebook(
    conjoint_workspace, source_kind, scope,
):
    client, store = conjoint_workspace
    dataset_id, result_id, frame, payload, _ = _prepare(client, store, source_kind, scope)
    before = _workspace_bytes(store)
    codebook = store.load_codebook(dataset_id)
    codebook_bytes = store._codebook_path(dataset_id).read_bytes()
    meta = store.get_meta(dataset_id)
    parent = store.load_provenance(dataset_id)["currentOperationId"]
    saved = _save(client, result_id, payload)
    assert saved.status_code == 200, saved.text
    first = saved.json()
    history_response = client.get(f"/api/v1/datasets/{dataset_id}/provenance")
    assert history_response.status_code == 200, history_response.text
    history = history_response.json()
    response = client.post(f"/api/v1/datasets/{dataset_id}/undo", json={
        "expectedDataRevision": first["dataRevision"], "expectedSchemaRevision": first["schemaRevision"],
    })
    assert response.status_code == 200, response.text
    assert history["canUndo"] is True
    assert history["currentOperationId"] == history["cursorOperationId"] == first["operationId"]
    assert history["previousOperationId"] == parent
    restored = store.get_dataframe(dataset_id)
    assert restored.schema == frame.schema
    assert restored.equals(frame)
    assert store.load_codebook(dataset_id) == codebook
    assert store._codebook_path(dataset_id).read_bytes() == codebook_bytes
    restored_meta = store.get_meta(dataset_id)
    for key in ("schema", "schemaRevision", "columnCount", "rowCount", "fingerprint", "valuesFingerprint"):
        assert restored_meta[key] == meta[key]
    assert restored_meta["dataRevision"] == first["dataRevision"] + 1
    provenance = store.load_provenance(dataset_id)
    assert provenance["currentOperationId"] == provenance["cursorOperationId"] == parent
    assert provenance["operations"][-1]["params"]["undoneOperationId"] == first["operationId"]
    after = _workspace_bytes(store)
    for path, raw in before.items():
        if path.startswith("analysis-results/") or ".revisions/" in path or path.endswith(".raw.parquet"):
            assert after[path] == raw


@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_late_publication_failure_rolls_back_receipt_and_same_key_can_retry(
    conjoint_workspace, monkeypatch, source_kind, scope,
):
    from app.storage import dataset_store

    client, store = conjoint_workspace
    dataset_id, result_id, frame, payload, expected = _prepare(client, store, source_kind, scope)
    before = _workspace_bytes(store)
    original_provenance = store.load_provenance(dataset_id)
    publications = _capture_publications(store, monkeypatch)
    write = dataset_store.atomic_write_bytes
    failed = False

    def fail_after_codebook(path, raw):
        nonlocal failed
        write(path, raw)
        if path == store._codebook_path(dataset_id) and not failed:
            failed = True
            raise OSError("conjoint publication failed after codebook write")

    with monkeypatch.context() as patch:
        patch.setattr(dataset_store, "atomic_write_bytes", fail_after_codebook)
        with pytest.raises(OSError, match="conjoint publication failed after codebook write"):
            _save(client, result_id, payload)
    assert failed and len(publications) == 1
    assert _workspace_bytes(store) == before
    assert store.get_dataframe(dataset_id).equals(frame)
    assert store.load_provenance(dataset_id) == original_provenance
    attempted = json.loads(publications[0][store._provenance_path(dataset_id)])["operations"][-1]
    assert re.fullmatch(r"op-[0-9a-f]{12}", attempted["operationId"])
    assert attempted["parentOperationId"] == original_provenance["currentOperationId"]
    assert attempted["outputDataRevision"] == payload["context"]["expectedDataRevision"] + 1
    attempted_codebook = json.loads(publications[0][store._codebook_path(dataset_id)])
    assert attempted["outputSchemaRevision"] == attempted_codebook["schemaRevision"]
    assert attempted["params"]["cjResponse"]["source"] == payload["source"]
    assert attempted["params"]["cjResponse"]["writtenRowCount"] == sum(value is not None for value in expected)
    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    first = response.json()
    operation = _assert_receipt(store, dataset_id, result_id, payload, expected, first,
                                original_provenance["currentOperationId"])
    assert len(publications) == 2
    assert len(store.load_provenance(dataset_id)["operations"]) == len(original_provenance["operations"]) + 1
    assert operation["operationId"] != attempted["operationId"]
    assert operation["params"] == attempted["params"]
    _assert_atomic_publication(store, dataset_id, publications[1], operation)
    committed = _workspace_bytes(store)
    replay = _save(client, result_id, payload)
    assert replay.status_code == 200, replay.text
    assert replay.json() == {**first, "idempotentReplay": True}
    assert _workspace_bytes(store) == committed
    assert len(publications) == 2
