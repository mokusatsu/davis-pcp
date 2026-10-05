"""All 31 original-coded ATOPP items: exploratory numerical contracts, not scoring."""
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
                        "atopp_r_reference" / "references.json").read_text())


@pytest.fixture
def atopp(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (datasets, factor_analysis):
        monkeypatch.setattr(module, "store", store)
    spec = sample_spec(REFERENCE["sampleId"])
    for field, hash_field in (("dataFile", "dataSha256"), ("codebookFile", "codebookSha256")):
        assert hashlib.sha256(asset_path(spec[field]).read_bytes()).hexdigest() == REFERENCE[hash_field]
    with TestClient(app) as client:
        imported = client.post("/api/v1/datasets/import/sample", json={"sampleId": REFERENCE["sampleId"]})
        assert imported.status_code == 200, imported.text
        did = imported.json()["datasetId"]
        frame, book = store.get_dataframe(did), store.load_codebook(did)
        assert frame.height == 541 and len(book["columns"]) == 31
        assert not any(column.get("isReversed") for column in book["columns"])
        for column in book["columns"]:
            assert column["scaleType"] == "ordinal"
            assert column["categoryOrder"] == ["1", "2", "3", "4", "5"]
            assert not column.get("missingCodes")
            assert set(frame[column["name"]].to_list()) == {1, 2, 3, 4, 5}
        context = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                   "scope": "all", "weightMode": "none"}
        yield client, store, frame, book, context


@pytest.mark.parametrize("mode", ["pearson", "polychoric"])
def test_full_raw_atopp_efa_matches_equivalent_independent_r(atopp, mode):
    client, store, frame, book, context = atopp
    pearson = mode == "pearson"
    response = client.post("/api/v1/models/factor-analysis", json={
        "method": "efa", "schemaVersion": "factor_extensions.1", "context": context,
        "variables": [{"columnId": column["columnId"], "measurement": "ordinal",
                       "treatment": "continuous_approximation" if pearson else "ordinal",
                       "categoryOrder": column["categoryOrder"], "reverse": False,
                       "approximationAcknowledged": pearson} for column in book["columns"]],
        "correlation": mode, "extraction": "ml" if pearson else "minres", "nFactors": 3,
        "rotation": "none", "scoreMethod": "none", "parallelAnalysis": {"enabled": False},
        "nStarts": 3, "maxIterations": 1000, "uniquenessLower": .005, "seed": 19})
    assert response.status_code == 200, response.text
    result = response.json()
    details, summary, reference = result["details"], result["summary"], REFERENCE[mode]
    assert result["meta"]["fitCount"] == 541
    assert result["meta"]["excludedCount"] == 0
    assert summary["nVariables"] == 31 and summary["nFactors"] == 3
    assert summary["solutionStatus"] == "admissible"
    assert summary["modelDf"] == 375
    assert summary["scoreMethod"] == "none" and summary["scoreInterpretation"] is None
    assert result["capabilities"]["rows"] is False
    np.testing.assert_allclose(details["sampleCorrelation"], reference["sampleCorrelation"],
                               atol=1e-12 if pearson else 1e-6, rtol=0)
    np.testing.assert_allclose(details["uniqueness"], reference["uniqueness"], atol=1e-5, rtol=0)
    np.testing.assert_allclose(details["reproducedCorrelation"], reference["reproducedCorrelation"],
                               atol=1e-5, rtol=0)
    # The ordinal objective differs by 7.52e-8 from independently estimated
    # pair correlations; this bound includes that recorded estimator error.
    assert summary["objective"]["value"] == pytest.approx(reference["metrics"]["objective"], abs=1e-7, rel=0)
    if pearson:
        inference = details["referenceInference"]["fit"]
        assert summary["inferenceStatus"] == "available"
        assert inference["statistic"] == pytest.approx(reference["metrics"]["statistic"], abs=1e-5, rel=0)
        assert inference["df"] == reference["metrics"]["df"] == 375
        assert inference["pValue"] == pytest.approx(reference["metrics"]["pValue"], rel=1e-6, abs=0)
    else:
        assert len(details["correlationPairs"]) == len(reference["pairReferences"]) == 465
        pairs = {tuple(item["pair"]): item for item in details["correlationPairs"]}
        for pair in reference["pairReferences"]:
            actual = pairs[pair["first"] - 1, pair["second"] - 1]
            assert actual["status"] == "success"
            assert actual["rho"] == pytest.approx(pair["rho"], abs=1e-6, rel=0)
            assert actual["negLogLik"] == pytest.approx(pair["nll"], abs=1e-5, rel=0)
            assert actual["integrationError"] <= 1e-10
        np.testing.assert_allclose([item["cuts"] for item in details["thresholds"]],
                                   reference["thresholds"], atol=1e-12, rtol=0)
        assert summary["inferenceStatus"] == "not_implemented"
    assert store.get_dataframe(context["datasetId"]).equals(frame)
    assert store.load_codebook(context["datasetId"]) == book
