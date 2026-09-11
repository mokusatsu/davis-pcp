import itertools, math, json
import numpy as np
import pytest
import mpmath as mp
from . import oracles as o
pytestmark=pytest.mark.full


def frame_of(pl,X):
    return pl.DataFrame({'__rowId__':list(map(str,range(len(X)))),**{f'x{i}':X[:,i].tolist() for i in range(X.shape[1])}})

@pytest.mark.parametrize('seed',range(6))
def test_covariance_inverse_partial_correlation(target,pl,seed):
    rng=np.random.default_rng(seed);X=rng.integers(-20,20,(30,3)).astype(float)
    got=target.module('algorithms.statistics.covariance').compute_covariance(frame_of(pl,X),['x0','x1','x2'])
    # Independent pairwise sample covariance, not np.cov used by production.
    centered=X-X.mean(axis=0);S=centered.T@centered/(len(X)-1);P=np.linalg.inv(S)
    np.testing.assert_allclose(got['covariance'],S,atol=5.1e-6,rtol=0)
    np.testing.assert_allclose(got['precision'],P,atol=5.1e-6,rtol=0)
    corr=S/np.sqrt(np.outer(np.diag(S),np.diag(S)))
    np.testing.assert_allclose(got['correlation'],corr,atol=5.1e-5,rtol=0)
    partial=-P/np.sqrt(np.outer(np.diag(P),np.diag(P)));np.fill_diagonal(partial,1)
    np.testing.assert_allclose(got['partialCorrelation'],partial,atol=5.1e-5,rtol=0)

@pytest.mark.parametrize('use_corr',[False,True])
@pytest.mark.parametrize('seed',range(5))
def test_pca_eigh_spectrum_projector_scores_and_loadings(target,pl,use_corr,seed):
    rng=np.random.default_rng(seed);X=rng.integers(-8,9,(25,4)).astype(float);df=frame_of(pl,X)
    got=target.module('algorithms.models.pca').compute_pca(df,use_correlation=use_corr)
    Z=X-X.mean(axis=0)
    if use_corr:Z=Z/Z.std(axis=0,ddof=1)
    S=Z.T@Z/(len(Z)-1);e,V=np.linalg.eigh(S);e=e[::-1];V=V[:,::-1]
    np.testing.assert_allclose(got['eigenvalues'],e,atol=5.1e-6,rtol=0)
    np.testing.assert_allclose(got['explainedVarianceRatio'],e/e.sum(),atol=5.1e-5,rtol=0)
    actualV=np.array(got['eigenvectors']).T
    for j in range(4):np.testing.assert_allclose(np.outer(actualV[:,j],actualV[:,j]),np.outer(V[:,j],V[:,j]),atol=1.2e-6)
    scores=np.array([p['pc'] for p in got['scores']])
    np.testing.assert_allclose(scores@actualV.T,Z,atol=1e-4+1e-5*np.max(np.abs(Z)))
    L=np.array([got['loadings'][f'x{i}'] for i in range(4)])
    np.testing.assert_allclose(L,actualV*np.sqrt(e),atol=6e-5)
    assert got['nSamples']==25

@pytest.mark.contract
def test_pca_covariance_kaiser_threshold_independent_of_requested_components(target,pl):
    X=np.array([[i,i*i,(-1)**i] for i in range(1,13)],float);df=frame_of(pl,X)
    fn=target.module('algorithms.models.pca').compute_pca
    full=fn(df,use_correlation=False);truncated=fn(df,use_correlation=False,n_components=1)
    expected=np.trace((X-X.mean(0)).T@(X-X.mean(0))/(len(X)-1))/X.shape[1]
    assert full['kaiserThreshold']==pytest.approx(expected,abs=5.1e-5)
    assert truncated['kaiserThreshold']==pytest.approx(expected,abs=5.1e-5)

@pytest.mark.parametrize('algorithm',['pca','covariance','loess','fedf','logistic'])
def test_empty_selection_never_expands_to_all_data(target,pl,algorithm):
    from app.domain.errors import BizError
    df=pl.DataFrame({'__rowId__':list(map(str,range(10))),'x':[float(i) for i in range(10)],'y':[float(i*i) for i in range(10)],'binary':[i%2 for i in range(10)]})
    with pytest.raises((BizError,ValueError)):
        if algorithm=='pca':target.module('algorithms.models.pca').compute_pca(df,['x','y'],row_ids=[])
        elif algorithm=='covariance':target.module('algorithms.statistics.covariance').compute_covariance(df,['x','y'],row_ids=[])
        elif algorithm=='loess':target.module('algorithms.regression.loess').compute_loess(df,'x','y',row_ids=[])
        elif algorithm=='fedf':target.module('algorithms.distribution.fedf').compute_fedf(df,['x'],row_ids=[])
        else:target.module('algorithms.models.logistic').run_logistic_regression(df,'binary',['x'],active_row_ids=[])

@pytest.mark.parametrize('degree',[1,2])
@pytest.mark.parametrize('span',[.4,.7,1.])
def test_loess_reproduces_local_polynomial_and_residual_identity(target,pl,degree,span):
    x=np.linspace(-3,3,31);y=2+3*x+(x*x if degree==2 else 0)
    got=target.module('algorithms.regression.loess').compute_loess(pl.DataFrame({'x':x,'y':y}),'x','y',span=span,degree=degree)
    assert got['rSquared']==pytest.approx(1.,abs=5.1e-5)
    for point in got['points']:
        assert point['residual']==pytest.approx(0,abs=1.1e-5)
        assert point['y']-point['fitted']==pytest.approx(point['residual'],abs=1.1e-5)
    for point in got['curve']:
        # x and fitted are rounded to 5 decimals independently.
        assert point['fitted']==pytest.approx(2+3*point['x']+(point['x']**2 if degree==2 else 0),abs=6e-5)
    # Deliberately does NOT certify the approximate 95% confidence band.

@pytest.mark.parametrize('position',['blom','weisberg'])
def test_qqplot_normal_quantiles_independent_erfinv(target,pl,position):
    x=[5.,1.,9.,2.,8.,3.,7.,4.,6.]
    got=target.module('algorithms.summaries.qqplot').compute_qqplot(pl.DataFrame({'q':x}),'q',plotting_position=position)
    for i,p in enumerate(got['points'],1):
        probability=(i-.375)/(len(x)+.25) if position=='blom' else (i-.5)/len(x)
        expected=float(mp.sqrt(2)*mp.erfinv(2*mp.mpf(str(probability))-1))
        assert p['sampleValue']==sorted(x)[i-1]
        assert p['theoreticalQuantile']==pytest.approx(expected,abs=1e-12)
    assert got['referenceLine']['q1Sample']==o.quantile7(x,.25)
    assert got['referenceLine']['q3Sample']==o.quantile7(x,.75)


def test_fedf_declared_hazen_positions_and_folded_transform(target,pl):
    # FEDF currently specifies Hazen plotting positions, not the right-continuous ECDF.
    xs=[6.,1.,4.,2.,5.,3.];got=target.module('algorithms.distribution.fedf').compute_fedf(pl.DataFrame({'q':xs}),['q'])
    for i,value in enumerate(xs):
        rank=sorted(xs).index(value)+1;p=(rank-.5)/len(xs)
        c=got['rowCoords'][str(i)]['q']
        assert c['quantile']==pytest.approx(p,abs=5.1e-6)
        assert c['folded']==pytest.approx(1-2*abs(p-.5),abs=5.1e-6)
    for point in got['profiles']['q']['curve']:
        # curve quantile itself is rounded to 4 digits, hence interpolation tolerance
        assert point['val']==pytest.approx(o.quantile7(xs,point['quantile']),abs=.0003)


def orthogonal_data(pl,duplicate=False):
    pairs=list(itertools.product([-1.,1.],repeat=3))*3
    data={'x1':[r[0] for r in pairs],'x2':[r[1] for r in pairs],'z':[r[2] for r in pairs]}
    data['y']=[3*a+4*b for a,b,_ in pairs]
    if duplicate:data['copy']=list(data['x1'])
    return pl.DataFrame(data)


def test_shapley_lmg_orthogonal_analytic_36_64_zero(target,pl):
    got=target.module('algorithms.models.kda').run_kda(orthogonal_data(pl),'y',['x1','x2','z'])
    items={d['name']:d for d in got['drivers']}
    assert got['model']['r_squared']==pytest.approx(1.)
    for name,expected in [('x1',36.),('x2',64.),('z',0.)]:
        assert items[name]['importance_pct']==pytest.approx(expected,abs=.0051)
        assert items[name]['importance_raw']==pytest.approx(expected/100,abs=5.1e-5)
    assert sum(d['importance_raw'] for d in got['drivers'])==pytest.approx(1.,abs=.0002)
    assert got['what_if_baseline']['raw_slopes']['x1']==pytest.approx(3.)
    assert got['what_if_baseline']['raw_slopes']['x2']==pytest.approx(4.)


def test_shapley_duplicate_drivers_share_symmetrically(target,pl):
    got=target.module('algorithms.models.kda').run_kda(orthogonal_data(pl,True),'y',['x1','copy','x2'])
    d={v['name']:v['importance_pct'] for v in got['drivers']}
    assert d==pytest.approx({'x1':18.,'copy':18.,'x2':64.},abs=.0051)


def test_shapley_zero_explanatory_power_not_fabricated_100_percent(target,pl):
    df=orthogonal_data(pl)
    got=target.module('algorithms.models.kda').run_kda(df,'z',['x1','x2'])
    assert got['model']['r_squared']==0.
    assert all(d['importance_pct']==0 for d in got['drivers'])

@pytest.mark.contract
def test_shapley_approximation_does_not_reset_global_rng(target,pl):
    df=orthogonal_data(pl);fn=target.module('algorithms.models.kda').run_kda
    state=np.random.get_state()
    try:
        np.random.seed(987);expected=np.random.random(5)
        np.random.seed(987);fn(df,'y',['x1','x2','z'],max_exact_drivers=1,n_sample_permutations=30)
        np.testing.assert_array_equal(np.random.random(5),expected)
    finally:np.random.set_state(state)

@pytest.mark.parametrize('cutoff',[.3,.5,.8])
def test_logistic_analytic_two_group_binomial_fit(target,pl,cutoff):
    # x=0: 5/20 success; x=1: 15/20 success. Closed-form MLE, no optimizer oracle.
    x=[0.]*20+[1.]*20;y=[0]*15+[1]*5+[0]*5+[1]*15
    df=pl.DataFrame({'x':x,'y':y})
    got=target.module('algorithms.models.logistic').run_logistic_regression(df,'y',['x'],cutoff=cutoff)
    coef=got['coefficients']
    assert coef[0]['coefficient']==pytest.approx(math.log(1/3),abs=2e-5)
    assert coef[1]['coefficient']==pytest.approx(math.log(9),abs=2e-5)
    assert coef[1]['oddsRatio']==pytest.approx(9.,abs=.0002)
    # Inverse observed Fisher information analytic variances.
    assert coef[0]['stdError']==pytest.approx(math.sqrt(1/(20*.25*.75)),abs=2e-5)
    assert coef[1]['stdError']==pytest.approx(math.sqrt(2/(20*.25*.75)),abs=2e-5)
    probs=[.25]*20+[.75]*20
    ll=sum(v*math.log(p)+(1-v)*math.log(1-p) for v,p in zip(y,probs))
    assert got['fitMetrics']['logLikelihood']==pytest.approx(ll,abs=5.1e-5)
    assert got['fitMetrics']['aic']==pytest.approx(4-2*ll,abs=5.1e-5)
    assert got['fitMetrics']['bic']==pytest.approx(2*math.log(40)-2*ll,abs=5.1e-5)
    cm=got['confusionMatrix'];expected={'tp':0,'tn':0,'fp':0,'fn':0}
    for actual,p in zip(y,probs):expected[('t' if actual==int(p>=cutoff) else 'f')+('p' if p>=cutoff else 'n')]+=1
    for k,v in expected.items():assert cm[k]==v
    assert not got['diagnostics']['completeSeparation']
    for sample,p in zip(got['samples'],probs):assert sample['predictedProb']==pytest.approx(p,abs=1e-5)

@pytest.mark.contract
def test_singular_covariance_json_is_finite_or_explicitly_rejected(target,pl):
    from app.domain.errors import BizError
    df=pl.DataFrame({'x':[1.,2.,3.,4.],'copy':[1.,2.,3.,4.]})
    try:got=target.module('algorithms.statistics.covariance').compute_covariance(df)
    except BizError:return
    json.dumps(got,allow_nan=False)
