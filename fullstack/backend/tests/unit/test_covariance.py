"""Unit tests for Covariance and Precision matrix computation."""
from __future__ import annotations

import numpy as np
import pytest

from app.algorithms.statistics.covariance import compute_covariance
from app.services.import_service import build_builtin_iris


def test_covariance_iris():
    df = build_builtin_iris()
    cols = ["sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm"]
    res = compute_covariance(df, columns=cols)

    assert res["columns"] == cols
    assert res["nRows"] == 150

    # Covariance matrix is 4x4 and symmetric
    cov = np.array(res["covariance"])
    assert cov.shape == (4, 4)
    assert np.allclose(cov, cov.T, atol=1e-5)
    # Diagonal variances are positive
    assert np.all(np.diag(cov) > 0)

    # Correlation matrix diagonal is 1.0
    corr = np.array(res["correlation"])
    assert corr.shape == (4, 4)
    assert np.allclose(np.diag(corr), 1.0)
    assert np.all(np.abs(corr) <= 1.0 + 1e-6)

    # Precision matrix (inverse covariance)
    prec = np.array(res["precision"])
    assert prec.shape == (4, 4)
    # cov @ prec should be approximately eye(4)
    assert np.allclose(cov @ prec, np.eye(4), atol=1e-3)

    # Diagnostics
    diag = res["diagnostics"]
    assert diag["totalVariance"] > 0
    assert diag["conditionNumber"] > 0
    assert not diag["isSingular"]
