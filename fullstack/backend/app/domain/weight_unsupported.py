"""Shared WEIGHT_UNSUPPORTED contract for first-stage non-weighted analyses (Feature 21).

Non-weighted pages accept ``weightColumn`` only to report that the survey
weight is not applied. They never return weighted values.
"""
from __future__ import annotations

from typing import Any

from .survey_weight import WEIGHT_UNSUPPORTED_MESSAGE, resolve_weight_column


def weight_unsupported_block(
    codebook: dict[str, Any] | None, weight_column: str | None
) -> dict[str, Any]:
    """Validate ``weightColumn`` reference and return the unsupported block.

    Raises 422 for unknown columns / wrong role so typos never look applied.
    """
    spec = resolve_weight_column(codebook, weight_column)
    return {
        "weightStatus": "unsupported" if weight_column is not None else "omitted",
        "weightApplied": False,
        "weightColumn": spec["name"] if spec is not None else None,
        "weightColumnId": spec["columnId"] if spec is not None else None,
        "warnings": ([{"code": "WEIGHT_UNSUPPORTED", "message": WEIGHT_UNSUPPORTED_MESSAGE}]
                      if weight_column is not None else []),
    }
