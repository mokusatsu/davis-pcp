import json, math
from pathlib import Path
import numpy as np
import pytest
from . import oracles as o

FIX=json.loads((Path(__file__).parent/'nist_univariate.json').read_text())

@pytest.mark.parametrize('case',FIX['datasets'],ids=lambda c:c['name'])
def test_nist_certified_mean_and_sample_sd(target,case):
    values=np.array([float(v) for v in case['values']])
    got=target.module('algorithms.summaries.core').numeric_summary(values)
    assert got['count']==case['n']
    assert got['mean']==pytest.approx(float(case['mean']),rel=0,abs=case['mean_atol'])
    assert got['std']==pytest.approx(float(case['sd']),rel=case['sd_rtol'],abs=1e-15)

@pytest.mark.parametrize('values',[[1,2,3,4],[1,1,1,8,9],[9,2,-3,8,8,7],[-8,-2,0,9,12]])
def test_quantile_type7_and_ddof_one(target,values):
    got=target.module('algorithms.summaries.core').numeric_summary(np.array(values,dtype=float))
    for key,p in [('q1',.25),('median',.5),('q3',.75)]:
        assert got[key]==pytest.approx(o.quantile7(values,p),abs=1e-14)
    assert got['std']**2==pytest.approx(o.mean_variance(values)[1],rel=1e-13)

@pytest.mark.parametrize('seed',range(10))
def test_numeric_row_permutation_and_affine_invariants(target,seed):
    rng=np.random.default_rng(seed);x=rng.integers(-500,500,35).astype(float)
    fn=target.module('algorithms.summaries.core').numeric_summary
    a=fn(x);b=fn(x[rng.permutation(len(x))]);c=fn(3*x+17)
    for key in ['mean','std','q1','median','q3','iqr']:assert a[key]==pytest.approx(b[key],abs=1e-11)
    assert c['mean']==pytest.approx(3*a['mean']+17)
    assert c['std']==pytest.approx(3*a['std'])
    assert c['iqr']==pytest.approx(3*a['iqr'])

def test_nan_missing_and_empty(target):
    fn=target.module('algorithms.summaries.core').numeric_summary
    got=fn(np.array([1.,3.,np.nan]));assert got['count']==2 and got['missing']==1
    assert got['mean']==2.
    empty=fn(np.array([np.nan,np.nan]));assert empty['count']==0
    assert empty.get('mean') is None

@pytest.mark.contract
@pytest.mark.parametrize('bad',[np.inf,-np.inf])
def test_nonfinite_input_must_be_rejected_or_excluded_not_return_nan(target,bad):
    fn=target.module('algorithms.summaries.core').numeric_summary
    try:got=fn(np.array([1.,2.,bad]))
    except (ValueError,OverflowError,target.module('domain.errors').BizError):return
    assert got['count']==2, 'Infinity must not be counted as a valid survey response.'
    assert got['mean']==pytest.approx(1.5)
    assert math.isfinite(got['std'])
