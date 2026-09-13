"""Feature 029 CA kernel/API tests (production)."""
from __future__ import annotations

import numpy as np
import polars as pl
from fastapi.testclient import TestClient

from app.algorithms.models.correspondence import run_ca_numeric, pearson_reference
from app.main import app

TOL = dict(rtol=1e-9, atol=1e-10)


def _table():
    return np.array([[30.0, 10.0], [10.0, 30.0]])


def test_ca01_analytic():
    k = run_ca_numeric(_table(), keep_row_index=[0, 1], keep_col_index=[0, 1])
    assert abs(k["eigenvalues"][0] - 0.25) < 1e-12
    assert abs(k["totalInertia"] - 0.25) < 1e-12
    assert all(abs(abs(v) - 0.5) < 1e-12 for v in k["f"][:, 0].tolist())
    p = pearson_reference(_table(), k["r"], k["c"], 80.0)
    assert abs(p["statistic"] - 20.0) < 1e-9
    assert p["df"] == 1


def test_ca02_scale_transpose():
    k = run_ca_numeric(_table(), keep_row_index=[0, 1], keep_col_index=[0, 1])
    k2 = run_ca_numeric(3.0 * _table(), keep_row_index=[0, 1], keep_col_index=[0, 1])
    assert np.allclose(np.abs(k2["f"]), np.abs(k["f"]), **TOL)
    kt = run_ca_numeric(_table().T, keep_row_index=[0, 1], keep_col_index=[0, 1])
    assert np.allclose(np.abs(kt["f"]), np.abs(k["g"]), **TOL)


def test_ca03_zero_inertia():
    import pytest

    with pytest.raises(ValueError, match="CA_ZERO_INERTIA"):
        run_ca_numeric(np.array([[10.0, 10.0], [10.0, 10.0]]),
                       keep_row_index=[0, 1], keep_col_index=[0, 1])


def _import_csv(client, name, df):
    r = client.post("/api/v1/datasets/import",
                    files={"file": (name, df.write_csv().encode(), "text/csv")})
    assert r.status_code == 200, r.text
    return r.json()["datasetId"]


def _codebook(client, did):
    r = client.get(f"/api/v1/datasets/{did}/codebook")
    assert r.status_code == 200
    return {x["name"]: x for x in r.json()["columns"]}


def _respondent_rows():
    rows = []
    for _ in range(30):
        rows.append(("R1", "C1"))
    for _ in range(10):
        rows.append(("R1", "C2"))
    for _ in range(10):
        rows.append(("R2", "C1"))
    for _ in range(30):
        rows.append(("R2", "C2"))
    return rows


def test_ca_api_contingency_and_respondents_agree():
    client = TestClient(app)
    did = _import_csv(client, "ca.csv", pl.DataFrame({"lab": ["R1", "R2"], "C1": [30, 10], "C2": [10, 30]}))
    cols = _codebook(client, did)
    body = {
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "input": {"kind": "contingency", "rowLabelColumn": cols["lab"]["columnId"],
                  "valueColumns": [cols["C1"]["columnId"], cols["C2"]["columnId"]],
                  "cellSemantics": "frequency", "independentCountsAcknowledged": True},
    }
    r = client.post("/api/v1/models/ca", json=body)
    assert r.status_code == 200, r.text
    tab = r.json()
    assert abs(tab["summary"]["eigenvalues"][0] - 0.25) < 1e-12
    assert tab["summary"]["pearson"]["status"] == "available"
    assert abs(tab["summary"]["pearson"]["statistic"] - 20.0) < 1e-9
    rows = _respondent_rows()
    did2 = _import_csv(client, "resp.csv",
                       pl.DataFrame({"brand": [a for a, _ in rows], "need": [b for _, b in rows]}))
    cols2 = _codebook(client, did2)
    r2 = client.post("/api/v1/models/ca", json={
        "context": {"datasetId": did2, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "input": {"kind": "respondents", "rowVariable": cols2["brand"]["columnId"],
                  "columnVariable": cols2["need"]["columnId"]}})
    assert r2.status_code == 200, r2.text
    resp = r2.json()
    assert abs(resp["summary"]["eigenvalues"][0] - 0.25) < 1e-12
    f1 = np.array([e["principalCoordinates"] for e in tab["details"]["rowCategories"]])
    f2 = np.array([e["principalCoordinates"] for e in resp["details"]["rowCategories"]])
    assert np.allclose(np.abs(f1), np.abs(f2), **TOL)


def test_ca_api_rejects():
    client = TestClient(app)
    did = _import_csv(client, "neg.csv",
                      pl.DataFrame({"lab": ["R1", "R2"], "C1": [30, -5], "C2": [10, 30]}))
    cols = _codebook(client, did)
    bad = {
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "input": {"kind": "contingency", "rowLabelColumn": cols["lab"]["columnId"],
                  "valueColumns": [cols["C1"]["columnId"], cols["C2"]["columnId"]],
                  "cellSemantics": "mass", "independentCountsAcknowledged": False},
    }
    r = client.post("/api/v1/models/ca", json=bad)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "CA_TABLE_INVALID"
    bad2 = dict(bad["input"])
    bad2["structuralZerosDeclared"] = True
    r = client.post("/api/v1/models/ca", json={"context": bad["context"], "input": bad2})
    assert r.json()["error"]["code"] == "CA_STRUCTURAL_ZERO_UNSUPPORTED"


def test_ca_select_and_or_and_stale():
    client = TestClient(app)
    rows = _respondent_rows()
    did = _import_csv(client, "s.csv",
                      pl.DataFrame({"brand": [a for a, _ in rows], "need": [b for _, b in rows]}))
    cols = _codebook(client, did)
    body = client.post("/api/v1/models/ca", json={
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "input": {"kind": "respondents", "rowVariable": cols["brand"]["columnId"],
                  "columnVariable": cols["need"]["columnId"]}}).json()
    rid = body["resultId"]
    rc = {e["code"]: e["categoryId"] for e in body["details"]["rowCategories"]}
    cc = {e["code"]: e["categoryId"] for e in body["details"]["columnCategories"]}
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none"}
    aand = client.post(f"/api/v1/analysis-results/{rid}/select",
                       json={"context": ctx,
                             "selector": {"kind": "categories",
                                          "categoryIds": [rc["R1"], cc["C1"]],
                                          "betweenVariables": "and"}}).json()
    assert aand["contextIntersectionCount"] == 30
    oor = client.post(f"/api/v1/analysis-results/{rid}/select",
                      json={"context": ctx,
                            "selector": {"kind": "categories",
                                         "categoryIds": [rc["R1"], cc["C1"]],
                                         "betweenVariables": "or"}}).json()
    assert oor["contextIntersectionCount"] == 50
    stale = client.post(f"/api/v1/analysis-results/{rid}/select",
                        json={"context": {**ctx, "expectedDataRevision": 999},
                              "selector": {"kind": "categories", "categoryIds": [rc["R1"]]}})
    assert stale.status_code == 409
    exp = client.post(f"/api/v1/analysis-results/{rid}/export",
                      json={"format": "csv", "table": "eigenvalues"}).json()
    assert exp["total"] == 1 and "eigenvalue" in exp["payload"]
    assert client.post(f"/api/v1/analysis-results/{rid}/predict",
                       json={"context": ctx}).status_code == 422
    assert client.post(f"/api/v1/analysis-results/{rid}/materialize",
                       json={"context": ctx}).status_code == 422

