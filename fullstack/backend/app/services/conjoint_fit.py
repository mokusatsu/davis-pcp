"""Conjoint estimation assembly (Feature 034, production).

Builds encoding dictionaries, design matrices, fits ratings/choice/ranking
branches, computes respondent-cluster/survey covariances, t inference,
utilities/importance, fit metrics, and row outputs.
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

import numpy as np
from scipy import stats

from ..algorithms.models import conjoint_choice as _choice
from ..algorithms.models import conjoint_covariance as _cov
from ..algorithms.models import conjoint_encoding as _enc
from ..algorithms.models import conjoint_ratings as _ratings
from ..algorithms.survey.model_covariance import build_regression_design_frame
from ..domain.errors import BizError


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _design_column_id(term_id, descriptors):
    canon = json.dumps([term_id, descriptors], ensure_ascii=False,
                       separators=(",", ":"), allow_nan=False)
    return "design:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _category_id(column_id, kind, code):
    canon = json.dumps([column_id, kind, code], ensure_ascii=False,
                       separators=(",", ":"), allow_nan=False)
    return "cat:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def build_encoding(
    *,
    attributes: list[dict[str, Any]],
    catalog: dict[str, list[str]],
    finalized_rows: list[dict[str, Any]],
    fit_row_ids: list[str],
    resp_weight: dict[str, float | None],
    has_opt: bool,
    price_attr: str | None,
) -> dict[str, Any]:
    dictionary = _enc.build_effect_dictionary(
        attributes=attributes, catalog=catalog)
    # Linear centers: weighted mean over regular fit profile rows.
    fit_set = set(fit_row_ids)
    centers: dict[str, float] = {}
    lin_cids = [str(a["columnId"]) for a in attributes
                if str(a.get("kind")) == "linear"]
    for cid in lin_cids:
        num, den = 0.0, 0.0
        for r in finalized_rows:
            if r["rowId"] not in fit_set:
                continue
            if r.get("optOut") and has_opt:
                continue
            v = (r.get("attrValues") or {}).get(cid)
            if v is None:
                continue
            w = float(resp_weight.get(r["respondentId"]) or 0.0)
            num += w * float(v)
            den += w
        centers[cid] = float(num / den) if den > 0 else 0.0
    dictionary["linearCenters"] = centers
    # Utility ranges: explicit or fit min/max; warn if explicit out of range.
    lin_ranges: dict[str, dict[str, Any]] = {}
    warnings: list[dict[str, Any]] = []
    for attr in attributes:
        if str(attr.get("kind")) != "linear":
            continue
        cid = str(attr["columnId"])
        vals = []
        for r in finalized_rows:
            if r["rowId"] not in fit_set:
                continue
            if r.get("optOut") and has_opt:
                continue
            v = (r.get("attrValues") or {}).get(cid)
            if v is not None:
                vals.append(float(v))
        fit_lo, fit_hi = (min(vals), max(vals)) if vals else (0.0, 0.0)
        ur = attr.get("utilityRange")
        if ur is not None:
            lo, hi = float(ur[0]), float(ur[1])
            if lo < fit_lo or hi > fit_hi:
                warnings.append({
                    "code": "CONJOINT_UTILITY_RANGE_EXTRAPOLATION",
                    "message": "指定rangeは訓練範囲外を含みます。",
                    "count": 1, "columnIds": [cid]})
        else:
            lo, hi = fit_lo, fit_hi
        lin_ranges[cid] = {"lower": lo, "upper": hi,
                           "fitMin": fit_lo, "fitMax": fit_hi}
    # Opt-out ASC column appended when requested.
    asc_offset: int | None = None
    if has_opt:
        asc_offset = int(dictionary["nParams"])
        dictionary["nParams"] = int(dictionary["nParams"]) + 1
        dictionary["ascOffset"] = asc_offset
    else:
        dictionary["ascOffset"] = None
    dictionary["linearRanges"] = lin_ranges
    dictionary["encodeWarnings"] = warnings
    return dictionary


def encode_fit_matrix(
    *,
    dictionary: dict[str, Any],
    rows: list[dict[str, Any]],
    fit_row_ids: list[str],
    has_opt: bool,
) -> dict[str, np.ndarray]:
    fit_set = set(fit_row_ids)
    p = int(dictionary["nParams"])
    out: dict[str, np.ndarray] = {}
    for r in rows:
        if r["rowId"] not in fit_set:
            continue
        if r.get("optOut") and has_opt:
            vec = np.zeros((p,), dtype=np.float64)
            vec[int(dictionary["ascOffset"])] = 1.0
            out[r["rowId"]] = vec
            continue
        vals = dict(r.get("attrValues") or {})
        vec, _ = _enc.encode_row(vals, dictionary)
        if has_opt:
            full = np.zeros((p,), dtype=np.float64)
            full[: len(vec)] = vec
            vec = full
        out[r["rowId"]] = vec
    return out


def t_rows(
    *,
    beta: np.ndarray,
    covariance: np.ndarray | None,
    reference_df: float | None,
    confidence_level: float,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for j in range(len(beta)):
        if covariance is None:
            rows.append({"standardError": None, "statistic": None,
                         "pValue": None, "ciLower": None, "ciUpper": None,
                         "reason": "INFERENCE_UNAVAILABLE"})
            continue
        se = float(math.sqrt(max(0.0, float(covariance[j, j]))))
        if not math.isfinite(se) or se <= 0:
            rows.append({"standardError": None, "statistic": None,
                         "pValue": None, "ciLower": None, "ciUpper": None,
                         "reason": "INFERENCE_UNAVAILABLE"})
            continue
        tstat = float(beta[j] / se)
        df = reference_df
        if df is not None and math.isfinite(df) and df > 0:
            p = float(2.0 * stats.t.sf(abs(tstat), df))
            crit = float(stats.t.ppf(0.5 + confidence_level / 2.0, df))
        else:
            p = float(2.0 * stats.norm.sf(abs(tstat)))
            crit = float(stats.norm.ppf(0.5 + confidence_level / 2.0))
            df = None
        rows.append({"standardError": se, "statistic": tstat, "pValue": p,
                     "ciLower": float(beta[j] - crit * se),
                     "ciUpper": float(beta[j] + crit * se),
                     "reason": None})
    return rows
