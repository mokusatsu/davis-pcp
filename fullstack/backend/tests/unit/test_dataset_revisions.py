import json

import polars as pl
import pytest

from app.storage import dataset_store
from app.storage.dataset_store import DatasetStore


def test_data_and_dictionary_revisions_are_independent(tmp_path):
    store = DatasetStore(tmp_path)
    meta = {'datasetId': 'd', 'schemaRevision': 1}
    frame = pl.DataFrame({'__rowId__': ['r'], 'a': [1]})
    store.save('d', meta, frame)
    assert meta['dataRevision'] == 1
    meta['schemaRevision'] = 2
    store.save_metadata('d', meta, {'schemaRevision': 2, 'columns': []})
    assert store.get_meta('d')['dataRevision'] == 1
    store.save('d', meta, frame.with_columns(pl.lit(2).alias('a')))
    assert store.get_meta('d')['dataRevision'] == 2
    assert store.get_meta('d')['schemaRevision'] == 2


def test_dictionary_publish_failure_restores_both_files(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    store.save('d', {'datasetId': 'd', 'schemaRevision': 1}, pl.DataFrame({'__rowId__': ['r']}))
    store.save_codebook('d', {'schemaRevision': 1, 'columns': []})
    old_meta, old_cb = store.get_meta('d'), store.load_codebook('d')
    write = dataset_store.atomic_write_bytes
    failed = False
    def fail_once(path, payload):
        nonlocal failed
        if path == store._meta_path('d') and not failed:
            failed = True
            raise OSError('write failed')
        write(path, payload)
    monkeypatch.setattr(dataset_store, 'atomic_write_bytes', fail_once)
    with pytest.raises(OSError):
        store.save_metadata('d', {**old_meta, 'schemaRevision': 2}, {'schemaRevision': 2, 'columns': []})
    assert store.get_meta('d') == old_meta
    assert store.load_codebook('d') == old_cb


def test_missing_data_revision_is_migrated_once(tmp_path):
    store = DatasetStore(tmp_path)
    store._meta_path('d').write_text(json.dumps({'datasetId': 'd'}), encoding='utf-8')
    assert store.get_meta('d')['dataRevision'] == 1
    assert json.loads(store._meta_path('d').read_text())['dataRevision'] == 1


@pytest.mark.parametrize('existing', [False, True])
@pytest.mark.parametrize('failed_suffix', ['.parquet', '.codebook.json', '.json'])
def test_data_publish_failure_restores_entire_dataset(tmp_path, monkeypatch, existing, failed_suffix):
    store = DatasetStore(tmp_path)
    old_frame = pl.DataFrame({'__rowId__': ['r1', 'r2'], 'a': [1, 2]})
    if existing:
        store.save('d', {'datasetId': 'd', 'schemaRevision': 1}, old_frame,
                   codebook={'schemaRevision': 1, 'columns': [{'name': 'a'}]})
    before = {path.name: path.read_bytes() for path in store.root.iterdir()}
    meta = {'datasetId': 'd', 'schemaRevision': 2}
    original_meta = dict(meta)
    write = dataset_store.atomic_write_bytes

    def fail_after_write(path, payload):
        write(path, payload)
        if path.name == 'd' + failed_suffix:
            raise OSError('publish failed')

    monkeypatch.setattr(dataset_store, 'atomic_write_bytes', fail_after_write)
    with pytest.raises(OSError, match='publish failed'):
        store.save('d', meta, old_frame.rename({'a': 'renamed'}),
                   codebook={'schemaRevision': 2, 'columns': [{'name': 'renamed'}]})
    assert meta == original_meta
    assert {path.name: path.read_bytes() for path in store.root.iterdir()} == before
    if existing:
        assert store.get_dataframe('d').equals(old_frame)


def test_reader_waits_for_failed_save_to_restore_previous_data(tmp_path, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    store = DatasetStore(tmp_path)
    frame = pl.DataFrame({'__rowId__': ['r'], 'a': [1]})
    store.save('d', {'datasetId': 'd'}, frame)
    published, release, reader_started = Event(), Event(), Event()
    write = dataset_store.atomic_write_bytes

    def pause_before_metadata(path, payload):
        if path == store._meta_path('d'):
            published.set()
            assert release.wait(5)
            raise OSError('metadata failure')
        write(path, payload)

    def read():
        reader_started.set()
        return store.get_dataframe('d')

    monkeypatch.setattr(dataset_store, 'atomic_write_bytes', pause_before_metadata)
    with ThreadPoolExecutor(max_workers=2) as pool:
        writer = pool.submit(store.save, 'd', {'datasetId': 'd'}, frame.with_columns(pl.lit(2).alias('a')))
        try:
            assert published.wait(5)
            reader = pool.submit(read)
            assert reader_started.wait(5)
            assert not reader.done()
        finally:
            release.set()
        with pytest.raises(OSError, match='metadata failure'):
            writer.result(timeout=5)
        assert reader.result(timeout=5).equals(frame)
