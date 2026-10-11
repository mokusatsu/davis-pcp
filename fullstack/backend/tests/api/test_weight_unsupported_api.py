"""Feature 21: unsupported analyses return WEIGHT_UNSUPPORTED, never weighted values."""
from __future__ import annotations

import hashlib
import io
import json
import math

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def weighted_ds():
    with TestClient(app) as client:
        text = "Q1,Q2,wt\n1,2.0,1.0\n2,3.0,2.0\n1,4.0,1.5\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("w.csv", text, "text/csv")}).json()["datasetId"]
        cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: c for c in cb["columns"]}
        by_name["wt"].update(role="weight", scaleType="ratio", label="weight")
        assert client.put(f"/api/v1/datasets/{dataset_id}/codebook",
                          json={"columns": list(by_name.values())}).status_code == 200
        yield client, dataset_id
        client.delete(f"/api/v1/datasets/{dataset_id}")


def test_relationship_matrix_reports_unsupported(weighted_ds):
    client, ds = weighted_ds
    plain = client.post("/api/v1/relationships/matrix",
                        json={"datasetId": ds, "columns": ["Q1", "Q2"]}).json()
    assert plain["weightStatus"] == "omitted" and plain["weightApplied"] is False
    assert plain["warnings"] == [] and "weightedN" not in plain
    weighted = client.post("/api/v1/relationships/matrix",
                           json={"datasetId": ds, "columns": ["Q1", "Q2"], "weightColumn": "wt"}).json()
    assert weighted["weightStatus"] == "unsupported" and weighted["weightApplied"] is False
    assert weighted["weightColumn"] == "wt" and weighted["weightColumnId"] is not None
    assert weighted["warnings"] == [{"code": "WEIGHT_UNSUPPORTED", "message": "この分析は調査ウェイトを適用しません。"}]
    assert "weightedN" not in weighted and "weighted" not in str(weighted.get("matrix"))


def test_surprise_reports_unsupported(weighted_ds):
    client, ds = weighted_ds
    res = client.post("/api/v1/relationships/surprise",
                      json={"datasetId": ds, "columns": ["Q1", "Q2"], "weightColumn": "wt"}).json()
    assert res["weightStatus"] == "unsupported" and res["weightApplied"] is False
    assert res["warnings"][0]["code"] == "WEIGHT_UNSUPPORTED"


def test_unsupported_unknown_weight_column_422(weighted_ds):
    client, ds = weighted_ds
    res = client.post("/api/v1/relationships/matrix",
                      json={"datasetId": ds, "columns": ["Q1", "Q2"], "weightColumn": "nope"})
    assert res.status_code == 422 and res.json()["error"]["code"] == "WEIGHT_COLUMN_NOT_FOUND"


def test_clusters_disclose_unsupported_weight_without_changing_results(weighted_ds):
    client, ds = weighted_ds
    codebook_response = client.get(f"/api/v1/datasets/{ds}/codebook")
    assert codebook_response.status_code == 200
    codebook = codebook_response.json()
    assert codebook.get("weightConfig") is None
    weight = next(column for column in codebook["columns"] if column["name"] == "wt")
    assert weight["columnId"] and weight["columnId"] != "wt"
    request = {"datasetId": ds, "method": "kmeans", "columns": ["Q2"], "k": 2, "seed": 42}
    baseline = None
    for fields in ({}, {"weightColumn": None}, {"weightColumn": "wt"},
                   {"weightColumn": weight["columnId"]}):
        response = client.post("/api/v1/clusters", json={**request, **fields})
        assert response.status_code == 200
        result = response.json()
        explicit = fields.get("weightColumn") is not None
        expected = {
            "weightStatus": "unsupported" if explicit else "omitted",
            "weightApplied": False,
            "weightColumn": "wt" if explicit else None,
            "weightColumnId": weight["columnId"] if explicit else None,
            "warnings": [{"code": "WEIGHT_UNSUPPORTED", "message": "この分析は調査ウェイトを適用しません。"}]
                        if explicit else [],
        }
        assert {key: result[key] for key in expected} == expected
        assert result["weightApplied"] is False
        assert "weightedN" not in result and "weighted" not in result
        # Compare every stable value, including diagnostics, scope and PCA.
        comparable = {key: value for key, value in result.items()
                      if key not in {*expected, "resultId", "createdAt", "diagnostics"}}
        comparable["diagnostics"] = {key: value for key, value in result["diagnostics"].items()
                                    if key != "runtimeMs"}
        if baseline is None:
            baseline = comparable
            assert len(result["rowIds"]) == len(set(result["rowIds"])) == 3
            assert len(result["labels"]) == 3 and len(set(result["labels"])) == result["k"] == 2
            assert result["scopeCount"] == result["usedRows"] == 3
            assert result["excludedRowCount"] == 0 and result["scopeHash"]
            assert result["requestedColumns"] == result["usedColumns"] == result["columns"] == ["Q2"]
            assert result["schemaRevision"] == codebook["schemaRevision"]
            assert result["dataRevision"] >= 1 and result["silhouette"] is not None
            projection = result["pcaProjection"]
            assert projection is not None
            for axis in ("pc1", "pc2"):
                assert len(projection[axis]) == 3
                assert all(math.isfinite(value) for value in projection[axis])
            assert len(set(projection["pc1"])) > 1
            assert len(projection["varianceRatio"]) == 2
            assert all(math.isfinite(value) for value in projection["varianceRatio"])
        else:
            assert comparable == baseline
    # GET retains the exact fit-time payload, including explicit-weight metadata.
    stored = client.get(f"/api/v1/clusters/{result['resultId']}")
    assert stored.status_code == 200 and stored.json() == result


@pytest.mark.parametrize("weight_column,code", [
    ("nope", "WEIGHT_COLUMN_NOT_FOUND"),
    ("Q2", "WEIGHT_ROLE_INVALID"),
])
def test_clusters_reject_invalid_weight_reference(weighted_ds, weight_column, code):
    client, ds = weighted_ds
    response = client.post("/api/v1/clusters", json={
        "datasetId": ds, "method": "kmeans", "columns": ["Q2"], "k": 2, "seed": 42,
        "weightColumn": weight_column,
    })
    assert response.status_code == 422 and response.json()["error"]["code"] == code


def _weight_context(client, ds):
    codebook_response = client.get(f"/api/v1/datasets/{ds}/codebook")
    meta_response = client.get(f"/api/v1/datasets/{ds}")
    view_response = client.post(f"/api/v1/datasets/{ds}/view", json={"columns": ["Q1", "Q2", "wt"]})
    assert codebook_response.status_code == meta_response.status_code == view_response.status_code == 200
    codebook, meta = codebook_response.json(), meta_response.json()
    assert codebook.get("weightConfig") is None
    weight = next(column for column in codebook["columns"] if column["name"] == "wt")
    assert weight["role"] == "weight" and weight["scaleType"] == "ratio"
    assert weight["columnId"] and weight["columnId"] != "wt"
    frame = pl.read_ipc_stream(io.BytesIO(view_response.content))
    assert frame.select("Q1", "Q2", "wt").to_dict(as_series=False) == {
        "Q1": [1, 2, 1], "Q2": [2.0, 3.0, 4.0], "wt": [1.0, 2.0, 1.5],
    }
    row_ids = frame["__rowId__"].to_list()
    assert len(row_ids) == len(set(row_ids)) == meta["rowCount"] == 3
    assert all(isinstance(row_id, str) and row_id for row_id in row_ids)
    revisions = {"schemaRevision": codebook["schemaRevision"], "dataRevision": meta["dataRevision"]}
    assert revisions["schemaRevision"] == meta["schemaRevision"]
    assert all(revision >= 1 for revision in revisions.values())
    return weight["columnId"], row_ids, revisions


def _post_success(client, endpoint, request):
    response = client.post(endpoint, json=request)
    assert response.status_code == 200, response.text
    return response.json()


def _assert_scope(result, ds, row_ids, revisions):
    assert result["datasetId"] == ds
    assert result["scopeCount"] == result["usedRows"] == len(row_ids)
    assert {key: result[key] for key in revisions} == revisions
    encoded = json.dumps(sorted(row_ids), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    assert result["scopeHash"] == hashlib.sha256(encoded).hexdigest()


def _stable_unweighted(result, *, model=False):
    # Keep all ordinary warnings, scope, class identities and numerical fields.
    excluded = {"weightStatus", "weightApplied", "weightColumn", "weightColumnId", "warnings"}
    if model:
        excluded.update({"resultId", "createdAt"})
    stable = {key: value for key, value in result.items() if key not in excluded}
    stable["warnings"] = [warning for warning in result.get("warnings", [])
                          if warning["code"] != "WEIGHT_UNSUPPORTED"]
    if model:
        stable["diagnostics"] = {key: value for key, value in result["diagnostics"].items()
                                 if key != "runtimeMs"}
    return stable


def _assert_weight_metadata(results, weight_id, ordinary_warnings):
    # Called only after every request's numerical/scope/storage controls passed.
    actual_blocks, expected_blocks = [], []
    for result, explicit in zip(results, (False, False, True, True), strict=True):
        expected = {
            "weightStatus": "unsupported" if explicit else "omitted",
            "weightApplied": False,
            "weightColumn": "wt" if explicit else None,
            "weightColumnId": weight_id if explicit else None,
            "warnings": ordinary_warnings + ([{
                "code": "WEIGHT_UNSUPPORTED", "message": "この分析は調査ウェイトを適用しません。",
            }] if explicit else []),
        }
        assert "weightedN" not in result and "weighted" not in result
        actual_blocks.append({key: result.get(key, "<missing>") for key in expected})
        expected_blocks.append(expected)
    assert actual_blocks == expected_blocks


def _assert_pca_output(result, ds, row_ids, revisions, columns, ordinary_warnings):
    _assert_scope(result, ds, row_ids, revisions)
    assert result["nSamples"] == result["n_samples"] == len(row_ids)
    assert result["columns"] == result["usedColumns"] == columns
    assert result["excludedCounts"] == {"ordinaryMissing": 0}
    assert result["method"] == "pca-ordinary-columns"
    assert result["useCorrelation"] is result["use_correlation"] is True
    assert result["excludedConstantColumns"] == (["Q1"] if columns == ["Q2"] else [])
    assert [warning for warning in result["warnings"] if warning["code"] != "WEIGHT_UNSUPPORTED"] == ordinary_warnings
    components = min(len(row_ids) - 1, len(columns))
    assert result["nComponents"] == result["n_components"] == components
    assert [score["rowId"] for score in result["scores"]] == row_ids
    assert [score["row_id"] for score in result["scores"]] == row_ids
    assert all(len(score["pc"]) == components for score in result["scores"])
    assert all(math.isfinite(value) for score in result["scores"] for value in score["pc"])
    assert all(len({score["pc"][axis] for score in result["scores"]}) > 1 for axis in range(components))
    assert len(result["eigenvalues"]) == components
    assert all(math.isfinite(value) and value > 0 for value in result["eigenvalues"])
    assert set(result["loadings"]) == set(columns)
    assert all(len(values) == components and all(math.isfinite(value) for value in values)
               for values in result["loadings"].values())
    assert "resultId" not in result  # PCA is computed directly; it has no stored fit.


def test_pca_discloses_unsupported_weight_without_changing_scoped_results(weighted_ds):
    client, ds = weighted_ds
    weight_id, all_ids, revisions = _weight_context(client, ds)
    request = {"datasetId": ds, "columns": ["Q1", "Q2"], "useCorrelation": True,
               "expectedSchemaRevision": revisions["schemaRevision"],
               "expectedDataRevision": revisions["dataRevision"]}
    full = _post_success(client, "/api/v1/models/pca", request)
    _assert_pca_output(full, ds, all_ids, revisions, ["Q1", "Q2"], [])
    row_ids, results = all_ids[:2], []
    for fields in ({}, {"weightColumn": None}, {"weightColumn": "wt"}, {"weightColumn": weight_id}):
        result = _post_success(client, "/api/v1/models/pca", {**request, "rowIds": row_ids, **fields})
        _assert_pca_output(result, ds, row_ids, revisions, ["Q1", "Q2"], [])
        assert result["scopeHash"] != full["scopeHash"]
        if results:
            assert _stable_unweighted(result) == _stable_unweighted(results[0])
        results.append(result)
    _assert_weight_metadata(results, weight_id, [])


def test_pca_preserves_constant_warning_with_unsupported_weight(weighted_ds):
    client, ds = weighted_ds
    weight_id, all_ids, revisions = _weight_context(client, ds)
    request = {"datasetId": ds, "columns": ["Q1", "Q2"], "useCorrelation": True,
               "expectedSchemaRevision": revisions["schemaRevision"],
               "expectedDataRevision": revisions["dataRevision"]}
    full = _post_success(client, "/api/v1/models/pca", request)
    _assert_pca_output(full, ds, all_ids, revisions, ["Q1", "Q2"], [])
    row_ids, results = [all_ids[0], all_ids[2]], []
    ordinary_warnings = [{"code": "PCA_CONSTANT_COLUMNS_EXCLUDED",
                          "message": "対象行で値が一定の列をPCAから除外しました: Q1",
                          "details": {"columns": ["Q1"]}}]
    for fields in ({}, {"weightColumn": None}, {"weightColumn": "wt"}, {"weightColumn": weight_id}):
        result = _post_success(client, "/api/v1/models/pca", {**request, "rowIds": row_ids, **fields})
        _assert_pca_output(result, ds, row_ids, revisions, ["Q2"], ordinary_warnings)
        assert result["scopeHash"] != full["scopeHash"]
        if results:
            assert _stable_unweighted(result) == _stable_unweighted(results[0])
        results.append(result)
    _assert_weight_metadata(results, weight_id, ordinary_warnings)


def _assert_model_output(client, result, ds, row_ids, revisions, model_type):
    _assert_scope(result, ds, row_ids, revisions)
    assert result["rowIds"] == row_ids and result["trainedRows"] == len(row_ids)
    assert result["features"] == ["Q2"] and result["target"] == "Q1"
    assert result["usedColumns"] == ["Q2", "Q1"]
    assert result["modelType"] == model_type and result["taskType"] == "classification"
    assert result["excludedCounts"] == {} and result["ordinaryMissingExcluded"] == 0
    assert result["classLabels"] == ["1", "2"] and result["targetDtype"] == "Int64"
    assert result["classCategories"] == [[{"rawValue": value, "code": value, "label": value}]
                                         for value in ("1", "2")]
    assert set(result["featureImportance"]) == {"Q2"}
    assert math.isfinite(result["featureImportance"]["Q2"])
    assert result["featureImportance"]["Q2"] == pytest.approx(1.0)
    assert result["nodeCount"] >= 3 and result["leafCount"] >= 2
    assert len(result["treeStructures"]) == 1
    root = result["treeStructures"][0]
    assert root["isLeaf"] is False and root["rowIdsCount"] == len(row_ids)
    assert root["feature"] == "Q2" and math.isfinite(root["threshold"])
    memberships = result["leafMembership"]
    assert len(memberships) == result["leafCount"]
    assert all(leaf["rowIds"] and leaf["treeIndex"] == 0 for leaf in memberships)
    members = [row_id for leaf in memberships for row_id in leaf["rowIds"]]
    assert len(members) == len(set(members)) == len(row_ids) and set(members) == set(row_ids)
    assert result["diagnostics"]["nEstimators"] == (10 if model_type == "random_forest" else 1)
    representative = result["representativeTree"]
    if model_type == "random_forest":
        assert 0 <= representative["index"] < 10
        assert len(representative["treeAgreements"]) == 10
        assert all(math.isfinite(value) and 0 <= value <= 1 for value in representative["treeAgreements"])
        assert representative["forestAgreement"] == max(representative["treeAgreements"])
    else:
        assert representative["index"] is representative["treeAgreements"] is None
        assert result["diagnostics"]["depth"] >= 1
    stored = client.get(f"/api/v1/models/{result['resultId']}")
    leaves = client.get(f"/api/v1/models/{result['resultId']}/leaves")
    assert stored.status_code == leaves.status_code == 200
    stored = stored.json()
    assert {key: value for key, value in stored.items() if key != "nodes"} == {
        key: value for key, value in result.items() if key not in {"nodeCount", "leafCount"}}
    assert len(stored["nodes"]) == result["nodeCount"]
    assert stored["nodes"][0]["rowIds"] == row_ids
    assert [{key: node[key] for key in ("nodeId", "treeIndex", "rowIds")}
            for node in stored["nodes"] if node["isLeaf"]] == memberships
    assert leaves.json() == {"leaves": memberships, "evidenceClass": result["evidenceClass"]}
    return stored


@pytest.mark.parametrize("model_type", ["decision_tree", "random_forest"])
def test_models_disclose_unsupported_weight_without_changing_scoped_results(weighted_ds, model_type):
    client, ds = weighted_ds
    weight_id, all_ids, revisions = _weight_context(client, ds)
    request = {"datasetId": ds, "features": ["Q2"], "target": "Q1", "modelType": model_type,
               "taskType": "classification", "maxDepth": 3, "nEstimators": 10, "seed": 42,
               "expectedSchemaRevision": revisions["schemaRevision"],
               "expectedDataRevision": revisions["dataRevision"]}
    full = _post_success(client, "/api/v1/models", request)
    _assert_model_output(client, full, ds, all_ids, revisions, model_type)
    row_ids, results, stored_results = all_ids[:2], [], []
    for fields in ({}, {"weightColumn": None}, {"weightColumn": "wt"}, {"weightColumn": weight_id}):
        result = _post_success(client, "/api/v1/models", {**request, "rowIds": row_ids, **fields})
        stored = _assert_model_output(client, result, ds, row_ids, revisions, model_type)
        assert result["scopeHash"] != full["scopeHash"]
        if results:
            assert _stable_unweighted(result, model=True) == _stable_unweighted(results[0], model=True)
            assert _stable_unweighted(stored, model=True) == _stable_unweighted(stored_results[0], model=True)
        results.append(result)
        stored_results.append(stored)
    _assert_weight_metadata(results, weight_id, [])


@pytest.mark.parametrize("weight_column,code", [
    ("nope", "WEIGHT_COLUMN_NOT_FOUND"), ("Q2", "WEIGHT_ROLE_INVALID"),
])
def test_pca_rejects_invalid_weight_reference(weighted_ds, weight_column, code):
    client, ds = weighted_ds
    response = client.post("/api/v1/models/pca", json={
        "datasetId": ds, "columns": ["Q1", "Q2"], "weightColumn": weight_column,
    })
    assert response.status_code == 422 and response.json()["error"]["code"] == code


@pytest.mark.parametrize("model_type", ["decision_tree", "random_forest"])
@pytest.mark.parametrize("weight_column,code", [
    ("nope", "WEIGHT_COLUMN_NOT_FOUND"), ("Q2", "WEIGHT_ROLE_INVALID"),
])
def test_models_reject_invalid_weight_reference(weighted_ds, model_type, weight_column, code):
    client, ds = weighted_ds
    response = client.post("/api/v1/models", json={
        "datasetId": ds, "features": ["Q2"], "target": "Q1", "modelType": model_type,
        "taskType": "classification", "nEstimators": 10, "seed": 42, "weightColumn": weight_column,
    })
    assert response.status_code == 422 and response.json()["error"]["code"] == code


@pytest.fixture
def logistic_weighted_ds():
    # The ordinary grouped-binomial oracle also used by test_logistic_class_identity.
    # Both x groups contain both outcomes; these unequal weights would change a fit.
    text = ("x,x_copy,answer,wt\n0.0,0.0,10,1\n0.0,0.0,10,2\n0.0,0.0,10,3\n0.0,0.0,20,7\n"
            "1.0,1.0,10,1\n1.0,1.0,20,2\n1.0,1.0,20,4\n1.0,1.0,20,6\n")
    with TestClient(app) as client:
        response = client.post("/api/v1/datasets/import", files={"file": (
            "logistic-weight.csv", text, "text/csv")})
        assert response.status_code == 200, response.text
        ds = response.json()["datasetId"]
        try:
            response = client.get(f"/api/v1/datasets/{ds}/codebook")
            assert response.status_code == 200
            by_name = {column["name"]: column for column in response.json()["columns"]}
            by_name["x"].update(role="attribute", scaleType="ratio")
            by_name["x_copy"].update(role="attribute", scaleType="ratio")
            by_name["answer"].update(role="question", scaleType="nominal",
                                     valueLabels={"10": "Low", "20": "High"})
            by_name["wt"].update(role="weight", scaleType="ratio")
            response = client.put(f"/api/v1/datasets/{ds}/codebook",
                                  json={"columns": list(by_name.values())})
            assert response.status_code == 200, response.text
            codebook = client.get(f"/api/v1/datasets/{ds}/codebook")
            meta = client.get(f"/api/v1/datasets/{ds}")
            view = client.post(f"/api/v1/datasets/{ds}/view", json={"columns": ["x", "x_copy", "answer", "wt"]})
            assert codebook.status_code == meta.status_code == view.status_code == 200
            codebook, meta = codebook.json(), meta.json()
            assert codebook.get("weightConfig") is None
            specs = {column["name"]: column for column in codebook["columns"]}
            assert specs["wt"]["role"] == "weight" and specs["wt"]["scaleType"] == "ratio"
            assert all(spec["columnId"] and spec["columnId"] != name for name, spec in specs.items())
            frame = pl.read_ipc_stream(io.BytesIO(view.content))
            assert frame.select("x", "x_copy", "answer", "wt").to_dict(as_series=False) == {
                "x": [0.0] * 4 + [1.0] * 4, "x_copy": [0.0] * 4 + [1.0] * 4,
                "answer": [10, 10, 10, 20, 10, 20, 20, 20],
                "wt": [1, 2, 3, 7, 1, 2, 4, 6],
            }
            row_ids = frame["__rowId__"].to_list()
            assert len(row_ids) == len(set(row_ids)) == meta["rowCount"] == 8
            assert all(isinstance(row_id, str) and row_id for row_id in row_ids)
            revisions = {"schemaRevision": codebook["schemaRevision"], "dataRevision": meta["dataRevision"]}
            assert revisions["schemaRevision"] == meta["schemaRevision"]
            assert all(revision >= 1 for revision in revisions.values())
            yield client, ds, frame, specs, revisions
        finally:
            client.delete(f"/api/v1/datasets/{ds}")


def _assert_logistic_output(result, ds, frame, revisions, features, ordinary_warnings):
    row_ids = frame["__rowId__"].to_list()
    _assert_scope(result, ds, row_ids, revisions)
    assert result["target"] == "answer" and result["features"] == features
    assert result["usedColumns"] == [*features, "answer"]
    assert result["targetDtype"] == "Int64" and result["classes"] == ["10", "20"]
    assert result["classCategories"] == [
        [{"rawValue": "10", "code": "10", "label": "Low"}],
        [{"rawValue": "20", "code": "20", "label": "High"}],
    ]
    assert result["excludedRowCount"] == 0 and result["excludedCounts"] == {"ordinaryMissing": 0}
    assert result["method"] == "logistic-explicit-columns" and result["evidenceClass"] == "JAR-INITIAL"
    assert result["diagnostics"] == {"completeSeparation": False, "fallbackUsed": False,
                                     "inferenceStatus": "unavailable" if ordinary_warnings else "available",
                                     "separationMethod": "strict-margin-linear-feasibility"}
    assert [warning for warning in result["warnings"] if warning["code"] != "WEIGHT_UNSUPPORTED"] == ordinary_warnings
    # Closed-form MLE: full p=(1/4,3/4); scoped p=(1/3,2/3).
    ratio = 3 if len(row_ids) == 8 else 2
    coefficients = {item["name"]: item for item in result["coefficients"]}
    assert set(coefficients) == {"Intercept", *features}
    if ordinary_warnings:
        for item in coefficients.values():
            assert math.isfinite(item["coefficient"])
            assert item["inferenceStatus"] == "unavailable" and item["inferenceReason"] == "SINGULAR_INFORMATION"
            assert all(item[key] is None for key in ("stdError", "zValue", "pValue", "ciLower", "ciUpper"))
    else:
        assert coefficients["Intercept"]["coefficient"] == pytest.approx(-math.log(ratio), abs=2e-5)
        assert coefficients["x"]["coefficient"] == pytest.approx(2 * math.log(ratio), abs=2e-5)
        assert coefficients["x"]["oddsRatio"] == pytest.approx(ratio ** 2, rel=2e-5)
    assert [sample["rowId"] for sample in result["samples"]] == row_ids
    cells, log_likelihood = {name: [] for name in ("tn", "fp", "fn", "tp")}, 0.0
    for row, sample in zip(frame.to_dicts(), result["samples"], strict=True):
        actual, predicted = int(row["answer"] == 20), int(row["x"] == 1)
        probability = (ratio if predicted else 1) / (ratio + 1)
        log_likelihood += math.log(probability if actual else 1 - probability)
        assert sample["actual"] == actual and sample["predictedClass"] == predicted
        assert sample["predictedProb"] == pytest.approx(probability, abs=1e-5)
        assert sample["residual"] == pytest.approx(actual - probability, abs=1e-5)
        assert sample["isMisclassified"] is (actual != predicted)
        assert sample["featureValues"] == {feature: row[feature] for feature in features}
        cells[("tn", "fp", "fn", "tp")[2 * actual + predicted]].append(row["__rowId__"])
    for name, members in cells.items():
        assert result["confusionMatrix"][name] == len(members)
        assert result["confusionMatrix"][name + "RowIds"] == members
    metrics = result["fitMetrics"]
    assert metrics["converged"] is True
    assert metrics["logLikelihood"] == pytest.approx(log_likelihood, abs=1e-4)
    assert all(math.isfinite(value) for value in metrics.values())
    assert set(result["curves"]) == set(features)
    assert all(len(curve) == 80 and all(math.isfinite(point["x"]) and 0 < point["probability"] < 1
               for point in curve) for curve in result["curves"].values())
    assert "resultId" not in result  # Logistic returns a direct fit; there is no stored-result route.


@pytest.mark.parametrize("case", ["full", "scoped", "inference-warning"])
def test_logistic_discloses_unsupported_weight_without_changing_results(logistic_weighted_ds, case):
    client, ds, frame, specs, revisions = logistic_weighted_ds
    features = ["x", "x_copy"] if case == "inference-warning" else ["x"]
    ordinary_warnings = [{"code": "LOGISTIC_INFERENCE_UNAVAILABLE",
                          "message": "情報行列のランクが不足しているため、係数の標準誤差・Wald検定・信頼区間を計算できません。",
                          "details": {"reason": "SINGULAR_INFORMATION"}}] if case == "inference-warning" else []
    request = {"datasetId": ds, "targetColumn": specs["answer"]["columnId"],
               "featureColumns": [specs[feature]["columnId"] for feature in features], "intercept": True,
               "regularization": "none", "cutoff": 0.5,
               "expectedSchemaRevision": revisions["schemaRevision"],
               "expectedDataRevision": revisions["dataRevision"]}
    if case == "scoped":
        full = _post_success(client, "/api/v1/models/logistic", request)
        _assert_logistic_output(full, ds, frame, revisions, features, ordinary_warnings)
        frame = frame.slice(1, 6)  # Remove one correctly classified row from each x group.
        request["activeRowIds"] = list(reversed(frame["__rowId__"].to_list()))
    weight_id, results = specs["wt"]["columnId"], []
    for fields in ({}, {"weightColumn": None}, {"weightColumn": "wt"}, {"weightColumn": weight_id}):
        result = _post_success(client, "/api/v1/models/logistic", {**request, **fields})
        _assert_logistic_output(result, ds, frame, revisions, features, ordinary_warnings)
        if case == "scoped":
            assert result["scopeHash"] != full["scopeHash"]
            assert result["coefficients"] != full["coefficients"]
        if results:
            # Logistic has no volatile fields: retain every numerical/identity/diagnostic field.
            assert _stable_unweighted(result) == _stable_unweighted(results[0])
        results.append(result)
    _assert_weight_metadata(results, weight_id, ordinary_warnings)


@pytest.mark.parametrize("reference,code", [
    ("unknown", "WEIGHT_COLUMN_NOT_FOUND"), ("wrong-name", "WEIGHT_ROLE_INVALID"),
    ("wrong-id", "WEIGHT_ROLE_INVALID"),
])
def test_logistic_rejects_invalid_weight_reference(logistic_weighted_ds, reference, code):
    client, ds, _, specs, _ = logistic_weighted_ds
    weight_column = {"unknown": "nope", "wrong-name": "x", "wrong-id": specs["x"]["columnId"]}[reference]
    response = client.post("/api/v1/models/logistic", json={
        "datasetId": ds, "targetColumn": "answer", "featureColumns": ["x"],
        "regularization": "none", "weightColumn": weight_column,
    })
    assert response.status_code == 422 and response.json()["error"]["code"] == code
