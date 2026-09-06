# DAVIS-PCP Fullstack v2.0.0 — production launcher (Windows)
# Builds the frontend (if needed) and serves everything from one URL.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$root/frontend/dist/index.html")) {
  Write-Host "[DAVIS-PCP] frontend build ..."
  Push-Location "$root/frontend"; npm run build; Pop-Location
}

Write-Host "[DAVIS-PCP] production server: http://127.0.0.1:8420"
python -m uvicorn app.main:app --host 127.0.0.1 --port 8420 --app-dir "$root/backend"
