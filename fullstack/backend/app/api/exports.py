"""Exports API: CSV, Parquet, Arrow, summary JSON, session JSON."""
from __future__ import annotations

import io
import json
import math
import numbers
import urllib.parse
import zipfile
from typing import Any, Literal
from xml.etree import ElementTree as ET

import polars as pl
from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel

from ..domain.codebook_adapter import CodebookAdapter, normalize_code
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
    format: Literal["csv", "parquet", "arrow", "xlsx"] = "csv"
    useValueLabels: bool = False


import csv


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


def _is_finite_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, numbers.Integral):
        return True
    if isinstance(value, numbers.Real):
        return math.isfinite(float(value))
    return False


def _cell_ref(col_idx: int, row_idx: int) -> str:
    """Convert zero-based (col_idx, row_idx) to Excel style cell reference."""
    n = col_idx + 1
    letters = ""
    while n:
        n, rem = divmod(n - 1, 26)
        letters = f"{chr(65 + rem)}{letters}"
    return f"{letters}{row_idx}"


def _to_xml_bytes(element: ET.Element) -> bytes:
    """Serialize XML element with declaration in UTF-8."""
    buffer = io.BytesIO()
    tree = ET.ElementTree(element)
    tree.write(buffer, encoding="utf-8", xml_declaration=True, method="xml")
    return buffer.getvalue()


def _apply_value_label(
    col_name: str,
    value: Any,
    label_maps: dict[str, dict[str, str]],
    adapter: CodebookAdapter | None,
) -> Any:
    """Apply codebook label lookup only when a mapping is available."""
    if not label_maps:
        return value
    mapping = label_maps.get(col_name)
    if not mapping:
        return value
    if adapter is None:
        return value

    norm = normalize_code(value)
    if norm is None:
        return value
    resolved = adapter.label_for_value(col_name, value)
    if norm in mapping:
        return resolved
    return value


def _prepare_label_maps(
    req: ExportRequest,
    df: pl.DataFrame,
) -> tuple[CodebookAdapter | None, dict[str, dict[str, str]], dict[str, pl.Series]]:
    """Prepare value-label maps and missing-code-masked series for export."""
    if not req.useValueLabels:
        return None, {}, {name: df[name] for name in df.columns}

    codebook_data = store.load_codebook(req.datasetId)
    adapter = CodebookAdapter(df, codebook_data)
    label_maps: dict[str, dict[str, str]] = {}
    series_by_col: dict[str, pl.Series] = {}

    for col_name in df.columns:
        spec = adapter.get_column_spec_optional(col_name)
        value_labels = (spec or {}).get("valueLabels") or {}
        normalized_labels = {
            str(normalize_code(code)): str(label)
            for code, label in value_labels.items()
            if normalize_code(code) is not None
        }
        if normalized_labels:
            label_maps[col_name] = normalized_labels

        series_by_col[col_name] = df[col_name]

    return adapter, label_maps, series_by_col


def _build_xlsx_response(
    df: pl.DataFrame,
    series_by_col: dict[str, pl.Series],
    label_maps: dict[str, dict[str, str]],
    adapter: CodebookAdapter | None,
) -> bytes:
    columns = df.columns
    series_list = [series_by_col[col] for col in columns]
    rows = zip(*[s.to_list() for s in series_list]) if series_list else []

    worksheet = ET.Element("worksheet", attrib={"xmlns": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"})
    sheet_data = ET.SubElement(worksheet, "sheetData")

    header_row = ET.SubElement(sheet_data, "row", {"r": "1"})
    for col_idx, column in enumerate(columns):
        cell_ref = _cell_ref(col_idx, 1)
        c = ET.SubElement(header_row, "c", {"r": cell_ref, "t": "inlineStr"})
        t = ET.SubElement(ET.SubElement(c, "is"), "t")
        t.text = str(column)

    for row_idx, row_values in enumerate(rows, start=2):
        row_el = ET.SubElement(sheet_data, "row", {"r": str(row_idx)})
        for col_idx, value in enumerate(row_values):
            col_name = columns[col_idx]
            out_value = _apply_value_label(col_name, value, label_maps, adapter)
            ref = _cell_ref(col_idx, row_idx)
            if out_value is None or (isinstance(out_value, float) and not math.isfinite(out_value)):
                ET.SubElement(row_el, "c", {"r": ref})
                continue

            if isinstance(out_value, numbers.Real) and not isinstance(out_value, bool):
                c = ET.SubElement(row_el, "c", {"r": ref, "t": "n"})
                if _is_finite_number(out_value):
                    ET.SubElement(
                        c,
                        "v",
                    ).text = str(int(out_value) if float(out_value).is_integer() else out_value)
                else:
                    ET.SubElement(row_el, "c", {"r": ref})
                continue

            if isinstance(out_value, bool):
                val = "TRUE" if out_value else "FALSE"
            else:
                val = str(out_value)

            c = ET.SubElement(row_el, "c", {"r": ref, "t": "inlineStr"})
            t = ET.SubElement(ET.SubElement(c, "is"), "t")
            t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
            t.text = val

    workbook = ET.Element("workbook", attrib={"xmlns": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "xmlns:r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"})
    ET.SubElement(
        workbook,
        "sheets",
    ).append(
        ET.Element("sheet", {"name": "Sheet1", "sheetId": "1", "r:id": "rId1"})
    )

    wb_rels = ET.Element(
        "Relationships",
        attrib={"xmlns": "http://schemas.openxmlformats.org/package/2006/relationships"},
    )
    ET.SubElement(
        wb_rels,
        "Relationship",
        {
            "Id": "rId1",
            "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
            "Target": "worksheets/sheet1.xml",
        },
    )

    rels = ET.Element(
        "Relationships",
        attrib={"xmlns": "http://schemas.openxmlformats.org/package/2006/relationships"},
    )
    ET.SubElement(
        rels,
        "Relationship",
        {
            "Id": "rId1",
            "Type": "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
            "Target": "xl/workbook.xml",
        },
    )

    content_types = ET.Element(
        "Types",
        attrib={"xmlns": "http://schemas.openxmlformats.org/package/2006/content-types"},
    )
    ET.SubElement(
        content_types,
        "Default",
        {"Extension": "rels", "ContentType": "application/vnd.openxmlformats-package.relationships+xml"},
    )
    ET.SubElement(
        content_types,
        "Default",
        {"Extension": "xml", "ContentType": "application/xml"},
    )
    ET.SubElement(
        content_types,
        "Override",
        {"PartName": "/xl/workbook.xml", "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"},
    )
    ET.SubElement(
        content_types,
        "Override",
        {"PartName": "/xl/worksheets/sheet1.xml", "ContentType": "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"},
    )

    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", _to_xml_bytes(content_types))
        zf.writestr("_rels/.rels", _to_xml_bytes(rels))
        zf.writestr("xl/workbook.xml", _to_xml_bytes(workbook))
        zf.writestr("xl/_rels/workbook.xml.rels", _to_xml_bytes(wb_rels))
        zf.writestr("xl/worksheets/sheet1.xml", _to_xml_bytes(worksheet))
    return output.getvalue()


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
    encoded_xlsx = urllib.parse.quote(f"{filename_base}.xlsx")
    cd_xlsx = f'attachment; filename="export-{req.scope}.xlsx"; filename*=UTF-8\'\'{encoded_xlsx}'

    # Prepare value labels map if requested (CSV/Excel only)
    label_adapter: CodebookAdapter | None = None
    label_maps: dict[str, dict[str, str]] = {}
    value_series: dict[str, pl.Series] = {name: df[name] for name in df.columns}
    if req.format in {"csv", "xlsx"}:
        label_adapter, label_maps, value_series = _prepare_label_maps(req, df)

    if req.format == "csv":
        out = io.StringIO()
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow([_neutralize(c) for c in df.columns])
        col_names = list(df.columns)
        series_order = [value_series[name] for name in col_names]
        for row in zip(*[s.to_list() for s in series_order]):
            cells = []
            for col_idx, value in enumerate(row):
                col_name = col_names[col_idx]
                mapped = _apply_value_label(col_name, value, label_maps, label_adapter)
                if mapped is None:
                    cells.append("")
                else:
                    if mapped is None:
                        cells.append("")
                    elif isinstance(mapped, numbers.Real) and not isinstance(mapped, bool):
                        cells.append(int(mapped) if float(mapped).is_integer() else mapped)
                    else:
                        str_val = str(mapped)
                        cells.append(_neutralize(str_val))
            writer.writerow(cells)
        payload = ("\ufeff" + out.getvalue()).encode("utf-8")
        return Response(content=payload, media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": cd_csv})
    if req.format == "xlsx":
        content = _build_xlsx_response(df, value_series, label_maps, label_adapter)
        return Response(content=content, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        headers={"Content-Disposition": cd_xlsx})
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
