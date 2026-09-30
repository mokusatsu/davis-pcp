"""Modern Subgroup Discovery & Exceptional Model Mining (Diverse-EMM).

Implements Feature 11 & Omnipresent Auto-Mining:
- Pre-generated selectors (one-sided & interval conditions for numeric, categories)
- Beam search with separation of Beam (expansion) and Candidate Pool (all evaluated)
- Numeric score with variance reduction bonus, zero-variance handling & upper cap
- Binary mode (target category proportion difference)
- Kendall tau-b EMM with tie-handling & complement comparison
- Omnipresent mode: automatically searches all question variables & prominent pairs
- Effect-aware diversity selection across all questions with per-target quota
"""
from __future__ import annotations

import datetime
import itertools
import math
import uuid
from dataclasses import dataclass
from typing import Any, Literal
import numpy as np
import polars as pl
from scipy import stats
from ...domain.codebook_adapter import CodebookAdapter


def _format_threshold(val: float) -> str:
    """Format numeric threshold cleanly without losing meaning or showing scientific notation unnecessarily."""
    if abs(val - round(val)) < 1e-9 and abs(val) < 1e12:
        return str(int(round(val)))
    for prec in (4, 6, 8):
        s = f"{val:.{prec}g}"
        if abs(float(s) - val) < 1e-9:
            return s
    return f"{val:g}"


@dataclass
class Condition:
    column: str
    operator: Literal["<", ">=", "between", "=="]
    value: Any  # float for <, >=; tuple[float, float] for between; Any for ==
    label: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "column": self.column,
            "operator": self.operator,
            "value": list(self.value) if isinstance(self.value, tuple) else self.value,
            "label": self.label,
        }

    def evaluate(self, df: pl.DataFrame) -> np.ndarray:
        series = df[self.column]
        is_valid = ~series.is_null().to_numpy()
        col_vals = series.to_numpy()
        if self.operator == "<":
            return is_valid & (col_vals < float(self.value))
        elif self.operator == ">=":
            return is_valid & (col_vals >= float(self.value))
        elif self.operator == "between":
            low, high = float(self.value[0]), float(self.value[1])
            return is_valid & (col_vals >= low) & (col_vals < high)
        elif self.operator == "==":
            col_list = series.to_list()
            val_str = str(self.value)
            return np.array([v == self.value or str(v) == val_str for v in col_list], dtype=bool)
        return np.zeros(len(df), dtype=bool)


def evaluate_condition_dict(cond: dict[str, Any], df: pl.DataFrame) -> np.ndarray:
    col = cond["column"]
    op = cond["operator"]
    val = cond["value"]
    series = df[col]
    is_valid = ~series.is_null().to_numpy()
    col_vals = series.to_numpy()
    if op == "<":
        return is_valid & (col_vals < float(val))
    elif op == ">=":
        return is_valid & (col_vals >= float(val))
    elif op == "between":
        low, high = float(val[0]), float(val[1])
        return is_valid & (col_vals >= low) & (col_vals < high)
    elif op == "==":
        col_list = series.to_list()
        val_str = str(val)
        return np.array([v == val or str(v) == val_str for v in col_list], dtype=bool)
    return np.zeros(len(df), dtype=bool)


def evaluate_rule(rule: RuleCandidate | dict[str, Any], df: pl.DataFrame) -> list[str]:
    """Evaluate a RuleCandidate or rule dictionary against DataFrame and return matching __rowId__ list."""
    if isinstance(rule, RuleCandidate):
        mask = rule.evaluate(df)
    elif isinstance(rule, dict) and "operator" in rule and "column" in rule:
        mask = evaluate_condition_dict(rule, df)
    else:
        conds = rule.get("conditions", []) if isinstance(rule, dict) else []
        mask = np.ones(len(df), dtype=bool)
        for c in conds:
            mask &= evaluate_condition_dict(c, df)
    
    if "__rowId__" in df.columns:
        row_ids = df["__rowId__"].to_list()
        return [str(row_ids[i]) for i in range(len(df)) if mask[i]]
    return [str(i) for i in range(len(df)) if mask[i]]


@dataclass
class RuleCandidate:
    conditions: list[Condition]
    attribute_cols: list[str]
    row_ids: list[str]
    bitmask: np.ndarray  # boolean 1D array of length N
    n_subgroup: int
    n_complement: int
    score: float
    raw_score: float
    target_stats: dict[str, Any]
    ranking_reason: dict[str, Any]
    target_question: str | None = None
    target_pair: list[str] | None = None
    complete_separation: bool = False
    parent_insight_id: str | None = None
    parent_delta_mean: float | None = None
    emm_stats: dict[str, Any] | None = None
    id: str | None = None

    def evaluate(self, df: pl.DataFrame) -> np.ndarray:
        mask = np.ones(len(df), dtype=bool)
        for cond in self.conditions:
            mask &= cond.evaluate(df)
        return mask


def generate_descriptors(
    df: pl.DataFrame,
    attribute_cols: list[str],
    excluded_cols: set[str],
    max_categories: int = 8,
    column_meta: dict[str, dict] | None = None,
) -> list[tuple[Condition, np.ndarray]]:
    """Pre-generate all single-attribute selectors:
    - Categorical/Ordinal: == value
    - Numeric: A < t, A >= t, t_i <= A < t_j using quartiles
    Returns list of (Condition, boolean_mask).
    """
    descriptors: list[tuple[Condition, np.ndarray]] = []
    n_rows = df.height

    for col in attribute_cols:
        if col in excluded_cols or col not in df.columns:
            continue

        series = df[col]
        dtype = series.dtype

        # Check numeric vs categorical
        is_numeric = dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64) and series.n_unique() > 8
        scale = (column_meta or {}).get(col, {}).get("scaleType")
        if scale:
            is_numeric = scale in ("interval", "ratio")

        if is_numeric:
            non_null_vals = series.drop_nulls().to_numpy()
            if len(non_null_vals) < 10:
                continue

            q25, q50, q75 = np.percentile(non_null_vals, [25, 50, 75])
            unique_cuts = sorted(list(set([float(q25), float(q50), float(q75)])))
            if len(unique_cuts) == 0:
                continue

            col_vals = series.to_numpy()
            is_valid = ~series.is_null().to_numpy()

            # Generate one-sided: < t, >= t
            for t in unique_cuts:
                val_float = float(t)
                mask_lt = is_valid & (col_vals < val_float)
                if 0 < np.sum(mask_lt) < n_rows:
                    cond_lt = Condition(
                        column=col,
                        operator="<",
                        value=val_float,
                        label=f"{col} < {_format_threshold(val_float)}",
                    )
                    descriptors.append((cond_lt, mask_lt))

                mask_ge = is_valid & (col_vals >= val_float)
                if 0 < np.sum(mask_ge) < n_rows:
                    cond_ge = Condition(
                        column=col,
                        operator=">=",
                        value=val_float,
                        label=f"{col} >= {_format_threshold(val_float)}",
                    )
                    descriptors.append((cond_ge, mask_ge))

            # Generate interval conditions: t_i <= A < t_j
            for i in range(len(unique_cuts)):
                for j in range(i + 1, len(unique_cuts)):
                    t_low, t_high = float(unique_cuts[i]), float(unique_cuts[j])
                    mask_between = is_valid & (col_vals >= t_low) & (col_vals < t_high)
                    if 0 < np.sum(mask_between) < n_rows:
                        cond_between = Condition(
                            column=col,
                            operator="between",
                            value=(t_low, t_high),
                            label=f"{_format_threshold(t_low)} <= {col} < {_format_threshold(t_high)}",
                        )
                        descriptors.append((cond_between, mask_between))
        else:
            # Categorical or discrete
            val_counts = series.drop_nulls().value_counts().sort("count", descending=True)
            top_vals = val_counts[col].head(max_categories).to_list()
            col_list = series.to_list()

            for val in top_vals:
                if val is None:
                    continue
                mask = np.array([v == val for v in col_list], dtype=bool)
                if 0 < np.sum(mask) < n_rows:
                    cond_eq = Condition(
                        column=col,
                        operator="==",
                        value=str(val),
                        label=f"{col} == {val}",
                    )
                    descriptors.append((cond_eq, mask))

    return descriptors


def compute_numeric_score(
    y: np.ndarray,
    subgroup_mask: np.ndarray,
    min_group_size: int = 30,
    complexity: int = 1,
    lambda_penalty: float = 0.05,
    s_max: float = 50.0,
) -> tuple[float, float, dict[str, Any], dict[str, Any], bool] | None:
    """Compute numeric score according to Feature 11 specifications."""
    valid_y = ~np.isnan(y)
    sg_valid = subgroup_mask & valid_y
    comp_valid = (~subgroup_mask) & valid_y

    n_R = int(np.sum(sg_valid))
    n_comp = int(np.sum(comp_valid))

    if n_R < min_group_size or n_comp < min_group_size:
        return None

    N = n_R + n_comp
    y_R = y[sg_valid]
    y_comp = y[comp_valid]

    mean_R = float(np.mean(y_R))
    mean_comp = float(np.mean(y_comp))
    delta_mean = mean_R - mean_comp

    s_R = float(np.std(y_R, ddof=1)) if n_R > 1 else 0.0
    s_comp = float(np.std(y_comp, ddof=1)) if n_comp > 1 else 0.0

    # Zero-variance checks
    if s_R == 0.0 and s_comp == 0.0:
        if abs(mean_R - mean_comp) < 1e-9:
            return None  # Constant everywhere
        else:
            raw_score = s_max
            score = raw_score - lambda_penalty * complexity
            target_stats = {
                "subgroup_mean": round(mean_R, 3),
                "complement_mean": round(mean_comp, 3),
                "delta_mean": round(delta_mean, 3),
                "subgroup_sd": 0.0,
                "complement_sd": 0.0,
                "sd_ratio": 0.0,
                "variance_ratio": 0.0,
            }
            ranking_reason = {
                "primary_driver": "complete_separation",
                "description": "サブグループと補集合が完全に異なる定数値に分離",
            }
            return score, raw_score, target_stats, ranking_reason, True

    # Variance reduction bonus B(R)
    if s_R == 0.0 and s_comp > 0.0:
        B_R = 0.5
    elif s_R > 0.0 and s_comp == 0.0:
        B_R = 0.0
    else:
        B_R = min(0.5, max(0.0, math.log(s_comp / s_R)))

    denom_df = (n_R - 1) + (n_comp - 1)
    if denom_df <= 0:
        return None
    s_pooled_sq = ((n_R - 1) * (s_R ** 2) + (n_comp - 1) * (s_comp ** 2)) / denom_df
    s_pooled = math.sqrt(max(1e-12, s_pooled_sq))

    size_weight = math.sqrt((n_R * n_comp) / N)
    raw_score = size_weight * (abs(delta_mean) / s_pooled) * (1.0 + B_R)

    score = min(raw_score, s_max) - lambda_penalty * complexity

    sd_ratio = round(s_R / s_comp, 3) if s_comp > 0 else 0.0
    var_ratio = round((s_R ** 2) / (s_comp ** 2), 3) if s_comp > 0 else 0.0

    driver = "mean_elevation_and_low_variance" if B_R > 0.1 else ("mean_difference" if abs(delta_mean) > 0.3 else "size_and_mean")
    desc = f"他群平均より{delta_mean:+.2f}差があり、標準偏差{s_R:.2f}（補集合{s_comp:.2f}）"

    target_stats = {
        "subgroup_mean": round(mean_R, 3),
        "complement_mean": round(mean_comp, 3),
        "delta_mean": round(delta_mean, 3),
        "subgroup_sd": round(s_R, 3),
        "complement_sd": round(s_comp, 3),
        "sd_ratio": sd_ratio,
        "variance_ratio": var_ratio,
    }
    ranking_reason = {
        "primary_driver": driver,
        "description": desc,
    }

    return score, raw_score, target_stats, ranking_reason, False


def compute_binary_score(
    y: np.ndarray,
    subgroup_mask: np.ndarray,
    min_group_size: int = 30,
    complexity: int = 1,
    lambda_penalty: float = 0.05,
    s_max: float = 50.0,
) -> tuple[float, float, dict[str, Any], dict[str, Any], bool] | None:
    """Compute binary score for proportion difference."""
    valid_y = ~np.isnan(y)
    sg_valid = subgroup_mask & valid_y
    comp_valid = (~subgroup_mask) & valid_y

    n_R = int(np.sum(sg_valid))
    n_comp = int(np.sum(comp_valid))

    if n_R < min_group_size or n_comp < min_group_size:
        return None

    N = n_R + n_comp
    p_R = float(np.mean(y[sg_valid]))
    p_comp = float(np.mean(y[comp_valid]))
    delta_p = p_R - p_comp

    size_weight = math.sqrt((n_R * n_comp) / N)
    raw_score = size_weight * abs(delta_p)

    score = min(raw_score, s_max) - lambda_penalty * complexity

    target_stats = {
        "subgroup_proportion": round(p_R, 3),
        "complement_proportion": round(p_comp, 3),
        "delta_proportion": round(delta_p, 3),
    }
    ranking_reason = {
        "primary_driver": "proportion_difference",
        "description": f"対象カテゴリ割合が補集合より{delta_p * 100:+.1f}%ポイント異なる",
    }

    return score, raw_score, target_stats, ranking_reason, False


def compute_kendall_emm_score(
    x: np.ndarray,
    y: np.ndarray,
    subgroup_mask: np.ndarray,
    min_group_size: int = 30,
    complexity: int = 1,
    lambda_penalty: float = 0.05,
    s_max: float = 50.0,
    include_reason: bool = False,
) -> tuple[float, float, dict[str, Any], dict[str, Any], dict[str, Any]] | tuple[tuple[float, float, dict[str, Any], dict[str, Any], dict[str, Any]] | None, str | None] | None:
    """Compute Kendall tau-b EMM score comparing subgroup tau vs complement tau.

    ``include_reason`` is used by the mining pipeline to distinguish a rejected
    candidate from a valid score without changing the normal public result.
    """
    valid = (~np.isnan(x)) & (~np.isnan(y))
    sg_valid = subgroup_mask & valid
    comp_valid = (~subgroup_mask) & valid

    n_R = int(np.sum(sg_valid))
    n_comp = int(np.sum(comp_valid))

    if n_R < min_group_size or n_comp < min_group_size:
        return (None, "insufficient_group_size") if include_reason else None

    N = n_R + n_comp
    x_R, y_R = x[sg_valid], y[sg_valid]
    x_comp, y_comp = x[comp_valid], y[comp_valid]

    if np.std(x_R) == 0 or np.std(y_R) == 0 or np.std(x_comp) == 0 or np.std(y_comp) == 0:
        return (None, "constant_value") if include_reason else None

    res_R = stats.kendalltau(x_R, y_R, variant="b")
    res_comp = stats.kendalltau(x_comp, y_comp, variant="b")

    tau_R = float(res_R.statistic) if not np.isnan(res_R.statistic) else None
    tau_comp = float(res_comp.statistic) if not np.isnan(res_comp.statistic) else None

    if tau_R is None or tau_comp is None:
        return (None, "undefined_tau") if include_reason else None

    delta_tau = tau_R - tau_comp
    size_weight = math.sqrt((n_R * n_comp) / N)
    raw_score = size_weight * abs(delta_tau)

    score = min(raw_score, s_max) - lambda_penalty * complexity

    reversal = bool((tau_comp > 0.2 and tau_R < -0.2) or (tau_comp < -0.2 and tau_R > 0.2))

    emm_stats = {
        "subgroup_tau": round(tau_R, 3),
        "complement_tau": round(tau_comp, 3),
        "delta_tau": round(delta_tau, 3),
        "reversal": reversal,
    }

    target_stats = {
        "subgroup_tau": round(tau_R, 3),
        "complement_tau": round(tau_comp, 3),
        "delta_tau": round(delta_tau, 3),
    }

    ranking_reason = {
        "primary_driver": "rank_correlation_reversal" if reversal else "rank_correlation_difference",
        "description": f"補集合の順位相関 ({tau_comp:+.2f}) に対し、サブグループは ({tau_R:+.2f}) と乖離",
    }

    result = (score, raw_score, target_stats, ranking_reason, emm_stats)
    return (result, None) if include_reason else result


def apply_effect_aware_diversity(
    candidates: list[RuleCandidate],
    top_k: int = 10,
    jaccard_threshold: float = 0.5,
    overlap_threshold: float = 0.8,
    min_effect_diff: float = 0.3,
    max_per_target: int = 3,
) -> list[RuleCandidate]:
    """Select Diverse Top-k candidates with effect-aware diversity and per-target quota."""
    if not candidates:
        return []

    sorted_cands = sorted(candidates, key=lambda c: c.score, reverse=True)
    selected: list[RuleCandidate] = []
    target_counts: dict[str, int] = {}

    for cand in sorted_cands:
        if len(selected) >= top_k:
            break

        target_key = cand.target_question or (":".join(cand.target_pair) if cand.target_pair else "default")
        current_target_count = target_counts.get(target_key, 0)
        if current_target_count >= max_per_target:
            continue

        is_redundant = False
        matching_parent: RuleCandidate | None = None
        parent_delta = None

        for sel in selected:
            sel_target_key = sel.target_question or (":".join(sel.target_pair) if sel.target_pair else "default")

            # Only check diversity/redundancy if looking at the same target concept
            if target_key != sel_target_key:
                continue

            c_cand = cand.bitmask
            c_sel = sel.bitmask

            intersection = int(np.sum(c_cand & c_sel))
            union = int(np.sum(c_cand | c_sel))
            min_size = min(int(np.sum(c_cand)), int(np.sum(c_sel)))

            jaccard = intersection / union if union > 0 else 0.0
            overlap = intersection / min_size if min_size > 0 else 0.0

            if jaccard >= jaccard_threshold or overlap >= overlap_threshold:
                effect_cand = 0.0
                effect_sel = 0.0

                if "delta_mean" in cand.target_stats and "delta_mean" in sel.target_stats:
                    effect_cand = cand.target_stats["delta_mean"]
                    effect_sel = sel.target_stats["delta_mean"]
                elif "delta_proportion" in cand.target_stats and "delta_proportion" in sel.target_stats:
                    effect_cand = cand.target_stats["delta_proportion"]
                    effect_sel = sel.target_stats["delta_proportion"]
                elif cand.emm_stats and sel.emm_stats:
                    effect_cand = cand.emm_stats["delta_tau"]
                    effect_sel = sel.emm_stats["delta_tau"]

                diff_effect = abs(effect_cand - effect_sel)
                opposite_direction = (
                    abs(effect_cand) >= min_effect_diff
                    and abs(effect_sel) >= min_effect_diff
                    and (effect_cand * effect_sel < 0)
                )

                if opposite_direction or diff_effect >= min_effect_diff:
                    # Meaningful exception or distinct effect -> keep!
                    sel_cols = set(sel.attribute_cols)
                    cand_cols = set(cand.attribute_cols)
                    if sel_cols.issubset(cand_cols) and len(sel_cols) < len(cand_cols):
                        matching_parent = sel
                        if "subgroup_mean" in cand.target_stats and "subgroup_mean" in sel.target_stats:
                            parent_delta = round(cand.target_stats["subgroup_mean"] - sel.target_stats["subgroup_mean"], 3)
                        elif "subgroup_proportion" in cand.target_stats and "subgroup_proportion" in sel.target_stats:
                            parent_delta = round(cand.target_stats["subgroup_proportion"] - sel.target_stats["subgroup_proportion"], 3)
                else:
                    is_redundant = True
                    break

        if not is_redundant:
            if matching_parent:
                cand.parent_insight_id = getattr(matching_parent, "id", None)
                cand.parent_delta_mean = parent_delta
            selected.append(cand)
            target_counts[target_key] = current_target_count + 1

    return selected


def run_modern_subgroup_mining(
    df: pl.DataFrame,
    target_questions: list[str] | None = None,
    mode: Literal["auto", "standard", "emm_kendall"] = "auto",
    target_binary_category: Any | None = None,
    attribute_cols: list[str] | None = None,
    column_meta: list[dict[str, Any]] | None = None,
    max_depth: int = 2,
    beam_width: int = 30,
    min_group_size: int = 30,
    top_k: int = 10,
    jaccard_threshold: float = 0.5,
    overlap_threshold: float = 0.8,
    min_effect_diff: float | None = None,
    lambda_penalty: float = 0.05,
    s_max: float = 50.0,
    max_per_target: int = 3,
    row_id_col: str | None = None,
) -> dict[str, Any]:
    """Omnipresent Auto-Mining pipeline.
    If target_questions is None or empty, automatically evaluates all questions & prominent pairs.
    """
    if df.height < 2:
        return {
            "run_id": str(uuid.uuid4()),
            "mode": mode,
            "generated_at": datetime.datetime.now().isoformat(),
            "config": {
                "max_depth": max_depth,
                "beam_width": beam_width,
                "min_group_size": min_group_size,
                "top_k": top_k,
            },
            "summary": {
                "n_candidates_evaluated": 0,
                "n_insights_returned": 0,
                "effective_min_group_size": min_group_size,
            },
            "insights": [],
            "emmDiagnostics": {
                "status": "insufficient_rows" if mode in ("auto", "emm_kendall") else "not_requested",
                "requestedQuestions": list(target_questions or []),
                "eligibleQuestions": [],
                "ineligibleQuestions": [],
                "pairsEvaluated": 0,
                "evaluationsAttempted": 0,
                "acceptedCandidates": 0,
                "rejectionCounts": {
                    "insufficient_group_size": 0,
                    "constant_value": 0,
                    "undefined_tau": 0,
                },
            },
        }

    adapter = CodebookAdapter(df, {"columns": column_meta or []})
    has_codebook = any("scaleType" in c for c in (column_meta or []))
    requested_attributes = attribute_cols
    if has_codebook:
        df = df.with_columns([
            adapter.analysis_series(c) if (adapter.get_column_spec_optional(c) or {}).get("role") == "question"
            else adapter.mask_missing_values(c)
            for c in df.columns if adapter.get_column_spec_optional(c)
        ])
    actual_row_id = row_id_col
    if not actual_row_id:
        for c in ["__rowId__", "id", "ID", "row_id", "rowId"]:
            if c in df.columns:
                actual_row_id = c
                break

    all_row_ids = [str(r) for r in df[actual_row_id].to_list()] if actual_row_id else [str(i) for i in range(df.height)]
    df_with_id = df if actual_row_id else df.with_columns(pl.Series("__rowId__", all_row_ids))
    actual_row_id = actual_row_id or "__rowId__"

    meta_by_col: dict[str, dict[str, Any]] = {}
    if column_meta:
        for m in column_meta:
            if m.get("columnId"):
                meta_by_col[m["columnId"]] = m
            if m.get("name"):
                meta_by_col[m["name"]] = m

    all_cols = [c for c in df.columns if c != actual_row_id]

    # Detect questions
    if target_questions and len(target_questions) > 0:
        eval_questions = [c for c in target_questions if c in all_cols]
    else:
        # Omnipresent mode: primary target questions should be numeric/continuous/ordinal
        eval_questions = []
        for c in all_cols:
            meta = meta_by_col.get(c, {})
            role = meta.get("role")
            sem_type = meta.get("semanticType")
            dtype = df_with_id[c].dtype

            if role == "question":
                eval_questions.append(c)
            elif role != "attribute":
                # Numeric or integer columns are prime targets
                if dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64):
                    eval_questions.append(c)
                elif sem_type in ("numeric", "ordinal"):
                    eval_questions.append(c)

        # Fallback if no numeric columns found: allow columns with 2 categories as binary target
        if not eval_questions:
            for c in all_cols:
                if df_with_id[c].n_unique() == 2:
                    eval_questions.append(c)

    # Detect attributes (condition selectors)
    if not attribute_cols:
        attribute_cols = []
        for c in all_cols:
            meta = meta_by_col.get(c, {})
            role = meta.get("role")
            sem_type = meta.get("semanticType")
            dtype = df_with_id[c].dtype
            n_unique = df_with_id[c].n_unique()

            if role == "attribute":
                attribute_cols.append(c)
            elif role != "question":
                # Categorical or string columns with reasonable unique levels
                if dtype == pl.String or sem_type == "categorical":
                    if 2 <= n_unique <= 100:
                        attribute_cols.append(c)
                elif sem_type == "ordinal":
                    attribute_cols.append(c)
                elif dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64):
                    # Numeric columns can also be used as selectors (quartile cuts)
                    attribute_cols.append(c)

    if has_codebook:
        allowed_questions = adapter.get_question_columns()
        allowed_attributes = adapter.get_attribute_columns()
        eval_questions = [c for c in (target_questions if target_questions is not None else allowed_questions) if c in allowed_questions]
        attribute_cols = [c for c in (requested_attributes if requested_attributes is not None else allowed_attributes) if c in allowed_attributes]

    effective_min_group_size = min_group_size

    # Pre-generate attribute descriptors
    # Only explicitly designated question columns (role == "question") are strictly excluded from attribute descriptors,
    # as long as there are attributes available.
    explicit_questions = {c for c in eval_questions if meta_by_col.get(c, {}).get("role") == "question"}
    if target_questions and not attribute_cols:
        explicit_questions.update(target_questions)
    excluded = explicit_questions
    descriptors = generate_descriptors(df_with_id, attribute_cols, excluded, column_meta=meta_by_col)
    for cond, _ in descriptors:
        cond.label = adapter.condition_label(cond.column, cond.operator, cond.value)

    # Build rule candidate tree up to max_depth
    # Each item: (conditions, mask)
    generated_rules: list[tuple[list[Condition], np.ndarray]] = []
    def _rule_canonical_key(conds: list[Condition]) -> tuple:
        return tuple(sorted(((c.column, c.operator, c.value) for c in conds), key=lambda x: (x[0], x[1], str(x[2]))))

    seen_rules: set[tuple] = set()

    # Depth 1 rules
    current_rule_beam: list[tuple[list[Condition], np.ndarray, int]] = []
    for cond, mask in descriptors:
        sub_n = int(np.sum(mask))
        if sub_n < effective_min_group_size:
            continue
        rule_key = _rule_canonical_key([cond])
        if rule_key in seen_rules:
            continue
        seen_rules.add(rule_key)
        rule_tuple = ([cond], mask)
        generated_rules.append(rule_tuple)
        current_rule_beam.append(([cond], mask, sub_n))

    # Depth 2..max_depth
    for d in range(2, max_depth + 1):
        next_rule_beam: list[tuple[list[Condition], np.ndarray, int]] = []
        for parent_conds, parent_mask, _ in current_rule_beam:
            parent_cols = {c.column for c in parent_conds}
            for desc_cond, desc_mask in descriptors:
                if desc_cond.column in parent_cols:
                    continue
                child_mask = parent_mask & desc_mask
                child_n = int(np.sum(child_mask))
                if child_n < effective_min_group_size:
                    continue
                child_conds = parent_conds + [desc_cond]
                rule_key = _rule_canonical_key(child_conds)
                if rule_key in seen_rules:
                    continue
                seen_rules.add(rule_key)
                rule_tuple = (child_conds, child_mask)
                generated_rules.append(rule_tuple)
                next_rule_beam.append((child_conds, child_mask, child_n))
        current_rule_beam = next_rule_beam[:beam_width * 2]

    # Prepare target questions arrays
    question_arrays: dict[str, tuple[np.ndarray, bool, float]] = {}  # col -> (array, is_binary, overall_sd)
    for q in eval_questions:
        meta = meta_by_col.get(q, {})
        sem_type = {"nominal": "categorical", "ordinal": "numeric", "interval": "numeric", "ratio": "numeric"}.get(meta.get("scaleType"), meta.get("semanticType"))
        t_series = df_with_id[q]
        dtype = t_series.dtype

        is_binary = False
        target_cat = 1 if meta.get('multiResponseGroup') else target_binary_category

        if target_cat is not None or sem_type == "binary":
            is_binary = True
        elif dtype == pl.String or sem_type == "categorical":
            from ...domain.codebook_adapter import normalize_code as _normalize_code
            non_null_unique = sorted({_normalize_code(v) for v in t_series.drop_nulls().to_list()
                                      if _normalize_code(v) is not None})
            if len(non_null_unique) == 2:
                is_binary = True
                if target_cat is None:
                    target_cat = non_null_unique[0]
            else:
                continue

        if is_binary:
            from ...domain.codebook_adapter import normalize_code as _normalize_code
            vals = t_series.to_list()
            target_norm = _normalize_code(target_cat)
            arr = np.array([
                np.nan if _normalize_code(v) is None else (1.0 if _normalize_code(v) == target_norm else 0.0)
                for v in vals
            ], dtype=float)
            sd = float(np.nanstd(arr)) if len(arr) > 0 else 1.0
            question_arrays[q] = (arr, True, sd)
        else:
            vals = t_series.to_list()
            converted = []
            can_convert = True
            for v in vals:
                if v is None:
                    converted.append(np.nan)
                else:
                    try:
                        converted.append(float(v))
                    except (ValueError, TypeError):
                        can_convert = False
                        break
            if not can_convert:
                continue
            arr = np.array(converted, dtype=float)
            valid_arr = arr[~np.isnan(arr)]
            sd = float(np.std(valid_arr, ddof=1)) if len(valid_arr) > 1 else 1.0
            question_arrays[q] = (arr, False, sd)

    candidate_pool: list[RuleCandidate] = []
    emm_diagnostics: dict[str, Any] = {
        "status": "not_requested",
        "requestedQuestions": list(target_questions or []),
        "eligibleQuestions": [],
        "ineligibleQuestions": [],
        "pairsEvaluated": 0,
        "evaluationsAttempted": 0,
        "acceptedCandidates": 0,
        "rejectionCounts": {
            "insufficient_group_size": 0,
            "constant_value": 0,
            "undefined_tau": 0,
        },
    }

    # 1. Standard Single Question Evaluation across all questions
    if mode in ("auto", "standard"):
        for q, (arr, is_binary, q_sd) in question_arrays.items():
            for conds, mask in generated_rules:
                if any(c.column == q for c in conds):
                    continue
                complexity = len(conds)
                if is_binary:
                    res = compute_binary_score(
                        y=arr,
                        subgroup_mask=mask,
                        min_group_size=effective_min_group_size,
                        complexity=complexity,
                        lambda_penalty=lambda_penalty,
                        s_max=s_max,
                    )
                    if res:
                        sc, r_sc, t_stats, reason, comp_sep = res
                        t_stats["overall_mean"] = round(float(np.nanmean(arr)), 3)
                        r_ids = [all_row_ids[i] for i, b in enumerate(mask) if b]
                        candidate_pool.append(RuleCandidate(
                            conditions=conds,
                            attribute_cols=[c.column for c in conds],
                            row_ids=r_ids,
                            bitmask=mask,
                            n_subgroup=int(np.sum(mask)),
                            n_complement=int(np.sum(~mask)),
                            score=round(sc, 2),
                            raw_score=round(r_sc, 2),
                            target_stats=t_stats,
                            ranking_reason=reason,
                            target_question=q,
                            complete_separation=comp_sep,
                        ))
                else:
                    res = compute_numeric_score(
                        y=arr,
                        subgroup_mask=mask,
                        min_group_size=effective_min_group_size,
                        complexity=complexity,
                        lambda_penalty=lambda_penalty,
                        s_max=s_max,
                    )
                    if res:
                        sc, r_sc, t_stats, reason, comp_sep = res
                        t_stats["overall_mean"] = round(float(np.nanmean(arr)), 3)
                        r_ids = [all_row_ids[i] for i, b in enumerate(mask) if b]
                        candidate_pool.append(RuleCandidate(
                            conditions=conds,
                            attribute_cols=[c.column for c in conds],
                            row_ids=r_ids,
                            bitmask=mask,
                            n_subgroup=int(np.sum(mask)),
                            n_complement=int(np.sum(~mask)),
                            score=round(sc, 2),
                            raw_score=round(r_sc, 2),
                            target_stats=t_stats,
                            ranking_reason=reason,
                            target_question=q,
                            complete_separation=comp_sep,
                        ))

    # 2. Kendall-EMM Pairs Evaluation
    if mode in ("auto", "emm_kendall"):
        # Kendall tau-b needs two non-binary, numeric question variables.
        emm_valid_questions = [
            q for q in eval_questions
            if q in question_arrays and not question_arrays[q][1]
        ]
        emm_diagnostics["status"] = "pending"
        emm_diagnostics["eligibleQuestions"] = emm_valid_questions
        pairs_to_eval: list[tuple[str, str]] = []

        if mode == "emm_kendall" and target_questions and len(target_questions) == 2:
            selected_pair = (target_questions[0], target_questions[1])
            emm_diagnostics["selectedPair"] = list(selected_pair)
            if selected_pair[0] == selected_pair[1]:
                emm_diagnostics["status"] = "selected_pair_ineligible"
                emm_diagnostics["ineligibleQuestions"] = [{
                    "column": selected_pair[0],
                    "reason": "duplicate_pair",
                }]
            else:
                ineligible_questions = []
                for question in selected_pair:
                    if question in emm_valid_questions:
                        continue
                    if question in question_arrays and question_arrays[question][1]:
                        reason = "binary_question"
                    elif question in eval_questions:
                        reason = "non_numeric_question"
                    else:
                        reason = "unsupported_target_type"
                    ineligible_questions.append({"column": question, "reason": reason})
                if ineligible_questions:
                    emm_diagnostics["status"] = "selected_pair_ineligible"
                    emm_diagnostics["ineligibleQuestions"] = ineligible_questions
                else:
                    pairs_to_eval = [selected_pair]
        elif len(emm_valid_questions) < 2:
            emm_diagnostics["status"] = "requires_two_eligible_questions"
        else:
            # Pick top prominent pairs for automatic EMM exploration.
            all_possible_pairs = list(itertools.combinations(emm_valid_questions[:8], 2))
            pairs_to_eval = all_possible_pairs[:15]

        emm_diagnostics["pairsEvaluated"] = len(pairs_to_eval)
        for q1, q2 in pairs_to_eval:
            arr1, _, _ = question_arrays[q1]
            arr2, _, _ = question_arrays[q2]

            for conds, mask in generated_rules:
                if any(c.column in (q1, q2) for c in conds):
                    continue
                complexity = len(conds)
                result_with_reason = compute_kendall_emm_score(
                    x=arr1,
                    y=arr2,
                    subgroup_mask=mask,
                    min_group_size=effective_min_group_size,
                    complexity=complexity,
                    lambda_penalty=lambda_penalty,
                    s_max=s_max,
                    include_reason=True,
                )
                res_emm, rejection_reason = result_with_reason
                emm_diagnostics["evaluationsAttempted"] += 1
                if rejection_reason:
                    rejection_counts = emm_diagnostics["rejectionCounts"]
                    rejection_counts[rejection_reason] = rejection_counts.get(rejection_reason, 0) + 1
                    continue
                if not res_emm:
                    continue

                sc, r_sc, t_stats, reason, emm_st = res_emm
                r_ids = [all_row_ids[i] for i, b in enumerate(mask) if b]
                candidate_pool.append(RuleCandidate(
                    conditions=conds,
                    attribute_cols=[c.column for c in conds],
                    row_ids=r_ids,
                    bitmask=mask,
                    n_subgroup=int(np.sum(mask)),
                    n_complement=int(np.sum(~mask)),
                    score=round(sc, 2),
                    raw_score=round(r_sc, 2),
                    target_stats=t_stats,
                    ranking_reason=reason,
                    target_pair=[q1, q2],
                    emm_stats=emm_st,
                ))
                emm_diagnostics["acceptedCandidates"] += 1

        if emm_diagnostics["status"] == "pending":
            if not pairs_to_eval:
                emm_diagnostics["status"] = "no_evaluable_pairs"
            elif emm_diagnostics["evaluationsAttempted"] == 0:
                emm_diagnostics["status"] = "no_evaluable_rules"
            elif emm_diagnostics["acceptedCandidates"] == 0:
                emm_diagnostics["status"] = "no_valid_candidate"
            else:
                emm_diagnostics["status"] = "results_found"

    # Cross-question diversity selection
    diverse_top_k = apply_effect_aware_diversity(
        candidates=candidate_pool,
        top_k=top_k,
        jaccard_threshold=jaccard_threshold,
        overlap_threshold=overlap_threshold,
        min_effect_diff=min_effect_diff if min_effect_diff is not None else 0.3,
        max_per_target=max_per_target,
    )

    # Format insights
    insights_out = []
    for i, cand in enumerate(diverse_top_k):
        ins_id = f"msd_{i + 1:03d}"
        setattr(cand, "id", ins_id)

        cond_texts = [c.label for c in cand.conditions]
        full_text = " かつ ".join(cond_texts)

        if cand.target_question:
            t_label = (adapter.get_column_spec_optional(cand.target_question) or {}).get("label") or cand.target_question
            if "delta_proportion" in cand.target_stats:
                delta = float(cand.target_stats["delta_proportion"])
                direction = "高く" if delta > 1e-12 else ("低く" if delta < -1e-12 else "同じで")
                if abs(delta) <= 1e-12:
                    narrative = (
                        f"「{full_text}」の層（{cand.n_subgroup}名, {cand.n_subgroup / df.height * 100:.1f}%）は、"
                        f"質問【{t_label}】の該当割合に補集合との実質差がありません。"
                    )
                else:
                    narrative = (
                        f"「{full_text}」の層（{cand.n_subgroup}名, {cand.n_subgroup / df.height * 100:.1f}%）は、"
                        f"質問【{t_label}】の該当割合が補集合に比べ{abs(delta) * 100:.1f}%ポイント{direction}なります。"
                    )
            else:
                if cand.parent_insight_id and cand.parent_delta_mean is not None:
                    narrative = (
                        f"「{full_text}」の層（{cand.n_subgroup}名, {cand.n_subgroup / df.height * 100:.1f}%）は、"
                        f"質問【{t_label}】において親集団よりさらに平均{cand.parent_delta_mean:+.2f}異なる突出・例外セグメントです。"
                    )
                else:
                    _delta = float(cand.target_stats.get("delta_mean", 0.0))
                    _direction = "高く" if _delta > 1e-12 else ("低く" if _delta < -1e-12 else "同じで")
                    if abs(_delta) <= 1e-12:
                        narrative = (
                            f"「{full_text}」の層（{cand.n_subgroup}名, {cand.n_subgroup / df.height * 100:.1f}%）は、"
                            f"質問【{t_label}】において補集合との実質差がありません。"
                        )
                    else:
                        narrative = (
                            f"「{full_text}」の層（{cand.n_subgroup}名, {cand.n_subgroup / df.height * 100:.1f}%）は、"
                            f"質問【{t_label}】において補集合に比べ平均{abs(_delta):.2f}{_direction}、回答がまとまっています。"
                        )
        else:
            q_pair_str = f"{cand.target_pair[0]} × {cand.target_pair[1]}" if cand.target_pair else "質問ペア"
            rev_text = "（順位相関が逆転）" if cand.emm_stats and cand.emm_stats.get("reversal") else ""
            narrative = (
                f"「{full_text}」の層（{cand.n_subgroup}名, {cand.n_subgroup / df.height * 100:.1f}%）は、"
                f"【{q_pair_str}】の順位相関が他群（{cand.emm_stats['complement_tau']:+.2f}）に対し、"
                f"サブグループ内では（{cand.emm_stats['subgroup_tau']:+.2f}）と大きく乖離しています{rev_text}。"
            )

        insights_out.append({
            "id": ins_id,
            "target_question": cand.target_question,
            "target_pair": cand.target_pair,
            "rule": {
                "conditions": [c.to_dict() for c in cand.conditions],
                "complexity": len(cand.conditions),
                "text": full_text,
            },
            "coverage": {
                "n": cand.n_subgroup,
                "ratio": round(cand.n_subgroup / df.height, 3),
                "row_ids": cand.row_ids,
            },
            "target_stats": cand.target_stats,
            "ranking_reason": cand.ranking_reason,
            "score": cand.score,
            "complete_separation": cand.complete_separation,
            "parent_insight_id": cand.parent_insight_id,
            "parent_delta_mean": cand.parent_delta_mean,
            "emm_stats": cand.emm_stats,
            "narrative": narrative,
        })

    skipped = sorted({q for q in (target_questions or []) if q not in question_arrays}
                     | {q for q in eval_questions if q not in question_arrays})
    skipped_targets = [{"column": q,
                        "reason": "unsupported_target_type",
                        "detail": "二値化できない3値以上の名義尺度は対象外です。"} for q in skipped]
    return {
        "run_id": str(uuid.uuid4()),
        "mode": mode,
        "summary": {
            "total_candidates_explored": len(seen_rules) * max(1, len(eval_questions)),
            "non_redundant_insights_count": len(insights_out),
            "questions_evaluated_count": len(question_arrays),
            "questions_requested_count": len(eval_questions),
            "skippedTargets": skipped_targets,
        },
        "emmDiagnostics": emm_diagnostics,
        "insights": insights_out,
    }
