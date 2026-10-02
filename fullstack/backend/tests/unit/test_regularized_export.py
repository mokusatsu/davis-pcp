"""Offline readable artifact, integrity, Python/JavaScript/TypeScript parity tests."""
import base64
import copy
import io
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

import pytest

from app.domain.portable_regression import predict_batch, seal_model, validate_model
from app.services.regularized_export import export_artifacts
from .test_portable_regression import make_model

NODE = shutil.which("node")


def _write(tmp_path, model, language, mapping=None):
    for artifact in ("model","code","schema","readme","test_vectors"):
        exported = export_artifacts(model,language,artifact,mapping)
        path = tmp_path / exported["fileName"]
        path.write_text(exported["payload"],encoding="utf-8")
    return tmp_path / {"python":"predict.py","javascript":"predict.mjs","typescript":"predict.ts"}[language]


def _node(tmp_path, model, records, language="javascript", mapping=None, checks=""):
    if not NODE:
        pytest.skip("Node not installed")
    path = _write(tmp_path,model,language,mapping)
    (tmp_path / "records.json").write_text(json.dumps(records,allow_nan=False),encoding="utf-8")
    program = f'''import * as runtime from {json.dumps(path.as_uri())};
import {{readFileSync}} from "node:fs";
const model = JSON.parse(readFileSync({json.dumps(str(tmp_path / 'model.json'))}, "utf8"));
const records = JSON.parse(readFileSync({json.dumps(str(tmp_path / 'records.json'))}, "utf8"));
{checks}
console.log(JSON.stringify({{results: runtime.predict_batch(model, records), sealed: runtime.seal_model(model).identity.contentHash}}));
'''
    result = subprocess.run([NODE,"--input-type=module","-e",program],check=True,capture_output=True,text=True)
    return json.loads(result.stdout)


@pytest.mark.parametrize("language",["python","javascript","typescript"])
def test_readable_individual_artifacts_and_bundle(language):
    # Do not rely on an archive-only path for any language.
    model = make_model(key='__proto__"\n日本')
    original = copy.deepcopy(model)
    exports = {name:export_artifacts(model,language,name) for name in ("model","code","schema","readme","test_vectors")}
    assert model == original
    for result in exports.values():
        assert result["encoding"] == "utf-8"
        assert result["contentHash"] == model["identity"]["contentHash"]
        assert isinstance(result["payload"],str) and result["payload"]
    validate_model(json.loads(exports["model"]["payload"]))
    bundle = export_artifacts(model,language,"bundle")
    assert bundle["encoding"] == "base64"
    with zipfile.ZipFile(io.BytesIO(base64.b64decode(bundle["payload"]))) as archive:
        assert set(archive.namelist()) == {result["fileName"] for result in exports.values()}
        for result in exports.values():
            assert archive.read(result["fileName"]).decode("utf-8") == result["payload"]
    code = exports["code"]["payload"]
    for forbidden in ("eval(","exec(","Function(","import numpy","import sklearn","pickle","joblib","fetch("):
        assert forbidden not in code


@pytest.mark.parametrize("language",["javascript","typescript"])
@pytest.mark.parametrize("kind",["numeric","ordinal","categorical"])
def test_python_js_ts_prediction_and_hash_parity(tmp_path,language,kind):
    model = make_model(kind,key='__proto__')
    model["identity"]["modelId"] = 'quotes"\\\n😀\ue000'
    if kind == "numeric":
        model["inputs"][0]["missingCodes"] += ["99.5","100000000000000000000"]
        model = seal_model(model)
        values = [0,1.25,"+1.5e2"," 1\n",1e16,"1e308","1e-999", "99.5","099.5","9.95e1",99.5,1e20,"1e20",True,False,None,"",{},[],"0x10","1_000","NaN","1e999","\u00a01\u00a0","１２"]
    else:
        model = seal_model(model)
        values = ["A","B","unseen","unknown",True,False,None,"","M","NA",0,0.5,9007199254740991,9007199254740992,"9007199254740992",{},[]]
    records = [{"__proto__":value,"extra":"ignored"} for value in values] + [None,{},[],"bad"]
    result = _node(tmp_path,model,records,language)
    assert result["results"] == predict_batch(model,records)
    assert result["sealed"] == model["identity"]["contentHash"]


@pytest.mark.parametrize("language",["javascript","typescript"])
def test_js_missing_levels_and_explicit_mapping(tmp_path,language):
    levels = [{"kind":"value","code":"__proto__","label":"prototype"}, {"kind":"value","code":"0","label":"zero"},
              {"kind":"value","code":"00","label":"leading zero"}, {"kind":"value","code":"","label":"empty"},
              {"kind":"missing","code":None,"label":"missing"}, {"kind":"not_applicable","code":None,"label":"NA"}]
    model = make_model("categorical",key="different",levels=levels)
    model["inputs"][0]["columnId"] = "__proto__"
    for row in model["features"]: row["inputColumnId"] = "__proto__"
    for row in model["display"]["coefficients"]: row["columnId"] = "__proto__"
    model["display"]["categoryReferences"][0]["columnId"] = "__proto__"
    model = seal_model(model)
    mapping = {"__proto__":"constructor"}
    records = [{"constructor":v} for v in ["__proto__",0,"0","00","",None,"M","NA",False,{},"unknown","unseen"]]
    result = _node(tmp_path,model,records,language,mapping)
    assert result["results"] == predict_batch(model,records,mapping)
    assert result["sealed"] == model["identity"]["contentHash"]


@pytest.mark.parametrize("language",["javascript","typescript"])
def test_js_general_affine_huge_offset_precision_and_hash(tmp_path,language):
    model = make_model()
    model["features"][0].update(offset=1e16,scale=2.2250738585072014e-308)
    model["linearModel"]["coefficients"][0] = 5e-324
    model["linearModel"].update(intercept=math.nextafter(1,2),targetOffset=-0.0,targetScale=3)
    model["display"]["coefficients"][0].update(estimate=None,estimateReason="unrepresentable")
    model = seal_model(model)
    records = [{"x":1e16},{"x":1e16+2},{"x":1e308},{"x":-1e308}]
    result = _node(tmp_path,model,records,language)
    assert result["results"] == predict_batch(model,records)
    assert result["sealed"] == model["identity"]["contentHash"]


def test_isolated_python_standard_library_only(tmp_path):
    model = make_model(key='a"\n\\😀')
    code = _write(tmp_path,model,"python",{"x-id":"constructor"})
    records = [{"constructor":2},{"constructor":"1e16"},{"constructor":True},{}]
    data = tmp_path / "records.json"; data.write_text(json.dumps(records),encoding="utf-8")
    result = subprocess.run([sys.executable,"-I","-S",str(code),str(data)],capture_output=True,text=True,check=True,cwd=tmp_path)
    assert json.loads(result.stdout) == predict_batch(model,records,{"x-id":"constructor"})


def test_model_integrity_validation_parity_rejects_mutations(tmp_path):
    if not NODE: pytest.skip("Node not installed")
    model = make_model()
    path = _write(tmp_path,model,"javascript")
    program = f'''import * as runtime from {json.dumps(path.as_uri())};
import {{ readFileSync }} from 'node:fs';
const original = JSON.parse(readFileSync({json.dumps(str(tmp_path/'model.json'))},'utf8'));
const changes = [
 m=>m.schemaVersion='2', m=>m.identity.runtimeVersion='2', m=>m.linearModel.intercept+=1,
 m=>m.features[0].scale=0, m=>m.features[0].operation='unsupported',m=>m.linearModel.coefficients.push(2),
 m=>m.inputs[0].label='\\ud800',m=>m.training.l1Ratio=1,m=>m.training.convergence.converged=false,
 m=>m.provenance.records=[],m=>m.inputs[0].notApplicableCodes=['outside'],m=>m.linearModel.intercept=NaN,
 m=>m.display.coefficients[0].exactZero=true,m=>m.inputs[0].columnId='oops'];
console.log(JSON.stringify(changes.map(change=>{{ const m=structuredClone(original);change(m);try{{runtime.validate_model(m);return false;}}catch{{return true;}} }})));
'''
    result = subprocess.run([NODE,"--input-type=module","-e",program],capture_output=True,text=True,check=True)
    assert all(json.loads(result.stdout))


def test_own_properties_only_no_prototype_lookup(tmp_path):
    model = make_model(key="toString")
    result = _node(tmp_path,model,[{}, {"toString":2}],checks='if (runtime.predict_record(model, {}).status !== "missing_field") throw new Error("prototype leak");')
    assert [r["status"] for r in result["results"]] == ["missing_field","ok"]


def test_synthetic_vectors_only_and_exact_results():
    model = make_model("categorical",key='name"\n')
    artifact = export_artifacts(model,"python","test_vectors")
    vectors = json.loads(artifact["payload"])
    assert vectors["synthetic"] is True
    assert set(vectors) == {"synthetic","description","modelIdentity","columnMapping","comparisonTolerance","cases"}
    assert all(set(c) == {"name","record","expected"} for c in vectors["cases"])
    assert all(set(c["record"]) <= {'name"\n'} for c in vectors["cases"])
    assert predict_batch(model,[c["record"] for c in vectors["cases"]]) == [c["expected"] for c in vectors["cases"]]
    assert model["inputs"][0]["label"] not in artifact["payload"]


def test_invalid_exports_fail_and_mapping_preserves_identity():
    model = make_model()
    with pytest.raises(ValueError): export_artifacts(model,"ruby","model")
    with pytest.raises(ValueError): export_artifacts(model,"python","exe")
    with pytest.raises(ValueError): export_artifacts(model,"python","code",{"bad":"x"})
    mapped = export_artifacts(model,"python","model",{"x-id":"other"})
    plain = export_artifacts(model,"python","model")
    assert mapped == plain
    model["linearModel"]["intercept"] += 1
    with pytest.raises(ValueError): export_artifacts(model,"python","code")


def test_exported_python_api_uses_same_default_mapping_as_js(tmp_path):
    model = make_model(key="original")
    path = _write(tmp_path,model,"python",{"x-id":"__proto__"})
    program = f'''import importlib.util, json
spec = importlib.util.spec_from_file_location("offline_runtime", {str(path)!r})
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
with open({str(tmp_path/'model.json')!r}, encoding="utf-8") as handle:
    model = json.load(handle)
print(json.dumps([runtime.predict_record(model, {{"__proto__": 2}}), runtime.predict_record(model, {{"original": 2}}, None)]))
'''
    result = subprocess.run([sys.executable,"-I","-S","-c",program],capture_output=True,text=True,check=True)
    assert [r["prediction"] for r in json.loads(result.stdout)] == [6.5,6.5]


def test_generated_typescript_strict_compile(tmp_path):
    root = Path(__file__).resolve().parents[4]
    tsc = root / "fullstack/frontend/node_modules/.bin/tsc"
    if not tsc.exists(): pytest.skip("Repository TypeScript compiler unavailable")
    path = _write(tmp_path,make_model(),"typescript")
    subprocess.run([str(tsc),"--strict","--noEmit","--target","ES2020","--module","ES2020","--lib","ES2020,DOM",str(path)],capture_output=True,text=True,check=True)
    assert "@ts-nocheck" not in path.read_text()


@pytest.mark.parametrize("language",["javascript","typescript"])
def test_affine_explanatory_fixture_three_language_parity(tmp_path,language):
    from .test_portable_regression import make_affine_model
    model = make_affine_model()
    records = [{"x":15,"z":30},{"x":10,"z":20},{"x":1.2,"z":4.9}]
    assert _node(tmp_path,model,records,language)["results"] == predict_batch(model,records)


def test_native_nonfinite_js_is_row_local(tmp_path):
    model = make_model()
    checks = '''const extra = [NaN, Infinity, -Infinity, undefined].map(x => runtime.predict_record(model, {x}));
if (JSON.stringify(extra.map(r=>r.status)) !== JSON.stringify(["numeric_range","numeric_range","numeric_range","invalid_type"])) throw new Error("nonfinite mismatch");'''
    _node(tmp_path,model,[],checks=checks)


def test_random_binary64_models_hash_and_prediction_parity(tmp_path):
    import random
    if not NODE: pytest.skip("Node not installed")
    rng = random.Random(146321)
    models = []
    records = []
    for _ in range(32):
        model = make_model()
        coefficient = math.ldexp(rng.uniform(-1,1),rng.randint(-1020,1020))
        offset = math.ldexp(rng.uniform(-1,1),rng.randint(-1000,1000))
        scale = math.ldexp(rng.uniform(.5,1),rng.randint(-1020,1020))
        model["linearModel"].update(coefficients=[coefficient],intercept=math.nextafter(rng.uniform(-1,1),1))
        model["features"][0].update(offset=offset,scale=scale)
        models.append(seal_model(model))
        records.append([{"x":offset},{"x":math.nextafter(offset,math.inf)},{"x":"1e-300"},{"x":"1e300"}])
    path = _write(tmp_path,models[0],"javascript")
    data = tmp_path / "edge_models.json"; data.write_text(json.dumps({"models":models,"records":records},allow_nan=False),encoding="utf-8")
    program = f'''import * as runtime from {json.dumps(path.as_uri())};
import {{readFileSync}} from 'node:fs';
const data=JSON.parse(readFileSync({json.dumps(str(data))},'utf8'));
console.log(JSON.stringify(data.models.map((model,i)=>({{hash:runtime.seal_model(model).identity.contentHash,results:runtime.predict_batch(model,data.records[i])}}))));'''
    result = json.loads(subprocess.run([NODE,"--input-type=module","-e",program],capture_output=True,text=True,check=True).stdout, parse_int=float)
    # JS may spell a binary64 as a large decimal integer; decode its number
    # as binary64 rather than comparing Python arbitrary-precision integers.
    for i,model in enumerate(models):
        assert result[i]["hash"] == model["identity"]["contentHash"]
        assert result[i]["results"] == predict_batch(model,records[i])


@pytest.mark.parametrize("algorithm",["ridge","lasso","elasticnet"])
def test_actual_cv_api_model_readable_export_and_js_ts_parity(tmp_path,algorithm):
    import polars as pl
    from tests.api.test_regularized_regression_api import imported, fit
    client, _, _, request = imported(pl.DataFrame({"y":[float(i)+(i%3)/10 for i in range(20)],"x":[float(i) for i in range(20)]}))
    request.update(algorithm=algorithm,selection="cv",cv={"folds":5,"seed":42,"lambdaValues":[.01,.1,1.],"l1Ratios":[.2,.8],"independentRowsAcknowledged":True})
    fitted = fit(client,request)
    model = fitted["portableModel"]
    records = [{"x":value} for value in [0,1,7.5,19,20]]
    for language in ("javascript","typescript"):
        response = client.post(f'/api/v1/analysis-results/{fitted["resultId"]}/export-predict',json={"language":language,"artifact":"model","expectedModelVersion":"1"})
        assert response.status_code == 200,response.text
        exported_model = json.loads(response.json()["payload"])
        assert exported_model == model
        directory = tmp_path / language; directory.mkdir()
        actual = _node(directory,exported_model,records,language)
        assert actual["sealed"] == model["identity"]["contentHash"]
        assert actual["results"] == predict_batch(model,records)
    for placement in ("top","fold","failure"):
        corrupted = copy.deepcopy(model)
        cv = corrupted["training"]["cv"]
        if placement == "top": cv["assignments"] = [{"rowId":"private"}]
        elif placement == "fold": cv["foldAudits"][0]["records"] = [{"x":1,"y":2}]
        else:
            cv["candidates"][0]["folds"][0]["failure"] = {"code":"RR_NUMERIC_RANGE","message":"bad","details":{"rowIds":["private"]}}
        with pytest.raises(ValueError): seal_model(corrupted)
    # The diagnostic allowlist permits necessary scalar solver information.
    audit_copy = copy.deepcopy(model)
    audit_copy["training"]["cv"]["candidates"][0]["folds"][0]["failure"] = {
        "code":"RR_NONCONVERGENCE","message":"synthetic diagnostic","details":{"iterations":100,"solver":"coordinate_descent_cyclic"}}
    validate_model(seal_model(audit_copy))


@pytest.mark.parametrize("language",["javascript","typescript"])
@pytest.mark.parametrize("stage",["parse","scale","coefficient","target","zero_coefficient","cancellation","target_cancellation"])
def test_underflow_exact_zero_and_subnormal_three_language_parity(tmp_path,language,stage):
    from .test_portable_regression import underflow_fixture
    model,records,statuses = underflow_fixture(stage)
    actual = _node(tmp_path,model,records,language)["results"]
    assert [r["status"] for r in actual] == statuses
    assert actual == predict_batch(model,records)
    code = _write(tmp_path,model,"python")
    data = tmp_path / "underflow_records.json"; data.write_text(json.dumps(records),encoding="utf-8")
    isolated = subprocess.run([sys.executable,"-I","-S",str(code),str(data)],capture_output=True,text=True,check=True)
    assert json.loads(isolated.stdout) == actual


def test_api_shared_normalizer_rejects_underflow_string_in_fit_and_predict():
    import polars as pl
    from tests.api.test_regularized_regression_api import imported,fit,store
    client,did,ids,request = imported(pl.DataFrame({"y":[1.,3.,5.,7.,9.],"x":["0","1","2","3","1e-999"]}))
    cb = store.load_codebook(did)
    for column in cb["columns"]:
        if column["columnId"] == ids["x"]: column.update(scaleType="ratio",role="attribute")
    # Preserve the string boundary: importer coercion may already round the literal.
    frame = store.get_dataframe(did).with_columns(pl.Series("x",["0","1","2","3","1e-999"]))
    store.save(did,store.get_meta(did),frame,cb)
    request["context"]["expectedDataRevision"] = store.get_meta(did)["dataRevision"]
    result = fit(client,request)
    assert result["meta"]["fitCount"] == 4
    response = client.post(f'/api/v1/analysis-results/{result["resultId"]}/predict',json={"context":request["context"],"options":{"interval":"none","evaluate":False}})
    assert response.status_code == 200,response.text
    prediction = response.json()
    assert prediction["summary"]["successfulPredictions"] == 4
    assert prediction["summary"]["statusCounts"]["numeric_range"] == 1
