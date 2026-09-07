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


import csv
import urllib.parse


def _neutralize(value: Any) -> Any:
    """CSV formula injection neutralization for strings only."""
    if isinstance(value, str) and value:
        try:
            float(value)
            return value
        except ValueError:
            pass
        if value[0] in "=+-@\t\r":
            return f"'{value}"
    return value


def _subset_df(req: ExportRequest) -> pl.DataFrame:
    df = store.get_dataframe(req.datasetId)
    if req.scope == "selected" or req.rowIds is not None:
        ids = req.rowIds if req.rowIds is not None else []
        if not ids:
            return df.head(0).drop("__rowId__", strict=False)
        wanted = set(ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))
    if "__rowId__" in df.columns:
        df = df.drop("__rowId__")
    return df


@router.post("/exports")
def export(req: ExportRequest) -> Response:
    df = _subset_df(req)
    safe_name = (store.get_meta(req.datasetId)["name"].split(":")[0])[:40].replace('"', "") or "export"
    filename_base = f"{safe_name}-{req.scope}"
    encoded_csv = urllib.parse.quote(f"{filename_base}.csv")
    cd_csv = f'attachment; filename="export-{req.scope}.csv"; filename*=UTF-8\'\'{encoded_csv}'

    if req.format == "csv":
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow([_neutralize(c) for c in df.columns])
        for row in df.iter_rows():
            cells = []
            for value in row:
                if value is None:
                    cells.append("")
                elif isinstance(value, (int, float)):
                    cells.append(value)
                else:
                    cells.append(_neutralize(str(value)))
            writer.writerow(cells)
        payload = ("\ufeff" + out.getvalue()).encode("utf-8")
        return Response(content=payload, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": cd_csv})
    buffer = io.BytesIO()
    if req.format == "parquet":
        try:
            df.write_parquet(buffer)
        except Exception:
            import pyarrow.parquet as pq
            pq.write_table(df.to_arrow(), buffer)
        media = "application/vnd.apache.parquet"
        ext = "parquet"
    else:
        return dataframe_to_arrow_response(df)
    encoded_other = urllib.parse.quote(f"{filename_base}.{ext}")
    cd_other = f'attachment; filename="export-{req.scope}.{ext}"; filename*=UTF-8\'\'{encoded_other}'
    return Response(content=buffer.getvalue(), media_type=media,
                    headers={"Content-Disposition": cd_other})


@router.get("/exports/session/{session_id}")
def export_session(session_id: str) -> Response:
    session = sessions.get(session_id)
    payload = json.dumps(session, ensure_ascii=False, indent=2).encode("utf-8")
    safe = session_id.replace('"', "")
    return Response(content=payload, media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{safe}.json"'})
