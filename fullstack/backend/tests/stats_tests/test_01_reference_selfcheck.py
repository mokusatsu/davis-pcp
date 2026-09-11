"""First validate the independent oracles, without importing production functions."""
import pytest
import numpy as np
from . import oracles as o

@pytest.mark.parametrize('table,chi,p',[
 ([[10,10,20],[20,20,20]],25/9,0.24935220877729619),
 ([[10,10],[10,10]],0,1),
 ([[10,0],[0,10]],20,7.744216431044088e-6),
])
def test_published_chi2_and_exact_special_cases(table,chi,p):
    x,df,_=o.pearson(table)
    assert x==pytest.approx(chi,rel=1e-14,abs=1e-14)
    assert o.chi2_sf(x,df)==pytest.approx(p,rel=1e-12)

@pytest.mark.parametrize('table,p',[
 ([[1,9],[11,3]],0.0027594561852200836),
 ([[6,2],[1,4]],0.10256410256410256),
 ([[1,1],[1,1]],1.),
])
def test_exact_fisher_reference(table,p):
    assert o.fisher_probability_ordered(table)==pytest.approx(p,abs=1e-15)

def test_bh_known_values():
    assert o.bh([.01,.04,.03,.002,.5])==pytest.approx([.025,.05,.05,.01,.5])

def test_welch_two_group_anova_equals_squared_t():
    # Algebraic identity cross-check, independent of production and SciPy.
    a=[1,2,3,4,5];b=[2,5,8,11,14,17]
    two=o.welch(a,b); multi=o.welch_anova([a,b])
    assert multi['statistic']==pytest.approx(two['statistic']**2,rel=1e-13)
    assert multi['df2']==pytest.approx(two['df'],rel=1e-13)
    assert multi['p']==pytest.approx(two['p'],rel=1e-13)

def test_survey_mean_variance_equals_sample_variance_over_n():
    xs=[1,2,4,7,11]
    V=o.survey_mean_covariance([[x] for x in xs],[1]*len(xs))
    assert float(V[0,0])==pytest.approx(o.mean_variance(xs)[1]/len(xs),rel=1e-14)
