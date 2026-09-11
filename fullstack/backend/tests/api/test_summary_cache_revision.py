"""HIST-01: an undone revision must not be served from the summary cache.

Restoring a revision reproduces the fingerprint it had before the operation,
so a fingerprint-only cache key cannot tell "the summary of now" from "the
summary of before the undo". dataRevision / maskRevision are part of the key.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def cache_ds(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    import app.api.datasets as datasets_api
    import app.api.multi_response as multi_response_api
    import app.api.summaries as summaries_api

    monkeypatch.setattr(datasets_api, "store", store)
    monkeypatch.setattr(multi_response_api, "store", store)
    monkeypatch.setattr(summaries_api, "store", store)
    summaries_api._cache.clear()
    with TestClient(app) as client:
        text = "a,b\n1,x\n, y\n3,y\n5,z\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("c.csv", text, "text/csv")}).json()["datasetId"]
        yield client, dataset_id, store
        client.delete(f"/api/v1/datasets/{dataset_id}")
        summaries_api._cache.clear()


def _summary(client, store, ds, column="a"):
    meta = store.get_meta(ds)
    codebook = store.load_codebook(ds) or {}
    res = client.post("/api/v1/summaries", json={
        "datasetId": ds, "columns": [column],
        "expectedDataRevision": int(meta["dataRevision"]),
        "expectedSchemaRevision": int(codebook.get("schemaRevision",
                                                    meta.get("schemaRevision", 1)))})
    assert res.status_code == 200, res.text
    return res.json()


def test_restored_revision_is_not_served_from_the_undone_cache(cache_ds):
    client, ds, store = cache_ds
    first = _summary(client, store, ds)
    assert first["cacheHit"] is False
    assert first["columns"]["a"]["missing"] == 1
    warm = _summary(client, store, ds)
    assert warm["cacheHit"] is True

    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    imputed = _summary(client, store, ds)
    assert imputed["cacheHit"] is False
    assert imputed["columns"]["a"]["missing"] == 0

    undo = client.post(f"/api/v1/datasets/{ds}/undo", json={})
    assert undo.status_code == 200, undo.text
    restored = _summary(client, store, ds)
    # Same fingerprint as ``first`` — a fingerprint-only key would have
    # returned the cached pre-computation summary here.
    assert restored["fingerprint"] == first["fingerprint"]
    assert restored["dataRevision"] != first["dataRevision"]
    assert restored["cacheHit"] is False
    assert restored["columns"]["a"]["missing"] == 1
    assert restored["columns"]["a"]["mean"] == first["columns"]["a"]["mean"]

    # …and the restored revision is cacheable in its own right.
    assert _summary(client, store, ds)["cacheHit"] is True


def test_mask_revision_separates_otherwise_identical_requests(cache_ds):
    """A mask-only change invalidates the cached summary of the same values."""
    client, ds, store = cache_ds
    _summary(client, store, ds)
    before_revision = int(store.load_mask(ds)["maskRevision"])
    assert before_revision == 0

    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    assert int(store.load_mask(ds)["maskRevision"]) == 1
    imputed = _summary(client, store, ds)
    assert imputed["cacheHit"] is False
    assert imputed["columns"]["a"]["missing"] == 0
