"""Unit changes must not change a fitted model or its inference (N01–N03)."""
from __future__ import annotations

import json
import uuid

import numpy as np
import polars as pl
import pytest
from scipy import optimize, special, stats

from app.algorithms.models.logistic import run_logistic_regression
from app.algorithms.models.pca import compute_pca
from app.domain.errors import BizError


X = np.repeat(np.arange(-2., 3.), 4)
Y = np.array([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1])


def _oracle():
    # Independent one-dimensional score root, followed by the unregularized
    # Fisher information. Symmetry fixes the intercept at zero.
    beta = optimize.brentq(lambda b: X @ (special.expit(X * b) - Y), -5, 5)
    probability = special.expit(X * beta)
    design = np.column_stack([np.ones(len(X)), X])
    covariance = np.linalg.inv(design.T @ (design * (probability * (1 - probability))[:, None]))
    return beta, covariance, probability


@pytest.mark.parametrize("scale", [1., 1e-6, 1e6, 1e154, 1e-162])
@pytest.mark.parametrize("offset", [0., 7.])
def test_logistic_fisher_inference_is_invariant_to_units(scale, offset):
    beta, covariance, probability = _oracle()
    got = run_logistic_regression(pl.DataFrame({"x": (X + offset) * scale, "y": Y}), "y", ["x"])
    slope, intercept = got["coefficients"][1], got["coefficients"][0]
    assert got["fitMetrics"]["converged"] is True
    assert slope["coefficient"] * scale == pytest.approx(beta, rel=2e-6)
    assert slope["stdError"] * scale == pytest.approx(np.sqrt(covariance[1, 1]), rel=2e-6)
    assert slope["pValue"] == pytest.approx(2 * stats.norm.sf(abs(beta) / np.sqrt(covariance[1, 1])), abs=1e-6)
    assert intercept["coefficient"] == pytest.approx(-offset * beta, abs=2e-6)
    transform = np.array([1., -offset])
    assert intercept["stdError"] == pytest.approx(np.sqrt(transform @ covariance @ transform), rel=2e-6)
    np.testing.assert_allclose([s["predictedProb"] for s in got["samples"]], probability, atol=5.1e-6)
    assert all(p["x"] != 0 for p in got["curves"]["x"][:1])
    json.dumps(got, allow_nan=False)


def test_logistic_unrepresentable_inference_has_explicit_range_error():
    with pytest.raises(BizError) as error:
        run_logistic_regression(pl.DataFrame({"x": X * 1e-310, "y": Y}), "y", ["x"])
    assert error.value.code == "LOGISTIC_NUMERIC_RANGE"
    assert error.value.status_code == 422
    json.dumps(error.value.details, allow_nan=False)


@pytest.mark.parametrize("scale", [1e-162, 1e154])
def test_logistic_no_intercept_preserves_origin_and_inference(scale):
    x = np.arange(1., 13.)
    y = np.array([0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 1])
    beta = optimize.brentq(lambda b: x @ (special.expit(x * b) - y), -2, 2)
    probability = special.expit(x * beta)
    se = 1 / np.sqrt(np.sum(x * x * probability * (1 - probability)))
    got = run_logistic_regression(pl.DataFrame({"x": x * scale, "y": y}), "y", ["x"], intercept=False)
    coefficient = got["coefficients"][0]
    assert coefficient["coefficient"] * scale == pytest.approx(beta, abs=1e-6)
    assert coefficient["stdError"] * scale == pytest.approx(se, rel=2e-6)
    assert coefficient["pValue"] == pytest.approx(2 * stats.norm.sf(beta / se), abs=1e-6)
    for point in got["curves"]["x"]:
        assert point["probability"] == pytest.approx(special.expit(point["x"] / scale * beta), abs=5.1e-5)


def test_logistic_near_float_max_keeps_curves_and_estimates_finite():
    got = run_logistic_regression(pl.DataFrame({"x": X * 8e307, "y": Y}), "y", ["x"])
    beta, covariance, _ = _oracle()
    assert got["coefficients"][1]["coefficient"] * 8e307 == pytest.approx(beta, rel=2e-6)
    assert got["coefficients"][1]["stdError"] * 8e307 == pytest.approx(np.sqrt(covariance[1, 1]), rel=2e-6)
    assert got["curves"]["x"][0]["x"] == -1.6e308
    assert got["curves"]["x"][-1]["x"] == 1.6e308
    json.dumps(got, allow_nan=False)


def test_logistic_exponentiation_status_is_not_a_fitted_model_failure():
    got = run_logistic_regression(pl.DataFrame({"x": X * 1e-6, "y": Y}), "y", ["x"])
    coefficient = got["coefficients"][1]
    assert coefficient["exponentiationStatus"] == {
        "oddsRatio": "overflow", "ciLower": "underflow", "ciUpper": "overflow"}
    assert coefficient["oddsRatio"] is None
    assert coefficient["stdError"] > 0
    assert coefficient["pValue"] == pytest.approx(.07399609729, abs=1e-6)


def test_logistic_singular_information_never_invents_wald_significance():
    frame = pl.DataFrame({"x": X, "duplicate": X * 1e-162, "y": Y})
    got = run_logistic_regression(frame, "y", ["x", "duplicate"])
    assert got["diagnostics"]["inferenceStatus"] == "unavailable"
    assert any(w["code"] == "LOGISTIC_INFERENCE_UNAVAILABLE" for w in got["warnings"])
    for coefficient in got["coefficients"]:
        assert coefficient["coefficient"] is not None
        assert coefficient["stdError"] is None
        assert coefficient["pValue"] is None
        assert coefficient["logCiLower"] is None
        assert coefficient["exponentiationStatus"]["ciLower"] == "unavailable"
        assert coefficient["inferenceReason"] == "SINGULAR_INFORMATION"
    json.dumps(got, allow_nan=False)


@pytest.mark.parametrize("regularization", ["l1", "l2"])
def test_logistic_does_not_claim_convergence_at_sklearn_iteration_limit(monkeypatch, regularization):
    from app.algorithms.models import logistic

    class ExhaustedSolver:
        def __init__(self, **kwargs):
            self.max_iter = kwargs["max_iter"]

        def fit(self, design, y):
            self.coef_ = np.zeros((1, design.shape[1]))
            self.n_iter_ = np.array([self.max_iter])

    monkeypatch.setattr(logistic, "LogisticRegression", ExhaustedSolver)
    got = run_logistic_regression(pl.DataFrame({"x": X, "y": Y}), "y", ["x"], regularization=regularization)
    assert got["fitMetrics"]["converged"] is False
    assert any(w["code"] == "LOGISTIC_OPTIMIZER_NOT_CONVERGED" for w in got["warnings"])


@pytest.mark.parametrize("scale", [1., 1e154, 1e-162])
def test_correlation_pca_uses_full_scale_invariant_spectrum(scale):
    # Pearson r is exactly 27/35; hence lambda = 1 +/- 27/35.
    frame = pl.DataFrame({"x": np.arange(6.) * scale, "z": np.array([1., 3., 2., 6., 4., 5.]) * scale})
    full = compute_pca(frame)
    short = compute_pca(frame, n_components=1)
    np.testing.assert_allclose(full["eigenvalues"], [62 / 35, 8 / 35], atol=5.1e-6)
    assert short["kaiserThresholdComponents"] == full["kaiserThresholdComponents"] == 1
    assert short["explainedVarianceRatio"][0] == pytest.approx(31 / 35, abs=5.1e-5)
    assert short["cumulativeVarianceRatio"] == short["explainedVarianceRatio"]
    scores = np.array([row["pc"] for row in full["scores"]])
    np.testing.assert_allclose(np.var(scores, axis=0, ddof=1), [62 / 35, 8 / 35], atol=1e-4)
    json.dumps(full, allow_nan=False)


@pytest.mark.parametrize("scale", [1e154, 1e-162])
def test_covariance_pca_unrepresentable_eigenvalues_are_explicit(scale):
    frame = pl.DataFrame({"x": np.arange(6.) * scale, "z": np.array([1., 3., 2., 6., 4., 5.]) * scale})
    with pytest.raises(BizError) as error:
        compute_pca(frame, use_correlation=False)
    assert error.value.code == "PCA_NUMERIC_RANGE"
    assert error.value.status_code == 422


def test_covariance_pca_wide_design_kaiser_includes_implicit_zero_eigenvalues():
    # Three rows, four variables, rank two; sample covariance eigenvalues
    # [8, 6, 0, 0] have mean 3.5, even if only one component is requested.
    matrix = np.array([[2., -1.], [-2., -1.], [0., 2.]])
    # Duplicate independent columns keeps all four nonconstant.
    matrix = matrix[:, [0, 1, 0, 1]]
    frame = pl.DataFrame({f"q{i}": matrix[:, i] for i in range(4)})
    expected = np.linalg.eigvalsh(matrix.T @ matrix / 2)[::-1]
    assert np.count_nonzero(expected >= expected.mean()) == 2
    for k in [1, 2]:
        got = compute_pca(frame, use_correlation=False, n_components=k)
        assert got["kaiserThreshold"] == pytest.approx(expected.mean())
        assert got["kaiserThresholdComponents"] == 2


def test_correlation_pca_independent_column_units_and_row_order():
    matrix = np.array([[0., 1.], [1., 3.], [2., 2.], [3., 6.], [4., 4.], [5., 5.]])
    base = compute_pca(pl.DataFrame({"x": matrix[:, 0], "z": matrix[:, 1]}))
    scaled = compute_pca(pl.DataFrame({"x": matrix[::-1, 0] * 1e-162, "z": matrix[::-1, 1] * 1e154}))
    np.testing.assert_allclose(scaled["eigenvalues"], base["eigenvalues"], rtol=1e-12)
    scores = np.array([r["pc"] for r in scaled["scores"]])[::-1]
    base_scores = np.array([r["pc"] for r in base["scores"]])
    # Sign conventions may change, but pairwise score Gram matrices may not.
    np.testing.assert_allclose(scores @ scores.T, base_scores @ base_scores.T, atol=1e-12)


def test_covariance_pca_cannot_silently_erase_a_nonconstant_column():
    frame = pl.DataFrame({"x": np.arange(6.) * 1e154, "z": np.array([1., 3., 2., 6., 4., 5.]) * 1e-200})
    with pytest.raises(BizError) as error:
        compute_pca(frame, use_correlation=False)
    assert error.value.code == "PCA_NUMERIC_RANGE"


@pytest.mark.parametrize("model,scale,status,code", [
    ("logistic", 1e154, 200, None), ("logistic", 1e-162, 200, None),
    ("logistic", 1e-310, 422, "LOGISTIC_NUMERIC_RANGE"),
    ("pca", 1e154, 200, None), ("pca", 1e-162, 200, None),
])
def test_numeric_scale_real_http_contract(model, scale, status, code):
    from fastapi.testclient import TestClient
    from app.api import datasets
    from app.main import app

    data = {"x": X * scale, "y": Y} if model == "logistic" else {
        "x": np.arange(6.) * scale, "z": np.array([1., 3., 2., 6., 4., 5.]) * scale}
    dataset_id = "numeric-scale-" + uuid.uuid4().hex
    datasets._finalize_dataset(dataset_id, "numeric-scale.csv", "csv", pl.DataFrame(data), None)
    codebook = datasets.store.load_codebook(dataset_id)
    datasets.update_codebook(dataset_id, {"columns": [
        {"columnId": c["columnId"], "scaleType": "ratio", "role": "question"} for c in codebook["columns"]]})
    body = {"datasetId": dataset_id, "targetColumn": "y", "featureColumns": ["x"], "regularization": "none"} if model == "logistic" else {"datasetId": dataset_id, "columns": ["x", "z"]}
    response = TestClient(app, raise_server_exceptions=False).post("/api/v1/models/" + model, json=body)
    assert response.status_code == status, response.text
    result = response.json()
    json.dumps(result, allow_nan=False)
    if code:
        assert result["error"]["code"] == code
    elif model == "logistic":
        assert result["coefficients"][1]["pValue"] == pytest.approx(.07399609729, abs=1e-6)
        assert result["fitMetrics"]["converged"] is True
    else:
        np.testing.assert_allclose(result["eigenvalues"], [62 / 35, 8 / 35], atol=5.1e-6)
