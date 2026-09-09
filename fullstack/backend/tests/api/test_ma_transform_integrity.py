import polars as pl
import pytest

from app.api import datasets
from app.storage import dataset_store
from app.storage.dataset_store import DatasetStore


def setup_dataset(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, 'store', store)
    frame = pl.DataFrame({'__rowId__': ['r4', 'r2', 'r9'], 'A': [1, 0, 1], 'B': [0, 1, 0], 'Score': [1., None, 3.]})
    schema = [{'name': name, 'columnId': 'stable-' + name, 'semanticType': 'numeric', 'role': 'feature'} for name in ['A', 'B', 'Score']]
    cb = {'datasetId': 'd', 'schemaRevision': 1,
          'columns': [{'name': name, 'columnId': 'stable-' + name, 'label': name, 'role': 'question',
                       'scaleType': 'ratio' if name == 'Score' else 'nominal',
                       'multiResponseGroup': None if name == 'Score' else 'g',
                       'multiResponseOptionLabel': name, 'missingCodes': []} for name in ['A', 'B', 'Score']],
          'multiResponseGroups': [{'groupId': 'g', 'label': '利用サービス', 'selectedCodes': ['1'],
                                   'unselectedCodes': ['0'], 'optionOrder': ['stable-B', 'stable-A']}]}
    store.save('d', {'datasetId': 'd', 'name': 'review', 'schema': schema, 'schemaRevision': 1,
                     'rowCount': 3, 'columnCount': 3}, frame, codebook=cb)
    return store, frame, cb


def test_ma_survives_calculation_imputation_copy_and_member_deletion(tmp_path, monkeypatch):
    store, frame, original = setup_dataset(tmp_path, monkeypatch)
    result = datasets.calculate_dataset_variable('d', datasets.CalculateRequest(expression='Score * 2', columnName='Double'))
    assert result['dataRevision'] == 2
    snapshot = datasets.get_dataset('d')
    assert snapshot['schemaRevision'] == store.load_codebook('d')['schemaRevision'] == 2
    assert snapshot['dataRevision'] == 2
    assert {c['name']: c['columnId'] for c in result['schema']}['A'] == 'stable-A'
    assert store.load_codebook('d')['multiResponseGroups'] == original['multiResponseGroups']
    result = datasets.impute_dataset('d', datasets.ImputeRequest(columns=['Score'], strategy='mean'))
    assert result['dataRevision'] == 3
    assert store.get_dataframe('d')['__rowId__'].to_list() == frame['__rowId__'].to_list()
    assert store.load_codebook('d')['columns'][:3] == original['columns']
    copied = datasets.impute_dataset('d', datasets.ImputeRequest(columns=['Score'], strategy='mean', inPlace=False))
    assert copied['dataRevision'] == 1
    assert store.get_dataframe(copied['datasetId'])['__rowId__'].to_list() == frame['__rowId__'].to_list()
    assert store.load_codebook(copied['datasetId'])['multiResponseGroups'] == original['multiResponseGroups']
    result = datasets.delete_column('d', 'B')
    assert result['dataRevision'] == 4
    assert store.load_codebook('d')['multiResponseGroups'][0]['optionOrder'] == ['stable-A']
    assert {c['name']: c['columnId'] for c in result['schema']}['A'] == 'stable-A'


def test_failed_transform_does_not_publish_dictionary_or_revision(tmp_path, monkeypatch):
    store, _, _ = setup_dataset(tmp_path, monkeypatch)
    before = {path.name: path.read_bytes() for path in store.root.iterdir()}
    write = dataset_store.atomic_write_bytes

    def fail(path, payload):
        if path == store._meta_path('d'):
            raise OSError('disk failure')
        write(path, payload)

    monkeypatch.setattr(dataset_store, 'atomic_write_bytes', fail)
    with pytest.raises(OSError, match='disk failure'):
        datasets.transform_dataset('d', datasets.TransformRequest(type='binning', source_column='Score', options={'num_bins': 2}))
    assert {path.name: path.read_bytes() for path in store.root.iterdir()} == before
