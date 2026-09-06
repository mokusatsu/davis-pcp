"""SQLite session repository with optimistic concurrency."""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from ..config import settings
from ..domain.errors import BizError

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dataset_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    dataset_id TEXT,
    status TEXT NOT NULL,
    phase TEXT,
    units_total INTEGER,
    units_done INTEGER DEFAULT 0,
    params TEXT,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def revision_token(session_id: str, revision: int) -> str:
    return hashlib.sha256(f"{session_id}:{revision}".encode()).hexdigest()[:16]


class SessionStore:
    def __init__(self, workspace: Path | None = None) -> None:
        path = (workspace or settings.workspace_dir) / "sessions"
        path.mkdir(parents=True, exist_ok=True)
        self.db_path = path / "sessions.db"
        self._lock = threading.Lock()
        with self._connect() as con:
            con.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path, timeout=10)
        con.row_factory = sqlite3.Row
        return con

    def create(self, name: str, dataset_id: str | None, state: dict[str, Any]) -> dict:
        import uuid
        session_id = f"sess-{uuid.uuid4().hex[:12]}"
        now = _now()
        with self._lock, self._connect() as con:
            con.execute(
                "INSERT INTO sessions (session_id, name, dataset_id, revision, state, created_at, updated_at) VALUES (?,?,?,1,?,?,?)",
                (session_id, name, dataset_id, json.dumps(state, ensure_ascii=False), now, now),
            )
        return self.get(session_id)

    def get(self, session_id: str) -> dict:
        with self._connect() as con:
            row = con.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
        if row is None:
            raise BizError("SESSION_NOT_FOUND", f"セッション {session_id} が見つかりません。", status_code=404)
        return self._to_dict(row)

    def _to_dict(self, row: sqlite3.Row) -> dict:
        return {
            "sessionId": row["session_id"],
            "name": row["name"],
            "datasetId": row["dataset_id"],
            "revision": row["revision"],
            "versionToken": revision_token(row["session_id"], row["revision"]),
            "state": json.loads(row["state"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def list_sessions(self) -> list[dict]:
        with self._connect() as con:
            rows = con.execute(
                "SELECT session_id, name, dataset_id, revision, state, created_at, updated_at FROM sessions ORDER BY updated_at DESC"
            ).fetchall()
        result = []
        for row in rows:
            item = {
                "sessionId": row["session_id"],
                "name": row["name"],
                "datasetId": row["dataset_id"],
                "revision": row["revision"],
                "state": json.loads(row["state"]),
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            result.append(item)
        return result

    def update(self, session_id: str, state: dict[str, Any], expected_token: str | None, name: str | None = None) -> dict:
        with self._lock, self._connect() as con:
            row = con.execute("SELECT * FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            if row is None:
                raise BizError("SESSION_NOT_FOUND", f"セッション {session_id} が見つかりません。", status_code=404)
            current = self._to_dict(row)
            if expected_token is not None and expected_token != current["versionToken"]:
                raise BizError(
                    "SESSION_CONFLICT",
                    "セッションは他のクライアントによって更新されています。",
                    details={"expectedRevision": current["revision"], "serverRevision": current["revision"],
                             "serverVersionToken": current["versionToken"], "state": current["state"]},
                    status_code=409,
                    suggested_actions=["再読込", "比較", "ローカル保持", "コピーとして保存"],
                )
            new_revision = current["revision"] + 1
            new_name = name if name is not None else current["name"]
            con.execute(
                "UPDATE sessions SET state=?, revision=?, name=?, updated_at=? WHERE session_id=?",
                (json.dumps(state, ensure_ascii=False), new_revision, new_name, _now(), session_id),
            )
        return self.get(session_id)

    def delete(self, session_id: str) -> None:
        with self._lock, self._connect() as con:
            row = con.execute("SELECT session_id FROM sessions WHERE session_id=?", (session_id,)).fetchone()
            if row is None:
                raise BizError("SESSION_NOT_FOUND", f"セッション {session_id} が見つかりません。", status_code=404)
            con.execute("DELETE FROM sessions WHERE session_id=?", (session_id,))


class JobStore:
    def __init__(self, workspace: Path | None = None) -> None:
        path = (workspace or settings.workspace_dir) / "jobs"
        path.mkdir(parents=True, exist_ok=True)
        self.db_path = path / "jobs.db"
        self._lock = threading.Lock()
        with self._connect() as con:
            con.executescript(SCHEMA)

    def _connect(self) -> sqlite3.Connection:
        con = sqlite3.connect(self.db_path, timeout=10)
        con.row_factory = sqlite3.Row
        return con

    def create(self, job_id: str, job_type: str, dataset_id: str | None, params: dict) -> dict:
        now = _now()
        with self._lock, self._connect() as con:
            con.execute(
                "INSERT INTO jobs (job_id, job_type, dataset_id, status, params, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
                (job_id, job_type, dataset_id, "queued", json.dumps(params, ensure_ascii=False), now, now),
            )
        return self.get(job_id)

    def get(self, job_id: str) -> dict:
        with self._connect() as con:
            row = con.execute("SELECT * FROM jobs WHERE job_id=?", (job_id,)).fetchone()
        if row is None:
            raise BizError("JOB_NOT_FOUND", f"ジョブ {job_id} が見つかりません。", status_code=404)
        return self._to_dict(row)

    def _to_dict(self, row: sqlite3.Row) -> dict:
        return {
            "jobId": row["job_id"],
            "jobType": row["job_type"],
            "datasetId": row["dataset_id"],
            "status": row["status"],
            "phase": row["phase"],
            "unitsTotal": row["units_total"],
            "unitsDone": row["units_done"],
            "params": json.loads(row["params"]) if row["params"] else {},
            "result": json.loads(row["result"]) if row["result"] else None,
            "error": json.loads(row["error"]) if row["error"] else None,
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def transition(self, job_id: str, status: str, *, phase: str | None = None,
                   units_done: int | None = None, result: dict | None = None,
                   error: dict | None = None) -> dict:
        """Guarded transition: cancelled/terminal states never regress."""
        with self._lock, self._connect() as con:
            row = con.execute("SELECT status FROM jobs WHERE job_id=?", (job_id,)).fetchone()
            if row is None:
                raise BizError("JOB_NOT_FOUND", f"ジョブ {job_id} が見つかりません。", status_code=404)
            current = row["status"]
            terminal = {"completed", "failed", "cancelled"}
            if current in terminal and current != status:
                # Terminal states are immutable.
                return self.get(job_id)
            if current == "cancelled":
                return self.get(job_id)
            sets = ["status=?", "updated_at=?"]
            args: list = [status, _now()]
            if phase is not None:
                sets.append("phase=?")
                args.append(phase)
            if units_done is not None:
                sets.append("units_done=?")
                args.append(units_done)
            if result is not None:
                sets.append("result=?")
                args.append(json.dumps(result, ensure_ascii=False))
            if error is not None:
                sets.append("error=?")
                args.append(json.dumps(error, ensure_ascii=False))
            args.append(job_id)
            con.execute(f"UPDATE jobs SET {', '.join(sets)} WHERE job_id=?", args)
        return self.get(job_id)

    def list_jobs(self, dataset_id: str | None = None) -> list[dict]:
        with self._connect() as con:
            if dataset_id:
                rows = con.execute("SELECT * FROM jobs WHERE dataset_id=? ORDER BY created_at DESC", (dataset_id,)).fetchall()
            else:
                rows = con.execute("SELECT * FROM jobs ORDER BY created_at DESC").fetchall()
        return [self._to_dict(row) for row in rows]
