import csv
from pathlib import Path
import numpy as np
import pytest
from . import oracles as o

DATA=list(csv.DictReader((Path(__file__).parent/'survey_synthetic.csv').read_text().splitlines()))
ROW=np.array([int(x['row']) for x in DATA]);COL=np.array([int(x['col']) for x in DATA])
W=np.array([float(x['weight']) for x in DATA])
STRATA=np.array([x['stratum'] for x in DATA],object);PSU=np.array([x['psu'] for x in DATA],object)
FPC=np.array([float(x['fpc']) for x in DATA])
X=np.array([[float(x['x']),float(x['y'])] for x in DATA])

def table_of(row,col,w):
    return np.array([[sum(w[i] for i in range(len(w)) if row[i]==r and col[i]==c) for c in range(max(col)+1)] for r in range(max(row)+1)])

@pytest.mark.parametrize('weights',[[1,1,1,1],[1,9],[0,1,3,7],[.1,.2,.3,.4],[1,5,20,100]])
@pytest.mark.parametrize('scale',[.001,1.,1000.])
def test_kish_ess_deff_and_sample_cv(target,weights,scale):
    w=np.array(weights)*scale;got=target.module('algorithms.survey.diagnostics').weight_diagnostics(w)
    q=list(map(o.q,w));ess=float(sum(q)**2/sum(v*v for v in q));pos=w[w>0]
    assert got['weightSum']==pytest.approx(sum(w))
    assert got['kishEffectiveN']==pytest.approx(ess,rel=1e-12)
    assert got['weightingDeff']==pytest.approx(len(pos)/ess,rel=1e-12)
    assert got['positiveWeightN']==len(pos)
    assert got['weightingDeff']==pytest.approx(1+(len(pos)-1)/len(pos)*got['weightCv']**2,rel=1e-12)

@pytest.mark.parametrize('weights',[[None,None],[0,0,0]])
def test_no_positive_weight_no_effective_n(target,weights):
    got=target.module('algorithms.survey.diagnostics').weight_diagnostics(weights)
    assert got['kishEffectiveN'] is None
    assert got['positiveWeightN']==0

@pytest.mark.parametrize('kind',['independent','cluster','stratified','fpc'])
def test_taylor_mean_covariance_independent_high_precision(target,kind):
    st=STRATA if kind in ['stratified','fpc'] else None
    ps=PSU if kind!='independent' else None
    fpc=FPC if kind=='fpc' else None
    design=target.module('algorithms.survey.design').build_design(W,st,ps,fpc)
    actual=target.module('algorithms.survey.covariance').mean_covariance(X,design)
    expected=np.array(o.survey_mean_covariance(X,W,st,ps,fpc).tolist(),float)
    np.testing.assert_allclose(actual,expected,rtol=1e-11,atol=1e-13)
    np.testing.assert_allclose(actual,actual.T,atol=1e-13)
    assert min(np.linalg.eigvalsh(actual))>=-1e-12

@pytest.mark.parametrize('kind',['independent','cluster','stratified','fpc'])
@pytest.mark.parametrize('scale',[.001,1.,1000.])
def test_rao_scott_against_different_contrast_high_precision_oracle(target,kind,scale):
    st=STRATA if kind in ['stratified','fpc'] else None
    ps=PSU if kind!='independent' else None
    fpc=FPC if kind=='fpc' else None
    design=target.module('algorithms.survey.design').build_design(W*scale,st,ps,fpc)
    got=target.module('algorithms.survey.rao_scott').rao_scott_test(table_of(ROW,COL,W*scale),ROW,COL,design)
    expected=o.rao_scott(ROW.tolist(),COL.tolist(),W.tolist(),None if st is None else st.tolist(),None if ps is None else ps.tolist(),None if fpc is None else fpc.tolist())
    assert got is not None
    assert got.statistic==pytest.approx(expected['statistic'],rel=2e-10,abs=1e-12)
    assert got.numerator_df==pytest.approx(expected['df1'],rel=2e-10)
    assert got.denominator_df==pytest.approx(expected['df2'],rel=2e-10)
    assert got.p_value==pytest.approx(expected['p'],rel=2e-9,abs=1e-13)

@pytest.mark.parametrize('seed',range(6))
def test_rao_scott_row_and_category_permutations(target,seed):
    rng=np.random.default_rng(seed);order=rng.permutation(len(W))
    fn=target.module('algorithms.survey.rao_scott').rao_scott_test
    bd=target.module('algorithms.survey.design').build_design
    a=fn(table_of(ROW,COL,W),ROW,COL,bd(W,STRATA,PSU))
    r=1-ROW[order];c=np.array([2,0,1])[COL[order]];w=W[order]
    b=fn(table_of(r,c,w),r,c,bd(w,STRATA[order],PSU[order]))
    for key in ['statistic','numerator_df','denominator_df','p_value']:
        assert getattr(a,key)==pytest.approx(getattr(b,key),rel=1e-10,abs=1e-12)

@pytest.mark.parametrize('r,c',[(2,2),(2,3),(3,2),(3,4),(4,4)])
def test_interaction_contrasts_are_correct_subspace(target,r,c):
    C=target.module('algorithms.survey.rao_scott').independence_contrasts(r,c)
    assert C.shape==(r*c,(r-1)*(c-1))
    assert np.linalg.matrix_rank(C)==(r-1)*(c-1)
    np.testing.assert_allclose(C.sum(axis=0),0,atol=1e-12)
    for row in range(r):np.testing.assert_allclose(C[row*c:(row+1)*c].sum(axis=0),0,atol=1e-12)
    for col in range(c):np.testing.assert_allclose(C[col::c].sum(axis=0),0,atol=1e-12)

def test_design_degrees_of_freedom_and_fpc(target):
    bd=target.module('algorithms.survey.design').build_design
    independent=bd(W);cluster=bd(W,STRATA,PSU);finite=bd(W,STRATA,PSU,FPC)
    assert independent.design_df==len(W)-1
    assert cluster.design_df==12-3
    assert independent.approximate and not cluster.approximate
    fn=target.module('algorithms.survey.covariance').mean_covariance
    np.testing.assert_allclose(fn(X,finite),fn(X,cluster)*.5,rtol=1e-12)

@pytest.mark.contract
def test_strata_without_explicit_psu_must_not_disappear(target):
    bd=target.module('algorithms.survey.design').build_design
    try:design=bd(W,strata=STRATA)
    except (ValueError,target.module('domain.errors').BizError):return
    assert design.number_of_strata==3, 'Preserve supplied strata using row PSUs, or reject unsupported design.'
    actual=target.module('algorithms.survey.covariance').mean_covariance(X,design)
    expected=np.array(o.survey_mean_covariance(X,W,STRATA).tolist(),float)
    np.testing.assert_allclose(actual,expected,rtol=1e-11)

@pytest.mark.contract
def test_psu_ids_reused_across_strata_must_be_nested_or_rejected(target):
    bd=target.module('algorithms.survey.design').build_design
    nested_ids=np.array([p[-2:] for p in PSU],object)
    try:design=bd(W,STRATA,nested_ids)
    except (ValueError,target.module('domain.errors').BizError):return
    assert design.design_df==9, 'R requires unique cross-stratum PSU ids or explicit nesting; df=1 is not an acceptable silent interpretation.'

@pytest.mark.contract
def test_fpc_without_explicit_psu_not_silently_discarded(target):
    bd=target.module('algorithms.survey.design').build_design
    try:design=bd(W,fpc=np.full(len(W),len(W)*2))
    except (ValueError,target.module('domain.errors').BizError):return
    fn=target.module('algorithms.survey.covariance').mean_covariance
    np.testing.assert_allclose(fn(X,design),fn(X,bd(W))*.5,rtol=1e-11,
                               err_msg='Supplied FPC must either apply or be explicitly rejected.')
