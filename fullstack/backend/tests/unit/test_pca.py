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


