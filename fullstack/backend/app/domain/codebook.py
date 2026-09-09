from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


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
    multiResponseOptionLabel: str = ""


class MultiResponseGroup(BaseModel):
    groupId: str = Field(min_length=1)
    label: str
    selectedCodes: list[str] = Field(default_factory=lambda: ["1"])
    unselectedCodes: list[str] = Field(default_factory=lambda: ["0"])
    allUnselectedMeaning: Literal["valid", "missing", "notApplicable"] = "valid"
    maxSelections: int | None = Field(default=None, gt=0, strict=True)
    optionOrder: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_codes(self) -> "MultiResponseGroup":
        if len(self.selectedCodes) == 0:
            raise ValueError("selectedCodes must not be empty")
        if len(self.unselectedCodes) == 0:
            raise ValueError("unselectedCodes must not be empty")
        if len(set(self.selectedCodes)) != len(self.selectedCodes):
            raise ValueError("selectedCodes must not contain duplicates")
        if len(set(self.unselectedCodes)) != len(self.unselectedCodes):
            raise ValueError("unselectedCodes must not contain duplicates")
        overlap = set(self.selectedCodes) & set(self.unselectedCodes)
        if overlap:
            raise ValueError("selectedCodes and unselectedCodes must not overlap")
        return self


class Codebook(BaseModel):
    datasetId: str
    schemaRevision: int = 1
    columns: list[CodebookColumn] = Field(default_factory=list)
    multiResponseGroups: list[MultiResponseGroup] = Field(default_factory=list)


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
    multiResponseOptionLabel: str | None = None


class CodebookUpdateRequest(BaseModel):
    columns: list[CodebookColumnPatch] = Field(default_factory=list)
    multiResponseGroups: list[MultiResponseGroup] | None = None
    expectedSchemaRevision: int | None = Field(default=None, gt=0)
