"""Test modern subgroup discovery on student_performance_math.csv."""
from pathlib import Path
import polars as pl
import pytest
from app.algorithms.mining.modern_subgroup import run_modern_subgroup_mining


def test_student_performance_math_omnipresent():
    csv_path = Path(r"c:\dev\davis-pcp\workspace\datasets\student_performance_math.csv")
    if not csv_path.exists():
        pytest.skip("student_performance_math.csv not found")

    df = pl.read_csv(csv_path)
    assert df.height == 395
    assert df.width == 33

    # 1. Omnipresent Auto-Mining on student dataset
    res = run_modern_subgroup_mining(df)
    assert res is not None
    assert "insights" in res
    assert len(res["insights"]) > 0

    for ins in res["insights"]:
        assert "id" in ins
        assert "rule" in ins
        assert "conditions" in ins["rule"]
        assert len(ins["rule"]["conditions"]) >= 1
        assert "coverage" in ins
        assert ins["coverage"]["n"] >= 20
        assert "score" in ins
        assert "narrative" in ins
        assert len(ins["narrative"]) > 0

    # 2. Targeted search with final grade G3
    res_g3 = run_modern_subgroup_mining(df, target_questions=["G3"])
    assert res_g3 is not None
    assert len(res_g3["insights"]) > 0
    for ins in res_g3["insights"]:
        assert ins["target_question"] == "G3"

    # 3. Simulate switching to PCP and coming back (with selectedRowIds)
    first_insight_row_ids = res["insights"][0]["coverage"]["row_ids"]
    print(f"\nSimulating returning with {len(first_insight_row_ids)} selectedRowIds")
    
    # Filter df by selectedRowIds like API does
    df_with_id = df.with_columns(pl.Series("__rowId__", [str(i) for i in range(df.height)]))
    filtered_df = df_with_id.filter(pl.col("__rowId__").is_in(first_insight_row_ids))
    print(f"Filtered DF height: {filtered_df.height}")

    try:
        res_filtered = run_modern_subgroup_mining(filtered_df, min_group_size=30)
        print(f"Success with filtered DF! Insights: {len(res_filtered['insights'])}")
    except Exception as e:
        print(f"ERROR on filtered DF: {e}")
        import traceback
        traceback.print_exc()
        raise e
