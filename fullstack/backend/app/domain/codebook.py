from __future__ import annotations

from enum import Enum
from typing import Any
from pydantic import BaseModel, Field


class ScaleType(str, Enum):
    NOMINAL = "nominal"
    ORDINAL = "ordinal"
    INTERVAL = "interval"
    RATIO = "ratio"
    TEXT = "text"
    ID = "id"


class RoleType(str, Enum):
    QUESTION = "question"
    ATTRIBUTE = "attribute"
    WEIGHT = "weight"
    ID = "id"
    OTHER = "other"


class CodebookColumn(BaseModel):
    columnId: str
    name: str
    label: str = ""
    scaleType: ScaleType = ScaleType.NOMINAL
    role: RoleType = RoleType.ATTRIBUTE
    valueLabels: dict[str, str] = Field(default_factory=dict)
    categoryOrder: list[str] = Field(default_factory=list)
    missingCodes: list[str] = Field(default_factory=list)
    missingReasons: dict[str, str] = Field(default_factory=dict)
    isReversed: bool = False
    multiResponseGroup: str | None = None


class Codebook(BaseModel):
    datasetId: str
    schemaRevision: int = 1
    columns: list[CodebookColumn] = Field(default_factory=list)


class CodebookColumnPatch(BaseModel):
    columnId: str | None = None
    name: str | None = None
    label: str | None = None
    scaleType: ScaleType | None = None
    role: RoleType | None = None
    valueLabels: dict[str, str] | None = None
    categoryOrder: list[str] | None = None
    missingCodes: list[str] | None = None
    missingReasons: dict[str, str] | None = None
    isReversed: bool | None = None
    multiResponseGroup: str | None = None


class CodebookUpdateRequest(BaseModel):
    columns: list[CodebookColumnPatch]
