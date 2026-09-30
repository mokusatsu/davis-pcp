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


class RespondentSelector(StrictModel):
    kind: Literal["respondents"]
    respondentIds: list[Id]


class SelectRequest(StrictModel):
    context: AnalysisContextV2
    selector: Annotated[Union[CategorySelector, RowIdSelector, RectangleSelector,
                              DiagnosticRectangleSelector, RespondentSelector],
                        Field(discriminator="kind")]


class ExportRequest(StrictModel):
    format: Literal["json", "csv"]
    table: Literal["manifest", "eigenvalues", "categories", "variables", "coefficients",
                   "diagnostics", "rows", "utilities", "table", "members",
                   "parallel_analysis", "factor_comparisons"]
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


Seed = Annotated[int, Field(ge=0, le=4294967295)]
Probability = Annotated[float, Field(gt=0, lt=1)]


class FactorVariable(StrictModel):
    """Feature 033 EFA: one analysed item.

    Mirrors the design artifact ``feature/analysis-specs/contracts/
    factor_extension_requests.py``. Cross-field semantics live in
    ``EFARequest.check_model`` below; data-dependent checks (usable
    categories, fit rows, matrix definiteness) belong in the service layer.
    """

    columnId: Id
    measurement: Literal["ordinal", "continuous"]
    treatment: Literal["ordinal", "continuous", "continuous_approximation"]
    categoryOrder: list[Id] | None = None
    reverse: bool = False
    approximationAcknowledged: bool = False
    # E013 3rd round: evidence-backed scale declaration for codebook
    # nominal/unknown columns. scaleBasis=None for ordinary declared
    # scales; otherwise the analyst states the evidence (e.g.
    # "codebook_order_verified") and the original scale is preserved in
    # measurementResolution. The service rejects unsupported bases.
    scaleBasis: str | None = None

    @model_validator(mode="after")
    def check_consistency(self):
        if self.measurement == "ordinal":
            if self.categoryOrder is None:
                raise ValueError("ordinal measurement requires categoryOrder")
            if len(self.categoryOrder) < 2:
                raise ValueError("ordinal categoryOrder requires at least two categories")
            if len(set(self.categoryOrder)) != len(self.categoryOrder):
                raise ValueError("ordinal categoryOrder must not contain duplicates")
            allowed = (self.treatment == "ordinal" and not self.approximationAcknowledged) or (
                self.treatment == "continuous_approximation" and self.approximationAcknowledged
            )
            if not allowed:
                raise ValueError(
                    "ordinal measurement permits only treatment ordinal "
                    "without acknowledgement or treatment continuous_approximation "
                    "with acknowledgement"
                )
        else:
            if (
                self.treatment != "continuous"
                or self.categoryOrder is not None
                or self.reverse
                or self.approximationAcknowledged
            ):
                raise ValueError(
                    "continuous measurement requires treatment continuous, "
                    "categoryOrder=null, reverse=false, approximationAcknowledged=false"
                )
        return self


def _check_factor_context(context: AnalysisContextV2) -> None:
    if context.missingPolicy != "exclude":
        raise ValueError("factor requests require context.missingPolicy='exclude'")
    if context.weightMode not in ("none", "dataset"):
        raise ValueError("factor requests permit only context weightMode none or dataset")
    if context.weightMode == "none" and (
        context.weightColumn is not None or context.weightType is not None
    ):
        raise ValueError("weightColumn/weightType are only allowed with weightMode=column")


def _check_factor_identified(p: int, counts: list[int], name: str) -> None:
    if len(set(counts)) != len(counts):
        raise ValueError(f"{name} must not contain duplicates")
    for q in counts:
        if q < 1 or q >= p or (p - q) ** 2 - p - q < 0:
            raise ValueError(f"requested factor model is underidentified for {name}={q} with p={p}")


class EFAParallelAnalysisOptions(StrictModel):
    enabled: bool = True
    iterations: Annotated[int, Field(ge=100, le=10000)] = 500
    quantile: Probability = 0.95
    seed: Seed = 42


class EFASensitivityAnalysisOptions(StrictModel):
    enabled: bool = False
    approximationAcknowledged: bool = False
    alignment: Literal["signed_permutation"] = "signed_permutation"
    comparisonExtraction: Literal["minres"] = "minres"
    loadingDifferenceThreshold: Annotated[float, Field(gt=0, le=1)] = 0.1
    communalityDifferenceThreshold: Annotated[float, Field(gt=0, le=1)] = 0.1
    factorCorrelationDifferenceThreshold: Annotated[float, Field(gt=0, le=1)] = 0.1
    assignmentThreshold: Annotated[float, Field(ge=0, le=1)] = 0.4
    assignmentMargin: Annotated[float, Field(ge=0, le=1)] = 0.1

    @model_validator(mode="after")
    def check_acknowledgement(self):
        if self.enabled != self.approximationAcknowledged:
            raise ValueError("sensitivity analysis and approximation acknowledgement must be enabled together")
        return self


class EFARequest(StrictModel):
    """Feature 033 EFA input (method=efa, schemaVersion=factor_extensions.1)."""

    context: AnalysisContextV2
    variables: list[FactorVariable] = Field(min_length=3)
    correlation: Literal["pearson", "polychoric"]
    extraction: Literal["minres", "ml"]
    nFactors: Annotated[int, Field(ge=1)]
    compareFactors: list[Annotated[int, Field(ge=1)]] = Field(default_factory=list)
    rotation: Literal["none", "varimax", "promax"] = "promax"
    scoreMethod: Literal["none", "regression", "bartlett"] = "none"
    parallelAnalysis: EFAParallelAnalysisOptions = Field(default_factory=EFAParallelAnalysisOptions)
    sensitivityAnalysis: EFASensitivityAnalysisOptions = Field(
        default_factory=EFASensitivityAnalysisOptions)
    uniquenessLower: Annotated[float, Field(ge=1e-6, le=0.1)] = 0.005
    nStarts: Annotated[int, Field(ge=1, le=20)] = 5
    maxIterations: Annotated[int, Field(ge=100, le=20000)] = 2000
    seed: Seed = 42

    @model_validator(mode="after")
    def check_model(self):
        ids = [v.columnId for v in self.variables]
        if len(set(ids)) != len(ids):
            raise ValueError("variables must not contain duplicates")
        _check_factor_context(self.context)
        treatments = {v.treatment for v in self.variables}
        if "ordinal" in treatments and len(treatments) > 1:
            raise ValueError("treatment ordinal must not be mixed with other treatments")
        if treatments == {"ordinal"}:
            if self.correlation != "polychoric":
                raise ValueError("ordinal treatment requires correlation=polychoric")
            if self.extraction != "minres":
                raise ValueError("ordinal treatment requires extraction=minres")
            if self.scoreMethod != "none":
                raise ValueError("ordinal treatment requires scoreMethod=none")
        elif self.correlation != "pearson":
            raise ValueError("non-ordinal treatment sets require correlation=pearson")
        if len(set(str(q) for q in self.compareFactors)) != len(self.compareFactors):
            raise ValueError("compareFactors must not contain duplicates")
        _check_factor_identified(len(ids), sorted({self.nFactors, *self.compareFactors}),
                                 "factor count")
        if self.sensitivityAnalysis.enabled:
            if not all(v.measurement == "ordinal" for v in self.variables):
                raise ValueError(
                    "sensitivity analysis requires original ordinal measurement for every item")
            if not self.parallelAnalysis.enabled:
                raise ValueError("sensitivity analysis requires parallelAnalysis.enabled=true")
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
        vals = [v for v in self.model_dump().values() if v is not None]
        if len(set(vals)) != len(vals):
            raise ValueError("conjoint mappings must not contain duplicates")
        return self


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
            if (len(self.utilityRange) != 2
                    or not (self.utilityRange[0] < self.utilityRange[1])):
                raise ValueError("utilityRange requires finite lower < upper")
        return self


class ConjointRequest(StrictModel):
    """Feature 034 conjoint input (method=conjoint)."""

    context: AnalysisContextV2
    mode: Literal["ratings", "choice", "ranking"]
    columns: ConjointColumns
    attributes: list[Annotated[Union[CategoricalAttribute, LinearAttribute],
                                    Field(discriminator="kind")]] = Field(min_length=1)
    ratingEffects: Literal["pooled", "respondent_fixed"] = "pooled"
    priceAttribute: Id | None = None
    confidenceLevel: Probability = 0.95
    maxIterations: Annotated[int, Field(ge=100, le=20000)] = 1000

    @model_validator(mode="after")
    def check_model(self):
        ids = [a.columnId for a in self.attributes]
        if len(set(ids)) != len(ids):
            raise ValueError("attributes must not contain duplicates")
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
                a.columnId == self.priceAttribute and a.kind == "linear"
                for a in self.attributes):
            raise ValueError("priceAttribute must identify a linear attribute")
        return self


class ConjointExpandScopeRequest(StrictModel):
    context: AnalysisContextV2
    columns: ConjointColumns



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
        ids = [p.alternativeId for p in self.profiles]
        if len(set(ids)) != len(ids):
            raise ValueError("simulation profile IDs must not contain duplicates")
        if self.context.scope != "all" or self.context.weightMode != "none":
            raise ValueError("simulation uses context only for revision identity: "
                             "all/none required")
        for p in self.profiles:
            if p.optOut and p.values:
                raise ValueError("opt-out simulation profile must use values={}")
        return self
