"""Descriptive statistics and selection summaries."""
from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl

from ...domain.codebook_adapter import CodebookAdapter, normalize_code


def numeric_summary(values: np.ndarray) -> dict:
    clean = values[~np.isnan(values)]
    if clean.size == 0:
        return {"count": 0, "missing": int(values.size)}
    q1, med, q3 = np.percentile(clean, [25, 50, 75])
    return {
        "count": int(clean.size),
        "missing": int(values.size - clean.size),
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

    raw_counts: dict[str, int] = {}
    null_count = 0
    for value in series.to_list():
        code = normalize_code(value)
        if code is None:
            null_count += 1
        else:
            raw_counts[code] = raw_counts.get(code, 0) + 1

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
        if "非該当" in reason or "not_applicable" in reason.lower() or "skip" in reason.lower():
            not_applicable += cnt
        else:
            missing += cnt

    target = max(0, total - not_applicable)
    valid = max(0, target - missing)

    denominators = {
        "total": total,
        "notApplicable": not_applicable,
        "missing": missing,
        "target": target,
        "valid": valid,
    }

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

    # Auxiliary stats (mean, median, top2Box, bottom2Box)
    auxiliary_stats: dict[str, Any] = {}
    if valid > 0 and scale_type in ("ordinal", "interval", "ratio", "numeric"):
        valid_vals = []
        score_map = {code: idx + 1 for idx, code in enumerate(ordered_valid_codes)}
        ordinal_scores = score_map

        reversed_numeric_values = []
        for code in ordered_valid_codes:
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

        for code in ordered_valid_codes:
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
            auxiliary_stats["meanNote"] = "等間隔得点として計算"
            auxiliary_stats["median"] = round(float(np.median(arr)), 2)

        if len(ordered_valid_codes) >= 2:
            top2_codes = ordered_valid_codes[-2:]
            top2_n = sum(raw_counts.get(c, 0) for c in top2_codes)
            top2_pct = round(top2_n / valid * 100, 1)
            auxiliary_stats["top2Box"] = {"pct": top2_pct, "n": top2_n}

            bottom2_codes = ordered_valid_codes[:2]
            bottom2_n = sum(raw_counts.get(c, 0) for c in bottom2_codes)
            bottom2_pct = round(bottom2_n / valid * 100, 1)
            auxiliary_stats["bottom2Box"] = {"pct": bottom2_pct, "n": bottom2_n}

    return {
        "denominators": denominators,
        "distribution": distribution,
        "auxiliaryStats": auxiliary_stats,
    }


def summarize(df: pl.DataFrame, column_types: dict[str, str], codebook: dict | None = None) -> dict:
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
        result[name] = col_summary

    return result


def correlation_matrix_df(df: pl.DataFrame, columns: list[str]) -> list[list[float | None]]:
    p = len(columns)
    if p == 0:
        return []
    if df.height == 0:
        return [[None] * p for _ in range(p)]

    # Extract numeric columns as float numpy arrays
    col_arrays = []
    for c in columns:
        col_arrays.append(np.array([np.nan if v is None else float(v) for v in df[c].to_list()], dtype=np.float64))

    mat: list[list[float | None]] = [[None] * p for _ in range(p)]

    for i in range(p):
        valid_i = ~np.isnan(col_arrays[i])
        if np.sum(valid_i) >= 2 and np.std(col_arrays[i][valid_i]) > 1e-12:
            mat[i][i] = 1.0
        else:
            mat[i][i] = None

    for i in range(p):
        for j in range(i + 1, p):
            valid = ~np.isnan(col_arrays[i]) & ~np.isnan(col_arrays[j])
            if np.sum(valid) >= 2:
                xi = col_arrays[i][valid]
                xj = col_arrays[j][valid]
                std_i = float(np.std(xi, ddof=1))
                std_j = float(np.std(xj, ddof=1))
                if std_i > 1e-12 and std_j > 1e-12:
                    r = float(np.corrcoef(xi, xj)[0, 1])
                    if not np.isnan(r):
                        mat[i][j] = round(r, 4)
                        mat[j][i] = round(r, 4)
    return mat
