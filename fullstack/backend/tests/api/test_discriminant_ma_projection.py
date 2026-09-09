import numpy as np
import polars as pl
import pytest

from app.api import discriminant
from app.domain.errors import BizError
from app.storage.dataset_store import DatasetStore


@pytest.mark.parametrize('method', ['lda', 'qda', 'stepwise'])
def test_discriminant_ma_projection_and_scope(tmp_path, monkeypatch, method):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(discriminant, 'store', store)
    rng = np.random.default_rng(42)
    frame = pl.DataFrame({'__rowId__': [f'r{i * 7}' for i in range(40)],
        'A': [2, 3, 3, 2] * 10, 'B': [99] + [3] * 39,
        'score': [float('inf')] + rng.normal(size=39).tolist(), 'target': [0, 0, 1, 1, 1] * 8,
        'unused': [0] * 40})
    cb = {'schemaRevision': 1, 'columns': [{'columnId': name, 'name': name, 'role': 'question',
        'scaleType': 'nominal' if name in ['A', 'B', 'target'] else 'ratio',
        'multiResponseGroup': 'g' if name in ['A', 'B'] else None, 'missingCodes': ['99']}
        for name in ['A', 'B', 'score', 'target', 'unused']],
        'multiResponseGroups': [{'groupId': 'g', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]}
    store.save('d', {'datasetId': 'd', 'fingerprint': 'fixture'}, frame, codebook=cb)
    read = store.get_dataframe
    projections = []
    def tracked(dataset_id, columns=None):
        projections.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', tracked)
    run = discriminant.run_discriminant_analysis
    def checked_run(**kwargs):
        assert set(kwargs['df']['A'].to_list()) == ({0, 1} if kwargs['df'].height else set())
        assert kwargs['df'].columns == ['__rowId__', 'A', 'score', 'target']
        return run(**kwargs)
    monkeypatch.setattr(discriminant, 'run_discriminant_analysis', checked_run)
    request = dict(datasetId='d', targetColumn='target', featureColumns=['A', 'score'], method=method,
        expectedDataRevision=1, expectedSchemaRevision=1)
    result = discriminant.fit_discriminant(discriminant.DiscriminantRequestSchema(**request))
    assert result['usedRows'] == 39 and result['excludedRowCount'] == 1
    assert result['excludedCounts']['g']['partial'] == 1
    assert projections == [['__rowId__', 'A', 'score', 'target', 'B']]
    assert set(result['features']).issubset({'A', 'score'})
    assert {sample['rowId'] for sample in result['samples']} == {f'r{i * 7}' for i in range(1, 40)}
    for override, code in [({'activeRowIds': [], 'active_row_ids': ['r7']}, 'DISCRIMINANT_INSUFFICIENT_ROWS'),
        ({'expectedDataRevision': 2}, 'ANALYSIS_INPUT_STALE'),
        ({'targetColumn': 'A', 'featureColumns': ['B']}, 'MA_METHOD_UNSUPPORTED'),
        ({'featureColumns': [], 'feature_columns': ['score']}, 'DISCRIMINANT_FEATURES_REQUIRED')]:
        with pytest.raises(BizError) as error:
            discriminant.fit_discriminant(discriminant.DiscriminantRequestSchema(**{**request, **override}))
        assert error.value.code == code
