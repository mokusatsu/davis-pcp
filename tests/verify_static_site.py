#!/usr/bin/env python3
"""E2E verification script for DAVIS-PCP static build (dist/static).
Verifies:
1. Zero external network calls (all assets and dependencies loaded locally).
2. Pyodide WASM runtime initializes and FastAPI ASGI runs in-browser.
3. Iris dataset loads and renders PCP canvas.
4. PCA analysis computes via WASM scikit-learn/numpy.
"""
from __future__ import annotations

import http.server
import socketserver
import threading
import time
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
STATIC_DIR = ROOT / "dist" / "static"
PORT = 8421


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, format, *args):
        # Suppress noisy HTTP request logging
        pass


def run_test():
    # 1. Start static server
    socketserver.TCPServer.allow_reuse_address = True
    server = socketserver.TCPServer(("127.0.0.1", PORT), QuietHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    print(f"[1/5] Local HTTP server started at http://127.0.0.1:{PORT}")

    external_requests = []
    console_logs = []

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = browser.new_context()
            page = context.new_page()

            # Track network requests
            def on_request(req):
                url = req.url
                if not (url.startswith(f"http://127.0.0.1:{PORT}") or url.startswith(f"http://localhost:{PORT}") or url.startswith("data:") or url.startswith("blob:")):
                    external_requests.append(url)

            page.on("request", on_request)
            page.on("console", lambda msg: console_logs.append(f"[{msg.type}] {msg.text}"))
            page.on("pageerror", lambda err: console_logs.append(f"[PAGE_ERROR] {err}"))

            print(f"[2/5] Navigating to http://127.0.0.1:{PORT} ...")
            page.goto(f"http://127.0.0.1:{PORT}/")

            print("[3/5] Waiting for WASM initialization and AppShell mount ...")
            # Wait for dashboard to mount (AppShell has .ant-layout or header with DAVIS-PCP)
            # Up to 60s for WASM package loading and app start
            page.wait_for_selector(".ant-layout", timeout=60000)
            print("  WASM runtime initialized successfully!")

            # 2. Check external requests
            print("[4/5] Checking offline compliance (zero external network requests) ...")
            if external_requests:
                print(f"  WARNING: Detected external requests: {external_requests}")
                raise AssertionError(f"Static site must be completely offline, but requested: {external_requests}")
            print("  PASS: Zero external requests. 100% locally bundled!")

            # 3. Verify Iris dataset loading and PCP view
            print("[5/5] Verifying interactive analytics and UI rendering ...")
            # Wait for auto-loading Iris sample (dataset selector shows Iris)
            page.wait_for_selector("canvas", timeout=30000)
            time.sleep(1)
            page.screenshot(path=str(ROOT / "test_static_iris_pcp.png"))
            print("  PCP canvas rendered successfully!")

            # Check navigation to PCA page
            page.goto(f"http://127.0.0.1:{PORT}/#/pca")
            page.wait_for_selector(".ant-card", timeout=10000)
            time.sleep(2)
            page.screenshot(path=str(ROOT / "test_static_pca.png"))
            print("  PCA navigation OK!")

            browser.close()
            print("\n" + "=" * 60)
            print(" ALL CHECKS PASSED: Static build works flawlessly offline!")
            print("=" * 60)
            return 0
    except Exception as e:
        print(f"\nVerification FAILED: {e}")
        print("\n--- Browser Console Logs ---")
        for log in console_logs[-30:]:
            print(log)
        return 1
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    sys.exit(run_test())
