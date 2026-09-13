"""Exploratory/confirmatory factor analysis request contracts (design artifact).

Standalone Pydantic v2 extension. It reuses ``StrictModel`` and
``AnalysisContextV2`` from ``analysis_requests`` by import and does not alter
that module. JSON Schema cannot express the ``model_validator``
cross-field semantics in this module (treatment consistency, correlation /
extraction / score coupling, factor-count identification, CFA estimator
selection, simple-structure coverage); Python contract validation is
authoritative for those cross-field rules. Data-dependent checks (usable
dataset weights, row provenance, fit diagnostics) belong in the service
layer, not here.

Fixed design notes (not validated here beyond structure):
marker loading scale is fixed at 1 and ordinal items use theta parameterization.
Pairwise deletion, FIML, and smoothing are deliberately not offered as fields.
``sourceEfaResultId``/``validationIntent`` are labels only and are not proof of
independent validation.
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Annotated, Literal
from pydantic import Field, StringConstraints, model_validator

from analysis_requests import AnalysisContextV2, StrictModel

Id = Annotated[str, StringConstraints(min_length=1)]
Seed = Annotated[int, Field(ge=0, le=4294967295)]
Probability = Annotated[float, Field(gt=0, lt=1)]


class FactorVariable(StrictModel):
    columnId: Id
    measurement: Literal["ordinal", "continuous"]
    treatment: Literal["ordinal", "continuous", "continuous_approximation"]
    categoryOrder: list[Id] | None = None
    reverse: bool = False
    approximationAcknowledged: bool = False

    @model_validator(mode="after")
    def check_consistency(self) -> FactorVariable:
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


def check_factor_context(context: AnalysisContextV2) -> None:
    if context.missingPolicy != "exclude":
        raise ValueError("factor requests require context.missingPolicy='exclude'")
    if context.weightMode not in ("none", "dataset"):
        raise ValueError("factor requests permit only context weightMode none or dataset")


def check_identified(p: int, counts: list[int], name: str) -> None:
    if len(set(counts)) != len(counts):
        raise ValueError(f"{name} must not contain duplicates")
    for q in counts:
        if q >= p or (p - q) ** 2 - p - q < 0:
            raise ValueError(f"requested factor model is underidentified for {name}={q} with p={p}")


def unique_ids(values: list[str], name: str) -> None:
    if len(set(values)) != len(values):
        raise ValueError(f"{name} must not contain duplicates")


class ParallelAnalysisOptions(StrictModel):
    enabled: bool = True
    iterations: Annotated[int, Field(ge=100, le=10000)] = 500
    quantile: Probability = 0.95
    seed: Seed = 42


class SensitivityAnalysisOptions(StrictModel):
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
    def check_acknowledgement(self) -> SensitivityAnalysisOptions:
        if self.enabled != self.approximationAcknowledged:
            raise ValueError("sensitivity analysis and approximation acknowledgement must be enabled together")
        return self


class EFARequest(StrictModel):
    context: AnalysisContextV2
    variables: list[FactorVariable] = Field(min_length=3)
    correlation: Literal["pearson", "polychoric"]
    extraction: Literal["minres", "ml"]
    nFactors: Annotated[int, Field(ge=1)]
    compareFactors: list[Annotated[int, Field(ge=1)]] = Field(default_factory=list)
    rotation: Literal["none", "varimax", "promax"] = "promax"
    scoreMethod: Literal["none", "regression", "bartlett"] = "none"
    parallelAnalysis: ParallelAnalysisOptions = Field(default_factory=ParallelAnalysisOptions)
    sensitivityAnalysis: SensitivityAnalysisOptions = Field(default_factory=SensitivityAnalysisOptions)
    uniquenessLower: Annotated[float, Field(ge=1e-6, le=0.1)] = 0.005
    nStarts: Annotated[int, Field(ge=1, le=20)] = 5
    maxIterations: Annotated[int, Field(ge=100, le=20000)] = 2000
    seed: Seed = 42

    @model_validator(mode="after")
    def check_model(self) -> EFARequest:
        ids = [v.columnId for v in self.variables]
        unique_ids(ids, "variables")
        check_factor_context(self.context)
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
        unique_ids([str(q) for q in self.compareFactors], "compareFactors")
        check_identified(len(ids), sorted({self.nFactors, *self.compareFactors}), "factor count")
        if self.sensitivityAnalysis.enabled:
            if not all(v.measurement == "ordinal" for v in self.variables):
                raise ValueError("sensitivity analysis requires original ordinal measurement for every item")
            if not self.parallelAnalysis.enabled:
                raise ValueError("sensitivity analysis requires parallelAnalysis.enabled=true")
        return self


class FactorModel(StrictModel):
    factorId: Id
    indicatorIds: list[Id] = Field(min_length=3)
    markerColumnId: Id

    @model_validator(mode="after")
    def check_marker(self) -> FactorModel:
        unique_ids(self.indicatorIds, "indicatorIds")
        if self.markerColumnId not in self.indicatorIds:
            raise ValueError("markerColumnId must be one of indicatorIds")
        return self


class CFARequest(StrictModel):
    context: AnalysisContextV2
    variables: list[FactorVariable] = Field(min_length=3)
    estimator: Literal["wlsmv", "ulsmv", "mlr", "ml"]
    factors: list[FactorModel] = Field(min_length=1)
    factorCovariance: Literal["free", "orthogonal"] = "free"
    confidenceLevel: Probability = 0.95
    sourceEfaResultId: Id | None = None
    validationIntent: Literal["exploratory", "same_data", "holdout", "external", "unknown"] = "unknown"

    @model_validator(mode="after")
    def check_model(self) -> CFARequest:
        ids = [v.columnId for v in self.variables]
        unique_ids(ids, "variables")
        check_factor_context(self.context)
        unique_ids([f.factorId for f in self.factors], "factorId")
        flat = [i for f in self.factors for i in f.indicatorIds]
        unique_ids(flat, "factor indicators")
        if set(flat) != set(ids):
            raise ValueError("factor indicators must cover all and only variables exactly once")
        treatments = {v.treatment for v in self.variables}
        if "ordinal" in treatments and len(treatments) > 1:
            raise ValueError("treatment ordinal must not be mixed with other treatments")
        if treatments == {"ordinal"}:
            if self.estimator not in ("wlsmv", "ulsmv"):
                raise ValueError("all-ordinal treatment permits only estimator wlsmv or ulsmv")
        elif self.estimator not in ("mlr", "ml"):
            raise ValueError("non-ordinal treatment sets permit only estimator mlr or ml")
        return self


REQUEST_MODELS = {"efa": EFARequest, "cfa": CFARequest}


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
