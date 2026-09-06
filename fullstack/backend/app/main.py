"""FastAPI application entry point."""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .api import health
from .api import datasets as datasets_api
from .api import jobs as jobs_api
from .api import groups as groups_api
from .api import summaries as summaries_api
from .api import sessions as sessions_api
from .api import orderings as orderings_api
from .api import exports as exports_api
from .api import clusters as clusters_api
from .api import models as models_api
from .api import mining as mining_api
from .api import relationships as relationships_api
from .api import robustness as robustness_api
from .api import pra as pra_api
from .api import distribution as distribution_api
from .api import regression as regression_api
from .api import statistics as statistics_api
from .api import observations as observations_api
from .api import logistic as logistic_api
from .api import discriminant as discriminant_api
from .config import settings
from .domain.errors import BizError, biz_error_handler

app = FastAPI(
    title=settings.app_name,
    version=settings.version,
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "If-Match"],
)

app.add_exception_handler(BizError, biz_error_handler)


@app.exception_handler(Exception)
async def unhandled_error(_request: Request, exc: Exception) -> JSONResponse:
    return JSONResponse(status_code=500, content={"error": {
        "code": "INTERNAL_ERROR",
        "message": "内部エラーが発生しました。",
        "details": {},
        "evidenceClass": "MODERN-EXTENSION",
        "recoverable": False,
        "suggestedActions": ["操作をやり直してください"],
        "traceId": "",
    }})


app.include_router(health.router, prefix="/api/v1")
app.include_router(datasets_api.router, prefix="/api/v1")
app.include_router(jobs_api.router, prefix="/api/v1")
app.include_router(groups_api.router, prefix="/api/v1")
app.include_router(summaries_api.router, prefix="/api/v1")
app.include_router(sessions_api.router, prefix="/api/v1")
app.include_router(orderings_api.router, prefix="/api/v1")
app.include_router(exports_api.router, prefix="/api/v1")
app.include_router(clusters_api.router, prefix="/api/v1")
app.include_router(models_api.router, prefix="/api/v1")
app.include_router(mining_api.router, prefix="/api/v1")
app.include_router(relationships_api.router, prefix="/api/v1")
app.include_router(robustness_api.router, prefix="/api/v1")
app.include_router(pra_api.router, prefix="/api/v1")
app.include_router(distribution_api.router, prefix="/api/v1")
app.include_router(regression_api.router, prefix="/api/v1")
app.include_router(statistics_api.router, prefix="/api/v1")
app.include_router(observations_api.router, prefix="/api/v1")
app.include_router(logistic_api.router, prefix="/api/v1")
app.include_router(discriminant_api.router, prefix="/api/v1")

_frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if _frontend_dist.exists():
    app.mount("/assets", StaticFiles(directory=_frontend_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        """SPA history fallback: serve index.html for client-side routes."""
        candidate = _frontend_dist / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(_frontend_dist / "index.html")


@app.on_event("startup")
def startup() -> None:
    settings.ensure_dirs()
