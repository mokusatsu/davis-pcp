"""DAVIS-PCP Local Distribution Builder.

Packages the fullstack application into `dist/local` for direct native execution:
1. Builds the frontend in production mode (SPA with HTTP API client)
2. Copies backend application and fixtures to `dist/local/backend`
3. Copies frontend dist to `dist/local/frontend/dist`
4. Writes runtime `requirements.txt`
5. Sets up `dist/local/workspace` directory
6. Generates `dist/local/run-local.bat`, `dist/local/run.bat`, and `dist/run-local.bat`
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

# このファイルは fullstack/scripts/ 配下にあるため、リポジトリルートは2階層上
ROOT_DIR = Path(__file__).resolve().parents[2]
FULLSTACK_DIR = ROOT_DIR / "fullstack"
FRONTEND_DIR = FULLSTACK_DIR / "frontend"
BACKEND_DIR = FULLSTACK_DIR / "backend"
FIXTURES_DIR = FULLSTACK_DIR / "fixtures"
DIST_DIR = ROOT_DIR / "dist"
DIST_LOCAL = DIST_DIR / "local"

RUNTIME_REQUIREMENTS = """fastapi==0.139.2
uvicorn[standard]==0.51.0
pydantic==2.13.4
polars==1.43.2
numpy==2.4.6
pyarrow==25.0.1
scipy==1.18.0
scikit-learn==1.9.0
httpx==0.28.1
python-multipart==0.0.32
"""

BAT_CONTENT = """@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ===================================================
echo  DAVIS-PCP Local Server Launcher
echo ===================================================
echo.

:: 1. Determine target directory (dist/local)
set "BASE_DIR=%~dp0"
if exist "%BASE_DIR%local\\requirements.txt" (
    set "TARGET_DIR=%BASE_DIR%local"
) else if exist "%BASE_DIR%requirements.txt" (
    set "TARGET_DIR=%BASE_DIR%"
) else (
    echo [ERROR] requirements.txt was not found in "%BASE_DIR%"!
    pause
    exit /b 1
)

:: Strip trailing backslash
if "%TARGET_DIR:~-1%"=="\\" set "TARGET_DIR=%TARGET_DIR:~0,-1%"

set "VENV_DIR=%TARGET_DIR%\\.venv"
set "VENV_PYTHON=%VENV_DIR%\\Scripts\\python.exe"

:: 2. If venv already exists, skip to dependency check
if exist "%VENV_PYTHON%" (
    goto :CHECK_DEPS
)

:: 3. Python Detection & winget Installation
echo [1/4] Checking for Python environment (Python 3.10+)...
set "PY_CMD="

:: Try finding python on PATH
where python >nul 2>nul
if %errorlevel% equ 0 (
    for /f "delims=" %%i in ('where python 2^>nul') do (
        if not defined PY_CMD (
            %%i -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
            if !errorlevel! equ 0 (
                set "PY_CMD=%%i"
            )
        )
    )
)

:: If not found, try py launcher
if not defined PY_CMD (
    where py >nul 2>nul
    if %errorlevel% equ 0 (
        py -3.12 -c "pass" >nul 2>&1
        if !errorlevel! equ 0 (
            set "PY_CMD=py -3.12"
        ) else (
            py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>&1
            if !errorlevel! equ 0 (
                set "PY_CMD=py -3"
            )
        )
    )
)

:: If Python is still not found, use winget to install Python 3.12
if not defined PY_CMD (
    echo Python 3.10+ was not found on this machine.
    echo Attempting to install Python 3.12 via winget...
    where winget >nul 2>nul
    if %errorlevel% neq 0 (
        echo [ERROR] Neither Python nor winget was found.
        echo Please install Python 3.12 manually from https://www.python.org/
        pause
        exit /b 1
    )

    echo Running: winget install --id Python.Python.3.12 --exact --silent --accept-package-agreements --accept-source-agreements
    winget install --id Python.Python.3.12 --exact --silent --accept-package-agreements --accept-source-agreements
    if %errorlevel% neq 0 (
        echo [WARNING] winget returned code %errorlevel%.
    )

    :: Refresh PATH or probe standard paths
    if exist "%LocalAppData%\\Programs\\Python\\Python312\\python.exe" (
        set "PY_CMD=%LocalAppData%\\Programs\\Python\\Python312\\python.exe"
    ) else if exist "%ProgramFiles%\\Python312\\python.exe" (
        set "PY_CMD=%ProgramFiles%\\Python312\\python.exe"
    ) else if exist "%WINDIR%\\py.exe" (
        set "PY_CMD=%WINDIR%\\py.exe -3.12"
    ) else (
        for /f "tokens=2*" %%a in ('reg query "HKCU\\Environment" /v Path 2^>nul') do set "PATH=%%b;!PATH!"
        for /f "tokens=2*" %%a in ('reg query "HKLM\\System\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path 2^>nul') do set "PATH=%%b;!PATH!"
        where python >nul 2>nul
        if !errorlevel! equ 0 (
            set "PY_CMD=python"
        ) else (
            echo [ERROR] Python 3.12 was installed but could not be located.
            echo Please open a new command prompt or restart your computer.
            pause
            exit /b 1
        )
    )
)

echo Python located: %PY_CMD%

:: 4. Create Virtual Environment (.venv)
echo [2/4] Creating virtual environment in "%VENV_DIR%"...
%PY_CMD% -m venv "%VENV_DIR%"
if not exist "%VENV_PYTHON%" (
    echo [ERROR] Failed to create virtual environment.
    pause
    exit /b 1
)

:CHECK_DEPS
:: 5. Install dependencies from requirements.txt
echo [3/4] Checking virtual environment dependencies...
set "NEED_INSTALL=0"
if not exist "%VENV_DIR%\\.installed" (
    set "NEED_INSTALL=1"
) else (
    "%VENV_PYTHON%" -c "import uvicorn, fastapi, polars, pyarrow, scipy, sklearn, httpx" >nul 2>&1
    if !errorlevel! neq 0 (
        set "NEED_INSTALL=1"
    )
)

if "%NEED_INSTALL%"=="1" (
    echo Installing required packages from "%TARGET_DIR%\\requirements.txt"...
    echo This may take a few moments on first launch.
    "%VENV_PYTHON%" -m pip install --upgrade pip
    "%VENV_PYTHON%" -m pip install -r "%TARGET_DIR%\\requirements.txt"
    if !errorlevel! neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo installed > "%VENV_DIR%\\.installed"
    echo Dependencies successfully installed.
) else (
    echo All dependencies are satisfied.
)

:: 6. Start Uvicorn Server and Launch Browser
echo [4/4] Launching DAVIS-PCP Local Server...
echo Server URL: http://127.0.0.1:8420/
echo Press Ctrl+C in this console to stop the server.
echo.

set "READY_FILE=%TARGET_DIR%\\.server_ready"
if exist "%READY_FILE%" del /f /q "%READY_FILE%"
set "DAVIS_PCP_READY_FILE=%READY_FILE%"
set "DAVIS_PCP_URL=http://127.0.0.1:8420/"
set "DAVIS_PCP_WORKSPACE=%TARGET_DIR%\\workspace"
set "DAVIS_PCP_FRONTEND_DIST=%TARGET_DIR%\\frontend\\dist"

:: Start background watcher to wait for Uvicorn ready flag and health response before opening browser
start "" /b "%VENV_PYTHON%" "%TARGET_DIR%\\backend\\app\\open_browser.py"

"%VENV_PYTHON%" -m uvicorn app.main:app --host 127.0.0.1 --port 8420 --app-dir "%TARGET_DIR%\\backend"

if exist "%READY_FILE%" del /f /q "%READY_FILE%"
"""


def build_frontend() -> None:
    print("\n--- [Step 1] Building Frontend in Production Mode ---")
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    cmd = [npm_cmd, "run", "build"]
    print(f"Running: {' '.join(cmd)} in {FRONTEND_DIR}")
    res = subprocess.run(cmd, cwd=FRONTEND_DIR)
    if res.returncode != 0:
        raise RuntimeError(f"Frontend build failed with exit code {res.returncode}")
    print("Frontend build complete.")


def assemble_dist_local() -> None:
    print("\n--- [Step 2] Assembling dist/local ---")
    DIST_LOCAL.mkdir(parents=True, exist_ok=True)

    # 1. Copy backend code
    backend_dest = DIST_LOCAL / "backend"
    if backend_dest.exists():
        shutil.rmtree(backend_dest)
    backend_dest.mkdir(parents=True, exist_ok=True)

    # Copy app/
    shutil.copytree(
        BACKEND_DIR / "app",
        backend_dest / "app",
        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo"),
    )

    # Copy fixtures/ if present
    if FIXTURES_DIR.exists():
        fixtures_dest = backend_dest / "fixtures"
        shutil.copytree(
            FIXTURES_DIR,
            fixtures_dest,
            dirs_exist_ok=True,
        )
        # Also copy to dist/local/fixtures for multi-path resolution
        shutil.copytree(
            FIXTURES_DIR,
            DIST_LOCAL / "fixtures",
            dirs_exist_ok=True,
        )

    # 2. Copy frontend/dist
    frontend_dist_dest = DIST_LOCAL / "frontend" / "dist"
    if frontend_dist_dest.exists():
        shutil.rmtree(frontend_dist_dest)
    frontend_dist_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(FRONTEND_DIR / "dist", frontend_dist_dest)

    # 3. Ensure Rust graph_core.wasm is in frontend/dist/wasm as well
    rust_wasm = (
        FRONTEND_DIR
        / "rust"
        / "graph-core"
        / "target"
        / "wasm32-unknown-unknown"
        / "release"
        / "graph_core.wasm"
    )
    if rust_wasm.exists():
        wasm_dir = frontend_dist_dest / "wasm"
        wasm_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(rust_wasm, wasm_dir / "graph_core.wasm")

    # 4. Write requirements.txt
    (DIST_LOCAL / "requirements.txt").write_text(RUNTIME_REQUIREMENTS, encoding="utf-8")

    # 5. Create workspace directory
    workspace_dir = DIST_LOCAL / "workspace"
    workspace_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("datasets", "sessions", "jobs", "exports"):
        (workspace_dir / sub).mkdir(parents=True, exist_ok=True)
    (workspace_dir / ".gitkeep").write_text("", encoding="utf-8")

    # 6. Write batch runners
    (DIST_LOCAL / "run-local.bat").write_text(BAT_CONTENT, encoding="utf-8")
    (DIST_LOCAL / "run.bat").write_text(BAT_CONTENT, encoding="utf-8")
    (DIST_DIR / "run-local.bat").write_text(BAT_CONTENT, encoding="utf-8")

    # 7. Clean distribution artifacts (.venv, __pycache__, *.pyc)
    clean_dist_local()

    print(f"Assembled local build in {DIST_LOCAL}")


def clean_dist_local() -> None:
    """Ensure dist/local is free of virtual environments and Python bytecode cache."""
    venv_dir = DIST_LOCAL / ".venv"
    if venv_dir.exists():
        shutil.rmtree(venv_dir, ignore_errors=True)

    ready_file = DIST_LOCAL / ".server_ready"
    if ready_file.exists():
        try:
            ready_file.unlink()
        except OSError:
            pass

    for pycache in list(DIST_LOCAL.rglob("__pycache__")):
        if pycache.is_dir():
            shutil.rmtree(pycache, ignore_errors=True)

    for pyc in list(DIST_LOCAL.rglob("*.py[co]")):
        if pyc.is_file():
            try:
                pyc.unlink()
            except OSError:
                pass



def main() -> int:
    print("=" * 60)
    print(" DAVIS-PCP Standalone Local Package Builder")
    print("=" * 60)

    # 0. Check license coverage
    check_script = ROOT_DIR / "scripts" / "check_licenses.py"
    if not check_script.exists():
        check_script = FULLSTACK_DIR / "scripts" / "check_licenses.py"
    subprocess.run([sys.executable, str(check_script)], check=True)

    build_frontend()
    assemble_dist_local()

    total_size = sum(f.stat().st_size for f in DIST_LOCAL.rglob("*") if f.is_file())
    total_mb = total_size / (1024 * 1024)
    file_count = sum(1 for f in DIST_LOCAL.rglob("*") if f.is_file())

    print("\n" + "=" * 60)
    print(f" SUCCESS: Local build complete in {DIST_LOCAL}")
    print(f" Total size: {total_mb:.1f} MB across {file_count} files")
    print(" To test locally:")
    print(f"   dist\\run-local.bat  (or dist\\local\\run-local.bat)")
    print("=" * 60)
    return 0


if __name__ == "__main__":
    sys.exit(main())
