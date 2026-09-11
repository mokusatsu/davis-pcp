"""独立プロセスで実行。FAIL/ERRORは非ゼロ終了。JSONとJUnit XMLを保存。"""
from __future__ import annotations
import argparse
import importlib.metadata
import json
import platform
import sys
import time
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


class RecordingResult(unittest.TextTestResult):
    records: list
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        self.records=[]
    def startTest(self,test):
        self.started=time.perf_counter()
        super().startTest(test)
    def record(self,test,status,detail=None):
        self.records.append({'test':test.id(),'status':status,'seconds':time.perf_counter()-self.started,'detail':detail})
    def addSuccess(self,test):
        super().addSuccess(test);self.record(test,'PASS')
    def addFailure(self,test,err):
        super().addFailure(test,err);self.record(test,'FAIL',self._exc_info_to_string(err,test))
    def addError(self,test,err):
        super().addError(test,err);self.record(test,'ERROR',self._exc_info_to_string(err,test))
    def addSkip(self,test,reason):
        super().addSkip(test,reason);self.record(test,'SKIP',reason)


def main(argv=None):
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,default=Path('audit-results'))
    args=parser.parse_args(argv)
    here=Path(__file__).resolve().parent
    suite=unittest.defaultTestLoader.discover(str(here),pattern='test_*.py')
    result=unittest.TextTestRunner(verbosity=2,resultclass=RecordingResult).run(suite)
    versions={}
    for p in ['fastapi','pydantic','numpy','scipy','scikit-learn','polars','pyarrow','httpx']:
        try:versions[p]=importlib.metadata.version(p)
        except importlib.metadata.PackageNotFoundError:versions[p]=None
    payload={'python':platform.python_version(),'platform':sys.platform,'versions':versions,
             'counts':{s:sum(r['status']==s for r in result.records) for s in ['PASS','FAIL','ERROR','SKIP']},
             'testsRun':result.testsRun,'records':result.records}
    args.output.mkdir(parents=True,exist_ok=True)
    (args.output/'test-results.json').write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
    root=ET.Element('testsuite',name='DAVIS survey audit',tests=str(result.testsRun),failures=str(len(result.failures)),errors=str(len(result.errors)),skipped=str(len(result.skipped)))
    for r in result.records:
        case=ET.SubElement(root,'testcase',name=r['test'],time=f"{r['seconds']:.6f}")
        if r['status']!='PASS':
            child=ET.SubElement(case,{'FAIL':'failure','ERROR':'error','SKIP':'skipped'}[r['status']]);child.text=r['detail']
    ET.ElementTree(root).write(args.output/'junit.xml',encoding='utf-8',xml_declaration=True)
    return 0 if result.wasSuccessful() else 1


if __name__=='__main__':
    raise SystemExit(main())
