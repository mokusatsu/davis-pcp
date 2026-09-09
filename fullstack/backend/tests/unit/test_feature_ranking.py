"""Unit tests for Feature 14: Advanced Feature Selection and Variable Ranking."""
import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.algorithms.mining.feature_ranking import compute_feature_rankings
from app.main import app
from app.storage.dataset_store import DatasetStore

client = TestClient(app)


def test_feature_ranking_synthetic_noise():
    np.random.seed(42)
    n = 200
    # Two informative features
    x1 = np.random.normal(0, 1, n)
    x2 = np.random.normal(0, 1, n)
    # One pure noise feature
    noise = np.random.normal(0, 1, n)
    # Binary target determined primarily by x1 + x2
    y_prob = 1 / (1 + np.exp(-(2.5 * x1 + 2.0 * x2)))
    y = np.where(y_prob > 0.5, "ClassA", "ClassB")

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "target": y,
        "x1": x1,
        "x2": x2,
        "noise": noise,
    })

    res = compute_feature_rankings(
        df=df,
        feature_columns=["x1", "x2", "noise"],
        target_column="target",
        seed=42,
    )

    assert res["taskType"] == "classification"
    assert len(res["rankings"]) == 3

    # noise should be ranked lowest (3rd)
    noise_rank = next(item for item in res["rankings"] if item["variable"] == "noise")
    assert noise_rank["overallRank"] == 3


def test_feature_ranking_iris_benchmark(tmp_path):
    store = DatasetStore()
    ds_id = "test_iris_ranking"

    # Create simplified Iris fixture
    np.random.seed(42)
    n_per_class = 50
    sl = np.concatenate([np.random.normal(5.0, 0.3, n_per_class), np.random.normal(5.9, 0.5, n_per_class), np.random.normal(6.5, 0.6, n_per_class)])
    sw = np.concatenate([np.random.normal(3.4, 0.3, n_per_class), np.random.normal(2.7, 0.3, n_per_class), np.random.normal(2.9, 0.3, n_per_class)])
    pl_val = np.concatenate([np.random.normal(1.4, 0.2, n_per_class), np.random.normal(4.2, 0.4, n_per_class), np.random.normal(5.5, 0.5, n_per_class)])
    pw = np.concatenate([np.random.normal(0.2, 0.1, n_per_class), np.random.normal(1.3, 0.2, n_per_class), np.random.normal(2.0, 0.3, n_per_class)])
    species = ["setosa"] * 50 + ["versicolor"] * 50 + ["virginica"] * 50

    df = pl.DataFrame({
        "__rowId__": [f"iris_{i}" for i in range(150)],
        "Sepal.Length": sl,
        "Sepal.Width": sw,
        "Petal.Length": pl_val,
        "Petal.Width": pw,
        "Species": species,
    })

    meta = {
        "datasetId": ds_id,
        "name": "Test Iris Ranking",
        "rowCount": 150,
        "columnCount": 6,
        "fingerprint": "fp_iris_rank",
        "createdAt": "2026-09-05T00:00:00Z",
        "schema": [
            {"columnId": "c1", "name": "Sepal.Length", "semanticType": "numeric", "physicalType": "Float64", "missingCount": 0, "role": "feature"},
            {"columnId": "c2", "name": "Sepal.Width", "semanticType": "numeric", "physicalType": "Float64", "missingCount": 0, "role": "feature"},
            {"columnId": "c3", "name": "Petal.Length", "semanticType": "numeric", "physicalType": "Float64", "missingCount": 0, "role": "feature"},
            {"columnId": "c4", "name": "Petal.Width", "semanticType": "numeric", "physicalType": "Float64", "missingCount": 0, "role": "feature"},
            {"columnId": "c5", "name": "Species", "semanticType": "nominal", "physicalType": "Utf8", "missingCount": 0, "role": "target"},
        ],
    }
    store.save(ds_id, meta, df)
    store.save_codebook(ds_id, {'datasetId': ds_id, 'schemaRevision': 1, 'columns': [
        {'columnId': column['columnId'], 'name': column['name'], 'role': 'question',
         'scaleType': 'nominal' if column['name'] == 'Species' else 'ratio', 'missingCodes': []}
        for column in meta['schema']
    ]})

    resp = client.post("/api/v1/mining/feature-ranking", json={
        "datasetId": ds_id,
        "targetColumn": "Species",
        "featureColumns": ["Sepal.Length", "Sepal.Width", "Petal.Length", "Petal.Width"],
        "seed": 42,
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["taskType"] == "classification"
    ranks = {item["variable"]: item["overallRank"] for item in data["rankings"]}
    # Petal.Length and Petal.Width should dominate ranks 1 and 2
    assert ranks["Petal.Length"] in (1, 2)
    assert ranks["Petal.Width"] in (1, 2)


def test_feature_ranking_unsupervised():
    np.random.seed(42)
    n = 100
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "v1": np.random.normal(0, 10, n),  # large variance
        "v2": np.random.normal(0, 1, n),   # small variance
        "v3": np.random.normal(0, 5, n),   # medium variance
    })

    res = compute_feature_rankings(
        df=df,
        feature_columns=["v1", "v2", "v3"],
        target_column=None,
        seed=42,
    )

    assert res["taskType"] == "unsupervised"
    assert len(res["rankings"]) == 3
    # v1 with largest dispersion should rank higher than v2
    v1_rank = next(item for item in res["rankings"] if item["variable"] == "v1")
    v2_rank = next(item for item in res["rankings"] if item["variable"] == "v2")
    assert v1_rank["overallRank"] < v2_rank["overallRank"]


def test_feature_ranking_categorical_columns_and_ties():
    """Verify categorical columns produce None for fStatistic/pcaDispersion and ties get fractional ranks."""
    np.random.seed(42)
    n = 60
    # Two numeric features with identical values to force ties
    x_val = np.random.normal(0, 1, n)
    # Binary categorical feature
    cat = np.array(["GroupA" if i % 2 == 0 else "GroupB" for i in range(n)])
    # Target
    y = np.array(["Yes" if i % 3 == 0 else "No" for i in range(n)])

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "target": y,
        "x_tie1": x_val,
        "x_tie2": x_val,
        "cat_feature": cat,
    })

    res = compute_feature_rankings(
        df=df,
        feature_columns=["x_tie1", "x_tie2", "cat_feature"],
        target_column="target",
        seed=42,
    )

    rankings_by_var = {item["variable"]: item for item in res["rankings"]}
    cat_item = rankings_by_var["cat_feature"]

    # Categorical feature must have None for fStatistic and pcaDispersion
    assert cat_item["scores"]["fStatistic"] is None
    assert cat_item["scores"]["pcaDispersion"] is None
    # Categorical feature should still have valid scores for reliefF and mutualInfo
    assert cat_item["scores"]["relieff"] is not None
    assert cat_item["scores"]["mutualInfo"] is not None

    # x_tie1 and x_tie2 are identical, so their ranks on numeric methods should tie with average rank
    tie1 = rankings_by_var["x_tie1"]
    tie2 = rankings_by_var["x_tie2"]
    assert tie1["scores"]["fStatistic"]["rank"] == tie2["scores"]["fStatistic"]["rank"]
    # With two identical features out of 2 valid numeric features, both should get rank 1.5
    assert tie1["scores"]["fStatistic"]["rank"] == 1.5
    assert tie2["scores"]["fStatistic"]["rank"] == 1.5
