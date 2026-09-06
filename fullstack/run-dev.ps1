# DAVIS-PCP Fullstack v2.0.0 — development launcher (Windows)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "[DAVIS-PCP] starting backend on 127.0.0.1:8420 ..."
$backend = Start-Process -PassThru python `
  -ArgumentList "-m","uvicorn","app.main:app","--host","127.0.0.1","--port","8420","--app-dir","$root/backend" `
  -WindowStyle Hidden

Write-Host "[DAVIS-PCP] starting frontend (Vite) on http://localhost:5173 ..."
Push-Location "$root/frontend"
$frontend = Start-Process -PassThru npm -ArgumentList "run","dev" -NoNewWindow
Pop-Location

Write-Host ""
Write-Host "Backend : http://127.0.0.1:8420/api/v1/health"
Write-Host "Frontend: http://localhost:5173"
Write-Host "Press Ctrl+C to stop."
try { Wait-Process -Id $frontend.Id } finally {
  try { Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue } catch {}
}
