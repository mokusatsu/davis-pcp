"""Two-way crosstab with adjusted standardized residuals (Feature 26).

Pure functions only: category/missing resolution, weighted/unweighted counts,
per-denominator percentages, expected counts, ASR + significance markers,
Pearson/Fisher inference, Cramér's V, row-id caps, warnings, ResultMeta.
The ASR formula is shared with subgroup mining (single implementation).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
import polars as pl
from scipy import stats

ALGORITHM_VERSION = "crosstab-1"
MAX_POSITIVE_ASR = 3.29
CATEGORY_SCALES = ("nominal", "ordinal", "binary")


def adjusted_residual(observed: float, expected: float, row_prop: float, col_prop: float) -> float | None:
    denom = expected * (1.0 - row_prop) * (1.0 - col_prop)
    if expected <= 0 or denom <= 0:
        return None
    return float((observed - expected) / math.sqrt(denom))


def significance_marker(asr: float | None) -> str:
    if asr is None or not math.isfinite(asr):
        return ""
    magnitude = abs(asr)
    if magnitude >= 3.29:
        return "***"
    if magnitude >= 2.58:
        return "**"
    if magnitude >= 1.96:
        return "*"
    return ""


def _category_spec(codebook: dict[str, Any] | None, variable_id: str) -> dict[str, Any]:
    for spec in ((codebook or {}).get("columns", []) or []):
        if not isinstance(spec, dict):
            continue
        if spec.get("name") == variable_id or spec.get("columnId") == variable_id:
            return spec
    return {}


def ordered_display_categories(values: list[str], spec: dict[str, Any]) -> list[str]:
    return _ordered_categories(values, spec)


def _ordered_categories(values: list[str], spec: dict[str, Any]) -> list[str]:
    order = [str(v) for v in (spec.get("categoryOrder") or []) if v is not None]
    labels = spec.get("valueLabels") or {}
    if order:
        ordered = [v for v in order if v in set(values) or True]
    elif labels:
        ordered = [str(k) for k in labels.keys()]
    else:
        ordered = []
    seen: set[str] = set()
    result = [v for v in ordered if not (v in seen or seen.add(v))]
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _effective_inference_matrix(
    counts: np.ndarray,
) -> tuple[np.ndarray, list[int], list[int]]:
    """Return the positive-marginal submatrix used for inference."""
    row_totals = counts.sum(axis=1)
    col_totals = counts.sum(axis=0)
    keep_rows = [i for i in range(counts.shape[0]) if row_totals[i] > 0]
    keep_cols = [j for j in range(counts.shape[1]) if col_totals[j] > 0]
    if not keep_rows or not keep_cols:
        return np.zeros((0, 0), dtype=float), keep_rows, keep_cols
    return counts[np.ix_(keep_rows, keep_cols)], keep_rows, keep_cols


def _split_missing(values: list[Any], spec: dict[str, Any], missing_policy: str,
                   reasons: dict[str, Any] | None = None) -> tuple[list[str | None], list[str]]:
    from ...domain.codebook_adapter import is_not_applicable_reason, normalize_code

    reasons = reasons or {}
    missing_codes = {normalize_code(c) for c in (spec.get("missingCodes") or [])}
    missing_codes.discard(None)
    out: list[str | None] = []
    missing_reasons: list[str] = []
    for raw in values:
        code = normalize_code(raw)
        if code is None or code in missing_codes:
            reason = reasons.get(code, "") if isinstance(reasons, dict) else ""
            if missing_policy == "include_missing":
                out.append("__missing__")
            elif missing_policy == "separate_not_applicable" and is_not_applicable_reason(reason):
                out.append("__not_applicable__")
            elif missing_policy == "separate_not_applicable":
                out.append("__missing__")
            else:
                out.append(None)
            missing_reasons.append(reason if isinstance(reason, str) else "")
        else:
            out.append(code)
            missing_reasons.append("")
    return out, missing_reasons


def compute_crosstab(
    df: pl.DataFrame,
    row_variable: str,
    col_variable: str,
    codebook: dict[str, Any] | None = None,
    missing_policy: str = "exclude",
    weights: list[float | None] | None = None,
    include_row_ids: bool = True,
    max_row_ids_per_cell: int = 10000,
    inference: str = "pearson",
) -> dict[str, Any]:
    from ...domain.errors import BizError

    codebook = codebook or {}
    if missing_policy not in ("exclude", "include_missing", "separate_not_applicable"):
        raise BizError("CROSSTAB_MISSING_POLICY", "missingPolicy が不正です。", status_code=422)
    if row_variable == col_variable:
        raise BizError("CROSSTAB_SAME_VARIABLE", "行変数と列変数に同じ列を指定できません。",
                       status_code=422)
    row_spec = _category_spec(codebook, row_variable)
    col_spec = _category_spec(codebook, col_variable)
    if not row_spec or not col_spec:
        raise BizError("CROSSTAB_COLUMN_NOT_FOUND", "行変数または列変数が存在しません。",
                       status_code=422)
    for spec, label in ((row_spec, "行変数"), (col_spec, "列変数")):
        if spec.get("multiResponseGroup"):
            raise BizError("CROSSTAB_CATEGORY_REQUIRED", f"{label}にMA設問は指定できません。",
                           status_code=422)
        if (spec.get("scaleType") or "nominal") not in CATEGORY_SCALES:
            raise BizError("CROSSTAB_CATEGORY_REQUIRED",
                           f"{label}はnominal/ordinal/binaryのいずれかを指定してください。",
                           status_code=422)
    row_name = row_spec.get("name", row_variable)
    col_name = col_spec.get("name", col_variable)
    if row_name not in df.columns or col_name not in df.columns:
        raise BizError("CROSSTAB_COLUMN_NOT_FOUND", "行変数または列変数がデータに存在しません。",
                       status_code=422)

    row_ids = [str(v) for v in df["__rowId__"].to_list()] if "__rowId__" in df.columns else [
        str(i) for i in range(df.height)]
    row_vals, _ = _split_missing(df[row_name].to_list(), row_spec, missing_policy,
                                 (row_spec.get("missingReasons") or {}))
    col_vals, _ = _split_missing(df[col_name].to_list(), col_spec, missing_policy,
                                 (col_spec.get("missingReasons") or {}))
    scope_count = len(row_ids)
    kept: list[int] = [i for i in range(scope_count) if row_vals[i] is not None and col_vals[i] is not None]
    missing_count = scope_count - len(kept)

    row_cats = _ordered_categories(sorted({row_vals[i] for i in kept if row_vals[i] is not None}),
                                   row_spec)
    col_cats = _ordered_categories(sorted({col_vals[i] for i in kept if col_vals[i] is not None}),
                                   col_spec)
    if missing_policy != "exclude":
        if any(row_vals[i] in ("__missing__", "__not_applicable__") for i in kept):
            for extra in ("__missing__", "__not_applicable__"):
                if extra not in row_cats and any(row_vals[i] == extra for i in kept):
                    row_cats.append(extra)
        if any(col_vals[i] in ("__missing__", "__not_applicable__") for i in kept):
            for extra in ("__missing__", "__not_applicable__"):
                if extra not in col_cats and any(col_vals[i] == extra for i in kept):
                    col_cats.append(extra)

    row_index = {c: i for i, c in enumerate(row_cats)}
    col_index = {c: j for j, c in enumerate(col_cats)}
    n_rows, n_cols = len(row_cats), len(col_cats)
    if n_rows == 0 or n_cols == 0 or not kept:
        return {
            "rowCategories": [], "colCategories": [], "cells": [],
            "rowTotals": [], "colTotals": [],
            "grandTotal": {"unweightedCount": 0, "count": 0.0},
            "statistics": {"chi2": None, "df": None, "pValue": None, "cramersV": None,
                           "inferenceMethod": inference, "expectedLt5Count": 0,
                           "expectedLt5Ratio": None, "smallMarginalWarnings": []},
            "warnings": [{"code": "CROSSTAB_EMPTY", "message": "有効なセルがありません。"}],
            "scopeCount": scope_count, "effectiveN": 0, "missingCount": missing_count,
            "algorithmVersion": ALGORITHM_VERSION,
        }

    use_weights = weights is not None
    if weights is not None and len(weights) != scope_count:
        raise BizError("CROSSTAB_WEIGHT_LENGTH", "ウェイト長がscopeと一致しません。",
                       status_code=422)
    counts = np.zeros((n_rows, n_cols), dtype=float)
    unweighted = np.zeros((n_rows, n_cols), dtype=int)
    cell_rows: list[list[list[str]]] = [[[] for _ in range(n_cols)] for _ in range(n_rows)]
    weight_zero = 0
    for k in kept:
        i, j = row_index[row_vals[k]], col_index[col_vals[k]]
        unweighted[i, j] += 1
        if include_row_ids and len(cell_rows[i][j]) < max_row_ids_per_cell:
            cell_rows[i][j].append(row_ids[k])
        if use_weights:
            w = weights[k] if k < len(weights) else None
            counts[i, j] += float(w or 0.0)
            if w == 0:
                weight_zero += 1
        else:
            counts[i, j] += 1.0

    row_totals = counts.sum(axis=1)
    col_totals = counts.sum(axis=0)
    grand = float(counts.sum())
    unweighted_row = unweighted.sum(axis=1)
    unweighted_col = unweighted.sum(axis=0)
    unweighted_grand = int(unweighted.sum())

    def pct(value: float, denom: float) -> float | None:
        if denom <= 0:
            return None
        return round(value / denom * 100.0, 2)

    expected = np.zeros((n_rows, n_cols), dtype=float)
    for i in range(n_rows):
        for j in range(n_cols):
            expected[i, j] = row_totals[i] * col_totals[j] / grand if grand > 0 else 0.0

    def label_of(spec: dict[str, Any], category: str) -> str:
        if category == "__missing__":
            return "欠損"
        if category == "__not_applicable__":
            return "非該当"
        labels = spec.get("valueLabels") or {}
        return str(labels.get(category, category))

    cells: list[dict[str, Any]] = []
    for i, row_cat in enumerate(row_cats):
        for j, col_cat in enumerate(col_cats):
            observed = float(counts[i, j])
            exp = float(expected[i, j])
            row_prop = float(row_totals[i] / grand) if grand > 0 else 0.0
            col_prop = float(col_totals[j] / grand) if grand > 0 else 0.0
            asr = adjusted_residual(observed, exp, row_prop, col_prop)
            ids = cell_rows[i][j]
            full_count = int(unweighted[i, j])
            cells.append({
                "rowCategoryId": row_cat, "colCategoryId": col_cat,
                "rowLabel": label_of(row_spec, row_cat), "colLabel": label_of(col_spec, col_cat),
                "unweightedCount": full_count,
                "count": round(observed, 4),
                "rowPct": pct(observed, float(row_totals[i])),
                "colPct": pct(observed, float(col_totals[j])),
                "totalPct": pct(observed, grand),
                "expectedCount": round(exp, 4),
                "asr": round(asr, 3) if asr is not None else None,
                "significance": significance_marker(asr),
                "rowIds": ids if include_row_ids else [],
                "rowIdCount": full_count,
                "rowIdsTruncated": full_count > len(ids) if include_row_ids else False,
            })

    chi2_stat: float | None = None
    p_value: float | None = None
    inference_method = inference
    warnings: list[dict[str, Any]] = []
    expected_lt5 = int(np.sum(expected < 5))
    total_cells = n_rows * n_cols
    expected_ratio = round(expected_lt5 / total_cells, 4) if total_cells else None
    if expected_ratio is not None and expected_ratio > 0.20:
        warnings.append({"code": "EXPECTED_COUNT_LT5",
                         "message": f"期待度数5未満のセルが{expected_ratio * 100:.1f}%あります。"})
    small_marginals: list[dict[str, Any]] = []
    for i, row_cat in enumerate(row_cats):
        if int(unweighted_row[i]) < 30:
            small_marginals.append({"axis": "row", "categoryId": row_cat,
                                    "unweightedN": int(unweighted_row[i])})
    for j, col_cat in enumerate(col_cats):
        if int(unweighted_col[j]) < 30:
            small_marginals.append({"axis": "col", "categoryId": col_cat,
                                    "unweightedN": int(unweighted_col[j])})
    inference_matrix = np.where(use_weights, counts, unweighted.astype(float))
    effective_matrix, keep_rows, keep_cols = _effective_inference_matrix(inference_matrix)
    excluded_rows = [row_cats[i] for i in range(n_rows) if i not in set(keep_rows)]
    excluded_cols = [col_cats[j] for j in range(n_cols) if j not in set(keep_cols)]
    if excluded_rows or excluded_cols:
        warnings.append({"code": "CROSSTAB_ZERO_MARGINAL_EXCLUDED",
                         "message": "周辺度数0のカテゴリを検定から除外しました。",
                         "details": {"excludedRows": excluded_rows, "excludedCols": excluded_cols}})
    eff_rows, eff_cols = effective_matrix.shape if effective_matrix.size else (0, 0)
    df_value = (eff_rows - 1) * (eff_cols - 1) if eff_rows and eff_cols else 0
    cramers_v: float | None = None
    if inference == "fisher_exact":
        if eff_rows != 2 or eff_cols != 2 or use_weights:
            raise BizError("CROSSTAB_FISHER_UNSUPPORTED",
                           "Fisher正確検定は無ウェイトの2x2表で明示指定時のみ利用できます。",
                           status_code=422)
        _, p_value = stats.fisher_exact(effective_matrix.astype(int))
        chi2_stat = None
    else:
        if use_weights:
            warnings.append({"code": "WEIGHTED_INFERENCE_APPROXIMATION",
                             "message": "ウェイト時は加重度数によるPearson近似です。設計効果は推定しません。"})
            inference_method = "weighted_pearson_approximation"
        else:
            inference_method = "pearson"
        try:
            if eff_rows < 2 or eff_cols < 2:
                raise ValueError("insufficient effective table")
            chi2_stat, p_value, _, _ = stats.chi2_contingency(effective_matrix, correction=False)
            chi2_stat = float(chi2_stat)
            p_value = float(p_value)
        except Exception:
            chi2_stat, p_value = None, None
    effective_grand = float(effective_matrix.sum()) if effective_matrix.size else 0.0
    denom_v = effective_grand * min(max(eff_rows - 1, 0), max(eff_cols - 1, 0))
    if chi2_stat is not None and denom_v and denom_v > 0:
        cramers_v = round(math.sqrt(chi2_stat / denom_v), 4)
        chi2_stat = round(chi2_stat, 4)
    if p_value is not None:
        p_value = float(p_value)

    row_totals_out = [{"categoryId": c, "label": label_of(row_spec, c),
                       "unweightedCount": int(unweighted_row[i]),
                       "count": round(float(row_totals[i]), 4),
                       "rowPct": 100.0 if row_totals[i] > 0 else None}
                      for i, c in enumerate(row_cats)]
    col_totals_out = [{"categoryId": c, "label": label_of(col_spec, c),
                       "unweightedCount": int(unweighted_col[j]),
                       "count": round(float(col_totals[j]), 4),
                       "colPct": 100.0 if col_totals[j] > 0 else None}
                      for j, c in enumerate(col_cats)]
    return {
        "rowCategories": [{"id": c, "label": label_of(row_spec, c), "order": i}
                          for i, c in enumerate(row_cats)],
        "colCategories": [{"id": c, "label": label_of(col_spec, c), "order": j}
                          for j, c in enumerate(col_cats)],
        "cells": cells,
        "rowTotals": row_totals_out,
        "colTotals": col_totals_out,
        "grandTotal": {"unweightedCount": unweighted_grand, "count": round(grand, 4)},
        "statistics": {"chi2": chi2_stat, "df": df_value, "pValue": p_value,
                       "cramersV": cramers_v, "inferenceMethod": inference_method,
                       "expectedLt5Count": expected_lt5, "expectedLt5Ratio": expected_ratio,
                       "smallMarginalWarnings": small_marginals},
        "warnings": warnings,
        "scopeCount": scope_count, "effectiveN": len(kept), "missingCount": missing_count,
        "weightZeroCount": weight_zero if use_weights else 0,
        "algorithmVersion": ALGORITHM_VERSION,
    }
