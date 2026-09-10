"""Feature 25 Stage 3: mutating routes record append-only operations and masks."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def prov_ds(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    import app.api.datasets as datasets_api
    import app.api.multi_response as multi_response_api
    import app.api.summaries as summaries_api

    monkeypatch.setattr(datasets_api, "store", store)
    monkeypatch.setattr(multi_response_api, "store", store)
    monkeypatch.setattr(summaries_api, "store", store)
    with TestClient(app) as client:
        text = "a,b\n1,x\n, y\n3,y\n"
        body = client.post(
            "/api/v1/datasets/import", files={"file": ("p.csv", text, "text/csv")}).json()
        dataset_id = body["datasetId"]
        assert body.get("provenance", {}).get("operationCount") == 1, body
        yield client, dataset_id, store
        client.delete(f"/api/v1/datasets/{dataset_id}")


def test_import_records_operation_and_raw_revision(prov_ds):
    client, ds, store = prov_ds
    prov = store.load_provenance(ds)
    assert prov["operations"] and prov["operations"][0]["operation"] == "import"
    assert prov["rawDataRevision"] == int(store.get_meta(ds)["dataRevision"])
    assert store.read_raw(ds).height == 3


def test_impute_records_mask_entries_only_for_filled_cells(prov_ds):
    client, ds, store = prov_ds
    res = client.post(f"/api/v1/datasets/{ds}/impute",
                      json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    assert res.status_code == 200, res.text
    mask = store.load_mask(ds)
    assert mask["maskRevision"] == 1
    assert {e["rowId"] for e in mask["entries"]} == {"ROW-000002"}
    assert all(e["methodId"] == "mean" and e["methodLabel"] == "平均値補完" for e in mask["entries"])
    ops = [o["operation"] for o in store.load_provenance(ds)["operations"]]
    assert ops == ["import", "impute"]


def test_delete_column_drops_its_mask_entries(prov_ds):
    client, ds, store = prov_ds
    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    assert client.delete(f"/api/v1/datasets/{ds}/columns/a").status_code == 200
    mask = store.load_mask(ds)
    assert mask["entries"] == []
    ops = store.load_provenance(ds)["operations"]
    assert ops[-1]["operation"] == "delete_column"
    assert ops[-1]["params"]["droppedMaskEntries"] == 1
