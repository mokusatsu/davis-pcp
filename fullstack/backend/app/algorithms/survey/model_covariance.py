"""Survey Taylor model covariance for Feature 032 (production).

Implements the Feature 029-034 common-design section 7 contract directly:

- The full-dataset design frame is retained; scope-outside and
  analysis-variable-missing rows contribute score 0 instead of shrinking
  the PSU set.
- PSUs are identified by (stratum, psu) pairs. FPC is the in-stratum
  population PSU count M_h (never a fraction); it must be constant within
  a stratum, finite, and M_h >= m_h.
- PSU score totals, in-stratum centering, m_h/(m_h-1), and the FPC
  correction are applied exactly as specified. Without PSU info each row
  is an independent unit with an explicit approximation label.
- Only certainty singletons (explicit M_h == 1) contribute zero. Other
  singletons are unavailable, never silently dropped or adjusted.
- Reference df D-(p-intercept); design defects/unavailable inference and
  blatantly invalid 422 inputs are distinguished.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from ...domain.errors import BizError


def _text_or_missing(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and not np.isfinite(value):
        return None
    text = str(value)
    if text.strip() == "" or text in ("None", "nan", "NaN", "NULL", "null"):
        return None
    return text


def build_regression_design_frame(
    *,
    row_ids: list[str],
    weights: list[float],
    strata: list[Any] | None,
    psu: list[Any] | None,
    fpc: list[Any] | None,
) -> dict[str, Any]:
    """Validate the complete design: weights + stratum/PSU/FPC identity."""
    n = len(row_ids)
    w = np.asarray(weights, dtype=np.float64)
    if w.shape != (n,) or not np.isfinite(w).all() or (w <= 0).any():
        raise BizError("SURVEY_DESIGN_UNSUPPORTED", "survey重みが不正です。",
                       status_code=422)
    has_strata = strata is not None
    has_psu = psu is not None
    stratum_vals: list[str] | None = None
    psu_vals: list[str] | None = None
    if has_strata:
        if len(strata or []) != n:
            raise BizError("SURVEY_DESIGN_UNSUPPORTED", "層変数の長さが一致しません。",
                           status_code=422)
        stratum_vals = []
        for i, raw in enumerate(strata or []):
            text = _text_or_missing(raw, "strata")
            if text is None:
                raise BizError("SURVEY_DESIGN_MISSING", "設計変数に欠損があります。",
                               status_code=422)
            stratum_vals.append(text)
    if has_psu:
        if len(psu or []) != n:
            raise BizError("SURVEY_DESIGN_UNSUPPORTED", "PSU変数の長さが一致しません。",
                           status_code=422)
        psu_vals = []
        for i, raw in enumerate(psu or []):
            text = _text_or_missing(raw, "psu")
            if text is None:
                raise BizError("SURVEY_DESIGN_MISSING", "設計変数に欠損があります。",
                               status_code=422)
            psu_vals.append(text)
    if has_psu != has_strata and (has_psu or has_strata):
        # One side alone still defines a usable frame; missing side becomes
        # one implicit level. Weight/design-ID missing rows never reach here.
        pass
    if stratum_vals is None:
        stratum_vals = ["1"] * n
    if psu_vals is None:
        psu_vals = [str(rid) for rid in row_ids]
        assumption = "independent_units"
    else:
        assumption = "provided" if has_psu else "independent_units"
    fpc_vals: np.ndarray | None = None
    if fpc is not None:
        if len(fpc) != n:
            raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC の長さが一致しません。",
                           status_code=422)
        raw = np.asarray(fpc, dtype=np.float64)
        if not np.isfinite(raw).all():
            raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC が不正です。",
                           status_code=422)
        # FPC is a count of population PSUs, never a sampling fraction.
        if ((raw <= 0) & (raw < 1)).any() or (raw < 1).any():
            raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC が不正です。",
                           status_code=422)
        if ((raw > 0) & (raw < 1)).any():
            raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC が不正です。",
                           status_code=422)
        # Constant within stratum and covering the sampled PSU count.
        grouped: dict[str, list[float]] = {}
        for s, v in zip(stratum_vals, raw.tolist()):
            grouped.setdefault(s, []).append(float(v))
        for s, vals in grouped.items():
            first = vals[0]
            if any(abs(v - first) > 1e-9 for v in vals):
                raise BizError("SURVEY_DESIGN_UNSUPPORTED",
                               "FPC は層内で一定である必要があります。", status_code=422)
            pair_psus = {p for ss, p in zip(stratum_vals, psu_vals) if ss == s}
            if first < len(pair_psus) - 1e-9:
                raise BizError("SURVEY_DESIGN_UNSUPPORTED",
                               "FPC は標本PSU数を下回れません。", status_code=422)
        fpc_vals = raw
    return {
        "rowIds": [str(v) for v in row_ids],
        "weights": w,
        "strata": stratum_vals,
        "psu": psu_vals,
        "fpc": fpc_vals,
        "assumption": assumption,
    }


def taylor_model_covariance(
    *,
    design_frame: dict[str, Any],
    scores: np.ndarray,
    bread: np.ndarray,
    n_params: int,
    intercept: bool,
) -> dict[str, Any]:
    """Taylor-linearized V = B meat B' with the Feature 032 reference df."""
    u = np.asarray(scores, dtype=np.float64)
    if u.ndim != 2:
        raise ValueError("scores must be a 2D array")
    n = u.shape[0]
    p = int(n_params)
    bread_mat = np.asarray(bread, dtype=np.float64)
    if bread_mat.shape != (p, p):
        raise ValueError("bread shape must match parameter count")
    strata: list[str] = list(design_frame["strata"])
    psu: list[str] = list(design_frame["psu"])
    fpc = design_frame.get("fpc")
    if len(strata) != n or len(psu) != n:
        raise ValueError("design frame length must match scores")
    meat = np.zeros((p, p), dtype=np.float64)
    design_df = 0
    singleton_without_certainty: list[str] = []
    # Group PSUs by (stratum, psu): duplicate local PSU numbers in different
    # strata stay distinct by construction.
    by_stratum: dict[str, dict[str, list[int]]] = {}
    for i, (s, g) in enumerate(zip(strata, psu)):
        by_stratum.setdefault(s, {}).setdefault(g, []).append(i)
    per_stratum_m: dict[str, int] = {s: len(groups) for s, groups in by_stratum.items()}
    per_stratum_mh: dict[str, float | None] = {}
    if fpc is not None:
        fpc_arr = np.asarray(fpc, dtype=np.float64)
        for s, groups in by_stratum.items():
            idx = [i for members in groups.values() for i in members]
            vals = fpc_arr[idx]
            first = float(vals[0])
            if any(abs(float(v) - first) > 1e-9 for v in vals.tolist()):
                raise BizError("SURVEY_DESIGN_UNSUPPORTED",
                               "FPC は層内で一定である必要があります。", status_code=422)
            if first < len(groups) - 1e-9:
                raise BizError("SURVEY_DESIGN_UNSUPPORTED",
                               "FPC は標本PSU数を下回れません。", status_code=422)
            per_stratum_mh[s] = first
    else:
        per_stratum_mh = {s: None for s in by_stratum}
    for s, groups in by_stratum.items():
        m_h = len(groups)
        m_pop = per_stratum_mh.get(s)
        totals = np.vstack([u[members].sum(axis=0) for members in groups.values()])
        if m_h < 2:
            if m_pop is not None and abs(float(m_pop) - 1.0) <= 1e-9:
                # Certainty singleton: zero contribution, keeps df unchanged.
                continue
            singleton_without_certainty.append(s)
            continue
        centered = totals - totals.mean(axis=0, keepdims=True)
        factor = float(m_h) / float(m_h - 1)
        if m_pop is not None:
            factor *= max(0.0, (float(m_pop) - float(m_h)) / float(m_pop))
        meat += factor * (centered.T @ centered)
        design_df += m_h - 1
    if singleton_without_certainty:
        return {
            "status": "unavailable",
            "reason": "SINGLETON_PSU_WITHOUT_CERTAINTY",
            "covariance": None,
            "designDf": int(design_df),
            "referenceDf": None,
            "singletonStrata": sorted(set(singleton_without_certainty)),
            "designAssumption": design_frame.get("assumption", "provided"),
        }
    cov = bread_mat @ meat @ bread_mat
    ref_df: float | None = float(design_df - (p - (1 if intercept else 0)))
    if ref_df is not None and (not np.isfinite(ref_df) or ref_df <= 0):
        return {
            "status": "available_no_reference",
            "reason": "REFERENCE_DF_NONPOSITIVE",
            "covariance": cov,
            "designDf": int(design_df),
            "referenceDf": float(ref_df),
            "singletonStrata": [],
            "designAssumption": design_frame.get("assumption", "provided"),
        }
    return {
        "status": "available",
        "reason": None,
        "covariance": cov,
        "designDf": int(design_df),
        "referenceDf": float(ref_df) if ref_df is not None else None,
        "singletonStrata": [],
        "designAssumption": design_frame.get("assumption", "provided"),
    }
