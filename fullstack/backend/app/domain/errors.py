"""Unified business error contract."""
from __future__ import annotations

import time
import uuid
from typing import Any

from fastapi import Request
from fastapi.responses import JSONResponse


class BizError(Exception):
    status_code = 400

    def __init__(
        self,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
        evidence_class: str = "MODERN-EXTENSION",
        recoverable: bool = True,
        suggested_actions: list[str] | None = None,
        status_code: int | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.details = details or {}
        self.evidence_class = evidence_class
        self.recoverable = recoverable
        self.suggested_actions = suggested_actions or []
        if status_code is not None:
            self.status_code = status_code
        super().__init__(message)

    def to_response(self) -> JSONResponse:
        return JSONResponse(
            status_code=self.status_code,
            content={"error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
                "evidenceClass": self.evidence_class,
                "recoverable": self.recoverable,
                "suggestedActions": self.suggested_actions,
                "traceId": uuid.uuid4().hex[:16],
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }},
        )


async def biz_error_handler(_request: Request, exc: BizError) -> JSONResponse:
    return exc.to_response()
