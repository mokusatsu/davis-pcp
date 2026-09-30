#!/usr/bin/env python3
"""Build standalone static site for DAVIS-PCP in dist/static.

Runs Python backend in browser via Pyodide WebAssembly.
Bundles all runtime files and Python wheels locally for full offline support.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = ROOT / "fullstack" / "frontend"
BACKEND_DIR = ROOT / "fullstack" / "backend"
DIST_STATIC = ROOT / "dist" / "static"
CACHE_DIR = ROOT / ".cache" / "pyodide_static"

PYODIDE_VERSION = "v0.27.7"
PYODIDE_CDN_BASE = f"https://cdn.jsdelivr.net/pyodide/{PYODIDE_VERSION}/full"

PYODIDE_CORE_FILES = [
    "pyodide.js",
    "pyodide.mjs",
    "pyodide.asm.js",
    "pyodide.asm.wasm",
    "python_stdlib.zip",
    "pyodide-lock.json",
]

# Native / binary packages from pyodide-lock.json to include locally
TARGET_NATIVE_PACKAGES = [
    "numpy",
    "scipy",
    "openblas",
    "scikit-learn",
    "joblib",
    "threadpoolctl",
    "polars",
    "pyarrow",
    "pyodide-unix-timezones",
    "pandas",
    "python-dateutil",
    "pytz",
    "six",
    "pydantic",
    "pydantic-core",
    "typing-extensions",
    "annotated-types",
    "anyio",
    "sniffio",
    "idna",
    "sqlite3",
]

# Pure-python packages to fetch from PyPI (pinned to maintain consistency with requirements.txt and avoid heavy telemetry dependencies)
PURE_PYTHON_PACKAGES: dict[str, str | None] = {
    "fastapi": "0.139.2",
    "starlette": "0.46.2",
    "python-multipart": "0.0.32",
    "annotated-doc": "0.0.5",
    "typing-inspection": "0.4.4",
    "httpx": "0.28.1",
    "httpcore": None,
    "h11": None,
    "certifi": None,
}


def download_file(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"  Downloading {dest.name} ...")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (DAVIS-PCP-Build)"})
    with urllib.request.urlopen(req) as resp, dest.open("wb") as out:
        shutil.copyfileobj(resp, out)


def get_pypi_pure_wheel_info(pkg_name: str, version: str | None = None) -> tuple[str, str]:
    """Return (filename, download_url) for the specified or latest pure-python wheel from PyPI."""
    if version:
        url = f"https://pypi.org/pypi/{pkg_name}/{version}/json"
    else:
        url = f"https://pypi.org/pypi/{pkg_name}/json"

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (DAVIS-PCP-Build)"})
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read().decode("utf-8"))

    # When version is queried directly, releases may not contain the version key; urls list contains download files
    urls = data.get("urls", [])
    for r in urls:
        fn = r.get("filename", "")
        if fn.endswith("-py3-none-any.whl") or fn.endswith("-py2.py3-none-any.whl"):
            return fn, r["url"]

    target_ver = version or data.get("info", {}).get("version")
    releases = data.get("releases", {}).get(target_ver, [])
    for r in releases:
        fn = r.get("filename", "")
        if fn.endswith("-py3-none-any.whl") or fn.endswith("-py2.py3-none-any.whl"):
            return fn, r["url"]

    raise RuntimeError(f"No pure wheel found for {pkg_name} {target_ver}")


def prepare_pyodide_assets() -> tuple[list[Path], list[Path]]:
    """Download and cache all Pyodide core files and wheels. Returns (core_files, wheel_files)."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    wheels_cache = CACHE_DIR / "wheels"
    wheels_cache.mkdir(exist_ok=True)

    print("[1/5] Preparing Pyodide core runtime ...")
    core_paths = []
    for fn in PYODIDE_CORE_FILES:
        dest = CACHE_DIR / fn
        download_file(f"{PYODIDE_CDN_BASE}/{fn}", dest)
        core_paths.append(dest)

    # Read pyodide-lock.json to resolve filenames for native packages
    lock_data = json.loads((CACHE_DIR / "pyodide-lock.json").read_text(encoding="utf-8"))
    packages_map = lock_data.get("packages", {})

    print("[2/5] Preparing Pyodide native WASM packages ...")
    native_wheel_paths = []
    # Use BFS to include all direct & indirect dependencies from lock
    to_visit = list(TARGET_NATIVE_PACKAGES)
    visited = set()
    while to_visit:
        pkg = to_visit.pop(0)
        if pkg in visited:
            continue
        visited.add(pkg)
        if pkg in packages_map:
            fn = packages_map[pkg]["file_name"]
            dest = CACHE_DIR / fn
            download_file(f"{PYODIDE_CDN_BASE}/{fn}", dest)
            native_wheel_paths.append(dest)
            for dep in packages_map[pkg].get("depends", []):
                if dep not in visited and dep in packages_map:
                    to_visit.append(dep)

    print("[3/5] Preparing Pure-Python packages (FastAPI, HTTPX, multipart, etc.) ...")
    pure_wheel_paths = []
    for pkg, ver in PURE_PYTHON_PACKAGES.items():
        fn, url = get_pypi_pure_wheel_info(pkg, ver)
        dest = wheels_cache / fn
        download_file(url, dest)
        pure_wheel_paths.append(dest)

    return core_paths + native_wheel_paths, pure_wheel_paths


def package_backend_app() -> Path:
    """Package fullstack/backend/app into a clean backend_app.zip."""
    zip_path = CACHE_DIR / "backend_app.zip"
    print("  Archiving backend application ...")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # Include backend/app
        app_dir = BACKEND_DIR / "app"
        for p in app_dir.rglob("*"):
            if p.is_file() and not any(part in ("__pycache__", ".pytest_cache") for part in p.parts):
                arcname = f"app/{p.relative_to(app_dir).as_posix()}"
                zf.write(p, arcname)

        # Include sample iris fixture
        iris_fix = ROOT / "fullstack" / "fixtures" / "iris_fixture.json"
        if not iris_fix.exists():
            iris_fix = ROOT / "_iris_fixture.json"
        if iris_fix.exists():
            zf.write(iris_fix, "fixtures/iris_fixture.json")
            zf.write(iris_fix, "app/fixtures/iris_fixture.json")
            zf.write(iris_fix, "_iris_fixture.json")

    return zip_path


def build_frontend() -> None:
    """Run Vite static build."""
    print("[4/5] Building frontend (Vite static mode) ...")
    # Vite は outDir を初期化しない設定 (emptyOutDir: false) のため、
    # 以前の index.html や古いハッシュ付き資産が残る。出力先全体を消す。
    if DIST_STATIC.exists():
        shutil.rmtree(DIST_STATIC)
    DIST_STATIC.mkdir(parents=True, exist_ok=True)
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    subprocess.run([npm_cmd, "run", "build:static"], cwd=FRONTEND_DIR, check=True,
                   shell=False)


def assemble_dist_static(pyodide_files: list[Path], pure_wheels: list[Path], app_zip: Path) -> None:
    """Assemble all files into dist/static."""
    print("[5/5] Assembling dist/static directory ...")
    pyodide_dest = DIST_STATIC / "pyodide"
    pyodide_dest.mkdir(parents=True, exist_ok=True)
    wheels_dest = pyodide_dest / "wheels"
    wheels_dest.mkdir(parents=True, exist_ok=True)

    # 1. Copy Pyodide core + native wheels to dist/static/pyodide/
    for src in pyodide_files:
        shutil.copy2(src, pyodide_dest / src.name)

    # 2. Copy Pure-python wheels to dist/static/pyodide/wheels/
    pure_manifest = []
    for src in pure_wheels:
        shutil.copy2(src, wheels_dest / src.name)
        pure_manifest.append(src.name)

    (wheels_dest / "manifest.json").write_text(json.dumps(pure_manifest, indent=2), encoding="utf-8")

    # 3. Copy backend_app.zip to dist/static/pyodide/
    shutil.copy2(app_zip, pyodide_dest / "backend_app.zip")

    # 4. Ensure Rust graph_core.wasm is available
    rust_wasm = FRONTEND_DIR / "rust" / "graph-core" / "target" / "wasm32-unknown-unknown" / "release" / "graph_core.wasm"
    wasm_dest_dir = DIST_STATIC / "wasm"
    wasm_dest_dir.mkdir(parents=True, exist_ok=True)
    if rust_wasm.exists():
        shutil.copy2(rust_wasm, wasm_dest_dir / "graph_core.wasm")

    # 5. Place local runner bat in dist/
    bat_content = """@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===================================================
echo  DAVIS-PCP Standalone Static Site (WASM) Local Server
echo ===================================================
echo.

set TARGET_DIR=static
if not exist "static\\index.html" (
    if exist "index.html" (
        set TARGET_DIR=.
    ) else (
        echo [ERROR] static site files not found in "%~dp0"!
        pause
        exit /b 1
    )
)

set PYTHON_CMD=python
where python >nul 2>nul
if %errorlevel% neq 0 (
    where py >nul 2>nul
    if %errorlevel% equ 0 (
        set PYTHON_CMD=py
    ) else (
        echo [ERROR] Python was not found on PATH.
        echo Please install Python or add it to PATH.
        pause
        exit /b 1
    )
)

echo Opening http://localhost:8421/ in your browser...
echo Serving directory: %TARGET_DIR%
echo Press Ctrl+C to stop the server.
echo.

start http://localhost:8421/

if "%TARGET_DIR%"=="static" (
    %PYTHON_CMD% -m http.server -d static 8421
) else (
    %PYTHON_CMD% -m http.server 8421
)
"""
    dist_dir = DIST_STATIC.parent
    (dist_dir / "run-static.bat").write_text(bat_content, encoding="utf-8")


def main() -> int:
    print("=" * 60)
    print(" DAVIS-PCP Standalone Static Site Builder (Pyodide WASM)")
    print("=" * 60)

    # 0. Check license coverage
    check_script = ROOT / "scripts" / "check_licenses.py"
    if not check_script.exists():
        check_script = ROOT / "fullstack" / "scripts" / "check_licenses.py"
    subprocess.run([sys.executable, str(check_script)], check=True)

    for probe, label in [
        (FRONTEND_DIR / "package.json", "frontend"),
        (BACKEND_DIR / "app", "backend/app"),
    ]:
        if not probe.exists():
            print(f"[ERROR] {label} が見つかりません: {probe}", file=sys.stderr)
            print(f"[ERROR] ROOT の解決を確認してください: {ROOT}", file=sys.stderr)
            return 1

    # 1-3. Download & cache Pyodide & wheels
    pyodide_files, pure_wheels = prepare_pyodide_assets()

    # Package backend app
    app_zip = package_backend_app()

    # 4. Build frontend
    build_frontend()

    # 5. Assemble all assets into dist/static
    assemble_dist_static(pyodide_files, pure_wheels, app_zip)

    # Count total size
    total_size = sum(f.stat().st_size for f in DIST_STATIC.rglob("*") if f.is_file())
    total_mb = total_size / (1024 * 1024)
    file_count = sum(1 for f in DIST_STATIC.rglob("*") if f.is_file())

    # 6. Package standalone zip
    zip_path = DIST_STATIC.parent / "davis-pcp-static.zip"
    print(f"\n[6/6] Packaging standalone zip: {zip_path.name} ...")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(DIST_STATIC.rglob("*")):
            if p.is_file():
                arcname = f"static/{p.relative_to(DIST_STATIC).as_posix()}"
                zf.write(p, arcname)
    zip_mb = zip_path.stat().st_size / (1024 * 1024)

    print("\n" + "=" * 60)
    print(f" SUCCESS: Static build complete in {DIST_STATIC}")
    print(f" Total size: {total_mb:.1f} MB across {file_count} files")
    print(f" Standalone ZIP: {zip_path.name} ({zip_mb:.1f} MB)")
    print(" To test locally:")
    print(f"   python -m http.server -d dist/static 8421")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
