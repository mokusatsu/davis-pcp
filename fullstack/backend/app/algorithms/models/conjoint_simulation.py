"""Conjoint simulation + importance + WTP (Feature 034, production).

- choice/ranking: in-set logit probabilities (sum to 1).
- ratings: predicted ratings + firstChoiceShare with ties split evenly;
  no softmax pseudo-probabilities on ratings.
- Importance from stored utilityRange; opt-out ASC excluded from the
  denominator; all-zero ranges give null (never equal splits).
- WTP only when the linear price slope is negative and its CI excludes 0;
  delta-method reference CI with the recorded price unit. Unstable price
  gives WTP_UNSTABLE with nulls (never |beta| rescue).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import stats
from scipy.special import logsumexp


def simulate_set(
    *,
    mode: str,
    beta: np.ndarray,
    intercept: float,
    profiles: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    beta = np.asarray(beta, dtype=np.float64)
    utils = [float(np.asarray(p["x"], dtype=np.float64) @ beta
                   + (float(intercept) if mode == "ratings" else 0.0))
             for p in profiles]
    out: list[dict[str, Any]] = []
    if mode == "ratings":
        best = max(utils)
        winners = [i for i, u in enumerate(utils) if u == best]
        share = 1.0 / len(winners)
        for i, p in enumerate(profiles):
            out.append({
                "alternativeId": p["alternativeId"],
                "utility": utils[i], "predictedRating": utils[i],
                "probability": None,
                "firstChoiceShare": share if i in winners else 0.0,
            })
        return out
    v = np.array(utils, dtype=np.float64)
    probs = np.exp(v - float(logsumexp(v)))
    for i, p in enumerate(profiles):
        out.append({
            "alternativeId": p["alternativeId"],
            "utility": utils[i], "predictedRating": None,
            "probability": float(probs[i]), "firstChoiceShare": None,
        })
    return out


def attribute_importance(
    *,
    utilities: list[dict[str, Any]],
    linear_specs: dict[str, dict[str, Any]],
) -> list[dict[str, Any]] | None:
    ranges: dict[str, float] = {}
    kinds: dict[str, str] = {}
    for u in utilities:
        if u.get("kind") == "categorical":
            ranges.setdefault(u["attributeId"], 0.0)
            kinds[u["attributeId"]] = "categorical"
    by_attr: dict[str, list[float]] = {}
    for u in utilities:
        if u.get("kind") == "categorical":
            by_attr.setdefault(u["attributeId"], []).append(float(u["utility"]))
    for attr, vals in by_attr.items():
        ranges[attr] = max(vals) - min(vals)
    for attr, spec in linear_specs.items():
        lo, hi = float(spec["lower"]), float(spec["upper"])
        ranges[attr] = abs(float(spec["beta"])) * (hi - lo)
        kinds[attr] = "linear"
    total = sum(ranges.values())
    if not ranges or total <= 0:
        return None
    return [{"attributeId": a, "kind": kinds[a], "range": ranges[a],
             "importance": ranges[a] / total} for a in ranges]


def wtp_table(
    *,
    beta: np.ndarray,
    covariance: np.ndarray | None,
    price_attr: str,
    price_index: int,
    price_beta: float,
    price_se: float | None,
    reference_df: float | None,
    confidence_level: float,
    comparisons: list[dict[str, Any]],
    price_unit: str,
) -> list[dict[str, Any]]:
    stable = (price_beta < 0 and price_se is not None
              and np.isfinite(price_se) and price_se > 0)
    ci: tuple[float | None, ...] = (None, None)
    if stable:
        df = reference_df
        if df is not None and np.isfinite(df) and df > 0:
            tcrit = float(stats.t.ppf(0.5 + confidence_level / 2.0, df))
        else:
            tcrit = float(stats.norm.ppf(0.5 + confidence_level / 2.0))
        lo, hi = price_beta - tcrit * price_se, price_beta + tcrit * price_se
        ci = (lo, hi)
        stable = bool(hi < 0)
    rows: list[dict[str, Any]] = []
    for comp in comparisons:
        d = np.asarray(comp["direction"], dtype=np.float64)
        delta = float(d @ np.asarray(beta, dtype=np.float64))
        # direction は内部計算用であり、JSON 応答に含めない。
        base = {k: v for k, v in comp.items() if k != "direction"}
        if not stable or covariance is None or comp["attributeId"] == price_attr:
            if comp["attributeId"] == price_attr:
                continue
            rows.append({**base, "deltaUtility": delta, "value": None,
                         "standardError": None, "ciLower": None,
                         "ciUpper": None, "priceUnit": price_unit,
                         "status": "unavailable", "reason": "WTP_UNSTABLE"})
            continue
        val = -delta / price_beta
        e = np.zeros_like(d)
        e[price_index] = 1.0
        g = -d / price_beta + delta * e / (price_beta ** 2)
        var = float(g @ np.asarray(covariance) @ g)
        se = math.sqrt(max(0.0, var))
        df = reference_df
        if df is not None and np.isfinite(df) and df > 0:
            tcrit = float(stats.t.ppf(0.5 + confidence_level / 2.0, df))
        else:
            tcrit = float(stats.norm.ppf(0.5 + confidence_level / 2.0))
        rows.append({**base, "deltaUtility": delta, "value": val,
                     "standardError": se,
                     "ciLower": val - tcrit * se, "ciUpper": val + tcrit * se,
                     "priceUnit": price_unit, "status": "available",
                     "reason": None})
    return rows
