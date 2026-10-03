"""Check all shipped builtin data and attribution in native Python and real Pyodide."""
from __future__ import annotations
import asyncio
import csv
import hashlib
import io
import json
import os
import sys
import zipfile
from pathlib import Path

async def run_acceptance(output_path: str) -> dict:
    if sys.platform == 'emscripten':
        import anyio.to_thread
        import starlette.concurrency
        async def no_threads(function, *args, **kwargs): return function(*args, **kwargs)
        anyio.to_thread.run_sync = no_threads
        starlette.concurrency.run_in_threadpool = no_threads
    import httpx
    from app.main import app
    from app.config import settings
    from app.services.builtin_samples import catalog
    from app.domain.multi_response import resolve_groups, validate_group
    from app.storage.dataset_store import DatasetStore
    settings.ensure_dirs()
    store = DatasetStore()
    results = []
    limitations = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver/api/v1/') as client:
        samples = (await client.get('datasets/samples')).json()['samples']
        assert len(samples) == 12 and not store.list_datasets()
        results.append('lazy_catalog_12_without_import')
        for spec in catalog():
            created = await client.post('datasets/import/sample', json={'sampleId': spec['id']})
            assert created.status_code == 200, created.text
            meta = created.json(); did = meta['datasetId']
            assert (meta['rowCount'], meta['columnCount']) == (spec['rowCount'], spec['columnCount'])
            cb = (await client.get(f'datasets/{did}/codebook')).json()
            assert cb['licenseText'] == spec['licenseText'] and len(cb['columns']) == spec['columnCount']
            for group in resolve_groups(cb): validate_group(group)
            rows = await client.post(f'datasets/{did}/view', json={'columns': []})
            assert rows.status_code == 200 and len(rows.content) > 0
            import pyarrow.ipc as ipc
            table = ipc.open_stream(io.BytesIO(rows.content)).read_all()
            assert table.num_rows == spec['rowCount']
            assert len(set(table['__rowId__'].to_pylist())) == spec['rowCount']
            package = await client.get(f"datasets/samples/{spec['id']}/package")
            assert package.status_code == 200 and package.headers['content-type'] == 'application/zip'
            with zipfile.ZipFile(io.BytesIO(package.content)) as archive:
                assert archive.read('LICENSE-AND-SOURCE.txt').decode() == spec['licenseText']
                if spec['id'] != 'iris':
                    assert hashlib.sha256(archive.read(spec['dataFile'])).hexdigest() == spec['dataSha256']
                    assert archive.read(spec['noticeFile']) and archive.read(spec['provenanceFile'])
            assert (await client.post('datasets/import/sample', json={'sampleId': spec['id']})).json()['datasetId'] == did
            results.append(f"builtin_{spec['id']}_codebook_arrow_package")
        did = 'ds-builtin-iris'
        before = (await client.get(f'datasets/{did}')).json()
        cb = (await client.get(f'datasets/{did}/codebook')).json()
        text = '著作権 ©\n複数行\r\n<a>plain text</a> 😀'
        saved = await client.put(f'datasets/{did}/codebook', json={'licenseText': text, 'expectedLicenseRevision': cb['licenseRevision']})
        assert saved.status_code == 200, saved.text
        assert saved.json()['schemaRevision'] == cb['schemaRevision']
        after = (await client.get(f'datasets/{did}')).json()
        assert (before['dataRevision'], before['fingerprint']) == (after['dataRevision'], after['fingerprint'])
        assert saved.json()['codebook']['licenseText'] == text
        stale = await client.put(f'datasets/{did}/codebook', json={'licenseText': 'stale', 'expectedLicenseRevision': cb['licenseRevision']})
        assert stale.status_code == 409
        for fmt in ['json', 'csv']:
            exported = await client.get(f'datasets/{did}/codebook/export?format={fmt}')
            assert exported.status_code == 200
            if fmt == 'json': assert exported.json()['licenseText'] == text
            else:
                metadata = [row for row in csv.DictReader(io.StringIO(exported.content.decode('utf-8-sig'))) if row['recordType'] == 'dataset']
                assert metadata[0]['licenseText'] == text
            cleared = await client.put(f'datasets/{did}/codebook', json={'licenseText': ''})
            assert cleared.status_code == 200
            imported = await client.post(f'datasets/{did}/codebook/import', files={'file': (f'codebook.{fmt}', exported.content)})
            assert imported.status_code == 200, imported.text
            assert (await client.get(f'datasets/{did}/codebook')).json()['licenseText'] == text
        if sys.platform != 'emscripten':
            snapshot = await client.get(f'datasets/{did}/export_package')
            assert snapshot.status_code == 200, (snapshot.status_code, snapshot.text)
            restored = await client.post('datasets/import_package', files={'file': ('iris-package.zip', snapshot.content)})
            assert restored.status_code == 200, restored.text
            assert (await client.get(f"datasets/{restored.json()['datasetId']}/codebook")).json()['licenseText'] == text
            results.append('native_full_provenance_package_license_roundtrip')
        else:
            # The existing static UI explicitly disables generic provenance packages.
            # The separate licensed builtin ZIPs above are fully supported offline.
            limitations.append('Existing generic provenance-package UI is native-only; WASM read_raw lacks the Polars Parquet reader. Builtin sample ZIPs are supported and checked.')
        assert (await client.get(f'datasets/{did}/codebook')).json()['licenseText'] == text
        results.append('unicode_license_cas_no_numerical_invalidation_json_csv_roundtrips')
    result = {'runtime': sys.platform, 'passed': len(results), 'checks': results, 'knownLimitations': limitations}
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result)); return result

if __name__ == '__main__':
    asyncio.run(run_acceptance(os.environ.get('BUILTIN_RUNTIME_OUTPUT', '.temp/license-acceptance/runtime-native.json')))
