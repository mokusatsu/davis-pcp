import numpy as np
import polars as pl
import pytest

from app.api import clusters
from app.domain.errors import BizError
from app.storage.dataset_store import DatasetStore


@pytest.mark.parametrize('use_ma', [True, False])
def test_outliers_preserve_scope_project_and_normalize_inputs(tmp_path, monkeypatch, use_ma):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(clusters, 'store', store)
    frame = pl.DataFrame({'__rowId__': [f'r{i*7}' for i in range(10)], 'A': [2, 3]*5,
        'B': [99]+[3]*9, 'score': [0., 1., 2., 3., float('inf'), 99., 6., 70., 999., 1000.], 'unused': [9]*10})
    cb = {'schemaRevision': 1, 'columns': [{'columnId': name, 'name': name, 'role': 'question',
        'scaleType': 'nominal' if name in ['A', 'B'] else 'ratio',
        'multiResponseGroup': 'g' if name in ['A', 'B'] else None, 'missingCodes': ['99']}
        for name in ['A', 'B', 'score', 'unused']],
        'multiResponseGroups': [{'groupId': 'g', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]}
    store.save('d', {'datasetId': 'd', 'fingerprint': 'fixture'}, frame, codebook=cb)
    read = store.get_dataframe
    projections = []
    def tracked(dataset_id, columns=None):
        projections.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', tracked)
    received = []
    detect = clusters.detect_outliers
    def detect_with_check(method, matrix, **kwargs):
        received.append(matrix.copy())
        return detect(method, matrix, **kwargs)
    monkeypatch.setattr(clusters, 'detect_outliers', detect_with_check)
    request = dict(datasetId='d', method='iqr', columns=['A', 'score'] if use_ma else ['score'],
        activeRowIds=[f'r{i*7}' for i in range(8)], expectedDataRevision=1, expectedSchemaRevision=1)
    result = clusters.create_outliers(clusters.OutlierRequest(**request))
    start = 1 if use_ma else 0
    assert result['rowIds'] == [f'r{i*7}' for i in range(start, 8)]
    assert result['outlierRowIds'] == ['r49']
    assert result['scopeCount'] == 8 and result['usedRows'] == 8-start
    assert result['excludedRowCount'] == start
    assert result['usedColumns'] == request['columns']
    assert len(projections) == 1 and 'unused' not in projections[0]
    assert ('B' in projections[0]) == use_ma
    matrix = received[0]
    assert np.isfinite(matrix).all()
    expected_mean = np.mean([float(i) for i in range(start, 4)] + [6., 70.])
    assert matrix[4-start, -1] == pytest.approx(expected_mean)
    assert matrix[5-start, -1] == pytest.approx(expected_mean)
    if use_ma:
        assert result['excludedCounts']['g']['partial'] == 1
        np.testing.assert_equal(matrix[:, 0], [0, 1, 0, 1, 0, 1, 0])
    for override, code in [({'activeRowIds': []}, 'OUTLIER_TOO_FEW_ROWS'),
        ({'columns': []}, 'OUTLIER_NO_COLUMNS'), ({'expectedDataRevision': 2}, 'ANALYSIS_INPUT_STALE')]:
        with pytest.raises(BizError) as error:
            clusters.create_outliers(clusters.OutlierRequest(**{**request, **override}))
        assert error.value.code == code


@pytest.mark.parametrize('outlier', [False, True])
def test_numeric_diagnostics_report_actual_columns_and_imputation(tmp_path, monkeypatch, outlier):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(clusters, 'store', store)
    frame = pl.DataFrame({'__rowId__': [f'r{i}' for i in range(8)],
        'score': [1., 2., None, 4., 5., float('inf'), 7., 20.], 'constant': [3]*8, 'empty': [None]*8})
    names = ['score', 'constant', 'empty']
    cb = {'schemaRevision': 1, 'columns': [{'name': name, 'columnId': name, 'role': 'question', 'scaleType': 'ratio'} for name in names]}
    store.save('d', {'datasetId': 'd', 'fingerprint': 'fixture'}, frame, codebook=cb)
    if outlier:
        result = clusters.create_outliers(clusters.OutlierRequest(datasetId='d', method='iqr', columns=names))
    else:
        result = clusters.create_cluster(clusters.ClusterRequest(datasetId='d', method='kmeans', columns=names, k=2))
    assert result['requestedColumns'] == ['score', 'constant', 'empty']
    assert result['usedColumns'] == result['columns'] == ['score']
    assert result['diagnostics']['droppedColumns'] == ['constant', 'empty']
    assert result['diagnostics']['imputedCounts'] == {'score': 2}
    assert result['usedRows'] == 8
    assert result['rowIds'] == [f'r{i}' for i in range(8)]
