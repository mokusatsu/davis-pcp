"""Hypothesis testing for a two-way table, dispatched on the weight's meaning.

Three regimes, three different answers to "is the association real?":

``unweighted``  every row is one observation — the ordinary Pearson χ² (or
                Fisher exact) applies.
``frequency``   each row stands for that many identical observations, so the
                weighted counts *are* counts and Pearson still applies; the
                statistic moves when the weight does, because the sample size
                genuinely moved.
``survey``      the weight corrects representativeness and its scale is
                arbitrary, so the ordinary Pearson χ² is meaningless. Only the
                Rao–Scott second-order correction answers the question, and it
                needs the sampling design to do so.

The requested method is resolved — never silently substituted. A caller that
asks for the wrong test for its weight type gets a 422 (spec §15), because
quietly running a different test is how the wrong p-value reached the UI in the
first place.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from scipy import stats

from ..survey.design import SurveyDesign
from ..survey.rao_scott import METHOD_SECOND_ORDER, pearson_chi_square, rao_scott_test
from .association import positive_marginal_submatrix

REQUEST_AUTO = "auto"
REQUEST_NONE = "none"
REQUEST_PEARSON = "pearson"
REQUEST_FISHER = "fisher_exact"
REQUEST_RAO_SCOTT = "rao_scott"

REQUESTED_METHODS = (REQUEST_AUTO, REQUEST_NONE, REQUEST_PEARSON, REQUEST_FISHER, REQUEST_RAO_SCOTT)

METHOD_PEARSON = "pearson"
METHOD_FISHER = "fisher_exact"
METHOD_RAO_SCOTT = METHOD_SECOND_ORDER

STATUS_NOT_REQUESTED = "not_requested"
STATUS_OK = "ok"
STATUS_UNAVAILABLE = "unavailable"


@dataclass
class InferenceResult:
    """What the inference layer returns; the API copies this straight out."""

    requested: bool
    status: str
    method: str | None = None
    statistic_type: str | None = None
    statistic: float | None = None
    statistic_status: str | None = None
    numerator_df: float | None = None
    denominator_df: float | None = None
    p_value: float | None = None
    design_assumption: str | None = None
    approximate: bool | None = None
    warnings: list[dict[str, Any]] = field(default_factory=list)

    def to_payload(self) -> dict[str, Any]:
        return {
            "requested": self.requested,
            "status": self.status,
            "method": self.method,
            "statisticType": self.statistic_type,
            "statistic": self.statistic,
            "statisticStatus": self.statistic_status,
            "numeratorDf": self.numerator_df,
            "denominatorDf": self.denominator_df,
            "pValue": self.p_value,
            "designAssumption": self.design_assumption,
            "approximate": self.approximate,
        }


def resolve_inference(requested: str, weight_type: str | None, has_weight: bool) -> str:
    """Turn the request + weight meaning into the method that will actually run.

    Returns one of ``none`` / ``pearson`` / ``fisher_exact`` / ``rao_scott``, or
    raises ``BizError`` when the combination cannot mean anything. ``auto``
    expresses the intent "run whatever is defensible here"; an explicit method
    is a claim the caller has to get right.
    """
    from ...domain.errors import BizError

    if requested not in REQUESTED_METHODS:
        raise BizError("CROSSTAB_INFERENCE_METHOD", "inference が不正です。", status_code=422)
    effective = weight_type if has_weight else None

    if requested == REQUEST_NONE:
        return REQUEST_NONE

    if requested == REQUEST_AUTO:
        return REQUEST_PEARSON if effective != "survey" else REQUEST_NONE

    if requested == REQUEST_PEARSON:
        if effective == "survey":
            raise BizError(
                "SURVEY_PEARSON_UNSUPPORTED",
                "調査ウェイトに通常の Pearson χ² 検定は使用できません。Rao–Scott を指定してください。",
                status_code=422,
            )
        return REQUEST_PEARSON

    if requested == REQUEST_FISHER:
        if effective is not None:
            raise BizError(
                "CROSSTAB_FISHER_UNSUPPORTED",
                "Fisher正確検定は無ウェイトの2x2表で明示指定時のみ利用できます。",
                status_code=422,
            )
        return REQUEST_FISHER

    # rao_scott
    if effective != "survey":
        raise BizError(
            "SURVEY_INFERENCE_UNAVAILABLE",
            "Rao–Scott 検定は調査ウェイト（weightType=survey）でのみ使用できます。",
            status_code=422,
        )
    return REQUEST_RAO_SCOTT


def unweighted_inference(counts: np.ndarray, method: str = REQUEST_PEARSON) -> InferenceResult:
    """Ordinary inference on counts that are real counts."""
    if method == REQUEST_FISHER:
        # Retain zero margins for a requested 2x2 exact test: p remains defined
        # even when its sample odds ratio is infinite or undefined.
        odds_ratio, p_value = stats.fisher_exact(np.asarray(counts).astype(int))
        statistic_status = ("finite" if np.isfinite(odds_ratio)
                            else "undefined" if np.isnan(odds_ratio) else "infinite")
        warnings = [] if statistic_status == "finite" else [{
            "code": "CROSSTAB_FISHER_ODDS_RATIO_NONFINITE",
            "message": ("Fisher検定のオッズ比は無限大です。p値は計算されています。" if statistic_status == "infinite"
                        else "Fisher検定のオッズ比は周辺度数0のため未定義です。p値は計算されています。"),
        }]
        return InferenceResult(
            requested=True, status=STATUS_OK, method=METHOD_FISHER,
            statistic_type="odds_ratio",
            statistic=float(odds_ratio) if statistic_status == "finite" else None,
            statistic_status=statistic_status,
            p_value=float(p_value),
            warnings=warnings,
        )
    matrix, keep_rows, keep_cols = positive_marginal_submatrix(counts)
    n_rows, n_cols = matrix.shape if matrix.size else (0, 0)
    if n_rows < 2 or n_cols < 2:
        return InferenceResult(requested=True, status=STATUS_UNAVAILABLE, method=method)
    chi2 = pearson_chi_square(matrix)
    df_value = float((n_rows - 1) * (n_cols - 1))
    return InferenceResult(
        requested=True, status=STATUS_OK, method=METHOD_PEARSON,
        statistic_type="chi2", statistic=float(chi2),
        numerator_df=df_value, denominator_df=None,
        p_value=float(stats.chi2.sf(chi2, df_value)),
    )


def frequency_inference(counts: np.ndarray) -> InferenceResult:
    """Pearson χ² on frequency-weighted counts.

    Unlike the survey case the raw weighted table is the right input: a row
    with weight 100 really does stand for 100 observations, so both the
    statistic and the p-value are *expected* to move when the weights scale.
    """
    return unweighted_inference(counts, REQUEST_PEARSON)


def survey_inference(
    counts: np.ndarray,
    row_codes: np.ndarray,
    col_codes: np.ndarray,
    design: SurveyDesign,
) -> InferenceResult:
    """Rao–Scott second-order test, or an explicit "unavailable"."""
    warnings: list[dict[str, Any]] = []
    if design.assumption != "provided":
        warnings.append({
            "code": "SURVEY_INFERENCE_WEIGHTS_ONLY",
            "message": "層化・クラスタ抽出等の標本設計情報が未指定のため、各回答者を独立した一次抽出単位として近似しています。",
        })
    else:
        if design.lonely_psu_strata:
            # Lonely-PSU strata cannot yield a design variance without an extra
            # assumption (certainty/merge/adjust); this release fails instead of
            # reporting a zero-variance success.
            return InferenceResult(
                requested=True, status=STATUS_UNAVAILABLE, method=METHOD_RAO_SCOTT,
                design_assumption=design.assumption,
                approximate=design.approximate,
                warnings=[{
                    "code": "SURVEY_LONELY_PSU",
                    "message": "一次抽出単位が1つだけの層があるため、調査設計に基づく推測はできません。",
                    "details": {"strata": list(design.lonely_psu_strata)},
                }],
            )

    result = rao_scott_test(counts, row_codes, col_codes, design)
    if result is None:
        return InferenceResult(
            requested=True, status=STATUS_UNAVAILABLE, method=METHOD_RAO_SCOTT,
            design_assumption=design.assumption,
            approximate=design.approximate,
            warnings=warnings,
        )

    if design.design_df < 1.0:
        warnings.append({
            "code": "SURVEY_LOW_DESIGN_DF",
            "message": "調査設計の自由度が不足しています。",
            "details": {"designDf": result.design_df},
        })
    return InferenceResult(
        requested=True, status=STATUS_OK, method=METHOD_RAO_SCOTT,
        statistic_type=result.statistic_type,
        statistic=result.statistic,
        numerator_df=result.numerator_df,
        denominator_df=result.denominator_df,
        p_value=result.p_value,
        design_assumption=result.design_assumption,
        approximate=result.approximate,
        warnings=warnings,
    )


def not_requested_inference() -> InferenceResult:
    """Survey weights with inference left off — a choice, not a failure (spec §10)."""
    return InferenceResult(
        requested=False, status=STATUS_NOT_REQUESTED, design_assumption=None, approximate=None,
    )
