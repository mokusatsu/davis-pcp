"""Bounded real-sample PA and remaining representative SparsePCA contracts."""
from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sklearn.decomposition import SparsePCA

from app.api import analysis_results, datasets, factor_analysis, sparse_pca
from app.config import settings
from app.main import app
from app.services import factor_analysis_service, sparse_pca_service
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (analysis_results, datasets, factor_analysis, sparse_pca, sparse_pca_service):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        yield client, store


def imported(api, sample_id):
    client, store = api
    response = client.post("/api/v1/datasets/import/sample", json={"sampleId": sample_id})
    assert response.status_code == 200, response.text
    did = response.json()["datasetId"]
    frame, book = store.get_dataframe(did), store.load_codebook(did)
    context = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
               "scope": "all", "weightMode": "none"}
    return client, store, frame, book, context


def analysis_values(frame, specs):
    columns = []
    for spec in specs:
        missing = set(spec.get("missingCodes") or [])
        order = [code for code in spec.get("categoryOrder", []) if code not in missing]
        if spec.get("isReversed"):
            order = order[::-1]
        ranks = {code: float(i+1) for i, code in enumerate(order)}
        values = []
        for raw in frame[spec["name"]]:
            code = None if raw is None else str(int(raw)) if isinstance(raw, float) and raw.is_integer() else str(raw)
            if code is None or code in missing or (order and code not in order):
                values.append(np.nan)
            elif spec["scaleType"] == "ordinal":
                values.append(ranks[code])
            else:
                values.append(float(raw))
        columns.append(values)
    return np.asarray(columns, dtype=float).T


SPARSE_CASES = [
    ("iris", ["sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm"], 150),
    ("tokyo-traffic2020-adult600", ["AGE", "Q15S1", "Q15S2", "Q15S3"], 356),
    ("yokohama-citizen2022-adult600", ["Q7", "Q8_ア", "Q8_イ", "Q8_ウ", "Q8_エ", "Q8_カ", "Q8_キ"], 508),
    ("turkiye-student-evaluation-600", None, 600),
    ("edss-cfa-646x13", None, 646),
]


@pytest.mark.parametrize("sample_id,names,expected_fit", SPARSE_CASES, ids=[case[0] for case in SPARSE_CASES])
def test_representative_builtin_sparse_pca_api_matches_independent_sklearn(api, sample_id, names, expected_fit):
    client, store, frame, book, context = imported(api, sample_id)
    by_name = {spec["name"]: spec for spec in book["columns"]}
    specs = [by_name[name] for name in names] if names is not None else book["columns"]
    values = analysis_values(frame, specs)
    valid = np.isfinite(values).all(axis=1)
    x = values[valid]
    assert len(x) == expected_fit
    variables = [{"columnId": spec["columnId"], "kind": "numeric", **({
        "ordinalAsNumericAcknowledged": True, "score": "ordered_rank"} if spec["scaleType"] == "ordinal" else {})}
        for spec in specs]
    response = client.post("/api/v1/models/sparse-pca", json={"context": context, "variables": variables,
        "preprocessing": "correlation", "nComponents": 2, "alpha": 1., "ridgeAlpha": .01,
        "maxIterations": 100, "tolerance": 1e-8, "seed": 0})
    assert response.status_code == 200, response.text
    result = response.json(); details = result["details"]; summary = result["summary"]
    assert result["meta"]["fitCount"] == expected_fit
    z = (x-x.mean(axis=0))/x.std(axis=0, ddof=1)
    oracle = SparsePCA(n_components=2, alpha=1., ridge_alpha=.01, max_iter=100,
                       tol=1e-8, method="lars", n_jobs=1, random_state=0).fit(z)
    np.testing.assert_allclose(details["components"], oracle.components_, atol=1e-8, rtol=1e-8)
    rows_response = client.get(f"/api/v1/analysis-results/{result['resultId']}/rows?limit=10000")
    assert rows_response.status_code == 200, rows_response.text
    rows = rows_response.json()["rows"]
    assert [r["rowId"] for r in rows] == [rid for rid, included in zip(frame["__rowId__"], valid) if included]
    scores = np.asarray([r["coordinates"] for r in rows])
    np.testing.assert_allclose(scores, oracle.transform(z), atol=1e-7, rtol=1e-8)
    np.testing.assert_allclose(scores, (z-np.asarray(details["preprocessing"]["estimatorMean"])) @ np.asarray(details["scoreCoefficients"]), atol=1e-11, rtol=1e-11)
    centered = z-oracle.mean_
    expected_reconstruction = 1-np.sum((centered-scores@oracle.components_)**2)/np.sum(centered**2)
    assert summary["reconstructionFraction"] == pytest.approx(expected_reconstruction, abs=1e-10, rel=0)
    assert summary["convergence"]["finalObjective"] == pytest.approx(oracle.error_[-1], abs=1e-8, rel=0)
    assert summary["convergence"]["nIterations"] == len(oracle.error_)
    assert summary["convergence"]["status"] in {"tolerance_reached", "iteration_limit", "objective_increase"}
    assert not {"eigenvalues", "explainedVarianceRatio", "cumulativeVarianceRatio"}.intersection(summary)
    assert store.get_dataframe(context["datasetId"]).equals(frame)


def test_edss_pearson_parallel_analysis_500_independent_permutations_and_svd_spectra(api, monkeypatch):
    client, store, frame, book, context = imported(api, "edss-efa-613x13")
    x = analysis_values(frame, book["columns"])
    assert x.shape == (613, 13) and np.isfinite(x).all()
    observed_inputs, observed_correlations = [], []
    original_estimator = factor_analysis_service.pearson_correlation
    def capture_estimator(matrix):
        result = original_estimator(matrix)
        observed_inputs.append(np.asarray(matrix).copy())
        observed_correlations.append(np.asarray(result["correlation"]).copy())
        return result
    monkeypatch.setattr(factor_analysis_service, "pearson_correlation", capture_estimator)
    response = client.post("/api/v1/models/factor-analysis", json={"context": context,
        "variables": [{"columnId": spec["columnId"], "measurement": "ordinal",
                       "treatment": "continuous_approximation", "approximationAcknowledged": True,
                       "categoryOrder": spec["categoryOrder"]} for spec in book["columns"]],
        "correlation": "pearson", "extraction": "ml", "nFactors": 3, "rotation": "none",
        "scoreMethod": "none", "nStarts": 1, "maxIterations": 500, "seed": 19,
        "parallelAnalysis": {"enabled": True, "iterations": 500, "quantile": .95, "seed": 19}})
    assert response.status_code == 200, response.text
    result = response.json(); parallel = result["details"]["parallelAnalysis"]
    assert len(observed_inputs) == 501
    np.testing.assert_array_equal(observed_inputs[0], x)
    rng = np.random.default_rng(19)
    spectra = []
    sorted_original = np.sort(x, axis=0)
    for iteration in range(500):
        permuted = np.column_stack([x[rng.permutation(len(x)), j] for j in range(x.shape[1])])
        np.testing.assert_array_equal(observed_inputs[iteration+1], permuted)
        np.testing.assert_array_equal(np.sort(permuted, axis=0), sorted_original)
        z = (permuted-permuted.mean(axis=0))/permuted.std(axis=0, ddof=1)
        spectrum = np.linalg.svd(z/np.sqrt(len(z)-1), compute_uv=False)**2
        np.testing.assert_allclose(np.linalg.eigvalsh(observed_correlations[iteration+1])[::-1], spectrum, atol=1e-12, rtol=0)
        spectra.append(spectrum)
    expected_quantiles = np.quantile(spectra, .95, axis=0, method="linear")
    z = (x-x.mean(axis=0))/x.std(axis=0, ddof=1)
    observed = np.linalg.svd(z/np.sqrt(len(z)-1), compute_uv=False)**2
    np.testing.assert_allclose(parallel["referenceQuantiles"], expected_quantiles, atol=1e-12, rtol=0)
    np.testing.assert_allclose(parallel["observedEigenvalues"], observed, atol=1e-12, rtol=0)
    assert parallel["iterationsSucceeded"] == 500 and parallel["iterationsFailed"] == 0
    assert parallel["status"] == "completed"
    exceed = observed > expected_quantiles
    leading = next((index for index, larger in enumerate(exceed) if not larger), len(exceed))
    assert parallel["suggestedFactors"] == leading
    assert parallel["exceedanceRanks"] == (np.flatnonzero(exceed)+1).tolist()
    assert store.get_dataframe(context["datasetId"]).equals(frame)
