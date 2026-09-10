"""Survey weight resolver and row-value validation (Feature 21, first stage).

Separates the survey weight (population correction) from the pre-existing
sampling weights (``sampledRowWeights``: bootstrap duplication counts) and
from mining/clustering score weights. Only ``role=weight`` numeric columns
are candidates; nothing is auto-adopted.
"""
from __future__ import annotations

from typing import Any

import polars as pl

from .codebook_adapter import normalize_code
from .errors import BizError


WEIGHT_UNSUPPORTED_MESSAGE = "この分析は調査ウェイトを適用しません。"


def find_weight_spec(codebook: dict[str, Any] | None, weight_column: str | None) -> dict[str, Any] | None:
    """Return the codebook column spec for ``weight_column`` (matched by name or columnId)."""
    if weight_column is None:
        return None
    columns = (codebook or {}).get("columns", []) or []
    for spec in columns:
        if not isinstance(spec, dict):
            continue
        if spec.get("name") == weight_column or spec.get("columnId") == weight_column:
            return spec
    return None


def resolve_weight_column(codebook: dict[str, Any] | None, weight_column: str | None) -> dict[str, Any] | None:
    """Validate the weight column reference. Raises 422 on unknown column or wrong role/scale."""
    if weight_column is None:
        return None
    spec = find_weight_spec(codebook, weight_column)
    if spec is None:
        raise BizError("WEIGHT_COLUMN_NOT_FOUND", "ウェイト列が存在しません。", status_code=422)
    if spec.get("role") != "weight":
        raise BizError("WEIGHT_ROLE_INVALID", "ウェイト列はrole=weightの列を指定してください。", status_code=422)
    if spec.get("multiResponseGroup"):
        raise BizError("WEIGHT_ROLE_INVALID", "MA設問はウェイト列に指定できません。", status_code=422)
    if spec.get("scaleType") not in ("interval", "ratio"):
        raise BizError("WEIGHT_ROLE_INVALID", "ウェイト列は数値尺度（interval/ratio）の列を指定してください。", status_code=422)
    return spec


def weight_candidates(codebook: dict[str, Any] | None) -> list[dict[str, Any]]:
    """List columns eligible as survey weights: role=weight, numeric scale, non-MA."""
    result = []
    for spec in ((codebook or {}).get("columns", []) or []):
        if not isinstance(spec, dict):
            continue
        if spec.get("role") != "weight":
            continue
        if spec.get("multiResponseGroup"):
            continue
        if spec.get("scaleType") not in ("interval", "ratio"):
            continue
        result.append(spec)
    return result


def extract_weights(
    frame: pl.DataFrame,
    column_name: str,
    weight_spec: dict[str, Any] | None = None,
) -> tuple[list[float | None], int, bool]:
    """Convert raw weight values. Returns (weights, missing_count, has_invalid).

    - None / null / NaN / ±Infinity / non-numeric strings are invalid, except
      plain nulls which count as missing and exclude the row from weighting.
    - Negative values and non-convertible strings are invalid (422 upstream).
    - Zero is allowed but contributes nothing to the weighted denominator.
    """
    missing_codes: set[str] = set()
    if weight_spec is not None:
        missing_codes = {c for c in (normalize_code(v) for v in (weight_spec.get("missingCodes") or []))
                         if c is not None}
    weights: list[float | None] = []
    missing = 0
    has_invalid = False
    for raw in frame[column_name].to_list():
        if normalize_code(raw) in missing_codes:
            weights.append(None)
            missing += 1
            continue
        if raw is None:
            weights.append(None)
            missing += 1
            continue
        try:
            import math

            if isinstance(raw, bool):
                raise ValueError("bool")
            value = float(raw)
            if isinstance(raw, str) and raw.strip() == "":
                raise ValueError("empty")
            if not math.isfinite(value):
                has_invalid = True
                weights.append(None)
                continue
            if value < 0:
                has_invalid = True
                weights.append(None)
                continue
            weights.append(value)
        except (TypeError, ValueError):
            code = normalize_code(raw)
            if code is None:
                weights.append(None)
                missing += 1
            else:
                has_invalid = True
                weights.append(None)
    return weights, missing, has_invalid


def check_weights_valid(weights: list[float | None], has_invalid: bool) -> None:
    if has_invalid:
        raise BizError(
            "WEIGHT_VALUE_INVALID",
            "ウェイト列に負値・非有限値・変換不能値が含まれています。",
            status_code=422,
        )


def weighted_status(has_weight: bool, positive_mass: float) -> str:
    if not has_weight:
        return "omitted"
    if positive_mass <= 0:
        return "no_positive_weight"
    return "applied"
