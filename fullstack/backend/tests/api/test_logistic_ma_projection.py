import polars as pl
import pytest

from app.api import logistic
from app.domain.errors import BizError
from app.storage.dataset_store import DatasetStore


@pytest.mark.parametrize('ma_target', [False, True])
def test_logistic_projects_explicit_ma_and_keeps_canonical_rows(tmp_path, monkeypatch, ma_target):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(logistic, 'store', store)
    frame = pl.DataFrame({'__rowId__': [f'r{i * 7}' for i in range(20)], 'A': [2, 3, 3, 2] * 5,
        'B': [99] + [3] * 19, 'score': list(range(19)) + [float('inf')],
        'target': [0, 0, 1, 1, 1] * 4, 'unused': [0] * 20}, strict=False)
    columns = [{'columnId': name, 'name': name, 'role': 'question',
        'scaleType': 'nominal' if name in ['A', 'B', 'target'] else 'ratio',
        'multiResponseGroup': 'g' if name in ['A', 'B'] else None, 'missingCodes': ['99']}
        for name in ['A', 'B', 'score', 'target', 'unused']]
    cb = {'schemaRevision': 1, 'columns': columns,
        'multiResponseGroups': [{'groupId': 'g', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]}
    store.save('d', {'datasetId': 'd', 'fingerprint': 'fixture'}, frame, codebook=cb)
    read = store.get_dataframe
    projections = []
    def tracked(dataset_id, columns=None):
        projections.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', tracked)
    request = dict(datasetId='d', targetColumn='A' if ma_target else 'target',
        featureColumns=['score'] if ma_target else ['A', 'score'], expectedDataRevision=1, expectedSchemaRevision=1)
    result = logistic.fit_logistic(logistic.LogisticRequestSchema(**request))
    assert result['usedRows'] == 18
    assert result['excludedRowCount'] == 2
    assert result['excludedCounts']['g']['partial'] == 1
    assert result['excludedCounts']['ordinaryMissing'] == 1
    assert result['features'] == request['featureColumns']
    assert 'unused' not in projections[0] and 'B' in projections[0]
    assert set(sample['rowId'] for sample in result['samples']) == {f'r{i * 7}' for i in range(1, 19)}
    for sample in result['samples']:
        index = int(sample['rowId'][1:]) // 7
        assert sample['featureValues']['score'] == index
        assert set(sample['featureValues']) == set(request['featureColumns'])
        if not ma_target:
            assert sample['featureValues']['A'] == int(frame['A'][index] == 2)
    if ma_target:
        assert result['classes'] == ['0', '1']
    for override, code in [({'activeRowIds': [], 'active_row_ids': ['r7']}, 'LOGISTIC_INSUFFICIENT_ROWS'),
        ({'expectedSchemaRevision': 2}, 'ANALYSIS_INPUT_STALE'),
        ({'targetColumn': 'A', 'featureColumns': ['B']}, 'MA_METHOD_UNSUPPORTED'),
        ({'featureColumns': [], 'feature_columns': ['score']}, 'LOGISTIC_FEATURES_REQUIRED')]:
        with pytest.raises(BizError) as error:
            logistic.fit_logistic(logistic.LogisticRequestSchema(**{**request, **override}))
        assert error.value.code == code
