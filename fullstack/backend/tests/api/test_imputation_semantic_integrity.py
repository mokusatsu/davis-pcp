"""Imputation writes ordinary missing cells only, and preview commits exact values."""
import polars as pl
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.storage.dataset_store import DatasetStore
from app.algorithms.imputation.core import impute_dataframe

@pytest.fixture
def harness(tmp_path, monkeypatch):
    import app.api.datasets as api
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(api, 'store', store)
    with TestClient(app) as client:
        yield client, store

def create(client, store, csv='x,q\n0,1\n1,3\n2,3\n3,98\n4,99\n5,\n6,7\n'):
    response = client.post('/api/v1/datasets/import', files={'file': ('semantic.csv', csv, 'text/csv')})
    assert response.status_code == 200, response.text
    ds = response.json()['datasetId']
    book = store.load_codebook(ds)
    for col in book['columns']:
        if col['name'] == 'q':
            col.update(scaleType='ordinal', categoryOrder=['1','3'], missingCodes=['98','99'],
                       missingReasons={'98':'not_applicable','99':'missing'})
    store.save_metadata(ds, store.get_meta(ds), book)
    return ds

@pytest.mark.parametrize('strategy', ['mean','median','mode','knn','constant','tabdiff'])
@pytest.mark.parametrize('in_place', [True,False])
def test_protected_codes_preview_apply_mask_and_undo(harness, strategy, in_place):
    client, store = harness
    ds = create(client, store)
    before = store.get_dataframe(ds)
    body = {'columns':['q'], 'predictorColumns':['x'], 'strategy':strategy,
            'options':{'knn_neighbors':1, 'constant_value':3, 'num_steps':5, 'seed':42}}
    response = client.post(f'/api/v1/datasets/{ds}/impute/preview', json=body)
    assert response.status_code == 200, response.text
    preview = response.json()
    applied = client.post(f'/api/v1/datasets/{ds}/impute', json={**body,'inPlace':in_place,'planHash':preview['planHash']})
    assert applied.status_code == 200, applied.text
    output = applied.json()['datasetId']
    actual = store.get_dataframe(output)
    assert actual['q'][3] == 98, 'Not-applicable must never be filled'
    assert actual['q'][6] == 7, 'Invalid codes are preserved, not reclassified as ordinary missing'
    assert actual['q'][:3].to_list() == [1,3,3]
    assert actual['x'].to_list() == before['x'].to_list()
    assert actual['q'][4] not in [None,98,99]
    assert actual['q'][5] is not None
    assert len(store.load_mask(output)['entries']) == 2
    assert preview['diagnostics']['imputedCounts']['q'] == 2
    assert preview['beforeStats']['totalCount'] == 7
    assert preview['beforeStats']['notApplicableCount'] == 1
    assert preview['afterStats']['notApplicableCount'] == 1
    assert preview['beforeStats']['missingCount'] == 2
    assert preview['afterStats']['missingCount'] == 0
    assert applied.json()['outputHashes']['q'] == preview['perColumn'][0]['valuesHash']
    q_spec = next(col for col in store.load_codebook(output)['columns'] if col['name']=='q')
    assert q_spec['missingReasons']['98'] == 'not_applicable'
    if strategy == 'mean':
        assert actual['q'][4] == pytest.approx(3.5), 'Skip codes are excluded; existing invalid-code donor policy is unchanged'
    if in_place:
        undo = client.post(f'/api/v1/datasets/{ds}/undo', json={})
        assert undo.status_code == 200, undo.text
        assert store.get_dataframe(ds).equals(before)
        assert store.load_mask(ds)['entries'] == []
        q_spec = next(col for col in store.load_codebook(ds)['columns'] if col['name']=='q')
        assert q_spec['missingReasons']['98'] == 'not_applicable'
    else:
        assert store.get_dataframe(ds).equals(before)

@pytest.mark.parametrize('strategy,values,expected', [('mode',[2.,1.,None],1.), ('mode',['z','a',None],'a'), ('mode',[True,False,None],False), ('knn',['z','a',None],'a'), ('knn',[True,False,None],False)])
def test_ties_have_stable_code_string_order(values, expected, strategy):
    frame = pl.DataFrame({'q':values,'x':[0.,1.,2.]})
    for _ in range(40):
        output,_ = impute_dataframe(frame,['q'],strategy,predictors=['x'])
        assert output['q'][-1] == expected

@pytest.mark.parametrize('csv', ['x,q\n0,2\n1,1\n2,\n', 'x,q\n0,z\n1,a\n2,\n'])
def test_tied_mode_preview_apply_repeated(harness, csv):
    client,store = harness
    ds = client.post('/api/v1/datasets/import',files={'file':('tie.csv',csv,'text/csv')}).json()['datasetId']
    for _ in range(20):
        body={'columns':['q'],'strategy':'mode'}
        preview=client.post(f'/api/v1/datasets/{ds}/impute/preview',json=body).json()
        result=client.post(f'/api/v1/datasets/{ds}/impute',json={**body,'planHash':preview['planHash']}).json()
        assert result['outputHashes']['q'] == preview['perColumn'][0]['valuesHash']
        client.post(f'/api/v1/datasets/{ds}/undo',json={})

@pytest.mark.parametrize('strategy', ['mean','median','mode','knn','constant','tabdiff'])
def test_only_protected_target_needs_no_donor(harness, strategy):
    client, store = harness
    ds = create(client,store,'x,q\n0,98\n1,98\n')
    before = store.get_dataframe(ds)
    body={'columns':['q'],'predictorColumns':[],'strategy':strategy,'options':{'constant_value':2}}
    preview=client.post(f'/api/v1/datasets/{ds}/impute/preview',json=body)
    assert preview.status_code == 200, preview.text
    result=client.post(f'/api/v1/datasets/{ds}/impute',json={**body,'planHash':preview.json()['planHash']})
    assert result.status_code == 200, result.text
    assert store.get_dataframe(ds).equals(before)
    assert store.load_mask(ds)['entries'] == []
    assert preview.json()['beforeStats']['missingCount'] == 0
    assert preview.json()['diagnostics']['imputedCounts']['q'] == 0

@pytest.mark.parametrize('strategy',['mean','median','knn'])
def test_skip_is_not_donor_for_true_missing(harness,strategy):
    client,store=harness
    ds=create(client,store,'x,q\n0,98\n1,\n')
    before=store.get_dataframe(ds)
    body={'columns':['q'],'predictorColumns':['x'],'strategy':strategy}
    for endpoint in ['impute/preview','impute']:
        response=client.post(f'/api/v1/datasets/{ds}/{endpoint}',json=body)
        assert response.status_code == 422, response.text
        assert response.json()['error']['code'] == 'IMPUTATION_NO_DONOR'
        assert store.get_dataframe(ds).equals(before)

@pytest.mark.parametrize('reason',['not_applicable','skip','非該当'])
@pytest.mark.parametrize('strategy',['mode','knn','tabdiff'])
@pytest.mark.parametrize('values,skip,missing,expected',[
    (['z','a','SKIP','NA',None],'SKIP','NA','a'),
    ([False,False,True,None,None],'True','unused',False),
])
def test_category_types_skip_and_ties(harness,reason,strategy,values,skip,missing,expected):
    from app.api import datasets as api
    from app.services.dataset_service import new_id
    client,store=harness
    df=pl.DataFrame({'q':values,'x':[0.,1.,2.,3.,4.]})
    ds=new_id('ds')
    api._finalize_dataset(ds,'categories','csv',df,None)
    book=store.load_codebook(ds)
    for col in book['columns']:
        if col['name']=='q':
            col.update(missingCodes=[skip,missing],missingReasons={skip:reason,missing:'missing'})
    store.save_metadata(ds,store.get_meta(ds),book)
    for _ in range(5):
        body={'columns':['q'],'predictorColumns':['x'],'strategy':strategy,'options':{'temperature':0.1,'num_steps':5,'seed':42}}
        preview=client.post(f'/api/v1/datasets/{ds}/impute/preview',json=body)
        assert preview.status_code == 200, preview.text
        result=client.post(f'/api/v1/datasets/{ds}/impute',json={**body,'planHash':preview.json()['planHash']})
        assert result.status_code==200,result.text
        actual=store.get_dataframe(ds)
        assert actual['q'][2] == values[2]
        assert actual['q'][3:].to_list() == [expected,expected]
        assert len(store.load_mask(ds)['entries'])==2
        assert result.json()['outputHashes']['q']==preview.json()['perColumn'][0]['valuesHash']
        client.post(f'/api/v1/datasets/{ds}/undo',json={})


def test_skip_reason_without_missing_code_is_protected_and_float_normalized(harness):
    client,store=harness
    ds=create(client,store,'x,q\n0,1.5\n1,98.0\n2,\n')
    book=store.load_codebook(ds)
    for col in book['columns']:
        if col['name']=='q': col['missingCodes']=[]
    store.save_metadata(ds,store.get_meta(ds),book)
    result=client.post(f'/api/v1/datasets/{ds}/impute',json={'columns':['q'],'strategy':'mean'})
    assert result.status_code == 200,result.text
    assert store.get_dataframe(ds)['q'].to_list()==[1.5,98.,1.5]
    assert len(store.load_mask(ds)['entries'])==1

@pytest.mark.parametrize('strategy',['knn','tabdiff'])
def test_predictor_skip_code_matches_null_oracle(harness,strategy):
    from app.algorithms.imputation.core import column_values_hash
    client,store=harness
    ds=create(client,store,'x,q\n0,1\n1,3\n98,3\n0,\n1,99\n')
    book=store.load_codebook(ds)
    for col in book['columns']:
        if col['name']=='x': col.update(missingCodes=['98'],missingReasons={'98':'skip'})
    store.save_metadata(ds,store.get_meta(ds),book)
    raw=store.get_dataframe(ds)
    # An independently specified donor frame, not the production adapter.
    oracle_frame=raw.with_columns(pl.Series('x',[0,1,None,0,1]),pl.Series('q',[1,3,3,None,None]))
    options={'knn_neighbors':1,'num_steps':5,'seed':42}
    oracle,_=impute_dataframe(oracle_frame,['q'],strategy,options,predictors=['x'])
    body={'columns':['q'],'predictorColumns':['x'],'strategy':strategy,'options':options}
    preview=client.post(f'/api/v1/datasets/{ds}/impute/preview',json=body)
    assert preview.status_code==200,preview.text
    result=client.post(f'/api/v1/datasets/{ds}/impute',json={**body,'planHash':preview.json()['planHash']})
    assert result.status_code==200,result.text
    assert store.get_dataframe(ds)['x'].to_list()==raw['x'].to_list()
    assert result.json()['outputHashes']['q']==column_values_hash(oracle['q'])


def test_mode_column_named_count_and_numeric_lexical_tie_policy():
    frame=pl.DataFrame({'count':[2,10,None]})
    result,_=impute_dataframe(frame,['count'],'mode')
    assert result['count'].to_list()==[2,10,10]  # existing TabDiff code-string convention
