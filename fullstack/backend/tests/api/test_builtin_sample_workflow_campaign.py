"""Real built-ins through export, row scope and durable workspace contracts.

These tests inspect response bytes; they do not claim browser download coverage.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import zipfile
from xml.etree import ElementTree as ET

import polars as pl
import numpy as np
import pyarrow.ipc as ipc
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, distribution, exports, observations, sessions, summaries
from app.main import app
from app.services.builtin_samples import catalog
from app.storage.dataset_store import DatasetStore
from app.storage.session_store import SessionStore

SAMPLE_IDS = [sample["id"] for sample in catalog()]


@pytest.fixture
def api(tmp_path, monkeypatch):
    data_store = DatasetStore(tmp_path / "data")
    session_store = SessionStore(tmp_path)
    for module in (datasets, distribution, exports, observations, sessions, summaries):
        monkeypatch.setattr(module, "store", data_store)
    for module in (exports, sessions):
        monkeypatch.setattr(module, "sessions", session_store)
    monkeypatch.setattr(summaries, "_cache", {})
    with TestClient(app) as client:
        yield client, data_store, tmp_path


def imported(api, sample_id):
    client, store, _ = api
    response = client.post("/api/v1/datasets/import/sample", json={"sampleId": sample_id})
    assert response.status_code == 200, response.text
    meta = response.json()
    dataset_id = meta["datasetId"]
    return meta, store.get_dataframe(dataset_id), store.load_codebook(dataset_id)


def csv_value(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


@pytest.mark.parametrize("sample_id", SAMPLE_IDS)
def test_builtin_exports_preserve_selected_values_and_explicit_empty_scope(api, sample_id):
    client, _, _ = api
    meta, frame, _ = imported(api, sample_id)
    # Sparse selection in reversed request order verifies set membership and
    # source ordering, without assuming that an export reorders source data.
    ids = frame["__rowId__"].to_list()
    wanted = [ids[-1], ids[2], ids[0]]
    expected = frame.filter(pl.col("__rowId__").is_in(wanted)).drop("__rowId__")
    body = {"datasetId": meta["datasetId"], "scope": "selected", "rowIds": wanted}
    for format in ("csv", "parquet", "arrow", "xlsx"):
        response = client.post("/api/v1/exports", json={**body, "format": format})
        assert response.status_code == 200, (sample_id, format, response.text)
        assert response.content
        if format == "csv":
            parsed = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
            assert parsed == [expected.columns, *[[csv_value(v) for v in row] for row in expected.rows()]]
        elif format == "parquet":
            assert pl.read_parquet(io.BytesIO(response.content)).equals(expected)
        elif format == "arrow":
            assert pl.from_arrow(ipc.open_stream(response.content).read_all()).equals(expected)
        else:
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
            ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            rows = []
            for row in root.findall("s:sheetData/s:row", ns):
                rows.append(["".join(cell.itertext()) for cell in row.findall("s:c", ns)])
            assert rows == [expected.columns, *[[csv_value(v) for v in row] for row in expected.rows()]]
    empty = client.post("/api/v1/exports", json={**body, "rowIds": [], "format": "csv"})
    assert list(csv.reader(io.StringIO(empty.content.decode("utf-8-sig")))) == [expected.columns]


@pytest.mark.parametrize("sample_id", SAMPLE_IDS)
def test_builtin_codebook_and_reproduction_package_keep_metadata_and_bytes(api, sample_id):
    client, _, _ = api
    meta, frame, book = imported(api, sample_id)
    url = f'/api/v1/datasets/{meta["datasetId"]}'
    assert client.get(url + "/codebook/export", params={"format": "json"}).json() == book
    response = client.get(url + "/codebook/export", params={"format": "csv"})
    records = list(csv.DictReader(io.StringIO(response.text)))
    assert records[0]["recordType"] == "dataset"
    assert records[0]["licenseText"] == book["licenseText"]
    assert len(records) == len(book["columns"]) + 1
    for row, column in zip(records[1:], book["columns"]):
        assert row["name"] == column["name"] and row["label"] == column["label"]
        for field, empty in (("categoryOrder", []), ("missingCodes", []), ("valueLabels", {})):
            assert (json.loads(row[field]) if row[field] else empty) == column.get(field, empty)
    package = client.get(url + "/export_package")
    assert package.status_code == 200, package.text
    with zipfile.ZipFile(io.BytesIO(package.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        for entry in manifest["files"]:
            content = archive.read(entry["path"])
            assert len(content) == entry["bytes"]
            assert hashlib.sha256(content).hexdigest() == entry["sha256"]
        assert json.loads(archive.read("metadata/codebook.json")) == book
        assert pl.read_parquet(io.BytesIO(archive.read("data/current.parquet"))).equals(frame)
        assert pl.read_parquet(io.BytesIO(archive.read("data/raw.parquet"))).equals(frame)


@pytest.mark.parametrize("sample_id", SAMPLE_IDS)
def test_builtin_scope_sampling_session_and_reload_remain_dataset_specific(api, sample_id):
    client, store, tmp_path = api
    meta, frame, book = imported(api, sample_id)
    did = meta["datasetId"]
    rows = frame["__rowId__"].to_list()
    candidates = rows[1:20:2]
    request = {"size": 4, "seed": 0, "activeRowIds": candidates,
               "expectedDataRevision": meta["dataRevision"], "expectedSchemaRevision": book["schemaRevision"]}
    url = f"/api/v1/datasets/{did}/observations/sample"
    first = client.post(url, json=request)
    second = client.post(url, json=request)
    assert first.status_code == second.status_code == 200, first.text
    sampled = first.json()["sampledRowIds"]
    assert sampled == second.json()["sampledRowIds"]
    assert len(set(sampled)) == 4 and set(sampled) <= set(candidates)
    assert first.json()["sourceRowCount"] == len(candidates)
    duplicate = client.post(url, json={**request, "activeRowIds": candidates + candidates[:1]})
    assert duplicate.status_code == 422 and duplicate.json()["error"]["code"] == "SAMPLING_DUPLICATE_ROW"
    unknown = client.post(url, json={**request, "activeRowIds": candidates + ["not-a-row"]})
    assert unknown.status_code == 422 and unknown.json()["error"]["code"] == "SAMPLING_UNKNOWN_ROW"
    state = {"workspaceVersion": 1, "datasetId": did, "dataRevision": meta["dataRevision"],
             "schemaRevision": book["schemaRevision"], "activeRowIds": candidates,
             "selectedRowIds": sampled, "variables": [c["name"] for c in book["columns"][:3]],
             "groups": [{"id": "sample-group", "label": "選択標本", "rowIds": sampled}]}
    created = client.post("/api/v1/sessions", json={"name": sample_id + " 検証", "datasetId": did, "state": state})
    assert created.status_code == 200, created.text
    record = created.json()
    # A fresh repository instance checks persisted SQLite bytes, not a cached
    # response or the in-memory session object.
    assert SessionStore(tmp_path).get(record["sessionId"]) == record
    assert client.get(f'/api/v1/exports/session/{record["sessionId"]}').json() == record
    repeat = client.post("/api/v1/datasets/import/sample", json={"sampleId": sample_id})
    assert repeat.json()["datasetId"] == did
    assert store.get_dataframe(did).equals(frame) and store.load_codebook(did) == book
    bad = client.put(f'/api/v1/sessions/{record["sessionId"]}',
                     json={"state": {**state, "datasetId": "other"}, "versionToken": record["versionToken"]})
    assert bad.status_code == 409 and bad.json()["error"]["code"] == "SESSION_DATASET_MISMATCH"
    assert SessionStore(tmp_path).get(record["sessionId"]) == record


@pytest.mark.parametrize("reverse", [False, True])
def test_builtin_edited_domain_agrees_between_summary_and_fedf(api, reverse):
    client, _, _ = api
    meta, frame, book = imported(api, "kakegawa-citizen2022-adult600")
    spec = next(c for c in book["columns"] if c["name"] == "問20_満足度_01")
    patch = client.put(f'/api/v1/datasets/{meta["datasetId"]}/codebook', json={
        "columns": [{"columnId": spec["columnId"], "categoryOrder": ["1", "2", "3"], "isReversed": reverse}],
        "expectedSchemaRevision": book["schemaRevision"]})
    assert patch.status_code == 200, patch.text
    body = {"datasetId": meta["datasetId"], "columns": [spec["name"]]}
    summary = client.post("/api/v1/summaries", json=body).json()["columns"][spec["name"]]
    fedf_response = client.post("/api/v1/distribution/fedf", json=body)
    assert fedf_response.status_code == 200, fedf_response.text
    fedf = fedf_response.json()
    raw = frame[spec["name"]].to_list()
    valid = [v for v in raw if v in (1, 2, 3)]
    expected = np.asarray([4 - v if reverse else v for v in valid])
    stats = fedf["statistics"][spec["name"]]
    assert stats["validCount"] == summary["count"] == len(expected) == 294
    assert stats["mean"] == pytest.approx(expected.mean()) == summary["mean"]
    assert stats["std"] == pytest.approx(expected.std(ddof=0))
    assert summary["std"] == pytest.approx(expected.std(ddof=1))
    for row_id, value in zip(frame["__rowId__"], raw):
        assert (spec["name"] in fedf["rowCoords"][row_id]) == (value in (1, 2, 3))


@pytest.mark.parametrize("scale", ["ordinal", "interval", "nominal"])
def test_builtin_declared_domain_with_only_missing_codes_never_reopens(api, scale):
    from app.algorithms.summaries.core import summarize
    from app.domain.analysis_frame import _classify_category, _numeric_value

    client, store, _ = api
    meta, frame, book = imported(api, "kakegawa-citizen2022-adult600")
    spec = next(c for c in book["columns"] if c["name"] == "問20_満足度_01")
    patch = client.put(f'/api/v1/datasets/{meta["datasetId"]}/codebook', json={
        "columns": [{"columnId": spec["columnId"], "categoryOrder": ["0", "5"], "scaleType": scale}],
        "expectedSchemaRevision": book["schemaRevision"]})
    assert patch.status_code == 200, patch.text
    book = store.load_codebook(meta["datasetId"])
    spec = next(c for c in book["columns"] if c["name"] == spec["name"])
    column_type = "categorical" if scale == "nominal" else "numeric"
    result = summarize(frame.select(spec["name"]), {spec["name"]: column_type},
                       codebook=book, weights=[1] * frame.height)[spec["name"]]
    assert result["count"] == result["denominators"]["valid"] == result["weighted"]["weightedN"] == 0
    assert result["denominators"]["invalid"] == 342
    assert result["weighted"]["distribution"] == []
    assert result["weighted"]["weightedMean"] is None
    assert _classify_category(4, spec, "exclude") == (None, "value", "invalid")
    assert _numeric_value(4, spec) == (None, "invalid")
