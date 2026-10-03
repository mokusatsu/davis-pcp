"""Global Observation Selection and Sampling API (Feature 15)."""
from __future__ import annotations

from collections import Counter
import hashlib
import json
import secrets
import uuid
from typing import Any, List, Optional
import numpy as np
from fastapi import APIRouter
from pydantic import BaseModel, Field

from ..domain.errors import BizError
from ..domain.context import check_revisions, collect_revisions, scope_hash
from ..storage.dataset_store import DatasetStore

router = APIRouter(prefix="/datasets/{dataset_id}/observations", tags=["observations"])
store = DatasetStore()

MAX_ROW_COUNT = 100_000


class SamplingRequest(BaseModel):
    method: str = Field("without_replacement", pattern="^(with_replacement|without_replacement)$")
    size: Optional[int] = None
    ratio: Optional[float] = None
    # Seeds must survive a JSON/JavaScript round trip without rounding or coercion.
    seed: Optional[int] = Field(default=42, ge=0, le=9007199254740991, strict=True)
    activeRowIds: Optional[List[str]] = None
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


class RangeSelectionRequest(BaseModel):
    fromIndex: int = Field(..., ge=0)
    toIndex: int = Field(..., ge=0)
    activeRowIds: Optional[List[str]] = None
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


def _observation_source(dataset_id: str, req: SamplingRequest | RangeSelectionRequest,
                        operation: str) -> tuple[list[str], dict[str, Any]]:
    """Snapshot ordered candidates and revisions together for reproducibility."""
    with store.lock(dataset_id):
        revisions = collect_revisions(store.get_meta(dataset_id), store.load_codebook(dataset_id))
        check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        df = store.get_dataframe(dataset_id)
        current = [str(v) for v in df["__rowId__"].to_list()]
    candidates = list(req.activeRowIds) if req.activeRowIds is not None else current
    unknown = sorted(set(candidates) - set(current))
    if unknown:
        raise BizError(f"{operation}_UNKNOWN_ROW", "存在しないrowIdが指定されています。",
                       status_code=422,
                       details={"unknownRowIds": unknown[:20], "unknownCount": len(unknown)})
    if len(set(candidates)) != len(candidates):
        raise BizError(f"{operation}_DUPLICATE_ROW", "対象行に重複したrowIdがあります。",
                       status_code=422)
    ordered_payload = json.dumps(candidates, ensure_ascii=False, separators=(",", ":"))
    return candidates, {
        **revisions,
        "sourceScopeHash": scope_hash(candidates),
        "sourceOrderHash": "sha256:" + hashlib.sha256(ordered_payload.encode("utf-8")).hexdigest(),
        "sourceRowCount": len(candidates),
    }


@router.post("/sample")
def sample_observations(dataset_id: str, req: SamplingRequest) -> dict[str, Any]:
    """Execute simple random sampling (with/without replacement)."""
    candidates, provenance = _observation_source(dataset_id, req, "SAMPLING")

    if req.method == "with_replacement":
        raise BizError(
            "SAMPLING_REPLACEMENT_UNSUPPORTED",
            "復元抽出は未対応です。非復元抽出を使用してください。",
            status_code=422,
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

    # Persist a concrete seed even when the caller requests fresh randomness.
    # 32 bits round-trip exactly through JavaScript and NumPy's PCG64 seed input.
    effective_seed = req.seed if req.seed is not None else secrets.randbits(32)
    rng = np.random.default_rng(effective_seed)
    with_replacement = req.method == "with_replacement"

    sampled_indices = rng.choice(n_candidates, size=target_size, replace=with_replacement)
    sampled_ids = [candidates[int(idx)] for idx in sampled_indices]

    if with_replacement:
        weights = {row_id: int(count) for row_id, count in Counter(sampled_ids).items()}
    else:
        weights = {row_id: 1 for row_id in sampled_ids}

    return {
        "datasetId": dataset_id,
        **provenance,
        "sampleId": f"sample-{uuid.uuid4().hex}",
        "method": req.method,
        "sampleSize": len(sampled_ids),
        "totalCandidates": n_candidates,
        "sampledRowIds": sampled_ids,
        "sampledRowWeights": weights,
        "seed": effective_seed,
    }


@router.post("/range")
def select_range_observations(dataset_id: str, req: RangeSelectionRequest) -> dict[str, Any]:
    """Select a contiguous slice of rows by 0-indexed [fromIndex, toIndex)."""
    candidates, provenance = _observation_source(dataset_id, req, "RANGE")

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
        **provenance,
        "fromIndex": from_idx,
        "toIndex": to_idx,
        "totalCandidates": len(candidates),
        "rowIds": sliced,
        "count": len(sliced),
    }
