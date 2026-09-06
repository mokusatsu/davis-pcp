"""Job APIs: status, cancel, WebSocket events."""
from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..jobs.manager import manager

router = APIRouter()


@router.get("/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    return manager.store.get(job_id)


@router.get("/jobs")
def list_jobs(dataset_id: str | None = None) -> dict:
    return {"jobs": manager.store.list_jobs(dataset_id)}


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    return manager.cancel(job_id)


@router.websocket("/ws/jobs/{job_id}/events")
async def job_events(ws: WebSocket, job_id: str) -> None:
    await ws.accept()
    manager.subscribe(job_id, ws)
    try:
        current = manager.store.get(job_id)
        await ws.send_json({"type": "current", "job": current})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        manager.unsubscribe(job_id, ws)
