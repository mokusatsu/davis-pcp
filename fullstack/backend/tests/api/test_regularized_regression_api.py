"""End-to-end regularized contracts without borrowing OLS inference fields."""
from __future__ import annotations

import copy
import json

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api.regularized_regression import store
from app.domain.portable_regression import predict_batch, validate_model
from app.storage import analysis_result_store as results


def imported(data=None):
    client = TestClient(app)
    data = data if data is not None else pl.DataFrame({
        "y": [2.2, 1.4, 3.1, 3.1, 3.1, 4.9, 4.7, 4.9, 5.8, 6.0],
        "x": [0., .333, .667, 1., 1.333, 1.667, 2., 2.333, 2.667, 3.],
        "g": ["a", "b", "a", "b", "b", "a", "a", "b", "a", "b"],
    })
    response = client.post("/api/v1/datasets/import", files={
        "file": ("regularized.csv", data.write_csv().encode(), "text/csv")})
    assert response.status_code == 200, response.text
    did = response.json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{did}/codebook").json()
    ids = {c["name"]: c["columnId"] for c in cb["columns"]}
    context = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
               "scope": "all", "weightMode": "none"}
    request = {"context": context, "target": ids["y"], "predictors": [
        {"columnId": ids["x"], "kind": "numeric"}, *(
            [{"columnId": ids["g"], "kind": "categorical"}] if "g" in ids else [])]}
    return client, did, ids, request


def fit(client, request):
    response = client.post("/api/v1/models/regularized-regression", json=request)
    assert response.status_code == 200, response.text
    return response.json()


def test_ridge_fit_get_rows_predict_frozen_runtime_agree():
    client, did, ids, request = imported()
    result = fit(client, request)
    assert result["method"] == "regularized_regression"
    assert result["capabilities"]["predictionIntervals"] == ["none"]
    model = result["portableModel"]
    validate_model(model)
    assert model["training"]["libraryAlpha"] == pytest.approx(10 * .1)
    assert len([f for f in model["features"] if f["operation"] == "one_hot"]) == 2
    forbidden = {"standardError", "pValue", "ciLower", "ciUpper", "adjustedRSquared", "aic", "bic", "leverage", "cooksDistance"}
    assert not forbidden.intersection(result["summary"])
    assert all(not forbidden.intersection(row) for row in result["details"]["coefficients"])
    rid = result["resultId"]
    again = client.get(f"/api/v1/analysis-results/{rid}").json()
    assert again["portableModel"] == model
    fitted = client.get(f"/api/v1/analysis-results/{rid}/rows", params={"limit": 100}).json()
    assert fitted["total"] == 10
    response = client.post(f"/api/v1/analysis-results/{rid}/predict", json={
        "context": request["context"], "options": {"interval": "none", "evaluate": True}})
    assert response.status_code == 200, response.text
    prediction = response.json()
    assert prediction["summary"]["successfulPredictions"] == 10
    assert prediction["summary"]["evaluation"]["fitOverlapCount"] == 10
    pid = prediction["predictionId"]
    rows = client.get(f"/api/v1/analysis-results/{rid}/predictions/{pid}/rows").json()["rows"]
    assert all(set(row) == {"rowId", "predicted", "observed", "residual", "predictionStatus", "warnings"} for row in rows)
    records = store.get_dataframe(did).to_dicts()
    standalone = predict_batch(model, records)
    np.testing.assert_allclose([r["prediction"] for r in standalone], [r["fitted"] for r in fitted["rows"]], rtol=1e-10, atol=1e-10)
    np.testing.assert_allclose([r["prediction"] for r in standalone], [r["predicted"] for r in rows], rtol=1e-10, atol=1e-10)
    bad = client.post(f"/api/v1/analysis-results/{rid}/predict", json={
        "context": request["context"], "options": {"interval": "mean_ci", "evaluate": False}})
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "RR_INTERVAL_UNSUPPORTED"


@pytest.mark.parametrize("extra", [{"interactions": []}, {"covariance": "hc3"}, {"confidenceLevel": .95}, {"targetScale": True}, {"lambdaValue": 0}, {"cv": {"folds": 5}}, {"algorithm": "ols"}])
def test_strict_request_rejects_ols_and_legacy_fields(extra):
    client, _, _, request = imported()
    response = client.post("/api/v1/models/regularized-regression", json={**request, **extra})
    assert response.status_code == 422


@pytest.mark.parametrize("weight_type, code", [("survey", "RR_SURVEY_UNSUPPORTED"), (None, "WEIGHT_TYPE_REQUIRED")])
def test_saved_weight_never_silently_becomes_unweighted(weight_type, code):
    client, did, ids, request = imported(pl.DataFrame({"y": [1., 3., 5., 7.], "x": [0., 1., 2., 3.], "w": [1, 2, 3, 4]}))
    cb = store.load_codebook(did)
    cb["weightConfig"] = {"weightColumnId": ids["w"], "weightType": weight_type}
    for c in cb["columns"]:
        if c["columnId"] == ids["w"]:
            c["role"] = "weight"
    store.save_codebook(did, cb)
    request["context"]["weightMode"] = "dataset"
    response = client.post("/api/v1/models/regularized-regression", json=request)
    assert response.status_code == 422 and response.json()["error"]["code"] == code
    request["context"]["weightMode"] = "none"
    assert fit(client, request)["meta"]["weightApplied"] is False


def test_frequency_weight_and_missing_zero_exclusions():
    client, did, ids, request = imported(pl.DataFrame({"y": [1., 3., 5., 7., 9., 11.], "x": [0., 1., 2., 3., 4., 5.], "w": [1, 2, 0, None, 3, 4]}))
    cb = store.load_codebook(did)
    cb["weightConfig"] = {"weightColumnId": ids["w"], "weightType": "frequency"}
    for c in cb["columns"]:
        if c["columnId"] == ids["w"]:
            c["role"] = "weight"
    store.save_codebook(did, cb)
    request["context"]["weightMode"] = "dataset"
    result = fit(client, request)
    assert result["meta"]["fitCount"] == 4
    assert result["meta"]["exclusionCounts"]["zero_weight"] == 1
    assert result["meta"]["exclusionCounts"]["missing_weight"] == 1
    assert result["portableModel"]["training"]["libraryAlpha"] == pytest.approx(.4)
    assert result["meta"]["frequencyN"] == 10


def test_preflight_preserves_numeric_missing_codes_when_other_input_invalid():
    client, did, ids, request = imported(pl.DataFrame({"y": [1., 99., 5., 7., 9.], "x": ["0", "1", "1_000", "3", "4"]}))
    cb = store.load_codebook(did)
    for c in cb["columns"]:
        if c["columnId"] == ids["x"]:
            c.update(scaleType="ratio", role="attribute")
        if c["columnId"] == ids["y"]:
            c["missingCodes"] = ["99"]
    store.save_codebook(did, cb)
    # Import eagerly parses Python-compatible numeric strings. Preserve a
    # genuinely string-backed transformed input to exercise the model boundary.
    data = store.get_dataframe(did).with_columns(pl.Series("x", ["0", "1", "1_000", "3", "4"]))
    store.save(did, store.get_meta(did), data, cb)
    request["context"]["expectedDataRevision"] = store.get_meta(did)["dataRevision"]
    result = fit(client, request)
    assert result["meta"]["fitCount"] == 3
    assert result["meta"]["exclusionCounts"]["invalid"] == 1
    assert result["meta"]["exclusionCounts"]["missing"] == 1
    after = store.get_dataframe(did)
    assert after["x"].to_list()[2] == "1_000"  # Snapshot sanitation never mutates data.


def test_category_missing_policy_frozen_and_replayed():
    client, did, ids, request = imported(pl.DataFrame({"y": [1., 2., 3., 4., 5., 6.], "x": [0., 1., 2., 3., 4., 5.], "g": ["a", None, "a", "NA_CODE", "b", "b"]}))
    cb = store.load_codebook(did)
    for c in cb["columns"]:
        if c["columnId"] == ids["g"]:
            c.update(missingCodes=["NA_CODE"], missingReasons={"NA_CODE": "not_applicable"})
    store.save_codebook(did, cb)
    request["context"]["missingPolicy"] = "separate_not_applicable"
    result = fit(client, request)
    model = result["portableModel"]
    assert model["preprocessing"]["categoricalMissingPolicy"] == "separate_not_applicable"
    assert {c["kind"] for c in model["inputs"][1]["observedCategories"]} == {"value", "missing", "not_applicable"}
    predictions = predict_batch(model, store.get_dataframe(did).to_dicts())
    assert all(r["status"] == "ok" for r in predictions)


def test_empty_prediction_batch_is_valid():
    client, _, _, request = imported()
    result = fit(client, request)
    context = {**request["context"], "scope": "explicit", "rowIds": []}
    response = client.post(f'/api/v1/analysis-results/{result["resultId"]}/predict', json={
        "context": context, "options": {"interval": "none", "evaluate": False}})
    assert response.status_code == 200, response.text
    prediction = response.json()
    assert prediction["summary"]["requestedCount"] == 0
    response = client.get(f'/api/v1/analysis-results/{result["resultId"]}/predictions/{prediction["predictionId"]}/rows')
    assert response.status_code == 200 and response.json()["rows"] == []


def test_stale_predict_rejected_but_export_preserves_original_model():
    client, did, ids, request = imported()
    result = fit(client, request)
    rid = result["resultId"]
    before = copy.deepcopy(result["portableModel"])
    saved = client.put(f"/api/v1/datasets/{did}/codebook", json={"columns": [{"columnId": ids["g"], "label": "Changed", "categoryOrder": ["b", "a"]}]})
    assert saved.status_code == 200, saved.text
    context = {**request["context"], "expectedSchemaRevision": saved.json()["schemaRevision"]}
    predicted = client.post(f"/api/v1/analysis-results/{rid}/predict", json={
        "context": context, "options": {"interval": "none", "evaluate": False}})
    assert predicted.status_code == 409
    exported = client.post(f"/api/v1/analysis-results/{rid}/export-predict", json={
        "language": "python", "artifact": "model", "expectedModelVersion": "1"})
    assert exported.status_code == 200, exported.text
    assert json.loads(exported.json()["payload"]) == before
    assert results.load_manifest(rid)["portableModel"] == before


@pytest.mark.parametrize("artifact", ["model", "code", "schema", "readme", "test_vectors", "bundle"])
def test_each_artifact_is_individually_exportable(artifact):
    client, _, _, request = imported()
    result = fit(client, request)
    response = client.post(f'/api/v1/analysis-results/{result["resultId"]}/export-predict', json={
        "language": "javascript", "artifact": artifact, "expectedModelVersion": "1"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["modelId"] == result["resultId"]
    assert body["contentHash"] == result["portableModel"]["identity"]["contentHash"]
    assert body["encoding"] == ("base64" if artifact == "bundle" else "utf-8")


def test_known_psu_cv_refuses_random_split():
    client, did, ids, request = imported()
    cb = store.load_codebook(did)
    cb["surveyDesign"] = {"psuColumnId": ids["g"]}
    store.save_codebook(did, cb)
    request.update(selection="cv", cv={"folds": 2, "seed": 42, "lambdaValues": [.1, 1.], "l1Ratios": [.5], "independentRowsAcknowledged": True})
    response = client.post("/api/v1/models/regularized-regression", json=request)
    assert response.status_code == 422 and response.json()["error"]["code"] == "RR_CV_SPLIT_UNSUPPORTED"


@pytest.mark.parametrize("weights, expected", [([0, 0, 0, 0], "RR_NO_USABLE_ROWS"), ([1, -1, 2, 3], "WEIGHT_VALUE_INVALID"), ([1., 1.5, 2., 3.], "WEIGHT_FREQUENCY_NONINTEGER")])
def test_invalid_frequency_weights_never_fit(weights, expected):
    client, did, ids, request = imported(pl.DataFrame({"y": [1., 3., 5., 7.], "x": [0., 1., 2., 3.], "w": weights}))
    cb = store.load_codebook(did)
    cb["weightConfig"] = {"weightColumnId": ids["w"], "weightType": "frequency"}
    for c in cb["columns"]:
        if c["columnId"] == ids["w"]:
            c["role"] = "weight"
    store.save_codebook(did, cb)
    request["context"]["weightMode"] = "dataset"
    response = client.post("/api/v1/models/regularized-regression", json=request)
    assert response.status_code == 422 and response.json()["error"]["code"] == expected


def test_revision_change_during_fit_never_persists(monkeypatch):
    from app.algorithms.models import regularized_regression as kernel
    client, did, _, request = imported()
    original = kernel.fit_regularized
    before = set(results.results_root().iterdir())
    def changing(*args, **kwargs):
        output = original(*args, **kwargs)
        cb = store.load_codebook(did)
        cb["schemaRevision"] += 1
        store.save_codebook(did, cb)
        return output
    monkeypatch.setattr(kernel, "fit_regularized", changing)
    response = client.post("/api/v1/models/regularized-regression", json=request)
    assert response.status_code == 409
    assert set(results.results_root().iterdir()) == before


def test_numeric_missing_whitespace_uses_same_frozen_rule_for_fit_predict():
    client, did, ids, request = imported(pl.DataFrame({"y": [1., 3., 5., 7., 9.], "x": [0., 1., 99., 3., 4.]}))
    cb = store.load_codebook(did)
    for c in cb["columns"]:
        if c["columnId"] == ids["x"]:
            c["missingCodes"] = ["99"]
    data = store.get_dataframe(did).with_columns(pl.Series("x", ["0", " 1 ", " 99 ", "3", "4"]))
    store.save(did, store.get_meta(did), data, cb)
    request["context"]["expectedDataRevision"] = store.get_meta(did)["dataRevision"]
    result = fit(client, request)
    assert result["meta"]["fitCount"] == 4
    standalone = predict_batch(result["portableModel"], data.to_dicts())
    assert standalone[2]["status"] == "missing_value"
    assert [r["status"] for r in standalone[:2]] == ["ok", "ok"]


def test_unsupported_model_version_cannot_be_guessed(monkeypatch):
    client, _, _, request = imported()
    result = fit(client, request)
    corrupted = results.load_manifest(result["resultId"])
    corrupted["portableModel"]["schemaVersion"] = "davis.regularized-regression/99"
    original = results.load_manifest
    monkeypatch.setattr(results, "load_manifest", lambda rid: corrupted if rid == result["resultId"] else original(rid))
    response = client.post(f'/api/v1/analysis-results/{result["resultId"]}/predict', json={
        "context": request["context"], "options": {"interval": "none", "evaluate": False}})
    assert response.status_code == 422 and response.json()["error"]["code"] == "RR_MODEL_INVALID"


@pytest.mark.parametrize("raw, sentinel", [(99.5, "99.5"), (1e20, "1e20"), ("099.5", "99.5"), ("9.95e1", "99.5")])
def test_continuous_sentinel_equivalence_matches_fit_and_predict(raw, sentinel):
    client, did, ids, request = imported(pl.DataFrame({"y": [1., 3., 5., 7., 9.], "x": [0., 1., 2., 3., 4.]}))
    cb = store.load_codebook(did)
    for c in cb["columns"]:
        if c["columnId"] == ids["x"]:
            c["missingCodes"] = [sentinel]
    values = ["0", "1", "2", "3", raw] if isinstance(raw, str) else [0., 1., 2., 3., raw]
    data = store.get_dataframe(did).with_columns(pl.Series("x", values))
    store.save(did, store.get_meta(did), data, cb)
    request["context"]["expectedDataRevision"] = store.get_meta(did)["dataRevision"]
    result = fit(client, request)
    assert result["meta"]["fitCount"] == 4
    assert predict_batch(result["portableModel"], [{"x": raw}])[0]["status"] == "missing_value"


def test_strict_target_evaluation_does_not_restore_invalid_fit_value():
    client, did, _, request = imported(pl.DataFrame({"y": [1., 3., 5., 7., 9.], "x": [0., 1., 2., 3., 4.]}))
    data = store.get_dataframe(did).with_columns(pl.Series("y", ["1", "3", "1_000", "7", "9"]))
    store.save(did, store.get_meta(did), data, store.load_codebook(did))
    request["context"]["expectedDataRevision"] = store.get_meta(did)["dataRevision"]
    result = fit(client, request)
    prediction = client.post(f'/api/v1/analysis-results/{result["resultId"]}/predict', json={
        "context": request["context"], "options": {"interval": "none", "evaluate": True}})
    assert prediction.status_code == 200, prediction.text
    evaluation = prediction.json()["summary"]["evaluation"]
    assert evaluation["evaluatedCount"] == 4
    assert evaluation["fitOverlapCount"] == 4 and evaluation["nonFitEvaluationCount"] == 0


@pytest.mark.parametrize("sentinel", [99.5, 1e20])
def test_unsupported_category_number_cannot_bypass_type_rule_as_missing(sentinel):
    client, did, ids, request = imported(pl.DataFrame({"y": [1., 3., 5., 7., 9.], "x": [0., 1., 2., 3., 4.], "g": [1., 2., 1., 2., sentinel]}))
    cb = store.load_codebook(did)
    for c in cb["columns"]:
        if c["columnId"] == ids["g"]:
            c.update(scaleType="nominal", missingCodes=[str(int(sentinel)) if sentinel.is_integer() else str(sentinel)])
    store.save_codebook(did, cb)
    request["context"]["missingPolicy"] = "include_missing"
    result = fit(client, request)
    assert result["meta"]["fitCount"] == 4
    assert result["meta"]["exclusionCounts"]["invalid"] == 1
    assert predict_batch(result["portableModel"], [{"x": 4., "g": sentinel}])[0]["status"] == "invalid_type"


@pytest.mark.parametrize("algorithm", ["ridge", "lasso", "elasticnet"])
def test_cv_api_refits_frozen_model_and_separates_assignment_rows(algorithm):
    client, _, _, request = imported(pl.DataFrame({"y": [float(i) + (i % 3) / 10 for i in range(20)], "x": [float(i) for i in range(20)]}))
    request.update(algorithm=algorithm, selection="cv", cv={"folds": 5, "seed": 42, "lambdaValues": [.01, .1, 1.], "l1Ratios": [.2, .8], "independentRowsAcknowledged": True})
    result = fit(client, request)
    model = result["portableModel"]
    validate_model(model)
    assert model["training"]["cv"]["folds"] == 5
    assert model["training"]["lambdaValue"] == result["summary"]["lambdaValue"]
    assert "rowId" not in json.dumps(model["training"]["cv"])
    if algorithm == "ridge":
        assert model["training"]["libraryAlpha"] == pytest.approx(20 * model["training"]["lambdaValue"])


def test_evaluation_preserves_small_residuals_with_huge_offsets():
    from app.api.regularized_regression import _evaluation
    rows = [{"rowId": "a", "observed": 1e16, "predicted": 1e16 + 2},
            {"rowId": "b", "observed": 1e16 + 2, "predicted": 1e16 + 2}]
    metrics = _evaluation(rows, set())["metrics"]
    assert metrics["rmse"] == pytest.approx(np.sqrt(2), rel=1e-14)
    assert metrics["mae"] == pytest.approx(1., rel=1e-14)
    assert metrics["rSquared"] == pytest.approx(-1., rel=1e-14)


@pytest.mark.parametrize("value", [1, 1.0, "true", False])
def test_cv_independence_requires_literal_json_boolean_true(value):
    client, _, _, request = imported()
    request.update(selection="cv", cv={"folds": 2, "seed": 42, "lambdaValues": [.1], "l1Ratios": [.5], "independentRowsAcknowledged": value})
    assert client.post("/api/v1/models/regularized-regression", json=request).status_code == 422


def test_no_intercept_fit_and_prediction_use_same_centered_r_squared():
    client, _, _, request = imported(pl.DataFrame({"y": [11., 12., 13.], "x": [1., 2., 3.]}))
    request["intercept"] = False
    result = fit(client, request)
    response = client.post(f'/api/v1/analysis-results/{result["resultId"]}/predict', json={
        "context": request["context"], "options": {"interval": "none", "evaluate": True}})
    assert response.status_code == 200, response.text
    assert result["summary"]["fitRSquared"] == pytest.approx(response.json()["summary"]["evaluation"]["metrics"]["rSquared"], rel=1e-12)
