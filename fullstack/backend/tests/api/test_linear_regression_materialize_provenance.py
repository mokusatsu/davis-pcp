"""Linear-regression saves record source and destination schema revisions.

Exercise real fit/prediction saves, CSV export and Undo in an isolated workspace.
Only storage roots are redirected; routes, numerics and persistence are real.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore
from .test_analysis_materialize_columns import _fit, _save, _source


@pytest.fixture
def linear_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    settings.ensure_dirs()
    from app.api import analysis_results, datasets, exports, linear_regression

    store = DatasetStore(tmp_path)
    for module in (datasets, analysis_results, exports, linear_regression):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        yield client, store


def _csv(client, dataset_id):
    response = client.post("/api/v1/exports", json={
        "datasetId": dataset_id, "scope": "all", "format": "csv",
    })
    assert response.status_code == 200, response.text
    return response.content


@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_linear_materialize_schema_provenance_and_undo(linear_workspace, source_kind, scope):
    client, store = linear_workspace
    dataset_id, context, result_id, _ = _fit(client, "ols")
    source, field = _source(client, "ols", result_id, context, source_kind)
    original = store.get_dataframe(dataset_id)
    original_meta = store.get_meta(dataset_id)
    original_codebook = store.load_codebook(dataset_id)
    original_mask = store.load_mask(dataset_id)
    original_provenance = store.load_provenance(dataset_id)
    original_csv = _csv(client, dataset_id)
    row_ids = original["__rowId__"].to_list()
    scope_ids = row_ids if scope == "all" else row_ids[::2]
    save_context = dict(context, scope=scope)
    if scope == "selected":
        save_context["selectedRowIds"] = scope_ids
    assert save_context["expectedSchemaRevision"] == original_codebook["schemaRevision"]
    assert save_context["expectedDataRevision"] == original_meta["dataRevision"]

    rows_path = (f"/api/v1/analysis-results/{result_id}/rows" if source_kind == "fit"
                 else f"/api/v1/analysis-results/{result_id}/predictions/{source}/rows")
    rows_response = client.get(rows_path, params={"offset": 0, "limit": len(row_ids)})
    assert rows_response.status_code == 200, rows_response.text
    rows = rows_response.json()["rows"]
    assert len(rows) == len(row_ids)
    if source_kind == "prediction":
        assert all(row["predictionStatus"] == "ok" for row in rows)
    source_values = {row["rowId"]: row[field] for row in rows}
    expected_values = [source_values[rid] if rid in scope_ids else None for rid in row_ids]
    assert all(source_values[rid] is not None for rid in scope_ids)

    payload = {"context": save_context, "source": source,
               "columns": [{"sourceField": field, "name": "LR_SAVED", "label": "Saved regression"}],
               "idempotencyKey": "linear-provenance"}
    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    receipt = response.json()
    saved = store.get_dataframe(dataset_id)
    saved_meta = store.get_meta(dataset_id)
    saved_codebook = store.load_codebook(dataset_id)
    provenance_response = client.get(f"/api/v1/datasets/{dataset_id}/provenance")
    assert provenance_response.status_code == 200, provenance_response.text
    provenance = provenance_response.json()
    operation = provenance["operations"][-1]
    assert saved.columns == original.columns + ["LR_SAVED"]
    assert saved.select(original.columns).equals(original)
    assert saved.schema["LR_SAVED"] == saved.schema["y"]
    assert saved["LR_SAVED"].to_list() == expected_values
    assert saved_codebook["columns"][:-1] == original_codebook["columns"]
    assert receipt["writtenRowCount"] == receipt["createdColumns"][0]["nonNullCount"] == len(scope_ids)
    assert receipt["idempotentReplay"] is False
    assert receipt["dataRevision"] == saved_meta["dataRevision"] == original_meta["dataRevision"] + 1
    assert receipt["schemaRevision"] == saved_meta["schemaRevision"] == saved_codebook["schemaRevision"]
    assert receipt["schemaRevision"] == original_codebook["schemaRevision"] + 1
    assert operation["operation"] == "calculate"
    assert operation["operationId"] == receipt["operationId"] == provenance["currentOperationId"]
    assert operation["parentOperationId"] == original_provenance["currentOperationId"]
    assert operation["inputDataRevision"] == original_meta["dataRevision"]
    assert operation["outputDataRevision"] == receipt["dataRevision"]
    assert operation["outputSchemaRevision"] == receipt["schemaRevision"]
    assert operation["targetRowIds"] == sorted(scope_ids)
    assert provenance["operations"] == original_provenance["operations"] + [operation]
    assert store.load_mask(dataset_id) == {**original_mask, "dataRevision": receipt["dataRevision"]}

    undo_response = client.post(f"/api/v1/datasets/{dataset_id}/undo", json={
        "expectedDataRevision": receipt["dataRevision"],
        "expectedSchemaRevision": receipt["schemaRevision"],
    })
    assert undo_response.status_code == 200, undo_response.text
    undo = undo_response.json()
    restored_meta = store.get_meta(dataset_id)
    restored_provenance = store.load_provenance(dataset_id)
    undo_operation = restored_provenance["operations"][-1]
    assert store.get_dataframe(dataset_id).equals(original)
    assert _csv(client, dataset_id) == original_csv
    assert store.load_codebook(dataset_id) == original_codebook
    assert restored_meta["schema"] == original_meta["schema"]
    assert restored_meta["fingerprint"] == original_meta["fingerprint"]
    assert undo["restoreWarnings"] == []
    assert undo["targetDataRevision"] == original_meta["dataRevision"]
    assert undo["currentDataRevision"] == restored_meta["dataRevision"] == receipt["dataRevision"] + 1
    assert undo["schemaRevision"] == restored_meta["schemaRevision"] == original_codebook["schemaRevision"]
    assert undo["maskRevision"] == original_mask["maskRevision"] + 1
    assert store.load_mask(dataset_id) == {
        **original_mask, "dataRevision": undo["currentDataRevision"], "maskRevision": undo["maskRevision"],
    }
    assert restored_provenance["operations"] == provenance["operations"] + [undo_operation]
    assert undo_operation["operation"] == "undo"
    assert undo_operation["params"]["undoneOperationId"] == receipt["operationId"]
    assert undo_operation["inputDataRevision"] == receipt["dataRevision"]
    assert undo_operation["outputDataRevision"] == undo["currentDataRevision"]
    assert restored_provenance["currentOperationId"] == original_provenance["currentOperationId"]
    assert restored_provenance["cursorOperationId"] == original_provenance["cursorOperationId"]
    assert restored_provenance["redoStack"] == [receipt["operationId"]]
    assert undo["canUndo"] is False and undo["canRedo"] is True

    # Check last so the baseline proves the complete save/Undo lifecycle first.
    assert operation["inputSchemaRevision"] == payload["context"]["expectedSchemaRevision"]
