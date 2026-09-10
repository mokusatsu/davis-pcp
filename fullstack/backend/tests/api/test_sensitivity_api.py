"""Feature 24-S: sensitivity comparison, robustness rule, no auto-apply."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def sensitivity_ds():
    with TestClient(app) as client:
        # b-group mean stays above a-group mean with and without the outlier,
        # so direction is preserved and the comparison is meaningful.
        rows = [f"{'a' if i < 20 else 'b'},{10 + (i % 5) if i < 20 else (20 + (i % 5) if i < 39 else 100.0)}"
                for i in range(40)]
        text = "seg,score\n" + "\n".join(rows) + "\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("s.csv", text, "text/csv")}).json()["datasetId"]
        cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: dict(c) for c in cb["columns"]}
        by_name["score"].update(role="question")
        assert client.put(f"/api/v1/datasets/{dataset_id}/codebook",
                          json={"columns": list(by_name.values())}).status_code == 200
        yield client, dataset_id
        client.delete(f"/api/v1/datasets/{dataset_id}")


def body(ds: str, **overrides) -> dict:
    base = {"datasetId": ds, "targetColumn": "score",
            "candidate": {"type": "subgroup_diff", "groupColumn": "seg",
                          "compareGroups": ["a", "b"]},
            "outlierMethod": "standardized_deviation", "threshold": 3.0, "seed": 42}
    return {**base, **overrides}


def test_sensitivity_compares_baseline_and_excluded(sensitivity_ds):
    client, ds = sensitivity_ds
    res = client.post("/api/v1/robustness/sensitivity", json=body(ds)).json()
    assert res["method"] == "standardized_deviation" and res["threshold"] == 3.0
    assert res["confidenceMethod"] == "welch_t_interval"
    assert res["bootstrapB"] is None and res["seed"] is None
    assert res["baseline"]["n"] == 40 and res["sensitivity"]["n"] < 40
    assert res["sensitivity"]["excludedN"] == 40 - res["sensitivity"]["n"] >= 1
    assert res["baseline"]["confidenceInterval"] is not None
    assert res["sensitivity"]["confidenceInterval"] is not None
    assert res["comparison"]["directionPreserved"] is True
    assert res["comparison"]["maxRelativeChange"] == 0.20
    assert res["comparison"]["reason"] in (
        "direction_and_ci_status_preserved", "direction_or_ci_status_changed",
        "relative_change_exceeded")
    assert res["weightApplied"] is False
    assert res["outlierRowIds"], "the 100.0 row must be flagged"


def test_sensitivity_rejects_bad_target_and_threshold(sensitivity_ds):
    client, ds = sensitivity_ds
    assert client.post("/api/v1/robustness/sensitivity",
                       json=body(ds, targetColumn="missing")).status_code == 422
    assert client.post("/api/v1/robustness/sensitivity",
                       json=body(ds, threshold=-1)).status_code == 422
    assert client.post("/api/v1/robustness/sensitivity",
                       json={**body(ds), "weightColumn": "nope"}).status_code == 422


def test_existing_evaluate_untouched(sensitivity_ds):
    client, ds = sensitivity_ds
    res = client.post("/api/v1/robustness/evaluate", json={"datasetId": ds}).json()
    assert "conclusions" in res
