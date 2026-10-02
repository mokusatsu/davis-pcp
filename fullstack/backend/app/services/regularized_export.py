"""Readable, offline Predict artifacts for an exact persisted portable model."""
from __future__ import annotations

import base64
import copy
import io
import json
from pathlib import Path
import zipfile

from app.domain import portable_regression as runtime

_LANGUAGES = {"python": ("predict.py", "text/x-python"), "javascript": ("predict.mjs", "text/javascript"),
              "typescript": ("predict.ts", "text/typescript")}
_ARTIFACTS = {"model", "code", "schema", "readme", "test_vectors", "bundle"}


def _json(value):
    # Python's shortest round-trip rendering preserves every finite binary64.
    return json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2) + "\n"


def _python_source(mapping):
    source = Path(runtime.__file__).read_text(encoding="utf-8")
    # Mapping is parsed as inert JSON, never used to construct Python identifiers.
    default = "DEFAULT_COLUMN_MAPPING = json.loads(" + repr(_json(mapping)) + ")\n\n"
    source = source.replace("def predict_record(model: dict, record: dict, column_mapping: dict | None = None)", default + "def predict_record(model: dict, record: dict, column_mapping: dict | None = DEFAULT_COLUMN_MAPPING)")
    source = source.replace("def predict_batch(model: dict, records: list, column_mapping: dict | None = None)", "def predict_batch(model: dict, records: list, column_mapping: dict | None = DEFAULT_COLUMN_MAPPING)")
    source += '''
# The reusable functions above take an explicit mapping. CLI uses the exported map.
if __name__ == "__main__":
    import argparse
    import pathlib
    parser = argparse.ArgumentParser(description="Offline frozen-model point prediction")
    parser.add_argument("records", help="JSON array of records (target is optional)")
    parser.add_argument("--model", default=str(pathlib.Path(__file__).with_name("model.json")))
    args = parser.parse_args()
    with open(args.model, encoding="utf-8") as handle:
        frozen_model = json.load(handle)
    with open(args.records, encoding="utf-8") as handle:
        records = json.load(handle)
    print(json.dumps(predict_batch(frozen_model, records, DEFAULT_COLUMN_MAPPING),
                     ensure_ascii=False, allow_nan=False, indent=2))
'''
    return source


def _javascript_source(mapping, template="predict.js"):
    source = (Path(__file__).parent / "regularized_templates" / template).read_text(encoding="utf-8")
    # Escape line separators for older parsers; these remain JSON strings, not code.
    def data(value):
        return json.dumps(value, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
    return source.replace("/*__MODEL_RULE__*/", data(runtime.MODEL_RULE)).replace("/*__COLUMN_MAPPING__*/", "JSON.parse(" + json.dumps(data(mapping)) + ")")


def _typescript_source(mapping):
    """Strict-typechecked companion with the identical numerical implementation."""
    return _javascript_source(mapping, "predict.ts")


def _input_schema(model, mapping):
    properties = {}
    policy = model["preprocessing"]["categoricalMissingPolicy"]
    for spec in model["inputs"]:
        key = mapping[spec["columnId"]]
        description = "Frozen current-dataset value. No imputation or upstream transformation is performed."
        if spec["kind"] == "numeric":
            rule = {"anyOf": [{"type": "number"}, {"type": "string", "pattern": r"^[ \t\n\r\v\f]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\n\r\v\f]*$"}],
                    "description": description + " Finite float64 only; numeric strings use ASCII decimal/exponent syntax and ASCII whitespace. Missing codes and empty strings are rejected."}
        else:
            codes = spec["ordinalOrder"] if spec["kind"] == "ordinal" else [c["code"] for c in spec["observedCategories"] if c["kind"] == "value"]
            variants = [{"type": "string", "enum": codes}, {"type": "integer", "minimum": -runtime.SAFE_INTEGER, "maximum": runtime.SAFE_INTEGER}]
            if spec["kind"] == "categorical" and policy != "exclude":
                if any(c["kind"] == "missing" for c in spec["observedCategories"]):
                    variants.append({"type": "null"})
                accepted_missing = []
                for value in spec["missingCodes"] + spec["notApplicableCodes"]:
                    _, error = runtime._normalize(spec, value, policy)
                    if error is None:
                        accepted_missing.append(value)
                if accepted_missing:
                    variants.append({"type": "string", "enum": accepted_missing})
            rule = {"anyOf": variants, "description": description + " Integer codes must match an observed code after base-10 conversion. Unsafe integers require strings. Strings preserve leading zeros and whitespace; booleans are rejected."}
        rule.update({"title": spec["label"], "x-columnId": spec["columnId"], "x-kind": spec["kind"],
                     "x-missingCodes": spec["missingCodes"], "x-notApplicableCodes": spec["notApplicableCodes"],
                     "x-declaredCategories": spec["declaredCategories"], "x-observedCategories": spec["observedCategories"],
                     "x-ordinalOrder": spec["ordinalOrder"], "x-ordinalReversed": spec["ordinalReversed"],
                     "x-trainingMin": spec["trainingMin"], "x-trainingMax": spec["trainingMax"]})
        properties[key] = rule
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "DAVIS frozen-model prediction record",
            "type": "object", "properties": properties, "required": list(properties), "additionalProperties": True,
            "description": "Record input only. Target is not required. The runtime enforces finite binary64, missing-code and observed-category constraints in addition to this descriptive schema.",
            "x-modelIdentity": copy.deepcopy(model["identity"]), "x-columnMapping": mapping,
            "x-normalization": copy.deepcopy(model["normalization"]), "x-preprocessing": copy.deepcopy(model["preprocessing"])}


def _synthetic_vectors(model, mapping):
    """Construct examples from frozen schema/ranges only, never training rows."""
    base = {}
    for spec in model["inputs"]:
        if spec["kind"] == "numeric":
            low, high = spec["trainingMin"], spec["trainingMax"]
            value = 0.0 if low is None else low / 2.0 + high / 2.0
            # Decimal string handles integer-sized values without code ambiguity.
            value = format(value, ".17g")
        elif spec["kind"] == "ordinal":
            value = spec["ordinalOrder"][0]
        else:
            category = spec["observedCategories"][0]
            if category["kind"] == "value":
                value = category["code"]
            elif category["kind"] == "missing":
                value = None
            else:
                value = spec["notApplicableCodes"][0] if spec["notApplicableCodes"] else None
        base[mapping[spec["columnId"]]] = value
    cases = [{"name": "synthetic_baseline", "record": base}]
    for spec in model["inputs"]:
        key = mapping[spec["columnId"]]
        missing = dict(base)
        missing.pop(key)
        cases.append({"name": "absent:" + spec["columnId"], "record": missing})
        for suffix, value in (("boolean", True), ("null", None), ("empty_string", "")):
            record = dict(base)
            record[key] = value
            cases.append({"name": suffix + ":" + spec["columnId"], "record": record})
        if spec["kind"] == "categorical":
            for index, level in enumerate(spec["observedCategories"]):
                if level["kind"] != "value":
                    continue
                record = dict(base)
                record[key] = level["code"]
                cases.append({"name": f"observed_level:{spec['columnId']}:{index}", "record": record})
            unknown = "__synthetic_unknown__"
            known = set(spec["declaredCategories"] or []) | {c["code"] for c in spec["observedCategories"]} | set(spec["missingCodes"] + spec["notApplicableCodes"])
            while unknown in known:
                unknown += "_"
            record = dict(base)
            record[key] = unknown
            cases.append({"name": "unknown:" + spec["columnId"], "record": record})
    expected = runtime.predict_batch(model, [case["record"] for case in cases], mapping)
    for case, result in zip(cases, expected):
        case["expected"] = result
    return {"synthetic": True, "description": "Generated solely from frozen model schema and ranges, never sampled from fit records. Examples are illustrative, not accuracy measurements.",
            "modelIdentity": copy.deepcopy(model["identity"]), "columnMapping": mapping,
            "comparisonTolerance": {"absolute": 1e-10, "relative": 1e-10}, "cases": cases}


def _readme(model, language, mapping):
    identity = model["identity"]
    code_name = _LANGUAGES[language][0]
    python = "python predict.py records.json --model model.json"
    js = 'import { predict_batch } from "./predict.mjs";\nimport { readFileSync } from "node:fs";\nconst model = JSON.parse(readFileSync("model.json", "utf8"));\nconst records = JSON.parse(readFileSync("records.json", "utf8"));\nconsole.log(predict_batch(model, records));'
    usage = python if language == "python" else js
    if language == "typescript":
        usage = 'Compile predict.ts as an ES module (target ES2020 or newer, lib ES2020 and DOM).\nImport predict_batch from the compiled predict.js and pass parsed model JSON and records.'
    return f'''# Frozen regularized-regression Predict

Model: {identity['modelId']}
Model version: {identity['modelVersion']}
Schema: {model['schemaVersion']}
Algorithm: {model['training']['algorithm']}
Integrity: {identity['contentHash']}
Runtime/exporter version: {identity['runtimeVersion']}/{identity['exporterVersion']}

## Files
- model.json: immutable execution model and frozen metadata, full binary64 round-trip precision
- {code_name}: readable, self-contained inference and validation; no training dependencies
- input-schema.json: named record fields, frozen codes and explicit key mapping
- test-vectors.json: synthetic examples generated from model metadata; no training records
- README.md: this file
ZIP is optional convenience. Every file is also independently downloadable.

## Run
{usage}

The Python API is predict_record(model, record, column_mapping=None) and
predict_batch(model, records, column_mapping=None). JavaScript/TypeScript expose
the same names. Their default mapping is the mapping selected at export.
All three exported APIs and the Python CLI default to the exported mapping.
Pass an explicit mapping to override it, or null/None to use the frozen input keys.
No target column is required. Extra fields are ignored.
Validate once per batch; invalid model data throws rather than returning predictions.
Individual invalid records return null prediction with a row-local status and warnings.
Empty batches are supported. For a browser, load model.json as JSON and import the ES module.

## Inputs and frozen meaning
Use current-dataset values, including any upstream transformed columns exactly as fitted.
The runtime does not recover original raw values, impute, fetch a dataset/codebook,
call an API, or import numpy/sklearn. Upstream leakage has not been verified.
The model necessarily contains frozen category codes and metadata labels; it is not
a guarantee of anonymity. Synthetic vectors are constructed, never copied fit rows.
Explicit mapping is columnId to record key; unmapped inputs use the frozen key.
All effective keys must be distinct. Labels never resolve input identity.
Exported mapping: {json.dumps(mapping, ensure_ascii=False)}

Continuous inputs accept finite binary64 numbers or ASCII decimal/exponent strings
with ASCII whitespace trimmed. Null, empty strings and frozen missing codes are missing;
booleans, arrays, objects and non-decimal strings are rejected. Overflow and underflow
to zero are numeric_range. A nonzero decimal mantissa such as "1e-999" must not
silently become zero; exact-zero strings such as "0e-999" remain valid.
Continuous missing codes compare by numeric equivalence: 99, 99.0 and "9.9e1"
all match a continuous missing code "99". This also applies to fractional/large codes.
Categorical and ordinal strings preserve Unicode, whitespace and leading zeros.
Integer numeric codes must be within ±9007199254740991; use strings for larger codes.
Fractional codes and booleans are invalid. Absent fields differ from explicit null.
Unknown categories differ from declared-but-unobserved categories; neither becomes
an all-zero one-hot vector. Missing/not-applicable levels follow the frozen policy.
Ordinal scores are one-based, using the frozen order and reversal.
Values outside observed numeric/rank ranges produce extrapolation warnings, not intervals.

## Evaluation and integrity
Each feature is evaluated in its saved order using separate float64 operations:
  total = fitted_intercept
  total = total + coefficient[j] * ((feature[j] - offset[j]) / scale[j])
  prediction = targetOffset + targetScale * total
No algebraic expansion to the display intercept is performed. This preserves centered
calculation for large offsets. Any nonfinite intermediate or result returns numeric_range.
A nonzero centered value divided by scale becoming zero, nonzero coefficient and
scaled-value operands multiplying to zero, or nonzero total multiplied by targetScale
becoming zero also returns numeric_range. Representable finite subnormals remain
valid. Exact-zero operands and ordinary addition cancellation are not underflow.
Coefficients shown by the application are display-only original-unit quantities.
Reference-category choices do not change model identity or prediction.
This export offers point predictions only, with no OLS p-values, confidence/prediction
intervals, survey inference or automatic retraining.

SHA-256 detects changes but is not a signature proving model authorship. Canonical hashing
excludes identity.contentHash only. It uses a typed binary encoding, not JSON text:
n/t/f for null/true/false; d + eight big-endian IEEE754 bytes for a number (negative zero
normalizes to positive zero); s + UTF8 byte length + ':' + bytes for a string;
a + item count + ':' + items for arrays; o + key count + ':' + key/value pairs for objects.
Object keys are sorted by Unicode scalar value (UTF8 byte order). Unpaired surrogates,
nonfinite values, unknown schema/runtime versions and malformed shapes are rejected.
JSON indentation, property order and integer versus floating spelling do not affect hash.
Unsupported older models must be explicitly re-exported/reanalyzed; no migration is guessed.
'''


def export_artifacts(model: dict, language: str, artifact: str, column_mapping: dict | None = None) -> dict:
    """Export readable artifacts or an optional ZIP, preserving frozen identity."""
    runtime.validate_model(model)
    if language not in _LANGUAGES:
        raise ValueError("language must be python, javascript or typescript")
    if artifact not in _ARTIFACTS:
        raise ValueError("unsupported Predict artifact")
    mapping = runtime._mapping(model, column_mapping)
    code_name, code_mime = _LANGUAGES[language]
    identity = model["identity"]
    # Construct only requested artifacts, except bundle which intentionally includes all.
    def render(kind):
        if kind == "model":
            return "model.json", "application/json", _json(model)
        if kind == "code":
            generator = {"python": _python_source, "javascript": _javascript_source, "typescript": _typescript_source}[language]
            return code_name, code_mime, generator(mapping)
        if kind == "schema":
            return "input-schema.json", "application/schema+json", _json(_input_schema(model, mapping))
        if kind == "readme":
            return "README.md", "text/markdown", _readme(model, language, mapping)
        return "test-vectors.json", "application/json", _json(_synthetic_vectors(model, mapping))
    if artifact == "bundle":
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for kind in ("model", "code", "schema", "readme", "test_vectors"):
                name, _, content = render(kind)
                # Fixed entry names and timestamps; model IDs never become filesystem paths.
                info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, content.encode("utf-8"))
        name, mime, payload, encoding = "regularized-predict.zip", "application/zip", base64.b64encode(buffer.getvalue()).decode("ascii"), "base64"
    else:
        name, mime, payload = render(artifact)
        encoding = "utf-8"
    return {"fileName": name, "mime": mime, "payload": payload, "encoding": encoding,
            "modelId": identity["modelId"], "modelVersion": identity["modelVersion"], "contentHash": identity["contentHash"]}
