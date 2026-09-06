"""Health endpoint."""
from __future__ import annotations

from fastapi import APIRouter

from ..config import settings

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "app": settings.app_name,
        "version": settings.version,
    }
