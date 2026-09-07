"""API regression tests for priority review bugs B05, B06, B08, B09, B12.

Validates via FastAPI TestClient:
- B05: Schema patch updates fingerprint and invalidates summaries cache.
- B05: In-place imputation preserves manual schema types and column IDs.
- B06: Empty rowIds ([]):
    - summaries returns rowCount=0 and empty columns, not all rows from cache.
    - PCA with rowIds=[] raises PCA_INSUFFICIENT_ROWS (400), does not evaluate full dataset.
    - modern-subgroup with selectedRowIds=[] returns empty insights, does not evaluate full dataset.
- B08: CSV export with Japanese dataset name succeeds without UnicodeEncodeError in Content-Disposition.
- B09: Copy imputation (inPlace: false) succeeds without AttributeError on meta.name.
- B12: Random forest endpoint returns treeAgreements and forestAgreement == 1.0 on separable data.
"""
from __future__ import annotations

import io
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.main import app  # noqa: E402
from app.storage.dataset_store import DatasetStore  # noqa: E402

client = TestClient(app)
store = DatasetStore()


def _upload_csv(filename: str, csv_content: str) -> dict:
    files = {"file": (filename, io.BytesIO(csv_content.encode("utf-8")), "text/csv")}
    res = client.post("/api/v1/datasets/import", files=files)
    assert res.status_code == 200, res.text
    return res.json()


class TestApiB05SchemaAndImputation:
    def test_schema_patch_invalidates_summaries_cache(self):
        csv_data = "x,q\n1,10\n2,20\n3,30\n"
        meta = _upload_csv("patch_cache_test.csv", csv_data)
        ds_id = meta["datasetId"]

        # Initial summary
        s1 = client.post("/api/v1/summaries", json={"datasetId": ds_id}).json()
        assert s1.get("cacheHit") is not True

        # Second summary hits cache
        s2 = client.post("/api/v1/summaries", json={"datasetId": ds_id}).json()
        assert s2.get("cacheHit") is True

        # Patch schema: change q to categorical
        patch_res = client.patch(
            f"/api/v1/datasets/{ds_id}/schema",
            json={"columns": [{"name": "q", "semanticType": "categorical"}]},
        )
        assert patch_res.status_code == 200
        new_meta = patch_res.json()
        assert new_meta["fingerprint"] != meta["fingerprint"]

        # Summary after patch must NOT hit the old cache
        s3 = client.post("/api/v1/summaries", json={"datasetId": ds_id}).json()
        assert s3.get("cacheHit") is not True
        # q should now have categorical summary (frequencies, not mean)
        assert "frequencies" in s3["columns"]["q"]

    def test_inplace_imputation_preserves_schema_types(self):
        csv_data = "x,q\n1,10\n,20\n3,30\n"
        meta = _upload_csv("impute_preserve_test.csv", csv_data)
        ds_id = meta["datasetId"]

        # Set q as categorical
        client.patch(
            f"/api/v1/datasets/{ds_id}/schema",
            json={"columns": [{"name": "q", "semanticType": "categorical"}]},
        )
        meta_patched = store.get_meta(ds_id)
        q_schema_before = next(c for c in meta_patched["schema"] if c["name"] == "q")
        assert q_schema_before["semanticType"] == "categorical"
        col_id_before = q_schema_before["columnId"]

        # Impute missing x in place
        imp_res = client.post(
            f"/api/v1/datasets/{ds_id}/impute",
            json={"columns": ["x"], "strategy": "mean", "inPlace": True},
        )
        assert imp_res.status_code == 200
        imputed_meta = imp_res.json()

        # Check that q's semanticType and columnId were preserved!
        q_schema_after = next(c for c in imputed_meta["schema"] if c["name"] == "q")
        assert q_schema_after["semanticType"] == "categorical"
        assert q_schema_after["columnId"] == col_id_before


class TestApiB06EmptyRowIds:
    def test_summaries_empty_row_ids_not_full_dataset(self):
        csv_data = "x,y\n1,2\n3,4\n5,6\n"
        meta = _upload_csv("empty_row_ids.csv", csv_data)
        ds_id = meta["datasetId"]

        # Request all rows first to prime cache
        all_res = client.post("/api/v1/summaries", json={"datasetId": ds_id}).json()
        assert all_res["rowCount"] == 3

        # Now request with rowIds=[]
        empty_res = client.post("/api/v1/summaries", json={"datasetId": ds_id, "rowIds": []}).json()
        assert empty_res.get("cacheHit") is not True
        assert empty_res["rowCount"] == 0
        assert empty_res["columns"]["x"]["count"] == 0

    def test_pca_empty_row_ids_insufficient_rows(self):
        csv_data = "x,y\n1,2\n3,4\n5,6\n"
        meta = _upload_csv("pca_empty.csv", csv_data)
        ds_id = meta["datasetId"]

        pca_res = client.post(
            "/api/v1/models/pca",
            json={"datasetId": ds_id, "columns": ["x", "y"], "rowIds": []},
        )
        assert pca_res.status_code == 400
        err = pca_res.json()
        msg = err.get("message") or err.get("error", {}).get("message", "")
        assert "PCAには2行以上の有効データが必要です" in msg

    def test_modern_subgroup_empty_selection_returns_empty_insights(self):
        csv_data = "gender,score\nM,80\nM,85\nF,90\nF,95\n"
        meta = _upload_csv("subgroup_empty.csv", csv_data)
        ds_id = meta["datasetId"]

        res = client.post(
            "/api/v1/mining/modern-subgroup",
            json={"datasetId": ds_id, "selectedRowIds": []},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["insights"] == []


class TestApiB08JapaneseFilenameExport:
    def test_export_japanese_dataset_name(self):
        csv_data = "設問1,設問2\n1,2\n3,4\n"
        meta = _upload_csv("アンケート.csv", csv_data)
        ds_id = meta["datasetId"]

        res = client.post("/api/v1/exports", json={"datasetId": ds_id, "format": "csv"})
        assert res.status_code == 200
        cd = res.headers.get("Content-Disposition", "")
        # Must contain valid RFC 5987 UTF-8 encoding
        assert "filename*=" in cd
        assert "UTF-8''" in cd


class TestApiB09ImputeCopy:
    def test_impute_in_place_false_creates_new_dataset(self):
        csv_data = "a,b\n1,10\n,20\n3,30\n"
        meta = _upload_csv("impute_copy.csv", csv_data)
        ds_id = meta["datasetId"]

        res = client.post(
            f"/api/v1/datasets/{ds_id}/impute",
            json={"columns": ["a"], "strategy": "mean", "inPlace": False},
        )
        # Should not raise AttributeError: 'dict' object has no attribute 'name'
        assert res.status_code == 200
        new_meta = res.json()
        assert new_meta["datasetId"] != ds_id
        assert "_imputed" in new_meta["name"]
        # Original dataset still exists and unchanged
        orig = store.get_dataframe(ds_id)
        assert orig["a"].null_count() == 1


class TestApiB12RandomForestEndpoint:
    def test_random_forest_agreement_endpoint(self):
        # 100 rows separable
        rows = ["x,y"]
        for i in range(50):
            rows.append("0,1")
            rows.append("1,2")
        meta = _upload_csv("rf_test.csv", "\n".join(rows) + "\n")
        ds_id = meta["datasetId"]

        res = client.post(
            "/api/v1/models",
            json={
                "datasetId": ds_id,
                "modelType": "random_forest",
                "taskType": "classification",
                "features": ["x"],
                "target": "y",
                "nEstimators": 5,
                "maxDepth": 3,
                "seed": 42,
            },
        )
        assert res.status_code == 200
        data = res.json()
        rep = data.get("representativeTree", {})
        assert rep.get("forestAgreement") == 1.0
        assert all(a == 1.0 for a in rep.get("treeAgreements", []))


class TestApiD13ParquetExport:
    def test_parquet_export_is_valid_binary(self):
        import io
        import polars as pl
        meta = _upload_csv("parquet_export_test.csv", "a,b\n1,foo\n2,bar\n")
        ds_id = meta["datasetId"]

        res = client.post(
            "/api/v1/exports",
            json={"datasetId": ds_id, "scope": "all", "format": "parquet"},
        )
        assert res.status_code == 200
        assert "application/vnd.apache.parquet" in res.headers["content-type"]
        assert res.content[:4] == b"PAR1"

        # Verify readable as Parquet
        df_read = pl.read_parquet(io.BytesIO(res.content))
        assert df_read["a"].to_list() == [1, 2]
        assert df_read["b"].to_list() == ["foo", "bar"]


class TestApiD02LargeIntegersApi:
    def test_large_integers_api_roundtrip(self):
        import io
        import polars as pl
        csv_text = "code,big_int\n0001,9007199254740993\n1,9007199254740992\n"
        meta = _upload_csv("large_int_test.csv", csv_text)
        ds_id = meta["datasetId"]

        # 1. Check schema
        schema = meta["schema"]
        code_s = next(s for s in schema if s["name"] == "code")
        assert code_s["physicalType"] == "string"
        int_s = next(s for s in schema if s["name"] == "big_int")
        assert int_s["physicalType"] == "int"
        assert int_s["min"] == 9007199254740992
        assert int_s["max"] == 9007199254740993

        # 2. Export to Parquet and verify binary retention
        res_pq = client.post(
            "/api/v1/exports",
            json={"datasetId": ds_id, "scope": "all", "format": "parquet"},
        )
        assert res_pq.status_code == 200
        df_pq = pl.read_parquet(io.BytesIO(res_pq.content))
        assert df_pq["big_int"].dtype == pl.Int64
        assert df_pq["big_int"].to_list() == [9007199254740993, 9007199254740992]

        # 3. Export to CSV and verify CSV retention
        res_csv = client.post(
            "/api/v1/exports",
            json={"datasetId": ds_id, "scope": "all", "format": "csv"},
        )
        assert res_csv.status_code == 200
        content_str = res_csv.content.decode("utf-8-sig")
        assert "9007199254740993" in content_str
        assert "9007199254740992" in content_str

