"""stats_tests 用の pytest/conftest。

監査バンドル davis_pcp_statistical_tests_20260911.zip 同梱の統計検証テストを、
リポジトリの pytest 運用（fullstack/pytest.ini, testpaths = backend/tests）で
実行するための最小限の橋渡し。テスト本体の期待値・fixture は変更しない。

- backend/ を sys.path に追加し、テスト内の `from app...` / `import app...`
  を解決する（通常の backend/tests と同じ解決）。
- stats_tests/ を sys.path に追加し、テスト内の `from . import oracles` 等の
  相対 import を両ランナーで解決する。
- `target` / `pl` フィクスチャを提供する。本家 conftest.py は
  --target-backend / --kernel-only / --with-r オプションを要求するが、
  リポジトリ運用では常にこのツリーの backend を対象にフルモード実行する。
  R テスト（test_r_90）は Rscript なしでは skip する（--with-r 相当の厳格
  モードは CI 側で別途 R 導入時に有効化すること）。
- DAVIS_PCP_WORKSPACE を tempfile 専用領域に設定し、隔離実行する。
  製品 API を先に import 済みのプロセスでは停止する（監査 README の安全規定）。
  CI では独立ジョブとして登録し、全 backend テストと同一プロセスに
  混ぜないこと（survey_audit と同様）。
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

if any(k.startswith("app.api.") for k in sys.modules):
    raise RuntimeError(
        "既存アプリをimportしたプロセスでは実行しないでください。"
        "統計テストは新規Pythonプロセスで実行します。"
    )

_WORK = tempfile.TemporaryDirectory(prefix="davis-statistical-tests-")
os.environ["DAVIS_PCP_WORKSPACE"] = _WORK.name
from app.config import settings  # noqa: E402

settings.workspace_dir = Path(_WORK.name)
settings.ensure_dirs()


class Target:
    """本家 stats_tests/support.py::Target のフルモード相当。"""

    def __init__(self) -> None:
        self.cache: dict[str, object] = {}
        self.extracted: dict[str, object] = {}

    def module(self, name: str):
        if name in self.cache:
            return self.cache[name]
        import importlib

        module = importlib.import_module("app." + name)
        self.cache[name] = module
        return module


@pytest.fixture(scope="session")
def target():
    return Target()


@pytest.fixture(scope="session")
def pl():
    import polars

    return polars
