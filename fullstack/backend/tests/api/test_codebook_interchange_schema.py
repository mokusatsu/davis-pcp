"""The authoring schema accepts actual exports and supported file-import forms."""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from app.api import datasets
from app.main import app
from app.storage.dataset_store import DatasetStore


SCHEMA_PATH = Path(__file__).resolve().parents[4] / "template" / "codebook.schema.json"
SCHEMA = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
VALIDATOR = Draft202012Validator(SCHEMA)
LICENSE = '出典, "公開調査"\n再配布条件'


@pytest.fixture
def survey(tmp_path, monkeypatch):
    monkeypatch.setattr(datasets, "store", DatasetStore(tmp_path))
    with TestClient(app) as client:
        uploaded = client.post("/api/v1/datasets/import", files={"file": (
            "survey.csv", b"answer,w,stratum,psu,fpc,rw1,rw2,option_a,option_b\n"
            b"1,0.5,A,P1,20,0.4,0.6,1,0\n2,2.5,B,P2,30,2.4,2.6,0,1\n")})
        assert uploaded.status_code == 200, uploaded.text
        url = f'/api/v1/datasets/{uploaded.json()["datasetId"]}/codebook'
        initial = client.get(url).json()
        ids = {column["name"]: column["columnId"] for column in initial["columns"]}
        yield client, url, ids


def configure(survey, weight_type="survey"):
    client, url, ids = survey
    response = client.put(url, json={
        "licenseText": LICENSE,
        "columns": [
            {"columnId": ids["w"], "role": "weight"},
            {"columnId": ids["option_a"], "scaleType": "nominal", "multiResponseGroup": "options",
             "multiResponseOptionLabel": "選択肢A"},
            {"columnId": ids["option_b"], "scaleType": "nominal", "multiResponseGroup": "options",
             "multiResponseOptionLabel": "選択肢B"},
        ],
        "multiResponseGroups": [{"groupId": "options", "label": "複数回答",
                                 "selectedCodes": ["1"], "unselectedCodes": ["0"],
                                 "allUnselectedMeaning": "notApplicable", "maxSelections": 2,
                                 "optionOrder": [ids["option_b"], ids["option_a"]]}],
        "weightConfig": {"weightColumnId": ids["w"], "weightType": weight_type},
        "surveyDesign": {"weightColumnId": ids["w"], "strataColumnId": ids["stratum"],
                         "psuColumnId": ids["psu"], "fpcColumnId": ids["fpc"],
                         "replicateWeightColumnIds": [ids["rw2"], ids["rw1"]]},
    })
    assert response.status_code == 200, response.text


def import_json(survey, payload):
    client, url, _ = survey
    return client.post(f"{url}/import", files={"file": (
        "dictionary.json", json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json")})


def test_authoring_schema_is_valid_draft_2020_12():
    Draft202012Validator.check_schema(SCHEMA)


@pytest.mark.parametrize("weight_type", [None, "survey", "frequency"])
def test_schema_accepts_real_json_export_and_reimport(survey, weight_type):
    client, url, ids = survey
    if weight_type:
        configure(survey, weight_type)
    response = client.get(f"{url}/export?format=json")
    assert response.status_code == 200, response.text
    exported = response.json()
    VALIDATOR.validate(exported)
    assert all("multiResponseOptionLabel" in column for column in exported["columns"])
    assert exported["licenseRevision"] >= 1
    if weight_type:
        assert exported["licenseText"] == LICENSE
        assert exported["weightConfig"]["weightType"] == weight_type
        assert exported["surveyDesign"]["replicateWeightColumnIds"] == [ids["rw2"], ids["rw1"]]
        assert exported["multiResponseGroups"][0]["maxSelections"] == 2
    imported = import_json(survey, exported)
    assert imported.status_code == 200, imported.text
    current = client.get(url).json()
    assert current["columns"] == exported["columns"]
    for field in ("licenseText", "multiResponseGroups", "weightConfig", "surveyDesign"):
        assert current.get(field) == exported.get(field)


@pytest.mark.parametrize("payload", [
    {"columns": [{"name": "answer", "label": "回答"}]},
    [{"name": "answer", "label": ""}],
    {"columns": [{"name": "answer", "valueLabels": {}, "categoryOrder": [], "missingCodes": []}]},
    {"licenseText": ""},
    {"columns": [{"name": "option_a", "multiResponseGroup": None, "multiResponseOptionLabel": ""}]},
    {"columns": [{"name": "answer"}], "weightConfig": None, "surveyDesign": None},
    {"multiResponseGroups": [{"groupId": "options", "label": "選択肢順",
                              "optionOrderNames": ["option_a", "option_b"]}]},
    {"columns": [{"name": "w"}], "weightConfig": {"weightColumnId": "w", "weightType": "frequency"},
     "surveyDesign": {"weightColumnId": None, "strataColumnId": None,
                      "psuColumnId": None, "fpcColumnId": None, "replicateWeightColumnIds": []}},
])
def test_schema_partial_examples_are_accepted_by_file_import(survey, payload):
    configure(survey)
    VALIDATOR.validate(payload)
    response = import_json(survey, payload)
    assert response.status_code == 200, response.text


def test_identifier_only_partial_and_supplied_name_precedence(survey):
    client, url, ids = survey
    by_id = [{"columnId": ids["answer"], "label": "IDで更新"}]
    VALIDATOR.validate(by_id)
    assert import_json(survey, by_id).status_code == 200
    # The name is authoritative even when the source ID is another local column.
    by_name = {"columns": [{"name": "w", "columnId": ids["answer"], "label": "名前で更新"}]}
    VALIDATOR.validate(by_name)
    assert import_json(survey, by_name).status_code == 200
    labels = {column["name"]: column["label"] for column in client.get(url).json()["columns"]}
    assert labels["answer"] == "IDで更新"
    assert labels["w"] == "名前で更新"


@pytest.mark.parametrize("payload", [
    {"columns": [{"name": "answer", "scaleType": "numeric"}]},
    {"columns": [{"name": "answer", "role": "measure"}]},
    {"columns": [{"name": "answer", "valueLabels": {"1": 1}}]},
    {"columns": [{"name": "answer", "missingCodes": [99]}]},
    {"columns": [{"name": "answer", "multiResponseOptionLabel": 1}]},
    {"licenseText": None},
    {"columns": [{"name": "w"}], "weightConfig": {"weightColumnId": "w", "weightType": "analytic"}},
    {"columns": [{"name": "w"}], "weightConfig": {"weightColumnId": "w"}},
    {"columns": [{"name": "w"}], "surveyDesign": {"replicateWeightColumnIds": "rw1"}},
    {"multiResponseGroups": [{"groupId": "options", "label": "A", "maxSelections": 0}]},
    {"multiResponseGroups": [{"groupId": "options", "label": "A", "maxSelections": True}]},
    {"multiResponseGroups": [{"groupId": "options", "label": "A", "selectedCodes": []}]},
    {"multiResponseGroups": [{"groupId": "options", "label": "A", "unselectedCodes": ["0", "0"]}]},
    {"multiResponseGroups": [{"groupId": "options", "label": "A", "allUnselectedMeaning": "invalid"}]},
    {"multiResponseGroups": [{"groupId": "options", "label": "A", "optionOrder": [], "optionOrderNames": []}]},
    {"weightConfig": None},
    {"surveyDesign": None},
])
def test_invalid_types_and_unsupported_standalone_forms_reject_without_saving(survey, payload):
    configure(survey)
    client, url, _ = survey
    before = client.get(url).json()
    assert not VALIDATOR.is_valid(payload)
    response = import_json(survey, payload)
    assert response.status_code == 422, response.text
    assert client.get(url).json() == before


@pytest.mark.parametrize("payload", [
    {"columns": [], "unexpected": True},
    {"columns": [{"name": "answer", "unexpected": True}]},
    {"licenseText": "", "schemaRevision": 0},
    {"licenseText": "", "licenseRevision": "1"},
    {"columns": [{"name": "answer", "label": None}]},
    {"multiResponseGroups": [{"groupId": "options", "label": "A", "unexpected": True}]},
    {"columns": [], "weightConfig": {"weightColumnId": "w", "weightType": "survey", "unexpected": True}},
    {"columns": [], "surveyDesign": {"unexpected": True}},
])
def test_authoring_schema_rejects_unknown_fields_and_ambiguous_inputs(payload):
    # Authoring validation is deliberately stricter than parser coercions/ignored fields.
    assert not VALIDATOR.is_valid(payload)


def test_csv_export_contains_column_dictionary_and_license_but_not_parent_or_design(survey):
    configure(survey)
    client, url, _ = survey
    exported = client.get(f"{url}/export?format=csv")
    assert exported.status_code == 200, exported.text
    reader = csv.DictReader(io.StringIO(exported.text))
    rows = list(reader)
    assert reader.fieldnames == [
        "name", "label", "scaleType", "role", "valueLabels", "categoryOrder", "missingCodes",
        "missingReasons", "isReversed", "multiResponseGroup", "multiResponseOptionLabel", "recordType", "licenseText",
    ]
    assert rows[0]["recordType"] == "dataset"
    assert rows[0]["name"] == ""
    assert rows[0]["licenseText"] == LICENSE
    columns = {row["name"]: row for row in rows[1:]}
    assert len(columns) == 9
    assert columns["option_a"]["multiResponseGroup"] == "options"
    assert columns["option_a"]["multiResponseOptionLabel"] == "選択肢A"
    assert columns["w"]["role"] == "weight"
    for field in ("multiResponseGroups", "selectedCodes", "maxSelections", "weightConfig", "weightType", "surveyDesign"):
        assert field not in reader.fieldnames
