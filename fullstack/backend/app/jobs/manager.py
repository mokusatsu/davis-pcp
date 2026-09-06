"""Background job manager: process pool, WebSocket progress, cancel, cache."""
from __future__ import annotations

import asyncio
import concurrent.futures
import json
import uuid
from typing import Any, Callable

from fastapi import WebSocket

from ..storage.session_store import JobStore


class JobManager:
    def __init__(self) -> None:
        self.store = JobStore()
        self.pool = concurrent.futures.ProcessPoolExecutor(max_workers=2)
        self.subscribers: dict[str, set[WebSocket]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        # result cache keyed by (job_type, dataset_id, params-canonical-json)
        self.cache: dict[str, str] = {}

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    @staticmethod
    def cache_key(job_type: str, dataset_id: str | None, params: dict) -> str:
        return f"{job_type}|{dataset_id}|{json.dumps(params, sort_keys=True, ensure_ascii=False)}"

    async def submit(
        self,
        job_type: str,
        dataset_id: str | None,
        params: dict,
        fn: Callable[..., dict],
        units_total: int | None = None,
        use_cache: bool = True,
    ) -> dict:
        key = self.cache_key(job_type, dataset_id, params)
        if use_cache and key in self.cache:
            cached = self.store.get(self.cache[key])
            if cached and cached["status"] == "completed":
                return {**cached, "cacheHit": True}
        job_id = f"job-{uuid.uuid4().hex[:12]}"
        job = self.store.create(job_id, job_type, dataset_id, params)
        loop = asyncio.get_running_loop()
        future = loop.run_in_executor(self.pool, _run_job_payload, fn, params)
        asyncio.ensure_future(self._track(job_id, key if use_cache else None, future))
        return job

    async def _track(self, job_id: str, cache_key_value: str | None, future: asyncio.Future) -> None:
        try:
            result = await future
            job = self.store.transition(job_id, "completed", phase="done", result=result)
            if cache_key_value:
                self.cache[cache_key_value] = job_id
            await self.broadcast(job_id, {"type": "completed", "job": job})
        except CancelledJob:
            job = self.store.transition(job_id, "cancelled", phase="cancelled")
            await self.broadcast(job_id, {"type": "cancelled", "job": job})
        except Exception as exc:
            job = self.store.transition(job_id, "failed", error={"message": str(exc)[:500]})
            await self.broadcast(job_id, {"type": "failed", "job": job})

    def cancel(self, job_id: str) -> dict:
        """Mark cancelled immediately; running workers observe via the store."""
        job = self.store.get(job_id)
        if job["status"] in ("queued", "running"):
            return self.store.transition(job_id, "cancelled", phase="cancelled")
        return job

    async def broadcast(self, job_id: str, message: dict) -> None:
        sockets = list(self.subscribers.get(job_id, ()))
        for ws in sockets:
            try:
                await ws.send_json(message)
            except Exception:
                self.subscribers.get(job_id, set()).discard(ws)

    def subscribe(self, job_id: str, ws: WebSocket) -> None:
        self.subscribers.setdefault(job_id, set()).add(ws)

    def unsubscribe(self, job_id: str, ws: WebSocket) -> None:
        self.subscribers.get(job_id, set()).discard(ws)


class CancelledJob(Exception):
    pass


def check_cancelled(store: JobStore, job_id: str) -> None:
    status = store.get(job_id)["status"]
    if status in ("cancelled",):
        raise CancelledJob()


def report_progress(store: JobStore, job_id: str, phase: str, done: int, total: int) -> dict:
    return store.transition(job_id, "running", phase=phase, units_done=done)


def _run_job_payload(fn: Callable[..., dict], params: dict) -> dict:
    """Runs inside a worker process. The callable is module-level picklable.

    Cancellation is checked by the function itself via injected store access;
    for process-pool safety the wrapper only serializes results.
    """
    return fn(**params)


manager = JobManager()
