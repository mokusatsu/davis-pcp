"""weightMode resolution shared by summary/crosstab/MA (FIX_SPEC §4.1).

``dataset`` (default) uses the saved weightConfig; only explicit ``none``
disables it. Legacy omitted/null requests migrate to ``dataset``.
``column`` mode names a column (+ type) explicitly without changing the saved
configuration.
"""
from __future__ import annotations

from typing import Any

from .errors import BizError
from .survey_weight import declared_weight_column_id, find_weight_spec


def resolve_weight_request(
    codebook: dict[str, Any] | None,
    *,
    weight_mode: str | None = None,
    weight_column: str | None = None,
    weight_type: str | None = None,
) -> tuple[str, str | None]:
    if weight_mode is None:
        if weight_column is not None:
            weight_mode = "column"
        else:
            weight_mode = "dataset"
    if weight_mode not in ("dataset", "none", "column"):
        raise BizError("WEIGHT_MODE_INVALID", "weightMode は dataset/none/column のいずれかです。",
                       status_code=422)
    if weight_mode == "none":
        return "none", None
    if weight_mode == "dataset":
        if weight_type is not None:
            raise BizError("WEIGHT_MODE_INVALID",
                           "weightMode=dataset では weightType を指定できません。",
                           status_code=422)
        if weight_column is not None:
            return "column", weight_column
        return "dataset", declared_weight_column_id(codebook)
    # column mode: explicit column (+ optional type override for the request).
    if not weight_column:
        raise BizError("WEIGHT_COLUMN_REQUIRED", "weightMode=column では weightColumn は必須です。",
                       status_code=422)
    if weight_type is not None:
        if weight_type not in ("survey", "frequency"):
            raise BizError("WEIGHT_TYPE_INVALID", "weightType は survey/frequency のいずれかです。",
                           status_code=422)
        spec = find_weight_spec(codebook, weight_column)
        if spec is None:
            raise BizError("WEIGHT_COLUMN_NOT_FOUND", "ウェイト列が存在しません。",
                           status_code=422)
    return "column", weight_column
