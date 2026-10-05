"""Empirical Türkiye margins must not acquire artificial integration boundaries."""
from __future__ import annotations

from functools import lru_cache
import math

import numpy as np
import pytest
from scipy.integrate import quad
from scipy.optimize import minimize_scalar
from scipy.special import ndtr
from scipy.stats import norm

from app.algorithms.models import ordinal_correlations as ordinal
from app.services.builtin_samples import load_sample


@lru_cache(maxsize=1)
def source():
    return load_sample("turkiye-student-evaluation-600")[0]


def empirical_pair(first, second):
    counts = np.zeros((5, 5), dtype=int)
    for x, y in zip(first, second):
        counts[int(x) - 1, int(y) - 1] += 1
    row = norm.ppf(np.cumsum(counts.sum(axis=1))[:-1] / counts.sum())
    col = norm.ppf(np.cumsum(counts.sum(axis=0))[:-1] / counts.sum())
    return counts, row, col


def adaptive_probability(a, b, c, d, rho):
    scale = math.sqrt(1 - rho*rho)
    def integrand(z):
        low, high = (c-rho*z)/scale, (d-rho*z)/scale
        probability = ndtr(-low)-ndtr(-high) if low > 0 else ndtr(high)-ndtr(low)
        return math.exp(-.5*z*z) / math.sqrt(2*math.pi) * probability
    return quad(integrand, a, b, epsabs=1e-12, epsrel=1e-12, limit=200)[0]


def independent_nll(counts, row, col, rho):
    rows, columns = np.r_[-np.inf, row, np.inf], np.r_[-np.inf, col, np.inf]
    value = 0.
    for i, j in zip(*np.nonzero(counts)):
        probability = adaptive_probability(rows[i], rows[i+1], columns[j], columns[j+1], rho)
        if probability <= 0:
            return np.inf
        value -= counts[i, j] * math.log(probability)
    return value


@pytest.mark.parametrize("transpose", [False, True], ids=["original-order", "transposed"])
@pytest.mark.parametrize("sign", [1, -1], ids=["identical", "reversed-identical"])
def test_empirical_perfect_association_is_boundary_not_false_interior_success(sign, transpose):
    first = source()["Q1"].to_numpy()
    second = first if sign == 1 else 6-first
    counts, row, col = empirical_pair(first, second)
    assert counts.sum(axis=1).tolist() == [107, 93, 163, 147, 90]
    if transpose:
        counts, row, col = counts.T, col, row
    fit = ordinal.polychoric_pair(counts, row, col)
    upper_likelihood = independent_nll(counts, row, col, sign*ordinal.RHO_BOUND)
    oracle = minimize_scalar(lambda magnitude: independent_nll(counts, row, col, sign*magnitude),
                             bounds=(.9, ordinal.RHO_BOUND), method="bounded",
                             options={"xatol": 1e-10, "maxiter": 150})
    assert oracle.success
    assert ordinal.RHO_BOUND-oracle.x < 1e-6
    assert upper_likelihood < independent_nll(counts, row, col, sign*.9976)
    assert fit["status"] == "boundary", fit
    assert fit["reasonCode"] == "FA_CORRELATION_BOUNDARY"
    assert fit["boundary"] is True
    assert abs(fit["rho"]-sign*ordinal.RHO_BOUND) < ordinal.BOUNDARY_MARGIN
    assert independent_nll(counts, row, col, fit["rho"]) == pytest.approx(upper_likelihood, abs=.01, rel=0)


@pytest.mark.parametrize("sign", [1, -1], ids=["upper-bound", "lower-bound"])
def test_boundary_tail_rectangle_obeys_declared_integration_tolerance(sign):
    first = source()["Q1"].to_numpy()
    counts, row, col = empirical_pair(first, first if sign == 1 else 6-first)
    rows, columns = np.r_[-np.inf, row, np.inf], np.r_[-np.inf, col, np.inf]
    j = 0 if sign == 1 else 4
    args = (rows[0], rows[1], columns[j], columns[j+1], sign*ordinal.RHO_BOUND)
    expected = adaptive_probability(*args)
    probability, error = ordinal.rectangle_probability(*args)
    tolerance = max(ordinal.QUAD_EPSABS, ordinal.QUAD_EPSREL*abs(expected))
    assert probability == pytest.approx(expected, abs=tolerance, rel=0)
    assert error <= tolerance


@pytest.mark.parametrize("first,second", [("Q1", "Q2"), ("Q21", "Q22")])
def test_actual_interior_pair_retains_independent_likelihood_optimum(first, second):
    frame = source()
    counts, row, col = empirical_pair(frame[first].to_numpy(), frame[second].to_numpy())
    oracle = minimize_scalar(lambda rho: independent_nll(counts, row, col, rho),
                             bounds=(.5, .9999), method="bounded", options={"xatol": 1e-10})
    fit = ordinal.polychoric_pair(counts, row, col)
    assert fit["status"] == "success" and fit["boundary"] is False
    assert fit["rho"] == pytest.approx(oracle.x, abs=1e-7, rel=0)
    assert fit["negLogLik"] == pytest.approx(oracle.fun, abs=1e-6, rel=0)


def test_extreme_positive_tail_rectangle_uses_stable_survival_probability():
    # At independence the exact rectangle probability is the marginal product.
    expected = float((norm.sf(9.) - norm.sf(10.)) ** 2)
    assert expected > 0
    probability, error = ordinal.rectangle_probability(9., 10., 9., 10., 0.)
    assert probability == pytest.approx(expected, rel=1e-11, abs=0)
    assert np.isfinite(error)


@pytest.mark.parametrize("status", ["boundary", "success"])
def test_parallel_analysis_never_accepts_positive_definite_boundary_replicates(status):
    from app.algorithms.models.factor_parallel import parallel_analysis

    frame = source()
    codes = frame.select("Q1", "Q2", "Q3").to_numpy()-1
    boundary = np.asarray([[1., .9999, .2], [.9999, 1., .2], [.2, .2, 1.]])
    interior = np.asarray([[1., .4, .2], [.4, 1., .2], [.2, .2, 1.]])
    matrix = boundary if status == "boundary" else interior
    assert np.linalg.eigvalsh(matrix).min() > 0
    result = parallel_analysis(codes, lambda _x: {
        "correlation": matrix, "status": status,
        "reasonCode": "FA_CORRELATION_BOUNDARY" if status == "boundary" else None},
        iterations=3, seed=19)
    if status == "boundary":
        assert result["iterationsSucceeded"] == 0
        assert result["iterationsFailed"] == 3
        assert result["status"] != "completed"
        assert result["referenceQuantiles"] is None
        assert result["reasonCode"] == "PA_REPLICATE_FAILED"
    else:
        assert result["iterationsSucceeded"] == 3
        assert result["iterationsFailed"] == 0
        assert result["status"] == "completed"
        np.testing.assert_allclose(result["referenceQuantiles"], np.linalg.eigvalsh(matrix)[::-1], atol=1e-12)


@pytest.mark.parametrize("failure", ["exception", "excess_error"])
def test_genuine_adaptive_refinement_failure_never_becomes_interior_success(monkeypatch, failure):
    values = source()["Q1"].to_numpy()
    counts, row, col = empirical_pair(values, values)
    calls = []
    def failed_quadrature(*_args, **_kwargs):
        calls.append(True)
        if failure == "exception":
            raise ArithmeticError("forced adaptive integration failure")
        return .1, 1e-4, {}
    monkeypatch.setattr(ordinal.integrate, "quad", failed_quadrature)
    fit = ordinal.polychoric_pair(counts, row, col)
    assert calls, "Control did not exercise adaptive refinement"
    assert fit["status"] == "failed"
    assert fit["rho"] is None and fit["boundary"] is False
    assert fit["reasonCode"] == "FA_CORRELATION_NONCONVERGENCE"
    assert fit["integrationFailureCount"] > 0
    assert fit["integrationFailures"]
    if failure == "excess_error":
        assert fit["integrationError"] > ordinal.QUAD_EPSABS
        assert any("tolerance" in example["detail"] for example in fit["integrationFailures"])
    else:
        assert any("forced adaptive" in example["detail"] for example in fit["integrationFailures"])


@pytest.mark.parametrize("kind", ["non-positive-definite", "singular", "near-singular", "ordinary-positive-definite"])
def test_parallel_analysis_validates_successful_correlation_matrix(kind):
    from app.algorithms.models.factor_parallel import parallel_analysis

    if kind == "non-positive-definite":
        matrix = np.asarray([[1., .9, .9], [.9, 1., -.9], [.9, -.9, 1.]])
    elif kind == "singular":
        matrix = np.ones((3, 3))
    elif kind == "near-singular":
        matrix = np.full((3, 3), 1-1e-12)
        np.fill_diagonal(matrix, 1.)
    else:
        matrix = np.asarray([[1., .4, .2], [.4, 1., .2], [.2, .2, 1.]])
    validation = ordinal.validate_correlation_matrix(matrix)
    assert validation["positiveDefinite"] == (kind == "ordinary-positive-definite")
    codes = source().select("Q1", "Q2", "Q3").to_numpy()-1
    result = parallel_analysis(codes, lambda _codes: {"status": "success", "correlation": matrix},
                               iterations=3, seed=19)
    if validation["positiveDefinite"]:
        assert result["status"] == "completed"
        assert result["iterationsSucceeded"] == 3 and result["iterationsFailed"] == 0
        np.testing.assert_allclose(result["referenceQuantiles"], np.linalg.eigvalsh(matrix)[::-1], atol=1e-12)
    else:
        assert result["status"] == "failed"
        assert result["iterationsSucceeded"] == 0 and result["iterationsFailed"] == 3
        assert result["referenceQuantiles"] is None and result["suggestedFactors"] is None
        assert result["reasonCode"] == "PA_REPLICATE_FAILED"
        assert {failure["reasonCode"] for failure in result["replicateFailures"]} == {validation["reasonCode"]}
