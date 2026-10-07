"""INT-03/09 real API calculations, canonical validity, metadata and history."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys

import pytest


BACKEND = Path(__file__).resolve().parents[2]
CASES = {
    "INT03_constant_z": ([1.0, None, 1.0], "zscore(x)", [0.0, None, 0.0]),
    "INT03_constant_m": ([1.0, None, 1.0], "minmax(x)", [0.0, None, 0.0]),
    "INT03_tiny_z": ([1e-14, 2e-14, 3e-14, None], "zscore(x)", [-math.sqrt(1.5), 0.0, math.sqrt(1.5), None]),
    "INT03_tiny_m": ([1e-14, 2e-14, 3e-14, None], "minmax(x)", [0.0, 0.5, 1.0, None]),
    "INT03_ordinary_z": ([1.0, 2.0, 3.0, None], "zscore(x)", [-math.sqrt(1.5), 0.0, math.sqrt(1.5), None]),
    "INT03_ordinary_m": ([1.0, 2.0, 3.0, None], "minmax(x)", [0.0, 0.5, 1.0, None]),
    "INT03_all_null_z": ([None, None, None], "zscore(x)", [None, None, None]),
    "INT03_all_null_m": ([None, None, None], "minmax(x)", [None, None, None]),
    "INT03_offset_z": ([1e16, 1e16 + 2.0, 1e16 + 4.0, None], "zscore(x)", [-math.sqrt(1.5), 0.0, math.sqrt(1.5), None]),
    "INT03_extreme_m": ([-1e308, 0.0, 1e308, None], "minmax(x)", [0.0, 0.5, 1.0, None]),
    "INT09_numeric": ([1.0, None, 2.0], "x * 2", [2.0, None, 4.0]),
    "INT09_text": ([1.0, None, 2.0], "text", ["a", None, "b"]),
    "INT09_literals": ([0.0] * 7, "text", ["None", "NaN", "nan", "inf", "-inf", "", None]),
    "INT09_boolean": ([1.0, None, 2.0], "flag", [True, None, False]),
    "INT09_scalar_boolean": ([1.0, None, 2.0], "True", [True, True, True]),
    "INT09_scalar_null": ([1.0, None, 2.0], "None", [None, None, None]),
    "INT09_fallback": ([1.0, None, 2.0], "where(x == x, x, 7)", [1.0, 7.0, 2.0]),
    "INT09_selected_null": ([1.0, None, 2.0], "where(x == 2, 'two', x)", ["1.0", None, "two"]),
    "INT09_literal_nan": ([1.0, None, 2.0], "where(x == x, x, 'NaN')", ["1.0", "NaN", "2.0"]),
    "INT09_division": ([1.0, 0.0, -0.0, None], "1 / x", [1.0, None, None, None]),
    "INT09_invalid": ([-1.0, 1.0, None], "x ** 0.5", [None, 1.0, None]),
    "INT09_overflow": ([1000.0, 0.0, None], "exp(x)", [None, 1.0, None]),
    "INT09_raw_code": ([1.0, 2.0, 99.0], "x * 2", [2.0, 4.0, 198.0]),
    "INT09_replace": ([1.0, None, 2.0], "x * 2", [2.0, None, 4.0]),
    "INT09_nested": ([1.0, None, 4.0], "sqrt(where(x > 0, x, None))", [1.0, None, 2.0]),
}


@pytest.fixture(scope="module")
def observations(tmp_path_factory):
    location = os.environ.get("DAVIS_EXPRESSION_EVIDENCE_DIR")
    out = Path(location) if location else tmp_path_factory.mktemp("expression-integrity")
    out.mkdir(parents=True, exist_ok=True)
    report = out / "observations.json"
    result = subprocess.run([sys.executable, str(Path(__file__).resolve()), str(out / "workspace"), str(report)],
        cwd=out, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}, capture_output=True, text=True, timeout=180)
    (out / "capture.log").write_text(result.stdout + result.stderr, encoding="utf-8")
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(report.read_text(encoding="utf-8"))


def _same_values(actual, expected):
    assert [v is None for v in actual] == [v is None for v in expected]
    if all(v is None or isinstance(v, (int, float)) for v in expected):
        assert actual == pytest.approx(expected, abs=2e-14, rel=2e-14)
    else:
        assert actual == expected


@pytest.mark.parametrize("name", CASES)
def test_expression_canonical_values_metadata_and_history(observations, name):
    expected = CASES[name][2]
    observed = observations["cases"][name]
    assert observed["preview"]["status"] == observed["apply"]["status"] == 200, observed
    assert observed["preview"]["body"]["valid"] is True
    assert observed["preview_no_write"] is True
    assert observed["get"]["status"] == 200
    column = observed["column"]
    n_valid = sum(v is not None for v in expected)
    n_unique = len({v for v in expected if v is not None})
    numeric = [v for v in expected if isinstance(v, float)]
    expected_dtype = ("Boolean" if any(isinstance(v, bool) for v in expected)
                      else "Float64" if numeric or name.startswith("INT03") else "String")
    for phase in ("current", "revision_2", "redo"):
        snapshot = observed[phase]
        _same_values(snapshot["values"][column], expected)
        assert snapshot["dtypes"][column] == expected_dtype
        arrow_type = snapshot["arrow_types"][column]
        assert arrow_type in {"Boolean": ["bool"], "Float64": ["double"],
                              "String": ["large_string", "string", "string_view"]}[expected_dtype]
        assert snapshot["validity"][column] == [v is not None for v in expected]
        assert snapshot["values"]["__rowId__"] == observed["before"]["values"]["__rowId__"]
        for source_name, source_values in observed["before"]["values"].items():
            if source_name != column:
                assert snapshot["values"][source_name] == source_values
    for phase in ("raw", "revision_1", "undo"):
        assert observed[phase] == observed["before"]
    for phase in ("apply", "get", "redo_get"):
        meta = observed[phase]["body"]
        schema = next(c for c in meta["schema"] if c["name"] == column)
        assert schema["missingCount"] == len(expected) - n_valid
        assert schema["uniqueCount"] == n_unique
        assert schema["uniqueIdCandidate"] == (n_unique == len(expected) and n_valid == len(expected))
        assert schema["constant"] == (n_unique == 1 and n_valid > 0)
        # GET intentionally overlays codebook identities on stored schema.
        # Bind each layer rather than assuming their independently-created IDs
        # were equal at import (the pristine API already differs here).
        assert schema["columnId"] == observed["schema_column_id" if phase == "apply" else "column_id"]
        if numeric and len(numeric) == n_valid:
            assert schema["min"] == pytest.approx(min(numeric), abs=2e-14)
            assert schema["max"] == pytest.approx(max(numeric), abs=2e-14)
    if observed["mode"] == "replace":
        assert observed["column_id"] == observed["source_column_id"]
        assert observed["schema_column_id"] == observed["source_schema_id"]
    assert observed["codebook_column_id"] == observed["column_id"]
    preview_expected = [round(v, 4) if isinstance(v, float)
                        else None if v is None else str(v) for v in expected]
    assert observed["preview"]["body"]["previewValues"] == preview_expected
    for phase in ("preview", "apply"):
        stats = observed[phase]["body"]["stats"] if phase == "preview" else observed[phase]["body"]["createdColumn"]["stats"]
        assert stats["count"] == n_valid
        assert stats["nullCount"] == len(expected) - n_valid
        if numeric and len(numeric) == n_valid:
            assert stats["min"] == round(min(numeric), 4)
            assert stats["max"] == round(max(numeric), 4)
    if "imputation" in observed:
        assert observed["imputation"]["status"] == 200, observed["imputation"]
        assert observed["imputation"]["body"]["beforeStats"]["missingCount"] == len(expected) - n_valid
    assert observed["undo_response"]["status"] == observed["redo_response"]["status"] == 200
    assert observed["apply"]["body"]["dataRevision"] == 2
    assert observed["undo_response"]["body"]["currentDataRevision"] == 3
    assert observed["redo_response"]["body"]["currentDataRevision"] == 4
    assert observed["undo_get"]["body"]["dataRevision"] == 3
    assert observed["redo_get"]["body"]["dataRevision"] == 4
    assert {c["name"]: c["columnId"] for c in observed["undo_get"]["body"]["schema"]} == observed["before_column_ids"]
    assert observed["provenance"]["operations"][1]["operation"] == "calculate"
    if name == "INT09_raw_code":
        spec = next(c for c in observed["codebook"]["columns"] if c["name"] == "x")
        assert spec["missingCodes"] == ["99"]


def test_rejections_leave_all_canonical_files_unchanged(observations):
    for rejected in observations["rejections"]:
        assert rejected["status"] == rejected["expected_status"], rejected
        assert rejected["no_write"] is True


def _capture(workspace: Path, report: Path):
    assert not any(name == "app" or name.startswith("app.") for name in sys.modules)
    assert not workspace.exists(), "Evidence must use a fresh isolated workspace"
    os.environ["DAVIS_PCP_WORKSPACE"] = str(workspace.resolve())
    sys.path.insert(0, str(BACKEND))
    import importlib.metadata
    import io
    import polars as pl
    from fastapi.testclient import TestClient
    from app.api import datasets
    from app.main import app
    from app.config import settings
    from app.storage.dataset_store import DatasetStore

    assert settings.workspace_dir.resolve() == workspace.resolve()
    record = {"cases": {}, "rejections": [], "source_bindings": {}, "store_bindings": {},
              "dependencies": {}, "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
    for package in ("numpy", "polars", "pyarrow", "fastapi", "starlette", "pydantic", "httpx"):
        dist = importlib.metadata.distribution(package)
        record["dependencies"][package] = {"version": dist.version, "location": str(dist.locate_file("")),
            "metadata_sha256": hashlib.sha256((dist.read_text("METADATA") or "").encode()).hexdigest()}

    def save_frame(frame):
        arrow = frame.to_arrow()
        return {"values": frame.to_dict(as_series=False), "validity": {
            c: arrow[c].is_valid().to_pylist() for c in frame.columns},
            "dtypes": {c: str(frame[c].dtype) for c in frame.columns},
            "arrow_types": {c: str(arrow[c].type) for c in frame.columns}}

    def files():
        return {str(p.relative_to(workspace)): hashlib.sha256(p.read_bytes()).hexdigest()
                for p in workspace.rglob("*") if p.is_file()}

    def request(method, path, body=None, **kwargs):
        response = client.request(method, "/api/v1" + path, json=body, **kwargs)
        try:
            payload = response.json()
        except ValueError:
            payload = response.text
        return {"status": response.status_code, "body": payload}

    def expectations(meta):
        return {"expectedDataRevision": meta["dataRevision"], "expectedSchemaRevision": meta["schemaRevision"]}

    with TestClient(app, raise_server_exceptions=False) as client:
        for name, (values, expression, expected) in CASES.items():
            n = len(values)
            text = ["a", None, "b"] if n == 3 else [f"label-{i}" for i in range(n)]
            if name == "INT09_literals":
                text = expected
            flag = [True, None, False] if n == 3 else [True] * n
            frame = pl.DataFrame({"x": pl.Series(values, dtype=pl.Float64),
                "text": pl.Series(text, dtype=pl.String), "flag": pl.Series(flag, dtype=pl.Boolean),
                "unrelated": pl.Series([None] * n, dtype=pl.String)})
            binary = io.BytesIO()
            frame.write_parquet(binary)
            imported = request("POST", "/datasets/import", files={"file": (name + ".parquet", binary.getvalue())})
            assert imported["status"] == 200, imported
            ds = imported["body"]["datasetId"]
            root = "/datasets/" + ds
            if name == "INT09_raw_code":
                cb = request("GET", root + "/codebook")["body"]
                spec = next(c for c in cb["columns"] if c["name"] == "x")
                patched = request("PUT", root + "/codebook", {"columns": [{"columnId": spec["columnId"], "missingCodes": ["99"]}],
                    "expectedSchemaRevision": cb["schemaRevision"]})
                assert patched["status"] == 200, patched
            before_meta = request("GET", root)["body"]
            before_stored_meta = datasets.store.get_meta(ds)
            before = save_frame(datasets.store.get_dataframe(ds))
            mode = "replace" if name == "INT09_replace" else "create"
            column = "x" if mode == "replace" else "result"
            body = {"expression": expression, "columnName": column, "mode": mode}
            before_files = files()
            preview = request("POST", root + "/calculate/preview", body)
            preview_no_write = files() == before_files
            applied = request("POST", root + "/calculate", {**body, **expectations(before_meta)})
            result = {"dataset_id": ds, "column": column, "mode": mode, "preview": preview,
                "preview_no_write": preview_no_write, "apply": applied, "before": before,
                "source_column_id": next(c["columnId"] for c in before_meta["schema"] if c["name"] == "x"),
                "source_schema_id": next(c["columnId"] for c in before_stored_meta["schema"] if c["name"] == "x"),
                "before_column_ids": {c["name"]: c["columnId"] for c in before_meta["schema"]},
                "input_sha256": hashlib.sha256(binary.getvalue()).hexdigest()}
            record["cases"][name] = result
            if applied["status"] != 200:
                continue
            result["get"] = request("GET", root)
            result["column_id"] = next(c["columnId"] for c in result["get"]["body"]["schema"] if c["name"] == column)
            result["stored_meta"] = datasets.store.get_meta(ds)
            result["schema_column_id"] = next(c["columnId"] for c in result["stored_meta"]["schema"] if c["name"] == column)
            result["codebook"] = request("GET", root + "/codebook")["body"]
            result["codebook_column_id"] = next(c["columnId"] for c in result["codebook"]["columns"] if c["name"] == column)
            result["current"] = save_frame(datasets.store.get_dataframe(ds))
            result["raw"] = save_frame(datasets.store.read_raw(ds))
            result["revision_1"] = save_frame(datasets.store.read_snapshot(ds, 1))
            result["revision_2"] = save_frame(datasets.store.read_snapshot(ds, 2))
            if (any(v is None for v in expected) and any(isinstance(v, float) for v in expected)
                    and all(v is None or isinstance(v, float) for v in expected)):
                result["imputation"] = request("POST", root + "/impute/preview", {"column": column, "strategy": "mean"})
            undo = request("POST", root + "/undo", expectations(result["get"]["body"]))
            result["undo_response"] = undo
            result["undo"] = save_frame(datasets.store.get_dataframe(ds))
            result["undo_get"] = request("GET", root)
            redo = request("POST", root + "/redo", expectations(result["undo_get"]["body"]))
            result["redo_response"] = redo
            result["redo"] = save_frame(datasets.store.get_dataframe(ds))
            result["redo_get"] = request("GET", root)
            result["provenance"] = datasets.store.load_provenance(ds)

        # Validate real-route rejection behavior on the last disposable dataset.
        meta = request("GET", root)["body"]
        base = {"expression": "x + 1", "columnName": "rejected", "mode": "create", **expectations(meta)}
        for payload, status in [({**base, "expectedDataRevision": meta["dataRevision"] + 1}, 409),
                                ({**base, "columnName": "x"}, 409),
                                ({**base, "columnName": "missing", "mode": "replace"}, 409),
                                ({**base, "expression": "x +"}, 400),
                                ({**base, "expression": "unknown + 1"}, 400)]:
            before_files = files()
            rejected = request("POST", root + "/calculate", payload)
            record["rejections"].append({**rejected, "expected_status": status, "no_write": files() == before_files})

    for name, module in list(sys.modules.items()):
        if name == "app" or name.startswith("app."):
            source = getattr(module, "__file__", None)
            if source:
                source = Path(source).resolve()
                assert source.is_relative_to(BACKEND), (name, source)
                record["source_bindings"][name] = {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
            for attr, value in vars(module).items():
                if isinstance(value, DatasetStore):
                    assert value.root.resolve() == workspace.resolve() / "datasets"
                    record["store_bindings"][f"{name}.{attr}"] = str(value.root)
    assert record["store_bindings"]

    def clean(value):
        if isinstance(value, float) and not math.isfinite(value):
            return {"nonfinite": str(value)}
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items()}
        if isinstance(value, list):
            return [clean(v) for v in value]
        return value
    report.write_text(json.dumps(clean(record), ensure_ascii=False, allow_nan=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    _capture(Path(sys.argv[1]), Path(sys.argv[2]))
