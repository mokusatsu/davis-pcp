"""Rao-Scott second-order correction for two-way tables (WEIGHT-04/B04).

The survey weight is a representativeness correction, so the weighted counts
cannot be handed to an ordinary Pearson chi-square: scaling every weight by 100
would scale the statistic by 100. Rao-Scott replaces the statistic with the
Pearson chi-square divided by the mean design effect of the independence
contrasts, and calibrates it against a Satterthwaite F distribution.

This is a faithful port of R ``survey::svychisq(statistic="F")``:

    Cmat  <- qr.resid(qr(X1), X12[, -(1:(nr+nc-1)), drop = FALSE])
    denom <- t(Cmat) %*% (iDmat/N) %*% Cmat
    numr  <- t(Cmat) %*% iDmat %*% V %*% iDmat %*% Cmat
    Delta <- solve(denom, numr)
    d0    <- sum(diag(Delta))^2 / sum(diag(Delta %*% Delta))
    F     <- X2 / sum(diag(Delta));  df = c(ndf = d0, ddf = d0 * degf(design))

The statistic itself is scale invariant because both ``X2`` and ``Delta`` are
built from weighted *proportions*.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy import stats

from .covariance import mean_covariance
from .design import SurveyDesign

METHOD_SECOND_ORDER = "rao_scott_second_order"
STATISTIC_TYPE = "F"


@dataclass(frozen=True)
class RaoScottResult:
    statistic: float
    statistic_type: str
    numerator_df: float
    denominator_df: float
    p_value: float
    design_df: float
    design_assumption: str
    approximate: bool
    chi2: float
    mean_design_effect: float


def independence_contrasts(n_rows: int, n_cols: int) -> np.ndarray:
    """Basis of the interaction subspace, orthogonal to the additive model.

    Mirrors R's construction: take the product-dummy columns of the saturated
    model and remove their projection onto ``~row + col``. The span does not
    depend on which reference category the coding picks.
    """
    size = n_rows * n_cols
    row_of = np.repeat(np.arange(n_rows), n_cols)
    col_of = np.tile(np.arange(n_cols), n_rows)
    additive = np.zeros((size, 1 + (n_rows - 1) + (n_cols - 1)), dtype=float)
    additive[:, 0] = 1.0
    for i in range(1, n_rows):
        additive[:, i] = (row_of == i).astype(float)
    for j in range(1, n_cols):
        additive[:, (n_rows - 1) + j] = (col_of == j).astype(float)
    interactions = np.zeros((size, (n_rows - 1) * (n_cols - 1)), dtype=float)
    column = 0
    for i in range(1, n_rows):
        for j in range(1, n_cols):
            interactions[:, column] = ((row_of == i) & (col_of == j)).astype(float)
            column += 1
    coefficients, *_ = np.linalg.lstsq(additive, interactions, rcond=None)
    return interactions - additive @ coefficients


def pearson_chi_square(counts: np.ndarray) -> float:
    """Pearson X² of a contingency table (expectations from the margins)."""
    counts = np.asarray(counts, dtype=float)
    total = float(counts.sum())
    if total <= 0:
        return 0.0
    expected = np.outer(counts.sum(axis=1), counts.sum(axis=0)) / total
    usable = expected > 0
    return float(np.sum((counts[usable] - expected[usable]) ** 2 / expected[usable]))


def rao_scott_test(
    counts: np.ndarray,
    row_codes: np.ndarray,
    col_codes: np.ndarray,
    design: SurveyDesign,
    method: str = METHOD_SECOND_ORDER,
) -> RaoScottResult | None:
    """Second-order Rao-Scott test of independence.

    ``counts`` is the r x c table of weighted counts used for display; the
    per-row ``row_codes`` / ``col_codes`` (integers indexing that table) carry
    the cluster membership needed for the design-based covariance. Returns
    ``None`` when the design cannot support a test (fewer than two rows or
    columns, a degenerate design effect, or no residual design degrees of
    freedom).
    """
    counts = np.asarray(counts, dtype=float)
    n_rows, n_cols = counts.shape
    if n_rows < 2 or n_cols < 2 or design.size == 0:
        return None
    total = float(counts.sum())
    if total <= 0:
        return None
    proportions = counts / total
    row_margins = proportions.sum(axis=1)
    col_margins = proportions.sum(axis=0)
    if np.any(row_margins <= 0) or np.any(col_margins <= 0):
        return None

    size = design.size
    indicators = np.zeros((size, n_rows * n_cols), dtype=float)
    indicators[np.arange(size), np.asarray(row_codes, dtype=int) * n_cols + np.asarray(col_codes, dtype=int)] = 1.0
    covariance = mean_covariance(indicators, design)

    inverse = np.where(proportions > 0, 1.0 / proportions, 0.0)
    inverse = inverse.reshape(-1)
    weighted_inverse = inverse[:, None] * covariance * inverse[None, :]
    contrasts = independence_contrasts(n_rows, n_cols)
    denominator = contrasts.T @ (inverse[:, None] * contrasts) / size
    numerator = contrasts.T @ weighted_inverse @ contrasts
    try:
        delta = np.linalg.solve(denominator, numerator)
    except np.linalg.LinAlgError:
        return None
    trace = float(np.trace(delta))
    if not np.isfinite(trace) or trace <= 0:
        return None

    chi2 = size * float(np.sum((proportions - np.outer(row_margins, col_margins)) ** 2
                               / np.outer(row_margins, col_margins)))
    statistic = chi2 / trace
    squared_trace = float(np.trace(delta @ delta))
    numerator_df = trace ** 2 / squared_trace if squared_trace > 0 else float(n_rows - 1) * (n_cols - 1)
    design_df = design.design_df
    denominator_df = numerator_df * design_df
    if not np.isfinite(statistic) or denominator_df <= 0 or numerator_df <= 0:
        return None
    return RaoScottResult(
        statistic=float(statistic),
        statistic_type=STATISTIC_TYPE,
        numerator_df=float(numerator_df),
        denominator_df=float(denominator_df),
        p_value=float(stats.f.sf(statistic, numerator_df, denominator_df)),
        design_df=float(design_df),
        design_assumption=design.assumption,
        approximate=design.approximate,
        chi2=chi2,
        mean_design_effect=trace,
    )
