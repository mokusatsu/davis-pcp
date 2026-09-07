"""Automated verification test for DAVIS-PCP Local Distribution (dist/local)."""
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT_DIR = Path(__file__).resolve().parents[1]
DIST_LOCAL = ROOT_DIR / "dist" / "local"
VENV_PYTHON = DIST_LOCAL / ".venv" / "Scripts" / "python.exe"
PORT = 8420
BASE_URL = f"http://127.0.0.1:{PORT}"


def main() -> int:
    python_exe = VENV_PYTHON if VENV_PYTHON.exists() else Path(sys.executable)
    print(f"Using Python executable: {python_exe}")

    ready_file = DIST_LOCAL / ".server_ready"
    if ready_file.exists():
        ready_file.unlink()

    env = os.environ.copy()
    env["DAVIS_PCP_WORKSPACE"] = str(DIST_LOCAL / "workspace")
    env["DAVIS_PCP_FRONTEND_DIST"] = str(DIST_LOCAL / "frontend" / "dist")
    env["DAVIS_PCP_READY_FILE"] = str(ready_file)

    cmd = [
        str(python_exe),
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(PORT),
        "--app-dir",
        str(DIST_LOCAL / "backend"),
    ]

    print(f"Starting server: {' '.join(cmd)}")
    proc = subprocess.Popen(
        cmd,
        cwd=str(DIST_LOCAL),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    try:
        # Wait up to 15 seconds for server to be responsive
        print("Waiting for server to become responsive...")
        ready = False
        for _ in range(30):
            try:
                res = httpx.get(f"{BASE_URL}/api/v1/health", timeout=1.0)
                if res.status_code == 200:
                    ready = True
                    break
            except Exception:
                pass
            time.sleep(0.5)

        if not ready:
            print("[ERROR] Server did not become ready in time.")
            return 1

        print("Server is responsive! Running tests...")

        # Test 0: Ready flag output
        assert ready_file.exists(), f"Ready flag was not found at {ready_file}!"
        print(f" [PASS] 0. Server ready flag generated at {ready_file}")

        # Test 1: Frontend root HTML
        res_html = httpx.get(f"{BASE_URL}/", timeout=5.0)
        assert res_html.status_code == 200, f"HTML returned {res_html.status_code}"
        assert '<div id="root">' in res_html.text, "Root div missing in index.html"
        print(" [PASS] 1. Frontend index.html served correctly")

        # Test 2: Static assets
        res_assets = httpx.get(f"{BASE_URL}/assets/index-DCO6Ry9B.css", timeout=5.0)
        assert res_assets.status_code in (200, 304), f"CSS returned {res_assets.status_code}"
        print(" [PASS] 2. Static assets served correctly")

        # Test 3: Health check
        res_health = httpx.get(f"{BASE_URL}/api/v1/health", timeout=5.0)
        assert res_health.status_code == 200
        health_data = res_health.json()
        assert health_data.get("status") == "ok"
        print(f" [PASS] 3. Health check returned: {health_data}")

        # Test 4: Import built-in Iris sample dataset
        res_import = httpx.post(f"{BASE_URL}/api/v1/datasets/import/sample", timeout=10.0)
        assert res_import.status_code == 200, f"Import sample returned {res_import.status_code}: {res_import.text}"
        import_data = res_import.json()
        dataset_id = import_data.get("datasetId")
        assert dataset_id, f"datasetId missing in response: {import_data}"
        print(f" [PASS] 4. Iris sample imported successfully: datasetId={dataset_id}, rowCount={import_data.get('rowCount')}")

        # Test 5: Fetch Dataset details
        res_ds = httpx.get(f"{BASE_URL}/api/v1/datasets/{dataset_id}", timeout=5.0)
        assert res_ds.status_code == 200
        ds_data = res_ds.json()
        assert "Iris" in ds_data.get("name", "")
        print(f" [PASS] 5. Dataset metadata fetched: {ds_data.get('name')}")

        # Test 6: Arrow IPC stream
        res_arrow = httpx.get(f"{BASE_URL}/api/v1/datasets/{dataset_id}/arrow", timeout=5.0)
        assert res_arrow.status_code == 200
        assert len(res_arrow.content) > 0
        print(f" [PASS] 6. Arrow IPC stream received: {len(res_arrow.content)} bytes")

        # Test 7: PCA analysis
        pca_payload = {
            "datasetId": dataset_id,
            "columns": ["sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm"],
            "nComponents": 2,
        }
        res_pca = httpx.post(f"{BASE_URL}/api/v1/models/pca", json=pca_payload, timeout=10.0)
        assert res_pca.status_code == 200, f"PCA failed: {res_pca.text}"
        pca_data = res_pca.json()
        assert "explainedVarianceRatio" in pca_data
        print(f" [PASS] 7. PCA analysis executed: variance={pca_data['explainedVarianceRatio']}")

        print("\n============================================================")
        print(" ALL TESTS PASSED FOR dist/local!")
        print("============================================================")
        return 0

    finally:
        print("Stopping uvicorn server...")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
