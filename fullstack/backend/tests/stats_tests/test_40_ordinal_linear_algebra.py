import itertools, math
import numpy as np
import pytest
from . import oracles as o

@pytest.mark.parametrize('a,b',[
 ([1,2,3],[4,5,6]),([1,2,3],[1,2,3]),([1,1,2,3],[1,2,2,3,3]),([8,9,10],[1,2,3,4]),
 ([10,20,40],[20,30,40,50])])
def test_cliffs_delta_pairwise_count_including_ties(target,a,b):
    fn=target.module('domain.ordinal_methods').cliffs_delta
    assert fn(a,b)==pytest.approx(o.cliff(a,b),abs=5.1e-5)
    assert fn(b,a)==pytest.approx(-o.cliff(a,b),abs=5.1e-5)

@pytest.mark.parametrize('x,y',[
 ([1,2,3,4],[1,2,3,4]),([1,2,3,4],[4,3,2,1]),
 ([1,1,2,3,3],[2,3,3,1,2]),([1,2,2,3,4],[1,1,2,2,4]),
 ([5,5,5],[1,2,3])])
def test_kendall_tau_b_independent_pair_enumeration(target,x,y):
    got=target.module('domain.ordinal_methods').kendall_tb(x,y);expected=o.kendall_tau_b(x,y)
    if expected is None:assert got['tau'] is None and got['pValue'] is None
    else:assert got['tau']==pytest.approx(expected,abs=5.1e-5)
    assert got['nValid']==len(x)

def test_kendall_missing_and_infinite_pairs(target):
    got=target.module('domain.ordinal_methods').kendall_tb([1,None,3,np.inf,5],[5,4,3,2,1])
    assert got['nValid']==3 and got['tau']==-1

@pytest.mark.parametrize('a,b',[
 ([1,2,3],[4,5,6]),([1,4,7],[2,3,5,6]),([9,11,13,17],[1,3,15])])
def test_mann_whitney_small_sample_exact_enumeration(target,a,b):
    fn=target.module('algorithms.mining.subgroup')._test_ordinal
    got=fn('a','q',['A','B'],['A']*len(a)+['B']*len(b),a+b,{'A':[],'B':[]})
    U,p=o.mann_whitney_exact(a,b)
    assert got['statistic']==pytest.approx(U)
    assert got['p_value']==pytest.approx(p,rel=1e-12,abs=1e-14)

@pytest.mark.parametrize('seed',range(12))
def test_jacobi_eigenvalues_vectors_reconstruction(target,seed):
    rng=np.random.default_rng(seed);n=2+seed%6;M=rng.normal(size=(n,n));A=M.T@M
    eig,vec=target.module('algorithms.ordering.core').jacobi_eigen_symmetric(A)
    expected=np.linalg.eigvalsh(A)
    np.testing.assert_allclose(eig,expected,rtol=1e-9,atol=1e-10)
    np.testing.assert_allclose(vec.T@vec,np.eye(n),atol=1e-10)
    np.testing.assert_allclose(A@vec,vec*eig,atol=1e-9)
    np.testing.assert_allclose(vec@np.diag(eig)@vec.T,A,atol=1e-9)
    assert np.sum(eig)==pytest.approx(np.trace(A),rel=1e-12)
    # Eigenvector signs and degenerate-subspace rotations are deliberately NOT fixed.

@pytest.mark.parametrize('seed',range(10))
def test_axis_ordering_pearson_against_pairwise_fraction_oracle(target,seed):
    rng=np.random.default_rng(seed);X=rng.integers(-10,10,size=(20,4))
    got=target.module('algorithms.ordering.core').correlation_matrix(X)
    for i in range(4):
        for j in range(4):
            x=list(map(o.q,X[:,i]));y=list(map(o.q,X[:,j]));mx=sum(x)/len(x);my=sum(y)/len(y)
            numerator=sum((a-mx)*(b-my) for a,b in zip(x,y))
            denominator=math.sqrt(float(sum((a-mx)**2 for a in x)*sum((b-my)**2 for b in y)))
            assert got[i,j]==pytest.approx(float(numerator)/denominator,abs=1e-12)

def test_ordering_constant_axis_visual_contract(target):
    # Ordering uses a documented visual convention (diag=1, offdiag=0),
    # unlike inferential correlation where constants are undefined.
    X=np.array([[1,2],[1,3],[1,4]])
    np.testing.assert_allclose(target.module('algorithms.ordering.core').correlation_matrix(X),np.eye(2))

@pytest.mark.parametrize('seed',range(8))
def test_iqr_and_mad_outliers_against_independent_quantiles(target,seed):
    rng=np.random.default_rng(seed);xs=rng.integers(-20,20,35).tolist()+[500]
    X=np.array(xs,dtype=float)[:,None];m=target.module('algorithms.outliers.core')
    q1=o.quantile7(xs,.25);q3=o.quantile7(xs,.75);I=q3-q1
    expected=[x<q1-1.5*I or x>q3+1.5*I for x in xs]
    assert m.iqr_rule(X).tolist()==expected
    med=o.quantile7(xs,.5);mad=o.quantile7([abs(x-med) for x in xs],.5)
    assert mad>0
    expected=[abs(x-med)/(1.4826*mad)>3.5 for x in xs]
    assert m.robust_zscore(X).tolist()==expected
    assert m.iqr_rule(3*X+100).tolist()==m.iqr_rule(X).tolist()

@pytest.mark.parametrize('seed',range(8))
def test_holdout_and_folds_no_leakage_reproducible(target,seed):
    m=target.module('domain.verification');ids=[str(i) for i in range(51)]
    a,b=m.split_holdout(ids,.3,seed)
    assert not set(a)&set(b) and sorted(a+b)==sorted(ids)
    assert m.split_holdout(ids,.3,seed)==(a,b)
    folds=m.split_folds(ids,5,seed)
    assert len(set(sum(folds,[])))==51
    assert sorted(sum(folds,[]))==sorted(ids)
    assert max(map(len,folds))-min(map(len,folds))<=1
    assert ids==[str(i) for i in range(51)]
    for i,j in itertools.combinations(range(5),2):m.check_row_disjoint(folds[i],folds[j])

@pytest.mark.parametrize('s,n',[(0,10),(10,10),(5,10),(1,100),(47,100)])
def test_wilson_interval_inverts_score_inequality(target,s,n):
    interval=target.module('domain.verification').wilson_interval(s,n)
    z=1.96;p=s/n
    # Solve n*(p-theta)^2=z^2*theta*(1-theta), a quadratic in theta.
    roots=sorted(np.roots([n+z*z,-2*n*p-z*z,n*p*p]))
    np.testing.assert_allclose(interval,roots,atol=5.1e-5,rtol=0)
    assert 0<=interval[0]<=interval[1]<=1
