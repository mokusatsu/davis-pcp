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
import tempfile
from pathlib import Path
from typing import Any

import polars as pl

from ..config import settings
from ..domain.errors import BizError


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

    def save(self, dataset_id: str, meta: dict[str, Any], df: pl.DataFrame) -> None:
        import io
        buffer = io.BytesIO()
        df.write_parquet(buffer)
        atomic_write_bytes(self._parquet_path(dataset_id), buffer.getvalue())
        atomic_write_bytes(self._meta_path(dataset_id), json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8"))

    def get_meta(self, dataset_id: str) -> dict[str, Any]:
        path = self._meta_path(dataset_id)
        if not path.exists():
            raise BizError("DATASET_NOT_FOUND", f"データセット {dataset_id} が見つかりません。", status_code=404,
                           suggested_actions=["データセット一覧を確認してください"])
        return json.loads(path.read_text(encoding="utf-8"))

    def get_dataframe(self, dataset_id: str) -> pl.DataFrame:
        path = self._parquet_path(dataset_id)
        if not path.exists():
            raise BizError("DATASET_NOT_FOUND", f"データセット {dataset_id} の本体が見つかりません。",
                           status_code=404)
        return pl.read_parquet(path)

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

    def delete(self, dataset_id: str) -> None:
        self.get_meta(dataset_id)
        self._meta_path(dataset_id).unlink()
        parquet = self._parquet_path(dataset_id)
        if parquet.exists():
            parquet.unlink()


def assign_row_identity(df: pl.DataFrame, id_column: str | None, schemas: list[Any]) -> tuple[pl.DataFrame, str]:
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
        out = df.with_columns(pl.col(id_column).cast(pl.String).alias("__rowId__")).drop([id_column])
        return out.select(["__rowId__"] + [c for c in out.columns if c != "__rowId__"]), f"column:{id_column}"
    candidate = next((s for s in schemas
                      if getattr(s, "uniqueIdCandidate", False) and s.name in df.columns
                      and s.semanticType != "numeric"), None)
    if candidate is not None:
        out = df.with_columns(pl.col(candidate.name).cast(pl.String).alias("__rowId__")).drop([candidate.name])
        return out.select(["__rowId__"] + [c for c in out.columns if c != "__rowId__"]), f"column:{candidate.name}"
    generated = [f"ROW-{i + 1:06d}" for i in range(df.height)]
    out = df.with_columns(pl.Series("__rowId__", generated, dtype=pl.String))
    return out.select(["__rowId__"] + [c for c in out.columns if c != "__rowId__"]), "generated"
