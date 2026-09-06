"""Unit tests for Line Mosaic Plot algorithm (Huh 2004)."""
from __future__ import annotations

import polars as pl
import pytest

from app.algorithms.summaries.line_mosaic import compute_line_mosaic


def test_line_mosaic_titanic_contingency():
    # Synthetic Titanic table
    df = pl.DataFrame({
        "Class": ["1st", "1st", "2nd", "2nd", "3rd", "3rd", "Crew", "Crew"] * 10,
        "Sex": ["Male", "Female"] * 40,
        "Age": ["Adult", "Child", "Adult", "Adult"] * 20,
        "Survived": ["No", "Yes", "No", "Yes"] * 20,
    })

    res = compute_line_mosaic(
        df=df,
        column_variables=["Class", "Age"],
        row_variables=["Sex"],
        target_variable="Survived",
    )

    grid = res["grid"]
    assert grid["nCols"] > 0
    assert grid["nRows"] == 2  # Male, Female
    assert len(grid["rowLabels"]) == 2

    # Target variable categories
    target = res["target"]
    assert target is not None
    assert target["name"] == "Survived"
    assert "No" in target["categories"]
    assert "Yes" in target["categories"]

    # Check cells
    cells = res["cells"]
    assert len(cells) == grid["nCols"] * grid["nRows"]
    total_samples = sum(c["totalCount"] for c in cells)
    assert total_samples == df.height

    # Check max frequency
    assert res["maxCellFrequency"] >= 1


def test_line_mosaic_empty_or_defaults():
    df = pl.DataFrame({
        "A": ["a1", "a2", "a1"],
        "B": ["b1", "b1", "b2"],
    })
    res = compute_line_mosaic(df)
    assert res["grid"]["nCols"] >= 1
    assert res["grid"]["nRows"] >= 1
    assert sum(c["totalCount"] for c in res["cells"]) == 3
