#!/usr/bin/env python3
"""Release build: verify tests, generate checksums + manifest, package ZIP.

Usage: python build-release.py [--skip-tests]
Output: ../DAVIS-PCP-Fullstack-v2.0.0.zip (+ .sha256 sidecar)
"""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = "2.0.0"
ZIP_NAME = f"DAVIS-PCP-Fullstack-v{VERSION}.zip"

INCLUDE_DIRS = ["backend", "frontend/src", "frontend/tests", "frontend/public", "fixtures", "scripts", "docs", "e2e", "benchmark"]
INCLUDE_FILES = [
    "README.md", "ARCHITECTURE.md", "API_SPEC.md", "MIGRATION_FROM_STATIC_V1.md",
    "FEATURE_TRACEABILITY.csv", "TEST_REPORT.md", "SOURCE_REVIEW_LOG.md",
    "RELEASE_NOTES.md", "BENCHMARK_REPORT.md", "SECURITY_REPORT.md",
    "release-manifest.json", "checksums.sha256",
    "run-dev.sh", "run-dev.ps1", "run-production.sh", "run-production.ps1",
    "backend/requirements.txt",
    "frontend/package.json", "frontend/package-lock.json",
    "frontend/tsconfig.json", "frontend/vite.config.ts", "frontend/index.html",
]
EXCLUDE_NAMES = {"__pycache__", ".pytest_cache", "node_modules", "dist", ".venv", "workspace", "_layout_check.py"}


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_tests() -> None:
    print("[1/4] backend tests ...")
    subprocess.run([sys.executable, "-m", "pytest", "tests/", "-q"],
                   cwd=ROOT / "backend", check=True)
    print("[1/4] frontend unit tests ...")
    subprocess.run(["npx", "vitest", "run"], cwd=ROOT / "frontend", check=True)


def ensure_frontend_build() -> None:
    print("[2/4] frontend production build ...")
    if not (ROOT / "frontend/dist/index.html").exists():
        subprocess.run(["npm", "run", "build"], cwd=ROOT / "frontend", check=True)


def collect_files() -> list[Path]:
    files: list[Path] = []
    for rel_dir in INCLUDE_DIRS:
        base = ROOT / rel_dir
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.is_file() and not any(part in EXCLUDE_NAMES for part in path.parts):
                files.append(path)
    for rel in INCLUDE_FILES:
        path = ROOT / rel
        if path.exists():
            files.append(path)
    return sorted(set(files))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-tests", action="store_true")
    args = parser.parse_args()

    if not args.skip_tests:
        run_tests()
    ensure_frontend_build()

    print("[3/4] checksums + manifest ...")
    files = collect_files()
    lines = []
    for path in files:
        rel = path.relative_to(ROOT).as_posix()
        lines.append(f"{sha256_of(path)}  {rel}")
    checksums = "\n".join(lines) + "\n"
    (ROOT / "checksums.sha256").write_text(checksums, encoding="utf-8")

    manifest = {
        "artifact": ZIP_NAME,
        "version": VERSION,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fileCount": len(files) + 2,
        "components": {
            "backend": "FastAPI + Polars/scikit-learn/scipy (Python authoritative ordering)",
            "frontend": "React 18 + TypeScript strict + Ant Design 5 + Vite",
            "storage": "canonical Parquet datasets + SQLite sessions/jobs",
        },
        "checksumsFile": "checksums.sha256",
    }
    (ROOT / "release-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    print(f"[4/4] packaging {ZIP_NAME} ...")
    zip_path = ROOT.parent / ZIP_NAME
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in files:
            zf.write(path, f"davis-pcp-fullstack-v{VERSION}/{path.relative_to(ROOT).as_posix()}")
        zf.writestr(f"davis-pcp-fullstack-v{VERSION}/checksums.sha256", checksums)
        zf.writestr(f"davis-pcp-fullstack-v{VERSION}/release-manifest.json",
                    json.dumps(manifest, indent=2) + "\n")

    digest = sha256_of(zip_path)
    (zip_path.parent / f"{ZIP_NAME}.sha256").write_text(f"{digest}  {ZIP_NAME}\n", encoding="ascii")
    size_mb = zip_path.stat().st_size / (1024 * 1024)
    print(f"\nDONE: {zip_path}")
    print(f"SHA-256: {digest}")
    print(f"size: {size_mb:.1f} MB, {len(files) + 2} entries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
