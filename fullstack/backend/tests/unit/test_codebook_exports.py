import csv
import io
import polars as pl
import pytest
from app.api.exports import export, ExportRequest
from app.storage.dataset_store import DatasetStore
from app.domain.codebook import Codebook, CodebookColumn


def test_export_with_value_labels(tmp_path, monkeypatch):
    store = DatasetStore()
    ds_id = "test_export_labels"
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2"],
        "satisfaction": [1, 2],
        "gender": [1, 2],
    })
    meta = {
        "datasetId": ds_id,
        "name": "survey.csv",
        "fingerprint": "fp123",
        "schema": [
            {"name": "satisfaction", "semanticType": "categorical"},
            {"name": "gender", "semanticType": "categorical"},
        ],
    }
    store.save(ds_id, meta, df)

    codebook = Codebook(
        datasetId=ds_id,
        schemaRevision=1,
        columns=[
            CodebookColumn(
                columnId="col-sat",
                name="satisfaction",
                label="満足度",
                scaleType="ordinal",
                role="question",
                valueLabels={"1": "不満", "2": "満足"},
            ),
            CodebookColumn(
                columnId="col-gen",
                name="gender",
                label="性別",
                scaleType="nominal",
                role="attribute",
                valueLabels={"1": "男性", "2": "女性"},
            ),
        ]
    )
    store.save_codebook(ds_id, codebook)

    # 1. Export raw (useValueLabels=False)
    raw_req = ExportRequest(datasetId=ds_id, format="csv", useValueLabels=False)
    raw_res = export(raw_req)
    raw_content = raw_res.body.decode("utf-8-sig")
    reader = list(csv.reader(io.StringIO(raw_content)))
    assert reader[0] == ["satisfaction", "gender"]
    assert reader[1] == ["1", "1"]
    assert reader[2] == ["2", "2"]

    # 2. Export with value labels (useValueLabels=True)
    label_req = ExportRequest(datasetId=ds_id, format="csv", useValueLabels=True)
    label_res = export(label_req)
    label_content = label_res.body.decode("utf-8-sig")
    reader = list(csv.reader(io.StringIO(label_content)))
    assert reader[0] == ["satisfaction", "gender"]
    assert reader[1] == ["不満", "男性"]
    assert reader[2] == ["満足", "女性"]

    # Cleanup
    store.delete(ds_id)
