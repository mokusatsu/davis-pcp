"""Numerical/semantic SparsePCA tests; ordinary PCA fields are never borrowed."""
from __future__ import annotations

import json
import numpy as np
import polars as pl
import pytest
from sklearn.datasets import load_iris
from sklearn.decomposition import SparsePCA

from app.algorithms.models import sparse_pca as spca
from app.domain.errors import BizError
from app.domain.sparse_pca_contracts import SparsePcaRequest
from app.domain.sparse_pca_frame import prepare_sparse_pca_frame


def prepared(x=None, **options):
    x = load_iris().data if x is None else np.asarray(x, dtype=float)
    columns = [{"columnId": f"v{j}", "name": f"x{j}", "label": f"Variable {j}",
                "role": "question", "scaleType": "interval"} for j in range(x.shape[1])]
    request = SparsePcaRequest.model_validate({"context": {"datasetId": "d", "expectedDataRevision": 1,
        "expectedSchemaRevision": 1, "weightMode": "none"},
        "variables": [{"columnId": c["columnId"], "kind": "numeric"} for c in columns], **options})
    data = pl.DataFrame({"__rowId__": [f"r{i}" for i in range(len(x))],
                        **{c["name"]: x[:, j] for j, c in enumerate(columns)}})
    frame = prepare_sparse_pca_frame(request, meta={"dataRevision": 1},
        codebook={"schemaRevision": 1, "columns": columns}, data=data, mask={}, mask_revision=0)
    return frame, request


@pytest.mark.parametrize("preprocessing", ["correlation", "covariance"])
@pytest.mark.parametrize("nComponents", [1, 2, 3])
def test_matches_sklearn_oracle_and_actual_transform(preprocessing, nComponents):
    frame, req = prepared(preprocessing=preprocessing, nComponents=nComponents)
    x = frame.values.copy()
    z = x - x.mean(axis=0)
    if preprocessing == "correlation":
        z /= x.std(axis=0, ddof=1)
    oracle = SparsePCA(n_components=nComponents, alpha=1., ridge_alpha=.01, max_iter=1000,
                       tol=1e-8, method="lars", n_jobs=1, random_state=0).fit(z)
    result = spca.fit_sparse_pca(frame, req)
    b, w = np.asarray(result.details.components), np.asarray(result.details.scoreCoefficients)
    np.testing.assert_allclose(b, oracle.components_, rtol=1e-11, atol=1e-12)
    np.testing.assert_allclose(result.scores, oracle.transform(z), rtol=1e-10, atol=1e-11)
    own_z, _ = spca.preprocess(x, preprocessing, [v["columnId"] for v in frame.variables])
    zc = own_z - np.asarray(result.details.preprocessing.estimatorMean)
    np.testing.assert_allclose(result.scores, zc @ w, rtol=1e-13, atol=1e-13)
    expected = 1 - np.linalg.norm(zc - result.scores @ b) ** 2 / np.linalg.norm(zc) ** 2
    assert result.summary.reconstructionFraction == pytest.approx(expected, abs=1e-14)
    np.testing.assert_array_equal(frame.values, x)
    assert not frame.values.flags.writeable
    assert result.details.componentOrder == [f"SP{i + 1}" for i in range(nComponents)]
    assert result.summary.convergence.finalObjective == pytest.approx(oracle.error_[-1], abs=1e-10)
    assert not {"eigenvalues", "explainedVarianceRatio", "cumulativeVarianceRatio", "kaiser"}.intersection(result.summary.model_dump())


def test_nonorthogonal_coefficients_and_correlations_are_distinct():
    frame, req = prepared()
    result = spca.fit_sparse_pca(frame, req)
    b, w = np.asarray(result.details.components), np.asarray(result.details.scoreCoefficients)
    correlations = np.asarray(result.details.variableScoreCorrelations)
    assert np.any((b.T == 0) & (abs(w) > 1e-5))
    assert np.any((b.T == 0) & (abs(correlations) > .1))
    assert abs(result.details.scoreCorrelations[0][1]) > .3
    direct = np.corrcoef(np.column_stack([frame.values, result.scores]).T)
    np.testing.assert_allclose(correlations, direct[:4, 4:], atol=1e-13)
    np.testing.assert_allclose(result.details.scoreCorrelations, direct[4:, 4:], atol=1e-13)
    np.testing.assert_allclose(result.details.componentGram, b @ b.T, atol=1e-13)
    np.testing.assert_allclose(result.details.scoreVariances, result.scores.var(axis=0, ddof=1), atol=1e-13)
    assert result.summary.zeroFraction == np.count_nonzero(b == 0) / b.size
    assert result.summary.nonzeroPerComponent == [3, 3]


@pytest.mark.parametrize("ridgeAlpha", [0., .01, 1.])
def test_all_zero_components_have_undefined_correlations_even_diagonal(ridgeAlpha):
    frame, req = prepared(alpha=50., ridgeAlpha=ridgeAlpha)
    result = spca.fit_sparse_pca(frame, req)
    assert result.summary.zeroFraction == 1
    assert result.summary.basisRank == 0
    assert result.summary.reconstructionFraction == 0
    assert result.summary.nonzeroPerComponent == [0, 0]
    np.testing.assert_array_equal(result.scores, np.zeros((150, 2)))
    assert result.details.scoreCorrelations == [[None, None], [None, None]]
    assert result.details.variableScoreCorrelations == [[None, None]] * 4
    assert result.details.scoreCorrelationReasons == [["constant_score"] * 2] * 2
    assert result.details.scoreVariances == [0., 0.]
    json.dumps(result.details.model_dump(), allow_nan=False)


def test_zero_ridge_rank_deficient_coefficients_are_minimum_norm():
    b = np.asarray([[1., 2., 0.], [2., 4., 0.]])
    w, rank, cutoff = spca.score_coefficients(b, 0.)
    np.testing.assert_allclose(w, np.linalg.pinv(b), atol=1e-15)
    assert rank == 1 and cutoff == 1e-15
    x = np.asarray([[3., 2., 1.], [-1., 0., 2.]])
    np.testing.assert_allclose(x @ w, np.linalg.lstsq(b.T, x.T, rcond=cutoff)[0].T, atol=1e-14)


def test_alpha_zero_ridge_still_shrinks_scores():
    frame, req0 = prepared(alpha=0., ridgeAlpha=0.)
    _, req1 = prepared(alpha=0., ridgeAlpha=.01)
    a = spca.fit_sparse_pca(frame, req0)
    b = spca.fit_sparse_pca(frame, req1)
    np.testing.assert_allclose(a.details.components, b.details.components, atol=1e-13)
    assert np.max(abs(a.scores - b.scores)) > .03
    np.testing.assert_allclose(b.scores, a.scores / 1.01, atol=1e-12)


def test_requested_k_is_fitted_jointly_and_seed_is_reproducible():
    frame, two = prepared(nComponents=2)
    _, one = prepared(nComponents=1)
    a, b = spca.fit_sparse_pca(frame, two), spca.fit_sparse_pca(frame, two)
    np.testing.assert_array_equal(a.scores, b.scores)
    first = spca.fit_sparse_pca(frame, one)
    assert np.max(abs(np.asarray(a.details.components)[0] - np.asarray(first.details.components)[0])) > .05


@pytest.mark.parametrize("history,maximum,status", [
    ([3.], 1, "iteration_limit"),
    ([3., 2., 1.999999999], 3, "tolerance_reached"),
    ([3., 2., 1.], 3, "iteration_limit"),
    ([1., 1.1], 2, "objective_increase"),
    ([1., 1.1, 1.0999999999], 3, "objective_increase"),
    ([1., 1. + 1e-15], 2, "tolerance_reached"),
    ([0., 0.], 2, "iteration_limit"),
    ([1e-100, 1.1e-100], 2, "objective_increase"),
])
def test_convergence_from_objective_history_not_iteration_count(history, maximum, status):
    d = spca.diagnose_convergence(history, len(history), maximum, 1e-8)
    assert d.status == status
    assert d.finalImprovement == (history[-2] - history[-1] if len(history) > 1 else None)


@pytest.mark.parametrize("history,count", [([], 0), ([1., float("nan")], 2), ([1., float("inf")], 2), ([-1.], 1), ([1.], 2)])
def test_invalid_objective_is_explicit_error(history, count):
    with pytest.raises(BizError, match="数値") as exc:
        spca.diagnose_convergence(history, count, 10, 1e-8)
    assert exc.value.code == "SPCA_NUMERIC_RANGE"


def test_single_iteration_reports_limit_without_library_warning():
    frame, req = prepared(maxIterations=1)
    result = spca.fit_sparse_pca(frame, req)
    assert result.summary.convergence.status == "iteration_limit"
    assert result.summary.convergence.nIterations == 1
    assert any(w["code"] == "SPCA_ITERATION_LIMIT" for w in result.warnings)


def test_solver_warning_preserved_separately(monkeypatch):
    import warnings
    original = spca.SparsePCA.fit
    def warned(self, x, *args, **kwargs):
        warnings.warn("inner solver evidence", RuntimeWarning)
        return original(self, x, *args, **kwargs)
    monkeypatch.setattr(spca.SparsePCA, "fit", warned)
    frame, req = prepared()
    result = spca.fit_sparse_pca(frame, req)
    assert any(w["code"] == "SPCA_SOLVER_WARNING" and w["message"] == "inner solver evidence" for w in result.warnings)


@pytest.mark.parametrize("magnitudes", [[1e154, 1e-162, 3., 1e80], [1e-200] * 4, [1e200] * 4])
def test_correlation_invariant_to_independent_finite_unit_changes(magnitudes):
    x = load_iris().data
    original, request = prepared(x)
    changed, changed_request = prepared(x * magnitudes)
    a = spca.fit_sparse_pca(original, request)
    b = spca.fit_sparse_pca(changed, changed_request)
    np.testing.assert_allclose(a.details.components, b.details.components, atol=1e-12)
    np.testing.assert_allclose(a.scores, b.scores, atol=1e-12)
    json.dumps(b.details.model_dump(), allow_nan=False)


def test_correlation_raw_sd_overflow_is_null_not_fit_error():
    x = np.asarray([[-1e308, -1e308], [1e308, .9e308]])
    frame, req = prepared(x, nComponents=1)
    result = spca.fit_sparse_pca(frame, req)
    # +/-1e308 has an unrepresentable sample SD, while normalized values fit.
    assert result.details.preprocessing.columns[0].rawSampleSd == pytest.approx(1.4142135623730951e308)
    x *= 1.7
    frame, req = prepared(x, nComponents=1)
    result = spca.fit_sparse_pca(frame, req)
    first = result.details.preprocessing.columns[0]
    assert first.rawSampleSd is None and first.rawSampleSdReason == "numeric_range_overflow"
    json.dumps(result.details.model_dump(), allow_nan=False)


@pytest.mark.parametrize("magnitude", [1e154, 1e-162, 1e200])
def test_covariance_extremes_rejected_without_changing_alpha(magnitude):
    frame, req = prepared(load_iris().data * magnitude, preprocessing="covariance")
    with pytest.raises(BizError) as exc:
        spca.fit_sparse_pca(frame, req)
    assert exc.value.code == "SPCA_NUMERIC_RANGE"


def test_covariance_alpha_units_never_silently_standardized():
    frame, req = prepared(preprocessing="covariance")
    changed, req2 = prepared(load_iris().data / 10, preprocessing="covariance")
    a, b = spca.fit_sparse_pca(frame, req), spca.fit_sparse_pca(changed, req2)
    assert a.summary.nonzeroPerComponent == [4, 2]
    assert b.summary.nonzeroPerComponent == [1, 1]
    assert abs(a.summary.reconstructionFraction - b.summary.reconstructionFraction) > .1


def test_large_offset_remains_finite_and_nonconstant():
    x = np.asarray([[1e15 + i, -1e15 + (i % 3)] for i in range(20)])
    frame, req = prepared(x, nComponents=1)
    result = spca.fit_sparse_pca(frame, req)
    assert np.isfinite(result.scores).all() and np.std(result.scores) > 0
    assert all(c.normalizedSampleSd > 0 for c in result.details.preprocessing.columns)


@pytest.mark.parametrize("n,p,k,iters", [(10001,2,1,1),(100,101,1,1),(100,30,21,1),(100,100,20,151)])
def test_size_cap_includes_iteration_overhead_floor(n,p,k,iters):
    with pytest.raises(BizError) as exc:
        spca.check_size(n,p,k,iters)
    assert exc.value.code == "SPCA_SIZE_LIMIT"
    assert exc.value.details["limits"]["minimumRowsForWorkEstimate"] == 500


def test_size_cap_boundary():
    spca.check_size(100, 100, 20, 150)
    spca.check_size(10000, 100, 20, 5)


def test_one_retained_variable_preserves_matrix_shapes():
    frame, req = prepared([[1., 4.], [2., 4.], [3., 4.]], nComponents=1)
    result = spca.fit_sparse_pca(frame, req)
    assert result.scores.shape == (3, 1)
    assert np.asarray(result.details.components).shape == (1, 1)
    assert np.asarray(result.details.scoreCoefficients).shape == (1, 1)
    assert len(result.details.excludedConstantColumns) == 1


@pytest.mark.parametrize("anchor", [1e14, 1e15, 1e16, -1e16])
def test_large_offset_affine_pearson_and_standardization_are_accurate(anchor):
    y = np.arange(20, dtype=float)
    x = anchor + 2 * y
    corr, reasons = spca.correlations(x[:, None], y[:, None])
    assert corr[0][0] == pytest.approx(1., abs=5e-15)
    assert reasons == [[None]]
    z, columns = spca.preprocess(np.column_stack([x, y]), "correlation", ["x", "y"])
    expected = (y-y.mean()) / y.std(ddof=1)
    np.testing.assert_allclose(z[:, 0], expected, atol=5e-15)
    np.testing.assert_allclose(z[:, 1], expected, atol=5e-15)
    for j, c in enumerate(columns):
        source = x if j == 0 else y
        frozen = ((source-c["inputAnchor"])/c["inputMagnitude"]-c["normalizedMeanOffset"])/c["normalizedSampleSd"]
        np.testing.assert_allclose(frozen, z[:, j], atol=0, rtol=0)


def test_anchored_preprocessing_opposite_extreme_endpoints_remains_finite():
    x = np.asarray([[-1.7e308, 1.7e308], [1.7e308, -1.7e308], [0., 0.]])
    z, cols = spca.preprocess(x, "correlation", ["x", "y"])
    np.testing.assert_allclose(z, [[-1., 1.], [1., -1.], [0., 0.]], atol=1e-15)
    assert all(c["inputAnchor"] in (-1.7e308, 1.7e308) for c in cols)


@pytest.mark.parametrize("values", [
    (1e15 + np.spacing(1e15)*np.arange(5)).tolist(),
    [-1e308, -.5, 0., .5, 1e308],
    [1e308, 1.1e308, 1.7e308],
    [-1.7e308, -1.1e308, -1e308],
])
def test_numeric_reversal_preserves_large_offset_steps_and_extreme_endpoints(values):
    from app.domain.sparse_pca_frame import _convert
    from app.domain.codebook_adapter import normalize_code
    from decimal import Decimal, localcontext
    spec = {"missingCodes": [], "scaleType": "interval", "isReversed": True,
            "categoryOrder": [normalize_code(v) for v in values]}
    with localcontext() as ctx:
        ctx.prec = 800
        expected = [float(Decimal.from_float(min(values)) + Decimal.from_float(max(values)) - Decimal.from_float(v)) for v in values]
    actual = [_convert(v, spec) for v in values]
    assert all(reason == "ok" for _, reason in actual)
    np.testing.assert_array_equal([v for v, _ in actual], expected)


@pytest.mark.parametrize("values,expected", [
    ([1e308, -1e308, 1.], 1./3.),
    ([1e308, 1e308, -1e308, -1e308, 1.], .2),
    ([1.7e308, 1.7e308, 1e308], 1.4666666666666666e308),
    ([-1.7e308, -1.7e308, -1e308], -1.4666666666666666e308),
    ([1e308, -1e308, 1e-300], 1e-300/3),
    ([1e308, 1e308, -1e308, -1e308, 1e-300], 1e-300/5),
    ([np.nextafter(0., 1.), np.nextafter(0., 1.)], np.nextafter(0., 1.)),
    ([1e308, -1e308], 0.),
])
def test_raw_mean_preserves_cancellation_and_handles_sum_overflow(values, expected):
    actual, reason = spca._raw_mean(np.asarray(values))
    assert actual == pytest.approx(expected, rel=3e-16, abs=0)
    assert reason is None
    if len(set(values)) > 1:
        _, columns = spca.preprocess(np.asarray(values)[:, None], "correlation", ["x"])
        assert columns[0]["rawMean"] == actual
        assert columns[0]["rawMeanReason"] is None


def test_raw_mean_underflow_is_not_silent_zero():
    smallest = float(np.nextafter(0., 1.))
    mean, reason = spca._raw_mean(np.asarray([smallest, 0., 0.]))
    assert mean is None and reason == "numeric_range_underflow"
    _, columns = spca.preprocess(np.asarray([[smallest], [0.], [0.]]), "correlation", ["x"])
    assert columns[0]["rawMean"] is None
    assert columns[0]["rawMeanReason"] == "numeric_range_underflow"


def test_tiny_explicit_scope_only_materializes_scoped_python_records(monkeypatch):
    count = 20000
    data = pl.DataFrame({"__rowId__": [f"r{i}" for i in range(count)],
                         "x": np.arange(count, dtype=float), "y": np.arange(count, dtype=float) % 7})
    wanted = ["r19999", "r12", "r1000"]
    req = SparsePcaRequest.model_validate({"context": {"datasetId": "d", "expectedDataRevision": 1,
        "expectedSchemaRevision": 1, "weightMode": "none", "scope": "explicit", "rowIds": wanted},
        "variables": [{"columnId": "x", "kind": "numeric"}, {"columnId": "y", "kind": "numeric"}], "nComponents": 1})
    sizes = []
    original = pl.DataFrame.to_dicts
    def records(frame):
        sizes.append(frame.height)
        return original(frame)
    monkeypatch.setattr(pl.DataFrame, "to_dicts", records)
    frame = prepare_sparse_pca_frame(req, meta={"dataRevision": 1},
        codebook={"schemaRevision": 1, "columns": [{"columnId": name, "name": name,
            "role": "question", "scaleType": "interval"} for name in ("x", "y")]},
        data=data, mask={}, mask_revision=0)
    assert sizes == [3]
    assert frame.row_ids == wanted
    np.testing.assert_array_equal(frame.values[:, 0], [19999, 12, 1000])
