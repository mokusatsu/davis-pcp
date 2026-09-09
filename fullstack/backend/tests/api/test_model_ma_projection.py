import polars as pl
import numpy as np
import pytest

from app.api import models
from app.domain.errors import BizError
from app.storage.dataset_store import DatasetStore


@pytest.mark.parametrize('model_type', ['decision_tree', 'random_forest'])
def test_model_uses_binary_ma_feature_and_preserves_leaf_row_ids(tmp_path, monkeypatch, model_type):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(models, 'store', store)
    frame = pl.DataFrame({'__rowId__': [f'r{i}' for i in range(12)], 'A': [2, 3] * 6,
                          'B': [99] + [3] * 11, 'score': [float(i) for i in range(12)], 'unused': [0] * 12})
    cb = {'schemaRevision': 1, 'columns': [
        {'name': name, 'columnId': name, 'role': 'question', 'scaleType': 'nominal' if name in ['A', 'B'] else 'ratio',
         'multiResponseGroup': 'g' if name in ['A', 'B'] else None, 'missingCodes': ['99']} for name in ['A', 'B', 'score', 'unused']],
        'multiResponseGroups': [{'groupId': 'g', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]}
    store.save('d', {'datasetId': 'd', 'schemaRevision': 1, 'fingerprint': 'fixture'}, frame, codebook=cb)
    read = store.get_dataframe
    projections = []
    def tracked(dataset_id, columns=None):
        projections.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', tracked)
    request = dict(datasetId='d', features=['A'], target='score', modelType=model_type, nEstimators=3,
                   expectedSchemaRevision=1, expectedDataRevision=1)
    result = models.create_model(models.ModelRequest(**request))
    assert projections == [['__rowId__', 'A', 'score', 'B']]
    assert result['features'] == ['A']
    assert result['usedRows'] == 11
    assert result['excludedCounts']['g']['partial'] == 1
    assert result['featureImportance'] == {'A': 1.0}
    assert set(row for leaf in result['leafMembership'] for row in leaf['rowIds']) == {f'r{i}' for i in range(1, 12)}
    assert result['treeStructures'][0]['threshold'] == 0.5
    for child in result['treeStructures'][0]['children']:
        assert child['values'] == []
        assert child['majority'] == f"{child['prediction']:.4g}"
    if model_type == 'random_forest':
        x = np.array([[int(i % 2 == 0)] for i in range(1, 12)])
        reference = models.RandomForestRegressor(n_estimators=3, max_depth=5, random_state=42).fit(x, list(range(1, 12)))
        prediction = reference.predict(x)
        differences = [float(np.mean(np.abs(tree.predict(x) - prediction))) for tree in reference.estimators_]
        representative = result['representativeTree']
        assert representative['forestAgreement'] is None
        assert representative['forestMae'] == pytest.approx(min(differences))
        assert representative['index'] == int(np.argmin(differences))
    for override, code in [({'target': 'B'}, 'MA_METHOD_UNSUPPORTED'),
                           ({'expectedDataRevision': 2}, 'ANALYSIS_INPUT_STALE'),
                           ({'rowIds': []}, 'MODEL_NO_VALID_ROWS')]:
        with pytest.raises(BizError) as error:
            models.create_model(models.ModelRequest(**{**request, **override}))
        assert error.value.code == code
