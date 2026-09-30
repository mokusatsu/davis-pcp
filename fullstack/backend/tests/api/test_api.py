"""API integration tests: full endpoint coverage via TestClient."""
from __future__ import annotations

import io
import sys
from pathlib import Path

import pytest
import polars as pl

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)

NUMERIC_COLS = ["sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm"]


@pytest.fixture(scope="module")
def iris_id() -> str:
    response = client.post("/api/v1/datasets/import/sample", json={"name": "Iris"})
    assert response.status_code == 200
    return response.json()["datasetId"]


@pytest.fixture(scope="module")
def iris_rows(iris_id):
    response = client.post(f"/api/v1/datasets/{iris_id}/view", json={})
    assert response.status_code == 200
    return pl.read_ipc_stream(io.BytesIO(response.content))


class TestHealth:
    def test_ok(self):
        r = client.get("/api/v1/health")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


class TestDatasets:
    def test_list_contains_iris(self, iris_id):
        r = client.get("/api/v1/datasets")
        ids = [d["datasetId"] for d in r.json()["datasets"]]
        assert iris_id in ids

    def test_import_builtin_sample_idempotent(self, iris_id):
        # Importing sample again with same name should return existing dataset ID
        r = client.post("/api/v1/datasets/import/sample", json={"name": "Iris"})
        assert r.status_code == 200
        assert r.json()["datasetId"] == iris_id

    def test_get_meta(self, iris_id):
        r = client.get(f"/api/v1/datasets/{iris_id}")
        meta = r.json()
        assert meta["rowCount"] == 150
        assert meta["rowIdentity"] == "generated"  # Sample id is a data column, not canonical row identity.

    def test_get_missing_404(self):
        r = client.get("/api/v1/datasets/nope")
        assert r.status_code == 404
        assert r.json()["error"]["code"] == "DATASET_NOT_FOUND"

    def test_csv_upload(self):
        payload = b"a,b\n1,2\n3,4\n"
        r = client.post("/api/v1/datasets/import", files={"file": ("t.csv", payload, "text/csv")})
        assert r.status_code == 200

    def test_arrow_view(self, iris_id):
        r = client.post(f"/api/v1/datasets/{iris_id}/view", json={"limit": 5})
        assert r.status_code == 200
        assert r.content[:6] == b"ARROW1" or len(r.content) > 100

    def test_row_filter_view(self, iris_id, iris_rows):
        selected = iris_rows["__rowId__"].to_list()[:2]
        r = client.post(f"/api/v1/datasets/{iris_id}/view",
                        json={"rowIds": selected})
        assert r.status_code == 200
        assert pl.read_ipc_stream(io.BytesIO(r.content))["__rowId__"].to_list() == selected

    def test_delete(self):
        created = client.post("/api/v1/datasets/import/sample", json={"name": "temp"}).json()
        r = client.delete(f"/api/v1/datasets/{created['datasetId']}")
        assert r.status_code == 200


class TestOrderings:
    @pytest.mark.parametrize("mode", ["database", "componentJar", "componentPaper", "permute", "correlation"])
    def test_modes(self, iris_id, mode):
        r = client.post("/api/v1/orderings", json={"datasetId": iris_id, "mode": mode})
        assert r.status_code == 200
        body = r.json()
        assert body["evidenceClass"]
        assert body["outputColumnIds"]

    def test_result_fetch(self, iris_id):
        result = client.post("/api/v1/orderings", json={"datasetId": iris_id, "mode": "permute"}).json()
        r = client.get(f"/api/v1/orderings/{result['resultId']}")
        assert r.status_code == 200

    def test_insufficient_columns_error(self, iris_id):
        r = client.post("/api/v1/orderings", json={"datasetId": iris_id, "mode": "componentJar",
                                                   "columns": ["species"]})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "ORDERING_INSUFFICIENT_COLUMNS"


class TestSummaries:
    def test_summary_and_cache(self, iris_id):
        r1 = client.post("/api/v1/summaries", json={"datasetId": iris_id})
        assert r1.json()["columns"]["sepal_length_cm"]["mean"] == pytest.approx(5.8433, abs=1e-3)
        r2 = client.post("/api/v1/summaries", json={"datasetId": iris_id})
        assert r2.json().get("cacheHit") is True

    def test_correlation(self, iris_id):
        r = client.post("/api/v1/summaries", json={"datasetId": iris_id, "columns": NUMERIC_COLS, "correlation": True})
        corr = r.json()["correlation"]
        assert len(corr["matrix"]) == 4


class TestSessions:
    def test_crud_and_conflict(self):
        s = client.post("/api/v1/sessions", json={"name": "t", "state": {"v": 1}}).json()
        token = s["versionToken"]
        u = client.put(f"/api/v1/sessions/{s['sessionId']}", json={"state": {"v": 2}, "versionToken": token})
        assert u.json()["revision"] == 2
        conflict = client.put(f"/api/v1/sessions/{s['sessionId']}", json={"state": {"v": 3}, "versionToken": token})
        assert conflict.status_code == 409
        assert client.delete(f"/api/v1/sessions/{s['sessionId']}").status_code == 200

    def test_migration_rejects_non_iris(self):
        r = client.post("/api/v1/sessions/migrate-static-v1", json={"state": {"schemaVersion": 1, "order": ["a"]}})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "MIGRATION_NOT_IRIS_FIXTURE"

    def test_migration_converts(self, iris_id):
        static_state = {
            "schemaVersion": 1, "orientation": "vertical", "orderMode": "permute",
            "order": ["petalLength", "petalWidth", "speciesCode", "sepalLength", "sepalWidth"],
            "visibleKeys": ["sepalLength", "sepalWidth"], "selected": ["IRIS-001"],
            "active": [f"IRIS-{i:03d}" for i in range(1, 151)],
            "jitterEnabled": False,
        }
        r = client.post("/api/v1/sessions/migrate-static-v1", json={"state": static_state})
        assert r.status_code == 200
        state = r.json()["state"]
        assert state["orientation"] == "vertical"
        assert state["visibleAxes"] == ["sepal_length_cm", "sepal_width_cm"]
        assert state["selectedRowIds"] == ["IRIS-001"]


class TestGroups:
    def test_create_update_delete(self, iris_id):
        g = client.post(f"/api/v1/datasets/{iris_id}/groups",
                        json={"name": "g1", "rowIds": ["IRIS-001"]}).json()
        gid = g["groupId"]
        assert g["rowIds"] == ["IRIS-001"]
        p = client.patch(f"/api/v1/datasets/{iris_id}/groups/{gid}", json={"rowIds": ["IRIS-002"]})
        assert p.json()["rowIds"] == ["IRIS-002"]
        assert client.delete(f"/api/v1/datasets/{iris_id}/groups/{gid}").status_code == 200


class TestClustersOutliers:
    def test_all_methods(self, iris_id):
        for method in ["kmeans", "kmedoids", "divisive", "gmm", "agglomerative"]:
            r = client.post("/api/v1/clusters", json={
                "datasetId": iris_id, "method": method, "columns": NUMERIC_COLS, "k": 3})
            assert r.status_code == 200, f"{method}: {r.text}"
            body = r.json()
            assert body["silhouette"] is not None
            assert body["pcaProjection"]["pc1"]

    def test_dendrogram_requires_hierarchical(self, iris_id):
        km = client.post("/api/v1/clusters", json={
            "datasetId": iris_id, "method": "kmeans", "columns": NUMERIC_COLS, "k": 3}).json()
        r = client.post("/api/v1/dendrograms", json={"clusterResultId": km["resultId"]})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "DENDROGRAM_REQUIRES_HIERARCHICAL"

    def test_outliers_all_methods(self, iris_id):
        for method in ["iqr", "robust_z", "isolation_forest", "lof"]:
            r = client.post("/api/v1/outliers", json={
                "datasetId": iris_id, "method": method, "columns": NUMERIC_COLS})
            assert r.status_code == 200
            assert "outlierRowIds" in r.json()


class TestModels:
    def test_tree_structure(self, iris_id):
        r = client.post("/api/v1/models", json={
            "datasetId": iris_id, "modelType": "decision_tree", "taskType": "classification",
            "features": NUMERIC_COLS, "target": "species", "maxDepth": 3})
        body = r.json()
        root = body["treeStructures"][0]
        assert root["children"]
        assert any(leaf["majority"] == "Iris-setosa"
                   for leaf in _walk_leaves(root))

    def test_forest(self, iris_id):
        r = client.post("/api/v1/models", json={
            "datasetId": iris_id, "modelType": "random_forest", "taskType": "classification",
            "features": NUMERIC_COLS, "target": "species"})
        assert r.json()["modelType"] == "random_forest"


def _walk_leaves(node):
    if node.get("isLeaf"):
        yield node
    for child in node.get("children") or []:
        yield from _walk_leaves(child)


class TestExports:
    def test_csv_neutralizes_formula_injection(self):
        payload = b"name,val\n=cmd(),1\n"
        created = client.post("/api/v1/datasets/import", files={"file": ("inj.csv", payload, "text/csv")}).json()
        r = client.post("/api/v1/exports", json={"datasetId": created["datasetId"], "scope": "all", "format": "csv"})
        first_line = r.content.decode("utf-8-sig").split("\n")[1]
        assert first_line.startswith("'=cmd()")

    def test_parquet_roundtrip(self, iris_id):
        r = client.post("/api/v1/exports", json={"datasetId": iris_id, "scope": "all", "format": "parquet"})
        assert r.content[:4] == b"PAR1"

    def test_selected_scope(self, iris_id, iris_rows):
        r = client.post("/api/v1/exports", json={
            "datasetId": iris_id, "scope": "selected", "rowIds": [iris_rows["__rowId__"][0]], "format": "csv"})
        lines = r.content.decode("utf-8-sig").strip().split("\n")
        assert len(lines) == 2  # header + 1 row


class TestJobs:
    def test_job_lifecycle_via_transition_guard(self):
        from app.storage.session_store import JobStore
        import tempfile
        store = JobStore(Path(tempfile.mkdtemp()))
        store.create("j1", "ordering", None, {})
        store.transition("j1", "cancelled")
        result = store.transition("j1", "completed", result={})
        assert result["status"] == "cancelled"

    def test_cancel_endpoint_404(self):
        r = client.post("/api/v1/jobs/nonexistent/cancel")
        assert r.status_code == 404


class TestSecurity:
    def test_no_stack_trace_in_errors(self):
        r = client.post("/api/v1/orderings", json={"datasetId": "missing-ds", "mode": "permute"})
        assert "Traceback" not in r.text
        assert r.json()["error"]["code"] == "DATASET_NOT_FOUND"

    def test_upload_size_limit(self):
        from app.config import settings as cfg
        orig = cfg.max_upload_bytes
        try:
            cfg.max_upload_bytes = 10 * 1024  # 10 KB for test
            big = b"a,b\n" + b"1,2\n" * 3000
            r = client.post("/api/v1/datasets/import", files={"file": ("big.csv", big, "text/csv")})
            assert r.status_code == 400
        finally:
            cfg.max_upload_bytes = orig
