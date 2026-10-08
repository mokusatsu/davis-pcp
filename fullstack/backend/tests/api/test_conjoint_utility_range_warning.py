"""Utility-range warnings describe extrapolation without changing the fit."""
from __future__ import annotations

import io
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient


RATINGS_CSV = """respondent_id,task_id,alternative_id,price,rating
R1,T1,P,10,2.60
R1,T2,P,15,4.50
R1,T3,P,20,6.40
R2,T1,P,10,2.75
R2,T2,P,15,4.75
R2,T3,P,20,6.75
R3,T1,P,10,2.95
R3,T2,P,15,5.00
R3,T3,P,20,7.05
R4,T1,P,10,3.30
R4,T2,P,15,5.25
R4,T3,P,20,7.20
R5,T1,P,10,3.40
R5,T2,P,15,5.50
R5,T3,P,20,7.60
R6,T1,P,10,2.95
R6,T2,P,15,4.75
R6,T3,P,20,6.55
R7,T1,P,10,3.10
R7,T2,P,15,5.25
R7,T3,P,20,7.40
R8,T1,P,10,2.95
R8,T2,P,15,5.00
R8,T3,P,20,7.05
"""

RANGE_WARNING = {
    "code": "CONJOINT_UTILITY_RANGE_EXTRAPOLATION",
    "message": "指定rangeは訓練範囲外を含みます。",
    "count": 1,
    "columnIds": ["price"],
}


@pytest.fixture
def conjoint_workspace(tmp_path, monkeypatch):
    # Support direct selection without another test first adding the backend.
    monkeypatch.syspath_prepend(str(Path(__file__).resolve().parents[2]))
    from app.config import settings

    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    monkeypatch.setenv("DAVIS_PCP_READY_FILE", str(tmp_path / "ready"))
    settings.ensure_dirs()

    from app.main import app
    from app.api import analysis_results, conjoint, datasets, sessions
    from app.jobs.manager import manager
    from app.storage.dataset_store import DatasetStore
    from app.storage.session_store import JobStore, SessionStore

    store = DatasetStore(tmp_path)
    for module in (datasets, analysis_results, conjoint):
        monkeypatch.setattr(module, "store", store)
    monkeypatch.setattr(sessions, "sessions", SessionStore(tmp_path))
    monkeypatch.setattr(manager, "store", JobStore(tmp_path))
    with TestClient(app) as client:
        yield client, store


def _fit(client, context, utility_range):
    from app.storage import analysis_result_store

    attribute = {"columnId": "price", "kind": "linear"}
    if utility_range is not None:
        attribute["utilityRange"] = utility_range
    response = client.post("/api/v1/models/conjoint", json={
        "context": context, "method": "conjoint", "mode": "ratings",
        "ratingEffects": "pooled",
        "columns": {"respondentId": "respondent_id", "taskId": "task_id",
                    "alternativeId": "alternative_id", "response": "rating"},
        "attributes": [attribute], "confidenceLevel": 0.95,
        "maxIterations": 1000,
    })
    assert response.status_code == 200, response.text
    fit = response.json()
    result_id = fit["resultId"]
    response = client.get(f"/api/v1/analysis-results/{result_id}/rows",
                          params={"offset": 0, "limit": 100})
    assert response.status_code == 200, response.text
    rows = response.json()
    assert fit["status"] == "success"
    assert fit["summary"]["converged"]
    assert fit["summary"]["inferenceStatus"] == "available"
    assert fit["meta"]["fitCount"] == fit["meta"]["effectiveN"] == 24
    assert fit["meta"]["excludedCount"] == 0
    assert len(rows["rows"]) == rows["total"] == 24
    assert fit["summary"]["fitProfileCount"] == 24
    encoding = analysis_result_store.load_manifest(result_id)["encoding"]
    beta = analysis_result_store.load_arrays(result_id)["beta"].tolist()
    assert beta == [item["estimate"] for item in fit["details"]["coefficients"]]
    assert len(beta) == 1
    return fit, rows["rows"], encoding, beta


@pytest.mark.parametrize("utility_range, expected_warning", [
    pytest.param(None, False, id="omitted"),
    pytest.param([10, 20], False, id="equal"),
    pytest.param([12, 18], False, id="interior"),
    pytest.param([0, 30], True, id="exterior"),
    pytest.param([0, 20], True, id="lower-only"),
    pytest.param([10, 30], True, id="upper-only"),
])
def test_utility_range_warning(conjoint_workspace, utility_range, expected_warning):
    client, store = conjoint_workspace
    response = client.post("/api/v1/datasets/import", files={
        "file": ("ratings.csv", RATINGS_CSV.encode(), "text/csv"),
    })
    assert response.status_code == 200, response.text
    dataset_id = response.json()["datasetId"]
    imported = store.get_dataframe(dataset_id)
    original = pl.read_csv(io.StringIO(RATINGS_CSV))
    assert imported.select(original.columns).to_dicts() == original.to_dicts()
    by_id = {str(row["__rowId__"]): row for row in imported.to_dicts()}
    assert len(by_id) == 24
    context = {"datasetId": dataset_id, "expectedDataRevision": 1,
               "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none",
               "missingPolicy": "exclude", "imputationPolicy": "use_current_values"}

    control, control_rows, control_encoding, control_beta = _fit(client, context, None)
    assert control["meta"]["warnings"] == []
    assert control_encoding["linearRanges"] == {
        "price": {"lower": 10, "upper": 20, "fitMin": 10, "fitMax": 20},
    }
    fit, rows, encoding, beta = _fit(client, context, utility_range)
    assert rows == control_rows
    assert {row["rowId"] for row in rows} == set(by_id)
    assert all(row["predictionStatus"] == "ok" and
               row["observed"] == by_id[row["rowId"]]["rating"] for row in rows)
    fit_prices = [by_id[row["rowId"]]["price"] for row in rows]
    assert [min(fit_prices), max(fit_prices)] == [10, 20]
    lower, upper = utility_range if utility_range is not None else [10, 20]
    assert encoding["linearRanges"] == {
        "price": {"lower": lower, "upper": upper, "fitMin": 10, "fitMax": 20},
    }
    assert fit["details"]["coefficients"] == control["details"]["coefficients"]
    assert beta == control_beta
    assert encoding["intercept"] == control_encoding["intercept"]
    assert store.get_dataframe(dataset_id).to_dicts() == imported.to_dicts()
    assert fit["meta"]["warnings"] == ([RANGE_WARNING] if expected_warning else [])
