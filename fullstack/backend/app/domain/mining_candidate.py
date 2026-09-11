"""Pinned candidate contract for subgroup-mining verification (Feature 24 / VERIFY-02, VERIFY-05).

Exploration produces candidates; verification must evaluate exactly those
candidates and nothing else. This module is the single source of truth for
the canonical candidate object (rule + estimand) and for the hash that
identifies a candidate set.

The hash covers the rule, the contrasted levels (estimand), the dataset
revision triple and the exploration parameters. Two candidate sets that
differ in any of those cannot share a hash, and a candidate set produced at
one data revision cannot be verified against another.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Literal

from pydantic import BaseModel, Field

ALGORITHM_CLASSIC = "classic"
ALGORITHM_MODERN = "modern"

ESTIMAND_MEAN_DIFFERENCE = "mean_difference"
ESTIMAND_PROPORTION_DIFFERENCE = "proportion_difference"
ESTIMAND_TAU_DIFFERENCE = "kendall_tau_difference"

HASH_PREFIX = "sha256:"


def canonical_dumps(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _as_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number:  # NaN
        return None
    return number


def _canonical_value(value: Any) -> Any:
    if isinstance(value, (list, tuple)):
        return [_canonical_value(v) for v in value]
    if isinstance(value, bool):
        return bool(value)
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return round(float(value), 9)
    if value is None:
        return None
    return str(value)


def normalize_condition(raw: Any) -> dict[str, Any]:
    """Canonical, order-stable form of a modern-subgroup condition."""
    if hasattr(raw, "to_dict"):
        raw = raw.to_dict()
    if not isinstance(raw, dict):
        return {"column": str(raw), "operator": "==", "value": None}
    return {
        "column": str(raw.get("column", "")),
        "operator": str(raw.get("operator", "")),
        "value": _canonical_value(raw.get("value")),
    }


def condition_sort_key(condition: dict[str, Any]) -> tuple[str, str, str]:
    return (str(condition.get("column", "")), str(condition.get("operator", "")),
            canonical_dumps(condition.get("value")))


class PinnedCandidate(BaseModel):
    candidateId: str
    algorithm: Literal["classic", "modern"]
    rule: dict[str, Any]
    estimand: dict[str, Any]
    displayLabel: str = ""
    # Effect observed during exploration, used to report whether the
    # evaluation split reproduced the same direction. Not part of the hash.
    explorationEffect: float | None = None


class PinnedCandidateSet(BaseModel):
    candidateSetHash: str = ""
    datasetId: str
    dataRevision: int
    schemaRevision: int
    scopeHash: str
    algorithm: str
    parameters: dict[str, Any] = Field(default_factory=dict)
    candidates: list[PinnedCandidate] = Field(default_factory=list)


def classic_candidate(item: dict[str, Any]) -> PinnedCandidate | None:
    """Build a pinned candidate from a classic exploration insight.

    The contrasted levels come from the exploration's ``direction`` so that
    verification re-tests the very same contrast instead of an unrelated one.
    """
    direction = item.get("direction") or {}
    subgroup = item.get("subgroup") if isinstance(item.get("subgroup"), dict) else {}
    question = item.get("question") if isinstance(item.get("question"), dict) else {}
    attribute = str((subgroup or {}).get("name") or "")
    target = str((question or {}).get("name") or "")
    candidate_id = str(item.get("id") or "")
    if not attribute or not target or not candidate_id:
        return None
    scale_type = str((question or {}).get("type") or "numeric")
    attribute_label = str((subgroup or {}).get("label") or attribute)
    target_label = str((question or {}).get("label") or target)

    if direction.get("top_group") is not None and direction.get("characteristic_category") is not None:
        level = str(direction["top_group"])
        category = str(direction["characteristic_category"])
        rule = {
            "kind": "classic_categorical",
            "attribute": {"column": attribute, "conditionLevel": level},
            "question": {"column": target, "conditionCategory": category, "scaleType": scale_type},
        }
        estimand = {
            "type": ESTIMAND_PROPORTION_DIFFERENCE,
            "cell": {"attributeLevel": level, "questionCategory": category},
            "reference": "rest_of_table",
        }
        label = f"{attribute_label}={level} × {target_label}={category}"
        exploration_effect = _as_float(direction.get("max_residual"))
    else:
        denominator = direction.get("lowest_group")
        numerator = direction.get("highest_group")
        if numerator is None or denominator is None or str(numerator) == str(denominator):
            return None
        numerator, denominator = str(numerator), str(denominator)
        rule = {
            "kind": "classic_numeric",
            "attribute": {"column": attribute, "conditionLevel": numerator,
                          "referenceLevel": denominator},
            "question": {"column": target, "scaleType": scale_type},
        }
        estimand = {
            "type": ESTIMAND_MEAN_DIFFERENCE,
            "numerator": numerator,
            "denominator": denominator,
            "unit": "question_value",
        }
        label = f"{attribute_label}:{numerator} vs {denominator} × {target_label}"
        exploration_effect = _as_float(direction.get("delta"))
    return PinnedCandidate(candidateId=candidate_id, algorithm=ALGORITHM_CLASSIC,
                           rule=rule, estimand=estimand, displayLabel=label,
                           explorationEffect=exploration_effect)


def modern_candidate(item: dict[str, Any]) -> PinnedCandidate | None:
    """Build a pinned candidate from a modern (conditional-rule) insight."""
    candidate_id = str(item.get("id") or "")
    rule_in = item.get("rule") if isinstance(item.get("rule"), dict) else {}
    target_question = item.get("target_question")
    if not candidate_id or not target_question:
        return None
    conditions = [normalize_condition(c) for c in (rule_in.get("conditions") or [])]
    conditions.sort(key=condition_sort_key)
    target_pair = item.get("target_pair")
    target_pair = [str(v) for v in target_pair] if isinstance(target_pair, (list, tuple)) else None
    pair_mode = bool(target_pair) and bool(item.get("emm_stats"))
    rule = {
        "kind": "modern",
        "conditions": conditions,
        "targetQuestion": str(target_question),
        "targetPair": target_pair,
        "ruleText": str(rule_in.get("text") or ""),
    }
    if pair_mode:
        estimand = {
            "type": ESTIMAND_TAU_DIFFERENCE,
            "numerator": "rule_matched_rows",
            "denominator": "complement_within_scope",
            "pair": target_pair,
        }
    else:
        estimand = {
            "type": ESTIMAND_MEAN_DIFFERENCE,
            "numerator": "rule_matched_rows",
            "denominator": "complement_within_scope",
            "unit": "target_question",
        }
    label = f"{rule['ruleText'] or '条件'} → {target_question}"
    target_stats = item.get("target_stats") if isinstance(item.get("target_stats"), dict) else {}
    exploration_effect = _as_float((target_stats or {}).get("delta_mean"))
    return PinnedCandidate(candidateId=candidate_id, algorithm=ALGORITHM_MODERN,
                           rule=rule, estimand=estimand, displayLabel=label,
                           explorationEffect=exploration_effect)


def compute_candidate_set_hash(
    candidate_set: PinnedCandidateSet | dict[str, Any],
) -> str:
    """Deterministic hash of the whole pinned candidate set and its context."""
    if isinstance(candidate_set, PinnedCandidateSet):
        payload = candidate_set.model_dump()
    else:
        payload = dict(candidate_set)
    payload.pop("candidateSetHash", None)
    candidates = []
    for candidate in payload.get("candidates") or []:
        if not isinstance(candidate, dict):
            candidate = dict(candidate)
        candidate = dict(candidate)
        candidate.pop("displayLabel", None)
        candidate.pop("explorationEffect", None)
        candidates.append(candidate)
    payload["candidates"] = sorted(candidates, key=lambda c: str(c.get("candidateId")))
    payload["parameters"] = payload.get("parameters") or {}
    return HASH_PREFIX + hashlib.sha256(canonical_dumps(payload).encode("utf-8")).hexdigest()


def build_candidate_set(
    dataset_id: str,
    data_revision: int,
    schema_revision: int,
    scope_hash: str,
    algorithm: str,
    parameters: dict[str, Any],
    candidates: list[PinnedCandidate],
) -> PinnedCandidateSet:
    candidate_set = PinnedCandidateSet(
        datasetId=dataset_id,
        dataRevision=int(data_revision),
        schemaRevision=int(schema_revision),
        scopeHash=scope_hash,
        algorithm=algorithm,
        parameters=dict(parameters or {}),
        candidates=candidates,
    )
    candidate_set.candidateSetHash = compute_candidate_set_hash(candidate_set)
    return candidate_set
