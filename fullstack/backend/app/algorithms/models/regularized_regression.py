"""Regularized regression on a frozen, already filtered regression frame.

The fitted coordinate system is the portable model's coordinate system.  No
OLS design/rank/inference code is used.  All one-hot levels observed by the
*training* rows are represented, including constant columns.  Random CV learns
a fresh encoder and transform inside every training fold.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import warnings as python_warnings
from decimal import Decimal, localcontext
from typing import Any

import numpy as np
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import ElasticNet, Lasso, Ridge
from sklearn.model_selection import KFold

from ...domain.analysis_frame import MissingKey, PreparedRegressionFrame
from ...domain.codebook_adapter import is_not_applicable_reason
from ...domain.errors import BizError

SCHEMA_VERSION = "davis.regularized-regression/1"
OBJECTIVE = "sum(w*(y-prediction)^2)/(2*sum(w)) + lambda*(rho*L1 + (1-rho)*L2/2)"
SAFE_INTEGER = 9007199254740991


def _fail(code: str, message: str, **details: Any) -> None:
    raise BizError(code, message, status_code=422, details=details)


def _finite(value: Any) -> float | None:
    """Display quantities may be unrepresentable although execution is valid."""
    with np.errstate(over="ignore", invalid="ignore", under="ignore"):
        out = float(value)
    return out if math.isfinite(out) and not (out == 0 and value != 0) else None


def _code(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, np.integer, np.floating)) and not isinstance(value, (bool, np.bool_)):
        if math.isfinite(float(value)) and float(value).is_integer() and abs(value) <= SAFE_INTEGER:
            return str(int(value))
    _fail("RR_INPUT_TYPE", "カテゴリは文字列または安全な整数で指定してください。")


def _category(value: Any) -> tuple[str, str | None]:
    if isinstance(value, MissingKey):
        if value.kind not in ("missing", "not_applicable"):
            _fail("RR_INPUT_TYPE", "欠損カテゴリの種類が不正です。")
        return value.kind, None
    return "value", _code(value)


def _category_object(value: tuple[str, str | None]) -> dict:
    return {"code": value[1], "kind": value[0]}


def _weights(frame: PreparedRegressionFrame) -> np.ndarray:
    if frame.weight_type == "survey":
        _fail("RR_SURVEY_UNSUPPORTED", "正則化回帰はsurvey重みに対応していません。")
    if frame.weight_type not in (None, "frequency"):
        _fail("RR_WEIGHT_TYPE", "未対応の重み種別です。")
    if frame.weights is not None and frame.weight_type != "frequency":
        _fail("RR_WEIGHT_TYPE", "重み付き学習にはfrequencyの宣言が必要です。")
    if frame.weight_applied and frame.weights is None:
        _fail("RR_WEIGHT_INVALID", "適用された重みがありません。")
    try:
        w = np.ones(len(frame.target_values)) if frame.weights is None else np.asarray(frame.weights, dtype=np.float64)
    except (ValueError, TypeError):
        _fail("RR_WEIGHT_INVALID", "有効な正の重みが必要です。")
    if w.shape != (len(frame.target_values),) or not np.isfinite(w).all() or np.any(w <= 0):
        _fail("RR_WEIGHT_INVALID", "学習行の重みは有限の正数である必要があります。")
    return w


def _normalize_weights(w: np.ndarray) -> np.ndarray:
    # Long-double intermediates avoid overflow in the sum and preserve the
    # objective when every supplied frequency is multiplied by the same factor.
    extended = w.astype(np.longdouble)
    extended /= np.max(extended)
    normalized = np.asarray(extended / extended.sum() * len(w), dtype=np.float64)
    if not np.isfinite(normalized).all() or np.any(normalized <= 0):
        _fail("RR_NUMERIC_RANGE", "重みの正規化がfloat64の表現範囲を超えました。", field="weights")
    return normalized


def _moments(x: np.ndarray, w: np.ndarray) -> tuple[float, np.longdouble]:
    xx = x.astype(np.longdouble)
    ww = w.astype(np.longdouble)
    ww /= np.max(ww)
    ww = ww / ww.sum()
    # Windows longdouble is commonly float64. Normalize anchored differences
    # BEFORE squaring so a representable SD such as 1e-200 cannot underflow.
    with np.errstate(over="ignore", invalid="ignore", under="ignore"):
        delta = xx - xx[0]
        magnitude = np.max(np.abs(delta))
        if not np.isfinite(magnitude):
            _fail("RR_NUMERIC_RANGE", "学習値の差が数値表現範囲を超えました。", field="moments")
        if magnitude == 0:
            return float(xx[0]), np.longdouble(0)
        scaled = delta / magnitude
        mean_scaled = np.sum(ww * scaled)
        mean = xx[0] + mean_scaled * magnitude
        sd = magnitude * np.sqrt(np.sum(ww * (scaled - mean_scaled) ** 2))
    if not np.isfinite(sd) or sd == 0:
        _fail("RR_NUMERIC_RANGE", "非定数列の標準偏差を正確に表現できません。", field="standardDeviation")
    offset = _finite(mean)
    if offset is None:
        _fail("RR_NUMERIC_RANGE", "学習平均がfloat64の表現範囲を超えました。", field="mean")
    return offset, sd


def _input_descriptors(frame: PreparedRegressionFrame, predictor_specs: list[dict]) -> list[dict]:
    out = []
    seen = set()
    for predictor in predictor_specs:
        cid = predictor.get("columnId")
        if not isinstance(cid, str) or not cid or cid in seen:
            _fail("RR_PREDICTOR_INVALID", "説明変数のIDが不正または重複しています。")
        seen.add(cid)
        kind = predictor.get("kind")
        if kind not in ("numeric", "categorical"):
            _fail("RR_PREDICTOR_INVALID", "数値またはカテゴリ主効果のみ使用できます。")
        ids = frame.numeric_ids if kind == "numeric" else frame.category_ids
        name = next((name for name, id_ in ids.items() if id_ == cid or name == cid), None)
        if name is None:
            _fail("RR_PREDICTOR_INVALID", "説明変数が学習フレームにありません。", columnId=cid)
        spec = (frame.numeric_specs if kind == "numeric" else frame.category_specs)[name]
        ordinal = frame.numeric_ordinal.get(name) if kind == "numeric" else None
        missing = list(dict.fromkeys(_code(c) for c in spec.get("missingCodes", []) or []))
        reasons = spec.get("missingReasons") or {}
        na = [c for c in missing if is_not_applicable_reason(reasons.get(c))]
        order = list(dict.fromkeys(_code(c) for c in spec.get("categoryOrder", []) or [] if _code(c) not in missing))
        frozen_order = list(ordinal.get("order", [])) if ordinal else []
        if ordinal and (not frozen_order or len(set(frozen_order)) != len(frozen_order)):
            _fail("RR_ORDINAL_INVALID", "順序尺度の順序が不正です。", columnId=cid)
        out.append({
            "columnId": str(ids[name]), "key": name, "name": name,
            "label": str(spec.get("label") or name),
            "kind": "ordinal" if ordinal else kind,
            "unit": str(spec["unit"]) if spec.get("unit") is not None else None,
            "missingCodes": missing, "notApplicableCodes": na,
            "declaredCategories": order if order and (kind == "categorical" or ordinal) else None,
            "observedCategories": [], "ordinalOrder": frozen_order,
            "ordinalReversed": bool(ordinal.get("reversed", False)) if ordinal else False,
            "trainingMin": None, "trainingMax": None,
        })
    if not out:
        _fail("RR_PREDICTOR_INVALID", "説明変数を1列以上指定してください。")
    if len({item["key"] for item in out}) != len(out):
        _fail("RR_INPUT_KEY_COLLISION", "入力キーが重複しています。")
    return out


def _build_design(frame: PreparedRegressionFrame, descriptors: list[dict], positions: np.ndarray,
                  w: np.ndarray, config: dict) -> dict:
    inputs = copy.deepcopy(descriptors)
    features, columns, comparisons, notices = [], [], [], []
    for item in inputs:
        name, cid = item["name"], item["columnId"]
        if item["kind"] != "categorical":
            try:
                raw = np.asarray(frame.numeric_inputs[name], dtype=np.float64)
            except (ValueError, TypeError):
                _fail("RR_INPUT_INVALID", "数値説明変数に欠損または不正値があります。", columnId=cid)
            if raw.shape != (len(frame.target_values),) or not np.isfinite(raw).all():
                _fail("RR_INPUT_INVALID", "数値説明変数に欠損または不正値があります。", columnId=cid)
            x = raw[positions]
            item["trainingMin"], item["trainingMax"] = float(np.min(x)), float(np.max(x))
            parts = [(None, x, "ordered_rank" if item["kind"] == "ordinal" else "identity")]
        else:
            raw = frame.category_inputs[name]
            if len(raw) != len(frame.target_values):
                _fail("RR_INPUT_INVALID", "カテゴリ行数が一致しません。", columnId=cid)
            observed = list(dict.fromkeys(_category(raw[int(pos)]) for pos in positions))
            declared = item["declaredCategories"] or []
            ordered = [("value", c) for c in declared if ("value", c) in observed]
            # Open-domain dictionaries are deterministic and train-only; neither
            # the full-frame catalog nor validation first occurrence sets order.
            ordered += sorted((c for c in observed if c not in ordered), key=lambda c: (c[0], c[1] or ""))
            spec = frame.category_specs[name]
            labels = spec.get("valueLabels") or {}
            item["observedCategories"] = [dict(_category_object(c), label=(str(labels.get(c[1], c[1])) if c[0] == "value" else "欠損" if c[0] == "missing" else "非該当")) for c in ordered]
            parts = [(_category_object(c), np.asarray([float(_category(raw[int(pos)]) == c) for pos in positions]), "one_hot") for c in ordered]
        for category, x, operation in parts:
            mean, sd_extended = _moments(x, w)
            constant = bool(np.all(x == x[0]))
            offset = (float(x[0]) if constant else mean) if config["intercept"] else 0.0
            sd = _finite(sd_extended)
            scale = 1.0
            if config["standardize"] and not constant:
                if sd is not None and sd >= np.finfo(np.float64).tiny:
                    scale = sd
                else:
                    notices.append({"code": "RR_TINY_VARIANCE", "message": "極小分散の列はscale=1で保持します。", "columnId": cid})
            if constant:
                notices.append({"code": "RR_CONSTANT_FEATURE", "message": "定数列を保持しました。切片ありでは中心化して係数を0とします。", "columnId": cid})
            with np.errstate(over="ignore", invalid="ignore", under="ignore"):
                centered = x - offset
                transformed = centered / scale
            if not np.isfinite(transformed).all() or np.any((centered != 0) & (transformed == 0)):
                _fail("RR_NUMERIC_RANGE", "説明変数の変換がfloat64の表現範囲を超えました。", columnId=cid)
            design_id = f"feature:{len(features)}"
            features.append({"designColumnId": design_id, "inputColumnId": cid,
                             "operation": operation, "category": category,
                             "offset": offset, "scale": scale, "constant": constant})
            columns.append(transformed)
            comparisons.append(sd_extended)
    return {"inputs": inputs, "features": features, "matrix": np.column_stack(columns),
            "comparisonSds": comparisons, "warnings": notices}


def _transform(frame: PreparedRegressionFrame, design: dict, positions: np.ndarray) -> np.ndarray:
    columns = []
    by_id = {item["columnId"]: item for item in design["inputs"]}
    for item in design["inputs"]:
        if item["kind"] != "categorical":
            continue
        allowed = {(c["kind"], c["code"]) for c in item["observedCategories"]}
        unknown = sum(_category(frame.category_inputs[item["name"]][int(pos)]) not in allowed for pos in positions)
        if unknown:
            _fail("RR_CV_UNKNOWN_CATEGORY", "検証foldに学習foldで未観測の水準があります。水準の統合または分割を見直してください。",
                  columnId=item["columnId"], failedPredictions=unknown)
    for feature in design["features"]:
        item = by_id[feature["inputColumnId"]]
        if feature["operation"] == "one_hot":
            category = feature["category"]
            level = category["kind"], category["code"]
            raw = np.asarray([float(_category(frame.category_inputs[item["name"]][int(pos)]) == level) for pos in positions])
        else:
            raw = np.asarray(frame.numeric_inputs[item["name"]], dtype=np.float64)[positions]
        with np.errstate(over="ignore", invalid="ignore", under="ignore"):
            centered = raw - feature["offset"]
            column = centered / feature["scale"]
        if not np.isfinite(column).all() or np.any((centered != 0) & (column == 0)):
            _fail("RR_NUMERIC_RANGE", "検証foldの変換がfloat64の表現範囲を超えました。")
        columns.append(column)
    return np.column_stack(columns)


def _rho(config: dict) -> float:
    return 0.0 if config["algorithm"] == "ridge" else 1.0 if config["algorithm"] == "lasso" else config["l1Ratio"]


def _solve(matrix: np.ndarray, y: np.ndarray, w: np.ndarray, config: dict) -> dict:
    n = len(y)
    wn = _normalize_weights(w)
    y_offset = _moments(y, w)[0] if config["intercept"] else 0.0
    # Center explicitly in original target units, never normalize the target.
    # Correct for the small residual mean of the saved float64 X transform.
    means = np.asarray([_moments(matrix[:, j], w)[0] for j in range(matrix.shape[1])]) if config["intercept"] else np.zeros(matrix.shape[1])
    with np.errstate(over="ignore", invalid="ignore", under="ignore"):
        X = matrix - means
        response = y - y_offset
    if not np.isfinite(X).all() or not np.isfinite(response).all():
        _fail("RR_NUMERIC_RANGE", "中心化がfloat64の表現範囲を超えました。")
    alpha = n * config["lambdaValue"] if config["algorithm"] == "ridge" else config["lambdaValue"]
    if not math.isfinite(alpha) or alpha <= 0:
        _fail("RR_NUMERIC_RANGE", "正則化係数がfloat64の表現範囲を超えました。")
    if config["algorithm"] == "ridge":
        estimator = Ridge(alpha=alpha, fit_intercept=False, solver="svd", tol=config["tolerance"])
        solver = "svd"
    else:
        cls = Lasso if config["algorithm"] == "lasso" else ElasticNet
        kwargs = {} if cls is Lasso else {"l1_ratio": config["l1Ratio"]}
        estimator = cls(alpha=alpha, fit_intercept=False, max_iter=config["maxIterations"],
                        tol=config["tolerance"], selection="cyclic", **kwargs)
        solver = "coordinate_descent_cyclic"
    if np.all(response == 0):
        return {"coefficients": np.zeros(matrix.shape[1]), "intercept": y_offset,
                "solver": solver, "libraryAlpha": alpha,
                "convergence": {"converged": True, "iterations": 0 if solver != "svd" else None, "dualGap": 0.0 if solver != "svd" else None}}
    try:
        with python_warnings.catch_warnings(record=True) as caught, np.errstate(over="raise", invalid="raise", divide="raise"):
            python_warnings.simplefilter("always")
            estimator.fit(X, response, sample_weight=wn)
        if any(issubclass(warning.category, ConvergenceWarning) for warning in caught):
            _fail("RR_NONCONVERGENCE", "正則化回帰が収束していません。反復回数または許容誤差を見直してください。",
                  iterations=int(getattr(estimator, "n_iter_", config["maxIterations"])), solver=solver)
        if any(issubclass(warning.category, RuntimeWarning) for warning in caught):
            _fail("RR_NUMERIC_RANGE", "ソルバーで数値範囲の問題が生じました。")
    except BizError:
        raise
    except (ValueError, FloatingPointError, OverflowError, np.linalg.LinAlgError) as exc:
        _fail("RR_NUMERIC_RANGE", "正則化回帰を有限float64で計算できません。", solver=solver, reason=type(exc).__name__)
    coefficients = np.asarray(estimator.coef_, dtype=np.float64)
    # Exact zero design columns have the unique penalty minimum at zero.
    # SVD round-off must not invent a nonzero constant effect.
    coefficients[np.all(X == 0, axis=0)] = 0.0
    intercept = _finite(np.longdouble(y_offset) - np.sum(coefficients.astype(np.longdouble) * means.astype(np.longdouble)))
    dual_gap = _finite(getattr(estimator, "dual_gap_", 0.0)) if solver != "svd" else None
    if not np.isfinite(coefficients).all() or intercept is None or (solver != "svd" and dual_gap is None):
        _fail("RR_NUMERIC_RANGE", "推定係数がfloat64の表現範囲を超えました。")
    return {"coefficients": coefficients, "intercept": intercept,
            "solver": solver, "libraryAlpha": alpha,
            "convergence": {"converged": True, "iterations": int(estimator.n_iter_) if solver != "svd" else None, "dualGap": dual_gap}}


def _predict(matrix: np.ndarray, solution: dict) -> np.ndarray:
    # Match the portable, ordered centered execution instead of BLAS summation.
    pred = np.full(len(matrix), solution["intercept"], dtype=np.float64)
    with np.errstate(over="ignore", invalid="ignore", under="ignore"):
        for j, coefficient in enumerate(solution["coefficients"]):
            term = coefficient * matrix[:, j]
            if coefficient != 0 and np.any((matrix[:, j] != 0) & (term == 0)):
                _fail("RR_NUMERIC_RANGE", "予測項がfloat64の表現範囲を下回りました。", field="prediction")
            pred = pred + term
    if not np.isfinite(pred).all():
        _fail("RR_NUMERIC_RANGE", "予測値がfloat64の表現範囲を超えました。", field="prediction")
    return pred


def _display(design: dict, solution: dict, y: np.ndarray, w: np.ndarray, target: dict, config: dict) -> dict:
    # Decimal is used only for display inverse transforms. It avoids relying on
    # platform-specific longdouble exponent range, without changing fitted math.
    with localcontext() as ctx:
        ctx.prec = 800
        return _display_decimal(design, solution, y, w, target, config)


def _display_decimal(design: dict, solution: dict, y: np.ndarray, w: np.ndarray, target: dict, config: dict) -> dict:
    _, sy = _moments(y, w)
    by_id = {item["columnId"]: item for item in design["inputs"]}
    rows, raw_coefficients, references = [], [], []
    for j, feature in enumerate(design["features"]):
        item = by_id[feature["inputColumnId"]]
        beta = Decimal.from_float(float(solution["coefficients"][j])) / Decimal.from_float(float(feature["scale"]))
        raw_coefficients.append(beta)
        estimate = _finite(beta)
        comparison = design["comparisonSds"][j]
        reason = "categorical_not_applicable" if item["kind"] == "categorical" else "constant_target" if sy == 0 else "constant_predictor" if comparison == 0 else None
        standardized = _finite(beta * Decimal(str(comparison)) / Decimal(str(sy))) if reason is None else None
        if standardized is None and reason is None:
            reason = "numeric_range"
        label = item["label"]
        if feature["category"] is not None:
            level = next(c for c in item["observedCategories"] if c["code"] == feature["category"]["code"] and c["kind"] == feature["category"]["kind"])
            label = f"{label}: {level['label']}"
        target_unit = target.get("unit") or "目的変数の単位"
        predictor_unit = "順序得点" if item["kind"] == "ordinal" else item.get("unit") or "説明変数の単位"
        unit = target_unit if item["kind"] == "categorical" else f"{target_unit}／{predictor_unit}"
        rows.append({"designColumnId": feature["designColumnId"], "columnId": item["columnId"],
                     "label": label, "kind": item["kind"], "category": copy.deepcopy(feature["category"]),
                     "estimate": estimate, "estimateReason": None if estimate is not None else "numeric_range",
                     "standardizedEstimate": standardized, "standardizedReason": reason,
                     "comparisonSd": _finite(comparison), "exactZero": bool(solution["coefficients"][j] == 0), "unit": unit})
    original_intercept = Decimal.from_float(float(solution["intercept"]))
    for coefficient, feature in zip(raw_coefficients, design["features"]):
        original_intercept -= coefficient * Decimal.from_float(float(feature["offset"]))
    intercept = _finite(original_intercept)
    for item in design["inputs"]:
        if item["kind"] == "categorical":
            references.append({"columnId": item["columnId"], "reference": {k: item["observedCategories"][0][k] for k in ("code", "kind")}, "levels": copy.deepcopy(item["observedCategories"])})
    return {"coefficients": rows, "intercept": {"estimate": intercept, "reason": None if intercept is not None else "numeric_range"},
            "targetSd": _finite(sy), "targetLabel": target["label"], "targetUnit": target.get("unit"), "categoryReferences": references}


def _fit_metrics(y: np.ndarray, residual: np.ndarray, w: np.ndarray, intercept: bool) -> dict:
    # Descriptive R² uses centered TSS consistently with out-of-fit evaluation,
    # including models constrained through the origin. No OLS uncentered alias.
    ww = w.astype(np.longdouble)
    ww /= ww.max()
    ww /= ww.sum()
    rr = residual.astype(np.longdouble)
    with np.errstate(over="ignore", invalid="ignore", divide="ignore", under="ignore"):
        scale = np.max(np.abs(rr))
        rmse = scale * np.sqrt(np.sum(ww * (rr / scale) ** 2)) if scale > 0 else np.longdouble(0)
        mae = scale * np.sum(ww * np.abs(rr / scale)) if scale > 0 else np.longdouble(0)
        target_sd = _moments(y, w)[1]
        r_squared = _finite(1 - (rmse / target_sd) ** 2) if target_sd > 0 else None
    return {"fitRmse": _finite(rmse), "fitMae": _finite(mae), "fitRSquared": r_squared}


def _config(config: dict) -> dict:
    out = {"algorithm": "ridge", "intercept": True, "standardize": True, "lambdaValue": 0.1,
           "l1Ratio": 0.5, "selection": "manual", "cv": None, "tolerance": 1e-8, "maxIterations": 10000, **copy.deepcopy(config)}
    if out["algorithm"] not in ("ridge", "lasso", "elasticnet") or out["selection"] not in ("manual", "cv"):
        _fail("RR_CONFIG_INVALID", "正則化回帰の設定が不正です。")
    for key in ("lambdaValue", "tolerance"):
        value = out[key]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or value <= 0:
            _fail("RR_CONFIG_INVALID", "lambdaと許容誤差は有限の正数が必要です。lambda=0には通常の回帰を使用してください。", field=key)
    if type(out["intercept"]) is not bool or type(out["standardize"]) is not bool:
        _fail("RR_CONFIG_INVALID", "interceptとstandardizeは真偽値が必要です。")
    if type(out["maxIterations"]) is not int or not 100 <= out["maxIterations"] <= 100000:
        _fail("RR_CONFIG_INVALID", "maxIterationsは100から100000の整数が必要です。")
    if isinstance(out["l1Ratio"], bool) or not isinstance(out["l1Ratio"], (float, int)) or not 0 < out["l1Ratio"] < 1:
        _fail("RR_CONFIG_INVALID", "Elastic Netのl1Ratioは0より大きく1より小さくしてください。")
    if out.get("interactions") or out.get("targetScale") is not None:
        _fail("RR_CONFIG_INVALID", "交互作用および目的変数の標準化には対応していません。")
    if out["selection"] == "manual" and out["cv"] is not None:
        _fail("RR_CONFIG_INVALID", "manualではcvを指定できません。")
    return out


def fit_regularized(frame: PreparedRegressionFrame, predictor_specs: list[dict], config: dict,
                    target_spec: dict | None = None) -> dict:
    """Fit a regularized model without changing the frame, specs, or request."""
    config = _config(config)
    w = _weights(frame)
    y = np.asarray(frame.target_values, dtype=np.float64)
    if len(y) == 0:
        _fail("RR_NO_EFFECTIVE_ROWS", "有効な学習行がありません。")
    if y.ndim != 1 or len(frame.row_ids) != len(y) or not np.isfinite(y).all():
        _fail("RR_INPUT_INVALID", "目的変数または学習行数が不正です。")
    descriptors = _input_descriptors(frame, predictor_specs)
    cv_audit = None
    if config["selection"] == "cv":
        config, cv_audit = _cross_validate(frame, descriptors, y, w, config)
    design = _build_design(frame, descriptors, np.arange(len(y)), w, config)
    solution = _solve(design["matrix"], y, w, config)
    fitted = _predict(design["matrix"], solution)
    with np.errstate(over="ignore", invalid="ignore"):
        residual = y - fitted
    if not np.isfinite(residual).all():
        _fail("RR_NUMERIC_RANGE", "残差がfloat64の表現範囲を超えました。")
    target = {"label": (target_spec or {}).get("label") or frame.target_name,
              "unit": (target_spec or {}).get("unit")}
    display = _display(design, solution, y, w, target, config)
    # Reference coding is presentation only; the fitted full one-hot model and
    # its original full coefficients are never reparameterized here.
    inputs_by_ref = {key: item for item in design["inputs"] for key in (item["columnId"], item["name"])}
    for predictor in predictor_specs:
        reference = predictor.get("referenceCategory")
        if predictor.get("kind") != "categorical" or reference is None:
            continue
        item = inputs_by_ref[predictor["columnId"]]
        if not isinstance(reference, str) or not any(level["kind"] == "value" and level["code"] == reference for level in item["observedCategories"]):
            _fail("RR_REFERENCE_INVALID", "表示の基準カテゴリは学習行で観測された値を指定してください。", columnId=item["columnId"])
        next(entry for entry in display["categoryReferences"] if entry["columnId"] == item["columnId"])["reference"] = {"code": reference, "kind": "value"}
    cv_portable = {k: copy.deepcopy(v) for k, v in cv_audit.items() if k != "assignments"} if cv_audit else None
    model = {
        "schemaVersion": SCHEMA_VERSION,
        "training": {"algorithm": config["algorithm"], "lambdaValue": config["lambdaValue"], "l1Ratio": _rho(config),
                     "libraryAlpha": solution["libraryAlpha"], "intercept": config["intercept"], "standardize": config["standardize"],
                     "weightNormalization": "sum_to_n", "objective": OBJECTIVE, "solver": solution["solver"],
                     "tolerance": config["tolerance"], "maxIterations": config["maxIterations"],
                     "convergence": solution["convergence"], "cv": cv_portable},
        "inputs": design["inputs"],
        "normalization": {"numericStrings": True, "categoricalCodes": "strings_or_safe_integers", "booleanInputs": "reject", "trimNumericStrings": True, "unicode": "preserve", "extraKeys": "ignore"},
        "preprocessing": {"numericMissing": "reject", "categoricalMissingPolicy": config.get("context", {}).get("missingPolicy", config.get("missingPolicy", "exclude")),
                          "imputation": "none", "inputScope": "current_dataset_values", "upstreamLeakageVerified": False},
        "features": design["features"],
        "linearModel": {"coefficients": solution["coefficients"].tolist(), "intercept": solution["intercept"], "targetOffset": 0, "targetScale": 1,
                        "dtype": "float64", "execution": "centered_ordered_sum"},
        "display": display,
        "domain": {"unknownCategory": "reject", "unobservedCategory": "reject", "extrapolation": "warn", "numericRange": "finite_float64"},
        "capabilities": {"pointPrediction": True, "intervals": False, "rawInput": False, "transformedInput": True},
    }
    notices = design["warnings"]
    if config["algorithm"] == "lasso":
        notices.append({"code": "RR_LASSO_COEFFICIENT_STABILITY", "message": "相関列やfull one-hotではLassoの係数解が一意でない場合があります。"})
    if cv_audit is not None:
        notices.append({"code": "RR_CV_SELECTION_SCORE", "message": "CV選択スコアは独立テスト精度ではありません。上流の変換・補完の漏洩防止は未確認です。"})
    if cv_audit is not None and cv_audit["summary"]["invalidCandidateCount"]:
        notices.append({"code": "RR_CV_INVALID_CANDIDATES", "message": "未収束または数値範囲エラーのCV候補を無効として除外しました。fold別の失敗理由を確認してください。", "invalidCandidateCount": cv_audit["summary"]["invalidCandidateCount"]})
    if frame.imputed_cell_count:
        notices.append({"code": "RR_UPSTREAM_IMPUTATION", "message": "現在の補完済み値を使用しています。上流の補完の漏洩防止は未確認です。", "imputedCellCount": frame.imputed_cell_count})
    if any(row["estimate"] is None for row in display["coefficients"]) or display["intercept"]["estimate"] is None:
        notices.append({"code": "RR_DISPLAY_NUMERIC_RANGE", "message": "元単位の表示値が表現範囲を超えました。保存済みの中心化モデルで予測します。"})
    summary = {"targetLabel": target["label"], "nDesignColumns": len(design["features"]),
               **_fit_metrics(y, residual, w, config["intercept"]),
               "lambdaValue": config["lambdaValue"], "l1Ratio": _rho(config), "algorithm": config["algorithm"],
               "convergence": solution["convergence"], "cv": cv_audit["summary"] if cv_audit else None}
    return {"model": model, "summary": summary,
            "details": {"coefficients": display["coefficients"], "intercept": display["intercept"], "categoryReferences": display["categoryReferences"], "cv": cv_audit},
            "fitted": fitted, "residual": residual, "warnings": notices}


def _cross_validate(frame: PreparedRegressionFrame, descriptors: list[dict], y: np.ndarray,
                    w: np.ndarray, config: dict) -> tuple[dict, dict]:
    """Explicit fold loop: split first, learn preprocessing only on training rows."""
    cv = config.get("cv")
    if not isinstance(cv, dict) or cv.get("independentRowsAcknowledged") is not True:
        _fail("RR_CV_INDEPENDENCE_REQUIRED", "ランダムCVには行の独立性の確認が必要です。")
    if frame.design_psu is not None or frame.design_strata is not None:
        _fail("RR_CV_GROUPED_UNSUPPORTED", "PSUまたは層別設計を持つデータにはランダム行CVを適用できません。")
    folds, seed = cv.get("folds", 5), cv.get("seed", 42)
    if type(folds) is not int or not 2 <= folds <= 20 or folds > len(y):
        _fail("RR_CV_FOLDS_INVALID", "CVのfold数は2〜20かつ有効行数以下で指定してください。", fitCount=len(y))
    if type(seed) is not int or not 0 <= seed <= 4294967295:
        _fail("RR_CV_CONFIG_INVALID", "CVのseedはuint32整数で指定してください。")
    lambdas = cv.get("lambdaValues")
    if not isinstance(lambdas, list) or not lambdas or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or v <= 0 for v in lambdas) or len(set(lambdas)) != len(lambdas):
        _fail("RR_CV_CONFIG_INVALID", "CVのlambda候補には重複のない有限の正数が必要です。")
    ratios = cv.get("l1Ratios", [config["l1Ratio"]]) if config["algorithm"] == "elasticnet" else [_rho(config)]
    if config["algorithm"] == "elasticnet" and (not isinstance(ratios, list) or not ratios or any(isinstance(v, bool) or not isinstance(v, (float, int)) or not .01 <= v < 1 for v in ratios) or len(set(ratios)) != len(ratios)):
        _fail("RR_CV_CONFIG_INVALID", "Elastic NetのCV候補l1Ratioは0.01以上1未満の重複のない値が必要です。")
    if len(lambdas) > 100 or len(ratios) > 20:
        _fail("RR_CV_CONFIG_INVALID", "CV候補はlambdaが100件以下、l1Ratioが20件以下にしてください。")
    # One immutable assignment is reused for every candidate and final audit.
    splits = list(KFold(n_splits=folds, shuffle=True, random_state=seed).split(np.arange(len(y))))
    assignment = [-1] * len(y)
    for fold, (_, validation) in enumerate(splits):
        for position in validation:
            assignment[int(position)] = fold
    assignment_data = {"rowUnit": "prepared_dataset_row", "seed": seed, "folds": folds,
                       "assignments": [[rid, fold] for rid, fold in zip(frame.row_ids, assignment)]}
    fingerprint = hashlib.sha256(json.dumps(assignment_data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    audit: dict[str, Any] = {
        "splitMethod": "shuffled_kfold", "rowUnit": "prepared_dataset_row", "folds": folds, "seed": seed,
        "independentRowsAcknowledged": True, "assignmentFingerprint": fingerprint,
        "assignments": [{"rowId": rid, "fold": fold} for rid, fold in zip(frame.row_ids, assignment)],
        "scoring": "pooled_weighted_mse", "scoreDefinition": "sum(validationWeightedSse)/sum(validationWeight)",
        "weightNormalization": "sum_to_n_per_training_fold", "preprocessingScope": "training_fold_only",
        "upstreamLeakageVerified": False, "lambdaValues": list(lambdas), "l1Ratios": list(ratios),
        "tolerance": config["tolerance"], "maxIterations": config["maxIterations"],
        "foldAudits": [], "candidates": [],
    }
    prepared = []
    for fold, (train, validation) in enumerate(splits):
        design = _build_design(frame, descriptors, train, w[train], config)
        train_weight = _finite(np.sum(w[train].astype(np.longdouble)))
        validation_weight = _finite(np.sum(w[validation].astype(np.longdouble)))
        if train_weight is None or validation_weight is None:
            _fail("RR_CV_NUMERIC_RANGE", "CVの重み合計をfloat64で保存できません。", fold=fold)
        fold_audit = {"fold": fold, "trainCount": len(train), "validationCount": len(validation),
                      "trainWeight": train_weight, "validationWeight": validation_weight,
                      "normalizedTrainWeight": float(len(train)),
                      "features": copy.deepcopy(design["features"]),
                      "observedCategories": [{"columnId": item["columnId"], "levels": copy.deepcopy(item["observedCategories"])} for item in design["inputs"] if item["kind"] == "categorical"],
                      "warnings": copy.deepcopy(design["warnings"])}
        audit["foldAudits"].append(fold_audit)
        try:
            validation_matrix = _transform(frame, design, validation)
        except BizError as exc:
            raise BizError(exc.code, exc.message, status_code=422,
                           details={**exc.details, "fold": fold, "assignmentFingerprint": fingerprint, "foldAudit": fold_audit}) from exc
        prepared.append((train, validation, design, validation_matrix))
    best = None
    for lambda_value, ratio in itertools_product(lambdas, ratios):
        candidate_config = {**config, "lambdaValue": lambda_value,
                            "l1Ratio": ratio if config["algorithm"] == "elasticnet" else config["l1Ratio"]}
        candidate = {"lambdaValue": lambda_value, "l1Ratio": ratio, "valid": True,
                     "folds": [], "weightedMse": None, "rmse": None, "failureCount": 0}
        sse_total, weight_total = np.longdouble(0), np.longdouble(0)
        for fold, (train, validation, design, validation_matrix) in enumerate(prepared):
            record = {"fold": fold, "trainCount": len(train), "validationCount": len(validation),
                      "validationWeight": audit["foldAudits"][fold]["validationWeight"],
                      "libraryAlpha": _finite(np.longdouble(len(train)) * lambda_value) if config["algorithm"] == "ridge" else lambda_value,
                      "weightedSse": None, "failedPredictions": 0, "convergence": None, "failure": None}
            try:
                solution = _solve(design["matrix"], y[train], w[train], candidate_config)
                predicted = _predict(validation_matrix, solution)
                errors = y[validation].astype(np.longdouble) - predicted.astype(np.longdouble)
                sse = np.sum(w[validation].astype(np.longdouble) * errors**2)
                if sse == 0 and np.any(errors != 0):
                    _fail("RR_CV_NUMERIC_RANGE", "検証foldの加重SSEが数値表現範囲を下回りました。")
                recorded_sse = _finite(sse)
                if recorded_sse is None:
                    _fail("RR_CV_NUMERIC_RANGE", "検証foldの加重SSEをfloat64で保存できません。")
                record["weightedSse"] = recorded_sse
                record["convergence"] = solution["convergence"]
                sse_total += sse
                weight_total += np.sum(w[validation].astype(np.longdouble))
            except BizError as exc:
                if exc.code not in ("RR_NONCONVERGENCE", "RR_NUMERIC_RANGE", "RR_CV_NUMERIC_RANGE"):
                    raise
                candidate["valid"] = False
                candidate["failureCount"] += 1
                record["failedPredictions"] = len(validation)
                record["failure"] = {"code": exc.code, "message": exc.message, "details": exc.details}
                record["convergence"] = {"converged": False, "iterations": exc.details.get("iterations"), "dualGap": None}
            candidate["folds"].append(record)
        if candidate["valid"]:
            score = _finite(sse_total / weight_total)
            if score is None:
                candidate["valid"] = False
            else:
                candidate["weightedMse"] = score
                candidate["rmse"] = math.sqrt(score)
                # Stable request-grid order breaks ties; preserve it in audit.
                if best is None or score < best["weightedMse"]:
                    best = candidate
        audit["candidates"].append(candidate)
    if best is None:
        _fail("RR_CV_NO_VALID_CANDIDATE", "全foldで収束し有限の予測が得られるCV候補がありません。", cv=audit)
    audit["summary"] = {"folds": folds, "seed": seed, "assignmentFingerprint": fingerprint,
                        "scoring": "pooled_weighted_mse", "bestLambdaValue": best["lambdaValue"], "bestL1Ratio": best["l1Ratio"],
                        "weightedMse": best["weightedMse"], "rmse": best["rmse"],
                        "candidateCount": len(audit["candidates"]), "invalidCandidateCount": sum(not c["valid"] for c in audit["candidates"])}
    chosen = {**config, "lambdaValue": best["lambdaValue"]}
    if config["algorithm"] == "elasticnet":
        chosen["l1Ratio"] = best["l1Ratio"]
    return chosen, audit


def itertools_product(first: list, second: list):
    """Keep candidate traversal explicit and stable in the request's order."""
    for a in first:
        for b in second:
            yield a, b
