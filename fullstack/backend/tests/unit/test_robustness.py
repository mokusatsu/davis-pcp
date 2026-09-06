"""Unit tests for Feature 03: Robustness & Sensitivity Analysis."""
import pytest
import numpy as np
import polars as pl
from fastapi.testclient import TestClient

from app.algorithms.robustness.engine import evaluate_robustness
from app.main import app


def test_robustness_kpi_evaluation():
    np.random.seed(42)
    n = 100
    # Clean normal distribution
    vals = np.random.normal(50.0, 5.0, n)
    # Add 2 extreme outlier respondents
    vals[0] = 200.0
    vals[1] = 200.0

    df = pl.DataFrame({
        "__rowId__": [f"resp_{i}" for i in range(n)],
        "satisfaction": vals,
    })

    res = evaluate_robustness(
        df=df,
        conclusions=[{
            "id": "c1",
            "type": "kpi",
            "metric": "satisfaction",
            "label": "顧客満足度平均",
            "target_col": "satisfaction",
        }],
        removal_fractions=[0.0, 0.05, 0.10, 0.20],
        bootstrap_b=50,
    )

    assert len(res["conclusions"]) == 1
    c = res["conclusions"][0]
    assert c["robustness"]["grade"] in ("robust", "mostly_robust", "somewhat_sensitive", "fragile")
    assert len(c["sweep_curve"]) == 4
    assert len(c["perturbations"]) >= 4

    # Top influential respondents should catch the outliers resp_0 or resp_1
    top_resp_ids = [r["row_id"] for r in c["top_influence_respondents"]]
    assert "resp_0" in top_resp_ids or "resp_1" in top_resp_ids


def test_robustness_subgroup_diff():
    np.random.seed(42)
    n = 80
    grps = ["GroupA"] * 40 + ["GroupB"] * 40
    score = list(np.random.normal(10.0, 1.0, 40)) + list(np.random.normal(15.0, 1.0, 40))

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "segment": grps,
        "nps": score,
    })

    res = evaluate_robustness(
        df=df,
        conclusions=[{
            "id": "c2",
            "type": "subgroup_diff",
            "metric": "nps_diff",
            "target_col": "nps",
            "group_col": "segment",
            "compare_groups": ["GroupA", "GroupB"],
        }],
        bootstrap_b=30,
    )

    assert len(res["conclusions"]) == 1
    c = res["conclusions"][0]
    assert c["full_estimate"] < 0  # GroupA - GroupB = -5.0
    assert c["robustness"]["grade"] in ("robust", "mostly_robust")


def test_robustness_auto_conclusions_and_api():
    client = TestClient(app)
    import_resp = client.post("/api/v1/datasets/import/sample", json={"name": "Iris Sample"})
    dataset_id = import_resp.json()["datasetId"]

    # Call evaluate without specifying conclusions -> auto-generates
    resp = client.post("/api/v1/robustness/evaluate", json={
        "datasetId": dataset_id,
        "bootstrapB": 20,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "conclusions" in body
    assert len(body["conclusions"]) >= 1


def test_robustness_subgroup_diff_integer_column():
    # Verify integer group column does not raise ComputeError when compared with string groups
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(20)],
        "int_group": [1] * 10 + [2] * 10,
        "satisfaction": [3.0] * 10 + [4.5] * 10,
    })
    res = evaluate_robustness(
        df=df,
        conclusions=[{
            "id": "c_int",
            "type": "subgroup_diff",
            "metric": "sat_diff",
            "target_col": "satisfaction",
            "group_col": "int_group",
            "compare_groups": ["1", "2"],
        }],
        bootstrap_b=20,
    )
    assert len(res["conclusions"]) == 1
    c = res["conclusions"][0]
    assert abs(c["full_estimate"] - (-1.5)) < 1e-4


def test_robustness_exact_analytic_influence():
    # Verify exact analytic influence formula matches manual leave-one-out for subgroup diff
    # G1: [2, 2, 8] (mean=4, n=3). Outlier x_i=8: removing it gives mean 2, diff change (8-4)/(3-1) = 2.0
    # G2: [5, 5, 5] (mean=5, n=3)
    df = pl.DataFrame({
        "__rowId__": ["r0", "r1", "r2", "r3", "r4", "r5"],
        "grp": ["G1", "G1", "G1", "G2", "G2", "G2"],
        "val": [2.0, 2.0, 8.0, 5.0, 5.0, 5.0],
    })
    res = evaluate_robustness(
        df=df,
        conclusions=[{
            "id": "c_exact",
            "type": "subgroup_diff",
            "metric": "val_diff",
            "target_col": "val",
            "group_col": "grp",
            "compare_groups": ["G1", "G2"],
        }],
        bootstrap_b=10,
    )
    c = res["conclusions"][0]
    top_r = c["top_influence_respondents"][0]
    assert top_r["row_id"] == "r2"
    assert abs(top_r["influence"] - 2.0) < 1e-6
