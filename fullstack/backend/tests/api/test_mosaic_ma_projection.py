import polars as pl
import pytest

from app.api import summaries
from app.domain.errors import BizError
from app.storage.dataset_store import DatasetStore


@pytest.mark.parametrize('placement', ['column', 'row', 'target', 'ordinary'])
def test_mosaic_explicit_ma_projection_and_cell_ids(tmp_path, monkeypatch, placement):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(summaries, 'store', store)
    frame = pl.DataFrame({'__rowId__': ['r0', 'r7', 'r14', 'r21', 'r28'],
        'Area': ['F', 'F', 'M', 'M', 'F'], 'A': [2, 2, 3, 3, 2],
        'B': [99, 3, 3, 3, 3], 'unused': [8]*5})
    codebook = {'schemaRevision': 1, 'columns': [
        {'columnId': name, 'name': name, 'role': 'attribute' if name == 'Area' else 'question',
         'scaleType': 'nominal', 'multiResponseGroup': 'g' if name in ['A', 'B'] else None,
         'missingCodes': ['99'], 'categoryOrder': ['2', '3'] if name in ['A', 'B'] else [],
         'valueLabels': {'2': 'source selected', '3': 'source unselected'} if name in ['A', 'B'] else {}}
        for name in ['Area', 'A', 'B', 'unused']],
        'multiResponseGroups': [{'groupId': 'g', 'selectedCodes': ['2'], 'unselectedCodes': ['3']}]}
    store.save('d', {'datasetId': 'd', 'fingerprint': 'mosaic'}, frame, codebook=codebook)
    read_original = store.get_dataframe
    reads = []
    def read(dataset_id, columns=None):
        reads.append(columns)
        return read_original(dataset_id, columns)
    monkeypatch.setattr(store, 'get_dataframe', read)
    request = dict(datasetId='d', columnVariables=['A'] if placement == 'column' else ['Area'],
        rowVariables=['Area'] if placement == 'column' else ['A'] if placement == 'row' else [],
        targetVariable='A' if placement == 'target' else None,
        rowIds=['r0', 'r7', 'r14', 'r21'], expectedDataRevision=1, expectedSchemaRevision=1)
    result = summaries.line_mosaic_summary(summaries.LineMosaicRequest(**request))
    ma = placement != 'ordinary'
    expected = ['r7', 'r14', 'r21'] if ma else ['r0', 'r7', 'r14', 'r21']
    assert sorted(r for cell in result['cells'] for r in cell['rowIds']) == sorted(expected)
    assert result['scopeCount'] == 4 and result['usedRows'] == len(expected)
    assert result['excludedRowCount'] == int(ma)
    assert len(reads) == 1 and 'unused' not in reads[0]
    assert ('B' in reads[0]) == ma and 'B' not in result['usedColumns']
    if placement in ['column', 'row']:
        labels = result['grid']['colLabels' if placement == 'column' else 'rowLabels']
        assert [label['path'] for label in labels] == [['0'], ['1']]
        assert result['valueLabels']['A'] == {'0': '非選択', '1': '選択'}
    if placement == 'target':
        assert result['target']['categories'] == ['0', '1']
        assert result['target']['valueLabels'] == {'0': '非選択', '1': '選択'}
        assert sum(cell['targetCounts']['1'] for cell in result['cells']) == 1
        assert sum(cell['targetCounts']['0'] for cell in result['cells']) == 2
    empty = summaries.line_mosaic_summary(summaries.LineMosaicRequest(**{**request, 'rowIds': []}))
    assert empty['scopeCount'] == 0 and empty['usedRows'] == 0 and empty['excludedRowCount'] == 0
    assert sum(cell['totalCount'] for cell in empty['cells']) == 0
    assert all(cell['rowIds'] == [] for cell in empty['cells'])
    for override, expected_code in [({'expectedSchemaRevision': 2}, 'ANALYSIS_INPUT_STALE'),
            ({'columnVariables': [], 'rowVariables': []}, 'MOSAIC_NO_VARIABLES')]:
        with pytest.raises(BizError) as error:
            summaries.line_mosaic_summary(summaries.LineMosaicRequest(**{**request, **override}))
        assert error.value.code == expected_code
    assert store.load_codebook('d')['columns'][1]['categoryOrder'] == ['2', '3']
