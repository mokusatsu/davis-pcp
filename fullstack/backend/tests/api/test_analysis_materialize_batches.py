"""Batch saves preserve every ordered mapping or reject without writing.

Exercise real import, fit, prediction, materialization and persistence against
synthetic datasets. Case artifacts retain exact source values and receipts.
"""
from __future__ import annotations

import hashlib
import json

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.storage import analysis_result_store as result_store
from app.storage.dataset_store import DatasetStore
from .test_analysis_materialize_columns import _column, _fit, _save, _workspace_bytes


@pytest.fixture
def batch_workspace(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    monkeypatch.setattr(settings, "workspace_dir", root)
    settings.ensure_dirs()
    from app.api import analysis_results, datasets, factor_analysis, famd, linear_regression, mca
    store = DatasetStore(root)
    for module in (datasets, analysis_results, factor_analysis, famd, linear_regression, mca):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        yield client, store


def _fit_batch(client, method):
    if method != "efa":
        return _fit(client, method)
    # Two distinct factors distinguish replacement from valid source aliases.
    rng = np.random.default_rng(20261006)
    loading = np.array([[.8, .0], [.7, .0], [.6, .0], [.0, .8], [.0, .7], [.0, .6]])
    covariance = loading @ loading.T + np.diag(1 - np.diag(loading @ loading.T))
    data = rng.multivariate_normal(np.zeros(6), covariance, size=400)
    frame = pl.DataFrame({f"q{i + 1}": data[:, i] for i in range(6)})
    imported = client.post("/api/v1/datasets/import", files={
        "file": ("two-factor.csv", frame.write_csv().encode(), "text/csv")})
    assert imported.status_code == 200, imported.text
    dataset_id = imported.json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
    context = {"datasetId": dataset_id, "expectedDataRevision": 1,
               "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none"}
    response = client.post("/api/v1/models/factor-analysis", json={
        "context": context,
        "variables": [{"columnId": c["columnId"], "measurement": "continuous",
                       "treatment": "continuous"} for c in cb["columns"]],
        "correlation": "pearson", "extraction": "ml", "nFactors": 2,
        "rotation": "varimax", "scoreMethod": "regression",
        "parallelAnalysis": {"enabled": False}, "uniquenessLower": .005,
        "nStarts": 1, "maxIterations": 300, "seed": 1,
        "method": "efa", "schemaVersion": "factor_extensions.1"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["capabilities"]["materialize"]
    assert {"score:1", "score:2"}.issubset(result["capabilities"]["materializeFitFields"])
    return dataset_id, context, result["resultId"], "q1"


def _batch_sources(client, method, result_id, context, kind):
    source = "fit"
    if kind == "prediction":
        options = {"interval": "mean_ci"} if method == "ols" else {}
        response = client.post(f"/api/v1/analysis-results/{result_id}/predict",
                               json={"context": context, "options": options})
        assert response.status_code == 200, response.text
        source = response.json()["predictionId"]
    if method == "ols":
        fields = ["fitted", "residual"] if kind == "fit" else ["predicted", "mean_ci_lower"]
        from app.api.linear_regression import LR_FIT_FIELD_MAP, LR_PRED_FIELD_MAP
        mapping = LR_FIT_FIELD_MAP if kind == "fit" else LR_PRED_FIELD_MAP
    elif method == "efa":
        fields = ["score:1", "score:2"]
        mapping = {"score:1": "score1", "score:2": "score2"}
    else:
        fields = ["coordinate:1", "coordinate:2"]
        mapping = {"coordinate:1": "axis1", "coordinate:2": "axis2"}
    rows = (result_store.load_rows(result_id) if kind == "fit"
            else result_store.load_prediction_rows(result_id, source))
    values = {str(row["rowId"]): {field: row[mapping[field]] for field in fields}
              for row in rows.rows(named=True)
              if kind == "fit" or row.get("status") == "ok"}
    return source, fields, values


def _inventory(contents):
    return {name: {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for name, data in contents.items()}


@pytest.mark.parametrize("method", ["ols", "mca", "famd", "efa"])
@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("case", ["duplicate_destination", "exact_duplicate", "unique_sources", "source_aliases"])
def test_materialize_batch_integrity(batch_workspace, tmp_path, method, source_kind, case):
    client, store = batch_workspace
    dataset_id, context, result_id, ordinary_name = _fit_batch(client, method)
    source, fields, values = _batch_sources(client, method, result_id, context, source_kind)
    original = store.get_dataframe(dataset_id)
    row_ids = original["__rowId__"].to_list()
    expected = {f: [values.get(str(rid), {}).get(f) for rid in row_ids] for f in fields}
    assert all(any(value is not None for value in vector) for vector in expected.values())
    assert expected[fields[0]] != expected[fields[1]], "Distinct source fixture must differ"
    # Names and sources are deliberately not sorted. Names remain case-sensitive.
    mappings = {
        "duplicate_destination": [(fields[1], "BATCH_OUTPUT"), (fields[0], "BATCH_OUTPUT")],
        "exact_duplicate": [(fields[0], "BATCH_OUTPUT"), (fields[0], "BATCH_OUTPUT")],
        "unique_sources": [(fields[1], "BATCH_Z"), (fields[0], "BATCH_A")],
        "source_aliases": [(fields[0], "alias"), (fields[0], "ALIAS")],
    }[case]
    columns = lambda pairs: [_column(method, field, name) for field, name in pairs]
    payload = {"context": context, "source": source, "columns": columns(mappings),
               "idempotencyKey": f"batch-{case}"}
    before = _workspace_bytes(store)
    assert any(".revisions/" in name for name in before)
    controls = []

    def reject(label, request, snapshot, code="COLUMN_ALREADY_EXISTS", status=409):
        response = _save(client, result_id, request)
        assert response.status_code == status, response.text
        assert response.json()["error"]["code"] == code, response.text
        assert _workspace_bytes(store) == snapshot
        controls.append({"control": label, "request": request, "status": status,
                         "response": response.json(), "workspace_byte_identical": True})

    # A valid prefix must not be written before a later mapping is rejected.
    for name in (ordinary_name, "__rowId__"):
        reject("existing:" + name, {**payload, "columns": columns([
            (fields[0], "VALID_PREFIX"), (fields[1], name)])}, before)
    for revision in ("expectedDataRevision", "expectedSchemaRevision"):
        reject(revision, {**payload, "context": dict(context, **{revision: 999})},
               before, "ANALYSIS_INPUT_STALE")
    reject("invalid_destination", {**payload, "columns": columns([
        (fields[0], "VALID_PREFIX"), (fields[1], "invalid-name")])},
        before, "ANALYSIS_REQUEST_INVALID", 422)
    reject("unsupported_source", {**payload, "columns": columns([
        (fields[0], "VALID_PREFIX"), ("unsupported", "VALID_SUFFIX")])},
        before, "ANALYSIS_REQUEST_INVALID", 422)
    original_payload = payload
    if case in ("duplicate_destination", "exact_duplicate"):
        reject(case, payload, before)
        # Rejection cannot reserve the key or names. Only fix the destination.
        mappings = [(mappings[0][0], "BATCH_OUTPUT"), (mappings[1][0], "BATCH_OTHER")]
        payload = {**payload, "columns": columns(mappings)}

    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    receipt = response.json()
    after = _workspace_bytes(store)
    saved = store.get_dataframe(dataset_id)
    meta = store.get_meta(dataset_id)
    cb = store.load_codebook(dataset_id)
    prov = store.load_provenance(dataset_id)
    prefix = "lr" if method == "ols" else method
    operations = [op for op in prov["operations"]
                  if op.get("params", {}).get(prefix + "ResultId") == result_id]
    assert len(operations) == 1
    operation = operations[0]
    op_fields = operation["params"][prefix + "Fields"]
    created = receipt.get("createdColumns", receipt.get("columns"))
    source_key = "source" if method == "efa" else "sourceField"
    assert [(c[source_key], c["name"]) for c in created] == mappings
    assert [(f[source_key], f["name"]) for f in op_fields] == mappings
    names = [name for _, name in mappings]
    assert saved.columns == original.columns + names
    assert saved.select(original.columns).equals(original)
    assert saved.schema["__rowId__"] == pl.String
    for schema in (cb["columns"], meta["schema"]):
        assert len({c["name"] for c in schema}) == len(schema)
        assert len({c["columnId"] for c in schema}) == len(schema)
        assert [c["name"] for c in schema if c["name"] in names] == names
    for (field, name), reported, recorded in zip(mappings, created, op_fields):
        assert saved.schema[name] == pl.Float64
        assert saved[name].to_list() == expected[field]
        stored_column = next(c for c in cb["columns"] if c["name"] == name)
        meta_column = next(c for c in meta["schema"] if c["name"] == name)
        assert stored_column["columnId"] == meta_column["columnId"] == recorded["columnId"]
        assert stored_column["origin"]["sourceField"] == field
        assert stored_column["origin"]["resultId"] == result_id
        assert stored_column["origin"]["source"] == source
        if method == "efa":
            assert recorded["values"] == expected[field]
        else:
            assert reported["columnId"] == stored_column["columnId"]
            assert reported["nonNullCount"] == sum(v is not None for v in expected[field])
    if method != "efa":
        assert receipt["writtenRowCount"] == len(row_ids)
    assert receipt["idempotentReplay"] is False
    assert receipt["dataRevision"] == receipt["schemaRevision"] == 2
    assert meta["dataRevision"] == meta["schemaRevision"] == cb["schemaRevision"] == 2
    assert operation["outputDataRevision"] == operation["outputSchemaRevision"] == 2
    revision_state = store.read_revision_state(dataset_id, 2)
    revision_cb = store.read_revision_codebook(dataset_id, 2)
    assert revision_state["schema"] == meta["schema"]
    assert revision_cb == cb
    assert store._snapshot_path(dataset_id, 2).read_bytes() == store._parquet_path(dataset_id).read_bytes()
    for endpoint, key in (("", "schema"), ("/codebook", "columns")):
        readback = client.get(f"/api/v1/datasets/{dataset_id}{endpoint}")
        assert readback.status_code == 200, readback.text
        actual = [(c["name"], c["columnId"]) for c in readback.json()[key] if c["name"] in names]
        assert actual == [(f["name"], f["columnId"]) for f in op_fields]

    replays = []
    # Both original and current revisions return the complete saved receipt.
    current_context = dict(context, expectedDataRevision=2, expectedSchemaRevision=2)
    for replay_context in (context, current_context):
        replay = _save(client, result_id, {**payload, "context": replay_context})
        assert replay.status_code == 200, replay.text
        assert replay.json() == {**receipt, "idempotentReplay": True}
        assert _workspace_bytes(store) == after
        replays.append({"context": replay_context, "receipt": replay.json(),
                        "workspace_byte_identical": True})
    # Conflict and stale guards still precede the new duplicate-name guard.
    duplicate_payload = {**payload, "context": current_context, "columns": columns([
        (fields[0], "OTHER_OUTPUT"), (fields[1], "OTHER_OUTPUT")])}
    reject("idempotency_conflict", duplicate_payload, after, "IDEMPOTENCY_CONFLICT")
    reject("stale_result", {**duplicate_payload, "idempotencyKey": "new-key"},
           after, "ANALYSIS_INPUT_STALE")
    evidence = {"method": method, "source_kind": source_kind, "case": case,
                "original_request": original_payload, "accepted_request": payload,
                "receipt": receipt, "row_ids": row_ids, "source_values": expected,
                "saved_values": {name: saved[name].to_list() for name in names},
                "codebook": cb, "metadata": meta, "operation": operation,
                "rejection_controls": controls, "replays": replays,
                "before_inventory": _inventory(before), "after_inventory": _inventory(after),
                "revision_two_matches_current": True}
    (tmp_path / "batch-evidence.json").write_text(
        json.dumps(evidence, indent=2, ensure_ascii=False), encoding="utf-8")
