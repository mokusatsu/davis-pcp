"""survey_audit 用の pytest/conftest。

監査バンドル同梱の unittest 形式テストを、リポジトリの pytest 運用
（fullstack/pytest.ini, testpaths = backend/tests）で実行するための
最小限の橋渡し。テスト本体の期待値・fixture は変更しない。

- DAVIS_AUDIT_BACKEND を fullstack/backend に固定し、audit_support の
  BACKEND 解決をこのツリーに向ける。
- survey_audit ディレクトリを sys.path に追加し、テスト内の
  `from audit_support import *` を両ランナーで解決する。
  （python -m unittest discover -s backend/tests/survey_audit でも同様に解決する）
- 監査テストは合成 fixture のみを使い、tempfile 専用 workspace で実行する。
  製品 API を先に import 済みのプロセスでは audit_support が停止する
  （バンドル README の安全規定どおり）。CI では独立ジョブとして登録し、
  全 backend テストと同一プロセスに混ぜないこと。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[2]
os.environ.setdefault("DAVIS_AUDIT_BACKEND", str(BACKEND))

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
