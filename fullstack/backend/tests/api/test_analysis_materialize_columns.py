"""Analysis saves must never replace physical row identity.

Use real import/fit/predict/materialize routes and persistence in a fresh
workspace per case. Only the workspace and store roots are redirected.
"""
from __future__ import annotations

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def analysis_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    settings.ensure_dirs()

    from app.api import (analysis_results, datasets, factor_analysis, famd,
                         linear_regression, mca)
    store = DatasetStore(tmp_path)
    for module in (datasets, analysis_results, linear_regression, mca, famd,
                   factor_analysis):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        yield client, store


def _workspace_bytes(store):
    """Include data, metadata, codebook, masks, raw imports and all history.

    Also include result artifacts so a rejected save or replay cannot mutate
    an existing result or quietly publish extra files.
    """
    root = store.root.parent
    return {str(path.relative_to(root)): path.read_bytes()
            for path in sorted(root.rglob("*")) if path.is_file()}


def _fit(client, method):
    if method == "ols":
        frame = pl.DataFrame({
            "y": [2.2, 1.4, 3.1, 3.1, 3.1, 4.9, 4.7, 4.9, 5.8, 6.0],
            "x": [0.0, .333, .667, 1.0, 1.333, 1.667, 2., 2.333, 2.667, 3.0],
            "g": ["a", "b", "a", "b", "b", "a", "a", "b", "a", "b"],
        })
    elif method == "mca":
        frame = pl.DataFrame({
            "q1": ["a", "a", "b", "b"] * 3,
            "q2": ["x", "y", "x", "y"] * 3,
            "q3": ["p", "p", "q", "q"] * 3,
        })
    elif method == "famd":
        frame = pl.DataFrame({
            "age": [20.0 + i for i in range(12)],
            "sat": [float(i % 5 + 1) for i in range(12)],
            "q1": ["a", "a", "b", "b", "c", "c"] * 2,
            "q2": ["x", "y"] * 6,
        })
    else:
        rng = np.random.default_rng(5)
        loading = np.array([[.8], [.7], [.6], [.5]])
        covariance = loading @ loading.T + np.diag(1 - np.diag(loading @ loading.T))
        # The existing EFA API fixture produces an admissible scored solution.
        data = rng.multivariate_normal(np.zeros(4), covariance, size=200)
        frame = pl.DataFrame({f"q{i + 1}": data[:, i] for i in range(4)})
    response = client.post(
        "/api/v1/datasets/import",
        files={"file": (f"{method}.csv", frame.write_csv().encode(), "text/csv")},
    )
    assert response.status_code == 200, response.text
    dataset_id = response.json()["datasetId"]
    codebook = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
    columns = {column["name"]: column["columnId"] for column in codebook["columns"]}
    context = {"datasetId": dataset_id, "expectedDataRevision": 1,
               "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none"}
    if method == "ols":
        endpoint = "linear-regression"
        payload = {
            "context": context, "target": columns["y"],
            "predictors": [{"columnId": columns["x"], "kind": "numeric"},
                           {"columnId": columns["g"], "kind": "categorical"}],
            "interactions": [], "intercept": True,
            "covariance": "classical", "confidenceLevel": .95,
        }
    elif method == "mca":
        endpoint = "mca"
        payload = {"context": context, "variables": list(columns.values()),
                   "maMode": "ordinary_only", "inertiaAdjustment": "raw"}
    elif method == "famd":
        endpoint = "famd"
        payload = {
            "context": context, "numericVariables": [columns["age"], columns["sat"]],
            "categoricalVariables": [columns["q1"], columns["q2"]],
        }
    else:
        endpoint = "factor-analysis"
        payload = {
            "context": context,
            "variables": [{"columnId": column, "measurement": "continuous",
                           "treatment": "continuous"} for column in columns.values()],
            "correlation": "pearson", "extraction": "ml", "nFactors": 1,
            "rotation": "varimax", "scoreMethod": "regression",
            "parallelAnalysis": {"enabled": False}, "uniquenessLower": .005,
            "nStarts": 1, "maxIterations": 300, "seed": 1,
            "method": "efa", "schemaVersion": "factor_extensions.1",
        }
    response = client.post(f"/api/v1/models/{endpoint}", json=payload)
    assert response.status_code == 200, response.text
    fit = response.json()
    assert fit["capabilities"]["materialize"]
    return dataset_id, context, fit["resultId"], next(iter(columns))


def _source(client, method, result_id, context, source_kind):
    source = "fit"
    if source_kind == "prediction":
        response = client.post(
            f"/api/v1/analysis-results/{result_id}/predict",
            json={"context": context, "options": {}},
        )
        assert response.status_code == 200, response.text
        source = response.json()["predictionId"]
    if method == "ols":
        field = "fitted" if source_kind == "fit" else "predicted"
    else:
        field = "score:1" if method == "efa" else "coordinate:1"
    return source, field


def _column(method, field, name):
    return {"source" if method == "efa" else "sourceField": field, "name": name}


def _save(client, result_id, payload):
    return client.post(f"/api/v1/analysis-results/{result_id}/materialize", json=payload)


def _assert_rejected(client, store, result_id, payload, before, code, status=409):
    response = _save(client, result_id, payload)
    assert response.status_code == status, response.text
    assert response.json()["error"]["code"] == code
    assert _workspace_bytes(store) == before


@pytest.mark.parametrize("method", ["ols", "mca", "famd", "efa"])
@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_reserved_destination_rejected_without_writes(
    analysis_workspace, method, source_kind, scope,
):
    client, store = analysis_workspace
    dataset_id, context, result_id, ordinary_name = _fit(client, method)
    source, field = _source(client, method, result_id, context, source_kind)
    frame = store.get_dataframe(dataset_id)
    assert frame.schema["__rowId__"] == pl.String
    assert "__rowId__" not in {c["name"] for c in store.get_meta(dataset_id)["schema"]}
    assert "__rowId__" not in {c["name"] for c in store.load_codebook(dataset_id)["columns"]}
    if scope == "selected":
        context = dict(context, scope=scope, selectedRowIds=frame["__rowId__"].to_list()[::2])
    before = _workspace_bytes(store)
    # Ensure the invariant actually covers original history snapshots too.
    assert any(".revisions/" in path for path in before)
    payload = {"context": context, "source": source,
               "columns": [_column(method, field, ordinary_name)],
               "idempotencyKey": "ordinary-collision"}
    _assert_rejected(client, store, result_id, payload, before, "COLUMN_ALREADY_EXISTS")
    payload = {**payload, "columns": [_column(method, field, "__rowId__")],
               "idempotencyKey": "reserved-collision"}
    _assert_rejected(client, store, result_id, payload, before, "COLUMN_ALREADY_EXISTS")
    # A mismatched revision still wins over a column collision.
    for revision in ("expectedDataRevision", "expectedSchemaRevision"):
        _assert_rejected(
            client, store, result_id,
            {**payload, "context": dict(context, **{revision: 999})},
            before, "ANALYSIS_INPUT_STALE",
        )
    assert store.get_dataframe(dataset_id).equals(frame)


@pytest.mark.parametrize("method", ["ols", "mca", "famd"])
@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
@pytest.mark.parametrize("scope", ["all", "selected"])
def test_unique_destination_values_scope_and_replay_preserved(
    analysis_workspace, method, source_kind, scope,
):
    client, store = analysis_workspace
    dataset_id, context, result_id, _ = _fit(client, method)
    source, field = _source(client, method, result_id, context, source_kind)
    endpoint = f"/api/v1/analysis-results/{result_id}"
    if source_kind == "prediction":
        endpoint += f"/predictions/{source}"
    response = client.get(endpoint + "/rows", params={"offset": 0, "limit": 1000})
    assert response.status_code == 200, response.text
    rows = response.json()["rows"]
    values = {str(row["rowId"]): row[field] if method == "ols" else row["coordinates"][0]
              for row in rows if source_kind == "fit" or row.get("predictionStatus") == "ok"}
    frame = store.get_dataframe(dataset_id)
    row_ids = frame["__rowId__"].to_list()
    chosen = row_ids[::2] if scope == "selected" else row_ids
    if scope == "selected":
        context = dict(context, scope=scope, selectedRowIds=chosen)
    before = _workspace_bytes(store)
    name = "SAFE_ANALYSIS_VALUE"
    payload = {"context": context, "source": source,
               "columns": [_column(method, field, name)], "idempotencyKey": "unique"}
    # Field and identifier validation must remain ahead of materialization.
    _assert_rejected(
        client, store, result_id,
        {**payload, "columns": [_column(method, "unsupported", "__rowId__")]},
        before, "ANALYSIS_REQUEST_INVALID", status=422,
    )
    _assert_rejected(
        client, store, result_id,
        {**payload, "columns": [_column(method, field, "invalid-name")]},
        before, "ANALYSIS_REQUEST_INVALID", status=422,
    )
    response = _save(client, result_id, payload)
    assert response.status_code == 200, response.text
    first = response.json()
    saved = store.get_dataframe(dataset_id)
    expected = [values.get(row_id) if row_id in chosen else None for row_id in row_ids]
    assert saved.select(frame.columns).equals(frame)
    assert saved.schema["__rowId__"] == pl.String
    assert saved.schema[name] == pl.Float64
    assert saved[name].to_list() == expected
    assert saved.width == frame.width + 1
    count = sum(value is not None for value in expected)
    assert count > 0
    assert first["writtenRowCount"] == count
    assert first["createdColumns"][0]["nonNullCount"] == count
    assert first["createdColumns"][0]["name"] == name
    assert first["createdColumns"][0]["sourceField"] == field
    assert first["idempotentReplay"] is False
    assert first["dataRevision"] == first["schemaRevision"] == 2
    assert store.get_meta(dataset_id)["dataRevision"] == 2
    assert store.load_codebook(dataset_id)["schemaRevision"] == 2
    after = _workspace_bytes(store)
    # A successful new save makes the old result stale. Identical retries
    # still return the complete original receipt before stale/collision checks.
    current_context = dict(context, expectedDataRevision=2, expectedSchemaRevision=2)
    for replay_context in (context, current_context):
        replay = _save(client, result_id, {**payload, "context": replay_context})
        assert replay.status_code == 200, replay.text
        assert replay.json() == {**first, "idempotentReplay": True}
        assert _workspace_bytes(store) == after
    other_payload = {**payload, "context": current_context,
                     "columns": [_column(method, field, "OTHER_SAFE_VALUE")]}
    _assert_rejected(client, store, result_id, other_payload, after, "IDEMPOTENCY_CONFLICT")
    _assert_rejected(
        client, store, result_id, {**other_payload, "idempotencyKey": "new-key"},
        after, "ANALYSIS_INPUT_STALE",
    )
