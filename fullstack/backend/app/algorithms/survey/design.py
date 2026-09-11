"""Sampling design for design-based inference.

Only the final weight is required. When strata / PSU are missing, every
respondent is treated as an independent primary sampling unit in a single
stratum (``assumption = "independent_rows"``) and the result is flagged as an
approximation wherever it surfaces.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ...domain.errors import BizError

ASSUMPTION_PROVIDED = "provided"
ASSUMPTION_INDEPENDENT_ROWS = "independent_rows"
ASSUMPTION_INDEPENDENT_ROWS_STRATA = "independent_rows_with_known_strata"


def _design_values(values: np.ndarray | None, size: int, label: str) -> np.ndarray | None:
    if values is None:
        return None
    raw = np.asarray(values, dtype=object)
    if raw.shape[0] != size:
        raise BizError("SURVEY_DESIGN_SHAPE", f"設計変数 {label} の長さが一致しません。",
                       status_code=422)
    out: list[str] = []
    for raw_value in raw.tolist():
        if raw_value is None:
            raise BizError("SURVEY_DESIGN_MISSING", f"設計変数 {label} に欠損があります。",
                           status_code=422)
        if isinstance(raw_value, float) and not np.isfinite(raw_value):
            raise BizError("SURVEY_DESIGN_MISSING", f"設計変数 {label} に欠損があります。",
                           status_code=422)
        text = str(raw_value)
        if text.strip() == "" or text in ("None", "nan", "NaN", "NULL", "null"):
            raise BizError("SURVEY_DESIGN_MISSING", f"設計変数 {label} に欠損があります。",
                           status_code=422)
        out.append(text)
    return np.asarray(out, dtype=object)


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
        # PSU ids are nested in strata (R nest=TRUE): the same local number in
        # two strata is two different PSUs, so relabelling must not move df.
        return int(len({(str(s), str(p)) for s, p in zip(self.strata.tolist(), self.psu.tolist())}))

    @property
    def design_df(self) -> float:
        """Residual degrees of freedom, nested PSUs (R ``nest=TRUE``).

        ``sum_h (n_h - 1)`` over strata, i.e. unique (stratum, psu) pairs minus
        unique strata, restricted to rows with nonzero weight. R's
        ``degf.survey.design2`` counts raw cluster ids globally, which changes
        df when the same local PSU number is reused across strata; nesting is
        the documented design assumption here (FIX_SPEC §5.2), so the nested
        count is the contract.
        """
        inset = self.weights != 0
        pairs = {(str(s), str(p)) for s, p in zip(self.strata[inset].tolist(), self.psu[inset].tolist())}
        return float(len(pairs) - len(set(self.strata[inset].tolist())))

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
    checked_fpc: np.ndarray | None = None
    if fpc is not None:
        # FPC is a population PSU count per row (R survey convention): it must
        # be finite, positive, and at least the sampled PSU count of its
        # stratum. Anything else (e.g. fpc=1 with 2 sampled PSUs) is 422
        # instead of a silent zero variance (SD05). Sampling fractions,
        # replicate weights, and multi-stage designs remain unsupported.
        raw_fpc = np.asarray(fpc, dtype=float)
        if raw_fpc.shape[0] != size or not np.all(np.isfinite(raw_fpc)):
            raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC が不正です。",
                           status_code=422)
        if np.any(raw_fpc < 1):
            raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC が不正です。",
                           status_code=422)
        checked_fpc = raw_fpc
    if psu is None:
        checked_strata = _design_values(strata, size, "strata") if strata is not None else None
        if checked_strata is None:
            if checked_fpc is not None:
                # FPC without any cluster/stratum information has no defined
                # target: reject instead of silently discarding it (F07).
                raise BizError("SURVEY_DESIGN_UNSUPPORTED",
                               "PSU未指定時のFPCは未対応です。",
                               status_code=422)
            # No cluster information: every respondent becomes an independent PSU.
            return SurveyDesign(
                weights=weights,
                strata=np.full(size, "1", dtype=object),
                psu=np.arange(size).astype(str),
                fpc=None,
                assumption=ASSUMPTION_INDEPENDENT_ROWS,
            )
        # Known strata, unknown PSU: one PSU per row, strata preserved. A
        # supplied FPC applies to the independent-row model as the population
        # size (sampling fraction 1 - n/N); without it, no correction.
        if checked_fpc is not None:
            population = float(np.median(checked_fpc))
            if not np.isfinite(population) or population < size:
                raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC が不正です。",
                               status_code=422)
        return SurveyDesign(
            weights=weights,
            strata=checked_strata,
            psu=np.arange(size).astype(str),
            fpc=checked_fpc,
            assumption=ASSUMPTION_INDEPENDENT_ROWS_STRATA,
        )
    strata = (np.full(size, "1", dtype=object) if strata is None
              else _design_values(strata, size, "strata"))
    assert strata is not None
    psu = _design_values(psu, size, "psu")
    assert psu is not None
    lonely: list[str] = []
    for stratum in dict.fromkeys(strata.tolist()):
        count = len(set(psu[strata == stratum].tolist()))
        if count < 2:
            lonely.append(stratum)
    if checked_fpc is not None:
        # The population must cover the sample in every stratum; a sampling
        # fraction in (0,1) or a population smaller than the sampled count is
        # a different FPC convention and stays unsupported (422).
        for stratum in dict.fromkeys(strata.tolist()):
            in_stratum = strata == stratum
            count = len(set(psu[in_stratum].tolist()))
            pop_values = checked_fpc[in_stratum]
            if np.any(pop_values < count) or np.any((pop_values > 0) & (pop_values < 1)):
                raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC が不正です。",
                               status_code=422)
    return SurveyDesign(
        weights=weights,
        strata=strata,
        psu=psu,
        fpc=checked_fpc,
        assumption=ASSUMPTION_PROVIDED,
        lonely_psu_strata=tuple(lonely),
    )
