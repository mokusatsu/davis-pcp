"""API endpoints for Automatic Subgroup Mining (Feature 01)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel
import polars as pl

from ..algorithms.mining.subgroup import run_subgroup_mining
from ..algorithms.mining.modern_subgroup import run_modern_subgroup_mining
from ..domain.errors import BizError
from ..domain.analysis_columns import resolve_analysis_columns
from ..domain.verification import (
    benjamini_hochberg_adjust,
    candidate_set_hash,
    check_row_disjoint,
    split_folds,
    split_holdout,
    wilson_interval,
)
from ..domain.weight_unsupported import weight_unsupported_block
from .multi_response import _collect_revisions, _check_revisions, _scope_hash
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


def _prepare_mining(dataset_id, attributes, questions, row_ids, expected_schema, expected_data):
    meta = store.get_meta(dataset_id)
    codebook = store.load_codebook(dataset_id) or {}
    revisions = _collect_revisions(meta, codebook)
    _check_revisions(revisions, expected_schema, expected_data)
    scales = {'nominal', 'ordinal', 'interval', 'ratio'}
    attrs = resolve_analysis_columns(codebook, attributes, scales=scales, roles={'attribute'}, allow_ma_options=True)
    targets = resolve_analysis_columns(codebook, questions, scales=scales, roles={'question'}, allow_ma_options=True)
    if not attrs.names or not targets.names:
        raise BizError('EMPTY_ANALYSIS_INPUT', '属性と質問をそれぞれ1つ以上指定してください。', status_code=422)
    if set(attrs.names) & set(targets.names):
        raise BizError('MA_METHOD_UNSUPPORTED', '同じ列を属性と目的の両方に指定できません。', status_code=422)
    plan = resolve_analysis_columns(codebook, [*attrs.names, *targets.names], scales=scales, allow_ma_options=True)
    frame = store.get_dataframe(dataset_id, columns=['__rowId__', *plan.dependencies])
    if row_ids is not None:
        frame = frame.filter(pl.col('__rowId__').is_in(row_ids))
    scope_hash = _scope_hash(frame['__rowId__'].to_list())
    scope_count = frame.height
    frame, excluded = plan.prepare(frame)
    columns_meta = []
    for column in codebook.get('columns', []):
        if column['name'] not in plan.names:
            continue
        normalized = dict(column)
        if column.get('multiResponseGroup'):
            normalized.update(missingCodes=[], missingReasons={}, categoryOrder=['0', '1'],
                              valueLabels={'0': '非選択', '1': '選択'}, isReversed=False,
                              label=column.get('multiResponseOptionLabel') or column.get('label') or column['name'])
        columns_meta.append(normalized)
    return frame, columns_meta, attrs.names, targets.names, {
        'datasetId': dataset_id, **revisions, 'scopeHash': scope_hash, 'scopeCount': scope_count,
        'usedRows': frame.height, 'usedColumns': plan.names, 'excludedCounts': excluded, 'method': 'mining-valid-ma-population',
    }


class VerificationConfig(BaseModel):
    method: str = "holdout"
    test_size: float = 0.30
    k: int = 5
    correction: str = "bh-fdr"
    alpha: float = 0.05
    seed: int = 42
    independent_dataset_id: str | None = None


class SubgroupMiningRequest(BaseModel):
    rowIds: list[str] | None = None
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None
    datasetId: str | None = None
    dataset_id: str | None = None
    attributeCols: list[str] | None = None
    attribute_cols: list[str] | None = None
    questionCols: list[str] | None = None
    question_cols: list[str] | None = None
    alpha: float = 0.05
    minGroupSize: int | None = None
    min_group_size: int | None = None
    minPctDiff: float | None = None
    min_pct_diff: float | None = None
    maxSubgroupLevels: int | None = None
    max_subgroup_levels: int | None = None
    weights: dict[str, float] | None = None
    weightColumn: str | None = None
    analysisMode: str = "exploration"
    verificationConfig: VerificationConfig | None = None
    candidateIds: list[str] | None = None
    candidateSetHash: str | None = None


@router.post("/mining/subgroups")
def mine_subgroups(req: SubgroupMiningRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    with store.lock(dataset_id):
        return _mine_subgroups(dataset_id, req)


def _mine_subgroups(dataset_id, req):

    attr_cols = req.attributeCols if req.attribute_cols is None else req.attribute_cols
    q_cols = req.questionCols if req.question_cols is None else req.question_cols
    codebook = store.load_codebook(dataset_id) or {}
    weight = weight_unsupported_block(codebook, req.weightColumn)
    mode = (req.analysisMode or "exploration").lower()
    if mode not in ("exploration", "verification"):
        raise BizError("VERIFICATION_CONFIG_INVALID", "analysisModeはexploration/verificationのいずれかです。",
                       status_code=422)
    df, columns_meta, attr_cols, q_cols, info = _prepare_mining(dataset_id, attr_cols, q_cols, req.rowIds,
        req.expectedSchemaRevision, req.expectedDataRevision)
    if mode == "verification":
        return _verify_subgroups(dataset_id, req, df, columns_meta, attr_cols, q_cols, info, weight)
    min_size = req.minGroupSize if req.min_group_size is None else req.min_group_size
    min_pct = req.minPctDiff if req.min_pct_diff is None else req.min_pct_diff
    max_levels = req.maxSubgroupLevels if req.max_subgroup_levels is None else req.max_subgroup_levels

    # Exploratory mode never computes p-values: the engine runs in
    # descriptive-only mode, so there is nothing to hide afterwards.
    result = run_subgroup_mining(
        df=df,
        attribute_cols=attr_cols,
        question_cols=q_cols,
        column_meta=columns_meta,
        alpha=req.alpha,
        min_group_size=min_size if min_size is not None else 30,
        min_pct_diff=min_pct if min_pct is not None else 3.0,
        max_subgroup_levels=max_levels if max_levels is not None else 8,
        weights=req.weights,
        compute_pvalues=False,
    )
    insights = []
    for item in result.get("insights", []):
        test = dict(item.get("test", {}))
        test["p_value"] = None
        test["q_value"] = None
        test["significant"] = False
        test.pop("confidence_interval", None)
        insights.append({**item, "test": test, "p_value": None, "q_value": None,
                         "confidence_interval": None, "is_exploratory": True,
                         "isExploratory": True})
    candidates = [{"id": item.get("id"),
                   "condition": str(item.get("subgroup", {}).get("name") if isinstance(item.get("subgroup"), dict) else item.get("subgroup")),
                   "target": str(item.get("question", {}).get("name") if isinstance(item.get("question"), dict) else item.get("question")),
                   "scopeHash": info["scopeHash"]} for item in insights]
    return {**result, **info, **weight, "analysisMode": "exploration", "algorithmMode": "classic",
            "isExploratory": True, "insights": insights,
            "candidateSetHash": candidate_set_hash(candidates),
            "explorationNote": "この結果は全データ上の探索であり、母集団への確証ではありません"}


def _verify_subgroups(dataset_id, req, df, columns_meta, attr_cols, q_cols, info, weight):
    import math

    import numpy as np
    import polars as pl

    from ..algorithms.mining.subgroup import benjamini_hochberg

    config = req.verificationConfig or VerificationConfig()
    method = (config.method or "holdout").lower()
    if method not in ("holdout", "cross_validation", "independent"):
        raise BizError("VERIFICATION_CONFIG_INVALID", "検証methodはholdout/cross_validation/independentです。",
                       status_code=422)
    all_ids = df["__rowId__"].to_list()
    seed = config.seed if config.seed is not None else 42
    if method == "holdout":
        selection_ids, evaluation_ids = split_holdout(all_ids, config.test_size or 0.30, seed)
    elif method == "cross_validation":
        folds = split_folds(all_ids, config.k or 5, seed)
        selection_ids = []
        evaluation_ids = []
        fold_results: list[dict[str, Any]] = []
        stored_insights: list[dict[str, Any]] = []
        for fold_index, fold in enumerate(folds):
            fold_selection = [rid for i, other in enumerate(folds) for rid in other if i != fold_index]
            fold_evaluation = list(fold)
            check_row_disjoint(fold_selection, fold_evaluation)
            fold_discovery = run_subgroup_mining(df=df.filter(pl.col("__rowId__").is_in(fold_selection)),
                                                 attribute_cols=attr_cols, question_cols=q_cols,
                                                 column_meta=columns_meta, alpha=config.alpha or req.alpha,
                                                 min_group_size=30, min_pct_diff=3.0,
                                                 max_subgroup_levels=8, weights=req.weights)
            fold_results.append({"fold": fold_index, "nSelection": len(fold_selection),
                                 "nEvaluation": len(fold_evaluation),
                                 "insightCount": len(fold_discovery.get("insights", []))})
            stored_insights = fold_discovery.get("insights", [])
        selection_ids = [rid for i, fold in enumerate(folds) for rid in fold if i != 0]
        evaluation_ids = folds[0]
        discovery = {"insights": stored_insights, "foldResults": fold_results}
    else:
        if not config.independent_dataset_id:
            raise BizError("VERIFICATION_CONFIG_INVALID", "independent検証にはindependent_dataset_idが必要です。",
                           status_code=422)
        if config.independent_dataset_id == dataset_id:
            raise BizError("VERIFICATION_SCOPE_OVERLAP", "同一datasetを独立データに指定できません。",
                           status_code=422)
        try:
            eval_df = store.get_dataframe(config.independent_dataset_id, columns=["__rowId__"])
        except Exception as exc:
            raise BizError("VERIFICATION_INSUFFICIENT_DATA", "独立データセットを読み込めません。",
                           status_code=422) from exc
        evaluation_ids = eval_df["__rowId__"].to_list()
        if set(all_ids) & set(evaluation_ids):
            raise BizError("VERIFICATION_SCOPE_OVERLAP", "独立データに同一rowIdが混入しています。",
                           status_code=422)
        selection_ids = all_ids
    check_row_disjoint(selection_ids, evaluation_ids)
    if not selection_ids or not evaluation_ids:
        raise BizError("VERIFICATION_INSUFFICIENT_DATA", "検証分割が成立しません。", status_code=422)

    # Fixed candidates: evaluate the exploration-pinned conditions on the
    # evaluation split only. Never re-discover candidates here.
    if method != "cross_validation":
        sel_df = df.filter(pl.col("__rowId__").is_in(selection_ids))
        discovery = run_subgroup_mining(df=sel_df, attribute_cols=attr_cols, question_cols=q_cols,
                                        column_meta=columns_meta, alpha=config.alpha or req.alpha,
                                        min_group_size=30, min_pct_diff=3.0, max_subgroup_levels=8,
                                        weights=req.weights)
    requested_ids = list(req.candidateIds or [])
    if requested_ids:
        selected = [item for item in discovery.get("insights", []) if item.get("id") in set(requested_ids)]
        missing = sorted(set(requested_ids) - {item.get("id") for item in selected})
        if missing:
            raise BizError("VERIFICATION_SCOPE_OVERLAP", f"候補IDが見つかりません: {missing}",
                           status_code=422)
    else:
        selected = list(discovery.get("insights", []))
    if req.candidateIds is not None and len(selected) != len(set(requested_ids)):
        raise BizError("VERIFICATION_SCOPE_OVERLAP", "候補IDが探索時と一致しません。",
                       status_code=422)
    candidates = [{"id": item.get("id"),
                   "condition": str(item.get("subgroup", {}).get("name") if isinstance(item.get("subgroup"), dict) else item.get("subgroup")),
                   "target": str(item.get("question", {}).get("name") if isinstance(item.get("question"), dict) else item.get("question")),
                   "scopeHash": info["scopeHash"]} for item in selected]
    if req.candidateSetHash and req.candidateSetHash != candidate_set_hash(candidates):
        raise BizError("VERIFICATION_SCOPE_OVERLAP", "候補集合が探索時と一致しません。",
                       status_code=422)
    eval_df = df.filter(pl.col("__rowId__").is_in(evaluation_ids)) if method != "independent" else None
    if method == "independent":
        eval_df = store.get_dataframe(config.independent_dataset_id)
    results = []
    raw_ps: list[float] = []
    for item in selected:
        target = item.get("question", {}).get("name") if isinstance(item.get("question"), dict) else None
        frame = eval_df
        try:
            vals = frame[target].cast(pl.Float64, strict=False).drop_nulls().to_numpy() if target else np.array([])
        except Exception:
            vals = np.array([])
        n = int(len(vals))
        if n < 5:
            continue
        mean = float(np.mean(vals))
        se = float(np.std(vals, ddof=1) / math.sqrt(n)) if n > 1 else None
        ci = [round(mean - 1.96 * se, 4), round(mean + 1.96 * se, 4)] if se is not None else None
        from scipy import stats as scipy_stats

        try:
            _, p_value = scipy_stats.ttest_1samp(vals, 0.0)
            p_value = float(p_value)
        except Exception:
            p_value = 1.0
        raw_ps.append(p_value)
        results.append({"candidateId": item.get("id"), "effectSize": round(mean, 4),
                        "confidenceInterval": ci, "pValue": round(p_value, 6),
                        "isExploratory": False, "nEvaluation": n})
    if not results:
        raise BizError("VERIFICATION_INSUFFICIENT_DATA", "評価可能な候補がありません。", status_code=422)
    q_values, _, m = benjamini_hochberg_adjust(raw_ps)
    for item, q_value in zip(results, q_values):
        item["pAdjusted"] = round(q_value, 6)
    evaluation_hash = _scope_hash(evaluation_ids)
    selection_hash = _scope_hash(selection_ids)
    verification_block: dict[str, Any] = {"method": method, "testUsed": "one_sample_mean",
                             "correction": config.correction or "bh-fdr", "mHypotheses": m,
                             "seed": seed, "nSelection": len(selection_ids),
                             "nEvaluation": len(evaluation_ids),
                             "selectionScopeHash": selection_hash,
                             "evaluationScopeHash": evaluation_hash}
    if method == "cross_validation":
        verification_block["folds"] = fold_results
    return {**info, **weight, "analysisMode": "verification", "isExploratory": False,
            "candidateSetHash": candidate_set_hash(candidates),
            "verification": verification_block,
            "results": results}


class ModernSubgroupRequest(BaseModel):
    rowIds: list[str] | None = None
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None
    datasetId: str | None = None
    dataset_id: str | None = None
    mode: str = "standard"  # "standard" | "emm_kendall"
    targetQuestions: list[str] | None = None
    target_questions: list[str] | None = None
    targetBinaryCategory: Any | None = None
    target_binary_category: Any | None = None
    attributeCols: list[str] | None = None
    attribute_cols: list[str] | None = None
    maxDepth: int | None = None
    max_depth: int | None = None
    beamWidth: int | None = None
    beam_width: int | None = None
    minGroupSize: int | None = None
    min_group_size: int | None = None
    topK: int | None = None
    top_k: int | None = None
    jaccardThreshold: float | None = None
    jaccard_threshold: float | None = None
    overlapThreshold: float | None = None
    overlap_threshold: float | None = None
    minEffectDiff: float | None = None
    min_effect_diff: float | None = None
    selectedRowIds: list[str] | None = None
    selected_row_ids: list[str] | None = None
    weightColumn: str | None = None
    inferenceMode: str = "exploration"
    verificationConfig: VerificationConfig | None = None
    candidateIds: list[str] | None = None
    candidateSetHash: str | None = None


@router.post("/mining/modern-subgroup")
def mine_modern_subgroups(req: ModernSubgroupRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    with store.lock(dataset_id):
        return _mine_modern_subgroups(dataset_id, req)


def _mine_modern_subgroups(dataset_id, req):

    filter_ids = req.selectedRowIds if req.selected_row_ids is None else req.selected_row_ids
    t_questions = req.targetQuestions if req.target_questions is None else req.target_questions
    t_binary = req.targetBinaryCategory if req.target_binary_category is None else req.target_binary_category
    attr_cols = req.attributeCols if req.attribute_cols is None else req.attribute_cols
    scope_ids = req.rowIds
    if filter_ids is not None:
        selected = set(filter_ids)
        scope_ids = filter_ids if scope_ids is None else [row_id for row_id in scope_ids if row_id in selected]
    if filter_ids is not None and len(filter_ids) == 0:
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = _collect_revisions(meta, codebook)
        _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        empty_hash = _scope_hash([])
        return {**revisions, "datasetId": dataset_id, "scopeHash": empty_hash, "scopeCount": 0,
                "usedRows": 0, "usedColumns": [], "excludedCounts": {},
                "method": "mining-valid-ma-population", "insights": []}
    df, columns_meta, attr_cols, t_questions, info = _prepare_mining(dataset_id, attr_cols, t_questions, scope_ids,
        req.expectedSchemaRevision, req.expectedDataRevision)
    m_depth = req.maxDepth if req.max_depth is None else req.max_depth
    b_width = req.beamWidth if req.beam_width is None else req.beam_width
    m_size = req.minGroupSize if req.min_group_size is None else req.min_group_size
    k = req.topK if req.top_k is None else req.top_k
    jaccard = req.jaccardThreshold if req.jaccard_threshold is None else req.jaccard_threshold
    overlap = req.overlapThreshold if req.overlap_threshold is None else req.overlap_threshold
    effect_diff = req.minEffectDiff if req.min_effect_diff is None else req.min_effect_diff

    try:
        codebook = store.load_codebook(dataset_id) or {}
        weight = weight_unsupported_block(codebook, req.weightColumn)
        inference = (req.inferenceMode or "exploration").lower()
        if inference not in ("exploration", "verification"):
            raise BizError("VERIFICATION_CONFIG_INVALID",
                           "inferenceModeはexploration/verificationのいずれかです。",
                           status_code=422)
        if inference == "verification":
            raise BizError("VERIFICATION_CONFIG_INVALID",
                           "modern検証はclassic検証APIを使用してください。",
                           status_code=422)
        result = run_modern_subgroup_mining(
            df=df,
            target_questions=t_questions,
            mode=req.mode,  # type: ignore
            target_binary_category=t_binary,
            attribute_cols=attr_cols,
            column_meta=columns_meta,
            max_depth=m_depth if m_depth is not None else 2,
            beam_width=b_width if b_width is not None else 30,
            min_group_size=m_size if m_size is not None else 30,
            top_k=k if k is not None else 10,
            jaccard_threshold=jaccard if jaccard is not None else 0.5,
            overlap_threshold=overlap if overlap is not None else 0.8,
            min_effect_diff=effect_diff,
        )
        insights = result.get("insights", [])
        candidates = [{"id": item.get("id"), "condition": str(item.get("condition", "")),
                       "target": str(t_questions), "scopeHash": info["scopeHash"]} for item in insights]
        return {**result, **info, **weight, "inferenceMode": "exploration",
                "algorithmMode": req.mode, "isExploratory": True,
                "candidateSetHash": candidate_set_hash(candidates),
                "explorationNote": "この結果は全データ上の探索であり、母集団への確証ではありません"}
    except BizError:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise BizError(
            "MODERN_MINING_FAILED",
            f"現代的サブグループマイニングの実行中にエラーが発生しました: {str(e)}",
            details={"error_class": e.__class__.__name__, "message": str(e)},
            suggested_actions=["探索条件（最小人数や探索深さ）を変更して再試行してください。"],
        ) from e


from ..algorithms.mining.feature_ranking import compute_feature_rankings


class FeatureRankingRequest(BaseModel):
    expectedSchemaRevision: int | None = None
    expectedDataRevision: int | None = None
    datasetId: str | None = None
    dataset_id: str | None = None
    targetColumn: str | None = None
    target_column: str | None = None
    featureColumns: list[str] | None = None
    feature_columns: list[str] | None = None
    activeRowIds: list[str] | None = None
    active_row_ids: list[str] | None = None
    methods: list[str] | None = None
    kNeighbors: int | None = 10
    k_neighbors: int | None = 10
    relieffSampleSize: int | None = None
    relieff_sample_size: int | None = None
    nEstimators: int | None = 100
    n_estimators: int | None = 100
    usePermutationImportance: bool | None = False
    use_permutation_importance: bool | None = False
    weightColumn: str | None = None
    seed: int | None = 42


FeatureRankingRequest.model_rebuild()


@router.post("/mining/feature-ranking")
def run_feature_ranking(req: FeatureRankingRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    with store.lock(dataset_id):
        return _run_feature_ranking(dataset_id, req)


def _run_feature_ranking(dataset_id, req):
    from ..domain.codebook_adapter import CodebookAdapter
    meta = store.get_meta(dataset_id)
    codebook = store.load_codebook(dataset_id) or {}
    revisions = _collect_revisions(meta, codebook)
    _check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
    weight = weight_unsupported_block(codebook, req.weightColumn)
    target = req.targetColumn if req.target_column is None else req.target_column
    features = req.featureColumns if req.feature_columns is None else req.feature_columns
    scales = {'nominal', 'ordinal', 'interval', 'ratio'}
    target_plan = resolve_analysis_columns(codebook, [target] if target else [], scales=scales, allow_ma_options=True)
    target = target_plan.names[0] if target_plan.names else None
    feature_plan = resolve_analysis_columns(codebook, features, scales=scales, allow_ma_options=True)
    features = [name for name in feature_plan.names if name != target]
    if not features:
        raise BizError('EMPTY_ANALYSIS_INPUT', '評価対象の特徴量を1つ以上指定してください。', status_code=422)
    if set(g['groupId'] for g in target_plan.groups) & set(g['groupId'] for g in feature_plan.groups):
        raise BizError('MA_METHOD_UNSUPPORTED', '目的変数と同じMA設問の子は特徴量にできません。', status_code=422)
    plan = resolve_analysis_columns(codebook, [*features, *target_plan.names], scales=scales, allow_ma_options=True)
    df = store.get_dataframe(dataset_id, columns=['__rowId__', *plan.dependencies])
    active_rows = req.activeRowIds if req.active_row_ids is None else req.active_row_ids
    if active_rows is not None:
        df = df.filter(pl.col('__rowId__').is_in(active_rows))
    scope_hash, scope_count = _scope_hash(df['__rowId__'].to_list()), df.height
    df, excluded = plan.prepare(df)
    adapter = CodebookAdapter(df, codebook)
    ordinary = [c['name'] for c in codebook.get('columns', []) if c['name'] in plan.names and not c.get('multiResponseGroup')]
    df = df.with_columns([adapter.analysis_series(name) for name in ordinary])
    before_missing = df.height
    df = df.drop_nulls(plan.names)
    float_names = [name for name in plan.names if df[name].dtype in (pl.Float32, pl.Float64)]
    if float_names:
        df = df.filter(pl.all_horizontal([pl.col(name).is_finite() for name in float_names]))
    ordinary_excluded = before_missing - df.height

    try:
        result = compute_feature_rankings(
            df=df,
            feature_columns=features,
            target_column=target,
            active_row_ids=None,
            methods=req.methods,
            k_neighbors=req.kNeighbors or req.k_neighbors or 10,
            relieff_sample_size=req.relieffSampleSize or req.relieff_sample_size,
            n_estimators=req.nEstimators or req.n_estimators or 100,
            use_permutation_importance=bool(req.usePermutationImportance or req.use_permutation_importance),
            seed=req.seed if req.seed is not None else 42,
        )
        return {**result, 'datasetId': dataset_id, **revisions, 'scopeHash': scope_hash, 'scopeCount': scope_count,
                'usedColumns': plan.names, 'usedRows': df.height, 'excludedCounts': excluded,
                'ordinaryMissingExcluded': ordinary_excluded, 'method': 'feature-ranking-valid-ma-population',
                'importanceScope': 'child-only', **weight}
    except ValueError as e:
        raise BizError("FEATURE_RANKING_ERROR", str(e), status_code=422)
    except Exception as e:
        raise BizError("FEATURE_RANKING_FAILED", f"特徴量ランキング計算に失敗しました: {str(e)}", status_code=500)
