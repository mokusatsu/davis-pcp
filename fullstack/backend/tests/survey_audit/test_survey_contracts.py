"""アンケート分析の固定契約。既知不具合もskip/expectedFailureにしない。"""
from __future__ import annotations
import io
import json
import zipfile
import numpy as np
from scipy import stats
from audit_support import *
from app.domain.codebook_adapter import CodebookAdapter
from app.domain.context import AnalysisContext, resolve_scope
from app.algorithms.survey.design import build_design
from app.algorithms.survey.covariance import linearized_total_covariance
from app.api.distribution import get_fedf, FedfRequest
from app.api.observations import sample_observations, SamplingRequest, select_range_observations, RangeSelectionRequest
from app.api import mining as mi, multi_response as ma, robustness as rb, models
from app.domain.mining_candidate import modern_candidate
from app.algorithms.mining.verification_test import compute_estimand


class AnalysisValueTests(AuditCase):
    def test_AV01_ordinal_score_is_subset_invariant(self):
        d = fixture({'x': [5, 1, 3]}, {'x': {'scaleType': 'ordinal', 'categoryOrder': [], 'valueLabels': {}}})
        all_scores = CodebookAdapter(frame(d), cb(d)).analysis_series('x').to_list()
        subset = CodebookAdapter(frame(d).slice(1, 1), cb(d)).analysis_series('x').to_list()
        self.assertEqual(subset, [all_scores[1]], '同じ回答コードの得点をsubsetで変えない')

    def test_AV01_declared_order_has_same_scores_after_row_shuffle(self):
        d = fixture({'x': [5, 1, 3]}, {'x': {'scaleType': 'ordinal', 'categoryOrder': ['1','2','3','4','5']}})
        adapter = CodebookAdapter(frame(d), cb(d))
        self.assertEqual(adapter.analysis_series('x').to_list(), [5., 1., 3.])
        self.assertEqual(CodebookAdapter(frame(d).reverse(), cb(d)).analysis_series('x').to_list(), [3., 1., 5.])

    def test_AV02_reversed_identity_weights_match(self):
        d = fixture({'x': [1,3,9], 'w': [1,1,1]}, {'x': {'scaleType': 'interval', 'categoryOrder': ['1','2','3','4','5'], 'isReversed': True}, 'w': {'role':'weight','scaleType':'ratio'}}, weight=('w','survey'))
        r = summary(d, ['x'], weightColumn='w')['columns']['x']
        self.assertAlmostEqual(r['mean'], r['weighted']['weightedMean'], places=4)

    def test_AV02_out_of_domain_is_not_used_to_expand_reverse_bounds(self):
        d = fixture({'x':[1,3,9]}, {'x':{'scaleType':'interval','categoryOrder':['1','2','3','4','5'],'isReversed':True}})
        r = summary(d,['x'])['columns']['x']
        self.assertEqual(r['count'],2)
        self.assertAlmostEqual(r['mean'],4.)

    def test_AV03_numeric_garbage_not_scored_as_category_rank(self):
        d = fixture({'x':['1','oops','3'],'w':[1,1,1]}, {'x':{'scaleType':'ratio'},'w':{'role':'weight','scaleType':'ratio'}},weight=('w','survey'))
        r = summary(d,['x'],weightColumn='w')['columns']['x']
        self.assertAlmostEqual(r['weighted']['weightedMean'],2.,places=4)

    def test_AV03_numeric_valid_denominator_matches_numeric_count(self):
        d = fixture({'x':['1','oops','3']},{'x':{'scaleType':'ratio'}})
        r=summary(d,['x'])['columns']['x']
        self.assertEqual(r['denominators']['valid'],r['count'])

    def test_AV04_legacy_schema_cannot_store_invalid_role_and_order_type(self):
        d=fixture({'x':['a','b','a']},{'x':{'scaleType':'nominal'}})
        self.rejects(ds.patch_schema,d,ds.SchemaPatch(columns=[{'name':'x','categoryOrder':'alphabetical','role':'categorical_axis'}]))

    def test_AV05_leading_zero_codes_default_to_nominal(self):
        d=fixture({'code':['001','002','003']})
        self.assertEqual(spec(d,'code')['scaleType'],'nominal')
        self.assertEqual(frame(d)['code'].to_list(),['001','002','003'])

    def test_AV06_fedf_omitted_columns_same_as_explicit(self):
        d=fixture({'x':[1,2,3,4,99]},{'x':{'scaleType':'ratio','missingCodes':['99']}})
        a=get_fedf(FedfRequest(datasetId=d,columns=['x']))
        b=get_fedf(FedfRequest(datasetId=d))
        # メタデータではなく数値結果を比較する。
        self.assertEqual(a['statistics'],b['statistics'])
        self.assertEqual(a['profiles'],b['profiles'])

    def test_AV06_qqplot_excludes_codebook_missing(self):
        d=fixture({'x':[1,2,3,4,99]},{'x':{'scaleType':'ratio','missingCodes':['99']}})
        r=sm.qqplot_summary(sm.QQPlotRequest(datasetId=d,column='x'))
        self.assertEqual(r['count'],4)


class WeightTests(AuditCase):
    def test_W01_declared_weight_default_is_identical_across_endpoints(self):
        d=fixture({'a':A,'b':B,'w':[1,1,10,1,10,10]},WEIGHT_PATCH,weight=('w','survey'))
        self.assertEqual(summary(d,['a'])['weightApplied'],xtab(d)['meta']['weightApplied'])
        self.assertTrue(summary(d,['a'])['weightApplied'],'未指定=dataset設定、明示noneは別フィールド')

    def test_W02_frequency_fractions_rejected_in_summary(self):
        d=fixture({'a':A,'b':B,'w':[1.5]*6},WEIGHT_PATCH,weight=('w','frequency'))
        self.rejects(summary,d,['a'],weightColumn='w')

    def test_W02_frequency_fractions_rejected_in_crosstab(self):
        d=fixture({'a':A,'b':B,'w':[1.5]*6},WEIGHT_PATCH,weight=('w','frequency'))
        self.rejects(xtab,d,weightColumn='w')

    def test_W03_small_positive_survey_weights_are_not_zero(self):
        d=fixture({'a':A,'b':B,'w':[1e-7]*6},WEIGHT_PATCH,weight=('w','survey'))
        r=self.ok(xtab,d,inference='rao_scott',weightColumn='w')
        self.assertEqual(r['inference']['status'],'ok')
        self.assertIsNotNone(r['inference']['pValue'])

    def test_W03_rescaling_does_not_change_survey_p_or_percentages(self):
        rs=[]
        for scale in (1.,100.):
            d=fixture({'a':A,'b':B,'w':[scale]*6},WEIGHT_PATCH,weight=('w','survey'))
            rs.append(xtab(d,inference='rao_scott',weightColumn='w'))
        self.assertAlmostEqual(rs[0]['inference']['pValue'],rs[1]['inference']['pValue'],places=10)
        self.assertEqual([c['rowPct'] for c in rs[0]['cells']],[c['rowPct'] for c in rs[1]['cells']])

    def test_W04_weighted_correlation_uses_pairwise_weights(self):
        x=np.array([0.,1.,2.,10.]); y=np.array([0.,1.,9.,1.]); w=np.array([1.,1.,1.,100.])
        dx=x-np.average(x,weights=w); dy=y-np.average(y,weights=w)
        expected=float(np.sum(w*dx*dy)/np.sqrt(np.sum(w*dx*dx)*np.sum(w*dy*dy)))
        d=fixture({'x':x.tolist(),'y':y.tolist(),'w':w.tolist()}, {'x':{'scaleType':'ratio'},'y':{'scaleType':'ratio'},'w':{'role':'weight','scaleType':'ratio'}},weight=('w','survey'))
        r=summary(d,['x','y'],weightColumn='w',correlation=True)
        self.assertAlmostEqual(r['correlation']['matrix'][0][1],expected,places=4)

    def test_W05_effective_weight_diagnostics_match_table_base(self):
        d=fixture({'a':A+['x'],'b':B+[None],'w':[1]*6+[100]},WEIGHT_PATCH,weight=('w','survey'))
        r=xtab(d,weightColumn='w'); diag=r['weightDiagnostics']
        self.assertAlmostEqual(diag['weightSum'],r['grandTotal']['count'])
        self.assertEqual(diag['positiveWeightN'],6)
        self.assertAlmostEqual(diag['kishEffectiveN'],6.)

    def test_W06_missing_weight_code_is_excluded(self):
        d=fixture({'x':[0,10],'w':[1,99]}, {'x':{'scaleType':'ratio'},'w':{'role':'weight','scaleType':'ratio','missingCodes':['99']}},weight=('w','survey'))
        r=summary(d,['x'],weightColumn='w')
        self.assertAlmostEqual(r['columns']['x']['weighted']['weightedMean'],0.)
        self.assertEqual(r['weightMissingCount'],1)

    def test_W07_ma_weighted_numerator_and_denominator(self):
        d=fixture({'o1':[1,0],'o2':[0,1],'w':[9,1]},self.ma_patch(),weight=('w','survey'))
        r=ma.summarize_multi_response(ma.MultiResponseSummaryRequest(datasetId=d,groupIds=['MA'],weightColumn='w'))
        self.assertEqual(sorted(o['pctRespondent'] for o in r['groups'][0]['items']),[10.,90.])

    @staticmethod
    def ma_patch():
        return {'o1':{'role':'question','scaleType':'nominal','multiResponseGroup':'MA'},'o2':{'role':'question','scaleType':'nominal','multiResponseGroup':'MA'},'w':{'role':'weight','scaleType':'ratio'}}

    def test_W07_ma_invalid_weight_outside_scope_does_not_disable_weighting(self):
        d=fixture({'o1':[1,0,1],'o2':[0,1,0],'w':[9,1,-1]},self.ma_patch(),weight=('w','survey'))
        r=ma.summarize_multi_response(ma.MultiResponseSummaryRequest(datasetId=d,groupIds=['MA'],rowIds=frame(d)['__rowId__'].to_list()[:2],weightColumn='w'))
        self.assertEqual(sorted(o['pctRespondent'] for o in r['groups'][0]['items']),[10.,90.])

    def test_W08_survey_default_has_no_inferential_p_or_cell_stars(self):
        d=fixture({'a':A,'b':B,'w':[1]*6},WEIGHT_PATCH,weight=('w','survey'))
        r=xtab(d,weightColumn='w')
        self.assertIsNone(r['inference']['pValue'])
        self.assertTrue(all(c['significance'] is None for c in r['cells']))

    def test_W08_weights_only_inference_is_flagged_approximate(self):
        d=fixture({'a':A,'b':B,'w':[1]*6},WEIGHT_PATCH,weight=('w','survey'))
        r=xtab(d,inference='rao_scott',weightColumn='w')
        self.assertTrue(r['inference']['approximate'])
        self.assertEqual(r['inference']['designAssumption'],'independent_rows')


class SurveyDesignTests(AuditCase):
    def test_SD01_strata_not_discarded_without_explicit_psu(self):
        d=build_design(np.ones(4),strata=np.array(['s1','s1','s2','s2']))
        self.assertEqual(d.number_of_strata,2)
        self.assertEqual(d.design_df,2.)

    def test_SD01_stratified_covariance_independent_oracle(self):
        d=build_design(np.ones(4),strata=np.array(['s1','s1','s2','s2']))
        result=linearized_total_covariance(np.array([[0.],[2.],[10.],[12.]]),d)
        # 2*( (-1)^2+1^2 ) を2層で加算 = 8。
        np.testing.assert_allclose(result,[[8.]],rtol=1e-12,atol=1e-12)

    def test_SD02_nested_local_psu_ids_do_not_change_df(self):
        strata=np.array(['s1']*4+['s2']*4)
        local=build_design(np.ones(8),strata=strata,psu=np.array(['1','1','2','2']*2))
        unique=build_design(np.ones(8),strata=strata,psu=np.array(['s1-1','s1-1','s1-2','s1-2','s2-1','s2-1','s2-2','s2-2']))
        self.assertEqual(local.number_of_psus,4)
        self.assertEqual(local.design_df,unique.design_df)

    def test_SD03_missing_psu_is_not_a_literal_cluster(self):
        with self.assertRaises((ValueError,BizError)):
            build_design(np.ones(4),strata=np.array(['s']*4),psu=np.array([None,None,'p2','p2'],dtype=object))

    def test_SD04_lonely_psu_does_not_report_successful_design_inference(self):
        d=fixture({'a':['x','x','y','y']*3,'b':['u','v','u','v']*3,'w':[1,2,2,6,1,3,4,4,2,1,1,8],
                   's':['S1']*8+['S2']*4,'p':['p1']*4+['p2']*4+['p3']*4},WEIGHT_PATCH,weight=('w','survey'),
                   design={'weightColumnId':'w','strataColumnId':'s','psuColumnId':'p'})
        r=xtab(d,inference='rao_scott',weightColumn='w')
        self.assertEqual(r['inference']['status'],'unavailable')
        self.assertIsNone(r['inference']['pValue'])

    def test_SD05_invalid_fpc_cannot_turn_variance_to_zero(self):
        with self.assertRaises((ValueError,BizError)):
            d=build_design(np.ones(4),strata=np.array(['s']*4),psu=np.array(['p1','p1','p2','p2']),fpc=np.ones(4))
            linearized_total_covariance(np.array([[1.],[3.],[2.],[4.]]),d)

    def test_SD06_changing_weight_invalidates_stale_design_atomically(self):
        d=fixture({'x':[1,2],'w':[1,2],'w2':[2,1]}, {'w':{'role':'weight','scaleType':'ratio'},'w2':{'role':'weight','scaleType':'ratio'}},weight=('w','survey'),design={'weightColumnId':'w'})
        ds.update_codebook(d,{'weightConfig':{'weightColumnId':column_id(d,'w2'),'weightType':'survey'}})
        self.assertIsNone(cb(d).get('surveyDesign'),'設計を再指定しない重み変更時は旧設計を解除する')


class ImputationHistoryPackageTests(AuditCase):
    def test_IM01_missing_code_neither_donor_nor_unfilled_ordinary_missing(self):
        d=fixture({'x':[1,3,99,None]},{'x':{'scaleType':'ratio','missingCodes':['99']}})
        ds.impute_dataset(d,ds.ImputeRequest(columns=['x'],strategy='mean',inPlace=True))
        self.assertEqual(frame(d)['x'].to_list(),[1.,3.,2.,2.])

    def test_IM02_plan_hash_changes_on_missing_semantics_change(self):
        d=fixture({'x':[1,3,None]},{'x':{'scaleType':'ratio'}})
        a=ds.preview_dataset_imputation(d,ds.ImputePreviewRequest(columns=['x'],strategy='mean'))
        ds.update_codebook(d,{'columns':[{'name':'x','missingCodes':['3']}]})
        b=ds.preview_dataset_imputation(d,ds.ImputePreviewRequest(columns=['x'],strategy='mean'))
        self.assertNotEqual(a['planHash'],b['planHash'])

    def test_IM02_old_plan_rejected_after_schema_change(self):
        d=fixture({'x':[1,3,None]},{'x':{'scaleType':'ratio'}})
        a=ds.preview_dataset_imputation(d,ds.ImputePreviewRequest(columns=['x'],strategy='mean'))
        ds.update_codebook(d,{'columns':[{'name':'x','missingCodes':['3']}]})
        self.rejects(ds.impute_dataset,d,ds.ImputeRequest(columns=['x'],strategy='mean',planHash=a['planHash']),status=409)

    def test_IM03_fractional_imputation_not_truncated(self):
        d=fixture({'x':[1,None,5]},{'x':{'scaleType':'ratio'}})
        with self.assertRaises(BizError) as caught:
            ds.impute_dataset(d,ds.ImputeRequest(columns=['x'],strategy='constant',options={'constant_value':2.5}))
        self.assertEqual(caught.exception.code,'IMPUTATION_CONSTANT_INVALID')
        self.assertEqual(frame(d)['x'].to_list(),[1,None,5])

    def test_H01_undo_restores_values_summary_and_mask(self):
        d=fixture({'x':[1,3,None]},{'x':{'scaleType':'ratio'}})
        ds.impute_dataset(d,ds.ImputeRequest(columns=['x'],strategy='constant',options={'constant_value':9}))
        summary(d,['x'])
        ds.undo_dataset(d,ds.UndoRedoRequest())
        self.assertEqual(frame(d)['x'].to_list(),[1.,3.,None])
        self.assertAlmostEqual(summary(d,['x'])['columns']['x']['mean'],2.)
        self.assertEqual((ds.store.load_mask(d) or {}).get('entries',[]),[])

    def test_H02_second_undo_never_redoes_the_imputation(self):
        d=fixture({'x':[1,3,None]},{'x':{'scaleType':'ratio'}})
        ds.impute_dataset(d,ds.ImputeRequest(columns=['x'],strategy='constant',options={'constant_value':9}))
        ds.undo_dataset(d,ds.UndoRedoRequest())
        self.rejects(ds.undo_dataset,d,ds.UndoRedoRequest(),status=409)
        self.assertIsNone(frame(d)['x'].to_list()[2])

    def test_H03_calculated_column_undo_restores_schema(self):
        d=fixture({'x':[1,2,3]},{'x':{'scaleType':'ratio'}})
        ds.calculate_dataset_variable(d,ds.CalculateRequest(columnName='z',expression='x+1'))
        ds.undo_dataset(d,ds.UndoRedoRequest())
        self.assertNotIn('z',frame(d).columns)
        self.assertNotIn('z',[c['name'] for c in cb(d)['columns']])
        self.ok(summary,d)

    def test_H04_delete_removes_raw_and_revision_files(self):
        d=fixture({'x':[1,3,None]},{'x':{'scaleType':'ratio'}})
        ds.impute_dataset(d,ds.ImputeRequest(columns=['x'],strategy='mean'))
        ds.delete_dataset(d)
        self.assertEqual(list(ds.store.root.glob(d+'.*')),[])

    def test_PK01_reserved_id_input_is_rejected_not_overwritten(self):
        self.rejects(fixture,{'__rowId__':['a','a'],'q':[1,2]})

    def package(self):
        d=fixture({'x':[1,3,None]},{'x':{'scaleType':'ratio'}})
        ds.impute_dataset(d,ds.ImputeRequest(columns=['x'],strategy='mean'))
        return d,ds.export_package(d).body

    def test_PK02_package_roundtrip_preserves_original_missing_raw(self):
        source,payload=self.package()
        imported=import_memory_package(payload)['datasetId']
        self.assertEqual(ds.store.read_raw(imported)['x'].to_list(),ds.store.read_raw(source)['x'].to_list())
        self.assertEqual(frame(imported)['x'].to_list(),[1.,3.,2.])

    def test_PK03_package_import_rebinds_codebook_dataset_id(self):
        _,payload=self.package()
        imported=import_memory_package(payload)['datasetId']
        self.assertEqual(cb(imported)['datasetId'],imported)

    def test_PK03_package_import_rebinds_session_dataset_id(self):
        _,payload=self.package()
        r=import_memory_package(payload)
        self.assertEqual(r['sessionState']['datasetId'],r['datasetId'])

    def test_PK04_manifest_must_cover_every_payload(self):
        _,payload=self.package()
        with zipfile.ZipFile(io.BytesIO(payload)) as z: files={n:z.read(n) for n in z.namelist()}
        m=json.loads(files['manifest.json']);m['files']=[];files['manifest.json']=json.dumps(m).encode()
        b=io.BytesIO()
        with zipfile.ZipFile(b,'w') as z:
            for n,v in files.items(): z.writestr(n,v)
        self.rejects(import_memory_package,b.getvalue())


class ScopeModelTests(AuditCase):
    def test_CTX01_empty_active_stays_empty(self):
        self.assertEqual(resolve_scope(['a','b'],AnalysisContext(datasetId='x',scope='active',activeRowIds=[])),[])

    def test_CTX01_empty_sampled_stays_empty(self):
        self.assertEqual(resolve_scope(['a','b'],AnalysisContext(datasetId='x',scope='sampled',sampledRowIds=[])),[])

    def test_CTX01_empty_explicit_is_valid_empty_scope(self):
        r=self.ok(lambda: resolve_scope(['a','b'],AnalysisContext(datasetId='x',scope='explicit',rowIds=[])))
        self.assertEqual(r,[])

    def test_CTX02_range_rejects_nonexistent_active_id(self):
        d=fixture({'x':[1,2,3]})
        self.rejects(select_range_observations,d,RangeSelectionRequest(fromIndex=0,toIndex=1,activeRowIds=['not-real']))

    def test_CTX03_sampling_rejects_nonexistent_active_id(self):
        d=fixture({'x':[1,2,3]})
        self.rejects(sample_observations,d,SamplingRequest(method='without_replacement',size=1,activeRowIds=['not-real']))

    def test_CTX04_shared_scope_replacement_sampling_disabled_until_multiplicity_supported(self):
        d=fixture({'x':[0,10,100]},{'x':{'scaleType':'ratio'}})
        self.rejects(sample_observations,d,SamplingRequest(method='with_replacement',size=5,seed=42))

    def test_CTX05_kda_stale_data_revision_is_rejected(self):
        d=fixture({'x':list(range(1,9)),'q':list(range(3,18,2))},{'x':{'role':'attribute','scaleType':'ratio'},'q':{'role':'question','scaleType':'ratio'}})
        self.rejects(models.calculate_kda,models.KdaRequest(datasetId=d,outcome='q',drivers=['x'],expectedDataRevision=999),status=409)

    def test_CTX05_kda_row_scope_is_applied(self):
        d=fixture({'x':list(range(1,9)),'q':list(range(3,18,2))},{'x':{'role':'attribute','scaleType':'ratio'},'q':{'role':'question','scaleType':'ratio'}})
        ids=frame(d)['__rowId__'].to_list()[:4]
        r=models.calculate_kda(models.KdaRequest(datasetId=d,outcome='q',drivers=['x'],rowIds=ids))
        self.assertEqual(r['model']['n_valid'],4)

    def test_MD01_tree_class_counts_sum_to_node_count(self):
        d=fixture({'x':list(range(20)),'q':['yes']*9+['no']*11},{'x':{'role':'attribute','scaleType':'ratio'},'q':{'role':'question','scaleType':'nominal'}})
        r=models.create_model(models.ModelRequest(datasetId=d,features=['x'],target='q',taskType='classification',maxDepth=2))
        root=r['treeStructures'][0]
        self.assertEqual(sum(v['count'] for v in root['values']),20)
        self.assertEqual(sorted(v['count'] for v in root['values']),[9,11])


class MiningVerificationTests(AuditCase):
    def exploration(self):
        d=fixture({'g':['A']*40+['B']*40,'q':[1,2]*20+[4,5]*20},REVERSED_PATCH)
        base=dict(datasetId=d,attributeCols=['g'],questionCols=['q'],minGroupSize=5,minPctDiff=0)
        result=mi.mine_subgroups(mi.SubgroupMiningRequest(**base))
        return d,base,result

    def verify(self,base,expl,method='holdout',**config):
        return mi.mine_subgroups(mi.SubgroupMiningRequest(**base,analysisMode='verification',candidateSetHash=expl['candidateSetHash'],verificationConfig={'method':method,'seed':42,'k':5,**config}))

    def test_V01_posthoc_holdout_not_confirmatory(self):
        _,base,expl=self.exploration()
        r=self.verify(base,expl)
        self.assertTrue(r['isExploratory'],'探索に使った全行から後で分割しても独立検証ではない')
        self.assertTrue(all(x['test']['pAdjusted'] is None for x in r['results']))

    def test_V01_posthoc_cv_not_confirmatory(self):
        _,base,expl=self.exploration()
        r=self.verify(base,expl,method='cross_validation')
        self.assertTrue(r['isExploratory'])
        self.assertTrue(all(x['test']['pAdjusted'] is None for x in r['results']))

    def test_V02_verification_uses_reversed_analysis_scores(self):
        _,base,expl=self.exploration()
        r=self.verify(base,expl,method='cross_validation')['results'][0]
        self.assertAlmostEqual(r['effect']['estimate'],3.,places=10)
        self.assertTrue(r['directionConsistent'])

    def test_V03_all_five_cv_folds_have_effect_values(self):
        _,base,expl=self.exploration()
        folds=self.verify(base,expl,method='cross_validation')['verification']['folds']
        self.assertEqual(len(folds),5)
        self.assertTrue(all(f['effects'] and all(e['effect'] is not None for e in f['effects']) for f in folds))

    def test_V04_candidate_stale_schema_is_rejected(self):
        d,base,expl=self.exploration()
        ds.update_codebook(d,{'columns':[{'name':'q','isReversed':False}]})
        self.rejects(self.verify,base,expl,status=409)

    def test_V05_unknown_correction_is_rejected(self):
        _,base,expl=self.exploration()
        self.rejects(self.verify,base,expl,correction='not-a-method')

    def test_V06_modern_rule_columns_in_independent_frame(self):
        p=modern_candidate({'id':'m1','target_question':'q','rule':{'conditions':[{'column':'g','operator':'==','value':'A'}]},'effect_size':3.})
        self.assertIn('g',mi._needed_columns([p]))

    def test_V07_nominal_modern_target_pins_proportion_not_mean(self):
        p=modern_candidate({'id':'m1','target_question':'q','chosen_category':'yes','target_type':'binary','rule':{'conditions':[{'column':'g','operator':'==','value':'A'}]},'effect_size':.5})
        f=pl.DataFrame({'__rowId__':[str(i) for i in range(8)],'g':['A']*4+['B']*4,'q':['yes','yes','yes','no','yes','no','no','no']})
        r=compute_estimand(f,p,None,2,42,.05)
        self.assertTrue(r['testable'])
        self.assertAlmostEqual(r['effect']['estimate'],.5)


class SensitivityTests(AuditCase):
    def test_SN01_sensitivity_matches_missing_and_reverse_contract(self):
        d=fixture({'g':['A']*4+['B']*4,'q':[1,1,2,2,4,4,5,99]},REVERSED_PATCH)
        r=rb.run_sensitivity(rb.SensitivityRequest(datasetId=d,targetColumn='q',candidate={'type':'subgroup_diff','groupColumn':'g','compareGroups':['A','B']},threshold=100))
        self.assertAlmostEqual(r['baseline']['effectSize'],17/6,places=4)
        self.assertEqual(r['baseline']['n'],7)

    def test_SN02_group_diff_without_groups_is_not_overall_mean(self):
        d=fixture({'q':[1,2,3]},{'q':{'scaleType':'ratio'}})
        self.rejects(rb.run_sensitivity,rb.SensitivityRequest(datasetId=d,targetColumn='q',candidate={'type':'subgroup_diff'},threshold=100))

    def test_SN03_kpi_small_sample_uses_student_t_interval(self):
        values=np.array([1.,2.,3.,4.]);mean=float(values.mean())
        radius=float(stats.t.ppf(.975,3)*values.std(ddof=1)/np.sqrt(4))
        d=fixture({'q':values.tolist()},{'q':{'scaleType':'ratio'}})
        r=rb.run_sensitivity(rb.SensitivityRequest(datasetId=d,targetColumn='q',candidate={'type':'kpi'},threshold=100))
        np.testing.assert_allclose(r['baseline']['confidenceInterval'],[mean-radius,mean+radius],atol=1e-4,rtol=0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
