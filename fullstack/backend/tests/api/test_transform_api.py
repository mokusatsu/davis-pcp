"""API tests for dataset transform endpoints."""
from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_transform_nominal_and_binning_flow():
    # 1. Load built-in iris with unique name
    import uuid
    uniq_name = f"Iris (transform test {uuid.uuid4().hex[:6]})"
    res = client.post("/api/v1/datasets/import/sample", json={"name": uniq_name})
    assert res.status_code == 200
    dataset_id = res.json()["datasetId"]

    # 2. Preview binning on sepal_length_cm
    prev_res = client.post(
        f"/api/v1/datasets/{dataset_id}/transform/preview",
        json={"column": "sepal_length_cm", "method": "equal_width", "num_bins": 3},
    )
    assert prev_res.status_code == 200
    prev_data = prev_res.json()
    assert prev_data["count"] == 150
    assert len(prev_data["bins"]) == 3

    # 3. Apply binning
    bin_res = client.post(
        f"/api/v1/datasets/{dataset_id}/transform",
        json={
            "type": "binning",
            "source_column": "sepal_length_cm",
            "options": {"method": "equal_width", "num_bins": 3, "output_column_name": "sepal_len_bin3"},
        },
    )
    assert bin_res.status_code == 200
    bin_data = bin_res.json()
    assert "sepal_len_bin3" in bin_data["createdColumns"]
    col_names = [c["name"] for c in bin_data["schema"]]
    assert "sepal_len_bin3" in col_names

    # 4. Apply nominal to binary on species
    nom_res = client.post(
        f"/api/v1/datasets/{dataset_id}/transform",
        json={
            "type": "nominal_to_binary",
            "source_column": "species",
            "options": {"drop_first": False},
        },
    )
    assert nom_res.status_code == 200
    nom_data = nom_res.json()
    assert len(nom_data["createdColumns"]) == 3
    col_names_after = [c["name"] for c in nom_data["schema"]]
    for col in nom_data["createdColumns"]:
        assert col in col_names_after

    # 5. Delete one created column
    del_col = nom_data["createdColumns"][0]
    del_res = client.delete(f"/api/v1/datasets/{dataset_id}/columns/{del_col}")
    assert del_res.status_code == 200
    remaining = [c["name"] for c in del_res.json()["schema"]]
    assert del_col not in remaining
