"""Canonical dataset storage: Parquet files + deterministic fingerprints.

Row identity priority:
1. user-specified unique ID column
2. probe-confirmed unique column
3. immutable generated ID stored once in the canonical dataset
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from threading import RLock
from pathlib import Path
from typing import Any

import polars as pl

from ..config import settings
from ..domain.errors import BizError

_dataset_locks: dict[tuple[str, str], RLock] = {}
_locks_guard = RLock()


def _arrow_temporal_copy_types(arrow_type: Any, dtype: Any) -> tuple[Any, Any]:
    """Normalize temporal units, then expose exact integers inside containers."""
    import pyarrow as pa

    if pa.types.is_timestamp(arrow_type):
        return pa.timestamp(dtype.time_unit, tz=arrow_type.tz), pa.int64()
    if pa.types.is_duration(arrow_type):
        return pa.duration(dtype.time_unit), pa.int64()
    if pa.types.is_time(arrow_type):
        return pa.time64("ns"), pa.int64()
    if pa.types.is_date32(arrow_type):
        return arrow_type, pa.int32()
    if pa.types.is_date64(arrow_type):
        return arrow_type, pa.int64()
    if (pa.types.is_list(arrow_type) or pa.types.is_large_list(arrow_type)
            or pa.types.is_fixed_size_list(arrow_type)):
        normalized, physical = _arrow_temporal_copy_types(arrow_type.value_type, dtype.inner)
        field = arrow_type.value_field

        def container(value_type):
            value_field = pa.field(field.name, value_type, nullable=field.nullable, metadata=field.metadata)
            if pa.types.is_fixed_size_list(arrow_type):
                return pa.list_(value_field, arrow_type.list_size)
            return pa.large_list(value_field) if pa.types.is_large_list(arrow_type) else pa.list_(value_field)

        return container(normalized), container(physical)
    if pa.types.is_struct(arrow_type):
        fields = {field.name: field.dtype for field in dtype.fields}
        children = [_arrow_temporal_copy_types(field.type, fields[field.name]) for field in arrow_type]
        return tuple(pa.struct([
            pa.field(field.name, types[index], nullable=field.nullable, metadata=field.metadata)
            for field, types in zip(arrow_type, children)
        ]) for index in (0, 1))
    return arrow_type, arrow_type


def canonical_fingerprint(schema_json: str, row_ids: list[str], values_hash: str, options_json: str) -> str:
    digest = hashlib.sha256()
    digest.update(schema_json.encode("utf-8"))
    digest.update(json.dumps(row_ids).encode("utf-8"))
    digest.update(values_hash.encode("utf-8"))
    digest.update(options_json.encode("utf-8"))
    return digest.hexdigest()


def values_fingerprint(df: pl.DataFrame) -> str:
    # Deterministic per-column hashing; avoids float formatting instability by using raw bytes.
    digest = hashlib.sha256()
    for name in df.columns:
        series = df[name]
        digest.update(name.encode("utf-8"))
        for value in series.to_list():
            if value is None:
                digest.update(b"\x00NULL")
            elif isinstance(value, float):
                digest.update(b"F")
                digest.update(value.hex().encode("ascii"))
            elif isinstance(value, int):
                digest.update(b"I")
                digest.update(str(value).encode("ascii"))
            else:
                digest.update(b"S")
                digest.update(str(value).encode("utf-8"))
    return digest.hexdigest()


def dataset_fingerprint(
    schema_payload: list[dict[str, Any]] | None,
    schema_revision: int,
    df: pl.DataFrame,
    fmt: str = "",
    options: dict[str, Any] | None = None,
) -> str:
    """Single source of truth for the dataset fingerprint (schema identity + values).

    Every write path (import, impute, calculate, column delete, revision restore)
    must go through this helper so that a restored revision cannot keep the
    fingerprint of the revision that was undone.
    """
    material = {
        "schema": schema_payload or [],
        "options": options or {},
        "format": fmt,
        "schemaRevision": int(schema_revision),
    }
    seed = values_fingerprint(df)
    return hashlib.sha256(
        json.dumps(material, sort_keys=True, ensure_ascii=False).encode("utf-8") + seed.encode()
    ).hexdigest()


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


class DatasetStore:
    def __init__(self, workspace: Path | None = None) -> None:
        self.root = (workspace or settings.workspace_dir) / "datasets"
        self.root.mkdir(parents=True, exist_ok=True)

    def _meta_path(self, dataset_id: str) -> Path:
        return self.root / f"{dataset_id}.json"

    def _parquet_path(self, dataset_id: str) -> Path:
        return self.root / f"{dataset_id}.parquet"

    def lock(self, dataset_id: str):
        key = (str(self.root.resolve()), dataset_id)
        with _locks_guard:
            return _dataset_locks.setdefault(key, RLock())

    def save(self, dataset_id: str, meta: dict[str, Any], df: pl.DataFrame,
             codebook: dict[str, Any] | None = None) -> None:
        with self.lock(dataset_id):
            previous = self.get_meta(dataset_id) if self._meta_path(dataset_id).exists() else None
            updated = {**meta, "dataRevision": int(previous.get("dataRevision", 1)) + 1 if previous else int(meta.get("dataRevision", 1)),
                       "valuesFingerprint": values_fingerprint(df)}
            self._save_data(dataset_id, updated, df, codebook)
            meta.update(updated)

    def _publish_files(self, payloads: list[tuple[Path, bytes]]) -> None:
        # Backups stay on disk so a large previous Parquet is not duplicated in RAM.
        backups: dict[Path, Path | None] = {}
        written: list[Path] = []
        recovery_failed = False
        try:
            for path, _ in payloads:
                if path.is_dir():
                    backups[path] = None
                    continue
                if path.exists():
                    fd, name = tempfile.mkstemp(dir=str(path.parent), suffix=".bak")
                    os.close(fd)
                    backups[path] = Path(name)
                    shutil.copyfile(path, name)
                else:
                    backups[path] = None
            try:
                for path, payload in payloads:
                    written.append(path)
                    atomic_write_bytes(path, payload)
            except Exception:
                try:
                    for path in reversed(written):
                        backup = backups[path]
                        if backup is None:
                            path.unlink(missing_ok=True)
                        else:
                            os.replace(backup, path)
                except Exception:
                    recovery_failed = True
                    raise
                raise
        finally:
            for backup in backups.values():
                if backup is not None and not recovery_failed:
                    backup.unlink(missing_ok=True)

    def _save_data(self, dataset_id: str, meta: dict[str, Any], df: pl.DataFrame,
                   codebook: dict[str, Any] | None = None) -> None:
        import io
        buffer = io.BytesIO()
        try:
            df.write_parquet(buffer)
        except Exception:
            import pyarrow as pa
            import pyarrow.parquet as pq
            table = pa.Table.from_pydict(df.to_dict(as_series=False))
            pq.write_table(table, buffer)
        payloads = [(self._parquet_path(dataset_id), buffer.getvalue())]
        if codebook is not None:
            payloads.append((self._codebook_path(dataset_id), json.dumps(codebook, ensure_ascii=False, indent=2).encode("utf-8")))
        payloads.append((self._meta_path(dataset_id), json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")))
        self._publish_files(payloads)

    def save_metadata(self, dataset_id: str, meta: dict[str, Any], codebook: dict[str, Any]) -> None:
        """Publish dictionary and metadata together under the dataset operation lock.

        A codebook-only edit (labels, category order, missing codes) does not
        create a new data revision, so the sidecar of the *current* revision is
        refreshed too: "the codebook of revision N" means the codebook in force
        while revision N was the head. Undo then restores the labels that were
        in use at that revision instead of dropping them.
        """
        with self.lock(dataset_id):
            payloads: list[tuple[Path, bytes]] = [
                (self._codebook_path(dataset_id),
                 json.dumps(codebook, ensure_ascii=False, indent=2).encode("utf-8")),
                (self._meta_path(dataset_id),
                 json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")),
            ]
            revision = int(meta.get("dataRevision", 1))
            previous = self.read_revision_state(dataset_id, revision) or {}
            state_doc = {
                "datasetId": dataset_id,
                "dataRevision": revision,
                "schema": meta.get("schema", []),
                "schemaRevision": int((codebook or {}).get(
                    "schemaRevision", meta.get("schemaRevision", 1))),
                "rowCount": previous.get("rowCount", meta.get("rowCount")),
                "columnCount": previous.get("columnCount", meta.get("columnCount")),
                "rowIdentity": previous.get("rowIdentity", meta.get("rowIdentity")),
                "format": meta.get("format"),
                "importOptions": meta.get("importOptions"),
                "sourceDatasetId": meta.get("sourceDatasetId"),
                "fingerprint": meta.get("fingerprint"),
                "valuesFingerprint": meta.get("valuesFingerprint"),
            }
            payloads.append((self._revision_state_path(dataset_id, revision),
                             json.dumps(state_doc, ensure_ascii=False, indent=2).encode("utf-8")))
            payloads.append((self._revision_codebook_path(dataset_id, revision),
                             json.dumps(codebook, ensure_ascii=False, indent=2).encode("utf-8")))
            self._publish_files(payloads)

    def get_meta(self, dataset_id: str) -> dict[str, Any]:
        path = self._meta_path(dataset_id)
        if not path.exists():
            raise BizError("DATASET_NOT_FOUND", f"データセット {dataset_id} が見つかりません。", status_code=404,
                           suggested_actions=["データセット一覧を確認してください"])
        with self.lock(dataset_id):
            meta = json.loads(path.read_text(encoding="utf-8"))
            if "dataRevision" not in meta:
                meta["dataRevision"] = 1
                atomic_write_bytes(path, json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8"))
            return meta

    def get_dataframe(self, dataset_id: str, columns: list[str] | None = None) -> pl.DataFrame:
        with self.lock(dataset_id):
            return self._read_dataframe(dataset_id, columns)

    def _read_dataframe(self, dataset_id: str, columns: list[str] | None) -> pl.DataFrame:
        path = self._parquet_path(dataset_id)
        if not path.exists():
            raise BizError("DATASET_NOT_FOUND", f"データセット {dataset_id} の本体が見つかりません。",
                           status_code=404)
        return self._read_parquet(path, columns)

    @staticmethod
    def _read_parquet(path: Path, columns: list[str] | None = None) -> pl.DataFrame:
        """Read every data generation through the same native/WASM bridge."""
        try:
            return pl.read_parquet(path, columns=columns)
        except Exception:
            import pyarrow as pa
            import pyarrow.parquet as pq
            table = pq.read_table(path, columns=columns)
            if columns == []:
                # Polars' native empty projection is (0, 0), independent of
                # Arrow's ability to retain a row count without columns.
                return pl.DataFrame()
            # Keep dtype metadata, but let Polars own the returned values.
            # Imported Arrow string buffers can panic when re-exported by
            # the shipped WASM Polars build. A zero-row import obtains only
            # the schema; explicit construction also preserves null dtypes.
            schema = pl.from_arrow(table.slice(0, 0)).schema
            owned = []
            for field, column in zip(table.schema, table.columns):
                dtype = schema[field.name]
                normalized, physical = _arrow_temporal_copy_types(field.type, dtype)
                # Python datetime/timedelta lose nanoseconds and cannot
                # represent all Arrow dates, including inside lists/structs.
                if normalized != physical:
                    copied = column.cast(normalized).cast(physical)
                    physical_dtype = pl.from_arrow(pa.table({field.name: copied.slice(0, 0)})).schema[field.name]
                    series = pl.Series(field.name, copied.to_pylist(), dtype=physical_dtype, strict=True).cast(dtype, strict=True)
                else:
                    series = pl.Series(field.name, column.to_pylist(), dtype=dtype, strict=True)
                owned.append(series)
            return pl.DataFrame(owned)

    def list_datasets(self) -> list[dict[str, Any]]:
        result = []
        for path in sorted(self.root.glob("*.json")):
            if path.stem.endswith(".groups"):
                continue
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
                result.append({
                    "datasetId": meta["datasetId"],
                    "name": meta["name"],
                    "rowCount": meta["rowCount"],
                    "columnCount": meta["columnCount"],
                    "fingerprint": meta["fingerprint"],
                    "createdAt": meta["createdAt"],
                })
            except (json.JSONDecodeError, KeyError):
                continue
        return result

    def _codebook_path(self, dataset_id: str) -> Path:
        return self.root / f"{dataset_id}.codebook.json"

    # --- Feature 25: provenance sidecars ---------------------------------
    def _provenance_path(self, dataset_id: str) -> Path:
        return self.root / f"{dataset_id}.provenance.json"

    def _mask_path(self, dataset_id: str) -> Path:
        return self.root / f"{dataset_id}.imputation-mask.json"

    def _raw_path(self, dataset_id: str) -> Path:
        return self.root / f"{dataset_id}.raw.parquet"

    def _snapshot_dir(self, dataset_id: str) -> Path:
        return self.root / f"{dataset_id}.revisions"

    def _snapshot_path(self, dataset_id: str, data_revision: int) -> Path:
        return self._snapshot_dir(dataset_id) / f"{int(data_revision)}.parquet"

    # Feature 25 / HIST: per-revision state sidecars (schema, codebook, mask).
    def _revision_state_path(self, dataset_id: str, data_revision: int) -> Path:
        return self._snapshot_dir(dataset_id) / f"{int(data_revision)}.state.json"

    def _revision_codebook_path(self, dataset_id: str, data_revision: int) -> Path:
        return self._snapshot_dir(dataset_id) / f"{int(data_revision)}.codebook.json"

    def _revision_mask_path(self, dataset_id: str, data_revision: int) -> Path:
        return self._snapshot_dir(dataset_id) / f"{int(data_revision)}.mask.json"

    def _read_json_sidecar(self, path: Path) -> dict[str, Any] | None:
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        return payload if isinstance(payload, dict) else None

    def read_revision_state(self, dataset_id: str, data_revision: int) -> dict[str, Any] | None:
        with self.lock(dataset_id):
            return self._read_json_sidecar(self._revision_state_path(dataset_id, data_revision))

    def read_revision_codebook(self, dataset_id: str, data_revision: int) -> dict[str, Any] | None:
        with self.lock(dataset_id):
            return self._read_json_sidecar(self._revision_codebook_path(dataset_id, data_revision))

    def read_revision_mask(self, dataset_id: str, data_revision: int) -> dict[str, Any] | None:
        with self.lock(dataset_id):
            return self._read_json_sidecar(self._revision_mask_path(dataset_id, data_revision))

    def list_snapshots(self, dataset_id: str) -> list[int]:
        directory = self._snapshot_dir(dataset_id)
        if not directory.exists():
            return []
        revisions: list[int] = []
        for path in directory.glob("*.parquet"):
            try:
                revisions.append(int(path.stem))
            except ValueError:
                continue
        return sorted(revisions)

    def write_revision_state(self, dataset_id: str, data_revision: int,
                             state: dict[str, Any], codebook: dict[str, Any] | None = None,
                             mask: dict[str, Any] | None = None) -> None:
        """Backfill helper for revisions that predate the state sidecars."""
        payloads: list[tuple[Path, bytes]] = [
            (self._revision_state_path(dataset_id, data_revision),
             json.dumps(state, ensure_ascii=False, indent=2).encode("utf-8")),
        ]
        if codebook is not None:
            payloads.append((self._revision_codebook_path(dataset_id, data_revision),
                             json.dumps(codebook, ensure_ascii=False, indent=2).encode("utf-8")))
        if mask is not None:
            payloads.append((self._revision_mask_path(dataset_id, data_revision),
                             json.dumps(mask, ensure_ascii=False, indent=2).encode("utf-8")))
        with self.lock(dataset_id):
            self._snapshot_dir(dataset_id).mkdir(parents=True, exist_ok=True)
            self._publish_files(payloads)

    def load_provenance(self, dataset_id: str) -> dict[str, Any] | None:
        with self.lock(dataset_id):
            return self._read_provenance(dataset_id)

    def _read_provenance(self, dataset_id: str) -> dict[str, Any] | None:
        path = self._provenance_path(dataset_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def load_mask(self, dataset_id: str) -> dict[str, Any] | None:
        with self.lock(dataset_id):
            return self._read_mask(dataset_id)

    def _read_mask(self, dataset_id: str) -> dict[str, Any] | None:
        path = self._mask_path(dataset_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def mask_revision(self, dataset_id: str) -> int | None:
        mask = self.load_mask(dataset_id)
        if mask is None:
            return None
        try:
            return int(mask.get("maskRevision", 0))
        except (TypeError, ValueError):
            return None

    def read_snapshot(self, dataset_id: str, data_revision: int) -> pl.DataFrame:
        with self.lock(dataset_id):
            path = self._snapshot_path(dataset_id, data_revision)
            if not path.exists():
                raise BizError("PROVENANCE_SNAPSHOT_MISSING",
                               f"revision {int(data_revision)} のスナップショットが存在しません。",
                               status_code=422)
            try:
                return self._read_parquet(path)
            except Exception as exc:
                raise BizError("PROVENANCE_SNAPSHOT_MISSING",
                               f"revision {int(data_revision)} のスナップショットを読み込めません: {exc}",
                               status_code=422) from exc

    def read_raw(self, dataset_id: str) -> pl.DataFrame:
        with self.lock(dataset_id):
            path = self._raw_path(dataset_id)
            if not path.exists():
                raise BizError("PROVENANCE_RAW_MISSING",
                               "原データのスナップショットが存在しません。",
                               status_code=422)
            try:
                return self._read_parquet(path)
            except Exception as exc:
                raise BizError("PROVENANCE_RAW_MISSING",
                               f"原データのスナップショットを読み込めません: {exc}",
                               status_code=422) from exc

    def commit_data_change(
        self,
        dataset_id: str,
        meta: dict[str, Any],
        df: pl.DataFrame,
        codebook: dict[str, Any] | None,
        step: dict[str, Any],
        mask_entries: list[dict[str, Any]] | None = None,
        replace_mask: bool = False,
        raw_df: pl.DataFrame | None = None,
        history_mode: str = "append",
        cursor_operation_id: str | None = None,
        redo_stack: list[str] | None = None,
        bump_mask_revision: bool = False,
    ) -> dict[str, Any]:
        """Atomically publish values + snapshot + provenance + mask.

        Never leaves values ahead of provenance (or vice versa): every file
        is written to temp paths first, checksummed, then renamed together.
        On any failure the current values and history stay untouched and
        PROVENANCE_COMMIT_FAILED is raised.

        ``history_mode`` controls the navigation cursor:
        - ``append``: the new step becomes the current operation (a normal edit)
        - ``navigate``: the step is recorded in the audit log but the cursor
          moves to ``cursor_operation_id`` (undo/redo/revert). The audit trail
          stays append-only while repeated undo can walk further back.
        """
        import io

        if history_mode not in ("append", "navigate"):
            raise BizError("PROVENANCE_HISTORY_MODE", f"未知のhistory_mode: {history_mode}",
                           status_code=500)

        with self.lock(dataset_id):
            previous = self.get_meta(dataset_id) if self._meta_path(dataset_id).exists() else None
            previous_revision = int((previous or {}).get("dataRevision", 0))
            new_revision = previous_revision + 1 if previous else int(meta.get("dataRevision", 1))
            updated = {**meta, "dataRevision": new_revision,
                       "valuesFingerprint": values_fingerprint(df)}
            # meta.schemaRevision and codebook.schemaRevision must agree: the
            # fingerprint is derived from them, and a restored revision has to
            # reproduce the very same fingerprint it had before it was undone.
            effective_schema_revision = int(
                (codebook or {}).get("schemaRevision")
                or updated.get("schemaRevision")
                or 1
            )
            updated["schemaRevision"] = effective_schema_revision
            # The fingerprint is always recomputed here so that no write path
            # (including revision restore) can leave a stale one behind.
            updated["fingerprint"] = dataset_fingerprint(
                updated.get("schema"),
                effective_schema_revision,
                df,
                str(updated.get("format") or ""),
                updated.get("importOptions") or {},
            )

            provenance = self._read_provenance(dataset_id) or {
                "datasetId": dataset_id,
                "operations": [],
                "currentOperationId": None,
                "rawDataRevision": None,
            }
            existing_mask = self._read_mask(dataset_id) or {
                "datasetId": dataset_id, "maskRevision": 0, "entries": [],
            }
            if replace_mask:
                merged_entries: list[dict[str, Any]] = list(mask_entries or [])
            else:
                merged_entries = list(existing_mask.get("entries", [])) + list(mask_entries or [])
            mask_changed = bool(mask_entries) or replace_mask or bump_mask_revision
            new_mask_revision = int(existing_mask.get("maskRevision", 0)) + (1 if mask_changed else 0)
            mask_doc = {"datasetId": dataset_id, "dataRevision": new_revision,
                        "maskRevision": new_mask_revision, "entries": merged_entries}

            step_doc = {**step, "inputDataRevision": previous_revision or new_revision,
                        "outputDataRevision": new_revision,
                        "currentOperationId": step.get("operationId")}
            operations = list(provenance.get("operations", [])) + [step_doc]
            cursor_before = provenance.get("cursorOperationId") or provenance.get("currentOperationId")
            if history_mode == "navigate":
                new_cursor = cursor_operation_id if cursor_operation_id is not None else cursor_before
                new_redo_stack = list(redo_stack) if redo_stack is not None else list(provenance.get("redoStack") or [])
            else:
                new_cursor = step.get("operationId")
                new_redo_stack = list(redo_stack) if redo_stack is not None else []
            provenance_doc = {**provenance, "datasetId": dataset_id,
                              "operations": operations,
                              "cursorOperationId": new_cursor,
                              "redoStack": new_redo_stack,
                              "currentOperationId": new_cursor}
            if provenance_doc.get("rawDataRevision") is None and previous is None:
                provenance_doc["rawDataRevision"] = new_revision

            buffer = io.BytesIO()
            try:
                df.write_parquet(buffer)
            except Exception:
                import pyarrow as pa
                import pyarrow.parquet as pq
                table = pa.Table.from_pydict(df.to_dict(as_series=False))
                pq.write_table(table, buffer)

            snapshot_dir = self._snapshot_dir(dataset_id)
            snapshot_dir.mkdir(parents=True, exist_ok=True)
            state_doc = {
                "datasetId": dataset_id,
                "dataRevision": new_revision,
                "schema": updated.get("schema", []),
                "schemaRevision": effective_schema_revision,
                "rowCount": df.height,
                "columnCount": df.width - 1,
                "rowIdentity": updated.get("rowIdentity"),
                "format": updated.get("format"),
                "importOptions": updated.get("importOptions"),
                "sourceDatasetId": updated.get("sourceDatasetId"),
                "fingerprint": updated["fingerprint"],
                "valuesFingerprint": updated["valuesFingerprint"],
            }
            payloads: list[tuple[Path, bytes]] = [
                (self._parquet_path(dataset_id), buffer.getvalue()),
                (self._meta_path(dataset_id),
                 json.dumps(updated, ensure_ascii=False, indent=2).encode("utf-8")),
                (self._provenance_path(dataset_id),
                 json.dumps(provenance_doc, ensure_ascii=False, indent=2).encode("utf-8")),
                (self._mask_path(dataset_id),
                 json.dumps(mask_doc, ensure_ascii=False, indent=2).encode("utf-8")),
                (self._snapshot_path(dataset_id, new_revision), buffer.getvalue()),
                (self._revision_state_path(dataset_id, new_revision),
                 json.dumps(state_doc, ensure_ascii=False, indent=2).encode("utf-8")),
                (self._revision_mask_path(dataset_id, new_revision),
                 json.dumps({**mask_doc, "maskRevision": new_mask_revision},
                            ensure_ascii=False, indent=2).encode("utf-8")),
            ]
            if codebook is not None:
                payloads.append((self._codebook_path(dataset_id),
                                 json.dumps(codebook, ensure_ascii=False, indent=2).encode("utf-8")))
                payloads.append((self._revision_codebook_path(dataset_id, new_revision),
                                 json.dumps(codebook, ensure_ascii=False, indent=2).encode("utf-8")))
            if raw_df is not None or previous is None:
                raw_buffer = io.BytesIO()
                try:
                    (raw_df if raw_df is not None else df).write_parquet(raw_buffer)
                except Exception:
                    import pyarrow as pa
                    import pyarrow.parquet as pq
                    table = pa.Table.from_pydict(
                        (raw_df if raw_df is not None else df).to_dict(as_series=False))
                    pq.write_table(table, raw_buffer)
                payloads.append((self._raw_path(dataset_id), raw_buffer.getvalue()))
            if provenance_doc.get("rawDataRevision") is None:
                provenance_doc["rawDataRevision"] = new_revision
                payloads = [(p, (json.dumps(provenance_doc, ensure_ascii=False, indent=2).encode("utf-8")
                                 if p == self._provenance_path(dataset_id) else b))
                            for p, b in payloads]

            failed_checksums: list[str] = []
            for path, payload in payloads:
                if not isinstance(payload, (bytes, bytearray)) or len(payload) == 0:
                    raise BizError("PROVENANCE_COMMIT_FAILED",
                                   f"データ変更の確定に失敗しました: empty payload for {path.name}",
                                   status_code=500)
                try:
                    hashlib.sha256(bytes(payload)).hexdigest()
                except Exception:
                    failed_checksums.append(path.name)
            if failed_checksums:
                raise BizError("PROVENANCE_COMMIT_FAILED",
                               "データ変更の確定に失敗しました: checksum error",
                               status_code=500,
                               details={"files": failed_checksums})
            self._publish_files(payloads)
            meta.update(updated)
            return {"provenance": provenance_doc, "mask": mask_doc,
                    "state": state_doc, "fingerprint": updated["fingerprint"],
                    "dataRevision": new_revision}

    def save_codebook(self, dataset_id: str, codebook: dict[str, Any] | Any) -> None:
        if hasattr(codebook, "model_dump"):
            payload = codebook.model_dump()
        elif hasattr(codebook, "dict"):
            payload = codebook.dict()
        else:
            payload = codebook
        with self.lock(dataset_id):
            atomic_write_bytes(
                self._codebook_path(dataset_id),
                json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"),
            )

    def load_codebook(self, dataset_id: str) -> dict[str, Any] | None:
        with self.lock(dataset_id):
            return self._read_codebook(dataset_id)

    def _read_codebook(self, dataset_id: str) -> dict[str, Any] | None:
        path = self._codebook_path(dataset_id)
        if not path.exists():
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def delete(self, dataset_id: str) -> None:
        with self.lock(dataset_id):
            self._read_meta_nolock(dataset_id)
            for path in (
                self._meta_path(dataset_id),
                self._parquet_path(dataset_id),
                self._codebook_path(dataset_id),
                self._provenance_path(dataset_id),
                self._mask_path(dataset_id),
                self._raw_path(dataset_id),
            ):
                if path.exists():
                    path.unlink()
            snapshot_dir = self._snapshot_dir(dataset_id)
            if snapshot_dir.exists():
                shutil.rmtree(snapshot_dir, ignore_errors=True)
            for sibling in self.root.glob(f"{dataset_id}.*"):
                if sibling.is_file():
                    sibling.unlink(missing_ok=True)

    def _read_meta_nolock(self, dataset_id: str) -> dict[str, Any]:
        path = self._meta_path(dataset_id)
        if not path.exists():
            raise BizError("DATASET_NOT_FOUND", f"データセット {dataset_id} が見つかりません。",
                           status_code=404,
                           suggested_actions=["データセット一覧を確認してください"])
        return json.loads(path.read_text(encoding="utf-8"))


RESERVED_COLUMNS = ("__rowId__",)

def _check_reserved_input(df: pl.DataFrame) -> None:
    from ..domain.errors import BizError

    collisions = [c for c in df.columns if c in RESERVED_COLUMNS]
    if collisions:
        raise BizError("RESERVED_COLUMN_CONFLICT",
                       f"予約列名と衝突しています: {collisions}。通常取込では使用できません。",
                       status_code=422)

def assign_row_identity(df: pl.DataFrame, id_column: str | None = None, schemas: list[Any] | None = None,
                          _internal_canonical: bool = False) -> tuple[pl.DataFrame, str]:
    """Return dataframe with a `__rowId__` first column and the identity source."""
    # PK01: ordinary imports must not silently overwrite reserved internals.
    # A user-supplied __rowId__ column (duplicates/empty/invalid ids) is 422
    # with no write; only verified package restore may carry internal ids.
    # Internal callers that already hold a canonical frame (unique __rowId__,
    # no id_column request) bypass the gate via _internal_canonical=True.
    if not _internal_canonical and "__rowId__" in df.columns and not (id_column and id_column in df.columns):
        _check_reserved_input(df)
    if id_column and id_column in df.columns and df[id_column].null_count() == 0:
        unique_count = df[id_column].n_unique()
        if unique_count != df.height:
            raise BizError(
                "ROW_ID_NOT_UNIQUE",
                f"指定されたrow ID列 {id_column} は一意ではありません。",
                details={"unique": unique_count, "rows": df.height},
                suggested_actions=["別の列をIDにする", "生成IDを使用する"],
            )
        out = df.with_columns(pl.col(id_column).cast(pl.String).alias("__rowId__"))
        return out.select(["__rowId__"] + [c for c in out.columns if c != "__rowId__"]), f"column:{id_column}"
    # If df already contains an existing unique __rowId__, preserve it (derived datasets / imputation / calculate)
    if "__rowId__" in df.columns and df["__rowId__"].null_count() == 0 and df["__rowId__"].n_unique() == df.height:
        out = df.with_columns(pl.col("__rowId__").cast(pl.String))
        return out.select(["__rowId__"] + [c for c in out.columns if c != "__rowId__"]), "preserved"
    generated = [f"ROW-{i + 1:06d}" for i in range(df.height)]
    out = df.with_columns(pl.Series("__rowId__", generated, dtype=pl.String))
    return out.select(["__rowId__"] + [c for c in out.columns if c != "__rowId__"]), "generated"
