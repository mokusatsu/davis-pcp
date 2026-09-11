import numpy as np
import pytest
from .support import spec,codebook
pytestmark=pytest.mark.full

@pytest.mark.parametrize('strategy,expected',[('mean',4.),('median',2.),('mode',2.),('constant',7.)])
def test_baseline_imputation_exact_and_observed_values_preserved(target,pl,strategy,expected):
    df=pl.DataFrame({'__rowId__':['a','b','c','d','e','f'],'q':[1.,2.,2.,11.,None,float('nan')],'predictor':[0,1,2,3,4,5]})
    got,info=target.module('algorithms.imputation.core').impute_dataframe(df,['q'],strategy,options={'constant_value':7.})
    assert got['q'].to_list()==[1.,2.,2.,11.,expected,expected]
    assert got['__rowId__'].to_list()==df['__rowId__'].to_list()
    assert got['predictor'].to_list()==df['predictor'].to_list()
    assert info['imputedCounts']['q']==2
    assert df['q'][4] is None and np.isnan(df['q'][5]), 'Input dataframe must be unchanged.'


def test_knn_unique_nearest_neighbor_known_value(target,pl):
    df=pl.DataFrame({'q':[10.,20.,30.,None],'x':[0.,100.,200.,101.]})
    out,_=target.module('algorithms.imputation.core').impute_dataframe(df,['q'],'knn',{'knn_neighbors':1},predictors=['x'])
    assert out['q'].to_list()==pytest.approx([10.,20.,30.,20.])

@pytest.mark.parametrize('bad',[float('inf'),float('nan'),'not-a-number'])
def test_invalid_imputation_constant_rejected(target,pl,bad):
    from app.domain.errors import BizError
    with pytest.raises(BizError):
        target.module('algorithms.imputation.core').impute_dataframe(pl.DataFrame({'q':[1.,None]}),['q'],'constant',{'constant_value':bad})


def test_imputation_plan_hash_predictors_revision_seed(target,pl):
    df=pl.DataFrame({'q':[1.,None,3.],'x':[1.,2.,3.],'z':[2.,3.,4.]})
    cb=codebook(spec('q','ratio'),spec('x','ratio'),spec('z','ratio'))
    fn=target.module('algorithms.imputation.plan').build_imputation_plan
    a=fn(df,cb,['q'],['x','z'],'knn',{'seed':42},dataset_id='test',data_revision=1)
    b=fn(df,cb,['q'],['z','x'],'knn',{'seed':42},dataset_id='test',data_revision=1)
    assert a.planHash==b.planHash
    c=fn(df,cb,['q'],['x'],'knn',{'seed':42},dataset_id='test',data_revision=1)
    d=fn(df,cb,['q'],['x','z'],'knn',{'seed':43},dataset_id='test',data_revision=1)
    e=fn(df,cb,['q'],['x','z'],'knn',{'seed':42},dataset_id='test',data_revision=2)
    assert len({a.planHash,c.planHash,d.planHash,e.planHash})==4


def test_imputation_self_predictor_rejected(target,pl):
    from app.domain.errors import BizError
    with pytest.raises(BizError):
        target.module('algorithms.imputation.plan').build_imputation_plan(pl.DataFrame({'q':[1.,None,3.]}),target_columns=['q'],predictor_columns=['q'],strategy='knn')

@pytest.mark.contract
@pytest.mark.parametrize('strategy',['mean','median','knn'])
def test_all_missing_numeric_no_evidence_must_not_be_invented_zero(target,pl,strategy):
    from app.domain.errors import BizError
    df=pl.DataFrame({'q':pl.Series([None,None,None],dtype=pl.Float64),'x':[1.,2.,3.]})
    try:out,diagnostics=target.module('algorithms.imputation.core').impute_dataframe(df,['q'],strategy,predictors=['x'])
    except BizError:return
    assert out['q'].null_count()==3, 'No observed donor/statistic exists: preserve missing or reject, not silently fill zero.'
