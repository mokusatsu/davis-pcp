"""Wait for DAVIS-PCP Uvicorn server to start listening, then open the browser."""
from __future__ import annotations

import os
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path


def wait_and_open_browser(timeout_seconds: float = 60.0, poll_interval: float = 0.5) -> bool:
    ready_file = os.environ.get("DAVIS_PCP_READY_FILE")
    target_url = os.environ.get("DAVIS_PCP_URL", "http://127.0.0.1:8420/")
    health_url = target_url.rstrip("/") + "/api/v1/health"

    max_attempts = int(timeout_seconds / poll_interval)
    for _ in range(max_attempts):
        flag_exists = False
        if ready_file:
            try:
                flag_exists = Path(ready_file).exists()
            except Exception:
                pass

        if flag_exists:
            try:
                req = urllib.request.Request(health_url, headers={"User-Agent": "DAVIS-PCP-Launcher"})
                with urllib.request.urlopen(req, timeout=1.0) as resp:
                    if resp.status == 200:
                        time.sleep(0.2)
                        webbrowser.open(target_url)
                        return True
            except Exception:
                pass
        time.sleep(poll_interval)
    return False


def main() -> int:
    success = wait_and_open_browser()
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
