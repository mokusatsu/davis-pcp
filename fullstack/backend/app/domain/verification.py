"""Exploration/verification contracts for subgroup mining (Feature 24).

Classic uses ``analysisMode``; modern uses ``inferenceMode``. The modern
algorithm ``mode`` (auto/standard/emm_kendall) is untouched.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

import numpy as np

from .errors import BizError

AnalysisMode = Literal["exploration", "verification"]


def candidate_set_hash(candidates: list[dict[str, Any]]) -> str:
    normalized = sorted(
        ({"id": c.get("id"), "condition": c.get("condition"),
          "target": c.get("target"), "scopeHash": c.get("scopeHash")} for c in candidates),
        key=lambda c: str(c.get("id")),
    )
    payload = json.dumps(normalized, ensure_ascii=False, sort_keys=True)
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def split_holdout(row_ids: list[str], test_size: float, seed: int) -> tuple[list[str], list[str]]:
    if not 0 < test_size < 1:
        raise BizError("VERIFICATION_CONFIG_INVALID", "test_sizeは0より大きく1より小さくしてください。",
                       status_code=422)
    rng = np.random.default_rng(seed)
    order = list(row_ids)
    rng.shuffle(order)
    n_test = max(1, int(round(len(order) * test_size)))
    if n_test >= len(order):
        raise BizError("VERIFICATION_INSUFFICIENT_DATA", "検証分割が成立しません。",
                       status_code=422)
    return order[:len(order) - n_test], order[len(order) - n_test:]


def split_folds(row_ids: list[str], k: int, seed: int) -> list[list[str]]:
    if k < 2:
        raise BizError("VERIFICATION_CONFIG_INVALID", "kは2以上にしてください。", status_code=422)
    if len(row_ids) < k:
        raise BizError("VERIFICATION_INSUFFICIENT_DATA", "fold数に対して行が不足しています。",
                       status_code=422)
    rng = np.random.default_rng(seed)
    order = list(row_ids)
    rng.shuffle(order)
    folds: list[list[str]] = [[] for _ in range(k)]
    for index, row_id in enumerate(order):
        folds[index % k].append(row_id)
    return folds


def benjamini_hochberg_adjust(p_values: list[float]) -> tuple[list[float], list[bool], int]:
    from ..algorithms.mining.subgroup import benjamini_hochberg

    q_values, rejected = benjamini_hochberg(p_values, alpha=0.05)
    return q_values, rejected, len(p_values)


def check_row_disjoint(selection: list[str], evaluation: list[str]) -> None:
    if set(selection) & set(evaluation):
        raise BizError("VERIFICATION_SCOPE_OVERLAP",
                       "候補固定用と評価用のrowIdが重複しています。", status_code=422)


def wilson_interval(successes: int, n: int, z: float = 1.96) -> list[float] | None:
    if n <= 0:
        return None
    p = successes / n
    denom = 1 + z * z / n
    center = p + z * z / (2 * n)
    margin = z * ((p * (1 - p) + z * z / (4 * n)) / n) ** 0.5
    return [round((center - margin) / denom, 4), round((center + margin) / denom, 4)]
