"""Materialized columns agree across persisted counts and API readbacks.

Real import/fit/predict/save routes operate only on a temporary workspace.
These checks cover API contracts; they do not exercise the live GUI.
"""
from __future__ import annotations

import json

import polars as pl
import pytest

from .test_analysis_materialize_batches import (
    _batch_sources,
    _fit_batch,
    batch_workspace,
)
from .test_analysis_materialize_columns import _column, _save, _workspace_bytes


def _assert_count_views(client, store, dataset_id, expected_count, expected_rows, revision):
    frame = store.get_dataframe(dataset_id)
    metadata = store.get_meta(dataset_id)
    codebook = store.load_codebook(dataset_id)
    state = store.read_revision_state(dataset_id, revision)
    snapshot = pl.read_parquet(store._snapshot_path(dataset_id, revision))
    revision_codebook = store.read_revision_codebook(dataset_id, revision)
    detail = client.get(f"/api/v1/datasets/{dataset_id}")
    assert detail.status_code == 200, detail.text
    listing = client.get("/api/v1/datasets")
    assert listing.status_code == 200, listing.text
    listed = next(item for item in listing.json()["datasets"]
                  if item["datasetId"] == dataset_id)
    readback = client.get(f"/api/v1/datasets/{dataset_id}/codebook")
    assert readback.status_code == 200, readback.text
    counts = {"metadata": metadata["columnCount"],
              "get": detail.json()["columnCount"], "list": listed["columnCount"],
              "revision": state["columnCount"]}
    assert set(counts.values()) == {expected_count}
    assert frame.columns.count("__rowId__") == 1
    user_columns = [name for name in frame.columns if name != "__rowId__"]
    assert len(user_columns) == expected_count
    assert frame.width == expected_count + 1
    for schema in (metadata["schema"], codebook["columns"], state["schema"],
                   revision_codebook["columns"], detail.json()["schema"],
                   readback.json()["columns"]):
        assert [column["name"] for column in schema] == user_columns
        assert len({column["columnId"] for column in schema}) == expected_count
    assert snapshot.equals(frame)
    assert frame.height == expected_rows
    for record in (metadata, state, detail.json(), listed):
        assert record["rowCount"] == expected_rows
    assert metadata["dataRevision"] == state["dataRevision"] == revision
    assert metadata["schemaRevision"] == codebook["schemaRevision"] == revision
    return counts


@pytest.mark.parametrize("method", ["ols", "mca", "famd", "efa"])
@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("case", ["single", "distinct_pair", "source_aliases"])
def test_materialize_persists_user_column_counts(
    batch_workspace, tmp_path, method, source_kind, case,
):
    client, store = batch_workspace
    dataset_id, context, result_id, ordinary_name = _fit_batch(client, method)
    source, fields, source_values = _batch_sources(
        client, method, result_id, context, source_kind)
    original = store.get_dataframe(dataset_id)
    row_ids = original["__rowId__"].to_list()
    original_count = original.width - 1
    original_counts = _assert_count_views(
        client, store, dataset_id, original_count, original.height, 1)
    original_state = store.read_revision_state(dataset_id, 1)
    original_snapshot = store._snapshot_path(dataset_id, 1).read_bytes()
    original_codebook = store.read_revision_codebook(dataset_id, 1)
    mappings = {
        "single": [(fields[0], "COUNT_SINGLE")],
        "distinct_pair": [(fields[1], "COUNT_Z"), (fields[0], "COUNT_A")],
        "source_aliases": [(fields[0], "count_alias"), (fields[0], "COUNT_ALIAS")],
    }[case]
    columns = lambda pairs: [_column(method, field, name) for field, name in pairs]
    payload = {"context": context, "source": source, "columns": columns(mappings),
               "idempotencyKey": f"count-{case}"}
    before = _workspace_bytes(store)

    def reject(request, snapshot, code="COLUMN_ALREADY_EXISTS", status=409):
        response = _save(client, result_id, request)
        assert response.status_code == status, response.text
        assert response.json()["error"]["code"] == code, response.text
        assert _workspace_bytes(store) == snapshot

    # Even a valid prefix must not change counts if a later mapping is rejected.
    for name in (ordinary_name, "__rowId__", "COUNT_PREFIX"):
        reject({**payload, "columns": columns([
            (fields[0], "COUNT_PREFIX"), (fields[1], name)])}, before)
    for revision_key in ("expectedDataRevision", "expectedSchemaRevision"):
        reject({**payload, "context": dict(context, **{revision_key: 999})},
               before, "ANALYSIS_INPUT_STALE")
    reject({**payload, "columns": columns([(fields[0], "invalid-name")])},
           before, "ANALYSIS_REQUEST_INVALID", 422)
    reject({**payload, "columns": columns([("unsupported", "COUNT_INVALID")])},
           before, "ANALYSIS_REQUEST_INVALID", 422)

    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    receipt = response.json()
    assert receipt["idempotentReplay"] is False
    assert receipt["dataRevision"] == receipt["schemaRevision"] == 2
    saved = store.get_dataframe(dataset_id)
    assert saved.columns == original.columns + [name for _, name in mappings]
    assert saved.select(original.columns).equals(original)
    assert saved.schema["__rowId__"] == pl.String
    for field, name in mappings:
        expected = [source_values.get(str(rid), {}).get(field) for rid in row_ids]
        assert any(value is not None for value in expected)
        assert saved.schema[name] == pl.Float64
        assert saved[name].to_list() == expected
    expected_count = original_count + len(mappings)
    saved_counts = _assert_count_views(
        client, store, dataset_id, expected_count, original.height, 2)
    assert store.read_revision_state(dataset_id, 1) == original_state
    assert store._snapshot_path(dataset_id, 1).read_bytes() == original_snapshot
    assert store.read_revision_codebook(dataset_id, 1) == original_codebook
    after = _workspace_bytes(store)

    # Neither a replay nor a rejected reuse may increment or roll back counts.
    current_context = dict(context, expectedDataRevision=2, expectedSchemaRevision=2)
    for replay_context in (context, current_context):
        replay = _save(client, result_id, {**payload, "context": replay_context})
        assert replay.status_code == 200, replay.text
        assert replay.json() == {**receipt, "idempotentReplay": True}
        assert _assert_count_views(
            client, store, dataset_id, expected_count, original.height, 2) == saved_counts
        assert _workspace_bytes(store) == after
    changed = {**payload, "context": current_context,
               "columns": columns([(fields[0], "COUNT_OTHER")])}
    reject(changed, after, "IDEMPOTENCY_CONFLICT")
    reject({**changed, "idempotencyKey": "new-count-key"}, after, "ANALYSIS_INPUT_STALE")
    evidence = {"method": method, "source_kind": source_kind, "case": case,
                "originalCounts": original_counts, "savedCounts": saved_counts,
                "physicalWidth": saved.width, "hiddenRowIdColumns": 1,
                "schemaLength": len(store.get_meta(dataset_id)["schema"]),
                "codebookLength": len(store.load_codebook(dataset_id)["columns"]),
                "rowCount": saved.height, "receipt": receipt,
                "originalRowsIdsValuesUnchanged": True,
                "originalRevisionUnchanged": True,
                "rejectionAndReplayWorkspaceByteIdentical": True,
                "apiVerified": True, "liveGuiVerified": False}
    (tmp_path / "count-evidence.json").write_text(
        json.dumps(evidence, indent=2, ensure_ascii=False), encoding="utf-8")
