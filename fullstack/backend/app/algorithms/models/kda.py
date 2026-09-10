"""Key Driver Analysis (KDA) Engine using Shapley value decomposition (Feature 04).

Decomposes model R² across all drivers via exact Shapley/LMG algorithm,
computes multicollinearity (VIF), standardized regression coefficients,
contrasts true impact vs simple correlation, and supports what-if simulation.
"""
from __future__ import annotations

import itertools
import math
import uuid
from typing import Any
import numpy as np
import polars as pl
from scipy import stats


def run_kda(
    df: pl.DataFrame,
    outcome: str,
    drivers: list[str] | None = None,
    column_meta: list[dict[str, Any]] | None = None,
    method: str = "shapley_lmg",
    max_exact_drivers: int = 12,
    n_sample_permutations: int = 500,
) -> dict[str, Any]:
    # Meta lookup
    meta_by_col: dict[str, dict[str, Any]] = {}
    if column_meta:
        for m in column_meta:
            if m.get("columnId"):
                meta_by_col[m["columnId"]] = m
            if m.get("name"):
                meta_by_col[m["name"]] = m

    # Filter out outcome and get numeric columns if drivers not given
    actual_drivers = drivers or []
    if not actual_drivers:
        for c in df.columns:
            if c != outcome and c not in ("__rowId__", "id", "ID", "row_id", "rowId"):
                if df[c].dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64):
                    actual_drivers.append(c)
        actual_drivers = actual_drivers[:10]  # default top 10

    if not actual_drivers or outcome not in df.columns:
        raise ValueError(f"Outcome {outcome} or drivers not valid in dataframe.")

    # Drop nulls across outcome and drivers (listwise deletion)
    needed_cols = [outcome] + actual_drivers
    sub_df = df.select(needed_cols).drop_nulls()
    n_valid = sub_df.height
    if n_valid < len(actual_drivers) + 2:
        raise ValueError("有効行数が説明変数の数に対して不足しています。")

    y = sub_df[outcome].to_numpy().astype(float)
    X = sub_df.select(actual_drivers).to_numpy().astype(float)
    k = len(actual_drivers)
    if float(np.std(y, ddof=1)) <= 1e-9 if n_valid > 1 else True:
        raise ValueError("目的変数にばらつきがないため重要度を算定できません。(NO_TARGET_VARIATION)")

    # Standardize X and y
    y_mean = float(np.mean(y))
    y_std = float(np.std(y, ddof=1)) if float(np.std(y, ddof=1)) > 1e-9 else 1.0
    y_norm = (y - y_mean) / y_std

    X_means = np.mean(X, axis=0)
    X_stds = np.std(X, axis=0, ddof=1)
    X_stds[X_stds < 1e-9] = 1.0
    X_norm = (X - X_means) / X_stds

    # Compute correlation with y
    pearson_rs = []
    for j in range(k):
        try:
            r_val, _ = stats.pearsonr(X[:, j], y)
            pearson_rs.append(round(float(r_val), 4) if not math.isnan(r_val) else 0.0)
        except Exception:
            pearson_rs.append(0.0)

    # Full standardized OLS regression: y_norm = X_norm * beta
    # Add intercept for stability (even though centered, lstsq handles constant)
    X_design = np.column_stack([np.ones(n_valid), X_norm])
    try:
        coefs, residuals, rank, s = np.linalg.lstsq(X_design, y_norm, rcond=None)
        std_betas = coefs[1:]
        # Unstandardized slopes for what-if simulation: beta_raw_j = std_beta_j * (y_std / x_std_j)
        raw_slopes = std_betas * (y_std / X_stds)
    except Exception:
        std_betas = np.zeros(k)
        raw_slopes = np.zeros(k)

    def calc_r2(feature_indices: tuple[int, ...]) -> float:
        if not feature_indices:
            return 0.0
        X_sub = np.column_stack([np.ones(n_valid), X_norm[:, feature_indices]])
        try:
            c_sub, _, _, _ = np.linalg.lstsq(X_sub, y_norm, rcond=None)
            y_pred = X_sub @ c_sub
            ss_res = np.sum((y_norm - y_pred)**2)
            ss_tot = np.sum((y_norm - np.mean(y_norm))**2)
            r2 = 1.0 - (ss_res / max(1e-9, ss_tot))
            return max(0.0, min(1.0, float(r2)))
        except Exception:
            return 0.0

    full_r2 = calc_r2(tuple(range(k)))

    # Compute VIF for each driver: VIF_j = 1 / (1 - R_j^2)
    vifs = []
    zero_variance_drivers = [actual_drivers[idx] for idx, s in enumerate(X_stds) if np.std(X[:, idx]) < 1e-9]
    for j in range(k):
        if np.std(X[:, j]) < 1e-9:
            vifs.append(1.0)
            continue
        other_indices = tuple(i for i in range(k) if i != j)
        if not other_indices:
            vifs.append(1.0)
            continue
        X_others = np.column_stack([np.ones(n_valid), X_norm[:, other_indices]])
        try:
            c_other, _, _, _ = np.linalg.lstsq(X_others, X_norm[:, j], rcond=None)
            pred_xj = X_others @ c_other
            ss_res_j = np.sum((X_norm[:, j] - pred_xj)**2)
            ss_tot_j = np.sum(X_norm[:, j]**2)
            r2_j = 1.0 - (ss_res_j / max(1e-9, ss_tot_j))
            vif_j = 1.0 / max(1e-4, 1.0 - r2_j)
            vifs.append(round(float(vif_j), 2))
        except Exception:
            vifs.append(1.0)

    vif_max = max(vifs) if vifs else 1.0

    # Shapley / LMG decomposition
    shapley_values = np.zeros(k, dtype=float)

    if k <= max_exact_drivers:
        # Precompute R2 for all subsets
        r2_cache: dict[tuple[int, ...], float] = {}
        for size in range(k + 1):
            for combo in itertools.combinations(range(k), size):
                r2_cache[combo] = calc_r2(combo)

        # Shapley weight formula: |S|! (k - |S| - 1)! / k!
        fact_k = math.factorial(k)
        for j in range(k):
            others = [i for i in range(k) if i != j]
            phi_j = 0.0
            for size in range(k):
                w_s = (math.factorial(size) * math.factorial(k - size - 1)) / fact_k
                for S in itertools.combinations(others, size):
                    S_with_j = tuple(sorted(S + (j,)))
                    marginal = r2_cache[S_with_j] - r2_cache[S]
                    phi_j += w_s * marginal
            shapley_values[j] = max(0.0, phi_j)
    else:
        # Sampling permutation approximation
        np.random.seed(42)
        n_samples = min(n_sample_permutations, 500)
        phi_sum = np.zeros(k, dtype=float)
        for _ in range(n_samples):
            perm = np.random.permutation(k)
            prev_r2 = 0.0
            curr_subset: list[int] = []
            for item in perm:
                curr_subset.append(item)
                curr_r2 = calc_r2(tuple(sorted(curr_subset)))
                phi_sum[item] += max(0.0, curr_r2 - prev_r2)
                prev_r2 = curr_r2
        shapley_values = phi_sum / n_samples

    # Normalize Shapley percentages; zero total explanatory power stays zero
    # instead of fabricating an even 100% split.
    sum_shapley = np.sum(shapley_values)
    if sum_shapley > 1e-6:
        importance_pcts = (shapley_values / sum_shapley) * 100.0
    else:
        importance_pcts = np.zeros(k)
        warnings_explain_none = True
    warnings = []
    if sum_shapley <= 1e-6:
        warnings.append("説明力がほぼゼロのため重要度は0%として返します。最優先ドライバーは提示しません。")

    # Rank drivers and generate diagnostic notes
    drivers_out = []
    # Rank by Shapley % desc
    shap_rank_order = np.argsort(-importance_pcts)
    corr_rank_order = np.argsort(-np.abs(np.array(pearson_rs)))

    shap_ranks = {idx: rank for rank, idx in enumerate(shap_rank_order)}
    corr_ranks = {idx: rank for rank, idx in enumerate(corr_rank_order)}

    if zero_variance_drivers:
        warnings.append(f"分散が0のドライバーが含まれています: {', '.join(zero_variance_drivers)}")
    if vif_max > 10.0:
        warnings.append(f"最大VIFが {vif_max:.1f} と高く、強い多重共線性が存在します。Shapley重要度により共線性影響を補正済みです。")

    for j in range(k):
        d_name = actual_drivers[j]
        d_label = meta_by_col.get(d_name, {}).get("label") or d_name
        s_rank = shap_ranks[j]
        c_rank = corr_ranks[j]

        note = "主因"
        if sum_shapley <= 1e-6:
            note = "説明力なし"
        elif c_rank < s_rank - 1:
            note = "⚠️見かけの相関（共線性により真の寄与は控えめ）"
        elif s_rank < c_rank - 1:
            note = "💎隠れた重要ドライバー（相関以上の貢献度）"
        elif importance_pcts[j] > 25.0:
            note = "最優先キードライバー"

        drivers_out.append({
            "name": d_name,
            "label": d_label,
            "importance_raw": round(float(shapley_values[j]), 4),
            "importance_pct": round(float(importance_pcts[j]), 2),
            "direction": 1 if std_betas[j] >= 0 else -1,
            "standardized_coef": round(float(std_betas[j]), 4),
            "raw_slope": round(float(raw_slopes[j]), 4),
            "pearson_r": pearson_rs[j],
            "vif": vifs[j],
            "note": note,
        })

    # Sort drivers descending by importance_pct
    drivers_out.sort(key=lambda d: d["importance_pct"], reverse=True)

    return {
        "run_id": str(uuid.uuid4()),
        "method": method,
        "outcome": {
            "name": outcome,
            "label": meta_by_col.get(outcome, {}).get("label") or outcome,
            "type": "numeric",
        },
        "model": {
            "r_squared": round(full_r2, 4),
            "n_valid": n_valid,
            "vif_max": vif_max,
            "warnings": warnings,
        },
        "drivers": drivers_out,
        "what_if_baseline": {
            "outcome_mean": round(y_mean, 4),
            "driver_means": {d: round(float(m), 4) for d, m in zip(actual_drivers, X_means)},
            "raw_slopes": {d: round(float(s), 4) for d, s in zip(actual_drivers, raw_slopes)},
        },
    }
