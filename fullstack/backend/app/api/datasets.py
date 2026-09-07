"""Dataset import, schema, and view APIs."""
from __future__ import annotations

import hashlib
import io
import json
from typing import Any

import polars as pl
import pyarrow as pa
import pyarrow.ipc as ipc
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel

from ..config import settings
from ..domain.errors import BizError
from ..services.dataset_service import ColumnRole, ImportOptions, new_id, now_iso
from ..services.import_service import (
    build_builtin_iris,
    enforce_limits,
    load_dataframe_from_upload,
    probe_table,
    sqlite_tables,
)
from ..storage.dataset_store import DatasetStore, assign_row_identity, values_fingerprint

router = APIRouter()

store = DatasetStore()


def _serialize_schema(df: pl.DataFrame) -> list[dict[str, Any]]:
    schemas = probe_table(df, df.height)
    return [s.model_dump() for s in schemas]


@router.get("/datasets")
def list_datasets() -> dict:
    return {"datasets": store.list_datasets()}


class BuiltinSampleRequest(BaseModel):
    name: str = "Iris (built-in sample)"


@router.post("/datasets/import/sample")
def import_builtin_sample(request: BuiltinSampleRequest | None = None) -> dict:
    target_name = request.name if request else "Iris (built-in sample)"
    for item in store.list_datasets():
        if item.get("name") == target_name:
            meta = dict(store.get_meta(item["datasetId"]))
            meta.pop("rowIds", None)
            return meta
    df = build_builtin_iris()
    dataset_id = new_id("ds")
    meta = _finalize_dataset(dataset_id, target_name,
                             "builtin-iris", df, None)
    return meta


async def _read_upload(upload: UploadFile) -> bytes:
    chunks = []
    total = 0
    while chunk := await upload.read(1024 * 1024):
        total += len(chunk)
        if total > settings.max_upload_bytes:
            raise BizError("UPLOAD_TOO_LARGE",
                           f"uploadサイズが上限({settings.max_upload_bytes // (1024 * 1024)}MB)を超えています。",
                           recoverable=False)
        chunks.append(chunk)
    return b"".join(chunks)


@router.post("/datasets/import")
async def import_dataset(
    file: UploadFile = File(...),
    options_json: str | None = Form(None),
) -> dict:
    raw = await _read_upload(file)
    options = ImportOptions(**__import__("json").loads(options_json)) if options_json else ImportOptions()
    df, fmt = load_dataframe_from_upload(file.filename or "upload", raw, options)
    enforce_limits(df)
    dataset_id = new_id("ds")
    name = (file.filename or "upload").rsplit(".", 1)[0][:80] or "upload"
    meta = _finalize_dataset(dataset_id, name, fmt, df, options)
    return meta


@router.post("/datasets/probe-sqlite")
async def probe_sqlite(file: UploadFile = File(...)) -> dict:
    raw = await _read_upload(file)
    try:
        tables = sqlite_tables(raw)
    except Exception as exc:
        raise BizError("IMPORT_MALFORMED_SQLITE", "SQLiteファイルを読み込めませんでした。",
                       details={"reason": str(exc)[:200]}) from exc
    return {"tables": tables}


class SqliteImportRequest(BaseModel):
    table: str


async def import_sqlite_common(raw: bytes, table: str, filename: str) -> dict:
    from ..services.import_service import load_sqlite_table
    df = load_sqlite_table(raw, table)
    enforce_limits(df)
    dataset_id = new_id("ds")
    meta = _finalize_dataset(dataset_id, f"{filename.rsplit('.', 1)[0][:60]}:{table}"[:80], "sqlite", df, None)
    return meta


@router.post("/datasets/import/sqlite")
async def import_sqlite(file: UploadFile = File(...), table: str = Form(...)) -> dict:
    raw = await _read_upload(file)
    return await import_sqlite_common(raw, table, file.filename or "database.sqlite")


def _derive_dataset_schema(df: pl.DataFrame, source_schema: list[dict] | None = None) -> list[dict]:
    frame = df.drop("__rowId__") if "__rowId__" in df.columns else df
    canonical_schemas = [s.model_dump(mode="json") for s in probe_table(frame, frame.height)]
    if not source_schema:
        return canonical_schemas
    existing_by_name = {c["name"]: dict(c) for c in source_schema if isinstance(c, dict) and "name" in c}
    schema_payload = []
    for s in canonical_schemas:
        cname = s["name"]
        if cname in existing_by_name:
            orig = existing_by_name[cname]
            merged = {**s, **{k: orig[k] for k in ["columnId", "semanticType", "role", "categoryOrder", "manualCategories"] if k in orig}}
            schema_payload.append(merged)
        else:
            schema_payload.append(s)
    return schema_payload


def _finalize_dataset(
    dataset_id: str,
    name: str,
    fmt: str,
    df: pl.DataFrame,
    options: ImportOptions | None,
    source_schema: list[dict] | None = None,
) -> dict:
    schemas = probe_table(df, df.height)
    id_column = (options.rowIdColumn if options and options.rowIdColumn else None) or next((s.name for s in schemas if s.role == ColumnRole.ROW_ID), None)
    df, identity_source = assign_row_identity(df, id_column, schemas)
    # Re-probe on the canonical frame so row counts align with __rowId__, preserving schema metadata if available.
    schema_payload = _derive_dataset_schema(df, source_schema)
    fingerprint_material = {
        "schema": schema_payload,
        "options": options.model_dump(mode="json") if options else {},
        "format": fmt,
    }
    fingerprint_seed = values_fingerprint(df)
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_material, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
    ).hexdigest()
    meta = {
        "datasetId": dataset_id,
        "name": name,
        "fingerprint": fingerprint,
        "format": fmt,
        "rowCount": df.height,
        "columnCount": df.width - 1,
        "schema": schema_payload,
        "rowIdentity": identity_source,
        "rowIds": df["__rowId__"].to_list(),
        "createdAt": now_iso(),
        "importOptions": options.model_dump(mode="json") if options else ImportOptions().model_dump(mode="json"),
    }
    store.save(dataset_id, meta, df)
    meta.pop("rowIds", None)
    return meta


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str) -> dict:
    return store.get_meta(dataset_id)


class SchemaPatch(BaseModel):
    columns: list[dict[str, Any]]


@router.patch("/datasets/{dataset_id}/schema")
def patch_schema(dataset_id: str, patch: SchemaPatch) -> dict:
    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)
    by_name = {c["name"]: c for c in patch.columns}
    updated = []
    for column_meta in meta["schema"]:
        override = by_name.get(column_meta["name"])
        if override:
            allowed = {"semanticType", "role", "categoryOrder", "manualCategories"}
            column_meta = {**column_meta, **{k: v for k, v in override.items() if k in allowed}}
            if override.get("newName"):
                old = column_meta["name"]
                column_meta["name"] = override["newName"]
                df = df.rename({old: override["newName"]})
        updated.append(column_meta)
    meta["schema"] = updated
    meta["schemaRevision"] = meta.get("schemaRevision", 1) + 1
    fingerprint_material = {
        "schema": updated,
        "options": meta.get("importOptions", {}),
        "format": meta.get("format", "csv"),
        "schemaRevision": meta["schemaRevision"],
    }
    fingerprint_seed = values_fingerprint(df)
    meta["fingerprint"] = hashlib.sha256(
        json.dumps(fingerprint_material, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
    ).hexdigest()
    store.save(dataset_id, meta, df)
    meta.pop("rowIds", None)
    return meta


class TransformRequest(BaseModel):
    type: str  # "nominal_to_binary" | "binning"
    source_column: str
    options: dict[str, Any] = {}


class BinningPreviewRequest(BaseModel):
    column: str
    method: str = "equal_width"
    num_bins: int = 4
    custom_cuts: list[float] | None = None


@router.post("/datasets/{dataset_id}/transform/preview")
def preview_dataset_binning(dataset_id: str, request: BinningPreviewRequest) -> dict:
    from ..algorithms.transform.core import preview_binning
    df = store.get_dataframe(dataset_id)
    return preview_binning(
        df,
        column=request.column,
        method=request.method,
        num_bins=request.num_bins,
        custom_cuts=request.custom_cuts,
    )


@router.post("/datasets/{dataset_id}/transform")
def transform_dataset(dataset_id: str, request: TransformRequest) -> dict:
    from ..algorithms.transform.core import bin_numeric, nominal_to_binary

    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)

    created_columns = []
    bin_summaries = None

    if request.type == "nominal_to_binary":
        df, new_col_names = nominal_to_binary(
            df,
            column=request.source_column,
            drop_first=bool(request.options.get("drop_first", False)),
            prefix=request.options.get("prefix"),
            handle_null=str(request.options.get("handle_null", "as_missing")),
            max_categories=int(request.options.get("max_categories", 30)),
        )
        created_columns = new_col_names
    elif request.type == "binning":
        df, target_col_name, bin_summaries = bin_numeric(
            df,
            column=request.source_column,
            method=str(request.options.get("method", "equal_width")),
            num_bins=int(request.options.get("num_bins", 4)),
            custom_cuts=request.options.get("custom_cuts"),
            output_name=request.options.get("output_column_name"),
            labels_format=str(request.options.get("labels_format", "range")),
        )
        created_columns = [target_col_name]
    else:
        raise BizError("TRANSFORM_UNKNOWN_TYPE", f"未知の変換タイプ '{request.type}' です。")

    # Re-probe schema on updated dataframe
    canonical_schemas = [s for s in probe_table(df.drop("__rowId__"), df.height)]
    schema_payload = [s.model_dump(mode="json") for s in canonical_schemas]

    # Invalidate cached fingerprint
    fingerprint_seed = values_fingerprint(df)
    meta["fingerprint"] = hashlib.sha256(
        json.dumps(schema_payload, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
    ).hexdigest()
    meta["schema"] = schema_payload
    meta["columnCount"] = df.width - 1
    meta["revision"] = meta.get("revision", 1) + 1

    store.save(dataset_id, meta, df)
    meta.pop("rowIds", None)

    return {
        **meta,
        "createdColumns": created_columns,
        "binSummaries": bin_summaries,
    }


@router.delete("/datasets/{dataset_id}/columns/{column_name}")
def delete_column(dataset_id: str, column_name: str) -> dict:
    if column_name == "__rowId__":
        raise BizError("COLUMN_CANNOT_DELETE_ROW_ID", "ID列 '__rowId__' は削除できません。")

    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)

    if column_name not in df.columns:
        raise BizError("COLUMN_NOT_FOUND", f"列 '{column_name}' が見つかりません。")

    df = df.drop(column_name)
    canonical_schemas = [s for s in probe_table(df.drop("__rowId__"), df.height)]
    schema_payload = [s.model_dump(mode="json") for s in canonical_schemas]

    meta["schema"] = schema_payload
    meta["columnCount"] = df.width - 1
    meta["revision"] = meta.get("revision", 1) + 1

    store.save(dataset_id, meta, df)
    meta.pop("rowIds", None)
    return meta


class ImputePreviewRequest(BaseModel):
    column: str
    strategy: str = "tabdiff"
    options: dict[str, Any] | None = None


class ImputeRequest(BaseModel):
    columns: list[str] | None = None
    strategy: str = "tabdiff"
    options: dict[str, Any] | None = None
    inPlace: bool = True


@router.post("/datasets/{dataset_id}/impute/preview")
def preview_dataset_imputation(dataset_id: str, request: ImputePreviewRequest) -> dict:
    from ..algorithms.imputation.core import preview_imputation
    df = store.get_dataframe(dataset_id)
    return preview_imputation(
        df,
        column=request.column,
        strategy=request.strategy,
        options=request.options,
    )


@router.post("/datasets/{dataset_id}/impute")
def impute_dataset(dataset_id: str, request: ImputeRequest) -> dict:
    from ..algorithms.imputation.core import impute_dataframe

    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)

    imputed_df, diagnostics = impute_dataframe(
        df,
        columns=request.columns,
        strategy=request.strategy,
        options=request.options,
    )

    if request.inPlace:
        schema_payload = _derive_dataset_schema(imputed_df, meta.get("schema", []))
        fingerprint_seed = values_fingerprint(imputed_df)
        meta["fingerprint"] = hashlib.sha256(
            json.dumps(schema_payload, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
        ).hexdigest()
        meta["schema"] = schema_payload
        meta["columnCount"] = imputed_df.width - 1
        meta["revision"] = meta.get("revision", 1) + 1
        meta["schemaRevision"] = meta.get("schemaRevision", 1) + 1

        store.save(dataset_id, meta, imputed_df)
        meta.pop("rowIds", None)
        return {
            **meta,
            "diagnostics": diagnostics,
        }
    else:
        new_dataset_id = new_id("ds")
        new_name = f"{meta['name']}_imputed"
        new_meta = _finalize_dataset(
            new_dataset_id,
            new_name,
            meta.get("format", "csv"),
            imputed_df,
            None,
            source_schema=meta.get("schema", []),
        )
        return {
            **new_meta,
            "diagnostics": diagnostics,
        }


class CalculatePreviewRequest(BaseModel):
    expression: str
    columnName: str = "new_var"


class CalculateRequest(BaseModel):
    expression: str
    columnName: str


@router.post("/datasets/{dataset_id}/calculate/preview")
def preview_dataset_calculation(dataset_id: str, request: CalculatePreviewRequest) -> dict:
    from ..algorithms.transformation.expression import preview_expression
    df = store.get_dataframe(dataset_id)
    return preview_expression(
        df,
        expression=request.expression,
        new_column_name=request.columnName,
    )


@router.post("/datasets/{dataset_id}/calculate")
def calculate_dataset_variable(dataset_id: str, request: CalculateRequest) -> dict:
    from ..algorithms.transformation.expression import evaluate_expression

    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)

    updated_df, new_series, col_meta = evaluate_expression(
        df,
        expression=request.expression,
        new_column_name=request.columnName,
    )

    schema_payload = _derive_dataset_schema(updated_df, meta.get("schema", []))
    fingerprint_seed = values_fingerprint(updated_df)
    meta["fingerprint"] = hashlib.sha256(
        json.dumps(schema_payload, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
    ).hexdigest()
    meta["schema"] = schema_payload
    meta["columnCount"] = updated_df.width - 1
    meta["revision"] = meta.get("revision", 1) + 1

    store.save(dataset_id, meta, updated_df)
    meta.pop("rowIds", None)

    return {
        **meta,
        "createdColumn": col_meta,
    }




@router.post("/datasets/{dataset_id}/view")
def dataset_view(dataset_id: str, body: dict) -> Response:
    """Arrow IPC view of the dataset with optional filters.

    body: {columns?: [names], rowIds?: [...], limit?: int, offset?: int}
    """
    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)
    columns = body.get("columns")
    if columns:
        keep = ["__rowId__"] + [c for c in columns if c in df.columns]
        df = df.select(keep)
    row_ids = body.get("rowIds")
    if row_ids is not None:
        wanted = set(row_ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))
    offset = body.get("offset") or 0
    limit = body.get("limit")
    if limit is not None:
        df = df.slice(offset, limit)
    elif offset:
        df = df.slice(offset)
    return Response(content=_serialize_dataframe_to_arrow_bytes(df), media_type="application/vnd.apache.arrow.stream")


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str) -> dict:
    store.delete(dataset_id)
    return {"deleted": dataset_id}


def _serialize_dataframe_to_arrow_bytes(df: pl.DataFrame) -> bytes:
    try:
        pydict = df.to_dict(as_series=False)
        table = pa.Table.from_pydict(pydict)
        sink = pa.BufferOutputStream()
        with ipc.new_stream(sink, table.schema) as writer:
            writer.write_table(table)
        return sink.getvalue().to_pybytes()
    except Exception:
        buf = io.BytesIO()
        df.write_ipc_stream(buf)
        return buf.getvalue()


def dataframe_to_arrow_response(df: pl.DataFrame) -> Response:
    return Response(content=_serialize_dataframe_to_arrow_bytes(df), media_type="application/vnd.apache.arrow.stream")
