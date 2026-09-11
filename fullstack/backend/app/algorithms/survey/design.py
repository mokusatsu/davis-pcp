"""Sampling design for design-based inference.

Only the final weight is required. When strata / PSU are missing, every
respondent is treated as an independent primary sampling unit in a single
stratum (``assumption = "independent_rows"``) and the result is flagged as an
approximation wherever it surfaces.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

ASSUMPTION_PROVIDED = "provided"
ASSUMPTION_INDEPENDENT_ROWS = "independent_rows"


@dataclass(frozen=True)
class SurveyDesign:
    """Weights plus (optionally) the cluster structure they were estimated from."""

    weights: np.ndarray
    strata: np.ndarray
    psu: np.ndarray
    fpc: np.ndarray | None = None
    assumption: str = ASSUMPTION_INDEPENDENT_ROWS
    lonely_psu_strata: tuple[str, ...] = ()

    @property
    def size(self) -> int:
        return int(self.weights.shape[0])

    @property
    def stratum_ids(self) -> list[str]:
        return list(dict.fromkeys(self.strata.tolist()))

    @property
    def number_of_strata(self) -> int:
        return len(self.stratum_ids)

    @property
    def number_of_psus(self) -> int:
        return int(len(set(self.psu.tolist())))

    @property
    def design_df(self) -> float:
        """Residual degrees of freedom, exactly as R's ``degf.survey.design2``.

        ``length(unique(cluster[weight != 0])) - length(unique(strata[weight != 0]))``
        — a single global difference, *not* the per-stratum sum of ``n_h - 1``.
        The two agree whenever a PSU id lives inside one stratum, which is the
        usual case; they diverge when the same id appears in several strata,
        because R counts that id once per *design*, not once per stratum. Getting
        this wrong changes the denominator df of the F test and therefore the
        p-value, so it is copied rather than paraphrased.
        """
        inset = self.weights != 0
        return float(len(set(self.psu[inset].tolist())) - len(set(self.strata[inset].tolist())))

    @property
    def approximate(self) -> bool:
        return self.assumption != ASSUMPTION_PROVIDED


def build_design(
    weights: np.ndarray,
    strata: np.ndarray | None = None,
    psu: np.ndarray | None = None,
    fpc: np.ndarray | None = None,
) -> SurveyDesign:
    """Assemble a design, falling back to one PSU per row when cluster info is absent."""
    weights = np.asarray(weights, dtype=float)
    size = weights.shape[0]
    if psu is None:
        # No cluster information: every respondent becomes an independent PSU.
        return SurveyDesign(
            weights=weights,
            strata=np.full(size, "1", dtype=object),
            psu=np.arange(size).astype(str),
            fpc=None,
            assumption=ASSUMPTION_INDEPENDENT_ROWS,
        )
    strata = (np.full(size, "1", dtype=object) if strata is None
              else np.asarray([str(v) for v in strata], dtype=object))
    psu = np.asarray([str(v) for v in psu], dtype=object)
    lonely: list[str] = []
    for stratum in dict.fromkeys(strata.tolist()):
        count = len(set(psu[strata == stratum].tolist()))
        if count < 2:
            lonely.append(stratum)
    return SurveyDesign(
        weights=weights,
        strata=strata,
        psu=psu,
        fpc=np.asarray(fpc, dtype=float) if fpc is not None else None,
        assumption=ASSUMPTION_PROVIDED,
        lonely_psu_strata=tuple(lonely),
    )
