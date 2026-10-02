"""Descriptive association for a two-way table (WEIGHT-04/B04, spec §9).

These quantities describe the table that was actually computed; they are not
tests. Splitting them out of the inference path is the point: the old code
derived Cramér's V from whatever ``chi2_contingency`` returned, so swapping the
inference method silently changed the descriptive number too.

Cramér's V is invariant to multiplying all weights by a constant. Pearson
X² retains the absolute table scale; it is descriptive, not survey inference.
"""
from __future__ import annotations

import math

import numpy as np

from ..survey.rao_scott import pearson_chi_square
from ..survey.weight_arithmetic import normalized_weights


def positive_marginal_submatrix(counts: np.ndarray) -> tuple[np.ndarray, list[int], list[int]]:
    """Return the positive-marginal submatrix used for inference and V.

    Categories the codebook defines but nobody chose stay in the display table
    (zero rows/columns are information), yet they must not enter a statistic
    whose margins would then be zero.
    """
    counts = np.asarray(counts, dtype=float)
    row_totals = counts.sum(axis=1)
    col_totals = counts.sum(axis=0)
    keep_rows = [i for i in range(counts.shape[0]) if row_totals[i] > 0]
    keep_cols = [j for j in range(counts.shape[1]) if col_totals[j] > 0]
    if not keep_rows or not keep_cols:
        return np.zeros((0, 0), dtype=float), keep_rows, keep_cols
    return counts[np.ix_(keep_rows, keep_cols)], keep_rows, keep_cols


def cramers_v(chi2: float | None, total: float, n_rows: int, n_cols: int) -> float | None:
    """Cramér's V of a table whose grand total is ``total``.

    Weighted form (spec §9): ``V_w = sqrt(X_w² / (W · min(r-1, c-1)))`` with
    ``W = Σw``. Dividing by the weight *sum* rather than the row count is what
    makes it scale free — ``X²`` and ``W`` both carry the multiplier.
    """
    if chi2 is None or total <= 0:
        return None
    dimensions = min(n_rows - 1, n_cols - 1)
    if dimensions <= 0:
        return None
    value = (chi2 / total) / dimensions
    if value < 0:
        return None
    return math.sqrt(value)


def descriptive_association(counts: np.ndarray, *, weighted: bool) -> dict[str, float | int | bool | str | None]:
    """Pearson table statistic + Cramér's V for the analysed table.

    The statistic is computed from the table's own margins, so it carries the
    weight multiplier; ``weightedCramersV`` divides that back out. Neither is
    corrected for the sampling design — that is the inference layer's job.
    """
    counts = np.asarray(counts, dtype=float)
    total = float(counts.sum())
    chi2 = pearson_chi_square(counts) if total > 0 else None
    submatrix, _, _ = positive_marginal_submatrix(counts)
    n_rows, n_cols = submatrix.shape if submatrix.size else (0, 0)
    # V is dimensionless; do not reconstruct it from an absolute statistic
    # that can underflow for tiny survey weights.
    relative_chi2 = pearson_chi_square(normalized_weights(counts)) if total > 0 else None
    value = cramers_v(relative_chi2, 1.0, n_rows, n_cols)
    out_of_range = chi2 is not None and not math.isfinite(chi2)
    return {
        "pearsonChi2": None if out_of_range else chi2,
        **({"pearsonChi2Status": "out_of_range"} if out_of_range else {}),
        "df": (n_rows - 1) * (n_cols - 1) if n_rows and n_cols else 0,
        # Only one of the two is filled: a weighted V must not be presented
        # under the plain name, and an unweighted one is not "weighted".
        "cramersV": None if weighted else value,
        "weightedCramersV": value if weighted else None,
        "weighted": weighted,
    }
