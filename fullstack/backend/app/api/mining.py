"""API endpoints for Automatic Subgroup Mining (Feature 01)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel, field_validator
import polars as pl

from ..algorithms.mining.subgroup import run_subgroup_mining
from ..algorithms.mining.modern_subgroup import run_modern_subgroup_mining
from ..domain.errors import BizError
from ..domain.analysis_columns import resolve_analysis_columns
from ..domain.mining_candidate import (
    build_candidate_set,
    classic_candidate,
    modern_candidate,
)
from ..domain.verification import (
    benjamini_hochberg_adjust,
    check_row_disjoint,
    split_folds,
    split_holdout,
    wilson_interval,
)
from ..domain.weight_unsupported import weight_unsupported_block
from ..services.candidate_store import candidate_store
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

    @field_validator("correction")
    @classmethod
    def _check_correction(cls, value: str) -> str:
        from pydantic_core import PydanticCustomError

        allowed = {"bh", "bh-fdr"}
        if str(value).lower() not in allowed:
            raise PydanticCustomError(
                "verification_config_invalid",
                "correctionはbh/bh-fdrのいずれかです。",
            )
        return value

    @field_validator("alpha")
    @classmethod
    def _check_alpha(cls, value: float) -> float:
        from pydantic_core import PydanticCustomError

        if not (0.0 < float(value) < 1.0):
            raise PydanticCustomError(
                "verification_config_invalid",
                "alphaは0より大きく1より小さくしてください。",
            )
        return value

    @field_validator("k")
    @classmethod
    def _check_k(cls, value: int) -> int:
        from pydantic_core import PydanticCustomError

        if int(value) < 2:
            raise PydanticCustomError(
                "verification_config_invalid",
                "kは2以上にしてください。",
            )
        return value


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
    pinned = [candidate for candidate in (classic_candidate(item) for item in insights)
              if candidate is not None]
    candidate_set = build_candidate_set(
        dataset_id=dataset_id,
        data_revision=int(info.get("dataRevision", 1)),
        schema_revision=int(info.get("schemaRevision", 1)),
        scope_hash=str(info.get("scopeHash") or ""),
        algorithm="classic",
        parameters={
            "minGroupSize": min_size if min_size is not None else 30,
            "minPctDiff": min_pct if min_pct is not None else 3.0,
            "maxSubgroupLevels": max_levels if max_levels is not None else 8,
            "alpha": req.alpha,
            "weightColumn": req.weightColumn,
            "attributeCols": list(attr_cols),
            "questionCols": list(q_cols),
        },
        candidates=pinned,
    )
    if pinned:
        candidate_store.save(candidate_set)
    return {**result, **info, **weight, "analysisMode": "exploration", "algorithmMode": "classic",
            "isExploratory": True, "insights": insights,
            "candidateSetHash": candidate_set.candidateSetHash,
            "candidates": [{"candidateId": candidate.candidateId,
                            "displayLabel": candidate.displayLabel,
                            "estimand": candidate.estimand} for candidate in pinned],
            "explorationNote": "この結果は全データ上の探索であり、母集団への確証ではありません"}


def _load_candidate_set(dataset_id: str, req, info: dict[str, Any]) -> dict[str, Any]:
    """Load the exploration-pinned candidate set; never re-discover candidates."""
    hash_value = req.candidateSetHash
    if not hash_value:
        raise BizError("VERIFICATION_CANDIDATE_SET_REQUIRED",
                       "検証には探索時に発行されたcandidateSetHashが必要です。もう一度探索してください。",
                       status_code=422)
    stored = candidate_store.load(dataset_id, hash_value)
    if stored is None:
        raise BizError("VERIFICATION_CANDIDATE_SET_EXPIRED",
                       "候補集合が失効しました。もう一度探索してください。", status_code=409)
    if int(stored.get("dataRevision", -1)) != int(info.get("dataRevision", -1)):
        raise BizError("VERIFICATION_CANDIDATE_SET_EXPIRED",
                       "探索後にデータが変更されたため候補集合が失効しました。もう一度探索してください。",
                       status_code=409,
                       details={"explorationDataRevision": stored.get("dataRevision"),
                                "currentDataRevision": info.get("dataRevision")})
    if str(stored.get("scopeHash")) != str(info.get("scopeHash")):
        raise BizError("VERIFICATION_CANDIDATE_SET_EXPIRED",
                       "探索時と対象行が変わったため候補集合が失効しました。もう一度探索してください。",
                       status_code=409,
                       details={"explorationScopeHash": stored.get("scopeHash"),
                                "currentScopeHash": info.get("scopeHash")})
    if int(stored.get("schemaRevision", -1)) != int(info.get("schemaRevision", -1)):
        raise BizError("VERIFICATION_CANDIDATE_SET_EXPIRED",
                       "探索後にコードブックが変更されたため候補集合が失効しました。もう一度探索してください。",
                       status_code=409,
                       details={"explorationSchemaRevision": stored.get("schemaRevision"),
                                "currentSchemaRevision": info.get("schemaRevision")})
    if "maskRevision" in stored and "maskRevision" in info:
        if str(stored.get("maskRevision")) != str(info.get("maskRevision")):
            raise BizError("VERIFICATION_CANDIDATE_SET_EXPIRED",
                           "探索後にマスクが変更されたため候補集合が失効しました。もう一度探索してください。",
                           status_code=409)
    if stored.get("scoreSpecHash") is not None or info.get("scoreSpecHash") is not None:
        if str(stored.get("scoreSpecHash")) != str(info.get("scoreSpecHash")):
            raise BizError("VERIFICATION_CANDIDATE_SET_EXPIRED",
                           "探索後に得点仕様が変更されたため候補集合が失効しました。もう一度探索してください。",
                           status_code=409)
    if not stored.get("candidates"):
        raise BizError("VERIFICATION_INSUFFICIENT_DATA",
                       "候補集合に検証できる候補がありません。", status_code=422)
    return stored


def _weights_for(frame, weights_map: dict[str, float] | None):
    import numpy as np

    if not weights_map or "__rowId__" not in frame.columns:
        return None
    try:
        return np.array([float(weights_map.get(str(row_id), 1.0))
                         for row_id in frame["__rowId__"].to_list()], dtype=float)
    except (TypeError, ValueError):
        return None


def _independent_frame(eval_dataset_id: str, needed_columns: list[str]):
    """Load the independent evaluation dataset, applying MA projection when possible."""
    frame = store.get_dataframe(eval_dataset_id)
    codebook = store.load_codebook(eval_dataset_id) or {}
    try:
        plan = resolve_analysis_columns(codebook, list(needed_columns),
                                        scales={'nominal', 'ordinal', 'interval', 'ratio'},
                                        allow_ma_options=True)
        if plan.names:
            frame, _ = plan.prepare(frame)
    except Exception:
        pass
    return frame


def _collect_condition_columns(node: object, columns: list[str]) -> None:
    if isinstance(node, dict):
        column = node.get("column")
        if isinstance(column, str) and column:
            columns.append(column)
        for key in ("conditions", "and", "or", "args", "operands", "children"):
            children = node.get(key)
            if isinstance(children, list):
                for child in children:
                    _collect_condition_columns(child, columns)
        for key in ("not", "operand", "condition", "left", "right"):
            child = node.get(key)
            if isinstance(child, (dict, list)):
                _collect_condition_columns(child, columns)
    elif isinstance(node, list):
        for child in node:
            _collect_condition_columns(child, columns)


def _needed_columns(selected) -> list[str]:
    columns: list[str] = []
    for candidate in selected:
        rule = candidate.rule or {}
        estimand = candidate.estimand or {}
        for key in ("attribute", "question"):
            column = (rule.get(key) or {}).get("column")
            if column:
                columns.append(str(column))
        if rule.get("targetQuestion"):
            columns.append(str(rule["targetQuestion"]))
        for column in (rule.get("targetPair") or []):
            columns.append(str(column))
        _collect_condition_columns(rule.get("conditions"), columns)
        _collect_condition_columns(rule, columns)
        cell = estimand.get("cell") or {}
        for key in ("attributeColumn", "questionColumn"):
            if cell.get(key):
                columns.append(str(cell[key]))
    return sorted(set(columns))


def _eval_frame(df, codebook: dict, mean_difference_targets: set[str]):
    """Return the evaluation frame with analysis scores applied to target columns."""
    if not mean_difference_targets:
        return df
    from ..domain.codebook_adapter import CodebookAdapter

    adapter = CodebookAdapter(df, codebook)
    replacements = []
    for name in sorted(mean_difference_targets):
        if name not in df.columns:
            continue
        try:
            replacements.append(adapter.analysis_series(name))
        except Exception:
            continue
    if not replacements:
        return df
    return df.with_columns(replacements)


def _verify_subgroups(dataset_id, req, df, columns_meta, attr_cols, q_cols, info, weight):
    import polars as pl

    from ..algorithms.mining.verification_test import DEFAULT_MIN_GROUP_SIZE, compute_estimand
    from ..domain.mining_candidate import ESTIMAND_MEAN_DIFFERENCE, PinnedCandidate

    config = req.verificationConfig or VerificationConfig()
    method = (config.method or "holdout").lower()
    if method not in ("holdout", "cross_validation", "independent"):
        raise BizError("VERIFICATION_CONFIG_INVALID", "検証methodはholdout/cross_validation/independentです。",
                       status_code=422)
    if method == "independent" and not config.independent_dataset_id:
        raise BizError("VERIFICATION_CONFIG_INVALID", "independent検証にはindependent_dataset_idが必要です。",
                       status_code=422)
    if method == "independent" and config.independent_dataset_id == dataset_id:
        raise BizError("VERIFICATION_SCOPE_OVERLAP", "同一datasetを独立データに指定できません。",
                       status_code=422)

    # --- 1. pinned candidates (never re-discovered here) -------------------
    stored = _load_candidate_set(dataset_id, req, info)
    available = [PinnedCandidate(**item) for item in stored.get("candidates", [])]
    by_id = {candidate.candidateId: candidate for candidate in available}
    requested_ids = list(req.candidateIds or [])
    if requested_ids:
        missing = sorted(set(requested_ids) - set(by_id))
        if missing:
            raise BizError("VERIFICATION_CANDIDATE_UNKNOWN",
                           f"候補IDが探索時の候補集合に存在しません: {missing}",
                           status_code=422)
        selected = [by_id[candidate_id] for candidate_id in requested_ids]
    else:
        selected = list(available)

    # --- 2. split ----------------------------------------------------------
    all_ids = df["__rowId__"].to_list()
    seed = config.seed if config.seed is not None else 42
    alpha = float(config.alpha or req.alpha or 0.05)
    min_group_raw = req.minGroupSize if req.min_group_size is None else req.min_group_size
    min_group = int(min_group_raw) if min_group_raw is not None else DEFAULT_MIN_GROUP_SIZE
    if min_group < 2:
        min_group = 2
    codebook = store.load_codebook(dataset_id) or {}
    mean_targets = {str((candidate.rule.get("targetQuestion")
                         or ((candidate.rule.get("question") or {}).get("column")) or ""))
                    for candidate in selected
                    if str((candidate.estimand or {}).get("type") or "")
                    == ESTIMAND_MEAN_DIFFERENCE}
    mean_targets.discard("")
    evaluation_dataset_id = dataset_id
    folds: list[dict[str, Any]] = []
    if method == "holdout":
        selection_ids, evaluation_ids = split_holdout(all_ids, config.test_size or 0.30, seed)
        check_row_disjoint(selection_ids, evaluation_ids)
        if not selection_ids or not evaluation_ids:
            raise BizError("VERIFICATION_INSUFFICIENT_DATA", "検証分割が成立しません。", status_code=422)
        evaluation_frame = _eval_frame(df.filter(pl.col("__rowId__").is_in(evaluation_ids)),
                                       codebook, mean_targets)
    elif method == "cross_validation":
        fold_rows = split_folds(all_ids, config.k or 5, seed)
        for fold_index, fold in enumerate(fold_rows):
            fold_frame = _eval_frame(df.filter(pl.col("__rowId__").is_in(fold)),
                                     codebook, mean_targets)
            fold_weights = _weights_for(fold_frame, req.weights)
            fold_outcomes = [compute_estimand(fold_frame, candidate, fold_weights, min_group, seed, alpha)
                             for candidate in selected]
            fold_effects = []
            for outcome in fold_outcomes:
                effect_obj = outcome.get("effect") or {}
                detail = {key: value for key, value in effect_obj.items()
                          if key not in ("effect",)}
                fold_effects.append({
                    "candidateId": outcome["candidateId"],
                    "effect": effect_obj.get("estimate"),
                    "testable": outcome["testable"],
                    "n": outcome.get("n"),
                    "reason": outcome.get("reason"),
                    **({"detail": detail} if detail else {}),
                })
            folds.append({
                "fold": fold_index,
                "nEvaluation": len(fold),
                "testableCount": sum(1 for outcome in fold_outcomes if outcome["testable"]),
                "effects": fold_effects,
            })
        # Candidates are already pinned, so nothing is re-discovered per fold.
        # The headline result evaluates every row exactly once (its held-out fold).
        selection_ids = list(all_ids)
        evaluation_ids = list(all_ids)
        evaluation_frame = _eval_frame(df, codebook, mean_targets)
    else:
        evaluation_dataset_id = str(config.independent_dataset_id)
        try:
            evaluation_frame = _independent_frame(evaluation_dataset_id, _needed_columns(selected))
        except Exception as exc:
            raise BizError("VERIFICATION_INSUFFICIENT_DATA", "独立データセットを読み込めません。",
                           status_code=422) from exc
        if "__rowId__" not in evaluation_frame.columns:
            evaluation_frame = evaluation_frame.with_columns(
                pl.Series("__rowId__", [str(i) for i in range(evaluation_frame.height)]))
        selection_ids = list(all_ids)
        evaluation_ids = [str(v) for v in evaluation_frame["__rowId__"].to_list()]
        if not evaluation_ids:
            raise BizError("VERIFICATION_INSUFFICIENT_DATA", "独立データの行がありません。",
                           status_code=422)
        eval_codebook = store.load_codebook(evaluation_dataset_id) or {}
        evaluation_frame = _eval_frame(evaluation_frame, eval_codebook, mean_targets)

    # --- 3. estimand-preserving tests -------------------------------------
    eval_weights = _weights_for(evaluation_frame, req.weights)
    results = [compute_estimand(evaluation_frame, candidate, eval_weights, min_group, seed, alpha)
               for candidate in selected]
    posthoc_stability = method in ("holdout", "cross_validation")
    if posthoc_stability:
        for item in results:
            if isinstance(item.get("test"), dict):
                item["test"]["pValue"] = None
                item["test"]["pAdjusted"] = None
                item["test"]["significant"] = None
            else:
                item["test"] = {"name": None, "statistic": None, "pValue": None,
                                "df": None, "permutations": None,
                                "pAdjusted": None, "significant": None}
            item["replicationStatus"] = None
        testable = []
        raw_ps: list[float] = []
        q_values: list[float] = []
        m = 0
    else:
        testable = [item for item in results
                    if item["testable"] and isinstance(item.get("test"), dict)
                    and (item.get("test") or {}).get("pValue") is not None]
        raw_ps = [float(item["test"]["pValue"]) for item in testable]
        q_values, _, m = benjamini_hochberg_adjust(raw_ps) if raw_ps else ([], [], 0)
    testable_ids = {item["candidateId"] for item in testable}
    for item, q_value in zip(testable, q_values):
        item["test"]["pAdjusted"] = round(q_value, 6)
        item["test"]["significant"] = bool(q_value <= alpha)
    for item in results:
        if (not posthoc_stability and item["candidateId"] not in testable_ids
                and isinstance(item.get("test"), dict)):
            item["test"]["pAdjusted"] = None
            item["test"]["significant"] = False
    excluded = [item["candidateId"] for item in results if not item["testable"]]
    if not results:
        raise BizError("VERIFICATION_INSUFFICIENT_DATA", "評価可能な候補がありません。", status_code=422)

    tests_used = sorted({str((item.get("test") or {}).get("name")) for item in testable})
    verification_block: dict[str, Any] = {
        "method": method,
        "testUsed": tests_used,
        "estimand": "per_candidate",
        "alpha": alpha,
        "correction": config.correction or "bh-fdr",
        "mHypotheses": m,
        "mExcluded": len(excluded),
        "excludedCandidateIds": excluded,
        "seed": seed,
        "nSelection": len(selection_ids),
        "nEvaluation": len(evaluation_ids),
        "selectionScopeHash": _scope_hash(selection_ids),
        "evaluationScopeHash": _scope_hash(evaluation_ids),
        "analysisDatasetId": dataset_id,
        "evaluationDatasetId": evaluation_dataset_id,
        "rowIdNamespace": "dataset-scoped",
        "candidateSetHash": stored.get("candidateSetHash"),
        "pinnedCandidateIds": [candidate.candidateId for candidate in selected],
        "pinnedCandidateCount": len(selected),
        "explorationScopeHash": stored.get("scopeHash"),
        "explorationDataRevision": stored.get("dataRevision"),
        "minGroupSize": min_group,
    }
    if method == "cross_validation":
        verification_block["folds"] = folds
        verification_block["note"] = ("候補は探索時に固定済みのため、fold毎の安定性を参考表示します。"
                                      "見出しの結果は全行を1回ずつ評価したものです。")
    elif method == "holdout":
        verification_block["note"] = "候補は探索時のスコープで固定し、評価は分割した評価側のみで行いました。"
    else:
        verification_block["note"] = "候補は探索時のスコープで固定し、評価は独立データセットで行いました。"
    if posthoc_stability:
        verification_block["stabilityMode"] = "posthoc_stability"
        verification_block["note"] = ("探索に使った全行からの後付け分割のため、独立検証ではなく"
                                      "posthoc stabilityとして記述効果とfold安定性を参考表示します。")
        return {**info, **weight, "analysisMode": "posthoc_stability", "isExploratory": True,
                "candidateSetHash": stored.get("candidateSetHash"),
                "candidates": [{"candidateId": candidate.candidateId,
                                "displayLabel": candidate.displayLabel,
                                "estimand": candidate.estimand} for candidate in selected],
                "verification": verification_block,
                "results": results}
    return {**info, **weight, "analysisMode": "verification", "isExploratory": False,
            "candidateSetHash": stored.get("candidateSetHash"),
            "candidates": [{"candidateId": candidate.candidateId,
                            "displayLabel": candidate.displayLabel,
                            "estimand": candidate.estimand} for candidate in selected],
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
        pinned = [candidate for candidate in (modern_candidate(item) for item in insights)
                  if candidate is not None]
        candidate_set = build_candidate_set(
            dataset_id=dataset_id,
            data_revision=int(info.get("dataRevision", 1)),
            schema_revision=int(info.get("schemaRevision", 1)),
            scope_hash=str(info.get("scopeHash") or ""),
            algorithm="modern",
            parameters={
                "mode": req.mode,
                "maxDepth": m_depth if m_depth is not None else 2,
                "beamWidth": b_width if b_width is not None else 30,
                "minGroupSize": m_size if m_size is not None else 30,
                "topK": k if k is not None else 10,
                "jaccardThreshold": jaccard if jaccard is not None else 0.5,
                "overlapThreshold": overlap if overlap is not None else 0.8,
                "minEffectDiff": effect_diff,
                "targetQuestions": list(t_questions),
                "attributeCols": list(attr_cols),
                "weightColumn": req.weightColumn,
            },
            candidates=pinned,
        )
        if pinned:
            candidate_store.save(candidate_set)
        return {**result, **info, **weight, "inferenceMode": "exploration",
                "algorithmMode": req.mode, "isExploratory": True,
                "candidateSetHash": candidate_set.candidateSetHash,
                "candidates": [{"candidateId": candidate.candidateId,
                                "displayLabel": candidate.displayLabel,
                                "estimand": candidate.estimand} for candidate in pinned],
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
