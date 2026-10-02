"""Regression coverage for service-to-kernel PA progress and cancellation."""
from __future__ import annotations

import numpy as np
import pytest

from app.services.factor_analysis_service import run_parallel_analysis


def _input():
    x = np.random.default_rng(25).normal(size=(80, 4))
    fit = {"kind": "scores", "x": x, "nCats": []}
    req = {"correlation": "pearson", "parallelAnalysis": {
        "enabled": True, "iterations": 55, "seed": 29}}
    return fit, req, np.corrcoef(x, rowvar=False)


def test_service_forwards_progress_without_changing_parallel_results():
    fit, req, observed = _input()
    calls = []
    actual = run_parallel_analysis(
        fit, req, observed, progress=lambda done, total: calls.append((done, total)))
    expected = run_parallel_analysis(fit, req, observed)
    assert calls == [(25, 55), (50, 55), (55, 55)]
    assert actual["status"] == "completed"
    assert actual["iterationsSucceeded"] == 55
    assert actual["suggestedFactors"] == expected["suggestedFactors"]
    np.testing.assert_array_equal(actual["referenceQuantiles"], expected["referenceQuantiles"])


@pytest.mark.parametrize("stop_iteration", [False, True])
def test_service_cancellation_keeps_partial_replicates_out_of_inference(stop_iteration):
    fit, req, observed = _input()
    calls = []

    def progress(done, total):
        calls.append((done, total))
        if stop_iteration:
            raise StopIteration
        return False

    result = run_parallel_analysis(fit, req, observed, progress=progress)
    assert calls == [(25, 55)]
    assert result["status"] == "cancelled"
    assert result["reasonCode"] == "PA_CANCELLED"
    assert result["iterationsRequested"] == 55
    assert result["iterationsSucceeded"] == 25
    assert result["referenceQuantiles"] is None
    assert result["suggestedFactors"] is None
    assert result["exceedanceRanks"] == []


def test_disabled_parallel_analysis_does_not_call_progress():
    fit, req, observed = _input()
    req["parallelAnalysis"]["enabled"] = False
    result = run_parallel_analysis(
        fit, req, observed, progress=lambda *_: pytest.fail("disabled PA ran"))
    assert result["status"] == "not_requested"
    assert result["iterationsRequested"] == 0
