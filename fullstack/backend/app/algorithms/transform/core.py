"""Variable transformation algorithms: nominal-to-binary and binning."""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl

from ...domain.errors import BizError


def nominal_to_binary(
    df: pl.DataFrame,
    column: str,
    drop_first: bool = False,
    prefix: str | None = None,
    handle_null: str = "as_missing",
    max_categories: int = 30,
) -> tuple[pl.DataFrame, list[str]]:
    """One-hot encode a categorical column into binary 0/1 integer columns."""
    if column not in df.columns:
        raise BizError("TRANSFORM_COLUMN_NOT_FOUND", f"列 '{column}' が存在しません。")

    series = df[column]
    non_null = series.drop_nulls()
    unique_vals = sorted([str(v) for v in non_null.unique().to_list()])

    if len(unique_vals) == 0:
        raise BizError("TRANSFORM_EMPTY_COLUMN", f"列 '{column}' に有効な値がありません。")

    if len(unique_vals) > max_categories:
        raise BizError(
            "TRANSFORM_TOO_MANY_CATEGORIES",
            f"カテゴリ数 ({len(unique_vals)}) が上限 ({max_categories}) を超えています。",
            details={"unique_count": len(unique_vals), "max": max_categories},
            suggested_actions=["カーディナリティの低い列を選択してください。"],
        )

    targets = unique_vals[1:] if drop_first and len(unique_vals) > 1 else unique_vals
    col_prefix = prefix or column
    new_col_names = []
    new_cols = []

    has_null = series.null_count() > 0

    for val in targets:
        clean_val = str(val).replace(" ", "_").replace("/", "_")
        col_name = f"{col_prefix}_{clean_val}"
        counter = 1
        orig_col_name = col_name
        while col_name in df.columns or col_name in new_col_names:
            col_name = f"{orig_col_name}_{counter}"
            counter += 1

        if handle_null == "as_missing" and has_null:
            expr = (
                pl.when(pl.col(column).is_null())
                .then(None)
                .when(pl.col(column).cast(pl.String) == str(val))
                .then(1)
                .otherwise(0)
                .cast(pl.Int32)
                .alias(col_name)
            )
        else:
            expr = (
                pl.when(pl.col(column).cast(pl.String) == str(val))
                .then(1)
                .otherwise(0)
                .cast(pl.Int32)
                .alias(col_name)
            )

        new_col_names.append(col_name)
        new_cols.append(expr)

    if handle_null == "as_category" and has_null:
        null_col_name = f"{col_prefix}_null"
        expr = (
            pl.when(pl.col(column).is_null())
            .then(1)
            .otherwise(0)
            .cast(pl.Int32)
            .alias(null_col_name)
        )
        new_col_names.append(null_col_name)
        new_cols.append(expr)

    updated_df = df.with_columns(new_cols)
    return updated_df, new_col_names


def compute_bin_edges(
    values: np.ndarray,
    method: str = "equal_width",
    num_bins: int = 4,
    custom_cuts: list[float] | None = None,
) -> list[float]:
    """Compute bin cut edges [e0, e1, ..., eB]."""
    if len(values) == 0:
        raise BizError("TRANSFORM_EMPTY_DATA", "ビン分割対象の有効データがありません。")

    v_min = float(np.min(values))
    v_max = float(np.max(values))

    if v_min == v_max:
        return [v_min - 0.5, v_max + 0.5]

    if method == "custom" and custom_cuts is not None and len(custom_cuts) > 0:
        cuts = sorted(set(float(c) for c in custom_cuts))
        edges = []
        if cuts[0] > v_min:
            edges.append(v_min)
        edges.extend(cuts)
        if cuts[-1] < v_max:
            edges.append(v_max)
        res = sorted(list(set(edges)))
        if len(res) >= 2:
            return res

    if method == "quantile":
        percentiles = np.linspace(0, 100, num_bins + 1)
        raw_edges = np.percentile(values, percentiles)
        edges = [float(raw_edges[0])]
        for e in raw_edges[1:]:
            if float(e) > edges[-1]:
                edges.append(float(e))
        if len(edges) < 2:
            edges = [v_min, v_max]
        return edges

    # Default: equal_width
    return [float(e) for e in np.linspace(v_min, v_max, num_bins + 1)]


def bin_numeric(
    df: pl.DataFrame,
    column: str,
    method: str = "equal_width",
    num_bins: int = 4,
    custom_cuts: list[float] | None = None,
    output_name: str | None = None,
    labels_format: str = "range",
) -> tuple[pl.DataFrame, str, list[dict[str, Any]]]:
    """Discretize / bin a numeric column into categories."""
    if column not in df.columns:
        raise BizError("TRANSFORM_COLUMN_NOT_FOUND", f"列 '{column}' が存在しません。")

    series = df[column]
    non_null = series.drop_nulls()
    if len(non_null) == 0:
        raise BizError("TRANSFORM_EMPTY_COLUMN", f"列 '{column}' に有効な数値データがありません。")

    vals = non_null.to_numpy().astype(float)
    edges = compute_bin_edges(vals, method=method, num_bins=num_bins, custom_cuts=custom_cuts)
    n_bins = len(edges) - 1

    bin_summaries = []
    labels = []
    for k in range(n_bins):
        low, high = edges[k], edges[k + 1]
        if labels_format == "bin_number":
            label = f"Bin {k + 1}"
        else:
            if k == n_bins - 1:
                label = f"[{low:.2f}, {high:.2f}]"
            else:
                label = f"[{low:.2f}, {high:.2f})"
        labels.append(label)

        if k == n_bins - 1:
            count = int(np.sum((vals >= low) & (vals <= high)))
        else:
            count = int(np.sum((vals >= low) & (vals < high)))

        bin_summaries.append({
            "binIndex": k,
            "label": label,
            "min": low,
            "max": high,
            "count": count,
            "ratio": float(count / len(vals)),
        })

    target_col_name = output_name or f"{column}_bin{n_bins}"
    counter = 1
    orig_target = target_col_name
    while target_col_name in df.columns:
        target_col_name = f"{orig_target}_{counter}"
        counter += 1

    expr = pl.lit(None).cast(pl.String)
    for k in reversed(range(n_bins)):
        low, high = edges[k], edges[k + 1]
        label = labels[k]
        if k == n_bins - 1:
            cond = (pl.col(column) >= low) & (pl.col(column) <= high)
        else:
            cond = (pl.col(column) >= low) & (pl.col(column) < high)
        expr = pl.when(cond).then(pl.lit(label)).otherwise(expr)

    updated_df = df.with_columns(expr.alias(target_col_name))
    return updated_df, target_col_name, bin_summaries


def preview_binning(
    df: pl.DataFrame,
    column: str,
    method: str = "equal_width",
    num_bins: int = 4,
    custom_cuts: list[float] | None = None,
) -> dict[str, Any]:
    """Generate preview histogram and bin cut boundaries without modifying df."""
    if column not in df.columns:
        raise BizError("TRANSFORM_COLUMN_NOT_FOUND", f"列 '{column}' が存在しません。")

    series = df[column].drop_nulls()
    if len(series) == 0:
        raise BizError("TRANSFORM_EMPTY_COLUMN", f"列 '{column}' に有効な数値がありません。")

    vals = series.to_numpy().astype(float)
    edges = compute_bin_edges(vals, method=method, num_bins=num_bins, custom_cuts=custom_cuts)
    n_bins = len(edges) - 1

    hist_counts, hist_edges = np.histogram(vals, bins=min(25, max(10, len(vals) // 5)))

    bins_info = []
    for k in range(n_bins):
        low, high = edges[k], edges[k + 1]
        if k == n_bins - 1:
            count = int(np.sum((vals >= low) & (vals <= high)))
            lbl = f"[{low:.2f}, {high:.2f}]"
        else:
            count = int(np.sum((vals >= low) & (vals < high)))
            lbl = f"[{low:.2f}, {high:.2f})"
        bins_info.append({
            "binIndex": k,
            "label": lbl,
            "min": low,
            "max": high,
            "count": count,
            "ratio": float(count / len(vals)),
        })

    return {
        "column": column,
        "method": method,
        "edges": edges,
        "bins": bins_info,
        "histogram": {
            "counts": [int(c) for c in hist_counts],
            "edges": [float(e) for e in hist_edges],
        },
        "min": float(np.min(vals)),
        "max": float(np.max(vals)),
        "count": len(vals),
    }
