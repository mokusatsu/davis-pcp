"""Conjoint ratings estimators (Feature 034, production).

- pooled: intercept WLS via the shared Feature 032 pure core
  (solve_weighted_least_squares); no internal HTTP call.
- respondent_fixed: within transformation (x~-xbar, y~-ybar), intercept-free
  WLS through the same core; alpha_i = ybar - xbar'beta and the
  respondent-weight meanIntercept for new-respondent reference prediction.
"""
from __future__ import annotations

from typing import Any

import numpy as np

from .linear_regression import solve_weighted_least_squares


def fit_pooled_ratings(
    x: np.ndarray, y: np.ndarray, weights: np.ndarray
) -> dict[str, Any]:
    X = np.asarray(x, dtype=np.float64)
    n = X.shape[0]
    Xa = np.hstack([np.ones((n, 1)), X])
    sol = solve_weighted_least_squares(Xa, np.asarray(y, dtype=np.float64),
                                       np.asarray(weights, dtype=np.float64))
    beta_full = np.asarray(sol["beta"])
    bread_full = np.asarray(sol["bread"])
    return {
        "intercept": float(beta_full[0]),
        "beta": np.asarray(beta_full[1:]),
        "bread": np.asarray(bread_full[1:, 1:]),
        "breadFull": bread_full,
        "sse": float(sol["sse"]),
        "fitted": np.asarray(sol["fitted"]),
        "residual": np.asarray(sol["residual"]),
        "rankInfo": {"rank": sol["rank"], "rankTol": sol["rankTol"],
                     "conditionNumber": sol["conditionNumber"]},
    }


def fit_fixed_ratings(
    x: np.ndarray,
    y: np.ndarray,
    weights: np.ndarray,
    respondent_index: list[str],
) -> dict[str, Any]:
    X = np.asarray(x, dtype=np.float64)
    yv = np.asarray(y, dtype=np.float64)
    resp = [str(v) for v in respondent_index]
    order: list[str] = []
    for r in resp:
        if r not in order:
            order.append(r)
    xbars: dict[str, np.ndarray] = {}
    ybars: dict[str, float] = {}
    for r in order:
        idx = [i for i, v in enumerate(resp) if v == r]
        xbars[r] = X[idx].mean(axis=0)
        ybars[r] = float(yv[idx].mean())
    Xw = np.vstack([X[i] - xbars[resp[i]] for i in range(len(resp))])
    yw = np.array([yv[i] - ybars[resp[i]] for i in range(len(resp))])
    sol = solve_weighted_least_squares(
        Xw, yw, np.asarray(weights, dtype=np.float64))
    beta = np.asarray(sol["beta"])
    alphas = {r: float(ybars[r] - xbars[r] @ beta) for r in order}
    return {
        "beta": beta,
        "bread": np.asarray(sol["bread"]),
        "sse": float(sol["sse"]),
        "alphas": alphas,
        "xbars": xbars,
        "ybars": ybars,
        "rankInfo": {"rank": sol["rank"], "rankTol": sol["rankTol"],
                     "conditionNumber": sol["conditionNumber"]},
    }


def mean_intercept(
    alphas: dict[str, float], respondent_weights: dict[str, float]
) -> float:
    num = sum(float(respondent_weights[r]) * float(a) for r, a in alphas.items())
    den = sum(float(w) for w in respondent_weights.values()) or 1.0
    return float(num / den)
