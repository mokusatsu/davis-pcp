"""Conjoint respondent-cluster covariance (Feature 034, production).

- none/frequency use V_CR1 = (G*/(G*-1)) H^-1 meat H^-1 with
  meat = sum_i f_i U_i U_i' (block replication; never f_i^2).
  Reference df = G*-1. No (N-1)/(N-p) row-count correction.
- survey delegates the meat to the shared Taylor model-covariance
  construction but keeps the conjoint reference df D = sum(m_h-1):
  never the regression D-(p-intercept).
"""
from __future__ import annotations

from typing import Any

import numpy as np


def respondent_cluster_cr1(
    *,
    bread: np.ndarray,
    respondent_scores: dict[str, np.ndarray],
    respondent_replications: dict[str, float] | None = None,
) -> dict[str, Any]:
    B = np.asarray(bread, dtype=np.float64)
    p = B.shape[0]
    reps = {k: float(v) for k, v in (respondent_replications or {}).items()}
    meat = np.zeros((p, p), dtype=np.float64)
    g_star = 0.0
    for resp, u in respondent_scores.items():
        f = float(reps.get(resp, 1.0))
        g_star += f
        uu = np.asarray(u, dtype=np.float64).reshape((p,))
        meat += f * np.outer(uu, uu)
    if g_star <= 1.0:
        return {"status": "point_only", "reason": "CR1_G_LE_ONE",
                "covariance": None, "gStar": float(g_star),
                "referenceDf": None}
    factor = float(g_star) / float(g_star - 1.0)
    cov = factor * (B @ meat @ B)
    return {"status": "available", "reason": None, "covariance": cov,
            "gStar": float(g_star), "referenceDf": float(g_star - 1.0),
            "correction": "G*/(G*-1) only"}


def conjoint_survey_covariance(
    *,
    bread: np.ndarray,
    respondent_scores: dict[str, np.ndarray],
    respondent_weights: dict[str, float],
    design_frame: dict[str, Any],
) -> dict[str, Any]:
    """Taylor meat via shared construction; conjoint df D (no p penalty)."""
    from ..survey.model_covariance import taylor_model_covariance

    order = list(design_frame.get("rowIds", []))
    p = int(np.asarray(bread).shape[0])
    scores = np.zeros((len(order), p), dtype=np.float64)
    # Design frame rows are respondents; scope-outside respondents keep
    # score 0 by construction of the caller.
    pos = {str(r): i for i, r in enumerate(order)}
    for resp, u in respondent_scores.items():
        if str(resp) in pos:
            scores[pos[str(resp)]] = (np.asarray(u, dtype=np.float64).reshape((p,))
                                      * float(respondent_weights.get(str(resp), 1.0)))
    out = taylor_model_covariance(
        design_frame=design_frame, scores=scores, bread=np.asarray(bread),
        n_params=p, intercept=False)
    if out.get("status") == "unavailable" or out.get("covariance") is None:
        return {"status": "unavailable",
                "reason": out.get("reason") or "SURVEY_DESIGN_UNAVAILABLE",
                "covariance": None, "designDf": out.get("designDf"),
                "referenceDf": None,
                "designAssumption": out.get("designAssumption")}
    design_df = int(out.get("designDf", 0))
    ref: float | None = float(design_df)
    if not np.isfinite(ref) or ref <= 0:
        return {"status": "available_no_reference",
                "reason": "REFERENCE_DF_NONPOSITIVE",
                "covariance": np.asarray(out["covariance"]),
                "designDf": design_df, "referenceDf": float(ref),
                "designAssumption": out.get("designAssumption")}
    return {"status": "available", "reason": None,
            "covariance": np.asarray(out["covariance"]),
            "designDf": design_df, "referenceDf": float(ref),
            "designAssumption": out.get("designAssumption")}
