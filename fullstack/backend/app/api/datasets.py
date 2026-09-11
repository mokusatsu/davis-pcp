"""Dataset import, schema, and view APIs."""
from __future__ import annotations

import csv
import hashlib
import io
import json
from typing import TYPE_CHECKING, Any

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
from ..storage.dataset_store import (
    DatasetStore,
    assign_row_identity,
    dataset_fingerprint,
    values_fingerprint,
)
from ..domain.provenance import new_operation_id

if TYPE_CHECKING:
    from ..algorithms.imputation.plan import ImputationPlan

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


def _imputed_cells(df_before: pl.DataFrame, df_after: pl.DataFrame,
                   columns: list[str]) -> list[dict[str, Any]]:
    """Cells that were missing before the imputation and carry a value after it.

    Deliberately operation-independent: the in-place path turns these into mask
    entries attached to its own provenance step, while the derived-dataset path
    attaches the same cells to the new dataset's seed step (E05).
    """
    cells: list[dict[str, Any]] = []
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
            cells.append({"rowId": str(row_id), "columnId": column})
    return cells


def _mask_entries(cells: list[dict[str, Any]], strategy: str, operation_id: str,
                  input_revision: int, mask_revision: int) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for cell in cells:
        if not isinstance(cell, dict):
            continue
        entries.append({
            "rowId": str(cell.get("rowId")),
            "columnId": str(cell.get("columnId")),
            "methodId": strategy,
            "methodLabel": IMPUTE_METHOD_LABELS.get(strategy, strategy),
            "originalMissingReason": "user_missing",
            "createdByOperationId": operation_id,
            "inputDataRevision": input_revision,
            "maskRevision": mask_revision,
        })
    return entries


def _mask_entries_for_impute(df_before: pl.DataFrame, df_after: pl.DataFrame,
                              columns: list[str], strategy: str, operation_id: str,
                              input_revision: int, mask_revision: int) -> list[dict[str, Any]]:
    return _mask_entries(_imputed_cells(df_before, df_after, columns), strategy,
                         operation_id, input_revision, mask_revision)


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


def _sync_weight_config(
    existing_cb: dict[str, Any] | None,
    merged_cols: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Carry the weight configuration across a re-sync, dropping vanished columns.

    A column that was renamed or removed takes its weight role with it; silently
    keeping a dangling ``columnId`` would let analyses pick up a weight whose
    meaning nobody re-confirmed. The caller decides whether the change is worth
    a schema-revision bump.
    """
    existing_cb = existing_cb or {}
    known = {c.get("columnId") for c in merged_cols}

    def _survives(column_id: Any) -> bool:
        return isinstance(column_id, str) and column_id in known

    raw_config = existing_cb.get("weightConfig")
    weight_config: dict[str, Any] | None = None
    if isinstance(raw_config, dict) and _survives(raw_config.get("weightColumnId")):
        weight_config = dict(raw_config)

    raw_design = existing_cb.get("surveyDesign")
    survey_design: dict[str, Any] | None = None
    if isinstance(raw_design, dict):
        cleaned = dict(raw_design)
        for key in ("weightColumnId", "strataColumnId", "psuColumnId", "fpcColumnId"):
            if key in cleaned and not _survives(cleaned.get(key)):
                cleaned.pop(key, None)
        replicates = [cid for cid in (cleaned.get("replicateWeightColumnIds") or []) if _survives(cid)]
        if replicates:
            cleaned["replicateWeightColumnIds"] = replicates
        else:
            cleaned.pop("replicateWeightColumnIds", None)
        survey_design = cleaned or None

    return weight_config, survey_design


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

    raw_weight = (existing_cb or {}).get("weightConfig")
    raw_design = (existing_cb or {}).get("surveyDesign")
    weight_config, survey_design = _sync_weight_config(existing_cb, cb_payload.get("columns", []))
    if weight_config is not None:
        cb_payload["weightConfig"] = weight_config
    if survey_design is not None:
        cb_payload["surveyDesign"] = survey_design
    # Dropping a weight or design column changes what the codebook means, so the
    # revision must move even when no column itself was added or renamed.
    if cb_payload.get("weightConfig") != raw_weight or cb_payload.get("surveyDesign") != raw_design:
        current = cb_payload.get("schemaRevision", 1)
        if current == (existing_cb or {}).get("schemaRevision", 1):
            cb_payload["schemaRevision"] = current + 1

    return cb_payload


def _finalize_dataset(
    dataset_id: str,
    name: str,
    fmt: str,
    df: pl.DataFrame,
    options: ImportOptions | None,
    source_schema: list[dict] | None = None,
    source_dataset_id: str | None = None,
    derivation: dict[str, Any] | None = None,
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

    # Single source of truth; commit_data_change recomputes it the same way.
    fingerprint = dataset_fingerprint(
        schema_payload, schema_revision, df, fmt,
        options.model_dump(mode="json") if options else {},
    )
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
    if source_dataset_id:
        # A derived dataset must say where it came from, and what its "raw" means.
        meta["sourceDatasetId"] = source_dataset_id
    if derivation:
        meta["derivation"] = derivation.get("operation", "import")

    if derivation:
        # E05: the new dataset carries its *own* imputation step and mask
        # entries, plus whatever mask it inherited from the source.
        step_params = dict(derivation.get("params") or {})
        seed_step = _provenance_step(derivation.get("operation", "import"), step_params, meta, cb,
                                     f"{derivation.get('operation', 'import')}-1")
        source_provenance = store.load_provenance(source_dataset_id) if source_dataset_id else None
        seed_step["parentOperationId"] = (source_provenance or {}).get("currentOperationId")
        # Inherited entries keep their original attribution and gain the marker
        # that says where they came from; the cells this derivation filled are
        # new entries attributed to the seed step itself.
        inherited = [{**e, "inheritedFromDatasetId": source_dataset_id}
                     for e in (derivation.get("inheritedMaskEntries") or [])
                     if isinstance(e, dict)]
        step_params["inheritedMaskEntries"] = len(inherited)
        seed_step["params"] = step_params
        cells = [c for c in (derivation.get("imputedCells") or []) if isinstance(c, dict)]
        mask_entries = inherited + _mask_entries(
            cells, str(step_params.get("strategy", "")), seed_step["operationId"],
            int(meta.get("dataRevision", 1)), 1)
        commit = store.commit_data_change(dataset_id, meta, df, codebook=cb, step=seed_step,
                                          mask_entries=mask_entries, replace_mask=True)
    else:
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

    def _resolve_column_ref(value: Any, *, field: str) -> str | None:
        """Accept either a columnId or a unique column name; reject anything unknown."""
        if value in (None, ""):
            return None
        if not isinstance(value, str):
            raise BizError("CODEBOOK_INVALID", f"{field} must be a string", status_code=422)
        if value in by_id:
            return value
        matches = [c["columnId"] for c in cb["columns"] if c.get("name") == value]
        if len(matches) == 1:
            return matches[0]
        raise BizError("CODEBOOK_INVALID", f"{field} が列を特定できません: {value}", status_code=422)

    if update_req.explicitly_set("weightConfig"):
        if update_req.weightConfig is None:
            # Clearing the weight is a real choice: analyses fall back to the
            # unweighted path instead of silently keeping the old weight type.
            cb.pop("weightConfig", None)
        else:
            resolved = _resolve_column_ref(
                update_req.weightConfig.weightColumnId, field="weightConfig.weightColumnId")
            if resolved is None:
                raise BizError("CODEBOOK_INVALID", "weightConfig.weightColumnId は必須です。", status_code=422)
            cb["weightConfig"] = {
                "weightColumnId": resolved,
                "weightType": update_req.weightConfig.weightType.value,
            }

    if update_req.explicitly_set("surveyDesign"):
        if update_req.surveyDesign is None:
            cb.pop("surveyDesign", None)
        else:
            design = update_req.surveyDesign
            payload: dict[str, Any] = {
                "weightColumnId": _resolve_column_ref(design.weightColumnId, field="surveyDesign.weightColumnId"),
                "strataColumnId": _resolve_column_ref(design.strataColumnId, field="surveyDesign.strataColumnId"),
                "psuColumnId": _resolve_column_ref(design.psuColumnId, field="surveyDesign.psuColumnId"),
                "fpcColumnId": _resolve_column_ref(design.fpcColumnId, field="surveyDesign.fpcColumnId"),
            }
            replicate_ids: list[str] = []
            for raw in design.replicateWeightColumnIds:
                resolved = _resolve_column_ref(raw, field="surveyDesign.replicateWeightColumnIds")
                if resolved is not None:
                    replicate_ids.append(resolved)
            if design.weightColumnId is None:
                # The weight is implied by weightConfig; keeping both in step is
                # what stops the design from pointing at a different column.
                payload["weightColumnId"] = (cb.get("weightConfig") or {}).get("weightColumnId")
            if payload["weightColumnId"] is None:
                raise BizError("CODEBOOK_INVALID", "surveyDesign には weightColumnId が必要です。", status_code=422)
            config = cb.get("weightConfig")
            if config and config.get("weightColumnId") != payload["weightColumnId"]:
                raise BizError(
                    "CODEBOOK_INVALID",
                    "surveyDesign.weightColumnId が weightConfig と一致しません。",
                    status_code=422,
                )
            if len(set(replicate_ids)) != len(replicate_ids):
                raise BizError("CODEBOOK_INVALID", "replicateWeightColumnIds が重複しています。", status_code=422)
            if replicate_ids:
                payload["replicateWeightColumnIds"] = replicate_ids
            same_as_weight = {
                key: payload[key] for key in ("strataColumnId", "psuColumnId", "fpcColumnId") if payload.get(key)
            }
            if payload["weightColumnId"] in same_as_weight.values():
                raise BizError(
                    "CODEBOOK_INVALID",
                    "ウェイト列を strata / PSU / fpc に同時指定できません。",
                    status_code=422,
                )
            cb["surveyDesign"] = payload

    new_rev = int(cb.get("schemaRevision", 1)) + 1
    cb["schemaRevision"] = new_rev
    # Sync schemaRevision to meta & update fingerprint
    meta["schemaRevision"] = new_rev
    # The codebook update path does not commit values, so the fingerprint is
    # recomputed here — with the same helper every other write path uses.
    meta["fingerprint"] = dataset_fingerprint(
        meta.get("schema", []), new_rev, store.get_dataframe(dataset_id),
        meta.get("format", "csv"), meta.get("importOptions", {}),
    )
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
    # commit_data_change recomputes the fingerprint from the same inputs.
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

    # Invalidate cached fingerprint (commit_data_change recomputes it too)
    meta["fingerprint"] = dataset_fingerprint(
        schema_payload, schema_revision, df, meta.get("format", "csv"),
        meta.get("importOptions", {}),
    )
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


def _impute_step_params(plan: ImputationPlan, in_place: bool) -> dict[str, Any]:
    """What the provenance step records about an imputation.

    The plan is the record: targets, predictors, the columns the plan refused,
    and the hash that ties the applied result to the previewed one.
    """
    return {
        "columns": plan.targetColumns,
        "predictorColumns": plan.predictorColumns,
        "excludedColumns": [e.model_dump() for e in plan.excludedColumns],
        "strategy": plan.strategy,
        "options": plan.options,
        "inPlace": in_place,
        "planHash": plan.planHash,
    }


def _plan_response(plan: ImputationPlan) -> dict[str, Any]:
    return {
        "planHash": plan.planHash,
        "targetColumns": plan.targetColumns,
        "predictorColumns": plan.predictorColumns,
        "excludedColumns": [e.model_dump() for e in plan.excludedColumns],
    }


class ImputationPlanRequest(BaseModel):
    columns: list[str] | None = None
    predictorColumns: list[str] | None = None
    strategy: str = "tabdiff"
    options: dict[str, Any] | None = None


class ImputePreviewRequest(ImputationPlanRequest):
    # Legacy single-column clients (and the unit tests) still send ``column``.
    column: str | None = None


class ImputeRequest(ImputationPlanRequest):
    inPlace: bool = True
    # Set by the preview; when present the apply refuses to run against
    # anything other than the exact state that was previewed.
    planHash: str | None = None


def _build_impute_plan(dataset_id: str, meta: dict[str, Any], df: pl.DataFrame,
                       request: ImputationPlanRequest) -> ImputationPlan:
    from ..algorithms.imputation.plan import build_imputation_plan

    columns = request.columns
    if columns is None and getattr(request, "column", None):
        columns = [request.column]
    if columns is None:
        columns = [c for c in df.columns if c != "__rowId__"]
    return build_imputation_plan(
        df,
        store.load_codebook(dataset_id),
        target_columns=columns,
        predictor_columns=request.predictorColumns,
        strategy=request.strategy,
        options=request.options,
        dataset_id=dataset_id,
        data_revision=int(meta.get("dataRevision", 1)),
    )


@router.post("/datasets/{dataset_id}/impute/preview")
def preview_dataset_imputation(dataset_id: str, request: ImputePreviewRequest) -> dict:
    from ..algorithms.imputation.core import preview_imputation_plan

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        df = store.get_dataframe(dataset_id)
        plan = _build_impute_plan(dataset_id, meta, df, request)
        return preview_imputation_plan(df, plan)


@router.post("/datasets/{dataset_id}/impute")
def impute_dataset(dataset_id: str, request: ImputeRequest) -> dict:
    with store.lock(dataset_id):
        return _impute_dataset(dataset_id, request)


def _impute_dataset(dataset_id: str, request: ImputeRequest) -> dict:
    from ..algorithms.imputation.core import column_values_hash, impute_dataframe

    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)

    # Same plan the preview built — same targets, same predictors, same seed —
    # so the applied values match the previewed ones.
    plan = _build_impute_plan(dataset_id, meta, df, request)
    if request.planHash is not None and request.planHash != plan.planHash:
        raise BizError(
            "IMPUTATION_PLAN_STALE",
            "プレビュー後にデータまたは設定が変わりました。もう一度プレビューしてください。",
            status_code=422,
            details={"expected": request.planHash, "actual": plan.planHash},
        )

    imputed_df, diagnostics = impute_dataframe(
        df,
        columns=plan.targetColumns,
        strategy=plan.strategy,
        options=plan.options,
        predictors=plan.predictorColumns,
        plan_hash=plan.planHash,
    )
    # Lets a client confirm the applied values are the previewed ones.
    output_hashes = {c: column_values_hash(imputed_df[c])
                     for c in plan.targetColumns if c in imputed_df.columns}

    if request.inPlace:
        schema_payload = _derive_dataset_schema(imputed_df, meta.get("schema", []))
        cb = _sync_codebook(dataset_id, imputed_df, source_schema=meta.get("schema", []))
        schema_revision = cb.get("schemaRevision", 1)
        meta["fingerprint"] = dataset_fingerprint(
            schema_payload, schema_revision, imputed_df, meta.get("format", "csv"),
            meta.get("importOptions", {}),
        )
        meta["schema"] = schema_payload
        meta["columnCount"] = imputed_df.width - 1
        meta["revision"] = meta.get("revision", 1) + 1
        meta["schemaRevision"] = schema_revision

        input_revision = int(store.get_meta(dataset_id).get("dataRevision", 1))
        provenance_before = store.load_provenance(dataset_id)
        mask_before = store.load_mask(dataset_id) or {"maskRevision": 0}
        step = _provenance_step("impute", _impute_step_params(plan, in_place=True), meta, cb,
                                f"impute-{plan.strategy}-1",
                                parent_operation_id=(provenance_before or {}).get("currentOperationId"))
        mask_entries = _mask_entries_for_impute(
            df, imputed_df, plan.targetColumns,
            plan.strategy, step["operationId"], input_revision,
            int(mask_before.get("maskRevision", 0)) + 1)
        commit = store.commit_data_change(dataset_id, meta, imputed_df, codebook=cb, step=step,
                                           mask_entries=mask_entries)
        meta.pop("rowIds", None)
        provenance = commit["provenance"]
        return {
            **meta,
            **_plan_response(plan),
            "outputHashes": output_hashes,
            "diagnostics": diagnostics,
            "provenance": {"currentOperationId": provenance["currentOperationId"],
                           "rawDataRevision": provenance.get("rawDataRevision"),
                           "operationCount": len(provenance.get("operations", []))},
            "maskRevision": commit["mask"]["maskRevision"],
        }
    else:
        new_dataset_id = new_id("ds")
        new_name = f"{meta['name']}_imputed"
        source_provenance = store.load_provenance(dataset_id) or {}
        source_mask = store.load_mask(dataset_id) or {"entries": []}
        new_meta = _finalize_dataset(
            new_dataset_id,
            new_name,
            meta.get("format", "csv"),
            imputed_df,
            None,
            source_schema=meta.get("schema", []),
            source_dataset_id=dataset_id,
            derivation={
                "operation": "impute",
                "params": {
                    **_impute_step_params(plan, in_place=False),
                    "sourceDatasetId": dataset_id,
                    "sourceOperationId": source_provenance.get("currentOperationId"),
                    "sourceDataRevision": int(meta.get("dataRevision", 1)),
                    # The derived dataset's raw.parquet is the already-imputed
                    # frame; the source dataset is the way back to the original.
                    "rawSemantics": "derived_creation",
                },
                "imputedCells": _imputed_cells(df, imputed_df, plan.targetColumns),
                "inheritedMaskEntries": list(source_mask.get("entries", [])),
            },
        )
        return {
            **new_meta,
            **_plan_response(plan),
            "outputHashes": output_hashes,
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

    meta["fingerprint"] = dataset_fingerprint(
        schema_payload, schema_revision, updated_df, meta.get("format", "csv"),
        meta.get("importOptions", {}),
    )
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
        history = _history_flags(provenance)
        head_revision = int(meta.get("dataRevision", 1))
        summary = [
            {"operationId": o.get("operationId"), "operation": o.get("operation"),
             "parentOperationId": o.get("parentOperationId"),
             "outputDataRevision": o.get("outputDataRevision"),
             "timestamp": o.get("timestamp"), "algorithmVersion": o.get("algorithmVersion"),
             "onCursorPath": _is_on_cursor_path(provenance, o.get("operationId")),
             # Undone steps stay in the log but no longer describe the data.
             "inEffect": _is_on_cursor_path(provenance, o.get("operationId"))
                         or int(o.get("outputDataRevision", -1)) == head_revision}
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
            **history,
        }


def _find_operation(provenance: dict[str, Any], operation_id: str | None
                    ) -> dict[str, Any] | None:
    if not operation_id:
        return None
    return next((o for o in provenance.get("operations", [])
                 if o.get("operationId") == operation_id), None)


def _cursor_of(provenance: dict[str, Any]) -> str | None:
    """Current position in the history.

    Pre-cursor provenance documents only have ``currentOperationId``; treat it
    as the cursor so old datasets keep working without a migration step.
    """
    return provenance.get("cursorOperationId") or provenance.get("currentOperationId")


def _redo_stack_of(provenance: dict[str, Any]) -> list[str]:
    operations = provenance.get("operations", [])
    known = {o.get("operationId") for o in operations}
    return [op_id for op_id in (provenance.get("redoStack") or []) if op_id in known]


def _is_on_cursor_path(provenance: dict[str, Any], operation_id: str | None) -> bool:
    """Whether an operation is an ancestor of (or equal to) the cursor.

    Used by the history panel to grey out operations that were undone. The
    cursor chain follows ``parentOperationId``; restore steps are appended to
    the log but never sit on the chain.
    """
    if not operation_id:
        return False
    operations = provenance.get("operations", [])
    by_id = {o.get("operationId"): o for o in operations}
    node = by_id.get(_cursor_of(provenance))
    seen: set[str] = set()
    while node is not None:
        current_id = node.get("operationId")
        if current_id in seen:
            return False
        if current_id == operation_id:
            return True
        seen.add(current_id)
        node = by_id.get(node.get("parentOperationId"))
    return False


def _history_flags(provenance: dict[str, Any]) -> dict[str, Any]:
    cursor = _cursor_of(provenance)
    current = _find_operation(provenance, cursor)
    can_undo = bool(current is not None and _find_operation(
        provenance, current.get("parentOperationId")) is not None)
    stack = _redo_stack_of(provenance)
    return {
        "cursorOperationId": cursor,
        "previousOperationId": (current or {}).get("parentOperationId"),
        "canUndo": can_undo,
        "canRedo": bool(stack),
        "redoStack": stack,
    }


def _restore_revision(dataset_id: str, target_revision: int, operation: str,
                      params: dict[str, Any], expected_data: int | None,
                      expected_schema: int | None,
                      target_operation_id: str | None = None,
                      redo_stack: list[str] | None = None) -> dict:
    """Restore values **and** the state that belongs to a revision.

    Values alone are not a revision: the schema, codebook and imputation mask
    of that moment are restored together, the fingerprint is recomputed and
    the navigation cursor is left on the target operation — so a second undo
    keeps walking back instead of re-applying the same step.
    """
    from ..domain.context import check_revisions, collect_revisions

    meta = store.get_meta(dataset_id)
    codebook = store.load_codebook(dataset_id) or {}
    revisions = collect_revisions(meta, codebook)
    check_revisions(revisions, expected_schema, expected_data)
    provenance = store.load_provenance(dataset_id) or {"operations": []}
    operations = provenance.get("operations", [])
    if not any(int(o.get("outputDataRevision", -1)) == int(target_revision) for o in operations):
        raise BizError("PROVENANCE_TARGET_MISSING",
                       f"revision {int(target_revision)} の履歴が存在しません。",
                       status_code=422)
    target_op = _find_operation(provenance, target_operation_id)
    if target_operation_id and target_op is None:
        raise BizError("PROVENANCE_TARGET_MISSING", "指定された操作が履歴に存在しません。",
                       status_code=422)
    if target_op is None:
        target_op = next((o for o in reversed(operations)
                          if int(o.get("outputDataRevision", -1)) == int(target_revision)), None)
    cursor_after = (target_op or {}).get("operationId") or _cursor_of(provenance)
    cursor_before = _cursor_of(provenance)

    snapshot = store.read_snapshot(dataset_id, int(target_revision))
    state = store.read_revision_state(dataset_id, int(target_revision))
    restored_codebook = store.read_revision_codebook(dataset_id, int(target_revision))
    restored_mask_doc = store.read_revision_mask(dataset_id, int(target_revision))
    warnings: list[str] = []

    raw_revision = provenance.get("rawDataRevision")
    if operation == "revert" and raw_revision is not None and int(target_revision) == int(raw_revision):
        restored_mask: list[dict[str, Any]] = []
    elif state is None or restored_mask_doc is None:
        # Revision written before state sidecars existed: approximate the mask
        # by keeping the entries that existed then and still fit the columns.
        warnings.append("REVISION_STATE_BACKFILLED")
        restored_mask = [e for e in (store.load_mask(dataset_id) or {}).get("entries", [])
                         if e.get("columnId") in snapshot.columns
                         and int(e.get("inputDataRevision") or 0) < int(target_revision)]
        warnings.append("MASK_RESTORE_APPROXIMATED")
    else:
        restored_mask = list(restored_mask_doc.get("entries", []))

    if state is None:
        schema_payload = _derive_dataset_schema(snapshot, meta.get("schema", []))
        if restored_codebook is None:
            restored_codebook = _sync_codebook(dataset_id, snapshot,
                                               source_schema=meta.get("schema", []))
        restored_schema_revision = int((restored_codebook or {}).get(
            "schemaRevision", meta.get("schemaRevision", 1)))
    else:
        schema_payload = state.get("schema") or _derive_dataset_schema(snapshot,
                                                                       meta.get("schema", []))
        restored_schema_revision = int(state.get("schemaRevision",
                                                 meta.get("schemaRevision", 1)))
        if restored_codebook is None:
            warnings.append("REVISION_CODEBOOK_BACKFILLED")
            restored_codebook = _sync_codebook(dataset_id, snapshot,
                                               source_schema=meta.get("schema", []))

    restored_meta = {**meta,
                     "schema": schema_payload,
                     "schemaRevision": restored_schema_revision,
                     "rowCount": snapshot.height,
                     "columnCount": max(snapshot.width - 1, 0)}
    step = _provenance_step(operation, params, restored_meta, restored_codebook,
                            f"{operation}-1", parent_operation_id=cursor_before)
    commit = store.commit_data_change(
        dataset_id, restored_meta, snapshot, codebook=restored_codebook, step=step,
        mask_entries=restored_mask, replace_mask=True,
        history_mode="navigate", cursor_operation_id=cursor_after,
        redo_stack=redo_stack, bump_mask_revision=True)
    fresh_meta = store.get_meta(dataset_id)
    fresh_codebook = store.load_codebook(dataset_id) or {}
    expected_fingerprint = (state or {}).get("fingerprint")
    if expected_fingerprint and expected_fingerprint != commit["fingerprint"]:
        warnings.append("REVISION_FINGERPRINT_DIVERGED")
    return {
        "datasetId": dataset_id,
        "currentDataRevision": int(fresh_meta.get("dataRevision", 1)),
        "currentOperationId": commit["provenance"]["currentOperationId"],
        "cursorOperationId": commit["provenance"].get("cursorOperationId"),
        "maskRevision": int(commit["mask"]["maskRevision"]),
        "schemaRevision": int(fresh_codebook.get("schemaRevision",
                                                 fresh_meta.get("schemaRevision", 1))),
        "restoredSchemaRevision": restored_schema_revision,
        "targetDataRevision": int(target_revision),
        "targetOperationId": cursor_after,
        "restoreWarnings": warnings,
        "maskEntryCount": len(restored_mask),
        **_history_flags(commit["provenance"]),
    }


def _child_operations(provenance: dict[str, Any], operation_id: str | None) -> list[dict[str, Any]]:
    return [o for o in provenance.get("operations", [])
            if o.get("parentOperationId") == operation_id]


@router.post("/datasets/{dataset_id}/revert")
def revert_dataset(dataset_id: str, request: RevertRequest) -> dict:
    """Jump to any recorded operation. The redo stack is cleared by design."""
    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        provenance = store.load_provenance(dataset_id) or {"operations": []}
        operations = provenance.get("operations", [])
        target_revision: int | None = request.targetDataRevision
        target_op: dict[str, Any] | None = None
        if request.targetOperationId:
            target_op = _find_operation(provenance, request.targetOperationId)
            if target_op is None:
                raise BizError("PROVENANCE_TARGET_MISSING", "指定された操作が履歴に存在しません。",
                               status_code=422)
            target_revision = int(target_op["outputDataRevision"])
        if target_revision is None:
            raise BizError("PROVENANCE_TARGET_MISSING",
                           "targetOperationId か targetDataRevision のいずれかを指定してください。",
                           status_code=422)
        if target_op is None:
            target_op = next((o for o in reversed(operations)
                              if int(o.get("outputDataRevision", -1)) == int(target_revision)), None)
        return _restore_revision(
            dataset_id, int(target_revision), "revert",
            {"targetOperationId": request.targetOperationId,
             "targetDataRevision": int(target_revision)},
            request.expectedDataRevision, request.expectedSchemaRevision,
            target_operation_id=(target_op or {}).get("operationId"),
            redo_stack=[])


@router.post("/datasets/{dataset_id}/undo")
def undo_dataset(dataset_id: str, request: UndoRedoRequest) -> dict:
    """Step the cursor back to the parent of the current operation.

    The undo itself is appended to the audit log, but the cursor moves to the
    parent — so calling undo again keeps walking back instead of landing on the
    operation that was just undone.
    """
    with store.lock(dataset_id):
        provenance = store.load_provenance(dataset_id) or {"operations": []}
        cursor_id = _cursor_of(provenance)
        current = _find_operation(provenance, cursor_id)
        if current is None or current.get("parentOperationId") is None:
            raise BizError("PROVENANCE_NOTHING_TO_UNDO", "取り消せる操作がありません。",
                           status_code=409)
        parent = _find_operation(provenance, current["parentOperationId"])
        if parent is None:
            raise BizError("PROVENANCE_TARGET_MISSING", "親操作の履歴が存在しません。",
                           status_code=422)
        redo_stack = ([cursor_id] if cursor_id else []) + _redo_stack_of(provenance)
        return _restore_revision(
            dataset_id, int(parent["outputDataRevision"]), "undo",
            {"undoneOperationId": cursor_id},
            request.expectedDataRevision, request.expectedSchemaRevision,
            target_operation_id=parent.get("operationId"),
            redo_stack=redo_stack)


@router.post("/datasets/{dataset_id}/redo")
def redo_dataset(dataset_id: str, request: UndoRedoRequest) -> dict:
    """Re-apply the most recently undone operation (redoStack is newest-first)."""
    with store.lock(dataset_id):
        provenance = store.load_provenance(dataset_id) or {"operations": []}
        stack = _redo_stack_of(provenance)
        if not stack:
            raise BizError("PROVENANCE_NOTHING_TO_REDO", "やり直せる操作がありません。",
                           status_code=409)
        target_id = stack[0]
        target = _find_operation(provenance, target_id)
        if target is None:
            raise BizError("PROVENANCE_TARGET_MISSING", "やり直し先の操作が履歴に存在しません。",
                           status_code=422)
        return _restore_revision(
            dataset_id, int(target["outputDataRevision"]), "redo",
            {"redoneOperationId": target_id},
            request.expectedDataRevision, request.expectedSchemaRevision,
            target_operation_id=target_id,
            redo_stack=stack[1:])


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
