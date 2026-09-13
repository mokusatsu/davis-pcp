from pathlib import Path
import sys,json,copy
import numpy as np
import pytest
from numpy.testing import assert_allclose
from scipy import linalg,special,optimize
import statsmodels.api as sm
from statsmodels.discrete.conditional_models import ConditionalLogit
from reference_kernels import (ca,indicator,mca,benzecri,famd,ols,survey_meat,
                               fa_profile,ml_factor,varimax,promax,choice_objective,
                               separation,fit_choice)
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'contracts'))
from analysis_requests import REQUEST_MODELS, AnalysisContextV2

def mixed():
    data=np.genfromtxt(ROOT/'fixtures/mixed_survey.csv',delimiter=',',skip_header=1,usecols=range(1,7))
    Z,b=indicator(data[:,:3]);G,fb=indicator(data[:,:2])
    return data,Z,b,G,fb

def lr_data():
    d=np.genfromtxt(ROOT/'fixtures/linear_regression.csv',delimiter=',',skip_header=1,usecols=range(1,5))
    return np.column_stack((np.ones(len(d)),d[:,:2])),d[:,2],d[:,3].astype(int)

def cj_stages(repeated=False):
    X=np.array([[1.],[-1.]])
    return [(X,0 if i<3 else 1,i) for i in range(4) for _ in range(2 if repeated else 1)]

def test_ca_exact():
    r=ca([[30,10],[10,30]])
    assert_allclose(r['eigenvalues'],[.25],atol=1e-14)
    assert_allclose(np.abs(r['F']),.5,atol=1e-14)
    assert_allclose(r['total']*80,20,atol=1e-12)

def test_ca_scale_zero_margins_transpose():
    T=np.array([[8,2,3],[2,5,1],[4,3,6.]])
    a=ca(T);b=ca(17*T);c=ca(np.pad(T,((0,1),(0,1))))
    assert_allclose(a['F'],b['F'],atol=1e-12)
    assert_allclose(a['eigenvalues'],c['eigenvalues'],atol=1e-12)
    assert_allclose(a['eigenvalues'],ca(T.T)['eigenvalues'],atol=1e-12)

def test_ca_independence_rank_zero():
    assert len(ca([[10,20],[20,40]])['s'])==0

@pytest.mark.parametrize('weighted',[False,True])
def test_mca_indicator_ca_identity_and_trace(weighted):
    d,Z,_,_,_=mixed();w=d[:,-1] if weighted else np.ones(len(d))
    a=mca(Z,3,w);b=ca(w[:,None]*Z)
    assert_allclose(a['total'],(Z.shape[1]-3)/3,atol=1e-12)
    assert_allclose(a['eigenvalues'],b['eigenvalues'],atol=1e-12)
    assert_allclose(a['F']@a['F'].T,b['F']@b['F'].T,atol=1e-11)
    assert_allclose(Z.sum(1),3)
    assert not np.isclose((Z/(len(Z)*Z.shape[1])).sum(),1)

def test_mca_weight_scaling_and_frequency_expansion():
    d,Z,_,_,_=mixed();f=d[:,-1].astype(int)
    a=mca(Z,3,f);b=mca(Z,3,100*f);c=mca(np.repeat(Z,f,axis=0),3)
    assert_allclose(a['F'],b['F'],atol=1e-11)
    assert_allclose(a['eigenvalues'],c['eigenvalues'],atol=1e-12)

def test_mca_projection_contribution_and_cos2():
    d,Z,_,_,_=mixed();a=mca(Z,3,d[:,-1])
    projected=(Z/3-a['c'])@(a['V']/np.sqrt(a['c'][:,None]))
    assert_allclose(projected,a['F'],atol=1e-11)
    assert_allclose(np.sum(a['c'][:,None]*a['G']**2/a['eigenvalues'],axis=0),1,atol=1e-11)
    assert_allclose(np.sum(a['G']**2,axis=1),(1-a['p'])/a['p'],atol=1e-10)

def test_benzecri_boundary_and_zero():
    adj,ratio=benzecri([.5,1/3,.2],3)
    assert_allclose(adj,[.0625,0,0]);assert_allclose(ratio,[1,0,0])
    assert benzecri([1/3,.2],3)[1] is None

def test_famd_trace_scaling_projection():
    d,_,_,G,b=mixed();a=famd(d[:,3:5],G,b,d[:,-1])
    c=famd(d[:,3:5]*[100,.2]+[1000,-3],G,b,d[:,-1])
    assert_allclose(a['total'],2+sum(x.stop-x.start-1 for x in b),atol=1e-12)
    assert_allclose(a['F']@a['F'].T,c['F']@c['F'].T,atol=1e-10)
    newX=np.column_stack(((d[:,3:5]-a['mean'])/a['scale'],(G-a['p'])/np.sqrt(a['p'])))
    assert_allclose(newX@a['V'],a['F'],atol=1e-12)

def test_famd_barycenters_contributions_eta():
    d,_,_,G,b=mixed();a=famd(d[:,3:5],G,b,d[:,-1]);lam=a['eigenvalues']
    assert_allclose(a['bary'],a['V'][2:]*lam/np.sqrt(a['p'][:,None]),atol=1e-10)
    assert_allclose(a['contributions'].sum(0),1,atol=1e-12)
    assert (a['eta']>=-1e-12).all() and (a['eta']<=1+1e-10).all()
    wrong=(G-a['p'])/np.sqrt(a['p']*(1-a['p']))
    assert not np.isclose(np.sum(a['a'][:,None]*wrong**2),sum(x.stop-x.start-1 for x in b))

@pytest.mark.parametrize('covariance',['classical','hc3'])
def test_ols_matches_statsmodels(covariance):
    X,y,_=lr_data();got=ols(X,y,covariance=covariance)
    oracle=sm.OLS(y,X).fit(cov_type='nonrobust' if covariance=='classical' else 'HC3')
    assert_allclose(got['beta'],oracle.params,rtol=1e-12,atol=1e-12)
    assert_allclose(got['cov'],oracle.cov_params(),rtol=1e-10,atol=1e-12)

@pytest.mark.parametrize('covariance',['classical','hc3'])
def test_frequency_ols_expansion(covariance):
    X,y,f=lr_data();got=ols(X,y,f,covariance)
    ref=sm.OLS(np.repeat(y,f),np.repeat(X,f,axis=0)).fit(cov_type='nonrobust' if covariance=='classical' else 'HC3')
    assert_allclose(got['beta'],ref.params,rtol=1e-12,atol=1e-12)
    assert_allclose(got['cov'],ref.cov_params(),rtol=1e-10,atol=1e-12)

def test_rank_deficiency_rejected():
    with pytest.raises(ValueError):ols(np.ones((6,2)),np.arange(6.))

def test_survey_manual_meat_fpc_and_singleton():
    scores=np.array([[1,2],[3,1],[-2,1],[2,-1.]])
    strata=np.array(['A','A','B','B']);psu=np.array([1,2,1,2])
    meat,df=survey_meat(scores,strata,psu)
    assert_allclose(meat,[[20,-10],[-10,5]]);assert df==2
    meat,_=survey_meat(scores,strata,psu,{'A':4,'B':2})
    assert_allclose(meat,[[2,-1],[-1,.5]])
    with pytest.raises(ValueError):survey_meat(scores[:1],['A'],[1])
    assert_allclose(survey_meat(scores[:1],['A'],[1],{'A':1})[0],0)

def test_survey_domain_keeps_zero_psu():
    scores=np.array([[1,2],[0,0],[0,0],[0,0.]])
    got,df=survey_meat(scores,['A','A','B','B'],[1,2,1,2])
    assert_allclose(got,[[1,2],[2,4]]);assert df==2

def test_survey_weight_scaling_invariance():
    X,y,f=lr_data();base=ols(X,y,f)
    # Two strata with five independent PSUs each. Out-of-domain rows score zero.
    strata=np.repeat(['A','B'],5);psu=np.arange(10)
    u=(f*base['residual'])[:,None]*X;u[1]=0
    meat,_=survey_meat(u,strata,psu);V=base['bread']@meat@base['bread']
    scaled=ols(X,y,100*f);u2=(100*f*scaled['residual'])[:,None]*X;u2[1]=0
    m2,_=survey_meat(u2,strata,psu);V2=scaled['bread']@m2@scaled['bread']
    assert_allclose(V,V2,rtol=1e-10,atol=1e-12)

def factor_R():
    return np.loadtxt(ROOT/'fixtures/factor_expected_correlation.csv',delimiter=',',skiprows=1)

def test_factor_fixture_exact_correlation():
    X=np.genfromtxt(ROOT/'fixtures/factor_exact_correlation.csv',delimiter=',',skip_header=1,usecols=range(1,7))
    assert_allclose(np.corrcoef(X,rowvar=False),factor_R(),atol=1e-12)

def test_factor_ml_reconstruction():
    fit=ml_factor(factor_R(),2)
    assert fit['success'];assert abs(fit['objective'])<1e-9
    assert_allclose(fit['Sigma'],factor_R(),atol=2e-6)

def test_factor_profile_gradient():
    R=factor_R();psi=np.array([.3,.4,.45,.32,.42,.43])
    numerical=optimize._numdiff.approx_derivative(lambda z:np.array([fa_profile(z,R,2)[0]]),psi,method='3-point').reshape(-1)
    assert_allclose(fa_profile(psi,R,2)[1],numerical,rtol=1e-5,atol=2e-7)

def test_factor_rotations_preserve_covariance():
    L=ml_factor(factor_R(),2)['L'];Lv,T=varimax(L);Lp,Phi,Tp=promax(L)
    assert_allclose(Lv@Lv.T,L@L.T,atol=1e-11)
    assert_allclose(Lp@Phi@Lp.T,L@L.T,atol=1e-11)
    assert_allclose(np.diag(Phi),1,atol=1e-12)
    assert_allclose(L@Tp,Lp,atol=1e-12)

def test_factor_scores_oblique_transform():
    R=factor_R();fit=ml_factor(R,2);L=fit['L'];Lp,Phi,T=promax(L)
    X=np.genfromtxt(ROOT/'fixtures/factor_exact_correlation.csv',delimiter=',',skip_header=1,usecols=range(1,7))
    Z=(X-X.mean(0))/X.std(0,ddof=1)
    original=Z@linalg.solve(R,L,assume_a='pos')
    rotated=Z@linalg.solve(R,Lp,assume_a='pos')@Phi
    assert_allclose(rotated,original@linalg.inv(T).T,atol=1e-10)

def test_choice_analytic_and_primary_oracle():
    stages=cj_stages();fit=fit_choice(stages,np.ones(4))
    assert_allclose(fit['beta'],[np.log(3)/2],atol=1e-8)
    assert_allclose(fit['H'],[[3]],atol=1e-8)
    assert_allclose(fit['cov'],[[4/9]],atol=1e-8)
    X=np.vstack([s[0] for s in stages]);y=np.concatenate([np.eye(2)[s[1]] for s in stages])
    groups=np.repeat(np.arange(4),2)
    oracle=ConditionalLogit(y,X,groups=groups).fit(disp=False,gtol=1e-10)
    assert_allclose(fit['beta'],oracle.params,atol=1e-6)

def test_choice_respondent_clustering_not_stage_independence():
    fit=fit_choice(cj_stages(True),np.ones(4))
    assert_allclose(fit['H'],[[6]],atol=1e-8)
    assert_allclose(fit['cov'],[[4/9]],atol=1e-8)

def test_choice_frequency_respondent_block_expansion():
    stages=cj_stages(True);freq=np.array([2,1,3,2]);got=fit_choice(stages,freq)
    expanded=[];new_id=0
    for r in range(4):
        for _ in range(freq[r]):
            expanded.extend((X,c,new_id) for X,c,rid in stages if rid==r);new_id+=1
    ref=fit_choice(expanded,np.ones(new_id))
    assert_allclose(got['beta'],ref['beta'],atol=1e-8)
    assert_allclose(got['cov'],ref['cov'],atol=1e-8)

def test_choice_separation_lp_and_shift_invariance():
    X=np.array([[1.],[-1.]])
    assert separation([(X,0,i) for i in range(4)])
    beta=np.array([.7]);stages=cj_stages()
    a=choice_objective(beta,stages,np.ones(4))
    b=choice_objective(beta,[(X+10,c,r) for X,c,r in stages],np.ones(4))
    assert_allclose(a[0],b[0],atol=1e-12);assert_allclose(a[1],b[1],atol=1e-12)

def test_ranking_stage_likelihood():
    X=np.array([[1.,0],[0,1],[-1,-1]]);beta=np.array([.3,-.2]);order=[0,2,1]
    stages=[(X,0,0),(X[[1,2]],1,0)]
    val=choice_objective(beta,stages,[1])[0]
    prob0=np.exp((X@beta)[0]-special.logsumexp(X@beta))
    prob1=np.exp((X@beta)[2]-special.logsumexp((X@beta)[[1,2]]))
    assert_allclose(np.exp(-val),prob0*prob1,atol=1e-14)

@pytest.mark.parametrize('name',list(REQUEST_MODELS))
def test_contract_examples(name):
    path=ROOT/'contracts/examples'/f'{name}.request.json'
    REQUEST_MODELS[name].model_validate_json(path.read_text())

def test_contract_rejects_scope_revision_and_type_conflicts():
    base={'datasetId':'d','expectedDataRevision':1,'expectedSchemaRevision':1,'scope':'all','weightMode':'none'}
    for updates in ({'scope':'selected'}, {'expectedDataRevision':True}, {'rowIds':[]},
                    {'weightColumn':'w'},{'weightMode':'column'}, {'missingPolicy':'impute_mean'}):
        with pytest.raises(ValueError):AnalysisContextV2.model_validate({**base,**updates})
    got=AnalysisContextV2.model_validate({**base,'scope':'selected','selectedRowIds':[]})
    assert got.selectedRowIds==[]

def test_contract_rejects_invalid_models():
    for name,modify in [
        ('ca',lambda d:d['input'].update(columnVariable=d['input']['rowVariable'])),
        ('mca',lambda d:d.update(variables=['q1','q1'])),
        ('famd',lambda d:d.update(categoricalVariables=d['numericVariables'])),
        ('factor_analysis',lambda d:d.update(method='pca')),
        ('factor_analysis',lambda d:d.update(nFactors=5)),
        ('conjoint',lambda d:d.update(ratingEffects='respondent_fixed')),
        ('linear_regression',lambda d:d.update(interactions=[['quality','unknown']]))]:
        d=json.loads((ROOT/'contracts/examples'/f'{name}.request.json').read_text());modify(d)
        with pytest.raises(ValueError):REQUEST_MODELS[name].model_validate(d)
