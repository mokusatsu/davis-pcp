"""Sensitivity & Robustness Analysis Engine (Feature 03).

Quantitatively tests conclusions against data perturbations:
1. Quality-based removal sweep (drop bottom 5%, 10%, 20%, 30% quality).
2. Leave-one-out / Jackknife influence function.
3. Nonparametric bootstrap distribution (95% CI & flip rate).
Computes robustness scorecards, drift, tornado breakdown, and top-influence respondents.
"""
from __future__ import annotations

import datetime
import math
import uuid
from typing import Any
import numpy as np
import polars as pl
from scipy import stats


def evaluate_robustness(
    df: pl.DataFrame,
    conclusions: list[dict[str, Any]] | None = None,
    removal_fractions: list[float] | None = None,
    bootstrap_b: int = 100,
    top_influence_count: int = 10,
    quality_col: str | None = None,
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
    n = df.height

    fractions = removal_fractions or [0.0, 0.05, 0.10, 0.20, 0.30]

    # Compute or locate respondent quality scores (higher = better quality, lower = noisy/anomalous)
    if quality_col and quality_col in df.columns:
        quality_vals = np.array([float(v) if v is not None else 0.0 for v in df[quality_col].to_list()])
    else:
        # Synthesize quality score from numerical deviation / Mahalanobis or variance
        num_cols = [c for c in df.columns if c != actual_row_id and df[c].dtype in (pl.Float32, pl.Float64, pl.Int32, pl.Int64)]
        if num_cols:
            mat = []
            for c in num_cols[:8]:
                col_vals = df[c].to_numpy()
                mask = ~np.isnan(col_vals)
                m = np.mean(col_vals[mask]) if np.sum(mask) > 0 else 0.0
                s = np.std(col_vals[mask]) if np.sum(mask) > 0 else 1.0
                norm_v = np.abs((col_vals - m) / max(1e-6, s))
                norm_v = np.nan_to_num(norm_v, nan=3.0)
                mat.append(norm_v)
            dev = np.mean(np.array(mat), axis=0)
            quality_vals = 1.0 / (1.0 + dev)
        else:
            quality_vals = np.ones(n, dtype=float)

    # Sort respondent indices by quality ascending (low quality first)
    quality_order = np.argsort(quality_vals)

    # If no conclusions given, auto-construct conclusions from dataset
    active_conclusions = conclusions or []
    if not active_conclusions:
        num_cols = [c for c in df.columns if c != actual_row_id and df[c].dtype in (pl.Float32, pl.Float64, pl.Int32, pl.Int64)]
        cat_cols = [c for c in df.columns if c != actual_row_id and c not in num_cols and df[c].n_unique() in range(2, 6)]

        # 1. KPI conclusion on primary numeric column
        if num_cols:
            target = num_cols[0]
            col_data = df[target].drop_nulls().to_numpy()
            active_conclusions.append({
                "id": "c001",
                "type": "kpi",
                "metric": target,
                "label": f"全体の平均{target}",
                "target_col": target,
            })

        # 2. Subgroup diff conclusion
        if num_cols and cat_cols:
            target = num_cols[0]
            group_c = cat_cols[0]
            cats = df[group_c].drop_nulls().unique().to_list()[:2]
            if len(cats) >= 2:
                active_conclusions.append({
                    "id": "c002",
                    "type": "subgroup_diff",
                    "metric": f"{group_c}_diff_{target}",
                    "label": f"{group_c} ({cats[0]} vs {cats[1]}) の{target}差",
                    "target_col": target,
                    "group_col": group_c,
                    "compare_groups": [str(cats[0]), str(cats[1])],
                })

    results: list[dict[str, Any]] = []

    for conc in active_conclusions:
        c_id = conc.get("id", str(uuid.uuid4())[:8])
        c_type = conc.get("type", "kpi")
        target_c = conc.get("target_col") or conc.get("metric", "")
        group_c = conc.get("group_col")
        compare_groups = conc.get("compare_groups")

        # Define evaluation function for this conclusion given row mask
        subgroup_ids_set = set(conc.get("subgroup_row_ids") or [])

        def eval_metric(mask: np.ndarray) -> float:
            sub_df = df_with_id.filter(pl.Series(mask))
            if sub_df.height < 3:
                return 0.0

            if c_type == "subgroup_diff":
                if subgroup_ids_set:
                    current_ids = set(sub_df["__rowId__"].to_list())
                    in_sub_ids = current_ids.intersection(subgroup_ids_set)
                    comp_ids = current_ids - subgroup_ids_set
                    if not in_sub_ids or not comp_ids:
                        return 0.0
                    g1_data = sub_df.filter(pl.col("__rowId__").is_in(list(in_sub_ids)))[target_c].cast(pl.Float64, strict=False).drop_nulls().to_numpy()
                    g2_data = sub_df.filter(pl.col("__rowId__").is_in(list(comp_ids)))[target_c].cast(pl.Float64, strict=False).drop_nulls().to_numpy()
                    m1 = float(np.mean(g1_data)) if len(g1_data) > 0 else 0.0
                    m2 = float(np.mean(g2_data)) if len(g2_data) > 0 else 0.0
                    return float(m1 - m2)
                elif group_c and compare_groups and len(compare_groups) >= 2:
                    g1_data = sub_df.filter(pl.col(group_c).cast(pl.String) == str(compare_groups[0]))[target_c].cast(pl.Float64, strict=False).drop_nulls().to_numpy()
                    g2_data = sub_df.filter(pl.col(group_c).cast(pl.String) == str(compare_groups[1]))[target_c].cast(pl.Float64, strict=False).drop_nulls().to_numpy()
                    m1 = float(np.mean(g1_data)) if len(g1_data) > 0 else 0.0
                    m2 = float(np.mean(g2_data)) if len(g2_data) > 0 else 0.0
                    return float(m1 - m2)
                else:
                    vals = sub_df[target_c].cast(pl.Float64, strict=False).drop_nulls().to_numpy()
                    return float(np.mean(vals)) if len(vals) > 0 else 0.0
            else:
                # KPI mean
                vals = sub_df[target_c].cast(pl.Float64, strict=False).drop_nulls().to_numpy()
                return float(np.mean(vals)) if len(vals) > 0 else 0.0

        # Full sample evaluation
        full_mask = np.ones(n, dtype=bool)
        full_estimate = eval_metric(full_mask)
        scale = abs(full_estimate) if abs(full_estimate) > 1e-4 else 1.0

        perturbations = []
        flipped_count = 0
        total_perturb_count = 0
        max_drift = 0.0

        # Strategy 1: Quality-based removal sweep
        sweep_points = []
        for frac in fractions:
            drop_n = int(round(n * frac))
            mask = np.ones(n, dtype=bool)
            if drop_n > 0:
                drop_indices = quality_order[:drop_n]
                mask[drop_indices] = False

            perturbed_est = eval_metric(mask)
            drift = abs(perturbed_est - full_estimate) / scale
            max_drift = max(max_drift, drift)

            is_flipped = False
            if c_type == "kpi":
                # Flipped if sign changed (when full != 0) or drift > 0.20
                is_flipped = (full_estimate * perturbed_est < 0) or (drift > 0.20)
            else:
                # subgroup diff: flipped if direction reversed or drift > 0.20
                is_flipped = (full_estimate * perturbed_est < 0) or (drift > 0.20)

            if is_flipped:
                flipped_count += 1
            total_perturb_count += 1

            sweep_points.append({
                "fraction": frac,
                "pct_label": f"除去 {int(frac * 100)}%",
                "estimate": round(perturbed_est, 4),
                "drift": round(drift, 4),
                "flipped": is_flipped,
            })

            if frac > 0:
                perturbations.append({
                    "strategy": "quality_removal",
                    "label": f"品質下位{int(frac * 100)}%除去",
                    "param": frac,
                    "estimate": round(perturbed_est, 4),
                    "drift": round(drift, 4),
                    "flipped": is_flipped,
                })

        # Strategy 2: Leave-one-out Jackknife Influence
        # Exact analytic influence function for linear sample statistics
        target_series = df_with_id[target_c].cast(pl.Float64, strict=False).to_numpy()
        influences = []

        if c_type == "kpi":
            # For mean: influence of respondent i is (x_i - mean) / (n - 1)
            # so that full_estimate - influence = mean_{-i}
            valid_indices = [i for i, v in enumerate(target_series) if not np.isnan(v)]
            v_arr = target_series[valid_indices]
            mean_v = float(np.mean(v_arr)) if len(v_arr) > 0 else 0.0
            n_v = len(v_arr)
            diffs = (v_arr - mean_v) / max(1, n_v - 1)

            for idx, inf in zip(valid_indices, diffs):
                influences.append({
                    "row_id": all_row_ids[idx],
                    "raw_value": float(target_series[idx]),
                    "influence": float(inf),
                    "abs_influence": float(abs(inf)),
                })
        else:
            # Subgroup diff: exact analytic influence function
            # delta = (m1 - m2) - (m1_{-i} - m2) = (x_i - m1) / (n1 - 1) for i in G1
            # delta = (m1 - m2) - (m1 - m2_{-i}) = (m2 - x_i) / (n2 - 1) for i in G2
            if subgroup_ids_set:
                g1_indices = [i for i, (rid, v) in enumerate(zip(all_row_ids, target_series)) if rid in subgroup_ids_set and not np.isnan(v)]
                g2_indices = [i for i, (rid, v) in enumerate(zip(all_row_ids, target_series)) if rid not in subgroup_ids_set and not np.isnan(v)]
            else:
                g_series = [str(x) if x is not None else "" for x in df_with_id[group_c].to_list()] if group_c else []
                g1_target = str(compare_groups[0]) if compare_groups else ""
                g2_target = str(compare_groups[1]) if compare_groups and len(compare_groups) > 1 else ""

                g1_indices = [i for i, (g, v) in enumerate(zip(g_series, target_series)) if g == g1_target and not np.isnan(v)]
                g2_indices = [i for i, (g, v) in enumerate(zip(g_series, target_series)) if g == g2_target and not np.isnan(v)]
            n1 = len(g1_indices)
            n2 = len(g2_indices)
            m1 = float(np.mean(target_series[g1_indices])) if n1 > 0 else 0.0
            m2 = float(np.mean(target_series[g2_indices])) if n2 > 0 else 0.0

            for idx in g1_indices:
                x_i = float(target_series[idx])
                delta = (x_i - m1) / max(1, n1 - 1)
                influences.append({
                    "row_id": all_row_ids[idx],
                    "raw_value": x_i,
                    "influence": float(delta),
                    "abs_influence": float(abs(delta)),
                })
            for idx in g2_indices:
                x_i = float(target_series[idx])
                delta = (m2 - x_i) / max(1, n2 - 1)
                influences.append({
                    "row_id": all_row_ids[idx],
                    "raw_value": x_i,
                    "influence": float(delta),
                    "abs_influence": float(abs(delta)),
                })

        influences.sort(key=lambda x: x["abs_influence"], reverse=True)
        top_influential = influences[:top_influence_count]
        max_influence_val = top_influential[0]["abs_influence"] if top_influential else 0.0

        perturbations.append({
            "strategy": "jackknife",
            "label": "最大個別影響回答者除外",
            "param": "single_drop",
            "estimate": round(full_estimate - (top_influential[0]["influence"] if top_influential else 0.0), 4),
            "drift": round(max_influence_val / scale, 4),
            "flipped": (max_influence_val / scale) > 0.15,
        })
        if (max_influence_val / scale) > 0.15:
            flipped_count += 1
        total_perturb_count += 1

        # Strategy 3: Nonparametric Bootstrap
        np.random.seed(42)
        boot_estimates = []
        for _ in range(bootstrap_b):
            resample_idx = np.random.choice(n, size=n, replace=True)
            if c_type == "kpi":
                v_arr = target_series[resample_idx]
                v_arr = v_arr[~np.isnan(v_arr)]
                boot_estimates.append(float(np.mean(v_arr)) if len(v_arr) > 0 else full_estimate)
            else:
                # Subgroup sample using actual resampled distribution
                if subgroup_ids_set:
                    resample_rids = [all_row_ids[i] for i in resample_idx]
                    resample_v = target_series[resample_idx]
                    g1_b = [v for rid, v in zip(resample_rids, resample_v) if rid in subgroup_ids_set and not np.isnan(v)]
                    g2_b = [v for rid, v in zip(resample_rids, resample_v) if rid not in subgroup_ids_set and not np.isnan(v)]
                else:
                    resample_g = [g_series[i] for i in resample_idx] if group_c else []
                    resample_v = target_series[resample_idx]
                    g1_b = [v for g, v in zip(resample_g, resample_v) if g == g1_target and not np.isnan(v)]
                    g2_b = [v for g, v in zip(resample_g, resample_v) if g == g2_target and not np.isnan(v)]
                m1_b = float(np.mean(g1_b)) if len(g1_b) > 0 else full_estimate
                m2_b = float(np.mean(g2_b)) if len(g2_b) > 0 else 0.0
                boot_estimates.append(float(m1_b - m2_b))

        boot_arr = np.array(boot_estimates)
        ci_lower = float(np.percentile(boot_arr, 2.5))
        ci_upper = float(np.percentile(boot_arr, 97.5))
        
        boot_flips = sum(1 for b_est in boot_arr if (full_estimate * b_est < 0) or (abs(b_est - full_estimate) / scale > 0.20))
        boot_flip_rate = boot_flips / max(1, bootstrap_b)
        flipped_count += int(boot_flip_rate * 5)
        total_perturb_count += 5

        perturbations.append({
            "strategy": "bootstrap_ci_lower",
            "label": "ブートストラップ 95%CI 下限",
            "param": "2.5%",
            "estimate": round(ci_lower, 4),
            "drift": round(abs(ci_lower - full_estimate) / scale, 4),
            "flipped": (full_estimate * ci_lower < 0),
        })
        perturbations.append({
            "strategy": "bootstrap_ci_upper",
            "label": "ブートストラップ 95%CI 上限",
            "param": "97.5%",
            "estimate": round(ci_upper, 4),
            "drift": round(abs(ci_upper - full_estimate) / scale, 4),
            "flipped": (full_estimate * ci_upper < 0),
        })

        # Robustness metrics & grade
        flip_rate = flipped_count / max(1, total_perturb_count)
        if flip_rate == 0:
            grade = "robust"
            grade_label = "頑健 (Robust)"
        elif flip_rate <= 0.10:
            grade = "mostly_robust"
            grade_label = "概ね頑健 (Mostly Robust)"
        elif flip_rate <= 0.25:
            grade = "somewhat_sensitive"
            grade_label = "やや敏感 (Somewhat Sensitive)"
        else:
            grade = "fragile"
            grade_label = "脆い (Fragile)"

        results.append({
            "id": c_id,
            "type": c_type,
            "label": conc.get("label") or f"{target_c} ({c_type})",
            "target_col": target_c,
            "group_col": group_c,
            "full_estimate": round(full_estimate, 4),
            "ci_95": [round(ci_lower, 4), round(ci_upper, 4)],
            "robustness": {
                "grade": grade,
                "grade_label": grade_label,
                "flip_rate": round(flip_rate, 3),
                "max_drift": round(max_drift, 3),
                "bootstrap_se": round(float(np.std(boot_arr)), 4),
            },
            "perturbations": perturbations,
            "sweep_curve": sweep_points,
            "top_influence_respondents": top_influential,
        })

    return {
        "run_id": str(uuid.uuid4()),
        "generated_at": datetime.datetime.now().isoformat(),
        "config": {
            "removal_fractions": fractions,
            "bootstrap_b": bootstrap_b,
            "top_influence_count": top_influence_count,
        },
        "conclusions": results,
    }
