"""Global Observation Selection and Sampling API (Feature 15)."""
from __future__ import annotations

from collections import Counter
from typing import Any, List, Optional
import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore

router = APIRouter(prefix="/datasets/{dataset_id}/observations", tags=["observations"])
store = DatasetStore()

MAX_ROW_COUNT = 100_000


class SamplingRequest(BaseModel):
    method: str = Field("without_replacement", pattern="^(with_replacement|without_replacement)$")
    size: Optional[int] = None
    ratio: Optional[float] = None
    seed: Optional[int] = 42
    activeRowIds: Optional[List[str]] = None


class RangeSelectionRequest(BaseModel):
    fromIndex: int = Field(..., ge=0)
    toIndex: int = Field(..., ge=0)
    activeRowIds: Optional[List[str]] = None


@router.post("/sample")
def sample_observations(dataset_id: str, req: SamplingRequest) -> dict[str, Any]:
    """Execute simple random sampling (with/without replacement)."""
    from ..domain.errors import BizError as _BizError

    df = store.get_dataframe(dataset_id)
    all_row_ids: list[str] = [str(x) for x in df["__rowId__"].to_list()]
    known = set(all_row_ids)

    candidates = req.activeRowIds if req.activeRowIds is not None else all_row_ids
    if req.activeRowIds is not None:
        unknown = sorted({str(v) for v in req.activeRowIds} - known)
        if unknown:
            raise _BizError("SAMPLING_UNKNOWN_ROW", "存在しないrowIdが指定されています。",
                            status_code=422,
                            details={"unknownRowIds": unknown[:20], "unknownCount": len(unknown)})
        candidates = [v for v in candidates if v in known]
    if len(candidates) > MAX_ROW_COUNT:
        raise BizError(
            "PAYLOAD_TOO_LARGE",
            f"対象行数（{len(candidates)}件）が上限（{MAX_ROW_COUNT:,}件）を超過しています。サンプリング機能を利用してください。",
            status_code=413,
        )

    n_candidates = len(candidates)
    if n_candidates == 0:
        raise BizError("EMPTY_CANDIDATES", "サンプリング対象の行が存在しません。", status_code=400)

    # Determine sample size
    if req.size is not None:
        target_size = req.size
        if target_size < 1:
            raise BizError("INVALID_SAMPLE_SIZE", "抽出サイズは1以上である必要があります。", status_code=422)
        if req.method == "without_replacement" and target_size > n_candidates:
            raise BizError(
                "SAMPLE_SIZE_EXCEEDS_ROWS",
                f"非復元抽出の件数（{target_size}）は対象行数（{n_candidates}）以下である必要があります。",
                status_code=422,
            )
    elif req.ratio is not None:
        if not (0.0 < req.ratio <= 1.0):
            raise BizError("INVALID_SAMPLE_RATIO", "抽出比率は0超1以下である必要があります。", status_code=422)
        target_size = max(1, round(n_candidates * req.ratio))
        if req.method == "without_replacement":
            target_size = min(target_size, n_candidates)
    else:
        raise BizError("MISSING_SAMPLE_PARAM", "件数(size)または比率(ratio)のいずれかを指定してください。", status_code=422)

    rng = np.random.default_rng(req.seed)
    with_replacement = req.method == "with_replacement"

    sampled_indices = rng.choice(n_candidates, size=target_size, replace=with_replacement)
    sampled_ids = [candidates[int(idx)] for idx in sampled_indices]

    if with_replacement:
        weights = {row_id: int(count) for row_id, count in Counter(sampled_ids).items()}
    else:
        weights = {row_id: 1 for row_id in sampled_ids}

    return {
        "datasetId": dataset_id,
        "method": req.method,
        "sampleSize": len(sampled_ids),
        "totalCandidates": n_candidates,
        "sampledRowIds": sampled_ids,
        "sampledRowWeights": weights,
        "seed": req.seed,
    }


@router.post("/range")
def select_range_observations(dataset_id: str, req: RangeSelectionRequest) -> dict[str, Any]:
    """Select a contiguous slice of rows by 0-indexed [fromIndex, toIndex)."""
    df = store.get_dataframe(dataset_id)
    all_row_ids: list[str] = [str(x) for x in df["__rowId__"].to_list()]

    candidates = req.activeRowIds if req.activeRowIds is not None else all_row_ids
    if len(candidates) > MAX_ROW_COUNT:
        raise BizError(
            "PAYLOAD_TOO_LARGE",
            f"対象行数（{len(candidates)}件）が上限（{MAX_ROW_COUNT:,}件）を超過しています。",
            status_code=413,
        )

    if req.fromIndex > req.toIndex:
        raise BizError(
            "INVALID_RANGE",
            f"開始インデックス（{req.fromIndex}）は終了インデックス（{req.toIndex}）以下である必要があります。",
            status_code=422,
        )

    from_idx = min(req.fromIndex, len(candidates))
    to_idx = min(req.toIndex, len(candidates))
    sliced = candidates[from_idx:to_idx]

    return {
        "datasetId": dataset_id,
        "fromIndex": from_idx,
        "toIndex": to_idx,
        "totalCandidates": len(candidates),
        "rowIds": sliced,
        "count": len(sliced),
    }
