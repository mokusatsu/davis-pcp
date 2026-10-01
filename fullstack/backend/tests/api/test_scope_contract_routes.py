"""Common scope contracts: exact membership, no empty-to-All, and provenance."""
from __future__ import annotations

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore
from app.domain.context import scope_hash


@pytest.fixture
def scope_dataset(tmp_path, monkeypatch):
    from app.api import pra, robustness, orderings, observations, summaries, regression, distribution
    store = DatasetStore(tmp_path)
    dataset_id = "scope-contract"
    row_ids = [f"r{i}" for i in range(1, 13)]
    df = pl.DataFrame({"__rowId__": row_ids,
                       "x": [float(i % 5 + 1) for i in range(12)],
                       "y": [float(i * i % 11) for i in range(12)],
                       "z": [float(i * 3 % 7) for i in range(12)],
                       "group": ["a", "b"] * 6,
                       "category": ["u", "v", "w"] * 4})
    schema = [{"columnId": name, "name": name, "semanticType": "numeric" if name in ("x", "y", "z") else "categorical",
               "physicalType": "float" if name in ("x", "y", "z") else "string"}
              for name in df.columns if name != "__rowId__"]
    store.save(dataset_id, {"datasetId": dataset_id, "rowCount": 12, "columnCount": 5,
                           "fingerprint": "fixture", "dataRevision": 3, "schemaRevision": 2,
                           "schema": schema}, df)
    store.save_codebook(dataset_id, {"schemaRevision": 2, "columns": [
        {"columnId": spec["name"], "name": spec["name"], "label": spec["name"],
         "scaleType": "ratio" if spec["name"] in ("x", "y", "z") else "nominal", "role": "question",
         "valueLabels": {}, "missingCodes": [], "categoryOrder": []} for spec in schema]})
    for module in (pra, robustness, orderings, observations, summaries, regression, distribution):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        yield client, dataset_id, row_ids, df


def request_scope(dataset_id, **kwargs):
    return {"datasetId": dataset_id, "expectedDataRevision": 3, "expectedSchemaRevision": 2, **kwargs}


@pytest.mark.parametrize("route,options", [
    ("/regression/loess", {"xCol": "x", "yCol": "y", "nPoints": 10}),
    ("/distribution/fedf", {"columns": ["x", "y"], "gridSize": 10}),
])
def test_live_displays_validate_revisions_and_keep_row_scope(scope_dataset, route, options):
    client, dataset_id, row_ids, _ = scope_dataset
    body = request_scope(dataset_id, rowIds=row_ids[:8], **options)
    response = client.post("/api/v1" + route, json=body)
    assert response.status_code == 200, response.text
    value = response.json()
    assert value["dataRevision"] == 3 and value["schemaRevision"] == 2
    actual_ids = {p["id"] for p in value["points"]} if "points" in value else set(value["rowCoords"])
    assert actual_ids == set(row_ids[:8])
    for revision in ("expectedDataRevision", "expectedSchemaRevision"):
        stale = client.post("/api/v1" + route, json={**body, revision: 99})
        assert stale.status_code == 409, stale.text
        assert stale.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
    empty = client.post("/api/v1" + route, json={**body, "rowIds": []})
    assert empty.status_code == 400, empty.text
    assert empty.json()["error"]["code"] in ("FEDF_EMPTY_DATA", "LOESS_INSUFFICIENT_DATA")


@pytest.mark.parametrize("route,kernel", [("pra", "evaluate_penalty_reward"), ("robustness", "evaluate_robustness")])
@pytest.mark.parametrize("ids", [None, ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"], ["r2", "r4"], ["r1", "r5", "r9"]])
def test_evaluate_kernel_receives_exact_common_population(scope_dataset, monkeypatch, route, kernel, ids):
    from app.api import pra, robustness
    client, dataset_id, row_ids, _ = scope_dataset
    captured = []
    def evaluate(**kwargs):
        captured.extend(kwargs["df"]["__rowId__"].to_list())
        return {"ok": True}
    monkeypatch.setattr(pra if route == "pra" else robustness, kernel, evaluate)
    body = request_scope(dataset_id, outcome="y", attributes=["x"], rowIds=ids)
    result = client.post(f"/api/v1/{route}/evaluate", json=body)
    assert result.status_code == 200, result.text
    expected = row_ids if ids is None else ids
    assert captured == expected
    assert result.json()["scopeCount"] == len(expected)
    assert result.json()["dataRevision"] == 3 and result.json()["schemaRevision"] == 2


@pytest.mark.parametrize("route,extras,field", [
    ("/pra/evaluate", {"outcome": "y", "attributes": ["x"]}, "rowIds"),
    ("/robustness/evaluate", {}, "rowIds"),
    ("/robustness/sensitivity", {"targetColumn": "y", "candidate": {"type": "kpi"}}, "scopeRowIds"),
    ("/orderings", {"mode": "correlation", "columns": ["x", "y", "z"]}, "rowIds"),
])
def test_empty_unknown_and_stale_inputs_never_execute_all(scope_dataset, route, extras, field):
    client, dataset_id, _, _ = scope_dataset
    body = request_scope(dataset_id, **extras)
    empty = client.post("/api/v1" + route, json={**body, field: []})
    assert empty.status_code == 422, empty.text
    assert empty.json()["error"]["code"] == "EMPTY_ANALYSIS_INPUT"
    unknown = client.post("/api/v1" + route, json={**body, field: ["r1", "foreign"]})
    assert unknown.status_code == 422, unknown.text
    assert unknown.json()["error"]["code"] == "ANALYSIS_SCOPE_UNKNOWN_ROW"
    for revision in ("expectedDataRevision", "expectedSchemaRevision"):
        stale = client.post("/api/v1" + route, json={**body, revision: 99, field: ["r1"]})
        assert stale.status_code == 409, stale.text
        assert stale.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"


def test_sensitivity_candidate_complement_is_inside_scope(scope_dataset, monkeypatch):
    from app.api import robustness
    client, dataset_id, _, _ = scope_dataset
    captured = {}
    def evaluate(**kwargs):
        captured.update(kwargs)
        return {"checked": True}
    monkeypatch.setattr(robustness, "run_sensitivity_analysis", evaluate)
    body = request_scope(dataset_id, targetColumn="y", scopeRowIds=["r1", "r2", "r3", "r4"],
                         candidate={"type": "subgroup_diff", "rowIds": ["r2", "r9"]})
    result = client.post("/api/v1/robustness/sensitivity", json=body)
    assert result.status_code == 200, result.text
    df = captured["df"]
    assert df["__rowId__"].to_list() == ["r1", "r2", "r3", "r4"]
    assert df[captured["group_column"]].to_list() == ["complement", "candidate", "complement", "complement"]
    assert result.json()["scopeCount"] == 4


def test_real_pra_and_robustness_results_use_requested_scope(scope_dataset):
    client, dataset_id, row_ids, df = scope_dataset
    selected = row_ids[:8]
    pra = client.post("/api/v1/pra/evaluate", json=request_scope(
        dataset_id, outcome="y", attributes=["x"], rowIds=selected))
    assert pra.status_code == 200, pra.text
    assert pra.json()["model"]["n_valid"] == pra.json()["scopeCount"] == 8
    for attribute in pra.json()["attributes"]:
        assert set(attribute["dissatisfied_row_ids"]).issubset(selected)
    too_small = client.post("/api/v1/pra/evaluate", json=request_scope(
        dataset_id, outcome="y", attributes=["x"], rowIds=["r2", "r4"]))
    assert too_small.status_code == 400
    assert too_small.json()["error"]["code"] == "PRA_EXECUTION_ERROR"
    robustness = client.post("/api/v1/robustness/evaluate", json=request_scope(
        dataset_id, rowIds=selected, bootstrapB=10, removalFractions=[0],
        conclusions=[{"id": "mean-x", "type": "kpi", "target_col": "x"}]))
    assert robustness.status_code == 200, robustness.text
    conclusion = robustness.json()["conclusions"][0]
    assert conclusion["full_estimate"] == pytest.approx(df.head(8)["x"].mean())
    assert conclusion["full_estimate"] != pytest.approx(df["x"].mean())
    assert {v["row_id"] for v in conclusion["top_influence_respondents"]}.issubset(selected)


@pytest.mark.parametrize("mode", ["correlation", "componentJar", "componentPaper", "permute"])
def test_ordering_uses_exact_rows_and_columns(scope_dataset, monkeypatch, mode):
    from app.api import orderings
    client, dataset_id, _, df = scope_dataset
    original = orderings.compute_order
    captured = {}
    def compute(mode, columns, values, manual):
        captured.update(columns=columns, values=values.copy())
        return original(mode, columns, values, manual)
    monkeypatch.setattr(orderings, "compute_order", compute)
    body = request_scope(dataset_id, mode=mode, rowIds=["r2", "r4", "r6"], columns=["z", "x"])
    result = client.post("/api/v1/orderings", json=body)
    assert result.status_code == 200, result.text
    expected = df.filter(pl.col("__rowId__").is_in(body["rowIds"])).select(["z", "x"]).to_numpy()
    np.testing.assert_equal(captured["values"], expected)
    assert captured["columns"] == ["z", "x"]
    assert result.json()["scopeHash"] == scope_hash(body["rowIds"])
    assert result.json()["scopeCount"] == 3


def test_ordering_empty_columns_do_not_expand_and_layout_order_can_use_empty_rows(scope_dataset):
    client, dataset_id, _, _ = scope_dataset
    body = request_scope(dataset_id, mode="correlation", columns=[], rowIds=["r1", "r2"])
    result = client.post("/api/v1/orderings", json=body)
    assert result.status_code == 400, result.text
    assert result.json()["error"]["code"] == "ORDERING_INSUFFICIENT_COLUMNS"
    for mode in ("manual", "database"):
        result = client.post("/api/v1/orderings", json={**body, "mode": mode, "columns": ["x", "y"], "rowIds": []})
        assert result.status_code == 200, result.text
        assert result.json()["scopeCount"] == 0
        assert result.json()["outputColumnIds"] == ["x", "y"]


def test_sampling_null_seed_can_be_replayed_and_provenance_is_order_sensitive(scope_dataset):
    client, dataset_id, row_ids, _ = scope_dataset
    url = f"/api/v1/datasets/{dataset_id}/observations/sample"
    body = {"size": 3, "seed": None, "activeRowIds": row_ids[:8],
            "expectedDataRevision": 3, "expectedSchemaRevision": 2}
    response = client.post(url, json=body)
    assert response.status_code == 200, response.text
    first = response.json()
    assert isinstance(first["seed"], int) and 0 <= first["seed"] < 2**32
    replay = client.post(url, json={**body, "seed": first["seed"]}).json()
    assert replay["sampledRowIds"] == first["sampledRowIds"]
    assert replay["sampleId"] != first["sampleId"]
    assert first["sourceScopeHash"] == scope_hash(row_ids[:8])
    assert first["sourceRowCount"] == first["totalCandidates"] == 8
    assert first["dataRevision"] == 3 and first["schemaRevision"] == 2
    reordered = client.post(url, json={**body, "seed": first["seed"], "activeRowIds": list(reversed(row_ids[:8]))}).json()
    assert reordered["sourceScopeHash"] == first["sourceScopeHash"]
    assert reordered["sourceOrderHash"] != first["sourceOrderHash"]
    different = client.post(url, json={**body, "activeRowIds": row_ids[1:9]}).json()
    assert different["sourceScopeHash"] != first["sourceScopeHash"]


@pytest.mark.parametrize("kind,params", [("sample", {"size": 2}), ("range", {"fromIndex": 0, "toIndex": 2})])
def test_observation_revisions_unknown_and_duplicate_inputs(scope_dataset, kind, params):
    client, dataset_id, _, _ = scope_dataset
    url = f"/api/v1/datasets/{dataset_id}/observations/{kind}"
    for revision in ("expectedDataRevision", "expectedSchemaRevision"):
        response = client.post(url, json={**params, revision: 99})
        assert response.status_code == 409, response.text
    for ids in (["r1", "unknown"], ["r1", "r1"]):
        response = client.post(url, json={**params, "activeRowIds": ids})
        assert response.status_code == 422, response.text
    empty = client.post(url, json={**params, "activeRowIds": []})
    if kind == "sample":
        assert empty.status_code == 400
        assert empty.json()["error"]["code"] == "EMPTY_CANDIDATES"
    else:
        assert empty.status_code == 200
        assert empty.json()["rowIds"] == [] and empty.json()["sourceRowCount"] == 0


@pytest.mark.parametrize("scope,field", [("active", "activeRowIds"), ("selected", "selectedRowIds"), ("sampled", "sampledRowIds"), ("explicit", "rowIds")])
def test_crosstab_requires_ids_but_accepts_empty_scope(scope_dataset, scope, field):
    client, dataset_id, _, _ = scope_dataset
    context = request_scope(dataset_id, scope=scope)
    body = {"context": context, "rowVariableId": "group", "colVariableId": "category"}
    for endpoint, extra in [("", {}), ("/cell-row-ids", {"rowCategoryId": "a", "colCategoryId": "u"})]:
        missing = client.post("/api/v1/summaries/crosstab" + endpoint, json={**body, **extra})
        assert missing.status_code == 422, missing.text
        empty = client.post("/api/v1/summaries/crosstab" + endpoint,
                            json={**body, **extra, "context": {**context, field: []}})
        assert empty.status_code == 200, empty.text
        value = empty.json()
        if endpoint:
            assert value["rowIds"] == [] and value["rowIdCount"] == 0
        else:
            assert value["meta"]["scopeCount"] == 0
            assert value["grandTotal"]["unweightedCount"] == 0
