"""Feature 029-034 V2 input contracts (production).

Mirrors the design-artifact ``contracts/analysis_requests.py`` for the CA slice
(plus select/export/predict/materialize envelopes used by the common result API).
Syntax validation lives here (Pydantic strict, extra=forbid, finite JSON);
data-dependent checks belong in domain/analysis_frame.py and kernels.
"""
from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Id = Annotated[str, StringConstraints(min_length=1)]
PositiveInt = Annotated[int, Field(ge=1)]
Finite = Annotated[float, Field(allow_inf_nan=False)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False, validate_default=True)


class AnalysisContextV2(StrictModel):
    datasetId: Id
    expectedDataRevision: PositiveInt
    expectedSchemaRevision: PositiveInt
    scope: Literal["all", "active", "selected", "sampled", "explicit"] = "all"
    rowIds: list[Id] | None = None
    activeRowIds: list[Id] | None = None
    selectedRowIds: list[Id] | None = None
    sampledRowIds: list[Id] | None = None
    weightMode: Literal["dataset", "none", "column"] = "dataset"
    weightColumn: Id | None = None
    weightType: Literal["survey", "frequency"] | None = None
    missingPolicy: Literal["exclude", "include_missing", "separate_not_applicable"] = "exclude"
    imputationPolicy: Literal["use_current_values"] = "use_current_values"
    candidateSetHash: str | None = None

    @model_validator(mode="after")
    def check_context(self) -> "AnalysisContextV2":
        required = {"active": "activeRowIds", "selected": "selectedRowIds",
                    "sampled": "sampledRowIds", "explicit": "rowIds"}.get(self.scope)
        for name in ("rowIds", "activeRowIds", "selectedRowIds", "sampledRowIds"):
            value = getattr(self, name)
            if name == required and value is None:
                raise ValueError(f"scope={self.scope} requires {name}; [] means empty")
            if name != required and value is not None:
                raise ValueError(f"{name} is not allowed for scope={self.scope}")
        if self.weightMode == "column":
            if self.weightColumn is None:
                raise ValueError("weightMode=column requires weightColumn")
        elif self.weightColumn is not None or self.weightType is not None:
            raise ValueError("weightColumn/weightType are only allowed with weightMode=column")
        return self


class RespondentCAInput(StrictModel):
    kind: Literal["respondents"]
    rowVariable: Id
    columnVariable: Id

    @model_validator(mode="after")
    def check_distinct(self):
        if self.rowVariable == self.columnVariable:
            raise ValueError("rowVariable and columnVariable must differ")
        return self


class ContingencyCAInput(StrictModel):
    kind: Literal["contingency"]
    rowLabelColumn: Id
    valueColumns: list[Id] = Field(min_length=2)
    cellSemantics: Literal["frequency", "mass"]
    independentCountsAcknowledged: bool = False
    structuralZerosDeclared: bool = False

    @model_validator(mode="after")
    def check_table(self):
        if len(set(self.valueColumns)) != len(self.valueColumns):
            raise ValueError("valueColumns must not contain duplicates")
        if self.rowLabelColumn in self.valueColumns:
            raise ValueError("row label must not also be a count column")
        if self.independentCountsAcknowledged != (self.cellSemantics == "frequency"):
            raise ValueError("frequency requires independent-count acknowledgement; mass must not claim it")
        return self


class CARequest(StrictModel):
    context: AnalysisContextV2
    input: Annotated[Union[RespondentCAInput, ContingencyCAInput], Field(discriminator="kind")]
    mapScaling: Literal["symmetric", "row_principal", "column_principal"] = "symmetric"

    @model_validator(mode="after")
    def check_missing(self):
        if self.input.kind == "contingency" and self.context.missingPolicy != "exclude":
            raise ValueError("contingency input only supports missingPolicy=exclude")
        return self


class CategorySelector(StrictModel):
    kind: Literal["categories"]
    categoryIds: list[Id] = Field(min_length=1)
    betweenVariables: Literal["and", "or"] = "and"


class RowIdSelector(StrictModel):
    kind: Literal["row_ids"]
    rowIds: list[Id]


class SelectRequest(StrictModel):
    context: AnalysisContextV2
    selector: Annotated[Union[CategorySelector, RowIdSelector], Field(discriminator="kind")]


class ExportRequest(StrictModel):
    format: Literal["json", "csv"]
    table: Literal["manifest", "eigenvalues", "categories", "variables", "coefficients",
                   "diagnostics", "rows", "utilities", "table", "members"]
    offset: Annotated[int, Field(ge=0)] = 0
    limit: Annotated[int, Field(ge=1, le=10000)] = 5000

    @model_validator(mode="after")
    def check_manifest(self):
        if self.table == "manifest" and (self.format != "json" or self.offset != 0):
            raise ValueError("manifest export is JSON at offset=0")
        return self


class MaterializeRequest(StrictModel):
    context: AnalysisContextV2
    source: Id = "fit"
    columns: list[dict] = Field(min_length=1)
    idempotencyKey: Id


class PredictRequest(StrictModel):
    context: AnalysisContextV2
    options: dict = Field(default_factory=dict)
