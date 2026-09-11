"""表示・コードブック移送・サンプリング境界の追加契約。"""
from __future__ import annotations
import json
import tempfile
from unittest.mock import patch
import numpy as np
from audit_support import *
from app.api.distribution import get_fedf, FedfRequest
from app.api.regression import get_loess, LoessRequest
from app.api.observations import sample_observations, SamplingRequest


def complete_in_memory(coroutine):
    try:
        pending=coroutine.send(None)
    except StopIteration as completed:
        return completed.value
    finally:
        coroutine.close()
    raise RuntimeError(f'非同期I/Oテストへ移行してください: {pending!r}')


class EdgeContractTests(AuditCase):
    def test_AV07_equal_answers_have_equal_fedf_quantiles(self):
        d=fixture({'x':[1,1,1,1,3]},{'x':{'scaleType':'ratio'}})
        r=get_fedf(FedfRequest(datasetId=d,columns=['x']))
        quantiles=[v['x']['quantile'] for v in r['rowCoords'].values() if v.get('x',{}).get('val')==1]
        self.assertEqual(len(set(quantiles)),1)

    def test_AV08_constant_qq_does_not_claim_normality(self):
        d=fixture({'x':[1,1,1,1,1]},{'x':{'scaleType':'ratio'}})
        r=sm.qqplot_summary(sm.QQPlotRequest(datasetId=d,column='x'))
        self.assertIsNone(r['normalityTest']['pValue'])
        self.assertIsNone(r['normalityTest']['isNormalAlpha05'])

    def test_W09_inference_none_disables_cell_stars_too(self):
        d=fixture({'a':['x']*20+['y']*20,'b':['u']*20+['v']*20},{'a':{'scaleType':'nominal'},'b':{'scaleType':'nominal'}})
        r=xtab(d,inference='none')
        self.assertIsNone(r['inference']['pValue'])
        self.assertTrue(all(c['significance'] is None for c in r['cells']))

    def test_CTX06_sampling_can_reduce_more_than_100000_rows(self):
        # 大きな取込の性能試験ではない。実sampling関数の入力件数ガードだけを検査。
        from app.api import observations
        ids=['r'+str(i) for i in range(100001)]
        with patch.object(observations.store,'get_dataframe',return_value=pl.DataFrame({'__rowId__':ids})):
            r=self.ok(sample_observations,'synthetic',SamplingRequest(method='without_replacement',size=10,seed=42))
        self.assertEqual(r['sampleSize'],10)

    def test_PK05_codebook_json_roundtrip_restores_weight_and_design(self):
        d=fixture({'x':[1,2],'w':[1,2]}, {'w':{'role':'weight','scaleType':'ratio'}},weight=('w','survey'),design={'weightColumnId':'w'})
        payload=ds.export_codebook(d,format='json').body
        original=cb(d)
        ds.update_codebook(d,{'weightConfig':None,'surveyDesign':None})
        with tempfile.SpooledTemporaryFile(max_size=len(payload)+1,mode='w+b') as f:
            f.write(payload);f.seek(0)
            complete_in_memory(ds.import_codebook(d,UploadFile(filename='codebook.json',file=f)))
        self.assertEqual(cb(d).get('weightConfig'),original.get('weightConfig'))
        self.assertEqual(cb(d).get('surveyDesign'),original.get('surveyDesign'))

    def test_CTX07_summary_stale_revision_is_rejected(self):
        d=fixture({'x':[1,2,3]},{'x':{'scaleType':'ratio'}})
        self.rejects(summary,d,['x'],expectedDataRevision=999,status=409)

    def test_AV09_loess_uses_reversed_scores(self):
        d=fixture({'x':[1,2,3,4,5],'q':[1,2,3,4,5]}, {'x':{'scaleType':'ratio'},'q':{'scaleType':'interval','categoryOrder':['1','2','3','4','5'],'isReversed':True}})
        r=get_loess(LoessRequest(datasetId=d,xCol='x',yCol='q'))
        self.assertEqual([p['y'] for p in r['points']],[5.,4.,3.,2.,1.])

    def test_SE01_static_fallback_rejects_outside_directory(self):
        import importlib
        from fastapi import HTTPException
        root=WORKSPACE/'synthetic_web';dist=root/'frontend'/'dist'
        (dist/'assets').mkdir(parents=True,exist_ok=True)
        (dist/'index.html').write_text('<!doctype html><title>audit</title>')
        (root/'sentinel.txt').write_text('AUDIT-ONLY-NOT-A-USER-FILE')
        with patch.dict(os.environ,{'DAVIS_PCP_FRONTEND_DIST':str(dist)}):
            main=importlib.import_module('app.main')
        with patch.object(main,'_frontend_dist',dist):
            with self.assertRaises(HTTPException) as caught:
                complete_in_memory(main.spa_fallback('../../sentinel.txt'))
        self.assertEqual(caught.exception.status_code,404)


if __name__=='__main__':
    unittest.main(verbosity=2)
