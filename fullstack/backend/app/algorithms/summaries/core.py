"""Descriptive statistics and selection summaries."""
from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl

from ...domain.codebook_adapter import CodebookAdapter, is_not_applicable_reason, normalize_code
from ..survey.weight_arithmetic import (
    absolute_weight_sum, display_weight_total, normalized_weights, weight_total_warning,
)


def numeric_summary(values: np.ndarray) -> dict:
    arr = np.asarray(values, dtype=float)
    finite = np.isfinite(arr)
    clean = arr[finite]
    if clean.size == 0:
        return {"count": 0, "missing": int(arr.size)}
    q1, med, q3 = np.percentile(clean, [25, 50, 75])
    return {
        "count": int(clean.size),
        "missing": int(arr.size - clean.size),
        "min": float(clean.min()),
        "max": float(clean.max()),
        "mean": float(clean.mean()),
        "median": float(med),
        "std": float(clean.std(ddof=1)) if clean.size > 1 else 0.0,
        "q1": float(q1),
        "q3": float(q3),
        "iqr": float(q3 - q1),
    }


def categorical_summary(series: pl.Series) -> dict:
    non_null = series.drop_nulls()
    counts: dict[str, int] = {}
    for value in non_null.to_list():
        key = str(value)
        counts[key] = counts.get(key, 0) + 1
    return {
        "count": int(non_null.len()),
        "missing": int(series.null_count()),
        "uniqueCount": len(counts),
        "frequencies": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
    }


def question_summary(series: pl.Series, spec: dict | None = None, adapter: CodebookAdapter | None = None) -> dict:
    """Compute survey question denominators, distributions, and auxiliary stats."""
    total = series.len()
    spec = spec or {}
    missing_codes = [normalize_code(v) for v in (spec.get("missingCodes") or [])]
    missing_codes = [code for code in missing_codes if code is not None]
    missing_code_set = set(missing_codes)
    missing_reasons = {normalize_code(k): str(v) for k, v in (spec.get("missingReasons") or {}).items() if normalize_code(k) is not None}
    value_labels = {normalize_code(k): str(v) for k, v in (spec.get("valueLabels") or {}).items() if normalize_code(k) is not None}
    scale_type = spec.get("scaleType", "nominal")
    is_reversed = bool(spec.get("isReversed", False))

    if adapter is None:
        adapter = CodebookAdapter(series.to_frame(), {"columns": [{**spec, "name": series.name}]})
    ordered_valid_codes = adapter.get_ordered_categories(series.name)

    # A declared discrete domain (non-empty categoryOrder) is authoritative:
    # values outside it are invalid, excluded from the analysis and counted
    # as invalid (AV02). Undeclared columns keep the observed-category fallback.
    # Ratio/interval/numeric columns additionally treat non-parseable codes as
    # invalid rather than rescuing them as nominal ranks (AV03).
    declared_order = [normalize_code(v) for v in (spec.get("categoryOrder") or [])]
    declared_domain = {c for c in declared_order if c is not None} - missing_code_set
    ordered_valid_codes = [c for c in ordered_valid_codes if c in declared_domain] if declared_order else list(ordered_valid_codes)

    def _is_invalid_code(code: str) -> bool:
        if code in missing_code_set:
            return False
        if declared_order and code not in declared_domain:
            return True
        if scale_type in ("ratio", "interval", "numeric"):
            try:
                number = float(code)
            except (TypeError, ValueError):
                return True
            import math as _math
            if not _math.isfinite(number):
                return True
        return False

    raw_counts: dict[str, int] = {}
    invalid_counts: dict[str, int] = {}
    null_count = 0
    for value in series.to_list():
        code = normalize_code(value)
        if code is None:
            null_count += 1
        elif _is_invalid_code(code):
            invalid_counts[code] = invalid_counts.get(code, 0) + 1
        else:
            raw_counts[code] = raw_counts.get(code, 0) + 1
    invalid = sum(invalid_counts.values())

    if not ordered_valid_codes:
        for v in raw_counts.keys():
            if v not in ordered_valid_codes and v not in missing_code_set:
                ordered_valid_codes.append(v)

    if not ordered_valid_codes and raw_counts:
        def try_num(x: str):
            try:
                return (0, float(x))
            except ValueError:
                return (1, x)
        ordered_valid_codes = sorted((code for code in raw_counts.keys() if code not in missing_code_set), key=try_num)

    if adapter is None and ordered_valid_codes:
        ordered_valid_codes = [code for code in ordered_valid_codes if code not in missing_code_set]

    # Continuous distributions follow numeric magnitude, not encounter order.
    # A declared order remains authoritative (including reverse-score bounds).
    if scale_type in ("ratio", "interval", "numeric") and not declared_order:
        ordered_valid_codes = sorted(
            (code for code in ordered_valid_codes if not _is_invalid_code(code)), key=float
        )

    # Reverse ordered scale if explicitly defined so that Top/Bottom and scores reflect reversed direction.
    if is_reversed:
        ordered_valid_codes = list(reversed(ordered_valid_codes))

    # Classify missing vs notApplicable
    not_applicable = 0
    missing = null_count

    for code in missing_code_set:
        cnt = raw_counts.get(code, 0)
        if cnt == 0:
            continue
        reason = missing_reasons.get(code, "")
        if is_not_applicable_reason(reason):
            not_applicable += cnt
        else:
            missing += cnt

    target = max(0, total - not_applicable)
    valid = max(0, target - missing - invalid)

    denominators = {
        "total": total,
        "notApplicable": not_applicable,
        "missing": missing,
        "target": target,
        "valid": valid,
    }
    if invalid:
        denominators["invalid"] = invalid

    # Build distribution items
    distribution: list[dict] = []
    for code in ordered_valid_codes:
        cnt = raw_counts.get(code, 0)
        pct_valid = round(cnt / valid * 100, 1) if valid > 0 else 0.0
        pct_total = round(cnt / total * 100, 1) if total > 0 else 0.0
        distribution.append({
            "code": code,
            "label": value_labels.get(code, code),
            "count": cnt,
            "percentageValid": pct_valid,
            "percentageTotal": pct_total,
            "isMissing": False,
            "missingReason": None,
        })

    for code in missing_codes:
        cnt = raw_counts.get(code, 0)
        pct_total = round(cnt / total * 100, 1) if total > 0 else 0.0
        distribution.append({
            "code": code,
            "label": value_labels.get(code, code),
            "count": cnt,
            "percentageValid": 0.0,
            "percentageTotal": pct_total,
            "isMissing": True,
            "missingReason": missing_reasons.get(code, "無回答"),
        })

    if null_count > 0:
        distribution.append({
            "code": None,
            "label": "無回答",
            "count": null_count,
            "percentageValid": 0.0,
            "percentageTotal": round(null_count / total * 100, 1) if total > 0 else 0.0,
            "isMissing": True,
            "missingReason": "無回答",
        })

    for code in sorted(invalid_counts):
        cnt = invalid_counts[code]
        distribution.append({
            "code": code,
            "label": value_labels.get(code, code),
            "count": cnt,
            "percentageValid": 0.0,
            "percentageTotal": round(cnt / total * 100, 1) if total > 0 else 0.0,
            "isMissing": False,
            "isInvalid": True,
            "missingReason": "invalid_value",
        })

    # Auxiliary stats (mean, median, iqr, top2Box, bottom2Box).
    # Ordinal scores always use 1-based categoryOrder ranks with an
    # equal-interval note; never raw numeric codes.
    auxiliary_stats: dict[str, Any] = {}
    if valid > 0 and scale_type in ("ordinal", "interval", "ratio", "numeric"):
        valid_vals: list[float] = []
        missing_code_set_local = set(missing_code_set)
        fixed_order = [c for c in ordered_valid_codes if c not in missing_code_set_local]
        score_map = {code: idx + 1 for idx, code in enumerate(fixed_order)}
        ordinal_scores = score_map

        reversed_numeric_values = []
        for code in fixed_order:
            try:
                numeric_value = float(code)
            except (TypeError, ValueError):
                continue
            reversed_numeric_values.append(numeric_value)

        if reversed_numeric_values:
            reversed_min = min(reversed_numeric_values)
            reversed_max = max(reversed_numeric_values)
        else:
            reversed_min = None
            reversed_max = None

        for code in fixed_order:
            cnt = raw_counts.get(code, 0)
            if cnt == 0:
                continue
            try:
                if scale_type == "ordinal":
                    num_v = float(ordinal_scores[code])
                else:
                    num_v = float(code)
            except ValueError:
                num_v = float(score_map.get(code, 1))
            if is_reversed and scale_type != "ordinal" and reversed_min is not None and reversed_max is not None:
                num_v = reversed_max + reversed_min - num_v
            valid_vals.extend([num_v] * cnt)

        if valid_vals:
            arr = np.array(valid_vals)
            auxiliary_stats["mean"] = round(float(arr.mean()), 2)
            if scale_type == "ordinal":
                auxiliary_stats["meanNote"] = "等間隔得点として計算"
            auxiliary_stats["median"] = round(float(np.median(arr)), 2)
            q1, q3 = np.percentile(arr, [25, 75])
            auxiliary_stats["q1"] = round(float(q1), 2)
            auxiliary_stats["q3"] = round(float(q3), 2)
            auxiliary_stats["iqr"] = round(float(q3 - q1), 2)

        # Top/Bottom boxes describe ordered response categories, not the
        # largest/smallest two distinct values of a continuous measurement.
        if scale_type == "ordinal" and len(fixed_order) >= 2:
            top2_codes = fixed_order[-2:]
            top2_n = sum(raw_counts.get(c, 0) for c in top2_codes)
            top2_pct = round(top2_n / valid * 100, 1)
            auxiliary_stats["top2Box"] = {"pct": top2_pct, "n": top2_n}

            bottom2_codes = fixed_order[:2]
            bottom2_n = sum(raw_counts.get(c, 0) for c in bottom2_codes)
            bottom2_pct = round(bottom2_n / valid * 100, 1)
            auxiliary_stats["bottom2Box"] = {"pct": bottom2_pct, "n": bottom2_n}

    return {
        "denominators": denominators,
        "distribution": distribution,
        "auxiliaryStats": auxiliary_stats,
    }


def summarize(
    df: pl.DataFrame,
    column_types: dict[str, str],
    codebook: dict | None = None,
    weights: list[float | None] | None = None,
) -> dict:
    from ...domain.errors import BizError

    # A weight vector that does not cover every row must fail loudly: zip
    # truncation would silently drop or misalign rows (contract).
    if weights is not None and len(weights) != df.height:
        raise BizError("CROSSTAB_WEIGHT_LENGTH", "ウェイト長が対象行数と一致しません。",
                       status_code=422)
    result: dict[str, dict] = {}
    adapter = CodebookAdapter(df, codebook) if codebook else None
    for name in df.columns:
        if name == "__rowId__":
            continue
        spec = adapter.get_column_spec_optional(name) if adapter is not None else None
        working_series = adapter.analysis_series(name) if adapter is not None and spec is not None else df[name]
        if column_types.get(name) == "numeric":
            values = np.array([np.nan if v is None else float(v) for v in working_series.to_list()])
            col_summary = numeric_summary(values)
        else:
            col_summary = categorical_summary(working_series)

        # Always enrich with denominators, distribution, and auxiliaryStats
        q_summary = question_summary(df[name], spec, adapter=adapter)
        col_summary.update(q_summary)
        # All headline moments/frequencies use the same normalized series.
        # Applying a second filter only to mean/count would leave SD and
        # quantiles inconsistent with the declared-domain denominators.
        if weights is not None:
            col_summary["weighted"] = _weighted_column_summary(df[name], spec, weights, adapter=adapter)
        result[name] = col_summary

    return result


def _weighted_column_summary(
    series: pl.Series,
    spec: dict | None,
    weights: list[float | None],
    adapter: CodebookAdapter | None = None,
) -> dict[str, Any]:
    """Weighted counts/percents/mean over valid rows with positive finite weights.

    Shares the valid-row rule with ``question_summary``: missing codes,
    notApplicable reasons, and nulls are excluded; unknown codes stay valid
    rows here because row-level invalid (MA-style) does not exist on this path.
    """
    spec = spec or {}
    missing_codes = {c for c in (normalize_code(v) for v in (spec.get("missingCodes") or [])) if c is not None}
    missing_reasons = {normalize_code(k): str(v) for k, v in (spec.get("missingReasons") or {}).items() if normalize_code(k) is not None}
    scale_type = spec.get("scaleType", "nominal")
    is_reversed = bool(spec.get("isReversed", False))
    if adapter is None:
        adapter = CodebookAdapter(series.to_frame(), {"columns": [{**spec, "name": series.name}]})
    import math as _wmath
    declared_order_w = [normalize_code(v) for v in (spec.get("categoryOrder") or [])]
    declared_domain_w = {c for c in declared_order_w if c is not None} - missing_codes
    ordered = [c for c in adapter.get_ordered_categories(series.name) if c not in missing_codes]
    if declared_order_w:
        ordered = [c for c in ordered if c in declared_domain_w]

    def _w_invalid(code: str) -> bool:
        if code in missing_codes:
            return False
        if declared_order_w and code not in declared_domain_w:
            return True
        if scale_type in ("ratio", "interval", "numeric"):
            try:
                number = float(code)
            except (TypeError, ValueError):
                return True
            if not _wmath.isfinite(number):
                return True
        return False
    if is_reversed:
        if scale_type == "ordinal":
            ordered = list(reversed(ordered))
        else:
            fixed_numeric = []
            for code in ordered:
                try:
                    fixed_numeric.append(float(code))
                except (TypeError, ValueError):
                    continue
            if not fixed_numeric:
                from ...domain.errors import BizError
                raise BizError("CODEBOOK_REVERSE_RANGE_MISSING",
                               f"逆転項目 '{series.name}' には固定の尺度範囲(categoryOrder)が必要です。",
                               status_code=422)
            reversed_min, reversed_max = min(fixed_numeric), max(fixed_numeric)

    raw = series.to_list()
    category_weights: dict[str, list[float]] = {}
    weight_missing = 0
    for value, weight in zip(raw, weights):
        code = normalize_code(value)
        if code is None:
            continue
        if _w_invalid(code):
            continue
        if code in missing_codes:
            reason = missing_reasons.get(code, "")
            if is_not_applicable_reason(reason):
                continue
            continue
        if weight is None:
            weight_missing += 1
            continue
        if weight <= 0:
            continue
        category_weights.setdefault(code, []).append(weight)

    # The absolute sum may overflow even though every weight is finite. Use
    # a common scale only for ratios; never report scaled masses as counts.
    maximum = max((max(group) for group in category_weights.values()), default=0.0)
    scaled_counts = {code: _wmath.fsum(w / maximum for w in group)
                     for code, group in category_weights.items()}
    scaled_total = _wmath.fsum(scaled_counts.values())
    counts = {code: absolute_weight_sum(group) for code, group in category_weights.items()}
    weighted_n = absolute_weight_sum(w for group in category_weights.values() for w in group)

    distribution = []
    for code in ordered:
        count = counts.get(code, 0.0)
        distribution.append({
            "code": code,
            "weightedCount": display_weight_total(count),
            "weightedCountStatus": "ok" if count is not None else "out_of_range",
            "weightedPct": round(scaled_counts.get(code, 0.0) / scaled_total * 100, 4) if scaled_total > 0 else None,
        })

    weighted: dict[str, Any] = {
        "weightedN": display_weight_total(weighted_n),
        "weightedNStatus": "ok" if weighted_n is not None else "out_of_range",
        "weightMissingCount": weight_missing,
        "distribution": distribution,
    }
    if weighted_n is None:
        weighted["warnings"] = [weight_total_warning()]
    if scale_type in ("ordinal", "interval", "ratio", "numeric") and scaled_total > 0:
        score_map = {code: idx + 1 for idx, code in enumerate(ordered)}
        scores: list[tuple[float, float]] = []
        for code, count in scaled_counts.items():
            try:
                score = float(score_map[code]) if scale_type == "ordinal" else float(code)
            except (TypeError, ValueError):
                score = float(score_map.get(code, 0))
            if is_reversed and scale_type != "ordinal":
                score = reversed_max + reversed_min - score
            scores.append((score, count / scaled_total))
        score_scale = max(abs(score) for score, _ in scores)
        mean = (_wmath.fsum((score / score_scale) * proportion for score, proportion in scores)
                * score_scale) if score_scale else 0.0
        weighted["weightedMean"] = round(mean, 4)
        if scale_type == "ordinal":
            weighted["meanNote"] = "等間隔得点として計算"
    else:
        weighted["weightedMean"] = None
    return weighted


def correlation_matrix_df(
    df: pl.DataFrame,
    columns: list[str],
    weights: list[float | None] | None = None,
) -> list[list[float | None]]:
    p = len(columns)
    if p == 0:
        return []
    if df.height == 0:
        return [[None] * p for _ in range(p)]

    # Extract numeric columns as float numpy arrays
    col_arrays = []
    for c in columns:
        col_arrays.append(np.array([np.nan if v is None else float(v) for v in df[c].to_list()], dtype=np.float64))
    weight_arr = None
    if weights is not None:
        weight_arr = np.array([np.nan if w is None else float(w) for w in weights], dtype=np.float64)

    def _weighted_corr(xi: np.ndarray, xj: np.ndarray, w: np.ndarray) -> float | None:
        w = normalized_weights(w)
        if not np.any(w > 0):
            return None
        mx = float(np.sum(w * xi))
        my = float(np.sum(w * xj))
        dx = xi - mx
        dy = xj - my
        cov = float(np.sum(w * dx * dy))
        vxx = float(np.sum(w * dx * dx))
        vyy = float(np.sum(w * dy * dy))
        if vxx <= 0 or vyy <= 0 or not np.isfinite(cov):
            return None
        return float((cov / np.sqrt(vxx)) / np.sqrt(vyy))

    mat: list[list[float | None]] = [[None] * p for _ in range(p)]

    for i in range(p):
        valid_i = ~np.isnan(col_arrays[i])
        if weight_arr is not None:
            valid_i = valid_i & np.isfinite(weight_arr) & (weight_arr > 0)
        if np.sum(valid_i) >= 2 and np.std(col_arrays[i][valid_i]) > 1e-12:
            mat[i][i] = 1.0
        else:
            mat[i][i] = None

    for i in range(p):
        for j in range(i + 1, p):
            valid = ~np.isnan(col_arrays[i]) & ~np.isnan(col_arrays[j])
            if weight_arr is not None:
                valid = valid & np.isfinite(weight_arr) & (weight_arr > 0)
            if np.sum(valid) >= 2:
                xi = col_arrays[i][valid]
                xj = col_arrays[j][valid]
                if weight_arr is not None:
                    r = _weighted_corr(xi, xj, weight_arr[valid])
                else:
                    std_i = float(np.std(xi, ddof=1))
                    std_j = float(np.std(xj, ddof=1))
                    if std_i > 1e-12 and std_j > 1e-12:
                        r = float(np.corrcoef(xi, xj)[0, 1])
                        r = None if np.isnan(r) else r
                    else:
                        r = None
                if r is not None and np.isfinite(r):
                    mat[i][j] = round(r, 4)
                    mat[j][i] = round(r, 4)
    return mat
