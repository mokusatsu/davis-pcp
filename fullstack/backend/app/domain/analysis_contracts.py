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


class MCARequest(StrictModel):
    context: AnalysisContextV2
    variables: list[Id] = Field(min_length=2)
    maMode: Literal["ordinary_only", "explicit_binary_options"] = "ordinary_only"
    inertiaAdjustment: Literal["raw", "benzecri"] = "raw"

    @model_validator(mode="after")
    def check_variables(self):
        if len(set(self.variables)) != len(self.variables):
            raise ValueError("variables must not contain duplicates")
        return self


class FAMDRequest(StrictModel):
    context: AnalysisContextV2
    numericVariables: list[Id] = Field(min_length=1)
    categoricalVariables: list[Id] = Field(min_length=1)

    @model_validator(mode="after")
    def check_variables(self):
        if len(set(self.numericVariables)) != len(self.numericVariables):
            raise ValueError("numericVariables must not contain duplicates")
        if len(set(self.categoricalVariables)) != len(self.categoricalVariables):
            raise ValueError("categoricalVariables must not contain duplicates")
        if set(self.numericVariables) & set(self.categoricalVariables):
            raise ValueError("FAMD variables must not overlap")
        return self


class NumericPredictor(StrictModel):
    columnId: Id
    kind: Literal["numeric"]
    ordinalAsNumericAcknowledged: bool = False
    score: Literal["ordered_rank"] | None = None

    @model_validator(mode="after")
    def check_ack(self):
        if self.ordinalAsNumericAcknowledged != (self.score == "ordered_rank"):
            raise ValueError("ordered_rank and ordinal acknowledgement must be supplied together")
        return self


class CategoricalPredictor(StrictModel):
    columnId: Id
    kind: Literal["categorical"]
    referenceCategory: str | None = None


class LinearRegressionRequest(StrictModel):
    context: AnalysisContextV2
    target: Id
    predictors: list[Annotated[Union[NumericPredictor, CategoricalPredictor], Field(discriminator="kind")]] = Field(min_length=1)
    interactions: list[list[Id]] = Field(default_factory=list)
    intercept: bool = True
    covariance: Literal["auto", "hc3", "classical", "taylor"] = "auto"
    confidenceLevel: Annotated[float, Field(gt=0, lt=1)] = 0.95

    @model_validator(mode="after")
    def check_design(self):
        ids = [p.columnId for p in self.predictors]
        if len(set(ids)) != len(ids):
            raise ValueError("predictors must not contain duplicates")
        if self.target in ids:
            raise ValueError("target must not be a predictor")
        seen: set[tuple[str, str]] = set()
        for pair in self.interactions:
            if len(pair) != 2 or pair[0] == pair[1] or any(p not in ids for p in pair):
                raise ValueError("interaction requires two distinct selected main effects")
            key = tuple(sorted(pair))
            if key in seen:
                raise ValueError("duplicate interaction")
            seen.add(key)
        return self


class DiagnosticRectangleSelector(StrictModel):
    kind: Literal["diagnostic_rectangle"]
    xField: Literal["fitted", "residual", "leverage"]
    yField: Literal["fitted", "residual", "leverage"]
    xBounds: list[Finite]
    yBounds: list[Finite]

    @model_validator(mode="after")
    def check_bounds(self):
        for b in (self.xBounds, self.yBounds):
            if len(b) != 2 or b[0] > b[1]:
                raise ValueError("bounds require lower <= upper")
        return self


class CategorySelector(StrictModel):
    kind: Literal["categories"]
    categoryIds: list[Id] = Field(min_length=1)
    betweenVariables: Literal["and", "or"] = "and"


class RowIdSelector(StrictModel):
    kind: Literal["row_ids"]
    rowIds: list[Id]


class RectangleSelector(StrictModel):
    kind: Literal["rectangle"]
    axes: list[PositiveInt] = Field(min_length=1, max_length=2)
    bounds: list[list[Finite]] = Field(min_length=1, max_length=2)

    @model_validator(mode="after")
    def check_axes(self):
        if len(self.axes) != len(self.bounds) or len(set(self.axes)) != len(self.axes):
            raise ValueError("each distinct axis needs one bound")
        if any(len(b) != 2 or b[0] > b[1] for b in self.bounds):
            raise ValueError("bounds require lower <= upper")
        return self


class SelectRequest(StrictModel):
    context: AnalysisContextV2
    selector: Annotated[Union[CategorySelector, RowIdSelector, RectangleSelector,
                              DiagnosticRectangleSelector],
                        Field(discriminator="kind")]


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


class PredictionOptions(StrictModel):
    interval: Literal["none", "mean_ci", "individual_pi"] = "none"
    evaluate: bool = True


class PredictRequest(StrictModel):
    context: AnalysisContextV2
    options: PredictionOptions = Field(default_factory=PredictionOptions)

    @model_validator(mode="after")
    def check_options(self):
        interval = (self.options.interval if isinstance(self.options, PredictionOptions)
                    else (self.options or {}).get("interval", "none"))
        if interval not in ("none", "mean_ci", "individual_pi"):
            raise ValueError("analysis predict supports none/mean_ci/individual_pi only")
        return self
