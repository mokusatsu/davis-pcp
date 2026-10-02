"""Strict v1 contracts for regularized regression; no OLS inference aliases."""
from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import Field, field_validator, model_validator

from .analysis_contracts import (
    AnalysisContextV2, CategoricalPredictor, Id, NumericPredictor, StrictModel,
)

PositiveFinite = Annotated[float, Field(gt=0, allow_inf_nan=False)]
Ratio = Annotated[float, Field(gt=0, lt=1, allow_inf_nan=False)]


class RegularizedCV(StrictModel):
    folds: Annotated[int, Field(ge=2, le=20)] = 5
    seed: Annotated[int, Field(ge=0, le=4294967295)] = 42
    lambdaValues: list[PositiveFinite] = Field(min_length=1, max_length=100)
    l1Ratios: list[Ratio] = Field(default_factory=lambda: [0.5], min_length=1, max_length=20)
    independentRowsAcknowledged: Literal[True]

    @field_validator("independentRowsAcknowledged", mode="before")
    @classmethod
    def require_explicit_boolean(cls, value):
        if value is not True:
            raise ValueError("independentRowsAcknowledged must be JSON true")
        return value

    @model_validator(mode="after")
    def check_grid(self):
        if len(set(self.lambdaValues)) != len(self.lambdaValues):
            raise ValueError("lambdaValues must be unique")
        if len(set(self.l1Ratios)) != len(self.l1Ratios):
            raise ValueError("l1Ratios must be unique")
        if any(v < 0.01 for v in self.l1Ratios):
            raise ValueError("automatic l1Ratios must be at least 0.01")
        if len(self.lambdaValues) * len(self.l1Ratios) * self.folds > 2000:
            raise ValueError("CV grid is too large")
        return self


class RegularizedRegressionRequest(StrictModel):
    context: AnalysisContextV2
    target: Id
    predictors: list[Annotated[Union[NumericPredictor, CategoricalPredictor],
                               Field(discriminator="kind")]] = Field(min_length=1)
    algorithm: Literal["ridge", "lasso", "elasticnet"] = "ridge"
    intercept: bool = True
    standardize: bool = True
    lambdaValue: PositiveFinite = 0.1
    l1Ratio: Ratio = 0.5
    selection: Literal["manual", "cv"] = "manual"
    cv: RegularizedCV | None = None
    tolerance: Annotated[float, Field(gt=0, le=0.1, allow_inf_nan=False)] = 1e-8
    maxIterations: Annotated[int, Field(ge=100, le=100000)] = 10000

    @model_validator(mode="after")
    def check_model(self):
        ids = [p.columnId for p in self.predictors]
        if len(set(ids)) != len(ids) or self.target in ids:
            raise ValueError("predictors must be distinct and exclude target")
        if (self.selection == "cv") != (self.cv is not None):
            raise ValueError("CV options are required only for selection=cv")
        return self


class ExportPredictRequest(StrictModel):
    language: Literal["python", "javascript", "typescript"]
    artifact: Literal["model", "code", "schema", "readme", "test_vectors", "bundle"]
    columnMapping: dict[Id, Id] | None = None
    expectedModelVersion: Literal["1"]
