"""Candidate-only helper controls; not part of baseline public-API red/green."""
from __future__ import annotations

from dataclasses import replace
import math

import numpy as np
import pytest

from app.algorithms.survey.design import (
    SurveyVarianceSource, build_design, build_domain_variance_frame,
)
from app.algorithms.survey.covariance import domain_mean_covariance
from app.algorithms.survey.rao_scott import rao_scott_test


def inputs(fpc=False):
    source = SurveyVarianceSource(
        row_ids=tuple(f"r{i}" for i in range(12)), weights=(1.,)*12,
        strata=("S1",)*12, psu=("P1",)*4+("P2",)*4+("P3",)*4,
        fpc=(6.,)*12 if fpc else None,
    )
    domain = build_design(np.ones(8), strata=np.array(["S1"]*8, dtype=object),
                          psu=np.array(["P1"]*4+["P2"]*4, dtype=object),
                          fpc=np.full(8, 6.) if fpc else None)
    codes = np.array([0,0,0,3,1,2,3,3])
    indicators = np.eye(4)[codes]
    return source, domain, codes, indicators


@pytest.mark.parametrize("fpc", [False, True])
def test_original_score_covariance_and_domain_n_df_are_separate(fpc):
    source, domain, codes, indicators = inputs(fpc)
    frame = build_domain_variance_frame(source, list(source.row_ids[:8]), domain)
    t = np.array([3.,-1.,-1.,-1.])/16
    expected = np.outer(t,t)*(1.5 if fpc else 3.)
    np.testing.assert_allclose(domain_mean_covariance(indicators, domain, frame), expected, rtol=1e-12)
    assert frame.design.size == 12 and frame.design.number_of_psus == 3
    assert domain.size == 8 and domain.number_of_psus == 2 and domain.design_df == 1
    result = rao_scott_test(np.array([[3.,1.],[1.,3.]]), codes//2, codes%2, domain, variance_frame=frame)
    assert result.chi2 == pytest.approx(2.)
    assert result.mean_design_effect == pytest.approx(1. if fpc else 2.)
    assert result.statistic == pytest.approx(2. if fpc else 1.)
    assert result.design_df == 1 and result.numerator_df == result.denominator_df == 1


def test_direct_kernel_without_frame_keeps_two_psu_universe():
    _, domain, codes, _ = inputs()
    result = rao_scott_test(np.array([[3.,1.],[1.,3.]]), codes//2, codes%2, domain)
    # Here the complete input design really contains only two PSUs. Its
    # independent Taylor covariance is4tt', so X2/delta =2/(8/3)=3/4.
    assert result.statistic == pytest.approx(.75)
    assert result.p_value == pytest.approx(1-2*math.atan(math.sqrt(.75))/math.pi)


@pytest.mark.parametrize("weight", [None, 0.])
def test_original_missing_zero_weights_are_not_valid_domain_zero_scores(weight):
    source, domain, _, indicators = inputs()
    source = replace(source, weights=(1.,)*8+(weight,)*4,
                     psu=source.psu[:8]+(None,)*4)
    frame = build_domain_variance_frame(source, list(source.row_ids[:8]), domain)
    assert frame.unavailable_reason is None and frame.design.size == 8
    t = np.array([3.,-1.,-1.,-1.])/16
    np.testing.assert_allclose(domain_mean_covariance(indicators, domain, frame), 4*np.outer(t,t))


def test_invalid_weight_status_does_not_become_missing_exclusion():
    source, domain, _, _ = inputs()
    source = replace(source, weights=(1.,)*8+(None,)*4, has_invalid_weights=True)
    frame = build_domain_variance_frame(source, list(source.row_ids[:8]), domain)
    assert frame.design is None and frame.unavailable_reason == "invalid_sampling_weight"


@pytest.mark.parametrize("mutation", ["missing", "duplicate", "weight", "psu"])
def test_mapping_identity_invariants_fail_explicitly(mutation):
    source, domain, _, _ = inputs()
    ids = list(source.row_ids[:8])
    if mutation == "missing":
        ids[0] = "unknown"
    elif mutation == "duplicate":
        ids[0] = ids[1]
    elif mutation == "weight":
        source = replace(source, weights=(2.,)+source.weights[1:])
    else:
        source = replace(source, psu=("wrong",)+source.psu[1:])
    with pytest.raises(ValueError):
        build_domain_variance_frame(source, ids, domain)


@pytest.mark.parametrize("positions", [(0,)*8, tuple(range(1,9)), tuple(range(7)), tuple(range(8))+(-1,)])
def test_covariance_position_contract_rejects_bad_mapping(positions):
    source, domain, _, indicators = inputs()
    frame = build_domain_variance_frame(source, list(source.row_ids[:8]), domain)
    if positions == tuple(range(1,9)):
        # Distinct in-range positions are only wrong if their original
        # weights differ; make the identity mismatch observable.
        frame = replace(frame, design=replace(frame.design, weights=np.arange(1.,13.)))
    with pytest.raises(ValueError):
        domain_mean_covariance(indicators, domain, replace(frame, positions=positions))


@pytest.mark.parametrize("value", [float("inf"), float("-inf")])
def test_legacy_string_converted_nonfinite_ids_are_not_reclassified(value):
    source, domain, _, _ = inputs()
    source = replace(source, psu=source.psu[:8]+(value,)*4)
    frame = build_domain_variance_frame(source, list(source.row_ids[:8]), domain)
    assert frame.unavailable_reason is None
    assert frame.design.number_of_psus == 3
