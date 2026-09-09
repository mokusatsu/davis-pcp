"""Unit tests for Discriminant Analysis (Feature 13)."""
import polars as pl
import pytest
from sklearn.datasets import load_iris

from app.algorithms.models.discriminant import run_discriminant_analysis
from app.domain.errors import BizError


def test_discriminant_names_constant_and_no_within_variation():
    frame = pl.DataFrame({'target': [0, 0, 0, 1, 1, 1], 'constant': [1] * 6, 'separated': [0, 0, 0, 1, 1, 1]})
    with pytest.raises(BizError) as error:
        run_discriminant_analysis(frame, 'target', ['constant'])
    assert error.value.code == 'DISCRIMINANT_CONSTANT_FEATURES'
    assert error.value.details['columns'] == ['constant']
    with pytest.raises(BizError) as error:
        run_discriminant_analysis(frame, 'target', ['separated'])
    assert error.value.code == 'DISCRIMINANT_NO_WITHIN_CLASS_VARIATION'


def test_discriminant_reports_collinearity_without_rejecting_svd():
    frame = pl.DataFrame({'target': [0] * 5 + [1] * 5, 'x': [0, 1, 2, 3, 4, 3, 4, 5, 6, 7]})
    frame = frame.with_columns((pl.col('x') * 1000).alias('copy'))
    result = run_discriminant_analysis(frame, 'target', ['x', 'copy'])
    assert result['diagnostics']['collinear'] is True
    assert result['diagnostics']['withinClassRank'] == 1
    assert result['diagnostics']['usedDimensions'] == 2
    assert result['diagnostics']['classCounts'] == {'0': 5, '1': 5}
    assert len(result['samples']) == 10


@pytest.fixture
def iris_df():
    iris = load_iris()
    return pl.DataFrame({
        "__rowId__": [f"row_{i}" for i in range(150)],
        "species": [iris.target_names[t] for t in iris.target],
        "sepal_length": iris.data[:, 0],
        "sepal_width": iris.data[:, 1],
        "petal_length": iris.data[:, 2],
        "petal_width": iris.data[:, 3],
    })


def test_fisher_iris_lda_reproduction(iris_df):
    """Verifies that LDA on Iris matches standard textbook results."""
    res = run_discriminant_analysis(
        df=iris_df,
        target_column="species",
        feature_columns=["sepal_length", "sepal_width", "petal_length", "petal_width"],
        method="lda",
    )

    assert res["target"] == "species"
    assert res["classes"] == ["setosa", "versicolor", "virginica"]
    assert res["accuracy"] == 0.98  # 147/150 = 98%
    assert res['diagnostics']['usedDimensions'] == 4
    assert res['diagnostics']['withinClassRank'] == 4
    assert res['diagnostics']['collinear'] is False
    assert len(res["misclassifiedRowIds"]) == 3

    # Axes
    axes = res["axes"]
    assert len(axes) == 2  # min(4, 3-1) = 2
    # LD1 explained variance ratio ~ 99.1%
    assert abs(axes[0]["explainedVarianceRatio"] - 0.9912) < 0.01
    assert axes[0]["canonicalCorrelation"] > 0.95

    # Loadings (Biplot vectors)
    loadings = res["loadings"]
    assert len(loadings) == 4
    for l in loadings:
        assert "variable" in l
        assert "ld1" in l
        assert l["ld2"] is not None

    # Samples
    samples = res["samples"]
    assert len(samples) == 150
    assert "ld1" in samples[0]
    assert "ld2" in samples[0]
    assert "posteriorProbabilities" in samples[0]
    assert "setosa" in samples[0]["posteriorProbabilities"]

    # Boundary mesh
    mesh = res["boundaryMesh"]
    assert mesh is not None
    assert mesh["gridResolution"] == 50
    assert len(mesh["gridClassIndices"]) == 50
    assert len(mesh["gridClassIndices"][0]) == 50


def test_qda_analysis(iris_df):
    """Verifies Quadratic Discriminant Analysis execution."""
    res = run_discriminant_analysis(
        df=iris_df,
        target_column="species",
        feature_columns=["sepal_length", "sepal_width", "petal_length", "petal_width"],
        method="qda",
    )
    assert res["method"] == "qda"
    assert res["accuracy"] >= 0.95
    assert res["boundaryMesh"] is not None
    assert len(res["samples"]) == 150


def test_stepwise_discriminant_analysis(iris_df):
    """Verifies stepwise feature selection trace and monotonic decrease of Wilks' Lambda."""
    res = run_discriminant_analysis(
        df=iris_df,
        target_column="species",
        feature_columns=["sepal_length", "sepal_width", "petal_length", "petal_width"],
        method="stepwise",
        stepwise_config={"fEnter": 3.84, "fRemove": 2.71, "maxSteps": 10},
    )

    trace = res["stepwiseTrace"]
    assert trace is not None
    assert len(trace) >= 2

    # Verify monotonic decrease of Wilks' Lambda on entered steps
    lambdas = [t["wilksLambda"] for t in trace if t["action"] == "entered"]
    for i in range(len(lambdas) - 1):
        assert lambdas[i] >= lambdas[i + 1]

    # Check that model runs on selected variables
    assert len(res["features"]) == len(trace[-1]["activeVariables"])
    assert res["accuracy"] >= 0.95


def test_auto_shrinkage(iris_df):
    """Verifies that Ledoit-Wolf shrinkage works without errors."""
    res = run_discriminant_analysis(
        df=iris_df,
        target_column="species",
        feature_columns=["sepal_length", "sepal_width", "petal_length", "petal_width"],
        method="lda",
        shrinkage="auto",
    )
    assert res["accuracy"] >= 0.90


def test_binary_class_mode():
    """Verifies 2-class mode (only 1 canonical axis, boundaryMesh is None)."""
    df_bin = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(20)],
        "target": ["A"] * 10 + ["B"] * 10,
        "f1": list(range(20)),
        "f2": [x * 2.0 for x in range(20)],
    })

    res = run_discriminant_analysis(
        df=df_bin,
        target_column="target",
        feature_columns=["f1", "f2"],
        method="lda",
    )
    assert len(res["axes"]) == 1
    assert res["boundaryMesh"] is None
    assert res["loadings"][0]["ld2"] is None


def test_error_handling(iris_df):
    # Insufficient classes
    df_one_class = iris_df.filter(pl.col("species") == "setosa")
    with pytest.raises(BizError) as exc_info:
        run_discriminant_analysis(
            df=df_one_class,
            target_column="species",
            feature_columns=["sepal_length", "petal_length"],
        )
    assert exc_info.value.code == "DISCRIMINANT_INSUFFICIENT_CLASSES"

    # Missing target
    with pytest.raises(BizError) as exc_info2:
        run_discriminant_analysis(
            df=iris_df,
            target_column="unknown_target",
            feature_columns=["sepal_length"],
        )
    assert exc_info2.value.code == "DISCRIMINANT_TARGET_NOT_FOUND"


def test_qda_small_sample_singularity_robustness():
    """Verifies that QDA automatically regularizes when sample count <= features or covariance is singular."""
    df_singular = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3", "r4"],
        "target": ["A", "A", "B", "B"],
        "f1": [1.0, 1.1, 5.0, 5.1],
        "f2": [2.0, 2.1, 6.0, 6.1],
    })

    res = run_discriminant_analysis(
        df=df_singular,
        target_column="target",
        feature_columns=["f1", "f2"],
        method="qda",
    )
    assert res["method"] == "qda"
    assert res["accuracy"] == 1.0
    assert "decisionThreshold1D" in res
