"""Tokyo categorical/mixed analysis uses codebook scales and observed domains."""
from __future__ import annotations

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.api import analysis_results, correspondence, datasets, famd, mca
from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def tokyo(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (analysis_results, correspondence, datasets, famd, mca):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        response = client.post("/api/v1/datasets/import/sample", json={"sampleId": "tokyo-traffic2020-adult600"})
        assert response.status_code == 200, response.text
        did = response.json()["datasetId"]
        book = store.load_codebook(did)
        context = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                   "weightMode": "none", "scope": "all"}
        yield client, store, store.get_dataframe(did), {c["name"]: c for c in book["columns"]}, context


def indicators(frame, names):
    columns, domains = [], {}
    for name in names:
        values = frame[name].to_list()
        observed = sorted(set(values))
        domains[name] = observed
        columns.extend([[float(value == code) for value in values] for code in observed])
    return np.column_stack(columns), domains


@pytest.mark.parametrize("layout", ["sex-by-job", "job-by-sex", "scoped-two-jobs"])
def test_tokyo_ca_observed_table_spectrum_and_category_selection(tokyo, layout):
    client, _, frame, specs, context = tokyo
    source = frame
    row_name, col_name = ("JOB", "SEX") if layout == "job-by-sex" else ("SEX", "JOB")
    if layout == "scoped-two-jobs":
        source = frame.filter(frame["JOB"].is_in([1, 3]))
        context = {**context, "scope": "explicit", "rowIds": source["__rowId__"].to_list()[::-1]}
        assert source.height == 340
    response = client.post("/api/v1/models/ca", json={"context": context, "input": {
        "kind": "respondents", "rowVariable": specs[row_name]["columnId"],
        "columnVariable": specs[col_name]["columnId"]}})
    assert response.status_code == 200, response.text
    result = response.json()
    row_codes, col_codes = sorted(source[row_name].unique()), sorted(source[col_name].unique())
    table = np.asarray([[sum(r == rc and c == cc for r, c in source.select(row_name, col_name).rows())
                         for cc in col_codes] for rc in row_codes], dtype=float)
    assert table.sum() == source.height
    assert table.shape == ((4, 2) if layout == "job-by-sex" else (2, 2) if layout == "scoped-two-jobs" else (2, 4))
    p = table / table.sum(); expected = np.outer(p.sum(axis=1), p.sum(axis=0))
    eig = np.linalg.svd((p - expected) / np.sqrt(expected), compute_uv=False) ** 2
    eig = eig[eig > 1e-12]
    assert len(eig) == 1
    np.testing.assert_allclose(result["summary"]["eigenvalues"], eig, atol=1e-12, rtol=0)
    assert result["summary"]["totalInertia"] == pytest.approx(np.sum((p - expected)**2/expected), abs=1e-12, rel=0)
    assert result["meta"]["fitCount"] == source.height
    details = result["details"]
    assert result["summary"]["activeRowCategoryCount"] == len(row_codes)
    assert result["summary"]["activeColumnCategoryCount"] == len(col_codes)
    job_side = "row" if row_name == "JOB" else "column"
    observed_jobs = {str(value) for value in source["JOB"]}
    expected_omitted = [{"code": code, "label": specs["JOB"]["valueLabels"][code],
                         "originalIndex": i, "side": job_side, "reason": "zero_mass"}
                        for i, code in enumerate(specs["JOB"]["categoryOrder"]) if code not in observed_jobs]
    assert len(expected_omitted) == (10 if layout == "scoped-two-jobs" else 8)
    assert [{key: category[key] for key in expected_omitted[0]} for category in details["omittedCategories"]] == expected_omitted
    assert all(category["variableId"] == specs["JOB"]["columnId"] for category in details["omittedCategories"])
    assert [category["code"] for category in details["rowCategories"]] == [str(code) for code in row_codes]
    assert [category["code"] for category in details["columnCategories"]] == [str(code) for code in col_codes]
    assert details["tableRowCategoryIds"] == [category["categoryId"] for category in details["rowCategories"]]
    assert details["tableColumnCategoryIds"] == [category["categoryId"] for category in details["columnCategories"]]
    np.testing.assert_array_equal(details["table"], table)
    np.testing.assert_array_equal(details["physicalTable"], table.astype(int))
    sex_categories = details["rowCategories"] if row_name == "SEX" else details["columnCategories"]
    category = next(c for c in sex_categories if c["code"] == "1")
    selected = client.post(f"/api/v1/analysis-results/{result['resultId']}/select", json={"context": context,
        "selector": {"kind": "categories", "categoryIds": [category["categoryId"]]}})
    assert selected.status_code == 200, selected.text
    expected_ids = {rid for rid, value in source.select("__rowId__", "SEX").rows() if value == 1}
    assert set(selected.json()["rowIds"]) == expected_ids
    table_export = client.post(f"/api/v1/analysis-results/{result['resultId']}/export",
                               json={"format": "json", "table": "table"})
    assert table_export.status_code == 200, table_export.text
    exported = json.loads(table_export.json()["payload"])
    assert exported["rows"] == [[rid, cid, table[i, j]]
        for i, rid in enumerate(details["tableRowCategoryIds"]) for j, cid in enumerate(details["tableColumnCategoryIds"])]
    category_export = client.post(f"/api/v1/analysis-results/{result['resultId']}/export",
                                  json={"format": "json", "table": "categories"})
    assert category_export.status_code == 200, category_export.text
    categories_exported = json.loads(category_export.json()["payload"])
    assert {row[0] for row in categories_exported["rows"]} == set(details["tableRowCategoryIds"] + details["tableColumnCategoryIds"])


def test_tokyo_mca_disjunctive_spectrum_uses_observed_categories(tokyo):
    client, _, frame, specs, context = tokyo
    names = ["SEX", "JOB", "Q6"]
    response = client.post("/api/v1/models/mca", json={"context": context,
        "variables": [specs[name]["columnId"] for name in names], "maMode": "ordinary_only"})
    assert response.status_code == 200, response.text
    result = response.json()
    z, domains = indicators(frame, names)
    assert z.shape == (600, 17)
    n, variable_count = len(z), len(names)
    p = z / (n * variable_count)
    expected = np.outer(np.full(n, 1/n), p.sum(axis=0))
    eigenvalues = np.linalg.svd((p - expected) / np.sqrt(expected), compute_uv=False) ** 2
    eigenvalues = eigenvalues[eigenvalues > 1e-12]
    np.testing.assert_allclose(result["summary"]["eigenvalues"], eigenvalues, atol=1e-11, rtol=0)
    assert result["summary"]["totalInertia"] == pytest.approx((17 - 3)/3, abs=1e-12, rel=0)
    assert result["meta"]["fitCount"] == 600
    rows = client.get(f"/api/v1/analysis-results/{result['resultId']}/rows?limit=10000").json()["rows"]
    assert {row["rowId"] for row in rows} == set(frame["__rowId__"])


def test_tokyo_famd_numeric_age_population_scaling_and_stored_projection(tokyo):
    client, _, frame, specs, context = tokyo
    response = client.post("/api/v1/models/famd", json={"context": context,
        "numericVariables": [specs["AGE"]["columnId"]],
        "categoricalVariables": [specs[name]["columnId"] for name in ["SEX", "JOB"]]})
    assert response.status_code == 200, response.text
    result = response.json()
    age = frame["AGE"].to_numpy().astype(float)
    z, _ = indicators(frame, ["SEX", "JOB"])
    mass = z.mean(axis=0)
    matrix = np.column_stack([(age-age.mean())/age.std(ddof=0), (z-mass)/np.sqrt(mass)])
    eigenvalues = np.linalg.svd(matrix / np.sqrt(len(age)), compute_uv=False)**2
    eigenvalues = eigenvalues[eigenvalues > 1e-12]
    np.testing.assert_allclose(result["summary"]["eigenvalues"], eigenvalues, atol=1e-11, rtol=0)
    assert result["summary"]["totalInertia"] == pytest.approx(5, abs=1e-12, rel=0)
    rid = result["resultId"]
    pred = client.post(f"/api/v1/analysis-results/{rid}/predict", json={"context": context, "options": {}})
    assert pred.status_code == 200, pred.text
    assert pred.json()["summary"]["successfulPredictions"] == 600
    fitted = client.get(f"/api/v1/analysis-results/{rid}/rows?limit=10000").json()["rows"]
    projected = client.get(f"/api/v1/analysis-results/{rid}/predictions/{pred.json()['predictionId']}/rows?limit=10000").json()["rows"]
    by_id = {r["rowId"]: r["coordinates"] for r in fitted}
    assert set(by_id) == set(frame["__rowId__"])
    for row in projected:
        assert row["predictionStatus"] == "ok"
        np.testing.assert_allclose(row["coordinates"], by_id[row["rowId"]], atol=1e-10, rtol=0)


@pytest.mark.parametrize("method,code", [("ca", "CA_CATEGORY_REQUIRED"), ("mca", "MCA_MA_UNSUPPORTED"), ("famd", "FAMD_SCALE_INVALID")])
def test_tokyo_method_scale_gates_do_not_silently_promote_codes(tokyo, method, code):
    client, _, _, specs, context = tokyo
    ref = {name: c["columnId"] for name, c in specs.items()}
    if method == "ca":
        payload = {"input": {"kind": "respondents", "rowVariable": ref["AGE"], "columnVariable": ref["SEX"]}}
    elif method == "mca":
        payload = {"variables": [ref["SEX"], ref["SQ3_1"]], "maMode": "ordinary_only"}
    else:
        payload = {"numericVariables": [ref["AGEID"]], "categoricalVariables": [ref["SEX"]]}
    response = client.post(f"/api/v1/models/{method}", json={"context": context, **payload})
    assert response.status_code == 422 and response.json()["error"]["code"] == code, response.text
