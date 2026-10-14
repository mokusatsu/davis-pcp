"""IMPUTE-03/E04 and IMPUTE-04/E05 through the API.

E04: the preview and the apply must be the *same* computation.  The preview
reports a value hash per target column, and the applied dataframe must hash the
same — that is the regression condition the audit asked for.

E05: a derived (``inPlace: false``) dataset must record the imputation that
created it: its own provenance step and mask entries for the cells it filled,
plus the mask it inherited from the source.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.algorithms.imputation.core import column_values_hash
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def plan_ds(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    import app.api.datasets as datasets_api

    monkeypatch.setattr(datasets_api, "store", store)
    with TestClient(app) as client:
        rows = ["x,y,z,grp"]
        for i in range(1, 21):
            y = "" if i % 4 == 0 else f"{2 * i + (i % 3) * 0.25:.4f}"
            z = "" if i % 5 == 0 else f"{i * 3.0:.4f}"
            grp = "" if i % 7 == 0 else ("a" if i % 2 else "b")
            rows.append(f"{float(i)},{y},{z},{grp}")
        text = "\n".join(rows) + "\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("p.csv", text, "text/csv")}).json()["datasetId"]
        yield client, dataset_id, store
        client.delete(f"/api/v1/datasets/{dataset_id}")


def _mask(store, ds):
    return store.load_mask(ds) or {"entries": [], "maskRevision": 0}


def test_preview_and_apply_produce_the_same_values(plan_ds):
    """The headline E04 regression: preview two targets, apply two targets,
    and the values that land in the dataset are byte-for-byte the previewed
    ones."""
    client, ds, store = plan_ds
    body = {
        "columns": ["y", "z"],
        "predictorColumns": ["x"],
        "strategy": "tabdiff",
        "options": {"num_steps": 8, "seed": 11},
    }
    preview = client.post(f"/api/v1/datasets/{ds}/impute/preview", json=body)
    assert preview.status_code == 200, preview.text
    preview = preview.json()
    assert [c["column"] for c in preview["perColumn"]] == ["y", "z"]
    assert preview["predictorColumns"] == ["x"]

    apply = client.post(f"/api/v1/datasets/{ds}/impute",
                        json={**body, "inPlace": True, "planHash": preview["planHash"]})
    assert apply.status_code == 200, apply.text

    applied = store.get_dataframe(ds)
    for entry in preview["perColumn"]:
        column = entry["column"]
        assert column_values_hash(applied[column]) == entry["valuesHash"]
    assert apply.json()["outputHashes"]["y"] == preview["perColumn"][0]["valuesHash"]
    assert applied["y"].null_count() == 0
    assert applied["z"].null_count() == 0


def test_preview_and_apply_report_the_same_plan_hash(plan_ds):
    client, ds, store = plan_ds
    body = {"columns": ["y"], "predictorColumns": ["x"], "strategy": "mean"}
    preview = client.post(f"/api/v1/datasets/{ds}/impute/preview", json=body).json()
    apply = client.post(f"/api/v1/datasets/{ds}/impute",
                        json={**body, "inPlace": True, "planHash": preview["planHash"]})
    assert apply.status_code == 200, apply.text
    assert apply.json()["planHash"] == preview["planHash"]


def test_stale_plan_hash_is_rejected(plan_ds):
    client, ds, store = plan_ds
    body = {"columns": ["y"], "strategy": "mean"}
    preview = client.post(f"/api/v1/datasets/{ds}/impute/preview", json=body).json()

    # Any data change moves the revision the plan was pinned to.
    calc = client.post(f"/api/v1/datasets/{ds}/calculate",
                       json={"mode": "create", "expectedDataRevision": store.get_meta(ds)["dataRevision"], "expectedSchemaRevision": (store.load_codebook(ds) or {}).get("schemaRevision", 1), "expression": "x * 2", "columnName": "x2"})
    assert calc.status_code == 200, calc.text

    apply = client.post(f"/api/v1/datasets/{ds}/impute",
                        json={**body, "inPlace": True, "planHash": preview["planHash"]})
    assert apply.status_code == 409, apply.text
    assert apply.json()["error"]["code"] == "IMPUTATION_PLAN_STALE"


def test_target_as_predictor_is_rejected(plan_ds):
    client, ds, store = plan_ds
    res = client.post(f"/api/v1/datasets/{ds}/impute/preview",
                      json={"columns": ["y"], "predictorColumns": ["x", "y"], "strategy": "mean"})
    assert res.status_code == 422, res.text
    assert res.json()["error"]["code"] == "IMPUTATION_SELF_PREDICTOR"


def test_preview_reports_the_columns_it_actually_conditioned_on(plan_ds):
    client, ds, store = plan_ds
    res = client.post(f"/api/v1/datasets/{ds}/impute/preview",
                      json={"columns": ["y"], "predictorColumns": ["x"], "strategy": "tabdiff",
                            "options": {"num_steps": 5, "seed": 2}})
    assert res.status_code == 200, res.text
    payload = res.json()
    assert payload["diagnostics"]["conditioningColumns"] == ["x", "y"]
    assert payload["diagnostics"]["conditioningColumns"][-1] == "y"
    # A categorical column cannot condition the numeric diffusion.
    res2 = client.post(f"/api/v1/datasets/{ds}/impute/preview",
                       json={"columns": ["y"], "predictorColumns": ["x", "grp"],
                             "strategy": "tabdiff", "options": {"num_steps": 5, "seed": 2}})
    assert res2.status_code == 200, res2.text
    assert res2.json()["predictorColumns"] == ["x"]
    assert any(w["code"] == "PREDICTOR_CATEGORICAL_IGNORED" for w in res2.json()["warnings"])


def test_derived_dataset_records_its_own_imputation(plan_ds):
    """E05: the new dataset gets the imputation step and the mask entries for
    the cells it filled, and the source dataset is untouched."""
    client, ds, store = plan_ds
    source_meta_before = store.get_meta(ds)
    source_mask_before = _mask(store, ds)
    missing_y = store.get_dataframe(ds)["y"].null_count() + store.get_dataframe(ds)["z"].null_count()
    assert missing_y > 0

    body = {"columns": ["y", "z"], "predictorColumns": ["x"], "strategy": "mean",
            "inPlace": False}
    res = client.post(f"/api/v1/datasets/{ds}/impute", json=body)
    assert res.status_code == 200, res.text
    created = res.json()
    new_id_ = created["datasetId"]
    try:
        assert created["sourceDatasetId"] == ds
        assert created["derivation"] == "impute"

        new_mask = _mask(store, new_id_)
        entries = new_mask["entries"]
        assert len(entries) == missing_y
        assert {e["columnId"] for e in entries} == {"y", "z"}
        assert {e["methodId"] for e in entries} == {"mean"}
        assert all(e["rowId"] for e in entries)

        provenance = client.get(f"/api/v1/datasets/{new_id_}/provenance").json()
        seed = provenance["operations"][0]
        assert seed["operation"] == "impute"
        assert seed["params"]["strategy"] == "mean"
        assert seed["params"]["columns"] == ["y", "z"]
        assert seed["params"]["sourceDatasetId"] == ds
        assert seed["params"]["sourceDataRevision"] == int(source_meta_before["dataRevision"])
        assert seed["params"]["rawSemantics"] == "derived_creation"
        assert {e["createdByOperationId"] for e in entries} == {seed["operationId"]}
        # A derived dataset has one revision: there is nothing to undo.
        assert provenance["canUndo"] is False

        # The source keeps its revision, its mask and its missing values.
        source_meta_after = store.get_meta(ds)
        assert int(source_meta_after["dataRevision"]) == int(source_meta_before["dataRevision"])
        assert int(_mask(store, ds)["maskRevision"]) == int(source_mask_before["maskRevision"])
        assert len(_mask(store, ds)["entries"]) == len(source_mask_before["entries"])
        assert store.get_dataframe(ds)["y"].null_count() > 0

        detail = client.get(f"/api/v1/datasets/{new_id_}").json()
        assert detail["sourceDatasetId"] == ds
    finally:
        client.delete(f"/api/v1/datasets/{new_id_}")


def test_derived_dataset_inherits_the_source_mask(plan_ds):
    client, ds, store = plan_ds
    first = client.post(f"/api/v1/datasets/{ds}/impute",
                        json={"columns": ["y"], "strategy": "mean", "inPlace": True})
    assert first.status_code == 200, first.text
    inherited = _mask(store, ds)["entries"]
    assert len(inherited) > 0

    res = client.post(f"/api/v1/datasets/{ds}/impute",
                      json={"columns": ["z"], "strategy": "mean", "inPlace": False})
    assert res.status_code == 200, res.text
    new_id_ = res.json()["datasetId"]
    try:
        entries = _mask(store, new_id_)["entries"]
        carried = [e for e in entries if e.get("inheritedFromDatasetId") == ds]
        assert len(carried) == len(inherited)
        # …plus the cells this derivation filled.
        assert len(entries) > len(carried)
        assert {e["columnId"] for e in entries if not e.get("inheritedFromDatasetId")} == {"z"}
    finally:
        client.delete(f"/api/v1/datasets/{new_id_}")


@pytest.mark.parametrize("in_place", [True, False])
@pytest.mark.parametrize("neighbors", [1, 5, 50])
def test_knn_preview_matches_apply_in_both_storage_modes(plan_ds, in_place, neighbors):
    """Storage choice must not change the shared KNN computation or donor inputs."""
    client, ds, store = plan_ds
    before = store.get_dataframe(ds)
    source_revision = store.get_meta(ds)["dataRevision"]
    source_mask = _mask(store, ds)
    body = {"columns": ["y", "z"], "predictorColumns": ["x"], "strategy": "knn",
            "options": {"knn_neighbors": neighbors}}
    preview_response = client.post(f"/api/v1/datasets/{ds}/impute/preview", json=body)
    assert preview_response.status_code == 200, preview_response.text
    preview = preview_response.json()
    assert store.get_dataframe(ds).to_dict(as_series=False) == before.to_dict(as_series=False)

    apply = client.post(f"/api/v1/datasets/{ds}/impute",
                        json={**body, "inPlace": in_place, "planHash": preview["planHash"]})
    assert apply.status_code == 200, apply.text
    output_id = apply.json()["datasetId"]
    try:
        assert (output_id == ds) is in_place
        result = store.get_dataframe(output_id)
        for entry in preview["perColumn"]:
            name = entry["column"]
            assert column_values_hash(result[name]) == entry["valuesHash"]
            assert apply.json()["outputHashes"][name] == entry["valuesHash"]
            assert result[name].null_count() == 0
            # Original observations remain donors, never rewritten predictions.
            for old, new in zip(before[name].to_list(), result[name].to_list()):
                if old is not None:
                    assert new == old
        for name in ("__rowId__", "x", "grp"):
            assert result[name].to_list() == before[name].to_list()
        assert len(_mask(store, output_id)["entries"]) == before["y"].null_count() + before["z"].null_count()
        if not in_place:
            assert store.get_dataframe(ds).to_dict(as_series=False) == before.to_dict(as_series=False)
            assert store.get_meta(ds)["dataRevision"] == source_revision
            assert _mask(store, ds) == source_mask
    finally:
        if output_id != ds:
            client.delete(f"/api/v1/datasets/{output_id}")


@pytest.mark.parametrize('in_place', [True, False])
def test_knn_predictor_counterexample_preview_apply_and_undo(plan_ds, in_place):
    client, _, store = plan_ds
    response = client.post('/api/v1/datasets/import', files={
        'file': ('geometry.csv', 'x,y\n0,100\n1,0\n100,0\n0,\n', 'text/csv')})
    assert response.status_code == 200, response.text
    ds = response.json()['datasetId']
    before = store.get_dataframe(ds)
    body = {'columns': ['y'], 'predictorColumns': ['x'], 'strategy': 'knn', 'options': {'knn_neighbors': 1}}
    preview = client.post(f'/api/v1/datasets/{ds}/impute/preview', json=body)
    assert preview.status_code == 200, preview.text
    assert preview.json()['diagnostics']['conditioningColumns'] == ['x']
    assert preview.json()['perColumn'][0]['afterStats']['mean'] == 50.
    applied = client.post(f'/api/v1/datasets/{ds}/impute', json={
        **body, 'inPlace': in_place, 'planHash': preview.json()['planHash']})
    assert applied.status_code == 200, applied.text
    output = applied.json()['datasetId']
    assert store.get_dataframe(output)['y'].to_list() == [100., 0., 0., 100.]
    assert applied.json()['outputHashes']['y'] == preview.json()['perColumn'][0]['valuesHash']
    if in_place:
        undo = client.post(f'/api/v1/datasets/{ds}/undo', json={})
        assert undo.status_code == 200, undo.text
        assert store.get_dataframe(ds).to_dict(as_series=False) == before.to_dict(as_series=False)
        assert _mask(store, ds)['entries'] == []
    else:
        assert store.get_dataframe(ds).to_dict(as_series=False) == before.to_dict(as_series=False)
        assert not client.get(f'/api/v1/datasets/{output}/provenance').json()['canUndo']
        client.delete(f'/api/v1/datasets/{output}')
    client.delete(f'/api/v1/datasets/{ds}')


@pytest.mark.parametrize('predictors', [[], ['grp']])
@pytest.mark.parametrize('in_place', [True, False])
def test_knn_no_predictors_rejected_by_preview_and_apply_without_mutation(plan_ds, predictors, in_place):
    client, ds, store = plan_ds
    before, meta, mask = store.get_dataframe(ds), store.get_meta(ds), _mask(store, ds)
    body = {'columns': ['y'], 'predictorColumns': predictors, 'strategy': 'knn', 'inPlace': in_place}
    for endpoint in ['impute/preview', 'impute']:
        response = client.post(f'/api/v1/datasets/{ds}/{endpoint}', json=body)
        assert response.status_code == 422, response.text
        assert response.json()['error']['code'] == 'IMPUTATION_NO_PREDICTORS'
        assert store.get_dataframe(ds).to_dict(as_series=False) == before.to_dict(as_series=False)
        assert store.get_meta(ds) == meta
        assert _mask(store, ds) == mask


def test_knn_auto_with_all_columns_targeted_rejects_in_preview_and_apply(plan_ds):
    client, ds, store = plan_ds
    before = store.get_dataframe(ds).to_dict(as_series=False)
    body = {'columns': ['x', 'y', 'z', 'grp'], 'strategy': 'knn'}
    for endpoint in ['impute/preview', 'impute']:
        response = client.post(f'/api/v1/datasets/{ds}/{endpoint}', json=body)
        assert response.status_code == 422, response.text
        assert response.json()['error']['code'] == 'IMPUTATION_NO_PREDICTORS'
        assert store.get_dataframe(ds).to_dict(as_series=False) == before
