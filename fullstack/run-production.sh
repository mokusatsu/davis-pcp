#!/usr/bin/env bash
# DAVIS-PCP Fullstack v2.0.0 — production launcher (Linux/macOS/Git Bash)
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "$root/frontend/dist/index.html" ]; then
  echo "[DAVIS-PCP] frontend build ..."
  (cd "$root/frontend" && npm run build)
fi

echo "[DAVIS-PCP] production server: http://127.0.0.1:8420"
exec python -m uvicorn app.main:app --host 127.0.0.1 --port 8420 --app-dir "$root/backend"
