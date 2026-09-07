"""Surprise-First Association Scoring Engine (Feature 02).

Computes unified association (Phik / Cramér's V with sample bias correction),
calculates strength vs unexpectedness (empirical baseline + cell lift),
and outputs quadrant scatter, clustered Phik matrix, and top-lift row links.
"""
from __future__ import annotations

import datetime
import math
import uuid
from typing import Any
import numpy as np
import polars as pl
from scipy import stats
from scipy.cluster.hierarchy import linkage, leaves_list
from scipy.spatial.distance import squareform


def compute_phik_and_surprise(
    df: pl.DataFrame,
    columns: list[str] | None = None,
    column_meta: list[dict[str, Any]] | None = None,
    primary_measure: str = "phik",
    unexpectedness_mode: str = "combined",  # "empirical" | "lift" | "combined"
    w_strength: float = 0.5,
    w_unexpected: float = 0.5,
    max_lift_cap: float = 5.0,
    min_n: int = 5,
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

    target_cols = columns or [c for c in df.columns if c != actual_row_id]
    # Filter out columns with 0 variance or all null
    valid_cols = []
    for c in target_cols:
        s = df[c].drop_nulls()
        if s.len() >= min_n and s.n_unique() > 1:
            valid_cols.append(c)

    p = len(valid_cols)
    if p < 2:
        return {
            "run_id": str(uuid.uuid4()),
            "generated_at": datetime.datetime.now().isoformat(),
            "config": {
                "primary_measure": primary_measure,
                "unexpectedness_mode": unexpectedness_mode,
                "w_strength": w_strength,
                "w_unexpected": w_unexpected,
                "max_lift_cap": max_lift_cap,
            },
            "pairs": [],
            "pair_matrix": {"columns": valid_cols, "matrix": []},
        }

    # Pre-bin continuous variables into discrete labels
    binned_data: dict[str, list[str]] = {}
    numeric_data: dict[str, np.ndarray | None] = {}
    col_types: dict[str, str] = {}

    for c in valid_cols:
        series = df_with_id[c]
        meta = meta_by_col.get(c, {})
        sem_type = meta.get("semanticType")
        if not sem_type:
            if series.dtype in (pl.Float32, pl.Float64):
                sem_type = "numeric"
            elif series.dtype in (pl.Int8, pl.Int16, pl.Int32, pl.Int64):
                sem_type = "numeric" if series.n_unique() > 8 else "ordinal"
            else:
                sem_type = "categorical"
        col_types[c] = sem_type

        # Extract values
        raw_vals = series.to_list()
        if sem_type == "numeric":
            num_arr = np.array([float(v) if v is not None and not math.isnan(float(v)) else np.nan for v in raw_vals])
            numeric_data[c] = num_arr
            valid_mask = ~np.isnan(num_arr)
            if np.sum(valid_mask) >= min_n:
                # 5-quantile bins
                valid_vals = num_arr[valid_mask]
                try:
                    quantiles = np.quantile(valid_vals, np.linspace(0, 1, 6))
                    # deduplicate bins
                    quantiles = np.unique(quantiles)
                    if len(quantiles) > 2:
                        bin_indices = np.digitize(num_arr, quantiles[1:-1])
                        binned_data[c] = [f"Q{b+1}" if not np.isnan(v) else "欠損" for b, v in zip(bin_indices, num_arr)]
                    else:
                        binned_data[c] = [str(v) if not np.isnan(v) else "欠損" for v in num_arr]
                except Exception:
                    binned_data[c] = [str(v) if not np.isnan(v) else "欠損" for v in num_arr]
            else:
                binned_data[c] = [str(v) if not np.isnan(v) else "欠損" for v in num_arr]
        else:
            numeric_data[c] = None
            binned_data[c] = [str(v) if v is not None else "欠損" for v in raw_vals]

    # Compute pair associations
    pairs_list: list[dict[str, Any]] = []
    # Matrix for heatmap
    phik_matrix = np.zeros((p, p), dtype=float)
    np.fill_diagonal(phik_matrix, 1.0)

    for i in range(p):
        col_x = valid_cols[i]
        bx = binned_data[col_x]
        nx = numeric_data[col_x]
        tx = col_types[col_x]

        for j in range(i + 1, p):
            col_y = valid_cols[j]
            by = binned_data[col_y]
            ny = numeric_data[col_y]
            ty = col_types[col_y]

            # Build contingency table
            categories_x = sorted(list(set(v for v in bx if v != "欠損")))
            categories_y = sorted(list(set(v for v in by if v != "欠損")))

            if len(categories_x) < 2 or len(categories_y) < 2:
                continue

            # Mapping
            map_x = {v: k for k, v in enumerate(categories_x)}
            map_y = {v: k for k, v in enumerate(categories_y)}
            obs = np.zeros((len(categories_x), len(categories_y)), dtype=int)
            cell_row_ids: dict[tuple[int, int], list[str]] = {}

            valid_count = 0
            for idx, (vx, vy, rid) in enumerate(zip(bx, by, all_row_ids)):
                if vx in map_x and vy in map_y:
                    kx = map_x[vx]
                    ky = map_y[vy]
                    obs[kx, ky] += 1
                    cell_key = (kx, ky)
                    if cell_key not in cell_row_ids:
                        cell_row_ids[cell_key] = []
                    cell_row_ids[cell_key].append(rid)
                    valid_count += 1

            if valid_count < min_n:
                continue

            # Chi-square and Phik
            try:
                chi2_res = stats.chi2_contingency(obs)
                chi2_stat = float(chi2_res.statistic)
                expected = chi2_res.expected_freq
            except Exception:
                chi2_stat = 0.0
                expected = np.ones_like(obs)

            r, c = obs.shape
            df_min = min(r - 1, c - 1)
            raw_v = math.sqrt(chi2_stat / max(1e-9, valid_count * df_min)) if df_min > 0 else 0.0

            # Finite-sample bias correction
            noise_thresh = math.sqrt(((r - 1) * (c - 1)) / max(1e-9, valid_count * df_min)) if df_min > 0 else 0.0
            corrected_v = max(0.0, raw_v - 0.5 * noise_thresh)
            corrected_v = min(1.0, corrected_v)

            # Sign recovery
            sign = 1.0
            signed_phik = corrected_v
            spearman_rho = None
            pearson_r = None
            kendall_tau = None
            corr_ratio = None

            if nx is not None and ny is not None:
                valid_mask = (~np.isnan(nx)) & (~np.isnan(ny))
                if np.sum(valid_mask) >= min_n:
                    vx_num = nx[valid_mask]
                    vy_num = ny[valid_mask]
                    try:
                        pr, _ = stats.pearsonr(vx_num, vy_num)
                        pearson_r = round(float(pr), 4) if not math.isnan(pr) else 0.0
                    except Exception:
                        pearson_r = 0.0
                    try:
                        sr, _ = stats.spearmanr(vx_num, vy_num)
                        spearman_rho = round(float(sr), 4) if not math.isnan(sr) else 0.0
                        if spearman_rho < 0:
                            sign = -1.0
                    except Exception:
                        spearman_rho = 0.0
                    try:
                        kt, _ = stats.kendalltau(vx_num, vy_num)
                        kendall_tau = round(float(kt), 4) if not math.isnan(kt) else 0.0
                    except Exception:
                        kendall_tau = 0.0
            elif nx is not None or ny is not None:
                # Correlation ratio eta
                num_col = nx if nx is not None else ny
                cat_col = by if nx is not None else bx
                valid_pairs = [(v, c) for v, c in zip(num_col, cat_col) if not math.isnan(v) and c != "欠損"]
                if len(valid_pairs) >= min_n:
                    all_vals = [p[0] for p in valid_pairs]
                    grand_mean = np.mean(all_vals)
                    cat_groups: dict[str, list[float]] = {}
                    for v, cat in valid_pairs:
                        cat_groups.setdefault(cat, []).append(v)
                    ss_between = sum(len(g) * (np.mean(g) - grand_mean)**2 for g in cat_groups.values())
                    ss_total = sum((v - grand_mean)**2 for v in all_vals)
                    corr_ratio = round(math.sqrt(ss_between / max(1e-9, ss_total)), 4)

            signed_phik = round(sign * corrected_v, 4)
            phik_matrix[i, j] = signed_phik
            phik_matrix[j, i] = signed_phik

            # Calculate Lift across cells
            # lift_ij = (obs_ij / N) / ((R_i / N) * (C_j / N)) = obs_ij / expected_ij
            max_lift = 1.0
            top_lift_cell = ""
            top_lift_rids: list[str] = []
            top_p_obs = 0.0
            top_p_exp = 0.0

            for kx in range(r):
                for ky in range(c):
                    o_cnt = obs[kx, ky]
                    e_cnt = expected[kx, ky]
                    if o_cnt >= 3 and e_cnt > 0:
                        cell_lift = o_cnt / e_cnt
                        if cell_lift > max_lift:
                            max_lift = cell_lift
                            top_lift_cell = f"{categories_x[kx]} × {categories_y[ky]}"
                            top_lift_rids = cell_row_ids.get((kx, ky), [])
                            top_p_obs = round(o_cnt / valid_count, 4)
                            top_p_exp = round(e_cnt / valid_count, 4)

            unexpected_lift = min(1.0, max(0.0, (max_lift - 1.0) / max(1e-4, max_lift_cap - 1.0)))

            pairs_list.append({
                "id": f"pair_{len(pairs_list)+1:03d}",
                "x": {
                    "name": col_x,
                    "label": meta_by_col.get(col_x, {}).get("label") or col_x,
                    "type": tx,
                },
                "y": {
                    "name": col_y,
                    "label": meta_by_col.get(col_y, {}).get("label") or col_y,
                    "type": ty,
                },
                "primary": {
                    "measure": "phik",
                    "value": round(corrected_v, 4),
                    "sign": int(sign),
                    "signed_value": signed_phik,
                },
                "secondary": {
                    "pearson_r": pearson_r,
                    "spearman_rho": spearman_rho,
                    "kendall_tau": kendall_tau,
                    "correlation_ratio": corr_ratio,
                },
                "strength": round(corrected_v, 4),
                "unexpectedness_lift": round(unexpected_lift, 4),
                "max_lift": round(max_lift, 3),
                "top_lift": {
                    "cell": top_lift_cell or f"{categories_x[0]} × {categories_y[0]}",
                    "lift": round(max_lift, 2),
                    "p_obs": top_p_obs,
                    "p_expected": top_p_exp,
                    "row_ids": top_lift_rids,
                },
                "n_valid": valid_count,
            })

    if not pairs_list:
        return {
            "run_id": str(uuid.uuid4()),
            "generated_at": datetime.datetime.now().isoformat(),
            "config": {
                "primary_measure": primary_measure,
                "unexpectedness_mode": unexpectedness_mode,
                "w_strength": w_strength,
                "w_unexpected": w_unexpected,
                "max_lift_cap": max_lift_cap,
            },
            "pairs": [],
            "pair_matrix": {"columns": valid_cols, "matrix": []},
        }

    # Compute empirical unexpectedness: z-score of strength
    strengths = np.array([p["strength"] for p in pairs_list])
    mean_s = float(np.mean(strengths))
    std_s = float(np.std(strengths))

    for p_item in pairs_list:
        s = p_item["strength"]
        z_unexp = (s - mean_s) / max(1e-9, std_s) if std_s > 1e-6 else 0.5
        unexp_emp = min(1.0, max(0.0, z_unexp / 3.0))

        if unexpectedness_mode == "empirical":
            unexp = unexp_emp
        elif unexpectedness_mode == "lift":
            unexp = p_item["unexpectedness_lift"]
        else:
            unexp = max(unexp_emp, p_item["unexpectedness_lift"])

        surp_score = w_strength * s + w_unexpected * unexp

        p_item["surprise"] = {
            "strength": round(s, 4),
            "unexpectedness_empirical": round(unexp_emp, 4),
            "unexpectedness_lift": p_item["unexpectedness_lift"],
            "unexpectedness": round(unexp, 4),
            "surprise_score": round(surp_score, 4),
        }

    # Sort pairs by surprise_score descending
    pairs_list.sort(key=lambda x: x["surprise"]["surprise_score"], reverse=True)

    # Hierarchical clustering of variables using distance = 1 - |phik|
    ordered_indices = list(range(p))
    try:
        dist_matrix = np.clip(1.0 - np.abs(phik_matrix), 0.0, 1.0)
        np.fill_diagonal(dist_matrix, 0.0)
        dist_condensed = squareform(dist_matrix, checks=False)
        Z = linkage(dist_condensed, method="average")
        ordered_indices = list(leaves_list(Z))
    except Exception:
        ordered_indices = list(range(p))

    ordered_cols = [valid_cols[idx] for idx in ordered_indices]
    reordered_matrix = phik_matrix[np.ix_(ordered_indices, ordered_indices)]

    return {
        "run_id": str(uuid.uuid4()),
        "generated_at": datetime.datetime.now().isoformat(),
        "config": {
            "primary_measure": primary_measure,
            "unexpectedness_mode": unexpectedness_mode,
            "w_strength": w_strength,
            "w_unexpected": w_unexpected,
            "max_lift_cap": max_lift_cap,
        },
        "pairs": pairs_list,
        "pair_matrix": {
            "columns": ordered_cols,
            "matrix": np.round(reordered_matrix, 4).tolist(),
        },
    }
