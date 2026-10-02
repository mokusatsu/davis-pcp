"""Small, synthetic fixtures for exported data and portable codebook contracts."""
from __future__ import annotations

import io
import json

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, exports
from app.main import app
from app.storage.dataset_store import DatasetStore


CSV = ("answer,w,stratum,psu,fpc,rw1,rw2,option_a,option_b\n"
       "1,0.5,A,P1,20,0.4,0.6,1,0\n"
       "2,2.5,A,P2,20,2.4,2.6,0,1\n"
       ",1.5,B,P3,30,1.4,1.6,1,1\n").encode()


@pytest.fixture
def client(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, "store", store)
    monkeypatch.setattr(exports, "store", store)
    return TestClient(app)


def upload(client, raw=CSV, name="survey.csv"):
    response = client.post("/api/v1/datasets/import", files={"file": (name, raw)})
    assert response.status_code == 200, response.text
    return response.json()["datasetId"]


def codebook(client, dataset_id):
    return client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()


def import_codebook(client, dataset_id, payload):
    return client.post(f"/api/v1/datasets/{dataset_id}/codebook/import",
                       files={"file": ("codebook.json", json.dumps(payload).encode())})


def configured_codebook(client, dataset_id, weight_type="survey"):
    cb = codebook(client, dataset_id)
    ids = {c["name"]: c["columnId"] for c in cb["columns"]}
    response = client.put(f"/api/v1/datasets/{dataset_id}/codebook", json={
        "columns": [
            {"columnId": ids["answer"], "label": "回答", "role": "question",
             "scaleType": "ordinal", "categoryOrder": ["1", "2"],
             "valueLabels": {"1": "いいえ", "2": "はい"}, "missingCodes": ["99"]},
            {"columnId": ids["w"], "role": "weight"},
            {"columnId": ids["option_a"], "scaleType": "nominal", "multiResponseGroup": "options"},
            {"columnId": ids["option_b"], "scaleType": "nominal", "multiResponseGroup": "options"},
        ],
        "multiResponseGroups": [{"groupId": "options", "label": "複数回答",
                                 "optionOrder": [ids["option_b"], ids["option_a"]]}],
        "weightConfig": {"weightColumnId": ids["w"], "weightType": weight_type},
        "surveyDesign": {"weightColumnId": ids["w"], "strataColumnId": ids["stratum"],
                         "psuColumnId": ids["psu"], "fpcColumnId": ids["fpc"],
                         "replicateWeightColumnIds": [ids["rw2"], ids["rw1"]]},
    })
    assert response.status_code == 200, response.text
    return client.get(f"/api/v1/datasets/{dataset_id}/codebook/export?format=json").json()


def test_own_arrow_export_import_roundtrip(client):
    source = upload(client)
    response = client.post("/api/v1/exports", json={"datasetId": source, "format": "arrow"})
    assert response.status_code == 200
    assert response.content.startswith(b"\xff\xff\xff\xff")
    # Deliberately misleading extension: the content determines the format.
    target = upload(client, response.content, "renamed.csv")
    meta = client.get(f"/api/v1/datasets/{target}").json()
    assert meta["format"] == "arrow"
    actual = datasets.store.get_dataframe(target).drop("__rowId__")
    expected = pl.read_ipc_stream(io.BytesIO(response.content))
    assert actual.equals(expected)
    assert len(set(datasets.store.get_dataframe(target)["__rowId__"])) == len(expected)


@pytest.mark.parametrize("raw", [b"\xff\xff\xff\xff", b"\xff\xff\xff\xff\x40\0\0\0bad", b"ARROW1bad"])
def test_malformed_arrow_returns_business_error(client, raw):
    response = client.post("/api/v1/datasets/import", files={"file": ("broken.bin", raw)})
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "IMPORT_MALFORMED_ARROW"
    assert response.json()["error"]["recoverable"] is True
    assert datasets.store.list_datasets() == []


@pytest.mark.parametrize("weight_type", ["survey", "frequency"])
def test_weighted_codebook_roundtrip_to_fresh_csv(client, weight_type):
    source, target = upload(client), upload(client)
    payload = configured_codebook(client, source, weight_type)
    before = codebook(client, target)
    source_ids = {c["columnId"] for c in payload["columns"]}
    target_ids = {c["name"]: c["columnId"] for c in before["columns"]}
    assert source_ids.isdisjoint(target_ids.values())
    response = import_codebook(client, target, payload)
    assert response.status_code == 200, response.text
    actual = codebook(client, target)
    assert actual["datasetId"] == target
    assert actual["schemaRevision"] == before["schemaRevision"] + 1
    assert actual["weightConfig"] == {"weightColumnId": target_ids["w"], "weightType": weight_type}
    assert actual["surveyDesign"] == {
        "weightColumnId": target_ids["w"], "strataColumnId": target_ids["stratum"],
        "psuColumnId": target_ids["psu"], "fpcColumnId": target_ids["fpc"],
        "replicateWeightColumnIds": [target_ids["rw2"], target_ids["rw1"]],
    }
    assert actual["multiResponseGroups"][0]["optionOrder"] == [target_ids["option_b"], target_ids["option_a"]]
    assert [{k: v for k, v in c.items() if k != "columnId"} for c in actual["columns"]] == [
        {k: v for k, v in c.items() if k != "columnId"} for c in payload["columns"]]
    assert codebook(client, source)["schemaRevision"] == payload["schemaRevision"]


def test_source_column_mapping_takes_precedence_over_target_id_collision(client):
    target = upload(client)
    ids = {c["name"]: c["columnId"] for c in codebook(client, target)["columns"]}
    payload = {"columns": [{"columnId": ids["answer"], "name": "w", "role": "weight"}],
               "weightConfig": {"weightColumnId": ids["answer"], "weightType": "survey"}}
    response = import_codebook(client, target, payload)
    assert response.status_code == 200, response.text
    assert codebook(client, target)["weightConfig"]["weightColumnId"] == ids["w"]


@pytest.mark.parametrize("field", ["weightConfig", "weightColumnId", "strataColumnId", "psuColumnId",
                                   "fpcColumnId", "replicateWeightColumnIds"])
def test_unknown_references_reject_atomically(client, field):
    target = upload(client)
    payload = configured_codebook(client, target)
    if field == "weightConfig":
        payload[field]["weightColumnId"] = "missing-column"
    elif field == "replicateWeightColumnIds":
        payload["surveyDesign"][field] = ["missing-column"]
    else:
        payload["surveyDesign"][field] = "missing-column"
    before = codebook(client, target)
    meta = client.get(f"/api/v1/datasets/{target}").json()
    response = import_codebook(client, target, payload)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "CODEBOOK_INVALID"
    assert codebook(client, target) == before
    assert client.get(f"/api/v1/datasets/{target}").json() == meta


def test_unmatched_source_name_cannot_fall_back_to_other_target_id(client):
    target = upload(client)
    before = codebook(client, target)
    existing_id = before["columns"][0]["columnId"]
    payload = {"columns": [{"name": "not-in-target", "columnId": existing_id, "label": "Wrong"},
                           {"name": "w", "role": "weight"}],
               "weightConfig": {"weightColumnId": existing_id, "weightType": "survey"}}
    response = import_codebook(client, target, payload)
    assert response.status_code == 422, response.text
    assert codebook(client, target) == before


@pytest.mark.parametrize("key,value", [
    ("weightConfig", []), ("weightConfig", {}), ("weightConfig", {"weightColumnId": []}),
    ("surveyDesign", []), ("surveyDesign", {"psuColumnId": []}),
    ("surveyDesign", {"replicateWeightColumnIds": "rw1"}),
])
def test_invalid_design_payload_returns_422_without_change(client, key, value):
    target = upload(client)
    payload = configured_codebook(client, target)
    payload[key] = value
    before = codebook(client, target)
    response = import_codebook(client, target, payload)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "CODEBOOK_INVALID"
    assert codebook(client, target) == before


def test_explicit_null_clears_weight_and_design(client):
    target = upload(client)
    payload = configured_codebook(client, target)
    payload.update(weightConfig=None, surveyDesign=None)
    response = import_codebook(client, target, payload)
    assert response.status_code == 200, response.text
    actual = codebook(client, target)
    assert actual.get("weightConfig") is None
    assert actual.get("surveyDesign") is None


def test_omitted_weight_and_design_keep_existing_configuration(client):
    target = upload(client)
    payload = configured_codebook(client, target)
    response = import_codebook(client, target, {"columns": [{"name": "answer", "label": "Updated"}]})
    assert response.status_code == 200, response.text
    actual = codebook(client, target)
    assert actual["weightConfig"] == payload["weightConfig"]
    assert actual["surveyDesign"] == payload["surveyDesign"]


@pytest.mark.parametrize("reference_kind", ["name", "target_id"])
def test_explicit_target_references_are_still_supported(client, reference_kind):
    target = upload(client)
    ids = {c["name"]: c["columnId"] for c in codebook(client, target)["columns"]}
    ref = lambda name: name if reference_kind == "name" else ids[name]
    payload = {"columns": [{"name": "w", "role": "weight"}],
               "weightConfig": {"weightColumnId": ref("w"), "weightType": "survey"},
               "surveyDesign": {"strataColumnId": ref("stratum"), "psuColumnId": ref("psu"),
                                "replicateWeightColumnIds": [ref("rw1")]}}
    response = import_codebook(client, target, payload)
    assert response.status_code == 200, response.text
    actual = codebook(client, target)
    assert actual["surveyDesign"]["weightColumnId"] == ids["w"]
    assert actual["surveyDesign"]["replicateWeightColumnIds"] == [ids["rw1"]]


@pytest.mark.parametrize("collision", ["name", "columnId"])
def test_duplicate_source_identifiers_are_rejected(client, collision):
    target = upload(client)
    before = codebook(client, target)
    definitions = [{"name": "answer", "columnId": "source-answer"},
                   {"name": "w", "columnId": "source-w"}]
    definitions[1][collision] = definitions[0][collision]
    response = import_codebook(client, target, {"columns": definitions})
    assert response.status_code == 422, response.text
    assert codebook(client, target) == before


def test_mismatched_weight_and_design_are_rejected(client):
    target = upload(client)
    payload = configured_codebook(client, target)
    payload["surveyDesign"]["weightColumnId"] = "rw1"
    before = codebook(client, target)
    response = import_codebook(client, target, payload)
    assert response.status_code == 422, response.text
    assert codebook(client, target) == before


def test_invalid_utf8_codebook_returns_business_error(client):
    target = upload(client)
    before = codebook(client, target)
    response = client.post(f"/api/v1/datasets/{target}/codebook/import",
                           files={"file": ("codebook.json", b"\xffbroken")})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "CODEBOOK_INVALID"
    assert codebook(client, target) == before
