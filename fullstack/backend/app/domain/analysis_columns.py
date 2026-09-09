"""Resolve explicit analysis columns separately from MA validity dependencies."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import polars as pl

from .errors import BizError
from .multi_response import prepare_classifier, resolve_groups, validate_group


@dataclass
class AnalysisColumns:
    names: list[str]
    dependencies: list[str]
    groups: list[dict[str, Any]]

    def prepare(self, frame: pl.DataFrame) -> tuple[pl.DataFrame, dict[str, dict[str, int]]]:
        """Keep valid parent populations; unrequested children never become features."""
        mask = [True] * frame.height
        excluded: dict[str, dict[str, int]] = {}
        replacements: dict[str, list[int]] = {}
        for group in self.groups:
            classify = prepare_classifier(group)
            members = group["columns"]
            selected_members = [c for c in members if c["name"] in self.names]
            values = {c["name"]: [] for c in selected_members}
            counts = {state: 0 for state in ("valid", "missing", "partial", "notApplicable", "invalid")}
            for index, row in enumerate(frame.select([c["name"] for c in members]).iter_rows()):
                status, selected = classify(list(row))
                counts[status] += 1
                mask[index] = mask[index] and status == "valid"
                for column in selected_members:
                    values[column["name"]].append(int(column["columnId"] in selected))
            replacements.update(values)
            excluded[group["groupId"]] = counts
        if replacements:
            frame = frame.with_columns([pl.Series(name, values, dtype=pl.UInt8) for name, values in replacements.items()])
        return frame.filter(pl.Series(mask, dtype=pl.Boolean)).select(["__rowId__", *self.names]), excluded


def resolve_analysis_columns(
    codebook: dict[str, Any],
    requested: list[str] | None,
    *,
    scales: set[str],
    allow_ma_options: bool = False,
    roles: set[str] | None = None,
) -> AnalysisColumns:
    """Omission chooses ordinary eligible columns; [] stays empty; MA requires explicit selection."""
    allowed_roles = roles if roles is not None else {"question", "attribute"}
    columns = codebook.get("columns", [])
    by_id = {c["columnId"]: c for c in columns}
    by_name = {c["name"]: c for c in columns}
    if requested is None:
        selected = [c for c in columns if not c.get("multiResponseGroup") and c.get("role") in allowed_roles and c.get("scaleType") in scales]
    else:
        selected = []
        for identifier in requested:
            column = by_id.get(identifier) or by_name.get(identifier)
            if column is None:
                raise BizError("COLUMN_NOT_FOUND", "分析対象の列が存在しません。", status_code=422)
            if column in selected:
                continue
            if column.get("role") not in allowed_roles:
                raise BizError("MA_METHOD_UNSUPPORTED", "この役割の列は分析対象にできません。", status_code=422)
            if column.get("multiResponseGroup"):
                if not allow_ma_options:
                    raise BizError("MA_METHOD_UNSUPPORTED", "この手法ではMA選択肢を使用できません。", status_code=422)
            elif column.get("scaleType") not in scales:
                raise BizError("MA_METHOD_UNSUPPORTED", "この尺度の列は手法の対象外です。", status_code=422)
            selected.append(column)
    names = [c["name"] for c in selected]
    dependencies = list(names)
    requested_groups = {c["multiResponseGroup"] for c in selected if c.get("multiResponseGroup")}
    groups = []
    if requested_groups:
        try:
            for group in resolve_groups(codebook):
                if group["groupId"] not in requested_groups:
                    continue
                validate_group(group)
                groups.append(group)
                dependencies.extend(c["name"] for c in group["columns"] if c["name"] not in dependencies)
        except ValueError as error:
            raise BizError("MA_DEFINITION_INVALID", str(error), status_code=422) from error
    return AnalysisColumns(names, dependencies, groups)
