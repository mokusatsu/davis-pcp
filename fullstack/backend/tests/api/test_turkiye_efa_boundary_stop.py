"""Near-unit pair estimates stop EFA before extraction, even with a PD matrix."""
from __future__ import annotations

import hashlib
import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, factor_analysis
from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def turkiye(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, "store", store)
    monkeypatch.setattr(factor_analysis, "store", store)
    monkeypatch.setattr(factor_analysis, "_attempts", {})
    monkeypatch.setattr(factor_analysis, "_comparisons", {})
    with TestClient(app) as client:
        did = client.post("/api/v1/datasets/import/sample", json={"sampleId": "turkiye-student-evaluation-600"}).json()["datasetId"]
        yield client, store, did



def durable_attempt(client, attempt_id, boundary=True):
    before = client.get(f"/api/v1/analysis-attempts/{attempt_id}")
    assert before.status_code == 200
    factor_analysis._attempts.clear()
    after = client.get(f"/api/v1/analysis-attempts/{attempt_id}")
    assert after.status_code == 200
    document = after.json()
    # Durable storage adds a checksum envelope; analysis evidence is unchanged.
    assert {key: value for key, value in document.items() if key != "files"} == before.json()
    artifact = settings.workspace_dir / "analysis-attempts" / attempt_id / "attempt.json"
    persisted = json.loads(artifact.read_text())
    files = persisted.pop("files")
    payload = json.dumps(persisted, ensure_ascii=False, indent=2, allow_nan=False).encode()
    assert files["attempt.json"] == hashlib.sha256(payload).hexdigest()
    assert document["files"] == files
    assert document["stage"] == "correlation" and document["status"] == "failed"
    assert document["diagnostics"], "Correlation failure evidence was discarded"
    def dictionaries(value):
        if isinstance(value, dict):
            yield value
            for child in value.values():
                yield from dictionaries(child)
        elif isinstance(value, list):
            for child in value:
                yield from dictionaries(child)
    pairs = [record for record in dictionaries(document["diagnostics"])
             if record.get("pair") == [0, 1] and "rho" in record]
    assert pairs, "Failed pair estimate missing from durable diagnostics"
    if boundary:
        assert any(pair["rho"] is not None and abs(abs(pair["rho"])-.9999) < 1e-5 for pair in pairs)
        assert all("integrationError" in pair and np.isfinite(pair["integrationError"])
                   and 0 <= pair["integrationError"] <= 1e-10 for pair in pairs)
    return document


def request(did, book, names):
    by_name = {c["name"]: c for c in book["columns"]}
    return {"context": {"datasetId": did, "expectedDataRevision": 1,
                        "expectedSchemaRevision": book["schemaRevision"], "weightMode": "none"},
            "variables": [{"columnId": by_name[name]["columnId"], "measurement": "ordinal",
                           "treatment": "ordinal", "categoryOrder": ["1", "2", "3", "4", "5"]} for name in names],
            "correlation": "polychoric", "extraction": "minres", "nFactors": 1,
            "rotation": "none", "scoreMethod": "none", "parallelAnalysis": {"enabled": False},
            "nStarts": 1, "maxIterations": 100, "seed": 19}


def test_boundary_correlation_status_prevents_extraction_and_saves_attempt(turkiye, monkeypatch):
    client, store, did = turkiye
    matrix = np.asarray([[1., .9999, .2], [.9999, 1., .2], [.2, .2, 1.]])
    assert np.linalg.eigvalsh(matrix).min() > 0
    def boundary_estimate(*_args, **_kwargs):
        return {"correlation": matrix, "mean": None, "std": None, "thresholds": None,
                "pairs": [{"pair": [0, 1], "rho": .9999, "status": "boundary", "boundary": True,
                           "reasonCode": "FA_CORRELATION_BOUNDARY", "integrationError": 3e-12}],
                "status": "boundary", "reasonCode": "FA_CORRELATION_BOUNDARY"}
    monkeypatch.setattr(factor_analysis.fa_svc, "estimate_correlation", boundary_estimate)
    extraction_calls = []
    original_fit = factor_analysis.fa_svc.fit_single_q
    def tracked_fit(*args, **kwargs):
        extraction_calls.append(True)
        return original_fit(*args, **kwargs)
    monkeypatch.setattr(factor_analysis.fa_svc, "fit_single_q", tracked_fit)
    response = client.post("/api/v1/models/factor-analysis", json=request(did, store.load_codebook(did), ["Q1", "Q2", "Q3"]))
    assert extraction_calls == [], "Boundary estimate reached extraction"
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "FA_CORRELATION_BOUNDARY"
    attempt = client.get(f"/api/v1/analysis-attempts/{error['details']['attemptId']}")
    assert attempt.status_code == 200
    assert attempt.json()["stage"] == "correlation"
    assert attempt.json()["status"] == "failed"
    durable_attempt(client, error["details"]["attemptId"])
    results = settings.workspace_dir / "analysis-results"
    assert not results.exists() or not list(results.iterdir())


@pytest.mark.parametrize("expression", ["Q1", "6 - Q1"], ids=["copied-question", "reversed-copy"])
def test_actual_turkiye_derived_duplicate_stops_at_correlation_boundary(turkiye, expression):
    client, store, did = turkiye
    calculated = client.post(f"/api/v1/datasets/{did}/calculate", json={
        "expression": expression, "columnName": "Q1_copy"})
    assert calculated.status_code == 200, calculated.text
    book = store.load_codebook(did)
    copy_spec = next(c for c in book["columns"] if c["name"] == "Q1_copy")
    updated = client.put(f"/api/v1/datasets/{did}/codebook", json={"expectedSchemaRevision": book["schemaRevision"],
        "columns": [{"columnId": copy_spec["columnId"], "role": "question", "scaleType": "ordinal",
                     "categoryOrder": ["1", "2", "3", "4", "5"]}]})
    assert updated.status_code == 200, updated.text
    book = store.load_codebook(did)
    before = store.get_dataframe(did)
    payload = request(did, book, ["Q1", "Q1_copy", "Q2", "Q3"])
    payload["context"]["expectedDataRevision"] = store.get_meta(did)["dataRevision"]
    response = client.post("/api/v1/models/factor-analysis", json=payload)
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "FA_CORRELATION_BOUNDARY"
    attempt = client.get(f"/api/v1/analysis-attempts/{error['details']['attemptId']}")
    assert attempt.status_code == 200
    assert attempt.json()["stage"] == "correlation"
    assert attempt.json()["status"] == "failed"
    durable_attempt(client, error["details"]["attemptId"])
    assert store.get_dataframe(did).equals(before)
    assert store.load_codebook(did) == book
    results = settings.workspace_dir / "analysis-results"
    assert not results.exists() or not list(results.iterdir())


@pytest.mark.parametrize("failure_mode", ["boundary", "non-positive-definite"])
@pytest.mark.parametrize("failed_side", ["pearson", "polychoric"])
def test_sensitivity_boundary_side_stops_before_its_extraction(turkiye, monkeypatch, failed_side, failure_mode):
    client, store, did = turkiye
    frame = store.get_dataframe(did)
    codes = frame.select("Q1", "Q2", "Q3").to_numpy()-1
    matrix = np.asarray([[1., .9999, .2], [.9999, 1., .2], [.2, .2, 1.]])
    ordinary = np.asarray([[1., .4, .2], [.4, 1., .2], [.2, .2, 1.]])
    if failure_mode == "non-positive-definite":
        matrix = np.asarray([[1., .9, .9], [.9, 1., -.9], [.9, -.9, 1.]])
    assert (np.linalg.eigvalsh(matrix).min() > 0) == (failure_mode == "boundary")
    def estimate(_fit, config):
        is_failed_side = config["correlation"] == failed_side
        is_boundary = is_failed_side and failure_mode == "boundary"
        return {"correlation": matrix if is_failed_side else ordinary, "pairs": [],
                "status": "boundary" if is_boundary else "success",
                "reasonCode": "FA_CORRELATION_BOUNDARY" if is_boundary else None}
    calls = []
    def extract(_matrix, config, *_args, **_kwargs):
        side = config["correlation"]
        calls.append(side)
        if side == failed_side:
            return {"status": "failed", "reasonCode": "TEST_EXTRACTION_REACHED"}
        return {"status": "success", "solutionStatus": "admissible"}
    monkeypatch.setattr(factor_analysis.fa_svc, "estimate_correlation", estimate)
    monkeypatch.setattr(factor_analysis.fa_svc, "fit_single_q", extract)
    rd = request(did, store.load_codebook(did), ["Q1", "Q2", "Q3"])
    rd.update(correlation="pearson", extraction="ml")
    for variable in rd["variables"]:
        variable.update(treatment="continuous_approximation", approximationAcknowledged=True)
    prep = {"rankCodes": codes, "fitIndex": np.arange(frame.height),
            "fitIds": frame["__rowId__"].to_list(), "revisions": {"dataRevision": 1, "schemaRevision": 1}}
    result, comparison_id = factor_analysis._run_sensitivity(
        did, rd, rd, prep, {"nCats": [5, 5, 5]}, ordinary, {}, {})
    assert failed_side not in calls
    assert result["status"] == "failed"
    assert result["reasonCode"] == ("FA_CORRELATION_BOUNDARY" if failure_mode == "boundary" else "FA_NON_POSITIVE_DEFINITE")
    assert result["assessment"] == "indeterminate"
    saved = client.get(f"/api/v1/analysis-comparisons/{comparison_id}")
    assert saved.status_code == 200
    assert saved.json()["status"] == "failed"


def test_failed_integration_detail_survives_durable_attempt_reload(turkiye, monkeypatch):
    client, store, did = turkiye
    pair = {"pair": [0, 1], "rho": None, "status": "failed", "boundary": False,
            "reasonCode": "FA_CORRELATION_NONCONVERGENCE", "integrationError": 1e-4,
            "integrationFailureCount": 1, "integrationFailures": [{
                "rowCategory": 0, "columnCategory": 0, "rho": .9999,
                "detail": "forced adaptive refinement failure", "estimatedError": 1e-4}]}
    monkeypatch.setattr(factor_analysis.fa_svc, "estimate_correlation", lambda *_a, **_k: {
        "correlation": None, "status": "failed", "reasonCode": "FA_CORRELATION_NONCONVERGENCE",
        "pairs": [pair], "thresholds": None})
    response = client.post("/api/v1/models/factor-analysis", json=request(did, store.load_codebook(did), ["Q1", "Q2", "Q3"]))
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "FA_CORRELATION_NONCONVERGENCE"
    document = durable_attempt(client, error["details"]["attemptId"], boundary=False)
    retained = [item for diagnostic in document["diagnostics"] for item in diagnostic.get("pairs", [])]
    assert retained == [pair]
    results = settings.workspace_dir / "analysis-results"
    assert not results.exists() or not list(results.iterdir())
