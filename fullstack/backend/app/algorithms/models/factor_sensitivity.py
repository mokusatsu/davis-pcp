"""Pearson/Polychoric sensitivity comparison (Feature 033 EFA).

Design: DAVIS-FEAT-033-DESIGN.md section 7. NumPy + SciPy only.

- Same q and rotation: congruence c_ab = (P_a' O_b)/(||P_a|| ||O_b||),
  one-to-one assignment maximizing sum |c| via linear_sum_assignment,
  signed permutation H saved. After alignment O H, Phi_o -> H' Phi_o H,
  structure likewise. Originals are never overwritten.
- Ambiguous when: zero-norm factor, rank deficiency, best-vs-second-best
  assignment objective gap <= 1e-6, or any congruence < .85. Second-best
  assignments forbid one adopted edge at a time; q == 1 records
  "no second assignment".
- Procrustes (O'P = U D V', Q = U V', ||OQ - P||_F / ||P||_F) is an
  auxiliary space diagnostic only.
- Differences: max/median abs of i<j correlations, aligned loadings,
  communalities, off-diagonal Phi; definite assignment changes
  (threshold .4 default, margin .1 default; q == 1 has no second-place
  condition); PA candidate difference. Different q: coefficient
  differences are null with reasonCode=FACTOR_COUNTS_DIFFER (no zero
  padding).
- Assessment priority: one-sided failure / PA unavailable / boundary /
  inadmissible / unalignable -> indeterminate; then candidate difference,
  any max-difference over threshold, definite assignment change ->
  method_sensitive; ambiguous items -> indeterminate; all aligned,
  candidates agree, differences within guides, 0 assignment changes ->
  small_observed_difference.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import linalg
from scipy.optimize import linear_sum_assignment

ASSIGNMENT_GAP_TOL = 1e-6
CONGRUENCE_GUIDE = 0.85


def congruence_matrix(p: np.ndarray, o: np.ndarray) -> np.ndarray:
    p = np.asarray(p, dtype=float)
    o = np.asarray(o, dtype=float)
    q = p.shape[1]
    c = np.zeros((q, q))
    for a in range(q):
        for b in range(q):
            denom = float(np.linalg.norm(p[:, a]) * np.linalg.norm(o[:, b]))
            c[a, b] = float(p[:, a] @ o[:, b] / denom) if denom > 0 else 0.0
    return c


def align_factors(pattern_p: np.ndarray, pattern_o: np.ndarray,
                  phi_o: np.ndarray, structure_o: np.ndarray) -> dict[str, Any]:
    p = np.asarray(pattern_p, dtype=float)
    o = np.asarray(pattern_o, dtype=float)
    phi = np.asarray(phi_o, dtype=float)
    s = np.asarray(structure_o, dtype=float)
    q = p.shape[1]
    norms_p = np.linalg.norm(p, axis=0)
    norms_o = np.linalg.norm(o, axis=0)
    if np.any(norms_p <= 0) or np.any(norms_o <= 0):
        return {"status": "ambiguous", "reasonCode": "FACTOR_ALIGNMENT_AMBIGUOUS",
                "H": None, "permutation": None, "signs": None,
                "congruences": None, "assignmentGap": None,
                "zeroNorm": True}
    c = congruence_matrix(p, o)
    rows, cols = linear_sum_assignment(-np.abs(c))
    perm = [int(v) for v in cols.tolist()]
    signs = [1.0 if c[a, perm[a]] >= 0 else -1.0 for a in range(q)]
    congr = [float(abs(c[a, perm[a]])) for a in range(q)]
    h = np.zeros((q, q))
    for a in range(q):
        h[perm[a], a] = signs[a]
    best_obj = float(sum(abs(c[a, perm[a]]) for a in range(q)))
    if q == 1:
        gap = None
        second_note = "no second assignment"
    else:
        second_best = -np.inf
        for a in range(q):
            cost = -np.abs(c).copy()
            cost[a, perm[a]] = 0.0
            r2, c2 = linear_sum_assignment(cost)
            if len(r2) < q:
                continue
            obj = float(sum(abs(c[r2[k], c2[k]]) for k in range(q)))
            if any(c2[k] != perm[r2[k]] for k in range(q)):
                second_best = max(second_best, obj)
        gap = None if second_best == -np.inf else float(best_obj - second_best)
        second_note = None
    ambiguous = (gap is not None and gap <= ASSIGNMENT_GAP_TOL) or any(v < CONGRUENCE_GUIDE for v in congr)
    try:
        rank_ok = np.linalg.matrix_rank(h) == q and np.linalg.matrix_rank(o) == q
    except Exception:
        rank_ok = False
    if not rank_ok:
        ambiguous = True
    return {"status": "ambiguous" if ambiguous else "aligned",
            "reasonCode": "FACTOR_ALIGNMENT_AMBIGUOUS" if ambiguous else None,
            "H": h, "permutation": perm, "signs": signs, "congruences": congr,
            "assignmentGap": gap, "secondBestNote": second_note,
            "alignedPattern": o @ h, "alignedPhi": h.T @ phi @ h,
            "alignedStructure": s @ h, "zeroNorm": False}


def procrustes_residual(o: np.ndarray, p: np.ndarray) -> dict[str, Any]:
    o = np.asarray(o, dtype=float)
    p = np.asarray(p, dtype=float)
    try:
        u, _, vt = linalg.svd(o.T @ p, full_matrices=False)
        qmat = u @ vt
        denom = float(np.linalg.norm(p))
        num = float(np.linalg.norm(o @ qmat - p))
        return {"Q": qmat, "relativeResidual": (num / denom) if denom > 0 else None}
    except Exception:
        return {"Q": None, "relativeResidual": None}


def definite_assignments(pattern: np.ndarray, threshold: float = 0.4,
                         margin: float = 0.1) -> list[dict[str, Any]]:
    p = np.asarray(pattern, dtype=float)
    q = p.shape[1]
    out = []
    for j in range(p.shape[0]):
        order = sorted(range(q), key=lambda a: -abs(float(p[j, a])))
        top = float(abs(p[j, order[0]]))
        second = float(abs(p[j, order[1]])) if q > 1 else 0.0
        if top >= threshold and (q == 1 or top - second >= margin):
            out.append({"item": j, "factor": int(order[0]), "definite": True,
                        "ambiguous": False})
        else:
            out.append({"item": j, "factor": None, "definite": False,
                        "ambiguous": bool(top >= threshold - 1e-12)})
    return out


def comparison_metrics(r_p: np.ndarray, r_o: np.ndarray,
                       pat_p: np.ndarray, pat_o_aligned: np.ndarray,
                       h2_p: np.ndarray, h2_o: np.ndarray,
                       phi_p: np.ndarray, phi_o_aligned: np.ndarray,
                       q: int) -> dict[str, Any]:
    iu = np.triu_indices(r_p.shape[0], k=1)
    d_r = np.abs(np.asarray(r_p)[iu] - np.asarray(r_o)[iu])
    d_l = np.abs(np.asarray(pat_p) - np.asarray(pat_o_aligned))
    d_h = np.abs(np.asarray(h2_p) - np.asarray(h2_o))
    if q > 1:
        iu_q = np.triu_indices(q, k=1)
        d_phi = np.abs(np.asarray(phi_p)[iu_q] - np.asarray(phi_o_aligned)[iu_q])
    else:
        d_phi = np.array([0.0])
    stat = lambda v: {"max": float(np.max(v)) if v.size else None,
                      "median": float(np.median(v)) if v.size else None}
    return {"correlationDifference": stat(d_r), "loadingDifference": stat(d_l),
            "communalityDifference": stat(d_h), "factorCorrelationDifference": stat(d_phi)}


def assess_comparison(*, failed_side: bool, pa_unavailable: bool,
                      boundary_or_inadmissible: bool, unalignable: bool,
                      candidate_diff: bool, over_threshold: bool,
                      assignment_changes: int, ambiguous_items: int,
                      all_aligned: bool) -> str:
    if failed_side or pa_unavailable or boundary_or_inadmissible or unalignable:
        return "indeterminate"
    if candidate_diff or over_threshold or assignment_changes > 0:
        return "method_sensitive"
    if ambiguous_items > 0:
        return "indeterminate"
    if all_aligned:
        return "small_observed_difference"
    return "indeterminate"
