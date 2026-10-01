"""Ordering API: Python authoritative DAVIS axis ordering."""
from __future__ import annotations

import time

import numpy as np
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.ordering.core import compute_order
from ..domain.errors import BizError
from ..domain.context import (
    check_revisions, collect_revisions, filter_scope_frame, resolve_row_ids, scope_hash,
)
from ..domain.codebook_adapter import CodebookAdapter
from ..services.dataset_service import now_iso
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()
_results: dict[str, dict] = {}


class OrderingRequest(BaseModel):
    datasetId: str
    mode: str
    columns: list[str] | None = None
    manualOrder: list[str] | None = None
    rowIds: list[str] | None = None
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


@router.post("/orderings")
def create_ordering(req: OrderingRequest) -> dict:
    with store.lock(req.datasetId):
        meta = store.get_meta(req.datasetId)
        codebook = store.load_codebook(req.datasetId)
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, req.expectedSchemaRevision, req.expectedDataRevision)
        df = store.get_dataframe(req.datasetId)
        scope_ids = resolve_row_ids(df, req.datasetId, req.rowIds)
        df = filter_scope_frame(df, scope_ids)
    statistical = req.mode in ("componentJar", "componentPaper", "permute", "correlation")
    if statistical and df.height == 0:
        raise BizError("EMPTY_ANALYSIS_INPUT", "対象データ行が0件です。", status_code=422)
    adapter = CodebookAdapter(df, codebook)
    df = adapter.analysis_frame()
    schema_by_name = {c["name"]: c for c in meta["schema"]}
    for name in df.columns:
        spec = adapter.get_column_spec_optional(name)
        if spec:
            numeric = spec.get("scaleType") in ("ordinal", "interval", "ratio")
            schema_by_name[name] = {**schema_by_name.get(name, {}), "physicalType": "float" if numeric else "string", "semanticType": "numeric" if numeric else "categorical"}
    columns = req.columns if req.columns is not None else [
        name for name, c in schema_by_name.items() if c["semanticType"] == "numeric"]
    unknown = [name for name in columns if name not in df.columns]
    if unknown:
        raise BizError("COLUMN_NOT_FOUND", "ordering対象の列が存在しません。",
                       status_code=422, details={"columns": unknown})
    non_numeric = [c for c in columns
                   if schema_by_name.get(c, {}).get("physicalType") not in ("float", "int")]
    constant = [schema_by_name[c] for c in columns if c in schema_by_name and schema_by_name[c].get("constant")]
    warnings: list[str] = []
    if non_numeric and req.mode in ("componentJar", "componentPaper", "permute", "correlation"):
        columns = [c for c in columns if c not in non_numeric]
        warnings.append(f"非数値列をordering対象から除外しました: {', '.join(non_numeric)}")
    if constant:
        warnings.append(f"定数列を含みます（相関0として扱います）: {', '.join(c['name'] for c in constant)}")
    if len(columns) < 2:
        raise BizError(
            "ORDERING_INSUFFICIENT_COLUMNS",
            "orderingには数値列が2本以上必要です。",
            details={"columnIds": columns},
            suggested_actions=["数値軸を追加表示する", "NoOrderを使用する"],
        )
    subset = df.select(columns)
    values = (np.array([[np.nan if v is None else float(v) for v in subset[c].to_list()]
                       for c in columns]).T if statistical else np.empty((0, len(columns))))
    if np.isnan(values).any() and statistical:
        col_means = np.nanmean(values, axis=0)
        idx = np.where(np.isnan(values))
        values[idx] = np.take(col_means, idx[1])
        warnings.append("欠損値を列平均で補完して計算しました（表示は元データを使用）。")
    started = time.perf_counter()
    result = compute_order(req.mode, columns, values, req.manualOrder)
    runtime_ms = (time.perf_counter() - started) * 1000
    result_id = f"ord-{int(time.time() * 1000):x}"
    payload = {
        "resultId": result_id,
        "algorithm": req.mode,
        "variant": "INITIAL_JAR_COMPAT" if req.mode in ("componentJar", "permute", "database") else
                   "PAPER_INTERPRETATION" if req.mode == "componentPaper" else
                   "MODERN" if req.mode == "correlation" else "MANUAL",
        "algorithmVersion": "2.0.0",
        "evidenceClass": result.get("evidence", "MODERN-EXTENSION"),
        "inputColumnIds": columns,
        "outputColumnIds": result["order"],
        "parameters": {"mode": req.mode, "manualOrder": req.manualOrder},
        "seed": None,
        "warnings": warnings,
        "candidateOrders": [c["order"] for c in result.get("candidates", [])],
        "candidateScores": [c.get("score") for c in result.get("candidates", [])],
        "iterationTrace": result.get("trace", []),
        "datasetFingerprint": meta["fingerprint"],
        "datasetId": req.datasetId,
        **revisions,
        "scopeHash": scope_hash(scope_ids),
        "scopeCount": len(scope_ids),
        "createdAt": now_iso(),
        "runtimeMs": round(runtime_ms, 3),
    }
    _results[result_id] = payload
    return payload


@router.get("/orderings/{result_id}")
def get_ordering(result_id: str) -> dict:
    if result_id not in _results:
        raise BizError("ORDERING_NOT_FOUND", f"ordering結果 {result_id} が見つかりません。", status_code=404)
    return _results[result_id]
