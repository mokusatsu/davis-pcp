"""Unit tests for Logistic Regression (Feature 12)."""
import numpy as np
import polars as pl
import pytest
from app.algorithms.models.logistic import run_logistic_regression
from app.domain.errors import BizError


def test_logistic_regression_basic():
    # Synthetic dataset with 2 features and binary target
    np.random.seed(42)
    n = 100
    x1 = np.random.normal(0, 1, n)
    x2 = np.random.normal(0, 1, n)
    # True logit
    z = 0.5 + 1.5 * x1 - 2.0 * x2
    prob = 1.0 / (1.0 + np.exp(-z))
    y = (np.random.rand(n) < prob).astype(int)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "target": y,
        "feat1": x1,
        "feat2": x2,
    })

    res = run_logistic_regression(
        df=df,
        target_column="target",
        feature_columns=["feat1", "feat2"],
        intercept=True,
        regularization="none",
        cutoff=0.5,
    )

    assert res["target"] == "target"
    assert res["classes"] == ["0", "1"]
    assert res["excludedRowCount"] == 0
    assert res['diagnostics']['completeSeparation'] is False
    assert len(res["coefficients"]) == 3  # Intercept, feat1, feat2

    # Check coefficient names
    names = [c["name"] for c in res["coefficients"]]
    assert names == ["Intercept", "feat1", "feat2"]

    # feat1 should be positive, feat2 negative
    c_map = {c["name"]: c for c in res["coefficients"]}
    assert c_map["feat1"]["coefficient"] > 0
    assert c_map["feat2"]["coefficient"] < 0
    assert c_map["feat1"]["oddsRatio"] > 1.0
    assert c_map["feat2"]["oddsRatio"] < 1.0
    assert c_map["feat1"]["ciLower"] < c_map["feat1"]["ciUpper"]

    # Fit metrics
    metrics = res["fitMetrics"]
    assert metrics["converged"] is True
    assert metrics["aic"] > 0
    assert metrics["bic"] > 0
    assert 0.0 <= metrics["pseudoR2"] <= 1.0

    # Confusion matrix
    cm = res["confusionMatrix"]
    assert cm["tp"] + cm["tn"] + cm["fp"] + cm["fn"] == n
    assert len(cm["tpRowIds"]) == cm["tp"]
    assert len(cm["tnRowIds"]) == cm["tn"]
    assert 0.0 <= cm["accuracy"] <= 1.0

    # Samples
    assert len(res["samples"]) == n
    assert "predictedProb" in res["samples"][0]
    assert "residual" in res["samples"][0]

    # Curves
    assert "feat1" in res["curves"]
    assert "feat2" in res["curves"]
    assert len(res["curves"]["feat1"]) == 80


def test_logistic_regression_regularization_l1_l2():
    np.random.seed(123)
    n = 60
    x1 = np.random.normal(0, 1, n)
    x2 = np.random.normal(0, 1, n)
    y = (x1 + x2 > 0).astype(int)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "target": y,
        "feat1": x1,
        "feat2": x2,
    })

    # L2
    res_l2 = run_logistic_regression(
        df=df,
        target_column="target",
        feature_columns=["feat1", "feat2"],
        regularization="l2",
        c_value=0.5,
    )
    assert len(res_l2["coefficients"]) == 3
    assert res_l2['diagnostics']['completeSeparation'] is True

    # L1
    res_l1 = run_logistic_regression(
        df=df,
        target_column="target",
        feature_columns=["feat1", "feat2"],
        regularization="l1",
        c_value=0.5,
    )
    assert len(res_l1["coefficients"]) == 3
    assert res_l1['diagnostics']['completeSeparation'] is True


def test_logistic_constant_features_are_named():
    frame = pl.DataFrame({'target': [0, 1, 0, 1, 0, 1], 'constant': [0] * 6, 'x': list(range(6))})
    with pytest.raises(BizError) as error:
        run_logistic_regression(frame, 'target', ['constant', 'x'])
    assert error.value.code == 'LOGISTIC_CONSTANT_FEATURES'
    assert error.value.details['columns'] == ['constant']


def test_complete_separation_requires_strict_margins():
    # Opposite labels at the same x prevent complete separation even if most rows separate.
    frame = pl.DataFrame({'target': [0, 0, 0, 1, 1, 1], 'x': [-2, -1, 0, 0, 1, 2]})
    result = run_logistic_regression(frame, 'target', ['x'], regularization='l2')
    assert result['diagnostics']['completeSeparation'] is False


def test_logistic_regression_listwise_deletion_and_active_rows():
    df = pl.DataFrame({
        "__rowId__": ["r0", "r1", "r2", "r3", "r4", "r5", "r6"],
        "target": [0, 1, 0, 1, 0, None, 1],
        "feat": [1.0, 2.0, None, 4.0, 5.0, 6.0, 7.0],
    })

    # Rows with nulls: r2 (feat is None), r5 (target is None) -> 2 rows dropped
    res = run_logistic_regression(
        df=df,
        target_column="target",
        feature_columns=["feat"],
    )
    assert res["excludedRowCount"] == 2
    assert len(res["samples"]) == 5

    # With active_row_ids
    res_active = run_logistic_regression(
        df=df,
        target_column="target",
        feature_columns=["feat"],
        active_row_ids=["r0", "r1", "r3", "r4"],
    )
    assert len(res_active["samples"]) == 4


def test_logistic_regression_errors():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3"],
        "target_3class": ["A", "B", "C"],
        "feat": [1.0, 2.0, 3.0],
    })

    # Non binary target
    with pytest.raises(BizError) as exc_info:
        run_logistic_regression(df=df, target_column="target_3class", feature_columns=["feat"])
    assert exc_info.value.code == "LOGISTIC_NOT_BINARY"

    # Missing column
    with pytest.raises(BizError) as exc_info2:
        run_logistic_regression(df=df, target_column="nonexistent", feature_columns=["feat"])
    assert exc_info2.value.code == "LOGISTIC_TARGET_NOT_FOUND"

    # No features
    with pytest.raises(BizError) as exc_info3:
        run_logistic_regression(df=df, target_column="target_3class", feature_columns=[])
    assert exc_info3.value.code == "LOGISTIC_NO_FEATURES"


def test_no_intercept_fits_the_original_origin_and_predicts_the_fitted_model():
    from scipy.optimize import brentq
    from scipy.special import expit

    x = np.arange(1.0, 13.0)
    y = np.array([0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1, 1])
    frame = pl.DataFrame({'__rowId__': [f'r{i * 7}' for i in range(len(x))], 'x': x, 'target': y})
    # Independent likelihood score on the original, uncentered design.
    expected_beta = brentq(lambda beta: x @ (expit(x * beta) - y), -2, 2)
    expected_probabilities = expit(x * expected_beta)
    result = run_logistic_regression(frame, 'target', ['x'], intercept=False)
    assert [item['name'] for item in result['coefficients']] == ['x']
    assert result['coefficients'][0]['coefficient'] == pytest.approx(expected_beta, abs=1e-6)
    np.testing.assert_allclose([sample['predictedProb'] for sample in result['samples']], expected_probabilities, atol=1e-5)
    expected_likelihood = np.sum(y * np.log(expected_probabilities) + (1-y) * np.log1p(-expected_probabilities))
    assert result['fitMetrics']['logLikelihood'] == pytest.approx(expected_likelihood, abs=1e-4)
    for point in result['curves']['x']:
        assert point['probability'] == pytest.approx(expit(point['x'] * expected_beta), abs=1e-4)
    assert [sample['rowId'] for sample in result['samples']] == frame['__rowId__'].to_list()


def test_no_intercept_separation_uses_the_original_origin():
    frame = pl.DataFrame({'x': [1., 2., 3., 4., 5., 6.], 'target': [0, 0, 0, 1, 1, 1]})
    # A threshold at 3.5 requires an intercept. No line through the origin separates these labels.
    without = run_logistic_regression(frame, 'target', ['x'], intercept=False, regularization='l2')
    with_intercept = run_logistic_regression(frame, 'target', ['x'], intercept=True, regularization='l2')
    assert without['diagnostics']['completeSeparation'] is False
    assert with_intercept['diagnostics']['completeSeparation'] is True
