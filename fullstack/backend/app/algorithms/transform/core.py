"""Variable transformation algorithms: nominal-to-binary and binning."""
from __future__ import annotations

import math
from typing import Any
import numpy as np
import polars as pl

from ...domain.errors import BizError
from ...domain.codebook_adapter import CodebookAdapter


def _transform_source(df: pl.DataFrame, column: str, codebook: dict | None) -> pl.Series:
    """Interpret missing codes without scoring or changing stored source values."""
    if column not in df.columns:
        raise BizError("TRANSFORM_COLUMN_NOT_FOUND", f"列 '{column}' が存在しません。")
    # Transforms operate on raw categories, including undeclared codes. Neither
    # declared-domain filtering nor ordinal/reverse scoring belongs here.
    return CodebookAdapter(df, codebook or {}).mask_missing_values(column)


def _allocate_column_name(base: str, reserved: set[str]) -> str:
    name = base
    counter = 1
    while name in reserved:
        name = f"{base}_{counter}"
        counter += 1
    reserved.add(name)
    return name


def _append_columns(df: pl.DataFrame, columns: list[pl.Series]) -> pl.DataFrame:
    """Validate the complete output batch before attaching any derived values."""
    names = [series.name for series in columns]
    if (len(names) != len(set(names)) or set(names).intersection(df.columns)
            or any(not name for name in names)
            or any(len(series) != df.height for series in columns)):
        raise BizError("TRANSFORM_INVALID_OUTPUT", "変換先の列名または行数が不正です。", status_code=422)
    return df.with_columns(columns)


def nominal_to_binary(
    df: pl.DataFrame,
    column: str,
    drop_first: bool = False,
    prefix: str | None = None,
    handle_null: str = "as_missing",
    max_categories: int = 30,
    codebook: dict | None = None,
) -> tuple[pl.DataFrame, list[str]]:
    """One-hot encode a categorical column into binary 0/1 integer columns."""
    series = _transform_source(df, column, codebook)
    non_null = series.drop_nulls()
    unique_vals = sorted(non_null.unique().to_list(), key=str)

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
    reserved = set(df.columns)

    has_null = series.null_count() > 0

    for val in targets:
        clean_val = str(val).replace(" ", "_").replace("/", "_")
        col_name = _allocate_column_name(f"{col_prefix}_{clean_val}", reserved)
        # Keep the actual typed category through comparison. In particular,
        # Polars Boolean string casts do not match Python's True/False names.
        indicator = (series == val).cast(pl.Int32)
        if handle_null != "as_missing":
            indicator = indicator.fill_null(0)
        new_col_names.append(col_name)
        new_cols.append(indicator.rename(col_name))

    if handle_null == "as_category" and has_null:
        null_col_name = _allocate_column_name(f"{col_prefix}_null", reserved)
        new_col_names.append(null_col_name)
        new_cols.append(series.is_null().cast(pl.Int32).rename(null_col_name))

    updated_df = _append_columns(df, new_cols)
    return updated_df, new_col_names


def _equal_width_edges(lower: float, upper: float, num_bins: int) -> list[float]:
    """Collapse only identical cuts when the requested resolution is unavailable."""
    edges: list[float] = []
    for raw_edge in np.linspace(lower, upper, num_bins + 1):
        edge = float(raw_edge)
        if not edges or edge != edges[-1]:
            edges.append(edge)
    return edges


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
        lower, upper = v_min - 0.5, v_max + 0.5
        if not (math.isfinite(lower) and math.isfinite(upper) and lower < upper):
            # A half-unit is not representable at large magnitudes. Use exact
            # neighboring floats, keeping the observed endpoint at finite limits.
            lower = math.nextafter(v_min, -math.inf)
            upper = math.nextafter(v_max, math.inf)
            lower = lower if math.isfinite(lower) else v_min
            upper = upper if math.isfinite(upper) else v_max
        return [lower, upper]

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
    return _equal_width_edges(v_min, v_max, num_bins)


def _bin_summaries(vals: np.ndarray, edges: list[float], labels_format: str) -> list[dict[str, Any]]:
    if (len(edges) < 2 or not all(np.isfinite(edge) for edge in edges)
            or any(low >= high for low, high in zip(edges, edges[1:]))):
        raise BizError("TRANSFORM_INVALID_BINS", "ビン境界には有限の昇順の値が必要です。", status_code=422)
    n_bins = len(edges) - 1
    bin_summaries = []
    for k in range(n_bins):
        low, high = edges[k], edges[k + 1]
        if labels_format == "bin_number":
            label = f"Bin {k + 1}"
        else:
            if k == n_bins - 1:
                label = f"[{low:.2f}, {high:.2f}]"
            else:
                label = f"[{low:.2f}, {high:.2f})"
        if k == n_bins - 1:
            count = int(np.sum((vals >= low) & (vals <= high)))
        else:
            count = int(np.sum((vals >= low) & (vals < high)))

        bin_summaries.append({
            "binIndex": k,
            "binId": k + 1,
            "label": label,
            "min": low,
            "max": high,
            "lowerInclusive": True,
            "upperInclusive": k == n_bins - 1,
            "count": count,
            "ratio": float(count / len(vals)),
        })
    return bin_summaries


def bin_numeric(
    df: pl.DataFrame,
    column: str,
    method: str = "equal_width",
    num_bins: int = 4,
    custom_cuts: list[float] | None = None,
    output_name: str | None = None,
    labels_format: str = "range",
    codebook: dict | None = None,
) -> tuple[pl.DataFrame, str, list[dict[str, Any]]]:
    """Store integer bin identities; display labels never identify a bin."""
    series = _transform_source(df, column, codebook)
    non_null = series.drop_nulls()
    if len(non_null) == 0:
        raise BizError("TRANSFORM_EMPTY_COLUMN", f"列 '{column}' に有効な数値データがありません。")

    vals = non_null.to_numpy().astype(float)
    edges = compute_bin_edges(vals, method=method, num_bins=num_bins, custom_cuts=custom_cuts)
    n_bins = len(edges) - 1
    bin_summaries = _bin_summaries(vals, edges, labels_format)

    target_col_name = _allocate_column_name(output_name or f"{column}_bin{n_bins}", set(df.columns))

    expr = pl.lit(None).cast(pl.Int32)
    for k in reversed(range(n_bins)):
        low, high = edges[k], edges[k + 1]
        if k == n_bins - 1:
            cond = (pl.col(column) >= low) & (pl.col(column) <= high)
        else:
            cond = (pl.col(column) >= low) & (pl.col(column) < high)
        expr = pl.when(cond).then(pl.lit(k + 1, dtype=pl.Int32)).otherwise(expr)

    derived = series.to_frame().select(expr.alias(target_col_name)).to_series()
    updated_df = _append_columns(df, [derived])
    return updated_df, target_col_name, bin_summaries


def preview_binning(
    df: pl.DataFrame,
    column: str,
    method: str = "equal_width",
    num_bins: int = 4,
    custom_cuts: list[float] | None = None,
    codebook: dict | None = None,
    labels_format: str = "range",
) -> dict[str, Any]:
    """Generate preview histogram and bin cut boundaries without modifying df."""
    series = _transform_source(df, column, codebook).drop_nulls()
    if len(series) == 0:
        raise BizError("TRANSFORM_EMPTY_COLUMN", f"列 '{column}' に有効な数値がありません。")

    vals = series.to_numpy().astype(float)
    edges = compute_bin_edges(vals, method=method, num_bins=num_bins, custom_cuts=custom_cuts)

    hist_min, hist_max = float(np.min(vals)), float(np.max(vals))
    if hist_min == hist_max:
        hist_min, hist_max = edges[0], edges[-1]
    # Explicit cuts avoid NumPy's independent half-unit/auto-bin range, which
    # can collapse for the same constant or adjacent-float inputs as above.
    histogram_edges = _equal_width_edges(hist_min, hist_max, min(25, max(10, len(vals) // 5)))
    hist_counts, hist_edges = np.histogram(vals, bins=histogram_edges)

    bins_info = _bin_summaries(vals, edges, labels_format)

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
