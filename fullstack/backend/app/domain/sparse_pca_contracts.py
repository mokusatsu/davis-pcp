"""Strict SparsePCA contracts, deliberately separate from ordinary PCA."""
from __future__ import annotations

from typing import Annotated, Literal
from pydantic import Field, model_validator
from .analysis_contracts import AnalysisContextV2, NumericPredictor, Seed, StrictModel

Nonnegative = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class SparsePcaRequest(StrictModel):
    context: AnalysisContextV2
    variables: list[NumericPredictor] = Field(min_length=2)
    preprocessing: Literal["correlation", "covariance"] = "correlation"
    nComponents: Annotated[int, Field(ge=1)] = 2
    alpha: Nonnegative = 1.0
    ridgeAlpha: Nonnegative = 0.01
    tolerance: Annotated[float, Field(gt=0, le=0.1, allow_inf_nan=False)] = 1e-8
    maxIterations: Annotated[int, Field(ge=1, le=5000)] = 1000
    seed: Seed = 0

    @model_validator(mode="after")
    def check_model(self):
        ids = [v.columnId for v in self.variables]
        if len(ids) != len(set(ids)):
            raise ValueError("variables must not contain duplicates")
        if self.context.missingPolicy != "exclude":
            raise ValueError("SparsePCA only supports missingPolicy=exclude")
        return self


class SparsePcaConvergence(StrictModel):
    status: Literal["tolerance_reached", "iteration_limit", "objective_increase"]
    nIterations: int
    maxIterations: int
    tolerance: float
    objectiveHistory: list[float]
    finalObjective: float
    finalImprovement: float | None


class SparsePcaSummary(StrictModel):
    nComponents: int
    nVariables: int
    basisRank: int
    nonzeroPerComponent: list[int]
    zeroFraction: float
    reconstructionFraction: float
    reconstructionSpace: Literal["standardized", "centered_analysis_values"]
    convergence: SparsePcaConvergence


class SparsePcaVariable(StrictModel):
    columnId: str
    name: str
    label: str
    scaleType: Literal["interval", "ratio", "ordinal"]
    missingCodes: list[str]
    valueLabels: dict[str, str]
    isReversed: bool
    categoryOrder: list[str]
    ordinalAsNumericAcknowledged: bool
    score: Literal["ordered_rank"] | None


class ExcludedConstantColumn(StrictModel):
    columnId: str
    name: str
    label: str


class SparsePcaScalingColumn(StrictModel):
    columnId: str
    inputMagnitude: float
    inputAnchor: float
    normalizedMeanOffset: float
    normalizedMean: float
    normalizedSampleSd: float
    rawMean: float | None
    rawMeanReason: str | None
    rawSampleSd: float | None
    rawSampleSdReason: str | None


class SparsePcaPreprocessing(StrictModel):
    mode: Literal["correlation", "covariance"]
    columns: list[SparsePcaScalingColumn]
    estimatorMean: list[float]


class SparsePcaDetails(StrictModel):
    variables: list[SparsePcaVariable]
    excludedConstantColumns: list[ExcludedConstantColumn]
    preprocessing: SparsePcaPreprocessing
    componentOrder: list[str]
    components: list[list[float]]
    scoreCoefficients: list[list[float]]
    variableScoreCorrelations: list[list[float | None]]
    variableScoreCorrelationReasons: list[list[str | None]]
    scoreCorrelations: list[list[float | None]]
    scoreCorrelationReasons: list[list[str | None]]
    componentGram: list[list[float]]
    scoreVariances: list[float | None]
    scoreVarianceReasons: list[str | None]
    rankTolerance: float
