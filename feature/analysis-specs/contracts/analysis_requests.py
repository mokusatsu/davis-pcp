"""DAVIS-PCP Features 029--034 request contracts (design artifact).

This module is independently executable. It does not register production routes.
Data-dependent checks (roles, revisions, weight declarations, rank, etc.) belong
in the specified service/domain layer, not in JSON Schema alone.
"""
from __future__ import annotations
from pathlib import Path
import json
from typing import Annotated, Literal, Union
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Id = Annotated[str, StringConstraints(min_length=1)]
PositiveInt = Annotated[int, Field(ge=1)]
Probability = Annotated[float, Field(gt=0, lt=1)]
Finite = Annotated[float, Field(allow_inf_nan=False)]

def unique(values: list[str], name: str) -> None:
    if len(set(values)) != len(values):
        raise ValueError(f"{name} must not contain duplicates")

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
    def check_context(self) -> AnalysisContextV2:
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
        unique(self.valueColumns, "valueColumns")
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
        unique(self.variables, "variables")
        return self

class FAMDRequest(StrictModel):
    context: AnalysisContextV2
    numericVariables: list[Id] = Field(min_length=1)
    categoricalVariables: list[Id] = Field(min_length=1)

    @model_validator(mode="after")
    def check_variables(self):
        unique(self.numericVariables + self.categoricalVariables, "FAMD variables")
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

Predictor = Annotated[Union[NumericPredictor, CategoricalPredictor], Field(discriminator="kind")]

class LinearRegressionRequest(StrictModel):
    context: AnalysisContextV2
    target: Id
    predictors: list[Predictor] = Field(min_length=1)
    interactions: list[list[Id]] = Field(default_factory=list)
    intercept: bool = True
    covariance: Literal["auto", "hc3", "classical", "taylor"] = "auto"
    confidenceLevel: Probability = 0.95

    @model_validator(mode="after")
    def check_design(self):
        ids = [p.columnId for p in self.predictors]
        unique(ids, "predictors")
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

class FactorVariable(StrictModel):
    columnId: Id
    ordinalAsNumericAcknowledged: bool = False
    score: Literal["ordered_rank"] | None = None

    @model_validator(mode="after")
    def check_ack(self):
        if self.ordinalAsNumericAcknowledged != (self.score == "ordered_rank"):
            raise ValueError("ordered_rank and ordinal acknowledgement must be supplied together")
        return self

class FactorAnalysisRequest(StrictModel):
    context: AnalysisContextV2
    variables: list[FactorVariable] = Field(min_length=3)
    nFactors: PositiveInt
    method: Literal["ml"] = "ml"
    rotation: Literal["none", "varimax", "promax"] = "varimax"
    scoreMethod: Literal["regression", "bartlett"] = "regression"
    uniquenessLower: Annotated[float, Field(ge=1e-6, le=0.1)] = 0.005
    nStarts: Annotated[int, Field(ge=1, le=20)] = 5
    maxIterations: Annotated[int, Field(ge=100, le=20000)] = 2000
    seed: Annotated[int, Field(ge=0, le=4294967295)] = 42

    @model_validator(mode="after")
    def check_model(self):
        ids = [v.columnId for v in self.variables]
        unique(ids, "variables")
        p, q = len(ids), self.nFactors
        if q >= p or ((p-q)**2-p-q) < 0:
            raise ValueError("requested factor model is underidentified")
        if self.context.missingPolicy != "exclude":
            raise ValueError("ML factor analysis requires missingPolicy=exclude")
        return self

class ConjointColumns(StrictModel):
    respondentId: Id
    taskId: Id
    alternativeId: Id
    response: Id
    availability: Id | None = None
    optOutIndicator: Id | None = None

    @model_validator(mode="after")
    def check_ids(self):
        unique([v for v in self.model_dump().values() if v is not None], "conjoint mappings")
        return self

class ConjointExpandScopeRequest(StrictModel):
    context: AnalysisContextV2
    columns: ConjointColumns

class CategoricalAttribute(StrictModel):
    columnId: Id
    kind: Literal["categorical"]
    referenceLevel: str | None = None

class LinearAttribute(StrictModel):
    columnId: Id
    kind: Literal["linear"]
    utilityRange: list[Finite] | None = None

    @model_validator(mode="after")
    def check_range(self):
        if self.utilityRange is not None:
            if len(self.utilityRange) != 2 or self.utilityRange[0] >= self.utilityRange[1]:
                raise ValueError("utilityRange requires finite lower < upper")
        return self

Attribute = Annotated[Union[CategoricalAttribute, LinearAttribute], Field(discriminator="kind")]

class ConjointRequest(StrictModel):
    context: AnalysisContextV2
    mode: Literal["ratings", "choice", "ranking"]
    columns: ConjointColumns
    attributes: list[Attribute] = Field(min_length=1)
    ratingEffects: Literal["pooled", "respondent_fixed"] = "pooled"
    priceAttribute: Id | None = None
    confidenceLevel: Probability = 0.95
    maxIterations: Annotated[int, Field(ge=100, le=20000)] = 1000

    @model_validator(mode="after")
    def check_model(self):
        ids = [a.columnId for a in self.attributes]
        unique(ids, "attributes")
        mapped = {v for v in self.columns.model_dump().values() if v is not None}
        if mapped.intersection(ids):
            raise ValueError("attribute columns must not overlap mapping columns")
        if self.context.missingPolicy != "exclude":
            raise ValueError("conjoint only supports missingPolicy=exclude")
        if self.mode != "ratings" and self.ratingEffects != "pooled":
            raise ValueError("ratingEffects is only configurable for ratings")
        if self.mode == "ratings" and self.columns.optOutIndicator is not None:
            raise ValueError("opt-out is not supported for ratings")
        if self.priceAttribute is not None and not any(
                a.columnId == self.priceAttribute and a.kind == "linear" for a in self.attributes):
            raise ValueError("priceAttribute must identify a linear attribute")
        return self

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

class CategorySelector(StrictModel):
    kind: Literal["categories"]
    categoryIds: list[Id] = Field(min_length=1)
    betweenVariables: Literal["and", "or"] = "and"

class RowSelector(StrictModel):
    kind: Literal["row_ids"]
    rowIds: list[Id]

class RespondentSelector(StrictModel):
    kind: Literal["respondents"]
    respondentIds: list[Id]

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

Selector = Annotated[Union[RectangleSelector, CategorySelector, RowSelector,
                          RespondentSelector, DiagnosticRectangleSelector], Field(discriminator="kind")]

class SelectRequest(StrictModel):
    context: AnalysisContextV2
    selector: Selector

class PredictionOptions(StrictModel):
    interval: Literal["none", "mean_ci", "individual_pi"] = "none"
    evaluate: bool = True

class PredictRequest(StrictModel):
    context: AnalysisContextV2
    options: PredictionOptions = Field(default_factory=PredictionOptions)

class MaterializedColumn(StrictModel):
    sourceField: Id
    name: Id
    label: str = ""

class MaterializeRequest(StrictModel):
    context: AnalysisContextV2
    source: Id = "fit"
    columns: list[MaterializedColumn] = Field(min_length=1)
    idempotencyKey: Id

    @model_validator(mode="after")
    def check_columns(self):
        unique([c.name for c in self.columns], "new names")
        unique([c.sourceField for c in self.columns], "source fields")
        return self

class ExportRequest(StrictModel):
    format: Literal["json", "csv"]
    table: Literal["manifest", "eigenvalues", "categories", "variables", "coefficients", "diagnostics", "rows", "utilities"]
    offset: Annotated[int, Field(ge=0)] = 0
    limit: Annotated[int, Field(ge=1, le=10000)] = 5000

    @model_validator(mode="after")
    def check_manifest(self):
        if self.table == "manifest" and (self.format != "json" or self.offset != 0):
            raise ValueError("manifest export is JSON at offset=0")
        return self

class SimulationProfile(StrictModel):
    alternativeId: Id
    values: dict[Id, str | Finite]
    optOut: bool = False

class SimulateRequest(StrictModel):
    context: AnalysisContextV2
    profiles: list[SimulationProfile] = Field(min_length=1)
    includeWtp: bool = False

    @model_validator(mode="after")
    def check_profiles(self):
        unique([p.alternativeId for p in self.profiles], "simulation profile IDs")
        if self.context.scope != "all" or self.context.weightMode != "none":
            raise ValueError("simulation uses context only for revision identity: all/none required")
        for p in self.profiles:
            if p.optOut and p.values:
                raise ValueError("opt-out simulation profile must use values={}")
        return self

REQUEST_MODELS = {
    "ca": CARequest, "mca": MCARequest, "famd": FAMDRequest,
    "linear_regression": LinearRegressionRequest, "factor_analysis": FactorAnalysisRequest,
    "conjoint": ConjointRequest, "conjoint_expand_scope": ConjointExpandScopeRequest, "select": SelectRequest, "predict": PredictRequest,
    "materialize": MaterializeRequest, "export": ExportRequest, "simulate": SimulateRequest,
}

def generate_schemas(directory: Path | None = None) -> None:
    directory = directory or Path(__file__).parent / "schemas"
    directory.mkdir(parents=True, exist_ok=True)
    for name, model in REQUEST_MODELS.items():
        (directory / f"{name}.schema.json").write_text(
            json.dumps(model.model_json_schema(), ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            encoding="utf-8",
        )

if __name__ == "__main__":
    generate_schemas()
