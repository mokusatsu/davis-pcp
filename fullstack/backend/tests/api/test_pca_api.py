"""API tests for PCA endpoint."""
from __future__ import annotations

import uuid
from fastapi.testclient import TestClient

from app.main import app
from app.api import models

client = TestClient(app)


def test_pca_api_iris(monkeypatch):
    uniq_name = f"Iris (PCA test {uuid.uuid4().hex[:6]})"
    res = client.post("/api/v1/datasets/import/sample", json={"name": uniq_name})
    assert res.status_code == 200
    dataset_id = res.json()["datasetId"]

    cols = ["sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm"]
    pca_res = client.post(
        "/api/v1/models/pca",
        json={
            "datasetId": dataset_id,
            "columns": cols,
            "useCorrelation": True,
            "nComponents": 4,
        },
    )
    assert pca_res.status_code == 200
    data = pca_res.json()
    assert data["nSamples"] == 150
    assert data["nComponents"] == 4
    assert len(data["eigenvalues"]) == 4
    assert len(data["scores"]) == 150
    assert "loadings" in data
    assert "sepal_length_cm" in data["loadings"]
    assert data['usedColumns'] == cols
    assert data['usedRows'] == 150
    meta = models.store.get_meta(dataset_id)
    cb = models.store.load_codebook(dataset_id)
    for column in cb['columns']:
        if column['name'] in cols[:2]:
            column.update(multiResponseGroup='q', scaleType='nominal')
    cb['multiResponseGroups'] = [{'groupId': 'q', 'selectedCodes': ['1'], 'unselectedCodes': ['0']}]
    cb['schemaRevision'] = meta['schemaRevision'] = 2
    models.store.save_metadata(dataset_id, meta, cb)
    read = models.store.get_dataframe
    projections = []
    def tracked(dataset_id, columns=None):
        projections.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(models.store, 'get_dataframe', tracked)
    default = client.post('/api/v1/models/pca', json={'datasetId': dataset_id})
    assert default.status_code == 200
    assert default.json()['usedColumns'] == cols[2:]
    assert projections == [['__rowId__', *cols[2:]]]
    for extra, code in [({'columns': []}, 'PCA_INSUFFICIENT_COLUMNS'),
                        ({'columns': cols}, 'MA_METHOD_UNSUPPORTED'),
                        ({'rowIds': []}, 'PCA_INSUFFICIENT_ROWS'),
                        ({'expectedSchemaRevision': 1}, 'ANALYSIS_INPUT_STALE')]:
        response = client.post('/api/v1/models/pca', json={'datasetId': dataset_id, **extra})
        assert response.json()['error']['code'] == code
