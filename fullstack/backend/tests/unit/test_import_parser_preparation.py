"""Import token settings are per-import, while cell semantics stay unchanged."""
from __future__ import annotations

import math
from pathlib import Path
import sys

import polars as pl
import pytest

BACKEND = Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.services import import_service  # noqa: E402
from app.services.dataset_service import ImportOptions  # noqa: E402


@pytest.mark.parametrize("token, expected", [
    ("", None), ("  ", None), ("n/A", None), ("NuLl", None),
    ("NaN", None), ("?", None), (".", None),
    ("001", "001"), ("+001", "+001"), ("-001", "-001"),
    ("0e3", "0e3"), ("01.2", "01.2"),
    ("0", 0), ("-0", 0), (" 42 ", 42), ("0.5", 0.5),
    ("-1.25", -1.25), ("1e3", 1000.0), ("1_000", 1000),
    ("9007199254740993", 9007199254740993),
    ("9223372036854775808", 9223372036854775808),
    ("Inf", float("inf")), ("-inf", float("-inf")),
    (" a,b ", "a,b"), ("日本語", "日本語"),
])
def test_prepared_default_parser_preserves_value_and_type(token, expected):
    actual = import_service._make_value_parser()(token)
    assert type(actual) is type(expected)
    assert actual == expected


def test_default_options_and_absent_options_keep_distinct_nan_policy():
    # ImportOptions' defaults deliberately omit NaN, unlike MISSING_TOKENS.
    assert import_service._make_value_parser()("NaN") is None
    assert math.isnan(import_service._make_value_parser(ImportOptions())("NaN"))


@pytest.mark.parametrize("fmt, delimiter", [("csv", ","), ("tsv", "\t")])
def test_repeated_imports_do_not_reuse_other_imports_settings(fmt, delimiter):
    raw = (f"label{delimiter}value\nMiSs{delimiter}1\nNA{delimiter}2\n").encode()
    options = ImportOptions(missingTokens=["MISS"])
    first = import_service.read_delimited(raw, fmt, options)
    assert first["label"].to_list() == [None, "NA"]

    options.missingTokens = []
    second = import_service.read_delimited(raw, fmt, options)
    assert second["label"].to_list() == ["MiSs", "NA"]

    third = import_service.read_delimited(raw, fmt)
    assert third["label"].to_list() == ["MiSs", None]
    assert first["value"].dtype == second["value"].dtype == third["value"].dtype == pl.Int64


def test_decimal_settings_and_empty_missing_tokens_are_per_import():
    raw = b'code;value;text\n001;0,5;\n-001;-2,5;NA\n'
    options = ImportOptions(delimiter=";", decimalSeparator=",", missingTokens=[])
    frame = import_service.read_delimited(raw, "csv", options)
    assert frame.to_dict(as_series=False) == {
        "code": ["001", "-001"], "value": [0.5, -2.5], "text": ["", "NA"],
    }
    options.decimalSeparator = "."
    frame = import_service.read_delimited(raw, "csv", options)
    assert frame["value"].to_list() == ["0,5", "-2,5"]


@pytest.mark.parametrize("fmt", ["csv", "tsv", "arff"])
def test_missing_token_normalization_is_constant_per_import(monkeypatch, fmt):
    class CountedToken(str):
        lower_calls = 0

        def lower(self):
            type(self).lower_calls += 1
            return super().lower()

    # Count actual invariant work rather than assert a wall-clock threshold.
    monkeypatch.setattr(import_service, "MISSING_TOKENS", {CountedToken("MISS")})
    delimiter = "\t" if fmt == "tsv" else ","
    header = "@RELATION test\n@ATTRIBUTE a REAL\n@ATTRIBUTE b REAL\n@DATA\n" if fmt == "arff" else f"a{delimiter}b\n"
    raw = (header + f"1{delimiter}miss\n" * 500).encode()
    frame, detected = import_service.load_dataframe_from_upload(f"data.{fmt}", raw)
    assert detected == fmt
    assert frame.shape == (500, 2)
    assert frame["a"].to_list() == [1] * 500
    assert frame["b"].to_list() == [None] * 500
    assert CountedToken.lower_calls == 1


def test_custom_missing_token_normalization_is_constant_per_import():
    class CountedToken(str):
        lower_calls = 0

        def lower(self):
            type(self).lower_calls += 1
            return super().lower()

    options = ImportOptions()
    options.missingTokens = [CountedToken("MISS"), CountedToken("EMPTY")]
    raw = b"a,b\n" + b"miss,empty\n" * 500
    frame = import_service.read_delimited(raw, "csv", options)
    assert frame.null_count().row(0) == (500, 500)
    assert CountedToken.lower_calls == 2


def test_arff_keeps_default_policy_independent_of_upload_options():
    raw = b"@RELATION test\n@ATTRIBUTE a REAL\n@ATTRIBUTE b STRING\n@DATA\n?,001\n2.5,NA\n"
    frame, fmt = import_service.load_dataframe_from_upload(
        "data.arff", raw, ImportOptions(missingTokens=[], decimalSeparator=","),
    )
    assert fmt == "arff"
    assert frame.to_dict(as_series=False) == {"a": [None, 2.5], "b": ["001", None]}
