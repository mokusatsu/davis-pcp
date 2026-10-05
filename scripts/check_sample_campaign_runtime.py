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
    # A small typed boundary fixture checks the actual WASM Arrow bridge;
    # Python-list inference must not erase all-null types or integer widths.
    import pyarrow as pa
    import pyarrow.parquet as pq
    typed_path = settings.workspace_dir / "typed-reader-check.parquet"
    typed_table = pa.table({"i32": pa.array([1, None], type=pa.int32()),
                           "f32": pa.array([None, None], type=pa.float32()),
                           "text": pa.array([None, None], type=pa.string()),
                           "flag": pa.array([True, None], type=pa.bool_())})
    pq.write_table(typed_table, typed_path)
    typed = store._read_parquet(typed_path)
    assert {key: str(value) for key, value in typed.schema.items()} == {
        "i32": "Int32", "f32": "Float32", "text": "String", "flag": "Boolean"}
    assert typed.shape == (2, 4) and typed["i32"].to_list() == [1, None]
    assert store._read_parquet(typed_path, columns=[]).shape == (0, 0)
    checks.append("parquet:typed_all_null_and_empty_projection_native_wasm_parity")
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
        assert store.read_raw(did).equals(original)
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
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    asyncio.run(run_acceptance(os.environ.get("SAMPLE_CAMPAIGN_OUTPUT", ".temp/sample-campaign/runtime-native.json")))
