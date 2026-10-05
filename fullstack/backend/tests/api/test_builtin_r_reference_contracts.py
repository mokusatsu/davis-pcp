"""Real built-in API fits versus separately generated, frozen R references.

R is not needed during pytest. Generator/version/source hashes accompany the
fixture. Tolerances reflect estimator stopping rules, not rounded UI output.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from scipy.special import softmax

from app.api import analysis_results, conjoint, datasets, factor_analysis, summaries
from app.config import settings
from app.main import app
from app.services.builtin_samples import asset_path, sample_spec
from app.storage.analysis_result_store import load_arrays
from app.storage.dataset_store import DatasetStore

FIXTURE_ROOT = Path(__file__).resolve().parents[1] / "fixtures" / "builtin_r_reference"
REFERENCE = json.loads((FIXTURE_ROOT / "references.json").read_text())


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (analysis_results, conjoint, datasets, factor_analysis, summaries):
        monkeypatch.setattr(module, "store", store)
    monkeypatch.setattr(summaries, "_cache", {})
    with TestClient(app) as client:
        yield client, store


def imported(api, sample_id, expected_hash):
    client, store = api
    assert hashlib.sha256(asset_path(sample_spec(sample_id)["dataFile"]).read_bytes()).hexdigest() == expected_hash
    response = client.post("/api/v1/datasets/import/sample", json={"sampleId": sample_id})
    assert response.status_code == 200, response.text
    meta = response.json()
    book = client.get(f"/api/v1/datasets/{meta['datasetId']}/codebook").json()
    context = {"datasetId": meta["datasetId"], "expectedDataRevision": meta.get("dataRevision", 1),
               "expectedSchemaRevision": book["schemaRevision"], "scope": "all", "weightMode": "none"}
    return client, store.get_dataframe(meta["datasetId"]), book, context


@pytest.mark.parametrize("sample_id", ["edss-efa-613x13", "edss-cfa-646x13"])
@pytest.mark.parametrize("correlation", ["pearson", "polychoric"])
def test_full_edss_api_efa_matches_independent_r_reference(api, sample_id, correlation):
    reference = REFERENCE["efa"][sample_id]
    client, frame, book, context = imported(api, sample_id, reference["dataSha256"])
    pearson = correlation == "pearson"
    variables = [{"columnId": c["columnId"], "measurement": "ordinal",
                  "treatment": "continuous_approximation" if pearson else "ordinal",
                  "categoryOrder": c["categoryOrder"], "approximationAcknowledged": pearson}
                 for c in book["columns"]]
    response = client.post("/api/v1/models/factor-analysis", json={
        "method": "efa", "schemaVersion": "factor_extensions.1", "context": context,
        "variables": variables, "correlation": correlation, "extraction": "ml" if pearson else "minres",
        "nFactors": 3, "rotation": "none", "scoreMethod": "none", "parallelAnalysis": {"enabled": False},
        "nStarts": 3, "maxIterations": 1000, "uniquenessLower": .005, "seed": 19})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["method"] == "efa"  # The named CFA sample does not make this CFA.
    assert body["meta"]["fitCount"] == reference["nRows"] == frame.height
    assert body["meta"]["excludedCount"] == 0
    assert body["summary"]["nVariables"] == 13
    actual, expected = body["details"], reference[correlation]
    np.testing.assert_allclose(actual["sampleCorrelation"], expected["sampleCorrelation"],
                               atol=1e-12 if pearson else 5e-5, rtol=0)
    np.testing.assert_allclose(actual["uniqueness"], expected["uniqueness"], atol=1e-4, rtol=0)
    np.testing.assert_allclose(actual["reproducedCorrelation"], expected["reproducedCorrelation"], atol=1e-4, rtol=0)
    assert body["summary"]["objective"]["value"] == pytest.approx(expected["metrics"]["objective"],
                                                                 abs=1e-8 if pearson else 1e-4, rel=0)
    if pearson:
        inference = actual["referenceInference"]["fit"]
        for field, tolerance in (("statistic", 1e-5), ("df", 0), ("pValue", 1e-8)):
            assert inference[field] == pytest.approx(expected["metrics"][field], abs=tolerance, rel=0)
    else:
        np.testing.assert_allclose([v["cuts"] for v in actual["thresholds"]], expected["thresholds"], atol=1e-12, rtol=0)
        assert actual["referenceInference"]["status"] == "not_implemented"
        assert body["capabilities"]["rows"] is False


def test_census_survey_descriptions_match_r_and_refuse_naive_inference(api):
    reference = REFERENCE["census"]
    client, _, book, context = imported(api, "census-kdd-adult600", reference["dataSha256"])
    response = client.post("/api/v1/summaries", json={"datasetId": context["datasetId"],
        "columns": ["weeks_worked", "migration_msa"], "weightMode": "dataset"})
    assert response.status_code == 200, response.text
    columns = response.json()["columns"]
    assert columns["weeks_worked"]["weighted"]["weightedMean"] == pytest.approx(reference["summary"]["weightedMean"], abs=5e-5, rel=0)
    assert columns["weeks_worked"]["weighted"]["weightedN"] == pytest.approx(reference["summary"]["weightedN"], abs=5e-5, rel=0)
    actual = {r["code"]: r for r in columns["migration_msa"]["weighted"]["distribution"]}
    for row in reference["masses"]:
        assert actual[row["code"]]["weightedCount"] == pytest.approx(row["mass"], abs=5e-5, rel=0)
        assert actual[row["code"]]["weightedPct"] == pytest.approx(row["pct"], abs=5e-5, rel=0)
    by_name = {c["name"]: c["columnId"] for c in book["columns"]}
    payload = {"context": {**context, "weightMode": "dataset"}, "rowVariableId": by_name["worker_class"],
               "colVariableId": by_name["year"], "includeRowIds": False}
    auto = client.post("/api/v1/summaries/crosstab", json={**payload, "inference": "auto"})
    assert auto.status_code == 200
    assert auto.json()["inference"]["status"] == "not_requested"
    assert auto.json()["weightDiagnostics"]["kishEffectiveN"] == pytest.approx(reference["summary"]["kishEffectiveN"], abs=1e-9, rel=0)
    naive = client.post("/api/v1/summaries/crosstab", json={**payload, "inference": "pearson"})
    assert naive.status_code == 422 and naive.json()["error"]["code"] == "SURVEY_PEARSON_UNSUPPORTED"
    rao = client.post("/api/v1/summaries/crosstab", json={**payload, "inference": "rao_scott"})
    assert rao.status_code == 200, rao.text
    inference = rao.json()["inference"]
    assert inference["method"] == "rao_scott_second_order"
    assert inference["designAssumption"] == "independent_rows"
    for field, r_field in (("statistic", "F"), ("numeratorDf", "numeratorDf"),
                           ("denominatorDf", "denominatorDf"), ("pValue", "pValue")):
        assert inference[field] == pytest.approx(reference["survey"][r_field], abs=1e-8, rel=0)
    assert any(w["code"] == "SURVEY_INFERENCE_WEIGHTS_ONLY" for w in rao.json()["warnings"])


def test_siechnice_full_choice_api_matches_r_likelihood_and_respondent_cr1(api):
    reference = REFERENCE["choice"]
    client, frame, book, context = imported(api, "siechnice-cbc96", reference["dataSha256"])
    by_name = {c["name"]: c for c in book["columns"]}
    attributes = [by_name[f"atr{i}"] for i in range(1, 6)]
    mapping = {"respondentId": "respondent_id", "taskId": "zadanie", "alternativeId": "alternatywa",
               "response": "wybor", "optOutIndicator": "status_quo"}
    response = client.post("/api/v1/models/conjoint", json={"method": "conjoint", "context": context,
        "mode": "choice", "columns": {key: by_name[name]["columnId"] for key, name in mapping.items()},
        "attributes": [{"columnId": c["columnId"], "kind": "categorical", "referenceLevel": c["categoryOrder"][-1]}
                       for c in attributes], "maxIterations": 1000})
    assert response.status_code == 200, response.text
    body = response.json(); summary = body["summary"]; tolerance = reference["tolerances"]
    assert (summary["respondentCount"], summary["taskCount"], summary["fitProfileCount"]) == (96, 1152, 3456)
    assert summary["referenceDf"] == 95
    assert summary["covarianceMethod"] == "respondent_cluster_CR1_G"
    for field in ("logLikelihood", "nullLogLikelihood"):
        assert summary["fitMetrics"][field] == pytest.approx(reference["metrics"][field], abs=tolerance["logLikelihood"], rel=0)
    coefficients = body["details"]["coefficients"]
    beta = np.asarray([c["estimate"] for c in coefficients])
    np.testing.assert_allclose(beta, reference["beta"], atol=tolerance["coefficient"], rtol=0)
    np.testing.assert_allclose(load_arrays(body["resultId"])["cov"], reference["covariance"], atol=tolerance["covariance"], rtol=0)
    np.testing.assert_allclose([c["standardError"] for c in coefficients], np.sqrt(np.diag(reference["covariance"])),
                               atol=tolerance["covariance"], rtol=0)
    # Reconstruct the design independently from raw values, not app encoders.
    optout = frame["status_quo"].to_numpy().astype(bool)
    design = []
    for spec in attributes:
        values = frame[spec["name"]].to_list(); reference_code = spec["categoryOrder"][-1]
        for level in spec["categoryOrder"][:-1]:
            design.append([0. if is_opt else float(value == level) - float(value == reference_code)
                           for value, is_opt in zip(values, optout)])
    x = np.column_stack([*design, optout.astype(float)])
    groups = {}
    for i, row in enumerate(frame.select("respondent_id", "zadanie").rows()):
        groups.setdefault(row, []).append(i)
    idx = np.asarray(list(groups.values()))
    probabilities = np.zeros(frame.height)
    probabilities[idx] = softmax((x @ beta)[idx], axis=1)
    scales = np.sqrt(((x[idx] - x[idx].mean(axis=1, keepdims=True)) ** 2).mean(axis=(0, 1)))
    normalized_score = np.max(np.abs((x.T @ (frame["wybor"].to_numpy() - probabilities)) / scales)) / len(idx)
    assert normalized_score <= tolerance["normalizedScore"]
    assert normalized_score == pytest.approx(summary["optimizer"]["scoreInfNorm"], abs=1e-12, rel=0)
    expected_probabilities = np.zeros(frame.height)
    expected_probabilities[idx] = softmax((x @ np.asarray(reference["beta"]))[idx], axis=1)
    rows = client.get(f"/api/v1/analysis-results/{body['resultId']}/rows?offset=0&limit=10000").json()["rows"]
    by_id = {r["rowId"]: r["probability"] for r in rows}
    observed = np.asarray([by_id[rid] for rid in frame["__rowId__"]])
    np.testing.assert_allclose(observed, probabilities, atol=1e-12, rtol=0)
    np.testing.assert_allclose(observed, expected_probabilities, atol=tolerance["probability"], rtol=0)
