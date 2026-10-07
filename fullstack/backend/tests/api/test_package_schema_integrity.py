"""Native package schema restoration and prepublication identity regressions."""
from __future__ import annotations

import copy
import hashlib
import io
import json
import os
from pathlib import Path
import zipfile

import polars as pl
import pyarrow.ipc as ipc
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, multi_response, summaries
from app.config import settings
from app.main import app
from app.services.import_service import probe_table
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (datasets, multi_response, summaries):
        monkeypatch.setattr(module, "store", store)
    summaries._cache.clear()
    with TestClient(app) as client:
        yield client, store
    summaries._cache.clear()


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def upload(api, frame):
    client, _ = api
    buffer = io.BytesIO()
    frame.write_parquet(buffer)
    return ok(client.post("/api/v1/datasets/import", files={
        "file": ("typed-package.parquet", buffer.getvalue(), "application/octet-stream")
    }))["datasetId"]


def export_package(client, did):
    response = client.get(f"/api/v1/datasets/{did}/export_package")
    assert response.status_code == 200, response.text
    return response.content


def import_package(client, payload):
    return client.post("/api/v1/datasets/import_package", files={
        "file": ("package.zip", payload, "application/zip")})


def unpack(payload):
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}


def pack(files, *, refresh_manifest=True):
    files = dict(files)
    if refresh_manifest:
        manifest = json.loads(files["manifest.json"])
        manifest["files"] = [{"path": name, "bytes": len(value),
                              "sha256": hashlib.sha256(value).hexdigest()}
                             for name, value in files.items() if name != "manifest.json"]
        files["manifest.json"] = json.dumps(manifest).encode()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in files.items():
            archive.writestr(name, value)
    return buffer.getvalue()


def change_book(payload, change):
    files = unpack(payload)
    book = json.loads(files["metadata/codebook.json"])
    change(book)
    files["metadata/codebook.json"] = json.dumps(book, ensure_ascii=False).encode()
    return pack(files)


def file_state(store):
    return {str(path.relative_to(store.root)): (
        "directory" if path.is_dir() else hashlib.sha256(path.read_bytes()).hexdigest())
        for path in sorted(store.root.rglob("*"))}


def assert_same_frame(actual, expected):
    assert actual.schema == expected.schema
    assert actual.equals(expected)
    left, right = actual.to_arrow(), expected.to_arrow()
    assert left.schema == right.schema
    assert left.equals(right)
    for name in left.column_names:
        assert left[name].is_null().to_pylist() == right[name].is_null().to_pylist()


def track_package_readers(monkeypatch, mode):
    """Model the deployed missing capability; use real readers/conversion."""
    native_polars = pl.read_parquet
    native_arrow = pq.read_table
    native_from_arrow = pl.from_arrow
    calls = {"polars": [], "arrow": [], "schema_rows": []}

    def polars_reader(source, *args, **kwargs):
        if isinstance(source, io.BytesIO):
            calls["polars"].append(source.getvalue())
        if mode == "fallback":
            if isinstance(source, io.BytesIO):
                source.read(17)  # A failed native read may already consume bytes.
            raise AttributeError("type object 'builtins.PyLazyFrame' has no attribute 'new_from_parquet'")
        return native_polars(source, *args, **kwargs)

    def arrow_reader(source, *args, **kwargs):
        assert mode == "fallback", "Successful native reads must not need Arrow"
        if isinstance(source, io.BytesIO):
            assert source.tell() == 0, "Fallback must rewind a partially consumed member"
            calls["arrow"].append(source.getvalue())
        return native_arrow(source, *args, **kwargs)

    def schema_only(table, *args, **kwargs):
        calls["schema_rows"].append(table.num_rows)
        assert table.num_rows == 0, "Nonempty Arrow buffers must not cross into WASM Polars"
        return native_from_arrow(table, *args, **kwargs)

    monkeypatch.setattr(pl, "read_parquet", polars_reader)
    monkeypatch.setattr(pq, "read_table", arrow_reader)
    if mode == "fallback":
        monkeypatch.setattr(pl, "from_arrow", schema_only)
    return calls


def assert_package_reader_calls(calls, payload, mode):
    files = unpack(payload)
    members = [files["data/current.parquet"], files["data/raw.parquet"]]
    assert calls["polars"] == members
    assert calls["arrow"] == (members if mode == "fallback" else [])
    if mode == "fallback":
        assert calls["schema_rows"] and set(calls["schema_rows"]) == {0}


def actual_response(client, did):
    response = client.post(f"/api/v1/datasets/{did}/view", json={})
    assert response.status_code == 200, response.text
    return {
        "meta": ok(client.get(f"/api/v1/datasets/{did}")),
        "codebook": ok(client.get(f"/api/v1/datasets/{did}/codebook")),
        "data": ipc.open_stream(response.content).read_all().to_pydict(),
    }


def evidence(name, content):
    target = os.environ.get("INT08_EVIDENCE_DIR")
    if target:
        path = Path(target)
        path.mkdir(parents=True, exist_ok=True)
        (path / name).write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n")


def evidence_bytes(name, content):
    target = os.environ.get("INT08_EVIDENCE_DIR")
    if target:
        path = Path(target)
        path.mkdir(parents=True, exist_ok=True)
        (path / name).write_bytes(content)


def assert_published_schema(client, store, did):
    meta = ok(client.get(f"/api/v1/datasets/{did}"))
    listing = ok(client.get("/api/v1/datasets"))["datasets"]
    listed = next(item for item in listing if item["datasetId"] == did)
    disk = json.loads(store._meta_path(did).read_text())
    revision = store.read_revision_state(did, meta["dataRevision"])
    assert disk["schema"] == revision["schema"]
    for field in ("datasetId", "name", "rowCount", "columnCount", "fingerprint", "createdAt"):
        assert listed[field] == disk[field]
    book = store.load_codebook(did)
    assert revision["schemaRevision"] == meta["schemaRevision"] == book["schemaRevision"]
    assert store.read_revision_codebook(did, meta["dataRevision"]) == book
    by_name = {column["name"]: column for column in book["columns"]}
    # GET intentionally presents codebook meaning over stored physical schema.
    # Validate each existing representation without changing that API contract.
    assert meta["schema"] == [{**column, **by_name[column["name"]]} for column in disk["schema"]]
    required = {"name", "columnId", "semanticType", "physicalType", "role",
                "missingCount", "uniqueCount", "min", "max", "categories",
                "constant", "uniqueIdCandidate", "categoryOrder", "manualCategories"}
    for representation in (disk["schema"], meta["schema"]):
        for column in representation:
            assert required <= column.keys()
            assert column["columnId"] == by_name[column["name"]]["columnId"]
    return disk


@pytest.mark.parametrize("reader_mode", ["native", "fallback"])
def test_native_package_reconstructs_complete_schema_without_changing_typed_data(api, monkeypatch, reader_mode):
    client, store = api
    frame = pl.DataFrame({
        "q1": pl.Series([1, None, 3, 4, 5], dtype=pl.Int16),
        "q2": pl.Series([.125, 2.25, None, 4.5, 5.75], dtype=pl.Float32),
        "group": ["001", "002", None, "001", "003"],
        "flag": [True, False, None, True, False],
        "ordinal": pl.Series([1, 2, 1, None, 3], dtype=pl.Int8),
        "blank": pl.Series([None] * 5, dtype=pl.Float64),
        "constant": pl.Series([7, 7, None, 7, 7], dtype=pl.UInt32),
        "id": ["r1", "r2", "r3", "r4", "r5"],
    })
    did = upload(api, frame)
    ok(client.put(f"/api/v1/datasets/{did}/codebook", json={
        "columns": [
            {"name": "q1", "role": "question", "label": "Edited numeric label", "missingCodes": ["99"]},
            {"name": "q2", "role": "weight", "scaleType": "ratio"},
            {"name": "group", "label": "Leading-zero codes", "categoryOrder": ["003", "002", "001"],
             "valueLabels": {"001": "First", "003": "Last"}, "missingCodes": ["999"],
             "missingReasons": {"999": "no answer"}},
            {"name": "ordinal", "role": "question", "scaleType": "ordinal",
             "categoryOrder": ["3", "1", "2"], "isReversed": True},
            {"name": "id", "role": "id", "scaleType": "id"},
        ], "licenseText": "Package fixture license"}))
    ok(client.post(f"/api/v1/datasets/{did}/impute", json={
        "columns": ["q1"], "strategy": "mean", "inPlace": True}))
    before = actual_response(client, did)
    current, raw = store.get_dataframe(did), store.read_raw(did)
    assert raw["q1"].null_count() == 1 and current["q1"].null_count() == 0
    payload = export_package(client, did)
    evidence_bytes("mixed-native-export.zip", payload)
    before_files = file_state(store)
    reader_calls = track_package_readers(monkeypatch, reader_mode)
    imported = ok(import_package(client, payload))
    restored_id = imported["datasetId"]
    assert restored_id != did
    meta = assert_published_schema(client, store, restored_id)
    assert_same_frame(store.get_dataframe(restored_id), current)
    assert_same_frame(store.read_raw(restored_id), raw)
    assert_same_frame(store.read_snapshot(restored_id, 1), current)
    encoded_book = json.loads(unpack(payload)["metadata/codebook.json"])
    expected_book = {**encoded_book, "datasetId": restored_id}
    assert store.load_codebook(restored_id) == expected_book
    canonical = [item.model_dump(mode="json") for item in probe_table(current.drop("__rowId__"), current.height)]
    ids = {c["name"]: c["columnId"] for c in encoded_book["columns"]}
    for column in canonical:
        column["columnId"] = ids[column["name"]]
    assert meta["schema"] == canonical
    schemas = {c["name"]: c for c in meta["schema"]}
    assert schemas["ordinal"]["semanticType"] == "numeric"
    assert schemas["ordinal"]["role"] == schemas["q1"]["role"] == "numeric_axis"
    assert schemas["q2"]["missingCount"] == 1 and schemas["q2"]["min"] == .125
    assert schemas["blank"]["missingCount"] == 5 and schemas["blank"]["semanticType"] == "ignored"
    assert schemas["constant"]["constant"] is True
    assert schemas["id"]["uniqueIdCandidate"] is True
    # Canonical Boolean metadata currently says string/categorical; its actual
    # Parquet/Arrow Boolean type is independently asserted above and stays intact.
    assert store.get_dataframe(restored_id)["flag"].dtype == pl.Boolean
    assert meta["sourceDatasetId"] == did and meta["rowIdentity"] == "preserved"
    assert meta["dataRevision"] == 1
    assert imported["sessionState"]["datasetId"] == restored_id
    assert imported["sessionState"]["sourceDatasetId"] == did
    source_history = store.load_provenance(did)
    history = store.load_provenance(restored_id)
    assert history["readOnlyHistory"] == source_history["operations"]
    assert len(history["operations"]) == 1 and history["rawDataRevision"] is None
    assert store.load_mask(restored_id)["entries"] == store.load_mask(did)["entries"]
    after_files = file_state(store)
    assert all(after_files[name] == digest for name, digest in before_files.items())
    rejected_undo = client.post(f"/api/v1/datasets/{restored_id}/undo", json={})
    assert rejected_undo.status_code == 409
    assert file_state(store) == after_files
    evidence("mixed-roundtrip.json", {"before": before, "restored": actual_response(client, restored_id)})
    assert_package_reader_calls(reader_calls, payload, reader_mode)


def make_binned(api):
    client, _ = api
    did = upload(api, pl.DataFrame({
        "x": [1.001, 1.002, 1.003, 1.004, None],
        "ordinal": pl.Series([1, 2, 3, 4, None], dtype=pl.Int32),
        "id": ["a", "b", "c", "d", "e"],
    }))
    ok(client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [{
        "name": "ordinal", "scaleType": "ordinal", "role": "question",
        "categoryOrder": ["4", "3", "2", "1"]}]}))
    result = ok(client.post(f"/api/v1/datasets/{did}/transform", json={
        "type": "binning", "source_column": "x",
        "options": {"num_bins": 4, "output_column_name": "exact_bin", "labels_format": "range"}}))
    assert result["createdColumns"] == ["exact_bin"]
    ok(client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [{
        "name": "exact_bin", "label": "Edited intervals", "categoryOrder": ["4", "2", "3", "1"],
        "valueLabels": {"1": "Low", "4": "High"}}]}))
    return did, export_package(client, did)


@pytest.mark.parametrize("reader_mode", ["native", "fallback"])
def test_generated_bins_restore_encoded_current_category_meaning_beside_numeric_ordinal(api, monkeypatch, reader_mode):
    client, store = api
    did, payload = make_binned(api)
    evidence_bytes("bins-native-export.zip", payload)
    before = actual_response(client, did)
    reader_calls = track_package_readers(monkeypatch, reader_mode)
    restored_id = ok(import_package(client, payload))["datasetId"]
    meta = assert_published_schema(client, store, restored_id)
    schemas = {c["name"]: c for c in meta["schema"]}
    binned = schemas["exact_bin"]
    assert binned["physicalType"] == "int" and binned["semanticType"] == "categorical"
    assert binned["role"] == "categorical_axis" and binned["categoryOrder"] == "manual"
    assert binned["manualCategories"] == binned["categories"] == ["4", "2", "3", "1"]
    assert binned["missingCount"] == 1 and binned["uniqueCount"] == 4
    assert schemas["ordinal"]["semanticType"] == "numeric"
    assert_same_frame(store.get_dataframe(restored_id), store.get_dataframe(did))
    assert_same_frame(store.read_raw(restored_id), store.read_raw(did))
    assert store.load_codebook(restored_id) == {**store.load_codebook(did), "datasetId": restored_id}
    evidence("bins-roundtrip.json", {"before": before, "restored": actual_response(client, restored_id)})
    assert_package_reader_calls(reader_calls, payload, reader_mode)


def test_explicit_current_scale_edit_keeps_history_without_restoring_bin_semantics(api):
    client, store = api
    did, _ = make_binned(api)
    definitions = next(c for c in store.load_codebook(did)["columns"]
                       if c["name"] == "exact_bin")["binDefinitions"]
    ok(client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [{
        "name": "exact_bin", "scaleType": "ratio", "label": "Now a quantitative variable"}]}))
    encoded = store.load_codebook(did)
    assert next(c for c in encoded["columns"] if c["name"] == "exact_bin")["binDefinitions"] == definitions
    restored_id = ok(import_package(client, export_package(client, did)))["datasetId"]
    physical = assert_published_schema(client, store, restored_id)
    assert next(c for c in physical["schema"] if c["name"] == "exact_bin")["semanticType"] == "numeric"
    assert store.load_codebook(restored_id) == {**encoded, "datasetId": restored_id}


@pytest.mark.parametrize("changed", [
    {"scaleType": "ratio"}, {"scaleType": "nominal"},
    {"categoryOrder": ["1", "2"]}, {"categoryOrder": ["1", "2", "3", "3"]},
    {"categoryOrder": ["1", "2", "3", "5"]}, {"categoryOrder": []},
    {"binDefinitions": []}, {"binDefinitions": None}, {"binDefinitions": "historical"},
    {"binDefinitions": [{"binId": 1, "min": 2, "max": 1,
                         "lowerInclusive": True, "upperInclusive": True}]},
])
def test_historical_bin_metadata_does_not_override_changed_or_invalid_current_meaning(api, changed):
    client, store = api
    _, payload = make_binned(api)
    modified = change_book(payload, lambda book: next(
        c for c in book["columns"] if c["name"] == "exact_bin").update(changed))
    encoded = json.loads(unpack(modified)["metadata/codebook.json"])
    restored_id = ok(import_package(client, modified))["datasetId"]
    meta = assert_published_schema(client, store, restored_id)
    column = next(c for c in meta["schema"] if c["name"] == "exact_bin")
    assert column["semanticType"] == "numeric" and column["role"] == "numeric_axis"
    assert store.load_codebook(restored_id) == {**encoded, "datasetId": restored_id}


@pytest.mark.parametrize("values,dtype", [([1, 2, 3, 9, None], pl.Int32),
                                          ([1, 2, 3, 4, None], pl.Float64)])
def test_historical_bin_definitions_require_compatible_current_integer_values(api, values, dtype):
    client, store = api
    _, payload = make_binned(api)
    files = unpack(payload)
    frame = pl.read_parquet(io.BytesIO(files["data/current.parquet"]))
    frame = frame.with_columns(pl.Series("exact_bin", values, dtype=dtype))
    buffer = io.BytesIO()
    frame.write_parquet(buffer)
    files["data/current.parquet"] = buffer.getvalue()
    restored_id = ok(import_package(client, pack(files)))["datasetId"]
    meta = assert_published_schema(client, store, restored_id)
    assert next(c for c in meta["schema"] if c["name"] == "exact_bin")["semanticType"] == "numeric"
    assert_same_frame(store.get_dataframe(restored_id), frame)


def test_package_binds_custom_column_ids_without_merging_codebook_roles(api):
    client, store = api
    did = upload(api, pl.DataFrame({"q": [1, None, 3], "id": ["a", "b", "c"]}))
    def custom_ids(book):
        for c in book["columns"]:
            c["columnId"] = "custom-" + c["name"]
            c["role"] = "question" if c["name"] == "q" else "id"
    payload = change_book(export_package(client, did), custom_ids)
    evidence_bytes("custom-ids-import.zip", payload)
    restored_id = ok(import_package(client, payload))["datasetId"]
    meta = assert_published_schema(client, store, restored_id)
    assert [c["columnId"] for c in meta["schema"]] == ["custom-q", "custom-id"]
    assert [c["role"] for c in meta["schema"]] == ["numeric_axis", "categorical_axis"]
    assert store.load_codebook(restored_id) == {
        **json.loads(unpack(payload)["metadata/codebook.json"]), "datasetId": restored_id}
    evidence("custom-ids.json", {"restored": actual_response(client, restored_id)})


@pytest.mark.parametrize("kind", ["duplicate_name", "duplicate_id", "missing_name", "missing_id",
    "empty_name", "empty_id", "blank_name", "blank_id", "nonstring_name", "nonstring_id",
    "extra_name", "missing_column", "nonobject_column", "null_columns", "object_columns"])
@pytest.mark.parametrize("reader_mode", ["native", "fallback"])
def test_malformed_package_column_identity_rejects_before_any_publication(api, monkeypatch, kind, reader_mode):
    client, store = api
    did = upload(api, pl.DataFrame({"q": [1, 2], "id": ["a", "b"]}))
    def corrupt(book):
        cols = book["columns"]
        if kind == "duplicate_name":
            cols.append({**cols[0], "columnId": "another-id"})
        elif kind == "duplicate_id":
            cols[1]["columnId"] = cols[0]["columnId"]
        elif kind.startswith("missing_") and kind != "missing_column":
            cols[0].pop("name" if kind.endswith("name") else "columnId")
        elif kind.startswith(("empty_", "blank_", "nonstring_")):
            cols[0]["name" if kind.endswith("name") else "columnId"] = (
                "" if kind.startswith("empty_") else " \t" if kind.startswith("blank_") else 42)
        elif kind == "extra_name":
            cols.append({"name": "extra", "columnId": "extra-id"})
        elif kind == "missing_column":
            cols.pop()
        elif kind == "nonobject_column":
            cols.append("not-an-object")
        elif kind == "null_columns":
            book["columns"] = None
        elif kind == "object_columns":
            book["columns"] = {"q": cols[0]}
    payload = change_book(export_package(client, did), corrupt)
    before = file_state(store)
    reader_calls = track_package_readers(monkeypatch, reader_mode)
    response = import_package(client, payload)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "PROVENANCE_PACKAGE_INVALID"
    assert file_state(store) == before
    assert_package_reader_calls(reader_calls, payload, reader_mode)


@pytest.mark.parametrize("kind", ["checksum", "version", "unlisted", "duplicate_manifest", "path", "row_id"])
@pytest.mark.parametrize("reader_mode", ["native", "fallback"])
def test_existing_package_guards_still_reject_without_writes(api, monkeypatch, kind, reader_mode):
    client, store = api
    did = upload(api, pl.DataFrame({"q": [1, 2], "id": ["a", "b"]}))
    files = unpack(export_package(client, did))
    manifest = json.loads(files["manifest.json"])
    refresh = False
    if kind == "checksum":
        files["data/raw.csv"] += b"extra,record\n"
    elif kind == "version":
        manifest["packageVersion"] = "unsupported"
    elif kind == "unlisted":
        files["unlisted.txt"] = b"extra"
    elif kind == "duplicate_manifest":
        manifest["files"].append(copy.deepcopy(manifest["files"][0]))
    elif kind == "path":
        files["../escape.txt"] = b"extra"
        refresh = True
    elif kind == "row_id":
        frame = pl.read_parquet(io.BytesIO(files["data/current.parquet"]))
        frame = frame.with_columns(pl.Series("__rowId__", ["same", "same"]))
        buffer = io.BytesIO()
        frame.write_parquet(buffer)
        files["data/current.parquet"] = buffer.getvalue()
        refresh = True
    files["manifest.json"] = json.dumps(manifest).encode()
    before = file_state(store)
    reader_calls = track_package_readers(monkeypatch, reader_mode)
    payload = pack(files, refresh_manifest=refresh)
    response = import_package(client, payload)
    assert response.status_code == 422, response.text
    assert file_state(store) == before
    if kind == "row_id":
        assert_package_reader_calls(reader_calls, payload, reader_mode)
    else:
        assert reader_calls == {"polars": [], "arrow": [], "schema_rows": []}


@pytest.mark.parametrize("member", ["data/current.parquet", "data/raw.parquet"])
@pytest.mark.parametrize("failure", ["malformed_parquet", "arrow_io"])
def test_package_member_fallback_failure_rejects_before_publication(api, monkeypatch, member, failure):
    client, store = api
    did = upload(api, pl.DataFrame({"q": [1, None, 3], "id": ["a", "b", "c"]}))
    ok(client.post(f"/api/v1/datasets/{did}/impute", json={
        "columns": ["q"], "strategy": "mean", "inPlace": True}))
    files = unpack(export_package(client, did))
    assert files["data/current.parquet"] != files["data/raw.parquet"]
    if failure == "malformed_parquet":
        files[member] = b"not a Parquet file; intentionally malformed synthetic payload"
    payload = pack(files)  # Valid checksums let the actual member reader decide.
    before = file_state(store)
    calls = track_package_readers(monkeypatch, "fallback")
    tracked_arrow = pq.read_table

    def failing_arrow(source, *args, **kwargs):
        if failure == "arrow_io" and isinstance(source, io.BytesIO) and source.getvalue() == files[member]:
            assert source.tell() == 0
            calls["arrow"].append(source.getvalue())
            raise OSError("forced package Arrow I/O failure")
        return tracked_arrow(source, *args, **kwargs)

    def forbid_publication(*_args, **_kwargs):
        pytest.fail("Unreadable package members must be rejected before publication")

    monkeypatch.setattr(pq, "read_table", failing_arrow)
    monkeypatch.setattr(store, "commit_data_change", forbid_publication)
    response = import_package(client, payload)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "PROVENANCE_PACKAGE_INVALID"
    assert "new_from_parquet" not in response.json()["error"]["message"]
    if failure == "arrow_io":
        assert "forced package Arrow I/O failure" in response.json()["error"]["message"]
    attempted = [files["data/current.parquet"]]
    if member == "data/raw.parquet":
        attempted.append(files[member])
    assert calls["polars"] == calls["arrow"] == attempted
    assert file_state(store) == before
