"""Arrow's file and stream encodings share an import contract, not a reader."""
from __future__ import annotations

import io

import polars as pl
import pyarrow as pa
import pyarrow.feather as feather
import pyarrow.ipc as ipc
import pytest

from app.services.import_service import detect_format, load_dataframe_from_upload


@pytest.mark.parametrize("encoding", ["stream", "file", "feather-lz4", "feather-zstd"])
@pytest.mark.parametrize("empty", [False, True])
def test_arrow_encodings_preserve_values_types_and_nulls(encoding, empty):
    frame = pl.DataFrame({"number": [1.5, None, 3.5], "code": ["001", "002", None],
                          "日本語": ["はい", None, "いいえ"], "integer": [1, 2, 3]})
    if empty:
        frame = frame.head(0)
    table = frame.to_arrow()
    buffer = io.BytesIO()
    if encoding.startswith("feather"):
        feather.write_feather(table, buffer, version=2, compression=encoding.split("-")[1])
    else:
        writer = ipc.new_stream if encoding == "stream" else ipc.new_file
        with writer(buffer, table.schema) as stream:
            stream.write_table(table, max_chunksize=1)
    raw = buffer.getvalue()
    assert detect_format("renamed.csv", raw) == "arrow"
    actual, fmt = load_dataframe_from_upload("renamed.csv", raw)
    assert fmt == "arrow"
    assert actual.schema == frame.schema
    assert actual.equals(frame)


def test_csv_named_arrow_remains_text():
    actual, fmt = load_dataframe_from_upload("text.arrow", b"name,value\nA,1\n")
    assert fmt == "csv"
    assert actual.to_dict(as_series=False) == {"name": ["A"], "value": [1]}


def test_arrow_stream_with_dictionary_batches():
    table = pa.table({"category": pa.array(["A", "B", None, "A"]).dictionary_encode()})
    buffer = io.BytesIO()
    with ipc.new_stream(buffer, table.schema) as stream:
        stream.write_table(table, max_chunksize=2)
    actual, fmt = load_dataframe_from_upload("data.bin", buffer.getvalue())
    assert fmt == "arrow"
    assert actual["category"].to_list() == ["A", "B", None, "A"]
