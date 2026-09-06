"""Import matrix tests: formats, encodings, edge cases, row identity."""
from __future__ import annotations

import io
import sqlite3
import sys
from pathlib import Path

import polars as pl
import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.domain.errors import BizError  # noqa: E402
from app.services.import_service import (  # noqa: E402
    build_builtin_iris,
    detect_format,
    load_dataframe_from_upload,
    parse_arff,
    read_delimited,
)
from app.storage.dataset_store import assign_row_identity, canonical_fingerprint, values_fingerprint  # noqa: E402
from app.services.dataset_service import ColumnRole, ImportOptions  # noqa: E402
from app.services.import_service import probe_table  # noqa: E402


class TestFormatDetection:
    def test_parquet_by_magic_not_extension(self):
        assert detect_format("data.txt", b"PAR1" + b"x" * 100) == "parquet"
        assert detect_format("data.txt", b"x" * 100 + b"PAR1") == "parquet"

    def test_arrow_by_magic(self):
        assert detect_format("f.bin", b"ARROW1\0" + b"x" * 50) == "arrow"

    def test_sqlite_header(self):
        assert detect_format("x.db", b"SQLite format 3\x00" + b"\0" * 90) == "sqlite"

    def test_arff_content(self):
        assert detect_format("x.txt", b"@RELATION test\n@ATTRIBUTE a numeric\n") == "arff"

    def test_tsv_content(self):
        assert detect_format("x.dat", b"a\tb\tc\n1\t2\t3\n") == "tsv"

    def test_csv_default(self):
        assert detect_format("x.csv", b"a,b\n1,2\n") == "csv"


class TestDelimited:
    def test_utf8_csv(self):
        df = read_delimited("a,b\n1,2.5\n".encode(), "csv")
        assert df.height == 1 and df["a"][0] == 1

    def test_bom_csv(self):
        df = read_delimited(b"\xef\xbb\xbfa,b\n7,8\n", "csv")
        assert df.columns[0] == "a"

    def test_shift_jis_csv(self):
        raw = "列A,列B\n1,2\n".encode("shift_jis")
        df = read_delimited(raw, "csv")
        assert df.columns[0] == "列A"

    def test_quoted_delimiter(self):
        df = read_delimited('a,b\n"x,y",3\n'.encode(), "csv")
        assert df["a"][0] == "x,y"

    def test_duplicate_column_names(self):
        df = read_delimited("a,a\n1,2\n".encode(), "csv")
        assert df.columns == ["a", "a_1"]

    def test_missing_header(self):
        df = read_delimited("1,2\n3,4\n".encode(), "csv", ImportOptions(hasHeader=False))
        assert df.columns == ["col_0", "col_1"]

    def test_empty_file_raises(self):
        with pytest.raises(BizError) as exc:
            read_delimited(b"", "csv")
        assert exc.value.code == "IMPORT_EMPTY_FILE"

    def test_malformed_row_raises(self):
        with pytest.raises(BizError) as exc:
            read_delimited(b"a,b\n1,2\n3\n", "csv")
        assert exc.value.code == "IMPORT_MALFORMED_ROW"

    def test_constant_column(self):
        df = read_delimited(b"a,b\n1,5\n2,5\n3,5\n", "csv")
        schemas = probe_table(df, df.height)
        const_schema = next(s for s in schemas if s.name == "b")
        assert const_schema.constant is True

    def test_all_missing_column(self):
        df = read_delimited(b"a,b\n1,\n2,\n", "csv")
        schema = next(s for s in probe_table(df, df.height) if s.name == "b")
        assert schema.missingCount == 2
        assert schema.semanticType == "ignored"
        assert schema.role == ColumnRole.IGNORED

    def test_high_cardinality_category(self):
        rows = "\n".join(f"k{i},cat{i % 97}" for i in range(500))
        df = read_delimited(f"a,c\n{rows}\n".encode(), "csv")
        schemas = probe_table(df, df.height)
        cat = next(s for s in schemas if s.name == "c")
        assert cat.semanticType == "categorical"


class TestArff:
    ARFF = """
% comment
@RELATION test
@ATTRIBUTE sepallength REAL
@ATTRIBUTE class {setosa,versicolor,virginica}
@DATA
5.1,setosa
4.9,'versicolor'
?,virginica
"""

    def test_parse(self):
        names, rows, types = parse_arff(self.ARFF)
        assert names == ["sepallength", "class"]
        assert len(rows) == 3
        assert rows[1] == ["4.9", "versicolor"]
        assert rows[2][0] == "?"


class TestRowIdentity:
    def test_user_specified_id_column_wins(self):
        df = pl.DataFrame({"myid": ["a", "b"], "v": [1.0, 2.0]})
        out, source = assign_row_identity(df, "myid", [])
        assert out["__rowId__"].to_list() == ["a", "b"]
        assert source == "column:myid"

    def test_non_unique_rejected(self):
        df = pl.DataFrame({"myid": ["a", "a"], "v": [1.0, 2.0]})
        with pytest.raises(BizError) as exc:
            assign_row_identity(df, "myid", [])
        assert exc.value.code == "ROW_ID_NOT_UNIQUE"

    def test_generated_ids_are_immutable_ordinals(self):
        df = pl.DataFrame({"v": [3.0, 1.0, 2.0]})
        out, source = assign_row_identity(df, None, [])
        assert out["__rowId__"].to_list() == ["ROW-000001", "ROW-000002", "ROW-000003"]
        # After sorting the rowIds travel with their rows.
        sorted_df = out.sort("v")
        assert sorted_df["__rowId__"].to_list() == ["ROW-000002", "ROW-000003", "ROW-000001"]


class TestFingerprint:
    def test_deterministic(self):
        df = pl.DataFrame({"v": [1.0, 2.0]})
        h1 = values_fingerprint(df)
        h2 = values_fingerprint(pl.DataFrame({"v": [1.0, 2.0]}))
        assert h1 == h2

    def test_value_change_changes_hash(self):
        h1 = values_fingerprint(pl.DataFrame({"v": [1.0, 2.0]}))
        h2 = values_fingerprint(pl.DataFrame({"v": [1.0, 3.0]}))
        assert h1 != h2

    def test_row_order_matters(self):
        h1 = values_fingerprint(pl.DataFrame({"v": [1.0, 2.0]}))
        h2 = values_fingerprint(pl.DataFrame({"v": [2.0, 1.0]}))
        assert h1 != h2

    def test_null_representable(self):
        h1 = values_fingerprint(pl.DataFrame({"v": [None, 2.0]}, schema={"v": pl.Float64}))
        h2 = values_fingerprint(pl.DataFrame({"v": [None, 2.0]}, schema={"v": pl.Float64}))
        assert h1 == h2

    def test_canonical_fingerprint_combines_inputs(self):
        base = canonical_fingerprint("schema", ["r1"], "vh", "{}")
        assert canonical_fingerprint("schema", ["r1"], "vh", "{}") == base
        assert canonical_fingerprint("schema2", ["r1"], "vh", "{}") != base


class TestBuiltinIris:
    def test_150_rows_with_id_column(self):
        df = build_builtin_iris()
        assert df.height == 150
        assert df["id"][0] == "IRIS-001"
        assert df["id"][-1] == "IRIS-150"
