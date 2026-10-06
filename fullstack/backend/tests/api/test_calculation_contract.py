"""Create/replace authorization, snapshot fences, and zero-write rejections."""
from contextlib import contextmanager

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import datasets
from app.main import app
from app.storage import dataset_store
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def calculation(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, "store", store)
    frame = pl.DataFrame({"__rowId__": ["r9", "r2", "r7"], "x": [1., 2., 3.],
                          "new_feature": [10., 20., 30.], " spaced ": [4., 5., 6.]})
    schema = [{"name": name, "columnId": f"stable-{i}", "semanticType": "numeric", "role": "feature"}
              for i, name in enumerate(frame.columns[1:])]
    book = {"datasetId": "d", "schemaRevision": 1, "columns": [
        {**column, "label": f"Label {column['name']}", "scaleType": "ratio", "role": "question",
         "missingCodes": [], "valueLabels": {"1": "one"}} for column in schema]}
    store.save("d", {"datasetId": "d", "name": "Contract fixture", "rowCount": 3,
                     "columnCount": 3, "schema": schema, "schemaRevision": 1}, frame, codebook=book)
    writes = []
    original_write = dataset_store.atomic_write_bytes
    def track_write(path, payload):
        writes.append(str(path))
        return original_write(path, payload)
    monkeypatch.setattr(dataset_store, "atomic_write_bytes", track_write)
    store.calculation_test_writes = writes
    with TestClient(app) as client:
        yield client, store


def snapshot(store):
    # Includes canonical/raw/revision parquet, metadata, dictionary, masks and history.
    return ({str(path.relative_to(store.root)): path.read_bytes()
             for path in store.root.rglob("*") if path.is_file()},
            len(store.calculation_test_writes))


def request_body(name="fresh", mode="create", expression="x + 10"):
    return {"columnName": name, "mode": mode, "expression": expression}


def preview(client, body):
    response = client.post("/api/v1/datasets/d/calculate/preview", json=body)
    assert response.status_code == 200, response.text
    assert response.json()["valid"], response.text
    return response.json()


def apply_body(body, observed):
    return {**body, "expectedDataRevision": observed["dataRevision"],
            "expectedSchemaRevision": observed["schemaRevision"]}


def apply(client, body):
    return client.post("/api/v1/datasets/d/calculate", json=body)


@pytest.mark.parametrize("name,mode", [("x", "create"), (" x ", "create"),
    ("new_feature", "create"), ("missing", "replace"), ("spaced", "replace")])
def test_destination_mismatch_rejected_without_any_write(calculation, name, mode):
    client, store = calculation
    before = snapshot(store)
    body = request_body(name, mode)
    for endpoint in ("/calculate/preview", "/calculate"):
        payload = body if endpoint.endswith("preview") else apply_body(body, store.get_meta("d"))
        response = client.post("/api/v1/datasets/d" + endpoint, json=payload)
        assert response.status_code == 409, response.text
        assert response.json()["error"]["code"] == "CALCULATION_TARGET_CONFLICT"
        assert snapshot(store) == before


@pytest.mark.parametrize("name", ["", "   ", "__rowId__", " __rowId__ "])
@pytest.mark.parametrize("mode", ["create", "replace"])
def test_invalid_or_system_name_never_mutates(calculation, name, mode):
    client, store = calculation
    before = snapshot(store)
    body = request_body(name, mode)
    for endpoint in ("/calculate/preview", "/calculate"):
        payload = body if endpoint.endswith("preview") else apply_body(body, store.get_meta("d"))
        response = client.post("/api/v1/datasets/d" + endpoint, json=payload)
        assert response.status_code == 400
        assert response.json()["error"]["code"] == "EXPRESSION_INVALID_NAME"
        assert snapshot(store) == before


@pytest.mark.parametrize("name", ["X", " __rowid__ ", "a b", "log", " spaced "])
def test_unique_exact_case_trim_only_creation(calculation, name):
    client, store = calculation
    body = request_body(name)
    before = store.get_dataframe("d")
    files = snapshot(store)
    observed = preview(client, body)
    assert snapshot(store) == files
    assert observed["column"] == name.strip()
    assert observed["mode"] == "create" and observed["targetExists"] is False
    assert observed["columnId"] is None
    response = apply(client, apply_body(body, observed))
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["operation"] == "created" and result["mode"] == "create"
    assert result["column"] == result["createdColumn"]["column"] == name.strip()
    after = store.get_dataframe("d")
    assert after.width == before.width + 1
    assert after["__rowId__"].to_list() == before["__rowId__"].to_list()
    assert after[name.strip()].to_list() == [11., 12., 13.]
    # Stored names are not trimmed when checking for a collision.
    assert after[" spaced "].to_list() == [4., 5., 6.]


def test_explicit_replacement_preserves_column_identity_count_rows_and_metadata(calculation):
    client, store = calculation
    before = store.get_dataframe("d")
    original_book = store.load_codebook("d")
    body = request_body(" x ", "replace")
    observed = preview(client, body)
    assert observed["targetExists"] is True and observed["columnId"] == "stable-0"
    response = apply(client, apply_body(body, observed))
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["operation"] == "replaced" and result["mode"] == "replace"
    assert result["column"] == result["createdColumn"]["column"] == "x"
    assert result["columnCount"] == 3 and result["dataRevision"] == 2
    after = store.get_dataframe("d")
    assert after.shape == before.shape
    assert after["__rowId__"].to_list() == before["__rowId__"].to_list()
    assert after["x"].to_list() == [11., 12., 13.]
    assert next(c for c in result["schema"] if c["name"] == "x")["columnId"] == "stable-0"
    assert next(c for c in store.load_codebook("d")["columns"] if c["name"] == "x") == original_book["columns"][0]
    step = store.load_provenance("d")["operations"][-1]
    assert step["operation"] == "calculate"
    assert step["params"] == {"columnName": "x", "expression": "x + 10", "mode": "replace"}


@pytest.mark.parametrize("field", ["mode", "expectedDataRevision", "expectedSchemaRevision"])
@pytest.mark.parametrize("value", [None, "omit", -1, 0, True, 1.5, "1", "unknown"])
def test_mandatory_strict_mode_and_revisions_cannot_be_bypassed(calculation, field, value):
    client, store = calculation
    body = apply_body(request_body(), store.get_meta("d"))
    if value == "omit":
        body.pop(field)
    else:
        body[field] = value
    before = snapshot(store)
    response = apply(client, body)
    assert response.status_code == 422, response.text
    assert snapshot(store) == before


@pytest.mark.parametrize("payload", [
    {"expression": "x", "columnName": "fresh"},
    {"expression": "x", "columnName": "fresh", "mode": "upsert"},
    {"expression": "x", "mode": "create"},
    {"expression": "x", "columnName": "fresh", "mode": "create", "unexpected": True},
])
def test_preview_requires_explicit_contract(calculation, payload):
    client, store = calculation
    before = snapshot(store)
    assert client.post("/api/v1/datasets/d/calculate/preview", json=payload).status_code == 422
    assert snapshot(store) == before


@pytest.mark.parametrize("field", ["expectedDataRevision", "expectedSchemaRevision", "extra"])
def test_wrong_revision_or_extra_expectations_never_write(calculation, field):
    client, store = calculation
    body = apply_body(request_body(), preview(client, request_body()))
    body[field] = 999
    before = snapshot(store)
    response = apply(client, body)
    assert response.status_code == (422 if field == "extra" else 409)
    if field != "extra":
        assert response.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
    assert snapshot(store) == before


@pytest.mark.parametrize("change", ["data", "schema", "create_destination", "delete_destination"])
def test_change_after_preview_rejects_without_second_commit(calculation, change):
    client, store = calculation
    body = request_body("x", "replace") if change == "delete_destination" else request_body()
    observed = preview(client, body)
    if change in ("data", "create_destination"):
        other = request_body("x", "replace", "x * 10") if change == "data" else request_body()
        committed = apply(client, apply_body(other, preview(client, other)))
        assert committed.status_code == 200, committed.text
    elif change == "schema":
        book = store.load_codebook("d")
        book["schemaRevision"] += 1
        book["columns"][0]["label"] = "Changed meaning"
        store.save_codebook("d", book)
    else:
        assert client.delete("/api/v1/datasets/d/columns/x").status_code == 200
    before = snapshot(store)
    response = apply(client, apply_body(body, observed))
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
    assert snapshot(store) == before
    # Replaying the rejected write does not automatically turn into a mutation.
    assert apply(client, apply_body(body, observed)).status_code == 409
    assert snapshot(store) == before


def test_preview_snapshot_reads_and_evaluation_share_dataset_lock(calculation, monkeypatch):
    client, store = calculation
    from app.algorithms.transformation import expression
    held = []
    observed = []
    lock = store.lock

    @contextmanager
    def tracked_lock(dataset_id):
        with lock(dataset_id):
            held.append(dataset_id)
            try:
                yield
            finally:
                held.pop()

    monkeypatch.setattr(store, "lock", tracked_lock)
    for name in ("get_meta", "load_codebook", "get_dataframe"):
        original = getattr(store, name)
        def read(*args, _original=original, _name=name, **kwargs):
            assert held and held[0] == "d", _name
            observed.append(_name)
            return _original(*args, **kwargs)
        monkeypatch.setattr(store, name, read)
    evaluate = expression.preview_expression
    def evaluate_locked(*args, **kwargs):
        assert held == ["d"]
        observed.append("evaluate")
        return evaluate(*args, **kwargs)
    monkeypatch.setattr(expression, "preview_expression", evaluate_locked)
    result = preview(client, request_body())
    assert result["dataRevision"] == result["schemaRevision"] == 1
    assert {"get_meta", "load_codebook", "get_dataframe", "evaluate"} <= set(observed)


def test_sample_limited_preview_is_truthfully_described_without_changing_arithmetic(calculation):
    client, store = calculation
    frame = pl.DataFrame({"__rowId__": [f"r{i}" for i in range(101)], "x": list(range(101))})
    store.save("d", {**store.get_meta("d"), "rowCount": 101}, frame, codebook=store.load_codebook("d"))
    body = request_body("scaled", expression="minmax(x)")
    observed = preview(client, body)
    assert observed["previewScope"] == "first_rows"
    assert observed["previewRowCount"] == observed["previewRowLimit"] == 100
    assert observed["rowCount"] == 101 and observed["stats"]["count"] == 100
    assert observed["previewValues"][1] == .0101
    assert apply(client, apply_body(body, observed)).status_code == 200
    assert store.get_dataframe("d")["scaled"][1] == .01


@pytest.mark.parametrize("expression", ["", "x +", "unknown + 1"])
def test_expression_rejection_does_not_write(calculation, expression):
    client, store = calculation
    body = request_body(expression=expression)
    before = snapshot(store)
    response = client.post("/api/v1/datasets/d/calculate/preview", json=body)
    assert response.status_code == 200 and response.json()["valid"] is False
    assert snapshot(store) == before
    response = apply(client, apply_body(body, store.get_meta("d")))
    assert response.status_code == 400
    assert snapshot(store) == before
