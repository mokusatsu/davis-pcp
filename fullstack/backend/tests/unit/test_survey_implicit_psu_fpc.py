"""STAT-01: implicit-PSU/FPC covariance against independent oracles."""
from __future__ import annotations

import numpy as np
import pytest
from scipy import stats

from app.algorithms.survey.design import build_design
from app.algorithms.survey.covariance import mean_covariance
from app.algorithms.survey.rao_scott import rao_scott_test
from app.domain.errors import BizError


def test_stat01_implicit_psu_mean_variance_matches_srs_oracle():
    y = np.array([0.] * 4 + [1.] * 4)
    design = build_design(np.ones(8), strata=np.repeat('all', 8), fpc=np.repeat(16., 8))
    expected = np.var(y, ddof=1) / len(y) * (1 - len(y) / 16)
    assert expected == pytest.approx(1 / 56, rel=1e-14)
    assert mean_covariance(y[:, None], design)[0, 0] == pytest.approx(expected, rel=1e-12)


def test_stat01_rao_scott_implicit_explicit_row_psu_equivalence():
    row = np.array([0] * 8 + [1] * 8)
    col = np.array([0] * 5 + [1] * 3 + [0] * 3 + [1] * 5)
    observed = np.array([[5., 3.], [3., 5.]])
    implicit = build_design(np.ones(16), strata=np.repeat('all', 16), fpc=np.repeat(32., 16))
    explicit = build_design(np.ones(16), strata=np.repeat('all', 16), psu=np.arange(16), fpc=np.repeat(32., 16))
    for design in (implicit, explicit):
        result = rao_scott_test(observed, row, col, design)
        assert result.statistic == pytest.approx(1.875, rel=1e-12)
        assert result.numerator_df == 1
        assert result.denominator_df == 15
        assert result.p_value == pytest.approx(stats.f.sf(1.875, 1, 15), rel=1e-12)


@pytest.mark.parametrize('scale', [1e-6, 1., 1e6])
@pytest.mark.parametrize('finite', [False, True])
def test_stat01_stratified_row_psus_match_manual_sum(scale, finite):
    # N_h can be smaller than the total sample size while covering its own stratum.
    strata = np.array(['a'] * 3 + ['b'] * 5)
    y = np.array([0., 1., 3., 5., 8., 8., 9., 11.])[:, None]
    w = np.array([1., 2., 3., 2., 1., 4., 2., 3.]) * scale
    fpc = np.array([6.] * 3 + [20.] * 5) if finite else None
    normalized = w / np.sum(w)
    linearized = (y - np.sum(y * normalized[:, None], axis=0)) * normalized[:, None]
    expected = np.zeros((1, 1))
    for label in ['a', 'b']:
        mask = strata == label
        block = linearized[mask]
        n = len(block)
        centered = block - block.mean(axis=0)
        factor = n / (n - 1) * ((1 - n / fpc[mask][0]) if finite else 1)
        expected += centered.T @ centered * factor
    implicit = build_design(w, strata=strata, fpc=fpc)
    explicit = build_design(w, strata=strata, psu=np.arange(len(w)), fpc=fpc)
    np.testing.assert_allclose(mean_covariance(y, implicit), expected, rtol=1e-12)
    np.testing.assert_allclose(mean_covariance(y, explicit), expected, rtol=1e-12)


@pytest.mark.parametrize('explicit', [False, True])
@pytest.mark.parametrize('fpc', [[3., 3., 3., 3.], [8., 8., 8., 2.], [8., 8., 8., 9.], [8., 8., 8., np.nan]])
def test_stat01_invalid_fpc_is_rejected_per_stratum(explicit, fpc):
    with pytest.raises(BizError) as exc:
        build_design(np.ones(4), strata=np.repeat('s', 4),
                     psu=np.arange(4) if explicit else None, fpc=np.array(fpc))
    assert exc.value.code == 'SURVEY_DESIGN_UNSUPPORTED'



def test_stat01_singleton_flags_match_explicit_row_psus():
    strata = np.array(['a', 'a', 'b'])
    implicit = build_design(np.ones(3), strata=strata)
    explicit = build_design(np.ones(3), strata=strata, psu=np.arange(3))
    assert implicit.assumption == 'independent_rows_with_known_strata'
    assert implicit.approximate is True
    assert explicit.assumption == 'provided'
    assert explicit.approximate is False
    assert implicit.lonely_psu_strata == explicit.lonely_psu_strata == ('b',)
    assert implicit.design_df == explicit.design_df == 1


def test_stat01_fpc_without_any_design_remains_explicitly_unsupported():
    with pytest.raises(BizError) as exc:
        build_design(np.ones(4), fpc=np.repeat(8., 4))
    assert exc.value.code == 'SURVEY_DESIGN_UNSUPPORTED'

def test_stat01_weights_only_assumption_label_is_unchanged():
    design = build_design(np.ones(4))
    assert design.assumption == 'independent_rows'
    assert design.approximate is True


def test_stat01_stratum_mean_differences_do_not_create_within_stratum_variance():
    strata = np.array(['a'] * 4 + ['b'] * 4)
    y = np.array([0.] * 4 + [10.] * 4)[:, None]
    design = build_design(np.ones(8), strata=strata, fpc=np.repeat(16., 8))
    # All population variation here is between known strata; centered PSU
    # totals are identically zero within each stratum.
    np.testing.assert_allclose(mean_covariance(y, design), np.zeros((1, 1)), atol=0)


def test_stat01_census_fpc_makes_the_variance_zero():
    y = np.array([0., 1., 2., 3.])[:, None]
    design = build_design(np.ones(4), strata=np.repeat('s', 4), fpc=np.repeat(4., 4))
    np.testing.assert_allclose(mean_covariance(y, design), np.zeros((1, 1)), atol=0)
