"""Application configuration."""
from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel, Field


class Settings(BaseModel):
    app_name: str = "DAVIS-PCP Fullstack"
    version: str = "2.0.0"
    host: str = "127.0.0.1"
    port: int = 8420
    workspace_dir: Path = Field(default_factory=lambda: Path(
        os.environ.get("DAVIS_PCP_WORKSPACE", Path(__file__).resolve().parents[3] / "workspace")
    ))
    max_upload_bytes: int = int(os.environ.get("DAVIS_PCP_MAX_UPLOAD", 256 * 1024 * 1024))
    max_rows: int = int(os.environ.get("DAVIS_PCP_MAX_ROWS", 5_000_000))
    max_columns: int = int(os.environ.get("DAVIS_PCP_MAX_COLUMNS", 500))
    cors_origins: list[str] = Field(default_factory=lambda: [
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:8420", "http://127.0.0.1:8420",
    ])

    model_config = {"arbitrary_types_allowed": True}

    def ensure_dirs(self) -> None:
        for sub in ("datasets", "sessions", "jobs", "exports"):
            (self.workspace_dir / sub).mkdir(parents=True, exist_ok=True)


settings = Settings()
