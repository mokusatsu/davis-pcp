"""Unit tests for PCA algorithm."""
from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from app.algorithms.models.pca import compute_pca


def test_pca_iris_standardization():
    # Build iris DataFrame with 4 numeric columns
    from app.services.import_service import build_builtin_iris
    df = build_builtin_iris()

    cols = ["sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm"]
    res = compute_pca(df, columns=cols, use_correlation=True)

    assert res["nSamples"] == 150
    assert res["nComponents"] == 4
    assert len(res["eigenvalues"]) == 4

    # Kaiser criterion: first component > 1.0
    assert res["eigenvalues"][0] > 1.0
    # Sum of eigenvalues in correlation PCA equals number of variables (4)
    assert np.isclose(sum(res["eigenvalues"]), 4.0, atol=1e-4)

    # Variance ratios sum to 1.0
    assert np.isclose(sum(res["explainedVarianceRatio"]), 1.0, atol=1e-4)
    assert res["cumulativeVarianceRatio"][-1] == 1.0
    assert res["explainedVarianceRatio"][0] > 0.70  # PC1 explains > 70% in Iris

    # Check loadings
    assert set(res["loadings"].keys()) == set(cols)
    for c in cols:
        assert len(res["loadings"][c]) == 4

    # Check scores
    assert len(res["scores"]) == 150
    assert len(res["scores"][0]["pc"]) == 4

    # Check eigenvectors orthogonality
    V = np.array(res["eigenvectors"])
    assert np.allclose(V @ V.T, np.eye(4), atol=1e-5)


def test_pca_subset_and_covariance():
    from app.services.import_service import build_builtin_iris
    df = build_builtin_iris()
    cols = ["sepal_length_cm", "petal_length_cm"]
    row_ids = [str(i) for i in range(50)]

    res = compute_pca(df, columns=cols, use_correlation=False, n_components=2, row_ids=row_ids)
    assert res["nSamples"] == 50
    assert res["nComponents"] == 2
    assert len(res["scores"]) == 50




@pytest.mark.parametrize("use_correlation", [True, False])
def test_kaiser_recommendation_uses_full_spectrum_when_output_is_truncated(use_correlation):
    """Requesting one displayed component must not cap the recommendation."""
    rng = np.random.default_rng(18)
    latent = rng.normal(size=(240, 2))
    x = np.column_stack([latent[:, 0], latent[:, 0], latent[:, 1], latent[:, 1]])
    x += 0.15 * rng.normal(size=x.shape)
    df = pl.DataFrame({f"q{j}": x[:, j] for j in range(x.shape[1])})
    centered = x - x.mean(axis=0)
    if use_correlation:
        centered /= x.std(axis=0, ddof=1)
    eigenvalues = np.linalg.eigvalsh(centered.T @ centered / (len(x) - 1))[::-1]
    threshold = 1.0 if use_correlation else eigenvalues.mean()
    expected = int(np.count_nonzero(eigenvalues >= threshold))
    assert expected == 2
    for n_components in (1, 2, 4):
        result = compute_pca(df, use_correlation=use_correlation,
                             n_components=n_components)
        assert result["kaiserThresholdComponents"] == expected
        assert result["kaiser_threshold_components"] == expected
        assert result["kaiserThreshold"] == pytest.approx(threshold, abs=5.1e-5)
        assert result["nComponents"] == n_components
        np.testing.assert_allclose(result["eigenvalues"], eigenvalues[:n_components],
                                   atol=5.1e-6, rtol=0)
        assert len(result["eigenvectors"]) == n_components
        assert all(len(values) == n_components for values in result["loadings"].values())
        assert all(len(row["pc"]) == n_components for row in result["scores"])
