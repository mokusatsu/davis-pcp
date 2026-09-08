import polars as pl
import pytest
from app.algorithms.summaries.core import question_summary, summarize


def test_denominator_with_missing_and_not_applicable():
    # 10 rows:
    # 6 valid (codes 1, 2, 3)
    # 2 not applicable (code 98, reason: "非該当")
    # 2 missing (code 99 reason: "無回答", plus 1 None) -> wait, let's make total 10:
    # 5 valid (1, 1, 2, 2, 3), 2 non-applicable (98, 98), 2 missing (99, 99), 1 None = 10 rows
    series = pl.Series("Q1", [1, 1, 2, 2, 3, 98, 98, 99, 99, None])
    spec = {
        "scaleType": "ordinal",
        "categoryOrder": ["1", "2", "3"],
        "valueLabels": {"1": "不満", "2": "普通", "3": "満足"},
        "missingCodes": ["98", "99"],
        "missingReasons": {"98": "非該当", "99": "無回答"},
    }

    res = question_summary(series, spec)

    # Denominators:
    # total = 10
    # notApplicable = 2 (98 x 2)
    # target = 10 - 2 = 8
    # missing = 3 (99 x 2 + None x 1)
    # valid = 8 - 3 = 5
    denoms = res["denominators"]
    assert denoms["total"] == 10
    assert denoms["notApplicable"] == 2
    assert denoms["target"] == 8
    assert denoms["missing"] == 3
    assert denoms["valid"] == 5

    # Distributions
    dist = res["distribution"]
    # 3 valid items + 2 missing items (98, 99)
    dist_by_code = {d["code"]: d for d in dist}
    assert dist_by_code["1"]["count"] == 2
    assert dist_by_code["1"]["percentageValid"] == 40.0  # 2 / 5 * 100
    assert dist_by_code["1"]["percentageTotal"] == 20.0  # 2 / 10 * 100

    assert dist_by_code["2"]["count"] == 2
    assert dist_by_code["2"]["percentageValid"] == 40.0  # 2 / 5 * 100

    assert dist_by_code["3"]["count"] == 1
    assert dist_by_code["3"]["percentageValid"] == 20.0  # 1 / 5 * 100

    assert dist_by_code["98"]["isMissing"] is True
    assert dist_by_code["98"]["percentageTotal"] == 20.0  # 2 / 10 * 100

    assert dist_by_code["99"]["isMissing"] is True
    assert dist_by_code["99"]["percentageTotal"] == 20.0  # 2 / 10 * 100


def test_ordinal_auxiliary_stats_top2_bottom2_box():
    # 5-point scale: codes 1, 2, 3, 4, 5
    # counts: 1: 10, 2: 10, 3: 20, 4: 30, 5: 30 (total 100 valid)
    vals = [1] * 10 + [2] * 10 + [3] * 20 + [4] * 30 + [5] * 30
    series = pl.Series("satisfaction", vals)
    spec = {
        "scaleType": "ordinal",
        "categoryOrder": ["1", "2", "3", "4", "5"],
        "valueLabels": {
            "1": "大いに不満",
            "2": "やや不満",
            "3": "どちらでもない",
            "4": "やや満足",
            "5": "大いに満足",
        },
        "missingCodes": [],
    }

    res = question_summary(series, spec)
    aux = res["auxiliaryStats"]

    # Top 2 box: 4 (30) + 5 (30) = 60 / 100 = 60.0%
    assert aux["top2Box"] == {"pct": 60.0, "n": 60}

    # Bottom 2 box: 1 (10) + 2 (10) = 20 / 100 = 20.0%
    assert aux["bottom2Box"] == {"pct": 20.0, "n": 20}

    # Mean: (1*10 + 2*10 + 3*20 + 4*30 + 5*30) / 100 = (10 + 20 + 60 + 120 + 150) / 100 = 360 / 100 = 3.6
    assert aux["mean"] == 3.6
    assert aux["meanNote"] == "等間隔得点として計算"
    assert aux["median"] == 4.0


def test_summarize_integrates_codebook():
    df = pl.DataFrame({
        "q1": [1, 2, 3, 4, 5],
        "q2": [10, 20, 30, 40, 50],
    })
    codebook = {
        "columns": [
            {
                "name": "q1",
                "scaleType": "ordinal",
                "categoryOrder": ["1", "2", "3", "4", "5"],
                "valueLabels": {"1": "A", "2": "B", "3": "C", "4": "D", "5": "E"},
            },
            {
                "name": "q2",
                "scaleType": "ratio",
            }
        ]
    }
    col_types = {"q1": "categorical", "q2": "numeric"}
    res = summarize(df, col_types, codebook=codebook)

    assert "denominators" in res["q1"]
    assert res["q1"]["denominators"]["total"] == 5
    assert res["q1"]["denominators"]["valid"] == 5
    assert len(res["q1"]["distribution"]) == 5
    assert "top2Box" in res["q1"]["auxiliaryStats"]
