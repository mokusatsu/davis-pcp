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
    _assert_lifecycle(client, store, dataset_id, 1, 1, 8)
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
    _assert_lifecycle(client, store, dataset_id, 2, 2, 9)
    assert (first["dataRevision"], first["schemaRevision"]) == (2, 2)
    assert (operation["inputSchemaRevision"], operation["outputSchemaRevision"]) == (1, 2)
    assert len(publications) == 1
    _assert_atomic_publication(store, dataset_id, publications[0], operation)
    _assert_publication_lifecycle(store, dataset_id, publications[0], 2, 2, 9)
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
        _assert_lifecycle(client, store, dataset_id, 3 if later else 2, 3 if later else 2, 10 if later else 9)
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
    _assert_lifecycle(client, store, dataset_id, 2, 2, 9)
    assert (first["dataRevision"], first["schemaRevision"]) == (2, 2)
    saved_bytes = _workspace_bytes(store)
    saved_operation = store.load_provenance(dataset_id)["operations"][-1]
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
    _assert_lifecycle(client, store, dataset_id, 3, 1, 8)
    for key in ("schema", "schemaRevision", "columnCount", "rowCount", "fingerprint", "valuesFingerprint"):
        assert restored_meta[key] == meta[key]
    assert restored_meta["dataRevision"] == first["dataRevision"] + 1
    provenance = store.load_provenance(dataset_id)
    assert provenance["currentOperationId"] == provenance["cursorOperationId"] == parent
    assert provenance["operations"][-1]["params"]["undoneOperationId"] == first["operationId"]
    after = _workspace_bytes(store)
    assert provenance["operations"][1] == saved_operation
    assert (saved_operation["outputDataRevision"], saved_operation["outputSchemaRevision"]) == (2, 2)
    for path, raw in saved_bytes.items():
        if ".revisions/" in path:
            assert after[path] == raw
    _assert_result_state(client, result_id, (1, 1), (3, 1), "stale")
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
    _assert_publication_lifecycle(store, dataset_id, publications[0], 2, 2, 9)
    assert (attempted["inputSchemaRevision"], attempted["outputSchemaRevision"]) == (1, 2)
    _assert_lifecycle(client, store, dataset_id, 1, 1, 8)
    assert attempted["outputSchemaRevision"] == attempted_codebook["schemaRevision"]
    assert attempted["params"]["cjResponse"]["source"] == payload["source"]
    assert attempted["params"]["cjResponse"]["writtenRowCount"] == sum(value is not None for value in expected)
    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    first = response.json()
    operation = _assert_receipt(store, dataset_id, result_id, payload, expected, first,
                                original_provenance["currentOperationId"])
    _assert_lifecycle(client, store, dataset_id, 2, 2, 9)
    assert (first["dataRevision"], first["schemaRevision"]) == (2, 2)
    assert len(publications) == 2
    assert len(store.load_provenance(dataset_id)["operations"]) == len(original_provenance["operations"]) + 1
    assert operation["operationId"] != attempted["operationId"]
    assert operation["params"] == attempted["params"]
    _assert_atomic_publication(store, dataset_id, publications[1], operation)
    _assert_publication_lifecycle(store, dataset_id, publications[1], 2, 2, 9)
    committed = _workspace_bytes(store)
    replay = _save(client, result_id, payload)
    assert replay.status_code == 200, replay.text
    assert replay.json() == {**first, "idempotentReplay": True}
    assert _workspace_bytes(store) == committed
    assert len(publications) == 2


def _assert_lifecycle(client, store, dataset_id, data_revision, schema_revision, column_count):
    """Check explicit expected revisions/counts across every public and disk view."""
    from app.storage.dataset_store import dataset_fingerprint, values_fingerprint

    before = _workspace_bytes(store)
    frame = store.get_dataframe(dataset_id)
    meta = store.get_meta(dataset_id)
    codebook = store.load_codebook(dataset_id)
    assert frame.height == 16
    assert frame.width - 1 == column_count
    names = [name for name in frame.columns if name != "__rowId__"]
    assert len(names) == column_count
    assert meta == json.loads(store._meta_path(dataset_id).read_bytes())
    assert codebook == json.loads(store._codebook_path(dataset_id).read_bytes())
    assert (meta["dataRevision"], meta["schemaRevision"], meta["columnCount"]) == (
        data_revision, schema_revision, column_count,
    )
    assert meta["rowCount"] == 16
    assert [column["name"] for column in meta["schema"]] == names
    assert codebook["schemaRevision"] == schema_revision
    assert [column["name"] for column in codebook["columns"]] == names
    assert meta["valuesFingerprint"] == values_fingerprint(frame)
    assert meta["fingerprint"] == dataset_fingerprint(
        meta["schema"], schema_revision, frame, meta["format"], meta.get("importOptions") or {},
    )
    if schema_revision > 1:
        assert meta["fingerprint"] != dataset_fingerprint(
            meta["schema"], schema_revision - 1, frame, meta["format"], meta.get("importOptions") or {},
        )
    response = client.get(f"/api/v1/datasets/{dataset_id}")
    assert response.status_code == 200, response.text
    public = response.json()
    for key in ("dataRevision", "schemaRevision", "columnCount", "rowCount", "fingerprint", "valuesFingerprint"):
        assert public[key] == meta[key]
    assert [column["name"] for column in public["schema"]] == names
    response = client.get("/api/v1/datasets")
    assert response.status_code == 200, response.text
    listed = [item for item in response.json()["datasets"] if item["datasetId"] == dataset_id]
    assert len(listed) == 1
    assert listed[0]["columnCount"] == column_count
    assert listed[0]["rowCount"] == 16
    assert listed[0]["fingerprint"] == meta["fingerprint"]
    response = client.get(f"/api/v1/datasets/{dataset_id}/codebook")
    assert response.status_code == 200, response.text
    assert response.json()["schemaRevision"] == schema_revision
    assert response.json()["columns"] == codebook["columns"]
    snapshot = pl.read_parquet(store._snapshot_path(dataset_id, data_revision))
    assert snapshot.schema == frame.schema
    assert snapshot.equals(frame)
    state = json.loads(store._revision_state_path(dataset_id, data_revision).read_bytes())
    for key in ("dataRevision", "schemaRevision", "columnCount", "rowCount", "schema", "fingerprint", "valuesFingerprint"):
        assert state[key] == meta[key]
    assert json.loads(store._revision_codebook_path(dataset_id, data_revision).read_bytes()) == codebook
    assert _workspace_bytes(store) == before


def _assert_publication_lifecycle(store, dataset_id, publication, data_revision, schema_revision, column_count):
    """Inspect the real atomic payload, including a failed attempted publication."""
    meta = json.loads(publication[store._meta_path(dataset_id)])
    codebook = json.loads(publication[store._codebook_path(dataset_id)])
    state = json.loads(publication[store._revision_state_path(dataset_id, data_revision)])
    operation = json.loads(publication[store._provenance_path(dataset_id)])["operations"][-1]
    frame = pl.read_parquet(io.BytesIO(publication[store._parquet_path(dataset_id)]))
    assert (meta["dataRevision"], meta["schemaRevision"], meta["columnCount"]) == (
        data_revision, schema_revision, column_count,
    )
    assert frame.height == meta["rowCount"] == 16
    assert frame.width - 1 == len(meta["schema"]) == len(codebook["columns"]) == column_count
    assert codebook["schemaRevision"] == schema_revision
    for key in ("dataRevision", "schemaRevision", "columnCount", "rowCount", "schema", "fingerprint", "valuesFingerprint"):
        assert state[key] == meta[key]
    assert (operation["outputDataRevision"], operation["outputSchemaRevision"]) == (data_revision, schema_revision)
    assert json.loads(publication[store._revision_codebook_path(dataset_id, data_revision)]) == codebook
    assert publication[store._snapshot_path(dataset_id, data_revision)] == publication[store._parquet_path(dataset_id)]


def _assert_result_state(client, result_id, original, current, state):
    response = client.get(f"/api/v1/analysis-results/{result_id}")
    assert response.status_code == 200, response.text
    meta = response.json()["meta"]
    assert (meta["dataRevision"], meta["schemaRevision"]) == original
    assert (meta["currentDataRevision"], meta["currentSchemaRevision"]) == current
    assert meta["resultState"] == state


@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_current_schema_refit_and_second_save_preserve_historical_receipt(
    conjoint_workspace, monkeypatch, source_kind, scope,
):
    client, store = conjoint_workspace
    dataset_id, result_id, frame, payload, expected = _prepare(client, store, source_kind, scope)
    parent = store.load_provenance(dataset_id)["currentOperationId"]
    publications = _capture_publications(store, monkeypatch)
    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    first = response.json()
    operation = _assert_receipt(store, dataset_id, result_id, payload, expected, first, parent)
    _assert_lifecycle(client, store, dataset_id, 2, 2, 9)
    assert (first["dataRevision"], first["schemaRevision"]) == (2, 2)
    assert len(publications) == 1
    _assert_publication_lifecycle(store, dataset_id, publications[0], 2, 2, 9)
    saved_frame = store.get_dataframe(dataset_id)
    assert saved_frame.select(frame.columns).schema == frame.schema
    assert saved_frame.select(frame.columns).equals(frame)
    saved_bytes = _workspace_bytes(store)
    _assert_result_state(client, result_id, (1, 1), (2, 2), "stale")
    for data_revision, schema_revision in ((1, 1), (2, 2)):
        _assert_rejected(client, store, result_id, {
            **payload, "idempotencyKey": "stale-result-new-key",
            "columns": [{"sourceField": "probability", "name": "SECOND_CJ_PROBABILITY"}],
            "context": dict(payload["context"], expectedDataRevision=data_revision,
                            expectedSchemaRevision=schema_revision),
        }, saved_bytes, "ANALYSIS_INPUT_STALE")
    context = dict(payload["context"], scope="all", expectedDataRevision=2, expectedSchemaRevision=2)
    context.pop("selectedRowIds", None)
    model = {
        "context": context, "mode": "choice", "method": "conjoint",
        "columns": {"respondentId": "respondent_id", "taskId": "task_id",
                    "alternativeId": "alternative_id", "response": "chosen"},
        "attributes": [{"columnId": "brand", "kind": "categorical"}],
    }
    rejected = client.post("/api/v1/models/conjoint", json={
        **model, "context": dict(context, expectedSchemaRevision=1),
    })
    assert rejected.status_code == 409, rejected.text
    assert rejected.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
    assert rejected.json()["error"]["details"] == {"schemaRevision": 2, "expectedSchemaRevision": 1}
    assert _workspace_bytes(store) == saved_bytes
    refit = client.post("/api/v1/models/conjoint", json=model)
    assert refit.status_code == 200, refit.text
    new_result_id = refit.json()["resultId"]
    assert new_result_id != result_id
    _assert_result_state(client, new_result_id, (2, 2), (2, 2), "current")
    source = "fit"
    endpoint = f"/api/v1/analysis-results/{new_result_id}"
    if source_kind == "prediction":
        prediction = client.post(endpoint + "/predict", json={
            "context": context, "options": {"interval": "none", "evaluate": True},
        })
        assert prediction.status_code == 200, prediction.text
        assert prediction.json()["summary"]["successfulPredictions"] == 16
        source = prediction.json()["predictionId"]
        endpoint += f"/predictions/{source}"
    rows = client.get(endpoint + "/rows", params={"offset": 0, "limit": 1000})
    assert rows.status_code == 200, rows.text
    values = {row["rowId"]: row["probability"] for row in rows.json()["rows"]}
    assert set(values) == set(frame["__rowId__"].to_list())
    assert all(value is not None for value in values.values())
    after_refit = _workspace_bytes(store)
    for path, raw in saved_bytes.items():
        assert after_refit[path] == raw
    assert len(publications) == 1
    _assert_lifecycle(client, store, dataset_id, 2, 2, 9)
    second_payload = {
        **payload, "source": source, "idempotencyKey": "current-refit-save",
        "context": dict(payload["context"], expectedDataRevision=2, expectedSchemaRevision=2),
        "columns": [{"sourceField": "probability", "name": "SECOND_CJ_PROBABILITY", "label": "saved probability"}],
    }
    ids = second_payload["context"].get("selectedRowIds", frame["__rowId__"].to_list())
    second_expected = [values[row_id] if row_id in ids else None for row_id in frame["__rowId__"].to_list()]
    second = _save(client, new_result_id, second_payload)
    assert second.status_code == 200, second.text
    second_receipt = second.json()
    second_operation = _assert_receipt(
        store, dataset_id, new_result_id, second_payload, second_expected, second_receipt, first["operationId"],
    )
    assert (second_receipt["dataRevision"], second_receipt["schemaRevision"]) == (3, 3)
    assert (second_operation["inputSchemaRevision"], second_operation["outputSchemaRevision"]) == (2, 3)
    _assert_lifecycle(client, store, dataset_id, 3, 3, 10)
    assert len(publications) == 2
    _assert_atomic_publication(store, dataset_id, publications[1], second_operation)
    _assert_publication_lifecycle(store, dataset_id, publications[1], 3, 3, 10)
    current_frame = store.get_dataframe(dataset_id)
    assert current_frame.select(saved_frame.columns).schema == saved_frame.schema
    assert current_frame.select(saved_frame.columns).equals(saved_frame)
    final_bytes = _workspace_bytes(store)
    for path, raw in after_refit.items():
        if path.startswith("analysis-results/") or ".revisions/" in path or path.endswith(".raw.parquet"):
            assert final_bytes[path] == raw
    assert store.load_provenance(dataset_id)["operations"][1] == operation
    _assert_result_state(client, result_id, (1, 1), (3, 3), "stale")
    _assert_result_state(client, new_result_id, (2, 2), (3, 3), "stale")
    for data_revision, schema_revision in ((1, 1), (2, 2), (3, 3)):
        replay = _save(client, result_id, {
            **payload, "context": dict(payload["context"], expectedDataRevision=data_revision,
                                        expectedSchemaRevision=schema_revision),
        })
        assert replay.status_code == 200, replay.text
        assert replay.json() == {**first, "idempotentReplay": True}
        assert _workspace_bytes(store) == final_bytes
    assert len(publications) == 2


@pytest.mark.parametrize("structural_case", ["two_destinations", "empty_selected"])
def test_structural_save_increments_schema_once(conjoint_workspace, monkeypatch, structural_case):
    client, store = conjoint_workspace
    dataset_id, result_id, frame, payload, expected = _prepare(client, store, "fit", "all")
    if structural_case == "two_destinations":
        payload["columns"].append({"sourceField": "probability", "name": "SECOND_CJ_PROBABILITY", "label": "second probability"})
        count, column_count = 16, 10
    else:
        payload["context"] = dict(payload["context"], scope="selected", selectedRowIds=[])
        expected = [None] * 16
        count, column_count = 0, 9
    before = _workspace_bytes(store)
    parent = store.load_provenance(dataset_id)["currentOperationId"]
    publications = _capture_publications(store, monkeypatch)
    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    receipt = response.json()
    saved = store.get_dataframe(dataset_id)
    assert saved.select(frame.columns).schema == frame.schema
    assert saved.select(frame.columns).equals(frame)
    assert saved.columns == frame.columns + [column["name"] for column in payload["columns"]]
    for column in payload["columns"]:
        assert saved[column["name"]].to_list() == expected
        assert saved[column["name"]].null_count() == 16 - count
    operation = store.load_provenance(dataset_id)["operations"][-1]
    assert receipt == {
        "status": "success", "resultId": result_id, "source": "fit", "datasetId": dataset_id,
        "operationId": operation["operationId"], "dataRevision": 2, "schemaRevision": 2,
        "createdColumns": [{"columnId": column["name"], **column, "nonNullCount": count}
                           for column in payload["columns"]],
        "writtenRowCount": count, "idempotentReplay": False,
    }
    assert operation["parentOperationId"] == parent
    assert (operation["inputDataRevision"], operation["outputDataRevision"]) == (1, 2)
    assert (operation["inputSchemaRevision"], operation["outputSchemaRevision"]) == (1, 2)
    assert operation["targetRowIds"] == ([] if count == 0 else sorted(frame["__rowId__"].to_list()))
    _assert_lifecycle(client, store, dataset_id, 2, 2, column_count)
    assert len(publications) == 1
    _assert_atomic_publication(store, dataset_id, publications[0], operation)
    _assert_publication_lifecycle(store, dataset_id, publications[0], 2, 2, column_count)
    after = _workspace_bytes(store)
    for path, raw in before.items():
        if path.startswith("analysis-results/") or ".revisions/" in path or path.endswith(".raw.parquet"):
            assert after[path] == raw
    for data_revision, schema_revision in ((1, 1), (2, 2)):
        replay = _save(client, result_id, {
            **payload, "context": dict(payload["context"], expectedDataRevision=data_revision,
                                        expectedSchemaRevision=schema_revision),
        })
        assert replay.status_code == 200, replay.text
        assert replay.json() == {**receipt, "idempotentReplay": True}
        assert _workspace_bytes(store) == after
    assert len(publications) == 1
