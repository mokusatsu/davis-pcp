"""Kakegawa's real 0/5 missing codes stay consistent through imputation/history."""
from __future__ import annotations

from collections import Counter
import hashlib
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, summaries
from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore

QUESTION = "問20_満足度_01"
REQUEST = {"columns": [QUESTION], "predictorColumns": [], "strategy": "mode"}


@pytest.fixture
def kakegawa(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, "store", store)
    monkeypatch.setattr(summaries, "store", store)
    monkeypatch.setattr(summaries, "_cache", {})
    with TestClient(app) as client:
        imported = client.post("/api/v1/datasets/import/sample", json={"sampleId": "kakegawa-citizen2022-adult600"})
        assert imported.status_code == 200, imported.text
        did = imported.json()["datasetId"]
        frame = store.get_dataframe(did)
        book = store.load_codebook(did)
        raw = frame[QUESTION].to_list()
        missing_ids = [rid for rid, value in zip(frame["__rowId__"], raw) if value in (0, 5)]
        valid = [value for value in raw if value not in (0, 5)]
        mode = Counter(valid).most_common(1)[0][0]
        assert len(missing_ids) == 258 and mode == 2
        expected = [mode if value in (0, 5) else value for value in raw]
        yield client, store, did, frame, book, missing_ids, expected


def value_hash(values):
    payload = json.dumps([None if value is None else str(value) for value in values],
                         ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def preview_apply(client, did, in_place):
    preview = client.post(f"/api/v1/datasets/{did}/impute/preview", json=REQUEST)
    assert preview.status_code == 200, preview.text
    apply = client.post(f"/api/v1/datasets/{did}/impute", json={**REQUEST,
        "planHash": preview.json()["planHash"], "inPlace": in_place})
    assert apply.status_code == 200, apply.text
    return preview.json(), apply.json()


@pytest.mark.parametrize("in_place", [True, False], ids=["in-place", "derived"])
def test_coded_missing_preview_matches_applied_values_and_hash(kakegawa, in_place):
    client, store, did, original, book, missing_ids, expected = kakegawa
    preview, applied = preview_apply(client, did, in_place)
    target = applied["datasetId"]
    actual = store.get_dataframe(target)
    assert actual[QUESTION].to_list() == expected
    assert actual.drop(QUESTION).equals(original.drop(QUESTION))
    column = preview["perColumn"][0]
    assert column["beforeStats"]["missingCount"] == len(missing_ids)
    assert column["afterStats"]["missingCount"] == 0
    assert column["beforeStats"]["mean"] == pytest.approx(np.mean([v for v in original[QUESTION] if v not in (0, 5)]), abs=5e-5, rel=0)
    assert column["afterStats"]["mean"] == pytest.approx(np.mean(expected), abs=5e-5, rel=0)
    assert column["valuesHash"] == applied["outputHashes"][QUESTION] == value_hash(expected)
    assert preview["diagnostics"]["imputedCounts"][QUESTION] == len(missing_ids)
    assert applied["diagnostics"]["imputedCounts"][QUESTION] == len(missing_ids)
    assert store.load_codebook(target)["licenseText"] == book["licenseText"]
    if not in_place:
        assert target != did
        assert store.get_dataframe(did).equals(original)
        assert store.load_mask(did)["entries"] == []


@pytest.mark.parametrize("in_place", [True, False], ids=["in-place", "derived"])
def test_coded_missing_imputation_has_exact_cell_attribution(kakegawa, in_place):
    client, store, did, original, _, missing_ids, expected = kakegawa
    _, applied = preview_apply(client, did, in_place)
    target = applied["datasetId"]
    assert store.get_dataframe(target)[QUESTION].to_list() == expected
    mask = store.load_mask(target)
    assert mask["maskRevision"] == 1
    assert len(mask["entries"]) == len(missing_ids)
    assert {entry["rowId"] for entry in mask["entries"]} == set(missing_ids)
    target_spec = next(c for c in store.load_codebook(target)["columns"] if c["name"] == QUESTION)
    assert {entry["columnId"] for entry in mask["entries"]} <= {QUESTION, target_spec["columnId"]}
    provenance = store.load_provenance(target)
    operation = next(o for o in reversed(provenance["operations"]) if o["operation"] == "impute")
    assert {entry["createdByOperationId"] for entry in mask["entries"]} == {operation["operationId"]}
    assert {entry["methodId"] for entry in mask["entries"]} == {"mode"}
    assert store.read_raw(target).equals(original if in_place else store.get_dataframe(target))


def test_impute_transform_undo_restores_values_masks_summary_and_current_license(kakegawa):
    client, store, did, original, book, missing_ids, expected = kakegawa
    _, applied = preview_apply(client, did, True)
    assert applied["dataRevision"] == 2
    assert len(store.load_mask(did)["entries"]) == len(missing_ids)
    imputed = store.get_dataframe(did)
    license_text = book["licenseText"] + "\nRegression-test annotation."
    license_edit = client.put(f"/api/v1/datasets/{did}/codebook", json={
        "licenseText": license_text, "expectedLicenseRevision": book["licenseRevision"]})
    assert license_edit.status_code == 200, license_edit.text
    current_license_revision = store.load_codebook(did)["licenseRevision"]
    transform = client.post(f"/api/v1/datasets/{did}/transform", json={"type": "binning",
        "source_column": "年齢", "options": {"method": "equal_width", "num_bins": 2,
                                                "output_column_name": "age_bins2"}})
    assert transform.status_code == 200, transform.text
    assert transform.json()["dataRevision"] == 3
    for expected_frame, revision, mask_count in ((imputed, 4, 258), (original, 5, 0)):
        response = client.post(f"/api/v1/datasets/{did}/undo", json={})
        assert response.status_code == 200, response.text
        assert store.get_dataframe(did).equals(expected_frame)
        assert store.get_meta(did)["dataRevision"] == revision
        assert len(store.load_mask(did)["entries"]) == mask_count
        now = store.load_codebook(did)
        assert now["licenseText"] == license_text
        assert now["licenseRevision"] == current_license_revision
        summary = client.post("/api/v1/summaries", json={"datasetId": did, "columns": [QUESTION]}).json()["columns"][QUESTION]
        independent = [v for v in expected_frame[QUESTION] if v not in (0, 5)]
        assert summary["denominators"]["valid"] == len(independent)
        assert summary["mean"] == pytest.approx(np.mean(independent), abs=1e-12, rel=0)
    assert [o["operation"] for o in store.load_provenance(did)["operations"]] == ["import", "impute", "transform", "undo", "undo"]


def test_codebook_change_after_preview_refuses_stale_plan_without_data_mutation(kakegawa):
    client, store, did, _, book, _, _ = kakegawa
    preview = client.post(f"/api/v1/datasets/{did}/impute/preview", json=REQUEST).json()
    spec = next(c for c in book["columns"] if c["name"] == QUESTION)
    update = client.put(f"/api/v1/datasets/{did}/codebook", json={"expectedSchemaRevision": book["schemaRevision"],
        "columns": [{"columnId": spec["columnId"], "missingCodes": ["0", "5", "99"]}]})
    assert update.status_code == 200, update.text
    before = {str(p.relative_to(store.root)): p.read_bytes() for p in store.root.rglob("*") if p.is_file()}
    response = client.post(f"/api/v1/datasets/{did}/impute", json={**REQUEST,
        "planHash": preview["planHash"], "inPlace": True})
    assert response.status_code == 409 and response.json()["error"]["code"] == "IMPUTATION_PLAN_STALE"
    after = {str(p.relative_to(store.root)): p.read_bytes() for p in store.root.rglob("*") if p.is_file()}
    assert before == after


def test_new_transform_after_imputation_undo_invalidates_redo(kakegawa):
    client, store, did, original, book, _, _ = kakegawa
    preview_apply(client, did, True)
    undo = client.post(f"/api/v1/datasets/{did}/undo", json={})
    assert undo.status_code == 200 and undo.json()["canRedo"]
    assert store.get_dataframe(did).equals(original)
    transform = client.post(f"/api/v1/datasets/{did}/transform", json={"type": "binning",
        "source_column": "年齢", "options": {"num_bins": 2, "output_column_name": "branch_age_bin"}})
    assert transform.status_code == 200, transform.text
    redo = client.post(f"/api/v1/datasets/{did}/redo", json={})
    assert redo.status_code == 409 and redo.json()["error"]["code"] == "PROVENANCE_NOTHING_TO_REDO"
    assert store.get_dataframe(did).select(original.columns).equals(original)
    assert store.load_codebook(did)["licenseText"] == book["licenseText"]
    assert store.load_provenance(did)["redoStack"] == []
    assert [o["operation"] for o in store.load_provenance(did)["operations"]] == ["import", "impute", "undo", "transform"]


def test_zero_is_preserved_when_declared_valid_and_only_five_is_missing(kakegawa):
    client, store, did, original, book, _, _ = kakegawa
    spec = next(c for c in book["columns"] if c["name"] == QUESTION)
    update = client.put(f"/api/v1/datasets/{did}/codebook", json={"expectedSchemaRevision": book["schemaRevision"],
        "columns": [{"columnId": spec["columnId"], "missingCodes": ["5"],
                     "categoryOrder": ["0", "1", "2", "3", "4"]}]})
    assert update.status_code == 200, update.text
    # Make 0 an actual valid response, not just an undeclared-domain value.
    expected_ids = [rid for rid, value in original.select("__rowId__", QUESTION).rows() if value == 5]
    zero_ids = [rid for rid, value in original.select("__rowId__", QUESTION).rows() if value == 0]
    assert len(expected_ids) == 248 and len(zero_ids) == 10
    preview, applied = preview_apply(client, did, True)
    assert preview["beforeStats"]["missingCount"] == 248
    assert applied["diagnostics"]["imputedCounts"][QUESTION] == 248
    assert preview["perColumn"][0]["valuesHash"] == applied["outputHashes"][QUESTION]
    after = store.get_dataframe(did)
    expected = [2 if value == 5 else value for value in original[QUESTION]]
    assert after[QUESTION].to_list() == expected
    assert after.drop(QUESTION).equals(original.drop(QUESTION))
    mask_ids = {entry["rowId"] for entry in store.load_mask(did)["entries"]}
    assert mask_ids == set(expected_ids)
    assert mask_ids.isdisjoint(zero_ids)


def test_repeated_preview_without_apply_is_identical_and_read_only(kakegawa):
    client, store, did, original, book, _, _ = kakegawa
    before = {str(p.relative_to(store.root)): p.read_bytes() for p in store.root.rglob("*") if p.is_file()}
    previews = []
    for _ in range(2):
        response = client.post(f"/api/v1/datasets/{did}/impute/preview", json=REQUEST)
        assert response.status_code == 200, response.text
        previews.append(response.json())
        after = {str(p.relative_to(store.root)): p.read_bytes() for p in store.root.rglob("*") if p.is_file()}
        assert after == before
    assert previews[0] == previews[1]
    assert previews[0]["beforeStats"]["missingCount"] == 258
    # Dismissing a preview has no apply action and leaves values/history intact.
    assert store.get_dataframe(did).equals(original)
    assert store.load_codebook(did) == book
    assert [step["operation"] for step in store.load_provenance(did)["operations"]] == ["import"]
    assert store.load_mask(did)["entries"] == []
