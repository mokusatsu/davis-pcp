"""Feature 25 / HIST-01〜04 (E07): a revision is values *and* state.

Undo must restore the schema, the codebook and the imputation mask of the
target revision, recompute the fingerprint, and move the navigation cursor —
so a second undo keeps walking back and no cached summary is reused across the
restore.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def undo_ds(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    import app.api.datasets as datasets_api
    import app.api.distribution as distribution_api
    import app.api.multi_response as multi_response_api
    import app.api.summaries as summaries_api

    monkeypatch.setattr(datasets_api, "store", store)
    monkeypatch.setattr(multi_response_api, "store", store)
    monkeypatch.setattr(summaries_api, "store", store)
    monkeypatch.setattr(distribution_api, "store", store)
    summaries_api._cache.clear()
    with TestClient(app) as client:
        text = "a,b,c\n1,x,p\n, y,q\n3,y,p\n5,z,q\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("u.csv", text, "text/csv")}).json()["datasetId"]
        yield client, dataset_id, store
        client.delete(f"/api/v1/datasets/{dataset_id}")


def _meta(store, ds):
    return store.get_meta(ds)


def _summaries(client, store, ds, columns):
    meta = _meta(store, ds)
    codebook = store.load_codebook(ds)
    body = {"datasetId": ds, "columns": columns,
            "expectedDataRevision": int(meta["dataRevision"]),
            "expectedSchemaRevision": int((codebook or {}).get("schemaRevision",
                                                               meta.get("schemaRevision", 1)))}
    res = client.post("/api/v1/summaries", json=body)
    assert res.status_code == 200, res.text
    return res.json()


def _column_summary(payload, name):
    return payload["columns"][name]


def test_undo_restores_fingerprint_and_invalidates_summary_cache(undo_ds):
    """Acceptance 1: reversal reproduces the pre-operation fingerprint and the
    summary of that moment, never the cached summary of the undone one."""
    client, ds, store = undo_ds
    before_fp = _meta(store, ds)["fingerprint"]
    before = _summaries(client, store, ds, ["a"])
    assert _column_summary(before, "a")["missing"] == 1
    assert before["cacheHit"] is False

    impute = client.post(f"/api/v1/datasets/{ds}/impute",
                         json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    assert impute.status_code == 200, impute.text
    imputed_fp = _meta(store, ds)["fingerprint"]
    assert imputed_fp != before_fp
    after_impute = _summaries(client, store, ds, ["a"])
    assert _column_summary(after_impute, "a")["missing"] == 0
    assert after_impute["fingerprint"] == imputed_fp

    undo = client.post(f"/api/v1/datasets/{ds}/undo", json={})
    assert undo.status_code == 200, undo.text
    restored = _meta(store, ds)
    assert restored["fingerprint"] == before_fp
    assert int(restored["dataRevision"]) > int(after_impute["dataRevision"])
    assert undo.json()["restoreWarnings"] == []

    again = _summaries(client, store, ds, ["a"])
    assert _column_summary(again, "a")["missing"] == 1
    assert again["fingerprint"] == before_fp


def test_undo_restores_schema_and_codebook_after_column_delete(undo_ds):
    """Acceptance 2: a deleted column comes back with its codebook metadata."""
    client, ds, store = undo_ds
    cb = client.get(f"/api/v1/datasets/{ds}/codebook").json()
    by_name = {c["name"]: dict(c) for c in cb["columns"]}
    by_name["b"].update(label="区分", valueLabels={"x": "X群", "y": "Y群", "z": "Z群"},
                        categoryOrder=["z", "y", "x"], missingCodes=["?"])
    put = client.put(f"/api/v1/datasets/{ds}/codebook",
                     json={"columns": list(by_name.values())})
    assert put.status_code == 200, put.text
    before_meta = _meta(store, ds)
    before_columns = sorted(c["name"] for c in before_meta["schema"])
    assert before_columns == ["a", "b", "c"]

    deleted = client.delete(f"/api/v1/datasets/{ds}/columns/b")
    assert deleted.status_code == 200, deleted.text
    assert sorted(c["name"] for c in _meta(store, ds)["schema"]) == ["a", "c"]
    assert _meta(store, ds)["columnCount"] == 2

    undo = client.post(f"/api/v1/datasets/{ds}/undo", json={})
    assert undo.status_code == 200, undo.text
    assert undo.json()["restoreWarnings"] == []
    restored_meta = _meta(store, ds)
    assert sorted(c["name"] for c in restored_meta["schema"]) == ["a", "b", "c"]
    assert restored_meta["columnCount"] == 3
    assert restored_meta["rowCount"] == 4
    assert restored_meta["schemaRevision"] == before_meta["schemaRevision"]

    restored_cb = client.get(f"/api/v1/datasets/{ds}/codebook").json()
    column_b = next(c for c in restored_cb["columns"] if c["name"] == "b")
    assert column_b["label"] == "区分"
    assert column_b["valueLabels"] == {"x": "X群", "y": "Y群", "z": "Z群"}
    assert column_b["categoryOrder"] == ["z", "y", "x"]
    assert column_b["missingCodes"] == ["?"]


def test_undo_clears_mask_and_redo_reapplies_it(undo_ds):
    """Acceptance 3 + 4: the mask follows the revision, in both directions."""
    client, ds, store = undo_ds
    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    mask = store.load_mask(ds)
    assert len(mask["entries"]) == 1
    assert mask["maskRevision"] == 1

    undo = client.post(f"/api/v1/datasets/{ds}/undo", json={}).json()
    assert undo["maskRevision"] == 2 and undo["maskEntryCount"] == 0
    assert store.load_mask(ds)["entries"] == []

    redo = client.post(f"/api/v1/datasets/{ds}/redo", json={}).json()
    assert redo["maskRevision"] == 3 and redo["maskEntryCount"] == 1
    replayed = store.load_mask(ds)
    assert len(replayed["entries"]) == 1
    assert replayed["entries"][0]["columnId"] == "a"
    assert replayed["entries"][0]["methodId"] == "mean"


def test_two_undos_walk_back_two_steps(undo_ds):
    """Acceptance 5: undo is not a no-op the second time."""
    client, ds, store = undo_ds
    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    calc = client.post(f"/api/v1/datasets/{ds}/calculate",
                       json={"expression": "a * 2", "columnName": "a2"})
    assert calc.status_code == 200, calc.text
    assert "a2" in {c["name"] for c in _meta(store, ds)["schema"]}

    first = client.post(f"/api/v1/datasets/{ds}/undo", json={})
    assert first.status_code == 200, first.text
    assert "a2" not in {c["name"] for c in _meta(store, ds)["schema"]}
    assert store.load_mask(ds)["entries"], "the imputation is still in place"

    second = client.post(f"/api/v1/datasets/{ds}/undo", json={})
    assert second.status_code == 200, second.text
    assert second.json()["targetDataRevision"] < first.json()["targetDataRevision"]
    assert store.load_mask(ds)["entries"] == []

    third = client.post(f"/api/v1/datasets/{ds}/undo", json={})
    assert third.status_code == 409
    assert third.json()["error"]["code"] == "PROVENANCE_NOTHING_TO_UNDO"


def test_every_revision_stays_queryable(undo_ds):
    """Acceptance 6: schema and parquet never disagree, so no endpoint 500s."""
    client, ds, store = undo_ds

    def check_all(label: str) -> None:
        meta = _meta(store, ds)
        codebook = store.load_codebook(ds) or {}
        revision = {"expectedDataRevision": int(meta["dataRevision"]),
                    "expectedSchemaRevision": int(codebook.get("schemaRevision",
                                                                meta.get("schemaRevision", 1)))}
        names = [c["name"] for c in meta["schema"]]
        assert names, label
        assert set(names) <= set(store.get_dataframe(ds).columns), label
        summaries = client.post("/api/v1/summaries", json={"datasetId": ds, "columns": names, **revision})
        assert summaries.status_code == 200, f"{label}: {summaries.text}"
        distribution = client.post("/api/v1/distribution/fedf",
                                   json={"datasetId": ds, "columns": names})
        assert distribution.status_code == 200, f"{label}: {distribution.text}"
        crosstab = client.post("/api/v1/summaries/crosstab", json={
            "context": {"datasetId": ds, **revision}, "rowVariableId": "b",
            "colVariableId": "c", "inference": "pearson"})
        assert crosstab.status_code == 200, f"{label}: {crosstab.text}"

    check_all("import")
    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    check_all("impute")
    client.post(f"/api/v1/datasets/{ds}/calculate",
                json={"expression": "a * 2", "columnName": "a2"})
    check_all("calculate")
    client.delete(f"/api/v1/datasets/{ds}/columns/a2")
    check_all("delete")
    for _ in range(3):
        assert client.post(f"/api/v1/datasets/{ds}/undo", json={}).status_code == 200
        check_all("undo")
    for _ in range(3):
        assert client.post(f"/api/v1/datasets/{ds}/redo", json={}).status_code == 200
        check_all("redo")


def test_audit_log_grows_while_cursor_moves(undo_ds):
    """Acceptance 7: the log is append-only; only the cursor navigates."""
    client, ds, store = undo_ds
    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    counts = [len(store.load_provenance(ds)["operations"])]
    cursors = [store.load_provenance(ds)["cursorOperationId"]]

    for endpoint in ("undo", "redo", "undo", "redo", "undo"):
        res = client.post(f"/api/v1/datasets/{ds}/undo" if endpoint == "undo"
                          else f"/api/v1/datasets/{ds}/redo", json={})
        assert res.status_code == 200, f"{endpoint}: {res.text}"
        provenance = store.load_provenance(ds)
        assert len(provenance["operations"]) == counts[-1] + 1
        assert provenance["currentOperationId"] == provenance["cursorOperationId"]
        counts.append(len(provenance["operations"]))
        cursors.append(provenance["cursorOperationId"])

    assert counts == sorted(counts) and len(set(counts)) == len(counts)
    # undo → parent (import), redo → impute, undo → import, …
    impute_id = next(o["operationId"] for o in store.load_provenance(ds)["operations"]
                     if o["operation"] == "impute")
    assert cursors[1] != impute_id and cursors[2] == impute_id
    assert cursors[3] != impute_id and cursors[4] == impute_id
    # Restore steps are recorded in the log but never on the cursor path.
    provenance = client.get(f"/api/v1/datasets/{ds}/provenance").json()
    on_path = {s["operationId"] for s in provenance["steps"] if s["onCursorPath"]}
    assert impute_id not in on_path


def test_provenance_exposes_navigation_flags(undo_ds):
    client, ds, store = undo_ds
    body = client.get(f"/api/v1/datasets/{ds}/provenance").json()
    assert body["canUndo"] is False and body["canRedo"] is False
    assert body["cursorOperationId"] == body["currentOperationId"]
    assert body["redoStack"] == []

    client.post(f"/api/v1/datasets/{ds}/impute",
                json={"columns": ["a"], "strategy": "mean", "inPlace": True})
    body = client.get(f"/api/v1/datasets/{ds}/provenance").json()
    assert body["canUndo"] is True and body["canRedo"] is False

    client.post(f"/api/v1/datasets/{ds}/undo", json={})
    body = client.get(f"/api/v1/datasets/{ds}/provenance").json()
    assert body["canUndo"] is False and body["canRedo"] is True
    assert len(body["redoStack"]) == 1
