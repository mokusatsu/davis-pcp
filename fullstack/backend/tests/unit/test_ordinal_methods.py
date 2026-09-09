"""Feature 22-O1/O2: method selection, Kendall b, ranks, subgroup/surprise contracts."""
from __future__ import annotations

import polars as pl

from app.algorithms.relationships.surprise import compute_phik_and_surprise
from app.algorithms.summaries.core import question_summary
from app.domain.ordinal_methods import (
    cliffs_delta,
    epsilon_squared,
    kendall_tb,
    method_family,
    ordinal_ranks,
    select_method,
)


def test_scale_type_is_sole_method_source():
    assert select_method("two_group", "ordinal")["methodUsed"] == "mann_whitney_u"
    assert select_method("two_group", "nominal")["methodUsed"] == "chi_squared"
    assert select_method("two_group", "ratio")["methodUsed"] == "welch_t"
    assert select_method("multi_group", "ordinal")["methodUsed"] == "kruskal_wallis"
    assert select_method("correlation", "ordinal")["methodUsed"] == "kendall_tb"
    assert select_method("correlation", "interval")["methodUsed"] == "pearson_r"
    assert method_family(None) == "nominal"


def test_kendall_tb_null_safe_not_zero():
    ok = kendall_tb([1, 2, 3, 4], [1, 2, 3, 4])
    assert ok["tau"] == 1.0 and ok["methodStatus"] == "ok" and ok["nValid"] == 4
    assert kendall_tb([1, 1, 1], [1, 2, 3])["tau"] is None
    assert kendall_tb([1.0], [2.0])["methodStatus"] == "insufficient_data"
    assert kendall_tb([1, None], [1, 1])["methodStatus"] == "insufficient_data"


def test_ordinal_ranks_follow_category_order_and_effects_null_safe():
    assert ordinal_ranks(["b", "a", "b"], ["a", "b"]) == [2.0, 1.0, 2.0]
    assert ordinal_ranks(["zzz"], ["a", "b"]) == [None]
    assert cliffs_delta([1, 2, 3], [1, 2, 3]) == 0.0
    assert cliffs_delta([1.0], [1.0, 2.0]) is None
    assert epsilon_squared(0.0, 2) is None


def test_ordinal_summary_median_iqr_top2_mean_note():
    spec = {"name": "Q", "scaleType": "ordinal", "categoryOrder": ["1", "2", "3", "4", "5"],
            "valueLabels": {}, "missingCodes": ["99"], "missingReasons": {"99": "無回答"}}
    res = question_summary(pl.Series("Q", [1, 2, 3, 4, 5, 5, 99, None]), spec)
    assert res["denominators"] == {"total": 8, "notApplicable": 0, "missing": 2,
                                   "target": 8, "valid": 6}
    aux = res["auxiliaryStats"]
    assert aux["median"] == 3.5 and aux["iqr"] == 2.5
    assert aux["top2Box"] == {"pct": 50.0, "n": 3}
    assert aux["bottom2Box"] == {"pct": 33.3, "n": 2}
    assert aux["meanNote"] == "等間隔得点として計算"


def test_surprise_ordinal_pair_adopts_kendall():
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(8)],
        "A": [1, 1, 2, 2, 3, 3, 4, 5],
        "B": [1, 2, 2, 3, 3, 4, 4, 5],
    })
    meta = [{"name": "A", "scaleType": "ordinal"}, {"name": "B", "scaleType": "ordinal"}]
    res = compute_phik_and_surprise(df=df, columns=["A", "B"], column_meta=meta)
    assert len(res["pairs"]) == 1
    adopted = res["pairs"][0]["adoptedCorrelation"]
    assert adopted["methodUsed"] == "kendall_tb"
    assert adopted["value"] is not None and adopted["nValid"] == 8
    # legacy secondary values still present, not presented as the adopted method
    assert "kendall_tau" in res["pairs"][0]["secondary"]


def test_subgroup_ordinal_uses_stable_method_contract():
    from app.algorithms.mining.subgroup import run_subgroup_mining

    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(12)],
        "seg": ["a"] * 6 + ["b"] * 6,
        "Q": [1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5],
    })
    meta = [
        {"columnId": "seg", "name": "seg", "role": "attribute", "scaleType": "nominal"},
        {"columnId": "Q", "name": "Q", "role": "question", "scaleType": "ordinal",
         "categoryOrder": ["1", "2", "3", "4", "5"], "valueLabels": {}, "missingCodes": []},
    ]
    res = run_subgroup_mining(df, attribute_cols=["seg"], question_cols=["Q"],
                              column_meta=meta, min_group_size=2)
    assert len(res.get("insights", [])) == 1
    insight = res["insights"][0]
    assert insight["test"]["method"] == "mann_whitney_u"
    assert insight["effect"]["measure"] == "cliffs_delta"
    assert insight["question"]["type"] == "ordinal"
