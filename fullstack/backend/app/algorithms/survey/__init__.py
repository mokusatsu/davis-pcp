"""Design-based inference for survey weights (WEIGHT-04/B04).

The survey weight is a population-representativeness correction, not a count, so
the raw weighted counts must not be fed to an ordinary Pearson chi-square. This
package provides the pieces the crosstab needs instead:

- ``design``       the sampling design (weights / strata / PSU / fpc)
- ``covariance``   Taylor linearization of an estimated total or mean
- ``rao_scott``    Rao-Scott second-order correction (Satterthwaite F)
- ``diagnostics``  weight diagnostics (Kish ESS, DEFF, CV)

``rao_scott_test`` follows R ``survey::svychisq(statistic="F")``; the golden
test in ``tests/unit/test_survey_rao_scott.py`` pins it to the published
``apiclus1`` output.
"""
from .covariance import linearized_total_covariance, mean_covariance
from .design import SurveyDesign, build_design
from .diagnostics import weight_diagnostics
from .rao_scott import RaoScottResult, rao_scott_test

__all__ = [
    "RaoScottResult",
    "SurveyDesign",
    "build_design",
    "linearized_total_covariance",
    "mean_covariance",
    "rao_scott_test",
    "weight_diagnostics",
]
