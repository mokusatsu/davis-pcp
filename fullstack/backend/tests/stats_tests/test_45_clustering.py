"""Clustering diagnostics against definitions, not a second sklearn call.

Cluster identifiers are arbitrary. PAM is checked for local one-swap optimality,
not falsely asserted to solve the globally NP-hard general k-medoids problem.
"""
import math
import numpy as np
import pytest


def silhouette_by_definition(X, labels):
    D=np.sqrt(((X[:,None,:]-X[None,:,:])**2).sum(axis=2))
    values=[]
    for i,c in enumerate(labels):
        same=[j for j,d in enumerate(labels) if d==c and j!=i]
        if not same:
            values.append(0.);continue
        a=sum(D[i,j] for j in same)/len(same)
        b=min(sum(D[i,j] for j,d in enumerate(labels) if d==other)/sum(d==other for d in labels)
              for other in set(labels) if other!=c)
        values.append((b-a)/max(a,b) if max(a,b)>0 else 0.)
    return np.array(values)


@pytest.mark.parametrize('seed',range(5))
@pytest.mark.parametrize('singleton',[False,True])
def test_silhouette_exact_definition_including_singletons(target,seed,singleton):
    rng=np.random.default_rng(seed)
    X=np.vstack([rng.normal(0,.2,(4,2)),rng.normal(3,.4,(5,2))])
    labels=[7]*4+[-2]*5
    if singleton:X=np.vstack([X,[1.2,2.2]]);labels.append(99)
    expected=silhouette_by_definition(X,labels)
    got=target.module('algorithms.clustering.core').silhouette_summary(X,labels)
    np.testing.assert_allclose(got['byRow'],expected,atol=5.1e-5,rtol=0)
    assert got['mean']==pytest.approx(float(expected.mean()),abs=5.1e-5)
    for group in got['byCluster']:
        selected=expected[np.array(labels)==group['label']]
        assert group['count']==len(selected)
        assert group['mean']==pytest.approx(float(selected.mean()),abs=5.1e-5)


@pytest.mark.parametrize('seed',range(5))
def test_kmeans_reported_inertia_equals_within_cluster_sse(target,seed):
    rng=np.random.default_rng(seed)
    X=np.vstack([rng.normal(-5,.15,(6,2)),rng.normal(5,.15,(8,2))])
    fn=target.module('algorithms.clustering.core').kmeans
    a=fn(X,2,seed=seed);b=fn(X,2,seed=seed)
    labels=np.array(a['labels'])
    assert len(set(labels))==2
    expected=sum(float(((X[labels==c]-X[labels==c].mean(axis=0))**2).sum()) for c in set(labels))
    assert a['inertia']==pytest.approx(expected,rel=1e-10,abs=1e-12)
    assert a['diagnostics']['inertia']==pytest.approx(expected,rel=1e-10)
    assert a['labels']==b['labels']
    assert sum(a['diagnostics']['clusterSizes'])==len(X)


@pytest.mark.parametrize('seed',range(4))
@pytest.mark.parametrize('metric',['euclidean','city_block'])
def test_pam_medoid_objective_and_one_swap_local_optimality(target,seed,metric):
    X=np.random.default_rng(seed).normal(size=(8,2))
    diff=np.abs(X[:,None,:]-X[None,:,:])
    D=diff.sum(axis=2) if metric=='city_block' else np.sqrt((diff**2).sum(axis=2))
    got=target.module('algorithms.clustering.core').kmedoids(X,3,distance=metric)
    medoids=np.array(got['medoidRowIndexes']);labels=np.array(got['labels'])
    assert len(set(medoids))==3
    assert all(0<=m<len(X) for m in medoids)
    nearest=D[:,medoids].min(axis=1)
    np.testing.assert_allclose(D[np.arange(len(X)),medoids[labels]],nearest,atol=1e-12)
    assert got['cost']==pytest.approx(float(nearest.sum()),rel=1e-12)
    for out in range(3):
        for inside in set(range(len(X)))-set(medoids):
            trial=medoids.copy();trial[out]=inside
            assert float(D[:,trial].min(axis=1).sum())>=got['cost']-1e-10


@pytest.mark.parametrize('seed',range(5))
def test_one_component_gaussian_likelihood_aic_bic_closed_form(target,seed):
    X=np.random.default_rng(seed).normal(size=(20,2))@np.array([[2.,.5],[0.,.7]])
    n,p=X.shape;reg=1e-6;Z=X-X.mean(axis=0)
    covariance=Z.T@Z/n+reg*np.eye(p)
    sign,logdet=np.linalg.slogdet(covariance);assert sign>0
    ll=-.5*(n*p*math.log(2*math.pi)+n*logdet+float(np.einsum('ij,jk,ik->',Z,np.linalg.inv(covariance),Z)))
    parameters=p+p*(p+1)/2  # k=1: no free mixture proportions.
    got=target.module('algorithms.clustering.core').gaussian_mixture(X,1,seed=seed,reg_covar=reg)
    assert got['diagnostics']['logLikelihood']==pytest.approx(ll,rel=1e-10,abs=1e-10)
    assert got['aic']==pytest.approx(-2*ll+2*parameters,rel=1e-10)
    assert got['bic']==pytest.approx(-2*ll+math.log(n)*parameters,rel=1e-10)
    assert got['diagnostics']['clusterSizes']==[n]


@pytest.mark.parametrize('a,b,expected',[
    ([0,0,1,1],[7,7,3,3],True),
    ([0,0,1,1],[7,3,7,3],False),
    ([0,0,1,1],[7,7,7,7],False),
])
def test_partition_equality_is_label_permutation_invariant(target,a,b,expected):
    got=target.module('algorithms.clustering.core')._partition_equivalent(np.array(a),np.array(b))
    assert got is expected
