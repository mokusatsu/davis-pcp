"""Unit tests for EFA kernels (Feature 033, B0-B2)."""
from __future__ import annotations

import numpy as np
import pytest

from app.algorithms.models.ordinal_correlations import (
    pearson_correlation,
    polychoric_pair,
    rectangle_probability,
    validate_correlation_matrix,
)
from app.algorithms.models.factor_analysis_uls import (
    fit_uls_profile,
    finite_difference_gradient,
    uls_profile_gradient,
    uls_profile_objective,
)
from app.algorithms.models.factor_analysis_ml import (
    fit_ml_profile,
    ml_profile,
    ml_profile_gradient,
)
from app.algorithms.models.factor_rotations import (
    factor_scores,
    rotate_solution,
)
from app.algorithms.models.factor_parallel import (
    full_correlation_eigenvalues,
    suggest_factors,
)
from app.algorithms.models.factor_sensitivity import (
    align_factors,
    definite_assignments,
)
from app.domain.analysis_contracts import EFARequest


def _synth(n=400, seed=1):
    rng = np.random.default_rng(seed)
    p = 6
    L = np.zeros((p, 2))
    L[:3, 0] = [0.8, 0.7, 0.6]
    L[3:, 1] = [0.8, 0.7, 0.6]
    Phi = np.array([[1.0, 0.3], [0.3, 1.0]])
    psi = 1 - np.diag(L @ Phi @ L.T)
    Sig = L @ Phi @ L.T + np.diag(psi)
    X = rng.multivariate_normal(np.zeros(p), Sig, size=n)
    R = np.corrcoef(X, rowvar=False)
    return X, R, Sig


def test_pearson_shared_set():
    X, R, _ = _synth()
    out = pearson_correlation(X)
    assert np.allclose(out["correlation"], R, atol=1e-10)
    assert np.allclose(np.diag(out["correlation"]), 1.0)


def test_matrix_validation_rejects_non_pd():
    R = np.array([[1.0, 0.99, 0.99], [0.99, 1.0, 0.0], [0.99, 0.0, 1.0]])
    rec = validate_correlation_matrix(R)
    assert rec["positiveDefinite"] is False
    assert rec["reasonCode"] == "FA_NON_POSITIVE_DEFINITE"


def test_rectangle_probability_sums_to_one():
    tau = np.array([-0.5, 0.5])
    edges = np.concatenate([[-np.inf], tau, [np.inf]])
    total = 0.0
    for i in range(3):
        for j in range(3):
            p, err = rectangle_probability(edges[i], edges[i + 1], edges[j], edges[j + 1], 0.3)
            assert np.isfinite(p) and p >= 0
            total += p
    assert abs(total - 1.0) < 1e-6


def test_polychoric_pair_recovers_positive():
    counts = np.array([[40, 30, 20, 10, 5], [30, 40, 30, 20, 10], [20, 30, 40, 30, 20],
                       [10, 20, 30, 40, 30], [5, 10, 20, 30, 40]], dtype=float)
    tau = np.array([-1.2, -0.4, 0.4, 1.2])
    rec = polychoric_pair(counts, tau, tau)
    assert rec["status"] == "success"
    assert rec["rho"] is not None and rec["rho"] > 0.2


def test_uls_gradient_matches_finite_difference():
    _, R, _ = _synth()
    u = np.full(6, 0.5)
    g = uls_profile_gradient(u, R, 2)
    gf = finite_difference_gradient(lambda v: uls_profile_objective(np.asarray(v), R, 2)[0], u)
    assert float(np.max(np.abs(g - gf))) < 1e-5


def test_ml_gradient_matches_finite_difference():
    _, R, _ = _synth()
    psi = np.full(6, 0.5)
    g = ml_profile_gradient(psi, R, 2)
    gf = finite_difference_gradient(lambda v: ml_profile(np.asarray(v), R, 2)[0], psi)
    assert float(np.max(np.abs(g - gf))) < 1e-4


def test_uls_and_ml_fit_and_objective_separation():
    _, R, _ = _synth()
    u = fit_uls_profile(R, 2, n_starts=2, maxiter=500, seed=1)
    assert u["status"] == "success"
    assert u["objectiveId"] == "uls_profile_full_v1"
    assert u["psi"] is not None and u["u"] is not None
    # u (optimizer diagonal) and psi (reported uniqueness) are stored
    # as separate arrays even when numerically close at the optimum.
    assert u["u"] is not u["psi"] and len(u["u"]) == len(u["psi"])
    assert u["offDiagonalSse"] is not None and u["offDiagonalSse"] <= u["objective"] + 1e-9
    m = fit_ml_profile(R, 2, n_starts=2, maxiter=500, seed=1)
    assert m["status"] == "success"
    assert m["objective"] is not None


def test_rotations_reconstruct_and_single_factor_none():
    _, R, _ = _synth()
    u = fit_uls_profile(R, 2, n_starts=2, maxiter=500, seed=1)
    L, psi = u["loadings"], u["psi"]
    for rot in ("none", "varimax", "promax"):
        out = rotate_solution(L, psi, rot)
        assert out["status"] == "success"
        P, Ph = np.asarray(out["loadings"]), np.asarray(out["phi"])
        assert np.allclose(P @ Ph @ P.T + np.diag(psi), L @ L.T + np.diag(psi), rtol=1e-9, atol=1e-10)
    q1 = rotate_solution(L[:, :1], psi, "promax")
    assert q1["appliedRotation"] == "none"
    assert q1["methodSwitchReason"]


def test_scores_regression_bartlett_shapes():
    X, R, _ = _synth()
    u = fit_uls_profile(R, 2, n_starts=2, maxiter=500, seed=1)
    out = rotate_solution(u["loadings"], u["psi"], "varimax")
    P, Ph = np.asarray(out["loadings"]), np.asarray(out["phi"])
    Z = (X - X.mean(0)) / X.std(0, ddof=1)
    for method in ("regression", "bartlett"):
        s = factor_scores(Z, R, P, Ph, np.asarray(u["psi"]), method)
        assert s["status"] == "success"
        assert s["scores"].shape == (X.shape[0], 2)


def test_parallel_suggest_and_alignment():
    obs = np.array([3.0, 1.2, 0.5])
    ref = np.array([1.5, 1.1, 0.9])
    sug = suggest_factors(obs, ref)
    assert sug["suggestedFactors"] == 2
    assert sug["exceedanceRanks"] == [1, 2]
    P = np.array([[0.8, 0.1], [0.7, 0.2], [0.1, 0.8]])
    H = np.array([[0.0, 1.0], [1.0, 0.0]]) * np.array([[1.0, 1.0], [-1.0, 1.0]])
    O = P @ H
    al = align_factors(P, O, np.eye(2), O.copy())
    assert al["status"] == "aligned"
    assert np.allclose(np.abs(al["alignedPattern"]), np.abs(P), atol=1e-8)
    a = definite_assignments(P)
    assert [x["factor"] for x in a] == [0, 0, 1]


def test_efa_request_contract_shape():
    ctx = {"datasetId": "d", "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none", "missingPolicy": "exclude",
           "imputationPolicy": "use_current_values"}
    req = EFARequest.model_validate({
        "context": ctx,
        "variables": [{"columnId": f"q{i}", "measurement": "continuous", "treatment": "continuous"} for i in range(4)],
        "correlation": "pearson", "extraction": "ml", "nFactors": 1})
    assert req.nFactors == 1
    with pytest.raises(Exception):
        EFARequest.model_validate({
            "context": ctx,
            "variables": [{"columnId": f"q{i}", "measurement": "continuous", "treatment": "continuous"} for i in range(4)],
            "correlation": "polychoric", "extraction": "ml", "nFactors": 1})


def test_parallel_uses_independent_column_permutation():
    """E001: null replicates must break inter-item association."""
    rng = np.random.default_rng(0)
    n, p = 200, 4
    X = rng.normal(size=(n, p))

    def est(mat):
        m = np.asarray(mat, dtype=float)
        xc = m - m.mean(axis=0)
        cov = (xc.T @ xc) / (len(m) - 1)
        sd = np.sqrt(np.diag(cov))
        return {"correlation": cov / sd[:, None] / sd[None, :], "status": "success"}

    from app.algorithms.models.factor_parallel import (
        full_correlation_eigenvalues,
        parallel_analysis,
    )
    out = parallel_analysis(X, est, iterations=100, quantile=0.95, seed=1)
    assert out["status"] == "completed"
    obs = full_correlation_eigenvalues(est(X)["correlation"])
    ref = np.asarray(out["referenceQuantiles"])
    assert float(np.max(np.abs(obs - ref))) > 1e-6


def test_varimax_kaiser_mean_correction_and_final_reconstruction():
    """E002/E003: corrected angle raises the criterion; H keeps P@Phi@P'."""
    from app.algorithms.models.factor_rotations import (
        canonicalize_columns,
        rotate_solution,
        varimax_rotation,
    )
    L = np.array([[0.6224, -0.4283], [0.5906, -0.4248], [0.5122, -0.3605],
                  [0.6607, 0.4806], [0.5666, 0.4145], [0.5038, 0.2971]])
    psi = np.full(6, 0.4)
    out = varimax_rotation(L, psi)
    assert out["status"] == "success"
    P = np.asarray(out["loadings"])
    Ph = np.asarray(out["phi"])
    sigma = L @ L.T + np.diag(psi)
    assert np.allclose(P @ Ph @ P.T + np.diag(psi), sigma, rtol=1e-9, atol=1e-10)
    h = np.sqrt(np.sum(P * P, axis=1))
    b = P / h[:, None]
    crit = float(np.sum(np.var(b * b, axis=0)))
    assert crit > 0.43
    # canonicalize_columns returns a single H applied to pattern AND Phi.
    lc, hperm = canonicalize_columns(P)
    assert np.allclose(lc @ (hperm.T @ Ph @ hperm) @ lc.T, P @ Ph @ P.T,
                       rtol=1e-12, atol=1e-12)
    q1 = rotate_solution(L[:, :1], psi, "promax")
    assert q1["appliedRotation"] == "none"
