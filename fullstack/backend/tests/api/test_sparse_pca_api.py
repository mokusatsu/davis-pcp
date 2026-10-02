"""SparsePCA API, frozen-result, and dataset-boundary regression contracts.

All imports use the synchronous in-process TestClient, like the other model API
tests. CSV imports in this module never contact an external upload service.
"""
from __future__ import annotations

import copy
import csv
import io
import json
import warnings

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api.models import store
from app.domain.context import scope_hash
from app.storage import analysis_result_store as results


ROUTE = "/api/v1/models/sparse-pca"
RESULTS = "/api/v1/analysis-results"
PCA_ONLY_FIELDS = {
    "eigenvalues", "explainedVarianceRatio", "cumulativeVarianceRatio",
    "explainedVariance", "kaiser", "kaiserCount", "loadings", "pc1", "pc2",
}


@pytest.fixture
def client():
    with TestClient(app) as value:
        yield value


def imported(client, data=None, variables=None):
    if data is None:
        data = pl.DataFrame({
            "x": [0., 1., 2., 3., 4., 5., 6., 7.],
            "y": [1., 4., 2., 7., 3., 8., 5., 9.],
            "z": [4., 2., 8., 1., 5., 3., 9., 6.],
        })
    response = client.post("/api/v1/datasets/import", files={
        "file": ("sparse-pca.csv", data.write_csv().encode(), "text/csv")})
    assert response.status_code == 200, response.text
    did = response.json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{did}/codebook").json()
    ids = {column["name"]: column["columnId"] for column in cb["columns"]}
    selected = variables if variables is not None else [n for n in ("x", "y", "z") if n in ids]
    request = {
        "context": {
            "datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
            "scope": "all", "weightMode": "none", "missingPolicy": "exclude",
            "imputationPolicy": "use_current_values",
        },
        "variables": [{"columnId": ids[name], "kind": "numeric",
                       "ordinalAsNumericAcknowledged": False, "score": None}
                      for name in selected],
        "preprocessing": "correlation", "nComponents": 2, "alpha": .2,
        "ridgeAlpha": .01, "tolerance": 1e-8, "maxIterations": 1000, "seed": 0,
    }
    return did, ids, request


def fit(client, request):
    response = client.post(ROUTE, json=request)
    assert response.status_code == 200, response.text
    return response.json()


def row_ids(did):
    return [str(value) for value in store.get_dataframe(did)["__rowId__"].to_list()]


def rows(client, rid, **params):
    response = client.get(f"{RESULTS}/{rid}/rows", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def error(response, status=422, code=None):
    assert response.status_code == status, response.text
    body = response.json()["error"]
    if code is not None:
        assert body["code"] == code, response.text
    return body


def update_column(did, name, **values):
    cb = store.load_codebook(did)
    next(column for column in cb["columns"] if column["name"] == name).update(values)
    store.save_codebook(did, cb)


def export(client, rid, table, format="json", **extra):
    response = client.post(f"{RESULTS}/{rid}/export", json={
        "table": table, "format": format, **extra})
    assert response.status_code == 200, response.text
    envelope = response.json()
    assert envelope["status"] == "success"
    assert envelope["fileName"].endswith(f".{format}")
    assert envelope["mime"].startswith("application/json" if format == "json" else "text/csv")
    if format == "csv":
        return envelope, list(csv.DictReader(io.StringIO(envelope["payload"])))
    body = json.loads(envelope["payload"])
    if table != "manifest":
        assert isinstance(body["columns"], list)
        assert all(isinstance(row, list) and len(row) == len(body["columns"]) for row in body["rows"])
        body["rows"] = [dict(zip(body["columns"], row, strict=True)) for row in body["rows"]]
    return envelope, body


def assert_no_pca_fields(value):
    if isinstance(value, dict):
        assert not PCA_ONLY_FIELDS.intersection(value)
        for child in value.values():
            assert_no_pca_fields(child)
    elif isinstance(value, list):
        for child in value:
            assert_no_pca_fields(child)


def test_fit_get_reload_preserves_typed_numerical_result(client):
    did, ids, request = imported(client)
    result = fit(client, request)
    rid = result["resultId"]
    assert result["status"] == "success" and result["method"] == "sparse_pca"
    assert result["config"] == {k: v for k, v in request.items() if k != "context"} | {"solver": "lars"}
    assert result["capabilities"] == {
        "rows": True, "projection": False, "materialize": False,
        "selectionKinds": ["row_ids", "rectangle"],
        "exportTables": ["manifest", "coefficients", "variables", "diagnostics", "rows"],
        "predictionIntervals": [], "exportPredict": False,
    }
    meta, summary, details = result["meta"], result["summary"], result["details"]
    assert meta["datasetId"] == did
    assert meta["dataRevision"] == meta["schemaRevision"] == 1
    assert meta["fitCount"] == meta["scopeCount"] == 8
    assert meta["scopeHash"] == scope_hash(row_ids(did))
    assert meta["weightApplied"] is False
    assert meta["modelFingerprint"] and meta["snapshotFingerprint"] and meta["algorithmVersion"]
    runtime = meta["numericalRuntime"]
    assert runtime["engine"] == "local" and runtime["pyodide"] is None
    assert all(runtime[name] for name in ("python", "numpy", "scipy", "sklearn"))
    assert summary["nComponents"] == 2 and summary["nVariables"] == 3
    assert 0 <= summary["basisRank"] <= 2
    assert 0 <= summary["zeroFraction"] <= 1
    assert summary["reconstructionSpace"] == "standardized"
    assert summary["convergence"]["status"] in {"tolerance_reached", "iteration_limit", "objective_increase"}
    assert details["componentOrder"] == ["SP1", "SP2"]
    assert [item["columnId"] for item in details["variables"]] == list(ids.values())
    assert details["excludedConstantColumns"] == []
    assert np.asarray(details["components"]).shape == (2, 3)
    assert np.asarray(details["scoreCoefficients"]).shape == (3, 2)
    assert np.asarray(details["variableScoreCorrelations"]).shape == (3, 2)
    assert np.asarray(details["scoreCorrelations"]).shape == (2, 2)
    assert len(details["preprocessing"]["columns"]) == 3
    assert len(details["preprocessing"]["estimatorMean"]) == 3
    assert_no_pca_fields(summary)
    assert_no_pca_fields(details)
    assert result["unavailableReasons"]
    json.dumps(result, allow_nan=False)
    saved = results.load_manifest(rid)
    assert saved["schemaVersion"] == "analysis-result/1.0"
    assert saved["ownerDatasetId"] == did
    for key in ("config", "summary", "details", "capabilities"):
        assert saved[key] == result[key]
    assert results.load_members(rid) is None
    arrays = results.load_arrays(rid)
    assert "eigenvalues" not in arrays
    assert arrays and all(array.dtype != object for array in arrays.values())
    with TestClient(app) as reloaded:
        response = reloaded.get(f"{RESULTS}/{rid}")
        assert response.status_code == 200, response.text
        assert response.json() == result
        assert [row["rowId"] for row in rows(reloaded, rid)["rows"]] == row_ids(did)


@pytest.mark.parametrize("field,value", [
    ("solver", "cd"), ("method", "sparse_pca"), ("whiten", True),
    ("unknown", {}), ("nComponents", True), ("nComponents", "2"),
    ("nComponents", 1.5), ("nComponents", 0), ("nComponents", -1),
    ("alpha", True), ("alpha", "1"), ("alpha", -1.),
    ("ridgeAlpha", False), ("ridgeAlpha", "0.01"), ("ridgeAlpha", -.01),
    ("tolerance", True), ("tolerance", "0.01"), ("tolerance", 0.),
    ("tolerance", .100001), ("maxIterations", True), ("maxIterations", "100"),
    ("maxIterations", 1.5), ("maxIterations", 0), ("maxIterations", 5001),
    ("seed", True), ("seed", "0"), ("seed", -1), ("seed", 4294967296),
    ("preprocessing", "whiten"),
])
def test_strict_request_rejects_unsupported_or_coerced_settings(client, field, value):
    _, _, request = imported(client)
    request[field] = value
    error(client.post(ROUTE, json=request), code="ANALYSIS_REQUEST_INVALID")


@pytest.mark.parametrize("field", ["alpha", "ridgeAlpha", "tolerance"])
@pytest.mark.parametrize("value", [float("nan"), float("inf"), -float("inf")])
def test_nonfinite_configuration_is_a_structured_422(client, field, value):
    _, _, request = imported(client)
    request[field] = value
    # httpx's json= serializer intentionally rejects these before the API sees them.
    response = client.post(ROUTE, content=json.dumps(request), headers={"content-type": "application/json"})
    error(response, code="ANALYSIS_REQUEST_INVALID")


@pytest.mark.parametrize("change", [
    "one_variable", "duplicate", "categorical", "variable_extra", "ack_without_score",
    "score_without_ack", "string_ack", "context_extra", "string_revision", "missing_policy",
])
def test_strict_nested_request_contract(client, change):
    _, _, request = imported(client)
    if change == "one_variable":
        request["variables"] = request["variables"][:1]
    elif change == "duplicate":
        request["variables"][1] = copy.deepcopy(request["variables"][0])
    elif change == "categorical":
        request["variables"][0]["kind"] = "categorical"
    elif change == "variable_extra":
        request["variables"][0]["referenceCategory"] = "a"
    elif change == "ack_without_score":
        request["variables"][0]["ordinalAsNumericAcknowledged"] = True
    elif change == "score_without_ack":
        request["variables"][0]["score"] = "ordered_rank"
    elif change == "string_ack":
        request["variables"][0]["ordinalAsNumericAcknowledged"] = "false"
    elif change == "context_extra":
        request["context"]["unknown"] = True
    elif change == "string_revision":
        request["context"]["expectedDataRevision"] = "1"
    else:
        request["context"]["missingPolicy"] = "include_missing"
    error(client.post(ROUTE, json=request), code="ANALYSIS_REQUEST_INVALID")


@pytest.mark.parametrize("mode", ["dataset", "omitted", "column"])
@pytest.mark.parametrize("weight_type", ["survey", "frequency"])
def test_actual_weight_requests_never_silently_fit_unweighted(client, mode, weight_type):
    did, ids, request = imported(client, pl.DataFrame({
        "x": [1., 2., 3., 4., 5.], "y": [4., 3., 5., 2., 1.], "w": [1., 2., 3., 4., 5.]}))
    cb = store.load_codebook(did)
    cb["weightConfig"] = {"weightColumnId": ids["w"], "weightType": weight_type}
    next(c for c in cb["columns"] if c["name"] == "w")["role"] = "weight"
    store.save_codebook(did, cb)
    if mode == "omitted":
        del request["context"]["weightMode"]
    else:
        request["context"]["weightMode"] = mode
    if mode == "column":
        request["context"].update(weightColumn=ids["w"], weightType=weight_type)
    error(client.post(ROUTE, json=request), code="SPCA_WEIGHT_UNSUPPORTED")


def test_dataset_without_saved_weight_and_explicit_none_fit_identically(client):
    _, _, request = imported(client)
    unweighted = fit(client, request)
    del request["context"]["weightMode"]
    default = fit(client, request)
    assert default["meta"]["weightApplied"] is False
    assert default["details"] == unweighted["details"]
    assert default["summary"] == unweighted["summary"]


def test_explicit_none_ignores_bad_weights_and_unrelated_survey_design(client):
    did, ids, request = imported(client, pl.DataFrame({
        "x": [1., 2., 3., 4., 5., 6.], "y": [4., 1., 6., 3., 5., 2.],
        "w": [None, 0., -1., 2.5, 4., 1.], "psu": [None, None, "a", "a", "b", "b"],
        "strata": [None, "s", "s", None, "s", "s"],
    }))
    cb = store.load_codebook(did)
    cb["weightConfig"] = {"weightColumnId": ids["w"], "weightType": "frequency"}
    cb["surveyDesign"] = {"psuColumnId": ids["psu"], "strataColumnId": ids["strata"]}
    next(c for c in cb["columns"] if c["name"] == "w")["role"] = "weight"
    store.save_codebook(did, cb)
    result = fit(client, request)
    assert result["meta"]["fitCount"] == 6
    assert result["meta"]["weightApplied"] is False
    assert not any(result["meta"]["exclusionCounts"].values())
    assert {r["rowId"] for r in rows(client, result["resultId"])["rows"]} == set(row_ids(did))


@pytest.mark.parametrize("mode,expected", [("unknown", "WEIGHT_COLUMN_NOT_FOUND"),
                                           ("mismatch", "WEIGHT_TYPE_MISMATCH"),
                                           ("no_type", "WEIGHT_TYPE_REQUIRED")])
def test_common_weight_validation_precedes_unsupported_weight_error(client, mode, expected):
    did, ids, request = imported(client, pl.DataFrame({
        "x": [1., 2., 3., 4.], "y": [2., 4., 1., 3.], "w": [1., 2., 3., 4.]}))
    cb = store.load_codebook(did)
    cb["weightConfig"] = {"weightColumnId": ids["w"], "weightType": None if mode == "no_type" else "survey"}
    next(c for c in cb["columns"] if c["name"] == "w")["role"] = "weight"
    store.save_codebook(did, cb)
    request["context"].update(weightMode="column", weightColumn="not-a-column" if mode == "unknown" else ids["w"])
    if mode != "no_type":
        request["context"]["weightType"] = "frequency"
    error(client.post(ROUTE, json=request), code=expected)


@pytest.mark.parametrize("changes", [
    {"role": "id"}, {"role": "weight"}, {"role": "text"}, {"scaleType": "nominal"},
    {"multiResponseGroup": "ma-question"},
])
def test_disallowed_roles_scales_and_ma_children_are_rejected(client, changes):
    did, _, request = imported(client)
    update_column(did, "x", **changes)
    error(client.post(ROUTE, json=request), code="SPCA_SCALE_INVALID")


def test_unknown_variable_is_not_resolved_as_a_different_column(client):
    _, _, request = imported(client)
    request["variables"][0]["columnId"] = "not-a-column"
    error(client.post(ROUTE, json=request), code="SPCA_COLUMN_NOT_FOUND")


def test_ordinal_requires_acknowledgement_and_preserves_unobserved_order_and_reversal(client):
    did, ids, request = imported(client, pl.DataFrame({
        "x": ["low", "high", "low", "high", "low", "high"],
        "y": [1., 4., 2., 6., 3., 5.],
    }))
    update_column(did, "x", scaleType="ordinal", categoryOrder=["low", "middle", "high"], isReversed=True)
    error(client.post(ROUTE, json=request), code="SPCA_ORDINAL_ACK_REQUIRED")
    request["variables"][0].update(ordinalAsNumericAcknowledged=True, score="ordered_rank")
    result = fit(client, request)
    descriptor = result["details"]["variables"][0]
    assert descriptor["columnId"] == ids["x"]
    assert descriptor["categoryOrder"] == ["low", "middle", "high"]
    assert descriptor["isReversed"] and descriptor["ordinalAsNumericAcknowledged"]
    assert descriptor["score"] == "ordered_rank"
    scaling = result["details"]["preprocessing"]["columns"][0]
    assert scaling["rawMean"] == pytest.approx(2.)
    assert scaling["rawSampleSd"] == pytest.approx(np.std([3., 1., 3., 1., 3., 1.], ddof=1))
    assert store.get_dataframe(did)["x"].to_list() == ["low", "high"] * 3


def test_unknown_ordinal_code_cannot_extend_the_frozen_order(client):
    did, _, request = imported(client, pl.DataFrame({
        "x": ["low", "high", "unknown", "high", "low", "high"],
        "y": [1., 4., 2., 6., 3., 5.],
    }))
    update_column(did, "x", scaleType="ordinal", categoryOrder=["low", "high"])
    request["variables"][0].update(ordinalAsNumericAcknowledged=True, score="ordered_rank")
    result = fit(client, request)
    assert result["meta"]["fitCount"] == 5
    assert result["meta"]["exclusionCounts"]["invalid"] == 1
    assert result["details"]["variables"][0]["categoryOrder"] == ["low", "high"]
    assert row_ids(did)[2] not in {r["rowId"] for r in rows(client, result["resultId"])["rows"]}


def test_ordinal_ack_does_not_allow_undeclared_order_or_numeric_rank_conversion(client):
    did, _, request = imported(client)
    request["variables"][0].update(ordinalAsNumericAcknowledged=True, score="ordered_rank")
    error(client.post(ROUTE, json=request), code="SPCA_ORDINAL_ACK_INVALID")
    update_column(did, "x", scaleType="ordinal", categoryOrder=[])
    error(client.post(ROUTE, json=request), code="ORDINAL_ORDER_REQUIRED")


def test_numeric_reversal_requires_frozen_scale_range(client):
    did, _, request = imported(client)
    update_column(did, "x", isReversed=True, categoryOrder=[])
    error(client.post(ROUTE, json=request), code="CODEBOOK_REVERSE_RANGE_MISSING")


@pytest.mark.parametrize("scope,key", [("all", None), ("active", "activeRowIds"),
                                        ("selected", "selectedRowIds"), ("sampled", "sampledRowIds"),
                                        ("explicit", "rowIds")])
def test_each_scope_keeps_exact_population_and_hash(client, scope, key):
    did, _, request = imported(client)
    wanted = row_ids(did) if key is None else row_ids(did)[1:6]
    request["context"]["scope"] = scope
    if key:
        request["context"][key] = wanted
    result = fit(client, request)
    assert result["meta"]["scopeCount"] == result["meta"]["fitCount"] == len(wanted)
    assert result["meta"]["scopeHash"] == scope_hash(wanted)
    assert [r["rowId"] for r in rows(client, result["resultId"])["rows"]] == wanted


@pytest.mark.parametrize("scope,key", [("active", "activeRowIds"), ("selected", "selectedRowIds"),
                                        ("sampled", "sampledRowIds"), ("explicit", "rowIds")])
def test_empty_scope_is_never_expanded_to_all_rows(client, scope, key):
    _, _, request = imported(client)
    request["context"].update(scope=scope, **{key: []})
    error(client.post(ROUTE, json=request), code="SPCA_INSUFFICIENT_ROWS")
    del request["context"][key]
    error(client.post(ROUTE, json=request), code="ANALYSIS_REQUEST_INVALID")


def test_explicit_scope_rejects_foreign_row_id_and_preserves_requested_order(client):
    did, _, request = imported(client)
    ids = row_ids(did)
    request["context"].update(scope="explicit", rowIds=[ids[0], "foreign-row"])
    error(client.post(ROUTE, json=request), code="ANALYSIS_SCOPE_UNKNOWN_ROW")
    wanted = [ids[5], ids[2], ids[7], ids[1]]
    request["context"]["rowIds"] = wanted + [wanted[0]]
    result = fit(client, request)
    assert [r["rowId"] for r in rows(client, result["resultId"])["rows"]] == wanted
    assert result["meta"]["scopeCount"] == 4


def test_one_listwise_mask_precedes_constant_exclusion_and_uses_missing_codes(client):
    did, ids, request = imported(client, pl.DataFrame({
        "x": [0., 1., 99., 3., 4., 5.], "y": [4., None, 6., 2., 5., 1.],
        "constant": [7., 7., 7., 7., None, 7.],
    }), variables=["x", "y", "constant"])
    update_column(did, "x", missingCodes=["99"])
    original = store.get_dataframe(did).clone()
    result = fit(client, request)
    assert result["meta"]["scopeCount"] == 6 and result["meta"]["fitCount"] == 3
    assert result["meta"]["exclusionCounts"]["missing"] == 3
    assert result["summary"]["nVariables"] == 2
    assert result["details"]["excludedConstantColumns"] == [
        {"columnId": ids["constant"], "name": "constant", "label": "constant"}]
    assert result["details"]["variables"][0]["missingCodes"] == ["99"]
    assert [r["rowId"] for r in rows(client, result["resultId"])["rows"]] == [row_ids(did)[i] for i in (0, 3, 5)]
    assert store.get_dataframe(did).equals(original)


@pytest.mark.parametrize("case", ["all_missing", "all_constant", "one_row", "k_after_constants", "k_after_rows"])
def test_invalid_complete_case_dimensions_never_silently_trim_k(client, case):
    data = {
        "all_missing": {"x": [1., 2., 3.], "y": [None, None, None]},
        "all_constant": {"x": [1., 1., 1.], "y": [2., 2., 2.]},
        "one_row": {"x": [1., None, None], "y": [2., 3., 4.]},
        "k_after_constants": {"x": [1., 2., 3.], "y": [2., 2., 2.]},
        "k_after_rows": {"x": [1., 2., None], "y": [2., 3., 4.]},
    }[case]
    did, _, request = imported(client, pl.DataFrame(data))
    # Explicitly declare the all-null input as numeric; never hide it by inference.
    update_column(did, "y", scaleType="ratio", role="attribute")
    before = set(results.results_root().iterdir())
    expected = ("SPCA_ALL_CONSTANT" if case == "all_constant" else
                "SPCA_COMPONENTS_INVALID" if case in {"k_after_constants", "k_after_rows"} else
                "SPCA_INSUFFICIENT_ROWS")
    failure = error(client.post(ROUTE, json=request), code=expected)
    if expected == "SPCA_COMPONENTS_INVALID":
        assert failure["details"]["maximum"] == 1
    assert set(results.results_root().iterdir()) == before


def test_constant_is_determined_in_fit_scope_and_one_component_is_supported(client):
    did, _, request = imported(client, pl.DataFrame({
        "x": [1., 2., 3., 4., 5.], "y": [9., 9., 9., 8., 7.]}))
    request["context"].update(scope="selected", selectedRowIds=row_ids(did)[:3])
    request["nComponents"] = 1
    result = fit(client, request)
    assert result["summary"]["nComponents"] == result["summary"]["nVariables"] == 1
    assert result["details"]["componentOrder"] == ["SP1"]
    page = rows(client, result["resultId"])
    assert page["axes"] == [1]
    assert all(len(row["coordinates"]) == 1 for row in page["rows"])
    error(client.get(f'{RESULTS}/{result["resultId"]}/rows', params={"axes": "1,2"}))


def test_covariance_preserves_analysis_units_and_numeric_reversal(client):
    did, _, request = imported(client, pl.DataFrame({
        "x": [1., 2., 3., 4., 5., 2.], "y": [10., 40., 20., 50., 30., 60.]}))
    update_column(did, "x", categoryOrder=["1", "2", "3", "4", "5"], isReversed=True)
    request["preprocessing"] = "covariance"
    result = fit(client, request)
    assert result["summary"]["reconstructionSpace"] == "centered_analysis_values"
    prep = result["details"]["preprocessing"]
    assert prep["mode"] == "covariance"
    assert prep["columns"][0]["rawMean"] == pytest.approx(np.mean([5., 4., 3., 2., 1., 4.]))
    assert prep["columns"][1]["rawSampleSd"] == pytest.approx(np.std([10., 40., 20., 50., 30., 60.], ddof=1))


def test_imputed_counts_only_include_distinct_used_fit_cells(client):
    did, ids, request = imported(client)
    selected = row_ids(did)[:5]
    request["context"].update(scope="selected", selectedRowIds=selected)
    entries = [
        {"rowId": selected[0], "columnId": ids["x"]},
        {"rowId": selected[0], "columnId": ids["x"]},
        {"rowId": selected[0], "columnId": ids["y"]},
        {"rowId": selected[1], "columnId": ids["z"]},
        {"rowId": row_ids(did)[7], "columnId": ids["x"]},
        {"rowId": selected[2], "columnId": "unused-column"},
    ]
    store._mask_path(did).write_text(json.dumps({"maskRevision": 7, "entries": entries}), encoding="utf-8")
    result = fit(client, request)
    assert result["meta"]["maskRevision"] == 7
    assert result["meta"]["imputedCellCount"] == 3
    assert result["meta"]["imputedRowCount"] == 2


@pytest.mark.parametrize("revision", ["expectedDataRevision", "expectedSchemaRevision"])
def test_stale_fit_request_is_rejected_before_publishing(client, revision):
    _, _, request = imported(client)
    request["context"][revision] = 99
    before = set(results.results_root().iterdir())
    error(client.post(ROUTE, json=request), status=409, code="ANALYSIS_INPUT_STALE")
    assert set(results.results_root().iterdir()) == before


@pytest.mark.parametrize("revision", ["data", "schema", "mask"])
def test_revision_change_during_fit_never_atomically_publishes(client, monkeypatch, revision):
    from app.algorithms.models import sparse_pca as kernel
    did, _, request = imported(client)
    original = kernel.fit_sparse_pca
    before = set(results.results_root().iterdir())

    def changing(*args, **kwargs):
        output = original(*args, **kwargs)
        if revision == "data":
            store.save(did, store.get_meta(did), store.get_dataframe(did), store.load_codebook(did))
        elif revision == "schema":
            cb = store.load_codebook(did)
            cb["schemaRevision"] += 1
            store.save_codebook(did, cb)
        else:
            mask = store.load_mask(did) or {"entries": []}
            mask["maskRevision"] = int(mask.get("maskRevision", 0)) + 1
            store._mask_path(did).write_text(json.dumps(mask), encoding="utf-8")
        return output

    monkeypatch.setattr(kernel, "fit_sparse_pca", changing)
    error(client.post(ROUTE, json=request), status=409, code="ANALYSIS_INPUT_STALE")
    assert set(results.results_root().iterdir()) == before


def test_saved_snapshot_stays_immutable_after_codebook_change(client):
    did, ids, request = imported(client)
    original = fit(client, request)
    rid = original["resultId"]
    old_rows = rows(client, rid)["rows"]
    changed = client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [
        {"columnId": ids["x"], "label": "Changed label", "missingCodes": ["0"]}]})
    assert changed.status_code == 200, changed.text
    current = {**request["context"], "expectedSchemaRevision": changed.json()["schemaRevision"]}
    got = client.get(f"{RESULTS}/{rid}")
    assert got.status_code == 200, got.text
    stale = got.json()
    assert stale["meta"]["resultState"] == "stale"
    for key in ("config", "summary", "details"):
        assert stale[key] == original[key]
        assert results.load_manifest(rid)[key] == original[key]
    assert rows(client, rid)["rows"] == old_rows
    error(client.post(f"{RESULTS}/{rid}/select", json={
        "context": current, "selector": {"kind": "row_ids", "rowIds": [row_ids(did)[0]]}}),
        status=409, code="ANALYSIS_INPUT_STALE")
    _, manifest = export(client, rid, "manifest")
    assert manifest["details"] == original["details"]
    assert manifest["summary"] == original["summary"]


@pytest.mark.parametrize("revision", ["data", "mask"])
def test_saved_result_is_stale_after_data_or_mask_change_but_remains_readable(client, revision):
    did, _, request = imported(client)
    original = fit(client, request)
    rid = original["resultId"]
    original_rows = rows(client, rid)["rows"]
    if revision == "data":
        data = store.get_dataframe(did).with_columns((pl.col("x") + 100).alias("x"))
        store.save(did, store.get_meta(did), data, store.load_codebook(did))
        request["context"]["expectedDataRevision"] = store.get_meta(did)["dataRevision"]
    else:
        mask = store.load_mask(did) or {"entries": []}
        mask["maskRevision"] = int(mask.get("maskRevision", 0)) + 1
        store._mask_path(did).write_text(json.dumps(mask), encoding="utf-8")
    response = client.get(f"{RESULTS}/{rid}")
    assert response.status_code == 200, response.text
    assert response.json()["meta"]["resultState"] == "stale"
    assert response.json()["details"] == original["details"]
    assert rows(client, rid)["rows"] == original_rows
    error(client.post(f"{RESULTS}/{rid}/select", json={
        "context": request["context"], "selector": {"kind": "row_ids", "rowIds": row_ids(did)}}),
        status=409, code="ANALYSIS_INPUT_STALE")
    _, manifest = export(client, rid, "manifest")
    assert manifest["details"] == original["details"]
    assert manifest["meta"]["dataRevision"] == original["meta"]["dataRevision"]


@pytest.mark.parametrize("ridge", [0., .01])
def test_zero_alpha_and_one_component_are_saved_without_pca_substitution(client, ridge):
    _, _, request = imported(client)
    request.update(alpha=0., ridgeAlpha=ridge, nComponents=1, seed=4294967295)
    result = fit(client, request)
    assert result["method"] == "sparse_pca"
    assert result["config"]["alpha"] == 0.
    assert result["config"]["ridgeAlpha"] == ridge
    assert result["config"]["seed"] == 4294967295
    assert result["details"]["componentOrder"] == ["SP1"]
    assert np.asarray(result["details"]["components"]).shape == (1, 3)
    assert np.asarray(result["details"]["scoreCoefficients"]).shape == (3, 1)
    assert_no_pca_fields(result["summary"])
    page = rows(client, result["resultId"])
    assert page["axes"] == [1] and len(page["rows"]) == 8


def test_rows_pagination_axes_and_empty_tail_keep_full_precision(client):
    did, _, request = imported(client)
    result = fit(client, request)
    rid = result["resultId"]
    first = rows(client, rid, offset=0, limit=3, axes="2,1")
    second = rows(client, rid, offset=3, limit=3, axes="2,1")
    last = rows(client, rid, offset=6, limit=3, axes="2,1")
    assert first["nextOffset"] == 3 and second["nextOffset"] == 6 and last["nextOffset"] is None
    assert first["axes"] == [2, 1]
    assert first["total"] == second["total"] == last["total"] == 8
    combined = first["rows"] + second["rows"] + last["rows"]
    assert [r["rowId"] for r in combined] == row_ids(did)
    default = rows(client, rid)
    assert default["axes"] == [1, 2]
    assert all(set(r) == {"rowId", "coordinates"} for r in combined)
    np.testing.assert_array_equal([r["coordinates"] for r in combined],
                                  np.asarray([r["coordinates"] for r in default["rows"]])[:, ::-1])
    tail = rows(client, rid, offset=100, limit=3)
    assert tail["rows"] == [] and tail["nextOffset"] is None and tail["total"] == 8


@pytest.mark.parametrize("params", [
    {"axes": "0"}, {"axes": "3"}, {"axes": "1,1"}, {"axes": "1,2,3"},
    {"axes": "PC1"}, {"axes": "SP1"}, {"axes": "1.0"}, {"axes": ""},
    {"offset": -1}, {"limit": 0}, {"limit": 10001},
])
def test_invalid_rows_axes_and_pagination_are_rejected(client, params):
    _, _, request = imported(client)
    rid = fit(client, request)["resultId"]
    error(client.get(f"{RESULTS}/{rid}/rows", params=params))


def test_row_selection_intersects_saved_fit_and_current_context(client):
    did, _, request = imported(client)
    all_ids = row_ids(did)
    request["context"].update(scope="selected", selectedRowIds=all_ids[:5])
    rid = fit(client, request)["resultId"]
    context = {**request["context"], "selectedRowIds": all_ids[1:7]}
    response = client.post(f"{RESULTS}/{rid}/select", json={
        "context": context, "selector": {"kind": "row_ids", "rowIds": [all_ids[0], all_ids[2], all_ids[6], "unknown"]}})
    assert response.status_code == 200, response.text
    selected = response.json()
    assert selected["rowIds"] == [all_ids[2]]
    assert selected["fitMatchedCount"] == selected["matchedCount"] == 2
    assert selected["contextIntersectionCount"] == 1
    context["selectedRowIds"] = []
    empty = client.post(f"{RESULTS}/{rid}/select", json={
        "context": context, "selector": {"kind": "row_ids", "rowIds": all_ids}})
    assert empty.status_code == 200 and empty.json()["rowIds"] == []


def test_rectangle_selection_matches_saved_coordinates_including_boundary(client):
    _, _, request = imported(client)
    rid = fit(client, request)["resultId"]
    points = rows(client, rid)["rows"]
    low = points[0]["coordinates"][0]
    high = max(r["coordinates"][0] for r in points)
    expected = {r["rowId"] for r in points if low <= r["coordinates"][0] <= high}
    response = client.post(f"{RESULTS}/{rid}/select", json={
        "context": request["context"], "selector": {"kind": "rectangle", "axes": [1], "bounds": [[low, high]]}})
    assert response.status_code == 200, response.text
    assert set(response.json()["rowIds"]) == expected
    assert response.json()["matchedCount"] == len(expected)
    for selector in [
        {"kind": "rectangle", "axes": [3], "bounds": [[-1., 1.]]},
        {"kind": "rectangle", "axes": [1, 1], "bounds": [[-1., 1.], [-1., 1.]]},
        {"kind": "rectangle", "axes": [1], "bounds": [[1., -1.]]},
    ]:
        error(client.post(f"{RESULTS}/{rid}/select", json={"context": request["context"], "selector": selector}))


def test_select_checks_ownership_revisions_and_unsupported_selector(client):
    _, _, request = imported(client)
    rid = fit(client, request)["resultId"]
    _, _, other = imported(client)
    selector = {"kind": "row_ids", "rowIds": []}
    error(client.post(f"{RESULTS}/{rid}/select", json={"context": other["context"], "selector": selector}),
          code="ANALYSIS_DATASET_MISMATCH")
    for field in ("expectedDataRevision", "expectedSchemaRevision"):
        context = {**request["context"], field: 99}
        error(client.post(f"{RESULTS}/{rid}/select", json={"context": context, "selector": selector}),
              status=409, code="ANALYSIS_INPUT_STALE")
    for unsupported in [
        {"kind": "categories", "categoryIds": ["a"]},
        {"kind": "respondents", "respondentIds": []},
        {"kind": "diagnostic_rectangle", "xField": "fitted", "yField": "residual",
         "xBounds": [-1., 1.], "yBounds": [-1., 1.]},
    ]:
        error(client.post(f"{RESULTS}/{rid}/select", json={"context": request["context"], "selector": unsupported}),
              code="ANALYSIS_SELECTOR_UNSUPPORTED")


def test_json_exports_preserve_coefficients_correlations_rows_and_meanings(client):
    did, ids, request = imported(client)
    result = fit(client, request)
    rid = result["resultId"]
    _, manifest = export(client, rid, "manifest")
    assert manifest["summary"] == result["summary"]
    assert manifest["details"] == result["details"]
    assert manifest["config"] == result["config"]
    assert manifest.get("meanings") or manifest.get("descriptions")
    _, coefficients = export(client, rid, "coefficients")
    assert len(coefficients["rows"]) == 6
    for record in coefficients["rows"]:
        j = list(ids.values()).index(record["variableId"])
        k = result["details"]["componentOrder"].index(record["component"])
        assert record["variableName"] == record["variableLabel"] == list(ids)[j]
        assert record["reconstructionCoefficient"] == result["details"]["components"][k][j]
        assert record["scoreCoefficient"] == result["details"]["scoreCoefficients"][j][k]
        assert record["exactZero"] is (record["reconstructionCoefficient"] == 0)
    _, variables = export(client, rid, "variables")
    assert len(variables["rows"]) == 6
    for record in variables["rows"]:
        j = list(ids.values()).index(record["variableId"])
        k = result["details"]["componentOrder"].index(record["component"])
        assert record["correlation"] == result["details"]["variableScoreCorrelations"][j][k]
        assert record["reason"] == result["details"]["variableScoreCorrelationReasons"][j][k]
    _, diagnostics = export(client, rid, "diagnostics")
    assert diagnostics["summary"] == result["summary"]
    assert len(diagnostics["rows"]) == 4
    for record in diagnostics["rows"]:
        a = result["details"]["componentOrder"].index(record["componentX"])
        b = result["details"]["componentOrder"].index(record["componentY"])
        assert record["correlation"] == result["details"]["scoreCorrelations"][a][b]
    _, score_rows = export(client, rid, "rows")
    page = rows(client, rid)
    assert score_rows["columns"] == ["rowId", "SP1", "SP2"]
    assert [r["rowId"] for r in score_rows["rows"]] == row_ids(did)
    assert [[r["SP1"], r["SP2"]] for r in score_rows["rows"]] == [r["coordinates"] for r in page["rows"]]


@pytest.mark.parametrize("table,total", [("coefficients", 6), ("variables", 6), ("diagnostics", 4), ("rows", 8)])
def test_csv_and_json_exports_support_pagination_without_rounding(client, table, total):
    _, _, request = imported(client)
    rid = fit(client, request)["resultId"]
    first, records = export(client, rid, table, "csv", offset=0, limit=2)
    assert first["total"] == total and first["nextOffset"] == 2 and first["hasHeader"] is True
    assert len(records) == 2
    second, json_records = export(client, rid, table, offset=2, limit=2)
    assert second["total"] == total and len(json_records["rows"]) == 2
    tail, empty = export(client, rid, table, offset=total + 1, limit=2)
    assert empty["rows"] == [] and tail["nextOffset"] is None
    _, full_csv = export(client, rid, table, "csv")
    _, full_json = export(client, rid, table)
    assert len(full_csv) == len(full_json["rows"]) == total
    for text_record, record in zip(full_csv, full_json["rows"]):
        for key, value in record.items():
            if isinstance(value, float):
                assert float(text_record[key]) == value


def test_csv_formula_labels_are_escaped_and_zero_score_correlations_have_reasons(client):
    did, _, request = imported(client)
    update_column(did, "x", label="=SUM(1,2)")
    update_column(did, "y", label="@danger")
    request["alpha"] = 1000000.
    result = fit(client, request)
    rid = result["resultId"]
    assert result["summary"]["zeroFraction"] == 1.
    assert result["summary"]["reconstructionFraction"] == 0.
    assert result["summary"]["basisRank"] == 0
    for key in ("variableScoreCorrelations", "scoreCorrelations"):
        assert all(value is None for row in result["details"][key] for value in row)
    for key in ("variableScoreCorrelationReasons", "scoreCorrelationReasons"):
        assert all(value for row in result["details"][key] for value in row)
    for table in ("coefficients", "variables"):
        _, output = export(client, rid, table, "csv")
        assert {r["variableLabel"] for r in output} >= {"'=SUM(1,2)", "'@danger"}
    _, variables = export(client, rid, "variables")
    assert all(r["correlation"] is None and r["reason"] for r in variables["rows"])
    _, csv_variables = export(client, rid, "variables", "csv")
    assert all(r["correlation"] == "" and r["reason"] for r in csv_variables)
    json.dumps(result, allow_nan=False)


def test_iteration_limit_is_visible_even_without_sklearn_warning(client):
    _, _, request = imported(client)
    request["maxIterations"] = 1
    result = fit(client, request)
    convergence = result["summary"]["convergence"]
    assert convergence["status"] == "iteration_limit"
    assert convergence["nIterations"] == convergence["maxIterations"] == 1
    assert convergence["finalObjective"] == convergence["objectiveHistory"][-1]
    assert result["meta"]["warnings"]


def test_internal_solver_warning_is_preserved_in_saved_metadata(client, monkeypatch):
    from app.algorithms.models import sparse_pca as kernel
    _, _, request = imported(client)
    original = kernel.SparsePCA.fit

    def warning_fit(self, *args, **kwargs):
        output = original(self, *args, **kwargs)
        warnings.warn("test sparse inner solver warning", RuntimeWarning)
        return output

    monkeypatch.setattr(kernel.SparsePCA, "fit", warning_fit)
    result = fit(client, request)
    assert "test sparse inner solver warning" in json.dumps(result["meta"]["warnings"])
    saved = client.get(f'{RESULTS}/{result["resultId"]}').json()
    assert saved["meta"]["warnings"] == result["meta"]["warnings"]


@pytest.mark.parametrize("dimension", ["rows", "variables", "components", "work"])
def test_size_limit_rejects_before_solver_and_never_truncates_input(client, monkeypatch, dimension):
    from app.algorithms.models import sparse_pca as kernel
    n, p, k, iterations = {
        "rows": (kernel.MAX_ROWS + 1, 2, 1, 1),
        "variables": (5, kernel.MAX_VARIABLES + 1, 1, 1),
        "components": (kernel.MAX_COMPONENTS + 3, kernel.MAX_COMPONENTS + 1, kernel.MAX_COMPONENTS + 1, 1),
        "work": (100, 100, 20, 5000),
    }[dimension]
    data = pl.DataFrame({f"v{j}": [float((i * (j + 1)) % 23) for i in range(n)] for j in range(p)})
    # Keep even modulo-23 multiples nonconstant; this is a size test, not a constant-column test.
    data = data.with_columns([pl.Series(f"v{j}", [float(i % 11) for i in range(n)])
                              for j in range(p) if (j + 1) % 23 == 0])
    did, _, request = imported(client, data, variables=data.columns)
    request.update(nComponents=k, maxIterations=iterations)

    def must_not_fit(*args, **kwargs):
        pytest.fail("SparsePCA.fit executed for an unsupported request size")

    monkeypatch.setattr(kernel.SparsePCA, "fit", must_not_fit)
    before = set(results.results_root().iterdir())
    failure = error(client.post(ROUTE, json=request), code="SPCA_SIZE_LIMIT")
    assert failure["details"]["nRows"] == n
    assert failure["details"]["nVariables"] == p
    assert store.get_dataframe(did).height == n
    assert set(results.results_root().iterdir()) == before


def test_unsupported_exports_predict_and_materialize_never_mutate_dataset(client):
    did, _, request = imported(client)
    rid = fit(client, request)["resultId"]
    before_meta = copy.deepcopy(store.get_meta(did))
    before_frame = store.get_dataframe(did).clone()
    for table in ("eigenvalues", "categories", "members"):
        error(client.post(f"{RESULTS}/{rid}/export", json={"format": "json", "table": table}))
    error(client.post(f"{RESULTS}/{rid}/export", json={"format": "csv", "table": "manifest"}))
    error(client.post(f"{RESULTS}/{rid}/export", json={"format": "json", "table": "rows", "axes": [1]}))
    error(client.post(f"{RESULTS}/{rid}/predict", json={"context": request["context"], "options": {"interval": "none"}}))
    error(client.post(f"{RESULTS}/{rid}/materialize", json={
        "context": request["context"], "source": "fit",
        "columns": [{"source": "score:1", "name": "spca_score"}], "idempotencyKey": "spca-no-materialize"}))
    error(client.post(f"{RESULTS}/{rid}/export-predict", json={
        "language": "python", "artifact": "model", "expectedModelVersion": "1"}))
    assert store.get_meta(did) == before_meta
    assert store.get_dataframe(did).equals(before_frame)


def test_ordinary_pca_route_retains_its_existing_separate_contract(client):
    did, _, request = imported(client)
    ordinary_request = {"datasetId": did, "columns": ["x", "y", "z"], "useCorrelation": True, "nComponents": 2}
    before = client.post("/api/v1/models/pca", json=ordinary_request)
    assert before.status_code == 200, before.text
    sparse = fit(client, request)
    after = client.post("/api/v1/models/pca", json=ordinary_request)
    assert after.status_code == 200, after.text
    assert before.json() == after.json()
    assert "eigenvalues" in before.json() and "scores" in before.json()
    assert "resultId" not in before.json()
    assert_no_pca_fields(sparse["summary"])
