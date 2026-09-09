"""Feature 21: unsupported analyses return WEIGHT_UNSUPPORTED, never weighted values."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def weighted_ds():
    with TestClient(app) as client:
        text = "Q1,Q2,wt\n1,2.0,1.0\n2,3.0,2.0\n1,4.0,1.5\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("w.csv", text, "text/csv")}).json()["datasetId"]
        cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: c for c in cb["columns"]}
        by_name["wt"].update(role="weight", scaleType="ratio", label="weight")
        assert client.put(f"/api/v1/datasets/{dataset_id}/codebook",
                          json={"columns": list(by_name.values())}).status_code == 200
        yield client, dataset_id
        client.delete(f"/api/v1/datasets/{dataset_id}")


def test_relationship_matrix_reports_unsupported(weighted_ds):
    client, ds = weighted_ds
    plain = client.post("/api/v1/relationships/matrix",
                        json={"datasetId": ds, "columns": ["Q1", "Q2"]}).json()
    assert plain["weightStatus"] == "omitted" and plain["weightApplied"] is False
    assert plain["warnings"] == [] and "weightedN" not in plain
    weighted = client.post("/api/v1/relationships/matrix",
                           json={"datasetId": ds, "columns": ["Q1", "Q2"], "weightColumn": "wt"}).json()
    assert weighted["weightStatus"] == "unsupported" and weighted["weightApplied"] is False
    assert weighted["weightColumn"] == "wt" and weighted["weightColumnId"] is not None
    assert weighted["warnings"] == [{"code": "WEIGHT_UNSUPPORTED", "message": "この分析は調査ウェイトを適用しません。"}]
    assert "weightedN" not in weighted and "weighted" not in str(weighted.get("matrix"))


def test_surprise_reports_unsupported(weighted_ds):
    client, ds = weighted_ds
    res = client.post("/api/v1/relationships/surprise",
                      json={"datasetId": ds, "columns": ["Q1", "Q2"], "weightColumn": "wt"}).json()
    assert res["weightStatus"] == "unsupported" and res["weightApplied"] is False
    assert res["warnings"][0]["code"] == "WEIGHT_UNSUPPORTED"


def test_unsupported_unknown_weight_column_422(weighted_ds):
    client, ds = weighted_ds
    res = client.post("/api/v1/relationships/matrix",
                      json={"datasetId": ds, "columns": ["Q1", "Q2"], "weightColumn": "nope"})
    assert res.status_code == 422 and res.json()["error"]["code"] == "WEIGHT_COLUMN_NOT_FOUND"
