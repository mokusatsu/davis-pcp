"""Feature 21-W1/W2: weight resolver, candidates, and row-value validation."""
from __future__ import annotations

import pytest

from app.domain.survey_weight import (
    check_weights_valid,
    extract_weights,
    resolve_weight_column,
    weight_candidates,
    weighted_status,
)


def codebook():
    return {"columns": [
        {"columnId": "c-w", "name": "wt", "role": "weight", "scaleType": "ratio"},
        {"columnId": "c-n", "name": "num", "role": "question", "scaleType": "ratio"},
        {"columnId": "c-t", "name": "txt", "role": "weight", "scaleType": "text"},
        {"columnId": "c-m", "name": "m", "role": "weight", "scaleType": "nominal", "multiResponseGroup": "g"},
    ]}


def test_resolver_accepts_only_weight_role_numeric():
    cb = codebook()
    assert resolve_weight_column(cb, None) is None
    assert resolve_weight_column(cb, "wt")["columnId"] == "c-w"
    assert resolve_weight_column(cb, "c-w")["columnId"] == "c-w"
    with pytest.raises(Exception) as exc:
        resolve_weight_column(cb, "missing")
    assert exc.value.code == "WEIGHT_COLUMN_NOT_FOUND"
    for bad in ("num", "txt", "m"):
        with pytest.raises(Exception) as exc:
            resolve_weight_column(cb, bad)
        assert exc.value.code == "WEIGHT_ROLE_INVALID"


def test_candidates_exclude_non_weight_and_ma():
    assert [c["name"] for c in weight_candidates(codebook())] == ["wt"]


def test_row_values_null_missing_zero_allowed_invalid_422():
    import polars as pl

    frame = pl.DataFrame({"wt": ["1.0", "0.0", None, "nan", "-2.0", "x", "3"]})
    weights, missing, has_invalid = extract_weights(frame, "wt")
    assert weights[:3] == [1.0, 0.0, None] and missing == 1 and has_invalid is True
    with pytest.raises(Exception) as exc:
        check_weights_valid(weights, has_invalid)
    assert exc.value.code == "WEIGHT_VALUE_INVALID"
    clean, missing, has_invalid = extract_weights(pl.DataFrame({"wt": [1.0, 0.0, None]}), "wt")
    check_weights_valid(clean, has_invalid)
    assert (clean, missing) == ([1.0, 0.0, None], 1)


def test_weighted_status_never_falls_back():
    assert weighted_status(False, 0.0) == "omitted"
    assert weighted_status(True, 0.0) == "no_positive_weight"
    assert weighted_status(True, 2.5) == "applied"
