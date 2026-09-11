"""Taylor linearization variance for stratified cluster samples.

Port of the variance estimator R ``survey`` uses inside ``svymean`` /
``svyCprod``: collapse the linearized variable to PSU totals, center them on
their stratum mean, then accumulate ``n_h / (n_h - 1)`` times the finite
population correction per stratum. Strata holding a single PSU contribute
nothing (their centered value is identically zero).
"""
from __future__ import annotations

import numpy as np

from .design import SurveyDesign


def linearized_total_covariance(values: np.ndarray, design: SurveyDesign) -> np.ndarray:
    """Covariance of the estimated total of the linearized variable ``values``."""
    values = np.atleast_2d(np.asarray(values, dtype=float))
    if values.shape[0] != design.size:
        values = values.T
    columns = values.shape[1]
    covariance = np.zeros((columns, columns), dtype=float)
    if design.size == 0:
        return covariance
    independent_rows = design.assumption == "independent_rows_with_known_strata" and design.fpc is not None
    if independent_rows:
        # One PSU per row: the stratum structure carries no cluster variance,
        # so the covariance is the plain independent-row sandwich scaled by the
        # sampling fraction (1 - n/N). This is what makes a supplied FPC halve
        # the variance for n=96/N=192 (F07) instead of being dropped.
        population = float(np.median(design.fpc))
        fraction = max(0.0, (population - design.size) / population) if population > 0 else 1.0
        centered_all = values - values.mean(axis=0, keepdims=True)
        n = design.size
        if n < 2:
            return covariance
        covariance += centered_all.T @ centered_all * (n / (n - 1)) * fraction / n
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
    weight_sum = float(design.weights.sum())
    if weight_sum <= 0 or design.size == 0:
        return np.zeros((indicators.shape[1], indicators.shape[1]), dtype=float)
    average = (indicators * design.weights[:, None]).sum(axis=0) / weight_sum
    linearized = (indicators - average) * design.weights[:, None] / weight_sum
    return linearized_total_covariance(linearized, design)
