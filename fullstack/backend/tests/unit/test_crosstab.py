"""Feature 26-BE1: crosstab pure computation against a known 2x3 fixture."""
from __future__ import annotations

import math

import polars as pl
import pytest
from scipy import stats

from app.algorithms.summaries.crosstab import (
    adjusted_residual,
    compute_crosstab,
    significance_marker,
)


def _fixture() -> tuple[pl.DataFrame, dict]:
    rows = []
    grid = {("a", "x"): 10, ("a", "y"): 20, ("a", "z"): 70,
            ("b", "x"): 30, ("b", "y"): 30, ("b", "z"): 40}
    n = 0
    for (row, col), count in grid.items():
        for _ in range(count):
            rows.append({"__rowId__": f"r{n}", "row": row, "col": col})
            n += 1
    codebook = {"columns": [
        {"name": "row", "columnId": "c-row", "scaleType": "nominal",
         "valueLabels": {"a": "A", "b": "B"}, "categoryOrder": ["a", "b"], "missingCodes": []},
        {"name": "col", "columnId": "c-col", "scaleType": "nominal",
         "valueLabels": {"x": "X", "y": "Y", "z": "Z"}, "categoryOrder": ["x", "y", "z"],
         "missingCodes": []},
    ]}
    return pl.DataFrame(rows), codebook


def test_counts_percentages_match_reference():
    df, codebook = _fixture()
    result = compute_crosstab(df, "row", "col", codebook=codebook)
    assert result["grandTotal"] == {"unweightedCount": 200, "count": 200.0}
    assert result["effectiveN"] == 200 and result["missingCount"] == 0
    by_key = {(c["rowCategoryId"], c["colCategoryId"]): c for c in result["cells"]}
    assert by_key[("a", "x")]["unweightedCount"] == 10
    assert by_key[("a", "x")]["rowPct"] == 10.0
    assert by_key[("a", "x")]["colPct"] == 25.0
    assert by_key[("a", "x")]["totalPct"] == 5.0
    assert result["rowTotals"][0]["count"] == 100.0
    total_pct = sum(c["totalPct"] for c in result["cells"] if c["totalPct"] is not None)
    assert total_pct == 100.0


def test_chi2_cramers_v_match_scipy_reference():
    import numpy as np

    df, codebook = _fixture()
    result = compute_crosstab(df, "row", "col", codebook=codebook)
    observed = np.array([[10, 20, 70], [30, 30, 40]])
    chi2, p, dof, _ = stats.chi2_contingency(observed, correction=False)
    assert result["descriptiveAssociation"]["pearsonChi2"] == pytest.approx(float(chi2))
    assert result["descriptiveAssociation"]["df"] == dof == 2
    assert result["inference"]["pValue"] == pytest.approx(float(p), rel=1e-14, abs=0)
    assert result["inference"]["method"] == "pearson"
    assert result["inference"]["statisticType"] == "chi2"
    expected_v = math.sqrt(chi2 / (200 * 1))
    assert result["descriptiveAssociation"]["cramersV"] == pytest.approx(expected_v)
    assert result["descriptiveAssociation"]["weightedCramersV"] is None


def test_asr_matches_shared_formula_and_thresholds():
    df, codebook = _fixture()
    result = compute_crosstab(df, "row", "col", codebook=codebook)
    by_key = {(c["rowCategoryId"], c["colCategoryId"]): c for c in result["cells"]}
    cell = by_key[("a", "z")]
    assert cell["asr"] == round(adjusted_residual(70, 55.0, 0.5, 0.55), 3)
    assert cell["significance"] in ("*", "**", "***")
    assert significance_marker(3.5) == "***"
    assert significance_marker(2.7) == "**"
    assert significance_marker(2.0) == "*"
    assert significance_marker(0.5) == ""
    assert significance_marker(None) == ""


def test_category_validation_and_empty_table():
    df, codebook = _fixture()

    from app.domain.errors import BizError

    with pytest.raises(BizError) as exc:
        compute_crosstab(df, "row", "row", codebook=codebook)
    assert exc.value.code == "CROSSTAB_SAME_VARIABLE"
    empty = df.filter(pl.col("row") == "nope")
    result = compute_crosstab(empty, "row", "col", codebook=codebook)
    assert result["descriptiveAssociation"]["pearsonChi2"] is None
    assert result["inference"]["pValue"] is None
    assert result["warnings"]
