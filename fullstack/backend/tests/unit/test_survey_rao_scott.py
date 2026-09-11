"""WEIGHT-04/B04: golden parity with R ``survey::svychisq`` and its invariants.

The fixture is the ``apiclus1`` dataset shipped with the R ``survey`` package
(183 rows, 15 clusters, ``dnum`` as PSU, ``pw`` as the survey weight, ``fpc``
the population cluster count). R's own documentation for ``svychisq`` reports:

    dclus1 <- svydesign(id=~dnum, weights=~pw, data=apiclus1, fpc=~fpc)
    svytable(~sch.wide+stype, dclus1)
    #          stype
    # sch.wide        E        H        M
    #      No   406.1640 101.5410 270.7760
    #      Yes 4467.8035 372.3170 575.3989
    svychisq(~sch.wide+stype, dclus1)
    # F = 5.1934, ndf = 1.4946, ddf = 20.9250, p-value = 0.02175
    svychisq(~sch.wide+stype, dclus1, statistic="Chisq")
    # X-squared = 11.941, df = 2, p-value = 0.005553

Those numbers are pinned here. (The ``F = 4.4639`` figures quoted in some
write-ups come from the *replicate-weight* design ``as.svrepdesign(dclus1)``,
which uses a different variance estimator and is out of scope.)
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from scipy import stats

from app.algorithms.survey import build_design, rao_scott_test, weight_diagnostics
from app.algorithms.survey.rao_scott import independence_contrasts

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "apiclus1_weight_design.csv"

R_SVYTABLE = np.array([[406.1640, 101.5410, 270.7760],
                       [4467.8035, 372.3170, 575.3989]])
R_STATISTIC = 5.1934
R_NUMERATOR_DF = 1.4946
R_DENOMINATOR_DF = 20.9250
R_P_VALUE = 0.02175
R_CHISQ_P_VALUE = 0.005553


def _rows() -> list[dict[str, str]]:
    lines = FIXTURE.read_text(encoding="utf-8").strip().splitlines()
    header = lines[0].split(",")
    return [dict(zip(header, line.split(","))) for line in lines[1:]]


def _coded(rows: list[dict[str, str]]):
    row_levels = ["No", "Yes"]
    col_levels = ["E", "H", "M"]
    row_codes = np.array([row_levels.index(r["sch.wide"]) for r in rows])
    col_codes = np.array([col_levels.index(r["stype"]) for r in rows])
    weights = np.array([float(r["pw"]) for r in rows])
    return row_codes, col_codes, weights


def _table(row_codes, col_codes, weights, shape: tuple[int, int] = (2, 3)) -> np.ndarray:
    table = np.zeros(shape, dtype=float)
    np.add.at(table, (row_codes, col_codes), weights)
    return table


def test_weighted_table_matches_r_svytable():
    rows = _rows()
    row_codes, col_codes, weights = _coded(rows)
    assert np.allclose(_table(row_codes, col_codes, weights), R_SVYTABLE, atol=5e-5)


def test_rao_scott_second_order_matches_r_svychisq():
    rows = _rows()
    row_codes, col_codes, weights = _coded(rows)
    psu = np.array([r["dnum"] for r in rows])
    fpc = np.array([float(r["fpc"]) for r in rows])
    design = build_design(weights, psu=psu, fpc=fpc)
    result = rao_scott_test(_table(row_codes, col_codes, weights), row_codes, col_codes, design)
    assert result is not None
    assert result.design_df == 14.0
    assert result.design_assumption == "provided"
    assert result.approximate is False
    assert result.statistic == pytest.approx(R_STATISTIC, abs=5e-5)
    assert result.numerator_df == pytest.approx(R_NUMERATOR_DF, abs=5e-5)
    assert result.denominator_df == pytest.approx(R_DENOMINATOR_DF, abs=5e-5)
    assert result.p_value == pytest.approx(R_P_VALUE, abs=5e-6)


def test_design_effect_matches_r_chisq_variant():
    """R's statistic="Chisq" divides X² by mean(diag(Delta)) and uses chi-square_2."""
    rows = _rows()
    row_codes, col_codes, weights = _coded(rows)
    design = build_design(weights, psu=np.array([r["dnum"] for r in rows]),
                          fpc=np.array([float(r["fpc"]) for r in rows]))
    result = rao_scott_test(_table(row_codes, col_codes, weights), row_codes, col_codes, design)
    assert result is not None
    # tr(Delta) = 2 * mean(diag(Delta)) because Delta is 2x2 here.
    mean_design_effect = result.mean_design_effect / 2.0
    assert result.chi2 == pytest.approx(11.941, abs=5e-3)
    assert stats.chi2.sf(result.chi2 / mean_design_effect, 2) == pytest.approx(R_CHISQ_P_VALUE, abs=5e-6)


def test_constant_strata_reproduce_the_clustered_design():
    """An explicit single stratum is the same design R builds when strata is NULL."""
    rows = _rows()
    row_codes, col_codes, weights = _coded(rows)
    psu = np.array([r["dnum"] for r in rows])
    fpc = np.array([float(r["fpc"]) for r in rows])
    implicit = rao_scott_test(_table(row_codes, col_codes, weights), row_codes, col_codes,
                              build_design(weights, psu=psu, fpc=fpc))
    explicit = rao_scott_test(_table(row_codes, col_codes, weights), row_codes, col_codes,
                              build_design(weights, strata=np.full(len(rows), "all"), psu=psu, fpc=fpc))
    assert implicit is not None and explicit is not None
    assert explicit.statistic == pytest.approx(implicit.statistic, rel=1e-12)
    assert explicit.numerator_df == pytest.approx(implicit.numerator_df, rel=1e-12)
    assert explicit.denominator_df == pytest.approx(implicit.denominator_df, rel=1e-12)


def test_weight_scale_does_not_move_any_inference_quantity():
    """T01: w, 10w, 100w and w/mean(w) must agree, only the weight sum may move."""
    rows = _rows()
    row_codes, col_codes, weights = _coded(rows)
    psu = np.array([r["dnum"] for r in rows])
    fpc = np.array([float(r["fpc"]) for r in rows])
    reference = rao_scott_test(_table(row_codes, col_codes, weights), row_codes, col_codes,
                               build_design(weights, psu=psu, fpc=fpc))
    assert reference is not None
    for scaled in (weights * 10.0, weights * 100.0, weights / weights.mean()):
        design = build_design(scaled, psu=psu, fpc=fpc)
        result = rao_scott_test(_table(row_codes, col_codes, scaled), row_codes, col_codes, design)
        assert result is not None
        assert result.statistic == pytest.approx(reference.statistic, rel=1e-9)
        assert result.numerator_df == pytest.approx(reference.numerator_df, rel=1e-9)
        assert result.denominator_df == pytest.approx(reference.denominator_df, rel=1e-9)
        assert result.p_value == pytest.approx(reference.p_value, rel=1e-9)
        diagnostics = weight_diagnostics(scaled)
        base = weight_diagnostics(weights)
        assert diagnostics["kishEffectiveN"] == pytest.approx(base["kishEffectiveN"], rel=1e-9)
        assert diagnostics["weightingDeff"] == pytest.approx(base["weightingDeff"], rel=1e-9)
        assert diagnostics["weightCv"] == pytest.approx(base["weightCv"], rel=1e-9)


def test_weights_only_design_uses_the_independent_rows_assumption():
    rows = _rows()
    row_codes, col_codes, weights = _coded(rows)
    design = build_design(weights)
    result = rao_scott_test(_table(row_codes, col_codes, weights), row_codes, col_codes, design)
    assert result is not None
    assert result.design_assumption == "independent_rows"
    assert result.approximate is True
    assert result.design_df == len(rows) - 1
    assert result.statistic > 0 and 0.0 <= result.p_value <= 1.0


def test_hand_computed_linearization_for_two_strata():
    """Independent check of the stratified estimator against a direct sum."""
    weights = np.array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0])
    strata = np.array(["s1", "s1", "s1", "s2", "s2", "s2"])
    psu = np.array(["a", "b", "c", "d", "e", "f"])
    row_codes = np.array([0, 1, 0, 1, 0, 1])
    col_codes = np.array([0, 0, 1, 1, 0, 1])
    table = _table(row_codes, col_codes, weights, shape=(2, 2))
    design = build_design(weights, strata=strata, psu=psu)
    result = rao_scott_test(table, row_codes, col_codes, design)
    assert result is not None
    assert result.design_df == 4.0  # (3 - 1) + (3 - 1)

    indicators = np.zeros((6, 4))
    indicators[np.arange(6), row_codes * 2 + col_codes] = 1.0
    total = weights.sum()
    average = (indicators * weights[:, None]).sum(0) / total
    linearized = (indicators - average) * weights[:, None] / total
    manual = np.zeros((4, 4))
    for mask in (strata == "s1", strata == "s2"):
        block = linearized[mask]
        manual += (block - block.mean(0)).T @ (block - block.mean(0)) * (3 / 2)
    # Reproduce the statistic from the same Delta the module derives.
    proportions = table / table.sum()
    inverse = np.where(proportions > 0, 1 / proportions, 0.0).reshape(-1)
    contrasts = independence_contrasts(2, 2)
    delta = np.linalg.solve(contrasts.T @ (inverse[:, None] * contrasts) / 6,
                            contrasts.T @ (inverse[:, None] * manual * inverse[None, :]) @ contrasts)
    assert result.mean_design_effect == pytest.approx(float(np.trace(delta)), rel=1e-12)


def test_single_psu_stratum_is_flagged():
    weights = np.array([1.0, 1.0, 1.0])
    strata = np.array(["s1", "s1", "s2"])
    psu = np.array(["a", "b", "c"])
    design = build_design(weights, strata=strata, psu=psu)
    assert design.design_df == 1.0  # 3 PSUs - 2 strata, R's degf.survey.design2
    assert design.lonely_psu_strata == ("s2",)


def test_design_df_counts_psus_nested_within_strata():
    """SD02 / nest=TRUE: a PSU is identified by (stratum, local PSU id).

    There are three PSUs in s1 and two in s2: 5 PSUs and 3 design df.
    Relabeling those same PSUs with globally unique ids must change neither.
    """
    weights = np.array([1.0, 1.0, 1.0, 1.0, 1.0])
    strata = np.array(["s1", "s1", "s1", "s2", "s2"])
    psu = np.array(["a", "b", "c", "a", "b"])
    design = build_design(weights, strata=strata, psu=psu)
    assert len(set(psu.tolist())) == 3  # Local labels alone are not identities.
    assert len(set(zip(strata.tolist(), psu.tolist()))) == 5
    assert design.number_of_psus == 5
    assert design.design_df == 3.0  # (3 - 1) + (2 - 1) = 5 - 2.

    global_ids = np.array([f"{stratum}:{psu_id}" for stratum, psu_id in zip(strata, psu)])
    relabeled = build_design(weights, strata=strata, psu=global_ids)
    assert relabeled.number_of_psus == design.number_of_psus
    assert relabeled.design_df == design.design_df


def test_zero_weight_rows_are_excluded_from_the_design_df():
    """R restricts the count to rows with a non-zero sampling weight."""
    weights = np.array([1.0, 1.0, 0.0, 1.0])
    strata = np.array(["s1", "s1", "s1", "s2"])
    psu = np.array(["a", "b", "ghost", "c"])
    design = build_design(weights, strata=strata, psu=psu)
    assert design.design_df == 1.0  # {a, b, c} minus {s1, s2}; "ghost" is dropped


def test_zero_marginal_categories_do_not_move_the_statistic():
    """T07: adding an empty category must not change the inference."""
    rows = _rows()
    row_codes, col_codes, weights = _coded(rows)
    psu = np.array([r["dnum"] for r in rows])
    fpc = np.array([float(r["fpc"]) for r in rows])
    reference = rao_scott_test(_table(row_codes, col_codes, weights), row_codes, col_codes,
                               build_design(weights, psu=psu, fpc=fpc))
    assert reference is not None
    padded = rao_scott_test(_table(row_codes, col_codes, weights), row_codes, col_codes,
                            build_design(weights, psu=psu, fpc=fpc))
    assert padded is not None and padded.statistic == pytest.approx(reference.statistic, rel=1e-12)
    # A zero row / column makes the test unavailable rather than wrong.
    zero_row = np.vstack([R_SVYTABLE, np.zeros((1, 3))])
    assert rao_scott_test(zero_row, row_codes, col_codes,
                          build_design(weights, psu=psu, fpc=fpc)) is None
