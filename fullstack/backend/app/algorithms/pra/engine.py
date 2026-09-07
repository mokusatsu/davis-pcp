"""Penalty-Reward Analysis (PRA) Engine (Feature 05).

Estimates asymmetric impacts of product/service attributes via dummy-variable regression,
classifies attributes into 3 Kano factors (Basic, Performance, Excitement, Indifferent),
runs Wald asymmetry hypothesis testing, and extracts dissatisfied customer segments.
"""
from __future__ import annotations

import datetime
import math
import uuid
from typing import Any
import numpy as np
import polars as pl
from scipy import stats


def evaluate_penalty_reward(
    df: pl.DataFrame,
    outcome: str,
    attributes: list[str] | None = None,
    column_meta: list[dict[str, Any]] | None = None,
    scale_min: float | None = None,
    scale_max: float | None = None,
    neutral_point: float | None = None,
    alpha: float = 0.05,
) -> dict[str, Any]:
    # Determine row ID column
    row_id_col = "__rowId__" if "__rowId__" in df.columns else None
    if not row_id_col:
        for c in ["id", "ID", "row_id", "rowId"]:
            if c in df.columns:
                row_id_col = c
                break

    all_row_ids = [str(r) for r in df[row_id_col].to_list()] if row_id_col else [str(i) for i in range(df.height)]
    actual_row_id = row_id_col or "__rowId__"
    df_with_id = df if row_id_col else df.with_columns(pl.Series("__rowId__", all_row_ids))

    # Meta lookup
    meta_by_col: dict[str, dict[str, Any]] = {}
    if column_meta:
        for m in column_meta:
            if m.get("columnId"):
                meta_by_col[m["columnId"]] = m
            if m.get("name"):
                meta_by_col[m["name"]] = m

    # Select attribute candidates if not given
    actual_attrs = attributes or []
    if not actual_attrs:
        for c in df.columns:
            if c != outcome and c != actual_row_id:
                if df[c].dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64):
                    actual_attrs.append(c)
        actual_attrs = actual_attrs[:8]

    if not actual_attrs or outcome not in df.columns:
        raise ValueError(f"Outcome {outcome} or attributes not valid.")

    needed_cols = [actual_row_id, outcome] + actual_attrs
    sub_df = df_with_id.select(needed_cols).drop_nulls()
    n_valid = sub_df.height
    if n_valid < len(actual_attrs) * 2 + 5:
        raise ValueError("有効行数が属性ダミーの回帰に必要なサンプル数を満たしていません。")

    y = sub_df[outcome].to_numpy().astype(float)
    row_ids = sub_df[actual_row_id].to_list()

    # Determine scale cutoffs
    # Default 5-point Likert: low <= 2, high >= 4, neutral = 3
    # If not 5-point, determine by quantiles (low <= 33th percentile, high >= 67th percentile)
    dummy_cols = []
    dummy_names = []
    attr_cutoffs = {}
    dissatisfied_row_ids: dict[str, list[str]] = {}

    for attr in actual_attrs:
        col_vals = sub_df[attr].to_numpy().astype(float)
        mn = scale_min if scale_min is not None else float(np.min(col_vals))
        mx = scale_max if scale_max is not None else float(np.max(col_vals))

        if scale_min is not None and scale_max is not None and neutral_point is not None:
            low_cutoff = neutral_point - 0.5
            high_cutoff = neutral_point + 0.5
        elif mx <= 5.5 and mn >= 0.5:
            # Standard 5-point scale
            low_cutoff = 2.5
            high_cutoff = 3.5
        elif mx <= 7.5 and mn >= 0.5:
            # 7-point scale
            low_cutoff = 3.5
            high_cutoff = 4.5
        else:
            # Quantile cutoffs (33% and 66%)
            low_cutoff = float(np.percentile(col_vals, 33.3))
            high_cutoff = float(np.percentile(col_vals, 66.7))

        attr_cutoffs[attr] = (low_cutoff, high_cutoff)

        low_dummy = (col_vals <= low_cutoff).astype(float)
        high_dummy = (col_vals >= high_cutoff).astype(float)

        dummy_cols.append(low_dummy)
        dummy_names.append((attr, "low"))
        dummy_cols.append(high_dummy)
        dummy_names.append((attr, "high"))

        # Dissatisfied respondents for this attribute
        dissatisfied_ids = [rid for rid, is_low in zip(row_ids, low_dummy) if is_low == 1.0]
        dissatisfied_row_ids[attr] = dissatisfied_ids

    # Assemble X design matrix: [1, Low_1, High_1, Low_2, High_2, ...]
    X_mat = np.column_stack([np.ones(n_valid)] + dummy_cols)
    p_vars = X_mat.shape[1]

    # Standardized outcome for comparability
    y_mean = float(np.mean(y))
    y_std = float(np.std(y, ddof=1)) if float(np.std(y, ddof=1)) > 1e-6 else 1.0
    y_stdzd = (y - y_mean) / y_std

    # OLS estimation: (X^T X)^{-1} X^T y
    try:
        inv_xtx = np.linalg.pinv(X_mat.T @ X_mat)
        betas = inv_xtx @ (X_mat.T @ y_stdzd)
        y_pred = X_mat @ betas
        residuals = y_stdzd - y_pred
        df_e = max(1, n_valid - p_vars)
        sigma2 = float(np.sum(residuals**2) / df_e)
        cov_matrix = sigma2 * inv_xtx
        se_betas = np.sqrt(np.maximum(1e-9, np.diag(cov_matrix)))
    except Exception:
        betas = np.zeros(p_vars)
        cov_matrix = np.eye(p_vars)
        se_betas = np.ones(p_vars)

    # Calculate model R²
    ss_res = float(np.sum((y_stdzd - X_mat @ betas)**2))
    ss_tot = float(np.sum((y_stdzd - np.mean(y_stdzd))**2))
    r_squared = max(0.0, min(1.0, 1.0 - (ss_res / max(1e-9, ss_tot))))

    attributes_out = []
    all_basic_dissatisfied: set[str] = set()

    for idx, attr in enumerate(actual_attrs):
        low_idx = 1 + idx * 2
        high_idx = 1 + idx * 2 + 1

        b_low = float(betas[low_idx])
        se_low = float(se_betas[low_idx])
        t_low = b_low / max(1e-9, se_low)
        # one-sided / two-sided p-value
        p_low = float(2.0 * (1.0 - stats.norm.cdf(abs(t_low))))

        b_high = float(betas[high_idx])
        se_high = float(se_betas[high_idx])
        t_high = b_high / max(1e-9, se_high)
        p_high = float(2.0 * (1.0 - stats.norm.cdf(abs(t_high))))

        # Wald Asymmetry Test: test H0: |b_high| = |b_low|
        # For b_low <= 0, |b_low| = -b_low; for b_high >= 0, |b_high| = b_high
        c_high = 1.0 if b_high >= 0 else -1.0
        c_low = 1.0 if b_low <= 0 else -1.0
        cov_lh = float(cov_matrix[low_idx, high_idx])
        var_sum = max(1e-9, (c_high * se_high)**2 + (c_low * se_low)**2 + 2.0 * c_high * c_low * cov_lh)
        se_asym = math.sqrt(var_sum)
        contrast_val = c_high * b_high + c_low * b_low
        asym_stat = contrast_val / max(1e-9, se_asym)
        asym_p = float(2.0 * (1.0 - stats.norm.cdf(abs(asym_stat))))
        asymmetry_val = abs(b_high) - abs(b_low)

        # Kano Classification Rule
        # Basic: |b_low| significantly dominates (b_low significantly negative, and asymmetry < 0)
        # Excitement: b_high significantly dominates (b_high significantly positive, and asymmetry > 0)
        # Performance: both significant, symmetric
        # Indifferent: neither significant
        is_low_sig = (p_low < alpha) and (b_low < 0)
        is_high_sig = (p_high < alpha) and (b_high > 0)

        if is_low_sig and (not is_high_sig or (asym_p < 0.15 and asymmetry_val < 0)):
            classification = "basic"
            class_label = "当たり前品質 (Basic / Must-be)"
            narrative = f"「{attr}」は当たり前品質（不満防止要因）です。不足時の不満ペナルティ ({b_low:.2f}) が充足時のリワード ({b_high:.2f}) を大きく上回ります。まず最低水準の徹底確保を最優先してください。"
            all_basic_dissatisfied.update(dissatisfied_row_ids[attr])
        elif is_high_sig and (not is_low_sig or (asym_p < 0.15 and asymmetry_val > 0)):
            classification = "excitement"
            class_label = "魅力的品質 (Excitement / Delighter)"
            narrative = f"「{attr}」は魅力的品質（感動要因）です。不足しても不満になりにくい一方、充足時のリワード ({b_high:.2f}) が突出しています。他社差別化の重点投資領域です。"
        elif is_low_sig and is_high_sig:
            classification = "performance"
            class_label = "一元的品質 (Performance / Linear)"
            narrative = f"「{attr}」は一元的品質です。充足度と満足度が対称的に連動します（ペナルティ {b_low:.2f}, リワード {b_high:.2f}）。改善がリニアに満足度向上へ直結します。"
        else:
            classification = "indifferent"
            class_label = "無関心要因 (Indifferent)"
            narrative = f"「{attr}」は現状、全体満足度への影響が限定的な要因です（両係数とも統計的に非有意）。"

        attr_label = meta_by_col.get(attr, {}).get("label") or attr

        attributes_out.append({
            "name": attr,
            "label": attr_label,
            "penalty": {
                "coef": round(b_low, 4),
                "se": round(se_low, 4),
                "p": round(p_low, 4),
                "ci": [round(b_low - 1.96 * se_low, 4), round(b_low + 1.96 * se_low, 4)],
            },
            "reward": {
                "coef": round(b_high, 4),
                "se": round(se_high, 4),
                "p": round(p_high, 4),
                "ci": [round(b_high - 1.96 * se_high, 4), round(b_high + 1.96 * se_high, 4)],
            },
            "asymmetry": round(asymmetry_val, 4),
            "asym_p": round(asym_p, 4),
            "classification": classification,
            "class_label": class_label,
            "n_dissatisfied": len(dissatisfied_row_ids[attr]),
            "dissatisfied_row_ids": dissatisfied_row_ids[attr],
            "narrative": narrative,
        })

    # Sort attributes: Basic first (highest penalty), then Performance, Excitement, Indifferent
    priority_order = {"basic": 1, "performance": 2, "excitement": 3, "indifferent": 4}
    attributes_out.sort(key=lambda a: (priority_order[a["classification"]], -abs(a["penalty"]["coef"])))

    return {
        "run_id": str(uuid.uuid4()),
        "generated_at": datetime.datetime.now().isoformat(),
        "outcome": {
            "name": outcome,
            "label": meta_by_col.get(outcome, {}).get("label") or outcome,
            "type": "numeric",
        },
        "scale": {
            "min": scale_min,
            "max": scale_max,
            "neutral": neutral_point,
        },
        "model": {
            "r_squared": round(r_squared, 4),
            "n_valid": n_valid,
            "alpha": alpha,
            "warnings": [],
        },
        "attributes": attributes_out,
        "all_basic_dissatisfied_row_ids": sorted(list(all_basic_dissatisfied)),
    }
