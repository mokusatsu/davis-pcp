"""Unit tests for Feature 04: Key Driver Analysis (KDA)."""
import pytest
import numpy as np
import polars as pl
from fastapi.testclient import TestClient

from app.algorithms.models.kda import run_kda
from app.main import app


def test_kda_shapley_sum_property():
    np.random.seed(42)
    n = 100
    x1 = np.random.normal(0, 1, n)
    x2 = np.random.normal(0, 1, n)
    x3 = np.random.normal(0, 1, n)
    # y is strong linear combination
    y = 3.0 * x1 + 1.5 * x2 + 0.2 * x3 + np.random.normal(0, 0.5, n)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "target": y,
        "d1": x1,
        "d2": x2,
        "d3": x3,
    })

    res = run_kda(df, outcome="target", drivers=["d1", "d2", "d3"])
    
    full_r2 = res["model"]["r_squared"]
    shapley_sum = sum(d["importance_raw"] for d in res["drivers"])
    # Sum of Shapley values must equal full R2
    assert math_close(shapley_sum, full_r2, tol=0.01)

    # d1 must have highest importance
    top_driver = res["drivers"][0]
    assert top_driver["name"] == "d1"
    assert top_driver["importance_pct"] > res["drivers"][1]["importance_pct"]
    assert top_driver["direction"] == 1


def test_kda_multicollinearity_vif():
    np.random.seed(42)
    n = 100
    x1 = np.random.normal(0, 1, n)
    # x2 collinear with x1
    x2 = x1 * 0.98 + np.random.normal(0, 0.05, n)
    x3 = np.random.normal(0, 1, n)
    y = 2.0 * x1 + 0.5 * x3 + np.random.normal(0, 0.5, n)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "y": y,
        "x1": x1,
        "x2": x2,
        "x3": x3,
    })

    res = run_kda(df, outcome="y", drivers=["x1", "x2", "x3"])
    assert res["model"]["vif_max"] > 5.0
    assert "warnings" in res["model"]


def test_kda_api():
    client = TestClient(app)
    import_resp = client.post("/api/v1/datasets/import/sample", json={"name": "Iris Sample"})
    dataset_id = import_resp.json()["datasetId"]

    resp = client.post("/api/v1/models/kda", json={
        "datasetId": dataset_id,
        "outcome": "petal_width_cm",
        "drivers": ["sepal_length_cm", "sepal_width_cm", "petal_length_cm"],
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"]["name"] == "petal_width_cm"
    assert len(body["drivers"]) == 3
    assert "what_if_baseline" in body


def test_kda_zero_variance_driver_handling():
    # Verify driver with 0 variance is handled without numerical breakdown and generates warning
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(30)],
        "target": [float(i) for i in range(30)],
        "d_const": [5.0] * 30,
        "d_var": [float(i * 2) for i in range(30)],
    })
    res = run_kda(df, outcome="target", drivers=["d_const", "d_var"])
    assert res["model"]["r_squared"] > 0.9
    assert any("d_const" in w for w in res["model"]["warnings"])


def math_close(a: float, b: float, tol: float = 0.01) -> bool:
    return abs(a - b) <= tol
