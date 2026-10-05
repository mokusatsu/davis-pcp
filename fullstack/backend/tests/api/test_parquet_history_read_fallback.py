"""Native/WASM history reads share a portable Parquet fallback.

All simulated reader failures act on isolated pytest storage and real built-ins.
"""
from __future__ import annotations

from pathlib import Path

import polars as pl
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from app.api import datasets
from app.config import settings
from app.domain.errors import BizError
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def builtin_store(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, "store", store)
    with TestClient(app) as client:
        yield client, store


def import_builtin(client, store, sample_id="iris"):
    response = client.post("/api/v1/datasets/import/sample", json={"sampleId": sample_id})
    assert response.status_code == 200, response.text
    did = response.json()["datasetId"]
    return did, store.get_dataframe(did), store.load_codebook(did)


def unavailable_polars_reader(*_args, **_kwargs):
    raise AttributeError("type object 'builtins.PyLazyFrame' has no attribute 'new_from_parquet'")


def artifact_reader(store, dataset_id, kind, columns=None):
    if kind == "snapshot":
        return store.read_snapshot(dataset_id, 1)
    if kind == "raw":
        return store.read_raw(dataset_id)
    return store.get_dataframe(dataset_id, columns=columns)


def artifact_path(store, dataset_id, kind):
    if kind == "snapshot":
        return store._snapshot_path(dataset_id, 1)
    if kind == "raw":
        return store._raw_path(dataset_id)
    return store._parquet_path(dataset_id)


def file_bytes(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


@pytest.mark.parametrize("sample_id", ["iris", "siechnice-cbc96"])
@pytest.mark.parametrize("kind", ["current", "snapshot", "raw"])
def test_missing_polars_reader_uses_arrow_for_every_dataset_artifact(builtin_store, monkeypatch, sample_id, kind):
    client, store = builtin_store
    did, expected, _ = import_builtin(client, store, sample_id)
    path = artifact_path(store, did, kind)
    before = file_bytes(store.root)
    native_arrow = pq.read_table
    calls = []
    def tracked_arrow(source, *args, **kwargs):
        calls.append((Path(source), kwargs.get("columns")))
        return native_arrow(source, *args, **kwargs)
    monkeypatch.setattr(pl, "read_parquet", unavailable_polars_reader)
    monkeypatch.setattr(pq, "read_table", tracked_arrow)
    actual = artifact_reader(store, did, kind)
    assert actual.equals(expected)
    assert actual.schema == expected.schema
    assert actual["__rowId__"].to_list() == expected["__rowId__"].to_list()
    assert calls == [(path, None)]
    # Includes Siechnice textual respondent IDs and structural opt-out nulls.
    if sample_id == "siechnice-cbc96":
        assert actual["respondent_id"].dtype == pl.String
        assert actual["atr1"].null_count() == 1152
    assert file_bytes(store.root) == before


@pytest.mark.parametrize("columns", [["__rowId__", "species"], ["petal_width_cm", "__rowId__", "sepal_length_cm"]])
def test_current_arrow_fallback_retains_exact_requested_projection(builtin_store, monkeypatch, columns):
    client, store = builtin_store
    did, frame, _ = import_builtin(client, store)
    native_arrow = pq.read_table
    calls = []
    def tracked_arrow(source, *args, **kwargs):
        calls.append(kwargs.get("columns"))
        return native_arrow(source, *args, **kwargs)
    monkeypatch.setattr(pl, "read_parquet", unavailable_polars_reader)
    monkeypatch.setattr(pq, "read_table", tracked_arrow)
    actual = store.get_dataframe(did, columns=columns)
    assert actual.equals(frame.select(columns))
    assert actual.columns == columns
    assert calls == [columns]


@pytest.mark.parametrize("kind", ["current", "snapshot", "raw"])
def test_native_parquet_success_does_not_call_arrow_fallback(builtin_store, monkeypatch, kind):
    client, store = builtin_store
    did, expected, _ = import_builtin(client, store)
    monkeypatch.setattr(pq, "read_table", lambda *_a, **_k: pytest.fail("Unnecessary Arrow fallback"))
    assert artifact_reader(store, did, kind).equals(expected)


@pytest.mark.parametrize("kind,code,status", [
    ("current", "DATASET_NOT_FOUND", 404),
    ("snapshot", "PROVENANCE_SNAPSHOT_MISSING", 422),
    ("raw", "PROVENANCE_RAW_MISSING", 422),
])
def test_absent_artifact_keeps_existing_business_error_and_never_recreates_file(builtin_store, monkeypatch, kind, code, status):
    client, store = builtin_store
    did, _, _ = import_builtin(client, store)
    path = artifact_path(store, did, kind)
    path.unlink()  # Only this test's own disposable fixture file.
    before = file_bytes(store.root)
    monkeypatch.setattr(pl, "read_parquet", lambda *_a, **_k: pytest.fail("Absent file must be checked first"))
    monkeypatch.setattr(pq, "read_table", lambda *_a, **_k: pytest.fail("Absent file must not call fallback"))
    with pytest.raises(BizError) as exc:
        artifact_reader(store, did, kind)
    assert exc.value.code == code and exc.value.status_code == status
    assert not path.exists()
    assert file_bytes(store.root) == before


@pytest.mark.parametrize("kind,code", [("snapshot", "PROVENANCE_SNAPSHOT_MISSING"), ("raw", "PROVENANCE_RAW_MISSING")])
@pytest.mark.parametrize("failure", ["corrupt_parquet", "arrow_io"])
def test_both_history_readers_fail_with_full_business_wrapper_and_preserve_files(builtin_store, monkeypatch, kind, code, failure):
    client, store = builtin_store
    did, _, _ = import_builtin(client, store)
    path = artifact_path(store, did, kind)
    if failure == "corrupt_parquet":
        path.write_bytes(b"not a Parquet file; deliberately corrupt test artifact")
    before = file_bytes(store.root)
    native_arrow = pq.read_table
    calls = []
    def fail_or_read_arrow(source, *args, **kwargs):
        calls.append(Path(source))
        if failure == "arrow_io":
            raise OSError("forced Arrow read failure")
        return native_arrow(source, *args, **kwargs)
    monkeypatch.setattr(pl, "read_parquet", unavailable_polars_reader)
    monkeypatch.setattr(pq, "read_table", fail_or_read_arrow)
    with pytest.raises(BizError) as exc:
        artifact_reader(store, did, kind)
    assert exc.value.code == code and exc.value.status_code == 422
    assert exc.value.__cause__ is not None
    assert not isinstance(exc.value.__cause__, AttributeError)
    assert "new_from_parquet" not in exc.value.message
    if failure == "arrow_io":
        assert "forced Arrow read failure" in exc.value.message
    assert calls == [path]
    assert file_bytes(store.root) == before


def bin_iris(client, did):
    response = client.post(f"/api/v1/datasets/{did}/transform", json={"type": "binning",
        "source_column": "sepal_length_cm", "options": {"method": "equal_width", "num_bins": 4,
                                                        "output_column_name": "sepal_length_bin4"}})
    assert response.status_code == 200, response.text
    return response.json()


def test_builtin_iris_transform_undo_redo_revert_without_polars_parquet_reader(builtin_store, monkeypatch):
    client, store = builtin_store
    did, original, original_book = import_builtin(client, store)
    original_raw = store._raw_path(did).read_bytes()
    original_snapshot = store._snapshot_path(did, 1).read_bytes()
    monkeypatch.setattr(pl, "read_parquet", unavailable_polars_reader)
    bin_iris(client, did)
    transformed = store.get_dataframe(did)
    assert transformed.width == original.width + 1
    assert transformed.select(original.columns).equals(original)
    assert store.get_meta(did)["dataRevision"] == 2
    for operation, payload, expected, revision in (
        ("undo", {}, original, 3),
        ("redo", {}, transformed, 4),
        ("revert", {"targetDataRevision": 1}, original, 5),
    ):
        response = client.post(f"/api/v1/datasets/{did}/{operation}", json=payload)
        assert response.status_code == 200, response.text
        assert store.get_dataframe(did).equals(expected)
        assert store.get_meta(did)["dataRevision"] == revision
        assert store.get_meta(did)["columnCount"] == expected.width - 1
        book = store.load_codebook(did)
        assert book["licenseText"] == original_book["licenseText"]
        assert book["licenseRevision"] == original_book["licenseRevision"]
        assert [c["name"] for c in book["columns"]] == [name for name in expected.columns if name != "__rowId__"]
        assert store.read_raw(did).equals(original)
    assert store._raw_path(did).read_bytes() == original_raw
    assert store._snapshot_path(did, 1).read_bytes() == original_snapshot
    assert [step["operation"] for step in store.load_provenance(did)["operations"]] == ["import", "transform", "undo", "redo", "revert"]
    assert store.load_mask(did)["entries"] == []


@pytest.mark.parametrize("operation", ["undo", "redo", "revert"])
def test_failed_history_fallback_leaves_current_dataset_and_all_files_unchanged(builtin_store, monkeypatch, operation):
    client, store = builtin_store
    did, _, _ = import_builtin(client, store)
    bin_iris(client, did)
    target_revision = 1
    if operation == "redo":
        assert client.post(f"/api/v1/datasets/{did}/undo", json={}).status_code == 200
        target_revision = 2
    target = store._snapshot_path(did, target_revision)
    native_arrow = pq.read_table
    calls = []
    def failing_target(source, *args, **kwargs):
        calls.append(Path(source))
        if Path(source) == target:
            raise OSError("forced history Arrow read failure")
        return native_arrow(source, *args, **kwargs)
    before = file_bytes(store.root)
    monkeypatch.setattr(pl, "read_parquet", unavailable_polars_reader)
    monkeypatch.setattr(pq, "read_table", failing_target)
    payload = {"targetDataRevision": 1} if operation == "revert" else {}
    response = client.post(f"/api/v1/datasets/{did}/{operation}", json=payload)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "PROVENANCE_SNAPSHOT_MISSING"
    assert "forced history Arrow read failure" in error["message"]
    assert error["recoverable"] is True
    assert error["traceId"] and error["timestamp"]
    assert target in calls
    assert file_bytes(store.root) == before


@pytest.mark.parametrize("kind", ["current", "snapshot", "raw"])
def test_arrow_fallback_preserves_explicit_widths_and_all_null_types(builtin_store, monkeypatch, kind):
    _, store = builtin_store
    did = "typed-portable-read"
    expected = pl.DataFrame({
        "__rowId__": pl.Series(["001", "002", "003"], dtype=pl.String),
        "narrow_integer": pl.Series([1, None, 3], dtype=pl.Int32),
        "all_null_float": pl.Series([None, None, None], dtype=pl.Float32),
        "text": pl.Series(["a", None, "c"], dtype=pl.String),
        "flag": pl.Series([True, False, None], dtype=pl.Boolean),
    })
    path = artifact_path(store, did, kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    expected.write_parquet(path)
    before = path.read_bytes()
    monkeypatch.setattr(pl, "read_parquet", unavailable_polars_reader)
    actual = artifact_reader(store, did, kind)
    assert actual.schema == expected.schema
    assert actual.equals(expected)
    assert actual["all_null_float"].dtype == pl.Float32
    assert actual["all_null_float"].null_count() == 3
    assert path.read_bytes() == before


def test_empty_current_projection_matches_native_shape_and_keeps_file(builtin_store, monkeypatch):
    client, store = builtin_store
    did, _, _ = import_builtin(client, store)
    expected = store.get_dataframe(did, columns=[])
    assert expected.shape == (0, 0)
    before = file_bytes(store.root)
    monkeypatch.setattr(pl, "read_parquet", unavailable_polars_reader)
    actual = store.get_dataframe(did, columns=[])
    assert actual.schema == expected.schema
    assert actual.shape == expected.shape
    assert file_bytes(store.root) == before
