"""Product numerical tests for the standalone regularized regression kernel."""
from __future__ import annotations

import copy
import itertools
import json
import math
from dataclasses import replace

import numpy as np
import pytest
from sklearn.linear_model import ElasticNet, Lasso, Ridge

from app.algorithms.models.regularized_regression import fit_regularized
from app.domain.analysis_frame import PreparedRegressionFrame, MISSING_M, MISSING_NA
from app.domain.errors import BizError


def frame_of(X, y, w=None, categories=None, category_specs=None, numeric_specs=None):
    X = np.asarray(X, dtype=float)
    if X.ndim == 1:
        X = X[:, None]
    y = np.asarray(y, dtype=float)
    n = len(y)
    names = [f"x{i}" for i in range(X.shape[1])]
    categories = categories or {}
    return PreparedRegressionFrame(
        dataset_id="fixture", scope_ids=[f"row-{i}" for i in range(n)],
        design_row_ids=[f"row-{i}" for i in range(n)], design_strata=None,
        design_psu=None, design_fpc=None, design_weights_full=[None] * n,
        fit_pos_in_design=list(range(n)), row_ids=[f"row-{i}" for i in range(n)],
        target_values=y.tolist(), target_name="y", target_id="y-id",
        numeric_inputs={name: X[:, j].tolist() for j, name in enumerate(names)},
        numeric_specs=numeric_specs or {name: {"name": name, "label": name, "columnId": name} for name in names},
        numeric_ids={name: name for name in names}, numeric_ordinal={},
        category_inputs=copy.deepcopy(categories),
        category_specs=category_specs or {name: {"name": name, "label": name, "columnId": name} for name in categories},
        category_ids={name: name for name in categories}, catalogs={},
        weights=None if w is None else np.asarray(w, dtype=float).tolist(), weight_applied=w is not None,
        weight_type=None if w is None else "frequency", weight_column=None if w is None else "w",
        weight_column_id=None if w is None else "w", exclusions=[], exclusion_counts={},
        scope_count=n, fit_count=n, revisions={"dataRevision": 1, "schemaRevision": 1},
        mask_revision=None, data_fingerprint="fixture")


def test_windows_float64_longdouble_cannot_silently_zero_tiny_variance(monkeypatch):
    # NumPy's Windows longdouble has binary64 range. The production algorithm
    # must not depend on Linux extended exponent range for a representable SD.
    monkeypatch.setattr(np, "longdouble", np.float64)
    x = np.arange(1., 5.) * 1e-200
    y = np.arange(1., 5.) * 1e150
    result = fit(frame_of(x, y), algorithm="ridge")
    feature = result["model"]["features"][0]
    assert feature["scale"] == pytest.approx(np.sqrt(1.25) * 1e-200, rel=1e-12, abs=0)
    assert result["model"]["display"]["coefficients"][0]["exactZero"] is False
    assert result["model"]["display"]["coefficients"][0]["estimate"] is None
    assert result["model"]["display"]["coefficients"][0]["standardizedEstimate"] == pytest.approx(1 / 1.1, rel=1e-12)
    assert result["summary"]["fitRSquared"] == pytest.approx(1 - (1 / 11) ** 2, rel=1e-12)


def test_centered_prediction_rejects_nonzero_product_underflow():
    from app.algorithms.models.regularized_regression import _predict
    with pytest.raises(BizError, match="下回") as exc:
        _predict(np.array([[1e-200]]), {"coefficients": np.array([1e-200]), "intercept": 1.})
    assert exc.value.code == "RR_NUMERIC_RANGE"
    assert _predict(np.array([[1e-200]]), {"coefficients": np.array([0.]), "intercept": 1.})[0] == 1.


def test_feature_standardization_rejects_nonzero_division_underflow():
    with pytest.raises(BizError) as exc:
        fit(frame_of([1e-320, 1e200, 2e200], [1., 2., 3.]), intercept=False, standardize=True)
    assert exc.value.code == "RR_NUMERIC_RANGE"


def fit(frame, **config):
    predictors = [{"columnId": cid, "kind": "numeric"} for cid in frame.numeric_ids.values()]
    predictors += [{"columnId": cid, "kind": "categorical"} for cid in frame.category_ids.values()]
    return fit_regularized(frame, predictors, config)


def estimator(kind, n, intercept=True, alpha=.035):
    if kind == "ridge":
        return Ridge(alpha=n * alpha, solver="svd", fit_intercept=intercept)
    if kind == "lasso":
        return Lasso(alpha=alpha, fit_intercept=intercept, max_iter=100000, tol=1e-11)
    return ElasticNet(alpha=alpha, l1_ratio=.5, fit_intercept=intercept, max_iter=100000, tol=1e-11)


def baseline_data():
    rng = np.random.default_rng(20261002)
    n = 90
    x, z, a = rng.normal(12, 3, n), rng.normal(-2, .7, n), rng.integers(0, 3, n)
    # Previously transformed columns are ordinary inputs, not model interactions.
    X = np.column_stack([x, z, a == 0, a == 1, a == 2, x * (a == 1), x * z]).astype(float)
    y = 250 + 2.5*x - 4*z + 7*(a == 1) - 3*(a == 2) + .8*x*(a == 1) + rng.normal(0, 2, n)
    w = rng.integers(1, 5, n).astype(float)
    return X, y, w


BASELINE_CASES = [(f"D{i+1:02}", *case) for i, case in enumerate(itertools.product([False, True], [False, True], [False, True], ["ridge", "lasso", "elasticnet"]))]


@pytest.mark.parametrize("case_id,weighted,center,scaled_y,kind", BASELINE_CASES, ids=[c[0] for c in BASELINE_CASES])
def test_design_baseline_product_affine(case_id, weighted, center, scaled_y, kind):
    X, y, frequency = baseline_data()
    w = frequency if weighted else np.ones(len(y))
    if scaled_y:
        # Product target scaling is intentionally unsupported. Here the supplied
        # dataset target is already transformed, and the model preserves it.
        sy = np.sqrt(np.average((y - np.average(y, weights=w))**2, weights=w))
        cy = np.average(y, weights=w) if center else 0
        y = (y - cy) / sy
    result = fit(frame_of(X, y, w if weighted else None), algorithm=kind, intercept=center, lambdaValue=.035, tolerance=1e-11, maxIterations=100000)
    model = result["model"]
    offsets = np.array([f["offset"] for f in model["features"]])
    scales = np.array([f["scale"] for f in model["features"]])
    Z = (X - offsets) / scales
    oracle = estimator(kind, len(y), center).fit(Z, y, sample_weight=w * len(y) / w.sum())
    np.testing.assert_allclose(result["fitted"], oracle.predict(Z), atol=1e-9, rtol=1e-10)
    raw_coefficients = np.array([c["estimate"] for c in model["display"]["coefficients"]])
    raw_intercept = model["display"]["intercept"]["estimate"]
    np.testing.assert_allclose(raw_intercept + X @ raw_coefficients, result["fitted"], atol=1e-9, rtol=1e-10)
    assert model["linearModel"]["targetOffset"] == 0 and model["linearModel"]["targetScale"] == 1
    assert model["training"]["libraryAlpha"] == pytest.approx(len(y)*.035 if kind == "ridge" else .035)
    if not center:
        assert all(f["offset"] == 0 for f in model["features"])
        assert model["linearModel"]["intercept"] == 0


@pytest.mark.parametrize("kind", ["ridge", "lasso", "elasticnet"], ids=["D25", "D26", "D27"])
def test_design_baseline_frequency_expansion(kind):
    X, y, w = baseline_data()
    rows = np.repeat(np.arange(len(y)), w.astype(int))
    config = dict(algorithm=kind, lambdaValue=.035, tolerance=1e-11, maxIterations=100000)
    weighted = fit(frame_of(X, y, w), **config)
    expanded = fit(frame_of(X[rows], y[rows]), **config)
    multiplied = fit(frame_of(X, y, w*13), **config)
    np.testing.assert_allclose(weighted["model"]["linearModel"]["coefficients"], expanded["model"]["linearModel"]["coefficients"], atol=1e-8, rtol=1e-9)
    np.testing.assert_allclose(weighted["fitted"], multiplied["fitted"], atol=1e-10, rtol=1e-10)


@pytest.mark.parametrize("intercept", [True, False])
def test_ridge_keeps_constants_and_duplicate_columns_without_ols_rank_rejection(intercept):
    X = np.column_stack([np.ones(5)*3, np.arange(5), np.arange(5), np.eye(5)])
    result = fit(frame_of(X, [1, 3, 4, 5, 7]), intercept=intercept)
    assert result["summary"]["nDesignColumns"] == 8
    assert result["model"]["features"][0]["constant"] is True
    assert result["model"]["features"][0]["scale"] == 1
    if intercept:
        assert result["model"]["linearModel"]["coefficients"][0] == 0
    else:
        assert result["model"]["linearModel"]["coefficients"][0] != 0


def test_full_one_hot_missing_sentinels_and_literal_collision():
    frame = frame_of(np.empty((6, 0)), [0, 1, 2, 3, 4, 5], categories={"g": ["__missing__", MISSING_M, MISSING_NA, "0", "", "__missing__"]})
    result = fit(frame, missingPolicy="separate_not_applicable")
    levels = result["model"]["inputs"][0]["observedCategories"]
    assert len(levels) == 5 and result["summary"]["nDesignColumns"] == 5
    assert { (c["kind"], c["code"]) for c in levels } == {("value", "__missing__"), ("missing", None), ("not_applicable", None), ("value", "0"), ("value", "")}
    assert all(c["standardizedEstimate"] is None for c in result["details"]["coefficients"])


def test_weighted_actual_scale_and_original_unit_display():
    X = np.array([[1, 2], [2, 7], [8, 10], [9, 3]], dtype=float)
    y, w = np.array([10, 20, 30, 40]), np.array([1, 2, 8, 1])
    result = fit(frame_of(X, y, w))
    for j, feature in enumerate(result["model"]["features"]):
        mean = np.average(X[:, j], weights=w)
        sd = np.sqrt(np.average((X[:, j]-mean)**2, weights=w))
        assert feature["offset"] == pytest.approx(mean)
        assert feature["scale"] == pytest.approx(sd)
        assert result["details"]["coefficients"][j]["estimate"] == pytest.approx(result["model"]["linearModel"]["coefficients"][j] / sd)


def test_standardization_disabled_saves_scale_one_and_weighted_center():
    result = fit(frame_of([[1], [4], [9]], [4, 8, 9], [1, 2, 3]), standardize=False)
    assert result["model"]["features"][0]["scale"] == 1
    assert result["model"]["features"][0]["offset"] == 6


@pytest.mark.parametrize("kind", ["ridge", "lasso", "elasticnet"])
def test_constant_target_does_not_claim_r_squared_or_standardized_effect(kind):
    result = fit(frame_of([[1], [2], [3]], [7, 7, 7]), algorithm=kind)
    np.testing.assert_array_equal(result["fitted"], [7, 7, 7])
    assert result["summary"]["fitRSquared"] is None
    assert result["details"]["coefficients"][0]["standardizedReason"] == "constant_target"


def test_display_overflow_is_nullable_while_centered_prediction_stays_finite():
    X = np.array([1e-200, 2e-200, 3e-200, 4e-200])
    y = np.array([1e150, 2e150, 3e150, 4e150])
    result = fit(frame_of(X, y))
    assert result["details"]["coefficients"][0]["estimate"] is None
    assert result["details"]["coefficients"][0]["estimateReason"] == "numeric_range"
    assert np.isfinite(result["fitted"]).all()
    assert result["details"]["coefficients"][0]["standardizedEstimate"] is not None


def test_huge_offset_preserves_centered_execution():
    X = 1e16 + 2 * np.arange(20, dtype=float)
    result = fit(frame_of(X, 3 * (X - 1e16) + 7))
    assert np.isfinite(result["fitted"]).all()
    assert result["model"]["features"][0]["offset"] > 1e16


def test_subnormal_variance_policy_is_explicit():
    result = fit(frame_of([0, 5e-324, 1e-323], [1, 2, 3]))
    assert result["model"]["features"][0]["scale"] == 1
    assert not result["model"]["features"][0]["constant"]
    assert "RR_TINY_VARIANCE" in {warning["code"] for warning in result["warnings"]}


@pytest.mark.parametrize("change,code", [({"weight_type":"survey"}, "RR_SURVEY_UNSUPPORTED"), ({"weight_type":"mystery"}, "RR_WEIGHT_TYPE"), ({"weights":[0,1,2], "weight_type":"frequency"}, "RR_WEIGHT_INVALID")])
def test_unsupported_weights_are_never_silently_unweighted(change, code):
    with pytest.raises(BizError) as error:
        fit(replace(frame_of([1,2,3], [2,3,4]), **change))
    assert error.value.code == code


def test_empty_and_nonfinite_and_zero_lambda_errors():
    for frame, config, expected in [(frame_of(np.empty((0,1)), []), {}, "RR_NO_EFFECTIVE_ROWS"), (frame_of([1,2], [1,math.inf]), {}, "RR_INPUT_INVALID"), (frame_of([1,2], [2,3]), {"lambdaValue": 0}, "RR_CONFIG_INVALID")]:
        with pytest.raises(BizError) as error:
            fit(frame, **config)
        assert error.value.code == expected


def test_no_ols_inference_fields_and_no_input_mutation():
    frame = frame_of([1,2,3], [4,5,6])
    before = copy.deepcopy(frame)
    result = fit(frame)
    assert frame == before
    payload = json.dumps({k:v for k,v in result.items() if k not in ("fitted", "residual")}, allow_nan=False)
    for forbidden in ("pValue", "standardError", "adjustedRSquared", "aic", "bic", "leverage", "cooksDistance", "confidenceInterval"):
        assert forbidden not in payload


def cv_config(**changes):
    return {"folds": 4, "seed": 42, "lambdaValues": [.01, .1, 1], "l1Ratios": [.3, .7],
            "independentRowsAcknowledged": True, **changes}


@pytest.mark.parametrize("kind", ["ridge", "lasso", "elasticnet"])
def test_cv_pooled_weighted_sse_audit_and_full_refit(kind):
    rng = np.random.default_rng(1221)
    X = rng.normal(size=(31, 3))
    y = X @ [2, -.5, 1] + rng.normal(size=31)
    w = np.arange(1, 32, dtype=float)**2
    frame = frame_of(X, y, w)
    request = cv_config()
    result = fit(frame, algorithm=kind, selection="cv", cv=request)
    audit = result["details"]["cv"]
    assert request == cv_config()  # no mutation
    assert len(audit["assignments"]) == 31
    assert "assignments" not in result["model"]["training"]["cv"]
    assert "row-" not in json.dumps(result["model"]["training"]["cv"])
    for candidate in audit["candidates"]:
        pooled = sum(f["weightedSse"] for f in candidate["folds"]) / sum(f["validationWeight"] for f in candidate["folds"])
        assert candidate["weightedMse"] == pytest.approx(pooled)
        assert candidate["rmse"] == pytest.approx(np.sqrt(pooled))
        for fold in candidate["folds"]:
            assert fold["libraryAlpha"] == pytest.approx(fold["trainCount"]*candidate["lambdaValue"] if kind == "ridge" else candidate["lambdaValue"])
            assert fold["failedPredictions"] == 0 and fold["convergence"]["converged"]
    best = min(audit["candidates"], key=lambda c:c["weightedMse"])
    assert result["summary"]["lambdaValue"] == best["lambdaValue"]
    manual = fit(frame, algorithm=kind, lambdaValue=best["lambdaValue"], l1Ratio=best["l1Ratio"] if kind == "elasticnet" else .5)
    np.testing.assert_array_equal(result["fitted"], manual["fitted"])
    assert result["model"]["training"]["libraryAlpha"] == pytest.approx(31*best["lambdaValue"] if kind == "ridge" else best["lambdaValue"])
    if kind == "elasticnet":
        assert len(audit["candidates"]) == 6


def test_cv_preprocessing_is_train_only_and_assignment_is_immutable():
    X = np.column_stack([np.arange(24, dtype=float), np.ones(24)])
    w = np.arange(1, 25, dtype=float)
    frame = frame_of(X, np.sin(X[:,0])+X[:,0], w)
    first = fit(frame, selection="cv", cv=cv_config())
    audit = first["details"]["cv"]
    assignment = {a["rowId"]:a["fold"] for a in audit["assignments"]}
    for fold in audit["foldAudits"]:
        train = np.array([assignment[r] != fold["fold"] for r in frame.row_ids])
        assert fold["features"][0]["offset"] == pytest.approx(np.average(X[train,0], weights=w[train]))
        assert fold["features"][1]["constant"] is True
        assert fold["normalizedTrainWeight"] == np.sum(train)
    validation = np.array([assignment[r] == 0 for r in frame.row_ids])
    changed = copy.deepcopy(frame)
    changed.numeric_inputs["x0"] = np.where(validation, X[:,0]*1000+7, X[:,0]).tolist()
    changed.numeric_inputs["x1"] = np.where(validation, 3, 1).tolist()
    second = fit(changed, selection="cv", cv=cv_config())
    assert second["details"]["cv"]["foldAudits"][0]["features"] == audit["foldAudits"][0]["features"]
    assert second["summary"]["cv"]["assignmentFingerprint"] == first["summary"]["cv"]["assignmentFingerprint"]
    assert second["model"]["features"][1]["constant"] is False


def test_cv_train_levels_never_use_full_frame_catalog_or_unused_declarations():
    categories = {"g": ["A", "B"]*12}
    specs = {"g":{"columnId":"g", "name":"g", "categoryOrder":["A", "B", "UNOBSERVED"]}}
    frame = frame_of(np.arange(24), np.arange(24)+np.tile([0,3],12), categories=categories, category_specs=specs)
    result = fit(frame, selection="cv", cv=cv_config(folds=3))
    for fold in result["details"]["cv"]["foldAudits"]:
        assert {c["code"] for c in fold["observedCategories"][0]["levels"]} == {"A", "B"}
        assert len(fold["features"]) == 3
    assert result["model"]["inputs"][1]["declaredCategories"] == ["A", "B", "UNOBSERVED"]


def test_cv_unseen_validation_level_invalidates_cv_without_dropping_rows():
    frame = frame_of(np.arange(12), np.arange(12), categories={"g":["common"]*11+["rare"]})
    with pytest.raises(BizError) as error:
        fit(frame, selection="cv", cv=cv_config())
    assert error.value.code == "RR_CV_UNKNOWN_CATEGORY"
    assert error.value.details["failedPredictions"] == 1
    assert "assignmentFingerprint" in error.value.details


@pytest.mark.parametrize("kind", ["ridge", "lasso", "elasticnet"])
def test_cv_uniform_weight_scaling_preserves_scores_selection_and_fit(kind):
    rng = np.random.default_rng(414)
    X, w = rng.normal(size=(40,3)), rng.integers(1,9,40).astype(float)
    y = X @ [3, -2, 0] + rng.normal(size=40)
    one = fit(frame_of(X,y,w), algorithm=kind, selection="cv", cv=cv_config())
    two = fit(frame_of(X,y,w*19), algorithm=kind, selection="cv", cv=cv_config())
    assert one["summary"]["lambdaValue"] == two["summary"]["lambdaValue"]
    assert one["summary"]["cv"]["weightedMse"] == pytest.approx(two["summary"]["cv"]["weightedMse"], rel=1e-10)
    np.testing.assert_allclose(one["fitted"], two["fitted"], atol=1e-10, rtol=1e-10)


@pytest.mark.parametrize("cv,code", [(cv_config(folds=20),"RR_CV_FOLDS_INVALID"), (cv_config(independentRowsAcknowledged=False),"RR_CV_INDEPENDENCE_REQUIRED"), (cv_config(lambdaValues=[0,.1]),"RR_CV_CONFIG_INVALID"), (cv_config(lambdaValues=[.1,.1]),"RR_CV_CONFIG_INVALID"), (cv_config(l1Ratios=[.001]),"RR_CV_CONFIG_INVALID"), (cv_config(seed=-1),"RR_CV_CONFIG_INVALID")])
def test_cv_rejects_invalid_configuration(cv,code):
    with pytest.raises(BizError) as error:
        fit(frame_of(np.arange(12),np.arange(12)), algorithm="elasticnet", selection="cv",cv=cv)
    assert error.value.code == code


def test_cv_rejects_known_grouped_design():
    frame = replace(frame_of(np.arange(12), np.arange(12)), design_psu=["a"]*6+["b"]*6)
    with pytest.raises(BizError) as error:
        fit(frame, selection="cv",cv=cv_config())
    assert error.value.code == "RR_CV_GROUPED_UNSUPPORTED"


def nonconverging_frame():
    rng = np.random.default_rng(827)
    X = rng.normal(size=(80,30))
    X[:,1:] = X[:,[0]] + .01*X[:,1:]
    return frame_of(X, rng.normal(size=80) + X[:,0])


def test_coordinate_descent_nonconvergence_is_not_success():
    with pytest.raises(BizError) as error:
        fit(nonconverging_frame(), algorithm="lasso", lambdaValue=1e-8, maxIterations=100, tolerance=1e-14)
    assert error.value.code == "RR_NONCONVERGENCE"
    assert error.value.details["iterations"] == 100


def test_cv_nonconverged_candidates_are_audited_and_never_selected():
    result = fit(nonconverging_frame(), algorithm="lasso", selection="cv",cv=cv_config(lambdaValues=[1e-8,10]), maxIterations=100, tolerance=1e-14)
    audit = result["details"]["cv"]
    assert result["summary"]["lambdaValue"] == 10
    assert audit["summary"]["invalidCandidateCount"] == 1
    assert "RR_CV_INVALID_CANDIDATES" in {warning["code"] for warning in result["warnings"]}
    invalid = audit["candidates"][0]
    assert invalid["weightedMse"] is None and invalid["valid"] is False
    assert invalid["failureCount"] > 0
    assert any(f["failure"]["code"] == "RR_NONCONVERGENCE" for f in invalid["folds"] if f["failure"])


def test_cv_no_valid_candidate_returns_failure_audit():
    with pytest.raises(BizError) as error:
        fit(nonconverging_frame(), algorithm="lasso", selection="cv",cv=cv_config(lambdaValues=[1e-8]), maxIterations=100, tolerance=1e-14)
    assert error.value.code == "RR_CV_NO_VALID_CANDIDATE"
    assert error.value.details["cv"]["candidates"][0]["valid"] is False


def test_ordinal_metadata_is_frozen_and_not_applicable_is_a_missing_subset():
    frame = frame_of([3,2,1,3], [8,4,1,7])
    frame.numeric_specs["x0"].update({"categoryOrder":["lo","mid","hi","NA","missing"],"missingCodes":["NA","missing"],"missingReasons":{"NA":"not_applicable"}})
    frame.numeric_ordinal["x0"]={"order":["lo","mid","hi"],"reversed":True}
    result=fit(frame)
    item=result["model"]["inputs"][0]
    assert item["kind"] == "ordinal"
    assert item["ordinalOrder"] == ["lo","mid","hi"] and item["ordinalReversed"] is True
    assert item["missingCodes"] == ["NA", "missing"] and item["notApplicableCodes"] == ["NA"]
    assert result["model"]["features"][0]["operation"] == "ordered_rank"
    assert result["details"]["coefficients"][0]["unit"] == "目的変数の単位／順序得点"


def test_lasso_exact_zero_is_fit_zero_not_display_rounding():
    result=fit(frame_of([[1,9],[2,3],[3,2],[4,1]], [2,4,6,8]), algorithm="lasso", lambdaValue=100)
    assert all(c["exactZero"] for c in result["details"]["coefficients"])
    assert result["model"]["linearModel"]["coefficients"] == [0,0]


def test_fit_portable_model_validates_and_reproduces_centered_predictions():
    from app.domain.portable_regression import seal_model, predict_batch
    frame=frame_of([1,2,3,4], [3,6,8,10], categories={"g":["A","B","A","B"]})
    result=fit(frame)
    model=copy.deepcopy(result["model"])
    model["identity"]={"modelId":"test","modelVersion":"1","algorithmVersion":"davis.regularized_regression.1.0.0","exporterVersion":"1","runtimeVersion":"1","createdAt":"2026-10-02T00:00:00Z","contentHash":""}
    model["provenance"]={"revisions":{"dataRevision":1,"schemaRevision":1,"maskRevision":None},"scopeFingerprint":"test","fitCount":4,"libraryVersions":{"python":"3.12.14","numpy":"2.4.6","sklearn":"1.9.0"}}
    sealed=seal_model(model)
    predicted=predict_batch(sealed,[{"x0":x,"g":g} for x,g in zip([1,2,3,4],["A","B","A","B"])])
    assert all(p["status"] == "ok" for p in predicted)
    np.testing.assert_allclose([p["prediction"] for p in predicted],result["fitted"],atol=1e-10,rtol=1e-10)


def test_reference_is_display_only_and_unobserved_reference_is_rejected():
    frame = frame_of(np.empty((6,0)), [1,3,2,4,3,5], categories={"g":["a","b"]*3})
    first = fit_regularized(frame,[{"columnId":"g","kind":"categorical","referenceCategory":"a"}],{})
    second = fit_regularized(frame,[{"columnId":"g","kind":"categorical","referenceCategory":"b"}],{})
    assert first["model"]["linearModel"] == second["model"]["linearModel"]
    assert first["model"]["features"] == second["model"]["features"]
    assert first["details"]["coefficients"] == second["details"]["coefficients"]
    assert second["details"]["categoryReferences"][0]["reference"] == {"code":"b","kind":"value"}
    with pytest.raises(BizError) as error:
        fit_regularized(frame,[{"columnId":"g","kind":"categorical","referenceCategory":"unseen"}],{})
    assert error.value.code == "RR_REFERENCE_INVALID"


@pytest.mark.parametrize("kind", ["ridge", "lasso", "elasticnet"])
def test_no_intercept_full_categorical_model_preserves_origin(kind):
    frame = frame_of(np.empty((8,0)), [3,7,2,8,4,9,3,8], categories={"g":["a","b"]*4})
    result=fit(frame, algorithm=kind, intercept=False, lambdaValue=.035, tolerance=1e-11,maxIterations=100000)
    assert all(feature["offset"] == 0 for feature in result["model"]["features"])
    assert result["model"]["linearModel"]["intercept"] == 0
    X=np.column_stack([np.tile([1,0],4),np.tile([0,1],4)])
    scales=np.array([f["scale"] for f in result["model"]["features"]])
    oracle=estimator(kind,8,False).fit(X/scales,frame.target_values)
    np.testing.assert_allclose(result["fitted"],oracle.predict(X/scales),rtol=1e-10,atol=1e-10)


def test_nonzero_display_underflow_is_not_fabricated_zero():
    X=np.array([1e200,2e200,3e200,4e200])
    result=fit(frame_of(X,np.array([1e-150,2e-150,3e-150,4e-150])))
    row=result["details"]["coefficients"][0]
    assert row["estimate"] is None and row["estimateReason"] == "numeric_range"
    assert row["exactZero"] is False
    assert row["standardizedEstimate"] is not None
    assert np.isfinite(result["fitted"]).all()


def test_tiny_representable_effect_remains_distinct_from_exact_zero():
    result=fit(frame_of([1,2,3,4],np.array([1,2,3,4])*1e-13))
    row=result["details"]["coefficients"][0]
    assert 0 < abs(row["estimate"]) < 1e-12
    assert row["exactZero"] is False


def test_descriptive_r_squared_uses_actual_weighted_target_sd_at_huge_offset():
    y=1e16+np.array([0,2,2,8])
    w=np.array([1,3,2,1])
    result=fit(frame_of([0,1,2,3],y,w))
    yy=y.astype(np.longdouble)
    mean=yy[0]+np.sum((w/w.sum()).astype(np.longdouble)*(yy-yy[0]))
    sse=np.sum(w.astype(np.longdouble)*result["residual"].astype(np.longdouble)**2)
    total=np.sum(w.astype(np.longdouble)*(yy-mean)**2)
    assert result["summary"]["fitRSquared"] == pytest.approx(float(1-sse/total), rel=1e-7)


def test_one_effective_row_remains_valid_for_manual_ridge():
    result=fit(frame_of([[3,4]],[7]))
    assert result["fitted"].tolist() == [7]
    assert result["model"]["linearModel"]["coefficients"] == [0,0]
