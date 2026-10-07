from __future__ import annotations

from enum import Enum
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


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


class BinDefinition(BaseModel):
    """An integer category's exact interval, independent of its display label."""

    model_config = ConfigDict(extra="forbid")

    binId: int = Field(gt=0, strict=True)
    min: float = Field(allow_inf_nan=False)
    max: float = Field(allow_inf_nan=False)
    lowerInclusive: bool = Field(strict=True)
    upperInclusive: bool = Field(strict=True)


def _validate_bin_definitions(bins: list[BinDefinition]) -> list[BinDefinition]:
    for index, definition in enumerate(bins):
        if definition.binId != index + 1:
            raise ValueError("binDefinitions must have consecutive ordered integer IDs starting at 1")
        if definition.min >= definition.max:
            raise ValueError("binDefinitions must have increasing finite bounds")
        if index and bins[index - 1].max != definition.min:
            raise ValueError("binDefinitions must have contiguous ordered bounds")
        if not definition.lowerInclusive or definition.upperInclusive != (index == len(bins) - 1):
            raise ValueError("binDefinitions include each lower bound and only the final upper bound")
    return bins


BinDefinitions = Annotated[list[BinDefinition], AfterValidator(_validate_bin_definitions)]


class CodebookColumn(BaseModel):
    columnId: str
    name: str
    label: str = ""
    scaleType: ScaleType = ScaleType.NOMINAL
    role: RoleType = RoleType.ATTRIBUTE
    valueLabels: dict[str, str] = Field(default_factory=dict)
    categoryOrder: list[str] = Field(default_factory=list)
    binDefinitions: BinDefinitions = Field(default_factory=list)
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


class WeightType(str, Enum):
    """What a weight column means (WEIGHT-04/B04).

    ``survey``   one row is one respondent; the weight corrects representativeness,
                 so its overall scale is arbitrary and must not reach a test statistic.
    ``frequency`` one row stands for that many identical observations, so the raw
                 weighted counts *are* counts and an ordinary Pearson test applies.
    """

    SURVEY = "survey"
    FREQUENCY = "frequency"


class WeightConfig(BaseModel):
    """Which weight column the dataset analyses use, and what it means."""

    weightColumnId: str
    weightType: WeightType


class SurveyDesignSpec(BaseModel):
    """Sampling design behind the final weight. All fields but the weight are optional."""

    weightColumnId: str | None = None
    strataColumnId: str | None = None
    psuColumnId: str | None = None
    fpcColumnId: str | None = None
    replicateWeightColumnIds: list[str] = Field(default_factory=list)


class Codebook(BaseModel):
    datasetId: str
    schemaRevision: int = 1
    # Dataset attribution is independent of the analysis schema and values.
    licenseText: str = Field(default="", strict=True)
    licenseRevision: int = Field(default=1, gt=0, strict=True)
    columns: list[CodebookColumn] = Field(default_factory=list)
    multiResponseGroups: list[MultiResponseGroup] = Field(default_factory=list)
    weightConfig: WeightConfig | None = None
    surveyDesign: SurveyDesignSpec | None = None


class CodebookColumnPatch(BaseModel):
    columnId: str | None = None
    name: str | None = None
    label: str | None = None
    scaleType: ScaleType | None = None
    role: RoleType | None = None
    valueLabels: dict[str, str] | None = None
    categoryOrder: list[str] | None = None
    binDefinitions: BinDefinitions | None = None
    missingCodes: list[str] | None = None
    missingReasons: dict[str, str] | None = None
    isReversed: bool | None = None
    multiResponseGroup: str | None = None
    multiResponseOptionLabel: str | None = None


class CodebookUpdateRequest(BaseModel):
    columns: list[CodebookColumnPatch] = Field(default_factory=list)
    multiResponseGroups: list[MultiResponseGroup] | None = None
    weightConfig: WeightConfig | None = None
    surveyDesign: SurveyDesignSpec | None = None
    expectedSchemaRevision: int | None = Field(default=None, gt=0)
    # An omitted key preserves the current text; an empty string clears it.
    licenseText: str = Field(default="", strict=True)
    expectedLicenseRevision: int | None = Field(default=None, gt=0, strict=True)

    def explicitly_set(self, field: str) -> bool:
        """Whether the caller sent the key; omitted metadata is preserved."""
        return field in self.model_fields_set
