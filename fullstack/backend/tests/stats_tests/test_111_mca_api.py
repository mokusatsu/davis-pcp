"""Feature 030 MCA API/rows/select/predict/materialize/export tests."""
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


def _mca_df(n=24):
    return pl.DataFrame({
        "q1": (["a", "a", "b", "b"] * ((n + 3) // 4))[:n],
        "q2": (["x", "y", "x", "y"] * ((n + 3) // 4))[:n],
        "q3": (["p", "p", "q", "q"] * ((n + 3) // 4))[:n],
    })


def _fit(client, did, cols, **kw):
    body = {"context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                        "scope": "all", "weightMode": "none"},
            "variables": [cols["q1"], cols["q2"], cols["q3"]],
            "maMode": "ordinary_only", "inertiaAdjustment": "raw"}
    body.update(kw)
    r = client.post("/api/v1/models/mca", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_mca_api_normalization_and_rows_paging():
    client = TestClient(app)
    did = _import(client, "m.csv", _mca_df())
    cols = _cols(client, did)
    fit = _fit(client, did, cols)
    assert fit["summary"]["nVariables"] == 3
    assert fit["summary"]["nCategories"] == 6
    assert abs(fit["summary"]["totalInertia"] - (6 - 3) / 3) < 1e-12
    rid = fit["resultId"]
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none"}
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
    # Fit rows keep all axes; default axes are 1..min(2,rank).
    assert len(seen[0]["coordinates"]) == 2
    g2 = client.get(f"/api/v1/analysis-results/{rid}/rows",
                    params={"offset": 0, "limit": 2, "axes": "2,1"})
    assert [len(r["coordinates"]) for r in g2.json()["rows"]] == [2, 2]
    bad = client.get(f"/api/v1/analysis-results/{rid}/rows",
                     params={"offset": 0, "limit": 2, "axes": "1,3"})
    assert bad.status_code == 422


def test_mca_api_select_rectangle_and_categories():
    client = TestClient(app)
    did = _import(client, "m.csv", _mca_df())
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
    assert both_and["contextIntersectionCount"] == 6
    assert "AND" in both_and["selectionLabel"]
    both_or = client.post(f"/api/v1/analysis-results/{rid}/select",
                          json={"context": ctx, "selector": {"kind": "categories",
                                 "categoryIds": [cat_a, cat_x], "betweenVariables": "or"}}).json()
    assert both_or["contextIntersectionCount"] == 18
    rect = client.post(f"/api/v1/analysis-results/{rid}/select",
                       json={"context": ctx, "selector": {"kind": "rectangle",
                              "axes": [1, 2], "bounds": [[-10, 10], [-10, 10]]}}).json()
    assert rect["matchedCount"] == 24
    unknown = client.post(f"/api/v1/analysis-results/{rid}/select",
                          json={"context": ctx, "selector": {"kind": "categories",
                                 "categoryIds": ["cat:dead"]}})
    assert unknown.status_code == 422


def test_mca_api_predict_and_materialize_idempotent():
    client = TestClient(app)
    did = _import(client, "m.csv", _mca_df())
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
                            "columns": [{"sourceField": "coordinate:1", "name": "MCA1"}],
                            "idempotencyKey": "k1"}).json()
    assert mat["writtenRowCount"] == 24 and mat["idempotentReplay"] is False
    stale_ctx = {**ctx, "expectedDataRevision": 2, "expectedSchemaRevision": 2}
    replay = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                         json={"context": stale_ctx, "source": "fit",
                               "columns": [{"sourceField": "coordinate:1", "name": "MCA1"}],
                               "idempotencyKey": "k1"})
    assert replay.status_code == 200 and replay.json()["idempotentReplay"] is True
    conflict = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                           json={"context": stale_ctx, "source": "fit",
                                 "columns": [{"sourceField": "coordinate:1", "name": "MCA1"}],
                                 "idempotencyKey": "k2"})
    assert conflict.status_code == 409


def test_mca_api_weights_missing_ma():
    import sys as _sys
    _sys.path.insert(0, "tests/stats_tests")
    from support import codebook as _cb, spec as _spec

    from app.storage.dataset_store import DatasetStore, dataset_fingerprint
    import uuid as _uuid

    client = TestClient(app)
    store = DatasetStore()

    def _save(data, cb):
        df = pl.DataFrame(data)
        if "__rowId__" not in df.columns:
            df = df.with_columns(pl.Series("__rowId__", [f"R{i}" for i in range(df.height)]))
        ds = "mca-x-" + _uuid.uuid4().hex[:8]
        schema = [{"name": c["name"], "semanticType": "numeric"
                   if c["scaleType"] in ["ratio", "interval", "ordinal"] else "categorical"}
                  for c in cb["columns"]]
        meta = {"datasetId": ds, "schema": schema, "schemaRevision": 1, "dataRevision": 1,
                "rowCount": df.height, "columnCount": len(schema),
                "fingerprint": dataset_fingerprint(schema, 1, df, "test")}
        store.save(ds, meta, df, cb)
        return ds

    # Missing policies: exclude drops the null row, include_missing keeps it as a category.
    did = _save({"q1": ["a", "a", "b", "b", "a", "b", None, "a"],
                 "q2": ["x", "y", "x", "y", "x", "y", "x", "y"],
                 "q3": ["p", "p", "q", "q", "p", "q", "p", "q"]},
                _cb(_spec("q1"), _spec("q2"), _spec("q3")))
    base = {"variables": ["q1", "q2", "q3"]}
    exc = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none", "missingPolicy": "exclude"}, **base}).json()
    inc = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none", "missingPolicy": "include_missing"}, **base}).json()
    assert exc["meta"]["fitCount"] == 7 and inc["meta"]["fitCount"] == 8
    assert inc["summary"]["nCategories"] == exc["summary"]["nCategories"] + 1

    # frequency integer replication equivalence.
    fcb = _cb(_spec("q1"), _spec("q2"), _spec("q3"), _spec("w", "ratio", "weight"),
              weightConfig={"weightColumnId": "w", "weightType": "frequency"})
    fdid = _save({"q1": ["a", "a", "b", "b"] * 3, "q2": ["x", "y", "x", "y"] * 3,
                  "q3": ["p", "p", "q", "q"] * 3, "w": [1, 1, 1, 1] * 3}, fcb)
    rdid = _save({"q1": ["a", "a", "b", "b"] * 6, "q2": ["x", "y", "x", "y"] * 6,
                  "q3": ["p", "p", "q", "q"] * 6}, _cb(_spec("q1"), _spec("q2"), _spec("q3")))
    fw = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": fdid, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "dataset"}, **base}).json()
    rep = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": rdid, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"}, **base}).json()
    assert np.allclose(fw["summary"]["eigenvalues"], rep["summary"]["eigenvalues"], **TOL)

    # survey x100 invariance.
    scb = _cb(_spec("q1"), _spec("q2"), _spec("q3"), _spec("w", "ratio", "weight"),
              weightConfig={"weightColumnId": "w", "weightType": "survey"})
    s1 = _save({"q1": ["a", "a", "b", "b"] * 3, "q2": ["x", "y", "x", "y"] * 3,
                "q3": ["p", "p", "q", "q"] * 3, "w": [1.0, 2.0, 1.5, 0.5] * 3}, scb)
    s2 = _save({"q1": ["a", "a", "b", "b"] * 3, "q2": ["x", "y", "x", "y"] * 3,
                "q3": ["p", "p", "q", "q"] * 3, "w": [100.0, 200.0, 150.0, 50.0] * 3}, scb)
    g1 = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": s1, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "dataset"}, **base}).json()
    g2 = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": s2, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "dataset"}, **base}).json()
    assert np.allclose(g1["summary"]["eigenvalues"], g2["summary"]["eigenvalues"], **TOL)
    c1 = [c["principalCoordinates"] for c in g1["details"]["categories"]]
    c2 = [c["principalCoordinates"] for c in g2["details"]["categories"]]
    assert np.allclose(np.abs(np.asarray(c1)), np.abs(np.asarray(c2)), **TOL)

    # MA gates: ordinary_only rejects, explicit adopts only listed children,
    # and an invalid unselected child poisons the adopted child.
    gdef = {"groupId": "ma", "label": "MA", "selectedCodes": ["1"], "unselectedCodes": ["0"],
            "allUnselectedMeaning": "valid", "optionOrder": ["x", "y"], "maxSelections": None,
            "columns": [_spec("x", multiResponseGroup="ma"), _spec("y", multiResponseGroup="ma")]}
    mcb = _cb(*gdef["columns"], _spec("q1"),
              multiResponseGroups=[{k: v for k, v in gdef.items() if k != "columns"}])
    mdid = _save({"x": [1, 1, 0, 1, 0], "y": [0, 2, 0, 1, 0],
                  "q1": ["a", "b", "a", "b", "a"]}, mcb)
    rej = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": mdid, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "variables": ["x", "q1"], "maMode": "ordinary_only"})
    assert rej.status_code == 422 and rej.json()["error"]["code"] == "MCA_MA_UNSUPPORTED"
    okm = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": mdid, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "variables": ["x", "q1"], "maMode": "explicit_binary_options"}).json()
    assert okm["meta"]["exclusionCounts"]["invalid"] == 1
    assert okm["details"]["maDiagnostics"][0]["parentId"] == "ma"


def test_mca_api_rejects_legacy_and_bad_variables():
    client = TestClient(app)
    did = _import(client, "m.csv", _mca_df())
    cols = _cols(client, did)
    base = {"context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                        "scope": "all", "weightMode": "none"},
            "variables": [cols["q1"], cols["q2"], cols["q3"]]}
    legacy = client.post("/api/v1/models/mca", json={**base, "nComponents": 2})
    assert legacy.status_code == 422
    dup = client.post("/api/v1/models/mca", json={**base, "variables": [cols["q1"], cols["q1"]]})
    assert dup.status_code == 422
    one = client.post("/api/v1/models/mca", json={**base, "variables": [cols["q1"]]})
    assert one.status_code == 422


def test_mca_review001_m001_fit_rows_reproject():
    """REVIEW-001 M001: include_missing fit rows re-project to saved F."""
    import sys as _sys
    _sys.path.insert(0, "tests/stats_tests")
    from support import codebook as _cb, spec as _spec

    from app.storage.dataset_store import DatasetStore, dataset_fingerprint
    import uuid as _uuid

    client = TestClient(app)
    store = DatasetStore()

    def _save(data, cb):
        df = pl.DataFrame(data)
        if "__rowId__" not in df.columns:
            df = df.with_columns(pl.Series("__rowId__", [f"R{i}" for i in range(df.height)]))
        ds = "mca-r1-" + _uuid.uuid4().hex[:8]
        schema = [{"name": c["name"], "semanticType": "numeric"
                   if c["scaleType"] in ["ratio", "interval"] else "categorical"}
                  for c in cb["columns"]]
        meta = {"datasetId": ds, "schema": schema, "schemaRevision": 1, "dataRevision": 1,
                "rowCount": df.height, "columnCount": len(schema),
                "fingerprint": dataset_fingerprint(schema, 1, df, "test")}
        store.save(ds, meta, df, cb)
        return ds

    did = _save({"q1": ["a", "a", "b", "b", "a", "b", None],
                 "q2": ["x", "y", "x", "y", "x", "y", "x"],
                 "q3": ["p", "p", "q", "q", "p", "q", "p"]},
                _cb(_spec("q1"), _spec("q2"), _spec("q3")))
    fit = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none", "missingPolicy": "include_missing"},
        "variables": ["q1", "q2", "q3"]}).json()
    assert fit["meta"]["fitCount"] == 7
    rid = fit["resultId"]
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none", "missingPolicy": "include_missing"}
    pred = client.post(f"/api/v1/analysis-results/{rid}/predict",
                       json={"context": ctx, "options": {}}).json()
    assert pred["summary"]["successfulPredictions"] == 7
    rows = client.get(f"/api/v1/analysis-results/{rid}/rows",
                      params={"offset": 0, "limit": 7}).json()["rows"]
    prows = client.get(f"/api/v1/analysis-results/{rid}/predictions/{pred['predictionId']}/rows",
                       params={"offset": 0, "limit": 7}).json()["rows"]
    by_id = {r["rowId"]: r["coordinates"] for r in rows}
    for r in prows:
        assert r["predictionStatus"] == "ok"
        assert np.allclose(r["coordinates"], by_id[r["rowId"]][:len(r["coordinates"])], **TOL)


def test_mca_review001_m002_idempotency_source_scope():
    """REVIEW-001 M002: source/scope changes are conflicts, identical replays succeed."""
    import sys as _sys
    _sys.path.insert(0, "tests/stats_tests")
    from support import codebook as _cb, spec as _spec

    from app.storage.dataset_store import DatasetStore, dataset_fingerprint
    import uuid as _uuid

    client = TestClient(app)
    store = DatasetStore()

    def _save(data, cb):
        df = pl.DataFrame(data)
        if "__rowId__" not in df.columns:
            df = df.with_columns(pl.Series("__rowId__", [f"R{i}" for i in range(df.height)]))
        ds = "mca-r2-" + _uuid.uuid4().hex[:8]
        schema = [{"name": c["name"], "semanticType": "numeric"
                   if c["scaleType"] in ["ratio", "interval"] else "categorical"}
                  for c in cb["columns"]]
        meta = {"datasetId": ds, "schema": schema, "schemaRevision": 1, "dataRevision": 1,
                "rowCount": df.height, "columnCount": len(schema),
                "fingerprint": dataset_fingerprint(schema, 1, df, "test")}
        store.save(ds, meta, df, cb)
        return ds

    did = _save({"q1": ["a", "a", "b", "b"] * 2, "q2": ["x", "y", "x", "y"] * 2,
                 "q3": ["p", "p", "q", "q"] * 2}, _cb(_spec("q1"), _spec("q2"), _spec("q3")))
    fit = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"}, "variables": ["q1", "q2", "q3"]}).json()
    rid = fit["resultId"]
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none"}
    pred = client.post(f"/api/v1/analysis-results/{rid}/predict",
                       json={"context": ctx, "options": {}}).json()
    cols = [{"sourceField": "coordinate:1", "name": "M9X"}]
    m1 = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                     json={"context": ctx, "source": "fit", "columns": cols,
                           "idempotencyKey": "rk-rev1"})
    assert m1.status_code == 200
    stale = {**ctx, "expectedDataRevision": 2, "expectedSchemaRevision": 2}
    diff_source = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                              json={"context": stale, "source": pred["predictionId"],
                                    "columns": cols, "idempotencyKey": "rk-rev1"})
    assert diff_source.status_code == 409
    replay = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                         json={"context": stale, "source": "fit", "columns": cols,
                               "idempotencyKey": "rk-rev1"})
    assert replay.status_code == 200 and replay.json()["idempotentReplay"] is True


def test_mca_review001_m007_categories_export_mass():
    """REVIEW-001 M007: categories export carries MCA categoryMass."""
    client = TestClient(app)
    did = _import(client, "m.csv", _mca_df())
    cols = _cols(client, did)
    fit = _fit(client, did, cols)
    rid = fit["resultId"]
    exp = client.post(f"/api/v1/analysis-results/{rid}/export",
                      json={"format": "json", "table": "categories"}).json()
    import json as _j
    body = _j.loads(exp["payload"])
    mi = body["columns"].index("mass")
    assert all(v is not None and v > 0 for v in [r[mi] for r in body["rows"]])
    for row, cat in zip(body["rows"], fit["details"]["categories"]):
        assert abs(row[mi] - cat["categoryMass"]) < 1e-12


def test_mca_review002_m001_ma_valid_reproject():
    """REVIEW-002 M001: MA valid rows re-project to saved F (indicator 1 set)."""
    import sys as _sys
    _sys.path.insert(0, "tests/stats_tests")
    from support import codebook as _cb, spec as _spec

    from app.storage.dataset_store import DatasetStore, dataset_fingerprint
    import uuid as _uuid

    client = TestClient(app)
    store = DatasetStore()

    def _save(data, cb):
        df = pl.DataFrame(data)
        if "__rowId__" not in df.columns:
            df = df.with_columns(pl.Series("__rowId__", [f"R{i}" for i in range(df.height)]))
        ds = "mca-r3-" + _uuid.uuid4().hex[:8]
        schema = [{"name": c["name"], "semanticType": "numeric"
                   if c["scaleType"] in ["ratio", "interval"] else "categorical"}
                  for c in cb["columns"]]
        meta = {"datasetId": ds, "schema": schema, "schemaRevision": 1, "dataRevision": 1,
                "rowCount": df.height, "columnCount": len(schema),
                "fingerprint": dataset_fingerprint(schema, 1, df, "test")}
        store.save(ds, meta, df, cb)
        return ds

    g = {"groupId": "ma", "label": "MA", "selectedCodes": ["1"], "unselectedCodes": ["0"],
         "allUnselectedMeaning": "valid", "optionOrder": ["x", "y"], "maxSelections": None,
         "columns": [_spec("x", multiResponseGroup="ma"), _spec("y", multiResponseGroup="ma")]}
    mcb = _cb(*g["columns"], _spec("q"),
              multiResponseGroups=[{k: v for k, v in g.items() if k != "columns"}])
    did = _save({"x": [1, 0, 1, 0, 1, 0], "y": [0, 1, 1, 0, 0, 1],
                 "q": ["a", "b", "a", "b", "a", "b"]}, mcb)
    fit = client.post("/api/v1/models/mca", json={
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "variables": ["x", "q"], "maMode": "explicit_binary_options"}).json()
    assert fit["meta"]["fitCount"] == 6
    rid = fit["resultId"]
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none"}
    pred = client.post(f"/api/v1/analysis-results/{rid}/predict",
                       json={"context": ctx, "options": {}}).json()
    assert pred["summary"]["successfulPredictions"] == 6
    rows = client.get(f"/api/v1/analysis-results/{rid}/rows",
                      params={"offset": 0, "limit": 6}).json()["rows"]
    prows = client.get(f"/api/v1/analysis-results/{rid}/predictions/{pred['predictionId']}/rows",
                       params={"offset": 0, "limit": 6}).json()["rows"]
    by_id = {r["rowId"]: r["coordinates"] for r in rows}
    for r in prows:
        assert r["predictionStatus"] == "ok"
        assert np.allclose(r["coordinates"], by_id[r["rowId"]][:len(r["coordinates"])], **TOL)
