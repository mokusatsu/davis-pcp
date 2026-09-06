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


class ColumnSchema(BaseModel):
    columnId: str
    name: str
    physicalType: Literal["float", "int", "string", "boolean", "date", "unknown"] = "unknown"
    semanticType: Literal["numeric", "categorical", "identifier", "label", "ignored"] = "numeric"
    role: ColumnRole = ColumnRole.NUMERIC_AXIS
    missingCount: int = 0
    uniqueCount: int = 0
    min: float | None = None
    max: float | None = None
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
