"""WF-11: invalid seeds fail at the API boundary and valid corrected input works."""
from __future__ import annotations

import polars as pl
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import observations
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def sampling_client(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    rows = [f"r{i}" for i in range(20)]
    store.save("seed-validation", {"datasetId": "seed-validation", "dataRevision": 1, "schemaRevision": 1,
        "schema": [], "rowCount": len(rows)}, pl.DataFrame({"__rowId__": rows}))
    monkeypatch.setattr(observations, "store", store)
    with TestClient(app) as client:
        yield client, "/api/v1/datasets/seed-validation/observations/sample"


@pytest.mark.parametrize("seed", [-1, 1.5, True, "42", {}, 9007199254740992])
def test_seed_model_rejects_invalid_values(seed):
    with pytest.raises(ValidationError) as error:
        observations.SamplingRequest(seed=seed, size=5)
    assert error.value.errors()[0]["loc"] == ("seed",)


@pytest.mark.parametrize("seed", [-1, 1.5, True, "42", {}, 9007199254740992])
def test_invalid_seed_api_is_field_specific_and_recovers(sampling_client, seed):
    client, url = sampling_client
    rejected = client.post(url, json={"seed": seed, "size": 5})
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["detail"][0]["loc"] == ["body", "seed"]
    assert "sampledRowIds" not in rejected.json()
    corrected = client.post(url, json={"seed": 42, "size": 5})
    assert corrected.status_code == 200, corrected.text
    assert corrected.json()["seed"] == 42
    assert len(corrected.json()["sampledRowIds"]) == 5
    repeated = client.post(url, json={"seed": 42, "size": 5})
    assert repeated.json()["sampledRowIds"] == corrected.json()["sampledRowIds"]


@pytest.mark.parametrize("seed", [0, 42, 9007199254740991, None])
def test_seed_boundary_and_blank_positive_controls(sampling_client, seed):
    client, url = sampling_client
    response = client.post(url, json={"seed": seed, "size": 5})
    assert response.status_code == 200, response.text
    result = response.json()
    assert isinstance(result["seed"], int)
    assert result["seed"] == seed if seed is not None else 0 <= result["seed"] < 2**32
    assert result["sourceRowCount"] == 20
    assert len(set(result["sampledRowIds"])) == 5
