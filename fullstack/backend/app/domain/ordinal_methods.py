"""Shared ordinal/nominal/numeric method-selection contract (Feature 22).

``scaleType`` from the codebook is the single source of truth; dtypes and
unique counts never override it. Every selector returns one adopted method
plus null-safe statistics — never a silently substituted zero.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import stats


METHOD_TABLE = {
    "two_group": {"ordinal": "mann_whitney_u", "nominal": "chi_squared", "numeric": "welch_t"},
    "multi_group": {"ordinal": "kruskal_wallis", "nominal": "chi_squared", "numeric": "welch_anova"},
    "correlation": {"ordinal": "kendall_tb", "nominal": "cramers_v", "numeric": "pearson_r"},
}

JAPANESE_LABELS = {
    "mann_whitney_u": "Mann-Whitney U",
    "kruskal_wallis": "Kruskal-Wallis",
    "kendall_tb": "Kendall τb",
    "chi_squared": "χ²",
    "welch_t": "Welch t",
    "welch_anova": "Welch ANOVA",
    "pearson_r": "Pearson r",
    "cramers_v": "Cramér's V",
}


def method_family(scale_type: str | None) -> str:
    if scale_type == "ordinal":
        return "ordinal"
    if scale_type == "nominal":
        return "nominal"
    if scale_type in ("interval", "ratio", "numeric"):
        return "numeric"
    return "nominal"


def select_method(situation: str, scale_type: str | None) -> dict[str, str]:
    family = method_family(scale_type)
    method = METHOD_TABLE[situation][family]
    return {"methodUsed": method, "family": family, "label": JAPANESE_LABELS[method]}


def cliffs_delta(first: list[float], second: list[float]) -> float | None:
    if len(first) < 2 or len(second) < 2:
        return None
    try:
        stat = float(stats.mannwhitneyu(first, second, alternative="two-sided").statistic)
    except ValueError:
        return None
    return round((2.0 * stat) / (len(first) * len(second)) - 1.0, 4)


def epsilon_squared(h_stat: float, n_total: int) -> float | None:
    if n_total < 3:
        return None
    denom = (n_total**2 - 1) / (n_total + 1)
    if denom <= 0:
        return None
    return round(h_stat / denom, 4)


def kendall_tb(first: list[float], second: list[float]) -> dict[str, Any]:
    pairs = [(x, y) for x, y in zip(first, second)
             if x is not None and y is not None and np.isfinite(x) and np.isfinite(y)]
    if len(pairs) < 2:
        return {"tau": None, "pValue": None, "nValid": len(pairs),
                "methodStatus": "insufficient_data"}
    xs, ys = zip(*pairs)
    if len(set(xs)) < 2 or len(set(ys)) < 2:
        return {"tau": None, "pValue": None, "nValid": len(pairs),
                "methodStatus": "insufficient_data"}
    tau, p_value = stats.kendalltau(list(xs), list(ys), variant="b")
    if tau is None or (isinstance(tau, float) and np.isnan(tau)):
        return {"tau": None, "pValue": None, "nValid": len(pairs),
                "methodStatus": "insufficient_data"}
    return {"tau": round(float(tau), 4),
            "pValue": None if p_value is None or np.isnan(p_value) else round(float(p_value), 6),
            "nValid": len(pairs), "methodStatus": "ok"}


def ordinal_ranks(values: list[Any], category_order: list[str]) -> list[float | None]:
    from .codebook_adapter import normalize_code

    order = [c for c in (normalize_code(v) for v in category_order) if c is not None]
    scores = {code: float(i + 1) for i, code in enumerate(order)}
    return [scores.get(normalize_code(v)) for v in values]
