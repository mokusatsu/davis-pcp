"""Sampling design for design-based inference.

Only the final weight is required. When strata / PSU are missing, every
respondent is treated as an independent primary sampling unit in a single
stratum (``assumption = "independent_rows"``) and the result is flagged as an
approximation wherever it surfaces.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from ...domain.errors import BizError

ASSUMPTION_PROVIDED = "provided"
ASSUMPTION_INDEPENDENT_ROWS = "independent_rows"
ASSUMPTION_INDEPENDENT_ROWS_STRATA = "independent_rows_with_known_strata"


@dataclass(frozen=True)
class SurveyVarianceSource:
    """Original design-only input; outcomes and scope membership are separate.

    Weights use the existing extract_weights classification. Missing and zero
    original weights are excluded; invalid weights prevent domain inference.
    Merely carrying this input must not validate a descriptive-only request.
    """

    row_ids: tuple[str, ...]
    weights: tuple[float | None, ...]
    has_invalid_weights: bool = False
    strata: tuple[Any, ...] | None = None
    psu: tuple[Any, ...] | None = None
    fpc: tuple[Any, ...] | None = None


@dataclass(frozen=True)
class SurveyVarianceFrame:
    """Covariance frame, deliberately distinct from the analyzed-domain design."""

    design: SurveyDesign | None = None
    positions: tuple[int, ...] = ()
    unavailable_reason: str | None = None
    design_error_code: str | None = None


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
    has_strata = strata is not None
    has_psu = psu is not None
    if not has_psu and not has_strata and checked_fpc is not None:
        # Keep the existing contract: FPC needs at least one supplied design
        # variable, rather than silently inventing its population target.
        raise BizError("SURVEY_DESIGN_UNSUPPORTED",
                       "PSU未指定時のFPCは未対応です。",
                       status_code=422)
    checked_strata = (np.full(size, "1", dtype=object) if strata is None
                      else _design_values(strata, size, "strata"))
    checked_psu = (np.arange(size).astype(str) if psu is None
                   else _design_values(psu, size, "psu"))
    assert checked_strata is not None and checked_psu is not None
    assumption = (ASSUMPTION_PROVIDED if has_psu else
                  ASSUMPTION_INDEPENDENT_ROWS_STRATA if has_strata else
                  ASSUMPTION_INDEPENDENT_ROWS)
    lonely: list[str] = []
    for stratum in dict.fromkeys(checked_strata.tolist()):
        in_stratum = checked_strata == stratum
        count = len(set(checked_psu[in_stratum].tolist()))
        if count < 2:
            lonely.append(stratum)
        if checked_fpc is not None:
            # Explicit and implicit row PSUs describe the same design. FPC
            # is the population PSU count for this stratum, never global n.
            pop_values = checked_fpc[in_stratum]
            if np.any(pop_values < count):
                raise BizError("SURVEY_DESIGN_UNSUPPORTED", "FPC が不正です。",
                               status_code=422)
            if np.any(np.abs(pop_values - pop_values[0]) > 1e-9):
                raise BizError("SURVEY_DESIGN_UNSUPPORTED",
                               "FPC は層内で一定である必要があります。", status_code=422)
    return SurveyDesign(
        weights=weights,
        strata=checked_strata,
        psu=checked_psu,
        fpc=checked_fpc,
        assumption=assumption,
        lonely_psu_strata=tuple(lonely),
    )


def build_domain_variance_frame(
    source: SurveyVarianceSource,
    analyzed_row_ids: list[str],
    domain_design: SurveyDesign,
) -> SurveyVarianceFrame:
    """Retain original positive non-missing units without changing reference df.

    Use after the ordinary scoped validation and only for resolved Rao–Scott.
    Extra source validity failures make inference unavailable; malformed row
    mappings are internal invariants and must not become a numerical fallback.
    No new codebook missing-code semantics are added for design fields.
    """
    size = len(source.row_ids)
    for values in (source.weights, source.strata, source.psu, source.fpc):
        if values is not None and len(values) != size:
            raise ValueError("Original survey source columns must align with row IDs")
    if len(set(source.row_ids)) != size or len(set(analyzed_row_ids)) != len(analyzed_row_ids):
        raise ValueError("Survey domain mapping requires unique row IDs")
    if len(analyzed_row_ids) != domain_design.size:
        raise ValueError("Survey domain row IDs must align with analyzed weights")
    if source.has_invalid_weights:
        return SurveyVarianceFrame(unavailable_reason="invalid_sampling_weight")
    kept: list[int] = []
    for i, weight in enumerate(source.weights):
        if isinstance(weight, (bool, np.bool_)):
            return SurveyVarianceFrame(unavailable_reason="invalid_sampling_weight")
        if weight is None or weight == 0:
            continue
        if not np.isfinite(weight) or weight < 0:
            return SurveyVarianceFrame(unavailable_reason="invalid_sampling_weight")
        kept.append(i)
    original_weights = np.asarray([source.weights[i] for i in kept], dtype=float)
    index = {source.row_ids[i]: position for position, i in enumerate(kept)}
    if any(row_id not in index for row_id in analyzed_row_ids):
        raise ValueError("Analyzed survey row is absent from the original positive-weight frame")
    positions = tuple(index[row_id] for row_id in analyzed_row_ids)
    if not np.array_equal(original_weights[list(positions)], domain_design.weights):
        raise ValueError("Original and analyzed sampling weights disagree")

    def identifiers(values: tuple[Any, ...] | None) -> np.ndarray | None:
        # Match Crosstab's current str conversion before build_design.
        return np.asarray([str(values[i]) for i in kept], dtype=object) if values is not None else None

    fpc = None
    if source.fpc is not None:
        # Same raw numeric acceptance as Crosstab._numeric, but a declared
        # array that fails conversion is distinct from an absent FPC column.
        try:
            fpc = np.asarray([float(source.fpc[i]) for i in kept], dtype=float)
        except (TypeError, ValueError):
            return SurveyVarianceFrame(unavailable_reason="invalid_fpc")
        if not np.all(np.isfinite(fpc)):
            return SurveyVarianceFrame(unavailable_reason="invalid_fpc")
    try:
        original = build_design(original_weights, strata=identifiers(source.strata),
                                psu=identifiers(source.psu), fpc=fpc)
    except BizError as exc:
        return SurveyVarianceFrame(unavailable_reason="invalid_sampling_design", design_error_code=exc.code)
    # Domain implicit PSU numbers are local to its rows; only supplied IDs
    # should match literally across the two independently constructed frames.
    for values, original_values, domain_values in (
        (source.strata, original.strata, domain_design.strata),
        (source.psu, original.psu, domain_design.psu),
    ):
        if values is not None and not np.array_equal(original_values[list(positions)], domain_values):
            raise ValueError("Original and analyzed sampling identities disagree")
    return SurveyVarianceFrame(design=original, positions=positions)
