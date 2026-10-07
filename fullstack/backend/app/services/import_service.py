"""Content-based import probe and canonical dataset creation.

Formats: CSV, TSV, Parquet, Arrow IPC/Feather, ARFF, SQLite table,
built-in Iris sample. The extension is never trusted; content is inspected.
"""
from __future__ import annotations

import csv
import io
import json
import re
import sqlite3
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from ..config import settings
from ..domain.errors import BizError
from .dataset_service import ColumnRole, ColumnSchema, ImportOptions, new_id

MISSING_TOKENS = {"", "NA", "N/A", "null", "NULL", "?", ".", "NaN", "nan"}


def _sniff_encoding(raw: bytes) -> str:
    if raw.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return "utf-16"
    try:
        raw.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        pass
    try:
        raw.decode("cp932")
        return "cp932"
    except UnicodeDecodeError:
        pass
    try:
        raw.decode("shift_jis")
        return "shift_jis"
    except UnicodeDecodeError:
        pass
    return "latin-1"


_MAGIC_PARQUET = b"PAR1"
_ARROW_STREAM_CONTINUATION = b"\xff\xff\xff\xff"


def detect_format(filename: str, head: bytes) -> str:
    """Content-based format detection. Extension is only a hint."""
    if head[:4] == _MAGIC_PARQUET or head[-4:] == _MAGIC_PARQUET:
        return "parquet"
    if head[:6] in (b"ARROW1", b"ARROW:") or head.startswith(_ARROW_STREAM_CONTINUATION):
        return "arrow"
    if b"SQLite format 3\x00" in head[:100]:
        return "sqlite"
    text_head = head[:4096].lstrip()
    if text_head.upper().startswith(b"@RELATION") or text_head.upper().startswith(b"@ATTRIBUTE"):
        return "arff"
    lowered = filename.lower()
    if lowered.endswith(".tsv"):
        return "tsv"
    if lowered.endswith(".csv"):
        return "csv"
    # Content sniff for delimited text.
    first_line = text_head.split(b"\n", 1)[0]
    tabs = first_line.count(b"\t")
    commas = first_line.count(b",")
    if tabs > commas and tabs > 0:
        return "tsv"
    return "csv"


def parse_arff(text: str) -> tuple[list[str], list[list[str]], dict[str, str]]:
    """Minimal ARFF parser: returns names, string rows, declared types."""
    names: list[str] = []
    types: dict[str, str] = {}
    rows: list[list[str]] = []
    in_data = False
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("%"):
            continue
        upper = stripped.upper()
        if not in_data:
            if upper.startswith("@ATTRIBUTE"):
                match = re.match(r"@ATTRIBUTE\s+(?:'([^']+)'|\"([^\"]+)\"|(\S+))\s+(\S+)", stripped, re.I)
                if match:
                    name = next(g for g in match.groups()[:3] if g is not None)
                    names.append(name)
                    types[name] = match.group(4).strip().lower()
            elif upper.startswith("@DATA"):
                in_data = True
            continue
        if stripped.startswith("{"):
            # Sparse format: {index value, ...}
            cells = [""] * len(names)
            for pair in stripped.strip("{}").split(","):
                idx_s, _, value = pair.partition(" ")
                if idx_s.strip():
                    cells[int(idx_s)] = value.strip().strip("'\"")
            rows.append(cells)
        else:
            rows.append([cell.strip().strip("'\"") for cell in _split_arff_line(stripped)])
    return names, rows, types


def _split_arff_line(line: str) -> list[str]:
    fields: list[str] = []
    current: list[str] = []
    quote: str | None = None
    for char in line:
        if quote:
            current.append(char)
            if char == quote:
                quote = None
        elif char in "'\"":
            quote = char
            current.append(char)
        elif char == ",":
            fields.append("".join(current))
            current = []
        else:
            current.append(char)
    fields.append("".join(current))
    return fields


def _parse_value(token: str, options: ImportOptions | None = None) -> Any:
    token = token.strip()
    missing_tokens = set(options.missingTokens) if (options and options.missingTokens is not None) else MISSING_TOKENS
    missing_lower = {t.lower() for t in missing_tokens}
    if token in missing_tokens or token.lower() in missing_lower:
        return None

    dec_sep = options.decimalSeparator if options and options.decimalSeparator else "."
    check_val = token[1:] if token.startswith("-") or token.startswith("+") else token
    # Preserve leading zeros as strings (codes like "001", "01"), except "0", "0.xxx", "0,xxx"
    if check_val.startswith("0") and len(check_val) > 1 and not check_val.startswith(f"0{dec_sep}"):
        return token

    num_token = token
    if dec_sep != ".":
        num_token = token.replace(dec_sep, ".")

    try:
        return int(num_token)
    except ValueError:
        pass
    try:
        return float(num_token)
    except ValueError:
        return token


def probe_table(
    columns_data: dict[str, pl.Series],
    row_count: int,
) -> list[ColumnSchema]:
    schemas: list[ColumnSchema] = []
    for name in columns_data.columns:
        series = columns_data[name]
        missing = int(series.null_count())
        non_null = series.drop_nulls()
        unique = int(non_null.n_unique()) if len(non_null) else 0
        dtype = series.dtype
        if dtype.is_numeric() if hasattr(dtype, "is_numeric") else dtype in (
            pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64,
            pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64,
        ):
            if len(non_null) == 0:
                physical = "float" if dtype.is_float() else "int"
                semantic = "ignored"
                min_v = None
                max_v = None
                categories = None
            else:
                physical = "float" if dtype.is_float() else "int"
                semantic = "numeric"
                if len(non_null):
                    raw_min = non_null.min()
                    raw_max = non_null.max()
                    min_v = int(raw_min) if physical == "int" else float(raw_min)
                    max_v = int(raw_max) if physical == "int" else float(raw_max)
                else:
                    min_v = None
                    max_v = None
                categories = None
        else:
            physical = "string"
            # Type inference must not depend on row order. Inspect the whole
            # column, but do not materialize another full Python list.
            numeric_like = 0
            leading_zero_codes = False
            for value in non_null:
                token = str(value)
                numeric_like += _try_float(token) is not None
                if (len(token) > 1 and token[0] == "0"
                        and token[1:].isdigit()
                        and not token.startswith("0.") and "," not in token):
                    leading_zero_codes = True
            if len(non_null) == 0:
                semantic = "ignored"
            elif leading_zero_codes:
                # Leading-zero numeric strings ("001") are codes, not
                # quantities: keep them categorical so they default to
                # nominal instead of ratio (AV05).
                semantic = "categorical"
            elif numeric_like / len(non_null) > 0.95:
                semantic = "numeric"
            else:
                semantic = "categorical"
            min_v = None
            max_v = None
            # Bounded display candidates come from the whole column, not the
            # first 200 rows. They are not an exhaustive validation domain.
            categories = [str(v) for v in non_null.unique().sort().head(100).to_list()] if semantic == "categorical" else None
        schemas.append(ColumnSchema(
            columnId=new_id("col"),
            name=name,
            physicalType=physical,
            semanticType=semantic,
            role=ColumnRole.IGNORED if semantic == "ignored" else (ColumnRole.NUMERIC_AXIS if semantic == "numeric" else ColumnRole.CATEGORICAL_AXIS),
            missingCount=missing,
            uniqueCount=unique,
            min=min_v,
            max=max_v,
            categories=categories,
            constant=unique <= 1 and len(non_null) > 0,
            uniqueIdCandidate=unique == row_count and missing == 0,
        ))
    return schemas


def _try_float(value: str) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def read_delimited(raw: bytes, fmt: str, options: ImportOptions | None = None) -> pl.DataFrame:
    encoding = _sniff_encoding(raw) if not (options and options.encoding != "utf-8") else options.encoding
    text = raw.decode(encoding, errors="replace")
    delimiter = "\t" if fmt == "tsv" else ","
    if options and options.delimiter:
        delimiter = options.delimiter
    has_header = options.hasHeader if options else True
    quotechar = options.quote if (options and options.quote) else '"'
    reader = csv.reader(io.StringIO(text), delimiter=delimiter, quotechar=quotechar)
    # csv.reader emits [] for a physical blank line. Explicit empty fields
    # still form a record and must survive missing-value parsing and row IDs.
    rows = [row for row in reader if row]
    if not rows:
        raise BizError("IMPORT_EMPTY_FILE", "ファイルにデータ行がありません。",
                       suggested_actions=["内容を確認してください"])
    header = rows[0]
    data_rows = rows[1:] if has_header else rows
    if not has_header:
        width = len(rows[0])
        header = [f"col_{i}" for i in range(width)]
    # Duplicate column names get suffixes without colliding with existing headers
    raw_names = [name.strip().strip('"').strip("'") or "column" for name in header]
    existing_names = set(raw_names)
    allocated: set[str] = set()
    final_header = []
    for idx, name in enumerate(raw_names):
        if name not in allocated:
            cand = name
        else:
            count = 1
            cand = f"{name}_{count}"
            while cand in allocated or cand in existing_names:
                count += 1
                cand = f"{name}_{count}"
        allocated.add(cand)
        final_header.append(cand)

    width = len(final_header)
    normalized = []
    for row in data_rows:
        if len(row) != width:
            raise BizError(
                "IMPORT_MALFORMED_ROW",
                f"行の列数が不正です（{len(row)}列、期待値{width}列）。",
                details={"row": row[:5]},
                suggested_actions=["引用符や区切り文字を確認してください"],
            )
        normalized.append([_parse_value(cell, options=options) for cell in row])
    series_list = []
    for i, name in enumerate(final_header):
        col_vals = [row[i] for row in normalized]
        is_num = all(isinstance(v, (int, float)) or v is None for v in col_vals)
        is_int = (
            is_num
            and any(isinstance(v, int) and not isinstance(v, bool) for v in col_vals)
            and all((isinstance(v, int) and not isinstance(v, bool)) or v is None for v in col_vals)
        )
        if is_int:
            non_null_ints = [v for v in col_vals if v is not None]
            min_int = min(non_null_ints)
            max_int = max(non_null_ints)
            if -9223372036854775808 <= min_int and max_int <= 9223372036854775807:
                dtype = pl.Int64
            else:
                dtype = pl.String
        elif is_num:
            dtype = pl.Float64
        else:
            dtype = pl.String
        series_list.append(pl.Series(name, col_vals, dtype=dtype, strict=False))
    return pl.DataFrame(series_list)



def load_dataframe_from_upload(filename: str, raw: bytes, options: ImportOptions | None = None) -> tuple[pl.DataFrame, str]:
    fmt = detect_format(filename, raw[:1024] + raw[-16:])
    if fmt == "parquet":
        try:
            try:
                df = pl.read_parquet(io.BytesIO(raw))
            except Exception:
                import pyarrow.parquet as pq
                df = pl.from_arrow(pq.read_table(io.BytesIO(raw)))
        except Exception as exc:
            raise BizError("IMPORT_MALFORMED_PARQUET", "Parquetファイルを読み込めませんでした。",
                           details={"reason": str(exc)[:200]},
                           suggested_actions=["ファイルが壊れていないか確認してください"]) from exc
    elif fmt == "arrow":
        try:
            # IPC streams (including our own exports) use the continuation
            # marker, while IPC files / Feather V2 use the ARROW1 magic.
            # Keep malformed binary content on the Arrow error path rather
            # than retrying it as text and reporting a misleading CSV error.
            if raw.startswith(_ARROW_STREAM_CONTINUATION):
                df = pl.read_ipc_stream(io.BytesIO(raw))
            else:
                df = pl.read_ipc(io.BytesIO(raw))
        except Exception as exc:
            raise BizError("IMPORT_MALFORMED_ARROW", "Arrow IPCファイルを読み込めませんでした。",
                           details={"reason": str(exc)[:200]},
                           suggested_actions=["Feather V2 / Arrow IPC形式で保存してください"]) from exc
    elif fmt == "arff":
        encoding = _sniff_encoding(raw)
        names, rows, _types = parse_arff(raw.decode(encoding, errors="replace"))
        parsed = [[_parse_value(c) for c in row] for row in rows]
        columns = {}
        for i, name in enumerate(names):
            col_vals = [row[i] if i < len(row) else None for row in parsed]
            is_num = all(isinstance(v, (int, float)) or v is None for v in col_vals)
            is_int = (
                is_num
                and any(isinstance(v, int) and not isinstance(v, bool) for v in col_vals)
                and all((isinstance(v, int) and not isinstance(v, bool)) or v is None for v in col_vals)
            )
            if is_int:
                non_null_ints = [v for v in col_vals if v is not None]
                min_int = min(non_null_ints)
                max_int = max(non_null_ints)
                if -9223372036854775808 <= min_int and max_int <= 9223372036854775807:
                    dtype = pl.Int64
                else:
                    dtype = pl.String
            elif is_num:
                dtype = pl.Float64
            else:
                dtype = pl.String
            columns[name] = pl.Series(name, col_vals, dtype=dtype)
        df = pl.DataFrame(columns)
        fmt = "arff"
    elif fmt == "tsv":
        df = read_delimited(raw, "tsv", options)
    elif fmt == "csv":
        df = read_delimited(raw, "csv", options)
    else:
        raise BizError("IMPORT_UNSUPPORTED_FORMAT", f"形式 {fmt} はupload経由では対応していません。",
                       suggested_actions=["CSV、TSV、Parquet、Arrow、ARFFのいずれかを使用してください"])
    return df, fmt


def load_sqlite_table(raw: bytes, table_name: str) -> pl.DataFrame:
    con = sqlite3.connect(":memory:")
    con.execute("PRAGMA enable_load_extension = OFF")
    try:
        con.deserialize(raw)
        identifier = table_name.replace('"', '""')
        rows = con.execute(f'SELECT * FROM "{identifier}"').fetchall()
        cursor = con.execute(f'SELECT * FROM "{identifier}" LIMIT 0')
        names = [d[0] for d in cursor.description]
    finally:
        con.close()
    if not rows:
        raise BizError("IMPORT_EMPTY_TABLE", f"テーブル {table_name} は空です。")
    columns = {}
    for i, name in enumerate(names):
        vals = [r[i] for r in rows]
        is_num = all(isinstance(v, (int, float)) or v is None for v in vals)
        columns[name] = pl.Series(name, vals, dtype=pl.Float64 if is_num else pl.String)
    return pl.DataFrame(columns)


def sqlite_tables(raw: bytes) -> list[str]:
    con = sqlite3.connect(":memory:")
    try:
        con.deserialize(raw)
        result = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        return [row[0] for row in result]
    finally:
        con.close()


def build_builtin_iris() -> pl.DataFrame:
    candidates = [
        Path(__file__).resolve().parents[3] / "fixtures" / "iris_fixture.json",
        Path(__file__).resolve().parents[2] / "fixtures" / "iris_fixture.json",
        Path(__file__).resolve().parents[1] / "fixtures" / "iris_fixture.json",
        Path("/fixtures/iris_fixture.json"),
        Path("/app/fixtures/iris_fixture.json"),
        Path("/_iris_fixture.json"),
        Path("/app/_iris_fixture.json"),
    ]
    fixture_path = next((p for p in candidates if p.exists()), None)
    if fixture_path:
        rows = json.loads(fixture_path.read_text(encoding="utf-8"))
        return pl.DataFrame({
            "id": pl.Series([r["id"] for r in rows], dtype=pl.String),
            "sepal_length_cm": pl.Series([float(r["sepalLength"]) for r in rows], dtype=pl.Float64),
            "sepal_width_cm": pl.Series([float(r["sepalWidth"]) for r in rows], dtype=pl.Float64),
            "petal_length_cm": pl.Series([float(r["petalLength"]) for r in rows], dtype=pl.Float64),
            "petal_width_cm": pl.Series([float(r["petalWidth"]) for r in rows], dtype=pl.Float64),
            "species": pl.Series([r["species"] for r in rows], dtype=pl.String),
        })

    # Built-in fallback via scikit-learn
    from sklearn.datasets import load_iris
    raw = load_iris(as_frame=True)
    target_names = list(raw.target_names)
    n = len(raw.target)
    return pl.DataFrame({
        "id": pl.Series([f"iris_{i+1:03d}" for i in range(n)], dtype=pl.String),
        "sepal_length_cm": pl.Series(raw.data["sepal length (cm)"].to_list(), dtype=pl.Float64),
        "sepal_width_cm": pl.Series(raw.data["sepal width (cm)"].to_list(), dtype=pl.Float64),
        "petal_length_cm": pl.Series(raw.data["petal length (cm)"].to_list(), dtype=pl.Float64),
        "petal_width_cm": pl.Series(raw.data["petal width (cm)"].to_list(), dtype=pl.Float64),
        "species": pl.Series([target_names[t] for t in raw.target], dtype=pl.String),
    })


def enforce_limits(df: pl.DataFrame) -> None:
    if df.height > settings.max_rows:
        raise BizError("IMPORT_ROW_LIMIT", f"行数が上限({settings.max_rows})を超えています。",
                       details={"rows": df.height}, recoverable=False)
    if df.width > settings.max_columns:
        raise BizError("IMPORT_COLUMN_LIMIT", f"列数が上限({settings.max_columns})を超えています。",
                       details={"columns": df.width}, recoverable=False)
