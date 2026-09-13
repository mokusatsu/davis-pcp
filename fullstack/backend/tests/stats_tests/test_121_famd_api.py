"""Feature 031 FAMD API/rows/select/predict/materialize/export tests."""
from __future__ import annotations

import numpy as np
import polars as pl
from fastapi.testclient import TestClient

from app.main import app

TOL = dict(rtol=1e-9, atol=1e-10)


def _import(client, name, df):
    r = client.post("/api/v1/datasets/import",
                    files={"file": (name, df.write_csv().encode(), "text/csv")})
    assert r.status_code == 200, r.text
    return r.json()["datasetId"]


def _cols(client, did):
    r = client.get(f"/api/v1/datasets/{did}/codebook")
    assert r.status_code == 200
    return {x["name"]: x["columnId"] for x in r.json()["columns"]}


def _famd_df():
    n = 24
    return pl.DataFrame({
        "age": [20.0 + i for i in range(n)],
        "sat": [float((i % 5) + 1) for i in range(n)],
        "q1": (["a", "a", "b", "b", "c", "c"] * 4)[:n],
        "q2": (["x", "y"] * 12)[:n],
    })


def _fit(client, did, cols, **kw):
    body = {"context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                        "scope": "all", "weightMode": "none"},
            "numericVariables": [cols["age"], cols["sat"]],
            "categoricalVariables": [cols["q1"], cols["q2"]]}
    body.update(kw)
    r = client.post("/api/v1/models/famd", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_famd_api_normalization_and_rows_paging():
    client = TestClient(app)
    did = _import(client, "f.csv", _famd_df())
    cols = _cols(client, did)
    fit = _fit(client, did, cols)
    assert fit["summary"]["coordinateConvention"] == "weighted_individual_barycenter"
    assert fit["summary"]["nNumericVariables"] == 2
    assert fit["summary"]["nCategoricalVariables"] == 2
    # p=2, K1=3, K2=2 -> 2 + 2 + 1 = 5.
    assert abs(fit["summary"]["totalInertia"] - 5.0) < 1e-9
    rid = fit["resultId"]
    seen = []
    offset: int | None = 0
    while offset is not None:
        g = client.get(f"/api/v1/analysis-results/{rid}/rows",
                       params={"offset": offset, "limit": 5})
        assert g.status_code == 200, g.text
        page = g.json()
        assert page["total"] == 24
        seen.extend(page["rows"])
        offset = page["nextOffset"]
    assert len(seen) == 24
    assert len(seen[0]["coordinates"]) == 2
    bad = client.get(f"/api/v1/analysis-results/{rid}/rows",
                     params={"offset": 0, "limit": 2, "axes": "1,99"})
    assert bad.status_code == 422


def test_famd_api_select_categories_and_rectangle():
    client = TestClient(app)
    did = _import(client, "f.csv", _famd_df())
    cols = _cols(client, did)
    fit = _fit(client, did, cols)
    rid = fit["resultId"]
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none"}
    cat_a = next(c["categoryId"] for c in fit["details"]["categories"]
                 if c["variableId"] == cols["q1"] and c["code"] == "a")
    cat_x = next(c["categoryId"] for c in fit["details"]["categories"]
                 if c["variableId"] == cols["q2"] and c["code"] == "x")
    both_and = client.post(f"/api/v1/analysis-results/{rid}/select",
                           json={"context": ctx, "selector": {"kind": "categories",
                                  "categoryIds": [cat_a, cat_x], "betweenVariables": "and"}}).json()
    assert both_and["contextIntersectionCount"] == 4
    both_or = client.post(f"/api/v1/analysis-results/{rid}/select",
                          json={"context": ctx, "selector": {"kind": "categories",
                                 "categoryIds": [cat_a, cat_x], "betweenVariables": "or"}}).json()
    assert both_or["contextIntersectionCount"] == 16
    rect = client.post(f"/api/v1/analysis-results/{rid}/select",
                       json={"context": ctx, "selector": {"kind": "rectangle",
                              "axes": [1, 2], "bounds": [[-10, 10], [-10, 10]]}}).json()
    assert rect["matchedCount"] == 24
    unknown = client.post(f"/api/v1/analysis-results/{rid}/select",
                          json={"context": ctx, "selector": {"kind": "categories",
                                 "categoryIds": ["cat:dead"]}})
    assert unknown.status_code == 422


def test_famd_api_predict_materialize_export_and_rejections():
    client = TestClient(app)
    did = _import(client, "f.csv", _famd_df())
    cols = _cols(client, did)
    fit = _fit(client, did, cols)
    rid = fit["resultId"]
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none"}
    pred = client.post(f"/api/v1/analysis-results/{rid}/predict",
                       json={"context": ctx, "options": {}}).json()
    assert pred["summary"]["successfulPredictions"] == 24
    rows = client.get(f"/api/v1/analysis-results/{rid}/predictions/{pred['predictionId']}/rows",
                      params={"offset": 0, "limit": 24}).json()
    fit_rows = client.get(f"/api/v1/analysis-results/{rid}/rows",
                          params={"offset": 0, "limit": 24}).json()
    by_id = {r["rowId"]: r["coordinates"] for r in fit_rows["rows"]}
    for r in rows["rows"]:
        assert r["predictionStatus"] == "ok"
        assert np.allclose(r["coordinates"], by_id[r["rowId"]][:len(r["coordinates"])], **TOL)
    mat = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                      json={"context": ctx, "source": "fit",
                            "columns": [{"sourceField": "coordinate:1", "name": "FAMD1"}],
                            "idempotencyKey": "famd-k1"}).json()
    assert mat["writtenRowCount"] == 24 and mat["idempotentReplay"] is False
    stale_ctx = {**ctx, "expectedDataRevision": 2, "expectedSchemaRevision": 2}
    replay = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                         json={"context": stale_ctx, "source": "fit",
                               "columns": [{"sourceField": "coordinate:1", "name": "FAMD1"}],
                               "idempotencyKey": "famd-k1"})
    assert replay.status_code == 200 and replay.json()["idempotentReplay"] is True
    # variable / categories export tables.
    exp_v = client.post(f"/api/v1/analysis-results/{rid}/export",
                        json={"format": "json", "table": "variables"}).json()
    import json as _j
    body_v = _j.loads(exp_v["payload"])
    assert "variableId" in body_v["columns"] and len(body_v["rows"]) == 4
    exp_c = client.post(f"/api/v1/analysis-results/{rid}/export",
                        json={"format": "json", "table": "categories"}).json()
    body_c = _j.loads(exp_c["payload"])
    assert len(body_c["rows"]) == 5
    # Rejections: numeric-only via categorical misuse, duplicates, constant.
    # NOTE: materialize above bumped schemaRevision 1->2; use live revisions here.
    live = client.get(f"/api/v1/datasets/{did}").json()
    base = {"context": {"datasetId": did, "expectedDataRevision": live["dataRevision"],
                        "expectedSchemaRevision": live["schemaRevision"], "scope": "all", "weightMode": "none"}}
    dup = client.post("/api/v1/models/famd", json={
        **base, "numericVariables": [cols["age"]], "categoricalVariables": [cols["age"]]})
    assert dup.status_code == 422
    bad_scale = client.post("/api/v1/models/famd", json={
        **base, "numericVariables": [cols["q1"]], "categoricalVariables": [cols["q2"]]})
    assert bad_scale.status_code == 422
    assert bad_scale.json()["error"]["code"] == "FAMD_SCALE_INVALID"
