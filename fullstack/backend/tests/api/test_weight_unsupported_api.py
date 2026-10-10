"""Feature 21: unsupported analyses return WEIGHT_UNSUPPORTED, never weighted values."""
from __future__ import annotations

import math

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


def test_clusters_disclose_unsupported_weight_without_changing_results(weighted_ds):
    client, ds = weighted_ds
    codebook_response = client.get(f"/api/v1/datasets/{ds}/codebook")
    assert codebook_response.status_code == 200
    codebook = codebook_response.json()
    assert codebook.get("weightConfig") is None
    weight = next(column for column in codebook["columns"] if column["name"] == "wt")
    assert weight["columnId"] and weight["columnId"] != "wt"
    request = {"datasetId": ds, "method": "kmeans", "columns": ["Q2"], "k": 2, "seed": 42}
    baseline = None
    for fields in ({}, {"weightColumn": None}, {"weightColumn": "wt"},
                   {"weightColumn": weight["columnId"]}):
        response = client.post("/api/v1/clusters", json={**request, **fields})
        assert response.status_code == 200
        result = response.json()
        explicit = fields.get("weightColumn") is not None
        expected = {
            "weightStatus": "unsupported" if explicit else "omitted",
            "weightApplied": False,
            "weightColumn": "wt" if explicit else None,
            "weightColumnId": weight["columnId"] if explicit else None,
            "warnings": [{"code": "WEIGHT_UNSUPPORTED", "message": "この分析は調査ウェイトを適用しません。"}]
                        if explicit else [],
        }
        assert {key: result[key] for key in expected} == expected
        assert result["weightApplied"] is False
        assert "weightedN" not in result and "weighted" not in result
        # Compare every stable value, including diagnostics, scope and PCA.
        comparable = {key: value for key, value in result.items()
                      if key not in {*expected, "resultId", "createdAt", "diagnostics"}}
        comparable["diagnostics"] = {key: value for key, value in result["diagnostics"].items()
                                    if key != "runtimeMs"}
        if baseline is None:
            baseline = comparable
            assert len(result["rowIds"]) == len(set(result["rowIds"])) == 3
            assert len(result["labels"]) == 3 and len(set(result["labels"])) == result["k"] == 2
            assert result["scopeCount"] == result["usedRows"] == 3
            assert result["excludedRowCount"] == 0 and result["scopeHash"]
            assert result["requestedColumns"] == result["usedColumns"] == result["columns"] == ["Q2"]
            assert result["schemaRevision"] == codebook["schemaRevision"]
            assert result["dataRevision"] >= 1 and result["silhouette"] is not None
            projection = result["pcaProjection"]
            assert projection is not None
            for axis in ("pc1", "pc2"):
                assert len(projection[axis]) == 3
                assert all(math.isfinite(value) for value in projection[axis])
            assert len(set(projection["pc1"])) > 1
            assert len(projection["varianceRatio"]) == 2
            assert all(math.isfinite(value) for value in projection["varianceRatio"])
        else:
            assert comparable == baseline
    # GET retains the exact fit-time payload, including explicit-weight metadata.
    stored = client.get(f"/api/v1/clusters/{result['resultId']}")
    assert stored.status_code == 200 and stored.json() == result


@pytest.mark.parametrize("weight_column,code", [
    ("nope", "WEIGHT_COLUMN_NOT_FOUND"),
    ("Q2", "WEIGHT_ROLE_INVALID"),
])
def test_clusters_reject_invalid_weight_reference(weighted_ds, weight_column, code):
    client, ds = weighted_ds
    response = client.post("/api/v1/clusters", json={
        "datasetId": ds, "method": "kmeans", "columns": ["Q2"], "k": 2, "seed": 42,
        "weightColumn": weight_column,
    })
    assert response.status_code == 422 and response.json()["error"]["code"] == code
