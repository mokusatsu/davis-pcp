"""Full28-item Türkiye API EFA against independently integrated R references."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, factor_analysis
from app.config import settings
from app.main import app
from app.services.builtin_samples import asset_path, sample_spec
from app.storage.dataset_store import DatasetStore

REFERENCE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" /
                        "turkiye_r_reference" / "references.json").read_text())


@pytest.fixture
def turkiye(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (datasets, factor_analysis):
        monkeypatch.setattr(module, "store", store)
    spec = sample_spec(REFERENCE["sampleId"])
    for field, hash_field in (("dataFile", "dataSha256"), ("codebookFile", "codebookSha256")):
        assert hashlib.sha256(asset_path(spec[field]).read_bytes()).hexdigest() == REFERENCE[hash_field]
    with TestClient(app) as client:
        response = client.post("/api/v1/datasets/import/sample", json={"sampleId": REFERENCE["sampleId"]})
        assert response.status_code == 200, response.text
        did = response.json()["datasetId"]
        frame, book = store.get_dataframe(did), store.load_codebook(did)
        context = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                   "scope": "all", "weightMode": "none"}
        yield client, store, frame, book, context


def request(book, context, mode):
    pearson = mode == "pearson"
    return {"method": "efa", "schemaVersion": "factor_extensions.1", "context": context,
        "variables": [{"columnId": c["columnId"], "measurement": "ordinal",
                       "treatment": "continuous_approximation" if pearson else "ordinal",
                       "categoryOrder": c["categoryOrder"], "approximationAcknowledged": pearson}
                      for c in book["columns"]],
        "correlation": mode, "extraction": "ml" if pearson else "minres", "nFactors": 3,
        "rotation": "none", "scoreMethod": "none", "parallelAnalysis": {"enabled": False},
        "nStarts": 3, "maxIterations": 1000, "uniquenessLower": .005, "seed": 19}


@pytest.mark.parametrize("mode", ["pearson", "polychoric"])
def test_full_turkiye_efa_matches_equivalent_r_estimator(turkiye, mode):
    client, store, frame, book, context = turkiye
    response = client.post("/api/v1/models/factor-analysis", json=request(book, context, mode))
    assert response.status_code == 200, response.text
    result = response.json(); details = result["details"]; reference = REFERENCE[mode]
    assert result["meta"]["fitCount"] == 600
    assert result["meta"]["excludedCount"] == 0
    assert result["summary"]["nVariables"] == 28
    assert result["summary"]["nFactors"] == 3
    assert result["summary"]["solutionStatus"] == "admissible"
    np.testing.assert_allclose(details["sampleCorrelation"], reference["sampleCorrelation"], atol=1e-12 if mode == "pearson" else 1e-6, rtol=0)
    np.testing.assert_allclose(details["uniqueness"], reference["uniqueness"], atol=1e-5, rtol=0)
    np.testing.assert_allclose(details["reproducedCorrelation"], reference["reproducedCorrelation"], atol=1e-5, rtol=0)
    assert result["summary"]["objective"]["value"] == pytest.approx(reference["metrics"]["objective"], abs=1e-7, rel=0)
    if mode == "pearson":
        inference = details["referenceInference"]["fit"]
        assert inference["statistic"] == pytest.approx(reference["metrics"]["statistic"], abs=1e-5, rel=0)
        assert inference["df"] == reference["metrics"]["df"] == 297
        assert inference["pValue"] == pytest.approx(reference["metrics"]["pValue"], rel=1e-6, abs=0)
    else:
        assert len(details["correlationPairs"]) == 378
        pairs = {tuple(item["pair"]): item for item in details["correlationPairs"]}
        for pair in reference["pairReferences"]:
            actual = pairs[pair["first"] - 1, pair["second"] - 1]
            assert actual["status"] == "success"
            assert actual["rho"] == pytest.approx(pair["rho"], abs=1e-6, rel=0)
            assert actual["negLogLik"] == pytest.approx(pair["nll"], abs=1e-5, rel=0)
        np.testing.assert_allclose([item["cuts"] for item in details["thresholds"]], reference["thresholds"], atol=1e-12, rtol=0)
        assert result["summary"]["inferenceStatus"] == "not_implemented"
        assert result["capabilities"]["rows"] is False
    assert store.get_dataframe(context["datasetId"]).equals(frame)


def test_turkiye_scope_missing_a_declared_level_stops_before_fit(turkiye):
    client, _, frame, book, context = turkiye
    ids = [rid for rid, value in frame.select("__rowId__", "Q1").rows() if value < 5]
    assert len(ids) == 510
    scoped = {**context, "scope": "explicit", "rowIds": ids}
    response = client.post("/api/v1/models/factor-analysis", json=request(book, scoped, "polychoric"))
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "FA_UNOBSERVED_CATEGORY"
    assert error["details"]["columnIds"] == [book["columns"][0]["columnId"]]
    attempt = client.get(f"/api/v1/analysis-attempts/{error['details']['attemptId']}")
    assert attempt.status_code == 200
    assert attempt.json()["attemptId"] == error["details"]["attemptId"]
    results = settings.workspace_dir / "analysis-results"
    assert not results.exists() or not list(results.iterdir())
