"""Unit tests for Feature 15: Global Observation Selection and Sampling API."""
import pytest
from fastapi.testclient import TestClient
import polars as pl

from app.main import app
from app.storage.dataset_store import DatasetStore

client = TestClient(app)


@pytest.fixture
def sample_dataset(tmp_path):
    store = DatasetStore()
    ds_id = "test_obs_dataset"
    df = pl.DataFrame({
        "__rowId__": [f"row_{i}" for i in range(100)],
        "x": [float(i) for i in range(100)],
        "y": [float(i * 2) for i in range(100)],
    })
    meta = {
        "datasetId": ds_id,
        "name": "Test Obs Dataset",
        "rowCount": 100,
        "columnCount": 3,
        "fingerprint": "fp_test",
        "createdAt": "2026-09-05T00:00:00Z",
        "schema": [
            {"columnId": "c1", "name": "x", "semanticType": "numeric", "physicalType": "Float64", "missingCount": 0, "role": "feature"},
            {"columnId": "c2", "name": "y", "semanticType": "numeric", "physicalType": "Float64", "missingCount": 0, "role": "feature"},
        ],
    }
    store.save(ds_id, meta, df)
    yield ds_id


def test_sampling_without_replacement(sample_dataset):
    # Test count-based without replacement
    resp = client.post(f"/api/v1/datasets/{sample_dataset}/observations/sample", json={
        "method": "without_replacement",
        "size": 30,
        "seed": 42,
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["sampleSize"] == 30
    assert len(data["sampledRowIds"]) == 30
    assert len(set(data["sampledRowIds"])) == 30
    assert all(w == 1 for w in data["sampledRowWeights"].values())


def test_sampling_with_replacement_is_rejected(sample_dataset):
    # CTX04: the shared scope is a set, not a multiset. Never silently discard
    # draw multiplicities or fall back to sampling without replacement.
    for _ in range(2):
        response = client.post(f"/api/v1/datasets/{sample_dataset}/observations/sample", json={
            "method": "with_replacement",
            "size": 50,
            "seed": 123,
        })
        assert response.status_code == 422, response.text
        assert "sampledRowIds" not in response.json()
        assert "sampledRowWeights" not in response.json()


def test_sampling_without_replacement_reproducibility(sample_dataset):
    # Preserve seeded-repeatability coverage for the supported method.
    request = {"method": "without_replacement", "size": 50, "seed": 123}
    url = f"/api/v1/datasets/{sample_dataset}/observations/sample"
    first = client.post(url, json=request)
    second = client.post(url, json=request)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    a, b = first.json(), second.json()
    assert a["sampleSize"] == b["sampleSize"] == 50
    assert a["sampledRowIds"] == b["sampledRowIds"]
    assert len(set(a["sampledRowIds"])) == 50
    assert a["sampledRowWeights"] == b["sampledRowWeights"]
    assert all(weight == 1 for weight in a["sampledRowWeights"].values())


def test_sampling_ratio(sample_dataset):
    # Test ratio-based sampling
    resp = client.post(f"/api/v1/datasets/{sample_dataset}/observations/sample", json={
        "method": "without_replacement",
        "ratio": 0.25,
        "seed": 42,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["sampleSize"] == 25
    assert len(data["sampledRowIds"]) == 25


def test_sampling_with_active_row_ids(sample_dataset):
    # Test subset of activeRowIds
    active_ids = [f"row_{i}" for i in range(10)]
    resp = client.post(f"/api/v1/datasets/{sample_dataset}/observations/sample", json={
        "method": "without_replacement",
        "size": 5,
        "activeRowIds": active_ids,
        "seed": 42,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["sampleSize"] == 5
    assert data["totalCandidates"] == 10
    assert all(rid in active_ids for rid in data["sampledRowIds"])


def test_sampling_validation_errors(sample_dataset):
    # Missing size and ratio
    resp = client.post(f"/api/v1/datasets/{sample_dataset}/observations/sample", json={
        "method": "without_replacement",
    })
    assert resp.status_code in [400, 422]

    # Size exceeds total for without_replacement
    resp = client.post(f"/api/v1/datasets/{sample_dataset}/observations/sample", json={
        "method": "without_replacement",
        "size": 150,
    })
    assert resp.status_code in [400, 422]


def test_range_selection(sample_dataset):
    # Test slice [10, 25)
    resp = client.post(f"/api/v1/datasets/{sample_dataset}/observations/range", json={
        "fromIndex": 10,
        "toIndex": 25,
    })
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["count"] == 15
    assert data["rowIds"] == [f"row_{i}" for i in range(10, 25)]


def test_range_selection_clipping_and_validation(sample_dataset):
    # from > to should fail
    resp = client.post(f"/api/v1/datasets/{sample_dataset}/observations/range", json={
        "fromIndex": 30,
        "toIndex": 20,
    })
    assert resp.status_code in [400, 422]

    # toIndex beyond length should clip gracefully
    resp = client.post(f"/api/v1/datasets/{sample_dataset}/observations/range", json={
        "fromIndex": 90,
        "toIndex": 200,
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 10
    assert data["rowIds"] == [f"row_{i}" for i in range(90, 100)]
