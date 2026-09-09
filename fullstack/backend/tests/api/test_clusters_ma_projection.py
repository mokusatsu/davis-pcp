import numpy as np
import polars as pl
import pytest

from app.api import clusters
from app.domain.errors import BizError
from app.storage.dataset_store import DatasetStore


def setup_dataset(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(clusters, 'store', store)
    frame = pl.DataFrame({'__rowId__': [f'r{i*7}' for i in range(12)], 'A': [2, 3]*6,
        'B': [99]+[3]*11, 'score': list(range(12)), 'category': ['F', 'M']*6, 'unused': [9]*12})
    cb = {'schemaRevision': 1, 'columns': [{'columnId': name, 'name': name, 'role': 'question',
        'scaleType': 'nominal' if name in ['A', 'B', 'category'] else 'ratio',
        'multiResponseGroup': 'g' if name in ['A', 'B'] else None, 'missingCodes': ['99']}
        for name in ['A', 'B', 'score', 'category', 'unused']],
        'multiResponseGroups': [{'groupId': 'g', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]}
    store.save('d', {'datasetId': 'd', 'fingerprint': 'fixture'}, frame, codebook=cb)
    return store


@pytest.mark.parametrize('method', ['kmeans', 'disc', 'class_variable'])
def test_clusters_project_only_ordinary_columns_and_preserve_scope(tmp_path, monkeypatch, method):
    store = setup_dataset(tmp_path, monkeypatch)
    original_read = store.get_dataframe
    reads = []
    def read(dataset_id, columns=None):
        reads.append(columns)
        return original_read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', read)
    request = dict(datasetId='d', method=method, k=2,
        columns=['score'] if method != 'class_variable' else [],
        categoricalColumns=['category'] if method == 'disc' else None,
        classColumn='category' if method == 'class_variable' else None,
        activeRowIds=[f'r{i*7}' for i in range(8)], expectedDataRevision=1, expectedSchemaRevision=1)
    result = clusters.create_cluster(clusters.ClusterRequest(**request))
    assert result['rowIds'] == [f'r{i*7}' for i in range(8)]
    assert result['usedRows'] == result['scopeCount'] == 8
    assert len(result['labels']) == 8
    assert result['excludedRowCount'] == 0
    assert result['excludedCounts'] == {}
    assert len(reads) == 1 and not {'A', 'B', 'unused'} & set(reads[0])
    assert result['usedColumns'] == (['score', 'category'] if method == 'disc' else ['category'] if method == 'class_variable' else ['score'])
    if method != 'class_variable':
        projection = result['pcaProjection']
        assert projection is not None
        assert len(projection['pc1']) == 8 and np.isfinite(projection['pc1']).all()
        assert projection['pc2'] == [0.] * 8
        assert projection['varianceRatio'] == [1., 0.]
    for override, code in [({'activeRowIds': []}, 'CLUSTERING_TOO_FEW_ROWS'), ({'expectedSchemaRevision': 2}, 'ANALYSIS_INPUT_STALE')]:
        with pytest.raises(BizError) as error:
            clusters.create_cluster(clusters.ClusterRequest(**{**request, **override}))
        assert error.value.code == code


@pytest.mark.parametrize('fields', [
    {'method': 'kmeans', 'columns': ['A']},
    {'method': 'disc', 'columns': ['score'], 'categoricalColumns': ['A']},
    {'method': 'cobweb', 'columns': ['A'], 'categoricalColumns': ['category']},
    {'method': 'class_variable', 'columns': [], 'classColumn': 'A'},
])
def test_clusters_accept_explicit_ma_children_with_shared_scope(tmp_path, monkeypatch, fields):
    store = setup_dataset(tmp_path, monkeypatch)
    original_read = store.get_dataframe
    reads = []
    def read(dataset_id, columns=None):
        reads.append(columns)
        return original_read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', read)
    result = clusters.create_cluster(clusters.ClusterRequest(datasetId='d', k=2,
        activeRowIds=[f'r{i*7}' for i in range(8)], **fields))
    assert result['rowIds'] == [f'r{i*7}' for i in range(1, 8)]
    assert result['usedRows'] == 7 and result['scopeCount'] == 8
    assert result['excludedRowCount'] == 1
    assert len(result['labels']) == 7
    assert len(reads) == 1 and {'A', 'B'} <= set(reads[0])
    assert 'unused' not in reads[0] and 'B' not in result['usedColumns']
