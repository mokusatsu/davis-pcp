"""Native MA regressions for the reviewed aggregate-first overflow correction.

Ordinary pytest dispatches the exact selected module cases into one isolated subprocess;
it requires neither an imported app nor a configured workspace in the parent.
The strict external runner can still prebind app.main and its workspace. These
tests never replace stores, settings, routes, classifiers, or arithmetic functions.
Every fixture is imported through HTTP and configured through the actual codebook
routes. Store access below is read-only, for imported-value and retained-cache evidence.

Set DAVIS_MA_SCALE_EVIDENCE to retain strict raw HTTP records, uploads,
exceptions, actual generated IDs/values, and independent Fraction oracles.
Ordinary runs always retain those records in pytest's temporary directories;
DAVIS_MA_SCALE_ORDINARY_EVIDENCE optionally chooses their parent directory.
"""
from __future__ import annotations

from copy import deepcopy
import csv
from fractions import Fraction
from functools import wraps
import hashlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback

from fastapi.testclient import TestClient
import pytest


SUMMARY = "/api/v1/summaries/multi-response"
COMPARISON = SUMMARY + "/comparison"
GROUP = "ma_response_scale"
MAX_FLOAT = Fraction.from_float(sys.float_info.max)
ZERO = Fraction(0)
_TEST_SHA256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


# Executed only in a fresh interpreter, after the parent supplies an isolated
# environment. All support code lives in this test file, not an external runner.
_STANDALONE_BOOTSTRAP = r'''
import hashlib, importlib, json, os, sys, traceback, types
from pathlib import Path
config = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
run, test = Path(config["run"]), Path(config["test"])
backend, app_root = test.parents[2], test.parents[2] / "app"
sys.path[:] = list(dict.fromkeys([str(backend), *config["dependency_paths"], *sys.path]))
sys.dont_write_bytecode, sys.pycache_prefix = True, str(run / "bytecode")
def save(name, value):
    (run / name).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
def sources():
    return {str(p.resolve()): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [test, *sorted(app_root.rglob("*.py"))]}
expected = sources()
def bindings():
    found = {}
    for name, module in list(sys.modules.items()):
        if name == "app" or name.startswith("app."):
            filename = getattr(module, "__file__", None)
            if filename is None:
                spec = getattr(module, "__spec__", None)
                assert spec is not None and spec.name == name and spec.origin is None, ("Not a namespace package", name)
                locations = [Path(p).resolve() for p in getattr(module, "__path__", ())]
                spec_locations = [Path(p).resolve() for p in (spec.submodule_search_locations or ())]
                directory = app_root.joinpath(*name.split(".")[1:]).resolve()
                assert locations == spec_locations == [directory], ("Unbound namespace", name, locations, spec_locations)
                assert directory.is_relative_to(app_root) and directory.is_dir(), ("Namespace outside app", name)
                found[name] = {"kind": "namespace", "locations": [str(p) for p in locations],
                               "spec_locations": [str(p) for p in spec_locations]}
                continue
            path = Path(filename).resolve()
            assert path.is_relative_to(app_root), ("Mixed app import", name, str(path))
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            assert expected.get(str(path)) == digest, ("Changed app source", name, str(path))
            found[name] = {"path": str(path), "sha256": digest}
    return found
class Outcome:
    def __init__(self):
        self.collected, self.reports = [], []
    def pytest_collection_finish(self, session):
        self.collected = [{"path": str(item.path.resolve()), "selector": item.nodeid.split("::", 1)[1]}
                          for item in session.items]
    def pytest_runtest_logreport(self, report):
        self.reports.append({"nodeid": report.nodeid, "when": report.when, "outcome": report.outcome})
outcome, status = Outcome(), {"complete": False, "passed": False}
save("sources-before.json", expected)
try:
    assert expected[str(test)] == config["test_sha256"], "Collected test source changed"
    assert not any(n == "app" or n.startswith("app.") for n in sys.modules), "App imported before isolation"
    assert "davis_ma_scale_bound_runner" not in sys.modules, "Unexpected external runner"
    marker = types.ModuleType("davis_ma_scale_standalone_child")
    marker.assert_native_binding = bindings
    sys.modules[marker.__name__] = marker
    importlib.import_module("app.main")
    save("imports-before.json", bindings())
    import pytest
    args = ["-q", "--import-mode=importlib", "--noconftest", "-c", str(run / "pytest.ini"),
            "--rootdir", str(backend), "--basetemp", str(run / "pytest-tmp"),
            "-o", "cache_dir=" + str(run / "pytest-cache"),
            "--junitxml", str(run / "junit.xml")]
    args += [str(test) + "::" + case for case in config["cases"]]
    save("invocation.json", {"args": args, "sys_path": sys.path, "executable": sys.executable,
                            "python": sys.version, "cwd": str(Path.cwd()), "app_root": str(app_root),
                            "workspace": os.environ["DAVIS_PCP_WORKSPACE"],
                            "pycache_prefix": sys.pycache_prefix, "dont_write_bytecode": sys.dont_write_bytecode,
                            "isolated_environment": {k: os.environ[k] for k in (
                                "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "MPLCONFIGDIR", "DAVIS_MA_SCALE_EVIDENCE")},
                            "test": str(test), "test_sha256": config["test_sha256"]})
    status["pytest_exit_code"] = int(pytest.main(args, plugins=[outcome]))
    assert status["pytest_exit_code"] in (0, 1), status
    assert len(config["cases"]) == len(set(config["cases"])), "Duplicate selected nodes"
    assert outcome.collected == [{"path": str(test), "selector": case}
                                 for case in config["cases"]], outcome.collected
    case_reports = {case: [] for case in config["cases"]}
    for report in outcome.reports:
        selector = report["nodeid"].split("::", 1)[1]
        assert selector in case_reports, ("Unrequested report", report)
        assert report["outcome"] in ("passed", "failed", "skipped"), report
        case_reports[selector].append(report)
    failed_report = any(r["outcome"] == "failed" for r in outcome.reports)
    assert failed_report == (status["pytest_exit_code"] == 1), "Inconsistent pytest outcome"
    status["cases"] = {
        case: {"passed": [(r["when"], r["outcome"]) for r in reports] == [
            ("setup", "passed"), ("call", "passed"), ("teardown", "passed")],
            "reports": reports}
        for case, reports in case_reports.items()}
    status["complete"] = True
    status["passed"] = all(result["passed"] for result in status["cases"].values())
except BaseException:
    status.update(complete=False, passed=False)
    status["error"] = traceback.format_exc()
    traceback.print_exc()
finally:
    status.update(selected_count=len(config["cases"]), collected_count=len(outcome.collected),
                  collected=outcome.collected, reports=outcome.reports)
    try:
        after = sources()
        save("sources-after.json", after)
        save("imports-after.json", bindings())
        assert after == expected, "App or test sources changed during child execution"
    except BaseException:
        status.update(complete=False, passed=False, binding_error=traceback.format_exc())
        traceback.print_exc()
    save("child-status.json", status)
sys.exit(status["pytest_exit_code"] if status["complete"] else 2)
'''


class _OrdinaryInvocation:
    def __init__(self, request, selectors):
        self.request, self.selectors = request, selectors
        self.started = False
        self.run = None
        self.status, self.returncode, self.error = {}, None, ""

    def execute(self):
        if self.started:
            return
        self.started = True
        try:
            self._execute()
        except (OSError, ValueError):
            self.error = traceback.format_exc()

    def _execute(self):
        test = Path(__file__).resolve()
        root = os.environ.get("DAVIS_MA_SCALE_ORDINARY_EVIDENCE")
        if root:
            root = Path(root).resolve()
            root.mkdir(parents=True, exist_ok=True)
            key = hashlib.sha256(json.dumps([str(test), self.selectors]).encode()).hexdigest()[:20]
            run = Path(tempfile.mkdtemp(prefix="native-module-" + key + "-", dir=root))
        else:
            run = self.request.getfixturevalue("tmp_path_factory").mktemp("ma-response-scale")
        self.run = run
        for name in ("workspace", "tmp", "cache", "mpl", "bytecode", "http"):
            (run / name).mkdir()
        # Preserve ordinary pytest's dependency paths, including --target
        # installs, while excluding other app roots and this test package.
        dependencies = [str(Path(p).resolve()) for p in sys.path if p
                        and not (Path(p) / "app").exists()
                        and not Path(p).resolve().is_relative_to(test.parents[1])]
        config = {"run": str(run), "test": str(test), "test_sha256": _TEST_SHA256,
                  "cases": self.selectors, "first_parent_nodeid": self.request.node.nodeid,
                  "dependency_paths": dependencies}
        (run / "config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
        (run / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
        env = dict(os.environ)
        for key in ("DAVIS_PCP_READY_FILE", "DAVIS_PCP_WASM", "PYTHONPATH", "PYTHONHOME",
                    "PYTEST_ADDOPTS", "PYTEST_PLUGINS", "PYTHONSTARTUP"):
            env.pop(key, None)
        env.update(DAVIS_PCP_WORKSPACE=str(run / "workspace"), TMPDIR=str(run / "tmp"),
                   TMP=str(run / "tmp"), TEMP=str(run / "tmp"), XDG_CACHE_HOME=str(run / "cache"),
                   MPLCONFIGDIR=str(run / "mpl"), PYTHONPYCACHEPREFIX=str(run / "bytecode"),
                   PYTHONDONTWRITEBYTECODE="1", PYTEST_DISABLE_PLUGIN_AUTOLOAD="1",
                   DAVIS_MA_SCALE_EVIDENCE=str(run / "http"), OPENBLAS_NUM_THREADS="1",
                   OMP_NUM_THREADS="1", MKL_NUM_THREADS="1", NUMEXPR_NUM_THREADS="1", POLARS_MAX_THREADS="1")
        command = [sys.executable, "-I", "-B", "-c", _STANDALONE_BOOTSTRAP, str(run / "config.json")]
        try:
            with (run / "stdout.txt").open("wb") as out, (run / "stderr.txt").open("wb") as err:
                result = subprocess.run(command, cwd=run, env=env, stdout=out, stderr=err, check=False)
            self.returncode = result.returncode
            status_file = run / "child-status.json"
            self.status = json.loads(status_file.read_text(encoding="utf-8")) if status_file.is_file() else {}
        except (OSError, ValueError):
            self.error = traceback.format_exc()
        (run / "process-status.json").write_text(json.dumps({
            "returncode": self.returncode, "launcher_error": self.error}) + "\n", encoding="utf-8")

    def assert_case(self, selector):
        self.execute()
        valid = (not self.error and self.returncode in (0, 1)
                 and self.status.get("complete") is True
                 and self.status.get("pytest_exit_code") == self.returncode)
        result = self.status.get("cases", {}).get(selector, {})
        logs = "".join((self.run / name).read_text(encoding="utf-8", errors="replace")
                       for name in ("stdout.txt", "stderr.txt")
                       if self.run is not None and (self.run / name).is_file())
        assert valid and result.get("passed") is True, (
            f"Isolated native case {selector} failed; evidence: {self.run}\n{self.error}\n"
            + logs)


class _OrdinaryBatch:
    def __init__(self, request):
        test = Path(__file__).resolve()
        selectors = [item.nodeid.split("::", 1)[1] for item in request.session.items
                     if Path(item.path).resolve() == test]
        # Preserve per-case isolation for external parallel schedulers or an
        # explicit duplicate-node invocation; never collapse their requests.
        self.selectors = (selectors if selectors and len(selectors) == len(set(selectors))
                          and not os.environ.get("PYTEST_XDIST_WORKER") else None)
        self.shared = None

    def run_case(self, request):
        selector = request.node.nodeid.split("::", 1)[1]
        if self.selectors is None:
            invocation = _OrdinaryInvocation(request, [selector])
        else:
            assert selector in self.selectors, "Parent requested an unselected case"
            if self.shared is None:
                self.shared = _OrdinaryInvocation(request, self.selectors)
            invocation = self.shared
        invocation.assert_case(selector)


@pytest.fixture(scope="module")
def _ordinary_native_batch(request):
    return _OrdinaryBatch(request)


class _IsolatedCase:
    def __init__(self, request, batch):
        self.request, self.batch = request, batch

    def run(self):
        self.batch.run_case(self.request)


def _isolated_native_test(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        harness = kwargs["native"] if "native" in kwargs else args[0]
        if isinstance(harness, _IsolatedCase):
            return harness.run()
        return function(*args, **kwargs)
    return wrapped


def _jsonable(value):
    if isinstance(value, Fraction):
        return {"fraction": str(value), "numerator": str(value.numerator),
                "denominator": str(value.denominator)}
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _assert_native_binding():
    runner = sys.modules.get("davis_ma_scale_bound_runner")
    if runner is None:
        runner = sys.modules.get("davis_ma_scale_standalone_child")
    if runner is not None:
        runner.assert_native_binding()


def _reject_nonfinite_json(value):
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Non-finite JSON numeric value")
    if isinstance(value, dict):
        for item in value.values():
            _reject_nonfinite_json(item)
    elif isinstance(value, list):
        for item in value:
            _reject_nonfinite_json(item)


class _Observer:
    """Record and rethrow exceptions, forwarding unmodified ASGI events."""

    def __init__(self, app):
        self.app = app
        self.exceptions = []

    async def __call__(self, scope, receive, send):
        try:
            await self.app(scope, receive, send)
        except Exception as error:
            self.exceptions.append({
                "type": type(error).__module__ + "." + type(error).__qualname__,
                "message": str(error), "repr": repr(error),
                "traceback": traceback.format_exc(),
            })
            raise


class _Native:
    def __init__(self, client, observer, evidence):
        self.client = client
        self.observer = observer
        self.evidence = evidence
        self.sequence = 0
        self.notes = 0

    def note(self, label, value):
        self.notes += 1
        if self.evidence is not None:
            path = self.evidence / f"note-{self.notes:03d}-{label}.json"
            path.write_text(json.dumps(_jsonable(value), ensure_ascii=False,
                                       indent=2, allow_nan=False) + "\n", encoding="utf-8")

    def request(self, method, path, *, expected_status=200, **kwargs):
        _assert_native_binding()
        self.sequence += 1
        stem = f"http-{self.sequence:03d}"
        self.observer.exceptions.clear()
        record = {"method": method, "path": path, "request_json": kwargs.get("json"),
                  "expected_status": expected_status}
        if "files" in kwargs:
            filename, payload, media_type = kwargs["files"]["file"]
            record["upload"] = {"filename": filename, "media_type": media_type,
                                "sha256": hashlib.sha256(payload).hexdigest(),
                                "file": stem + ".upload.bin"}
            if self.evidence is not None:
                (self.evidence / (stem + ".upload.bin")).write_bytes(payload)
        response = None
        try:
            response = self.client.request(method, path, **kwargs)
        except Exception as error:
            record["client_exception"] = {"type": type(error).__qualname__,
                                          "message": str(error), "traceback": traceback.format_exc()}
            raise
        finally:
            record["observed_exceptions"] = list(self.observer.exceptions)
            if response is None:
                self.note(stem, record)
                _assert_native_binding()
        record.update(status=response.status_code, headers=list(response.headers.multi_items()),
                      body_sha256=hashlib.sha256(response.content).hexdigest(), body_text=response.text,
                      body_file=stem + ".body.bin")
        if self.evidence is not None:
            (self.evidence / (stem + ".body.bin")).write_bytes(response.content)

        def reject_constant(value):
            raise ValueError("Nonstandard JSON constant: " + value)

        parse_error = None
        try:
            body = json.loads(response.content, parse_constant=reject_constant)
            _reject_nonfinite_json(body)
            record["parsed_body"] = body
        except (ValueError, UnicodeDecodeError) as error:
            body = None
            parse_error = str(error)
            record["json_parse_error"] = parse_error
        self.note(stem, record)
        _assert_native_binding()
        assert response.status_code == expected_status, record
        assert parse_error is None, record
        assert isinstance(body, dict), record
        assert not self.observer.exceptions, record
        return body


@pytest.fixture
def native(request):
    # Importing this test must never choose or initialize an app by accident.
    if not any(name in sys.modules for name in (
            "davis_ma_scale_bound_runner", "davis_ma_scale_standalone_child")):
        yield _IsolatedCase(request, request.getfixturevalue("_ordinary_native_batch"))
        return
    assert "app.main" in sys.modules, "The source-bound external runner must prebind app.main"
    assert os.environ.get("DAVIS_PCP_WORKSPACE"), "An isolated workspace is required"
    from app.api import datasets, multi_response
    from app.config import settings

    workspace = Path(os.environ["DAVIS_PCP_WORKSPACE"]).resolve()
    assert Path(settings.workspace_dir).resolve() == workspace
    assert datasets.store.root.resolve() == workspace / "datasets"
    assert multi_response.store.root.resolve() == workspace / "datasets"
    evidence = None
    if os.environ.get("DAVIS_MA_SCALE_EVIDENCE"):
        key = hashlib.sha256(request.node.nodeid.encode()).hexdigest()[:20]
        evidence = Path(os.environ["DAVIS_MA_SCALE_EVIDENCE"]) / ("native-" + key)
        evidence.mkdir(parents=True, exist_ok=False)
    observer = _Observer(sys.modules["app.main"].app)
    with TestClient(observer, raise_server_exceptions=False) as client:
        harness = _Native(client, observer, evidence)
        harness.note("test", {"nodeid": request.node.nodeid, "workspace": str(workspace)})
        yield harness


def _row(a, b, weight, *, picks, state="valid", area="X", **weights):
    """Literal expected membership; no production classifier is consulted."""
    return {"a": a, "b": b, "area": area, "weights": {"w": weight, **weights},
            "state": state, "picks": tuple(picks)}


def _pair(scale=1.0):
    return [_row(1, 0, scale, picks=("a",)),
            _row(1, 1, 2 * scale, picks=("a", "b"))]


def _import(native, rows, *, policy="valid", members=("a", "b"),
            option_order=("a", "b"), category_order=("X", "Y")):
    from app.api import datasets

    weight_names = list(rows[0]["weights"])
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow([*members, "area", *weight_names])
    for row in rows:
        assert set(row["weights"]) == set(weight_names)
        writer.writerow([*(row[name] for name in members), row["area"],
                         *(row["weights"][name] for name in weight_names)])
    imported = native.request("POST", "/api/v1/datasets/import", files={
        "file": ("ma-response-scale.csv", buffer.getvalue().encode(), "text/csv")})
    dataset_id = imported["datasetId"]
    path = f"/api/v1/datasets/{dataset_id}"
    initial = native.request("GET", path + "/codebook")
    by_name = {column["name"]: column for column in initial["columns"]}
    ids = {name: by_name[name]["columnId"] for name in [*members, "area", *weight_names]}
    assert len(set(ids.values())) == len(ids)
    changes = [{"columnId": ids[name], "role": "question", "scaleType": "nominal",
                "multiResponseGroup": GROUP, "multiResponseOptionLabel": "Option " + name,
                "missingCodes": ["98", "99"],
                "missingReasons": {"98": "not_applicable", "99": "missing"}}
               for name in members]
    changes += [{"columnId": ids["area"], "role": "attribute", "scaleType": "nominal",
                 "missingCodes": ["99"], "categoryOrder": list(category_order)}]
    changes += [{"columnId": ids[name], "role": "weight", "scaleType": "ratio",
                 "missingCodes": []} for name in weight_names]
    patch = {"expectedSchemaRevision": initial["schemaRevision"], "columns": changes,
             "multiResponseGroups": [{"groupId": GROUP, "label": "MA response scale",
                                      "selectedCodes": ["1"], "unselectedCodes": ["0"],
                                      "allUnselectedMeaning": policy,
                                      "optionOrder": [ids[name] for name in option_order]}],
             "weightConfig": {"weightColumnId": ids["w"], "weightType": "survey"}}
    native.request("PUT", path + "/codebook", json=patch)
    book = native.request("GET", path + "/codebook")
    meta = native.request("GET", path)
    assert book["schemaRevision"] == initial["schemaRevision"] + 1
    assert meta["schemaRevision"] == book["schemaRevision"]
    assert meta["dataRevision"] == imported["dataRevision"]
    saved_group = next(group for group in book["multiResponseGroups"] if group["groupId"] == GROUP)
    assert saved_group["optionOrder"] == [ids[name] for name in option_order]
    assert saved_group["allUnselectedMeaning"] == policy
    for column in book["columns"]:
        if column["name"] in ids:
            assert column["columnId"] == ids[column["name"]]

    # This is the same native read-back path used by the sealed proof. It is
    # intentionally read-only; it never constructs/saves a replacement store.
    frame = datasets.store.get_dataframe(dataset_id)
    actual = frame.to_dicts()
    assert len(actual) == len(rows)
    row_ids = [str(row["__rowId__"]) for row in actual]
    assert len(set(row_ids)) == len(rows)
    observations = []
    for index, (declared, saved) in enumerate(zip(rows, actual)):
        for name in (*members, "area"):
            assert saved[name] == declared[name]
        for name in weight_names:
            expected, observed = declared["weights"][name], saved[name]
            if expected is None:
                assert observed is None
            else:
                assert not isinstance(observed, (str, bool))
                assert math.isfinite(float(observed)) and float(observed) >= 0
                assert float(observed) == float(expected)
            observations.append({"rowId": row_ids[index], "columnId": ids[name], "name": name,
                                 "raw_value": observed, "python_type": type(observed).__name__,
                                 "float_hex": None if observed is None else float(observed).hex(),
                                 "exact": None if observed is None else Fraction.from_float(float(observed))})
    fixture = {"datasetId": dataset_id, "ids": ids, "rowIds": row_ids,
               "rows": actual, "declared": rows, "book": book, "meta": meta,
               "members": members, "option_order": option_order,
               "category_order": category_order, "policy": policy}
    native.note("imported-fixture", {**fixture, "initialCodebook": initial, "patch": patch,
                                     "weightObservations": observations,
                                     "dtypes": {name: str(dtype) for name, dtype in frame.schema.items()}})
    return fixture


def _fraction(value):
    return ZERO if value is None else Fraction.from_float(float(value))


def _oracle(fixture, indices, weight_name, weighted):
    # The state/picks below are explicit fixture data, independent of all
    # production classification, summation, and normalization helpers.
    counts = {name: 0 for name in ("valid", "missing", "partial", "invalid", "notApplicable")}
    valid = []
    for index in indices:
        state = fixture["declared"][index]["state"]
        counts[state] += 1
        if state == "valid":
            valid.append(index)
    denominators = {"total": len(indices), "target": len(indices) - counts["notApplicable"], **counts}
    picks = {name: [index for index in valid if name in fixture["declared"][index]["picks"]]
             for name in fixture["option_order"]}
    mass = lambda index: _fraction(fixture["rows"][index][weight_name]) if weighted else Fraction(1)
    valid_mass = sum((mass(index) for index in valid), ZERO)
    option_masses = {name: sum((mass(index) for index in picked), ZERO) for name, picked in picks.items()}
    response_mass = sum(option_masses.values(), ZERO)
    total_responses = sum(len(picked) for picked in picks.values())
    items = {}
    for name, picked in picks.items():
        numerator = option_masses[name]
        items[name] = {"indices": picked, "selectedN": len(picked), "mass": numerator,
                       "pctRespondent": 100 * numerator / valid_mass if valid_mass else None,
                       "pctResponse": 100 * numerator / response_mass if response_mass else None,
                       "pctRespondentUnweighted": Fraction(100 * len(picked), len(valid)) if valid else None,
                       "pctResponseUnweighted": Fraction(100 * len(picked), total_responses) if total_responses else None}
    return {"denominators": denominators, "validMass": valid_mass, "responseMass": response_mass,
            "allUnselectedN": sum(not fixture["declared"][index]["picks"] for index in valid),
            "totalResponses": total_responses, "items": items}


def _assert_number(observed, exact, label):
    if exact is None:
        assert observed is None, (label, observed, exact)
        return
    target = float(exact)
    assert isinstance(observed, (float, int)) and not isinstance(observed, bool), (label, observed, str(exact))
    assert math.isfinite(observed), (label, observed, str(exact))
    if target == 0:
        assert observed == 0.0, (label, observed, str(exact))
    elif 0 < target < sys.float_info.min:
        assert observed > 0.0, (label, observed, str(exact), target.hex())
        assert abs(observed - target) <= 4 * math.ulp(target), (label, observed, str(exact), target.hex())
    else:
        assert observed > 0.0, (label, observed, str(exact))
        assert math.isclose(observed, target, rel_tol=1e-14, abs_tol=0.0), (label, observed, str(exact), target)


def _assert_total(observed, exact, label):
    if exact > MAX_FLOAT:
        assert observed is None, (label, observed, str(exact))
    else:
        _assert_number(observed, exact, label)


def _assert_group(group, fixture, oracle, selected_ids, weighted):
    assert group["groupId"] == GROUP
    assert group["label"] == "MA response scale"
    assert group["denominators"] == oracle["denominators"]
    assert group["allUnselectedN"] == oracle["allUnselectedN"]
    assert group["totalResponses"] == oracle["totalResponses"]
    assert [item["columnId"] for item in group["items"]] == [fixture["ids"][name] for name in fixture["option_order"]]
    assert [item["name"] for item in group["items"]] == list(fixture["option_order"])
    # Percentage checks precede unavailable-total checks, so the required
    # baseline failures identify bad ratios rather than infinity cleanup.
    for item in group["items"]:
        name = item["name"]
        expected = oracle["items"][name]
        assert item["label"] == "Option " + name
        assert item["selectedN"] == expected["selectedN"]
        assert item["selectedInSelection"] == sum(fixture["rowIds"][index] in selected_ids for index in expected["indices"])
        for field in ("pctResponse", "pctRespondent", "pctResponseUnweighted", "pctRespondentUnweighted"):
            _assert_number(item[field], expected[field], name + "." + field)
        _assert_total(item["selectedWeighted"], expected["mass"], name + ".selectedWeighted")
    if weighted:
        _assert_total(group["weightedValidN"], oracle["validMass"], "weightedValidN")
        _assert_total(group["weightedResponses"], oracle["responseMass"], "weightedResponses")
    else:
        assert group["weightedValidN"] is None and group["weightedResponses"] is None


def _scope_hash(row_ids):
    payload = json.dumps(sorted(set(row_ids)), ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _query(native, fixture, endpoint, *, weight_name="w", indices=None, selected=(),
           request_row_ids=None):
    scope = list(range(len(fixture["rows"]))) if indices is None else list(indices)
    selected_ids = {fixture["rowIds"][index] for index in selected}
    body = {"datasetId": fixture["datasetId"], "selectedRowIds": sorted(selected_ids),
            "expectedDataRevision": fixture["meta"]["dataRevision"],
            "expectedSchemaRevision": fixture["book"]["schemaRevision"]}
    if weight_name is not None:
        body["weightColumn"] = fixture["ids"][weight_name]
    if indices is not None:
        body["rowIds"] = [fixture["rowIds"][index] for index in scope]
    if request_row_ids is not None:
        body["rowIds"] = request_row_ids
    if endpoint == SUMMARY:
        body["groupIds"] = [GROUP]
    else:
        body.update(groupId=GROUP, attributeColumnId=fixture["ids"]["area"])
    scoped_values = [] if weight_name is None else [fixture["rows"][index][weight_name] for index in scope]
    weighted = weight_name is not None and any(value is not None and value > 0 for value in scoped_values)
    status = "omitted" if weight_name is None else ("applied" if weighted else "no_positive_weight")
    if endpoint == SUMMARY:
        expected_groups = [(None, scope)]
    else:
        codes = {fixture["declared"][index]["area"] for index in scope} - {None, "99"}
        order = {code: index for index, code in enumerate(fixture["category_order"])}
        expected_groups = [(code, [index for index in scope if fixture["declared"][index]["area"] == code])
                           for code in sorted(codes, key=lambda code: (order.get(code, len(order)), code))]
    oracles = [(code, _oracle(fixture, subset, weight_name, weighted)) for code, subset in expected_groups]
    native.note("oracle", {"datasetId": fixture["datasetId"], "endpoint": endpoint, "request": body,
                            "scopeIndices": scope, "weightStatus": status, "groups": oracles})
    result = native.request("POST", endpoint, json=body)
    assert result["datasetId"] == fixture["datasetId"]
    assert result["dataRevision"] == fixture["meta"]["dataRevision"]
    assert result["schemaRevision"] == fixture["book"]["schemaRevision"]
    assert result["scopeHash"] == _scope_hash([fixture["rowIds"][index] for index in scope])
    assert result["weightStatus"] == status
    assert result["weightColumnId"] == (None if weight_name is None else fixture["ids"][weight_name])
    assert result["weightColumn"] == weight_name
    assert result["weightMissingCount"] == sum(value is None for value in scoped_values)
    assert result["weightZeroCount"] == sum(value == 0 for value in scoped_values)
    if weighted:
        exact_scope_mass = sum((_fraction(value) for value in scoped_values), ZERO)
        if exact_scope_mass > MAX_FLOAT:
            assert result["weightedN"] is None
        else:
            # The outer API intentionally retains its existing 4-digit display
            # behavior; helper totals below are checked in original units.
            target = float(exact_scope_mass)
            rounded = round(target, 4)
            _assert_number(result["weightedN"], Fraction.from_float(target if rounded == 0 else rounded), "weightedN")
        assert [warning["code"] for warning in result["warnings"]] == ["MA_WEIGHT_APPLIED"]
    else:
        assert result["weightedN"] is None
        assert [warning["code"] for warning in result["warnings"]] == ([] if weight_name is None else ["WEIGHT_UNSUPPORTED"])
    if endpoint == SUMMARY:
        assert result["method"] == "multiple-response-complete-case"
        assert result["usedColumns"] == list(fixture["members"])
        assert len(result["groups"]) == 1
        assert result["excludedCounts"] == {GROUP: oracles[0][1]["denominators"]}
        groups = result["groups"]
    else:
        assert result["method"] == "multiple-response-disjoint-attribute-strata"
        assert result["groupId"] == GROUP
        assert result["attributeColumnId"] == fixture["ids"]["area"]
        assert result["usedColumns"] == [*fixture["members"], "area"]
        assert result["scopeCount"] == len(scope)
        assert result["attributeMissingExcluded"] == sum(fixture["declared"][index]["area"] in (None, "99") for index in scope)
        assert [stratum["code"] for stratum in result["strata"]] == [code for code, _ in oracles]
        assert [stratum["label"] for stratum in result["strata"]] == [code for code, _ in oracles]
        groups = [stratum["summary"] for stratum in result["strata"]]
    for group, (_, oracle) in zip(groups, oracles):
        _assert_group(group, fixture, oracle, selected_ids, weighted)
    return result


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("scale", [1.0, 4e307], ids=["ordinary", "large"])
@_isolated_native_test
def test_m01_exact_proved_fixture_has_60_40_response_percentages(native, endpoint, scale):
    fixture = _import(native, _pair(scale))
    oracle = _oracle(fixture, [0, 1], "w", True)
    assert _fraction(fixture["rows"][1]["w"]) == 2 * _fraction(fixture["rows"][0]["w"])
    assert [oracle["items"][name]["pctResponse"] for name in ("a", "b")] == [Fraction(60), Fraction(40)]
    assert [oracle["items"][name]["pctRespondent"] for name in ("a", "b")] == [Fraction(100), Fraction(200, 3)]
    assert oracle["validMass"] <= MAX_FLOAT
    assert all(item["mass"] <= MAX_FLOAT for item in oracle["items"].values())
    assert (oracle["responseMass"] > MAX_FLOAT) == (scale == 4e307)
    _query(native, fixture, endpoint)


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("scale", [1e-300, 1e-12, 1e160])
@_isolated_native_test
def test_m02_common_scales_use_actual_imported_float_oracle(native, endpoint, scale):
    _query(native, _import(native, _pair(scale)), endpoint)


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("permutation", [(1, 0), (2, 0, 3, 1)])
@_isolated_native_test
def test_m03_row_member_and_option_order_permutations(native, endpoint, permutation):
    rows = _pair(4e307)
    if len(permutation) == 4:
        rows += [_row(0, 1, 1e307, picks=("b",)), _row(0, 0, 2e307, picks=())]
    rows = [rows[index] for index in permutation]
    fixture = _import(native, rows, members=("b", "a"), option_order=("a", "b"))
    _query(native, fixture, endpoint, selected=(0, len(rows) - 1))


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@_isolated_native_test
def test_m04_overflowed_respondent_and_option_mass_keep_both_ratios(native, endpoint):
    fixture = _import(native, [_row(1, 0, 1e308, picks=("a",)),
                               _row(1, 1, 1e308, picks=("a", "b"))])
    oracle = _oracle(fixture, [0, 1], "w", True)
    assert oracle["validMass"] > MAX_FLOAT and oracle["items"]["a"]["mass"] > MAX_FLOAT
    assert oracle["items"]["b"]["mass"] <= MAX_FLOAT
    assert [oracle["items"][name]["pctRespondent"] for name in ("a", "b")] == [Fraction(100), Fraction(50)]
    assert [oracle["items"][name]["pctResponse"] for name in ("a", "b")] == [Fraction(200, 3), Fraction(100, 3)]
    _query(native, fixture, endpoint)


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("a,b,state,picks", [
    (99, 99, "missing", ()), (1, 99, "partial", ("a",)),
    (2, 0, "invalid", ()), (98, 98, "notApplicable", ()),
])
@_isolated_native_test
def test_m05_excluded_giant_never_scales_valid_tiny_masses(native, endpoint, a, b, state, picks):
    fixture = _import(native, _pair(1e-300) + [_row(a, b, 1e308, state=state, picks=picks)])
    _query(native, fixture, endpoint, selected=(0, 2))


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("policy,state", [("valid", "valid"), ("missing", "missing"), ("notApplicable", "notApplicable")])
@_isolated_native_test
def test_m06_all_unselected_giant_is_absent_from_response_mass(native, endpoint, policy, state):
    fixture = _import(native, _pair(1e-300) + [_row(0, 0, 1e308, state=state, picks=())], policy=policy)
    oracle = _oracle(fixture, [0, 1, 2], "w", True)
    assert oracle["items"]["a"]["pctResponse"] == 60
    assert oracle["items"]["b"]["pctResponse"] == 40
    _query(native, fixture, endpoint)


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@_isolated_native_test
def test_m07_scope_excludes_selected_giant_with_generated_ids(native, endpoint):
    fixture = _import(native, _pair(1e-300) + [_row(0, 1, 1e308, picks=("b",))])
    requested = [fixture["rowIds"][1], fixture["rowIds"][0], fixture["rowIds"][1], "not-an-imported-row"]
    _query(native, fixture, endpoint, indices=[0, 1], request_row_ids=requested, selected=(1, 2))


@_isolated_native_test
def test_m07_comparison_isolates_missing_attribute_and_other_stratum(native):
    rows = _pair(1e-300) + [_row(1, 1, 1e308, picks=("a", "b"), area="99"),
                           _row(0, 1, 1e308, picks=("b",), area="Y")]
    fixture = _import(native, rows, category_order=("Y", "X"))
    _query(native, fixture, COMPARISON, selected=(0, 2, 3))


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@_isolated_native_test
def test_m08_zero_and_missing_weights_keep_selection_and_raw_membership(native, endpoint):
    rows = _pair() + [_row(0, 1, 0.0, picks=("b",)), _row(0, 1, None, picks=("b",))]
    fixture = _import(native, rows)
    oracle = _oracle(fixture, range(4), "w", True)
    assert [oracle["items"][name]["selectedN"] for name in ("a", "b")] == [2, 3]
    assert oracle["totalResponses"] == 5
    assert oracle["items"]["a"]["pctResponse"] != oracle["items"]["a"]["pctResponseUnweighted"]
    _query(native, fixture, endpoint, selected=(2, 3))


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("weights", [(0.0, 0.0), (None, None), (0.0, None)])
@_isolated_native_test
def test_m09_no_positive_weights_use_native_unweighted_fallback(native, endpoint, weights):
    rows = [_row(1, 0, weights[0], picks=("a",)), _row(1, 1, weights[1], picks=("a", "b"))]
    _query(native, _import(native, rows), endpoint, selected=(1,))


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@_isolated_native_test
def test_m09_excluded_positive_weight_does_not_enable_group_percentages(native, endpoint):
    rows = [_row(1, 0, 0.0, picks=("a",)), _row(1, 1, None, picks=("a", "b")),
            _row(99, 99, 1e308, state="missing", picks=())]
    _query(native, _import(native, rows), endpoint)


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@_isolated_native_test
def test_m09_omitted_weights_preserve_raw_percentage_fields(native, endpoint):
    _query(native, _import(native, _pair(4e307)), endpoint, weight_name=None, selected=(1,))


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("scale", [1.0, 1e-300, 1e308])
@_isolated_native_test
def test_m10_positive_respondent_mass_and_zero_responses(native, endpoint, scale):
    rows = [_row(0, 0, scale, picks=()), _row(0, 0, scale, picks=())]
    _query(native, _import(native, rows), endpoint, selected=(0, 1))


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("policy,state", [("missing", "missing"), ("notApplicable", "notApplicable")])
@_isolated_native_test
def test_m10_no_valid_rows_leave_both_denominators_unavailable(native, endpoint, policy, state):
    rows = [_row(0, 0, 1e308, picks=(), state=state), _row(0, 0, 1e308, picks=(), state=state)]
    _query(native, _import(native, rows, policy=policy), endpoint)


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@_isolated_native_test
def test_m10_empty_native_scope_is_well_defined(native, endpoint):
    _query(native, _import(native, _pair()), endpoint, indices=[], selected=(0,))


@pytest.mark.parametrize("endpoint", [SUMMARY, COMPARISON], ids=["summary", "comparison"])
@pytest.mark.parametrize("reverse", [False, True])
@_isolated_native_test
def test_m11_aggregate_tiny_option_before_scaling_preserves_subnormal(native, endpoint, reverse):
    rows = [_row(1, 0, 1e-16, picks=("a",)) for _ in range(10)]
    rows.append(_row(0, 1, 1e308, picks=("b",)))
    if reverse:
        rows = rows[5:] + rows[:5]
    fixture = _import(native, rows, members=("b", "a") if reverse else ("a", "b"),
                      option_order=("b", "a") if reverse else ("a", "b"))
    oracle = _oracle(fixture, range(11), "w", True)
    for field in ("pctResponse", "pctRespondent"):
        target = float(oracle["items"]["a"][field])
        assert 0 < target < sys.float_info.min
        assert target.hex() == "0x0.00000000000cap-1022"
    assert float(Fraction.from_float(1e-16) / Fraction.from_float(1e308)) == 0.0
    _query(native, fixture, endpoint, selected=(0, 8, 10))


def _cache_entry(fixture, result):
    from app.api import multi_response

    with multi_response._summary_cache_lock:
        entries = [(key, entry) for key, entry in multi_response._summary_cache.items()
                   if key[1] == fixture["datasetId"] and key[5] == result["scopeHash"]
                   and key[7] == result["weightColumnId"]]
    assert len(entries) == 1, [(key, id(entry)) for key, entry in entries]
    return entries[0]


def _assert_cache_masks(fixture, result, indices=None):
    indices = list(range(len(fixture["rows"]))) if indices is None else list(indices)
    key, entry = _cache_entry(fixture, result)
    base, masks, row_ids, size = entry
    assert row_ids == tuple(fixture["rowIds"][index] for index in indices)
    expected = {fixture["ids"][name]: sum(1 << position for position, index in enumerate(indices)
                if fixture["declared"][index]["state"] == "valid"
                and name in fixture["declared"][index]["picks"]) for name in fixture["option_order"]}
    assert masks == expected
    assert all(item["selectedInSelection"] == 0 for item in base["items"])
    assert isinstance(size, int) and size > 0
    assert len(entry) == 4
    return key, entry


def _matches(native, fixture, *, picks=(), predicate="any", state=None, indices=None, area=None):
    scope = list(range(len(fixture["rows"]))) if indices is None else list(indices)
    body = {"groupId": GROUP, "optionColumnIds": [fixture["ids"][name] for name in picks],
            "predicate": predicate, "expectedSchemaRevision": fixture["book"]["schemaRevision"],
            "expectedDataRevision": fixture["meta"]["dataRevision"]}
    if indices is not None:
        body["rowIds"] = [fixture["rowIds"][index] for index in scope]
    if state is not None:
        body["status"] = state
    if area is not None:
        body["attributeFilter"] = {"columnId": fixture["ids"]["area"], "code": area}
    wanted = []
    for index in scope:
        row = fixture["declared"][index]
        if area is not None and row["area"] != area:
            continue
        if predicate == "status":
            match = row["state"] == state
        elif row["state"] != "valid":
            match = False
        elif predicate == "any":
            match = bool(set(picks) & set(row["picks"]))
        elif predicate == "all":
            match = set(picks) <= set(row["picks"])
        else:
            match = not (set(picks) & set(row["picks"]))
        if match:
            wanted.append(fixture["rowIds"][index])
    native.note("match-oracle", {"request": body, "rowIds": wanted})
    result = native.request("POST", f"/api/v1/datasets/{fixture['datasetId']}/matches", json=body)
    assert result["datasetId"] == fixture["datasetId"]
    assert result["schemaRevision"] == fixture["book"]["schemaRevision"]
    assert result["dataRevision"] == fixture["meta"]["dataRevision"]
    assert result["scopeHash"] == _scope_hash([fixture["rowIds"][index] for index in scope])
    assert result["rowIds"] == wanted and result["count"] == len(wanted)


@pytest.mark.parametrize("scale", [1.0, 4e307], ids=["ordinary", "overflow"])
@pytest.mark.parametrize("permuted", [False, True])
@_isolated_native_test
def test_m12_mask_byte_boundary_selection_and_matches(native, scale, permuted):
    rows = _pair(scale) + [
        _row(0, 1, 0.0, picks=("b",)), _row(0, 1, None, picks=("b",)),
        _row(99, 99, scale, picks=(), state="missing"),
        _row(1, 99, scale, picks=("a",), state="partial"),
        _row(2, 0, scale, picks=(), state="invalid"),
        _row(98, 98, scale, picks=(), state="notApplicable"),
        _row(0, 0, scale, picks=()), _row(1, 0, scale, picks=("a",), area="Y"),
        _row(1, 1, scale, picks=("a", "b"), area="Y"),
    ]
    if permuted:
        rows = [rows[index] for index in [10, 3, 7, 1, 9, 5, 0, 8, 2, 6, 4]]
    fixture = _import(native, rows, option_order=("b", "a"))
    first = _query(native, fixture, SUMMARY, selected=(0, 2, 3, 8, 9, 10))
    key, entry = _assert_cache_masks(fixture, first)
    snapshot = deepcopy(entry)
    second = _query(native, fixture, SUMMARY, selected=(1, 4, 6))
    second_key, second_entry = _assert_cache_masks(fixture, second)
    assert second_key == key and second_entry is entry and second_entry == snapshot
    _query(native, fixture, COMPARISON, selected=(0, 2, 3, 8, 9, 10))
    native.note("cache-masks", {"key": key, "base": entry[0], "masks": entry[1], "rowIds": entry[2]})
    for picks, predicate in [(("a",), "any"), (("b",), "any"), (("a", "b"), "all"), (("a", "b"), "unselected")]:
        _matches(native, fixture, picks=picks, predicate=predicate)
    for state in ("valid", "partial", "missing", "invalid", "notApplicable"):
        _matches(native, fixture, predicate="status", state=state)
    _matches(native, fixture, picks=("b",), indices=list(range(10)), area="X")


@_isolated_native_test
def test_m13_native_cache_selection_weight_scope_and_revision_controls(native):
    rows = [_row(1, 0, 1.0, picks=("a",), w_large=4e307, w_tiny=1e-300, w_changed=2.0),
            _row(1, 1, 2.0, picks=("a", "b"), w_large=8e307, w_tiny=2e-300, w_changed=1.0)]
    fixture = _import(native, rows)
    first = _query(native, fixture, SUMMARY, selected=(0,))
    first_key, first_entry = _assert_cache_masks(fixture, first)
    snapshot = deepcopy(first_entry)
    for selected in ((1,), ()):
        repeated = _query(native, fixture, SUMMARY, selected=selected)
        key, entry = _assert_cache_masks(fixture, repeated)
        assert key == first_key and entry is first_entry and entry == snapshot
    keys = {first_key}
    for name in ("w_tiny", "w_large", "w_changed"):
        result = _query(native, fixture, SUMMARY, weight_name=name, selected=(1,))
        key, entry = _assert_cache_masks(fixture, result)
        assert key not in keys and entry is not first_entry
        keys.add(key)
    changed = _oracle(fixture, [0, 1], "w_changed", True)
    assert [changed["items"][name]["pctResponse"] for name in ("a", "b")] == [Fraction(75), Fraction(25)]
    scoped = _query(native, fixture, SUMMARY, indices=[1], selected=(1,))
    scoped_key, _ = _assert_cache_masks(fixture, scoped, indices=[1])
    assert scoped_key not in keys
    for name in ("w", "w_large", "w_changed"):
        for selected in ((0,), (1,), ()):
            _query(native, fixture, COMPARISON, weight_name=name, selected=selected)
    # Revision mismatch is checked through the route; no dataset or cache
    # mutation is used to manufacture a new revision.
    for endpoint in (SUMMARY, COMPARISON):
        for field, revision in (("expectedDataRevision", fixture["meta"]["dataRevision"]),
                                ("expectedSchemaRevision", fixture["book"]["schemaRevision"])):
            request = {"datasetId": fixture["datasetId"], "weightColumn": fixture["ids"]["w"], field: revision + 1}
            request.update({"groupIds": [GROUP]} if endpoint == SUMMARY else
                           {"groupId": GROUP, "attributeColumnId": fixture["ids"]["area"]})
            native.request("POST", endpoint, json=request, expected_status=409)
    assert _cache_entry(fixture, first)[1] is first_entry
    assert first_entry == snapshot
    meta = native.request("GET", f"/api/v1/datasets/{fixture['datasetId']}")
    book = native.request("GET", f"/api/v1/datasets/{fixture['datasetId']}/codebook")
    assert meta == fixture["meta"] and book == fixture["book"]
    native.note("retained-cache", {"firstKey": first_key, "otherKeys": sorted(keys, key=repr),
                                   "scopedKey": scoped_key, "base": first_entry[0],
                                   "masks": first_entry[1], "rowIds": first_entry[2]})
