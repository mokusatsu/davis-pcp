"""API endpoints for Distribution suite (FEDF, etc.)."""
from __future__ import annotations

from typing import Any, Literal
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.distribution.fedf import compute_fedf
from ..domain.errors import BizError
from ..domain.context import check_revisions, collect_revisions
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


class FedfRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    columns: list[str] | None = None
    mode: Literal["standard", "folded", "both"] = "standard"
    gridSize: int = 100
    rowIds: list[str] | None = None
    row_ids: list[str] | None = None
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


@router.post("/distribution/fedf")
def get_fedf(req: FedfRequest) -> dict[str, Any]:
    from ..domain.codebook_adapter import CodebookAdapter

    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    with store.lock(dataset_id):
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(store.get_meta(dataset_id), codebook)
        check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        df = store.get_dataframe(dataset_id)
    resolved_columns = req.columns if req.columns is not None else [c for c in df.columns if c != "__rowId__"]
    if resolved_columns:
        adapter = CodebookAdapter(df, codebook)
        masked = [adapter.analysis_series(c) for c in resolved_columns
                  if c in df.columns]
        if masked:
            df = df.with_columns(masked)
    wanted_rows = req.rowIds if req.row_ids is None else req.row_ids
    result = compute_fedf(
        df=df,
        columns=req.columns,
        mode=req.mode,
        grid_size=req.gridSize,
        row_ids=wanted_rows,
    )
    return {**result, "datasetId": dataset_id, **revisions}
