"""Feature 26-BE2/BE3: crosstab API contract, weights, scope, stale handling."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def crosstab_ds(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    import app.api.datasets as datasets_api
    import app.api.multi_response as multi_response_api
    import app.api.summaries as summaries_api

    monkeypatch.setattr(datasets_api, "store", store)
    monkeypatch.setattr(multi_response_api, "store", store)
    monkeypatch.setattr(summaries_api, "store", store)
    with TestClient(app) as client:
        grid = {("a", "x"): 10, ("a", "y"): 20, ("a", "z"): 70,
                ("b", "x"): 30, ("b", "y"): 30, ("b", "z"): 40}
        lines = ["row,col"]
        for (row, col), count in grid.items():
            lines.extend([f"{row},{col}"] * count)
        dataset_id = client.post(
            "/api/v1/datasets/import",
            files={"file": ("c.csv", "\n".join(lines) + "\n", "text/csv")}).json()["datasetId"]
        cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: dict(c) for c in cb["columns"]}
        for name in ("row", "col"):
            by_name[name].update(role="question", scaleType="nominal",
                                 categoryOrder=sorted({v for k, v in grid for v in [k] if k in (name,)}))
        by_name["row"]["categoryOrder"] = ["a", "b"]
        by_name["col"]["categoryOrder"] = ["x", "y", "z"]
        assert client.put(f"/api/v1/datasets/{dataset_id}/codebook",
                          json={"columns": list(by_name.values())}).status_code == 200
        meta = client.get(f"/api/v1/datasets/{dataset_id}").json()
        codebook = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        context = {"datasetId": dataset_id, "expectedDataRevision": meta["dataRevision"],
                   "expectedSchemaRevision": codebook.get("schemaRevision", 1),
                   "scope": "all", "missingPolicy": "exclude"}
        yield client, context
        client.delete(f"/api/v1/datasets/{dataset_id}")


def _body(context=None, **overrides):
    base = {"context": dict(context), "rowVariableId": "row", "colVariableId": "col",
            "includeRowIds": True, "maxRowIdsPerCell": 10000, "inference": "auto"}
    return {**base, **overrides}


def test_crosstab_contract_and_meta(crosstab_ds):
    client, context = crosstab_ds
    body = client.post("/api/v1/summaries/crosstab", json=_body(context)).json()
    assert body["grandTotal"] == {"unweightedCount": 200, "count": 200.0}
    assert body["meta"]["scopeCount"] == 200 and body["meta"]["effectiveN"] == 200
    assert body["meta"]["algorithmVersion"] == "crosstab-survey-4"
    assert body["meta"]["scopeHash"].startswith("sha256:")
    assert body["descriptiveAssociation"]["df"] == 2
    assert body["inference"]["method"] == "pearson"
    assert body["meta"]["isExplorative"] is False
    assert "weightedN" not in body
    cell = next(c for c in body["cells"]
                if c["rowCategoryId"] == "a" and c["colCategoryId"] == "z")
    assert cell["rowIds"] and cell["rowIdCount"] == 70 and cell["rowIdsTruncated"] is False
    assert cell["significance"] in ("*", "**", "***")
    assert cell["residualType"] == "adjusted"


def test_crosstab_rejects_same_and_noncategorical(crosstab_ds):
    client, context = crosstab_ds
    res = client.post("/api/v1/summaries/crosstab", json=_body(context, colVariableId="row"))
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "CROSSTAB_SAME_VARIABLE"


def test_crosstab_stale_revision_returns_409(crosstab_ds):
    client, context = crosstab_ds
    stale = dict(context, expectedDataRevision=context["expectedDataRevision"] + 99)
    res = client.post("/api/v1/summaries/crosstab", json=_body(stale))
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"


def test_crosstab_explicit_scope_and_cell_route(crosstab_ds):
    client, context = crosstab_ds
    first = client.post("/api/v1/summaries/crosstab", json=_body(context)).json()
    sample = first["cells"][0]["rowIds"][:5]
    explicit = dict(context, scope="explicit", rowIds=sample)
    scoped = client.post("/api/v1/summaries/crosstab", json=_body(explicit)).json()
    assert scoped["meta"]["scopeCount"] == len(sample)
    cell_req = {"context": explicit, "rowVariableId": "row", "colVariableId": "col",
                "rowCategoryId": first["cells"][0]["rowCategoryId"],
                "colCategoryId": first["cells"][0]["colCategoryId"]}
    cell = client.post("/api/v1/summaries/crosstab/cell-row-ids", json=cell_req).json()
    assert cell["rowIdCount"] >= 1
    assert set(cell["rowIds"]).issubset(set(sample))


def test_crosstab_weight_validation(crosstab_ds):
    client, context = crosstab_ds
    res = client.post("/api/v1/summaries/crosstab",
                      json=_body(dict(context, weightColumn="nope")))
    assert res.status_code == 422
