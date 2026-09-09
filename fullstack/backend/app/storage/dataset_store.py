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
        """Publish dictionary and metadata together under the dataset operation lock."""
        with self.lock(dataset_id):
            self._publish_files([(path, json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8"))
                                 for path, payload in [(self._codebook_path(dataset_id), codebook), (self._meta_path(dataset_id), meta)]])

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
        try:
            return pl.read_parquet(path, columns=columns)
        except Exception:
            import pyarrow.parquet as pq
            table = pq.read_table(path, columns=columns)
            return pl.DataFrame(table.to_pydict())

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
        self.get_meta(dataset_id)
        self._meta_path(dataset_id).unlink()
        parquet = self._parquet_path(dataset_id)
        if parquet.exists():
            parquet.unlink()
        codebook = self._codebook_path(dataset_id)
        if codebook.exists():
            codebook.unlink()


def assign_row_identity(df: pl.DataFrame, id_column: str | None = None, schemas: list[Any] | None = None) -> tuple[pl.DataFrame, str]:
    """Return dataframe with a `__rowId__` first column and the identity source."""
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
