"""API tests for Feature 034 conjoint (CJ01/CJ03-CJ07 slice)."""
from __future__ import annotations

import sys
from pathlib import Path

import polars as pl

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def _import_choice_dataset():
    rows = []
    n = 0
    for r in range(1, 9):
        for alt, brand in (("A1", "A"), ("A2", "B")):
            n += 1
            chosen = 1 if (brand == "A") == (r % 4 != 0) else 0
            rows.append({"respondent_id": f"P{r}",
                         "task_id": "T1", "alternative_id": alt,
                         "brand": brand, "chosen": chosen})
    df = pl.DataFrame(rows)
    ds = client.post(
        "/api/v1/datasets/import",
        files={"file": ("cj.csv", df.write_csv().encode(), "text/csv")},
    ).json()["datasetId"]
    ctx = {"datasetId": ds, "expectedDataRevision": 1,
           "expectedSchemaRevision": 1, "scope": "all",
           "weightMode": "none", "missingPolicy": "exclude",
           "imputationPolicy": "use_current_values"}
    return ds, ctx


def _choice_payload(ctx, **over):
    base = {
        "context": ctx, "mode": "choice", "method": "conjoint",
        "columns": {"respondentId": "respondent_id", "taskId": "task_id",
                    "alternativeId": "alternative_id",
                    "response": "chosen"},
        "attributes": [{"columnId": "brand", "kind": "categorical"}],
    }
    base.update(over)
    return base


def test_choice_fit_rows_expand_scope_simulate():
    ds, ctx = _import_choice_dataset()
    r = client.post("/api/v1/models/conjoint",
                    json=_choice_payload(ctx))
    assert r.status_code == 200, r.text[:800]
    j = r.json()
    assert j["method"] == "conjoint"
    assert j["summary"]["mode"] == "choice"
    # Effect-coding utilities sum to 0 (CJ01).
    utils = j["details"]["levelUtilities"]
    brand_u = [u["utility"] for u in utils
               if u["attributeId"] == "brand"]
    assert abs(sum(brand_u)) < 1e-9
    rid = j["resultId"]
    rows = client.get(
        f"/api/v1/analysis-results/{rid}/rows?offset=0&limit=5").json()
    assert rows["total"] == 16
    assert rows["rows"][0]["probability"] is not None
    assert rows["rows"][0]["predictedRating"] is None
    # Partial-task rejection (CJ04): one row of a task.
    bad_ctx = dict(ctx, scope="selected",
                   selectedRowIds=[rows["rows"][0]["rowId"]])
    r2 = client.post("/api/v1/models/conjoint",
                     json=_choice_payload(bad_ctx))
    assert r2.status_code == 422
    # Explicit expand-scope returns the full task rows.
    cols = {"respondentId": "respondent_id", "taskId": "task_id",
            "alternativeId": "alternative_id", "response": "chosen"}
    ex = client.post("/api/v1/models/conjoint/expand-scope",
                     json={"context": bad_ctx, "columns": cols}).json()
    assert ex["status"] == "success"
    assert ex["expandedRowCount"] >= ex["originalRowCount"]
    # Simulate: in-set logit probabilities sum to 1.
    sim = client.post(
        f"/api/v1/models/conjoint/{rid}/simulate",
        json={"context": {"datasetId": ds, "expectedDataRevision": 1,
                          "expectedSchemaRevision": 1, "scope": "all",
                          "weightMode": "none",
                          "missingPolicy": "exclude",
                          "imputationPolicy": "use_current_values"},
              "profiles": [{"alternativeId": "s1",
                            "values": {"brand": "A"}},
                           {"alternativeId": "s2",
                            "values": {"brand": "B"}}]}).json()
    assert sim["status"] == "success"
    assert abs(sum(p["probability"]
                   for p in sim["profiles"]) - 1.0) < 1e-9
    # respondents selector + materialize (mode-gated fields).
    sel = client.post(
        f"/api/v1/analysis-results/{rid}/select",
        json={"context": ctx,
              "selector": {"kind": "respondents",
                           "respondentIds": ["P1"]}}).json()
    assert sel["matchedCount"] == 2
    # CJ-R002/R003: predict emits every requested row; partial scope 422.
    pred = client.post(
        f"/api/v1/analysis-results/{rid}/predict",
        json={"context": ctx,
              "options": {"interval": "none", "evaluate": True}}).json()
    assert pred["summary"]["requestedCount"] == 16
    assert pred["summary"]["successfulPredictions"] == 16
    assert pred["summary"]["evaluation"]["fitOverlapCount"] == 16
    assert pred["summary"]["evaluation"][
        "fitOverlapRespondentCount"] == 8
    one = [r for r in
           client.get(f"/api/v1/analysis-results/{rid}/rows?offset=0"
                      f"&limit=1").json()["rows"]]
    partial_ctx = dict(ctx, scope="selected",
                       selectedRowIds=[one[0]["rowId"]])
    pp = client.post(f"/api/v1/analysis-results/{rid}/predict",
                     json={"context": partial_ctx,
                           "options": {"interval": "none",
                                       "evaluate": True}})
    assert pp.status_code == 422
    mat = client.post(
        f"/api/v1/analysis-results/{rid}/materialize",
        json={"context": ctx, "source": "fit",
              "columns": [{"sourceField": "probability",
                           "name": "CJ_PROB", "label": "prob"}],
              "idempotencyKey": "cj-test-1"}).json()
    assert mat["status"] == "success"
    # CJ-R006: materialize resolves scope inside the write lock and
    # re-verifies the learned revision; idempotent replay works.
    replay = client.post(
        f"/api/v1/analysis-results/{rid}/materialize",
        json={"context": ctx, "source": "fit",
              "columns": [{"sourceField": "probability",
                           "name": "CJ_PROB", "label": "prob"}],
              "idempotencyKey": "cj-test-1"}).json()
    assert replay.get("idempotentReplay") is True
    conflict = client.post(
        f"/api/v1/analysis-results/{rid}/materialize",
        json={"context": ctx, "source": "fit",
              "columns": [{"sourceField": "residual",
                           "name": "CJ_PROB", "label": "prob"}],
              "idempotencyKey": "cj-test-1"})
    assert conflict.status_code == 409
    # Ratings must not accept probability fields.
    assert "probability" in (j["capabilities"]["materializeFitFields"]
                             if j["summary"]["mode"] == "choice" else [])


def test_ratings_has_no_probability():
    rows = []
    n = 0
    for r in range(1, 5):
        for t, brand in (("T1", "A"), ("T2", "B")):
            n += 1
            rows.append({"respondent_id": f"R{r}", "task_id": t,
                         "alternative_id": "A1", "brand": brand,
                         "rating": float(5 + (1 if brand == "A" else -1))})
    df = pl.DataFrame(rows)
    ds = client.post(
        "/api/v1/datasets/import",
        files={"file": ("rt.csv", df.write_csv().encode(), "text/csv")},
    ).json()["datasetId"]
    ctx = {"datasetId": ds, "expectedDataRevision": 1,
           "expectedSchemaRevision": 1, "scope": "all",
           "weightMode": "none", "missingPolicy": "exclude",
           "imputationPolicy": "use_current_values"}
    payload = {"context": ctx, "mode": "ratings", "method": "conjoint",
               "columns": {"respondentId": "respondent_id",
                           "taskId": "task_id",
                           "alternativeId": "alternative_id",
                           "response": "rating"},
               "attributes": [{"columnId": "brand",
                               "kind": "categorical"}]}
    r = client.post("/api/v1/models/conjoint", json=payload)
    assert r.status_code == 200, r.text[:800]
    j = r.json()
    rid = j["resultId"]
    rows_j = client.get(
        f"/api/v1/analysis-results/{rid}/rows?offset=0&limit=8").json()
    assert all(x["probability"] is None for x in rows_j["rows"])
    assert all(x["predictedRating"] is not None
               for x in rows_j["rows"])
    # ratings must reject probability materialize fields (CJ09).
    bad = client.post(
        f"/api/v1/analysis-results/{rid}/materialize",
        json={"context": ctx, "source": "fit",
              "columns": [{"sourceField": "probability",
                           "name": "CJ_BAD", "label": "bad"}],
              "idempotencyKey": "cj-test-2"})
    assert bad.status_code == 422
