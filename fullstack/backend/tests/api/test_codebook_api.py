from __future__ import annotations

import io
import json
import pytest
from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


@pytest.fixture
def sample_dataset():
    res = client.post("/api/v1/datasets/import/sample")
    assert res.status_code == 200
    meta = res.json()
    return meta["datasetId"]


def test_codebook_get_initial(sample_dataset):
    res = client.get(f"/api/v1/datasets/{sample_dataset}/codebook")
    assert res.status_code == 200
    cb = res.json()
    assert cb["datasetId"] == sample_dataset
    assert cb["schemaRevision"] >= 1
    assert "columns" in cb
    assert len(cb["columns"]) > 0

    # Iris has columns (sepal_length_cm, sepal_width_cm, petal_length_cm, petal_width_cm, species, petal_ratio)
    col_names = [c["name"] for c in cb["columns"]]
    assert "sepal_length_cm" in col_names
    assert "species" in col_names

    species_col = next(c for c in cb["columns"] if c["name"] == "species")
    assert species_col["scaleType"] in ("nominal", "ordinal", "categorical")


def test_codebook_partial_update(sample_dataset):
    get_res = client.get(f"/api/v1/datasets/{sample_dataset}/codebook")
    cb = get_res.json()
    col1 = cb["columns"][0]
    orig_label = col1["label"]

    update_payload = {
        "columns": [
            {
                "columnId": col1["columnId"],
                "label": "がく片の長さ (cm)",
                "isReversed": True,
                "missingCodes": ["99"],
            }
        ]
    }
    put_res = client.put(f"/api/v1/datasets/{sample_dataset}/codebook", json=update_payload)
    assert put_res.status_code == 200
    res_data = put_res.json()
    assert res_data["status"] == "success"
    assert res_data["schemaRevision"] == cb["schemaRevision"] + 1

    # Verify updated codebook
    get_res2 = client.get(f"/api/v1/datasets/{sample_dataset}/codebook")
    cb2 = get_res2.json()
    col1_updated = next(c for c in cb2["columns"] if c["columnId"] == col1["columnId"])
    assert col1_updated["label"] == "がく片の長さ (cm)"
    assert col1_updated["isReversed"] is True
    assert col1_updated["missingCodes"] == ["99"]

    # Other columns untouched
    other_col = cb2["columns"][1]
    assert other_col["label"] == cb["columns"][1]["label"]


def test_codebook_schema_revision_fingerprint(sample_dataset):
    meta1 = client.get(f"/api/v1/datasets/{sample_dataset}").json()
    fp1 = meta1["fingerprint"]

    cb = client.get(f"/api/v1/datasets/{sample_dataset}/codebook").json()
    col = cb["columns"][0]
    client.put(
        f"/api/v1/datasets/{sample_dataset}/codebook",
        json={"columns": [{"columnId": col["columnId"], "label": "New Fingerprint Test"}]},
    )

    meta2 = client.get(f"/api/v1/datasets/{sample_dataset}").json()
    fp2 = meta2["fingerprint"]
    assert fp1 != fp2
    assert meta2["schemaRevision"] > meta1.get("schemaRevision", 1)


def test_codebook_survives_imputation(sample_dataset):
    # Set a custom label
    cb = client.get(f"/api/v1/datasets/{sample_dataset}/codebook").json()
    col = cb["columns"][0]
    client.put(
        f"/api/v1/datasets/{sample_dataset}/codebook",
        json={"columns": [{"columnId": col["columnId"], "label": "Imputation Guard Label", "isReversed": True}]},
    )

    # Run in-place imputation
    imp_res = client.post(
        f"/api/v1/datasets/{sample_dataset}/impute",
        json={"columns": [col["name"]], "strategy": "mean", "inPlace": True},
    )
    assert imp_res.status_code == 200

    # Verify codebook preserved
    cb_after = client.get(f"/api/v1/datasets/{sample_dataset}/codebook").json()
    col_after = next(c for c in cb_after["columns"] if c["name"] == col["name"])
    assert col_after["label"] == "Imputation Guard Label"
    assert col_after["isReversed"] is True
    assert col_after["columnId"] == col["columnId"]


def test_codebook_survives_transformation(sample_dataset):
    # Set custom label on species
    cb = client.get(f"/api/v1/datasets/{sample_dataset}/codebook").json()
    col = next(c for c in cb["columns"] if c["name"] == "species")
    client.put(
        f"/api/v1/datasets/{sample_dataset}/codebook",
        json={"columns": [{"columnId": col["columnId"], "label": "品種ラベル"}]},
    )

    # Run binning transformation
    trans_res = client.post(
        f"/api/v1/datasets/{sample_dataset}/transform",
        json={
            "type": "binning",
            "source_column": "sepal_length_cm",
            "options": {"num_bins": 3, "output_column_name": "sepal_length_bin"},
        },
    )
    assert trans_res.status_code == 200

    # Verify original species label preserved and new column present
    cb_after = client.get(f"/api/v1/datasets/{sample_dataset}/codebook").json()
    species_after = next(c for c in cb_after["columns"] if c["name"] == "species")
    assert species_after["label"] == "品種ラベル"

    col_names = [c["name"] for c in cb_after["columns"]]
    assert "sepal_length_bin" in col_names


def test_codebook_csv_export_and_import(sample_dataset):
    export_res = client.get(f"/api/v1/datasets/{sample_dataset}/codebook/export?format=csv")
    assert export_res.status_code == 200
    assert "text/csv" in export_res.headers.get("content-type", "")
    csv_text = export_res.text
    assert "sepal_length_cm" in csv_text

    # Modify CSV and re-import
    lines = csv_text.splitlines()
    header = lines[0]
    # Replace label for sepal_length_cm
    new_lines = [header]
    for line in lines[1:]:
        if line.startswith("sepal_length_cm,"):
            parts = line.split(",", 2)
            parts[1] = "CSVインポートテスト"
            new_lines.append(",".join(parts))
        else:
            new_lines.append(line)
    modified_csv = "\n".join(new_lines)

    import_res = client.post(
        f"/api/v1/datasets/{sample_dataset}/codebook/import",
        files={"file": ("codebook.csv", modified_csv.encode("utf-8"), "text/csv")},
    )
    assert import_res.status_code == 200
    assert import_res.json()["status"] == "success"

    # Verify updated
    cb = client.get(f"/api/v1/datasets/{sample_dataset}/codebook").json()
    sl_col = next(c for c in cb["columns"] if c["name"] == "sepal_length_cm")
    assert sl_col["label"] == "CSVインポートテスト"


def test_codebook_json_export_and_import(sample_dataset):
    export_res = client.get(f"/api/v1/datasets/{sample_dataset}/codebook/export?format=json")
    assert export_res.status_code == 200
    cb_data = export_res.json()
    assert "columns" in cb_data

    # Modify species label
    species_col = next(c for c in cb_data["columns"] if c["name"] == "species")
    species_col["label"] = "JSONインポートテスト品種"

    import_res = client.post(
        f"/api/v1/datasets/{sample_dataset}/codebook/import",
        files={"file": ("codebook.json", json.dumps(cb_data).encode("utf-8"), "application/json")},
    )
    assert import_res.status_code == 200

    cb = client.get(f"/api/v1/datasets/{sample_dataset}/codebook").json()
    col = next(c for c in cb["columns"] if c["name"] == "species")
    assert col["label"] == "JSONインポートテスト品種"
