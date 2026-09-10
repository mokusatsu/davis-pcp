"""Feature 25 Stage 4: reproduction package export/import roundtrip."""
from __future__ import annotations

import hashlib
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def package_ds(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    import app.api.datasets as datasets_api
    import app.api.multi_response as multi_response_api
    import app.api.summaries as summaries_api

    monkeypatch.setattr(datasets_api, "store", store)
    monkeypatch.setattr(multi_response_api, "store", store)
    monkeypatch.setattr(summaries_api, "store", store)
    with TestClient(app) as client:
        text = "a,b\n1,x\n, y\n3,y\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("k.csv", text, "text/csv")}).json()["datasetId"]
        client.post(f"/api/v1/datasets/{dataset_id}/impute",
                    json={"columns": ["a"], "strategy": "mean", "inPlace": True})
        yield client, dataset_id, store
        for item in store.list_datasets():
            client.delete(f"/api/v1/datasets/{item['datasetId']}")


def test_package_export_has_manifest_checksums_and_no_secrets(package_ds):
    client, ds, store = package_ds
    res = client.get(f"/api/v1/datasets/{ds}/export_package")
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(res.content))
    manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    assert manifest["packageVersion"] == "provenance-package-1"
    for entry in manifest["files"]:
        assert hashlib.sha256(archive.read(entry["path"])).hexdigest() == entry["sha256"]
    blob = res.content.decode("latin-1")
    assert "token" not in blob.lower() or "missingTokens" in blob
    assert "C:\\" not in blob and "/home/" not in blob


def test_package_import_roundtrip_creates_new_dataset(package_ds):
    client, ds, store = package_ds
    payload = client.get(f"/api/v1/datasets/{ds}/export_package").content
    res = client.post("/api/v1/datasets/import_package",
                      files={"file": ("package.zip", payload, "application/zip")})
    assert res.status_code == 200, res.text
    new_id = res.json()["datasetId"]
    assert new_id != ds
    assert (store.get_dataframe(new_id)["__rowId__"].to_list()
            == store.get_dataframe(ds)["__rowId__"].to_list())
    assert store.load_provenance(new_id)["operations"]
    assert store.load_mask(new_id)["entries"] == store.load_mask(ds)["entries"]


def test_package_import_rejects_tampered_payload(package_ds):
    client, ds, store = package_ds
    payload = client.get(f"/api/v1/datasets/{ds}/export_package").content
    archive = zipfile.ZipFile(io.BytesIO(payload))
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as fresh:
        for name in archive.namelist():
            data = archive.read(name)
            if name == "data/raw.csv":
                data += b"tampered,1\n"
            fresh.writestr(name, data)
    res = client.post("/api/v1/datasets/import_package",
                      files={"file": ("package.zip", out.getvalue(), "application/zip")})
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "PROVENANCE_PACKAGE_CHECKSUM"
