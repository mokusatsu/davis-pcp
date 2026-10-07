"""Assert the codebook CSV text policy, without evaluating spreadsheet formulas."""
from __future__ import annotations

import csv
import io
import json

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import datasets
from app.main import app
from app.storage.dataset_store import DatasetStore


FIELDS = [
    "name", "label", "scaleType", "role", "valueLabels", "categoryOrder", "missingCodes",
    "missingReasons", "isReversed", "multiResponseGroup", "multiResponseOptionLabel",
    "recordType", "licenseText",
]
QUOTED_TEXT = '出典, "公開調査" 🧪\n次の行\r\n 余白 '
PREFIXED_TEXTS = ["=1+1", "+1", "-1", "@text"] + [
    chr(code) + "=1+1" for code in [*range(0x21), 0x7f]
] + [
    " \tplain", "\rplain", "\nplain", " \x7f\t", "\t", "\r", "\n",
    " \x00@\ttext", " \x7f-2", "\x1f \x00+1",
]
UNCHANGED_TEXTS = [
    "", "ordinary", QUOTED_TEXT, "  普通の文字列", "'=1+1", "''=1+1", "'\t=1+1",
    '"=1+1"', "a=1+1", "a\n=1+1", "a\r=1+1", "a\t=1+1", "\x00plain",
    "\x1fplain", "\x7fplain", "\x00 \x7f", "\u0080=1+1", "\u0085=1+1",
    "\u00a0=1+1", "\u3000=1+1", "\ufeff=1+1",
]


@pytest.fixture
def dictionary(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, "store", store)
    with TestClient(app) as client:
        imported = client.post("/api/v1/datasets/import", files={
            "file": ("text-policy.csv", b"answer,other\n0,1\n1,0\n", "text/csv")})
        assert imported.status_code == 200, imported.text
        dataset_id = imported.json()["datasetId"]
        yield client, f"/api/v1/datasets/{dataset_id}/codebook", dataset_id, store


def _saved_text(dictionary, text):
    client, url, _, _ = dictionary
    current = client.get(url).json()
    column_id = current["columns"][0]["columnId"]
    saved = client.put(url, json={
        "expectedSchemaRevision": current["schemaRevision"],
        "expectedLicenseRevision": current["licenseRevision"],
        "licenseText": text,
        "columns": [{"columnId": column_id, "label": text, "multiResponseOptionLabel": text}],
    })
    assert saved.status_code == 200, saved.text
    return saved.json()["codebook"]


def _csv(client, url):
    exported = client.get(f"{url}/export?format=csv")
    assert exported.status_code == 200, exported.text
    reader = csv.DictReader(io.StringIO(exported.text, newline=""))
    rows = list(reader)
    assert reader.fieldnames == FIELDS
    assert [row["recordType"] for row in rows] == ["dataset", "column", "column"]
    assert all(len(row) == len(FIELDS) and None not in row for row in rows)
    return exported, rows


@pytest.mark.parametrize("text", PREFIXED_TEXTS)
def test_csv_prefixes_policy_text_in_labels_options_and_license_without_mutating(dictionary, text):
    client, url, dataset_id, store = dictionary
    saved = _saved_text(dictionary, text)
    meta = store.get_meta(dataset_id)
    data = store.get_dataframe(dataset_id)
    original_json = client.get(f"{url}/export?format=json").content
    first, rows = _csv(client, url)
    assert rows[0]["licenseText"] == "'" + text
    assert rows[1]["label"] == "'" + text
    assert rows[1]["multiResponseOptionLabel"] == "'" + text
    assert rows[0]["name"] == ""
    assert all(row["licenseText"] == "" for row in rows[1:])
    assert client.get(f"{url}/export?format=csv").content == first.content
    assert client.get(f"{url}/export?format=json").content == original_json
    assert json.loads(original_json) == saved
    assert store.load_codebook(dataset_id) == saved
    assert store.get_meta(dataset_id) == meta
    assert store.get_dataframe(dataset_id).equals(data)


@pytest.mark.parametrize("text", UNCHANGED_TEXTS)
def test_csv_preserves_ordinary_text_apostrophes_and_explicit_policy_boundaries(dictionary, text):
    client, url, _, _ = dictionary
    _saved_text(dictionary, text)
    _, rows = _csv(client, url)
    assert rows[0]["licenseText"] == text
    assert rows[1]["label"] == text
    assert rows[1]["multiResponseOptionLabel"] == text


def test_csv_prefixes_names_and_group_text_but_keeps_json_cells_intact(dictionary):
    client, _, _, store = dictionary
    names = ["=1+1", " \t@name", "'=literal", '名前, "引用"\n改行']
    data = pl.DataFrame({name: [0, 1] for name in names})
    upload = io.BytesIO()
    data.write_parquet(upload)
    imported = client.post("/api/v1/datasets/import", files={
        "file": ("named.parquet", upload.getvalue(), "application/octet-stream")})
    assert imported.status_code == 200, imported.text
    dataset_id = imported.json()["datasetId"]
    url = f"/api/v1/datasets/{dataset_id}/codebook"
    original = client.get(url).json()
    assert [column["name"] for column in original["columns"]] == names
    group = " \x7f@group"
    definitions = {"valueLabels": {"0": "=1+1", "1": "+1"}, "categoryOrder": ["0", "1"],
                   "missingCodes": ["-99"], "missingReasons": {"-99": "@reason"}}
    saved = client.put(url, json={"columns": [
        {"columnId": original["columns"][0]["columnId"], "scaleType": "nominal",
         "multiResponseGroup": group, **definitions}],
        "multiResponseGroups": [{"groupId": group, "label": "=parent question"}],
    })
    assert saved.status_code == 200, saved.text
    exported = client.get(f"{url}/export?format=csv")
    assert exported.status_code == 200, exported.text
    rows = list(csv.DictReader(io.StringIO(exported.text, newline="")))
    assert [row["name"] for row in rows[1:]] == ["'=1+1", "' \t@name", "'=literal", names[3]]
    assert rows[1]["multiResponseGroup"] == "'" + group
    for key, value in definitions.items():
        assert json.loads(rows[1][key]) == value
    assert "multiResponseGroups" not in rows[0]
    assert "weightConfig" not in rows[0]
    assert "surveyDesign" not in rows[0]
    assert "binDefinitions" not in rows[0]
    exact = client.get(f"{url}/export?format=json").json()
    assert exact == store.load_codebook(dataset_id)
    assert exact["multiResponseGroups"][0]["label"] == "=parent question"
    assert [column["name"] for column in exact["columns"]] == names
    assert store.get_dataframe(dataset_id).drop("__rowId__").equals(data)


@pytest.mark.parametrize("text", ["=1+1", " \t@text", "'=literal", QUOTED_TEXT])
def test_json_remains_exact_interchange_for_text_that_csv_may_change(dictionary, text):
    client, url, _, store = dictionary
    source = _saved_text(dictionary, text)
    exported = client.get(f"{url}/export?format=json")
    assert exported.status_code == 200, exported.text
    assert exported.json() == source
    _saved_text(dictionary, "replacement")
    imported = client.post(f"{url}/import", files={
        "file": ("exact.json", exported.content, "application/json")})
    assert imported.status_code == 200, imported.text
    current = client.get(url).json()
    assert current["columns"] == source["columns"]
    assert current["licenseText"] == text
    assert store.load_codebook(current["datasetId"])["columns"] == source["columns"]


@pytest.mark.parametrize("text", [QUOTED_TEXT, "'=1+1", "'\t=literal"])
def test_csv_roundtrip_preserves_ordinary_text_and_does_not_strip_literal_apostrophes(dictionary, text):
    client, url, _, _ = dictionary
    saved = _saved_text(dictionary, text)
    exported, _ = _csv(client, url)
    _saved_text(dictionary, "replacement")
    imported = client.post(f"{url}/import", files={
        "file": ("literal.csv", exported.content, "text/csv")})
    assert imported.status_code == 200, imported.text
    current = client.get(url).json()
    assert current["columns"] == saved["columns"]
    assert current["licenseText"] == text
    assert client.get(f"{url}/export?format=csv").content == exported.content


def test_csv_import_keeps_the_added_apostrophe_instead_of_inventing_a_lossless_roundtrip(dictionary):
    client, url, _, _ = dictionary
    _saved_text(dictionary, "=1+1")
    exported, _ = _csv(client, url)
    imported = client.post(f"{url}/import", files={
        "file": ("prefixed.csv", exported.content, "text/csv")})
    assert imported.status_code == 200, imported.text
    current = client.get(url).json()
    assert current["licenseText"] == "'=1+1"
    assert current["columns"][0]["label"] == "'=1+1"
    assert current["columns"][0]["multiResponseOptionLabel"] == "'=1+1"
    assert client.get(f"{url}/export?format=csv").content == exported.content
