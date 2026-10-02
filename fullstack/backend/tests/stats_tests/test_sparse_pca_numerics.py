"""Fixed numerical references and independent nonorthogonal-model identities."""
from __future__ import annotations

import numpy as np
import pytest
from sklearn.datasets import load_iris
from sklearn.decomposition import SparsePCA
from app.algorithms.models.sparse_pca import preprocess, score_coefficients, reconstruction_fraction, correlations


@pytest.mark.parametrize("mode,alpha,scale,expected,nonzero", [
    ("correlation", 1., 1., .9530300351217424, [3, 3]),
    ("covariance", 1., 1., .9756251442245412, [4, 2]),
    ("covariance", 1., .1, .8313217508598894, [1, 1]),
    ("covariance", .1, .1, .9756251802984671, [4, 2]),
])
def test_iris_preprocessing_and_frozen_runtime_golden(mode, alpha, scale, expected, nonzero):
    values = load_iris().data * scale
    z, columns = preprocess(values, mode, list("abcd"))
    estimator = SparsePCA(n_components=2, alpha=alpha, ridge_alpha=.01, tol=1e-8,
                         max_iter=1000, method="lars", n_jobs=1, random_state=0).fit(z)
    w, rank, _ = score_coefficients(estimator.components_, .01)
    scores = (z - estimator.mean_) @ w
    np.testing.assert_allclose(scores, estimator.transform(z), atol=2e-13)
    fraction = reconstruction_fraction(z - estimator.mean_, scores, estimator.components_)
    assert fraction == pytest.approx(expected, abs=1e-11)
    assert np.count_nonzero(estimator.components_, axis=1).tolist() == nonzero
    assert rank == 2
    raw_mean = np.asarray([c["rawMean"] for c in columns])
    raw_sd = np.asarray([c["rawSampleSd"] for c in columns])
    np.testing.assert_allclose(raw_mean, values.mean(0), atol=1e-14)
    np.testing.assert_allclose(raw_sd, values.std(0, ddof=1), atol=1e-14)
    restored = z * raw_sd + raw_mean if mode == "correlation" else z + raw_mean
    np.testing.assert_allclose(restored, values, atol=1e-14)
    if mode == "correlation":
        assert estimator.n_iter_ == 25
        assert estimator.error_[-1] == pytest.approx(61.72595229481922, abs=1e-11)
        score_corr, _ = correlations(scores, scores)
        assert score_corr[0][1] == pytest.approx(-.329155420285278, abs=1e-12)
        # sklearn's objective is not recomputable from normalized B/ridge T.
        naive_loss = .5 * np.square(z-estimator.mean_-scores@estimator.components_).sum() + alpha * np.abs(estimator.components_).sum()
        assert abs(naive_loss - estimator.error_[-1]) > 40


@pytest.mark.parametrize("rho", [0., .01, 3.])
def test_nonorthogonal_basis_matches_independent_svd_ridge(rho):
    b = np.asarray([[1., 0., 1., 0.], [0., 1., 1., 1.]])
    b /= np.linalg.norm(b, axis=1)[:, None]
    x = np.random.default_rng(84).normal(size=(32, 4))
    x -= x.mean(axis=0)
    w, rank, _ = score_coefficients(b, rho)
    u, s, vt = np.linalg.svd(b.T, full_matrices=False)
    oracle = u @ np.diag(s / (s*s + rho)) @ vt
    np.testing.assert_allclose(w, oracle, atol=1e-14)
    np.testing.assert_allclose(w @ (b @ b.T + rho*np.eye(2)), b.T, atol=1e-14)
    assert rank == 2
    assert abs((b @ b.T)[0, 1]) > .4
    assert w[1, 0] != 0 and b[0, 1] == 0
    reconstructed = x @ w @ b
    assert reconstruction_fraction(x, x @ w, b) == pytest.approx(1-np.square(x-reconstructed).sum()/np.square(x).sum())
