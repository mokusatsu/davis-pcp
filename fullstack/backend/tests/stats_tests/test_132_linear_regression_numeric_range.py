"""N04: finite response rescaling must preserve inference or fail explicitly."""
from __future__ import annotations

import json
import math
import uuid
from fractions import Fraction

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient
from scipy import stats

from app.api import datasets
from app.algorithms.models.linear_regression import (
    LinearRegressionNumericRangeError,
    mean_ci_half_width,
    individual_pi_half_width,
    normalize_response,
    rescale_response_quantity,
    solve_weighted_least_squares,
)
from app.main import app
from app.storage import analysis_result_store


Y = np.array([1., 1., 3., 5., 4., 6.])
X = np.column_stack([np.ones(6), np.arange(6.)])


def _request(scale=1., covariance="classical", intercept=True):
    did = "lr-numeric-" + uuid.uuid4().hex
    datasets._finalize_dataset(
        did, "numeric-range", "csv",
        pl.DataFrame({"x": X[:, 1], "y": Y * scale}), None)
    cb = datasets.store.load_codebook(did)
    cols = {c["name"]: c["columnId"] for c in cb["columns"]}
    return {
        "context": {"datasetId": did, "expectedDataRevision": 1,
                    "expectedSchemaRevision": cb["schemaRevision"],
                    "scope": "all", "weightMode": "none"},
        "target": cols["y"],
        "predictors": [{"columnId": cols["x"], "kind": "numeric"}],
        "intercept": intercept, "covariance": covariance,
        "confidenceLevel": .95,
    }


def _post(request):
    return TestClient(app, raise_server_exceptions=False).post(
        "/api/v1/models/linear-regression", json=request)


@pytest.mark.parametrize("scale", [1., 1e150, 1e154, 1e-150])
def test_classical_extreme_response_exact_oracle(scale):
    response = _post(_request(scale))
    assert response.status_code == 200, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    # Exact rational normal-equation solution and residual sum of squares,
    # independent of the implementation's LAPACK/scaled-response route.
    beta = np.array([float(Fraction(16, 21)), float(Fraction(36, 35))])
    sse = float(Fraction(296, 105))
    variance = np.array([float(Fraction(814, 2205)),
                         float(Fraction(148, 3675))])
    se = np.sqrt(variance)
    rows = result["details"]["coefficients"]
    np.testing.assert_allclose([r["estimate"] / scale for r in rows], beta, rtol=1e-12)
    np.testing.assert_allclose([r["standardError"] / scale for r in rows], se, rtol=1e-12)
    np.testing.assert_allclose([r["statistic"] for r in rows], beta / se, rtol=1e-12)
    np.testing.assert_allclose([r["pValue"] for r in rows],
                               2 * stats.t.sf(abs(beta / se), 4), rtol=1e-12)
    assert result["summary"]["rSquared"] == pytest.approx(float(Fraction(243, 280)))
    assert result["summary"]["rmse"] / scale == pytest.approx(math.sqrt(sse / 6))
    assert result["summary"]["residualStdError"] / scale == pytest.approx(math.sqrt(sse / 4))
    loglik = -3 * (math.log(2 * math.pi) + 1 + math.log(sse / 6) + 2 * math.log(scale))
    assert result["summary"]["logLikelihood"] == pytest.approx(loglik)
    assert result["summary"]["aic"] == pytest.approx(-2 * loglik + 6)
    assert result["summary"]["bic"] == pytest.approx(-2 * loglik + 3 * math.log(6))
    arrays = analysis_result_store.load_arrays(result["resultId"])
    assert np.isfinite(arrays["cov"]).all()
    assert np.isfinite(arrays["sigma2"]).all()
    manifest = analysis_result_store.load_manifest(result["resultId"])
    json.dumps(manifest, allow_nan=False)


@pytest.mark.parametrize("covariance", ["classical", "hc3"])
@pytest.mark.parametrize("intercept", [True, False])
def test_extreme_response_keeps_dimensionless_inference_and_diagnostics(covariance, intercept):
    base = _post(_request(covariance=covariance, intercept=intercept)).json()
    response = _post(_request(1e154, covariance, intercept))
    assert response.status_code == 200, response.text
    result = response.json()
    for key in ("rSquared", "adjustedRSquared"):
        assert result["summary"][key] == pytest.approx(base["summary"][key])
    for base_row, row in zip(base["details"]["coefficients"], result["details"]["coefficients"]):
        for key in ("estimate", "standardError", "ciLower", "ciUpper"):
            assert row[key] / 1e154 == pytest.approx(base_row[key])
        for key in ("statistic", "pValue", "standardizedEstimate"):
            if base_row[key] is None:
                assert row[key] is None
            else:
                assert row[key] == pytest.approx(base_row[key])
    for key in ("studentizedResidual", "cooksDistance", "leverageTotal"):
        np.testing.assert_allclose(result["details"]["designDiagnostics"][key],
                                   base["details"]["designDiagnostics"][key], rtol=1e-12)


@pytest.mark.parametrize("scale", [1e155, 1e-170])
@pytest.mark.parametrize("covariance", ["classical", "hc3"])
def test_unrepresentable_variance_is_structured_422_with_finite_partial(scale, covariance, monkeypatch):
    def forbidden_save(*args, **kwargs):
        pytest.fail("An out-of-range result must not be persisted")
    monkeypatch.setattr(analysis_result_store, "save_result", forbidden_save)
    response = _post(_request(scale, covariance))
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "LR_NUMERIC_RANGE"
    details = error["details"]
    assert details["fields"]
    assert any("covariance" in field or "sigma2" in field for field in details["fields"])
    partial = details["partialResult"]
    assert partial["rSquared"] == pytest.approx(float(Fraction(243, 280)))
    assert partial["rmse"] / scale == pytest.approx(math.sqrt(float(Fraction(148, 315))))
    np.testing.assert_allclose(np.asarray(partial["estimates"]) / scale, [16/21, 36/35])
    assert all(math.isfinite(v) and v > 0 for v in partial["standardErrors"])
    json.dumps(details, allow_nan=False)


def test_extreme_saved_fit_prediction_evaluation_and_intervals():
    request = _request(1e154)
    response = _post(request)
    assert response.status_code == 200, response.text
    result_id = response.json()["resultId"]
    client = TestClient(app, raise_server_exceptions=False)
    response = client.post(f"/api/v1/analysis-results/{result_id}/predict", json={
        "context": request["context"],
        "options": {"interval": "individual_pi", "evaluate": True}})
    assert response.status_code == 200, response.text
    result = response.json()
    metrics = result["summary"]["evaluation"]["metrics"]
    assert metrics["rSquared"] == pytest.approx(float(Fraction(243, 280)))
    assert metrics["rmse"] / 1e154 == pytest.approx(math.sqrt(float(Fraction(148, 315))))
    rows = analysis_result_store.load_prediction_rows(result_id, result["predictionId"])
    for row in rows.rows(named=True):
        assert row["status"] == "ok"
        for key in ("predicted", "meanCiLower", "meanCiUpper", "individualPiLower", "individualPiUpper"):
            assert math.isfinite(row[key])


@pytest.mark.parametrize("scale", [1e154, 1e-170])
def test_direct_solver_reports_unrepresentable_sse(scale):
    with pytest.raises(LinearRegressionNumericRangeError) as caught:
        solve_weighted_least_squares(X, Y * scale, None)
    assert caught.value.field == "sse"


@pytest.mark.parametrize("value,scale,power,expected", [
    (1e-300, 1e160, 2, 1e20),
    (1e300, 1e-160, 2, 1e-20),
    (-.25, 1e154, 2, -2.5e307),
    (0., 1e308, 2, 0.),
])
def test_rescaling_does_not_overflow_or_underflow_intermediates(value, scale, power, expected):
    assert rescale_response_quantity(value, scale, power) == pytest.approx(expected, rel=1e-14, abs=0)


@pytest.mark.parametrize("scale", [1e170, 1e-170])
def test_rescaling_rejects_true_overflow_and_nonzero_to_zero(scale):
    with pytest.raises(LinearRegressionNumericRangeError):
        rescale_response_quantity(1., scale, 2)


def test_constant_zero_response_still_has_legitimate_zero_error():
    normalized, scale = normalize_response(np.zeros(6))
    assert scale == 1
    assert np.array_equal(normalized, np.zeros(6))
    sol = solve_weighted_least_squares(X, normalized, None)
    assert sol["sse"] == 0
    assert np.array_equal(sol["beta"], np.zeros(2))
    assert rescale_response_quantity(0., 1e308, 2) == 0


def test_prediction_intervals_preserve_computable_root_of_overflowed_variance():
    # 4 * 1e308 and 4 * 1e308 + 1e308 exceed float64, but their
    # square roots and the confidence half-widths remain representable.
    covariance = np.array([[1e308]])
    assert mean_ci_half_width(np.array([2.]), covariance, 2.) == pytest.approx(4e154)
    assert individual_pi_half_width(np.array([2.]), covariance, 1e308, 2., True) == pytest.approx(2 * math.sqrt(5) * 1e154)
