"""EFA saves intersect stored row IDs with the requested scope.

The ten real import/fit/predict cases exercise the actual EFA workflow, including
its captured-fit GUI save context. Separately labeled stored-result controls
isolate row-ID joins and scope boundaries; they do not validate EFA arithmetic.
"""
from __future__ import annotations

import hashlib
import json
import uuid
from pathlib import Path

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.storage import analysis_result_store as result_store
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    root = tmp_path / "workspace"
    monkeypatch.setattr(settings, "workspace_dir", root)
    settings.ensure_dirs()
    from app.api import analysis_results, datasets, factor_analysis
    store = DatasetStore(root)
    for module in (datasets, analysis_results, factor_analysis):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        yield client, store, root


def contents(root):
    return {str(p.relative_to(root)): p.read_bytes()
            for p in sorted(root.rglob("*")) if p.is_file()}


def inventory(files):
    return {path: {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            for path, data in files.items()}


def imported(client, store, frame):
    response = client.post("/api/v1/datasets/import", files={
        "file": ("synthetic-efa-scope.csv", frame.write_csv().encode(), "text/csv")})
    assert response.status_code == 200, response.text
    ds = response.json()["datasetId"]
    context = {"datasetId": ds, "expectedDataRevision": 1,
               "expectedSchemaRevision": 1, "scope": "all", "weightMode": "none"}
    return ds, context, store.get_dataframe(ds)


def stored_result_boundary_fixture(client, store, kind):
    ds, context, original = imported(client, store, pl.DataFrame({
        "original_number": [3.25, 7.5, None, -4.0, 0.0, 16.75],
        "original_text": ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]}))
    ids = original["__rowId__"].to_list()
    result_id = str(uuid.uuid4())
    fit = pl.DataFrame({"rowId": [ids[3], ids[0], ids[2]],
                        "score1": [40.5, 10.25, 30.75]})
    prediction = pl.DataFrame({"rowId": [ids[4], ids[2], ids[0], ids[1]],
                               "score1": [50.5, None, 10.5, 20.5],
                               "status": ["ok", "missing", "ok", "ok"]})
    prediction_id = "pred-scope-proof"
    result_store.save_result(result_id, {
        "schemaVersion": "factor_extensions.1", "resultId": result_id,
        "method": "efa", "ownerDatasetId": ds,
        "meta": {"dataRevision": 1, "schemaRevision": 1},
        "capabilities": {"materialize": True, "materializeFitFields": ["score:1"],
                         "materializePredictionFields": ["score:1"]},
        "summary": {"nFactors": 1}, "config": {}, "details": {},
    }, {}, rows=fit, predictions={prediction_id: prediction})
    source = "fit" if kind == "fit" else prediction_id
    source_frame = fit if kind == "fit" else prediction
    values = {str(r["rowId"]): r["score1"] for r in source_frame.rows(named=True)}
    return ds, context, original, result_id, source, values


SCOPE_FIELD = {"active": "activeRowIds", "selected": "selectedRowIds",
               "sampled": "sampledRowIds", "explicit": "rowIds"}
CASES = ["all", "active", "selected", "sampled", "explicit",
         "empty_active", "empty_selected", "empty_sampled", "empty_explicit",
         "disjoint_active", "disjoint_selected", "disjoint_sampled", "disjoint_explicit",
         "unknown_active", "unknown_selected", "unknown_sampled", "explicit_unknown",
         "stored_null_row"]


def requested_context(context, ids, case):
    if case == "all":
        return context, list(ids)
    if case.startswith("empty_"):
        scope = case.removeprefix("empty_")
        return dict(context, scope=scope, **{SCOPE_FIELD[scope]: []}), []
    if case.startswith("disjoint_"):
        scope = case.removeprefix("disjoint_")
        return dict(context, scope=scope, **{SCOPE_FIELD[scope]: [ids[5]]}), [ids[5]]
    if case.startswith("unknown_"):
        scope = case.removeprefix("unknown_")
        return dict(context, scope=scope, **{SCOPE_FIELD[scope]: ["foreign-row-id"]}), []
    if case == "stored_null_row":
        return dict(context, scope="selected", selectedRowIds=[ids[2]]), [ids[2]]
    if case == "explicit_unknown":
        return dict(context, scope="explicit", rowIds=[ids[0], "foreign-row-id"]), None
    target = [ids[0], ids[2], ids[5]]
    # Deliberately reversed and repeated: scope is a set, source order differs.
    supplied = [ids[5], ids[2], ids[0], ids[2]]
    if case != "explicit":
        supplied.append("foreign-row-id")
    return dict(context, scope=case, **{SCOPE_FIELD[case]: supplied}), target


def perform(client, store, root, ds, context, original, result_id, source, values,
            save_context, target_ids, label, tmp_path):
    endpoint = f"/api/v1/analysis-results/{result_id}/materialize"
    payload = {"context": save_context, "source": source,
               "columns": [{"source": "score:1", "name": "saved_scope_score"},
                           {"source": "score:1", "name": "SAVED_SCOPE_ALIAS"}],
               "idempotencyKey": "scope-proof"}
    before = contents(root)
    result_before = contents(result_store.result_dir(result_id))
    controls = []

    def reject(name, request, snapshot, status, code):
        response = client.post(endpoint, json=request)
        assert response.status_code == status, response.text
        assert response.json()["error"]["code"] == code, response.text
        assert contents(root) == snapshot
        controls.append({"name": name, "status": status, "code": code,
                         "workspace_bytes_unchanged": True})

    base = {**payload, "context": context}
    for name in (next(c for c in original.columns if c != "__rowId__"), "__rowId__"):
        reject("existing:" + name, {**base,
               "columns": [{"source": "score:1", "name": name}]},
               before, 409, "COLUMN_ALREADY_EXISTS")
    for revision in ("expectedDataRevision", "expectedSchemaRevision"):
        reject("stale:" + revision, {**base, "context": dict(context, **{revision: 999})},
               before, 409, "ANALYSIS_INPUT_STALE")
    reject("wrong_dataset", {**base, "context": dict(context, datasetId="other-dataset")},
           before, 422, "ANALYSIS_DATASET_MISMATCH")
    for scope in SCOPE_FIELD:
        reject("missing_required_scope_ids:" + scope,
               {**base, "context": dict(context, scope=scope)},
               before, 422, "ANALYSIS_REQUEST_INVALID")
    reject("duplicate_destination", {**base, "columns": [
        {"source": "score:1", "name": "saved_scope_score"},
        {"source": "score:1", "name": "saved_scope_score"}]},
           before, 409, "COLUMN_ALREADY_EXISTS")

    response = client.post(endpoint, json=payload)
    observed = {"case": label, "datasetId": ds, "resultId": result_id,
                "request": payload, "responseStatus": response.status_code,
                "response": response.json(), "original": original.to_dict(as_series=False),
                "sourceValuesByRowId": values, "targetRowIds": target_ids,
                "before": inventory(before), "controls": controls}
    if response.status_code == 200:
        receipt = response.json()
        saved = store.get_dataframe(ds)
        after = contents(root)
        assert saved.columns == original.columns + ["saved_scope_score", "SAVED_SCOPE_ALIAS"]
        assert saved.select(original.columns).equals(original)
        assert saved.schema["__rowId__"] == original.schema["__rowId__"] == pl.String
        assert contents(result_store.result_dir(result_id)) == result_before
        actual = saved["saved_scope_score"].to_list()
        assert saved["SAVED_SCOPE_ALIAS"].to_list() == actual
        assert receipt["columns"] == payload["columns"]
        ids = original["__rowId__"].to_list()
        expected = [values.get(str(rid)) if target_ids is not None and rid in target_ids
                    else None for rid in ids]
        # A value may be incorrectly present, but any saved value must still
        # equal the original source value for exactly that row ID.
        assert all(v is None or v == values.get(str(rid)) for rid, v in zip(ids, actual))
        assert receipt["dataRevision"] == receipt["schemaRevision"] == 2
        provenance = store.load_provenance(ds)
        assert len(provenance["operations"]) == 2
        operation = provenance["operations"][-1]
        assert operation["outputDataRevision"] == operation["outputSchemaRevision"] == 2
        assert operation["targetRowIds"] == sorted(set(target_ids))
        assert operation["params"]["efaColumns"] == payload["columns"]
        assert [f["values"] for f in operation["params"]["efaFields"]] == [actual, actual]
        observed.update({"actual": actual, "expected": expected,
                         "source_and_original_values_preserved": True,
                         "unexpectedNonNullRowIds": [rid for rid, v, want in zip(ids, actual, expected)
                                                    if v is not None and want is None],
                         "provenanceTargetRowIds": operation["targetRowIds"],
                         "after": inventory(after)})
        # Replay normalization and stale-revision precedence are retained.
        replay_contexts = [save_context, dict(save_context, expectedDataRevision=2,
                                              expectedSchemaRevision=2)]
        field = SCOPE_FIELD.get(save_context["scope"])
        if field:
            replay_contexts.append(dict(save_context, **{
                field: sorted(set(save_context[field]))}))
        for replay_context in replay_contexts:
            replay = client.post(endpoint, json={**payload, "context": replay_context})
            assert replay.status_code == 200, replay.text
            assert replay.json() == {**receipt, "idempotentReplay": True}
            assert contents(root) == after
        controls.append({"name": "exact_receipt_replay", "count": len(replay_contexts),
                         "workspace_bytes_unchanged": True})
        changed_scope = (dict(context, scope="selected", selectedRowIds=[ids[0]])
                         if save_context["scope"] == "all" else context)
        reject("changed_scope_same_key", {**payload, "context": changed_scope},
               after, 409, "IDEMPOTENCY_CONFLICT")
        reject("changed_destination_same_key", {**payload, "columns": [
            {"source": "score:1", "name": "changed_destination"}]},
               after, 409, "IDEMPOTENCY_CONFLICT")
        reject("new_key_old_fit_current_revisions", {**payload,
            "idempotencyKey": "new-key", "context": dict(save_context,
                expectedDataRevision=2, expectedSchemaRevision=2),
            "columns": [{"source": "score:1", "name": "new_destination"}]},
               after, 409, "ANALYSIS_INPUT_STALE")
    else:
        assert contents(root) == before
        observed["workspace_bytes_unchanged"] = True
    # Keep each real-workflow or boundary-control request and storage receipt.
    (tmp_path / "scope-evidence.json").write_text(json.dumps(observed, indent=2) + "\n")
    if target_ids is None:
        assert response.status_code == 422, "Explicit foreign row ID was accepted and wrote values"
        assert response.json()["error"]["code"] == "ANALYSIS_SCOPE_UNKNOWN_ROW"
    elif any(values.get(str(rid)) is not None for rid in target_ids):
        assert response.status_code == 200, response.text
        assert observed["actual"] == observed["expected"], "Values escaped the requested scope"
    else:
        # Preserve the existing no-available-value guard after scope intersection.
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "LR_FIELD_UNAVAILABLE"


@pytest.mark.parametrize("kind", ["fit", "prediction"])
@pytest.mark.parametrize("case", CASES)
def test_stored_result_scope_boundaries(isolated, tmp_path, kind, case):
    client, store, root = isolated
    ds, context, original, result_id, source, values = stored_result_boundary_fixture(client, store, kind)
    save_context, target_ids = requested_context(context, original["__rowId__"].to_list(), case)
    perform(client, store, root, ds, context, original, result_id, source, values,
            save_context, target_ids, f"{kind}:{case}", tmp_path)


@pytest.mark.parametrize("kind", ["fit", "prediction"])
@pytest.mark.parametrize("case", ["positive", "active", "selected", "sampled", "explicit"])
def test_real_fit_prediction_scope_contract(isolated, tmp_path, kind, case):
    client, store, root = isolated
    rng = np.random.default_rng(5)
    loading = np.array([.8, .7, .6, .5])[:, None]
    covariance = loading @ loading.T + np.diag(1 - np.diag(loading @ loading.T))
    data = rng.multivariate_normal(np.zeros(4), covariance, size=200)
    frame = pl.DataFrame({f"q{i + 1}": data[:, i].tolist() for i in range(4)})
    frame = frame.with_columns(pl.when(pl.int_range(pl.len()) == 0).then(None)
                               .otherwise(pl.col("q1")).alias("q1"))
    ds, context, original = imported(client, store, frame)
    ids = original["__rowId__"].to_list()
    fit_context = dict(context, scope="selected", selectedRowIds=ids[:180])
    cb = store.load_codebook(ds)
    fitted = client.post("/api/v1/models/factor-analysis", json={
        "context": fit_context,
        "variables": [{"columnId": c["columnId"], "measurement": "continuous",
                       "treatment": "continuous"} for c in cb["columns"]],
        "correlation": "pearson", "extraction": "ml", "nFactors": 1,
        "rotation": "varimax", "scoreMethod": "regression",
        "parallelAnalysis": {"enabled": False}, "uniquenessLower": .005,
        "nStarts": 1, "maxIterations": 300, "seed": 1,
        "method": "efa", "schemaVersion": "factor_extensions.1"})
    assert fitted.status_code == 200, fitted.text
    result_id = fitted.json()["resultId"]
    assert fitted.json()["capabilities"]["materialize"]
    source = "fit"
    source_frame = result_store.load_rows(result_id)
    assert source_frame.height == 179
    save_context, target_ids = fit_context, ids[:180]
    if kind == "prediction":
        # This is API integration only; current GUI save always uses source=fit.
        predicted = client.post(f"/api/v1/analysis-results/{result_id}/predict", json={
            "context": dict(context, scope="sampled", sampledRowIds=[ids[190], ids[0], ids[2]]),
            "options": {"interval": "none", "evaluate": False}})
        assert predicted.status_code == 200, predicted.text
        assert predicted.json()["summary"]["successfulPredictions"] == 2
        assert predicted.json()["summary"]["failedPredictions"] == 1
        source = predicted.json()["predictionId"]
        source_frame = result_store.load_prediction_rows(result_id, source)
        save_context, target_ids = context, ids
    values = {str(r["rowId"]): r["score1"] for r in source_frame.rows(named=True)}
    if case != "positive":
        save_context, target_ids = requested_context(context, ids, case)
    perform(client, store, root, ds, context, original, result_id, source, values,
            save_context, target_ids, f"real_{kind}:{case}", tmp_path)
