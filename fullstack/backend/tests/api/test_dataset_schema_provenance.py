"""Dataset audit revisions follow persisted state through edits and Undo/Redo."""
from __future__ import annotations

import json

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, exports
from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore


def _ok(response):
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (datasets, exports):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        result = _ok(client.post("/api/v1/datasets/import", files={"file": (
            "schema-provenance.csv",
            b"q,id,value,fill\nb,r1,10,1.0\na,r2,20,\nb,r3,30,3.0\n,r4,40,5.0\na,r5,50,7.0\n",
            "text/csv",
        )}))
        did = result["datasetId"]
        revision = store.load_codebook(did)["schemaRevision"]
        seed = store.load_provenance(did)["operations"]
        assert len(seed) == 1 and seed[0]["algorithmVersion"] == "import-1"
        assert (seed[0]["inputSchemaRevision"], seed[0]["outputSchemaRevision"]) == (revision, revision)
        yield client, store, did


def _state(client, store, did):
    """Read the committed state independently of the operation's audit fields."""
    book = store.load_codebook(did)
    meta = store.get_meta(did)
    assert meta["schemaRevision"] == book["schemaRevision"]
    audit = json.loads(store._provenance_path(did).read_text(encoding="utf-8"))
    assert audit == store.load_provenance(did)
    assert _ok(client.get(f"/api/v1/datasets/{did}/provenance"))["operations"] == audit["operations"]
    csv = client.post("/api/v1/exports", json={"datasetId": did, "scope": "all", "format": "csv"})
    assert csv.status_code == 200, csv.text
    return {"meta": meta, "book": book, "audit": audit, "csv": csv.content,
            "frame": store.get_dataframe(did), "mask": store.load_mask(did)}


def _apply(client, did, kind, before):
    base = f"/api/v1/datasets/{did}"
    if kind in ("nominal_to_binary", "binning"):
        return _ok(client.post(base + "/transform", json={
            "type": kind, "source_column": "q" if kind == "nominal_to_binary" else "value",
            "options": {} if kind == "nominal_to_binary" else {"num_bins": 2},
        }))
    if kind.startswith("calculate_"):
        create = kind == "calculate_create"
        return _ok(client.post(base + "/calculate", json={
            "expression": "value * 2" if create else "fill + 1",
            "columnName": "double" if create else "fill", "mode": "create" if create else "replace",
            "expectedDataRevision": before["meta"]["dataRevision"],
            "expectedSchemaRevision": before["book"]["schemaRevision"],
        }))
    if kind == "delete":
        return _ok(client.delete(base + "/columns/q"))
    if kind == "schema_patch":
        return _ok(client.patch(base + "/schema", json={"columns": [{"name": "q", "newName": "category"}]}))
    assert kind == "impute"
    return _ok(client.post(base + "/impute", json={"columns": ["fill"], "strategy": "mean", "inPlace": True}))


def _assert_restored(actual, expected):
    assert actual["frame"].schema == expected["frame"].schema
    assert actual["frame"].equals(expected["frame"])
    assert actual["csv"] == expected["csv"]
    assert actual["book"] == expected["book"]
    assert actual["mask"]["entries"] == expected["mask"]["entries"]
    for key in ("schema", "schemaRevision", "fingerprint", "rowCount", "columnCount"):
        assert actual["meta"][key] == expected["meta"][key]


@pytest.mark.parametrize("kind,operation,version,changed", [
    ("nominal_to_binary", "transform", "transform-2", True),
    ("binning", "transform", "transform-2", True),
    ("calculate_create", "calculate", "calculate-1", True),
    ("delete", "delete_column", "delete-column-1", True),
    ("schema_patch", "schema_update", "schema-patch-1", True),
    ("calculate_replace", "calculate", "calculate-1", False),
    ("impute", "impute", "impute-mean-1", False),
])
def test_edit_and_navigation_record_actual_schema_pairs(api, kind, operation, version, changed, record_property):
    client, store, did = api
    before = _state(client, store, did)
    raw = store._raw_path(did).read_bytes()
    result = _apply(client, did, kind, before)
    after = _state(client, store, did)
    original, saved = before["frame"], after["frame"]
    assert result["schemaRevision"] == after["book"]["schemaRevision"]
    assert (after["book"]["schemaRevision"] > before["book"]["schemaRevision"]) is changed

    if kind in ("nominal_to_binary", "binning", "calculate_create"):
        added = result["createdColumns"] if operation == "transform" else ["double"]
        assert saved.columns == original.columns + added
        assert saved.select(original.columns).schema == original.schema
        assert saved.select(original.columns).equals(original)
        assert after["book"]["columns"][:-len(added)] == before["book"]["columns"]
        if kind == "nominal_to_binary":
            assert added == ["q_a", "q_b"]
            assert saved["q_a"].to_list() == [0, 1, 0, None, 1]
            assert saved["q_b"].to_list() == [1, 0, 1, None, 0]
            assert saved["q_a"].dtype == saved["q_b"].dtype == pl.Int32
        elif kind == "binning":
            assert saved[added[0]].to_list() == [1, 1, 2, 2, 2]
            assert saved[added[0]].dtype == pl.Int32
            assert after["book"]["columns"][-1]["categoryOrder"] == ["1", "2"]
        else:
            assert saved["double"].to_list() == [20, 40, 60, 80, 100]
            assert saved["double"].dtype == pl.Float64
    elif kind == "delete":
        assert saved.schema == original.drop("q").schema
        assert saved.equals(original.drop("q"))
        assert after["book"]["columns"] == [c for c in before["book"]["columns"] if c["name"] != "q"]
    elif kind == "schema_patch":
        assert saved.schema == original.rename({"q": "category"}).schema
        assert saved.equals(original.rename({"q": "category"}))
        assert after["book"]["columns"] == [
            {**c, "name": "category"} if c["name"] == "q" else c for c in before["book"]["columns"]]
    else:
        assert saved.columns == original.columns and saved.schema == original.schema
        assert saved.drop("fill").equals(original.drop("fill"))
        assert saved["fill"].to_list() == ([2., None, 4., 6., 8.] if kind == "calculate_replace"
                                          else [1., 4., 3., 5., 7.])
        # Ordinary synchronization omits these unset design keys; all other
        # definitions and revisions remain identical for a same-schema edit.
        assert before["book"].get("weightConfig") is None
        assert before["book"].get("surveyDesign") is None
        assert after["book"] == {key: value for key, value in before["book"].items()
                                 if key not in ("weightConfig", "surveyDesign")}
        if kind == "impute":
            assert [(c["rowId"], c["columnId"]) for c in after["mask"]["entries"]] == [(original["__rowId__"][1], "fill")]

    edit = after["audit"]["operations"][-1]
    assert edit["operationId"] == result["provenance"]["currentOperationId"]
    assert edit["algorithmVersion"] == version
    transitions = [(before, after, operation)]
    current = after
    for action, target in (("undo", before), ("redo", after)):
        response = _ok(client.post(f"/api/v1/datasets/{did}/{action}", json={
            "expectedDataRevision": current["meta"]["dataRevision"],
            "expectedSchemaRevision": current["book"]["schemaRevision"],
        }))
        restored = _state(client, store, did)
        _assert_restored(restored, target)
        assert response["restoreWarnings"] == []
        assert response["schemaRevision"] == restored["book"]["schemaRevision"]
        assert response["currentDataRevision"] == restored["meta"]["dataRevision"]
        assert restored["audit"]["cursorOperationId"] == target["audit"]["cursorOperationId"]
        transitions.append((current, restored, action))
        current = restored
    assert store._raw_path(did).read_bytes() == raw

    expected, observed = [], []
    for source, destination, name in transitions:
        step = destination["audit"]["operations"][-1]
        assert destination["audit"]["operations"] == source["audit"]["operations"] + [step]
        assert step["operation"] == name
        assert step["parentOperationId"] == source["audit"]["currentOperationId"]
        assert (step["inputDataRevision"], step["outputDataRevision"]) == (
            source["meta"]["dataRevision"], destination["meta"]["dataRevision"])
        assert step["outputDataRevision"] > step["inputDataRevision"]
        expected.append((source["book"]["schemaRevision"], destination["book"]["schemaRevision"]))
        observed.append((step["inputSchemaRevision"], step["outputSchemaRevision"]))
    record_property("schema_pairs", json.dumps({"expected": expected, "observed": observed}))
    # Compare only after all values, persistence and navigation checks, so a
    # provenance failure cannot be mistaken for a failed edit or restoration.
    assert observed == expected


@pytest.mark.parametrize("kind", ["derived_imputation", "package_import"])
def test_new_dataset_seed_uses_its_own_schema_revision(api, kind):
    client, store, did = api
    before = _state(client, store, did)
    _apply(client, did, "nominal_to_binary", before)
    source = _state(client, store, did)
    if kind == "derived_imputation":
        result = _ok(client.post(f"/api/v1/datasets/{did}/impute", json={
            "columns": ["fill"], "strategy": "mean", "inPlace": False}))
        expected_operation, version = "impute", "impute-1"
    else:
        package = client.get(f"/api/v1/datasets/{did}/export_package")
        assert package.status_code == 200, package.text
        result = _ok(client.post("/api/v1/datasets/import_package", files={
            "file": ("dataset.zip", package.content, "application/zip")}))
        expected_operation, version = "import", "import-package-1"
    new_id = result["datasetId"]
    assert new_id != did
    created = _state(client, store, new_id)
    operations = created["audit"]["operations"]
    assert len(operations) == 1
    step = operations[0]
    revision = created["book"]["schemaRevision"]
    assert step["operation"] == expected_operation and step["algorithmVersion"] == version
    assert (step["inputSchemaRevision"], step["outputSchemaRevision"]) == (revision, revision)
    assert created["frame"].columns == source["frame"].columns
    assert created["frame"].schema == source["frame"].schema
    assert created["book"]["columns"] == source["book"]["columns"]
    if kind == "derived_imputation":
        assert created["frame"].drop("fill").equals(source["frame"].drop("fill"))
        assert created["frame"]["fill"].to_list() == [1., 4., 3., 5., 7.]
    else:
        assert created["frame"].equals(source["frame"])
        assert created["csv"] == source["csv"]
        assert created["audit"]["readOnlyHistory"] == source["audit"]["operations"]
    _assert_restored(_state(client, store, did), source)
