"""Unit tests for Feature 01: Automatic Subgroup Mining."""
import pytest
import numpy as np
import polars as pl
from fastapi.testclient import TestClient

from app.algorithms.mining.subgroup import (
    benjamini_hochberg,
    get_cramers_v_thresholds,
    label_effect,
    run_subgroup_mining,
)
from app.main import app


def test_benjamini_hochberg():
    # Known p-value vector
    pvals = [0.001, 0.01, 0.04, 0.20, 0.80]
    qvals, rej = benjamini_hochberg(pvals, alpha=0.05)
    
    assert len(qvals) == 5
    assert len(rej) == 5
    # q-values must be non-decreasing with sorted p-values
    assert qvals[0] <= qvals[1] <= qvals[2]
    # Check monotonicity and boundedness
    for q in qvals:
        assert 0.0 <= q <= 1.0
    assert rej[0] is True
    assert rej[-1] is False


def test_cramers_v_thresholds():
    small, med, large = get_cramers_v_thresholds(1)
    assert (small, med, large) == (0.10, 0.30, 0.50)

    small2, med2, large2 = get_cramers_v_thresholds(2)
    assert (small2, med2, large2) == (0.07, 0.21, 0.35)

    assert label_effect(0.55, small, med, large) == "large"
    assert label_effect(0.35, small, med, large) == "medium"
    assert label_effect(0.15, small, med, large) == "small"
    assert label_effect(0.02, small, med, large) == "negligible"


def test_subgroup_mining_numeric_embedded_signal():
    np.random.seed(42)
    n = 200
    # Create dataset where segment B has much higher satisfaction
    segments = ["SegA"] * 100 + ["SegB"] * 100
    satisfaction = list(np.random.normal(3.0, 0.5, 100)) + list(np.random.normal(5.0, 0.5, 100))
    noise = list(np.random.normal(10.0, 2.0, 200))
    
    df = pl.DataFrame({
        "__rowId__": [f"row_{i}" for i in range(n)],
        "segment": segments,
        "satisfaction": satisfaction,
        "noise": noise,
    })

    res = run_subgroup_mining(
        df=df,
        attribute_cols=["segment"],
        question_cols=["satisfaction", "noise"],
        alpha=0.05,
        min_group_size=20,
    )

    assert res["summary"]["n_tests_run"] == 2
    assert len(res["insights"]) >= 1
    top_insight = res["insights"][0]
    assert top_insight["subgroup"]["name"] == "segment"
    assert top_insight["question"]["name"] == "satisfaction"
    assert top_insight["test"]["significant"] is True
    assert top_insight["effect"]["measure"] == "cohens_d"
    assert top_insight["effect"]["label"] == "large"
    assert top_insight["direction"]["highest_group"] == "SegB"
    assert len(top_insight["row_ids"]["highest_group"]) == 100


def test_subgroup_mining_categorical_chi2():
    # Segment vs Preference
    segments = ["A"] * 50 + ["B"] * 50
    pref = ["Apple"] * 45 + ["Banana"] * 5 + ["Apple"] * 10 + ["Banana"] * 40
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(100)],
        "segment": segments,
        "pref": pref,
    })

    res = run_subgroup_mining(
        df=df,
        attribute_cols=["segment"],
        question_cols=["pref"],
        min_group_size=10,
    )

    assert len(res["insights"]) == 1
    ins = res["insights"][0]
    assert ins["test"]["method"] == "chi2_contingency"
    assert ins["effect"]["measure"] == "cramers_v"
    assert ins["contingency"] is not None
    assert "residuals" in ins["contingency"]


def test_subgroup_mining_multiclass_anova():
    np.random.seed(123)
    # 3 groups: G1, G2, G3
    grps = ["G1"] * 40 + ["G2"] * 40 + ["G3"] * 40
    score = list(np.random.normal(2.0, 0.4, 40)) + list(np.random.normal(3.5, 0.4, 40)) + list(np.random.normal(5.0, 0.4, 40))
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(120)],
        "group": grps,
        "score": score,
    })

    res = run_subgroup_mining(
        df=df,
        attribute_cols=["group"],
        question_cols=["score"],
        min_group_size=10,
    )

    assert len(res["insights"]) >= 1
    ins = res["insights"][0]
    assert ins["test"]["method"] == "welch_anova"
    assert ins["effect"]["measure"] == "eta_sq"
    assert len(ins["posthoc"]) == 3  # (G1,G2), (G1,G3), (G2,G3)


def test_subgroup_mining_edge_cases():
    # Small size, empty, or constant columns
    df = pl.DataFrame({
        "__rowId__": ["1", "2", "3", "4"],
        "const": ["X", "X", "X", "X"],
        "attr": ["A", "A", "B", "B"],
        "const_num": [1.0, 1.0, 1.0, 1.0],
    })

    res = run_subgroup_mining(
        df=df,
        attribute_cols=["const", "attr"],
        question_cols=["const_num"],
        min_group_size=1,
    )
    # Shouldn't crash
    assert "insights" in res


def test_subgroup_mining_delta_vs_overall():
    # Verify accurate delta vs overall mean and by-group row IDs
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(20)],
        "grp": ["A"] * 10 + ["B"] * 10,
        "score": [1.0] * 10 + [5.0] * 10,
    })
    res = run_subgroup_mining(
        df=df,
        attribute_cols=["grp"],
        question_cols=["score"],
        min_group_size=5,
    )
    assert len(res["insights"]) >= 1
    ins = res["insights"][0]
    direction = ins["direction"]
    assert direction["highest_group"] == "B"
    assert direction["lowest_group"] == "A"
    assert direction["delta"] == 4.0  # 5.0 - 1.0
    assert direction["delta_vs_overall"] == 2.0  # 5.0 - 3.0
    assert "all_by_group" in ins["row_ids"]
    assert len(ins["row_ids"]["all_by_group"]["A"]) == 10
    assert len(ins["row_ids"]["all_by_group"]["B"]) == 10
