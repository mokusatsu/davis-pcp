"""Unit tests for Feature 02: Surprise-First Association Scoring."""
import pytest
import numpy as np
import polars as pl
from fastapi.testclient import TestClient

from app.algorithms.relationships.surprise import compute_phik_and_surprise
from app.main import app


def test_surprise_association_synthetic_correlated():
    np.random.seed(42)
    n = 150
    x = np.random.normal(0, 1, n)
    # y strongly correlated with x
    y = 2.0 * x + np.random.normal(0, 0.3, n)
    # z independent noise
    z = np.random.uniform(0, 10, n)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "col_x": x,
        "col_y": y,
        "col_z": z,
    })

    res = compute_phik_and_surprise(df, columns=["col_x", "col_y", "col_z"])
    assert "pairs" in res
    assert len(res["pairs"]) == 3  # (x,y), (x,z), (y,z)

    # (x, y) should have high strength and positive sign
    xy_pair = next(p for p in res["pairs"] if (p["x"]["name"] == "col_x" and p["y"]["name"] == "col_y") or (p["x"]["name"] == "col_y" and p["y"]["name"] == "col_x"))
    assert xy_pair["strength"] > 0.5
    assert xy_pair["primary"]["sign"] == 1
    assert xy_pair["primary"]["signed_value"] > 0.5
    assert xy_pair["surprise"]["surprise_score"] > 0


def test_surprise_association_negative_sign():
    np.random.seed(42)
    n = 100
    x = np.linspace(0, 10, n)
    y = -1.5 * x + np.random.normal(0, 0.5, n)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "x": x,
        "y": y,
    })

    res = compute_phik_and_surprise(df, columns=["x", "y"])
    assert len(res["pairs"]) == 1
    pair = res["pairs"][0]
    assert pair["primary"]["sign"] == -1
    assert pair["primary"]["signed_value"] < 0


def test_surprise_association_top_lift():
    # Build dataset with specific cell co-occurrence spike
    n = 100
    a = ["A1"] * 50 + ["A2"] * 50
    b = ["B1"] * 10 + ["B2"] * 40 + ["B1"] * 45 + ["B2"] * 5
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "cat_a": a,
        "cat_b": b,
    })

    res = compute_phik_and_surprise(df, columns=["cat_a", "cat_b"])
    assert len(res["pairs"]) == 1
    pair = res["pairs"][0]
    assert pair["top_lift"]["lift"] > 1.2
    assert len(pair["top_lift"]["row_ids"]) > 0


def test_surprise_association_pair_matrix():
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(50)],
        "v1": list(range(50)),
        "v2": [x * 2 for x in range(50)],
        "v3": [50 - x for x in range(50)],
    })

    res = compute_phik_and_surprise(df, columns=["v1", "v2", "v3"])
    matrix_info = res["pair_matrix"]
    assert len(matrix_info["columns"]) == 3
    assert len(matrix_info["matrix"]) == 3
    assert len(matrix_info["matrix"][0]) == 3


def test_surprise_association_api():
    client = TestClient(app)
    # Import Iris dataset sample if needed
    import_resp = client.post("/api/v1/datasets/import/sample", json={"name": "Iris Sample"})
    assert import_resp.status_code == 200
    dataset_id = import_resp.json()["datasetId"]

    resp = client.post("/api/v1/relationships/surprise", json={
        "datasetId": dataset_id,
        "wStrength": 0.6,
        "wUnexpected": 0.4,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "pairs" in body
    assert "pair_matrix" in body
    assert len(body["pairs"]) > 0
