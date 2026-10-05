"""Portable Parquet reads must own values before serializing Arrow responses.

Native ABI alone does not reproduce the shipped WASM string-buffer panic.
The zero-row-only bridge guard therefore accompanies real API/IPC round-trips.
"""
from __future__ import annotations

import polars as pl
import pyarrow as pa
import pyarrow.ipc as ipc
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, exports
from app.config import settings
from app.main import app
from app.services.builtin_samples import catalog
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (datasets, exports):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        yield client, store


def force_owned_fallback(monkeypatch):
    def unavailable(*_args, **_kwargs):
        raise AttributeError("PyLazyFrame.new_from_parquet is unavailable in WASM")

    native_from_arrow = pl.from_arrow
    imported_rows = []

    def schema_only(table, *args, **kwargs):
        imported_rows.append(table.num_rows)
        assert table.num_rows == 0, "Nonempty Arrow buffers must not cross into the WASM Polars owner"
        return native_from_arrow(table, *args, **kwargs)

    monkeypatch.setattr(pl, "read_parquet", unavailable)
    monkeypatch.setattr(pl, "from_arrow", schema_only)
    return imported_rows


def import_sample(api, sample_id):
    client, store = api
    response = client.post("/api/v1/datasets/import/sample", json={"sampleId": sample_id})
    assert response.status_code == 200, response.text
    did = response.json()["datasetId"]
    return did, store.get_dataframe(did)


def all_files(root):
    return {str(path.relative_to(root)): path.read_bytes()
            for path in root.rglob("*") if path.is_file()}


def assert_ipc(response, expected):
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/vnd.apache.arrow.stream"
    actual = ipc.open_stream(pa.BufferReader(response.content)).read_all()
    # Decode independently with PyArrow, without sending result buffers through
    # pl.from_arrow (which is precisely the ownership boundary under test).
    assert actual.schema.equals(expected.to_arrow().schema, check_metadata=True)
    assert actual.column_names == expected.columns
    assert actual.num_rows == expected.height
    assert actual.to_pydict() == expected.to_dict(as_series=False)
    if "__rowId__" in expected.columns:
        assert actual["__rowId__"].to_pylist() == expected["__rowId__"].to_list()


SAMPLE_IDS = [spec["id"] for spec in catalog()]


@pytest.mark.parametrize("sample_id", SAMPLE_IDS)
def test_all_builtins_fallback_view_projection_and_arrow_export(api, monkeypatch, sample_id):
    assert len(SAMPLE_IDS) == 12
    client, store = api
    did, original = import_sample(api, sample_id)
    before = all_files(store.root)
    imported_rows = force_owned_fallback(monkeypatch)
    assert_ipc(client.post(f"/api/v1/datasets/{did}/view", json={}), original)

    selected_columns = [name for name in original.columns if name != "__rowId__"][:3][::-1]
    requested_columns = [*selected_columns, "__rowId__", selected_columns[0]]
    projection = ["__rowId__", *selected_columns]
    ids = original["__rowId__"].to_list()[::2][:8]
    expected = original.filter(pl.col("__rowId__").is_in(ids)).slice(1, 3).select(projection)
    assert_ipc(client.post(f"/api/v1/datasets/{did}/view", json={
        "columns": requested_columns, "rowIds": ids[::-1], "offset": 1, "limit": 3}), expected)
    assert_ipc(client.post(f"/api/v1/datasets/{did}/view", json={
        "columns": requested_columns, "rowIds": []}), original.select(projection).head(0))

    assert_ipc(client.post("/api/v1/exports", json={
        "datasetId": did, "format": "arrow", "scope": "all"}), original.drop("__rowId__"))
    assert_ipc(client.post("/api/v1/exports", json={
        "datasetId": did, "format": "arrow", "scope": "selected", "rowIds": ids[::-1]}),
        original.filter(pl.col("__rowId__").is_in(ids)).drop("__rowId__"))
    assert imported_rows and set(imported_rows) == {0}
    assert all_files(store.root) == before


def typed_frame():
    return pl.DataFrame({
        "display_id": pl.Series(["001", "002", "003"], dtype=pl.String),
        "narrow_integer": pl.Series([1, None, 3], dtype=pl.Int32),
        "all_null_float": pl.Series([None, None, None], dtype=pl.Float32),
        "text": pl.Series(["a", None, "長い文字列"], dtype=pl.String),
        "flag": pl.Series([True, False, None], dtype=pl.Boolean),
    })


def create_typed(api):
    _, store = api
    did = "typed-arrow-roundtrip"
    # Use the normal import finalizer to establish complete revision sidecars.
    datasets._finalize_dataset(did, "Typed portable fixture", "test", typed_frame(), None)
    return did, store.get_dataframe(did)


@pytest.mark.parametrize("kind", ["current", "snapshot", "raw"])
def test_typed_fallback_artifacts_are_safe_to_reserialize(api, monkeypatch, kind):
    _, store = api
    did, original = create_typed(api)
    before = all_files(store.root)
    imported_rows = force_owned_fallback(monkeypatch)
    reader = {"current": lambda: store.get_dataframe(did),
              "snapshot": lambda: store.read_snapshot(did, 1),
              "raw": lambda: store.read_raw(did)}[kind]
    actual = reader()
    assert actual.schema == original.schema
    assert actual.equals(original)
    # Exercise the same serializer used by /view and Arrow export.
    response = datasets.dataframe_to_arrow_response(actual)
    decoded = ipc.open_stream(pa.BufferReader(response.body)).read_all()
    assert decoded.schema.equals(original.to_arrow().schema, check_metadata=True)
    assert decoded.to_pydict() == original.to_dict(as_series=False)
    assert decoded["narrow_integer"].type == pa.int32()
    assert decoded["all_null_float"].type == pa.float32()
    assert decoded["all_null_float"].null_count == 3
    assert decoded["flag"].type == pa.bool_()
    assert imported_rows == [0]
    assert all_files(store.root) == before


@pytest.mark.parametrize("source", ["iris", "typed"])
def test_fallback_history_operations_keep_view_and_export_serializable(api, monkeypatch, source):
    client, store = api
    did, original = import_sample(api, "iris") if source == "iris" else create_typed(api)
    original_book = store.load_codebook(did)
    raw_bytes = store._raw_path(did).read_bytes()
    first_snapshot = store._snapshot_path(did, 1).read_bytes()
    imported_rows = force_owned_fallback(monkeypatch)

    def verify(expected):
        assert_ipc(client.post(f"/api/v1/datasets/{did}/view", json={}), expected)
        assert_ipc(client.post("/api/v1/exports", json={
            "datasetId": did, "format": "arrow", "scope": "all"}), expected.drop("__rowId__"))
        current = store.get_dataframe(did)
        assert current.equals(expected) and current.schema == expected.schema
        raw = store.read_raw(did)
        assert raw.equals(original) and raw.schema == original.schema
        assert store.load_codebook(did)["licenseText"] == original_book["licenseText"]

    verify(original)
    transformed = client.post(f"/api/v1/datasets/{did}/transform", json={
        "type": "binning", "source_column": "sepal_length_cm" if source == "iris" else "narrow_integer",
        "options": {"method": "equal_width", "num_bins": 2, "output_column_name": "test_bin"}})
    assert transformed.status_code == 200, transformed.text
    binned = store.get_dataframe(did)
    assert binned.select(original.columns).equals(original)
    verify(binned)
    for operation, payload, expected, revision in (
        ("undo", {}, original, 3), ("redo", {}, binned, 4),
        ("revert", {"targetDataRevision": 1}, original, 5),
    ):
        response = client.post(f"/api/v1/datasets/{did}/{operation}", json=payload)
        assert response.status_code == 200, response.text
        assert store.get_meta(did)["dataRevision"] == revision
        verify(expected)
    assert imported_rows and set(imported_rows) == {0}
    assert store._raw_path(did).read_bytes() == raw_bytes
    assert store._snapshot_path(did, 1).read_bytes() == first_snapshot
    assert [step["operation"] for step in store.load_provenance(did)["operations"]] == [
        "import", "transform", "undo", "redo", "revert"]


TEMPORAL_CASES = [
    ("timestamp_ns", pa.timestamp("ns"), [1728086400000000001, None, 1728086400000000123], 1),
    ("timestamp_tz", pa.timestamp("ns", tz="Asia/Tokyo"), [1728086400000000001, None, 1728086400000000123], 1),
    ("timestamp_s", pa.timestamp("s"), [1728086400, None, 1728086401], 1000),
    ("duration_ns", pa.duration("ns"), [1, None, -123], 1),
    ("duration_s", pa.duration("s"), [1, None, -123], 1000),
    ("time_ns", pa.time64("ns"), [1, None, 86399999999999], 1),
    ("time_s", pa.time32("s"), [1, None, 86399], 1_000_000_000),
    ("date32", pa.date32(), [20000, None, 20001], 1),
    ("date64", pa.date64(), [1728000000000, None, 1728086400000], 1),
]


@pytest.mark.parametrize("name,arrow_type,values,unit_factor", TEMPORAL_CASES,
                         ids=[case[0] for case in TEMPORAL_CASES])
def test_temporal_fallback_retains_native_units_and_exact_physical_integers(
        tmp_path, monkeypatch, name, arrow_type, values, unit_factor):
    table = pa.table({name: pa.array(values, type=arrow_type), "label": ["日本語", None, "Łódź"]})
    expected_arrow_import = pl.from_arrow(table)
    path = tmp_path / "temporal.parquet"
    pq.write_table(table, path)
    expected_parquet = pl.from_arrow(pq.read_table(path))
    before = path.read_bytes()
    imported_rows = force_owned_fallback(monkeypatch)

    # Real Parquet can normalize seconds or date64. Match the native Arrow
    # import's schema and integers for the exact table the fallback receives.
    # pl.read_parquet is not a safe oracle for externally written time32[s]:
    # its original-Arrow metadata handling can mis-scale or null those values.
    restored = DatasetStore._read_parquet(path)
    assert restored.schema == expected_parquet.schema
    assert restored[name].cast(pl.Int64).to_list() == expected_parquet[name].cast(pl.Int64).to_list()
    decoded = ipc.open_stream(datasets._serialize_dataframe_to_arrow_bytes(restored)).read_all()
    assert decoded.equals(expected_parquet.to_arrow(), check_metadata=True)

    # Also test the original nine Arrow top-level types at the bridge boundary;
    # this prevents Parquet normalization from hiding unsupported input units.
    def original_typed_table(source, columns=None):
        assert source == path and columns is None
        return table

    monkeypatch.setattr(pq, "read_table", original_typed_table)
    exact = DatasetStore._read_parquet(path)
    assert exact.schema == expected_arrow_import.schema
    physical = [None if value is None else value * unit_factor for value in values]
    assert exact[name].cast(pl.Int64).to_list() == physical
    assert exact["label"].to_list() == ["日本語", None, "Łódź"]
    decoded = ipc.open_stream(datasets._serialize_dataframe_to_arrow_bytes(exact)).read_all()
    assert decoded.equals(expected_arrow_import.to_arrow(), check_metadata=True)
    assert len(imported_rows) >= 2 and set(imported_rows) == {0}
    assert path.read_bytes() == before


@pytest.mark.parametrize("selection", ["filter", "slice", "empty"])
def test_filtered_string_binary_and_non_ascii_views_roundtrip(api, monkeypatch, selection):
    client, store = api
    did = "variable-width-arrow"
    frame = pl.DataFrame({
        "text": pl.Series(["first", "日本語", None, "Łódź", "", "last"], dtype=pl.String),
        "binary": pl.Series([b"first", b"\x00\xff", None, "Łódź".encode(), b"", b"last"], dtype=pl.Binary),
        "narrow": pl.Series([1, 2, None, 4, 5, 6], dtype=pl.Int32),
    })
    datasets._finalize_dataset(did, "Variable width fixture", "test", frame, None)
    original = store.get_dataframe(did)
    ids = original["__rowId__"].to_list()
    if selection == "filter":
        body = {"rowIds": [ids[4], ids[1], ids[3]]}
        expected = original.filter(pl.col("__rowId__").is_in(body["rowIds"]))
    elif selection == "slice":
        body = {"offset": 1, "limit": 4}
        expected = original.slice(1, 4)
    else:
        body = {"rowIds": []}
        expected = original.head(0)
    before = all_files(store.root)
    imported_rows = force_owned_fallback(monkeypatch)
    assert_ipc(client.post(f"/api/v1/datasets/{did}/view", json=body), expected)
    assert_ipc(client.post("/api/v1/exports", json={
        "datasetId": did, "format": "arrow", "scope": "selected",
        "rowIds": expected["__rowId__"].to_list()}), expected.drop("__rowId__"))
    assert imported_rows and set(imported_rows) == {0}
    assert all_files(store.root) == before


NESTED_TEMPORAL_CASES = [
    ("list_timestamp_ns", pa.list_(pa.timestamp("ns")), pa.list_(pa.int64()),
     [[1, None, -123], None, []], [[1, None, -123], None, []]),
    ("list_list_time", pa.list_(pa.list_(pa.time64("ns"))), pa.list_(pa.list_(pa.int64())),
     [[[1, None], None, []], None, []], [[[1, None], None, []], None, []]),
    ("fixed_duration", pa.list_(pa.duration("ns"), 2), pa.list_(pa.int64(), 2),
     [[1, None], None, [-123, 123]], [[1, None], None, [-123, 123]]),
    ("struct_timestamp", pa.struct([("ts", pa.timestamp("ns", "Asia/Tokyo")), ("str", pa.string())]),
     pa.struct([("ts", pa.int64()), ("str", pa.string())]),
     [{"ts": -1, "str": "日本語"}, None, {"ts": 123, "str": None}],
     [{"ts": -1, "str": "日本語"}, None, {"ts": 123, "str": None}]),
    ("list_struct_seconds", pa.list_(pa.struct([("ts", pa.timestamp("s")), ("str", pa.string())])),
     pa.list_(pa.struct([("ts", pa.int64()), ("str", pa.string())])),
     [[{"ts": -1, "str": "Łódź"}, None], None, [{"ts": 123, "str": None}]],
     [[{"ts": -1000, "str": "Łódź"}, None], None, [{"ts": 123000, "str": None}]]),
    ("struct_list", pa.struct([("ts", pa.list_(pa.timestamp("ns"))), ("str", pa.string())]),
     pa.struct([("ts", pa.list_(pa.int64())), ("str", pa.string())]),
     [{"ts": [-1, None], "str": "日本語"}, None, {"ts": [], "str": None}],
     [{"ts": [-1, None], "str": "日本語"}, None, {"ts": [], "str": None}]),
    ("large_list_timestamp", pa.large_list(pa.timestamp("ns")), pa.large_list(pa.int64()),
     [[1, None, -123], None, []], [[1, None, -123], None, []]),
    ("nested_date64", pa.list_(pa.date64()), pa.list_(pa.int64()),
     [[0, None, -86400000], None, []], [[0, None, -86400000], None, []]),
    ("date32_outside_python_years", pa.date32(), pa.int32(),
     [4_000_000, None, -4_000_000], [4_000_000, None, -4_000_000]),
]


@pytest.mark.parametrize("name,arrow_type,physical_type,values,physical_values", NESTED_TEMPORAL_CASES,
                         ids=[case[0] for case in NESTED_TEMPORAL_CASES])
def test_nested_temporal_copy_preserves_physical_values_and_container_validity(
        tmp_path, monkeypatch, name, arrow_type, physical_type, values, physical_values):
    table = pa.table({"value": pa.array(values, type=arrow_type), "text": ["日本語", None, "Łódź"]})
    expected = pl.from_arrow(table)
    path = tmp_path / f"{name}.parquet"
    pq.write_table(table, path)
    before = path.read_bytes()
    imported_rows = force_owned_fallback(monkeypatch)

    def exact_input(source, columns=None):
        assert source == path and columns is None
        return table

    # Pin the Arrow input at the ownership boundary so Parquet's normalization
    # of date64 and list metadata cannot erase the container type under test.
    monkeypatch.setattr(pq, "read_table", exact_input)
    actual = DatasetStore._read_parquet(path)
    assert actual.schema == expected.schema
    for indices in ([0, 1, 2], [2, 0], [], [1]):
        selected = actual[indices]
        decoded = ipc.open_stream(datasets._serialize_dataframe_to_arrow_bytes(selected)).read_all()
        assert decoded.equals(expected[indices].to_arrow(), check_metadata=True)
        # Only integer/string/list/struct values enter Python. Datetime objects
        # would round nanoseconds or reject the out-of-range Date32 values.
        assert decoded["value"].cast(physical_type).to_pylist() == [physical_values[index] for index in indices]
        assert decoded["text"].to_pylist() == [["日本語", None, "Łódź"][index] for index in indices]
    assert imported_rows and set(imported_rows) == {0}
    assert path.read_bytes() == before


def test_selected_parquet_export_fallback_uses_owned_arrow_table(api, monkeypatch):
    client, store = api
    did = "selected-parquet-fallback"
    frame = typed_frame().with_columns(pl.Series("binary", [b"\xff", None, b"\x00\x80"], dtype=pl.Binary))
    datasets._finalize_dataset(did, "Selected Parquet fixture", "test", frame, None)
    original = store.get_dataframe(did)
    ids = original["__rowId__"].to_list()
    requested_ids = [ids[2], ids[1]]
    expected = original.filter(pl.col("__rowId__").is_in(requested_ids)).drop("__rowId__")
    before = all_files(store.root)
    imported_rows = force_owned_fallback(monkeypatch)
    native_attempts, copied_frames = [], []
    owned_arrow_table = exports.dataframe_to_arrow_table

    def unavailable_writer(dataframe, *_args, **_kwargs):
        native_attempts.append(dataframe.clone())
        raise AttributeError("native Parquet writer is unavailable in WASM")

    def tracked_owned_arrow_table(dataframe):
        copied_frames.append(dataframe.clone())
        return owned_arrow_table(dataframe)

    monkeypatch.setattr(pl.DataFrame, "write_parquet", unavailable_writer)
    monkeypatch.setattr(exports, "dataframe_to_arrow_table", tracked_owned_arrow_table)
    response = client.post("/api/v1/exports", json={
        "datasetId": did, "format": "parquet", "scope": "selected", "rowIds": requested_ids})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/vnd.apache.parquet"
    assert len(native_attempts) == len(copied_frames) == 1
    assert native_attempts[0].equals(expected) and copied_frames[0].equals(expected)
    decoded = pq.read_table(pa.BufferReader(response.content))
    assert decoded.schema.equals(expected.to_arrow().schema, check_metadata=True)
    assert decoded.column_names == expected.columns
    assert decoded.to_pydict() == expected.to_dict(as_series=False)
    assert decoded["display_id"].to_pylist() == ["002", "003"]
    assert decoded["narrow_integer"].type == pa.int32()
    assert decoded["all_null_float"].type == pa.float32()
    assert decoded["all_null_float"].null_count == 2
    assert imported_rows and set(imported_rows) == {0}
    assert all_files(store.root) == before
