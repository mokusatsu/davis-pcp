#!/usr/bin/env python3
"""OSS License Coverage Checker.

Ensures all production dependencies in frontend/package.json
and backend/requirements.txt are documented in licenses.json.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

# このファイルは fullstack/scripts/ 配下にあるため、fullstack ルートは1階層上
FULLSTACK_DIR = Path(__file__).resolve().parents[1]
ROOT_DIR = FULLSTACK_DIR.parents[0]
FRONTEND_DIR = FULLSTACK_DIR / "frontend"
BACKEND_DIR = FULLSTACK_DIR / "backend"
LICENSES_JSON = FRONTEND_DIR / "src" / "data" / "licenses.json"
PACKAGE_JSON = FRONTEND_DIR / "package.json"
REQUIREMENTS_TXT = BACKEND_DIR / "requirements.txt"


def verify_licenses() -> bool:
    print("[license-check] Verifying OSS license coverage...")
    if not LICENSES_JSON.exists():
        print(f"[ERROR] licenses.json not found at {LICENSES_JSON}", file=sys.stderr)
        return False

    with LICENSES_JSON.open("r", encoding="utf-8") as f:
        data = json.load(f)

    packages = data.get("packages", [])
    registered_names = {pkg["name"].lower(): pkg for pkg in packages if "name" in pkg}

    # Verify required fields
    for pkg in packages:
        for field in ("name", "license", "text", "copyright"):
            if not pkg.get(field):
                print(f"[ERROR] Package {pkg.get('name')} missing required field: {field}", file=sys.stderr)
                return False

    has_error = False

    # Check frontend dependencies
    if PACKAGE_JSON.exists():
        with PACKAGE_JSON.open("r", encoding="utf-8") as f:
            pkg_json = json.load(f)
        deps = list(pkg_json.get("dependencies", {}).keys())
        print(f"[license-check] Checking {len(deps)} frontend dependencies...")
        for dep in deps:
            if dep.lower() not in registered_names:
                print(f"[ERROR] Frontend dependency '{dep}' is missing from licenses.json!", file=sys.stderr)
                has_error = True

    # Check backend dependencies
    if REQUIREMENTS_TXT.exists():
        backend_pkgs = []
        with REQUIREMENTS_TXT.open("r", encoding="utf-8") as f:
            for line in f:
                trimmed = line.strip()
                if not trimmed or trimmed.startswith("#"):
                    continue
                match = re.match(r"^([a-zA-Z0-9_\-]+)", trimmed)
                if match:
                    name = match.group(1)
                    if name.lower() not in ("pytest", "playwright"):
                        backend_pkgs.append(name)
        print(f"[license-check] Checking {len(backend_pkgs)} backend production dependencies...")
        for pkg in backend_pkgs:
            if pkg.lower() not in registered_names:
                print(f"[ERROR] Backend dependency '{pkg}' is missing from licenses.json!", file=sys.stderr)
                has_error = True

    if has_error:
        print("\n[FAILED] OSS License check failed. Register missing packages in licenses.json before building.\n", file=sys.stderr)
        return False

    print(f"[SUCCESS] All dependencies are fully covered in licenses.json ({len(packages)} packages total).\n")
    return True


if __name__ == "__main__":
    if not verify_licenses():
        sys.exit(1)
