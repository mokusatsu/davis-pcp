"""監査専用の合成データと隔離workspace。製品ロジックは置換しない。"""
from __future__ import annotations
import atexit
import inspect
import os
import shutil
import sys
import tempfile
import unittest
import uuid
from pathlib import Path

# コピー先: <project>/backend/tests/survey_audit。別配置は DAVIS_AUDIT_BACKEND を指定。
BACKEND = Path(os.environ.get('DAVIS_AUDIT_BACKEND', Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(BACKEND))
if any(k.startswith('app.api.') for k in sys.modules):
    raise RuntimeError('既存アプリをimportしたプロセスでは実行しないでください。監査は新規Pythonプロセスで実行します。')
WORKSPACE = Path(tempfile.mkdtemp(prefix='davis-survey-audit-'))
os.environ['DAVIS_PCP_WORKSPACE'] = str(WORKSPACE)
from app.config import settings
settings.workspace_dir = WORKSPACE
settings.ensure_dirs()
atexit.register(lambda: shutil.rmtree(WORKSPACE, ignore_errors=True))

import polars as pl
from fastapi import UploadFile
from app.api import datasets as ds
from app.api import summaries as sm
from app.domain.errors import BizError
from pydantic import ValidationError


def fixture(data: dict, patches: dict | None = None, *, weight=None, design=None) -> str:
    did = 'audit-' + uuid.uuid4().hex[:16]
    ds._finalize_dataset(did, 'synthetic-audit', 'csv', pl.DataFrame(data, strict=False), None)
    cols = {c['name']: c for c in cb(did)['columns']}
    req = {'columns': [{'columnId': cols[k]['columnId'], **v} for k, v in (patches or {}).items()]}
    if weight:
        req['weightConfig'] = {'weightColumnId': cols[weight[0]]['columnId'], 'weightType': weight[1]}
    if design is not None:
        req['surveyDesign'] = {k: cols[v]['columnId'] if isinstance(v, str) and v in cols else v for k, v in design.items()}
    if req['columns'] or weight or design is not None:
        ds.update_codebook(did, req)
    return did


def cb(did): return ds.store.load_codebook(did)
def frame(did): return ds.store.get_dataframe(did)
def spec(did, name): return next(c for c in cb(did)['columns'] if c['name'] == name)
def column_id(did, name): return spec(did, name)['columnId']
def context(did, **kw):
    return {'datasetId': did, 'expectedDataRevision': ds.store.get_meta(did)['dataRevision'],
            'expectedSchemaRevision': cb(did)['schemaRevision'], **kw}
def summary(did, columns=None, **kw):
    return sm.summaries(sm.SummaryRequest(datasetId=did, columns=columns, **kw))
def xtab(did, inference='auto', **kw):
    return sm.crosstab_summary(sm.CrosstabRequest(context=context(did, **kw),
        rowVariableId=column_id(did, 'a'), colVariableId=column_id(did, 'b'), inference=inference))


def import_memory_package(payload: bytes) -> dict:
    """実import_packageを、メモリ内UploadFileで直接試す。

    通常の unittest.TestCase から利用する。SpooledTemporaryFile はrollover前のため
    UploadFile.readはI/O待機しない。新しい実装が実非同期I/Oを導入した場合は、この
    helperが明示エラーとなるためIsolatedAsyncioTestCaseへ移行する。例外を成功扱いしない。
    HTTPルーティング・並行処理のテストではない。
    """
    with tempfile.SpooledTemporaryFile(max_size=max(len(payload) + 1, 1024), mode='w+b') as f:
        f.write(payload)
        f.seek(0)
        coroutine = ds.import_package(UploadFile(filename='audit.zip', file=f))
        try:
            yielded = coroutine.send(None)
        except StopIteration as completed:
            return completed.value
        finally:
            coroutine.close()
        raise RuntimeError(f'非同期I/Oが追加されました。asyncテストへ変更が必要です: {yielded!r}')


A = ['x', 'x', 'x', 'y', 'y', 'y']
B = ['u', 'u', 'v', 'u', 'v', 'v']
WEIGHT_PATCH = {'a': {'scaleType': 'nominal'}, 'b': {'scaleType': 'nominal'},
                'w': {'role': 'weight', 'scaleType': 'ratio'}}
REVERSED_PATCH = {'g': {'role': 'attribute', 'scaleType': 'nominal'},
    'q': {'role': 'question', 'scaleType': 'interval', 'categoryOrder': ['1','2','3','4','5'],
          'isReversed': True, 'missingCodes': ['99']}}


class AuditCase(unittest.TestCase):
    def ok(self, fn, *args, **kwargs):
        """予期しない製品例外をFAILに分類。実装例外のtraceはassertionに残す。"""
        try:
            return fn(*args, **kwargs)
        except Exception as exc:
            self.fail(f'正常応答が必要: {type(exc).__name__}: {exc}')

    def rejects(self, fn, *args, status=422, **kwargs):
        with self.assertRaises((BizError, ValidationError)) as caught:
            fn(*args, **kwargs)
        actual_status = caught.exception.status_code if isinstance(caught.exception, BizError) else 422
        self.assertEqual(actual_status, status)
        return caught.exception
