"""Unit tests for Feature 05: Penalty-Reward Analysis (PRA)."""
import pytest
import numpy as np
import polars as pl
from fastapi.testclient import TestClient

from app.algorithms.pra.engine import evaluate_penalty_reward
from app.main import app


def test_pra_basic_attribute_classification():
    np.random.seed(42)
    n = 150
    # Create an attribute where LOW score heavily penalizes satisfaction, but HIGH gives almost no reward (Basic quality)
    q_quality = np.random.choice([1.0, 2.0, 3.0, 4.0, 5.0], size=n, p=[0.2, 0.2, 0.2, 0.2, 0.2])
    
    sat = np.zeros(n)
    for i, val in enumerate(q_quality):
        if val <= 2.0:
            sat[i] = 1.5 + np.random.normal(0, 0.3)
        elif val == 3.0:
            sat[i] = 3.5 + np.random.normal(0, 0.3)
        else:
            sat[i] = 3.8 + np.random.normal(0, 0.3)  # high barely improves over neutral

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "overall_sat": sat,
        "quality": q_quality,
    })

    res = evaluate_penalty_reward(
        df=df,
        outcome="overall_sat",
        attributes=["quality"],
        scale_min=1.0,
        scale_max=5.0,
        neutral_point=3.0,
    )

    assert len(res["attributes"]) == 1
    attr = res["attributes"][0]
    assert attr["classification"] == "basic"
    assert attr["penalty"]["coef"] < 0
    assert abs(attr["penalty"]["coef"]) > abs(attr["reward"]["coef"])
    assert len(attr["dissatisfied_row_ids"]) > 0


def test_pra_excitement_attribute_classification():
    np.random.seed(42)
    n = 150
    # Create attribute where LOW score does NOT drop satisfaction below neutral, but HIGH score gives huge boost (Delighter)
    q_delight = np.random.choice([1.0, 2.0, 3.0, 4.0, 5.0], size=n, p=[0.2, 0.2, 0.2, 0.2, 0.2])

    sat = np.zeros(n)
    for i, val in enumerate(q_delight):
        if val <= 2.0:
            sat[i] = 3.0 + np.random.normal(0, 0.3)  # low has little penalty
        elif val == 3.0:
            sat[i] = 3.2 + np.random.normal(0, 0.3)
        else:
            sat[i] = 5.0 + np.random.normal(0, 0.3)  # high gives big jump

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "overall_sat": sat,
        "delight": q_delight,
    })

    res = evaluate_penalty_reward(
        df=df,
        outcome="overall_sat",
        attributes=["delight"],
        scale_min=1.0,
        scale_max=5.0,
        neutral_point=3.0,
    )

    assert len(res["attributes"]) == 1
    attr = res["attributes"][0]
    assert attr["classification"] == "excitement"
    assert attr["reward"]["coef"] > 0
    assert abs(attr["reward"]["coef"]) > abs(attr["penalty"]["coef"])


def test_pra_api():
    client = TestClient(app)
    import_resp = client.post("/api/v1/datasets/import/sample", json={"name": "Iris Sample"})
    dataset_id = import_resp.json()["datasetId"]

    resp = client.post("/api/v1/pra/evaluate", json={
        "datasetId": dataset_id,
        "outcome": "petal_width_cm",
        "attributes": ["sepal_length_cm", "sepal_width_cm", "petal_length_cm"],
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"]["name"] == "petal_width_cm"
    assert len(body["attributes"]) == 3
    assert "all_basic_dissatisfied_row_ids" in body


def test_pra_performance_symmetric_classification():
    # Performance attribute: Low penalizes by -1.5, High rewards by +1.5 symmetrically
    np.random.seed(42)
    n = 150
    q = np.random.choice([1.0, 2.0, 3.0, 4.0, 5.0], size=n)
    sat = np.zeros(n)
    for i, v in enumerate(q):
        if v <= 2.0:
            sat[i] = 2.0 + np.random.normal(0, 0.2)
        elif v == 3.0:
            sat[i] = 3.5 + np.random.normal(0, 0.2)
        else:
            sat[i] = 5.0 + np.random.normal(0, 0.2)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "sat": sat,
        "speed": q,
    })
    res = evaluate_penalty_reward(
        df=df,
        outcome="sat",
        attributes=["speed"],
        scale_min=1.0,
        scale_max=5.0,
        neutral_point=3.0,
    )
    assert len(res["attributes"]) == 1
    attr = res["attributes"][0]
    assert attr["classification"] == "performance"
    assert attr["penalty"]["coef"] < 0
    assert attr["reward"]["coef"] > 0
