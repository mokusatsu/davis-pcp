"""Feature 25 Stage 4: undo/redo/revert append-only semantics and mask API."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def revert_ds(tmp_path, monkeypatch):
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
            "/api/v1/datasets/import", files={"file": ("r.csv", text, "text/csv")}).json()["datasetId"]
        yield client, dataset_id, store
        client.delete(f"/api/v1/datasets/{dataset_id}")


def test_undo_redo_revert_keep_history_and_clear_mask_on_raw(revert_ds):
    client, ds, store = revert_ds
    raw_rev = store.load_provenance(ds)["rawDataRevision"]
    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    assert store.load_mask(ds)["entries"]
    rev_after_impute = int(store.get_meta(ds)["dataRevision"])

    undo = client.post(f"/api/v1/datasets/{ds}/undo", json={}).json()
    assert undo["currentDataRevision"] == rev_after_impute + 1
    ops = [o["operation"] for o in store.load_provenance(ds)["operations"]]
    assert ops == ["import", "impute", "undo"]

    redo = client.post(f"/api/v1/datasets/{ds}/redo", json={}).json()
    assert redo["currentDataRevision"] == rev_after_impute + 2
    assert store.load_provenance(ds)["operations"][-1]["operation"] == "redo"

    revert = client.post(f"/api/v1/datasets/{ds}/revert",
                         json={"targetDataRevision": raw_rev}).json()
    assert revert["targetDataRevision"] == raw_rev
    assert store.load_mask(ds)["entries"] == []
    assert [o["operation"] for o in store.load_provenance(ds)["operations"]][-1] == "revert"


def test_new_edit_after_undo_discards_redo_stack(revert_ds):
    """A new edit branches off the cursor and clears the redo stack.

    The audit log keeps the undone step (append-only), but redo no longer has
    an unambiguous target — the standard undo/redo contract.
    """
    client, ds, store = revert_ds
    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    undo_body = client.post(f"/api/v1/datasets/{ds}/undo", json={}).json()
    assert undo_body["currentDataRevision"] == 3
    # The cursor is back on the import, so there is nothing further to undo.
    assert undo_body["canUndo"] is False and undo_body["canRedo"] is True
    assert undo_body["cursorOperationId"] == undo_body["targetOperationId"]
    prov = store.load_provenance(ds)
    undone_id = next(o["operationId"] for o in prov["operations"] if o["operation"] == "impute")
    anchor = next(o["parentOperationId"] for o in prov["operations"] if o["operation"] == "impute")
    assert store.load_provenance(ds)["redoStack"] == [undone_id]
    calc = client.post(f"/api/v1/datasets/{ds}/calculate",
                       json={"expression": "a * 2", "columnName": "a2"})
    assert calc.status_code == 200, calc.text
    after = store.load_provenance(ds)
    assert [o["operation"] for o in after["operations"]] == ["import", "impute", "undo",
                                                             "calculate"], after
    # The new edit hangs off the restored cursor (the import), not the impute.
    assert after["redoStack"] == []
    calc_body = calc.json()
    assert calc_body.get("createdColumn", {}).get("column") == "a2", calc_body
    assert calc_body["dataRevision"] == 4, calc_body
    res = client.post(f"/api/v1/datasets/{ds}/redo", json={})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "PROVENANCE_NOTHING_TO_REDO"
    assert anchor == next(o["operationId"] for o in after["operations"] if o["operation"] == "import")


def test_mask_api_requires_revision_and_filters_scope(revert_ds):
    client, ds, store = revert_ds
    assert client.get(f"/api/v1/datasets/{ds}/imputation-mask").status_code == 422
    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    rev = int(store.get_meta(ds)["dataRevision"])
    body = client.get(f"/api/v1/datasets/{ds}/imputation-mask",
                      params={"expectedDataRevision": rev}).json()
    assert body["maskRevision"] == 1 and len(body["entries"]) == 1
    row_id = body["entries"][0]["rowId"]
    filtered = client.get(f"/api/v1/datasets/{ds}/imputation-mask",
                          params={"expectedDataRevision": rev, "rowIds": "nope"}).json()
    assert filtered["entries"] == []
    scoped = client.get(f"/api/v1/datasets/{ds}/imputation-mask",
                        params={"expectedDataRevision": rev, "rowIds": row_id}).json()
    assert len(scoped["entries"]) == 1
    stale = client.get(f"/api/v1/datasets/{ds}/imputation-mask",
                       params={"expectedDataRevision": rev - 1})
    assert stale.status_code == 409
