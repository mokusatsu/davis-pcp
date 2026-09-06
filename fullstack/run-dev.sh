#!/usr/bin/env bash
# DAVIS-PCP Fullstack v2.0.0 — development launcher (Linux/macOS/Git Bash)
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"

echo "[DAVIS-PCP] starting backend on 127.0.0.1:8420 ..."
python -m uvicorn app.main:app --host 127.0.0.1 --port 8420 --app-dir "$root/backend" &
backend_pid=$!

cleanup() { kill "$backend_pid" 2>/dev/null || true; }
trap cleanup EXIT

echo "[DAVIS-PCP] starting frontend (Vite) on http://localhost:5173 ..."
cd "$root/frontend"
npm run dev
