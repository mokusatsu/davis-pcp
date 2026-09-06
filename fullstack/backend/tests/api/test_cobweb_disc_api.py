"""API integration tests for Cobweb and DISC clustering endpoints."""
from __future__ import annotations

import sys
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))

from app.main import app

client = TestClient(app)

NUMERIC_COLS = ["sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm"]


@pytest.fixture(scope="module")
def iris_id() -> str:
    response = client.post("/api/v1/datasets/import/sample", json={"name": "Iris"})
    assert response.status_code == 200
    return response.json()["datasetId"]


def test_cobweb_api(iris_id):
    r = client.post(
        "/api/v1/clusters",
        json={
            "datasetId": iris_id,
            "method": "cobweb",
            "columns": NUMERIC_COLS,
            "k": 3,
            "acuity": 0.1,
            "cutoff": 0.001,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["method"] == "cobweb"
    assert body["k"] >= 2
    assert "conceptTree" in body
    assert body["conceptTree"]["count"] == 150
    assert len(body["labels"]) == 150


def test_disc_api(iris_id):
    r = client.post(
        "/api/v1/clusters",
        json={
            "datasetId": iris_id,
            "method": "disc",
            "columns": NUMERIC_COLS,
            "k": 3,
            "seed": 42,
            "alphaSmooth": 0.6,
            "numWeight": 1.0,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["method"] == "disc"
    assert body["k"] == 3
    assert "categoryMatrices" in body
    assert len(body["labels"]) == 150
