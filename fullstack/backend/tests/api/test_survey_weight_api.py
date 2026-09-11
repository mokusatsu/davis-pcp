"""Feature 21: survey weight contracts on POST /summaries (applied/invalid/omitted)."""
from __future__ import annotations

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def weighted():
    with TestClient(app) as client:
        text = (
            "Q1,wt\n"
            + "\n".join(f"{code},{w}" for code, w in
                         [("1", 1.0), ("1", 2.0), ("2", 3.0), ("2", 0.0), ("9", 5.0), ("2", "")])
        ) + "\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("w.csv", text, "text/csv")}).json()["datasetId"]
        cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: c for c in cb["columns"]}
        by_name["Q1"].update(role="question", scaleType="ordinal",
                             categoryOrder=["1", "2"], valueLabels={"1": "low", "2": "high"},
                             missingCodes=["99"], missingReasons={"99": "無回答"})
        by_name["wt"].update(role="weight", scaleType="ratio", label="weight")
        put = client.put(f"/api/v1/datasets/{dataset_id}/codebook",
                         json={"columns": list(by_name.values())})
        assert put.status_code == 200, put.text
        confirm = {c["name"]: c for c in
                   client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()["columns"]}
        assert confirm["wt"]["role"] == "weight", confirm["wt"]
        yield client, dataset_id
        client.delete(f"/api/v1/datasets/{dataset_id}")


def test_weighted_mean_counts_pct_match_hand_values(weighted):
    client, ds = weighted
    body = {"datasetId": ds, "columns": ["Q1"], "weightColumn": "wt"}
    response = client.post("/api/v1/summaries", json=body)
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["weightStatus"] == "applied" and res["weightApplied"] is True, res
    assert res["weightColumn"] == "wt" and res["unweightedN"] == 6
    # Scope-level legacy weightedN still describes all six respondents:
    # weights 1,2,3,0,5,null sum to 11; this is NOT Q1's valid denominator.
    # AV02: code 9 is invalid outside the declared ["1", "2"] domain.
    assert res["weightedN"] == 11.0 and res["weightMissingCount"] == 1
    col = res["columns"]["Q1"]["weighted"]
    by_code = {d["code"]: d for d in col["distribution"]}
    assert set(by_code) == {"1", "2"}, "invalid code 9 must not become rank 3"
    assert col["weightedN"] == 6.0
    assert by_code["1"]["weightedCount"] == 3.0
    assert by_code["2"]["weightedCount"] == 3.0
    assert by_code["1"]["weightedPct"] == 50.0
    assert by_code["2"]["weightedPct"] == 50.0
    assert sum(d["weightedCount"] for d in by_code.values()) == col["weightedN"]
    # The invalid response's weight 5 contributes neither to the numerator
    # nor to Q1's denominator: (1*1 + 1*2 + 2*3) / (1+2+3) = 1.5.
    assert col["weightedMean"] == 1.5
    assert col["meanNote"] == "等間隔得点として計算"
    # Zero/missing weights do not invalidate the corresponding raw answers.
    # The five valid unweighted answers are [1,1,2,2,2].
    assert res["columns"]["Q1"]["denominators"]["valid"] == 5
    assert res["columns"]["Q1"]["count"] == 5
    assert res["columns"]["Q1"]["mean"] == pytest.approx(1.6)


def test_weight_null_omitted_and_zero_weight_excluded(weighted):
    client, ds = weighted
    plain = client.post("/api/v1/summaries", json={"datasetId": ds, "columns": ["Q1"]}).json()
    assert plain["weightStatus"] == "omitted" and plain["weightApplied"] is False
    assert "weighted" not in plain["columns"]["Q1"]
    nulled = client.post("/api/v1/summaries",
                         json={"datasetId": ds, "columns": ["Q1"], "weightColumn": None}).json()
    assert nulled["weightStatus"] == "omitted"


def test_weight_negative_rejected_and_unknown_column_422(weighted):
    client, ds = weighted
    neg = client.post("/api/v1/datasets/import",
                      files={"file": ("neg.csv", "Q1,wt\n1,-1.0\n", "text/csv")}).json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{neg}/codebook").json()
    by_name = {c["name"]: c for c in cb["columns"]}
    by_name["wt"].update(role="weight", scaleType="ratio")
    client.put(f"/api/v1/datasets/{neg}/codebook", json={"columns": list(by_name.values())})
    try:
        bad = client.post("/api/v1/summaries", json={"datasetId": neg, "columns": ["Q1"], "weightColumn": "wt"})
        assert bad.status_code == 422 and bad.json()["error"]["code"] == "WEIGHT_VALUE_INVALID"
        missing = client.post("/api/v1/summaries", json={"datasetId": ds, "columns": ["Q1"], "weightColumn": "nope"})
        assert missing.status_code == 422 and missing.json()["error"]["code"] == "WEIGHT_COLUMN_NOT_FOUND"
        not_weight = client.post("/api/v1/summaries", json={"datasetId": ds, "columns": ["Q1"], "weightColumn": "Q1"})
        assert not_weight.status_code == 422 and not_weight.json()["error"]["code"] == "WEIGHT_ROLE_INVALID"
    finally:
        client.delete(f"/api/v1/datasets/{neg}")


def test_weight_no_positive_returns_status_not_values(weighted):
    client, ds = weighted
    zero = client.post("/api/v1/datasets/import",
                       files={"file": ("zero.csv", "Q1,wt\n1,0.0\n2,0.0\n", "text/csv")}).json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{zero}/codebook").json()
    by_name = {c["name"]: c for c in cb["columns"]}
    by_name["wt"].update(role="weight", scaleType="ratio")
    client.put(f"/api/v1/datasets/{zero}/codebook", json={"columns": list(by_name.values())})
    try:
        res = client.post("/api/v1/summaries", json={"datasetId": zero, "columns": ["Q1"], "weightColumn": "wt"}).json()
        assert res["weightStatus"] == "no_positive_weight" and res["weightApplied"] is False
        assert res["weightedN"] is None
        assert res["columns"]["Q1"]["weighted"]["weightedMean"] is None
    finally:
        client.delete(f"/api/v1/datasets/{zero}")


def test_weight_cache_key_includes_weight_column(weighted):
    client, ds = weighted
    body = {"datasetId": ds, "columns": ["Q1"]}
    first = client.post("/api/v1/summaries", json=body).json()
    second = client.post("/api/v1/summaries", json={**body, "weightColumn": "wt"}).json()
    assert second.get("cacheHit") is not True
    assert second["weightStatus"] == "applied"
    third = client.post("/api/v1/summaries", json={**body, "weightColumn": "wt"}).json()
    assert third.get("cacheHit") is True
    assert "weighted" not in first["columns"]["Q1"]
