"""Actual Yokohama KDA/PRA populations and independent least-squares/LMG oracles."""
from __future__ import annotations

import itertools
import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, models, pra
from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore

DRIVERS = ["Q8_ア", "Q8_イ", "Q8_ウ", "Q8_エ", "Q8_カ", "Q8_キ"]


@pytest.fixture
def yokohama(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (datasets, models, pra):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        imported = client.post("/api/v1/datasets/import/sample", json={"sampleId": "yokohama-citizen2022-adult600"})
        assert imported.status_code == 200
        did = imported.json()["datasetId"]
        yield client, store, did, store.get_dataframe(did)


def independent_lmg(x, y):
    total = np.sum((y - y.mean()) ** 2)
    scores = {(): 0.}
    count = x.shape[1]
    for size in range(1, count + 1):
        for subset in itertools.combinations(range(count), size):
            design = np.column_stack([np.ones(len(y)), x[:, subset]])
            residual = y - design @ np.linalg.lstsq(design, y, rcond=None)[0]
            scores[subset] = 1 - float(residual @ residual / total)
    values = np.zeros(count)
    for j in range(count):
        others = [i for i in range(count) if i != j]
        for size in range(count):
            weight = 1 / (count * math.comb(count - 1, size))
            for subset in itertools.combinations(others, size):
                values[j] += weight * (scores[tuple(sorted((*subset, j)))] - scores[subset])
    return values, scores[tuple(range(count))]


@pytest.mark.parametrize("scope", ["all", "reversed_every_third"])
def test_yokohama_kda_pra_preserve_requested_scope_and_exact_valid_rows(yokohama, scope):
    client, store, did, frame = yokohama
    requested = frame["__rowId__"].to_list()
    if scope != "all":
        requested = requested[::3][::-1]
    selected = set(requested)
    rows = [row for row in frame.to_dicts() if row["__rowId__"] in selected
            and all(row[name] is not None for name in ["Q7", *DRIVERS])]
    expected_ids = [row["__rowId__"] for row in rows]
    assert (len(requested), len(rows)) == ((600, 508) if scope == "all" else (200, 166))
    x = np.asarray([[row[name] for name in DRIVERS] for row in rows], dtype=float)
    y = np.asarray([row["Q7"] for row in rows], dtype=float)
    common = {"datasetId": did, "outcome": "Q7", "rowIds": requested,
              "expectedDataRevision": 1, "expectedSchemaRevision": 1}
    kda_response = client.post("/api/v1/models/kda", json={**common, "drivers": DRIVERS})
    pra_response = client.post("/api/v1/pra/evaluate", json={**common, "attributes": DRIVERS,
                                                          "scaleMin": 1, "scaleMax": 5, "neutralPoint": 3})
    assert kda_response.status_code == pra_response.status_code == 200, (kda_response.text, pra_response.text)
    kda, result = kda_response.json(), pra_response.json()
    assert kda["model"]["n_valid"] == result["model"]["n_valid"] == len(rows)
    assert result["scopeCount"] == len(requested)
    contributions, r_squared = independent_lmg(x, y)
    assert kda["model"]["r_squared"] == pytest.approx(r_squared, abs=5.1e-5, rel=0)
    assert kda["what_if_baseline"]["outcome_mean"] == pytest.approx(y.mean(), abs=5.1e-5, rel=0)
    by_name = {item["name"]: item for item in kda["drivers"]}
    for name, raw, percent in zip(DRIVERS, contributions, contributions / contributions.sum() * 100):
        assert by_name[name]["importance_raw"] == pytest.approx(raw, abs=5.1e-5, rel=0)
        assert by_name[name]["importance_pct"] == pytest.approx(percent, abs=.0051, rel=0)
    design = np.column_stack([np.ones(len(rows)), *[values for j in range(x.shape[1])
                              for values in ((x[:, j] <= 2).astype(float), (x[:, j] >= 4).astype(float))]])
    coefficients = np.linalg.lstsq(design, (y - y.mean()) / y.std(ddof=1), rcond=None)[0]
    attrs = {item["name"]: item for item in result["attributes"]}
    for j, name in enumerate(DRIVERS):
        assert attrs[name]["penalty"]["coef"] == pytest.approx(coefficients[1 + 2*j], abs=5.1e-5, rel=0)
        assert attrs[name]["reward"]["coef"] == pytest.approx(coefficients[2 + 2*j], abs=5.1e-5, rel=0)
        assert attrs[name]["dissatisfied_row_ids"] == [rid for rid, value in zip(expected_ids, x[:, j]) if value <= 2]
    assert store.get_dataframe(did).equals(frame)


def test_yokohama_pra_refuses_stale_kda_handoff_revision(yokohama):
    client, store, did, frame = yokohama
    common = {"datasetId": did, "outcome": "Q7", "rowIds": frame["__rowId__"].to_list(),
              "expectedDataRevision": 1, "expectedSchemaRevision": 1}
    assert client.post("/api/v1/models/kda", json={**common, "drivers": DRIVERS}).status_code == 200
    book = store.load_codebook(did)
    outcome = next(c for c in book["columns"] if c["name"] == "Q7")
    updated = client.put(f"/api/v1/datasets/{did}/codebook", json={"expectedSchemaRevision": 1,
        "columns": [{"columnId": outcome["columnId"], "label": "Updated question label"}]})
    assert updated.status_code == 200, updated.text
    response = client.post("/api/v1/pra/evaluate", json={**common, "attributes": DRIVERS})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
    assert store.get_dataframe(did).equals(frame)
