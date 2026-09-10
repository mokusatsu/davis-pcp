"""Dataset import, schema, and view APIs."""
from __future__ import annotations

import csv
import hashlib
import io
import json
from typing import Any

import polars as pl
import pyarrow as pa
import pyarrow.ipc as ipc
from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ValidationError

from ..config import settings
from ..domain.errors import BizError
from ..domain.multi_response import resolve_groups, validate_group
from ..domain.ma_projection import plan_ma_axes, append_ma_axes
from ..services.dataset_service import ColumnRole, ImportOptions, new_id, now_iso
from ..services.import_service import (
    build_builtin_iris,
    enforce_limits,
    load_dataframe_from_upload,
    probe_table,
    sqlite_tables,
)
from ..storage.dataset_store import DatasetStore, assign_row_identity, values_fingerprint
from ..domain.provenance import new_operation_id

router = APIRouter()

store = DatasetStore()

IMPUTE_METHOD_LABELS = {
    "mean": "平均値補完",
    "median": "中央値補完",
    "mode": "最頻値補完",
    "constant": "定数補完",
    "knn": "KNN補完",
    "tabdiff": "実験的条件付き補完",
}


def _provenance_step(operation: str, params: dict[str, Any], meta: dict[str, Any],
                     codebook: dict[str, Any] | None, algorithm_version: str,
                     target_row_ids: list[str] | None = None,
                     target_cells: list[dict[str, Any]] | None = None,
                     parent_operation_id: str | None = None) -> dict[str, Any]:
    return {
        "operationId": new_operation_id(),
        "parentOperationId": parent_operation_id,
        "operation": operation,
        "params": dict(params or {}),
        "targetRowIds": sorted({str(v) for v in (target_row_ids or [])}),
        "targetCells": sorted(
            ({"rowId": str(c.get("rowId")), "columnId": str(c.get("columnId"))}
             for c in (target_cells or []) if isinstance(c, dict)),
            key=lambda c: (c["rowId"], c["columnId"]),
        ),
        "inputSchemaRevision": int((codebook or {}).get("schemaRevision", meta.get("schemaRevision", 1))),
        "outputSchemaRevision": int((codebook or {}).get("schemaRevision", meta.get("schemaRevision", 1))),
        "algorithmVersion": algorithm_version,
        "timestamp": now_iso(),
        "createdBy": "local-session",
    }


def _mask_entries_for_impute(df_before: pl.DataFrame, df_after: pl.DataFrame,
                              columns: list[str], strategy: str, operation_id: str,
                              input_revision: int, mask_revision: int) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    row_ids = df_before["__rowId__"].to_list() if "__rowId__" in df_before.columns else []
    for column in columns:
        if column not in df_before.columns or column not in df_after.columns:
            continue
        before, after = df_before[column], df_after[column]
        is_float = before.dtype in (pl.Float32, pl.Float64)
        for idx, row_id in enumerate(row_ids):
            old = before[idx]
            old_missing = old is None or (is_float and isinstance(old, float) and old != old)
            if not old_missing:
                continue
            new = after[idx]
            new_missing = new is None or (is_float and isinstance(new, float) and new != new)
            if new_missing:
                continue
            entries.append({
                "rowId": str(row_id),
                "columnId": column,
                "methodId": strategy,
                "methodLabel": IMPUTE_METHOD_LABELS.get(strategy, strategy),
                "originalMissingReason": "user_missing",
                "createdByOperationId": operation_id,
                "inputDataRevision": input_revision,
                "maskRevision": mask_revision,
            })
    return entries


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
            if store.load_codebook(item["datasetId"]) is None:
                from ..services.dataset_service import generate_initial_codebook
                try:
                    cb = generate_initial_codebook(item["datasetId"], meta.get("schema", []))
                    store.save_codebook(item["datasetId"], cb)
                except Exception:
                    pass
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


def _get_visible_multi_response_groups(codebook: dict[str, Any]) -> list[dict[str, Any]]:
    raw_groups = codebook.get("multiResponseGroups") or []
    fallback = []
    for group in raw_groups:
        if isinstance(group, dict):
            fallback.append({k: v for k, v in group.items() if k != "columns"})

    try:
        groups = resolve_groups(codebook)
    except Exception:
        return fallback

    resolved = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        resolved.append({k: v for k, v in group.items() if k != "columns"})
    return resolved


def _sync_multi_response_groups(
    groups: list[Any],
    merged_cols: list[dict[str, Any]],
    filter_option_order: bool = False,
) -> list[dict[str, Any]]:
    if not groups:
        return []

    members_by_group: dict[str, set[str]] = {}
    for col in merged_cols:
        group_id = col.get("multiResponseGroup")
        column_id = col.get("columnId")
        if not isinstance(group_id, str) or not group_id:
            continue
        if not isinstance(column_id, str):
            continue
        members_by_group.setdefault(group_id, set()).add(column_id)

    normalized: list[dict[str, Any]] = []
    for raw_group in groups:
        if not isinstance(raw_group, dict):
            continue
        group_id = raw_group.get("groupId")
        if not isinstance(group_id, str) or not group_id:
            continue
        members = members_by_group.get(group_id)
        if not members:
            continue

        option_order_raw = raw_group.get("optionOrder", [])
        if filter_option_order:
            option_order = [cid for cid in option_order_raw if isinstance(cid, str) and cid in members]
        else:
            option_order = option_order_raw if isinstance(option_order_raw, list) else []
        group = dict(raw_group)
        group.pop("columns", None)
        group["optionOrder"] = option_order
        normalized.append(group)

    return normalized


def _sync_codebook(
    dataset_id: str,
    df: pl.DataFrame,
    source_schema: list[dict] | None = None,
    source_dataset_id: str | None = None,
) -> dict[str, Any]:
    from ..services.dataset_service import generate_initial_codebook
    existing_cb = None
    if source_dataset_id:
        existing_cb = store.load_codebook(source_dataset_id)
    if not existing_cb:
        existing_cb = store.load_codebook(dataset_id)

    frame_without_row_id = df.drop("__rowId__") if "__rowId__" in df.columns else df
    existing_names = {c["name"] for c in (existing_cb or {}).get("columns", [])}
    new_names = [c for c in frame_without_row_id.columns if c not in existing_names]
    new_frame = frame_without_row_id.select(new_names)
    schemas = _derive_dataset_schema(new_frame, source_schema) if new_names else []
    initial_cb = generate_initial_codebook(dataset_id, schemas)

    if existing_cb and "columns" in existing_cb:
        by_name = {c["name"]: dict(c) for c in existing_cb["columns"]}
        by_id = {c["columnId"]: dict(c) for c in existing_cb["columns"]}
        merged_cols = []
        initial_by_name = {c["name"]: c for c in initial_cb["columns"]}
        for cname in frame_without_row_id.columns:
            init_col = initial_by_name.get(cname) or by_name[cname]
            cname = init_col["name"]
            orig = by_name.get(cname) or by_id.get(init_col["columnId"])
            if orig:
                merged = {**init_col, **orig, "name": cname}
                merged_cols.append(merged)
            else:
                merged_cols.append(init_col)
        cb_payload = {
            "datasetId": dataset_id,
            "schemaRevision": existing_cb.get("schemaRevision", 1) + int(merged_cols != existing_cb["columns"]),
            "columns": merged_cols,
        }
    else:
        cb_payload = initial_cb

    cb_payload["multiResponseGroups"] = _sync_multi_response_groups(
        (existing_cb or {}).get("multiResponseGroups", []) or [],
        cb_payload.get("columns", []),
        True,
    ) if existing_cb else cb_payload.get("multiResponseGroups", [])

    return cb_payload


def _finalize_dataset(
    dataset_id: str,
    name: str,
    fmt: str,
    df: pl.DataFrame,
    options: ImportOptions | None,
    source_schema: list[dict] | None = None,
    source_dataset_id: str | None = None,
) -> dict:
    schemas = probe_table(df, df.height)
    id_column = (options.rowIdColumn if options and options.rowIdColumn else None) or next((s.name for s in schemas if s.role == ColumnRole.ROW_ID), None)
    if source_dataset_id and "__rowId__" in df.columns:
        id_column = None
    df, identity_source = assign_row_identity(df, id_column, schemas)
    # Re-probe on the canonical frame so row counts align with __rowId__, preserving schema metadata if available.
    schema_payload = _derive_dataset_schema(df, source_schema)
    cb = _sync_codebook(dataset_id, df, source_schema=source_schema, source_dataset_id=source_dataset_id)
    schema_revision = cb.get("schemaRevision", 1)

    fingerprint_material = {
        "schema": schema_payload,
        "options": options.model_dump(mode="json") if options else {},
        "format": fmt,
        "schemaRevision": schema_revision,
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
        "schemaRevision": schema_revision,
        "rowIdentity": identity_source,
        "rowIds": df["__rowId__"].to_list(),
        "createdAt": now_iso(),
        "importOptions": options.model_dump(mode="json") if options else ImportOptions().model_dump(mode="json"),
    }
    seed_step = _provenance_step("import", {"name": name, "format": fmt,
                                            "source_dataset_id": source_dataset_id}, meta, cb,
                                 "import-1")
    if source_dataset_id:
        source_provenance = store.load_provenance(source_dataset_id) or {}
        source_mask = store.load_mask(source_dataset_id) or {"entries": []}
        seed_step["parentOperationId"] = source_provenance.get("currentOperationId")
        seed_step["params"] = {**seed_step["params"],
                               "copiedMaskEntries": len(source_mask.get("entries", []))}
        commit = store.commit_data_change(dataset_id, meta, df, codebook=cb, step=seed_step,
                                           mask_entries=list(source_mask.get("entries", [])))
    else:
        commit = store.commit_data_change(dataset_id, meta, df, codebook=cb, step=seed_step)
    meta.pop("rowIds", None)
    provenance = commit["provenance"]
    return {**meta, "provenance": {"currentOperationId": provenance["currentOperationId"],
                                   "rawDataRevision": provenance.get("rawDataRevision"),
                                   "operationCount": len(provenance.get("operations", []))}}


@router.get("/datasets/{dataset_id}")
def get_dataset(dataset_id: str) -> dict:
    with store.lock(dataset_id):
        return _get_dataset(dataset_id)


def _get_dataset(dataset_id: str) -> dict:
    meta = store.get_meta(dataset_id)
    cb = store.load_codebook(dataset_id)
    by_name = {c["name"]: c for c in (cb or {}).get("columns", [])}
    return {**meta, "schemaRevision": (cb or {}).get("schemaRevision", meta.get("schemaRevision", 1)),
            "schema": [{**c, **by_name.get(c["name"], {})} for c in meta["schema"]]}


@router.get("/datasets/{dataset_id}/codebook")
def get_codebook(dataset_id: str) -> dict:
    with store.lock(dataset_id):
        return _get_codebook(dataset_id)


def _get_codebook(dataset_id: str) -> dict:
    meta = store.get_meta(dataset_id)
    cb = store.load_codebook(dataset_id)
    if not cb:
        from ..services.dataset_service import generate_initial_codebook
        cb = generate_initial_codebook(dataset_id, meta.get("schema", []))
        store.save_codebook(dataset_id, cb)
    response = dict(cb)
    response["multiResponseGroups"] = _get_visible_multi_response_groups(cb)
    return response


@router.put("/datasets/{dataset_id}/codebook")
def update_codebook(dataset_id: str, request: dict) -> dict:
    with store.lock(dataset_id):
        return _update_codebook(dataset_id, request)


def _update_codebook(dataset_id: str, request: dict) -> dict:
    from ..domain.codebook import CodebookUpdateRequest

    try:
        update_req = CodebookUpdateRequest(**request)
    except ValidationError as exc:
        raise BizError("CODEBOOK_INVALID", "コードブック定義が不正です。", status_code=422, details={"message": str(exc)}) from exc

    meta = store.get_meta(dataset_id)
    cb = store.load_codebook(dataset_id)
    if not cb:
        from ..services.dataset_service import generate_initial_codebook
        cb = generate_initial_codebook(dataset_id, meta.get("schema", []))
        cb["multiResponseGroups"] = []

    current_schema_revision = int(cb.get("schemaRevision", 1))
    if (
        update_req.expectedSchemaRevision is not None
        and update_req.expectedSchemaRevision != current_schema_revision
    ):
        raise BizError(
            "ANALYSIS_INPUT_STALE",
            "保存・変換のため入力の世代が更新されています。",
            status_code=409,
            details={
                "schemaRevision": current_schema_revision,
                "expectedSchemaRevision": update_req.expectedSchemaRevision,
            },
        )

    columns_payload = [dict(col) for col in cb.get("columns", []) if isinstance(col, dict)]
    cb["columns"] = columns_payload
    by_id = {c["columnId"]: c for c in cb.get("columns", [])}
    by_name = {c["name"]: c for c in cb.get("columns", [])}
    multi_response_groups = [dict(g) for g in cb.get("multiResponseGroups", []) if isinstance(g, dict)]
    groups_by_id = {g.get("groupId"): idx for idx, g in enumerate(multi_response_groups) if isinstance(g.get("groupId"), str) and g.get("groupId")}
    updated_count = 0

    allowed_fields = {
        "label",
        "scaleType",
        "role",
        "valueLabels",
        "categoryOrder",
        "missingCodes",
        "missingReasons",
        "isReversed",
        "multiResponseGroup",
        "multiResponseOptionLabel",
    }
    validation_affecting_fields = {
        "scaleType",
        "role",
        "missingCodes",
        "missingReasons",
        "isReversed",
        "multiResponseGroup",
    }
    changed_group_ids: set[str] = set()
    changed_group_order: list[str] = []
    reassigned_from_group_ids: set[str] = set()

    def _mark_changed(group_id: str | None) -> None:
        if not isinstance(group_id, str) or not group_id:
            return
        if group_id not in changed_group_ids:
            changed_group_ids.add(group_id)
            changed_group_order.append(group_id)

    for patch in update_req.columns:
        target = None
        if patch.columnId and patch.columnId in by_id:
            target = by_id[patch.columnId]
        elif patch.name and patch.name in by_name:
            target = by_name[patch.name]

        if not target:
            continue

        updated_count += 1
        old_group = target.get("multiResponseGroup")
        old_group = old_group if isinstance(old_group, str) else None
        patch_dict = patch.model_dump(exclude_unset=True)
        for k, v in patch_dict.items():
            if k not in allowed_fields:
                continue
            if k == "multiResponseGroup":
                next_group = v
                if hasattr(v, "value"):
                    next_group = v.value
                if next_group == "":
                    next_group = None
                target[k] = next_group
                if next_group != old_group:
                    if old_group:
                        reassigned_from_group_ids.add(old_group)
                    _mark_changed(next_group)
                    _mark_changed(old_group)
            elif v is not None:
                if hasattr(v, "value"):
                    v = v.value
                if k in validation_affecting_fields and v != target.get(k):
                    _mark_changed(old_group)
                target[k] = v

    seen_upsert_group_ids: set[str] = set()
    if update_req.multiResponseGroups:
        for group in update_req.multiResponseGroups:
            group_payload = group.model_dump()
            group_id = group_payload.get("groupId")
            if not isinstance(group_id, str) or not group_id:
                continue
            if group_id in seen_upsert_group_ids:
                raise BizError("MA_DEFINITION_INVALID", f"groupId が重複しています: {group_id}", status_code=422)
            seen_upsert_group_ids.add(group_id)
            if not group_payload.get("label"):
                group_payload["label"] = group_id
            _mark_changed(group_id)
            if group_id in groups_by_id:
                multi_response_groups[groups_by_id[group_id]] = group_payload
            else:
                multi_response_groups.append(group_payload)
                groups_by_id[group_id] = len(multi_response_groups) - 1
    resolved_groups: list[dict[str, Any]] = []
    resolved_group_specs: dict[str, dict[str, Any]] = {}

    if changed_group_ids:
        try:
            resolved_groups = resolve_groups({"columns": cb["columns"], "multiResponseGroups": multi_response_groups})
        except ValueError as exc:
            raise BizError("MA_DEFINITION_INVALID", str(exc), status_code=422) from exc
        resolved_by_group = {
            g.get("groupId"): g for g in resolved_groups if isinstance(g, dict) and isinstance(g.get("groupId"), str)
        }
        for group_id in changed_group_order:
            group = resolved_by_group.get(group_id)
            if not group:
                continue
            group_members = group.get("columns")
            if group_id in seen_upsert_group_ids and not group_members:
                raise BizError(
                    "MA_DEFINITION_INVALID",
                    "multi-response group must have at least one member column",
                    status_code=422,
                )
            if not group_members:
                # allow removing an existing parent whose column membership became empty (old parent cleanup).
                continue

            option_order = group.get("optionOrder")
            if option_order is None:
                option_order = []
            if not isinstance(option_order, list):
                raise BizError(
                    "MA_DEFINITION_INVALID",
                    "multiResponseGroup optionOrder must be a list",
                    status_code=422,
                )
            if not all(isinstance(code, str) for code in option_order):
                raise BizError(
                    "MA_DEFINITION_INVALID",
                    "multiResponseGroup optionOrder must be a list of strings",
                    status_code=422,
                )

            option_order_for_validation = option_order
            if group_id in reassigned_from_group_ids:
                member_ids = {
                    c.get("columnId")
                    for c in group_members
                    if isinstance(c, dict) and isinstance(c.get("columnId"), str)
                }
                option_order_for_validation = [code for code in option_order if code in member_ids]

            candidate_group = dict(group)
            candidate_group["optionOrder"] = option_order_for_validation
            try:
                validate_group(candidate_group)
            except ValueError as exc:
                raise BizError("MA_DEFINITION_INVALID", str(exc), status_code=422) from exc

            if not candidate_group.get("label"):
                candidate_group["label"] = group_id
            resolved_group_specs[group_id] = {k: v for k, v in candidate_group.items() if k != "columns"}

    projected_groups: list[dict[str, Any]] = []
    seen_projected_ids: set[str] = set()
    for raw_group in multi_response_groups:
        if not isinstance(raw_group, dict):
            continue
        raw_group_id = raw_group.get("groupId")
        if not isinstance(raw_group_id, str):
            continue
        if raw_group_id in changed_group_ids:
            if raw_group_id in resolved_group_specs:
                if raw_group_id in seen_projected_ids:
                    continue
                projected = resolved_group_specs[raw_group_id]
                projected_groups.append(projected)
                seen_projected_ids.add(raw_group_id)
            continue
        projected = {k: v for k, v in raw_group.items() if k != "columns"}
        projected_groups.append(projected)
        seen_projected_ids.add(raw_group_id)

    for group_id in changed_group_order:
        if group_id in seen_projected_ids:
            continue
        projected = resolved_group_specs.get(group_id)
        if projected:
            projected_groups.append(projected)
            seen_projected_ids.add(group_id)

    cb["multiResponseGroups"] = _sync_multi_response_groups(projected_groups, cb["columns"], False)
    new_rev = int(cb.get("schemaRevision", 1)) + 1
    cb["schemaRevision"] = new_rev
    # Sync schemaRevision to meta & update fingerprint
    meta["schemaRevision"] = new_rev
    fingerprint_material = {
        "schema": meta.get("schema", []),
        "options": meta.get("importOptions", {}),
        "format": meta.get("format", "csv"),
        "schemaRevision": new_rev,
    }
    fingerprint_seed = meta.get("valuesFingerprint")
    if not fingerprint_seed:
        fingerprint_seed = values_fingerprint(store.get_dataframe(dataset_id))
        meta["valuesFingerprint"] = fingerprint_seed
    meta["fingerprint"] = hashlib.sha256(
        json.dumps(fingerprint_material, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
    ).hexdigest()
    store.save_metadata(dataset_id, meta, cb)

    return {
        "status": "success",
        "datasetId": dataset_id,
        "schemaRevision": new_rev,
        "updatedColumns": updated_count,
    }


@router.post("/datasets/{dataset_id}/codebook/import")
async def import_codebook(dataset_id: str, file: UploadFile = File(...)) -> dict:
    cb = get_codebook(dataset_id)
    by_name = {c["name"]: c for c in cb["columns"]}
    by_id = {c["columnId"]: c for c in cb["columns"]}
    raw = await _read_upload(file)
    text = raw.decode("utf-8-sig")
    patches: list[dict] = []
    groups = None
    try:
        if text.lstrip().startswith(("{", "[")):
            payload = json.loads(text)
            items = payload.get("columns") if isinstance(payload, dict) else payload
            if not isinstance(items, list):
                raise ValueError("columns must be an array")
            for item in items:
                if not isinstance(item, dict):
                    raise ValueError("column definitions must be objects")
                target = by_name.get(item.get("name")) or by_id.get(item.get("columnId"))
                if target:
                    patches.append({**item, "columnId": target["columnId"], "name": target["name"]})
            if isinstance(payload, dict) and "multiResponseGroups" in payload:
                groups = payload["multiResponseGroups"]
                if not isinstance(groups, list):
                    raise ValueError("multiResponseGroups must be an array")
                source_names = {c.get("columnId"): c.get("name") for c in items if isinstance(c, dict)}
                normalized_groups = []
                for raw_group in groups:
                    group = dict(raw_group)
                    if "optionOrderNames" in group and "optionOrder" in group:
                        raise ValueError("Specify only one option order field")
                    if "optionOrderNames" in group:
                        group["optionOrder"] = [by_name[name]["columnId"] for name in group.pop("optionOrderNames")]
                    elif group.get("optionOrder"):
                        group["optionOrder"] = [by_name[source_names[cid]]["columnId"] if cid in source_names
                                                else by_id[cid]["columnId"] for cid in group["optionOrder"]]
                    normalized_groups.append(group)
                groups = normalized_groups
        else:
            for row in csv.DictReader(io.StringIO(text)):
                target = by_name.get(row.get("name"))
                if not target:
                    continue
                patch = {"columnId": target["columnId"]}
                for field in ("label", "scaleType", "role", "multiResponseOptionLabel"):
                    if row.get(field):
                        patch[field] = row[field]
                if "multiResponseGroup" in row:
                    patch["multiResponseGroup"] = row["multiResponseGroup"] or None
                if row.get("isReversed"):
                    if row["isReversed"].lower() not in ("true", "false", "1", "0", "yes", "no"):
                        raise ValueError("isReversed must be a boolean")
                    patch["isReversed"] = row["isReversed"].lower() in ("true", "1", "yes")
                for field in ("valueLabels", "missingReasons", "categoryOrder", "missingCodes"):
                    if row.get(field):
                        patch[field] = json.loads(row[field])
                patches.append(patch)
        if not patches and not groups:
            raise ValueError("No matching columns or groups")
    except (ValueError, KeyError, TypeError) as exc:
        raise BizError("CODEBOOK_INVALID", "辞書の列・設問定義を確認してください。", status_code=422,
                       details={"message": str(exc)}) from exc
    request = {"columns": patches, "expectedSchemaRevision": cb["schemaRevision"]}
    if groups is not None:
        request["multiResponseGroups"] = groups
    return update_codebook(dataset_id, request)


@router.get("/datasets/{dataset_id}/codebook/export")
def export_codebook(dataset_id: str, format: str = "csv") -> Response:
    with store.lock(dataset_id):
        return _export_codebook(dataset_id, format)


def _export_codebook(dataset_id: str, format: str = "csv") -> Response:
    cb = store.load_codebook(dataset_id)
    if not cb:
        meta = store.get_meta(dataset_id)
        from ..services.dataset_service import generate_initial_codebook
        cb = generate_initial_codebook(dataset_id, meta.get("schema", []))
        store.save_codebook(dataset_id, cb)

    fmt = format.lower().strip()
    if fmt == "json":
        content = json.dumps(cb, ensure_ascii=False, indent=2)
        return Response(
            content=content,
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="codebook_{dataset_id}.json"'},
        )

    # CSV format
    output = io.StringIO()
    fields = [
        "name",
        "label",
        "scaleType",
        "role",
        "valueLabels",
        "categoryOrder",
        "missingCodes",
        "missingReasons",
        "isReversed",
        "multiResponseGroup",
        "multiResponseOptionLabel",
    ]
    writer = csv.writer(output)
    writer.writerow(fields)

    for col in cb.get("columns", []):
        row = [
            col.get("name", ""),
            col.get("label", ""),
            col.get("scaleType", ""),
            col.get("role", ""),
            json.dumps(col.get("valueLabels", {}), ensure_ascii=False) if col.get("valueLabels") else "",
            json.dumps(col.get("categoryOrder", []), ensure_ascii=False) if col.get("categoryOrder") else "",
            json.dumps(col.get("missingCodes", []), ensure_ascii=False) if col.get("missingCodes") else "",
            json.dumps(col.get("missingReasons", {}), ensure_ascii=False) if col.get("missingReasons") else "",
            "true" if col.get("isReversed") else "false",
            col.get("multiResponseGroup") or "",
            col.get("multiResponseOptionLabel", ""),
        ]
        writer.writerow(row)

    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="codebook_{dataset_id}.csv"'},
    )


@router.delete("/datasets/{dataset_id}/codebook/multi-response-groups/{group_id}")
def delete_multi_response_group(dataset_id: str, group_id: str, expectedSchemaRevision: int) -> dict:
    with store.lock(dataset_id):
        return _delete_multi_response_group(dataset_id, group_id, expectedSchemaRevision)


def _delete_multi_response_group(dataset_id: str, group_id: str, expectedSchemaRevision: int) -> dict:
    cb = store.load_codebook(dataset_id)
    if not cb:
        meta = store.get_meta(dataset_id)
        from ..services.dataset_service import generate_initial_codebook
        cb = generate_initial_codebook(dataset_id, meta.get("schema", []))
        cb["multiResponseGroups"] = []

    columns = cb.get("columns", [])
    if not isinstance(columns, list):
        columns = []

    group_columns = []
    for col in columns:
        if isinstance(col, dict) and col.get("multiResponseGroup") == group_id and isinstance(col.get("columnId"), str):
            group_columns.append(col["columnId"])

    has_group_definition = any(
        isinstance(group, dict) and group.get("groupId") == group_id
        for group in cb.get("multiResponseGroups", [])
    )
    if not group_columns and not has_group_definition:
        raise BizError("GROUP_NOT_FOUND", f"multiResponseGroup が見つかりません: {group_id}", status_code=404)

    return update_codebook(dataset_id, {
        "expectedSchemaRevision": expectedSchemaRevision,
        "columns": [{"columnId": cid, "multiResponseGroup": None} for cid in group_columns],
    })


class SchemaPatch(BaseModel):
    columns: list[dict[str, Any]]


@router.patch("/datasets/{dataset_id}/schema")
def patch_schema(dataset_id: str, patch: SchemaPatch) -> dict:
    with store.lock(dataset_id):
        return _patch_schema(dataset_id, patch)


def _patch_schema(dataset_id: str, patch: SchemaPatch) -> dict:
    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)
    by_name = {c["name"]: c for c in patch.columns}
    input_revision = int(meta.get("dataRevision", 1))
    current_cb = store.load_codebook(dataset_id) or {}
    input_schema_revision = int(current_cb.get("schemaRevision", meta.get("schemaRevision", 1)))
    provenance_before = store.load_provenance(dataset_id)
    parent_op = (provenance_before or {}).get("currentOperationId")
    updated = []
    renamed = False
    for column_meta in meta["schema"]:
        override = by_name.get(column_meta["name"])
        if override:
            allowed = {"semanticType", "role", "categoryOrder", "manualCategories"}
            column_meta = {**column_meta, **{k: v for k, v in override.items() if k in allowed}}
            if override.get("newName"):
                old = column_meta["name"]
                column_meta["name"] = override["newName"]
                df = df.rename({old: override["newName"]})
                renamed = renamed or old != override["newName"]
        updated.append(column_meta)
    meta["schema"] = updated
    meta["schemaRevision"] = input_schema_revision + 1
    cb = store.load_codebook(dataset_id)
    if cb:
        for column in cb["columns"]:
            override = by_name.get(column["name"], {})
            if "semanticType" in override:
                column["scaleType"] = {"numeric": "ratio", "categorical": "nominal", "ordinal": "ordinal", "identifier": "id", "label": "text"}.get(override["semanticType"], column["scaleType"])
            for key in ("role", "categoryOrder"):
                if key in override:
                    column[key] = override[key]
            if override.get("newName"):
                column["name"] = override["newName"]
        cb["schemaRevision"] = meta["schemaRevision"]
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
    step = _provenance_step("schema_update", {"columns": sorted(by_name.keys())}, meta, cb,
                            "schema-patch-1", parent_operation_id=parent_op)
    commit = store.commit_data_change(dataset_id, meta, df, codebook=cb, step=step)
    meta.pop("rowIds", None)
    provenance = commit["provenance"]
    return {**meta, "provenance": {"currentOperationId": provenance["currentOperationId"],
                                   "rawDataRevision": provenance.get("rawDataRevision"),
                                   "operationCount": len(provenance.get("operations", []))}}


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
    with store.lock(dataset_id):
        return _transform_dataset(dataset_id, request)


def _transform_dataset(dataset_id: str, request: TransformRequest) -> dict:
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
    schema_payload = _derive_dataset_schema(df, meta.get("schema", []))
    cb = _sync_codebook(dataset_id, df, source_schema=meta.get("schema", []))
    schema_revision = cb.get("schemaRevision", 1)

    # Invalidate cached fingerprint
    fingerprint_seed = values_fingerprint(df)
    meta["fingerprint"] = hashlib.sha256(
        json.dumps({"schema": schema_payload, "schemaRevision": schema_revision}, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
    ).hexdigest()
    meta["schema"] = schema_payload
    meta["schemaRevision"] = schema_revision
    meta["columnCount"] = df.width - 1
    meta["revision"] = meta.get("revision", 1) + 1

    input_revision = int(store.get_meta(dataset_id).get("dataRevision", 1))
    provenance_before = store.load_provenance(dataset_id)
    step = _provenance_step("transform", {"type": request.type, "source_column": request.source_column,
                                          "options": request.options}, meta, cb, "transform-1",
                            parent_operation_id=(provenance_before or {}).get("currentOperationId"))
    commit = store.commit_data_change(dataset_id, meta, df, codebook=cb, step=step)
    meta.pop("rowIds", None)
    provenance = commit["provenance"]

    return {
        **meta,
        "createdColumns": created_columns,
        "binSummaries": bin_summaries,
        "provenance": {"currentOperationId": provenance["currentOperationId"],
                       "rawDataRevision": provenance.get("rawDataRevision"),
                       "operationCount": len(provenance.get("operations", []))},
    }


@router.delete("/datasets/{dataset_id}/columns/{column_name}")
def delete_column(dataset_id: str, column_name: str) -> dict:
    with store.lock(dataset_id):
        return _delete_column(dataset_id, column_name)


def _delete_column(dataset_id: str, column_name: str) -> dict:
    if column_name == "__rowId__":
        raise BizError("COLUMN_CANNOT_DELETE_ROW_ID", "ID列 '__rowId__' は削除できません。")

    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)

    if column_name not in df.columns:
        raise BizError("COLUMN_NOT_FOUND", f"列 '{column_name}' が見つかりません。")

    df = df.drop(column_name)
    schema_payload = _derive_dataset_schema(df, meta.get("schema", []))
    cb = _sync_codebook(dataset_id, df, source_schema=meta.get("schema", []))
    schema_revision = cb.get("schemaRevision", 1)

    meta["schema"] = schema_payload
    meta["schemaRevision"] = schema_revision
    meta["columnCount"] = df.width - 1
    meta["revision"] = meta.get("revision", 1) + 1

    provenance_before = store.load_provenance(dataset_id)
    mask_doc = store.load_mask(dataset_id) or {"entries": [], "maskRevision": 0}
    dropped = [e for e in mask_doc.get("entries", []) if e.get("columnId") == column_name]
    step = _provenance_step("delete_column", {"column_name": column_name,
                                              "droppedMaskEntries": len(dropped)}, meta, cb,
                            "delete-column-1",
                            parent_operation_id=(provenance_before or {}).get("currentOperationId"))
    kept = [e for e in mask_doc.get("entries", []) if e.get("columnId") != column_name]
    commit = store.commit_data_change(dataset_id, meta, df, codebook=cb, step=step,
                                       mask_entries=kept, replace_mask=True)
    meta.pop("rowIds", None)
    provenance = commit["provenance"]
    return {**meta, "provenance": {"currentOperationId": provenance["currentOperationId"],
                                   "rawDataRevision": provenance.get("rawDataRevision"),
                                   "operationCount": len(provenance.get("operations", []))}}


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
    with store.lock(dataset_id):
        return _impute_dataset(dataset_id, request)


def _impute_dataset(dataset_id: str, request: ImputeRequest) -> dict:
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
        cb = _sync_codebook(dataset_id, imputed_df, source_schema=meta.get("schema", []))
        schema_revision = cb.get("schemaRevision", 1)
        fingerprint_seed = values_fingerprint(imputed_df)
        meta["fingerprint"] = hashlib.sha256(
            json.dumps({"schema": schema_payload, "schemaRevision": schema_revision}, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
        ).hexdigest()
        meta["schema"] = schema_payload
        meta["columnCount"] = imputed_df.width - 1
        meta["revision"] = meta.get("revision", 1) + 1
        meta["schemaRevision"] = schema_revision

        input_revision = int(store.get_meta(dataset_id).get("dataRevision", 1))
        provenance_before = store.load_provenance(dataset_id)
        mask_before = store.load_mask(dataset_id) or {"maskRevision": 0}
        step = _provenance_step("impute", {"columns": request.columns, "strategy": request.strategy,
                                           "options": request.options, "inPlace": True}, meta, cb,
                                f"impute-{request.strategy}-1",
                                parent_operation_id=(provenance_before or {}).get("currentOperationId"))
        imputed_targets = [c for c in (request.columns or []) if c in df.columns]
        if not imputed_targets:
            imputed_targets = [c for c in df.columns if c != "__rowId__"]
        mask_entries = _mask_entries_for_impute(
            df, imputed_df, imputed_targets,
            request.strategy, step["operationId"], input_revision,
            int(mask_before.get("maskRevision", 0)) + 1)
        commit = store.commit_data_change(dataset_id, meta, imputed_df, codebook=cb, step=step,
                                           mask_entries=mask_entries)
        meta.pop("rowIds", None)
        provenance = commit["provenance"]
        return {
            **meta,
            "diagnostics": diagnostics,
            "provenance": {"currentOperationId": provenance["currentOperationId"],
                           "rawDataRevision": provenance.get("rawDataRevision"),
                           "operationCount": len(provenance.get("operations", []))},
            "maskRevision": commit["mask"]["maskRevision"],
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
            source_dataset_id=dataset_id,
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
    with store.lock(dataset_id):
        return _calculate_dataset_variable(dataset_id, request)


def _calculate_dataset_variable(dataset_id: str, request: CalculateRequest) -> dict:
    from ..algorithms.transformation.expression import evaluate_expression

    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)

    updated_df, new_series, col_meta = evaluate_expression(
        df,
        expression=request.expression,
        new_column_name=request.columnName,
    )

    schema_payload = _derive_dataset_schema(updated_df, meta.get("schema", []))
    cb = _sync_codebook(dataset_id, updated_df, source_schema=meta.get("schema", []))
    schema_revision = cb.get("schemaRevision", 1)

    fingerprint_seed = values_fingerprint(updated_df)
    meta["fingerprint"] = hashlib.sha256(
        json.dumps({"schema": schema_payload, "schemaRevision": schema_revision}, sort_keys=True).encode("utf-8") + fingerprint_seed.encode()
    ).hexdigest()
    meta["schema"] = schema_payload
    meta["schemaRevision"] = schema_revision
    meta["columnCount"] = updated_df.width - 1
    meta["revision"] = meta.get("revision", 1) + 1

    provenance_before = store.load_provenance(dataset_id)
    step = _provenance_step("calculate", {"expression": request.expression,
                                          "columnName": request.columnName}, meta, cb,
                            "calculate-1",
                            parent_operation_id=(provenance_before or {}).get("currentOperationId"))
    commit = store.commit_data_change(dataset_id, meta, updated_df, codebook=cb, step=step)
    meta.pop("rowIds", None)
    provenance = commit["provenance"]

    return {
        **meta,
        "createdColumn": col_meta,
        "provenance": {"currentOperationId": provenance["currentOperationId"],
                       "rawDataRevision": provenance.get("rawDataRevision"),
                       "operationCount": len(provenance.get("operations", []))},
    }




@router.post("/datasets/{dataset_id}/view")
def dataset_view(dataset_id: str, body: dict) -> Response:
    with store.lock(dataset_id):
        return _dataset_view(dataset_id, body)


def _dataset_view(dataset_id: str, body: dict) -> Response:
    """Arrow IPC view of the dataset with optional filters.

    body: {columns?: [names], rowIds?: [...], limit?: int, offset?: int}
    """
    meta = store.get_meta(dataset_id)
    columns = body.get("columns")
    ma_axes = body.get("maAxes") or []
    codebook = store.load_codebook(dataset_id) or {}
    for field in ("dataRevision", "schemaRevision"):
        current = codebook.get(field, meta.get(field, 1)) if field == "schemaRevision" else meta.get(field, 1)
        expected = body.get("expected" + field[0].upper() + field[1:])
        if expected is not None and expected != current:
            raise BizError("ANALYSIS_INPUT_STALE", "入力の世代が更新されています。", status_code=409)
    if columns is not None:
        available = {c["name"] for c in meta["schema"]} | {"__rowId__"}
        if not isinstance(columns, list) or any(c not in available for c in columns):
            raise BizError("COLUMN_NOT_FOUND", "存在する列を指定してください。", status_code=422)
        columns = list(dict.fromkeys(["__rowId__", *columns]))
    try:
        plans, dependencies = plan_ma_axes(codebook, ma_axes, {c["name"] for c in meta["schema"]}) if ma_axes else ([], [])
    except (ValueError, TypeError, AttributeError) as exc:
        raise BizError("MA_DEFINITION_INVALID", str(exc), status_code=422) from exc
    if plans and columns is None:
        raise BizError("MA_DEFINITION_INVALID", "MA軸と併用する通常列を明示してください。", status_code=422)
    read_columns = list(dict.fromkeys([*columns, *dependencies])) if columns is not None else None
    df = store.get_dataframe(dataset_id, columns=read_columns)
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
    if plans:
        df = append_ma_axes(df, plans).select([*columns, *[axis["key"] for axis, _ in plans]])
    return Response(content=_serialize_dataframe_to_arrow_bytes(df), media_type="application/vnd.apache.arrow.stream")


class RevertRequest(BaseModel):
    targetOperationId: str | None = None
    targetDataRevision: int | None = None
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


class UndoRedoRequest(BaseModel):
    expectedDataRevision: int | None = None
    expectedSchemaRevision: int | None = None


@router.get("/datasets/{dataset_id}/provenance")
def get_provenance(dataset_id: str) -> dict:
    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        provenance = store.load_provenance(dataset_id) or {
            "datasetId": dataset_id, "operations": [], "currentOperationId": None,
            "rawDataRevision": None,
        }
        mask = store.load_mask(dataset_id) or {"maskRevision": 0, "entries": []}
        summary = [
            {"operationId": o.get("operationId"), "operation": o.get("operation"),
             "outputDataRevision": o.get("outputDataRevision"),
             "timestamp": o.get("timestamp"), "algorithmVersion": o.get("algorithmVersion")}
            for o in provenance.get("operations", [])
        ]
        return {
            "datasetId": dataset_id,
            "dataRevision": int(meta.get("dataRevision", 1)),
            "schemaRevision": int(codebook.get("schemaRevision", meta.get("schemaRevision", 1))),
            "currentOperationId": provenance.get("currentOperationId"),
            "rawDataRevision": provenance.get("rawDataRevision"),
            "maskRevision": int(mask.get("maskRevision", 0)),
            "operations": provenance.get("operations", []),
            "steps": summary,
        }


def _restore_revision(dataset_id: str, target_revision: int, operation: str,
                      params: dict[str, Any], expected_data: int | None,
                      expected_schema: int | None) -> dict:
    from ..domain.context import check_revisions, collect_revisions

    meta = store.get_meta(dataset_id)
    codebook = store.load_codebook(dataset_id) or {}
    revisions = collect_revisions(meta, codebook)
    check_revisions(revisions, expected_schema, expected_data)
    provenance = store.load_provenance(dataset_id) or {"operations": []}
    if not any(int(o.get("outputDataRevision", -1)) == int(target_revision)
               for o in provenance.get("operations", [])):
        raise BizError("PROVENANCE_TARGET_MISSING",
                       f"revision {int(target_revision)} の履歴が存在しません。",
                       status_code=422)
    snapshot = store.read_snapshot(dataset_id, int(target_revision))
    mask_now = store.load_mask(dataset_id) or {"entries": []}
    if operation == "revert" and int(target_revision) == int(provenance.get("rawDataRevision") or -1):
        restored_mask: list[dict[str, Any]] = []
    else:
        restored_mask = [e for e in mask_now.get("entries", [])
                         if e.get("columnId") in snapshot.columns]
    parent_op = provenance.get("currentOperationId")
    step = _provenance_step(operation, params, meta, codebook, f"{operation}-1",
                            parent_operation_id=parent_op)
    target_cb = _sync_codebook(dataset_id, snapshot, source_schema=meta.get("schema", []))
    commit = store.commit_data_change(dataset_id, dict(meta), snapshot, codebook=target_cb,
                                       step=step, mask_entries=restored_mask, replace_mask=True)
    fresh_meta = store.get_meta(dataset_id)
    fresh_codebook = store.load_codebook(dataset_id) or {}
    return {
        "datasetId": dataset_id,
        "currentDataRevision": int(fresh_meta.get("dataRevision", 1)),
        "currentOperationId": commit["provenance"]["currentOperationId"],
        "maskRevision": int(commit["mask"]["maskRevision"]),
        "schemaRevision": int(fresh_codebook.get("schemaRevision",
                                                 fresh_meta.get("schemaRevision", 1))),
        "targetDataRevision": int(target_revision),
    }


def _child_operations(provenance: dict[str, Any], operation_id: str | None) -> list[dict[str, Any]]:
    return [o for o in provenance.get("operations", [])
            if o.get("parentOperationId") == operation_id]


@router.post("/datasets/{dataset_id}/revert")
def revert_dataset(dataset_id: str, request: RevertRequest) -> dict:
    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        provenance = store.load_provenance(dataset_id) or {"operations": []}
        target_revision: int | None = request.targetDataRevision
        if request.targetOperationId:
            match = next((o for o in provenance.get("operations", [])
                          if o.get("operationId") == request.targetOperationId), None)
            if match is None:
                raise BizError("PROVENANCE_TARGET_MISSING", "指定された操作が履歴に存在しません。",
                               status_code=422)
            target_revision = int(match["outputDataRevision"])
        if target_revision is None:
            raise BizError("PROVENANCE_TARGET_MISSING",
                           "targetOperationId か targetDataRevision のいずれかを指定してください。",
                           status_code=422)
        return _restore_revision(
            dataset_id, int(target_revision), "revert",
            {"targetOperationId": request.targetOperationId,
             "targetDataRevision": int(target_revision)},
            request.expectedDataRevision, request.expectedSchemaRevision)


@router.post("/datasets/{dataset_id}/undo")
def undo_dataset(dataset_id: str, request: UndoRedoRequest) -> dict:
    with store.lock(dataset_id):
        provenance = store.load_provenance(dataset_id) or {"operations": []}
        current_id = provenance.get("currentOperationId")
        current = next((o for o in provenance.get("operations", [])
                        if o.get("operationId") == current_id), None)
        if current is None or current.get("parentOperationId") is None:
            raise BizError("PROVENANCE_NOTHING_TO_UNDO", "取り消せる操作がありません。",
                           status_code=409)
        parent = next((o for o in provenance.get("operations", [])
                       if o.get("operationId") == current["parentOperationId"]), None)
        if parent is None:
            raise BizError("PROVENANCE_TARGET_MISSING", "親操作の履歴が存在しません。",
                           status_code=422)
        return _restore_revision(
            dataset_id, int(parent["outputDataRevision"]), "undo",
            {"undoneOperationId": current_id},
            request.expectedDataRevision, request.expectedSchemaRevision)


@router.post("/datasets/{dataset_id}/redo")
def redo_dataset(dataset_id: str, request: UndoRedoRequest) -> dict:
    with store.lock(dataset_id):
        provenance = store.load_provenance(dataset_id) or {"operations": []}
        current_id = provenance.get("currentOperationId")
        current = next((o for o in provenance.get("operations", [])
                        if o.get("operationId") == current_id), None)
        if current is not None:
            undone_ids = {(o.get("params") or {}).get("undoneOperationId")
                          for o in provenance.get("operations", [])
                          if o.get("operation") == "undo"}
            undone_ids.discard(None)
            undo_ids = {o.get("operationId") for o in provenance.get("operations", [])
                        if o.get("operation") == "undo"}
            undone_parents = {o.get("parentOperationId")
                              for o in provenance.get("operations", [])
                              if o.get("operationId") in undone_ids}
            branched_anchors = set(undone_parents) | set(undone_ids) | set(undo_ids)
            branched = [o for o in provenance.get("operations", [])
                        if o.get("operation") not in ("undo", "redo")
                        and (o.get("parentOperationId") in branched_anchors
                             or o.get("operationId") in undone_ids)]
            anchor_groups: dict[str, list[dict[str, Any]]] = {}
            for item in branched:
                key = str(item.get("parentOperationId"))
                anchor_groups.setdefault(key, []).append(item)
            conflict = [item for group in anchor_groups.values() if len(group) >= 2 for item in group]
            if not conflict and len(branched) >= 2 and current.get("operation") != "undo":
                conflict = branched
            if conflict:
                raise BizError("REDO_AMBIGUOUS", "やり直し先が複数あるため対象を特定できません。",
                               status_code=409,
                               details={"childOperationIds":
                                        [c.get("operationId") for c in conflict]})
            undone_id = ((current.get("params") or {}).get("undoneOperationId")
                         if current.get("operation") == "undo" else None)
            if undone_id:
                target = next((o for o in provenance.get("operations", [])
                               if o.get("operationId") == undone_id), None)
                if target is not None:
                    return _restore_revision(
                        dataset_id, int(target["outputDataRevision"]), "redo",
                        {"redoneOperationId": undone_id},
                        request.expectedDataRevision, request.expectedSchemaRevision)
        children = _child_operations(provenance, provenance.get("currentOperationId"))
        if not children:
            raise BizError("PROVENANCE_NOTHING_TO_REDO", "やり直せる操作がありません。",
                           status_code=409)
        if len(children) > 1:
            raise BizError("REDO_AMBIGUOUS", "やり直し先が複数あるため対象を特定できません。",
                           status_code=409,
                           details={"childOperationIds": [c.get("operationId") for c in children]})
        child = children[0]
        return _restore_revision(
            dataset_id, int(child["outputDataRevision"]), "redo",
            {"redoneOperationId": child.get("operationId")},
            request.expectedDataRevision, request.expectedSchemaRevision)


@router.get("/datasets/{dataset_id}/imputation-mask")
def get_imputation_mask(dataset_id: str, rowIds: str | None = None,
                        columnIds: str | None = None,
                        expectedDataRevision: int | None = None) -> dict:
    with store.lock(dataset_id):
        from ..domain.context import check_revisions, collect_revisions, scope_hash

        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(meta, codebook)
        if expectedDataRevision is None:
            raise BizError("ANALYSIS_CONTEXT_INCOMPLETE", "expectedDataRevision は必須です。",
                           status_code=422)
        check_revisions(revisions, None, expectedDataRevision)
        mask = store.load_mask(dataset_id) or {"maskRevision": 0, "entries": []}
        df = store.get_dataframe(dataset_id, columns=["__rowId__"])
        current_ids = {str(v) for v in df["__rowId__"].to_list()}
        wanted_rows = {s.strip() for s in (rowIds or "").split(",") if s.strip()} or None
        wanted_cols = {s.strip() for s in (columnIds or "").split(",") if s.strip()} or None
        entries = [e for e in mask.get("entries", [])
                   if e.get("rowId") in current_ids
                   and (wanted_rows is None or e.get("rowId") in wanted_rows)
                   and (wanted_cols is None or e.get("columnId") in wanted_cols)]
        return {
            "datasetId": dataset_id,
            "dataRevision": revisions["dataRevision"],
            "maskRevision": int(mask.get("maskRevision", 0)),
            "entries": entries,
            "scopeHash": scope_hash(sorted(current_ids)),
        }


PACKAGE_VERSION = "provenance-package-1"


@router.get("/datasets/{dataset_id}/export_package")
def export_package(dataset_id: str):
    import io
    import zipfile
    from fastapi.responses import Response

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        provenance = store.load_provenance(dataset_id) or {
            "datasetId": dataset_id, "operations": [], "currentOperationId": None,
            "rawDataRevision": None,
        }
        mask = store.load_mask(dataset_id) or {"maskRevision": 0, "entries": []}
        current_df = store.get_dataframe(dataset_id)
        raw_df = store.read_raw(dataset_id)
        revisions = {"dataRevision": int(meta.get("dataRevision", 1)),
                     "schemaRevision": int(codebook.get("schemaRevision",
                                                        meta.get("schemaRevision", 1)))}

        raw_buffer = io.BytesIO()
        raw_df.write_csv(raw_buffer)
        current_buffer = io.BytesIO()
        current_df.write_parquet(current_buffer)
        session_state = {"datasetId": dataset_id, **revisions,
                         "scopeHash": None, "exportedAt": now_iso()}
        files = {
            "data/raw.csv": raw_buffer.getvalue(),
            "data/current.parquet": current_buffer.getvalue(),
            "metadata/codebook.json": json.dumps(codebook, ensure_ascii=False, indent=2).encode("utf-8"),
            "metadata/provenance.json": json.dumps(provenance, ensure_ascii=False,
                                                   indent=2).encode("utf-8"),
            "metadata/imputation-mask.json": json.dumps(mask, ensure_ascii=False,
                                                        indent=2).encode("utf-8"),
            "metadata/session-state.json": json.dumps(session_state, ensure_ascii=False,
                                                      indent=2).encode("utf-8"),
        }
        manifest_files = []
        for name, payload in files.items():
            digest = hashlib.sha256(payload).hexdigest()
            manifest_files.append({"path": name, "sha256": digest, "bytes": len(payload)})
        manifest = {"packageVersion": PACKAGE_VERSION, "datasetId": dataset_id,
                    "dataRevision": revisions["dataRevision"],
                    "schemaRevision": revisions["schemaRevision"],
                    "createdAt": now_iso(), "files": manifest_files}
        files["manifest.json"] = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
        if not files["data/current.parquet"]:
            raise BizError("PROVENANCE_EXPORT_FAILED", "現在値の出力に失敗しました。",
                           status_code=500)
        bundle = io.BytesIO()
        with zipfile.ZipFile(bundle, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, payload in files.items():
                archive.writestr(name, payload)
        return Response(content=bundle.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition":
                                 f"attachment; filename=\"{dataset_id}-package.zip\""})


@router.post("/datasets/import_package")
async def import_package(file: UploadFile = File(...)) -> dict:
    import io
    import zipfile

    raw = await _read_upload(file)
    try:
        archive = zipfile.ZipFile(io.BytesIO(raw))
        names = set(archive.namelist())
    except Exception as exc:
        raise BizError("PROVENANCE_PACKAGE_INVALID", "ZIPパッケージを開けません。",
                       status_code=422) from exc
    required = {"manifest.json", "data/raw.csv", "data/current.parquet",
                "metadata/codebook.json", "metadata/provenance.json",
                "metadata/imputation-mask.json", "metadata/session-state.json"}
    if not required.issubset(names):
        raise BizError("PROVENANCE_PACKAGE_INVALID",
                       f"必須ファイルが不足しています: {sorted(required - names)}",
                       status_code=422)
    try:
        manifest = json.loads(archive.read("manifest.json").decode("utf-8"))
    except Exception as exc:
        raise BizError("PROVENANCE_PACKAGE_INVALID", "manifest.json を読み込めません。",
                       status_code=422) from exc
    if manifest.get("packageVersion") != PACKAGE_VERSION:
        raise BizError("PROVENANCE_PACKAGE_VERSION",
                       f"未対応のpackageVersionです: {manifest.get('packageVersion')}",
                       status_code=422)
    for entry in manifest.get("files", []):
        try:
            payload = archive.read(entry["path"])
        except KeyError as exc:
            raise BizError("PROVENANCE_PACKAGE_INVALID",
                           f"ファイルが存在しません: {entry['path']}",
                           status_code=422) from exc
        if hashlib.sha256(payload).hexdigest() != entry.get("sha256"):
            raise BizError("PROVENANCE_PACKAGE_CHECKSUM",
                           f"checksum不一致: {entry['path']}", status_code=422)
    try:
        codebook = json.loads(archive.read("metadata/codebook.json").decode("utf-8"))
        provenance = json.loads(archive.read("metadata/provenance.json").decode("utf-8"))
        mask = json.loads(archive.read("metadata/imputation-mask.json").decode("utf-8"))
        session_state = json.loads(archive.read("metadata/session-state.json").decode("utf-8"))
        current_df = pl.read_parquet(io.BytesIO(archive.read("data/current.parquet")))
        raw_df = pl.read_csv(io.BytesIO(archive.read("data/raw.csv")))
    except Exception as exc:
        raise BizError("PROVENANCE_PACKAGE_INVALID", f"パッケージ内容を読み込めません: {exc}",
                       status_code=422) from exc
    if "__rowId__" not in current_df.columns or current_df["__rowId__"].n_unique() != current_df.height:
        raise BizError("PROVENANCE_PACKAGE_INVALID", "__rowId__ の一意性を確認できません。",
                       status_code=422)
    codebook_names = {c.get("name") for c in codebook.get("columns", []) if isinstance(c, dict)}
    frame_names = {c for c in current_df.columns if c != "__rowId__"}
    if codebook_names != frame_names:
        raise BizError("PROVENANCE_PACKAGE_INVALID",
                       f"codebookとデータ列が一致しません: {sorted(codebook_names ^ frame_names)[:10]}",
                       status_code=422)
    new_id_value = new_id("ds")
    with store.lock(new_id_value):
        meta = {
            "datasetId": new_id_value,
            "name": f"imported-{manifest.get('datasetId', 'package')}"[:80],
            "fingerprint": values_fingerprint(current_df),
            "format": "package",
            "rowCount": current_df.height,
            "columnCount": current_df.width - 1,
            "schema": [{"name": c} for c in current_df.columns if c != "__rowId__"],
            "schemaRevision": int(codebook.get("schemaRevision", 1)),
            "rowIdentity": "preserved",
            "rowIds": current_df["__rowId__"].to_list(),
            "createdAt": now_iso(),
            "importOptions": {"packageVersion": PACKAGE_VERSION},
        }
        step = _provenance_step("import", {"packageVersion": PACKAGE_VERSION,
                                           "sourceDatasetId": manifest.get("datasetId"),
                                           "sourceDataRevision": manifest.get("dataRevision")},
                                meta, codebook, "import-package-1")
        provenance_import = dict(provenance or {})
        provenance_import["datasetId"] = new_id_value
        provenance_import["operations"] = [
            *provenance_import.get("operations", []),
            {**step, "inputDataRevision": manifest.get("dataRevision", 1),
             "outputDataRevision": 1},
        ]
        provenance_import["currentOperationId"] = step["operationId"]
        mask_import = dict(mask or {})
        mask_import["datasetId"] = new_id_value
        commit = store.commit_data_change(new_id_value, meta, current_df, codebook=codebook,
                                           step=provenance_import["operations"][-1],
                                           mask_entries=list(mask_import.get("entries", [])))
        store._provenance_path(new_id_value).write_text(
            json.dumps(provenance_import, ensure_ascii=False, indent=2), encoding="utf-8")
        if store.read_raw(new_id_value).height != raw_df.height:
            store.delete(new_id_value)
            raise BizError("PROVENANCE_PACKAGE_INVALID", "raw snapshotの検証に失敗しました。",
                           status_code=422)
        if [str(v) for v in store.get_dataframe(new_id_value)["__rowId__"].to_list()] != [
                str(v) for v in current_df["__rowId__"].to_list()]:
            store.delete(new_id_value)
            raise BizError("PROVENANCE_PACKAGE_INVALID", "現在値の検証に失敗しました。",
                           status_code=422)
    return {"datasetId": new_id_value,
            "dataRevision": int(store.get_meta(new_id_value).get("dataRevision", 1)),
            "sessionState": session_state,
            "provenance": {"operationCount": len(provenance_import.get("operations", []))}}


@router.delete("/datasets/{dataset_id}")
def delete_dataset(dataset_id: str) -> dict:
    with store.lock(dataset_id):
        return _delete_dataset(dataset_id)


def _delete_dataset(dataset_id: str) -> dict:
    store.delete(dataset_id)
    return {"deleted": dataset_id}


def _serialize_dataframe_to_arrow_bytes(df: pl.DataFrame) -> bytes:
    table = df.to_arrow()
    sink = pa.BufferOutputStream()
    with ipc.new_stream(sink, table.schema) as writer:
        writer.write_table(table)
    return sink.getvalue().to_pybytes()


def dataframe_to_arrow_response(df: pl.DataFrame) -> Response:
    return Response(content=_serialize_dataframe_to_arrow_bytes(df), media_type="application/vnd.apache.arrow.stream")
