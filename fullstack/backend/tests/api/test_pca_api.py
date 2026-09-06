"""API tests for PCA endpoint."""
from __future__ import annotations

import uuid
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_pca_api_iris():
    uniq_name = f"Iris (PCA test {uuid.uuid4().hex[:6]})"
    res = client.post("/api/v1/datasets/import/sample", json={"name": uniq_name})
    assert res.status_code == 200
    dataset_id = res.json()["datasetId"]

    cols = ["sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm"]
    pca_res = client.post(
        "/api/v1/models/pca",
        json={
            "datasetId": dataset_id,
            "columns": cols,
            "useCorrelation": True,
            "nComponents": 4,
        },
    )
    assert pca_res.status_code == 200
    data = pca_res.json()
    assert data["nSamples"] == 150
    assert data["nComponents"] == 4
    assert len(data["eigenvalues"]) == 4
    assert len(data["scores"]) == 150
    assert "loadings" in data
    assert "sepal_length_cm" in data["loadings"]
