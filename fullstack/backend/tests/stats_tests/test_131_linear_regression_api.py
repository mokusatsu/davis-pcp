"""Feature 032 linear regression API tests."""
from __future__ import annotations
import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient
from app.main import app
TOL = dict(rtol=1e-9, atol=1e-10)
def _import(client, name, df):
    r = client.post("/api/v1/datasets/import", files={"file": (name, df.write_csv().encode(), "text/csv")})
    assert r.status_code == 200, r.text
    return r.json()["datasetId"]
def _cols(client, did):
    r = client.get(f"/api/v1/datasets/{did}/codebook")
    assert r.status_code == 200
    return {x["name"]: x["columnId"] for x in r.json()["columns"]}
def _lrdf():
    return pl.DataFrame({"y": [2.2,1.4,3.1,3.1,3.1,4.9,4.7,4.9,5.8,6.0], "x": [0.0,0.333,0.667,1.0,1.333,1.667,2.0,2.333,2.667,3.0], "g": ["a","b","a","b","b","a","a","b","a","b"]})
def _fit(client, did, cols, **kw):
    body = {"context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none"}, "target": cols["y"], "predictors": [{"columnId": cols["x"], "kind": "numeric"}, {"columnId": cols["g"], "kind": "categorical"}], "interactions": [], "intercept": True, "covariance": "classical", "confidenceLevel": 0.95}
    body.update(kw)
    r = client.post("/api/v1/models/linear-regression", json=body)
    assert r.status_code == 200, r.text
    return r.json()
def test_lr_api_fit_rows_select_predict_materialize():
    client = TestClient(app)
    did = _import(client, "a.csv", _lrdf())
    cols = _cols(client, did)
    fit = _fit(client, did, cols)
    assert fit["summary"]["covarianceMethod"] == "classical"
    assert fit["summary"]["inferenceStatus"] == "available"
    assert len(fit["details"]["coefficients"]) == 3
    rid = fit["resultId"]
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none"}
    seen = []; off = 0
    while off is not None:
        g = client.get(f"/api/v1/analysis-results/{rid}/rows", params={"offset": off, "limit": 4})
        assert g.status_code == 200, g.text
        pg = g.json(); assert pg["total"] == 10; seen.extend(pg["rows"]); off = pg["nextOffset"]
    assert len(seen) == 10
    bad = client.get(f"/api/v1/analysis-results/{rid}/rows", params={"offset": 0, "limit": 2, "axes": "1"})
    assert bad.status_code == 422
    sel = client.post(f"/api/v1/analysis-results/{rid}/select", json={"context": ctx, "selector": {"kind": "diagnostic_rectangle", "xField": "fitted", "yField": "residual", "xBounds": [0, 10], "yBounds": [-10, 10]}}).json()
    assert sel["matchedCount"] == 10 and sel["contextIntersectionCount"] == 10
    pred = client.post(f"/api/v1/analysis-results/{rid}/predict", json={"context": ctx, "options": {"interval": "mean_ci", "evaluate": True}}).json()
    assert pred["summary"]["successfulPredictions"] == 10
    pid = pred["predictionId"]
    pr = client.get(f"/api/v1/analysis-results/{rid}/predictions/" + pid + "/rows", params={"offset": 0, "limit": 10}).json()
    assert pr["total"] == 10 and pr["rows"][0]["predictionStatus"] == "ok"
    mat = client.post(f"/api/v1/analysis-results/{rid}/materialize", json={"context": ctx, "source": "fit", "columns": [{"sourceField": "fitted", "name": "LR_FIT"}], "idempotencyKey": "k1"}).json()
    assert mat["writtenRowCount"] == 10 and mat["idempotentReplay"] is False
def test_lr_api_rejects_bad_design_and_covariance():
    client = TestClient(app)
    did = _import(client, "b.csv", _lrdf())
    cols = _cols(client, did)
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none"}
    base = {"context": ctx, "target": cols["y"], "intercept": True, "covariance": "auto", "confidenceLevel": 0.95}
    r1 = client.post("/api/v1/models/linear-regression", json=dict(base, predictors=[{"columnId": cols["y"], "kind": "numeric"}]))
    assert r1.status_code == 422
    r2 = client.post("/api/v1/models/linear-regression", json=dict(base, predictors=[{"columnId": cols["x"], "kind": "numeric"}], interactions=[[cols["x"], cols["x"]]]))
    assert r2.status_code == 422
    r3 = client.post("/api/v1/models/linear-regression", json=dict(base, predictors=[{"columnId": cols["x"], "kind": "numeric"}], covariance="taylor"))
    assert r3.status_code == 422 and r3.json()["error"]["code"] == "LR_COVARIANCE_WEIGHT_CONFLICT"
    r4 = client.post("/api/v1/models/linear-regression", json=dict(base, target=cols["x"], predictors=[{"columnId": cols["x"], "kind": "numeric"}]))
    assert r4.status_code == 422
def test_lr_api_interaction_and_reference():
    client = TestClient(app)
    did = _import(client, "c.csv", _lrdf())
    cols = _cols(client, did)
    fit = _fit(client, did, cols, interactions=[[cols["x"], cols["g"]]])
    assert len(fit["details"]["coefficients"]) == 4
    assert fit["details"]["categoryReferences"][0]["referenceCode"] in ("a", "b")
    exp = client.post("/api/v1/analysis-results/" + fit["resultId"] + "/export", json={"format": "json", "table": "coefficients", "offset": 0, "limit": 10}).json()
    assert exp["total"] == 4
