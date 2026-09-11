"""Real routes, request validation, storage and caches in an isolated FastAPI app.

This does not launch the production lifespan/background jobs, and is not a
browser/Pyodide test. Numeric expectations below do not call the app as oracle.
"""
import json,uuid,os
from pathlib import Path
import numpy as np
import pytest
from .support import spec,codebook
from .test_full_50_survey_data import ma_group
pytestmark=pytest.mark.full

@pytest.fixture
def api(target,pl):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.domain.errors import BizError,biz_error_handler
    from app.storage.dataset_store import DatasetStore,dataset_fingerprint
    app=FastAPI();app.add_exception_handler(BizError,biz_error_handler)
    for name in ['summaries','statistics','relationships','multi_response','regression']:
        app.include_router(target.module('api.'+name).router,prefix='/api')
    store=DatasetStore()
    assert Path(os.environ['DAVIS_PCP_WORKSPACE']).resolve() in store.root.resolve().parents
    def save(data,cb):
        df=pl.DataFrame(data)
        if '__rowId__' not in df.columns:df=df.with_columns(pl.Series('__rowId__',[str(i) for i in range(df.height)]))
        ds='stat-test-'+uuid.uuid4().hex
        schema=[{'name':c['name'],'semanticType':'numeric' if c['scaleType'] in ['ratio','interval','ordinal'] else 'categorical'} for c in cb['columns']]
        meta={'datasetId':ds,'schema':schema,'schemaRevision':cb.get('schemaRevision',1),'dataRevision':1,
              'rowCount':df.height,'columnCount':len(schema),'fingerprint':dataset_fingerprint(schema,1,df,'test')}
        store.save(ds,meta,df,cb)
        return ds
    with TestClient(app,raise_server_exceptions=False) as client:
        yield client,save,store


def post_ok(client,path,payload):
    response=client.post('/api'+path,json=payload)
    assert response.status_code==200,(response.status_code,response.text)
    result=response.json();json.dumps(result,allow_nan=False)
    return result


def test_api_summary_scope_none_empty_and_selected_ids(api):
    client,save,_=api
    ds=save({'q':[1.,2.,3.,99.,None]},codebook(spec('q','ratio',missingCodes=['99'])))
    all_=post_ok(client,'/summaries',{'datasetId':ds,'columns':['q']})
    empty=post_ok(client,'/summaries',{'datasetId':ds,'columns':['q'],'rowIds':[]})
    selected=post_ok(client,'/summaries',{'datasetId':ds,'columns':['q'],'rowIds':['0','2']})
    assert all_['rowCount']==5 and all_['columns']['q']['mean']==2.
    assert empty['rowCount']==0 and empty['columns']['q']['count']==0
    assert selected['rowCount']==2 and selected['columns']['q']['mean']==2.
    assert len({all_['scopeHash'],empty['scopeHash'],selected['scopeHash']})==3


def test_api_summary_cache_different_weight_columns(api):
    client,save,_=api
    ds=save({'q':[1.,5.],'w1':[1.,9.],'w2':[9.,1.]},codebook(spec('q','ratio'),spec('w1','ratio','weight'),spec('w2','ratio','weight')))
    outputs=[]
    for w in ['w1','w2','w1']:
        outputs.append(post_ok(client,'/summaries',{'datasetId':ds,'columns':['q'],'weightColumn':w}))
    assert [g['columns']['q']['weighted']['weightedMean'] for g in outputs]==pytest.approx([4.6,1.4,4.6])
    assert outputs[2]['cacheHit'] is True
    assert all(g['weightApplied'] for g in outputs)


def test_api_schema_change_invalidates_missing_code_summary_cache(api):
    client,save,store=api
    cb=codebook(spec('q','ratio'));ds=save({'q':[1.,2.,99.]},cb)
    before=post_ok(client,'/summaries',{'datasetId':ds,'columns':['q']})
    cb['columns'][0]['missingCodes']=['99'];cb['schemaRevision']=2
    meta=store.get_meta(ds);meta['schemaRevision']=2;store.save_metadata(ds,meta,cb)
    after=post_ok(client,'/summaries',{'datasetId':ds,'columns':['q']})
    assert before['columns']['q']['mean']==34.
    assert after['columns']['q']['mean']==1.5 and after['schemaRevision']==2
    assert after['cacheHit'] is False


def test_api_data_revision_change_invalidates_summary_cache(api,pl):
    client,save,store=api;cb=codebook(spec('q','ratio'));ds=save({'q':[1.,3.]},cb)
    before=post_ok(client,'/summaries',{'datasetId':ds,'columns':['q']})
    meta=store.get_meta(ds)
    # Keep fingerprint intentionally unchanged to ensure dataRevision alone protects cache.
    store.save(ds,meta,pl.DataFrame({'__rowId__':['0','1'],'q':[10.,30.]}),cb)
    after=post_ok(client,'/summaries',{'datasetId':ds,'columns':['q']})
    assert before['columns']['q']['mean']==2.
    assert after['columns']['q']['mean']==20. and after['dataRevision']==2

@pytest.mark.parametrize('path,payload',[
 ('/summaries',{'columns':['x']}),('/statistics/covariance',{'columns':['x','y']}),
 ('/relationships/matrix',{'columns':['x','y']})])
def test_api_stale_revision_rejected_not_old_numbers(api,path,payload):
    client,save,_=api;ds=save({'x':[1.,2.,3.],'y':[2.,4.,7.]},codebook(spec('x','ratio'),spec('y','ratio')))
    response=client.post('/api'+path,json={'datasetId':ds,**payload,'expectedDataRevision':999})
    assert response.status_code==409,response.text


def test_api_covariance_and_summary_use_same_semantic_missing_rows(api):
    client,save,_=api
    cb=codebook(spec('x','ratio',missingCodes=['99']),spec('y','ratio'))
    ds=save({'x':[1.,2.,3.,4.,99.],'y':[2.,5.,4.,8.,-100.]},cb)
    got=post_ok(client,'/statistics/covariance',{'datasetId':ds,'columns':['x','y']})
    X=np.array([[1,2],[2,5],[3,4],[4,8]],float);Z=X-X.mean(0)
    np.testing.assert_allclose(got['covariance'],Z.T@Z/3,atol=5.1e-6,rtol=0)
    assert got['nRows']==4


def test_api_pearson_pairwise_denominator_matrix(api):
    client,save,_=api
    ds=save({'x':[1.,2.,3.,99.],'y':[2.,None,6.,8.],'constant':[5.,5.,5.,5.]},
            codebook(spec('x','ratio',missingCodes=['99']),spec('y','ratio'),spec('constant','ratio')))
    got=post_ok(client,'/relationships/matrix',{'datasetId':ds,'columns':['x','y','constant']})
    assert got['counts']==[[3,2,3],[2,3,3],[3,3,4]]
    assert got['matrix'][0][1]==pytest.approx(1.)
    assert got['matrix'][2][2] is None and got['matrix'][0][2] is None


def test_api_unsupported_weight_is_explicit(api):
    client,save,_=api
    ds=save({'x':[1.,2.,3.],'y':[2.,4.,3.],'w':[1.,1.,9.]},
            codebook(spec('x','ratio'),spec('y','ratio'),spec('w','ratio','weight')))
    got=post_ok(client,'/relationships/matrix',{'datasetId':ds,'columns':['x','y'],'weightColumn':'w'})
    assert got['weightStatus']=='unsupported' and got['weightApplied'] is False


def test_api_ma_weight_switch_does_not_reuse_unweighted_cache(api):
    client,save,_=api;g=ma_group()
    cols=g['columns']+[spec('w1','ratio','weight'),spec('w2','ratio','weight')]
    cb=codebook(*cols,multiResponseGroups=[{k:v for k,v in g.items() if k!='columns'}])
    ds=save({'x':[1,0],'y':[0,1],'w1':[1.,9.],'w2':[9.,1.]},cb)
    actual=[]
    for w in [None,'w1','w2','w1']:
        got=post_ok(client,'/summaries/multi-response',{'datasetId':ds,'groupIds':['ma'],'weightColumn':w})
        group=got['groups'][0];items={v['columnId']:v for v in group['items']}
        actual.append(items['x']['pctRespondent'])
    assert actual==pytest.approx([50.,10.,90.,10.])


def test_api_survey_crosstab_default_and_explicit_pearson_rejection(api):
    client,save,_=api
    cb=codebook(spec('a'),spec('b'),spec('w','ratio','weight'),weightConfig={'weightColumnId':'w','weightType':'survey'})
    ds=save({'a':['0','0','1','1'],'b':['0','1','0','1'],'w':[1.,2.,3.,9.]},cb)
    req={'context':{'datasetId':ds,'expectedDataRevision':1,'expectedSchemaRevision':1},'rowVariableId':'a','colVariableId':'b'}
    got=post_ok(client,'/summaries/crosstab',req)
    # This distribution returns result fields at top level, alongside meta.
    data=got
    assert data['inference']['pValue'] is None
    assert all(c['significance'] is None for c in data['cells'])
    response=client.post('/api/summaries/crosstab',json={**req,'inference':'pearson'})
    assert response.status_code==422,response.text

@pytest.mark.contract
def test_api_qqplot_must_exclude_codebook_missing_99(api):
    client,save,_=api
    ds=save({'q':[1.,2.,3.,4.,99.]},codebook(spec('q','ratio',missingCodes=['99'])))
    got=post_ok(client,'/summaries/qqplot',{'datasetId':ds,'column':'q'})
    assert got['count']==4
    assert [p['sampleValue'] for p in got['points']]==[1.,2.,3.,4.]
