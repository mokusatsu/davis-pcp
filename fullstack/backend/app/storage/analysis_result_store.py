"""Workspace-backed analysis result store (Features 029-034, CA slice).

Layout: workspace/analysis-results/{resultId}/manifest.json, model.npz
(numeric arrays only), category_members.parquet (category row-set index),
exclusions.parquet. Atomic publish via temp dir + rename.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl

from ..config import settings
from ..domain.errors import BizError


def results_root() -> Path:
    root = settings.workspace_dir / "analysis-results"
    root.mkdir(parents=True, exist_ok=True)
    return root


def result_dir(result_id: str) -> Path:
    if not result_id or "/" in result_id or "\\" in result_id or ".." in result_id:
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "結果が見つかりません。", status_code=404)
    return results_root() / result_id


def _hash_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _write_frame_parquet(frame: pl.DataFrame, buf) -> None:
    """Write a frame, falling back to pyarrow when polars lacks parquet.

    The Pyodide-bundled polars exposes a PyDataFrame without write_parquet;
    dataset_store already carries the same pyarrow fallback for datasets.
    """
    try:
        frame.write_parquet(buf)
        return
    except Exception:
        pass
    import pyarrow as pa
    import pyarrow.parquet as pq

    table = pa.Table.from_pydict(frame.to_dict(as_series=False))
    pq.write_table(table, buf)


def _read_frame_parquet(path: Path, **kwargs) -> pl.DataFrame:
    try:
        return pl.read_parquet(path, **kwargs)
    except Exception:
        import pyarrow.parquet as pq

        table = pq.read_table(path, columns=kwargs.get("columns"))
        return pl.DataFrame(table.to_pydict())


def save_result(
    result_id: str,
    manifest: dict[str, Any],
    arrays: dict[str, np.ndarray],
    members: pl.DataFrame | None = None,
    exclusions: pl.DataFrame | None = None,
    rows: pl.DataFrame | None = None,
    predictions: dict[str, pl.DataFrame] | None = None,
) -> None:
    for name, arr in arrays.items():
        a = np.asarray(arr)
        if a.dtype == object:
            raise ValueError(f"model.npz forbids object arrays: {name}")
    tmp = Path(tempfile.mkdtemp(prefix="ca-result-", dir=str(results_root())))
    try:
        import io as _io
        buf = _io.BytesIO()
        np.savez_compressed(buf, **{k: np.asarray(v) for k, v in arrays.items()})
        model_bytes = buf.getvalue()
        member_bytes = None
        if members is not None:
            mbuf = _io.BytesIO()
            _write_frame_parquet(members, mbuf)
            member_bytes = mbuf.getvalue()
        excl_bytes = None
        if exclusions is not None:
            ebuf = _io.BytesIO()
            _write_frame_parquet(exclusions, ebuf)
            excl_bytes = ebuf.getvalue()
        rows_bytes = None
        if rows is not None:
            rbuf = _io.BytesIO()
            _write_frame_parquet(rows, rbuf)
            rows_bytes = rbuf.getvalue()
        pred_bytes: dict[str, bytes] = {}
        for pid, pdf in (predictions or {}).items():
            pbuf = _io.BytesIO()
            _write_frame_parquet(pdf, pbuf)
            pred_bytes[str(pid)] = pbuf.getvalue()
        files = {
            "model.npz": model_bytes,
            "manifest.json": json.dumps(manifest, ensure_ascii=False, indent=2,
                                        allow_nan=False).encode("utf-8"),
        }
        if member_bytes is not None:
            files["category_members.parquet"] = member_bytes
        if excl_bytes is not None:
            files["exclusions.parquet"] = excl_bytes
        if rows_bytes is not None:
            files["rows.parquet"] = rows_bytes
        for pid, payload in pred_bytes.items():
            safe = "".join(c for c in pid if c.isalnum() or c in ("-", "_"))
            files[f"prediction-{safe or 'p'}.parquet"] = payload
        hashes = {name: _hash_bytes(payload) for name, payload in files.items()}
        manifest_with_hash = {**manifest, "files": hashes}
        files["manifest.json"] = json.dumps(manifest_with_hash, ensure_ascii=False, indent=2,
                                            allow_nan=False).encode("utf-8")
        for name, payload in files.items():
            (tmp / name).write_bytes(payload)
        dest = result_dir(result_id)
        if dest.exists():
            raise BizError("ANALYSIS_RESULT_CONFLICT", "結果IDが重複しています。",
                           status_code=409)
        os.replace(tmp, dest)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise


def load_manifest(result_id: str) -> dict[str, Any]:
    path = result_dir(result_id) / "manifest.json"
    if not path.exists():
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", f"結果 {result_id} が見つかりません。",
                       status_code=404)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "結果を読み込めません。", status_code=404)
    if not isinstance(payload, dict):
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "結果を読み込めません。", status_code=404)
    return payload


def load_arrays(result_id: str) -> dict[str, np.ndarray]:
    path = result_dir(result_id) / "model.npz"
    if not path.exists():
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "結果が見つかりません。", status_code=404)
    with np.load(path, allow_pickle=False) as data:
        return {k: np.asarray(data[k]) for k in data.files}


def load_members(result_id: str) -> pl.DataFrame | None:
    path = result_dir(result_id) / "category_members.parquet"
    if not path.exists():
        return None
    try:
        return _read_frame_parquet(path)
    except Exception:
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "結果を読み込めません。", status_code=404)


def load_rows(result_id: str) -> pl.DataFrame | None:
    path = result_dir(result_id) / "rows.parquet"
    if not path.exists():
        return None
    try:
        return _read_frame_parquet(path)
    except Exception:
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "結果を読み込めません。", status_code=404)


def load_prediction_rows(result_id: str, prediction_id: str) -> pl.DataFrame | None:
    safe = "".join(c for c in str(prediction_id) if c.isalnum() or c in ("-", "_"))
    for name in (f"prediction-{safe or 'p'}.parquet", f"prediction-{prediction_id}.parquet"):
        path = result_dir(result_id) / name
        if path.exists():
            try:
                return _read_frame_parquet(path)
            except Exception:
                raise BizError("ANALYSIS_RESULT_NOT_FOUND", "結果を読み込めません。",
                               status_code=404)
    return None


def save_prediction_rows(result_id: str, prediction_id: str, frame: pl.DataFrame) -> None:
    import io as _io

    safe = "".join(c for c in str(prediction_id) if c.isalnum() or c in ("-", "_"))
    path = result_dir(result_id) / f"prediction-{safe or 'p'}.parquet"
    buf = _io.BytesIO()
    _write_frame_parquet(frame, buf)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(buf.getvalue())
    os.replace(tmp, path)


def delete_result(result_id: str) -> None:
    path = result_dir(result_id)
    if not path.exists():
        return
    shutil.rmtree(path, ignore_errors=True)


# --- E011: persistent EFA attempt/comparison artifacts ---------------------
# Attempts and comparisons live next to analysis-results so they survive
# process restarts and stay addressable from the saved main result's
# comparisonId. Layout (atomic publish via temp dir + rename, same as
# save_result):
#   workspace/analysis-attempts/{attemptId}/attempt.json
#   workspace/analysis-comparisons/{comparisonId}/comparison.json
# (+ optional diagnostics.json / payload.json sidecars).

def _artifact_root(kind: str) -> Path:
    root = settings.workspace_dir / kind
    root.mkdir(parents=True, exist_ok=True)
    return root


def _artifact_dir(kind: str, artifact_id: str) -> Path:
    if (not artifact_id or "/" in artifact_id or "\\" in artifact_id
            or ".." in artifact_id):
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "記録が見つかりません。",
                       status_code=404)
    return _artifact_root(kind) / artifact_id


def _write_artifact_file(dest_dir: Path, name: str, data: bytes) -> None:
    """Atomically replace one artifact file, keeping the rest intact.

    Writes to a temp sibling and renames over the target, so a failed or
    concurrent update never deletes the previous record (E011 2nd round).
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    tmp = dest_dir / f".{name}.tmp"
    tmp.write_bytes(data)
    os.replace(tmp, dest_dir / name)


def save_artifact(kind: str, artifact_id: str, payload: dict[str, Any]) -> None:
    dest = _artifact_dir(kind, artifact_id)
    name = "attempt.json" if kind == "analysis-attempts" else "comparison.json"
    body = json.dumps(payload, ensure_ascii=False, indent=2,
                      allow_nan=False).encode("utf-8")
    _write_artifact_file(dest, name,
                         json.dumps({**payload,
                                     "files": {name: _hash_bytes(body)}},
                                    ensure_ascii=False, indent=2,
                                    allow_nan=False).encode("utf-8"))


def load_artifact(kind: str, artifact_id: str) -> dict[str, Any]:
    name = "attempt.json" if kind == "analysis-attempts" else "comparison.json"
    path = _artifact_dir(kind, artifact_id) / name
    if not path.exists():
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "記録が見つかりません。",
                       status_code=404)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "記録を読み込めません。",
                       status_code=404)
    if not isinstance(payload, dict):
        raise BizError("ANALYSIS_RESULT_NOT_FOUND", "記録を読み込めません。",
                       status_code=404)
    return payload
