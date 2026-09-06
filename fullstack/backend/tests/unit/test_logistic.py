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

    # L1
    res_l1 = run_logistic_regression(
        df=df,
        target_column="target",
        feature_columns=["feat1", "feat2"],
        regularization="l1",
        c_value=0.5,
    )
    assert len(res_l1["coefficients"]) == 3


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
