"""API tests for dataset imputation and expression calculation endpoints."""
from __future__ import annotations

import polars as pl
from starlette.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore

client = TestClient(app)
store = DatasetStore()


def _setup_test_dataset() -> str:
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3", "r4", "r5"],
        "num1": [1.0, 2.0, 3.0, 4.0, 5.0],
        "num2": [10.0, None, 30.0, None, 50.0],
        "cat1": ["alpha", "beta", None, "alpha", "beta"],
    })
    meta = {
        "datasetId": "test-impute-calc",
        "name": "Test Impute Calc",
        "format": "csv",
        "rowCount": 5,
        "columnCount": 3,
        "fingerprint": "fakefingerprint",
        "rowIdentity": "exact",
        "createdAt": "2026-09-05T00:00:00Z",
        "schema": [
            {"columnId": "c1", "name": "num1", "physicalType": "Float64", "semanticType": "numeric", "role": "feature", "missingCount": 0, "uniqueCount": 5},
            {"columnId": "c2", "name": "num2", "physicalType": "Float64", "semanticType": "numeric", "role": "feature", "missingCount": 2, "uniqueCount": 3},
            {"columnId": "c3", "name": "cat1", "physicalType": "String", "semanticType": "categorical", "role": "feature", "missingCount": 1, "uniqueCount": 2},
        ],
    }
    store.save("test-impute-calc", meta, df)
    return "test-impute-calc"


def test_impute_preview_api():
    ds_id = _setup_test_dataset()
    res = client.post(f"/api/v1/datasets/{ds_id}/impute/preview", json={
        "column": "num2",
        "strategy": "mean",
    })
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["column"] == "num2"
    assert data["beforeStats"]["missingCount"] == 2
    assert data["afterStats"]["missingCount"] == 0
    assert len(data["histogram"]) > 0


def test_impute_execute_api():
    ds_id = _setup_test_dataset()
    res = client.post(f"/api/v1/datasets/{ds_id}/impute", json={
        "columns": ["num2", "cat1"],
        "strategy": "tabdiff",
        "options": {"num_steps": 5, "seed": 42},
        "inPlace": True,
    })
    assert res.status_code == 200, res.text
    data = res.json()
    assert "diagnostics" in data
    assert data["diagnostics"]["method"] == "tabdiff"

    # Verify df in store has 0 missing
    updated_df = store.get_dataframe(ds_id)
    assert updated_df["num2"].null_count() == 0
    assert updated_df["cat1"].null_count() == 0


def test_calculate_preview_api():
    ds_id = _setup_test_dataset()
    res = client.post(f"/api/v1/datasets/{ds_id}/calculate/preview", json={
        "expression": "num1 * 10 + 5",
        "columnName": "num1_scaled",
    })
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["valid"] is True
    assert len(data["previewValues"]) == 5
    assert data["previewValues"][0] == 15.0


def test_calculate_execute_api():
    ds_id = _setup_test_dataset()
    res = client.post(f"/api/v1/datasets/{ds_id}/calculate", json={
        "expression": "log(num1 + 1)",
        "columnName": "log_num1",
    })
    assert res.status_code == 200, res.text
    data = res.json()
    assert "createdColumn" in data
    assert data["createdColumn"]["column"] == "log_num1"

    updated_df = store.get_dataframe(ds_id)
    assert "log_num1" in updated_df.columns
