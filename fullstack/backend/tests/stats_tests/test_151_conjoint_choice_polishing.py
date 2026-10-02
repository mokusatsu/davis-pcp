"""Conditional-logit score convergence after L-BFGS objective early stopping."""
from __future__ import annotations

import math
from types import SimpleNamespace

import numpy as np
import pytest

from app.algorithms.models import conjoint_choice as ch


OPTIMUM = math.log(3) / 2
EARLY_STOP = OPTIMUM + 2e-6
FTOL_MESSAGE = "CONVERGENCE: RELATIVE REDUCTION OF F <= FACTR*EPSMCH"


def _stages(*, scale=1.0, weight=1.0):
    return ch.expand_stages(tasks=[
        {"respondentId": str(i), "taskId": "T", "respondentWeight": weight,
         "rows": [{"rowId": f"a{i}", "x": np.array([scale]), "chosen": i < 3},
                  {"rowId": f"b{i}", "x": np.array([-scale]), "chosen": i == 3}]}
        for i in range(4)
    ], mode="choice")


def _early_optimizer(monkeypatch, *, beta=EARLY_STOP, iterations=7,
                     success=True, message=FTOL_MESSAGE, fun=None):
    """Control only the optimizer's stop; use the real likelihood/derivatives."""
    def minimize(objective, initial, **kwargs):
        x = np.atleast_1d(beta).astype(float)
        return SimpleNamespace(x=x, fun=objective(x) if fun is None else fun,
                               nit=iterations, success=success, message=message)
    monkeypatch.setattr(ch, "minimize", minimize)


@pytest.mark.parametrize("scale,weight", [(1.0, 1.0), (1e3, 10.0), (1e-3, 0.1)])
def test_early_ftol_polishes_to_strict_score_with_original_units(monkeypatch, scale, weight):
    stages = _stages(scale=scale, weight=weight)
    _early_optimizer(monkeypatch)
    initial_score, _, _ = ch.stage_score_hessian(np.array([EARLY_STOP]), _stages())
    assert np.max(np.abs(initial_score)) / 4 > ch.SCORE_TOL

    fit = ch.fit_conditional_logit(stages, 1)

    assert fit["beta"][0] == pytest.approx(OPTIMUM / scale, rel=1e-10)
    assert fit["scoreInfNorm"] < 1e-10 < ch.SCORE_TOL
    assert fit["iterations"] == 8
    assert FTOL_MESSAGE in fit["optimizerMessage"]
    assert "Newton polish: 1 iteration(s)" in fit["optimizerMessage"]
    # All returned diagnostics and covariance must refer to the polished fit.
    score, information, _ = ch.stage_score_hessian(fit["beta"], stages)
    assert fit["logLikelihood"] == pytest.approx(ch.stage_loglik(fit["beta"], stages), abs=1e-12)
    assert fit["scoreInfNorm"] == pytest.approx(np.max(np.abs(score / fit["scales"])) / (4 * weight), abs=1e-14)
    np.testing.assert_allclose(fit["bread"], np.linalg.inv(information), rtol=1e-12)
    assert fit["bread"][0, 0] == pytest.approx(1 / (3 * weight * scale**2), rel=1e-10)


def test_converged_optimizer_needs_no_polishing(monkeypatch):
    _early_optimizer(monkeypatch, beta=OPTIMUM)
    monkeypatch.setattr(np.linalg, "solve", lambda *args: pytest.fail("unexpected polish"))
    fit = ch.fit_conditional_logit(_stages(), 1)
    assert fit["iterations"] == 7
    assert fit["optimizerMessage"] == FTOL_MESSAGE


def test_polishing_uses_full_multivariate_information(monkeypatch):
    design = [np.array([1.0, 0.0]), np.array([0.0, 1.0]), np.array([-1.0, -1.0])]
    choices = [0] * 4 + [1] * 3 + [2] * 2
    stages = ch.expand_stages(tasks=[
        {"respondentId": str(i), "taskId": "T",
         "rows": [{"rowId": f"{i}-{j}", "x": x, "chosen": j == chosen}
                  for j, x in enumerate(design)]}
        for i, chosen in enumerate(choices)
    ], mode="choice")
    log_counts = np.log([4.0, 3.0, 2.0])
    optimum = (log_counts - log_counts.mean())[:2]
    scales = ch.rms_scales(stages, 2)
    _early_optimizer(monkeypatch, beta=optimum * scales + [2e-6, -3e-6])

    fit = ch.fit_conditional_logit(stages, 2)

    np.testing.assert_allclose(fit["beta"], optimum, atol=1e-10, rtol=0)
    assert fit["iterations"] == 8
    assert fit["scoreInfNorm"] < 1e-10
    _, information, _ = ch.stage_score_hessian(fit["beta"], stages)
    assert abs(information[0, 1]) > 0.1
    np.testing.assert_allclose(fit["bread"], np.linalg.inv(information), rtol=1e-12)


def test_polishing_can_use_last_available_iteration(monkeypatch):
    _early_optimizer(monkeypatch)
    fit = ch.fit_conditional_logit(_stages(), 1, max_iterations=8)
    assert fit["iterations"] == 8
    assert fit["scoreInfNorm"] <= ch.SCORE_TOL


def test_polishing_cannot_exceed_exhausted_iteration_budget(monkeypatch):
    _early_optimizer(monkeypatch)
    monkeypatch.setattr(np.linalg, "solve", lambda *args: pytest.fail("budget exhausted"))
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1, max_iterations=7)


@pytest.mark.parametrize("beta", [OPTIMUM, EARLY_STOP])
@pytest.mark.parametrize("message", ["STOP: TOTAL NO. OF ITERATIONS REACHED LIMIT", "ABNORMAL"])
def test_optimizer_failure_is_not_accepted_or_polished(monkeypatch, beta, message):
    _early_optimizer(monkeypatch, beta=beta, success=False, message=message)
    monkeypatch.setattr(np.linalg, "solve", lambda *args: pytest.fail("optimizer failed"))
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1)


def test_actual_optimizer_iteration_limit_remains_failure():
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1, max_iterations=1)


@pytest.mark.parametrize("fun", [math.nan, math.inf, -math.inf])
def test_nonfinite_optimizer_objective_cannot_be_polished(monkeypatch, fun):
    _early_optimizer(monkeypatch, fun=fun)
    monkeypatch.setattr(np.linalg, "solve", lambda *args: pytest.fail("nonfinite objective"))
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1)


def test_newton_backtracks_and_recomputes_multiple_steps(monkeypatch):
    # From this finite but inaccurate stop the full Newton step worsens the
    # objective badly; backtracking is required before Newton can converge.
    stages = _stages()
    start = np.array([3.0])
    score, hessian, _ = ch.stage_score_hessian(start, stages)
    full_step = start + np.linalg.solve(hessian, score)
    assert ch.stage_loglik(full_step, stages) < ch.stage_loglik(start, stages)
    _early_optimizer(monkeypatch, beta=float(start[0]))
    observed_likelihoods = []
    original_evaluate = ch.stage_score_hessian

    def evaluate(beta, stages):
        observed_likelihoods.append(ch.stage_loglik(beta, stages))
        return original_evaluate(beta, stages)

    monkeypatch.setattr(ch, "stage_score_hessian", evaluate)
    fit = ch.fit_conditional_logit(stages, 1)
    assert fit["beta"][0] == pytest.approx(OPTIMUM, abs=1e-6)
    assert 8 < fit["iterations"] <= 7 + ch.MAX_POLISH_ITERATIONS
    assert np.all(np.diff(observed_likelihoods) >= -1e-13)


def test_multiple_steps_share_total_iteration_budget(monkeypatch):
    _early_optimizer(monkeypatch, beta=3.0)
    original_solve = np.linalg.solve
    calls = []

    def solve(*args):
        calls.append(1)
        return original_solve(*args)

    monkeypatch.setattr(np.linalg, "solve", solve)
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1, max_iterations=8)
    assert len(calls) == 1


def test_polishing_has_own_bounded_iteration_budget(monkeypatch):
    _early_optimizer(monkeypatch, beta=0.0)
    original_solve = np.linalg.solve
    calls = []

    def small_step(*args):
        calls.append(1)
        return 0.01 * original_solve(*args)

    monkeypatch.setattr(np.linalg, "solve", small_step)
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1, max_iterations=1000)
    assert len(calls) == ch.MAX_POLISH_ITERATIONS


@pytest.mark.parametrize("hessian", [0.0, -1.0, 1e-15, math.nan])
def test_invalid_information_prevents_polishing(monkeypatch, hessian):
    _early_optimizer(monkeypatch)
    monkeypatch.setattr(ch, "stage_score_hessian", lambda *args: (
        np.array([1e-5]), np.array([[hessian]]), {}))
    with pytest.raises(ValueError, match="^CONJOINT_INFORMATION_SINGULAR$"):
        ch.fit_conditional_logit(_stages(), 1)


def test_information_guard_still_applies_after_score_convergence(monkeypatch):
    _early_optimizer(monkeypatch, beta=OPTIMUM)
    monkeypatch.setattr(ch, "stage_score_hessian", lambda *args: (
        np.zeros(1), np.zeros((1, 1)), {}))
    with pytest.raises(ValueError, match="^CONJOINT_INFORMATION_SINGULAR$"):
        ch.fit_conditional_logit(_stages(), 1)


def test_newton_solve_failure_is_reported_as_invalid_information(monkeypatch):
    _early_optimizer(monkeypatch)

    def solve(*args):
        raise np.linalg.LinAlgError("singular information")

    monkeypatch.setattr(np.linalg, "solve", solve)
    with pytest.raises(ValueError, match="^CONJOINT_INFORMATION_SINGULAR$"):
        ch.fit_conditional_logit(_stages(), 1)


@pytest.mark.parametrize("direction", [0.0, -1.0, math.nan, math.inf])
def test_invalid_newton_direction_is_not_accepted(monkeypatch, direction):
    _early_optimizer(monkeypatch, beta=0.0)  # Positive score.
    monkeypatch.setattr(np.linalg, "solve", lambda *args: np.array([direction]))
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1)


def test_roundoff_likelihood_decrease_requires_score_progress(monkeypatch):
    _early_optimizer(monkeypatch)
    baseline = ch.stage_loglik(np.array([EARLY_STOP]), _stages())
    original_loglik = ch.stage_loglik
    first = True

    def rounded_loglik(beta, stages):
        nonlocal first
        if first:  # Supply the genuine optimizer objective.
            first = False
            return original_loglik(beta, stages)
        return baseline - 1e-14  # NLL worsens only within floating-point noise.

    monkeypatch.setattr(ch, "stage_loglik", rounded_loglik)
    fit = ch.fit_conditional_logit(_stages(), 1)
    assert fit["scoreInfNorm"] < 1e-10
    assert fit["iterations"] == 8


def test_roundoff_without_score_progress_is_bounded_failure(monkeypatch):
    _early_optimizer(monkeypatch)
    score, hessian, per_resp = ch.stage_score_hessian(np.array([EARLY_STOP]), _stages())
    monkeypatch.setattr(ch, "stage_loglik", lambda *args: -3.0)
    evaluations = []

    def unchanged_score(*args):
        evaluations.append(1)
        return score, hessian, per_resp

    monkeypatch.setattr(ch, "stage_score_hessian", unchanged_score)
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1)
    assert len(evaluations) == 1 + ch.MAX_POLISH_BACKTRACKS


def test_nonfinite_trial_likelihood_is_bounded_failure(monkeypatch):
    _early_optimizer(monkeypatch, fun=3.0)
    evaluations = []

    def nonfinite_loglik(*args):
        evaluations.append(1)
        return math.nan

    monkeypatch.setattr(ch, "stage_loglik", nonfinite_loglik)
    with pytest.raises(ValueError, match="^CONJOINT_NONCONVERGENCE$"):
        ch.fit_conditional_logit(_stages(), 1)
    assert len(evaluations) == ch.MAX_POLISH_BACKTRACKS


def test_design_rank_guard_precedes_optimizer(monkeypatch):
    monkeypatch.setattr(ch, "minimize", lambda *args, **kwargs: pytest.fail("rank guard bypassed"))
    stages = _stages()
    for stage in stages:
        for member in stage["members"]:
            member["x"] = np.repeat(member["x"], 2)
    with pytest.raises(ValueError, match="^CONJOINT_DESIGN_RANK_DEFICIENT$"):
        ch.fit_conditional_logit(stages, 2)


def test_separation_guard_precedes_optimizer(monkeypatch):
    monkeypatch.setattr(ch, "minimize", lambda *args, **kwargs: pytest.fail("separation guard bypassed"))
    stages = _stages()[:3]
    with pytest.raises(ValueError, match="^CONJOINT_SEPARATION$"):
        ch.fit_conditional_logit(stages, 1)


def test_separation_solver_failure_remains_failure(monkeypatch):
    monkeypatch.setattr(ch, "linprog", lambda *args, **kwargs: SimpleNamespace(status=4, fun=math.nan))
    with pytest.raises(ValueError, match="^CONJOINT_SEPARATION_CHECK_FAILED$"):
        ch.fit_conditional_logit(_stages(), 1)
