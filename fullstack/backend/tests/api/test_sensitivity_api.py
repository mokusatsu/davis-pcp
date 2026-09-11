"""Feature 24-S: sensitivity comparison, robustness rule, no auto-apply."""
from __future__ import annotations

import numpy as np
import pytest
from scipy import stats
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def sensitivity_ds():
    with TestClient(app) as client:
        # b-group mean stays above a-group mean with and without the outlier,
        # so direction is preserved and the comparison is meaningful.
        rows = [f"{'a' if i < 20 else 'b'},{10 + (i % 5) if i < 20 else (20 + (i % 5) if i < 39 else 100.0)}"
                for i in range(40)]
        text = "seg,score\n" + "\n".join(rows) + "\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("s.csv", text, "text/csv")}).json()["datasetId"]
        cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: dict(c) for c in cb["columns"]}
        by_name["score"].update(role="question")
        assert client.put(f"/api/v1/datasets/{dataset_id}/codebook",
                          json={"columns": list(by_name.values())}).status_code == 200
        yield client, dataset_id
        client.delete(f"/api/v1/datasets/{dataset_id}")


def body(ds: str, **overrides) -> dict:
    base = {"datasetId": ds, "targetColumn": "score",
            "candidate": {"type": "subgroup_diff", "groupColumn": "seg",
                          "compareGroups": ["a", "b"]},
            "outlierMethod": "standardized_deviation", "threshold": 3.0, "seed": 42}
    return {**base, **overrides}


def _welch_difference_interval(a: np.ndarray, b: np.ndarray) -> tuple[float, list[float]]:
    """Independent oracle: mean contrast, Welch SE and Satterthwaite df."""
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    se2 = va + vb
    df = se2 ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))
    estimate = float(a.mean() - b.mean())
    radius = float(stats.t.ppf(0.975, df) * np.sqrt(se2))
    return estimate, [estimate - radius, estimate + radius]


def test_sensitivity_compares_baseline_and_excluded(sensitivity_ds):
    client, ds = sensitivity_ds
    response = client.post("/api/v1/robustness/sensitivity", json=body(ds))
    assert response.status_code == 200, response.text
    res = response.json()
    assert res["method"] == "standardized_deviation" and res["threshold"] == 3.0
    # SN03 fixes the estimator, not an undocumented suffix on its label.
    # This request is a two-group contrast: Welch, not a one-sample interval.
    assert isinstance(res["confidenceMethod"], str)
    assert "welch" in res["confidenceMethod"].casefold()
    assert res["bootstrapB"] is None and res["seed"] is None
    assert res["baseline"]["n"] == 40 and res["sensitivity"]["n"] == 39
    assert res["sensitivity"]["excludedN"] == 1
    # These vectors reproduce the submitted fixture, not application output.
    a = np.array([10 + (i % 5) for i in range(20)], dtype=float)
    b = np.array([20 + (i % 5) for i in range(20, 39)] + [100.0])
    for key, right in (("baseline", b), ("sensitivity", b[:-1])):
        estimate, interval = _welch_difference_interval(a, right)
        assert res[key]["effectSize"] == pytest.approx(estimate, rel=0, abs=1e-4)
        assert res[key]["confidenceInterval"] == pytest.approx(interval, rel=0, abs=1e-4)
    assert res["comparison"]["directionPreserved"] is True
    assert res["comparison"]["maxRelativeChange"] == 0.20
    assert res["comparison"]["reason"] in (
        "direction_and_ci_status_preserved", "direction_or_ci_status_changed",
        "relative_change_exceeded")
    assert res["weightApplied"] is False
    assert len(res["outlierRowIds"]) == 1, "only the 100.0 row must be flagged"


def test_sensitivity_kpi_small_sample_uses_student_t(sensitivity_ds):
    """SN03: four observations expose a fixed-1.96 or a Welch-label fallback."""
    client, _ = sensitivity_ds
    values = np.array([1.0, 2.0, 3.0, 4.0])
    imported = client.post(
        "/api/v1/datasets/import",
        files={"file": ("kpi.csv", "score\n1\n2\n3\n4\n", "text/csv")})
    assert imported.status_code == 200, imported.text
    ds = imported.json()["datasetId"]
    try:
        cb = client.get(f"/api/v1/datasets/{ds}/codebook").json()
        by_name = {c["name"]: dict(c) for c in cb["columns"]}
        by_name["score"].update(role="question", scaleType="ratio")
        updated = client.put(f"/api/v1/datasets/{ds}/codebook",
                             json={"columns": list(by_name.values())})
        assert updated.status_code == 200, updated.text
        response = client.post("/api/v1/robustness/sensitivity",
                               json=body(ds, candidate={"type": "kpi"}, threshold=100.0))
        assert response.status_code == 200, response.text
        res = response.json()
        assert isinstance(res["confidenceMethod"], str)
        assert "student" in res["confidenceMethod"].casefold()
        radius = float(stats.t.ppf(0.975, len(values) - 1)
                       * values.std(ddof=1) / np.sqrt(len(values)))
        interval = [float(values.mean() - radius), float(values.mean() + radius)]
        for key in ("baseline", "sensitivity"):
            assert res[key]["n"] == 4
            assert res[key]["effectSize"] == pytest.approx(2.5, rel=0, abs=1e-4)
            assert res[key]["confidenceInterval"] == pytest.approx(interval, rel=0, abs=1e-4)
        assert res["sensitivity"]["excludedN"] == 0
        assert res["outlierRowIds"] == []
        assert res["bootstrapB"] is None and res["seed"] is None
    finally:
        client.delete(f"/api/v1/datasets/{ds}")


def test_sensitivity_rejects_bad_target_and_threshold(sensitivity_ds):
    client, ds = sensitivity_ds
    assert client.post("/api/v1/robustness/sensitivity",
                       json=body(ds, targetColumn="missing")).status_code == 422
    assert client.post("/api/v1/robustness/sensitivity",
                       json=body(ds, threshold=-1)).status_code == 422
    assert client.post("/api/v1/robustness/sensitivity",
                       json={**body(ds), "weightColumn": "nope"}).status_code == 422


def test_existing_evaluate_untouched(sensitivity_ds):
    client, ds = sensitivity_ds
    res = client.post("/api/v1/robustness/evaluate", json={"datasetId": ds}).json()
    assert "conclusions" in res
