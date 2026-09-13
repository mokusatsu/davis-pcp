"""Feature 032 linear regression kernel tests."""
from __future__ import annotations
import json
import math
from pathlib import Path
import numpy as np
import pytest
from scipy import linalg, stats
from app.algorithms.models.linear_regression import *
from app.algorithms.models.linear_regression import solve_weighted_least_squares as _solve
from app.algorithms.models.linear_regression import classical_covariance as _cc
from app.algorithms.models.linear_regression import hc3_covariance as _hc3
from app.algorithms.models.linear_regression import fit_statistics as _fit
from app.algorithms.models.linear_regression import gaussian_loglik_aic_bic as _aic
TOL = dict(rtol=1e-9, atol=1e-10)
FIX = Path(__file__).parent / ".." / ".." / ".." / ".." / "feature" / "analysis-specs" / "fixtures"
def _lr():
    rows = [l.rstrip(chr(10)).split(",") for l in open(FIX / "linear_regression.csv", encoding="utf-8")]
    d = rows[1:]
    X = __import__("numpy").column_stack([[1.0]*10, [float(r[1]) for r in d], [float(r[2]) for r in d]])
    y = __import__("numpy").array([float(r[3]) for r in d])
    f = __import__("numpy").array([float(r[4]) for r in d])
    return X, y, f
def _exp(): return json.loads(open(FIX / "expected_values.json", encoding="utf-8").read())
def test_lr01_ols_classical_matches_oracle():
    import numpy as _np
    X, y, f = _lr(); exp = _exp()["linear_classical"]
    sol = _solve(X, y, f)
    _np.testing.assert_allclose(sol["beta"], _np.array(exp["beta"]), **TOL)
    _np.testing.assert_allclose(sol["bread"], _np.array(exp["bread"]), **TOL)
    assert sol["sse"] == pytest.approx(exp["sse"], rel=1e-9, abs=1e-10)
    cov, s2v = _cc(sol["sse"], float(f.sum()), 3, sol["bread"])
    _np.testing.assert_allclose(cov, _np.array(exp["cov"]), **TOL)
    _np.testing.assert_allclose(sol["residual"], _np.array(exp["residual"]), **TOL)
def test_lr02_hc3_matches_oracle():
    import numpy as _np
    X, y, f = _lr(); exp = _exp()["linear_hc3"]
    sol = _solve(X, y, f)
    cov, h0, bad = _hc3(X, sol["residual"], f, sol["bread"])
    _np.testing.assert_allclose(cov, _np.array(exp["cov"]), **TOL)
    assert bad == []
def test_lr03_frequency_expansion_equivalence():
    import numpy as _np
    X, y, f = _lr()
    sol = _solve(X, y, f)
    Xe = _np.repeat(X, f.astype(int), axis=0); ye = _np.repeat(y, f.astype(int))
    se = _solve(Xe, ye, None)
    _np.testing.assert_allclose(se["beta"], sol["beta"], **TOL)
    assert se["sse"] == pytest.approx(sol["sse"], rel=1e-9, abs=1e-10)
    ce, _ = _cc(se["sse"], float(f.sum()), 3, se["bread"])
    c0, _ = _cc(sol["sse"], float(f.sum()), 3, sol["bread"])
    _np.testing.assert_allclose(ce, c0, **TOL)
    he, _, _ = _hc3(Xe, se["residual"], None, se["bread"])
    hf, _, _ = _hc3(X, sol["residual"], f, sol["bread"])
    _np.testing.assert_allclose(he, hf, **TOL)
def test_lr04_rank_deficient_and_leverage_one():
    import numpy as _np
    X = _np.column_stack([[1.0]*5, [1.0]*5, [2.0]*5])
    y = _np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    try: _solve(X, y, None)
    except ValueError as e: assert str(e) == "LR_RANK_DEFICIENT"
    else: raise AssertionError("rank deficient not raised")
    X2 = _np.array([[1.0, 0.0], [1.0, 0.0], [1.0, 10.0]])
    y2 = _np.array([1.0, 1.0, 2.0])
    s2 = _solve(X2, y2, None)
    assert s2["rank"] == 2
def test_lr05_fit_aic_and_r2_types():
    import numpy as _np
    X, y, f = _lr()
    sol = _solve(X, y, f)
    st = _fit(y, f, sol["sse"], True, float(f.sum()), 3)
    assert st["rSquaredType"] == "centered"
    assert 0.0 < st["rSquared"] < 1.0
    assert st["adjustedRSquared"] < st["rSquared"]
    assert st["residualDf"] == pytest.approx(float(f.sum()) - 3, rel=1e-9, abs=1e-10)
    like = _aic(sol["sse"], float(f.sum()), 3)
    assert like["kAic"] == 4
    assert like["aic"] is not None and like["bic"] is not None
    st0 = _fit(y, f, sol["sse"], False, float(f.sum()), 3)
    assert st0["rSquaredType"] == "uncentered"
    z = _aic(0.0, 10.0, 3)
    assert z["logLikelihood"] is None and z["aic"] is None and z["bic"] is None
def test_lr06_survey_taylor_two_strata():
    import numpy as _np
    from app.algorithms.survey.model_covariance import build_regression_design_frame as _bd, taylor_model_covariance as _tm
    rng = _np.random.default_rng(7)
    n = 24
    x = rng.normal(0, 1, n); g = _np.array([0, 1]*(n//2))
    X = _np.column_stack([_np.ones(n), x, g])
    y = 1.0 + 2.0*x - 0.5*g + rng.normal(0, 0.5, n)
    w = _np.array([1.0, 1.5, 2.0, 0.5]*6)
    sol = _solve(X, y, w)
    resid = y - X.dot(sol["beta"])
    strata = ["h1"]*12 + ["h2"]*12
    psu = (["a","b","c"]*4)[:12] + (["d","e","f"]*4)[:12]
    df = _bd(row_ids=[str(i) for i in range(n)], weights=list(w), strata=strata, psu=psu, fpc=None)
    scores = (w*resid)[:, None]*X
    out = _tm(design_frame=df, scores=scores, bread=sol["bread"], n_params=3, intercept=True)
    assert out["status"] == "available"
    assert out["designDf"] == 4
    assert out["referenceDf"] == pytest.approx(4 - (3-1), rel=1e-9, abs=1e-10)
    df2 = _bd(row_ids=[str(i) for i in range(n)], weights=list(w*100.0), strata=strata, psu=psu, fpc=None)
    out2 = _tm(design_frame=df2, scores=(w*100.0*resid)[:, None]*X, bread=sol["bread"]/100.0, n_params=3, intercept=True)
    _np.testing.assert_allclose(_np.array(out2["covariance"]), _np.array(out["covariance"]), **TOL)
def test_lr07_singleton_and_fpc_rules():
    import numpy as _np
    from app.algorithms.survey.model_covariance import build_regression_design_frame as _bd, taylor_model_covariance as _tm
    X = _np.column_stack([_np.ones(6), _np.arange(6, dtype=float)])
    y = _np.array([1.0, 2.0, 1.5, 3.0, 2.5, 4.0])
    sol = _solve(X, y, None)
    resid = y - X.dot(sol["beta"])
    df = _bd(row_ids=[str(i) for i in range(6)], weights=[1.0]*6, strata=["h1"]*3+["h2"]*3, psu=["a","a","b","c","c","d"], fpc=None)
    scores = resid[:, None]*X
    out = _tm(design_frame=df, scores=scores, bread=sol["bread"], n_params=2, intercept=True)
    assert out["status"] == "available"
    dfc = _bd(row_ids=[str(i) for i in range(6)], weights=[1.0]*6, strata=["h1"]*3+["h2"]*3, psu=["a","a","b","c","c","d"], fpc=[2.0]*3+[3.0]*3)
    outc = _tm(design_frame=dfc, scores=scores, bread=sol["bread"], n_params=2, intercept=True)
    assert outc["status"] == "available"
    dfs = _bd(row_ids=[str(i) for i in range(4)], weights=[1.0]*4, strata=["h1"]*4, psu=["a","a","a","a"], fpc=None)
    Xs = _np.column_stack([_np.ones(4), _np.arange(4, dtype=float)])
    ss = _solve(Xs, _np.array([1.0,2.0,3.0,4.0]), None)
    outs = _tm(design_frame=dfs, scores=(Xs[:,1]*0+1)[:,None]*_np.ones((4,2)), bread=ss["bread"], n_params=2, intercept=True)
    assert outs["status"] == "unavailable" and outs["reason"] == "SINGLETON_PSU_WITHOUT_CERTAINTY"
def test_lr08_vif_qq_and_diagnostics():
    import numpy as _np
    from app.algorithms.models.linear_regression import weighted_vif as _vif, qq_positions as _qq, non_survey_diagnostics as _dg
    X, y, f = _lr()
    sol = _solve(X, y, f)
    ids = ["a", "b", "c"]
    v = _vif(X, f, True, ids)
    assert len(v) == 2 and all(r["status"] == "available" for r in v)
    q = _qq(sol["residual"], None)
    assert q["kind"] == "uniform" and len(q["position"]) == 10
    qf = _qq(sol["residual"], f)
    assert qf["kind"] == "weighted_mid_cdf"
    cov, s2v = _cc(sol["sse"], float(f.sum()), 3, sol["bread"])
    d = _dg(X, sol["residual"], f, sol["bread"], s2v, 3)
    assert len(d["leveragePerReplica"]) == 10 and len(d["leverageTotal"]) == 10
    assert d["studentizedResidual"][0] is not None and d["cooksDistance"][0] is not None
