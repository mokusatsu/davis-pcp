"""Data provenance and imputation-mask models (Feature 25).

The operation log is append-only: undo/redo/revert add new entries and move
a cursor, never delete or rewrite history. Snapshots live beside the dataset
files; only the lightweight step summaries travel over the API.
"""
from __future__ import annotations

import hashlib
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

OPERATIONS = (
    "import",
    "transform",
    "impute",
    "calculate",
    "delete_column",
    "schema_update",
    "view_filter",
    "materialize_filter",
    "revert",
    "undo",
    "redo",
)

OperationName = Literal[
    "import",
    "transform",
    "impute",
    "calculate",
    "delete_column",
    "schema_update",
    "view_filter",
    "materialize_filter",
    "revert",
    "undo",
    "redo",
]


def new_operation_id() -> str:
    return f"op-{uuid.uuid4().hex[:12]}"


class TargetCell(BaseModel):
    rowId: str
    columnId: str


class ProvenanceStep(BaseModel):
    operationId: str
    parentOperationId: str | None = None
    operation: str
    params: dict[str, Any] = Field(default_factory=dict)
    targetRowIds: list[str] = Field(default_factory=list)
    targetCells: list[TargetCell] = Field(default_factory=list)
    inputDataRevision: int
    outputDataRevision: int
    inputSchemaRevision: int
    outputSchemaRevision: int
    algorithmVersion: str = ""
    timestamp: str
    createdBy: str = "local-session"


class MaskEntry(BaseModel):
    rowId: str
    columnId: str
    methodId: str
    methodLabel: str
    originalMissingReason: str = "user_missing"
    createdByOperationId: str
    inputDataRevision: int
    maskRevision: int


def fingerprint_payload(payload: Any) -> str:
    import json

    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
