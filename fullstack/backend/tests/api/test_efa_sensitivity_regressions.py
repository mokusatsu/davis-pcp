"""EFA sensitivity regressions for both supported original-ordinal treatments."""
from __future__ import annotations

import copy
import threading

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.api import factor_analysis as fa
from app.services import factor_analysis_service as svc

client = TestClient(app)


def _ordinal_request(treatment):
    # Deliberately nonnumeric spacing/order: sensitivity must use final ranks,
    # including reversal, rather than raw codes or a second reversal.
    rng = np.random.default_rng(420)
    z = rng.normal(size=(240, 1)) * 0.8 + rng.normal(size=(240, 4)) * 0.75
    ranks = np.digitize(z, [-0.5, 0.5])
    raw_codes = np.array([20, 1, 5])[ranks]
    values = {f"q{j}": raw_codes[:, j].tolist() for j in range(4)}
    values["q2"][3] = None
    response = client.post("/api/v1/datasets/import", files={
        "file": ("ordinal-sensitivity.csv", pl.DataFrame(values).write_csv().encode(), "text/csv")})
    assert response.status_code == 200, response.text
    dataset_id = response.json()["datasetId"]
    cb = fa.store.load_codebook(dataset_id)
    for spec in cb["columns"]:
        spec.update(scaleType="ordinal", categoryOrder=["20", "1", "5"])
    fa.store.save_codebook(dataset_id, cb)
    meta = fa.store.get_meta(dataset_id)
    cb = fa.store.load_codebook(dataset_id)
    variables = [{"columnId": spec["columnId"], "measurement": "ordinal",
                  "treatment": treatment, "categoryOrder": ["20", "1", "5"],
                  "reverse": j == 0,
                  "approximationAcknowledged": treatment == "continuous_approximation"}
                 for j, spec in enumerate(cb["columns"])]
    request = {
        "method": "efa", "schemaVersion": "factor_extensions.1",
        "context": {"datasetId": dataset_id,
                    "expectedDataRevision": meta["dataRevision"],
                    "expectedSchemaRevision": cb["schemaRevision"],
                    "scope": "all", "weightMode": "none", "missingPolicy": "exclude",
                    "imputationPolicy": "use_current_values"},
        "variables": variables,
        "correlation": "polychoric" if treatment == "ordinal" else "pearson",
        "extraction": "minres", "nFactors": 1, "rotation": "none", "scoreMethod": "none",
        "nStarts": 1, "maxIterations": 300, "seed": 1,
        "parallelAnalysis": {"enabled": True, "iterations": 100, "seed": 42},
        "sensitivityAnalysis": {"enabled": True, "approximationAcknowledged": True},
    }
    ranks[:, 0] = 2 - ranks[:, 0]
    return request, np.delete(ranks, 3, axis=0)


@pytest.mark.parametrize("treatment", ["ordinal", "continuous_approximation"])
def test_sensitivity_completes_from_both_primary_treatments(treatment, monkeypatch):
    request, ranks = _ordinal_request(treatment)
    original_request = copy.deepcopy(request)
    correlation_inputs = []
    parallel_inputs = []
    estimate = svc.estimate_correlation
    parallel = svc.run_parallel_analysis

    def record_correlation(fit, req):
        correlation_inputs.append((copy.deepcopy(fit), req["correlation"]))
        return estimate(fit, req)

    def record_parallel(fit, req, observed, perm_index=None, *, progress=None):
        if perm_index is not None:
            parallel_inputs.append((copy.deepcopy(fit), perm_index.copy(), progress))
        return parallel(fit, req, observed, perm_index, progress=progress)

    monkeypatch.setattr(svc, "estimate_correlation", record_correlation)
    monkeypatch.setattr(svc, "run_parallel_analysis", record_parallel)
    response = client.post("/api/v1/models/factor-analysis", json=request)
    assert response.status_code == 200, response.text
    main = response.json()
    assert request == original_request
    assert main["summary"]["computationStatus"] == "completed"
    assert main["summary"]["solutionStatus"] == "admissible"
    assert main["meta"]["fitCount"] == len(ranks)
    assert main["config"]["correlation"] == request["correlation"]
    for resolved in main["meta"]["measurementResolution"]:
        assert resolved["originalMeasurement"] == "ordinal"
        assert resolved["effectiveMeasurement"] == treatment
        assert resolved["approximation"] == (treatment == "continuous_approximation")
    assert main["details"]["variables"][0]["order"] == ["5", "1", "20"]
    comparison_id = main["details"]["sensitivityAnalysis"]["comparisonId"]
    got = client.get(f"/api/v1/analysis-comparisons/{comparison_id}")
    assert got.status_code == 200
    comparison = got.json()
    assert comparison["status"] == "completed", comparison
    assert comparison["primaryResultId"] == main["resultId"]
    assert comparison["treatments"] == [treatment] * 4
    assert comparison["completedIterations"] == comparison["totalIterations"] == 200
    assert comparison["progress"] == 1.0
    for side in ("pearsonParallel", "polychoricParallel"):
        assert comparison["diagnostics"][side]["status"] == "completed"
        assert comparison["diagnostics"][side]["iterationsSucceeded"] == 100
        assert comparison["diagnostics"][side]["iterationsFailed"] == 0
    for fit, correlation in correlation_inputs:
        assert fit["nCats"] == [3] * 4
        if correlation == "polychoric":
            assert fit["kind"] == "codes"
            np.testing.assert_array_equal(fit["codes"], ranks)
        else:
            assert fit["kind"] == "scores"
            np.testing.assert_array_equal(fit["x"], ranks + 1.0)
    assert len(parallel_inputs) == 2
    assert all(callable(item[2]) for item in parallel_inputs)
    np.testing.assert_array_equal(parallel_inputs[0][1], parallel_inputs[1][1])
    np.testing.assert_array_equal(parallel_inputs[0][0]["x"], ranks + 1.0)
    np.testing.assert_array_equal(parallel_inputs[1][0]["codes"], ranks)


@pytest.fixture
def comparison_record(monkeypatch):
    # Detached persisted snapshots expose stale-write bugs masked by shared dicts.
    records = {"test-comparison": {
        "comparisonId": "test-comparison", "status": "running", "stage": "sensitivity",
        "primaryResultId": "primary-result", "completedIterations": 0,
        "totalIterations": 200, "progress": 0.0}}
    monkeypatch.setattr(fa, "_load_comparison", lambda cid: copy.deepcopy(records[cid]))
    monkeypatch.setattr(fa, "_remember_comparison",
                        lambda rec: records.update({rec["comparisonId"]: copy.deepcopy(rec)}))
    monkeypatch.setattr(fa, "_comparison_cancel", {})
    monkeypatch.setattr(fa, "_comparison_threads", {})
    return records


def test_terminal_comparison_keeps_latest_progress_and_primary_result(comparison_record):
    assert fa._note_progress("test-comparison", "parallel_analysis", 200, 200)
    out, cid = fa._finish_comparison("test-comparison", {"status": "completed", "stage": "done"})
    assert cid == "test-comparison"
    assert out["completedIterations"] == 200
    assert out["progress"] == 1.0
    assert out["primaryResultId"] == "primary-result"
    # A late cancellation/progress callback cannot rewrite a completed result.
    assert fa.cancel_comparison(cid)["cancelled"] is False
    assert fa._note_progress(cid, "parallel_analysis", 25, 200) is False
    assert comparison_record[cid] == out


@pytest.mark.parametrize("settled", [False, True])
def test_cancellation_wins_over_late_completion(comparison_record, settled):
    cid = "test-comparison"
    assert fa._note_progress(cid, "parallel_analysis", 125, 200)
    if settled:
        result = fa.cancel_comparison(cid)
        assert result["cancelled"] is True
        assert result["comparisonStatus"] == "cancelled"
    else:
        # Worker reaches completion after a cancellation signal, before the
        # cancelling endpoint has had a chance to persist the terminal state.
        event = threading.Event()
        event.set()
        fa._comparison_cancel[cid] = event
    out, _ = fa._finish_comparison(cid, {"status": "completed", "stage": "done", "assessment": "stable"})
    assert out["status"] == out["stage"] == "cancelled"
    assert out["reasonCode"] == "COMPARISON_CANCELLED"
    assert out["assessment"] is None
    assert out["completedIterations"] == 125
    assert out["primaryResultId"] == "primary-result"
    assert fa._note_progress(cid, "parallel_analysis", 200, 200) is False
    assert comparison_record[cid] == out


def test_background_worker_does_not_republish_stale_terminal_snapshot(comparison_record, monkeypatch):
    cid = "test-comparison"

    def finish_then_link(*args, **kwargs):
        stale, _ = fa._finish_comparison(cid, {"status": "completed", "stage": "done"})
        current = fa._load_comparison(cid)
        current["primaryResultId"] = "linked-after-terminal-update"
        fa._remember_comparison(current)
        return stale, cid

    monkeypatch.setattr(fa, "_run_sensitivity", finish_then_link)
    fa._run_sensitivity_worker("dataset", {}, {}, {}, {}, None, {}, {}, cid)
    assert comparison_record[cid]["status"] == "completed"
    assert comparison_record[cid]["primaryResultId"] == "linked-after-terminal-update"


@pytest.mark.parametrize("cancelled", [False, True])
def test_background_worker_error_respects_cancel_signal(comparison_record, monkeypatch, cancelled):
    cid = "test-comparison"

    def fail(*args, **kwargs):
        if cancelled:
            event = threading.Event()
            event.set()
            fa._comparison_cancel[cid] = event
        raise RuntimeError("controlled worker failure")

    monkeypatch.setattr(fa, "_run_sensitivity", fail)
    fa._run_sensitivity_worker("dataset", {}, {}, {}, {}, None, {}, {}, cid)
    result = comparison_record[cid]
    assert result["primaryResultId"] == "primary-result"
    if cancelled:
        assert result["status"] == "cancelled"
        assert result["reasonCode"] == "COMPARISON_CANCELLED"
        assert result["assessment"] is None
    else:
        assert result["status"] == "failed"
        assert result["reasonCode"] == "COMPARISON_WORKER_FAILED"
        assert result["diagnostics"]["error"] == "controlled worker failure"
