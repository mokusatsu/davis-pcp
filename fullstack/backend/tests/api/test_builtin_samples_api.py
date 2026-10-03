"""The shipped sample catalog is lazy, reproducible, attributed and non-destructive."""
from __future__ import annotations

import hashlib
import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from app.api import datasets
from app.main import app
from app.services.builtin_samples import IRIS_LABELS, SAMPLE_ROOT, catalog
from app.storage.dataset_store import DatasetStore
from app.domain.multi_response import resolve_groups, validate_group

@pytest.fixture
def samples(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, 'store', store)
    with TestClient(app) as client:
        yield client, store

def test_catalog_is_lazy_and_rejects_unknown_samples(samples):
    client, store = samples
    result = client.get('/api/v1/datasets/samples')
    assert result.status_code == 200
    assert len(result.json()['samples']) == 12
    assert not store.list_datasets()
    for sample_id in ['unknown', '../iris']:
        assert client.post('/api/v1/datasets/import/sample', json={'sampleId': sample_id}).status_code == 404
    assert not store.list_datasets()

@pytest.mark.parametrize('spec', catalog(), ids=lambda spec: spec['id'])
def test_builtin_codebook_source_and_shapes(samples, spec):
    client, store = samples
    imported = client.post('/api/v1/datasets/import/sample', json={'sampleId': spec['id']})
    assert imported.status_code == 200, imported.text
    meta = imported.json(); did = meta['datasetId']
    assert did == f"ds-builtin-{spec['id']}"
    assert (meta['rowCount'], meta['columnCount']) == (spec['rowCount'], spec['columnCount'])
    book = client.get(f'/api/v1/datasets/{did}/codebook').json()
    frame = store.get_dataframe(did)
    assert len(book['columns']) == spec['columnCount']
    assert book['licenseText'] == spec['licenseText']
    assert frame['__rowId__'].n_unique() == frame.height
    assert all(column['label'] for column in book['columns'])
    ids = {column['columnId'] for column in book['columns']}
    for group in resolve_groups(book):
        validate_group(group)
        assert set(group['optionOrder']).issubset(ids)
    if book.get('weightConfig'):
        assert book['weightConfig']['weightColumnId'] in ids
        assert book['weightConfig']['weightType'] == 'survey'
    assert client.post('/api/v1/datasets/import/sample', json={'sampleId': spec['id']}).json()['datasetId'] == did
    assert len(store.list_datasets()) == 1
    package = client.get(f"/api/v1/datasets/samples/{spec['id']}/package")
    assert package.status_code == 200
    with zipfile.ZipFile(io.BytesIO(package.content)) as archive:
        assert archive.read('LICENSE-AND-SOURCE.txt').decode() == spec['licenseText']
        if spec['id'] != 'iris':
            assert hashlib.sha256(archive.read(spec['dataFile'])).hexdigest() == spec['dataSha256']
            assert hashlib.sha256(archive.read(spec['codebookFile'])).hexdigest() == spec['codebookSha256']
            assert archive.read(spec['noticeFile']) and archive.read(spec['provenanceFile'])
    if spec['id'] == 'iris':
        assert {c['name']: c['label'] for c in book['columns'] if c['name'] in IRIS_LABELS} == IRIS_LABELS
    if spec['id'] == 'wine':
        assert frame.group_by('class').len().sort('class')['len'].to_list() == [59, 71, 48]
    if spec['id'] == 'siechnice-cbc96':
        assert str(frame['respondent_id'].dtype) == 'String'
        for name in ['atr1', 'atr2', 'atr3', 'atr4', 'atr5']:
            assert frame.filter(frame['status_quo'] == 1)[name].null_count() == 1152
    if spec['id'] == 'kakegawa-citizen2022-adult600':
        for column in book['columns']:
            if column['name'].startswith('Q20'):
                assert set(column['missingCodes']) == {'0', '5'}
                assert column['categoryOrder'] == ['1', '2', '3', '4']
    if spec['id'] == 'atopp-541x31':
        assert all(not column['isReversed'] for column in book['columns'])
        assert '最終21項目' in book['licenseText']

@pytest.mark.parametrize('license_value', [None, '', 'Custom license'])
def test_existing_iris_only_enriches_untouched_labels(samples, license_value):
    client, store = samples
    created = client.post('/api/v1/datasets/import/sample').json(); did = created['datasetId']
    cb = store.load_codebook(did)
    meta = store.get_meta(did); meta.pop('builtinCodebookVersion', None)
    store.save_metadata(did, meta, cb)
    for column in cb['columns']:
        if column['name'] in IRIS_LABELS:
            column['label'] = column['name']
    cb['columns'][1].update(label='Custom label', isReversed=True, categoryOrder=['1', '2'])
    if license_value is None:
        cb.pop('licenseText'); cb.pop('licenseRevision')
    else:
        cb['licenseText'] = license_value
    store.save_codebook(did, cb)
    response = client.post('/api/v1/datasets/import/sample')
    assert response.status_code == 200, response.text
    after = store.load_codebook(did)
    assert after['columns'][1] == cb['columns'][1]
    for column in after['columns'][2:]:
        if column['name'] in IRIS_LABELS: assert column['label'] == IRIS_LABELS[column['name']]
    assert after['licenseText'] == (catalog()[0]['licenseText'] if license_value is None else license_value)

def test_invalid_template_never_publishes_half_initialized_dataset(samples, monkeypatch):
    import app.services.builtin_samples as builtin
    client, store = samples
    monkeypatch.setattr(builtin, 'install_codebook', lambda *args: (_ for _ in ()).throw(ValueError('invalid template')))
    with pytest.raises(ValueError, match='invalid template'):
        client.post('/api/v1/datasets/import/sample')
    assert store.list_datasets() == []
    assert not list(store.root.glob('*.parquet'))

def test_same_named_upload_is_not_adopted_as_builtin(samples):
    client, store = samples
    uploaded = client.post('/api/v1/datasets/import', files={'file': ('Iris (built-in sample).csv', b'x\n1\n2\n')}).json()
    imported = client.post('/api/v1/datasets/import/sample').json()
    assert uploaded['datasetId'] != imported['datasetId']
    assert imported['rowCount'] == 150


def test_new_sample_preserves_explicit_blank_and_raw_name_labels(samples):
    client, store = samples
    did = client.post('/api/v1/datasets/import/sample').json()['datasetId']
    cb = store.load_codebook(did)
    cb['columns'][1]['label'] = ''
    cb['columns'][2]['label'] = cb['columns'][2]['name']
    store.save_codebook(did, cb)
    assert client.post('/api/v1/datasets/import/sample').status_code == 200
    after = store.load_codebook(did)
    assert after == cb
