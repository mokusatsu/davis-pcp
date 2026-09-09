"""Line Mosaic Plot algorithm (Huh 2004, COMPSTAT).

Transforms multi-way contingency tables into aligned horizontal line segments
within hierarchical grid boxes, with optional target variable segmentation.
"""
from __future__ import annotations

import itertools
from typing import Any
import polars as pl

from ...domain.errors import BizError
from ...domain.codebook_adapter import CodebookAdapter, normalize_code

PALETTE = [
    "#4e79a7",  # Blue
    "#f28e2b",  # Orange
    "#e15759",  # Red
    "#76b7b2",  # Cyan
    "#59a14f",  # Green
    "#edc949",  # Yellow
    "#af7aa1",  # Purple
    "#ff9da7",  # Pink
    "#9c755f",  # Brown
    "#bab0ab",  # Gray
]


def compute_line_mosaic(
    df: pl.DataFrame,
    column_variables: list[str] | None = None,
    row_variables: list[str] | None = None,
    target_variable: str | None = None,
    row_ids: list[str] | None = None,
    codebook: dict | None = None,
) -> dict[str, Any]:
    """Compute hierarchical line mosaic contingency table and grid coordinates."""
    if "__rowId__" not in df.columns:
        df = df.with_columns(pl.int_range(0, df.height).cast(pl.String).alias("__rowId__"))

    if row_ids is not None:
        wanted = set(row_ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))

    # Empty scope is a normal zero result (20a 7.5: 集計APIは0件結果を正常返却).
    # Levels come from the codebook order, so the grid stays defined with 0 counts.

    col_vars = [c for c in (column_variables or []) if c in df.columns]
    row_vars = [r for r in (row_variables or []) if r in df.columns]

    # Auto-pick defaults if none specified
    if not col_vars and not row_vars:
        # Prefer string/categorical/boolean columns
        cat_cols = [c for c in df.columns if c != "__rowId__" and df[c].dtype in (pl.String, pl.Categorical, pl.Boolean)]
        if len(cat_cols) >= 2:
            col_vars = [cat_cols[0]]
            row_vars = [cat_cols[1]]
        elif len(cat_cols) == 1:
            col_vars = [cat_cols[0]]
        else:
            # Pick columns with <= 10 unique values
            low_card = [c for c in df.columns if c != "__rowId__" and df[c].n_unique() <= 10]
            if len(low_card) >= 2:
                col_vars = [low_card[0]]
                row_vars = [low_card[1]]
            elif len(low_card) == 1:
                col_vars = [low_card[0]]
            else:
                raise BizError("MOSAIC_NO_CATEGORICAL_COLUMNS", "モザイクプロットに使用可能なカテゴリ変数がありません。")

    adapter = CodebookAdapter(df, codebook)
    if codebook:
        for c in set(col_vars + row_vars + ([target_variable] if target_variable else [])):
            if c in df.columns:
                df = df.with_columns(adapter.mask_missing_values(c).map_elements(normalize_code, return_dtype=pl.String))
    def levels(name: str) -> list[str]:
        if codebook:
            ordered = adapter.get_ordered_categories(name)
            spec = adapter.get_column_spec_optional(name) or {}
            return list(reversed(ordered)) if spec.get("isReversed") else ordered
        return sorted([str(v) for v in df[name].unique().to_list() if v is not None])

    # Determine unique levels for each column variable
    col_levels: list[list[str]] = []
    for c in col_vars:
        vals = levels(c)
        if not vals:
            vals = ["(None)"]
        col_levels.append(vals)

    # Determine unique levels for each row variable
    row_levels: list[list[str]] = []
    for r in row_vars:
        vals = levels(r)
        if not vals:
            vals = ["(None)"]
        row_levels.append(vals)

    # Build Cartesian product for columns
    if col_levels:
        col_combs = list(itertools.product(*col_levels))
    else:
        col_combs = [()]

    col_labels = [
        {"path": list(comb), "j": idx + 1}
        for idx, comb in enumerate(col_combs)
    ]
    col_map = {comb: idx + 1 for idx, comb in enumerate(col_combs)}

    # Build Cartesian product for rows
    if row_levels:
        row_combs = list(itertools.product(*row_levels))
    else:
        row_combs = [()]

    row_labels = [
        {"path": list(comb), "i": idx + 1}
        for idx, comb in enumerate(row_combs)
    ]
    row_map = {comb: idx + 1 for idx, comb in enumerate(row_combs)}

    n_cols = len(col_combs)
    n_rows = len(row_combs)

    # Target variable handling
    target_info = None
    has_target = target_variable and target_variable in df.columns
    target_categories: list[str] = []
    if has_target:
        target_categories = levels(target_variable)
        target_colors = [PALETTE[i % len(PALETTE)] for i in range(len(target_categories))]
        target_info = {
            "name": target_variable,
            "categories": target_categories,
            "colors": target_colors,
            "valueLabels": (adapter.get_column_spec_optional(target_variable) or {}).get("valueLabels", {}),
        }

    # Initialize cells grid
    cells_dict: dict[tuple[int, int], dict[str, Any]] = {}
    for r_idx, r_comb in enumerate(row_combs):
        for c_idx, c_comb in enumerate(col_combs):
            i = r_idx + 1
            j = c_idx + 1
            cells_dict[(i, j)] = {
                "i": i,
                "j": j,
                "totalCount": 0,
                "total_count": 0,
                "colPath": list(c_comb),
                "col_path": list(c_comb),
                "rowPath": list(r_comb),
                "row_path": list(r_comb),
                "targetCounts": {cat: 0 for cat in target_categories},
                "target_counts": {cat: 0 for cat in target_categories},
                "rowIds": [],
                "row_ids": [],
            }

    # Populate cells from DataFrame
    row_id_list = df["__rowId__"].to_list()
    col_data = [df[c].cast(pl.String).to_list() for c in col_vars]
    row_data = [df[r].cast(pl.String).to_list() for r in row_vars]
    target_data = df[target_variable].cast(pl.String).to_list() if has_target else None

    for row_idx in range(df.height):
        r_id = row_id_list[row_idx]
        c_tuple = tuple(col_data[j][row_idx] if col_data[j][row_idx] is not None else "(None)" for j in range(len(col_vars)))
        r_tuple = tuple(row_data[i][row_idx] if row_data[i][row_idx] is not None else "(None)" for i in range(len(row_vars)))

        j = col_map.get(c_tuple)
        i = row_map.get(r_tuple)

        if i is not None and j is not None:
            cell = cells_dict[(i, j)]
            cell["totalCount"] += 1
            cell["total_count"] += 1
            cell["rowIds"].append(r_id)
            cell["row_ids"].append(r_id)
            if target_data is not None:
                t_val = target_data[row_idx]
                if t_val in cell["targetCounts"]:
                    cell["targetCounts"][t_val] += 1
                    cell["target_counts"][t_val] += 1

    cells_list = list(cells_dict.values())
    max_freq = max((c["totalCount"] for c in cells_list), default=1)
    if max_freq == 0:
        max_freq = 1

    return {
        "grid": {
            "nCols": n_cols,
            "nRows": n_rows,
            "n_cols": n_cols,
            "n_rows": n_rows,
            "colVariables": col_vars,
            "col_variables": col_vars,
            "rowVariables": row_vars,
            "row_variables": row_vars,
            "colLabels": col_labels,
            "col_labels": col_labels,
            "rowLabels": row_labels,
            "row_labels": row_labels,
        },
        "target": target_info,
        "valueLabels": {c: (adapter.get_column_spec_optional(c) or {}).get("valueLabels", {}) for c in col_vars + row_vars},
        "maxCellFrequency": max_freq,
        "max_cell_frequency": max_freq,
        "cells": cells_list,
        "evidenceClass": "LEGACY-RECOVERED",
    }
