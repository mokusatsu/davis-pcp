"""Real-sample campaign acceptance through native and Pyodide ASGI.

Uses a fresh isolated workspace; never a browser's or user's saved workspace.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import sys
import time
from pathlib import Path


async def run_acceptance(output_path: str) -> dict:
    if sys.platform != "emscripten":
        import tempfile

        supplied = os.environ.get("DAVIS_PCP_WORKSPACE")
        if supplied:
            workspace = Path(supplied).resolve()
            if workspace.exists() and any(workspace.iterdir()):
                raise RuntimeError("Use a new empty DAVIS_PCP_WORKSPACE; this test edits built-in codebooks.")
        else:
            temporary_root = Path(__file__).resolve().parents[1] / ".temp" / "sample-campaign"
            temporary_root.mkdir(parents=True, exist_ok=True)
            workspace = Path(tempfile.mkdtemp(prefix="runtime-", dir=temporary_root))
        os.environ["DAVIS_PCP_WORKSPACE"] = str(workspace)
    if sys.platform == "emscripten":
        import anyio.to_thread
        import starlette.concurrency

        async def no_threads(function, *args, **kwargs):
            return function(*args, **kwargs)

        anyio.to_thread.run_sync = no_threads
        starlette.concurrency.run_in_threadpool = no_threads
    import httpx
    import numpy as np
    from app.main import app
    from app.config import settings
    from app.storage.dataset_store import DatasetStore
    from app.algorithms.models.factor_analysis_ml import _initial_psi
    from app.domain.sparse_pca_frame import prepare_sparse_pca_frame
    from app.domain.sparse_pca_contracts import SparsePcaRequest
    from app.services.factor_analysis_service import prepare_efa_frame

    settings.ensure_dirs()
    store = DatasetStore()
    checks = []
    timings = {}
    arrow_views = Path(output_path).parent / "arrow-views"
    arrow_views.mkdir(parents=True, exist_ok=True)
    arrow_expectations = []
    # A small typed boundary fixture checks the actual WASM Arrow bridge;
    # Python-list inference must not erase all-null types or integer widths.
    import pyarrow as pa
    import pyarrow.parquet as pq
    import polars as pl
    from decimal import Decimal

    def unavailable_native_reader(*_args, **_kwargs):
        raise AttributeError("test the Arrow fallback")

    def read_arrow_fallback(path, columns=None):
        # Exercise the same bridge on native and WASM. Native Polars and
        # Arrow differ for a few Parquet logical types (e.g. date64/time32).
        native_reader = pl.read_parquet
        try:
            pl.read_parquet = unavailable_native_reader
            return store._read_parquet(path, columns)
        finally:
            pl.read_parquet = native_reader

    typed_path = settings.workspace_dir / "typed-reader-check.parquet"
    typed_table = pa.table({"i32": pa.array([1, None], type=pa.int32()),
                           "f32": pa.array([None, None], type=pa.float32()),
                           "text": pa.array([None, None], type=pa.string()),
                           "flag": pa.array([True, None], type=pa.bool_()),
                           "bytes": pa.array([b"\xff\x00", None], type=pa.binary()),
                           "decimal": pa.array([Decimal("1.23"), None], type=pa.decimal128(10, 2)),
                           "stamp": pa.array([1728086400000000001, None], type=pa.timestamp("ns", tz="Asia/Tokyo")),
                           "duration": pa.array([1, None], type=pa.duration("ns")),
                           "time": pa.array([1, None], type=pa.time64("ns"))})
    pq.write_table(typed_table, typed_path)
    typed = read_arrow_fallback(typed_path)
    assert {key: str(value) for key, value in typed.select("i32", "f32", "text", "flag").schema.items()} == {
        "i32": "Int32", "f32": "Float32", "text": "String", "flag": "Boolean"}
    assert typed.shape == (2, 9) and typed["i32"].to_list() == [1, None]
    assert typed.schema["decimal"] == pl.Decimal(10, 2)
    assert typed.schema["stamp"] == pl.Datetime("ns", "Asia/Tokyo")
    assert typed.schema["duration"] == pl.Duration("ns") and typed.schema["time"] == pl.Time
    assert read_arrow_fallback(typed_path, columns=[]).shape == (0, 0)
    decoded_typed = typed.to_arrow()
    for name in ("i32", "f32", "text", "flag", "bytes", "decimal"):
        assert decoded_typed[name].to_pylist() == typed_table[name].to_pylist()
    for name in ("stamp", "duration", "time"):
        assert decoded_typed[name].cast(pa.int64()).to_pylist() == typed_table[name].cast(pa.int64()).to_pylist()
    checks.append("parquet:typed_all_null_and_empty_projection_native_wasm_parity")
    from app.api.datasets import _serialize_dataframe_to_arrow_bytes
    nested_temporal = [
        ("list_timestamp", pa.list_(pa.timestamp("ns")), [[1, None, -123], None, []]),
        ("nested_time", pa.list_(pa.list_(pa.time64("ns"))), [[[1, None], None, []], None, []]),
        ("fixed_duration", pa.list_(pa.duration("ns"), 2), [[1, None], [None, None], [-123, 123]]),
        ("struct_timezone", pa.struct([("stamp", pa.timestamp("ns", tz="Asia/Tokyo")), ("text", pa.string())]),
         [{"stamp": -1, "text": "長い文字列の確認"}, None, {"stamp": 123, "text": None}]),
        ("list_struct", pa.list_(pa.struct([("stamp", pa.timestamp("s")), ("text", pa.string())])),
         [[{"stamp": -1, "text": "Łódź"}, None], None, [{"stamp": 123, "text": None}]]),
        ("struct_list", pa.struct([("stamp", pa.list_(pa.timestamp("ns"))), ("text", pa.string())]),
         [{"stamp": [-1, None], "text": "value"}, None, {"stamp": [], "text": None}]),
        ("large_list", pa.large_list(pa.timestamp("ns")), [[1, None, -123], None, []]),
        ("nested_date64", pa.list_(pa.date64()), [[0, None, -86400000], None, []]),
        ("date32_range", pa.date32(), [4000000, None, -4000000]),
        ("nested_date32_range", pa.list_(pa.date32()), [[4000000, None], None, [-4000000]]),
        ("nested_decimal_precision", pa.list_(pa.decimal128(38, 18)),
         [[Decimal("12345678901234567890.123456789012345678"), None], None,
          [Decimal("0.000000000000000001"), Decimal("-0.000000000000000001")]]),
    ]
    for name, arrow_type, values in nested_temporal:
        path = settings.workspace_dir / f"typed-{name}.parquet"
        pq.write_table(pa.table({"value": pa.array(values, type=arrow_type), "label": ["row1", None, "row3"]}), path)
        source = pq.read_table(path)
        frame = read_arrow_fallback(path)
        assert frame.schema == pl.from_arrow(source.slice(0, 0)).schema
        for actual, expected in ((frame, source),
                (frame.filter(pl.Series([True, False, True])), source.take(pa.array([0, 2])))):
            decoded = pa.ipc.open_stream(_serialize_dataframe_to_arrow_bytes(actual)).read_all()
            assert decoded.column_names == expected.column_names
            # Compare Arrow buffers/logical values, never lossy Python dates.
            for column in expected.column_names:
                assert decoded[column].cast(expected[column].type).equals(expected[column]), (name, column)
        checks.append("parquet:typed_container_exact_" + name)
    # Some PyArrow Parquet versions cannot read a null fixed-size-list
    # parent they wrote themselves. Test that Arrow bridge input directly,
    # separately from the non-null-parent real-file control above.
    fixed_null = pa.table({"value": pa.array([[1, None], None, [-123, 123]],
                                           type=pa.list_(pa.duration("ns"), 2))})
    native_read, arrow_read = pl.read_parquet, pq.read_table
    try:
        pl.read_parquet = unavailable_native_reader
        pq.read_table = lambda *_args, **_kwargs: fixed_null
        frame = store._read_parquet(settings.workspace_dir / "fixed-null-bridge.parquet")
    finally:
        pl.read_parquet, pq.read_table = native_read, arrow_read
    decoded = pa.ipc.open_stream(_serialize_dataframe_to_arrow_bytes(frame)).read_all()
    assert decoded["value"].cast(fixed_null["value"].type).equals(fixed_null["value"])
    checks.append("arrow_bridge:fixed_temporal_null_parent_exact")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver/api/v1/") as client:
        samples = (await client.get("datasets/samples")).json()["samples"]
        assert len(samples) == 12
        for sample in samples:
            imported = await client.post("datasets/import/sample", json={"sampleId": sample["id"]})
            assert imported.status_code == 200, imported.text
            meta = imported.json()
            did = meta["datasetId"]
            frame = store.get_dataframe(did)
            book = store.load_codebook(did)
            assert frame.height == sample["rowCount"] and len(book["columns"]) == sample["columnCount"]
            summary = await client.post("summaries", json={"datasetId": did, "weightMode": "none"})
            assert summary.status_code == 200, summary.text
            assert summary.json()["rowCount"] == sample["rowCount"]
            ids = frame["__rowId__"].to_list()
            exported = await client.post("exports", json={"datasetId": did, "scope": "selected", "rowIds": ids[:3], "format": "csv"})
            assert exported.status_code == 200, exported.text
            rows = list(csv.reader(io.StringIO(exported.content.decode("utf-8-sig"))))
            assert len(rows) == 4 and all(len(row) == sample["columnCount"] for row in rows)
            checks.append(f"{sample['id']}:import_summary_selected_csv")

            # A Parquet read followed by Arrow export is a distinct ABI
            # boundary: values/schema checks alone cannot detect bad buffers.
            view = await client.post(f"datasets/{did}/view", json={})
            assert view.status_code == 200, view.text
            decoded = pa.ipc.open_stream(view.content).read_all()
            assert decoded.to_pydict() == frame.to_dict(as_series=False)
            (arrow_views / f"{sample['id']}.arrow").write_bytes(view.content)
            arrow_expectations.append({"sampleId": sample["id"], "columns": frame.columns,
                                       "values": frame.to_dict(as_series=False)})
            chosen = frame.columns[-2:][::-1]
            projected = await client.post(f"datasets/{did}/view", json={
                "columns": chosen, "rowIds": ids[:3][::-1]})
            assert projected.status_code == 200, projected.text
            decoded = pa.ipc.open_stream(projected.content).read_all()
            expected_columns = list(dict.fromkeys(["__rowId__", *chosen]))
            assert decoded.column_names == expected_columns
            assert decoded.to_pydict() == frame.head(3).select(expected_columns).to_dict(as_series=False)
            exported = await client.post("exports", json={"datasetId": did,
                "scope": "selected", "rowIds": ids[:3], "format": "arrow"})
            assert exported.status_code == 200, exported.text
            assert pa.ipc.open_stream(exported.content).read_all().to_pydict() == frame.head(3).drop("__rowId__").to_dict(as_series=False)
            checks.append(f"{sample['id']}:fresh_parquet_arrow_view_projection_export")
            if sample["id"] == "iris":
                native_writer = pl.DataFrame.write_parquet
                try:
                    pl.DataFrame.write_parquet = unavailable_native_reader
                    exported = await client.post("exports", json={"datasetId": did,
                        "scope": "selected", "rowIds": ids[:3], "format": "parquet"})
                finally:
                    pl.DataFrame.write_parquet = native_writer
                assert exported.status_code == 200, exported.text
                decoded = pq.read_table(io.BytesIO(exported.content))
                assert decoded.to_pydict() == frame.head(3).drop("__rowId__").to_dict(as_series=False)
                checks.append("iris:forced_parquet_writer_fallback_selected_export")

        # Exercise the actual static history reader, not a native-only stand-in.
        did = "ds-builtin-iris"
        original = store.get_dataframe(did)
        original_license = store.load_codebook(did)["licenseText"]
        transformed = await client.post(f"datasets/{did}/transform", json={"type": "binning",
            "source_column": "sepal_length_cm", "options": {"method": "equal_width", "num_bins": 4,
            "output_column_name": "sepal_length_cm_bin4"}})
        assert transformed.status_code == 200, transformed.text
        transformed_frame = store.get_dataframe(did)
        assert transformed_frame.width == original.width + 1
        for operation, payload, expected, revision in (("undo", {}, original, 3),
                ("redo", {}, transformed_frame, 4), ("revert", {"targetDataRevision": 1}, original, 5)):
            restored = await client.post(f"datasets/{did}/{operation}", json=payload)
            assert restored.status_code == 200, restored.text
            assert store.get_dataframe(did).equals(expected)
            assert store.get_meta(did)["dataRevision"] == revision
            assert store.load_codebook(did)["licenseText"] == original_license
            view = await client.post(f"datasets/{did}/view", json={})
            assert view.status_code == 200, view.text
            assert pa.ipc.open_stream(view.content).read_all().to_pydict() == expected.to_dict(as_series=False)
        assert store.read_raw(did).equals(original)
        assert store.read_raw(did).to_arrow().to_pydict() == original.to_dict(as_series=False)
        checks.append("iris:bin_undo_redo_revert_exact_values_ids_license")

        did = "ds-builtin-kakegawa-citizen2022-adult600"
        original = store.get_dataframe(did)
        original_license = store.load_codebook(did)["licenseText"]
        column = "問20_満足度_01"
        request = {"columns": [column], "predictorColumns": [], "strategy": "mode"}
        preview_response = await client.post(f"datasets/{did}/impute/preview", json=request)
        assert preview_response.status_code == 200, preview_response.text
        preview = preview_response.json()
        assert preview["beforeStats"]["missingCount"] == 258
        assert preview["diagnostics"]["imputedCounts"][column] == 258
        applied = await client.post(f"datasets/{did}/impute", json={**request, "planHash": preview["planHash"]})
        assert applied.status_code == 200, applied.text
        assert applied.json()["outputHashes"][column] == preview["perColumn"][0]["valuesHash"]
        expected_ids = {rid for rid, value in original.select("__rowId__", column).rows() if value in (0, 5)}
        entries = store.load_mask(did)["entries"]
        assert len(entries) == 258 and {entry["rowId"] for entry in entries} == expected_ids
        after = store.get_dataframe(did)
        assert after.drop(column).equals(original.drop(column))
        assert after[column].to_list() == [2 if value in (0, 5) else value for value in original[column]]
        restored = await client.post(f"datasets/{did}/undo", json={})
        assert restored.status_code == 200, restored.text
        assert store.get_dataframe(did).equals(original) and store.load_mask(did)["entries"] == []
        assert store.load_codebook(did)["licenseText"] == original_license
        checks.append("kakegawa:preview_apply258_exact_hash_mask_undo")

        book = store.load_codebook(did)
        names = [f"問20_満足度_0{i}" for i in (1, 2, 3)]
        specs = [next(c for c in book["columns"] if c["name"] == name) for name in names]
        for reverse in (False, True):
            updated = await client.put(f"datasets/{did}/codebook", json={"columns": [
                {"columnId": specs[0]["columnId"], "categoryOrder": ["1", "2", "3"], "isReversed": reverse}]})
            assert updated.status_code == 200, updated.text
            body = {"datasetId": did, "columns": names[:1]}
            summary = (await client.post("summaries", json=body)).json()["columns"][names[0]]
            fedf = (await client.post("distribution/fedf", json=body)).json()["statistics"][names[0]]
            expected = 1.6564625850340136 if reverse else 2.3435374149659864
            assert summary["count"] == summary["denominators"]["valid"] == fedf["validCount"] == 294
            assert abs(summary["mean"] - expected) < 1e-12 and abs(fedf["mean"] - expected) < 1e-12
            checks.append(f"kakegawa:closed_ordinal_reverse={reverse}:summary_fedf294")
        updated = await client.put(f"datasets/{did}/codebook", json={"columns": [
            {"columnId": c["columnId"], "categoryOrder": ["1", "2", "3"], "scaleType": "interval", "isReversed": False}
            for c in specs]})
        assert updated.status_code == 200, updated.text
        meta = store.get_meta(did)
        book = store.load_codebook(did)
        frame = store.get_dataframe(did)
        context = {"datasetId": did, "expectedDataRevision": meta["dataRevision"],
                   "expectedSchemaRevision": book["schemaRevision"], "weightMode": "none"}
        sparse = prepare_sparse_pca_frame(SparsePcaRequest.model_validate({"context": context,
            "variables": [{"columnId": c["columnId"], "kind": "numeric"} for c in specs], "nComponents": 1}),
            meta=meta, codebook=book, data=frame, mask={}, mask_revision=0)
        efa = prepare_efa_frame(did, {"context": context, "variables": [
            {"columnId": c["columnId"], "measurement": "continuous", "treatment": "continuous"} for c in specs]}, store)
        assert len(sparse.row_ids) == len(efa["fitIds"]) == 200
        assert set(sparse.row_ids) == set(efa["fitIds"])
        assert np.isfinite(sparse.values).all() and np.isfinite(efa["contVals"][efa["fitIndex"]]).all()
        checks.append("kakegawa:closed_interval_sparse_efa_same200_finite")

        for sample in ("edss-efa-613x13", "edss-cfa-646x13", "atopp-541x31"):
            did = "ds-builtin-" + sample
            frame = store.get_dataframe(did)
            names = [c["name"] for c in store.load_codebook(did)["columns"][:6]]
            r = np.corrcoef(frame.select(names).to_numpy(), rowvar=False)
            expected = np.clip((1 - .5 / len(r)) / np.diag(np.linalg.inv(r)), .005, 1)
            np.testing.assert_allclose(_initial_psi(r, 1, .005), expected, atol=1e-12, rtol=1e-12)
            checks.append(sample + ":ml_initial_uniqueness")

        # Exercise all 28 ordinal items against independently generated R
        # references, including the adaptive integration path in real WASM.
        reference_path = os.environ.get("SAMPLE_CAMPAIGN_TURKIYE_REFERENCE")
        if reference_path is None:
            reference_path = str(Path(__file__).resolve().parents[1] /
                "fullstack/backend/tests/fixtures/turkiye_r_reference/references.json")
        reference = json.loads(Path(reference_path).read_text())
        did = "ds-builtin-" + reference["sampleId"]
        book = store.load_codebook(did)
        payload = {"context": {"datasetId": did, "expectedDataRevision": 1,
                "expectedSchemaRevision": book["schemaRevision"], "weightMode": "none"},
            "variables": [{"columnId": spec["columnId"], "measurement": "ordinal",
                "treatment": "ordinal", "categoryOrder": spec["categoryOrder"]}
                for spec in book["columns"]],
            "correlation": "polychoric", "extraction": "minres", "nFactors": 3,
            "rotation": "none", "scoreMethod": "none", "parallelAnalysis": {"enabled": False},
            "nStarts": 3, "maxIterations": 1000, "uniquenessLower": .005, "seed": 19}
        for mode in ("pearson", "polychoric"):
            config = {**payload, "correlation": mode,
                "extraction": "ml" if mode == "pearson" else "minres",
                "variables": [{**spec, "treatment": "continuous_approximation" if mode == "pearson" else "ordinal",
                    "approximationAcknowledged": mode == "pearson"} for spec in payload["variables"]]}
            started = time.perf_counter()
            response = await client.post("models/factor-analysis", json=config)
            timings["turkiye_full28_" + mode] = time.perf_counter() - started
            assert response.status_code == 200, response.text
            result = response.json()
            assert result["meta"]["fitCount"] == 600
            assert result["summary"]["solutionStatus"] == "admissible"
            expected = reference[mode]
            details = result["details"]
            np.testing.assert_allclose(details["sampleCorrelation"], expected["sampleCorrelation"],
                                       atol=1e-12 if mode == "pearson" else 1e-6, rtol=0)
            for key in ("uniqueness", "reproducedCorrelation"):
                np.testing.assert_allclose(details[key], expected[key], atol=1e-5, rtol=0)
            assert abs(result["summary"]["objective"]["value"] - expected["metrics"]["objective"]) < 1e-7
            checks.append("turkiye:full28_" + mode + "_independent_R_reference")

        from app.api import factor_analysis
        for index, expression in enumerate(("Q1", "6 - Q1")):
            name = f"Q1_copy_{index}"
            calculated = await client.post(f"datasets/{did}/calculate", json={
                "expression": expression, "columnName": name})
            assert calculated.status_code == 200, calculated.text
            book = store.load_codebook(did)
            spec = next(c for c in book["columns"] if c["name"] == name)
            updated = await client.put(f"datasets/{did}/codebook", json={"columns": [{
                "columnId": spec["columnId"], "role": "question", "scaleType": "ordinal",
                "categoryOrder": ["1", "2", "3", "4", "5"]}]})
            assert updated.status_code == 200, updated.text
            book = store.load_codebook(did)
            config = {**payload, "nFactors": 1, "nStarts": 1,
                "context": {**payload["context"], "expectedDataRevision": store.get_meta(did)["dataRevision"],
                    "expectedSchemaRevision": book["schemaRevision"]},
                "variables": [{"columnId": next(c for c in book["columns"] if c["name"] == name)["columnId"],
                    "measurement": "ordinal", "treatment": "ordinal", "categoryOrder": ["1", "2", "3", "4", "5"]}
                    for name in ("Q1", name, "Q2", "Q3")]}
            saved_results = set((settings.workspace_dir / "analysis-results").iterdir())
            response = await client.post("models/factor-analysis", json=config)
            assert response.status_code == 422, response.text
            error = response.json()["error"]
            assert error["code"] == "FA_CORRELATION_BOUNDARY"
            factor_analysis._attempts.clear()
            attempt = (await client.get("analysis-attempts/" + error["details"]["attemptId"])).json()
            pair = next(pair for pair in attempt["diagnostics"][0]["pairs"] if pair["pair"] == [0, 1])
            assert pair["status"] == "boundary" and pair["integrationError"] <= 1e-10
            assert abs(pair["rho"] - (.9999 if index == 0 else -.9999)) < 1e-6
            assert saved_results == set((settings.workspace_dir / "analysis-results").iterdir())
            checks.append(f"turkiye:copy_sign{index}_boundary_stop_durable_diagnostics")

        from scipy.stats import norm
        from app.algorithms.models.ordinal_correlations import rectangle_probability
        tail, error = rectangle_probability(9, 10, 9, 10, 0)
        expected_tail = (norm.sf(9) - norm.sf(10)) ** 2
        assert abs(tail / expected_tail - 1) < 1e-12 and error <= 1e-10
        checks.append("polychoric:extreme_positive_tail_survival_probability")
    result = {"runtime": sys.platform, "passed": len(checks), "checks": checks, "timingsSeconds": timings}
    (arrow_views / "expected.json").write_text(json.dumps(arrow_expectations, ensure_ascii=False, allow_nan=False))
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    asyncio.run(run_acceptance(os.environ.get("SAMPLE_CAMPAIGN_OUTPUT", ".temp/sample-campaign/runtime-native.json")))
