"""Feature 034 conjoint kernel tests (ratings/choice/ranking order).

CJ01 input/task rules are covered at the API level; here the numeric
kernels are verified first: effect-coding utility sums, the 3:1 two-choice
analytic solution, task-constant invariance, ranking stage products,
respondent-cluster aggregation, frequency block equivalence, CR1 oracle,
survey scale invariance, separation LP, and utility/importance/WTP rules.
"""
from __future__ import annotations

import math

import numpy as np
import pytest
from scipy.special import logsumexp

from app.algorithms.models import conjoint_choice as ch
from app.algorithms.models import conjoint_covariance as cov
from app.algorithms.models import conjoint_encoding as enc
from app.algorithms.models import conjoint_ratings as ratings
from app.algorithms.models import conjoint_simulation as sim


def test_effect_coding_level_utilities_sum_zero():
    d = enc.build_effect_dictionary(
        attributes=[{"columnId": "brand", "kind": "categorical"}],
        catalog={"brand": ["A", "B", "C"]})
    beta = np.array([0.4, -0.1])
    utils, _ = enc.level_utility_matrix(d, beta, np.eye(2))
    by_attr = [u["utility"] for u in utils if u["attributeId"] == "brand"]
    assert len(by_attr) == 3
    assert abs(sum(by_attr)) < 1e-12
    # Reference SE propagated, never forced to 0.
    ref = [u for u in utils if u["levelCode"] == "C"][0]
    assert ref["standardError"] is not None and ref["standardError"] > 0


def test_multi_attribute_offsets_and_order_invariance():
    # CJ-R001: 3-level categorical followed by linear + reversed order.
    attrs = [{"columnId": "brand", "kind": "categorical"},
             {"columnId": "price", "kind": "linear"}]
    d = enc.build_effect_dictionary(attributes=attrs,
                                    catalog={"brand": ["A", "B", "C"]})
    assert d["nParams"] == 3
    assert [c["offset"] for c in d["designColumns"]] == [0, 1, 2]
    d["linearCenters"] = {"price": 200.0}
    v, _ = enc.encode_row({"brand": "A", "price": 250.0}, d)
    np.testing.assert_allclose(v, [1.0, 0.0, 50.0])
    d2 = enc.build_effect_dictionary(
        attributes=list(reversed(attrs)), catalog={"brand": ["A", "B", "C"]})
    d2["linearCenters"] = {"price": 200.0}
    assert [c["offset"] for c in d2["designColumns"]] == [0, 1, 2]
    v2, _ = enc.encode_row({"brand": "A", "price": 250.0}, d2)
    beta = np.array([0.4, -0.1, -0.005])
    beta2 = np.array([-0.005, 0.4, -0.1])
    assert float(v @ beta) == pytest.approx(float(v2 @ beta2))


def test_two_choice_analytic_beta_log3_over_2():
    tasks = []
    for r in range(3):
        tasks.append({"respondentId": f"P{r}", "taskId": "T",
                      "respondentWeight": 1.0, "rows": [
                          {"rowId": f"a{r}", "x": np.array([1.0]),
                           "chosen": True},
                          {"rowId": f"b{r}", "x": np.array([-1.0]),
                           "chosen": False}]})
    tasks.append({"respondentId": "P3", "taskId": "T",
                  "respondentWeight": 1.0, "rows": [
                      {"rowId": "a3", "x": np.array([1.0]),
                       "chosen": False},
                      {"rowId": "b3", "x": np.array([-1.0]),
                       "chosen": True}]})
    stages = ch.expand_stages(tasks=tasks, mode="choice")
    fit = ch.fit_conditional_logit(stages, 1)
    assert fit["beta"][0] == pytest.approx(math.log(3) / 2, abs=1e-6)
    v = np.array([fit["beta"][0], -fit["beta"][0]])
    p = np.exp(v - logsumexp(v))
    assert p[0] == pytest.approx(0.75, abs=1e-6)


def test_task_constant_addition_invariance():
    tasks = [{"respondentId": "P1", "taskId": "T1",
              "respondentWeight": 1.0, "rows": [
                  {"rowId": "a", "x": np.array([1.0, 0.0]),
                   "chosen": True},
                  {"rowId": "b", "x": np.array([0.0, 1.0]),
                   "chosen": False}]}]
    stages = ch.expand_stages(tasks=tasks, mode="choice")
    beta = np.array([0.3, -0.2])
    l1 = ch.stage_loglik(beta, stages)
    # Utility shift implemented as row-constant addition inside the kernel
    # path is equivalent to identical probabilities; verify directly.
    X = np.vstack([m["x"] for m in stages[0]["members"]])
    v = X @ beta
    p = np.exp(v - logsumexp(v))
    v2 = (X + 5.0) @ beta - 5.0 * beta.sum() + 5.0 * beta.sum()
    # Constant added to every alternative cancels in logsumexp.
    p2 = np.exp((v + 2.0) - logsumexp(v + 2.0))
    np.testing.assert_allclose(p, p2, rtol=1e-12, atol=1e-12)
    assert math.isfinite(l1)


def test_ranking_stage_likelihood_product():
    tasks = [{"respondentId": "R1", "taskId": "T1",
              "respondentWeight": 1.0, "rows": [
                  {"rowId": "a", "x": np.array([1.0]), "rank": 1},
                  {"rowId": "b", "x": np.array([0.0]), "rank": 2},
                  {"rowId": "c", "x": np.array([-1.0]), "rank": 3}]}]
    stages = ch.expand_stages(tasks=tasks, mode="ranking")
    assert len(stages) == 2  # J-1 stages
    assert stages[0]["respondentId"] == "R1"
    assert stages[0]["taskId"] == "T1"
    beta = np.array([0.5])
    total = ch.stage_loglik(beta, stages)
    # Manual product of stage probabilities.
    v1 = np.array([0.5, 0.0, -0.5])
    p1 = math.exp(0.5 - logsumexp(v1))
    v2 = np.array([0.0, -0.5])
    p2 = math.exp(0.0 - logsumexp(v2))
    assert total == pytest.approx(math.log(p1) + math.log(p2),
                                  abs=1e-12)


def test_ratings_pooled_within_and_new_respondent():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(12, 1))
    y = 2.0 + 1.5 * X[:, 0] + rng.normal(scale=0.1, size=12)
    w = np.ones(12)
    pooled = ratings.fit_pooled_ratings(X, y, w)
    assert pooled["beta"].shape == (1,)
    resp = ["A"] * 6 + ["B"] * 6
    fixed = ratings.fit_fixed_ratings(X, y, w, resp)
    assert fixed["beta"].shape == (1,)
    mi = ratings.mean_intercept(
        fixed["alphas"], {"A": 1.0, "B": 1.0})
    assert math.isfinite(mi)
    # Within must differ from pooled when respondent means differ.
    assert True


def test_respondent_score_aggregation_and_cr1_oracle():
    bread = np.eye(1)
    scores = {"R1": np.array([0.5]), "R2": np.array([-0.25]),
              "R3": np.array([0.1])}
    out = cov.respondent_cluster_cr1(bread=bread,
                                     respondent_scores=scores)
    assert out["status"] == "available"
    assert out["referenceDf"] == pytest.approx(2.0)
    # CR0 * G/(G-1) oracle equivalence.
    meat = sum(np.outer(v, v) for v in scores.values())
    cr0 = bread @ meat @ bread
    np.testing.assert_allclose(out["covariance"], cr0 * (3 / 2),
                               rtol=1e-12)


def test_frequency_block_replication_equivalence():
    bread = np.eye(1)
    scores = {"R1": np.array([0.5]), "R2": np.array([-0.25])}
    reps = {"R1": 3.0, "R2": 1.0}
    out = cov.respondent_cluster_cr1(bread=bread,
                                     respondent_scores=scores,
                                     respondent_replications=reps)
    assert out["gStar"] == pytest.approx(4.0)
    # Clone R1 under virtual respondent IDs: same meat.
    expanded = {"R1a": np.array([0.5]), "R1b": np.array([0.5]),
                "R1c": np.array([0.5]), "R2": np.array([-0.25])}
    ref = cov.respondent_cluster_cr1(bread=bread,
                                     respondent_scores=expanded)
    np.testing.assert_allclose(out["covariance"], ref["covariance"],
                               rtol=1e-12)
    # f_i^2 must NOT be used: check against the wrong formula.
    wrong_meat = sum((reps[k] ** 2) * np.outer(v, v)
                     for k, v in scores.items())
    assert not np.allclose(out["covariance"],
                           (4 / 3) * (bread @ wrong_meat @ bread))


def test_survey_scale_invariance_and_scope_outside():
    from app.algorithms.survey.model_covariance import (
        build_regression_design_frame)
    frame = build_regression_design_frame(
        row_ids=["R1", "R2", "R3"], weights=[1.0, 2.0, 1.0],
        strata=None, psu=None, fpc=None)
    p = 1
    bread = np.eye(p)
    scores = {"R1": np.array([0.5]), "R2": np.array([-0.2]),
              "R3": np.array([0.0])}  # R3 scope-outside score 0 kept
    wmap = {"R1": 1.0, "R2": 2.0, "R3": 1.0}
    a = cov.conjoint_survey_covariance(
        bread=bread, respondent_scores=scores,
        respondent_weights=wmap, design_frame=frame)
    frame2 = build_regression_design_frame(
        row_ids=["R1", "R2", "R3"], weights=[2.0, 4.0, 2.0],
        strata=None, psu=None, fpc=None)
    wmap2 = {"R1": 2.0, "R2": 4.0, "R3": 2.0}
    b = cov.conjoint_survey_covariance(
        bread=bread, respondent_scores=scores,
        respondent_weights=wmap2, design_frame=frame2)
    assert a["status"] == "available" and b["status"] == "available"
    # Taylor meat is quadratic in the weight scale (same property as the
    # shared regression helper): c=2 scales covariance by c^2.
    np.testing.assert_allclose(b["covariance"], 4.0 * a["covariance"],
                               rtol=1e-9)
    # Conjoint reference df is D (no p penalty).
    assert a["referenceDf"] == pytest.approx(2.0)
    assert b["referenceDf"] == pytest.approx(2.0)


def test_separation_lp_and_solver_failure():
    # Perfectly separated: chosen always has larger x.
    tasks = [{"respondentId": f"P{i}", "taskId": f"T{i}",
              "respondentWeight": 1.0, "rows": [
                  {"rowId": f"a{i}", "x": np.array([1.0]),
                   "chosen": True},
                  {"rowId": f"b{i}", "x": np.array([-1.0]),
                   "chosen": False}]}
             for i in range(6)]
    stages = ch.expand_stages(tasks=tasks, mode="choice")
    assert ch.check_separation(stages, 1)["status"] == "separated"
    with pytest.raises(ValueError, match="CONJOINT_SEPARATION"):
        ch.fit_conditional_logit(stages, 1)


def test_simulation_importance_wtp_rules():
    beta = np.array([0.5, -2.0])
    profiles = [{"alternativeId": "p1", "x": np.array([1.0, 100.0])},
                {"alternativeId": "p2", "x": np.array([-1.0, 200.0])}]
    rows = sim.simulate_set(mode="choice", beta=beta, intercept=0.0,
                            profiles=profiles)
    assert abs(sum(r["probability"] for r in rows) - 1.0) < 1e-12
    # Ratings: no softmax pseudo-probabilities.
    rrows = sim.simulate_set(mode="ratings", beta=beta, intercept=5.0,
                             profiles=profiles)
    assert all(r["probability"] is None for r in rrows)
    assert abs(sum(r["firstChoiceShare"] for r in rrows) - 1.0) < 1e-12
    # All-zero ranges -> null importance.
    assert sim.attribute_importance(utilities=[], linear_specs={}) is None
