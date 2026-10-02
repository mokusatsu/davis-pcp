"""Dataset domain models."""
from __future__ import annotations

import time
import uuid
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


class ColumnRole(str, Enum):
    NUMERIC_AXIS = "numeric_axis"
    CATEGORICAL_AXIS = "categorical_axis"
    ROW_ID = "row_id"
    LABEL = "label"
    IGNORED = "ignored"
    QUESTION = "question"
    ATTRIBUTE = "attribute"


class ColumnSchema(BaseModel):
    columnId: str
    name: str
    physicalType: Literal["float", "int", "string", "boolean", "date", "unknown"] = "unknown"
    semanticType: Literal["numeric", "categorical", "identifier", "label", "ignored"] = "numeric"
    role: ColumnRole = ColumnRole.NUMERIC_AXIS
    missingCount: int = 0
    uniqueCount: int = 0
    min: int | float | None = None
    max: int | float | None = None
    categories: list[str] | None = None
    categoryOrder: Literal["imported", "alphabetical", "frequency", "manual", "class"] = "imported"
    manualCategories: list[str] | None = None
    constant: bool = False
    uniqueIdCandidate: bool = False


class ImportOptions(BaseModel):
    encoding: str = "utf-8"
    delimiter: str | None = None
    quote: str | None = None
    hasHeader: bool = True
    decimalSeparator: str = "."
    missingTokens: list[str] = Field(default_factory=lambda: ["", "NA", "N/A", "null", "NULL", "?", "."])
    rowIdColumn: str | None = None


class DatasetMeta(BaseModel):
    datasetId: str
    name: str
    fingerprint: str
    format: str
    rowCount: int
    columnCount: int
    schema_: list[ColumnSchema] = Field(alias="schema")
    rowIdentity: str
    createdAt: str
    importOptions: ImportOptions

    model_config = {"populate_by_name": True}


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def generate_initial_codebook(dataset_id: str, schemas: list[Any]) -> dict[str, Any]:
    import re
    from ..domain.codebook import Codebook, CodebookColumn, RoleType, ScaleType

    columns: list[CodebookColumn] = []
    for s in schemas:
        s_dict = s.model_dump() if hasattr(s, "model_dump") else (s if isinstance(s, dict) else {})
        name = s_dict.get("name", "")
        if name == "__rowId__":
            continue
        col_id = s_dict.get("columnId") or new_id("col")
        semantic = s_dict.get("semanticType", "numeric")
        role_val = s_dict.get("role", "")
        if hasattr(role_val, "value"):
            role_val = role_val.value
        cats = s_dict.get("categories") or []

        # Scale type inference
        if role_val == "row_id" or semantic == "identifier" or name.lower() == "id":
            scale = ScaleType.ID
        elif semantic == "categorical":
            scale = ScaleType.NOMINAL
        elif semantic == "numeric":
            scale = ScaleType.RATIO
        elif semantic == "label":
            scale = ScaleType.TEXT
        else:
            scale = ScaleType.NOMINAL

        # Role inference
        if scale == ScaleType.ID or role_val == "row_id":
            role = RoleType.ID
        elif re.match(r"^(?:q|sq|item|v)\d+", name, re.IGNORECASE):
            role = RoleType.QUESTION
        else:
            role = RoleType.ATTRIBUTE

        # Inferred categories are display hints, never a user-declared allowed
        # domain. Probe samples may omit late or high-cardinality values. Only
        # explicit codebook edits may populate the authoritative categoryOrder.
        val_labels = {str(c): str(c) for c in cats} if cats else {}
        cat_order: list[str] = []

        col = CodebookColumn(
            columnId=col_id,
            name=name,
            label=name,
            scaleType=scale,
            role=role,
            valueLabels=val_labels,
            categoryOrder=cat_order,
            missingCodes=[],
            missingReasons={},
            isReversed=False,
            multiResponseGroup=None,
        )
        columns.append(col)

    cb = Codebook(datasetId=dataset_id, schemaRevision=1, columns=columns)
    return cb.model_dump(mode="json")
