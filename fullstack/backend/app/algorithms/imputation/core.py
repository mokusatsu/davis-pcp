"""Baseline and advanced imputation engine (Mean, Median, Mode, Constant, KNN, TabDiff)."""
from __future__ import annotations

import hashlib
import json
from typing import Any
import numpy as np
import polars as pl

from ...domain.errors import BizError
from .plan import ImputationPlan, build_imputation_plan, plan_warnings
from .tabdiff import tabdiff_impute


def column_values_hash(series: pl.Series) -> str:
    """SHA-256 over every value of a column, in row order.

    Preview and apply both report this, so "the preview showed what actually
    got applied" is checked on the values themselves and not on summary stats.
    """
    payload = json.dumps([None if v is None else str(v) for v in series.to_list()],
                         ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _knn_impute_series(target_arr: np.ndarray, feature_mat: np.ndarray, k: int = 5) -> np.ndarray:
    """Impute missing numeric values using K-Nearest Neighbors on observed rows."""
    is_nan = np.isnan(target_arr)
    if not np.any(is_nan) or np.all(is_nan):
        # Nothing to impute or everything is missing
        fill_val = 0.0 if np.all(is_nan) else float(np.nanmean(target_arr))
        return np.where(is_nan, fill_val, target_arr)

    obs_indices = np.where(~is_nan)[0]
    mis_indices = np.where(is_nan)[0]

    # Standardize feature matrix for fair distance calculation
    col_means = np.nanmean(feature_mat, axis=0)
    col_stds = np.nanstd(feature_mat, axis=0)
    col_stds[col_stds < 1e-6] = 1.0
    norm_features = np.nan_to_num((feature_mat - col_means) / col_stds, nan=0.0)

    imputed_arr = target_arr.copy()
    for m_idx in mis_indices:
        query_vec = norm_features[m_idx]
        obs_features = norm_features[obs_indices]
        # Euclidean distance to all observed rows
        dists = np.linalg.norm(obs_features - query_vec, axis=1)
        k_actual = min(k, len(obs_indices))
        nearest_obs_pos = np.argpartition(dists, k_actual - 1)[:k_actual]
        nearest_rows = obs_indices[nearest_obs_pos]
        weights = 1.0 / (dists[nearest_obs_pos] + 1e-5)
        weights /= np.sum(weights)
        imputed_arr[m_idx] = float(np.sum(target_arr[nearest_rows] * weights))

    return imputed_arr


def impute_dataframe(
    df: pl.DataFrame,
    columns: list[str] | None = None,
    strategy: str = "tabdiff",
    options: dict[str, Any] | None = None,
    predictors: list[str] | None = None,
    plan_hash: str = "",
) -> tuple[pl.DataFrame, dict[str, Any]]:
    """Impute missing values across specified columns in a dataframe.

    ``predictors`` are conditioning columns: they inform the imputation of
    ``columns`` but never receive values themselves.  ``None`` keeps the
    historical behaviour (the engine picks its own feature set).
    """
    opts = options or {}
    if columns is not None:
        target_cols = list(columns)
    else:
        target_cols = [c for c in df.columns if c != "__rowId__"]
    valid_cols = [c for c in target_cols if c in df.columns and c != "__rowId__"]

    if columns is not None and len(valid_cols) == 0:
        raise BizError("IMPUTATION_NO_COLUMNS", "補完対象の列が指定されていないか、存在しません。")
    if not valid_cols:
        raise BizError("IMPUTATION_NO_COLUMNS", "補完対象の列が指定されていないか、存在しません。")

    if strategy == "tabdiff":
        num_steps = int(opts.get("num_steps", 20))
        temperature = float(opts.get("temperature", 1.0))
        seed = int(opts.get("seed", 42))
        return tabdiff_impute(df, columns=valid_cols, num_steps=num_steps, temperature=temperature,
                              seed=seed, predictors=predictors, plan_hash=plan_hash)

    imputed_counts: dict[str, int] = {}
    col_diagnostics: dict[str, Any] = {}
    new_series_map: dict[str, pl.Series] = {}

    numeric_cols = [c for c in df.columns if c != "__rowId__" and df[c].dtype in (
        pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64
    )]

    # If KNN is chosen, extract numeric feature matrix.  With explicit
    # predictors the target is never one of its own neighbours in feature
    # space; without them the historical "all numeric columns" set is kept.
    feature_mat = None
    if strategy == "knn" and numeric_cols:
        if predictors is None:
            feature_names = list(numeric_cols)
        else:
            wanted = set(predictors) | {c for c in valid_cols if c in numeric_cols}
            feature_names = [c for c in df.columns if c in wanted and c != "__rowId__"]
        if feature_names:
            raw_cols = [df[c].to_numpy().astype(np.float64) for c in feature_names]
            feature_mat = np.column_stack(raw_cols)

    for c in valid_cols:
        s = df[c]
        is_float = s.dtype in (pl.Float32, pl.Float64)
        is_numeric = is_float or s.dtype in (
            pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64
        )
        null_count = s.null_count() + (int(s.is_nan().sum()) if is_float else 0)
        imputed_counts[c] = null_count
        if null_count == 0:
            new_series_map[c] = s
            continue

        if strategy == "mean":
            if not is_numeric:
                raise BizError("IMPUTATION_STRATEGY_MISMATCH", f"列 '{c}' は非数値型のため 'mean' 補完は適用できません。")
            clean_s = s.drop_nulls()
            if is_float:
                clean_s = clean_s.filter(~clean_s.is_nan())
            mean_val = float(clean_s.mean()) if clean_s.len() > 0 else 0.0
            new_s = s.fill_nan(mean_val).fill_null(mean_val) if is_float else s.fill_null(mean_val)
            new_series_map[c] = new_s
            col_diagnostics[c] = {"imputedCount": null_count, "fillValue": mean_val}

        elif strategy == "median":
            if not is_numeric:
                raise BizError("IMPUTATION_STRATEGY_MISMATCH", f"列 '{c}' は非数値型のため 'median' 補完は適用できません。")
            clean_s = s.drop_nulls()
            if is_float:
                clean_s = clean_s.filter(~clean_s.is_nan())
            med_val = float(clean_s.median()) if clean_s.len() > 0 else 0.0
            new_s = s.fill_nan(med_val).fill_null(med_val) if is_float else s.fill_null(med_val)
            new_series_map[c] = new_s
            col_diagnostics[c] = {"imputedCount": null_count, "fillValue": med_val}

        elif strategy == "mode":
            clean_s = s.drop_nulls()
            if is_float:
                clean_s = clean_s.filter(~clean_s.is_nan())
            if clean_s.len() > 0:
                mode_val = clean_s.mode()[0]
            else:
                mode_val = 0 if is_numeric else "UNKNOWN"
            new_s = s.fill_nan(mode_val).fill_null(mode_val) if is_float else s.fill_null(mode_val)
            new_series_map[c] = new_s
            col_diagnostics[c] = {"imputedCount": null_count, "fillValue": str(mode_val)}

        elif strategy == "constant":
            if "constant_value" not in opts:
                raise BizError("IMPUTATION_CONSTANT_MISSING", "定数補完にはconstant_valueが必要です。")
            raw_const = opts.get("constant_value")
            if is_numeric:
                try:
                    const_val = float(raw_const)
                except (TypeError, ValueError):
                    raise BizError("IMPUTATION_CONSTANT_INVALID", "定数値を数値に変換できません。")
                if not np.isfinite(const_val):
                    raise BizError("IMPUTATION_CONSTANT_INVALID", "定数値は有限値にしてください。")
                if s.dtype in (pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64):
                    if not float(const_val).is_integer():
                        raise BizError("IMPUTATION_CONSTANT_INVALID", "整数列には整数の定数を指定してください。")
                    const_val = int(const_val)
            else:
                const_val = str(raw_const)
            new_s = s.fill_nan(const_val).fill_null(const_val) if is_float else s.fill_null(const_val)
            new_series_map[c] = new_s
            col_diagnostics[c] = {"imputedCount": null_count, "fillValue": const_val}

        elif strategy == "knn":
            if not is_numeric:
                clean_s = s.drop_nulls()
                mode_val = clean_s.mode()[0] if clean_s.len() > 0 else "UNKNOWN"
                new_series_map[c] = s.fill_null(mode_val)
                col_diagnostics[c] = {"imputedCount": null_count, "fallbackMode": str(mode_val)}
            else:
                arr = s.to_numpy().astype(np.float64)
                k_val = int(opts.get("knn_neighbors", 5))
                imputed_arr = _knn_impute_series(arr, feature_mat, k=k_val)
                if s.dtype in (pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64):
                    imputed_arr = np.round(imputed_arr).astype(np.int64)
                new_s = pl.Series(c, imputed_arr, dtype=s.dtype)
                new_series_map[c] = new_s
                col_diagnostics[c] = {"imputedCount": null_count, "k": k_val}
        else:
            raise BizError("IMPUTATION_UNKNOWN_STRATEGY", f"未知の補完戦略 '{strategy}' です。")

    new_cols = []
    for c in df.columns:
        if c in new_series_map:
            new_cols.append(new_series_map[c])
        else:
            new_cols.append(df[c])

    final_df = pl.DataFrame(new_cols)
    diagnostics = {
        "method": strategy,
        "algorithmVersion": "2.0.0",
        "evidenceClass": "STATISTICAL_IMPUTATION",
        "planHash": plan_hash,
        "predictorColumns": [c for c in (predictors or []) if c in df.columns and c != "__rowId__"],
        "conditioningColumns": list(feature_names) if strategy == "knn" and feature_mat is not None else [],
        "outputColumns": list(valid_cols),
        "imputedCounts": imputed_counts,
        "columns": col_diagnostics,
    }
    return final_df, diagnostics


def preview_imputation(
    df: pl.DataFrame,
    column: str,
    strategy: str = "tabdiff",
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Single-column preview. Kept as the algorithm-level entry point; the API
    goes through ``preview_imputation_plan`` so that what is previewed is
    exactly what gets applied."""
    if column not in df.columns:
        raise BizError("COLUMN_NOT_FOUND", f"列 '{column}' が見つかりません。")

    plan = build_imputation_plan(df, None, [column], [], strategy, options)
    result = preview_imputation_plan(df, plan)
    per_column = result["perColumn"][0]
    return {
        "column": per_column["column"],
        "strategy": strategy,
        "beforeStats": per_column["beforeStats"],
        "afterStats": per_column["afterStats"],
        "histogram": per_column["histogram"],
        "diagnostics": result["diagnostics"],
    }


def preview_imputation_plan(df: pl.DataFrame, plan: ImputationPlan) -> dict[str, Any]:
    """Before/after comparison for every target of ``plan``.

    The whole target set is imputed in a single pass, exactly as the apply
    endpoint will, so the previewed values *are* the applied values.
    """
    imputed_df, diag = impute_dataframe(
        df,
        columns=plan.targetColumns,
        strategy=plan.strategy,
        options=plan.options,
        predictors=plan.predictorColumns,
        plan_hash=plan.planHash,
    )

    per_column = [_column_preview(df, imputed_df, column) for column in plan.targetColumns]
    payload: dict[str, Any] = {
        "planHash": plan.planHash,
        "datasetId": plan.datasetId,
        "dataRevision": plan.dataRevision,
        "strategy": plan.strategy,
        "targetColumns": plan.targetColumns,
        "predictorColumns": plan.predictorColumns,
        "excludedColumns": [e.model_dump() for e in plan.excludedColumns],
        "perColumn": per_column,
        "diagnostics": diag,
        "warnings": plan_warnings(plan, df),
    }
    if per_column:
        # Legacy single-column shape, so an older client keeps working.
        first = per_column[0]
        payload.update({
            "column": first["column"],
            "beforeStats": first["beforeStats"],
            "afterStats": first["afterStats"],
            "histogram": first["histogram"],
        })
    return payload


def _column_preview(df: pl.DataFrame, imputed_df: pl.DataFrame, column: str) -> dict[str, Any]:
    """Before-and-after comparison stats and distribution bins for one column."""
    s = df[column]
    total_count = s.len()
    null_count = s.null_count()
    is_numeric = s.dtype in (
        pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64
    )

    imp_s = imputed_df[column]

    orig_non_null = s.drop_nulls()
    before_stats: dict[str, Any] = {
        "totalCount": total_count,
        "missingCount": null_count,
        "missingPercent": round(null_count / max(1, total_count) * 100, 2),
    }
    after_stats: dict[str, Any] = {
        "totalCount": imp_s.len(),
        "missingCount": imp_s.null_count(),
        "missingPercent": round(imp_s.null_count() / max(1, imp_s.len()) * 100, 2),
    }

    histogram_comparison: list[dict[str, Any]] = []

    if is_numeric and orig_non_null.len() > 0:
        b_vals = orig_non_null.to_numpy().astype(np.float64)
        a_vals = imp_s.to_numpy().astype(np.float64)

        before_stats.update({
            "mean": round(float(np.mean(b_vals)), 4),
            "std": round(float(np.std(b_vals)), 4),
            "min": round(float(np.min(b_vals)), 4),
            "max": round(float(np.max(b_vals)), 4),
            "median": round(float(np.median(b_vals)), 4),
        })
        after_stats.update({
            "mean": round(float(np.mean(a_vals)), 4),
            "std": round(float(np.std(a_vals)), 4),
            "min": round(float(np.min(a_vals)), 4),
            "max": round(float(np.max(a_vals)), 4),
            "median": round(float(np.median(a_vals)), 4),
        })

        # Calculate 10-bin histogram comparisons
        global_min = min(float(np.min(b_vals)), float(np.min(a_vals)))
        global_max = max(float(np.max(b_vals)), float(np.max(a_vals)))
        if global_min == global_max:
            global_max += 1.0

        bins = np.linspace(global_min, global_max, 11)
        b_counts, _ = np.histogram(b_vals, bins=bins)
        a_counts, _ = np.histogram(a_vals, bins=bins)

        for i in range(len(b_counts)):
            histogram_comparison.append({
                "binLabel": f"{bins[i]:.2f} - {bins[i+1]:.2f}",
                "beforeCount": int(b_counts[i]),
                "afterCount": int(a_counts[i]),
                "imputedAdded": int(a_counts[i] - b_counts[i]),
            })
    else:
        # Categorical comparison
        b_counts_dict = dict(orig_non_null.value_counts().iter_rows())
        a_counts_dict = dict(imp_s.value_counts().iter_rows())
        all_keys = sorted(set(b_counts_dict.keys()) | set(a_counts_dict.keys()), key=str)
        for k in all_keys[:20]:
            b_c = b_counts_dict.get(k, 0)
            a_c = a_counts_dict.get(k, 0)
            histogram_comparison.append({
                "binLabel": str(k),
                "beforeCount": int(b_c),
                "afterCount": int(a_c),
                "imputedAdded": int(a_c - b_c),
            })

    return {
        "column": column,
        "beforeStats": before_stats,
        "afterStats": after_stats,
        "histogram": histogram_comparison,
        "valuesHash": column_values_hash(imp_s),
    }
