"""Exercise workflow safety contracts through native and real Pyodide ASGI APIs.

Uses an isolated workspace and only the built-in public Iris fixture.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path


async def run_acceptance(output_path: str) -> dict:
    if sys.platform == 'emscripten':
        import anyio.to_thread
        import starlette.concurrency
        async def no_threads(function, *args, **kwargs):
            return function(*args, **kwargs)
        anyio.to_thread.run_sync = no_threads
        starlette.concurrency.run_in_threadpool = no_threads
    import httpx
    from app.main import app
    from app.config import settings
    settings.ensure_dirs()
    results = []
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://testserver/api/v1/') as client:
        imported = await client.post('datasets/import/sample', json={'name': f'Workflow acceptance Iris {uuid.uuid4().hex[:8]}'})
        assert imported.status_code == 200, imported.text
        dataset = imported.json()['datasetId']
        created = await client.post('sessions', json={'name': 'A workspace', 'datasetId': dataset,
            'state': {'workspaceVersion': 1, 'datasetId': dataset, 'activeRowIds': ['a']}})
        assert created.status_code == 200, created.text
        record = created.json()
        path = 'sessions/' + record['sessionId']
        mismatch = await client.put(path, json={'state': {'workspaceVersion': 1, 'datasetId': 'foreign'}, 'versionToken': record['versionToken']})
        assert mismatch.status_code == 409 and mismatch.json()['error']['code'] == 'SESSION_DATASET_MISMATCH'
        assert (await client.get(path)).json() == record
        results.append('session_cross_dataset_rejected_without_mutation')
        missing = await client.put(path, json={'state': record['state']})
        assert missing.status_code == 409 and missing.json()['error']['code'] == 'SESSION_VERSION_REQUIRED'
        updated = await client.put(path, json={'state': record['state'], 'name': 'A renamed', 'versionToken': record['versionToken']})
        assert updated.status_code == 200, updated.text
        assert updated.json()['revision'] == 2 and updated.json()['name'] == 'A renamed'
        stale = await client.put(path, json={'state': record['state'], 'versionToken': record['versionToken']})
        assert stale.status_code == 409 and stale.json()['error']['code'] == 'SESSION_CONFLICT'
        saved = (await client.get(path)).json()
        assert saved == updated.json()
        assert any(value['sessionId'] == record['sessionId'] for value in (await client.get('sessions')).json()['sessions'])
        results.append('session_list_get_tokens_conflict_rename')
        mismatch_create = await client.post('sessions', json={'name': 'foreign', 'datasetId': dataset, 'state': {'datasetId': 'foreign'}})
        assert mismatch_create.status_code == 409
        results.append('session_create_identity_rejected')
        for seed in [1.5, -1, True, '42', 9007199254740992]:
            bad = await client.post(f'datasets/{dataset}/observations/sample', json={'size': 10, 'seed': seed})
            assert bad.status_code == 422, (seed, bad.status_code, bad.text)
            assert any(value['loc'][-1] == 'seed' for value in bad.json()['detail'])
        first = await client.post(f'datasets/{dataset}/observations/sample', json={'size': 10, 'seed': 42})
        second = await client.post(f'datasets/{dataset}/observations/sample', json={'size': 10, 'seed': 42})
        assert first.status_code == second.status_code == 200, first.text
        a, b = first.json(), second.json()
        assert a['sampledRowIds'] == b['sampledRowIds'] and len(a['sampledRowIds']) == 10 and a['seed'] == 42
        results.append('sampling_seed_errors_and_deterministic_recovery')
        # Use only this isolated built-in fixture. Check that the handoff's
        # requested population and both methods' valid population stay distinct.
        from app.storage.dataset_store import DatasetStore
        dataset_store = DatasetStore()
        rows = dataset_store.get_dataframe(dataset)['__rowId__'].to_list()
        meta = (await client.get(f'datasets/{dataset}')).json()
        book = (await client.get(f'datasets/{dataset}/codebook')).json()
        body = {'datasetId': dataset, 'outcome': 'sepal_length_cm', 'rowIds': rows,
                'expectedDataRevision': meta['dataRevision'], 'expectedSchemaRevision': book['schemaRevision']}
        async def paired(expected_valid):
            kda = await client.post('models/kda', json={**body, 'drivers': ['sepal_width_cm', 'petal_length_cm']})
            pra = await client.post('pra/evaluate', json={**body, 'attributes': ['sepal_width_cm', 'petal_length_cm']})
            assert kda.status_code == pra.status_code == 200, (kda.text, pra.text)
            assert kda.json()['model']['n_valid'] == pra.json()['model']['n_valid'] == expected_valid
            assert pra.json()['scopeCount'] == len(rows) == 150
        await paired(150)
        width = next(column for column in book['columns'] if column['name'] == 'sepal_width_cm')
        patched = await client.put(f'datasets/{dataset}/codebook', json={
            'expectedSchemaRevision': book['schemaRevision'],
            'columns': [{'columnId': width['columnId'], 'missingCodes': ['3']}]})
        assert patched.status_code == 200, patched.text
        body['expectedSchemaRevision'] = patched.json()['schemaRevision']
        await paired(124)
        results.append('kda_pra_common_missing_policy_requested150_valid124')
    result = {'runtime': sys.platform, 'checks': results, 'passed': len(results)}
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result))
    return result


if __name__ == '__main__':
    asyncio.run(run_acceptance(os.environ.get('WORKFLOW_RUNTIME_OUTPUT', '.temp/workflow-repair/runtime-native.json')))
