"""Dataset license metadata must survive edits without invalidating analysis."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import csv
import hashlib
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.domain.codebook import Codebook, CodebookUpdateRequest
from app.main import app
from app.storage.dataset_store import DatasetStore


LICENSE = '出典: Example © 2026\nLicense: CC BY 4.0\n"Attribution", https://example.org/license\r\n 保持する空白 🧪 '


@pytest.fixture
def license_ds(tmp_path, monkeypatch):
    import app.api.datasets as datasets_api
    import app.api.models as models_api
    import app.api.multi_response as multi_response_api

    store = DatasetStore(tmp_path)
    for module in (datasets_api, models_api, multi_response_api):
        monkeypatch.setattr(module, "store", store)
    monkeypatch.setattr(models_api, "_results", {})
    with TestClient(app) as client:
        result = client.post("/api/v1/datasets/import", files={
            "file": ("license.csv", "x,y,group\n1,3,A\n2,4,B\n3,8,A\n4,9,B\n5,12,A\n6,13,B\n", "text/csv")})
        assert result.status_code == 200, result.text
        yield client, result.json()["datasetId"], store


def _url(dataset_id):
    return f"/api/v1/datasets/{dataset_id}/codebook"


def _get(client, dataset_id):
    response = client.get(_url(dataset_id))
    assert response.status_code == 200, response.text
    return response.json()


def _save(client, dataset_id, text=LICENSE, **kwargs):
    response = client.put(_url(dataset_id), json={"licenseText": text, **kwargs})
    assert response.status_code == 200, response.text
    return response.json()


def _csv_metadata(text):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["recordType", "licenseText"])
    writer.writerow(["dataset", text])
    return output.getvalue()


def test_codebook_license_defaults(license_ds):
    client, ds, store = license_ds
    cb = _get(client, ds)
    assert cb["licenseText"] == ""
    assert cb["licenseRevision"] == 1
    assert store.load_codebook(ds)["licenseText"] == ""
    assert Codebook(datasetId=ds).licenseRevision == 1
    assert not CodebookUpdateRequest().explicitly_set("licenseText")


@pytest.mark.parametrize("method", ["put", "patch"])
def test_license_only_edit_preserves_all_analytical_state(license_ds, method):
    client, ds, store = license_ds
    before = _get(client, ds)
    meta = store.get_meta(ds)
    values = store.get_dataframe(ds)
    provenance = store.load_provenance(ds)
    response = getattr(client, method)(_url(ds), json={
        "licenseText": LICENSE, "columns": [], "expectedLicenseRevision": 1})
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved["schemaRevision"] == before["schemaRevision"]
    assert saved["licenseRevision"] == 2
    assert saved["updatedColumns"] == 0
    assert saved["codebook"]["licenseText"] == LICENSE
    assert saved["codebook"]["columns"] == before["columns"]
    assert store.get_meta(ds) == meta
    assert store.get_dataframe(ds).equals(values)
    assert store.load_provenance(ds) == provenance
    assert store.read_revision_codebook(ds, meta["dataRevision"])["licenseText"] == LICENSE
    assert DatasetStore(store.root.parent).load_codebook(ds)["licenseText"] == LICENSE


def test_license_clear_and_partial_column_update(license_ds):
    client, ds, _ = license_ds
    saved = _save(client, ds)
    col = saved["codebook"]["columns"][0]
    response = client.put(_url(ds), json={
        "columns": [{"columnId": col["columnId"], "label": "説明ラベル"}],
        "expectedSchemaRevision": saved["schemaRevision"],
    })
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated["schemaRevision"] == saved["schemaRevision"] + 1
    assert updated["licenseRevision"] == saved["licenseRevision"]
    assert updated["codebook"]["licenseText"] == LICENSE
    cleared = _save(client, ds, "", expectedLicenseRevision=updated["licenseRevision"])
    assert cleared["licenseRevision"] == updated["licenseRevision"] + 1
    assert cleared["schemaRevision"] == updated["schemaRevision"]
    assert _get(client, ds)["licenseText"] == ""
    assert cleared["codebook"]["columns"] == updated["codebook"]["columns"]


@pytest.mark.parametrize("value", [None, 12, [], {}, True])
def test_invalid_license_text_is_atomic(license_ds, value):
    client, ds, store = license_ds
    before = store.load_codebook(ds)
    response = client.put(_url(ds), json={"licenseText": value})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "CODEBOOK_INVALID"
    assert store.load_codebook(ds) == before


def test_license_stale_revision_rejects_overwrite(license_ds):
    client, ds, store = license_ds
    saved = _save(client, ds, expectedLicenseRevision=1)
    response = client.put(_url(ds), json={"licenseText": "overwrite", "expectedLicenseRevision": 1})
    assert response.status_code == 409
    error = response.json()["error"]
    assert error["code"] == "CODEBOOK_LICENSE_STALE"
    assert error["details"] == {"licenseRevision": 2, "expectedLicenseRevision": 1}
    assert store.load_codebook(ds) == saved["codebook"]


def test_license_concurrent_saves_have_one_winner(license_ds):
    client, ds, _ = license_ds
    def save(text):
        return client.patch(_url(ds), json={"licenseText": text, "expectedLicenseRevision": 1})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(save, ["first", "second"]))
    assert sorted(result.status_code for result in results) == [200, 409]
    winner = next(result.json()["codebook"]["licenseText"] for result in results if result.status_code == 200)
    assert _get(client, ds)["licenseText"] == winner
    assert _get(client, ds)["licenseRevision"] == 2


def test_license_revision_is_independent_of_column_revision(license_ds):
    client, ds, _ = license_ds
    cb = _get(client, ds)
    response = client.put(_url(ds), json={"columns": [
        {"columnId": cb["columns"][0]["columnId"], "label": "Changed"}]})
    assert response.status_code == 200, response.text
    saved = _save(client, ds, expectedLicenseRevision=cb["licenseRevision"])
    assert saved["schemaRevision"] == response.json()["schemaRevision"]
    assert saved["codebook"]["columns"][0]["label"] == "Changed"


def test_mixed_update_checks_both_revisions_atomically(license_ds):
    client, ds, store = license_ds
    cb = _get(client, ds)
    payload = {"licenseText": LICENSE, "expectedLicenseRevision": 1, "expectedSchemaRevision": 1,
               "columns": [{"columnId": cb["columns"][0]["columnId"], "label": "Changed"}]}
    response = client.put(_url(ds), json=payload)
    assert response.status_code == 200, response.text
    assert response.json()["schemaRevision"] == 2
    assert response.json()["licenseRevision"] == 2
    saved = store.load_codebook(ds)
    for updates, code in [({"expectedSchemaRevision": 1, "expectedLicenseRevision": 2}, "ANALYSIS_INPUT_STALE"),
                          ({"expectedSchemaRevision": 2, "expectedLicenseRevision": 1}, "CODEBOOK_LICENSE_STALE")]:
        stale = client.put(_url(ds), json={**payload, **updates, "licenseText": "lost update"})
        assert stale.status_code == 409
        assert stale.json()["error"]["code"] == code
        assert store.load_codebook(ds) == saved


def test_license_edit_keeps_existing_model_result_valid(license_ds):
    client, ds, store = license_ds
    meta = store.get_meta(ds)
    model = client.post("/api/v1/models", json={
        "datasetId": ds, "features": ["x"], "target": "y", "taskType": "regression",
        "expectedDataRevision": meta["dataRevision"], "expectedSchemaRevision": meta["schemaRevision"]})
    assert model.status_code == 200, model.text
    result_id = model.json()["resultId"]
    before = client.get(f"/api/v1/models/{result_id}")
    assert before.status_code == 200
    _save(client, ds)
    after = client.get(f"/api/v1/models/{result_id}")
    assert after.status_code == 200, after.text
    assert after.json() == before.json()
    pca = client.post("/api/v1/models/pca", json={
        "datasetId": ds, "columns": ["x", "y"],
        "expectedDataRevision": meta["dataRevision"], "expectedSchemaRevision": meta["schemaRevision"]})
    assert pca.status_code == 200, pca.text


def test_license_edit_keeps_linear_regression_result_current(license_ds, monkeypatch):
    import app.api.analysis_results as results_api
    import app.api.linear_regression as regression_api
    from app.storage import analysis_result_store

    client, ds, store = license_ds
    monkeypatch.setattr(results_api, "store", store)
    monkeypatch.setattr(regression_api, "store", store)
    results_path = store.root.parent / "analysis-results"
    results_path.mkdir()
    monkeypatch.setattr(analysis_result_store, "results_root", lambda: results_path)
    columns = {col["name"]: col["columnId"] for col in _get(client, ds)["columns"]}
    fitted = client.post("/api/v1/models/linear-regression", json={
        "context": {"datasetId": ds, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "target": columns["y"], "predictors": [{"columnId": columns["x"], "kind": "numeric"}],
    })
    assert fitted.status_code == 200, fitted.text
    result_id = fitted.json()["resultId"]
    _save(client, ds)
    current = client.get(f"/api/v1/analysis-results/{result_id}")
    assert current.status_code == 200, current.text
    assert current.json()["meta"]["resultState"] == "current"
    assert current.json()["details"]["coefficients"] == fitted.json()["details"]["coefficients"]


@pytest.mark.parametrize("format", ["json", "csv"])
@pytest.mark.parametrize("text", [LICENSE, ""])
def test_license_codebook_export_import_roundtrip(license_ds, format, text):
    client, ds, _ = license_ds
    saved = _save(client, ds, text)
    exported = client.get(f"{_url(ds)}/export?format={format}")
    assert exported.status_code == 200, exported.text
    if format == "json":
        assert exported.json()["licenseText"] == text
        assert exported.json()["licenseRevision"] == saved["licenseRevision"]
    else:
        rows = list(csv.DictReader(io.StringIO(exported.text)))
        metadata = [row for row in rows if row["recordType"] == "dataset"]
        assert len(metadata) == 1
        assert metadata[0]["licenseText"] == text
        assert metadata[0]["name"] == ""
        assert len([row for row in rows if row["recordType"] == "column"]) == len(saved["codebook"]["columns"])
    _save(client, ds, "replacement")
    imported = client.post(f"{_url(ds)}/import", files={
        "file": (f"codebook.{format}", exported.content, "application/json" if format == "json" else "text/csv")})
    assert imported.status_code == 200, imported.text
    current = _get(client, ds)
    assert current["licenseText"] == text
    assert current["columns"] == saved["codebook"]["columns"]


@pytest.mark.parametrize("format", ["json", "csv"])
@pytest.mark.parametrize("text", [LICENSE, ""])
def test_metadata_only_import_does_not_change_schema(license_ds, format, text):
    client, ds, store = license_ds
    before = _save(client, ds, "old")
    meta = store.get_meta(ds)
    body = json.dumps({"licenseText": text}) if format == "json" else _csv_metadata(text)
    response = client.post(f"{_url(ds)}/import", files={"file": (f"license.{format}", body.encode(), "text/plain")})
    assert response.status_code == 200, response.text
    assert response.json()["schemaRevision"] == before["schemaRevision"]
    assert response.json()["licenseRevision"] == before["licenseRevision"] + 1
    assert response.json()["codebook"]["licenseText"] == text
    assert store.get_meta(ds) == meta


@pytest.mark.parametrize("format", ["json", "csv"])
def test_column_only_import_preserves_license(license_ds, format):
    client, ds, _ = license_ds
    before = _save(client, ds)
    body = json.dumps([{"name": "x", "label": "new"}]) if format == "json" else "name,label\nx,new\n"
    response = client.post(f"{_url(ds)}/import", files={"file": (f"columns.{format}", body, "text/plain")})
    assert response.status_code == 200, response.text
    assert response.json()["codebook"]["licenseText"] == LICENSE
    assert response.json()["licenseRevision"] == before["licenseRevision"]


def test_license_import_rejects_concurrent_change(license_ds, monkeypatch):
    import app.api.datasets as datasets_api

    client, ds, store = license_ds
    original_read = datasets_api._read_upload

    async def read_after_concurrent_save(upload):
        datasets_api.update_codebook(ds, {"licenseText": "concurrent edit", "expectedLicenseRevision": 1})
        return await original_read(upload)

    monkeypatch.setattr(datasets_api, "_read_upload", read_after_concurrent_save)
    response = client.post(f"{_url(ds)}/import", files={
        "file": ("license.json", json.dumps({"licenseText": LICENSE}), "application/json")})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "CODEBOOK_LICENSE_STALE"
    assert store.load_codebook(ds)["licenseText"] == "concurrent edit"


def test_license_csv_roundtrip_with_no_columns(license_ds):
    client, ds, store = license_ds
    saved = _save(client, ds)
    saved["codebook"]["columns"] = []
    store.save_codebook(ds, saved["codebook"])
    exported = client.get(f"{_url(ds)}/export?format=csv")
    assert exported.status_code == 200
    _save(client, ds, "")
    response = client.post(f"{_url(ds)}/import", files={
        "file": ("empty-codebook.csv", exported.content, "text/csv")})
    assert response.status_code == 200, response.text
    assert response.json()["codebook"]["licenseText"] == LICENSE
    assert response.json()["codebook"]["columns"] == []


@pytest.mark.parametrize("body", [
    '{"licenseText": null}', '{"licenseText": 42}',
    'recordType,licenseText\ndataset,first\ndataset,second\n',
    'recordType,name,licenseText\ncolumn,x,unexpected\n',
])
def test_invalid_license_import_is_atomic(license_ds, body):
    client, ds, store = license_ds
    _save(client, ds)
    before = store.load_codebook(ds)
    response = client.post(f"{_url(ds)}/import", files={"file": ("bad.txt", body, "text/plain")})
    assert response.status_code == 422
    assert store.load_codebook(ds) == before


@pytest.mark.parametrize("text", [LICENSE, ""])
def test_license_package_roundtrip(license_ds, text):
    client, ds, store = license_ds
    saved = _save(client, ds, text)
    exported = client.get(f"/api/v1/datasets/{ds}/export_package")
    assert exported.status_code == 200, exported.text
    with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
        cb = json.loads(archive.read("metadata/codebook.json"))
        assert cb["licenseText"] == text
        assert cb["licenseRevision"] == saved["licenseRevision"]
    imported = client.post("/api/v1/datasets/import_package", files={
        "file": ("package.zip", exported.content, "application/zip")})
    assert imported.status_code == 200, imported.text
    target = imported.json()["datasetId"]
    cb_after = _get(client, target)
    assert target != ds
    assert cb_after["licenseText"] == text
    assert cb_after["licenseRevision"] == saved["licenseRevision"]
    assert cb_after["columns"] == saved["codebook"]["columns"]
    assert store.get_dataframe(target).equals(store.get_dataframe(ds))


def test_invalid_package_license_rejected_before_dataset_creation(license_ds):
    client, ds, store = license_ds
    exported = client.get(f"/api/v1/datasets/{ds}/export_package")
    with zipfile.ZipFile(io.BytesIO(exported.content)) as source:
        entries = {name: source.read(name) for name in source.namelist()}
    cb = json.loads(entries["metadata/codebook.json"])
    cb["licenseText"] = {"invalid": True}
    entries["metadata/codebook.json"] = json.dumps(cb).encode()
    manifest = json.loads(entries["manifest.json"])
    for entry in manifest["files"]:
        payload = entries[entry["path"]]
        entry.update(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    entries["manifest.json"] = json.dumps(manifest).encode()
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)
    before = store.list_datasets()
    response = client.post("/api/v1/datasets/import_package", files={
        "file": ("invalid.zip", output.getvalue(), "application/zip")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PROVENANCE_PACKAGE_INVALID"
    assert store.list_datasets() == before


def test_license_survives_transform_and_history_navigation(license_ds):
    client, ds, _ = license_ds
    _save(client, ds, "first")
    transformed = client.post(f"/api/v1/datasets/{ds}/transform", json={
        "type": "binning", "source_column": "x", "options": {"num_bins": 3, "output_column_name": "bin"}})
    assert transformed.status_code == 200, transformed.text
    assert _get(client, ds)["licenseText"] == "first"
    saved = _save(client, ds)
    for endpoint in ("undo", "redo", "undo"):
        response = client.post(f"/api/v1/datasets/{ds}/{endpoint}", json={})
        assert response.status_code == 200, response.text
        cb = _get(client, ds)
        assert cb["licenseText"] == LICENSE
        assert cb["licenseRevision"] == saved["licenseRevision"]


def test_license_survives_derived_dataset(license_ds):
    client, ds, _ = license_ds
    saved = _save(client, ds)
    derived = client.post(f"/api/v1/datasets/{ds}/impute", json={
        "columns": ["x"], "strategy": "mean", "inPlace": False})
    assert derived.status_code == 200, derived.text
    target = derived.json()["datasetId"]
    assert target != ds
    cb = _get(client, target)
    assert cb["licenseText"] == LICENSE
    assert cb["licenseRevision"] == saved["licenseRevision"]
