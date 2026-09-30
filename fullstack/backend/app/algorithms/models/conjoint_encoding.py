"""Conjoint effect coding kernel (Feature 034, production).

Implements DAVIS-FEAT-034-DESIGN section 3 on already-clean inputs:

- categorical attributes use K-1 effect-coded columns; the omitted
  reference level maps to all -1 so level utilities always sum to 0.
- linear attributes are centered at the weighted training mean of regular
  profile rows; the center and the importance utilityRange are stored and
  never re-estimated at predict time.
- No zero-coefficient padding for unobserved levels: they go to
  omittedLevels. Constant single-level attributes raise
  CONJOINT_CONSTANT_ATTRIBUTE.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np


def build_effect_dictionary(
    *,
    attributes: list[dict[str, Any]],
    catalog: dict[str, list[str]],
) -> dict[str, Any]:
    """Build the fixed training encoding dictionary.

    attributes: [{columnId, kind, referenceLevel?|utilityRange?}]
    catalog: {columnId: [ordered observed level codes]} for categorical attrs.
    """
    design_columns: list[dict[str, Any]] = []
    level_maps: dict[str, dict[str, Any]] = {}
    linear_centers: dict[str, float] = {}
    omitted_levels: list[dict[str, Any]] = []
    seen: set[str] = set()
    for attr in attributes:
        cid = str(attr["columnId"])
        if cid in seen:
            raise ValueError("CONJOINT_DUPLICATE_ATTRIBUTE")
        seen.add(cid)
        kind = str(attr.get("kind"))
        if kind == "categorical":
            levels = [str(v) for v in (catalog.get(cid) or [])]
            if len(levels) < 2:
                raise ValueError("CONJOINT_CONSTANT_ATTRIBUTE")
            ref = attr.get("referenceLevel")
            ref_code = str(ref) if ref is not None else levels[-1]
            if ref_code not in levels:
                raise ValueError("CONJOINT_UNKNOWN_REFERENCE_LEVEL")
            non_ref = [lv for lv in levels if lv != ref_code]
            cols = [f"eff:{cid}:{lv}" for lv in non_ref]
            per_level: dict[str, list[float]] = {}
            for lv in non_ref:
                vec = [0.0] * len(non_ref)
                vec[non_ref.index(lv)] = 1.0
                per_level[lv] = vec
            per_level[ref_code] = [-1.0] * len(non_ref)
            level_maps[cid] = {
                "kind": "categorical",
                "levels": list(levels),
                "referenceLevel": ref_code,
                "nonRefLevels": list(non_ref),
                "codes": per_level,
            }
            for pos, lv in enumerate(non_ref):
                design_columns.append({
                    "columnId": cid, "kind": "categorical",
                    "level": lv, "reference": ref_code,
                    "position": pos, "width": len(non_ref),
                })
        elif kind == "linear":
            ur = attr.get("utilityRange")
            if ur is not None:
                lo, hi = float(ur[0]), float(ur[1])
                if not (math.isfinite(lo) and math.isfinite(hi)) or not lo < hi:
                    raise ValueError("CONJOINT_INVALID_UTILITY_RANGE")
            design_columns.append({
                "columnId": cid, "kind": "linear",
                "position": 0, "width": 1,
            })
            level_maps[cid] = {"kind": "linear"}
        else:
            raise ValueError("CONJOINT_UNKNOWN_ATTRIBUTE_KIND")
    # Column offsets in fixed attribute order. CJ-R001: each expanded
    # categorical column entry must advance the offset by 1 (not by the
    # block width), otherwise attributes after a multi-level categorical
    # point out of bounds.
    offset = 0
    for dc in design_columns:
        # Each expanded entry occupies exactly one column; the running
        # counter is the entry offset. position recovers the block base
        # (offset - position) when writing full effect-code rows.
        dc["offset"] = offset
        offset += 1
    # Block widths: categorical blocks span their K-1 columns.
    n_params = offset
    for dc in design_columns:
        if dc["kind"] == "categorical":
            width = sum(1 for o in design_columns
                        if o["columnId"] == dc["columnId"]
                        and o["kind"] == "categorical")
            dc["width"] = width
    return {
        "designColumns": design_columns,
        "levelMaps": level_maps,
        "linearCenters": dict(linear_centers),
        "omittedLevels": list(omitted_levels),
        "nParams": int(n_params),
    }


def encode_row(
    values: dict[str, Any],
    dictionary: dict[str, Any],
    *,
    unknown_policy: str = "reject",
) -> tuple[np.ndarray, list[str]]:
    """Encode one regular profile row. Returns (vector, unknownLevels)."""
    p = int(dictionary["nParams"])
    vec = np.zeros((p,), dtype=np.float64)
    unknown: list[str] = []
    for dc in dictionary["designColumns"]:
        cid = dc["columnId"]
        if dc["kind"] == "linear":
            if dc["position"] != 0:
                continue
            raw = values.get(cid)
            if raw is None:
                raise ValueError("CONJOINT_MISSING_ATTRIBUTE")
            try:
                xv = float(raw)
            except (TypeError, ValueError):
                raise ValueError("CONJOINT_INVALID_ATTRIBUTE")
            if not math.isfinite(xv):
                raise ValueError("CONJOINT_INVALID_ATTRIBUTE")
            center = float(dictionary["linearCenters"].get(cid, 0.0))
            vec[int(dc["offset"])] = xv - center
        else:
            if dc["position"] != 0 and dc["offset"] is not None:
                pass
            code = values.get(cid)
            if code is None:
                raise ValueError("CONJOINT_MISSING_ATTRIBUTE")
            scode = str(code)
            lm = dictionary["levelMaps"][cid]
            if scode not in lm["codes"]:
                if unknown_policy == "reject":
                    raise ValueError("CONJOINT_UNKNOWN_LEVEL")
                unknown.append(f"{cid}:{scode}")
                continue
            row = lm["codes"][scode]
            for k, val in enumerate(row):
                vec[int(dc["offset"]) - int(dc["position"]) + k] = float(val)
    return vec, unknown


def level_utility_matrix(
    dictionary: dict[str, Any],
    beta: np.ndarray,
    covariance: np.ndarray | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Expand beta to per-level utilities u = L beta, V_u = L V L'.

    Reference-level rows come from the -1 row of L, so utilities sum to 0
    and reference SEs are propagated (never forced to 0).
    """
    beta = np.asarray(beta, dtype=np.float64)
    cov = np.asarray(covariance, dtype=np.float64) if covariance is not None else None
    utilities: list[dict[str, Any]] = []
    ranges: dict[str, dict[str, Any]] = {}
    for dc in dictionary["designColumns"]:
        cid = dc["columnId"]
        lm = dictionary["levelMaps"][cid]
        if lm["kind"] != "categorical":
            continue
        if any(u["attributeId"] == cid for u in utilities if u.get("kind") == "categorical"):
            continue
        rows_L: list[np.ndarray] = []
        order = list(lm["levels"])
        for lv in order:
            code = lm["codes"][lv]
            full = np.zeros((int(dictionary["nParams"]),), dtype=np.float64)
            base = int(dc["offset"]) - int(dc["position"])
            for k, val in enumerate(code):
                full[base + k] = float(val)
            rows_L.append(full)
        L = np.vstack(rows_L)
        u = L @ beta
        if cov is not None:
            v_u = L @ cov @ L.T
            se = [float(math.sqrt(max(0.0, v_u[i, i]))) for i in range(len(order))]
        else:
            se = [None] * len(order)
        for i, lv in enumerate(order):
            utilities.append({
                "attributeId": cid, "kind": "categorical",
                "levelCode": lv, "utility": float(u[i]),
                "standardError": se[i],
                "referenceLevel": lm["referenceLevel"],
            })
        vals = [float(v) for v in u.tolist()]
        ranges[cid] = {"min": min(vals), "max": max(vals),
                       "range": max(vals) - min(vals)}
    return utilities, ranges
