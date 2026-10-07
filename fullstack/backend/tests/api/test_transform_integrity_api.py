"""Real API/storage regressions for the final INT-04/05/06/07 findings."""
from __future__ import annotations

import io
import json
import math
from pathlib import Path

import polars as pl
import pyarrow as pa
import pyarrow.ipc as ipc
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from app.api import datasets, multi_response, summaries
from app.config import settings
from app.main import app
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


def upload(api, payload, name="fixture.csv"):
    client, store = api
    result = ok(client.post("/api/v1/datasets/import", files={"file": (name, payload)}))
    did = result["datasetId"]
    return did, store.get_dataframe(did)


def apply(api, did, kind, column="q", **options):
    client, _ = api
    return ok(client.post(f"/api/v1/datasets/{did}/transform", json={
        "type": kind, "source_column": column, "options": options}))


def all_files(store):
    return {str(path.relative_to(store.root)): path.read_bytes()
            for path in store.root.rglob("*") if path.is_file()}


def unchanged_source(actual, original):
    assert actual.select(original.columns).schema == original.schema
    assert actual.select(original.columns).equals(original)


def test_int04_missing_codes_share_preview_apply_eligibility_but_calculation_keeps_raw_codes(api):
    client, store = api
    did, original = upload(api, b"q,id\n1,a\n2,b\n99,c\n")
    source_book = store.load_codebook(did)
    source_ids = {item["name"]: item["columnId"] for item in source_book["columns"]}
    ok(client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [
        {"name": "q", "missingCodes": ["99"]}]}))
    files_before_preview = all_files(store)
    preview = ok(client.post(f"/api/v1/datasets/{did}/transform/preview", json={"column": "q", "num_bins": 2}))
    assert all_files(store) == files_before_preview
    assert preview["count"] == 2
    assert preview["edges"] == [1., 1.5, 2.]
    first = apply(api, did, "nominal_to_binary")
    assert first["createdColumns"] == ["q_1", "q_2"]
    current = store.get_dataframe(did)
    assert current["q_1"].to_list() == [1, 0, None]
    assert current["q_2"].to_list() == [0, 1, None]
    binned = apply(api, did, "binning", num_bins=2)
    assert binned["binSummaries"] == preview["bins"]
    assert store.get_dataframe(did)[binned["createdColumns"][0]].to_list() == [1, 2, None]
    meta = store.get_meta(did)
    ok(client.post(f"/api/v1/datasets/{did}/calculate", json={
        "expression": "q * 2", "columnName": "raw_double", "mode": "create",
        "expectedDataRevision": meta["dataRevision"], "expectedSchemaRevision": meta["schemaRevision"]}))
    assert store.get_dataframe(did)["raw_double"].to_list() == [2, 4, 198]
    unchanged_source(store.get_dataframe(did), original)
    assert {c["name"]: c["columnId"] for c in store.load_codebook(did)["columns"] if c["name"] in source_ids} == source_ids


@pytest.mark.parametrize("operation", ["nominal_to_binary", "binning"])
def test_missing_only_controls_and_undo_keep_original_schema_dtypes_and_ids(api, operation):
    client, store = api
    did, original = upload(api, b"q,id\n1,a\n2,b\n7,c\n8,d\n99,e\n,f\n")
    ok(client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [{
        "name": "q", "scaleType": "ordinal", "categoryOrder": ["1", "2", "99"],
        "isReversed": True, "missingCodes": ["99"], "missingReasons": {"7": "skip"}}]}))
    before_meta = store.get_meta(did)
    before_book = store.load_codebook(did)
    raw_before = store._raw_path(did).read_bytes()
    result = apply(api, did, operation, num_bins=2)
    current = store.get_dataframe(did)
    if operation == "nominal_to_binary":
        assert result["createdColumns"] == ["q_1", "q_2", "q_7", "q_8"]
        assert current["q_7"].to_list() == [0, 0, 1, 0, None, None]
    else:
        assert current[result["createdColumns"][0]].to_list() == [1, 1, 2, 2, None, None]
        assert [item["min"] for item in result["binSummaries"]] == [1., 4.5]
    unchanged_source(current, original)
    ok(client.post(f"/api/v1/datasets/{did}/undo", json={}))
    assert store.get_dataframe(did).equals(original)
    assert store.get_dataframe(did).schema == original.schema
    assert store.get_meta(did)["schema"] == before_meta["schema"]
    assert store.load_codebook(did)["columns"] == before_book["columns"]
    assert store._raw_path(did).read_bytes() == raw_before


def test_int06_api_null_indicator_uses_collision_free_destination_and_repeat_is_append_only(api):
    client, store = api
    did, original = upload(api, b"q,q_null\na,100\n,200\nb,300\n")
    first = apply(api, did, "nominal_to_binary", handle_null="as_category")
    assert first["createdColumns"] == ["q_a", "q_b", "q_null_1"]
    first_frame = store.get_dataframe(did)
    assert first_frame["q_null_1"].to_list() == [0, 1, 0]
    assert first_frame["q_null"].to_list() == [100, 200, 300]
    unchanged_source(first_frame, original)
    second = apply(api, did, "nominal_to_binary", handle_null="as_category")
    assert second["createdColumns"] == ["q_a_1", "q_b_1", "q_null_2"]
    unchanged_source(store.get_dataframe(did), first_frame)
    ok(client.post(f"/api/v1/datasets/{did}/undo", json={}))
    assert store.get_dataframe(did).equals(first_frame)
    ok(client.post(f"/api/v1/datasets/{did}/undo", json={}))
    assert store.get_dataframe(did).equals(original)


def test_int07_true_boolean_parquet_preserves_typed_equality_and_arrow_validity(api):
    client, store = api
    buffer = io.BytesIO()
    pq.write_table(pa.table({"q": pa.array([True, False, None], type=pa.bool_()),
                            "id": ["b", "a", "c"]}), buffer)
    did, original = upload(api, buffer.getvalue(), "boolean.parquet")
    assert original["q"].dtype == pl.Boolean
    result = apply(api, did, "nominal_to_binary")
    assert result["createdColumns"] == ["q_False", "q_True"]
    response = client.post(f"/api/v1/datasets/{did}/view", json={})
    assert response.status_code == 200, response.text
    arrow = ipc.open_stream(response.content).read_all()
    assert arrow["q_True"].to_pylist() == [1, 0, None]
    assert arrow["q_False"].to_pylist() == [0, 1, None]
    assert arrow["q_True"].type == arrow["q_False"].type == pa.int32()
    assert arrow["q_True"].null_count == arrow["q_False"].null_count == 1
    unchanged_source(store.get_dataframe(did), original)


def test_int05_exact_bin_metadata_roundtrips_and_selects_each_bin_independently(api):
    client, store = api
    did, original = upload(api, b"x,id\n1.001,a\n1.002,b\n1.003,c\n1.004,d\n")
    raw_before = store._raw_path(did).read_bytes()
    original_schema = store.get_meta(did)["schema"]
    original_book = store.load_codebook(did)
    preview = ok(client.post(f"/api/v1/datasets/{did}/transform/preview", json={"column": "x", "num_bins": 4}))
    result = apply(api, did, "binning", column="x", num_bins=4)
    name = result["createdColumns"][0]
    assert result["binSummaries"] == preview["bins"]
    binned = store.get_dataframe(did)
    assert binned[name].to_list() == [1, 2, 3, 4]
    assert binned[name].dtype == pl.Int32
    schema = next(c for c in result["schema"] if c["name"] == name)
    assert schema["physicalType"] == "int"
    assert schema["semanticType"] == "categorical"
    assert schema["role"] == "categorical_axis"
    assert schema["categoryOrder"] == "manual"
    assert schema["manualCategories"] == ["1", "2", "3", "4"]
    book = store.load_codebook(did)
    spec = next(c for c in book["columns"] if c["name"] == name)
    assert spec["columnId"] == schema["columnId"]
    assert spec["scaleType"] == "ordinal"
    assert spec["categoryOrder"] == ["1", "2", "3", "4"]
    assert set(spec["valueLabels"]) == {"1", "2", "3", "4"}
    assert len(set(spec["valueLabels"].values())) < 4
    expected_edges = [1.001, 1.00175, 1.0025, 1.00325, 1.004]
    definitions = spec["binDefinitions"]
    assert [d["binId"] for d in definitions] == [1, 2, 3, 4]
    assert [d["min"] for d in definitions] + [definitions[-1]["max"]] == pytest.approx(expected_edges, abs=1e-15)
    assert [d["lowerInclusive"] for d in definitions] == [True] * 4
    assert [d["upperInclusive"] for d in definitions] == [False, False, False, True]
    response = ok(client.post("/api/v1/summaries", json={
        "datasetId": did, "columns": [name], "expectedDataRevision": result["dataRevision"],
        "expectedSchemaRevision": result["schemaRevision"]}))
    distribution = response["columns"][name]["distribution"]
    assert [(d["code"], d["count"]) for d in distribution] == [("1", 1), ("2", 1), ("3", 1), ("4", 1)]
    for i in range(4):
        matched = ok(client.post(f"/api/v1/datasets/{did}/column-matches", json={
            "columnId": spec["columnId"], "code": str(i + 1),
            "expectedDataRevision": result["dataRevision"], "expectedSchemaRevision": result["schemaRevision"]}))
        assert matched["rowIds"] == [original["__rowId__"][i]]
        assert matched["count"] == 1
    # A partial API patch omits the new interval field and preserves it.
    updated_labels = {**spec["valueLabels"], "1": "First interval"}
    ok(client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [
        {"name": name, "label": "Exact intervals", "valueLabels": updated_labels}]}))
    # The real editor submits complete column objects. Interval metadata is
    # historical and does not restrict later display-label or domain edits.
    editor_spec = next(c for c in store.load_codebook(did)["columns"] if c["name"] == name)
    updated_labels = {"1": "First interval", "3": "Third interval"}
    editor_spec.update(categoryOrder=["4", "3", "2", "1"], valueLabels=updated_labels)
    ok(client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [editor_spec]}))
    exported = client.get(f"/api/v1/datasets/{did}/codebook/export?format=json")
    exported_book = ok(exported)
    exported_spec = next(c for c in exported_book["columns"] if c["name"] == name)
    assert exported_spec["binDefinitions"] == definitions
    assert exported_spec["valueLabels"] == updated_labels
    assert exported_spec["categoryOrder"] == ["4", "3", "2", "1"]
    authoring_schema = json.loads((Path(__file__).resolve().parents[4] / "template/codebook.schema.json").read_text())
    Draft202012Validator(authoring_schema).validate(exported_book)
    ok(client.post(f"/api/v1/datasets/{did}/codebook/import", files={"file": (
        "exact-bins.json", exported.content, "application/json")}))
    assert next(c for c in store.load_codebook(did)["columns"] if c["name"] == name) == exported_spec
    package = client.get(f"/api/v1/datasets/{did}/export_package")
    assert package.status_code == 200, package.text
    imported = ok(client.post("/api/v1/datasets/import_package", files={"file": (
        "exact-bins.zip", package.content, "application/zip")}))["datasetId"]
    assert store.get_dataframe(imported).equals(binned)
    assert store.get_dataframe(imported).schema == binned.schema
    assert next(c for c in store.load_codebook(imported)["columns"] if c["name"] == name) == exported_spec
    # Undo and redo restore both the integer cells and their interval definitions.
    ok(client.post(f"/api/v1/datasets/{did}/undo", json={}))
    assert store.get_dataframe(did).equals(original)
    assert store.get_dataframe(did).schema == original.schema
    assert store.get_meta(did)["schema"] == original_schema
    assert store.load_codebook(did)["columns"] == original_book["columns"]
    ok(client.post(f"/api/v1/datasets/{did}/redo", json={}))
    assert store.get_dataframe(did).equals(binned)
    assert next(c for c in store.load_codebook(did)["columns"] if c["name"] == name) == exported_spec
    assert store._raw_path(did).read_bytes() == raw_before


def test_rejected_transform_or_bin_metadata_never_publishes_partial_data(api):
    client, store = api
    did, _ = upload(api, b"q,q_null\na,100\n,200\nb,300\n")
    before = all_files(store)
    rejected = client.post(f"/api/v1/datasets/{did}/transform", json={
        "type": "nominal_to_binary", "source_column": "q",
        "options": {"handle_null": "as_category", "max_categories": 1}})
    assert rejected.status_code == 400
    assert rejected.json()["error"]["code"] == "TRANSFORM_TOO_MANY_CATEGORIES"
    assert all_files(store) == before
    invalid = client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [{
        "name": "q", "label": "must not be published", "binDefinitions": [
            {"binId": 1, "min": 2, "max": 1, "lowerInclusive": True, "upperInclusive": True}]}]})
    assert invalid.status_code == 422
    assert all_files(store) == before
    inconsistent = client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [{
        "name": "q", "binDefinitions": [
            {"binId": 2, "min": 0, "max": 1, "lowerInclusive": True, "upperInclusive": True}]}]})
    assert inconsistent.status_code == 422
    assert all_files(store) == before


FLOAT64_MAX = float.fromhex("0x1.fffffffffffffp+1023")
RESOLUTION_CASES = [
    [1e20, 1e20], [-1e20, -1e20], [FLOAT64_MAX, FLOAT64_MAX], [-FLOAT64_MAX, -FLOAT64_MAX],
    [1e20, math.nextafter(1e20, math.inf)], [-1e20, math.nextafter(-1e20, math.inf)],
    [math.nextafter(FLOAT64_MAX, -math.inf), FLOAT64_MAX],
    [-FLOAT64_MAX, math.nextafter(-FLOAT64_MAX, math.inf)],
]


@pytest.mark.parametrize("first_endpoint", ["preview", "apply"])
@pytest.mark.parametrize("values", RESOLUTION_CASES)
def test_large_constant_and_adjacent_bins_preview_apply_and_json_roundtrip(api, values, first_endpoint):
    client, store = api
    buffer = io.BytesIO()
    pq.write_table(pa.table({"q": pa.array([*values, None], type=pa.float64()),
                            "id": ["a", "b", "c"]}), buffer)
    did, original = upload(api, buffer.getvalue(), "finite-resolution.parquet")

    def preview():
        return ok(client.post(f"/api/v1/datasets/{did}/transform/preview", json={"column": "q", "num_bins": 4}))

    if first_endpoint == "preview":
        preview_result = preview()
        applied = apply(api, did, "binning", num_bins=4, output_column_name="exact_bin")
    else:
        applied = apply(api, did, "binning", num_bins=4, output_column_name="exact_bin")
        preview_result = preview()
    assert preview_result["bins"] == applied["binSummaries"]
    assert store.get_dataframe(did)["exact_bin"].to_list() == [1, 1, None]
    assert preview_result["count"] == 2
    assert sum(preview_result["histogram"]["counts"]) == 2
    assert len(applied["binSummaries"]) == 1
    assert applied["binSummaries"][0]["count"] == 2
    for edges in (preview_result["edges"], preview_result["histogram"]["edges"]):
        assert all(math.isfinite(edge) for edge in edges)
        assert all(low < high for low, high in zip(edges, edges[1:]))
        assert edges[0] <= min(values) <= max(values) <= edges[-1]
    unchanged_source(store.get_dataframe(did), original)
    exported = client.get(f"/api/v1/datasets/{did}/codebook/export?format=json")
    exported_book = ok(exported)
    spec = next(c for c in exported_book["columns"] if c["name"] == "exact_bin")
    assert spec["binDefinitions"] == [{
        "binId": 1, "min": preview_result["edges"][0], "max": preview_result["edges"][-1],
        "lowerInclusive": True, "upperInclusive": True,
    }]
    ok(client.post(f"/api/v1/datasets/{did}/codebook/import", files={"file": (
        "finite-resolution.json", exported.content, "application/json")}))
    assert next(c for c in store.load_codebook(did)["columns"] if c["name"] == "exact_bin") == spec
