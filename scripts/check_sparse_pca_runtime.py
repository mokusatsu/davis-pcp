"""Exercise SparsePCA through the real ASGI API in native Python or Pyodide.

Native: PYTHONPATH=fullstack/backend python scripts/check_sparse_pca_runtime.py
WASM: node scripts/check_sparse_pca_pyodide.mjs /path/to/shipped/pyodide
Only synthetic/public Iris observations are imported into an isolated workspace.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import os
import platform
import sys
import time
from pathlib import Path

import numpy as np
import sklearn
from sklearn.datasets import load_iris
from sklearn.decomposition import SparsePCA


async def run_acceptance(output_path: str) -> dict:
    # The browser bridge uses the same synchronous fallback: WASM has no threads.
    if sys.platform == "emscripten":
        import anyio.to_thread
        import starlette.concurrency

        async def no_threads(function, *args, **kwargs):
            return function(*args, **kwargs)

        anyio.to_thread.run_sync = no_threads
        starlette.concurrency.run_in_threadpool = no_threads

    import httpx
    from app.main import app
    from app.config import settings

    settings.ensure_dirs()
    results = []

    async def checked(client, method, path, **kwargs):
        response = await client.request(method, "/api/v1" + path, **kwargs)
        assert response.status_code == 200, (method, path, response.status_code, response.text)
        return response.json()

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
        matrix = load_iris().data
        source = io.StringIO()
        writer = csv.writer(source)
        writer.writerow(["sepal_length", "sepal_width", "petal_length", "petal_width"])
        writer.writerows(matrix.tolist())
        imported = await checked(client, "POST", "/datasets/import", files={
            "file": ("public-iris.csv", source.getvalue().encode(), "text/csv")})
        did = imported["datasetId"]
        codebook = await checked(client, "GET", f"/datasets/{did}/codebook")
        context = {"datasetId": did, "expectedDataRevision": 1,
                   "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none"}
        variables = [{"columnId": column["columnId"], "kind": "numeric"}
                     for column in codebook["columns"]]
        cases = [
            {"name": "correlation", "preprocessing": "correlation", "alpha": 1.0, "ridgeAlpha": .01, "nComponents": 2},
            {"name": "covariance", "preprocessing": "covariance", "alpha": 1.0, "ridgeAlpha": .01, "nComponents": 2},
            {"name": "zero-alpha-ridge", "preprocessing": "correlation", "alpha": 0.0, "ridgeAlpha": .01, "nComponents": 2},
            {"name": "zero-alpha-no-ridge", "preprocessing": "correlation", "alpha": 0.0, "ridgeAlpha": 0.0, "nComponents": 2},
            {"name": "zero-basis", "preprocessing": "correlation", "alpha": 50.0, "ridgeAlpha": 0.0, "nComponents": 2},
            {"name": "one-component", "preprocessing": "correlation", "alpha": 1.0, "ridgeAlpha": .01, "nComponents": 1},
            {"name": "iteration-limit", "preprocessing": "correlation", "alpha": 1.0, "ridgeAlpha": .01, "nComponents": 2, "maxIterations": 1},
        ]
        for case in cases:
            request = {"context": context, "variables": variables, "maxIterations": 1000,
                       "tolerance": 1e-8, "seed": 0, **{k: v for k, v in case.items() if k != "name"}}
            started = time.perf_counter()
            fit = await checked(client, "POST", "/models/sparse-pca", json=request)
            rid = fit["resultId"]
            k = request["nComponents"]
            axes = ",".join(str(axis) for axis in range(1, k + 1))
            rows = await checked(client, "GET", f"/analysis-results/{rid}/rows?limit=1000&axes={axes}")
            score = np.asarray([row["coordinates"] for row in rows["rows"]])
            # Use the frozen factored preprocessing: this is robust for extreme units too.
            transforms = fit["details"]["preprocessing"]["columns"]
            centered_columns = []
            for index, column in enumerate(transforms):
                with np.errstate(over="ignore", invalid="ignore"):
                    difference = matrix[:, index] - column["inputAnchor"]
                    scaled = difference / column["inputMagnitude"]
                fallback = matrix[:, index] / column["inputMagnitude"] - column["inputAnchor"] / column["inputMagnitude"]
                scaled = np.where(np.isfinite(scaled), scaled, fallback)
                centered_column = scaled - column["normalizedMeanOffset"]
                centered_columns.append(centered_column / column["normalizedSampleSd"]
                    if request["preprocessing"] == "correlation" else centered_column * column["inputMagnitude"])
            z = np.column_stack(centered_columns)
            oracle = SparsePCA(n_components=k, alpha=request["alpha"], ridge_alpha=request["ridgeAlpha"],
                              max_iter=request["maxIterations"], tol=request["tolerance"],
                              random_state=0, n_jobs=1, method="lars").fit(z)
            b = np.asarray(fit["details"]["components"])
            w = np.asarray(fit["details"]["scoreCoefficients"])
            centered = z - np.asarray(fit["details"]["preprocessing"]["estimatorMean"])
            np.testing.assert_allclose(b, oracle.components_, atol=1e-8, rtol=1e-8)
            np.testing.assert_allclose(score, oracle.transform(z), atol=1e-8, rtol=1e-8)
            np.testing.assert_allclose(score, centered @ w, atol=1e-8, rtol=1e-8)
            fraction = 1.0 - np.linalg.norm(centered - score @ b) ** 2 / np.linalg.norm(centered) ** 2
            np.testing.assert_allclose(fit["summary"]["reconstructionFraction"], fraction, atol=1e-10)
            assert rows["axes"] == list(range(1, k + 1))
            assert rows["total"] == 150 and rows["nextOffset"] is None
            assert fit["method"] == "sparse_pca" and not fit["meta"]["weightApplied"]
            assert fit["config"]["solver"] == "lars"
            assert not {"eigenvalues", "explainedVarianceRatio", "kaiserThreshold"}.intersection(fit["summary"])
            again = await checked(client, "GET", f"/analysis-results/{rid}")
            assert again["details"] == fit["details"] and again["summary"] == fit["summary"]
            empty = await checked(client, "GET", f"/analysis-results/{rid}/rows?offset=150&axes=1")
            assert empty["rows"] == [] and empty["total"] == 150
            chosen = [row["rowId"] for row in rows["rows"][:3]]
            selected = await checked(client, "POST", f"/analysis-results/{rid}/select", json={
                "context": {**context, "scope": "selected", "selectedRowIds": chosen[:2]},
                "selector": {"kind": "row_ids", "rowIds": chosen}})
            assert set(selected["rowIds"]) == set(chosen[:2])
            bounds = [[float(score[:, i].min()), float(score[:, i].max())] for i in range(k)]
            rectangle = await checked(client, "POST", f"/analysis-results/{rid}/select", json={
                "context": context, "selector": {"kind": "rectangle", "axes": list(range(1, k + 1)), "bounds": bounds}})
            assert len(rectangle["rowIds"]) == 150
            exports = {}
            for table in ("manifest", "coefficients", "variables", "diagnostics", "rows"):
                for fmt in (("json",) if table == "manifest" else ("json", "csv")):
                    exported = await checked(client, "POST", f"/analysis-results/{rid}/export", json={
                        "table": table, "format": fmt, "limit": 10000})
                    assert exported["encoding"] == "utf-8" and exported["payload"]
                    if fmt == "json":
                        parsed = json.loads(exported["payload"])
                        if table == "manifest":
                            assert parsed["summary"] == fit["summary"]
                            assert parsed["details"] == fit["details"]
                    exports[f"{table}.{fmt}"] = len(exported["payload"])
            denied = await client.post(f"/api/v1/analysis-results/{rid}/export", json={"table": "eigenvalues", "format": "json"})
            assert denied.status_code == 422
            denied = await client.post(f"/api/v1/analysis-results/{rid}/predict", json={"context": context})
            assert denied.status_code == 422
            invalid_axes = await client.get(f"/api/v1/analysis-results/{rid}/rows?axes={k + 1}")
            assert invalid_axes.status_code == 422
            if case["name"] == "iteration-limit":
                assert fit["summary"]["convergence"]["status"] == "iteration_limit"
            if case["name"] == "zero-basis":
                assert not np.count_nonzero(b) and not np.count_nonzero(score)
                assert fit["details"]["scoreCorrelations"] == [[None, None], [None, None]]
            result = {"case": case["name"], "summary": fit["summary"], "components": b.tolist(),
                      "scoreCoefficients": w.tolist(), "firstScores": score[:5].tolist(),
                      "runtime": fit["meta"]["numericalRuntime"], "exports": exports,
                      "elapsedSeconds": time.perf_counter() - started, "status": "pass"}
            results.append(result)
            print("SparsePCA ASGI acceptance passed:", case["name"], flush=True)

        # Empty selected scope must never be silently broadened to all rows.
        denied = await client.post("/api/v1/models/sparse-pca", json={**request,
            "context": {**context, "scope": "selected", "selectedRowIds": []}})
        assert denied.status_code == 422
        denied = await client.post("/api/v1/models/sparse-pca", json={**request,
            "context": {**context, "expectedSchemaRevision": 999}})
        assert denied.status_code == 409

        # Cross-runtime input normalization must remain invariant even when
        # raw squaring would overflow/underflow. A covariance request is refused.
        extreme = matrix * np.asarray([1e154, 1e-162, 1.0, 1.0])
        source = io.StringIO()
        writer = csv.writer(source)
        writer.writerow(["huge", "tiny", "ordinary1", "ordinary2"])
        writer.writerows(extreme.tolist())
        imported = await checked(client, "POST", "/datasets/import", files={
            "file": ("public-iris-scaled.csv", source.getvalue().encode(), "text/csv")})
        did = imported["datasetId"]
        codebook = await checked(client, "GET", f"/datasets/{did}/codebook")
        extreme_request = {**request, "maxIterations": 1000,
            "context": {**context, "datasetId": did},
            "variables": [{"columnId": column["columnId"], "kind": "numeric"} for column in codebook["columns"]]}
        fit = await checked(client, "POST", "/models/sparse-pca", json=extreme_request)
        np.testing.assert_allclose(fit["details"]["components"], results[0]["components"], atol=1e-8, rtol=1e-8)
        np.testing.assert_allclose(fit["summary"]["reconstructionFraction"], results[0]["summary"]["reconstructionFraction"], atol=1e-10)
        denied = await client.post("/api/v1/models/sparse-pca", json={**extreme_request, "preprocessing": "covariance"})
        assert denied.status_code == 422 and denied.json()["error"]["code"] == "SPCA_NUMERIC_RANGE"
        results.append({"case": "extreme-independent-units", "status": "pass"})

        # Seed a saved frequency/survey design containing missing and zero
        # weights. Explicit none must preserve all four complete predictor rows.
        imported = await checked(client, "POST", "/datasets/import", files={
            "file": ("synthetic-weight.csv", b"x,z,w\n0,1,\n1,4,0\n2,2,2\n3,5,3\n", "text/csv")})
        did = imported["datasetId"]
        from app.services.sparse_pca_service import store
        codebook = store.load_codebook(did)
        ids = {column["name"]: column["columnId"] for column in codebook["columns"]}
        for column in codebook["columns"]:
            if column["name"] == "w":
                column["role"] = "weight"
        weight_request = {**request, "maxIterations": 1000, "nComponents": 1,
            "context": {**context, "datasetId": did, "weightMode": "dataset"},
            "variables": [{"columnId": ids[name], "kind": "numeric"} for name in ("x", "z")]}
        for kind in ("frequency", "survey"):
            codebook["weightConfig"] = {"weightColumnId": ids["w"], "weightType": kind}
            codebook["surveyDesign"] = {"weightColumnId": ids["w"], "psuColumnId": "deliberately-unavailable"}
            store.save_codebook(did, codebook)
            denied = await client.post("/api/v1/models/sparse-pca", json=weight_request)
            assert denied.status_code == 422 and denied.json()["error"]["code"] == "SPCA_WEIGHT_UNSUPPORTED"
            fit = await checked(client, "POST", "/models/sparse-pca", json={**weight_request,
                "context": {**weight_request["context"], "weightMode": "none"}})
            assert fit["meta"]["fitCount"] == 4 and not fit["meta"]["weightApplied"]
            assert not any(fit["meta"]["exclusionCounts"].values())
        results.append({"case": "explicit-unweighted-boundary", "status": "pass"})

        # One retained variable after constant exclusion must still serialize
        # the W matrix as (1,1), rather than sklearn's squeezed scalar/vector.
        imported = await checked(client, "POST", "/datasets/import", files={
            "file": ("synthetic-constant.csv", b"x,constant\n1,8\n2,8\n4,8\n7,8\n", "text/csv")})
        did = imported["datasetId"]
        codebook = await checked(client, "GET", f"/datasets/{did}/codebook")
        single_request = {**request, "maxIterations": 1000, "nComponents": 1,
            "context": {**context, "datasetId": did},
            "variables": [{"columnId": column["columnId"], "kind": "numeric"} for column in codebook["columns"]]}
        fit = await checked(client, "POST", "/models/sparse-pca", json=single_request)
        assert fit["summary"]["nVariables"] == 1 and fit["summary"]["nComponents"] == 1
        assert np.asarray(fit["details"]["scoreCoefficients"]).shape == (1, 1)
        assert len(fit["details"]["excludedConstantColumns"]) == 1
        rows = await checked(client, "GET", f"/analysis-results/{fit['resultId']}/rows")
        assert rows["axes"] == [1] and rows["total"] == 4
        results.append({"case": "one-retained-variable", "status": "pass"})

        # This affine relationship is exact in float64 before normalization.
        # Dividing raw observations before centering used to report r=.994.
        source = io.StringIO()
        writer = csv.writer(source)
        writer.writerow(["large_offset", "ordinary"])
        writer.writerows(zip(1e16 + 2 * np.arange(20), np.arange(20)))
        imported = await checked(client, "POST", "/datasets/import", files={
            "file": ("synthetic-large-offset.csv", source.getvalue().encode(), "text/csv")})
        did = imported["datasetId"]
        codebook = await checked(client, "GET", f"/datasets/{did}/codebook")
        offset_request = {**request, "nComponents": 1, "maxIterations": 1000,
            "context": {**context, "datasetId": did},
            "variables": [{"columnId": column["columnId"], "kind": "numeric"} for column in codebook["columns"]]}
        fit = await checked(client, "POST", "/models/sparse-pca", json=offset_request)
        np.testing.assert_allclose(np.abs(fit["details"]["variableScoreCorrelations"]), 1.0, atol=1e-12)
        rows = await checked(client, "GET", f"/analysis-results/{fit['resultId']}/rows")
        score = np.asarray([row["coordinates"][0] for row in rows["rows"]])
        expected = (np.arange(20) - 9.5) / np.arange(20).std(ddof=1)
        np.testing.assert_allclose(np.abs(np.corrcoef(score, expected)[0, 1]), 1.0, atol=1e-12)
        results.append({"case": "large-offset-affine", "status": "pass"})

        source = io.StringIO()
        writer = csv.writer(source)
        writer.writerow(["reversed", "ordinary"])
        reversal_values = 1e15 + np.spacing(1e15) * np.arange(5)
        writer.writerows(zip(reversal_values, np.arange(5)))
        imported = await checked(client, "POST", "/datasets/import", files={
            "file": ("synthetic-reversal-offset.csv", source.getvalue().encode(), "text/csv")})
        did = imported["datasetId"]
        codebook = store.load_codebook(did)
        from app.domain.codebook_adapter import normalize_code
        for column in codebook["columns"]:
            if column["name"] == "reversed":
                column["isReversed"] = True
                column["categoryOrder"] = [normalize_code(value) for value in reversal_values]
        store.save_codebook(did, codebook)
        reversal_request = {**request, "nComponents": 1, "maxIterations": 1000,
            "context": {**context, "datasetId": did},
            "variables": [{"columnId": column["columnId"], "kind": "numeric"} for column in codebook["columns"]]}
        fit = await checked(client, "POST", "/models/sparse-pca", json=reversal_request)
        correlations = np.asarray(fit["details"]["variableScoreCorrelations"]).ravel()
        np.testing.assert_allclose(correlations[0] * correlations[1], -1.0, atol=1e-12)
        results.append({"case": "large-offset-reversal", "status": "pass"})

        imported = await checked(client, "POST", "/datasets/import", files={
            "file": ("synthetic-compensated-mean.csv", b"huge,ordinary\n1e308,1\n-1e308,2\n1,4\n", "text/csv")})
        did = imported["datasetId"]
        codebook = await checked(client, "GET", f"/datasets/{did}/codebook")
        mean_request = {**request, "nComponents": 1, "maxIterations": 1000,
            "context": {**context, "datasetId": did},
            "variables": [{"columnId": column["columnId"], "kind": "numeric"} for column in codebook["columns"]]}
        fit = await checked(client, "POST", "/models/sparse-pca", json=mean_request)
        assert fit["details"]["preprocessing"]["columns"][0]["rawMean"] == 1.0 / 3.0
        results.append({"case": "compensated-raw-mean", "status": "pass"})

        if os.environ.get("SPARSE_PCA_RUNTIME_PERFORMANCE") == "1":
            # Exercise the largest accepted frame through the same importer,
            # snapshot, fit and store used by the application. Iteration count
            # stays within the explicit budget, rather than stopping a fit.
            started = time.perf_counter()
            rng = np.random.default_rng(1428)
            large = rng.normal(size=(10000, 100))
            source = io.StringIO()
            writer = csv.writer(source)
            writer.writerow([f"x{i}" for i in range(100)])
            writer.writerows(large.tolist())
            imported = await checked(client, "POST", "/datasets/import", files={
                "file": ("synthetic-size-bound.csv", source.getvalue().encode(), "text/csv")})
            did = imported["datasetId"]
            codebook = await checked(client, "GET", f"/datasets/{did}/codebook")
            large_request = {**request, "nComponents": 20, "maxIterations": 5,
                "context": {**context, "datasetId": did},
                "variables": [{"columnId": column["columnId"], "kind": "numeric"} for column in codebook["columns"]]}
            fit_started = time.perf_counter()
            fit = await checked(client, "POST", "/models/sparse-pca", json=large_request)
            fit_seconds = time.perf_counter() - fit_started
            assert fit["meta"]["fitCount"] == 10000 and fit["summary"]["nVariables"] == 100
            assert fit["summary"]["nComponents"] == 20
            rows = await checked(client, "GET", f"/analysis-results/{fit['resultId']}/rows?offset=9999&axes=19,20")
            assert rows["total"] == 10000 and len(rows["rows"]) == 1
            denied = await client.post("/api/v1/models/sparse-pca", json={**large_request, "maxIterations": 8})
            assert denied.status_code == 422 and denied.json()["error"]["code"] == "SPCA_SIZE_LIMIT"
            results.append({"case": "largest-frame-api", "status": "pass", "n": 10000, "p": 100,
                            "k": 20, "maxIterations": 5, "fitSeconds": fit_seconds,
                            "totalSeconds": time.perf_counter() - started})
            print("SparsePCA largest-frame ASGI passed:", fit_seconds, "fit seconds", flush=True)

    output = {"python": platform.python_version(), "sklearn": sklearn.__version__,
              "numpy": np.__version__, "cases": results}
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    Path(output_path).write_text(json.dumps(output, indent=2, allow_nan=False), encoding="utf-8")
    return output


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    output = root / ".temp" / "sparse-pca" / "runtime-native.json"
    os.environ.setdefault("DAVIS_PCP_WORKSPACE", str(root / ".temp" / "sparse-pca" / "native-workspace"))
    sys.path.insert(0, str(root / "fullstack" / "backend"))
    asyncio.run(run_acceptance(str(output)))
