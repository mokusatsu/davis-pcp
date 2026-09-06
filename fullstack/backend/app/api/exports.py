"""Exports API: CSV, Parquet, Arrow, summary JSON, session JSON."""
from __future__ import annotations

import io
import json
from typing import Literal

import polars as pl
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from ..api.datasets import dataframe_to_arrow_response
from ..storage.dataset_store import DatasetStore
from ..storage.session_store import SessionStore

router = APIRouter()
store = DatasetStore()
sessions = SessionStore()


class ExportRequest(BaseModel):
    datasetId: str
    scope: Literal["selected", "active", "all"] = "all"
    rowIds: list[str] | None = None
    format: Literal["csv", "parquet", "arrow"] = "csv"


def _neutralize(value: str) -> str:
    """CSV formula injection neutralization."""
    if value and value[0] in "=+-@\t\r":
        return f"'{value}"
    return value


def _subset_df(req: ExportRequest) -> pl.DataFrame:
    df = store.get_dataframe(req.datasetId)
    if req.scope == "selected" or req.rowIds is not None:
        ids = req.rowIds if req.rowIds is not None else []
        if not ids:
            return df.head(0)
        wanted = set(ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))
    return df


@router.post("/exports")
def export(req: ExportRequest) -> Response:
    df = _subset_df(req)
    safe_name = (store.get_meta(req.datasetId)["name"].split(":")[0])[:40].replace('"', "") or "export"
    if req.format == "csv":
        lines = [",".join(f'"{_neutralize(str(c))}"' for c in df.columns)]
        for row in df.iter_rows():
            cells = []
            for value in row:
                s = "" if value is None else str(value)
                cells.append(f'"{_neutralize(s)}"' if any(ch in s for ch in ',"\n\r') else _neutralize(s))
            lines.append(",".join(cells))
        payload = ("﻿" + "\n".join(lines)).encode("utf-8")
        return Response(content=payload, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{safe_name}-{req.scope}.csv"'})
    buffer = io.BytesIO()
    if req.format == "parquet":
        df.write_parquet(buffer)
        media = "application/vnd.apache.parquet"
        ext = "parquet"
    else:
        return dataframe_to_arrow_response(df)
    return Response(content=buffer.getvalue(), media_type=media,
                    headers={"Content-Disposition": f'attachment; filename="{safe_name}-{req.scope}.{ext}"'})


@router.get("/exports/session/{session_id}")
def export_session(session_id: str) -> Response:
    session = sessions.get(session_id)
    payload = json.dumps(session, ensure_ascii=False, indent=2).encode("utf-8")
    safe = session_id.replace('"', "")
    return Response(content=payload, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.json"'})
