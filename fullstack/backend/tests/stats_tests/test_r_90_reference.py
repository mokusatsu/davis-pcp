"""Live R parity. Collected only with --with-r; missing R or survey is an ERROR."""
import csv,subprocess,shutil
from pathlib import Path
import numpy as np
import pytest
from .test_30_survey_design import ROW,COL,W,STRATA,PSU,FPC,X,table_of
pytestmark=pytest.mark.r_oracle

@pytest.fixture(scope='module')
def r_reference(tmp_path_factory):
    executable=shutil.which('Rscript')
    assert executable is not None,'Rscript is required, not an optional skip in --with-r mode.'
    root=Path(__file__).parent
    dest=tmp_path_factory.mktemp('R-reference')
    dest.mkdir(parents=True,exist_ok=True)
    p=subprocess.run([executable,str(root/'generate_R_reference.R'),str(root/'survey_synthetic.csv'),str(dest)],capture_output=True,text=True,timeout=180)
    (dest/'runner_stdout.txt').write_text(p.stdout,encoding='utf-8')
    (dest/'runner_stderr.txt').write_text(p.stderr,encoding='utf-8')
    assert p.returncode==0,'R reference generation failed:\n'+p.stderr
    return dest

@pytest.mark.parametrize('kind',['independent','cluster','stratified','fpc'])
@pytest.mark.parametrize('scale',[.001,1.,1000.])
def test_R_survey_svychisq_and_svymean(target,r_reference,kind,scale):
    rows=list(csv.DictReader((r_reference/'survey.tsv').read_text().splitlines(),delimiter='\t'))
    covrows=list(csv.DictReader((r_reference/'covariance.tsv').read_text().splitlines(),delimiter='\t'))
    ref=next(r for r in rows if r['kind']==kind and float(r['scale'])==scale)
    cov=next(r for r in covrows if r['kind']==kind and float(r['scale'])==scale)
    st=STRATA if kind in ['stratified','fpc'] else None
    ps=PSU if kind!='independent' else None;fpc=FPC if kind=='fpc' else None
    design=target.module('algorithms.survey.design').build_design(W*scale,st,ps,fpc)
    got=target.module('algorithms.survey.rao_scott').rao_scott_test(table_of(ROW,COL,W*scale),ROW,COL,design)
    assert got is not None
    for attr,key in [('statistic','F'),('numerator_df','ndf'),('denominator_df','ddf'),('p_value','p')]:
        assert getattr(got,attr)==pytest.approx(float(ref[key]),rel=2e-8,abs=1e-12)
    assert design.design_df==float(ref['design_df'])
    V=target.module('algorithms.survey.covariance').mean_covariance(X,design)
    np.testing.assert_allclose(V,[[float(cov['xx']),float(cov['xy'])],[float(cov['xy']),float(cov['yy'])]],rtol=2e-9,atol=1e-12)


def test_R_oneway_test_welch(target,r_reference):
    ref=next(csv.DictReader((r_reference/'welch.tsv').read_text().splitlines(),delimiter='\t'))
    groups=[[1,2,3,4,5],[4,5,6,7,8],[0,10,20,30,40,50,60]]
    got=target.module('algorithms.mining.subgroup')._test_numeric('a','q',['0','1','2'],sum(([str(i)]*len(g) for i,g in enumerate(groups)),[]),sum(groups,[]),{'0':[],'1':[],'2':[]})
    assert got['statistic']==pytest.approx(float(ref['F']),rel=1e-10)
    assert got['p_value']==pytest.approx(float(ref['p']),rel=1e-9)


def test_R_p_adjust_BH(target,r_reference):
    rows=list(csv.DictReader((r_reference/'bh.tsv').read_text().splitlines(),delimiter='\t'))
    ps=[float(r['p']) for r in rows];expected=[float(r['q']) for r in rows]
    actual,_=target.module('algorithms.mining.subgroup').benjamini_hochberg(ps)
    assert actual==pytest.approx(expected,abs=1e-14)
