import math
import numpy as np
import pytest
from . import oracles as o

TABLES=[[[10,10,20],[20,20,20]],[[1,9],[11,3]],[[5,10,15],[20,7,4]],[[10,0],[0,10]],[[10,10],[10,10]],[[0,0,0],[1,3,0],[7,2,0]]]

@pytest.mark.parametrize('table',TABLES)
def test_pearson_uncorrected_and_cramers_v_exact(target,table):
    expected,df,V=o.pearson(table)
    result=target.module('algorithms.summaries.inference').unweighted_inference(np.array(table))
    assert result.statistic==pytest.approx(expected,rel=1e-12,abs=1e-13)
    assert result.numerator_df==df
    assert result.p_value==pytest.approx(o.chi2_sf(expected,df),rel=1e-11,abs=1e-15)
    assoc=target.module('algorithms.summaries.association').descriptive_association(np.array(table),weighted=False)
    assert assoc['cramersV']==pytest.approx(V,rel=1e-12,abs=1e-13)
    assert assoc['weightedCramersV'] is None

@pytest.mark.parametrize('table',TABLES)
@pytest.mark.parametrize('scale',[.01,3,100])
def test_descriptive_v_scale_transpose_and_category_permutation(target,table,scale):
    fn=target.module('algorithms.summaries.association').descriptive_association
    a=np.array(table,dtype=float)
    expected=o.pearson(a.tolist())[2]
    for matrix in [a*scale,a[::-1,::-1]*scale,a.T*scale]:
        got=fn(matrix,weighted=True)
        assert got['weightedCramersV']==pytest.approx(expected,abs=1e-12)
        assert got['cramersV'] is None

@pytest.mark.parametrize('table',[[[6,2],[1,4]],[[1,9],[11,3]],[[0,4],[7,2]],[[10,10],[10,10]]])
def test_fisher_exact_probability_ordering(target,table):
    got=target.module('algorithms.summaries.inference').unweighted_inference(np.array(table),method='fisher_exact')
    assert got.p_value==pytest.approx(o.fisher_probability_ordered(table),rel=1e-12,abs=1e-15)

@pytest.mark.parametrize('scale',[2,5,100])
def test_frequency_weights_intentionally_increase_evidence(target,scale):
    m=target.module('algorithms.summaries.inference');table=np.array([[2,6],[8,3]])
    a=m.frequency_inference(table);b=m.frequency_inference(table*scale)
    assert b.statistic==pytest.approx(scale*a.statistic)
    assert b.p_value<a.p_value

@pytest.mark.parametrize('requested,kind,has_weight,expected',[
 ('auto',None,False,'pearson'),('auto','survey',True,'none'),('auto','frequency',True,'pearson'),
 ('auto','survey',False,'pearson'),('none','survey',True,'none'),('rao_scott','survey',True,'rao_scott'),
 ('pearson','frequency',True,'pearson'),('fisher_exact',None,False,'fisher_exact')])
def test_inference_dispatch(target,requested,kind,has_weight,expected):
    assert target.module('algorithms.summaries.inference').resolve_inference(requested,kind,has_weight)==expected

@pytest.mark.parametrize('requested,kind,has_weight',[
 ('pearson','survey',True),('fisher_exact','survey',True),('fisher_exact','frequency',True),
 ('rao_scott','frequency',True),('rao_scott',None,False),('banana',None,False)])
def test_invalid_statistical_method_is_not_silently_substituted(target,requested,kind,has_weight):
    from app.domain.errors import BizError
    with pytest.raises(BizError):target.module('algorithms.summaries.inference').resolve_inference(requested,kind,has_weight)

@pytest.mark.parametrize('table',[[[0,0],[0,0]],[[1,2]],[[0,1],[0,4]]])
def test_degenerate_table_is_unavailable_not_p_one(target,table):
    got=target.module('algorithms.summaries.inference').unweighted_inference(np.array(table))
    assert got.p_value is None and got.status=='unavailable'

@pytest.mark.parametrize('seed',range(15))
def test_bh_independent_suffix_min_and_order_invariance(target,seed):
    rng=np.random.default_rng(seed);ps=(rng.integers(0,1001,30)/1000).tolist()
    ps[:5]=[0,1,.05,.05,.001]
    fn=target.module('algorithms.mining.subgroup').benjamini_hochberg
    qs,rej=fn(ps)
    assert qs==pytest.approx(o.bh(ps),abs=1e-14)
    assert rej==[v<=.05 for v in o.bh(ps)]
    perm=rng.permutation(len(ps));qq,_=fn([ps[i] for i in perm])
    assert qq==pytest.approx([qs[i] for i in perm],abs=1e-14)
    assert all(p-1e-15<=q<=1 for p,q in zip(ps,qs))

@pytest.mark.parametrize('seed',range(8))
def test_welch_t_and_cohen_d_subgroup(target,seed):
    rng=np.random.default_rng(seed)
    a=rng.integers(0,10,7).tolist();b=rng.integers(-10,25,13).tolist()
    got=target.module('algorithms.mining.subgroup')._test_numeric('a','q',['A','B'],['A']*len(a)+['B']*len(b),a+b,{'A':[],'B':[]})
    ref=o.welch(a,b)
    assert got['test_method']=='welch_ttest'
    assert got['statistic']==pytest.approx(ref['statistic'],rel=1e-12,abs=1e-12)
    assert got['p_value']==pytest.approx(ref['p'],rel=1e-11,abs=1e-14)
    assert got['effect']['value']==pytest.approx(abs(o.pooled_d(a,b)),abs=5.1e-5)

@pytest.mark.parametrize('groups',[
 [[1,2,3,4,5],[4,5,6,7,8],[0,10,20,30,40,50,60]],
 [[2,3,4,5],[0,20,40,60,80,100],[7,8,9,10,11,12,13]],
 [[1,3,4,6,7],[3,4,8,9,14,20],[1,11,21,31,41,51,61,71]],
])
def test_claimed_welch_anova_is_really_welch(target,groups):
    levels=[str(i) for i in range(len(groups))]
    labels=[str(i) for i,g in enumerate(groups) for _ in g];values=sum(groups,[])
    got=target.module('algorithms.mining.subgroup')._test_numeric('a','q',levels,labels,values,{k:[] for k in levels})
    ref=o.welch_anova(groups)
    assert got['test_method']=='welch_anova'
    assert got['statistic']==pytest.approx(ref['statistic'],rel=1e-11),f"Welch F expected {ref}; actual {got['statistic']}, p={got['p_value']}"
    assert got['p_value']==pytest.approx(ref['p'],rel=1e-10)

@pytest.mark.parametrize('a,b',[
 ([1,2,3,4],[2,4,8,10,12]),([2,3,4],[0,5,8,11,15,20]),([1,5,9,11,14],[4,5,7])])
def test_verification_welch_matches_same_estimand(target,a,b):
    got=target.module('algorithms.mining.verification_test')._welch(np.array(a),np.array(b));ref=o.welch(a,b)
    assert got['statistic']==pytest.approx(ref['statistic'],rel=1e-12,abs=1e-13)
    assert got['df']==pytest.approx(ref['df'],rel=1e-12)
    assert got['pValue']==pytest.approx(ref['p'],rel=1e-11)
    assert sum(got['ci95'])/2==pytest.approx(ref['difference'])
    # Check confidence interval inversion using independent t CDF, not target ppf.
    t=(got['ci95'][1]-got['estimate'])/ref['se']
    assert o.t_two_sided(t,ref['df'])==pytest.approx(.05,rel=1e-9)

@pytest.mark.contract
def test_cohen_d_pooled_definition_consistent_across_exploration_verification(target):
    a=[1,2,3];b=[1,5,9,13,17,21,25]
    actual=target.module('algorithms.mining.verification_test')._cohens_d(np.array(a),np.array(b))
    assert actual==pytest.approx(o.pooled_d(a,b),rel=1e-12), 'Acceptance: use pooled-n Cohen d consistently, or rename/document the alternative effect.'

@pytest.mark.parametrize('ws',[[1,2,3,4],[.1,.2,3.,8.],[1,1,1,1]])
def test_reliability_weighted_moments_not_frequency_variance(target,ws):
    xs=[1,2,5,9]
    fn=target.module('algorithms.mining.verification_test')._weighted_mean_var
    assert fn(np.array(xs),np.array(ws))==pytest.approx(o.weighted_moments(xs,ws),rel=1e-12)
    assert fn(np.array(xs),np.array(ws)*100)==pytest.approx(o.weighted_moments(xs,ws),rel=1e-12)

@pytest.mark.contract
def test_weighted_welch_fractional_effective_n_does_not_clamp_df(target):
    a=[1,3,7,10];b=[2,4,9,15];wa=[100,1,1,1];wb=[80,1,1,1]
    got=target.module('algorithms.mining.verification_test')._welch(np.array(a),np.array(b),np.array(wa),np.array(wb))
    ref=o.welch(a,b,wa,wb)
    # Contract for the app's explicitly selected reliability-weight/ESS approximation,
    # not a claim that this is a general design-based survey t test.
    assert got['df']==pytest.approx(ref['df'],rel=1e-10),f'No arbitrary max(n_eff-1,1); expected {ref}'
