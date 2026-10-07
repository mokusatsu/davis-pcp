"""Taylor linearization variance for stratified cluster samples.

Port of the variance estimator R ``survey`` uses inside ``svymean`` /
``svyCprod``: collapse the linearized variable to PSU totals, center them on
their stratum mean, then accumulate ``n_h / (n_h - 1)`` times the finite
population correction per stratum. Strata holding a single PSU contribute
nothing (their centered value is identically zero).
"""
from __future__ import annotations

import numpy as np

from .design import SurveyDesign, SurveyVarianceFrame
from .weight_arithmetic import normalized_weights


def linearized_total_covariance(values: np.ndarray, design: SurveyDesign) -> np.ndarray:
    """Covariance of the estimated total of the linearized variable ``values``."""
    values = np.atleast_2d(np.asarray(values, dtype=float))
    if values.shape[0] != design.size:
        values = values.T
    columns = values.shape[1]
    covariance = np.zeros((columns, columns), dtype=float)
    if design.size == 0:
        return covariance
    for stratum in design.stratum_ids:
        in_stratum = design.strata == stratum
        psu_labels = design.psu[in_stratum]
        psu_totals = np.zeros((0, columns), dtype=float)
        unique_psus = list(dict.fromkeys(psu_labels.tolist()))
        psu_totals = np.vstack([values[in_stratum][psu_labels == psu] .sum(axis=0) for psu in unique_psus])
        count = len(unique_psus)
        if count < 2:
            continue
        centered = psu_totals - psu_totals.mean(axis=0, keepdims=True)
        inflation = count / (count - 1)
        if design.fpc is not None:
            population = float(np.median(design.fpc[in_stratum]))
            if population > 0:
                inflation *= max(0.0, (population - count) / population)
        covariance += centered.T @ centered * inflation
    return covariance


def mean_covariance(indicators: np.ndarray, design: SurveyDesign) -> np.ndarray:
    """Covariance matrix of the weighted means of the columns of ``indicators``."""
    indicators = np.atleast_2d(np.asarray(indicators, dtype=float))
    if indicators.shape[0] != design.size:
        indicators = indicators.T
    weights = normalized_weights(design.weights)
    if design.size == 0 or not np.any(weights > 0):
        return np.zeros((indicators.shape[1], indicators.shape[1]), dtype=float)
    average = (indicators * weights[:, None]).sum(axis=0)
    linearized = (indicators - average) * weights[:, None]
    return linearized_total_covariance(linearized, design)


def domain_mean_covariance(
    indicators: np.ndarray, domain_design: SurveyDesign, frame: SurveyVarianceFrame,
) -> np.ndarray:
    """Domain ratio covariance with zero scores in the original sampling frame.

    Original zero/missing weights have already been excluded by the source
    builder. Valid original units outside the analyzed domain retain their
    design membership; their scores alone are zero.
    """
    if frame.design is None or frame.unavailable_reason is not None:
        raise ValueError("Domain covariance requires a complete original survey frame")
    indicators = np.asarray(indicators, dtype=float)
    if indicators.ndim != 2 or indicators.shape[0] != domain_design.size:
        raise ValueError("Domain indicators must align with analyzed rows")
    positions = np.asarray(frame.positions)
    if (positions.ndim != 1 or positions.size != domain_design.size
            or positions.dtype.kind not in "iu"
            or len(set(frame.positions)) != len(frame.positions)
            or np.any(positions < 0) or np.any(positions >= frame.design.size)):
        raise ValueError("Domain positions must uniquely index the original survey frame")
    if not np.array_equal(frame.design.weights[positions], domain_design.weights):
        raise ValueError("Original and domain sampling weights disagree")
    weights = normalized_weights(domain_design.weights)
    average = (indicators * weights[:, None]).sum(axis=0)
    scores = np.zeros((frame.design.size, indicators.shape[1]), dtype=float)
    scores[positions] = (indicators - average) * weights[:, None]
    return linearized_total_covariance(scores, frame.design)
