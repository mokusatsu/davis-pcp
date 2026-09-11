"""IMPUTE-03 / E04: an imputation is a plan, not two different computations.

The audit found that preview imputed one column while apply imputed the whole
selection, and that a target was its own only predictor.  These tests pin the
plan contract: explicit targets, explicit predictors, a target can never be a
predictor, and predictors actually condition the generated values.
"""
from __future__ import annotations

import numpy as np
import polars as pl
import pytest

from app.algorithms.imputation.core import impute_dataframe, preview_imputation_plan
from app.algorithms.imputation.plan import (
    build_imputation_plan,
    compute_plan_hash,
)
from app.domain.errors import BizError


def _codebook(columns: list[dict]) -> dict:
    return {"columns": columns, "multiResponseGroups": []}


def _frame() -> pl.DataFrame:
    return pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3", "r4"],
        "x": [1.0, 2.0, 3.0, 4.0],
        "y": [1.0, None, 3.0, None],
        "cat": ["a", "b", None, "a"],
        "ma1": [1, 0, 1, 0],
        "w": [1.0, 2.0, 1.0, 2.0],
    })


def test_default_predictors_exclude_targets_row_id_ma_and_weight():
    df = _frame()
    cb = _codebook([
        {"name": "x", "columnId": "c-x", "role": "explanatory"},
        {"name": "y", "columnId": "c-y", "role": "explanatory"},
        {"name": "cat", "columnId": "c-cat", "role": "explanatory"},
        {"name": "ma1", "columnId": "c-ma1", "role": "explanatory", "multiResponseGroup": "g1"},
        {"name": "w", "columnId": "c-w", "role": "weight"},
    ])
    plan = build_imputation_plan(df, cb, ["y"], None, "tabdiff", {"seed": 1},
                                 dataset_id="ds1", data_revision=3)
    assert plan.targetColumns == ["y"]
    # cat is numeric-ineligible, ma1 is a group member, w is a design weight.
    assert plan.predictorColumns == ["x"]
    reasons = {e.column: e.reason for e in plan.excludedColumns}
    assert reasons["cat"] == "PREDICTOR_CATEGORICAL_IGNORED"
    assert reasons["ma1"] == "PREDICTOR_MULTI_RESPONSE_EXCLUDED"
    assert reasons["w"] == "PREDICTOR_WEIGHT_EXCLUDED"


def test_target_cannot_be_its_own_predictor():
    df = _frame()
    with pytest.raises(BizError) as excinfo:
        build_imputation_plan(df, None, ["y"], ["x", "y"], "tabdiff", None,
                              dataset_id="ds1", data_revision=1)
    assert excinfo.value.code == "IMPUTATION_SELF_PREDICTOR"
    assert excinfo.value.status_code == 422


def test_unknown_predictor_is_rejected():
    df = _frame()
    with pytest.raises(BizError) as excinfo:
        build_imputation_plan(df, None, ["y"], ["nope"], "tabdiff", None,
                              dataset_id="ds1", data_revision=1)
    assert excinfo.value.code == "IMPUTATION_PREDICTOR_NOT_FOUND"


def test_plan_hash_covers_revision_targets_predictors_and_seed():
    base = compute_plan_hash("ds1", 1, ["y"], ["x"], "tabdiff", {"seed": 7}, 7)
    assert base == compute_plan_hash("ds1", 1, ["y"], ["x"], "tabdiff", {"seed": 7}, 7)
    assert base != compute_plan_hash("ds1", 2, ["y"], ["x"], "tabdiff", {"seed": 7}, 7)
    assert base != compute_plan_hash("ds1", 1, ["x"], ["y"], "tabdiff", {"seed": 7}, 7)
    assert base != compute_plan_hash("ds1", 1, ["y"], ["x"], "tabdiff", {"seed": 8}, 8)


def test_plan_hash_is_independent_of_column_listing_order():
    df = _frame()
    a = build_imputation_plan(df, None, ["y", "cat"], ["x"], "tabdiff", None,
                              dataset_id="ds1", data_revision=1)
    b = build_imputation_plan(df, None, ["cat", "y"], ["x"], "tabdiff", None,
                              dataset_id="ds1", data_revision=1)
    assert a.planHash == b.planHash
    assert a.targetColumns == ["y", "cat"]  # dataset column order


def test_predictors_condition_the_generated_values():
    """y = 2x + noise with x fully observed: conditioning on x must beat the
    marginal fit by a wide margin."""
    rng = np.random.default_rng(7)
    n = 200
    x = rng.uniform(0.0, 10.0, n)
    y = 2.0 * x + rng.normal(0.0, 0.2, n)
    missing_index = rng.choice(n, size=40, replace=False)
    y_missing = y.copy()
    y_missing[missing_index] = np.nan
    df = pl.DataFrame({"__rowId__": [f"r{i}" for i in range(n)], "x": x, "y": y_missing})

    with_predictor, diag = impute_dataframe(
        df, columns=["y"], strategy="tabdiff", options={"num_steps": 10, "seed": 5},
        predictors=["x"])
    without, _ = impute_dataframe(
        df, columns=["y"], strategy="tabdiff", options={"num_steps": 10, "seed": 5},
        predictors=[])

    truth = y[missing_index]
    rmse_with = float(np.sqrt(np.mean((with_predictor["y"].to_numpy()[missing_index] - truth) ** 2)))
    rmse_without = float(np.sqrt(np.mean((without["y"].to_numpy()[missing_index] - truth) ** 2)))
    assert rmse_with < rmse_without / 2
    # A predictor is conditioning only: it keeps its own values.
    assert with_predictor["x"].to_list() == df["x"].to_list()
    assert diag["conditioningColumns"] == ["x", "y"]
    assert diag["predictorColumns"] == ["x"]
    assert diag["outputColumns"] == ["y"]


def test_preview_imputes_every_target_in_one_pass():
    df = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3", "r4"],
        "x": [1.0, 2.0, 3.0, 4.0],
        "y": [1.0, None, 3.0, None],
        "z": [2.0, 4.0, None, 8.0],
    })
    plan = build_imputation_plan(df, None, ["y", "z"], ["x"], "tabdiff",
                                 {"num_steps": 5, "seed": 3}, dataset_id="ds1", data_revision=1)
    result = preview_imputation_plan(df, plan)
    assert [c["column"] for c in result["perColumn"]] == ["y", "z"]
    assert result["planHash"] == plan.planHash
    assert all(c["afterStats"]["missingCount"] == 0 for c in result["perColumn"])
    # Legacy single-column shape is still present for older clients.
    assert result["column"] == "y"
    assert result["beforeStats"]["missingCount"] == 2
