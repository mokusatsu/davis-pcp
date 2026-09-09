import polars as pl
import pytest

from app.api import mining
from app.domain.errors import BizError
from app.storage.dataset_store import DatasetStore


def test_ranking_uses_explicit_ma_feature_and_valid_population(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(mining, 'store', store)
    frame = pl.DataFrame({'__rowId__': [f'r{i}' for i in range(12)], 'A': [2, 3] * 6,
                          'B': [99] + [3] * 11, 'score': list(range(12)), 'unused': [0] * 12})
    cb = {'schemaRevision': 1, 'columns': [
        {'name': name, 'columnId': name, 'role': 'question', 'scaleType': 'nominal' if name in ['A', 'B'] else 'ratio',
         'multiResponseGroup': 'g' if name in ['A', 'B'] else None, 'missingCodes': ['99']} for name in ['A', 'B', 'score', 'unused']],
        'multiResponseGroups': [{'groupId': 'g', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]}
    store.save('d', {'datasetId': 'd', 'schemaRevision': 1}, frame, codebook=cb)
    read = store.get_dataframe
    projections = []
    def tracked(dataset_id, columns=None):
        projections.append(columns)
        return read(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', tracked)
    request = dict(datasetId='d', featureColumns=['A'], targetColumn='score', methods=['relieff'],
                   expectedSchemaRevision=1, expectedDataRevision=1)
    result = mining.run_feature_ranking(mining.FeatureRankingRequest(**request))
    assert projections == [['__rowId__', 'A', 'score', 'B']]
    assert result['evaluatedVariables'] == ['A']
    assert result['redundancyMatrix'] == [[0.0]]
    assert result['usedColumns'] == ['A', 'score']
    assert result['usedRows'] == 11
    assert result['excludedCounts']['g']['partial'] == 1
    assert result['importanceScope'] == 'child-only'
    for override, code in [({'featureColumns': []}, 'EMPTY_ANALYSIS_INPUT'),
                           ({'targetColumn': 'B'}, 'MA_METHOD_UNSUPPORTED'),
                           ({'expectedDataRevision': 2}, 'ANALYSIS_INPUT_STALE'),
                           ({'activeRowIds': []}, 'FEATURE_RANKING_ERROR')]:
        with pytest.raises(BizError) as error:
            mining.run_feature_ranking(mining.FeatureRankingRequest(**{**request, **override}))
        assert error.value.code == code
