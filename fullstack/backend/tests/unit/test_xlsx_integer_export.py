"""Excel's numeric cells cannot preserve integers beyond 15 decimal digits."""
import io
import zipfile
from xml.etree import ElementTree as ET

import polars as pl
import pytest

from app.api.exports import _build_xlsx_response
from app.domain.codebook_adapter import CodebookAdapter

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def cells(df, labels=None, adapter=None):
    payload = _build_xlsx_response(df, {name: df[name] for name in df.columns}, labels or {}, adapter)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    return root.findall("s:sheetData/s:row", NS)[1].findall("s:c", NS)


@pytest.mark.parametrize("value", [
    10**15, -(10**15), 10**15 + 1, -(10**15 + 1),
    2**53 - 1, 2**53, 2**53 + 1, -(2**53 + 1),
    2**63 - 1, -(2**63), 2**64 - 1,
])
def test_large_integer_cells_keep_exact_digits_as_text(value):
    dtype = pl.UInt64 if value > 2**63 - 1 else pl.Int64
    cell = cells(pl.DataFrame({"value": pl.Series([value], dtype=dtype)}))[0]
    assert cell.attrib["t"] == "inlineStr"
    assert cell.find("s:is/s:t", NS).text == str(value)


@pytest.mark.parametrize("value", [0, 1, -1, 10**15 - 1, -(10**15 - 1)])
def test_ordinary_integers_remain_numeric(value):
    cell = cells(pl.DataFrame({"value": [value]}))[0]
    assert cell.attrib["t"] == "n"
    assert cell.find("s:v", NS).text == str(value)


def test_value_label_mapping_takes_precedence_over_integer_guard():
    value = 2**53 + 1
    df = pl.DataFrame({"code": [value]})
    label_maps = {"code": {str(value): "回答ラベル"}}
    adapter = CodebookAdapter(df, {"columns": [{"name": "code", "valueLabels": label_maps["code"]}]})
    cell = cells(df, label_maps, adapter)[0]
    assert cell.attrib["t"] == "inlineStr"
    assert cell.find("s:is/s:t", NS).text == "回答ラベル"


def test_nulls_floats_and_booleans_keep_existing_representation():
    row = cells(pl.DataFrame({"null": [None], "float": [1.25], "bool": [True]}))
    assert row[0].attrib == {"r": "A2"}
    assert row[1].attrib["t"] == "n"
    assert row[1].find("s:v", NS).text == "1.25"
    assert row[2].attrib["t"] == "inlineStr"
    assert row[2].find("s:is/s:t", NS).text == "TRUE"


def test_export_endpoint_preserves_integer_text_and_scope(monkeypatch):
    from types import SimpleNamespace
    from app.api import exports

    df = pl.DataFrame({"__rowId__": ["r1", "r2", "r3"], "id": [2**53 + 1, -(2**63), 42]})
    monkeypatch.setattr(exports, "store", SimpleNamespace(
        get_dataframe=lambda _: df,
        get_meta=lambda _: {"name": "survey.csv"},
    ))
    response = exports.export(exports.ExportRequest(
        datasetId="integer-export", format="xlsx", scope="selected", rowIds=["r1", "r3"],
    ))
    with zipfile.ZipFile(io.BytesIO(response.body)) as archive:
        root = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))
    rows = root.findall("s:sheetData/s:row", NS)
    assert len(rows) == 3
    assert rows[0].find("s:c/s:is/s:t", NS).text == "id"
    assert rows[1].find("s:c/s:is/s:t", NS).text == str(2**53 + 1)
    assert rows[2].find("s:c/s:v", NS).text == "42"
    assert response.media_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def test_csv_export_large_integers_remains_unchanged(monkeypatch):
    import csv
    from types import SimpleNamespace
    from app.api import exports

    df = pl.DataFrame({"id": [2**53 + 1, -(2**63)]})
    monkeypatch.setattr(exports, "store", SimpleNamespace(
        get_dataframe=lambda _: df,
        get_meta=lambda _: {"name": "survey.csv"},
    ))
    response = exports.export(exports.ExportRequest(datasetId="integer-export", format="csv"))
    assert list(csv.reader(io.StringIO(response.body.decode("utf-8-sig")))) == [
        ["id"], [str(2**53 + 1)], [str(-(2**63))],
    ]
