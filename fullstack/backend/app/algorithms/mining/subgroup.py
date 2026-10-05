"""Automatic Subgroup Mining Engine (Feature 01).

Automatically tests all attribute (subgroup) x question variable pairs,
applies proper statistical tests & effect sizes, corrects for multiple testing
via Benjamini-Hochberg FDR, filters by practical significance, and ranks insights.
"""
from __future__ import annotations

import datetime
import math
import uuid
from typing import Any, Literal
import numpy as np
import polars as pl
from scipy import stats

from ..summaries.crosstab import adjusted_residual as shared_adjusted_residual


def _welch_anova(groups: list[list[float]]) -> tuple[float, float, float, float]:
    """Welch (1951) one-way ANOVA with the finite-sample F correction.

    Returns (F, df1, df2, p). Independent of scipy.stats.f_oneway, which
    assumes equal variances and must never back a 'welch_anova' label.
    """
    from scipy import stats as _stats

    k = len(groups)
    ns = [len(g) for g in groups]
    means = [float(np.mean(g)) for g in groups]
    variances = [float(np.var(g, ddof=1)) if len(g) > 1 else 0.0 for g in groups]
    weights = [n / v if v > 0 else 0.0 for n, v in zip(ns, variances)]
    total_weight = sum(weights)
    if total_weight <= 0:
        return 0.0, float(k - 1), 1.0, 1.0
    grand = sum(w * m for w, m in zip(weights, means)) / total_weight
    between = sum(w * (m - grand) ** 2 for w, m in zip(weights, means)) / (k - 1)
    lambda_prime = sum((1 - w / total_weight) ** 2 / max(n - 1, 1) for w, n in zip(weights, ns))
    denom = 1 + (2 * (k - 2) / max(k * k - 1, 1)) * lambda_prime
    f_stat = between / denom if denom > 0 else 0.0
    df1 = float(k - 1)
    df2 = float((k * k - 1) / (3 * lambda_prime)) if lambda_prime > 0 else 1.0
    p_value = float(_stats.f.sf(f_stat, df1, max(df2, 1e-9))) if math.isfinite(f_stat) else 1.0
    return float(f_stat), df1, float(df2), float(p_value)


def benjamini_hochberg(p_values: list[float], alpha: float = 0.05) -> tuple[list[float], list[bool]]:
    """Compute Benjamini-Hochberg FDR adjusted p-values (q-values) and rejection flags."""
    m = len(p_values)
    if m == 0:
        return [], []
    
    # Pair with original indices
    indexed_p = sorted(enumerate(p_values), key=lambda x: x[1])
    q_values = [1.0] * m
    
    # Calculate raw q-values: p * m / rank (1-based rank)
    running_min = 1.0
    for rank in range(m, 0, -1):
        orig_idx, p = indexed_p[rank - 1]
        raw_q = min(1.0, (p * m) / rank)
        running_min = min(running_min, raw_q)
        q_values[orig_idx] = running_min
        
    rejected = [q <= alpha for q in q_values]
    return q_values, rejected


def get_cramers_v_thresholds(df_min: int) -> tuple[float, float, float]:
    """Cohen (1988) thresholds for Cramér's V based on df_min = min(r-1, c-1)."""
    table = {
        1: (0.10, 0.30, 0.50),
        2: (0.07, 0.21, 0.35),
        3: (0.06, 0.17, 0.29),
        4: (0.05, 0.15, 0.25),
    }
    if df_min in table:
        return table[df_min]
    if df_min < 1:
        return (0.10, 0.30, 0.50)
    # df_min > 4: df_min-dependent scaling ~ 0.10 / sqrt(df_min)
    scale = 1.0 / math.sqrt(df_min)
    return (round(0.10 * scale, 3), round(0.30 * scale, 3), round(0.50 * scale, 3))


def label_effect(value: float, small: float, medium: float, large: float) -> str:
    val = abs(value)
    if val >= large:
        return "large"
    if val >= medium:
        return "medium"
    if val >= small:
        return "small"
    return "negligible"


def run_subgroup_mining(
    df: pl.DataFrame,
    attribute_cols: list[str] | None = None,
    question_cols: list[str] | None = None,
    column_meta: list[dict[str, Any]] | None = None,
    alpha: float = 0.05,
    min_group_size: int = 30,
    min_pct_diff: float = 3.0,
    max_subgroup_levels: int = 8,
    weights: dict[str, float] | None = None,
    surprise_scores: dict[str, float] | None = None,
    compute_pvalues: bool = True,
) -> dict[str, Any]:
    """Run full automated subgroup mining pipeline.

    When ``compute_pvalues`` is False (exploratory mode), no statistical test
    is executed at all: p-values, q-values, and post-hoc adjustments are
    None instead of being computed and hidden afterwards.
    """
    w = {
        "stat": 0.35,
        "eff": 0.30,
        "prac": 0.20,
        "surp": 0.15,
    }
    if weights:
        w.update(weights)

    if df.height < 2:
        return {
            "run_id": str(uuid.uuid4()),
            "generated_at": datetime.datetime.now().isoformat(),
            "config": {"alpha": alpha, "min_group_size": min_group_size, "min_pct_diff": min_pct_diff},
            "summary": {
                "n_subgroup_vars": 0,
                "n_questions": 0,
                "n_tests_run": 0,
                "n_significant_fdr": 0,
                "n_significant_bonferroni": 0,
                "n_insights_after_filters": 0,
            },
            "insights": [],
        }

    from ...domain.codebook_adapter import CodebookAdapter
    adapter = CodebookAdapter(df, {"columns": column_meta or []})
    has_codebook = any("scaleType" in c for c in (column_meta or []))
    requested_attributes, requested_questions = attribute_cols, question_cols
    if has_codebook:
        df = df.with_columns([
            adapter.analysis_series(c) if (adapter.get_column_spec_optional(c) or {}).get("role") == "question"
            else adapter.mask_analysis_values(c)
            for c in df.columns if adapter.get_column_spec_optional(c)
        ])

    # Determine row IDs column
    row_id_col = "__rowId__" if "__rowId__" in df.columns else None
    if not row_id_col:
        for c in ["id", "ID", "row_id", "rowId"]:
            if c in df.columns:
                row_id_col = c
                break

    all_row_ids = [str(r) for r in df[row_id_col].to_list()] if row_id_col else [str(i) for i in range(df.height)]
    df_with_id = df if row_id_col else df.with_columns(pl.Series("__rowId__", all_row_ids))
    actual_row_id = row_id_col or "__rowId__"

    # Meta lookup
    meta_by_col: dict[str, dict[str, Any]] = {}
    if column_meta:
        for m in column_meta:
            if m.get("columnId"):
                meta_by_col[m["columnId"]] = m
            if m.get("name"):
                meta_by_col[m["name"]] = m

    # Detect attribute columns if not given
    # Attributes: categorical, ordinal, or discrete integer columns (unique <= max_subgroup_levels)
    all_cols = [c for c in df.columns if c != actual_row_id]
    
    if not attribute_cols:
        attribute_cols = []
        for c in all_cols:
            meta = meta_by_col.get(c, {})
            role = meta.get("role")
            sem_type = meta.get("semanticType")
            n_unique = df[c].n_unique()
            if role == "attribute" or sem_type == "categorical" or df[c].dtype == pl.String:
                if 2 <= n_unique <= max_subgroup_levels * 2:
                    attribute_cols.append(c)
            elif n_unique <= max_subgroup_levels and df[c].dtype in (pl.Int8, pl.Int16, pl.Int32, pl.Int64):
                attribute_cols.append(c)
    
    if not question_cols:
        question_cols = [c for c in all_cols if c not in attribute_cols]

    if has_codebook:
        allowed_attributes, allowed_questions = adapter.get_attribute_columns(), adapter.get_question_columns()
        attribute_cols = [c for c in (requested_attributes if requested_attributes is not None else allowed_attributes) if c in allowed_attributes]
        question_cols = [c for c in (requested_questions if requested_questions is not None else allowed_questions) if c in allowed_questions]

    effective_min_group_size = min_group_size

    # Prepare candidates
    raw_tests: list[dict[str, Any]] = []

    for attr in attribute_cols:
        attr_series = df_with_id[attr]
        # Count frequency of each level
        val_counts = attr_series.drop_nulls().value_counts()
        if val_counts.height < 2:
            continue
        
        # Sort by count desc
        top_levels = val_counts.sort("count", descending=True)
        if top_levels.height > max_subgroup_levels:
            # Aggregate levels beyond max_subgroup_levels - 1 into "その他"
            keep_vals = set(top_levels[attr].head(max_subgroup_levels - 1).to_list())
            def map_level(v: Any) -> str:
                if v is None:
                    return "欠損"
                return str(v) if v in keep_vals else "その他"
            attr_vals = [map_level(v) for v in attr_series.to_list()]
        else:
            attr_vals = [str(v) if v is not None else "欠損" for v in attr_series.to_list()]

        unique_levels = sorted(list(set(l for l in attr_vals if l != "欠損")))
        if len(unique_levels) < 2:
            continue

        level_row_ids: dict[str, list[str]] = {lvl: [] for lvl in unique_levels}
        for lvl, rid in zip(attr_vals, all_row_ids):
            if lvl in level_row_ids:
                level_row_ids[lvl].append(rid)

        # Check group size
        group_sizes = {lvl: len(rids) for lvl, rids in level_row_ids.items()}

        for q in question_cols:
            if q == attr:
                continue
            q_series = df_with_id[q]
            meta = meta_by_col.get(q, {})
            q_type = {"ordinal": "ordinal", "nominal": "categorical", "ratio": "numeric", "interval": "numeric"}.get(meta.get("scaleType"), meta.get("semanticType"))
            if not q_type:
                if q_series.dtype in (pl.Float32, pl.Float64):
                    q_type = "numeric"
                elif q_series.dtype in (pl.Int8, pl.Int16, pl.Int32, pl.Int64):
                    q_type = "numeric" if q_series.n_unique() > 7 else "ordinal"
                else:
                    q_type = "categorical"

            # Execute statistical test (skipped entirely in exploratory mode)
            test_res = None
            if compute_pvalues:
                if q_type == "numeric":
                    test_res = _test_numeric(attr, q, unique_levels, attr_vals, q_series.to_list(), level_row_ids)
                elif q_type == "ordinal":
                    test_res = _test_ordinal(attr, q, unique_levels, attr_vals, q_series.to_list(), level_row_ids)
                else:
                    test_res = _test_categorical(attr, q, unique_levels, attr_vals, q_series.to_list(), level_row_ids)
            else:
                test_res = _describe_numeric(attr, q, unique_levels, attr_vals, q_series.to_list(),
                                             level_row_ids, q_type=q_type)

            if test_res:
                test_res["attr"] = attr
                test_res["q"] = q
                test_res["q_type"] = q_type
                test_res["group_sizes"] = group_sizes
                raw_tests.append(test_res)

    if not raw_tests:
        return {
            "run_id": str(uuid.uuid4()),
            "generated_at": datetime.datetime.now().isoformat(),
            "config": {"alpha": alpha, "min_group_size": min_group_size, "min_pct_diff": min_pct_diff},
            "summary": {
                "n_subgroup_vars": len(attribute_cols),
                "n_questions": len(question_cols),
                "n_tests_run": 0,
                "n_significant_fdr": 0,
                "n_significant_bonferroni": 0,
                "n_insights_after_filters": 0,
            },
            "insights": [],
        }

    # Multiple testing correction (exploratory mode: never computed)
    if compute_pvalues:
        p_values = [t["p_value"] for t in raw_tests]
        q_values, rejected = benjamini_hochberg(p_values, alpha=alpha)

        bonferroni_thresh = alpha / max(1, len(raw_tests))
        n_bonf_sig = sum(1 for p in p_values if p <= bonferroni_thresh)
        n_fdr_sig = sum(1 for r in rejected if r)
    else:
        p_values = []
        q_values = [None] * len(raw_tests)
        rejected = [False] * len(raw_tests)
        bonferroni_thresh = alpha / max(1, len(raw_tests))
        n_bonf_sig = 0
        n_fdr_sig = 0

    insights: list[dict[str, Any]] = []

    for i, t in enumerate(raw_tests):
        q_val = q_values[i]
        is_sig = rejected[i]
        t["q_value"] = q_val
        t["significant"] = is_sig if compute_pvalues else False

        # Practical significance filters
        eff_label = t["effect"]["label"]
        min_size = min(t["group_sizes"].values()) if t["group_sizes"] else 0
        delta_pct = abs(t["direction"].get("delta_pct", 0.0))

        # Check min size warning
        warnings = []
        if min_size < effective_min_group_size:
            warnings.append(f"最小グループサイズ ({min_size}) が閾値 ({effective_min_group_size}) 未満です。")

        # Practical filters: exploratory mode ranks by effect only (never by p-value).
        if compute_pvalues:
            passed_filters = is_sig and eff_label != "negligible" and (delta_pct >= min_pct_diff or t["effect"]["value"] >= 0.1)
        else:
            passed_filters = eff_label != "negligible" and (delta_pct >= min_pct_diff or t["effect"]["value"] >= 0.1)

        # Composite score
        if compute_pvalues and q_val is not None:
            stat_score = min(max(1.0 - (q_val / max(alpha, 1e-9)), 0.0), 1.0)
        else:
            stat_score = 0.0
        eff_score = 1.0 if eff_label == "large" else (0.66 if eff_label == "medium" else 0.33)
        prac_score = min(max(delta_pct / (max(min_pct_diff, 1.0) * 5.0), 0.0), 1.0)
        
        surp_val = 0.0
        if surprise_scores:
            pair_key = f"{t['attr']}:{t['q']}"
            surp_val = surprise_scores.get(pair_key, 0.0)

        insight_score = round(
            w["stat"] * stat_score +
            w["eff"] * eff_score +
            w["prac"] * prac_score +
            w["surp"] * surp_val,
            4
        )

        scores = {
            "stat": round(stat_score, 3),
            "effect": round(eff_score, 3),
            "practical": round(prac_score, 3),
            "surprise": round(surp_val, 3) if surprise_scores else None,
            "insight_score": insight_score,
        }

        # Narrative description
        narrative = _generate_narrative({**t, "attr": (adapter.get_column_spec_optional(t["attr"]) or {}).get("label") or t["attr"], "q": (adapter.get_column_spec_optional(t["q"]) or {}).get("label") or t["q"]})

        insight_obj = {
            "id": f"ins_{i+1:03d}",
            "subgroup": {
                "name": t["attr"],
                "label": meta_by_col.get(t["attr"], {}).get("label") or t["attr"],
                "type": "categorical",
            },
            "question": {
                "name": t["q"],
                "label": meta_by_col.get(t["q"], {}).get("label") or t["q"],
                "type": t["q_type"],
            },
            "test": {
                "method": t["test_method"],
                "statistic": round(float(t["statistic"]), 4) if t["statistic"] is not None else None,
                "p_value": float(f"{t['p_value']:.4e}") if compute_pvalues else None,
                "q_value": float(f"{q_val:.4e}") if compute_pvalues and q_val is not None else None,
                "significant": is_sig,
            },
            "effect": t["effect"],
            "group_stats": t["group_stats"],
            "valueLabels": {level: adapter.label_for_value(t["attr"], level) for level in t.get("row_ids", {})},
            "contingency": t.get("contingency"),
            "direction": t["direction"],
            "posthoc": t.get("posthoc", []),
            "scores": scores,
            "narrative": narrative,
            "warnings": warnings,
            "row_ids": t.get("row_ids", {}),
            "_passed_filter": passed_filters,
        }
        insights.append(insight_obj)

    # Filter and sort (exploratory mode: never filter by significance)
    filtered_insights = [ins for ins in insights if ins["_passed_filter"]]
    # If filtered results are empty (e.g. strict alpha on small dataset), fallback to top sorted insights
    if not filtered_insights and compute_pvalues:
        filtered_insights = [ins for ins in insights if ins["test"]["significant"]]
    if not filtered_insights:
        filtered_insights = insights[:10]

    filtered_insights.sort(key=lambda x: x["scores"]["insight_score"], reverse=True)
    for ins in filtered_insights:
        ins.pop("_passed_filter", None)

    return {
        "run_id": str(uuid.uuid4()),
        "generated_at": datetime.datetime.now().isoformat(),
        "config": {
            "alpha": alpha,
            "min_group_size": min_group_size,
            "min_pct_diff": min_pct_diff,
        },
        "summary": {
            "n_subgroup_vars": len(attribute_cols),
            "n_questions": len(question_cols),
            "n_tests_run": len(raw_tests),
            "n_significant_fdr": n_fdr_sig,
            "n_significant_bonferroni": n_bonf_sig,
            "n_insights_after_filters": len(filtered_insights),
        },
        "insights": filtered_insights,
    }


def _describe_numeric(
    attr: str,
    q: str,
    levels: list[str],
    attr_vals: list[str],
    q_vals: list[Any],
    level_row_ids: dict[str, list[str]],
    q_type: str = "numeric",
) -> dict[str, Any] | None:
    """Descriptive-only candidate summary for exploratory mode.

    Computes group means, an effect-size label, and row-id sets without
    running any statistical test, so no p-value ever exists to hide.
    """
    val_by_lvl: dict[str, list[float]] = {lvl: [] for lvl in levels}
    for lvl, qv in zip(attr_vals, q_vals):
        if lvl in val_by_lvl and qv is not None:
            try:
                fv = float(qv)
                if not math.isnan(fv):
                    val_by_lvl[lvl].append(fv)
            except (ValueError, TypeError):
                continue

    valid_levels = [lvl for lvl in levels if len(val_by_lvl[lvl]) >= 2]
    if len(valid_levels) < 2:
        return None

    group_stats = []
    for lvl in valid_levels:
        arr = np.array(val_by_lvl[lvl])
        group_stats.append({
            "group": lvl,
            "n": len(arr),
            "mean": round(float(np.mean(arr)), 4),
            "sd": round(float(np.std(arr, ddof=1)), 4) if len(arr) > 1 else 0.0,
            "median": round(float(np.median(arr)), 4),
        })

    high_g = max(group_stats, key=lambda g: g["mean"])
    low_g = min(group_stats, key=lambda g: g["mean"])
    overall_mean = float(np.mean([v for lvl in valid_levels for v in val_by_lvl[lvl]]))
    delta = high_g["mean"] - low_g["mean"]
    delta_pct = (delta / (abs(overall_mean) + 1e-6)) * 100.0

    pooled_sd = math.sqrt(sum((np.std(val_by_lvl[lvl], ddof=1) or 0.0) ** 2
                             for lvl in valid_levels) / max(1, len(valid_levels)))
    cohen_d = abs(delta) / max(pooled_sd, 1e-6)
    eff_label = label_effect(cohen_d, 0.20, 0.50, 0.80)
    return {
        "test_method": "descriptive_only",
        "statistic": None,
        "p_value": None,
        "effect": {"measure": "cohens_d", "value": round(float(cohen_d), 4), "label": eff_label},
        "group_stats": group_stats,
        "direction": {
            "highest_group": high_g["group"],
            "lowest_group": low_g["group"],
            "delta": round(delta, 4),
            "delta_vs_overall": round(high_g["mean"] - overall_mean, 4),
            "delta_pct": round(delta_pct, 2),
            "overall_mean": round(overall_mean, 4),
        },
        "posthoc": [],
        "row_ids": {
            "highest_group": level_row_ids.get(high_g["group"], []),
            "lowest_group": level_row_ids.get(low_g["group"], []),
            "all_by_group": level_row_ids,
        },
    }


def _test_numeric(
    attr: str,
    q: str,
    levels: list[str],
    attr_vals: list[str],
    q_vals: list[Any],
    level_row_ids: dict[str, list[str]],
) -> dict[str, Any] | None:
    """Welch t-test or ANOVA for numeric questions."""
    # Map values
    val_by_lvl: dict[str, list[float]] = {lvl: [] for lvl in levels}
    for lvl, qv in zip(attr_vals, q_vals):
        if lvl in val_by_lvl and qv is not None:
            try:
                fv = float(qv)
                if not math.isnan(fv):
                    val_by_lvl[lvl].append(fv)
            except (ValueError, TypeError):
                continue

    # Filter out empty levels
    valid_levels = [lvl for lvl in levels if len(val_by_lvl[lvl]) >= 2]
    if len(valid_levels) < 2:
        return None

    group_stats = []
    for lvl in valid_levels:
        vals = val_by_lvl[lvl]
        arr = np.array(vals)
        group_stats.append({
            "group": lvl,
            "n": len(vals),
            "mean": round(float(np.mean(arr)), 4),
            "sd": round(float(np.std(arr, ddof=1)), 4) if len(vals) > 1 else 0.0,
            "median": round(float(np.median(arr)), 4),
        })

    means = [g["mean"] for g in group_stats]
    high_g = max(group_stats, key=lambda g: g["mean"])
    low_g = min(group_stats, key=lambda g: g["mean"])
    overall_mean = float(np.mean([v for lvl in valid_levels for v in val_by_lvl[lvl]]))
    delta = high_g["mean"] - low_g["mean"]
    delta_pct = (delta / (abs(overall_mean) + 1e-6)) * 100.0

    posthoc = []
    if len(valid_levels) == 2:
        # Welch t-test
        lvl1, lvl2 = valid_levels[0], valid_levels[1]
        v1, v2 = val_by_lvl[lvl1], val_by_lvl[lvl2]
        res = stats.ttest_ind(v1, v2, equal_var=False)
        stat = float(res.statistic)
        pval = float(res.pvalue) if not math.isnan(res.pvalue) else 1.0

        # Cohen's d
        s1, s2 = np.std(v1, ddof=1), np.std(v2, ddof=1)
        n1, n2 = len(v1), len(v2)
        s_pooled = math.sqrt(((n1 - 1) * s1**2 + (n2 - 1) * s2**2) / max(1, n1 + n2 - 2))
        cohen_d = abs(np.mean(v1) - np.mean(v2)) / max(s_pooled, 1e-6)
        eff_label = label_effect(cohen_d, 0.20, 0.50, 0.80)
        effect = {"measure": "cohens_d", "value": round(cohen_d, 4), "label": eff_label}
        method = "welch_ttest"
        posthoc.append({"pair": [lvl1, lvl2], "p_adj": pval, "significant": pval < 0.05})
    else:
        # Welch ANOVA (unequal variances): Welch (1951) F with the
        # finite-sample correction and Satterthwaite-Welch denominator df.
        # Never the equal-variance f_oneway under a Welch label (F01).
        arrays = [val_by_lvl[lvl] for lvl in valid_levels]
        try:
            stat, _df1, _df2, pval = _welch_anova(arrays)
        except Exception:
            stat, pval = 0.0, 1.0

        # Eta-squared
        all_vals = np.concatenate(arrays)
        grand_mean = np.mean(all_vals)
        ss_between = sum(len(a) * (np.mean(a) - grand_mean)**2 for a in arrays)
        ss_total = sum((x - grand_mean)**2 for x in all_vals)
        eta_sq = ss_between / max(ss_total, 1e-9)
        eff_label = label_effect(eta_sq, 0.01, 0.06, 0.14)
        effect = {"measure": "eta_sq", "value": round(eta_sq, 4), "label": eff_label}
        method = "welch_anova"

        # Pairwise Welch t-tests
        pair_pvals = []
        pairs = []
        for i in range(len(valid_levels)):
            for j in range(i + 1, len(valid_levels)):
                l_i, l_j = valid_levels[i], valid_levels[j]
                t_pair = stats.ttest_ind(val_by_lvl[l_i], val_by_lvl[l_j], equal_var=False)
                pv = float(t_pair.pvalue) if not math.isnan(t_pair.pvalue) else 1.0
                pairs.append([l_i, l_j])
                pair_pvals.append(pv)
        pair_qvals, pair_rej = benjamini_hochberg(pair_pvals, alpha=0.05)
        for p, q, rej in zip(pairs, pair_qvals, pair_rej):
            posthoc.append({"pair": p, "p_adj": round(q, 6), "significant": rej})

    delta_vs_overall = high_g["mean"] - overall_mean
    return {
        "test_method": method,
        "statistic": stat,
        "p_value": pval,
        "effect": effect,
        "group_stats": group_stats,
        "direction": {
            "highest_group": high_g["group"],
            "lowest_group": low_g["group"],
            "delta": round(delta, 4),
            "delta_vs_overall": round(delta_vs_overall, 4),
            "delta_pct": round(delta_pct, 2),
            "overall_mean": round(overall_mean, 4),
        },
        "posthoc": posthoc,
        "row_ids": {
            "highest_group": level_row_ids.get(high_g["group"], []),
            "lowest_group": level_row_ids.get(low_g["group"], []),
            "all_by_group": level_row_ids,
        }
    }


def _test_ordinal(
    attr: str,
    q: str,
    levels: list[str],
    attr_vals: list[str],
    q_vals: list[Any],
    level_row_ids: dict[str, list[str]],
) -> dict[str, Any] | None:
    """Mann-Whitney U or Kruskal-Wallis for ordinal questions."""
    val_by_lvl: dict[str, list[float]] = {lvl: [] for lvl in levels}
    for lvl, qv in zip(attr_vals, q_vals):
        if lvl in val_by_lvl and qv is not None:
            try:
                val_by_lvl[lvl].append(float(qv))
            except (ValueError, TypeError):
                continue

    valid_levels = [lvl for lvl in levels if len(val_by_lvl[lvl]) >= 2]
    if len(valid_levels) < 2:
        return None

    group_stats = []
    for lvl in valid_levels:
        arr = np.array(val_by_lvl[lvl])
        group_stats.append({
            "group": lvl,
            "n": len(arr),
            "mean": round(float(np.mean(arr)), 4),
            "sd": round(float(np.std(arr, ddof=1)), 4) if len(arr) > 1 else 0.0,
            "median": round(float(np.median(arr)), 4),
        })

    high_g = max(group_stats, key=lambda g: g["mean"])
    low_g = min(group_stats, key=lambda g: g["mean"])
    overall_mean = float(np.mean([v for lvl in valid_levels for v in val_by_lvl[lvl]]))
    delta = high_g["mean"] - low_g["mean"]
    delta_pct = (delta / (abs(overall_mean) + 1e-6)) * 100.0

    posthoc = []
    if len(valid_levels) == 2:
        l1, l2 = valid_levels[0], valid_levels[1]
        v1, v2 = val_by_lvl[l1], val_by_lvl[l2]
        res = stats.mannwhitneyu(v1, v2, alternative='two-sided')
        stat = float(res.statistic)
        pval = float(res.pvalue)

        # Cliff's delta
        n1, n2 = len(v1), len(v2)
        cliffs_d = (2.0 * stat) / (n1 * n2) - 1.0
        eff_label = label_effect(cliffs_d, 0.147, 0.330, 0.474)
        effect = {"measure": "cliffs_delta", "value": round(cliffs_d, 4), "label": eff_label}
        method = "mann_whitney_u"
        posthoc.append({"pair": [l1, l2], "p_adj": pval, "significant": pval < 0.05})
    else:
        arrays = [val_by_lvl[lvl] for lvl in valid_levels]
        try:
            res = stats.kruskal(*arrays)
            stat = float(res.statistic)
            pval = float(res.pvalue)
        except Exception:
            stat, pval = 0.0, 1.0

        n_total = sum(len(a) for a in arrays)
        epsilon_sq = stat / max(1e-9, ((n_total**2 - 1) / (n_total + 1)))
        eff_label = label_effect(epsilon_sq, 0.01, 0.06, 0.14)
        effect = {"measure": "epsilon_sq", "value": round(epsilon_sq, 4), "label": eff_label}
        method = "kruskal_wallis"

        pair_pvals = []
        pairs = []
        for i in range(len(valid_levels)):
            for j in range(i + 1, len(valid_levels)):
                li, lj = valid_levels[i], valid_levels[j]
                m_pair = stats.mannwhitneyu(val_by_lvl[li], val_by_lvl[lj], alternative='two-sided')
                pairs.append([li, lj])
                pair_pvals.append(float(m_pair.pvalue))
        pair_qvals, pair_rej = benjamini_hochberg(pair_pvals, alpha=0.05)
        for p, q, rej in zip(pairs, pair_qvals, pair_rej):
            posthoc.append({"pair": p, "p_adj": round(q, 6), "significant": rej})

    delta_vs_overall = high_g["mean"] - overall_mean
    return {
        "test_method": method,
        "statistic": stat,
        "p_value": pval,
        "effect": effect,
        "group_stats": group_stats,
        "direction": {
            "highest_group": high_g["group"],
            "lowest_group": low_g["group"],
            "delta": round(delta, 4),
            "delta_vs_overall": round(delta_vs_overall, 4),
            "delta_pct": round(delta_pct, 2),
            "overall_mean": round(overall_mean, 4),
        },
        "posthoc": posthoc,
        "row_ids": {
            "highest_group": level_row_ids.get(high_g["group"], []),
            "lowest_group": level_row_ids.get(low_g["group"], []),
            "all_by_group": level_row_ids,
        }
    }


def _test_categorical(
    attr: str,
    q: str,
    levels: list[str],
    attr_vals: list[str],
    q_vals: list[Any],
    level_row_ids: dict[str, list[str]],
) -> dict[str, Any] | None:
    """Chi-square contingency test and Cramér's V for nominal questions."""
    q_str_vals = [str(v) if v is not None else "欠損" for v in q_vals]
    q_categories = sorted(list(set(c for c in q_str_vals if c != "欠損")))
    if len(q_categories) < 2:
        return None

    # Construct contingency matrix
    # rows: attr levels, cols: q categories
    observed = np.zeros((len(levels), len(q_categories)), dtype=int)
    lvl_map = {lvl: i for i, lvl in enumerate(levels)}
    cat_map = {cat: j for j, cat in enumerate(q_categories)}

    for a, qv in zip(attr_vals, q_str_vals):
        if a in lvl_map and qv in cat_map:
            observed[lvl_map[a], cat_map[qv]] += 1

    # Check non-empty rows/cols
    row_sums = observed.sum(axis=1)
    col_sums = observed.sum(axis=0)
    if (row_sums == 0).any() or (col_sums == 0).any():
        return None

    n_total = int(observed.sum())
    if n_total < 5:
        return None

    try:
        chi2_res = stats.chi2_contingency(observed)
        stat = float(chi2_res.statistic)
        pval = float(chi2_res.pvalue)
        expected = chi2_res.expected_freq
    except Exception:
        return None

    r, c = observed.shape
    df_min = min(r - 1, c - 1)
    cramers_v = math.sqrt(stat / max(1e-9, n_total * df_min)) if df_min > 0 else 0.0
    thresh = get_cramers_v_thresholds(df_min)
    eff_label = label_effect(cramers_v, thresh[0], thresh[1], thresh[2])
    effect = {"measure": "cramers_v", "value": round(cramers_v, 4), "label": eff_label}

    # Adjusted standardized residuals: shared with crosstab (Feature 26).
    residuals = np.zeros((r, c), dtype=float)
    for i in range(r):
        for j in range(c):
            value = shared_adjusted_residual(float(observed[i, j]), float(expected[i, j]),
                                             float(row_sums[i] / n_total),
                                             float(col_sums[j] / n_total))
            residuals[i, j] = round(value if value is not None else 0.0, 3)

    # Find cell with largest positive residual
    max_res_idx = np.unravel_index(np.argmax(residuals), residuals.shape)
    top_attr_lvl = levels[max_res_idx[0]]
    top_q_cat = q_categories[max_res_idx[1]]
    top_res = float(residuals[max_res_idx])

    group_stats = []
    for i, lvl in enumerate(levels):
        group_stats.append({
            "group": lvl,
            "n": int(row_sums[i]),
            "most_frequent_cat": q_categories[int(np.argmax(observed[i, :]))],
        })

    contingency = {
        "rows": levels,
        "cols": q_categories,
        "observed": observed.tolist(),
        "expected": np.round(expected, 2).tolist(),
        "residuals": residuals.tolist(),
    }

    # Direction info
    delta_pct = round(top_res * 5.0, 2)  # approximate practical indicator
    return {
        "test_method": "chi2_contingency",
        "statistic": stat,
        "p_value": pval,
        "effect": effect,
        "group_stats": group_stats,
        "contingency": contingency,
        "direction": {
            "top_group": top_attr_lvl,
            "characteristic_category": top_q_cat,
            "max_residual": top_res,
            "delta_pct": delta_pct,
        },
        "posthoc": [],
        "row_ids": {
            "top_group": level_row_ids.get(top_attr_lvl, []),
            "all_by_group": level_row_ids,
        }
    }


def _generate_narrative(t: dict[str, Any]) -> str:
    """Generate Japanese narrative explaining the finding."""
    attr = t["attr"]
    q = t["q"]
    q_val = t.get("q_value")
    eff_label = t["effect"]["label"]
    eff_val = t["effect"]["value"]
    direction = t.get("direction", {})
    significance = f"（FDR q={q_val:.2e}, " if q_val is not None else "（探索的候補であり確証ではありません。"

    if t["test_method"] == "descriptive_only":
        high = direction.get("highest_group", "")
        low = direction.get("lowest_group", "")
        delta = direction.get("delta", 0.0)
        overall = direction.get("overall_mean", 0.0)
        return (
            f"「{attr}」で見ると、「{q}」に探索的な差の候補があります"
            f"{significance}効果量 {eff_label}={eff_val:.2f}）。"
            f"特に【{high}】が最も高く（全体平均 {overall:.2f} / 最低群【{low}】との差 {delta:.2f}）。"
        )
    if t["test_method"] in ("welch_ttest", "welch_anova", "mann_whitney_u", "kruskal_wallis"):
        high = direction.get("highest_group", "")
        low = direction.get("lowest_group", "")
        delta = direction.get("delta", 0.0)
        delta_vs_overall = direction.get("delta_vs_overall", delta)
        overall = direction.get("overall_mean", 0.0)
        sign_char = "+" if delta_vs_overall >= 0 else ""
        return (
            f"「{attr}」で見ると、「{q}」に有意な差が認められます{significance}効果量 {eff_label}={eff_val:.2f}）。"
            f"特に【{high}】が最も高く（全体平均 {overall:.2f} に対し {sign_char}{delta_vs_overall:.2f} / 最低群【{low}】との差 {delta:.2f}）、"
            f"顕著なコントラストが形成されています。"
        )
    else:
        top_g = direction.get("top_group", "")
        cat = direction.get("characteristic_category", "")
        res = direction.get("max_residual", 0.0)
        return (
            f"「{attr}」で見ると、「{q}」の構成比に有意な偏りがあります{significance}Cramér's V={eff_val:.2f} [{eff_label}]）。"
            f"特に【{top_g}】において「{cat}」の出現度が期待値を大きく上回っています（調整済み残差 +{res:.1f}）。"
        )
