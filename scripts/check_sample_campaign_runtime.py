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

        did = "ds-builtin-kakegawa-citizen2022-adult600"
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
    result = {"runtime": sys.platform, "passed": len(checks), "checks": checks}
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    asyncio.run(run_acceptance(os.environ.get("SAMPLE_CAMPAIGN_OUTPUT", ".temp/sample-campaign/runtime-native.json")))
