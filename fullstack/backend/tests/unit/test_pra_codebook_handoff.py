"""WF-01: native KDA/PRA endpoints must agree on the same requested population.

These use real stored frames, codebooks, API handlers and numerical engines.
The handoff scope is pre-exclusion; model.n_valid is the listwise valid count.
"""
from __future__ import annotations

import math

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import models as models_api, pra as pra_api
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def fixture_store(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(models_api, "store", store)
    monkeypatch.setattr(pra_api, "store", store)
    return store


def save_fixture(store, with_missing):
    n = 30
    x = [float(i % 5) for i in range(n)]
    z = [float((i * 3) % 7) for i in range(n)]
    y = [2 * x[i] + .3 * z[i] + .1 * (i % 3) for i in range(n)]
    excluded = {"r1", "r2", "r3", "r4", "r5"} if with_missing else set()
    if with_missing:
        x[1] = 99.0  # Only a declared missing code, not a null in storage.
        y[2] = -999.0  # A missing outcome must use the same mask too.
        z[3] = None
        x[4] = math.nan
        z[5] = math.inf
    frame = pl.DataFrame({"__rowId__": [f"r{i}" for i in range(n)], "x": x, "z": z, "y": y})
    columns = [{"columnId": name, "name": name, "label": f"Question {name}", "scaleType": "ratio", "role": "question",
                "missingCodes": {"x": ["99"], "y": ["-999"]}.get(name, []), "isReversed": False,
                "valueLabels": {}, "categoryOrder": []} for name in ["x", "z", "y"]]
    codebook = {"datasetId": "handoff", "schemaRevision": 2, "columns": columns, "multiResponseGroups": []}
    schema = [{"name": name, "physicalType": "float", "semanticType": "numeric"} for name in ["x", "z", "y"]]
    store.save("handoff", {"datasetId": "handoff", "schema": schema, "schemaRevision": 2, "dataRevision": 1}, frame, codebook)
    return frame, excluded


@pytest.mark.parametrize("with_missing", [False, True], ids=["normal-positive", "coded-null-nonfinite"])
@pytest.mark.parametrize("scope_size", [30, 20], ids=["all-rows", "subset"])
def test_kda_pra_share_codebook_valid_rows(fixture_store, with_missing, scope_size):
    frame, excluded = save_fixture(fixture_store, with_missing)
    requested_rows = frame["__rowId__"].to_list()[:scope_size]
    valid_rows = [row for row in requested_rows if row not in excluded]
    common = {"datasetId": "handoff", "rowIds": requested_rows, "outcome": "y", "expectedDataRevision": 1, "expectedSchemaRevision": 2}
    client = TestClient(app)
    kda = client.post("/api/v1/models/kda", json={**common, "drivers": ["x", "z"]})
    pra = client.post("/api/v1/pra/evaluate", json={**common, "attributes": ["x", "z"]})
    assert kda.status_code == pra.status_code == 200, (kda.text, pra.text)
    kda_result, pra_result = kda.json(), pra.json()
    assert kda_result["model"]["n_valid"] == pra_result["model"]["n_valid"] == len(valid_rows)
    assert pra_result["scopeCount"] == len(requested_rows)
    assert pra_result["schemaRevision"] == 2
    assert pra_result["dataRevision"] == 1
    assert pra_result["outcome"]["label"] == "Question y"
    valid_frame = frame.filter(pl.col("__rowId__").is_in(valid_rows))
    assert kda_result["what_if_baseline"]["outcome_mean"] == pytest.approx(valid_frame["y"].mean(), abs=1e-4)
    low_x = next(a for a in pra_result["attributes"] if a["name"] == "x")["dissatisfied_row_ids"]
    # Genuine 0 in both the outcome and attribute is an observed value, never
    # silently imputed or removed. It must remain selectable from the PRA result.
    assert frame.filter(pl.col("__rowId__") == "r0")["x"].item() == 0
    assert frame.filter(pl.col("__rowId__") == "r0")["y"].item() == 0
    assert "r0" in low_x
    for attribute in pra_result["attributes"]:
        assert set(attribute["dissatisfied_row_ids"]) <= set(valid_rows)
        assert not set(attribute["dissatisfied_row_ids"]) & excluded
    # The analysis mask does not mutate canonical raw observations.
    persisted = fixture_store.get_dataframe("handoff")
    assert persisted.height == 30
    assert persisted.filter(pl.col("__rowId__") == "r0")["x"].item() == 0
    if with_missing:
        assert persisted.filter(pl.col("__rowId__") == "r1")["x"].item() == 99
