"""Portable contract/normalization/ordered binary64 execution acceptance."""
import copy
import json
import math

import pytest

from app.domain.portable_regression import NORMALIZATION, predict_batch, predict_record, seal_model, validate_model


def make_model(kind="numeric", key="x", levels=None):
    """Entirely synthetic metadata fixture; no dataset/store/training dependency."""
    levels = levels or [{"code": "A", "kind": "value", "label": "A"}, {"code": "B", "kind": "value", "label": "B"}]
    spec = {"columnId": "x-id", "key": key, "name": key, "label": 'label "\\\n日本😀', "kind": kind,
            "unit": None, "missingCodes": ["M", "NA"], "notApplicableCodes": ["NA"],
            "declaredCategories": ["A", "B", "unseen"] if kind != "numeric" else None,
            "observedCategories": levels if kind == "categorical" else [],
            "ordinalOrder": ["A", "B"] if kind == "ordinal" else [], "ordinalReversed": kind == "ordinal",
            "trainingMin": None if kind == "categorical" else 0.0, "trainingMax": None if kind == "categorical" else 10.0}
    model = {"schemaVersion": "davis.regularized-regression/1",
             "identity": {"modelId": "synthetic-model", "modelVersion": "1", "algorithmVersion": "davis.regularized_regression.1.0.0",
                          "exporterVersion": "1", "runtimeVersion": "1", "createdAt": "2026-10-02T00:00:00Z", "contentHash": ""},
             "provenance": {"revisions": {"dataRevision": 1, "schemaRevision": 1, "maskRevision": None}, "scopeFingerprint": "synthetic",
                            "fitCount": 4, "libraryVersions": {"python": "3.12", "numpy": "2.4.6", "sklearn": "1.9.0"}},
             "training": {"algorithm": "ridge", "lambdaValue": .1, "l1Ratio": 0.0, "libraryAlpha": .4, "intercept": True,
                          "standardize": True, "weightNormalization": "sum_to_n", "objective": "synthetic objective", "solver": "svd",
                          "tolerance": 1e-8, "maxIterations": 10000, "convergence": {"converged": True, "iterations": None, "dualGap": None}, "cv": None},
             "inputs": [spec], "normalization": copy.deepcopy(NORMALIZATION),
             "preprocessing": {"numericMissing": "reject", "categoricalMissingPolicy": "separate_not_applicable", "imputation": "none", "inputScope": "current_dataset_values", "upstreamLeakageVerified": False},
             "features": [], "linearModel": {"coefficients": [], "intercept": 5.0, "targetOffset": 0.0, "targetScale": 1.0, "dtype": "float64", "execution": "centered_ordered_sum"},
             "display": {"coefficients": [], "intercept": {"estimate": 4.0, "reason": None}, "targetSd": 2.0, "targetLabel": "target", "targetUnit": None, "categoryReferences": []},
             "domain": {"unknownCategory": "reject", "unobservedCategory": "reject", "extrapolation": "warn", "numericRange": "finite_float64"},
             "capabilities": {"pointPrediction": True, "intervals": False, "rawInput": False, "transformedInput": True}}
    categories = levels if kind == "categorical" else [None]
    for i, level in enumerate(categories):
        category = {"code": level["code"], "kind": level["kind"]} if level is not None else None
        fid = f"f-{i}"
        model["features"].append({"designColumnId": fid, "inputColumnId": "x-id", "operation": {"numeric": "identity", "ordinal": "ordered_rank", "categorical": "one_hot"}[kind],
                                  "category": category, "offset": .5, "scale": 2.0, "constant": False})
        model["linearModel"]["coefficients"].append(float(i + 2))
        model["display"]["coefficients"].append({"designColumnId": fid, "columnId": "x-id", "label": spec["label"], "kind": kind,
                                                 "category": category, "estimate": float(i + 2) / 2, "estimateReason": None,
                                                 "standardizedEstimate": None if kind == "categorical" else 1.0,
                                                 "standardizedReason": "categorical" if kind == "categorical" else None,
                                                 "comparisonSd": None if kind == "categorical" else 2.0, "exactZero": False, "unit": "unit"})
    if kind == "categorical":
        model["display"]["categoryReferences"] = [{"columnId": "x-id", "reference": {"code": levels[0]["code"], "kind": levels[0]["kind"]}, "levels": copy.deepcopy(levels)}]
    return seal_model(model)


def test_seal_roundtrip_copy_and_hash_not_json_spelling():
    model = make_model()
    original = copy.deepcopy(model)
    sealed = seal_model(model)
    assert model == original and sealed is not model
    roundtrip = json.loads(json.dumps(model, ensure_ascii=True))
    validate_model(roundtrip)
    roundtrip["linearModel"]["intercept"] = 5  # integer/float spelling cannot change identity
    assert seal_model(roundtrip)["identity"]["contentHash"] == model["identity"]["contentHash"]
    roundtrip["linearModel"]["targetOffset"] = -0.0
    assert seal_model(roundtrip)["identity"]["contentHash"] == model["identity"]["contentHash"]


@pytest.mark.parametrize("value,status", [
    (0,"ok"), (1.25,"ok"), (1e16,"ok"), ("  +1.25e2\r\n","ok"), (".5","ok"), ("1.","ok"), ("01","ok"), ("-0","ok"),
    (None,"missing_value"), ("","missing_value"), (" \t","missing_value"), ("M","missing_value"), (" NA ","missing_value"),
    (True,"invalid_type"), (False,"invalid_type"), ([],"invalid_type"), ({},"invalid_type"), ("1_000","invalid_type"), ("0x10","invalid_type"),
    ("1,5","invalid_type"), ("nan","invalid_type"), ("Infinity","invalid_type"), ("１２","invalid_type"), ("\u00a01\u00a0","invalid_type"),
    (float("nan"),"numeric_range"), (float("inf"),"numeric_range"), ("1e999","numeric_range"), (10**1000,"numeric_range"),
])
def test_numeric_normalization(value,status):
    assert predict_record(make_model(), {"x": value})["status"] == status


def test_missing_absent_batch_invalid_sibling_and_no_target():
    model = make_model()
    result = predict_batch(model, [{}, {"x": None}, {"x": 2, "irrelevant": True}, None, [], "", 42])
    assert [r["status"] for r in result] == ["missing_field", "missing_value", "ok", "invalid_type", "invalid_type", "invalid_type", "invalid_type"]
    assert result[2]["prediction"] == 6.5
    assert predict_batch(model, []) == []
    with pytest.raises(ValueError):
        predict_batch(model, {})


def test_mapping_exact_keys_duplicate_labels_and_extras():
    model = make_model(key='__proto__"\n\\😀')
    assert predict_record(model, {'__proto__"\n\\😀': 2})["prediction"] == 6.5
    assert predict_record(model, {"constructor": 2}, {"x-id": "constructor"})["prediction"] == 6.5
    assert predict_record(model, {"label": 2})["status"] == "missing_field"
    for mapping in ({"unknown": "x"}, {"x-id": 1}, []):
        with pytest.raises(ValueError):
            predict_record(model, {}, mapping)
    copy_model = copy.deepcopy(model)
    second = copy.deepcopy(copy_model["inputs"][0]); second["columnId"] = "second"; copy_model["inputs"].append(second)
    feature = copy.deepcopy(copy_model["features"][0]); feature.update(designColumnId="second-f", inputColumnId="second"); copy_model["features"].append(feature)
    copy_model["linearModel"]["coefficients"].append(2.0)
    row = copy.deepcopy(copy_model["display"]["coefficients"][0]); row.update(designColumnId="second-f", columnId="second"); copy_model["display"]["coefficients"].append(row)
    copy_model = seal_model(copy_model)
    with pytest.raises(ValueError, match="reuses"):
        predict_record(copy_model, {})
    assert predict_record(copy_model, {"a": 2, "b": 2}, {"x-id": "a", "second": "b"})["prediction"] == 8


def test_category_kinds_unknown_unobserved_and_codes():
    levels = [{"kind":"value","code":"0","label":"zero"},{"kind":"value","code":"00","label":"double zero"},
              {"kind":"value","code":"","label":"empty"},{"kind":"missing","code":None,"label":"missing"},
              {"kind":"not_applicable","code":None,"label":"NA"}]
    model = make_model("categorical", levels=levels)
    values = [0, "0", "00", "", None, "M", "NA", "A", "unknown", True, .5, 9007199254740992, "9007199254740992"]
    actual = predict_batch(model, [{"x": v} for v in values])
    assert [v["status"] for v in actual] == ["ok"] * 7 + ["unobserved_category","unknown_category","invalid_type","invalid_type","invalid_type","unknown_category"]
    assert actual[0] == actual[1]
    assert actual[4] == actual[5] and actual[4] != actual[6]
    for policy in ("exclude", "include_missing"):
        changed = copy.deepcopy(model); changed["preprocessing"]["categoricalMissingPolicy"] = policy; changed = seal_model(changed)
        rows = predict_batch(changed,[{"x":None},{"x":"M"},{"x":"NA"}])
        assert len({r["status"] for r in rows}) == 1
        if policy == "include_missing": assert rows[0] == rows[2]
        else: assert rows[0]["status"] == "missing_value"
    no_missing = make_model("categorical")
    assert predict_record(no_missing,{"x":None})["status"] == "unobserved_category"


def test_ordinal_frozen_reverse_and_out_of_domain():
    model = make_model("ordinal")
    assert predict_record(model,{"x":"A"})["prediction"] == 6.5
    assert predict_record(model,{"x":"B"})["prediction"] == 5.5
    assert predict_record(model,{"x":"unseen"})["status"] == "unobserved_category"
    assert predict_record(model,{"x":"C"})["status"] == "unknown_category"
    assert predict_record(model,{"x":None})["status"] == "missing_value"


def test_centered_huge_offset_general_affine_and_overflow():
    model = make_model()
    model["features"][0].update(offset=1e16,scale=2)
    model["linearModel"].update(intercept=3,targetOffset=19,targetScale=7)
    model = seal_model(model)
    result = predict_record(model,{"x":1e16+2})
    assert result["prediction"] == 54
    assert result["warnings"] == [{"code":"extrapolation","columnId":"x-id"}]
    model["features"][0].update(offset=-1e308,scale=1)
    model = seal_model(model)
    assert predict_record(model,{"x":1e308})["status"] == "numeric_range"
    model["features"][0].update(offset=0,scale=5e-324)
    model = seal_model(model)
    assert predict_record(model,{"x":1})["status"] == "numeric_range"


@pytest.mark.parametrize("mutate", [
    lambda m: m.update(schemaVersion="unknown/2"),
    lambda m: m["identity"].update(runtimeVersion="2"),
    lambda m: m["identity"].update(contentHash="sha256:"+"0"*64),
    lambda m: m["linearModel"]["coefficients"].append(1),
    lambda m: m["linearModel"].update(intercept=float("nan")),
    lambda m: m["linearModel"].update(targetScale=0),
    lambda m: m["features"][0].update(scale=0),
    lambda m: m["features"][0].update(operation="eval"),
    lambda m: m["features"][0].update(inputColumnId="unknown"),
    lambda m: m["training"].update(algorithm="ols"),
    lambda m: m["training"].update(l1Ratio=.5),
    lambda m: m["training"]["convergence"].update(converged=False),
    lambda m: m["normalization"].update(booleanInputs="accept"),
    lambda m: m["provenance"].update(records=[]),
    lambda m: m["inputs"][0].update(label="\ud800"),
    lambda m: m["display"]["coefficients"][0].update(estimate=None),
    lambda m: m["display"]["coefficients"][0].update(exactZero=True),
    lambda m: m["training"].update(intercept=False),
])
def test_corrupt_models_fail_before_predict(mutate):
    model = make_model(); mutate(model)
    with pytest.raises(ValueError): validate_model(model)
    with pytest.raises(ValueError): predict_batch(model, [])


def test_full_precision_subnormal_and_signed_zero_hash():
    model = make_model()
    model["linearModel"]["intercept"] = math.nextafter(1.0,2.0)
    model["features"][0]["offset"] = 0
    model["linearModel"]["coefficients"][0] = 5e-324
    model = seal_model(model)
    assert json.loads(json.dumps(model))["linearModel"]["intercept"] == math.nextafter(1.0,2.0)
    assert predict_record(model,{"x":0})["prediction"] == math.nextafter(1.0,2.0)


@pytest.mark.parametrize("value", [99.5,"99.5","99.50",1e20,"100000000000000000000","1e20", " 1e20 "])
def test_fractional_and_huge_continuous_missing_sentinels(value):
    model = make_model()
    model["inputs"][0]["missingCodes"] += ["99.5", "100000000000000000000"]
    model = seal_model(model)
    assert predict_record(model,{"x":value})["status"] == "missing_value"


def make_affine_model():
    """Approved explanatory transform: raw beta=[0.4,-0.4], intercept=20.4."""
    model = make_model()
    model["inputs"][0].update(trainingMin=0,trainingMax=100)
    second = copy.deepcopy(model["inputs"][0]); second.update(columnId="second",key="z",name="z")
    model["inputs"].append(second)
    model["features"][0].update(offset=10,scale=5)
    feature = copy.deepcopy(model["features"][0]); feature.update(designColumnId="f-z",inputColumnId="second",offset=20,scale=10)
    model["features"].append(feature)
    model["linearModel"].update(coefficients=[.5,-1],intercept=1.6,targetOffset=10,targetScale=4)
    model["display"]["coefficients"][0]["estimate"] = .4
    row = copy.deepcopy(model["display"]["coefficients"][0]); row.update(designColumnId="f-z",columnId="second",estimate=-.4)
    model["display"]["coefficients"].append(row)
    model["display"]["intercept"]["estimate"] = 20.4
    return seal_model(model)


def test_approved_explanatory_affine_and_display_independence():
    model = make_affine_model()
    records = [{"x":15,"z":30},{"x":10,"z":20},{"x":1.2,"z":4.9}]
    actual = predict_batch(model,records)
    for row,result in zip(records,actual):
        assert result["prediction"] == pytest.approx(.4*row["x"]-.4*row["z"]+20.4,abs=1e-12)
    changed = copy.deepcopy(model)
    changed["display"]["intercept"]["estimate"] = -999
    changed["display"]["coefficients"][0]["estimate"] = 999
    changed = seal_model(changed)
    assert predict_batch(changed,records) == actual


def test_explicit_ordered_sum_not_reassociated():
    model = make_affine_model()
    model["features"][0].update(offset=0,scale=1)
    model["features"][1].update(offset=0,scale=1)
    model["linearModel"].update(coefficients=[-1e16,1],intercept=1e16,targetOffset=0,targetScale=1)
    model = seal_model(model)
    assert predict_record(model,{"x":1,"z":1})["prediction"] == 1


def test_non_json_circular_model_is_value_error():
    model = make_model()
    model["training"]["cv"] = model
    with pytest.raises(ValueError,match="circular"):
        validate_model(model)
    with pytest.raises(ValueError,match="circular"):
        seal_model(model)


def underflow_fixture(stage):
    """Exact-zero and representable-subnormal controls for each arithmetic stage."""
    model = make_model()
    model["features"][0].update(offset=0.0,scale=1.0)
    model["linearModel"].update(coefficients=[1.0],intercept=0.0,targetOffset=0.0,targetScale=1.0)
    if stage == "parse":
        values = ["1e-999","-1e-999","0e-999","-0.000E-999",0,-0.0,"5e-324","-5e-324","2e-324"]
        statuses = ["numeric_range","numeric_range","ok","ok","ok","ok","ok","ok","numeric_range"]
    else:
        values = [5e-324,1e-323,0.0]
        statuses = ["numeric_range","ok","ok"]
        if stage == "scale": model["features"][0]["scale"] = 2.0
        elif stage == "coefficient": model["linearModel"]["coefficients"] = [.5]
        elif stage == "target": model["linearModel"]["targetScale"] = .5
        elif stage == "zero_coefficient":
            model["linearModel"]["coefficients"] = [0.0]
            model["display"]["coefficients"][0]["exactZero"] = True
            statuses = ["ok"] * 3
        elif stage == "cancellation":
            model["linearModel"].update(coefficients=[-1.0],intercept=5e-324)
            statuses = ["ok"] * 3
        elif stage == "target_cancellation":
            model["linearModel"]["targetOffset"] = -5e-324
            statuses = ["ok"] * 3
        else: raise AssertionError(stage)
    return seal_model(model), [{"x":value} for value in values], statuses


@pytest.mark.parametrize("stage",["parse","scale","coefficient","target","zero_coefficient","cancellation","target_cancellation"])
def test_underflow_to_zero_is_row_local_range_error(stage):
    model,records,statuses = underflow_fixture(stage)
    actual = predict_batch(model,records)
    assert [r["status"] for r in actual] == statuses
    if stage in ("scale","coefficient","target"):
        assert actual[1]["prediction"] == 5e-324
        assert actual[2]["prediction"] == 0.0
    if stage in ("cancellation","target_cancellation"):
        assert actual[0]["prediction"] == 0.0


def test_underflowing_missing_spelling_never_collapses_actual_zero():
    from app.domain.portable_regression import normalize_numeric_input
    assert normalize_numeric_input(0,["1e-999"]) == (0.0,None)
    assert normalize_numeric_input("0e-999",["1e-999"]) == (0.0,None)
    assert normalize_numeric_input("1e-999",["1e-999"]) == (None,"missing_value")
    assert normalize_numeric_input("01e-999",["1e-999"]) == (None,"numeric_range")
    assert normalize_numeric_input(0,["0e-999"]) == (None,"missing_value")
