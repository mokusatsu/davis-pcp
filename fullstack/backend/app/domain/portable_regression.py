"""Frozen, dependency-free regularized-regression prediction runtime (version 1).

This file is also the complete exported Python runtime. It never imports the
application, a training library, a dataset or a codebook. Numbers use binary64
and evaluation deliberately follows feature order, without dot products/FMA.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import struct

SCHEMA_VERSION = "davis.regularized-regression/1"
ALGORITHM_VERSION = "davis.regularized_regression.1.0.0"
SAFE_INTEGER = 9007199254740991
# ASCII only: Python's \\d / strip and JavaScript's equivalents differ on Unicode.
DECIMAL_PATTERN = r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$"
NUMERIC_WHITESPACE = " \t\n\r\v\f"
NORMALIZATION = {"numericStrings": True, "categoricalCodes": "strings_or_safe_integers",
                 "booleanInputs": "reject", "trimNumericStrings": True,
                 "unicode": "preserve", "extraKeys": "ignore"}


def _enum(*values):
    return ["enum", list(values)]


def _nullable(rule):
    return ["nullable", rule]


def _list(rule):
    return ["list", rule]


CATEGORY_RULE = {"code": _nullable("string"), "kind": _enum("value", "missing", "not_applicable")}
LEVEL_RULE = {**CATEGORY_RULE, "label": "string"}
CONVERGENCE_RULE = {"converged": "boolean", "iterations": _nullable("nonnegative_integer"),
                    "dualGap": _nullable("number")}
# These rules are JSON data and are included verbatim in the JS/TS export.
MODEL_RULE = {
    "schemaVersion": _enum(SCHEMA_VERSION),
    "identity": {"modelId": "nonempty_string", "modelVersion": _enum("1"),
                 "algorithmVersion": _enum(ALGORITHM_VERSION), "exporterVersion": _enum("1"),
                 "runtimeVersion": _enum("1"), "createdAt": "nonempty_string", "contentHash": "string"},
    "provenance": {"revisions": {"dataRevision": "nonnegative_integer", "schemaRevision": "nonnegative_integer", "maskRevision": _nullable("nonnegative_integer")},
                   "scopeFingerprint": "string", "fitCount": "positive_integer",
                   "libraryVersions": {"python": "string", "numpy": "string", "sklearn": "string"}},
    "training": {"algorithm": _enum("ridge", "lasso", "elasticnet"), "lambdaValue": "positive",
                 "l1Ratio": "number", "libraryAlpha": "positive", "intercept": "boolean",
                 "standardize": "boolean", "weightNormalization": _enum("sum_to_n"),
                 "objective": "nonempty_string", "solver": "nonempty_string", "tolerance": "positive",
                 "maxIterations": "positive_integer", "convergence": CONVERGENCE_RULE,
                 "cv": _nullable("json_object")},
    "inputs": _list({"columnId": "nonempty_string", "key": "string", "name": "string", "label": "string",
                     "kind": _enum("numeric", "ordinal", "categorical"), "unit": _nullable("string"),
                     "missingCodes": _list("string"), "notApplicableCodes": _list("string"),
                     "declaredCategories": _nullable(_list("string")), "observedCategories": _list(LEVEL_RULE),
                     "ordinalOrder": _list("string"), "ordinalReversed": "boolean",
                     "trainingMin": _nullable("number"), "trainingMax": _nullable("number")}),
    "normalization": {key: _enum(value) for key, value in NORMALIZATION.items()},
    "preprocessing": {"numericMissing": _enum("reject"), "categoricalMissingPolicy": _enum("exclude", "include_missing", "separate_not_applicable"),
                      "imputation": _enum("none"), "inputScope": _enum("current_dataset_values"), "upstreamLeakageVerified": _enum(False)},
    "features": _list({"designColumnId": "nonempty_string", "inputColumnId": "nonempty_string",
                       "operation": _enum("identity", "ordered_rank", "one_hot"), "category": _nullable(CATEGORY_RULE),
                       "offset": "number", "scale": "positive", "constant": "boolean"}),
    "linearModel": {"coefficients": _list("number"), "intercept": "number", "targetOffset": "number",
                    "targetScale": "positive", "dtype": _enum("float64"), "execution": _enum("centered_ordered_sum")},
    "display": {"coefficients": _list({"designColumnId": "nonempty_string", "columnId": "nonempty_string",
                    "label": "string", "kind": _enum("numeric", "ordinal", "categorical"), "category": _nullable(CATEGORY_RULE),
                    "estimate": _nullable("number"), "estimateReason": _nullable("string"),
                    "standardizedEstimate": _nullable("number"), "standardizedReason": _nullable("string"),
                    "comparisonSd": _nullable("nonnegative"), "exactZero": "boolean", "unit": "string"}),
                "intercept": {"estimate": _nullable("number"), "reason": _nullable("string")},
                "targetSd": _nullable("nonnegative"), "targetLabel": "string", "targetUnit": _nullable("string"),
                "categoryReferences": _list({"columnId": "nonempty_string", "reference": CATEGORY_RULE, "levels": _list(LEVEL_RULE)})},
    "domain": {"unknownCategory": _enum("reject"), "unobservedCategory": _enum("reject"), "extrapolation": _enum("warn"), "numericRange": _enum("finite_float64")},
    "capabilities": {"pointPrediction": _enum(True), "intervals": _enum(False), "rawInput": _enum(False), "transformedInput": _enum(True)},
}


# Strict portable CV audit: row assignments and fit records are intentionally absent.
# Optional failure detail keys are structural scalar diagnostics only.
CV_FAILURE_DETAILS_RULE = ["optional_object", {
    "iterations": "nonnegative_integer", "solver": _enum("svd", "coordinate_descent_cyclic"),
    "reason": _enum("ValueError", "FloatingPointError", "OverflowError", "LinAlgError"),
    "field": _enum("weights", "moments", "standardDeviation", "mean", "prediction"),
    "columnId": "nonempty_string", "failedPredictions": "nonnegative_integer",
}]
CV_FOLD_RULE = {"fold": "nonnegative_integer", "trainCount": "positive_integer", "validationCount": "positive_integer",
                "validationWeight": "positive", "libraryAlpha": _nullable("positive"),
                "weightedSse": _nullable("nonnegative"), "failedPredictions": "nonnegative_integer",
                "convergence": _nullable(CONVERGENCE_RULE), "failure": _nullable({
                    "code": _enum("RR_NONCONVERGENCE", "RR_NUMERIC_RANGE", "RR_CV_NUMERIC_RANGE"),
                    "message": "string", "details": CV_FAILURE_DETAILS_RULE})}
CV_RULE = {
    "splitMethod": _enum("shuffled_kfold"), "rowUnit": _enum("prepared_dataset_row"),
    "folds": "positive_integer", "seed": "nonnegative_integer", "independentRowsAcknowledged": _enum(True),
    "assignmentFingerprint": "nonempty_string", "scoring": _enum("pooled_weighted_mse"),
    "scoreDefinition": _enum("sum(validationWeightedSse)/sum(validationWeight)"),
    "weightNormalization": _enum("sum_to_n_per_training_fold"), "preprocessingScope": _enum("training_fold_only"),
    "upstreamLeakageVerified": _enum(False), "lambdaValues": _list("positive"), "l1Ratios": _list("number"),
    "tolerance": "positive", "maxIterations": "positive_integer",
    "foldAudits": _list({"fold": "nonnegative_integer", "trainCount": "positive_integer", "validationCount": "positive_integer",
                         "trainWeight": "positive", "validationWeight": "positive", "normalizedTrainWeight": "positive",
                         "features": MODEL_RULE["features"],
                         "observedCategories": _list({"columnId": "nonempty_string", "levels": _list(LEVEL_RULE)}),
                         "warnings": _list({"code": _enum("RR_TINY_VARIANCE", "RR_CONSTANT_FEATURE"), "message": "string", "columnId": "nonempty_string"})}),
    "candidates": _list({"lambdaValue": "positive", "l1Ratio": "number", "valid": "boolean", "folds": _list(CV_FOLD_RULE),
                         "weightedMse": _nullable("nonnegative"), "rmse": _nullable("nonnegative"), "failureCount": "nonnegative_integer"}),
    "summary": {"folds": "positive_integer", "seed": "nonnegative_integer", "assignmentFingerprint": "nonempty_string",
                "scoring": _enum("pooled_weighted_mse"), "bestLambdaValue": "positive", "bestL1Ratio": "number",
                "weightedMse": "nonnegative", "rmse": "nonnegative", "candidateCount": "positive_integer", "invalidCandidateCount": "nonnegative_integer"},
}
MODEL_RULE["training"]["cv"] = _nullable(CV_RULE)


def _fail(path, message):
    raise ValueError(f"Invalid portable model at {path}: {message}")


def _finite(value):
    if type(value) not in (int, float):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _json_value(value, path="model", seen=None):
    """Reject non-JSON objects, nonfinite values and ill-formed Unicode."""
    if value is None or type(value) is bool:
        return
    if type(value) is str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            _fail(path, "unpaired Unicode surrogate")
        return
    if type(value) in (int, float):
        if not _finite(value):
            _fail(path, "number must be finite float64")
        return
    if type(value) in (list, dict):
        seen = set() if seen is None else seen
        if id(value) in seen:
            _fail(path, "circular data is not JSON")
        seen.add(id(value))
    if type(value) is list:
        for i, item in enumerate(value):
            _json_value(item, f"{path}[{i}]", seen)
        seen.remove(id(value))
        return
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                _fail(path, "object keys must be strings")
            _json_value(key, path, seen)
            _json_value(item, f"{path}.{key}", seen)
        seen.remove(id(value))
        return
    _fail(path, "expected JSON data")


def _check(value, rule, path="model"):
    if type(rule) is dict:
        if type(value) is not dict or set(value) != set(rule):
            _fail(path, "missing, extra or invalid object fields")
        for key, child_rule in rule.items():
            _check(value[key], child_rule, f"{path}.{key}")
    elif type(rule) is list:
        op, argument = rule
        if op == "nullable":
            if value is not None:
                _check(value, argument, path)
        elif op == "enum":
            if not any(type(value) is type(item) and value == item for item in argument):
                _fail(path, "unsupported value/version")
        elif op == "optional_object":
            if type(value) is not dict or not set(value).issubset(argument):
                _fail(path, "unexpected diagnostic fields")
            for key, item in value.items():
                _check(item, argument[key], f"{path}.{key}")
        elif op == "list":
            if type(value) is not list:
                _fail(path, "expected array")
            for i, item in enumerate(value):
                _check(item, argument, f"{path}[{i}]")
    else:
        ok = False
        if rule in ("string", "nonempty_string"):
            ok = type(value) is str and (rule == "string" or bool(value))
        elif rule == "boolean":
            ok = type(value) is bool
        elif rule == "json_object":
            ok = type(value) is dict
        elif rule in ("number", "positive", "nonnegative", "positive_integer", "nonnegative_integer"):
            ok = _finite(value)
            if ok and rule.startswith("positive"):
                ok = value > 0
            if ok and rule.startswith("nonnegative"):
                ok = value >= 0
            if ok and rule.endswith("integer"):
                ok = float(value).is_integer() and abs(value) <= SAFE_INTEGER
        if not ok:
            _fail(path, f"expected {rule}")


def _category_key(category):
    return category["kind"], category["code"]


def _valid_category(category, path):
    if (category["kind"] == "value") != (category["code"] is not None):
        _fail(path, "value needs a string code; missing kinds need null")


def _unique(values, path):
    if len(values) != len(set(values)):
        _fail(path, "duplicates are not allowed")


def _canonical_bytes(value):
    """Portable canonical encoding, NOT JSON text canonicalization.

    Null/bool: n/t/f. Number: d + 8 big-endian IEEE754 bytes (-0 => +0).
    String: s + UTF8 byte length + ':' + UTF8. Array: a + length + ':' +
    items. Object: o + length + ':' + key/value pairs sorted by Unicode
    scalar value (equivalently UTF8 bytes). Hash excludes contentHash only.
    """
    if value is None:
        return b"n"
    if type(value) is bool:
        return b"t" if value else b"f"
    if type(value) in (int, float):
        number = float(value)
        return b"d" + struct.pack(">d", 0.0 if number == 0 else number)
    if type(value) is str:
        data = value.encode("utf-8")
        return b"s" + str(len(data)).encode("ascii") + b":" + data
    if type(value) is list:
        return b"a" + str(len(value)).encode("ascii") + b":" + b"".join(_canonical_bytes(v) for v in value)
    keys = sorted(value)
    return b"o" + str(len(keys)).encode("ascii") + b":" + b"".join(_canonical_bytes(k) + _canonical_bytes(value[k]) for k in keys)


def _content_hash(model):
    unhashed = dict(model)
    unhashed["identity"] = {k: v for k, v in model["identity"].items() if k != "contentHash"}
    return "sha256:" + hashlib.sha256(_canonical_bytes(unhashed)).hexdigest()


def validate_model(model: dict, verify_hash: bool = True) -> None:
    """Reject malformed, unsupported, inconsistent or tampered model data."""
    _json_value(model)
    _check(model, MODEL_RULE)
    training = model["training"]
    rho = training["l1Ratio"]
    if ((training["algorithm"] == "ridge" and rho != 0) or
        (training["algorithm"] == "lasso" and rho != 1) or
        (training["algorithm"] == "elasticnet" and not 0 < rho < 1)):
        _fail("training.l1Ratio", "algorithm and ratio disagree")
    if not training["convergence"]["converged"]:
        _fail("training.convergence", "unconverged models cannot predict")
    inputs = model["inputs"]
    _unique([v["columnId"] for v in inputs], "inputs.columnId")
    # Duplicate names are supported only through an explicit unambiguous mapping.
    by_id = {v["columnId"]: v for v in inputs}
    for spec in inputs:
        path = "inputs." + spec["columnId"]
        for field in ("missingCodes", "notApplicableCodes", "ordinalOrder"):
            _unique(spec[field], path + "." + field)
        if not set(spec["notApplicableCodes"]).issubset(spec["missingCodes"]):
            _fail(path, "not-applicable codes must be a subset of missing codes")
        if spec["declaredCategories"] is not None:
            _unique(spec["declaredCategories"], path + ".declaredCategories")
        levels = spec["observedCategories"]
        _unique([_category_key(c) for c in levels], path + ".observedCategories")
        for category in levels:
            _valid_category(category, path)
            if category["kind"] == "value" and category["code"] in spec["missingCodes"] + spec["notApplicableCodes"]:
                _fail(path, "a missing code cannot be an observed value")
        if spec["kind"] == "ordinal" and not spec["ordinalOrder"]:
            _fail(path, "ordinal input requires frozen order")
        if spec["kind"] != "ordinal" and (spec["ordinalOrder"] or spec["ordinalReversed"]):
            _fail(path, "only ordinal inputs can have an order/reversal")
        if (spec["trainingMin"] is None) != (spec["trainingMax"] is None):
            _fail(path, "range endpoints must both be present or null")
        if spec["trainingMin"] is not None and spec["trainingMin"] > spec["trainingMax"]:
            _fail(path, "reversed range")
    features = model["features"]
    coefficients = model["linearModel"]["coefficients"]
    if len(features) != len(coefficients) or len(features) != len(model["display"]["coefficients"]):
        _fail("features", "feature, coefficient and display lengths disagree")
    _unique([f["designColumnId"] for f in features], "features.designColumnId")
    used = {key: [] for key in by_id}
    for i, feature in enumerate(features):
        path = f"features[{i}]"
        spec = by_id.get(feature["inputColumnId"])
        if spec is None:
            _fail(path, "unknown inputColumnId")
        expected = {"numeric": "identity", "ordinal": "ordered_rank", "categorical": "one_hot"}[spec["kind"]]
        if feature["operation"] != expected:
            _fail(path, "operation does not match input kind")
        category = feature["category"]
        if expected == "one_hot":
            if category is None:
                _fail(path, "one_hot requires category")
            _valid_category(category, path)
            if _category_key(category) not in [_category_key(c) for c in spec["observedCategories"]]:
                _fail(path, "one_hot must refer to an observed category")
        elif category is not None:
            _fail(path, "noncategorical feature cannot have a category")
        if not training["intercept"] and feature["offset"] != 0:
            _fail(path, "no-intercept model cannot center features")
        used[spec["columnId"]].append(feature)
        display = model["display"]["coefficients"][i]
        if (display["designColumnId"] != feature["designColumnId"] or display["columnId"] != spec["columnId"] or
            display["kind"] != spec["kind"] or display["category"] != category or
            display["exactZero"] != (coefficients[i] == 0)):
            _fail("display.coefficients", "display identity disagrees with execution")
        for field, reason in (("estimate", "estimateReason"), ("standardizedEstimate", "standardizedReason")):
            if display[field] is None and not display[reason]:
                _fail("display.coefficients", "null estimates require a reason")
    for key, spec in by_id.items():
        if spec["kind"] == "categorical":
            actual = [_category_key(f["category"]) for f in used[key]]
            expected = [_category_key(c) for c in spec["observedCategories"]]
            if len(actual) != len(set(actual)) or set(actual) != set(expected) or not expected:
                _fail("features", "categorical input requires exactly the full observed one-hot basis")
        elif len(used[key]) != 1:
            _fail("features", "numeric/ordinal input requires exactly one feature")
    display = model["display"]
    if display["intercept"]["estimate"] is None and not display["intercept"]["reason"]:
        _fail("display.intercept", "null estimate requires a reason")
    references = display["categoryReferences"]
    _unique([r["columnId"] for r in references], "display.categoryReferences")
    for reference in references:
        spec = by_id.get(reference["columnId"])
        if spec is None or spec["kind"] != "categorical":
            _fail("display.categoryReferences", "reference must name a categorical input")
        if reference["levels"] != spec["observedCategories"] or _category_key(reference["reference"]) not in [_category_key(c) for c in reference["levels"]]:
            _fail("display.categoryReferences", "reference levels disagree with frozen input")
    if verify_hash and (not re.fullmatch(r"sha256:[0-9a-f]{64}", model["identity"]["contentHash"]) or
                        model["identity"]["contentHash"] != _content_hash(model)):
        _fail("identity.contentHash", "integrity check failed")


def seal_model(model: dict) -> dict:
    """Return a validated, independent sealed copy; never mutate its argument."""
    _json_value(model)
    sealed = copy.deepcopy(model)
    if type(sealed) is dict and type(sealed.get("identity")) is dict:
        sealed["identity"]["contentHash"] = ""
    validate_model(sealed, verify_hash=False)
    sealed["identity"]["contentHash"] = _content_hash(sealed)
    return sealed


def _mapping(model, column_mapping):
    if column_mapping is None:
        column_mapping = {}
    if type(column_mapping) is not dict:
        raise ValueError("column_mapping must map input columnId to record key")
    _json_value(column_mapping, "column_mapping")
    ids = {spec["columnId"] for spec in model["inputs"]}
    if any(type(key) is not str or key not in ids or type(value) is not str for key, value in column_mapping.items()):
        raise ValueError("column_mapping contains unknown columnId or non-string key")
    mapping = {spec["columnId"]: column_mapping.get(spec["columnId"], spec["key"]) for spec in model["inputs"]}
    if len(set(mapping.values())) != len(mapping):
        raise ValueError("column_mapping reuses an input key; explicitly map each input to a distinct key")
    return mapping


def _result(model, status, warnings, prediction=None):
    return {"prediction": prediction, "status": status, "warnings": warnings, "modelVersion": model["identity"]["modelVersion"]}


def _code(value):
    if type(value) is str:
        try:
            value.encode("utf-8")
        except UnicodeEncodeError:
            return None
        return value
    if _finite(value) and float(value).is_integer() and abs(value) <= SAFE_INTEGER:
        return str(int(value))
    return None


def normalize_numeric_input(raw, missing_codes):
    """Shared finite-float64 numeric parsing and frozen sentinel normalization.

    Numeric codes are compared by finite binary64 value, so 99, 99.0,
    '99.0' and '9.9e1' consistently denote the same continuous sentinel.
    """
    if raw is None:
        return None, "missing_value"
    if type(raw) is str:
        raw = raw.strip(NUMERIC_WHITESPACE)
        if not raw or raw in missing_codes:
            return None, "missing_value"
        if not re.fullmatch(DECIMAL_PATTERN, raw):
            return None, "invalid_type"
        try:
            value = float(raw)
        except (ValueError, OverflowError):
            return None, "numeric_range"
        if value == 0 and re.search(r"[1-9]", re.split(r"[eE]", raw, maxsplit=1)[0]):
            return None, "numeric_range"
    elif type(raw) in (int, float):
        try:
            value = float(raw)
        except (ValueError, OverflowError):
            return None, "numeric_range"
    else:
        return None, "invalid_type"
    if not math.isfinite(value):
        return None, "numeric_range"
    # Continuous sentinels use numeric equality, including fractional/huge
    # values. Categorical safe-integer restrictions do not apply here.
    for sentinel in missing_codes:
        text = sentinel.strip(NUMERIC_WHITESPACE)
        if re.fullmatch(DECIMAL_PATTERN, text):
            missing = float(text)
            underflow = missing == 0 and re.search(r"[1-9]", re.split(r"[eE]", text, maxsplit=1)[0])
            if math.isfinite(missing) and not underflow and value == missing:
                return None, "missing_value"
    return value, None


def _normalize(spec, raw, policy):
    """Return (normalized value, error status); missing stays a typed level."""
    if spec["kind"] == "numeric":
        return normalize_numeric_input(raw, spec["missingCodes"])
    code = _code(raw) if raw is not None else None
    if raw is not None and code is None:
        return None, "invalid_type"
    kind = "value"
    if code in spec["notApplicableCodes"]:
        kind = "not_applicable"
    elif raw is None or code in spec["missingCodes"]:
        kind = "missing"
    if kind != "value":
        if spec["kind"] == "ordinal" or policy == "exclude":
            return None, "missing_value"
        if policy == "include_missing":
            kind = "missing"
        code = None
    if spec["kind"] == "ordinal":
        if code not in spec["ordinalOrder"]:
            declared = spec["declaredCategories"]
            return None, "unobserved_category" if declared is not None and code in declared else "unknown_category"
        rank = spec["ordinalOrder"].index(code) + 1
        return float(len(spec["ordinalOrder"]) + 1 - rank if spec["ordinalReversed"] else rank), None
    level = (kind, code)
    if level not in [_category_key(c) for c in spec["observedCategories"]]:
        declared = spec["declaredCategories"]
        if kind != "value" or (declared is not None and code in declared):
            return None, "unobserved_category"
        return None, "unknown_category"
    return level, None


def _predict_validated(model, record, mapping):
    warnings = []
    if type(record) is not dict:
        return _result(model, "invalid_type", warnings)
    values = {}
    policy = model["preprocessing"]["categoricalMissingPolicy"]
    for spec in model["inputs"]:
        cid = spec["columnId"]
        key = mapping[cid]
        if key not in record:
            return _result(model, "missing_field", warnings + [{"code": "missing_field", "columnId": cid}])
        value, error = _normalize(spec, record[key], policy)
        if error:
            return _result(model, error, warnings + [{"code": error, "columnId": cid}])
        values[cid] = value
        if spec["kind"] != "categorical" and spec["trainingMin"] is not None and not spec["trainingMin"] <= value <= spec["trainingMax"]:
            warnings.append({"code": "extrapolation", "columnId": cid})
    lm = model["linearModel"]
    total = float(lm["intercept"])
    for feature, coefficient in zip(model["features"], lm["coefficients"]):
        value = values[feature["inputColumnId"]]
        if feature["operation"] == "one_hot":
            value = 1.0 if value == _category_key(feature["category"]) else 0.0
        # Separate primitive operations intentionally match JS binary64 order.
        centered = value - float(feature["offset"])
        scaled = centered / float(feature["scale"])
        term = float(coefficient) * scaled
        total = total + term
        underflow = (centered != 0 and scaled == 0) or (coefficient != 0 and scaled != 0 and term == 0)
        if underflow or not all(math.isfinite(v) for v in (centered, scaled, term, total)):
            return _result(model, "numeric_range", warnings + [{"code": "numeric_range", "columnId": feature["inputColumnId"]}])
    transformed = float(lm["targetScale"]) * total
    prediction = float(lm["targetOffset"]) + transformed
    if (total != 0 and transformed == 0) or not math.isfinite(transformed) or not math.isfinite(prediction):
        return _result(model, "numeric_range", warnings + [{"code": "numeric_range"}])
    return _result(model, "ok", warnings, 0.0 if prediction == 0 else prediction)


def predict_record(model: dict, record: dict, column_mapping: dict | None = None) -> dict:
    validate_model(model)
    return _predict_validated(model, record, _mapping(model, column_mapping))


def predict_batch(model: dict, records: list, column_mapping: dict | None = None) -> list[dict]:
    validate_model(model)
    mapping = _mapping(model, column_mapping)
    if type(records) is not list:
        raise ValueError("records must be a JSON array")
    return [_predict_validated(model, record, mapping) for record in records]
