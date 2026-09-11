"""Estimand-preserving tests for pinned mining candidates (Feature 24 / VERIFY-01).

Verification must re-test the contrast that exploration reported, on the
evaluation partition only:

- classic numeric candidate  -> Welch two-sample test of mean(level A) - mean(level B)
- classic categorical candidate -> 2x2 comparison of a cell proportion vs the rest
- modern rule candidate -> rule-matched rows vs their complement within scope

Testing the raw question column against 0 (the previous behaviour) answers a
different question entirely and is never done here.

Numeric answers are the only ones that participate in the Welch/mean tests;
weighted variants use reliability weights and the effective sample size.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import polars as pl
from scipy import stats

from ...domain.mining_candidate import (
    ESTIMAND_MEAN_DIFFERENCE,
    ESTIMAND_PROPORTION_DIFFERENCE,
    ESTIMAND_TAU_DIFFERENCE,
    PinnedCandidate,
)

# Evaluation splits are smaller than the exploration scope, so the default
# minimum group size for a test is lower than the exploration default (30).
DEFAULT_MIN_GROUP_SIZE = 10
PERMUTATIONS = 500
ALPHA = 0.05


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------
def _float_array(series: pl.Series) -> np.ndarray:
    try:
        return series.cast(pl.Float64, strict=False).to_numpy().astype(np.float64)
    except Exception:
        return np.full(series.len(), np.nan, dtype=np.float64)


def _object_array(series: pl.Series) -> np.ndarray:
    return np.array(series.to_list(), dtype=object)


def _safe_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return None if number != number else number
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return None


def level_mask(values: np.ndarray, level: Any) -> np.ndarray:
    """Match a level either by its string form or, failing that, numerically."""
    target = str(level)
    mask = np.array([value is not None and str(value) == target for value in values], dtype=bool)
    if mask.any():
        return mask
    wanted = _safe_float(level)
    if wanted is None:
        return mask
    return np.array([(_safe_float(v) == wanted) for v in values], dtype=bool)


def _finite_mask(values: np.ndarray) -> np.ndarray:
    return np.array([v is not None and not (isinstance(v, float) and math.isnan(v))
                     for v in values], dtype=bool)


def _weighted_mean_var(values: np.ndarray, weights: np.ndarray) -> tuple[float, float, float]:
    """Return (weighted mean, unbiased weighted variance, effective n)."""
    total = float(weights.sum())
    if total <= 0:
        return float("nan"), float("nan"), 0.0
    mean = float(np.sum(weights * values) / total)
    square_sum = float(np.sum(weights ** 2))
    denom = total - (square_sum / total)
    if denom <= 0:
        variance = 0.0
    else:
        variance = float(np.sum(weights * (values - mean) ** 2) / denom)
    effective_n = (total ** 2) / square_sum if square_sum > 0 else 0.0
    return mean, variance, effective_n


def _unweighted_mean_var(values: np.ndarray) -> tuple[float, float, float]:
    n = int(values.size)
    if n == 0:
        return float("nan"), float("nan"), 0.0
    mean = float(np.mean(values))
    variance = float(np.var(values, ddof=1)) if n > 1 else 0.0
    return mean, variance, float(n)


def _summary(values: np.ndarray, weights: np.ndarray | None) -> tuple[float, float, float]:
    if weights is None:
        return _unweighted_mean_var(values)
    return _weighted_mean_var(values, weights)


def _welch(a: np.ndarray, b: np.ndarray,
           weights_a: np.ndarray | None = None,
           weights_b: np.ndarray | None = None,
           alpha: float = ALPHA) -> dict[str, Any]:
    mean_a, var_a, n_a = _summary(a, weights_a)
    mean_b, var_b, n_b = _summary(b, weights_b)
    effect = mean_a - mean_b
    if n_a <= 1 or n_b <= 1:
        return {"name": "welch_two_sample", "statistic": None, "pValue": None,
                "df": None, "estimate": effect, "ci95": None,
                "meanA": mean_a, "meanB": mean_b, "nA": n_a, "nB": n_b,
                "varA": var_a, "varB": var_b}
    se_sq = (var_a / n_a) + (var_b / n_b)
    if se_sq <= 0:
        return {"name": "welch_two_sample", "statistic": None, "pValue": None,
                "df": None, "estimate": effect, "ci95": None,
                "meanA": mean_a, "meanB": mean_b, "nA": n_a, "nB": n_b,
                "varA": var_a, "varB": var_b}
    se = math.sqrt(se_sq)
    statistic = effect / se
    df_value = se_sq ** 2 / (
        ((var_a / n_a) ** 2) / max(n_a - 1, 1) + ((var_b / n_b) ** 2) / max(n_b - 1, 1)
    ) if se_sq > 0 else 0.0
    p_value = float(2 * stats.t.sf(abs(statistic), max(df_value, 1e-9)))
    t_crit = float(stats.t.ppf(1 - alpha / 2, max(df_value, 1e-9)))
    return {"name": "welch_two_sample", "statistic": float(statistic), "pValue": p_value,
            "df": float(df_value), "estimate": float(effect),
            "ci95": [float(effect - t_crit * se), float(effect + t_crit * se)],
            "meanA": mean_a, "meanB": mean_b, "nA": n_a, "nB": n_b,
            "varA": var_a, "varB": var_b}


def _cohens_d(a: np.ndarray, b: np.ndarray,
              weights_a: np.ndarray | None = None,
              weights_b: np.ndarray | None = None) -> float | None:
    _, var_a, n_a = _summary(a, weights_a)
    _, var_b, n_b = _summary(b, weights_b)
    if n_a <= 0 or n_b <= 0:
        return None
    pooled = math.sqrt((var_a + var_b) / 2.0)
    if pooled <= 0:
        return None
    mean_a, _, _ = _summary(a, weights_a)
    mean_b, _, _ = _summary(b, weights_b)
    return float((mean_a - mean_b) / pooled)


def _kendall_tau(x: np.ndarray, y: np.ndarray) -> float | None:
    if x.size < 3 or y.size < 3:
        return None
    result = stats.kendalltau(x, y)
    tau = float(result.statistic) if hasattr(result, "statistic") else float(result[0])
    if not math.isfinite(tau):
        return None
    return tau


def _tau_difference(x: np.ndarray, y: np.ndarray, mask: np.ndarray,
                    seed: int) -> dict[str, Any]:
    def _tau(selector: np.ndarray) -> float | None:
        xs, ys = x[selector], y[selector]
        valid = ~np.isnan(xs) & ~np.isnan(ys)
        return _kendall_tau(xs[valid], ys[valid])

    tau_sub = _tau(mask)
    tau_comp = _tau(~mask)
    if tau_sub is None or tau_comp is None:
        return {"name": "kendall_tau_difference", "statistic": None, "pValue": None,
                "estimate": None, "ci95": None, "subgroupTau": tau_sub, "complementTau": tau_comp,
                "permutations": PERMUTATIONS}
    observed = tau_sub - tau_comp
    rng = np.random.default_rng(seed)
    order = np.arange(mask.size)
    extreme = 0
    n_sub = int(mask.sum())
    for _ in range(PERMUTATIONS):
        shuffled = rng.permutation(order)
        perm_mask = np.zeros_like(mask)
        perm_mask[shuffled[:n_sub]] = True
        t_perm_sub = _tau(perm_mask)
        t_perm_comp = _tau(~perm_mask)
        if t_perm_sub is None or t_perm_comp is None:
            continue
        if abs(t_perm_sub - t_perm_comp) >= abs(observed) - 1e-12:
            extreme += 1
    p_value = (extreme + 1) / (PERMUTATIONS + 1)
    return {"name": "kendall_tau_difference", "statistic": float(observed),
            "pValue": float(p_value), "estimate": float(observed), "ci95": None,
            "subgroupTau": tau_sub, "complementTau": tau_comp,
            "permutations": PERMUTATIONS}


def _two_by_two(table: np.ndarray, alpha: float = ALPHA) -> dict[str, Any]:
    """Chi-square with the exact test when any expected count is small."""
    total = float(table.sum())
    if total <= 0:
        return {"name": "chi2_2x2", "statistic": None, "pValue": None, "estimate": None}
    expected = np.outer(table.sum(axis=1), table.sum(axis=0)) / total
    row = table[0]
    n_row = float(row.sum())
    n_other = float(table[1].sum())
    p_row = float(row[0] / n_row) if n_row > 0 else 0.0
    p_other = float(table[1][0] / n_other) if n_other > 0 else 0.0
    effect = p_row - p_other
    if (expected < 5).any() or table.shape != (2, 2):
        result = stats.fisher_exact(table.astype(int))
        p_value = float(result[1]) if hasattr(result, "__len__") else float(result.pvalue)
        return {"name": "fisher_exact", "statistic": None, "pValue": p_value,
                "estimate": effect, "pRow": p_row, "pOther": p_other}
    chi2_stat, p_value, _, _ = stats.chi2_contingency(table, correction=False)
    return {"name": "chi2_2x2", "statistic": float(chi2_stat), "pValue": float(p_value),
            "estimate": effect, "pRow": p_row, "pOther": p_other}


def _not_testable(candidate: PinnedCandidate, reason: str, detail: dict[str, Any],
                  evaluation_n: int) -> dict[str, Any]:
    return {
        "candidateId": candidate.candidateId,
        "estimand": candidate.estimand,
        "testable": False,
        "reason": reason,
        "detail": detail,
        "effect": None,
        "test": None,
        "n": {"evaluation": evaluation_n, "used": 0},
        "directionConsistent": None,
        "replicationStatus": "not_testable",
        "warnings": [{"code": reason, "message": _reason_message(reason)}],
    }


def _reason_message(reason: str) -> str:
    messages = {
        "INSUFFICIENT_GROUP_SIZE": "評価データ内の群サイズが最小群サイズに達しないため検定できません。",
        "COLUMN_NOT_FOUND": "評価データに必要な列が存在しません。",
        "NO_VALID_VALUES": "評価データに有効な値がありません。",
        "EMPTY_REFERENCE": "比較対象（補集合）に有効な行がありません。",
    }
    return messages.get(reason, "検定できません。")


# --------------------------------------------------------------------------
# public API
# --------------------------------------------------------------------------
def compute_estimand(
    frame: pl.DataFrame,
    candidate: PinnedCandidate,
    weights: np.ndarray | None = None,
    min_group_size: int = DEFAULT_MIN_GROUP_SIZE,
    seed: int = 42,
    alpha: float = ALPHA,
) -> dict[str, Any]:
    """Re-compute the exploration contrast on ``frame`` (the evaluation partition)."""
    estimand_type = str((candidate.estimand or {}).get("type") or ESTIMAND_MEAN_DIFFERENCE)
    if estimand_type == ESTIMAND_PROPORTION_DIFFERENCE:
        return _compute_proportion(frame, candidate, weights, min_group_size, alpha)
    if estimand_type == ESTIMAND_TAU_DIFFERENCE:
        return _compute_tau(frame, candidate, weights, min_group_size, seed)
    return _compute_mean_difference(frame, candidate, weights, min_group_size, alpha)


TEST_KEYS = ("name", "statistic", "pValue", "df", "permutations")


def _finish(candidate: PinnedCandidate, result: dict[str, Any], used: int,
            evaluation_n: int) -> dict[str, Any]:
    exploration = candidate.explorationEffect
    effect = result.get("estimate")
    consistent: bool | None = None
    if exploration is not None and effect is not None:
        if abs(exploration) <= 1e-12 or abs(effect) <= 1e-12:
            consistent = abs(effect) <= 1e-12
        else:
            consistent = (exploration > 0) == (effect > 0)
    if consistent is None:
        status = "not_comparable"
    elif consistent:
        status = "replicated"
    else:
        status = "reversed"
    return {
        "candidateId": candidate.candidateId,
        "estimand": candidate.estimand,
        "testable": True,
        "reason": None,
        # The estimate object: estimate / ci95 / groupStats / meanA / meanB …
        "effect": {key: value for key, value in result.items() if key not in TEST_KEYS},
        "test": {"name": result.get("name"),
                 "statistic": result.get("statistic"),
                 "pValue": result.get("pValue"),
                 "df": result.get("df"),
                 "permutations": result.get("permutations")},
        "n": {"evaluation": evaluation_n, "used": used},
        "directionConsistent": consistent,
        "replicationStatus": status,
        "warnings": [],
    }


def _compute_mean_difference(frame: pl.DataFrame, candidate: PinnedCandidate,
                             weights: np.ndarray | None, min_group_size: int,
                             alpha: float) -> dict[str, Any]:
    rule = candidate.rule or {}
    attribute = str(((rule.get("attribute") or {}).get("column")) or "")
    question = str(((rule.get("question") or {}).get("column")) or "")
    if candidate.algorithm == "modern":
        return _compute_modern_mean(frame, candidate, weights, min_group_size, alpha)
    if attribute not in frame.columns or question not in frame.columns:
        return _not_testable(candidate, "COLUMN_NOT_FOUND",
                             {"attribute": attribute, "question": question}, frame.height)
    numerator_level = (candidate.estimand or {}).get("numerator")
    denominator_level = (candidate.estimand or {}).get("denominator")
    levels = _object_array(frame[attribute])
    values = _float_array(frame[question])
    numerator_mask = level_mask(levels, numerator_level)
    denominator_mask = level_mask(levels, denominator_level)
    valid = _finite_mask(values)
    numerator_values = values[numerator_mask & valid]
    denominator_values = values[denominator_mask & valid]
    if numerator_values.size < min_group_size or denominator_values.size < min_group_size:
        return _not_testable(candidate, "INSUFFICIENT_GROUP_SIZE",
                             {"numeratorN": int(numerator_values.size),
                              "denominatorN": int(denominator_values.size),
                              "minGroupSize": int(min_group_size)}, frame.height)
    w_a = weights[numerator_mask & valid] if weights is not None else None
    w_b = weights[denominator_mask & valid] if weights is not None else None
    result = _welch(numerator_values, denominator_values, w_a, w_b, alpha)
    result["cohensD"] = _cohens_d(numerator_values, denominator_values, w_a, w_b)
    result["groupStats"] = [
        {"label": str(numerator_level), "n": int(numerator_values.size),
         "mean": result["meanA"], "sd": math.sqrt(result["varA"]) if result["varA"] == result["varA"] else None},
        {"label": str(denominator_level), "n": int(denominator_values.size),
         "mean": result["meanB"], "sd": math.sqrt(result["varB"]) if result["varB"] == result["varB"] else None},
    ]
    result["weighted"] = weights is not None
    used = int(numerator_values.size + denominator_values.size)
    return _finish(candidate, result, used, frame.height)


def _compute_modern_mean(frame: pl.DataFrame, candidate: PinnedCandidate,
                         weights: np.ndarray | None, min_group_size: int,
                         alpha: float) -> dict[str, Any]:
    from .modern_subgroup import evaluate_condition_dict

    rule = candidate.rule or {}
    conditions = rule.get("conditions") or []
    target = str(rule.get("targetQuestion") or "")
    if target not in frame.columns:
        return _not_testable(candidate, "COLUMN_NOT_FOUND", {"target": target}, frame.height)
    mask = np.ones(frame.height, dtype=bool)
    for condition in conditions:
        try:
            mask &= evaluate_condition_dict(condition, frame)
        except Exception:
            return _not_testable(candidate, "COLUMN_NOT_FOUND",
                                 {"condition": condition}, frame.height)
    values = _float_array(frame[target])
    valid = _finite_mask(values)
    subgroup_values = values[mask & valid]
    complement_values = values[(~mask) & valid]
    if subgroup_values.size < min_group_size or complement_values.size < min_group_size:
        return _not_testable(candidate, "INSUFFICIENT_GROUP_SIZE",
                             {"numeratorN": int(subgroup_values.size),
                              "denominatorN": int(complement_values.size),
                              "minGroupSize": int(min_group_size)}, frame.height)
    w_a = weights[mask & valid] if weights is not None else None
    w_b = weights[(~mask) & valid] if weights is not None else None
    result = _welch(subgroup_values, complement_values, w_a, w_b, alpha)
    result["cohensD"] = _cohens_d(subgroup_values, complement_values, w_a, w_b)
    result["groupStats"] = [
        {"label": "条件一致", "n": int(subgroup_values.size), "mean": result["meanA"],
         "sd": math.sqrt(result["varA"]) if result["varA"] == result["varA"] else None},
        {"label": "補集合", "n": int(complement_values.size), "mean": result["meanB"],
         "sd": math.sqrt(result["varB"]) if result["varB"] == result["varB"] else None},
    ]
    result["weighted"] = weights is not None
    used = int(subgroup_values.size + complement_values.size)
    return _finish(candidate, result, used, frame.height)


def _compute_tau(frame: pl.DataFrame, candidate: PinnedCandidate,
                 weights: np.ndarray | None, min_group_size: int,
                 seed: int) -> dict[str, Any]:
    from .modern_subgroup import evaluate_condition_dict

    rule = candidate.rule or {}
    pair = rule.get("targetPair") or []
    if len(pair) != 2 or pair[0] not in frame.columns or pair[1] not in frame.columns:
        return _not_testable(candidate, "COLUMN_NOT_FOUND", {"pair": pair}, frame.height)
    mask = np.ones(frame.height, dtype=bool)
    for condition in (rule.get("conditions") or []):
        try:
            mask &= evaluate_condition_dict(condition, frame)
        except Exception:
            return _not_testable(candidate, "COLUMN_NOT_FOUND",
                                 {"condition": condition}, frame.height)
    if int(mask.sum()) < min_group_size or int((~mask).sum()) < min_group_size:
        return _not_testable(candidate, "INSUFFICIENT_GROUP_SIZE",
                             {"numeratorN": int(mask.sum()),
                              "denominatorN": int((~mask).sum()),
                              "minGroupSize": int(min_group_size)}, frame.height)
    x = _float_array(frame[str(pair[0])])
    y = _float_array(frame[str(pair[1])])
    result = _tau_difference(x, y, mask, seed)
    result["weighted"] = False
    used = int(mask.size)
    if result.get("estimate") is None:
        return _not_testable(candidate, "NO_VALID_VALUES", {"pair": pair}, frame.height)
    return _finish(candidate, result, used, frame.height)


def _compute_proportion(frame: pl.DataFrame, candidate: PinnedCandidate,
                        weights: np.ndarray | None, min_group_size: int,
                        alpha: float) -> dict[str, Any]:
    rule = candidate.rule or {}
    attribute = str(((rule.get("attribute") or {}).get("column")) or "")
    question = str(((rule.get("question") or {}).get("column")) or "")
    if attribute not in frame.columns or question not in frame.columns:
        return _not_testable(candidate, "COLUMN_NOT_FOUND",
                             {"attribute": attribute, "question": question}, frame.height)
    cell = (candidate.estimand or {}).get("cell") or {}
    level = cell.get("attributeLevel")
    category = cell.get("questionCategory")
    levels = _object_array(frame[attribute])
    categories = _object_array(frame[question])
    level_rows = level_mask(levels, level)
    category_rows = level_mask(categories, category)
    valid = _finite_mask(levels) & _finite_mask(categories)
    level_rows &= valid
    category_rows &= valid
    n_level = int(level_rows.sum())
    n_other = int((~level_rows & valid).sum())
    if n_level < min_group_size or n_other < min_group_size:
        return _not_testable(candidate, "INSUFFICIENT_GROUP_SIZE",
                             {"numeratorN": n_level, "denominatorN": n_other,
                              "minGroupSize": int(min_group_size)}, frame.height)
    if weights is not None:
        w_level = float(weights[level_rows].sum())
        w_other = float(weights[(~level_rows) & valid].sum())
        if w_level <= 0 or w_other <= 0:
            return _not_testable(candidate, "EMPTY_REFERENCE", {}, frame.height)
        w_cell = float(weights[level_rows & category_rows].sum())
        w_cell_other = float(weights[(~level_rows) & valid & category_rows].sum())
        table = np.array([[w_cell, w_level - w_cell],
                          [w_cell_other, w_other - w_cell_other]], dtype=float)
    else:
        table = np.array([
            [int((level_rows & category_rows).sum()), n_level - int((level_rows & category_rows).sum())],
            [int((~level_rows & valid & category_rows).sum()),
             n_other - int((~level_rows & valid & category_rows).sum())],
        ], dtype=float)
    if (table < 0).any() or table.sum() <= 0:
        return _not_testable(candidate, "NO_VALID_VALUES", {}, frame.height)
    result = _two_by_two(table, alpha)
    result["contingency"] = table.tolist()
    result["groupStats"] = [
        {"label": str(level), "n": n_level,
         "pct": result.get("pRow")}, {"label": "その他", "n": n_other, "pct": result.get("pOther")},
    ]
    result["weighted"] = weights is not None
    used = n_level + n_other
    return _finish(candidate, result, used, frame.height)
