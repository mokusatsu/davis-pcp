"""テスト用ヘルパ（codebook spec 組立て・近似比較）。

監査バンドル同梱 stats_tests/support.py の Target（AST 抽出・CLI 依存）を除き、
リポジトリ運用に必要な spec/codebook/assert_nullable_close のみを引き継ぐ。
数値期待値の定義は変えない。
"""
from __future__ import annotations

from typing import Any


def spec(name, scale="nominal", role="question", **kw):
    return {"columnId": name, "name": name, "label": name, "scaleType": scale, "role": role,
            "missingCodes": [], "valueLabels": {}, **kw}


def codebook(*columns, **kw):
    return {"schemaVersion": 1, "schemaRevision": 1, "columns": list(columns), **kw}


def assert_nullable_close(actual, expected, **kw):
    import pytest
    if expected is None:
        assert actual is None
    else:
        assert actual == pytest.approx(expected, **kw)
