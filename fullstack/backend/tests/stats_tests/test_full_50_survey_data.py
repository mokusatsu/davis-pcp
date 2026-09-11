"""Real Polars integration; never executed through source extraction or mocks."""
import itertools, math
import numpy as np
import pytest
from .support import spec, codebook
from . import oracles as o
pytestmark=pytest.mark.full


def test_question_missing_not_applicable_denominators(target,pl):
    s=spec('q','ordinal',categoryOrder=['10','20','40','80'],missingCodes=['98','99'],missingReasons={'98':'非該当','99':'無回答'})
    got=target.module('algorithms.summaries.core').question_summary(pl.Series('q',[10,20,20,40,80,99,98,None]),s)
    assert got['denominators']=={'total':8,'notApplicable':1,'missing':2,'target':7,'valid':5}
    assert sum(x['count'] for x in got['distribution'])==8
    assert got['auxiliaryStats']['mean']==pytest.approx(2.4)
    assert got['auxiliaryStats']['top2Box']=={'n':2,'pct':40.}
    assert got['auxiliaryStats']['bottom2Box']=={'n':3,'pct':60.}

@pytest.mark.parametrize('reverse',[False,True])
def test_ordinal_rank_not_raw_code_and_fixed_reverse_range(target,pl,reverse):
    s=spec('q','ordinal',categoryOrder=['10','20','40','80'],isReversed=reverse)
    values=[10,20,20]  # upper endpoint 80 is absent from this selected scope
    got=target.module('algorithms.summaries.core').summarize(pl.DataFrame({'q':values}),{'q':'numeric'},codebook(s),[1,2,4])['q']
    scores=[4,3,3] if reverse else [1,2,2]
    assert got['mean']==pytest.approx(sum(scores)/3)
    assert got['weighted']['weightedMean']==pytest.approx(sum(x*w for x,w in zip(scores,[1,2,4]))/7,abs=5.1e-5)
    assert got['auxiliaryStats']['mean']==pytest.approx(sum(scores)/3,abs=.0051)

@pytest.mark.parametrize('reverse',[False,True])
def test_numeric_semantic_missing_and_reverse_endpoints(target,pl,reverse):
    s=spec('q','interval',categoryOrder=['1','2','3','4','5'],missingCodes=['99'],isReversed=reverse)
    got=target.module('algorithms.summaries.core').summarize(pl.DataFrame({'q':[1,2,2,99,None]}),{'q':'numeric'},codebook(s))['q']
    expected=[5,4,4] if reverse else [1,2,2]
    assert got['count']==3 and got['missing']==2
    assert got['mean']==pytest.approx(sum(expected)/3)

@pytest.mark.parametrize('multiplier',[.01,1,100])
def test_weighted_summary_valid_denominator_not_all_rows(target,pl,multiplier):
    s=spec('q','ratio',missingCodes=['99'])
    values=[1,4,8,99,None,5];weights=[1*multiplier,9*multiplier,0,50*multiplier,70*multiplier,None]
    got=target.module('algorithms.summaries.core').summarize(pl.DataFrame({'q':values}),{'q':'numeric'},codebook(s),weights)['q']
    assert got['weighted']['weightedN']==pytest.approx(10*multiplier,abs=5.1e-5)
    assert got['weighted']['weightedMean']==pytest.approx(3.7,abs=5.1e-5)
    assert got['weighted']['weightMissingCount']==1

@pytest.mark.parametrize('bad',[-1.,float('inf'),float('-inf'),float('nan')])
def test_weight_invalid_numbers_rejected_upstream(target,pl,bad):
    from app.domain.errors import BizError
    m=target.module('domain.survey_weight')
    w,missing,invalid=m.extract_weights(pl.DataFrame({'w':[1.,bad]}),'w',spec('w','ratio','weight'))
    assert invalid
    with pytest.raises(BizError):m.check_weights_valid(w,invalid)

@pytest.mark.parametrize('values',[[1,0,99,None],['1','0','99',None]])
def test_semantic_weight_missing_not_numeric_mass(target,pl,values):
    m=target.module('domain.survey_weight')
    w,missing,invalid=m.extract_weights(pl.DataFrame({'w':values}),'w',spec('w','ratio','weight',missingCodes=['99']))
    assert w==[1.,0.,None,None] and missing==2 and not invalid

@pytest.mark.parametrize('weights',[[1,2,3],[0,1,9]])
def test_frequency_weight_integer_semantics(target,weights):
    target.module('domain.survey_weight').validate_weight_semantics(weights,'frequency')

@pytest.mark.parametrize('weights',[[1,.5,3],[2,1.1,None]])
def test_fractional_frequency_weights_rejected(target,weights):
    from app.domain.errors import BizError
    with pytest.raises(BizError):target.module('domain.survey_weight').validate_weight_semantics(weights,'frequency')


def table_fixture(pl):
    rows=[]
    counts=[[10,10,20],[20,20,20]]
    for i,line in enumerate(counts):
        for j,n in enumerate(line):rows += [(str(i),str(j))]*n
    frame=pl.DataFrame({'__rowId__':[str(i) for i in range(len(rows))],'a':[r[0] for r in rows],'b':[r[1] for r in rows]})
    cb=codebook(spec('a',categoryOrder=['0','1','unused']),spec('b',categoryOrder=['0','1','2','unused']))
    return frame,cb


def test_crosstab_counts_expected_asr_and_zero_margins(target,pl):
    frame,cb=table_fixture(pl)
    got=target.module('algorithms.summaries.crosstab').compute_crosstab(frame,'a','b',cb)
    assert got['grandTotal']=={'unweightedCount':100,'count':100.}
    assert got['inference']['statistic']==pytest.approx(25/9)
    assert got['inference']['numeratorDf']==2
    expected_counts=[[12,12,16],[18,18,24]];raw=[[10,10,20],[20,20,20]]
    for cell in got['cells']:
        r,c=cell['rowCategoryId'],cell['colCategoryId']
        if 'unused' in [r,c]:
            assert cell['count']==0
            continue
        i,j=int(r),int(c);E=expected_counts[i][j];O=raw[i][j]
        assert cell['count']==O and cell['expectedCount']==E
        assert cell['asr']==pytest.approx((O-E)/math.sqrt(E*(1-[.4,.6][i])*(1-[.3,.3,.4][j])),abs=.00051)
        assert cell['rowPct']==pytest.approx(100*O/sum(raw[i]),abs=.0051)
        assert cell['rowIdCount']==O and len(cell['rowIds'])==O

@pytest.mark.parametrize('scale',[.01,1,100])
def test_crosstab_survey_default_no_p_no_cell_stars(target,pl,scale):
    frame,cb=table_fixture(pl);weights=[scale*(1+i%7) for i in range(frame.height)]
    got=target.module('algorithms.summaries.crosstab').compute_crosstab(frame,'a','b',cb,weights=weights,weight_type='survey')
    assert got['inference']['status']=='not_requested' and got['inference']['pValue'] is None
    assert all(c['significance'] is None for c in got['cells'])
    assert got['grandTotal']['count']==pytest.approx(sum(weights),abs=5.1e-5)
    assert got['descriptiveAssociation']['cramersV'] is None
    weighted_table=[[sum(weights[k] for k,(a,b) in enumerate(zip(frame['a'].to_list(),frame['b'].to_list())) if a==str(i) and b==str(j)) for j in range(3)] for i in range(2)]
    assert got['descriptiveAssociation']['weightedCramersV']==pytest.approx(o.pearson(weighted_table)[2],rel=1e-11)


def test_crosstab_frequency_equals_integer_row_replication(target,pl):
    df=pl.DataFrame({'__rowId__':['a','b','c','d'],'a':['0','0','1','1'],'b':['0','1','0','1']})
    cb=codebook(spec('a'),spec('b'));weights=[2,6,8,3]
    m=target.module('algorithms.summaries.crosstab')
    weighted=m.compute_crosstab(df,'a','b',cb,weights=weights,weight_type='frequency')
    expanded=[]
    for row,w in zip(df.to_dicts(),weights):
        for i in range(w):expanded.append({**row,'__rowId__':row['__rowId__']+f'-{i}'})
    ordinary=m.compute_crosstab(pl.DataFrame(expanded),'a','b',cb)
    assert weighted['inference']['statistic']==pytest.approx(ordinary['inference']['statistic'])
    assert weighted['inference']['pValue']==pytest.approx(ordinary['inference']['pValue'])
    assert weighted['grandTotal']['unweightedCount']==4
    assert ordinary['grandTotal']['unweightedCount']==19


def test_crosstab_rowid_truncation_never_changes_statistical_count(target,pl):
    df,cb=table_fixture(pl);fn=target.module('algorithms.summaries.crosstab').compute_crosstab
    a=fn(df,'a','b',cb);b=fn(df,'a','b',cb,max_row_ids_per_cell=2)
    assert a['inference']==b['inference']
    for ca,cb in zip(a['cells'],b['cells']):
        assert ca['count']==cb['count'] and ca['rowIdCount']==cb['rowIdCount']
        assert len(cb['rowIds'])<=2
        assert cb['rowIdsTruncated']==(cb['rowIdCount']>2)


def ma_group():
    return {'groupId':'ma','label':'Multiple answer','selectedCodes':['1'],'unselectedCodes':['0'],
            'allUnselectedMeaning':'valid','optionOrder':['x','y'],'maxSelections':None,
            'columns':[spec(c,multiResponseGroup='ma',missingCodes=['98','99'],missingReasons={'98':'非該当','99':'無回答'}) for c in ['x','y']]}

@pytest.mark.parametrize('a,b',list(itertools.product([0,1,None,99,98,2],repeat=2)))
def test_ma_row_classification_exhaustive_small_domain(target,a,b):
    group=ma_group();m=target.module('domain.multi_response');m.validate_group(group)
    state,selected=m.classify_row([a,b],group)
    if 2 in [a,b]:expected='invalid'
    elif 98 in [a,b]:expected='notApplicable' if a==98 and b==98 else 'invalid'
    elif all(v in [None,99] for v in [a,b]):expected='missing'
    elif any(v in [None,99] for v in [a,b]):expected='partial'
    else:expected='valid'
    assert state==expected
    assert selected==[name for name,value in zip(['x','y'],[a,b]) if value==1]

@pytest.mark.parametrize('scale',[.01,1,100])
def test_ma_respondent_vs_response_denominators_and_weights(target,pl,scale):
    rows=[(1,0),(0,1),(1,1),(0,0),(None,None),(1,None),(2,0),(98,98)]
    df=pl.DataFrame({'__rowId__':list(map(str,range(len(rows)))),'x':[r[0] for r in rows],'y':[r[1] for r in rows]})
    weights=[scale*w for w in [1,9,2,4,100,100,100,100]]
    got=target.module('domain.multi_response').summarize_group(df,ma_group(),weights=weights)
    assert got['denominators']==dict(total=8,valid=4,missing=1,partial=1,invalid=1,notApplicable=1,target=7)
    assert got['weightedValidN']==pytest.approx(16*scale)
    assert got['weightedResponses']==pytest.approx(14*scale)
    items={v['columnId']:v for v in got['items']}
    for col,w in [('x',3),('y',11)]:
        assert items[col]['selectedN']==2
        assert items[col]['selectedWeighted']==pytest.approx(w*scale)
        assert items[col]['pctRespondent']==pytest.approx(w/16*100)
        assert items[col]['pctResponse']==pytest.approx(w/14*100)
        assert items[col]['pctRespondentUnweighted']==50.
    assert sum(i['pctResponse'] for i in got['items'])==pytest.approx(100.)

@pytest.mark.parametrize('meaning,expected',[('valid','valid'),('missing','missing'),('notApplicable','notApplicable')])
def test_ma_all_unselected_declared_meaning(target,meaning,expected):
    g=ma_group();g['allUnselectedMeaning']=meaning
    assert target.module('domain.multi_response').classify_row([0,0],g)[0]==expected


def test_ma_maxselections_and_fractional_option_rejected(target):
    g=ma_group();g['maxSelections']=1;m=target.module('domain.multi_response')
    assert m.classify_row([1,1],g)[0]=='invalid'
    assert m.classify_row([.5,0],g)[0]=='invalid'

@pytest.mark.contract
@pytest.mark.parametrize('kind',['single','ma'])
def test_weight_vector_length_mismatch_must_not_silently_zip_truncate(target,pl,kind):
    from app.domain.errors import BizError
    with pytest.raises((ValueError,BizError)):
        if kind=='single':
            target.module('algorithms.summaries.core').summarize(pl.DataFrame({'q':[1,2,3]}),{'q':'numeric'},codebook(spec('q','ratio')),weights=[1,2])
        else:
            target.module('domain.multi_response').summarize_group(pl.DataFrame({'__rowId__':['a','b','c'],'x':[1,0,1],'y':[0,1,1]}),ma_group(),weights=[1,2])
