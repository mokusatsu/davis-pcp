"""SpreadsheetML text must remain valid XML and preserve exact input strings."""
import io
import re
import zipfile
from xml.etree import ElementTree as ET

import polars as pl
import pytest

from app.api.exports import _build_xlsx_response
from app.domain.codebook_adapter import CodebookAdapter

NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
XML_SPACE = '{http://www.w3.org/XML/1998/namespace}space'
TEXT_CASES = [
    *[f'before{chr(code)}after' for code in range(32)],
    'before\ufffeafter', 'before\uffffafter',
    '_x0000_', '_x000B_', '_x000b_', '_x005F_', '_x005f_x0000_',
    '_x0000_x000B_', 'ordinary_under_score', ' leading and trailing ',
    '日本語 😀 & < > "', '\r\n\t', '=SUM(A1:A2)', '',
]


def sheet_texts(df, label_maps=None, adapter=None):
    payload = _build_xlsx_response(df, {name: df[name] for name in df.columns}, label_maps or {}, adapter)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        # All package XML parts must be readable, not merely ZIP-valid.
        for name in archive.namelist():
            ET.fromstring(archive.read(name))
        root = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
    return root.findall('.//s:t', NS)


def decode_xstring(value):
    # Single-pass ST_Xstring decoding: a protected literal escape must not be
    # decoded a second time. This is deliberately independent of the encoder.
    return re.sub(r'_x([0-9A-Fa-f]{4})_', lambda m: chr(int(m[1], 16)), value or '')


@pytest.mark.parametrize('value', TEXT_CASES)
def test_raw_cells_preserve_xml_and_spreadsheet_text(value):
    texts = sheet_texts(pl.DataFrame({'text': [value]}))
    assert decode_xstring(texts[1].text) == value
    assert texts[1].get(XML_SPACE) == 'preserve'


@pytest.mark.parametrize('value', [v for v in TEXT_CASES if v])
def test_column_headers_use_same_text_contract(value):
    texts = sheet_texts(pl.DataFrame({value: ['ok']}))
    assert decode_xstring(texts[0].text) == value
    assert texts[0].get(XML_SPACE) == 'preserve'


@pytest.mark.parametrize('label', TEXT_CASES)
def test_value_labels_use_same_text_contract(label):
    df = pl.DataFrame({'code': [1]})
    adapter = CodebookAdapter(df, {'columns': [{'name': 'code', 'valueLabels': {'1': label}}]})
    texts = sheet_texts(df, {'code': {'1': label}}, adapter)
    assert decode_xstring(texts[1].text) == label
