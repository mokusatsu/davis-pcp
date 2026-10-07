"""CSV records survive real import, including all-empty responses (INT-01)."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest


BACKEND = Path(__file__).resolve().parents[2]
# Expected values are the intended record sequences, not another CSV parser.
AUDIT_CSV = b'q1,q2\n1,10\n,\n2,20\n"",""\n3,30\n'
AUDIT_VALUES = {"q1": [1, None, 2, None, 3], "q2": [10, None, 20, None, 30]}
CASES = {
    "audit_lf": (AUDIT_CSV, {}, AUDIT_VALUES),
    "audit_crlf": (AUDIT_CSV.replace(b"\n", b"\r\n"), {}, AUDIT_VALUES),
    "blank_lines_and_quotes_lf": (
        b'\nlabel,q\n\n"first,\n\nline",1\n,\n"say ""yes""",2\n"",""\n\n', {},
        {"label": ["first,\n\nline", None, 'say "yes"', None], "q": [1, None, 2, None]},
    ),
    "blank_lines_and_quotes_crlf": (
        b'\r\nlabel,q\r\n\r\n"first,\r\n\r\nline",1\r\n,\r\n"say ""yes""",2\r\n"",""\r\n\r\n', {},
        {"label": ["first,\r\n\r\nline", None, 'say "yes"', None], "q": [1, None, 2, None]},
    ),
    "no_header_first_empty": (
        b'\n,\n1,10\n"",""', {"hasHeader": False},
        {"col_0": [None, 1, None], "col_1": [None, 10, None]},
    ),
    "single_column": (b'q\n\n""\n1\n"  "\n', {}, {"q": [None, 1, None]}),
    "all_records_empty": (b'q1,q2\n,\n"",""\n', {}, {"q1": [None, None], "q2": [None, None]}),
    "whitespace_fields": (b'q1,q2\n , \n\t,\t\n1,10\n', {}, {"q1": [None, None, 1], "q2": [None, None, 10]}),
    "custom_missing_tokens": (
        b'q1,q2\nNA,NA\nMISS,miss\n"",""\n', {"missingTokens": ["MISS"]},
        {"q1": ["NA", None, ""], "q2": ["NA", None, ""]},
    ),
    "no_missing_tokens": (
        b'q1,q2\n,\n"",""\nNA,NULL\n', {"missingTokens": []},
        {"q1": ["", "", "NA"], "q2": ["", "", "NULL"]},
    ),
    "valid_custom_syntax": (
        b"code;value\r\n'001';'1,5'\r\n'002';'2,5'\r\n",
        {"delimiter": ";", "quote": "'", "decimalSeparator": ","},
        {"code": ["001", "002"], "value": [1.5, 2.5]},
    ),
}
REJECTIONS = {
    "only_blank_lines": (b"\n\r\n\n", "IMPORT_EMPTY_FILE"),
    "ragged_values": (b"q1,q2\n1\n", "IMPORT_MALFORMED_ROW"),
    "ragged_quoted_empty": (b'q1,q2\n""\n', "IMPORT_MALFORMED_ROW"),
}


@pytest.fixture(scope="module")
def imported_records(tmp_path_factory):
    # A fresh process sets the workspace before any app import; no route or
    # store substitutions can hide which parser and canonical writer ran.
    out = tmp_path_factory.mktemp("csv-records")
    report = out / "observations.json"
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), str(out / "workspace"), str(report)],
        cwd=out, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(report.read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", CASES)
def test_import_retains_record_sequence_and_generated_ids(imported_records, name):
    expected = CASES[name][2]
    count = len(next(iter(expected.values())))
    expected_ids = [f"ROW-{i:06d}" for i in range(1, count + 1)]
    actual = imported_records["cases"][name]
    assert actual["import_status"] == 200, actual
    assert actual["get_status"] == 200, actual
    for meta in (actual["import_meta"], actual["get_meta"]):
        assert meta["rowCount"] == count
        assert meta["rowIdentity"] == "generated"
        assert meta["columnCount"] == len(expected)
        schema = {column["name"]: column for column in meta["schema"]}
        for column, values in expected.items():
            assert schema[column]["missingCount"] == values.count(None)
    for generation in ("current", "raw", "revision_1"):
        saved = actual[generation]
        assert saved["values"] == {"__rowId__": expected_ids, **expected}
        # Check Arrow validity as well as decoded Python values.
        for column, values in expected.items():
            assert saved["validity"][column] == [value is not None for value in values]


@pytest.mark.parametrize("name", REJECTIONS)
def test_empty_file_and_ragged_record_rejections(imported_records, name):
    actual = imported_records["rejections"][name]
    assert actual["status"] == 400, actual
    assert actual["body"]["error"]["code"] == REJECTIONS[name][1]
    assert actual["dataset_count_after"] == actual["dataset_count_before"]


def _capture_imports(workspace: Path, report: Path) -> None:
    assert not any(name == "app" or name.startswith("app.") for name in sys.modules)
    os.environ["DAVIS_PCP_WORKSPACE"] = str(workspace.resolve())
    sys.path.insert(0, str(BACKEND))

    from fastapi.testclient import TestClient
    from app.api import datasets
    from app.config import settings
    from app.main import app
    from app.storage.dataset_store import DatasetStore

    assert settings.workspace_dir.resolve() == workspace.resolve()
    bindings = {}
    modules = {}
    for name, module in list(sys.modules.items()):
        if name == "app" or name.startswith("app."):
            if getattr(module, "__file__", None):
                source = Path(module.__file__).resolve()
                assert source.is_relative_to(BACKEND), (name, source)
                modules[name] = {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest()}
            for attr, value in vars(module).items():
                if isinstance(value, DatasetStore):
                    assert value.root.resolve() == workspace.resolve() / "datasets"
                    bindings[f"{name}.{attr}"] = str(value.root)
    assert bindings
    observed = {"cases": {}, "rejections": {}, "module_sources": modules, "store_bindings": bindings}

    def saved(frame):
        return {"values": frame.to_dict(as_series=False), "validity": {
            column: frame.to_arrow()[column].is_valid().to_pylist() for column in frame.columns
        }}

    with TestClient(app, raise_server_exceptions=False) as client:
        for name, (raw, options, _) in CASES.items():
            response = client.post("/api/v1/datasets/import", files={"file": (name + ".csv", raw)},
                                   data={"options_json": json.dumps(options)})
            actual = {"import_status": response.status_code, "import_meta": response.json(),
                      "input_sha256": hashlib.sha256(raw).hexdigest(), "options": options}
            observed["cases"][name] = actual
            if response.status_code == 200:
                dataset_id = actual["import_meta"]["datasetId"]
                current = client.get(f"/api/v1/datasets/{dataset_id}")
                actual.update(get_status=current.status_code, get_meta=current.json(),
                              current=saved(datasets.store.get_dataframe(dataset_id)),
                              raw=saved(datasets.store.read_raw(dataset_id)),
                              revision_1=saved(datasets.store.read_snapshot(dataset_id, 1)))
        for name, (raw, _) in REJECTIONS.items():
            before = len(datasets.store.list_datasets())
            response = client.post("/api/v1/datasets/import", files={"file": (name + ".csv", raw)})
            observed["rejections"][name] = {
                "status": response.status_code, "body": response.json(),
                "dataset_count_before": before, "dataset_count_after": len(datasets.store.list_datasets()),
            }
    report.write_text(json.dumps(observed, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    _capture_imports(Path(sys.argv[1]), Path(sys.argv[2]))
