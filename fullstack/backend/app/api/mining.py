"""API endpoints for Automatic Subgroup Mining (Feature 01)."""
from __future__ import annotations

from typing import Any
from fastapi import APIRouter
from pydantic import BaseModel
import polars as pl

from ..algorithms.mining.subgroup import run_subgroup_mining
from ..algorithms.mining.modern_subgroup import run_modern_subgroup_mining
from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class SubgroupMiningRequest(BaseModel):
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


@router.post("/mining/subgroups")
def mine_subgroups(req: SubgroupMiningRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    meta = store.get_meta(dataset_id)
    schema = meta.get("schema", [])

    attr_cols = req.attributeCols if req.attribute_cols is None else req.attribute_cols
    q_cols = req.questionCols if req.question_cols is None else req.question_cols
    min_size = req.minGroupSize if req.min_group_size is None else req.min_group_size
    min_pct = req.minPctDiff if req.min_pct_diff is None else req.min_pct_diff
    max_levels = req.maxSubgroupLevels if req.max_subgroup_levels is None else req.max_subgroup_levels

    result = run_subgroup_mining(
        df=df,
        attribute_cols=attr_cols,
        question_cols=q_cols,
        column_meta=schema,
        alpha=req.alpha,
        min_group_size=min_size if min_size is not None else 30,
        min_pct_diff=min_pct if min_pct is not None else 3.0,
        max_subgroup_levels=max_levels if max_levels is not None else 8,
        weights=req.weights,
    )
    return result


class ModernSubgroupRequest(BaseModel):
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


@router.post("/mining/modern-subgroup")
def mine_modern_subgroups(req: ModernSubgroupRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    meta = store.get_meta(dataset_id)
    schema = meta.get("schema", [])

    # Filter by selected row IDs if provided (active population connection contract)
    filter_ids = req.selectedRowIds if req.selected_row_ids is None else req.selected_row_ids
    if filter_ids is not None:
        id_col = None
        for c in ["__rowId__", "id", "ID", "row_id", "rowId"]:
            if c in df.columns:
                id_col = c
                break
        if id_col:
            id_set = set(str(i) for i in filter_ids)
            df = df.filter(pl.col(id_col).cast(pl.String).is_in(list(id_set)))

    t_questions = req.targetQuestions if req.target_questions is None else req.target_questions
    # If not specified or empty, run_modern_subgroup_mining will automatically evaluate all questions!
    if t_questions and len(t_questions) == 0:
        t_questions = None

    t_binary = req.targetBinaryCategory if req.target_binary_category is None else req.target_binary_category
    attr_cols = req.attributeCols if req.attribute_cols is None else req.attribute_cols
    m_depth = req.maxDepth if req.max_depth is None else req.max_depth
    b_width = req.beamWidth if req.beam_width is None else req.beam_width
    m_size = req.minGroupSize if req.min_group_size is None else req.min_group_size
    k = req.topK if req.top_k is None else req.top_k
    jaccard = req.jaccardThreshold if req.jaccard_threshold is None else req.jaccard_threshold
    overlap = req.overlapThreshold if req.overlap_threshold is None else req.overlap_threshold
    effect_diff = req.minEffectDiff if req.min_effect_diff is None else req.min_effect_diff

    try:
        result = run_modern_subgroup_mining(
            df=df,
            target_questions=t_questions,
            mode=req.mode,  # type: ignore
            target_binary_category=t_binary,
            attribute_cols=attr_cols,
            column_meta=schema,
            max_depth=m_depth if m_depth is not None else 2,
            beam_width=b_width if b_width is not None else 30,
            min_group_size=m_size if m_size is not None else 30,
            top_k=k if k is not None else 10,
            jaccard_threshold=jaccard if jaccard is not None else 0.5,
            overlap_threshold=overlap if overlap is not None else 0.8,
            min_effect_diff=effect_diff,
        )
        return result
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
    seed: int | None = 42


FeatureRankingRequest.model_rebuild()


@router.post("/mining/feature-ranking")
def run_feature_ranking(req: FeatureRankingRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    target = req.targetColumn if req.target_column is None else req.target_column
    features = req.featureColumns if req.feature_columns is None else req.feature_columns
    if not features:
        meta = store.get_meta(dataset_id)
        schema = meta.get("schema", [])
        features = [col["name"] for col in schema if col.get("semanticType") == "numeric" and col["name"] != target]

    active_rows = req.activeRowIds if req.active_row_ids is None else req.active_row_ids

    try:
        result = compute_feature_rankings(
            df=df,
            feature_columns=features,
            target_column=target,
            active_row_ids=active_rows,
            methods=req.methods,
            k_neighbors=req.kNeighbors or req.k_neighbors or 10,
            relieff_sample_size=req.relieffSampleSize or req.relieff_sample_size,
            n_estimators=req.nEstimators or req.n_estimators or 100,
            use_permutation_importance=bool(req.usePermutationImportance or req.use_permutation_importance),
            seed=req.seed if req.seed is not None else 42,
        )
        return result
    except ValueError as e:
        raise BizError("FEATURE_RANKING_ERROR", str(e), status_code=400)
    except Exception as e:
        raise BizError("FEATURE_RANKING_FAILED", f"特徴量ランキング計算に失敗しました: {str(e)}", status_code=500)


