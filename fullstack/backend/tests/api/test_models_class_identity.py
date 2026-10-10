"""Tree presentation identities follow fitted classes and original kept rows."""
from copy import deepcopy

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import datasets, models
from app.main import app
from app.storage.dataset_store import DatasetStore


ROW_IDS = ['r84', 'r7', 'r63', 'r21', 'r98', 'r14', 'r77', 'r35', 'r66', 'r2', 'r91', 'r48']
X = [0.0] * 6 + [1.0] * 6
KINDS = ['decision_tree', 'random_forest']


@pytest.fixture
def store(tmp_path, monkeypatch):
    dataset_store = DatasetStore(tmp_path)
    monkeypatch.setattr(models, 'store', dataset_store)
    monkeypatch.setattr(datasets, 'store', dataset_store)
    monkeypatch.setattr(models, '_results', {})
    return dataset_store


def _binary_frame(low='A', high='B', dtype=pl.String):
    return pl.DataFrame({'__rowId__': ROW_IDS, 'x': X,
                         'answer': pl.Series([low] * 6 + [high] * 6, dtype=dtype)})


def _save(store, frame, target_spec=None, *, other_specs=(), groups=()):
    codebook = {'datasetId': 'identity', 'schemaRevision': 1, 'licenseText': '', 'licenseRevision': 1,
                'columns': [
        {'columnId': 'x-id', 'name': 'x', 'scaleType': 'ratio', 'role': 'attribute', 'missingCodes': []},
        {'columnId': 'answer-id', 'name': 'answer', 'scaleType': 'nominal',
         'role': 'question', 'missingCodes': [], **(target_spec or {})},
        *other_specs,
    ], 'multiResponseGroups': list(groups)}
    store.save('identity', {'datasetId': 'identity', 'fingerprint': 'class-identity',
                           'schemaRevision': 1}, frame, codebook=codebook)


def _request(kind='decision_tree'):
    return dict(datasetId='identity', features=['x-id'], target='answer-id', modelType=kind,
                taskType='auto', maxDepth=4, nEstimators=10, seed=42,
                expectedSchemaRevision=1, expectedDataRevision=1)


def _fit(kind='decision_tree', **overrides):
    request = {**_request(kind), **overrides}
    return models.create_model(models.ModelRequest(**request))


def _category(raw, code, label):
    return {'rawValue': raw, 'code': code, 'label': label}


def _walk(node):
    yield node
    for child in node.get('children', []):
        yield from _walk(child)


def _numeric_tree(node):
    return {key: [_numeric_tree(child) for child in value] if key == 'children'
            else [{k: v for k, v in item.items() if k != 'label'} for item in value] if key == 'values'
            else value for key, value in node.items() if key != 'majority'}


def _assert_pure_binary(result, kind, *, low_index=0):
    """Closed 12-row fixture oracle; bootstrap counts differ from memberships."""
    high_index = 1 - low_index
    counts = [12, 6, 6] if kind == 'decision_tree' else [7, 2, 5]
    ratios = [0.5, 0.5] if kind == 'decision_tree' else [0.25, 0.75]
    root_values = [{'classIndex': i, 'count': round(ratio * counts[0]), 'ratio': ratio}
                   for i, ratio in sorted(zip([low_index, high_index], ratios))]
    root_values.sort(key=lambda item: -item['count'])
    children = []
    for node_id, winner in [(1, low_index), (2, high_index)]:
        children.append({
            'nodeId': node_id, 'isLeaf': True, 'count': counts[node_id], 'rowIdsCount': 6,
            'values': [{'classIndex': winner, 'count': counts[node_id], 'ratio': 1.0},
                       {'classIndex': 1 - winner, 'count': 0, 'ratio': 0.0}], 'rowIds': None,
        })
    assert _numeric_tree(result['treeStructures'][0]) == {
        'nodeId': 0, 'isLeaf': False, 'count': counts[0], 'rowIdsCount': 12,
        'values': root_values, 'feature': 'x', 'threshold': 0.5, 'children': children,
    }
    assert result['trainedRows'] == result['usedRows'] == 12
    assert result['rowIds'] == ROW_IDS
    assert result['features'] == ['x']
    assert result['usedColumns'] == ['x', 'answer']
    assert result['featureImportance'] == {'x': 1.0}
    assert result['leafMembership'] == [
        {'nodeId': 1, 'treeIndex': 0, 'rowIds': ROW_IDS[:6]},
        {'nodeId': 2, 'treeIndex': 0, 'rowIds': ROW_IDS[6:]},
    ]
    assert models.get_model(result['resultId'])['nodes'] == [
        {'nodeId': 0, 'isLeaf': False, 'count': 12, 'feature': 0, 'treeIndex': 0, 'rowIds': ROW_IDS},
        {'nodeId': 1, 'isLeaf': True, 'count': 6, 'feature': None, 'treeIndex': 0, 'rowIds': ROW_IDS[:6]},
        {'nodeId': 2, 'isLeaf': True, 'count': 6, 'feature': None, 'treeIndex': 0, 'rowIds': ROW_IDS[6:]},
    ]
    assert result['representativeTree'] == {
        'index': 0 if kind == 'random_forest' else None,
        'forestAgreement': 1.0 if kind == 'random_forest' else None,
        'treeAgreements': [1.0] * 10 if kind == 'random_forest' else None,
        'forestMae': None, 'treeMaes': None,
    }
    for node in _walk(result['treeStructures'][0]):
        assert [value['count'] for value in node['values']] == sorted(
            [value['count'] for value in node['values']], reverse=True)
        for value in node['values']:
            assert value['label'] == result['classLabels'][value['classIndex']]
        if node['isLeaf']:
            assert node['majority'] == node['values'][0]['label']


@pytest.mark.parametrize('kind', KINDS)
def test_label_only_edit_preserves_native_results_and_freezes_post_get_identity(store, kind):
    frame = _binary_frame()
    _save(store, frame, {'categoryOrder': ['A', 'B'], 'valueLabels': {'A': 'Alpha', 'B': 'Beta'}})
    initial_meta, initial_book = store.get_meta('identity'), store.load_codebook('identity')
    results = []
    with TestClient(app) as client:
        for revision, labels in [(1, ['Alpha', 'Beta']), (2, ['Same', 'Same'])]:
            response = client.post('/api/v1/models', json={**_request(kind), 'expectedSchemaRevision': revision})
            assert response.status_code == 200, response.text
            result = response.json()
            full = client.get(f"/api/v1/models/{result['resultId']}")
            assert full.status_code == 200, full.text
            full = full.json()
            leaves = client.get(f"/api/v1/models/{result['resultId']}/leaves")
            assert leaves.status_code == 200, leaves.text
            assert leaves.json()['leaves'] == result['leafMembership']
            assert {k: v for k, v in full.items() if k != 'nodes'} == {
                k: v for k, v in result.items() if k not in ('nodeCount', 'leafCount')}
            assert result['nodeCount'] == 3 and result['leafCount'] == 2
            assert result['targetDtype'] == 'String'
            assert result['classLabels'] == labels
            assert result['classCategories'] == [[_category(raw, raw, label)] for raw, label in zip('AB', labels)]
            assert result['scopeCount'] == 12 and result['ordinaryMissingExcluded'] == 0
            assert result['excludedCounts'] == {}
            assert result['taskType'] == 'classification'
            assert result['schemaRevision'] == revision and result['dataRevision'] == 1
            _assert_pure_binary(result, kind)
            raw_by_id = dict(zip(ROW_IDS, frame['answer'].to_list()))
            for leaf, node in zip(result['leafMembership'], result['treeStructures'][0]['children']):
                raw = {raw_by_id[row_id] for row_id in leaf['rowIds']}
                assert len(raw) == 1
                category, = result['classCategories'][node['values'][0]['classIndex']]
                assert raw == {category['rawValue']}
            results.append(deepcopy(full))
            if revision == 1:
                assert store.get_meta('identity') == initial_meta
                assert store.load_codebook('identity') == initial_book
                updated = client.put('/api/v1/datasets/identity/codebook', json={
                    'expectedSchemaRevision': 1,
                    'columns': [{'columnId': 'answer-id', 'valueLabels': {'A': 'Same', 'B': 'Same'}}],
                })
                assert updated.status_code == 200, updated.text
                assert updated.json()['updatedColumns'] == 1
                # Already-returned descriptors stay frozen; cached reads keep the stale policy.
                for suffix in ['', '/leaves']:
                    stale = client.get(f"/api/v1/models/{result['resultId']}{suffix}")
                    assert stale.status_code == 409, stale.text
                    assert 'MODEL_RESULT_STALE' in stale.text
                assert result['classCategories'] == [[_category('A', 'A', 'Alpha')], [_category('B', 'B', 'Beta')]]
                assert models._results[result['resultId']]['classCategories'] == result['classCategories']
        first, second = results
        assert first['resultId'] != second['resultId']
        assert _numeric_tree(first['treeStructures'][0]) == _numeric_tree(second['treeStructures'][0])
        for field in ('nodes', 'leafMembership', 'rowIds', 'scopeHash', 'scopeCount', 'usedRows', 'usedColumns',
                      'excludedCounts', 'ordinaryMissingExcluded', 'featureImportance', 'representativeTree'):
            assert first[field] == second[field], field
    assert store.get_dataframe('identity').to_dicts() == frame.to_dicts()
    assert store.get_meta('identity')['valuesFingerprint'] == initial_meta['valuesFingerprint']
    expected_book = deepcopy(initial_book)
    expected_book['schemaRevision'] = 2
    expected_book['columns'][1]['valueLabels'] = {'A': 'Same', 'B': 'Same'}
    assert store.load_codebook('identity') == expected_book


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize(('dtype', 'low', 'high', 'raw', 'codes', 'low_index'), [
    pytest.param(pl.Int64, 2, 10, ['2', '10'], ['2', '10'], 0, id='integer-numeric-order'),
    pytest.param(pl.Float64, 2.0, 10.0, ['2.0', '10.0'], ['2', '10'], 0, id='float-numeric-order'),
    pytest.param(pl.String, '2', '10', ['2', '10'], ['2', '10'], 1, id='string-lexical-order'),
    pytest.param(pl.String, '01', '1', ['01', '1'], ['01', '1'], 0, id='literal-leading-zero'),
    pytest.param(pl.String, '1', '1.0', ['1', '1.0'], ['1', '1.0'], 0, id='literal-decimal'),
    pytest.param(pl.Int64, 9007199254740992, 9007199254740993,
                 ['9007199254740992', '9007199254740993'], ['9007199254740992', '9007199254740993'],
                 0, id='exact-large-integers'),
])
def test_stored_identity_uses_actual_fitted_class_order(store, kind, dtype, low, high, raw, codes, low_index):
    frame = _binary_frame(low, high, dtype)
    _save(store, frame, {'valueLabels': {codes[0]: 'Low', codes[1]: 'High'}})
    result = _fit(kind)
    categories = [[_category(raw[0], codes[0], 'Low')], [_category(raw[1], codes[1], 'High')]]
    assert result['targetDtype'] == str(dtype)
    assert result['classCategories'] == (categories if low_index == 0 else list(reversed(categories)))
    _assert_pure_binary(result, kind, low_index=low_index)
    assert store.get_dataframe('identity').to_dicts() == frame.to_dicts()


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('scale', ['ordinal', 'ratio'])
def test_explicit_scored_classification_tracks_original_codes_after_reversal(store, kind, scale):
    _save(store, _binary_frame(10, 20, pl.Int64), {
        'scaleType': scale, 'categoryOrder': ['10', '20'], 'isReversed': True,
        'valueLabels': {'10': 'Low', '20': 'High'},
    })
    result = _fit(kind, taskType='classification')
    assert result['taskType'] == 'classification'
    assert result['targetDtype'] == 'Int64'
    assert result['classCategories'] == [[_category('20', '20', 'High')], [_category('10', '10', 'Low')]]
    _assert_pure_binary(result, kind, low_index=1)


@pytest.mark.parametrize('kind', KINDS)
def test_explicit_numeric_classification_keeps_all_raw_string_aliases(store, kind):
    frame = pl.DataFrame({'__rowId__': ROW_IDS, 'x': X, 'answer': ['01', '1'] * 3 + ['2'] * 6})
    _save(store, frame, {'scaleType': 'ratio', 'valueLabels': {'01': 'First', '1': 'Same score', '2': 'High'}})
    result = _fit(kind, taskType='classification')
    assert result['targetDtype'] == 'String'
    assert result['classCategories'] == [
        [_category('01', '01', 'First'), _category('1', '1', 'Same score')], [_category('2', '2', 'High')],
    ]
    _assert_pure_binary(result, kind)


@pytest.mark.parametrize('kind', KINDS)
def test_ma_identity_covers_all_kept_raw_codes_and_excludes_other_populations(store, kind):
    valid = pl.DataFrame({'__rowId__': ROW_IDS, 'x': X,
                          'answer': [*range(10, 16), *range(20, 26)], 'sibling': [10] * 12})
    excluded = pl.DataFrame({
        '__rowId__': ['semantic', 'physical', 'invalid', 'no-feature', 'partial', 'inf-feature', 'outside'],
        'x': [0.0, 0.0, 0.0, None, 0.0, float('inf'), 0.0],
        'answer': [99, None, 77, 26, 28, 29, 27], 'sibling': [10, 10, 10, 10, 99, 10, 10],
    })
    frame = pl.concat([excluded, valid])
    _save(store, frame, {'multiResponseGroup': 'g', 'missingCodes': ['99'],
                         'valueLabels': {'10': 'No', '20': 'Selected', '21': 'Selected', '26': 'Unused', '30': 'Unobserved'}},
          other_specs=[{'columnId': 'sibling-id', 'name': 'sibling', 'role': 'question', 'scaleType': 'nominal',
                        'multiResponseGroup': 'g', 'missingCodes': ['99']}],
          groups=[{'groupId': 'g', 'selectedCodes': [str(code) for code in range(20, 31)],
                   'unselectedCodes': [str(code) for code in range(10, 17)]}])
    active = [row_id for row_id in frame['__rowId__'].to_list() if row_id != 'outside']
    result = _fit(kind, rowIds=list(reversed(active)))
    assert result['targetDtype'] == 'Int64'
    assert result['classLabels'] == ['非選択', '選択']
    assert result['classCategories'] == [
        [_category(str(code), str(code), 'No' if code == 10 else str(code)) for code in range(10, 16)],
        [_category(str(code), str(code), 'Selected' if code in (20, 21) else str(code)) for code in range(20, 26)],
    ]
    assert result['scopeCount'] == 18 and result['ordinaryMissingExcluded'] == 2
    assert result['excludedCounts'] == {'g': {
        'valid': 14, 'missing': 0, 'partial': 3, 'notApplicable': 0, 'invalid': 1,
    }}
    _assert_pure_binary(result, kind)
    if kind == 'random_forest':
        # Each raw code occurs once; seven bootstrap members cannot supply the
        # complete twelve-code mapping, which must describe all fitted rows.
        assert sum(map(len, result['classCategories'])) == 12 > result['treeStructures'][0]['count']


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize(('dtype', 'values', 'selected', 'unselected', 'categories'), [
    pytest.param(pl.String, ['1', '01'] * 3 + ['1.0'] * 6, ['1.0'], ['01', '1'],
                 [[_category('01', '01', '01'), _category('1', '1', '1')], [_category('1.0', '1.0', '1.0')]],
                 id='literal-string-aliases'),
    pytest.param(pl.Float64, [0.0, -0.0] * 3 + [1.0] * 6, ['1'], ['0'],
                 [[_category('-0.0', '0', '0'), _category('0.0', '0', '0')], [_category('1.0', '1', '1')]],
                 id='signed-zero'),
])
def test_ma_deduplicates_original_raw_text_not_lookup_code(store, kind, dtype, values, selected, unselected, categories):
    _save(store, pl.DataFrame({'__rowId__': ROW_IDS, 'x': X, 'answer': pl.Series(values, dtype=dtype)}),
          {'multiResponseGroup': 'g'}, groups=[{'groupId': 'g', 'selectedCodes': selected, 'unselectedCodes': unselected}])
    result = _fit(kind)
    assert result['targetDtype'] == str(dtype)
    assert result['classCategories'] == categories
    _assert_pure_binary(result, kind)


@pytest.mark.parametrize('kind', KINDS)
def test_ordinary_metadata_omits_missing_invalid_feature_excluded_and_unscoped_rows(store, kind):
    excluded = pl.DataFrame({
        '__rowId__': ['semantic', 'physical', 'nan-target', 'inf-target', 'invalid', 'no-feature', 'outside'],
        'x': [0.0, 0.0, 0.0, 0.0, 0.0, None, 0.0],
        'answer': [99.0, None, float('nan'), float('inf'), 77.0, 30.0, 40.0],
    })
    frame = pl.concat([excluded, _binary_frame(10.0, 20.0, pl.Float64)])
    _save(store, frame, {'categoryOrder': ['10', '20', '30', '40', '50', '99'], 'missingCodes': ['99'],
                         'valueLabels': {'10': 'Low', '20': 'High', '30': 'Unused', '40': 'Unscoped', '50': 'Unobserved'}})
    active = [row_id for row_id in frame['__rowId__'].to_list() if row_id != 'outside']
    result = _fit(kind, rowIds=list(reversed(active)))
    assert result['targetDtype'] == 'Float64'
    assert result['classCategories'] == [[_category('10.0', '10', 'Low')], [_category('20.0', '20', 'High')]]
    assert result['scopeCount'] == 18 and result['ordinaryMissingExcluded'] == 6
    assert result['excludedCounts'] == {}
    _assert_pure_binary(result, kind)


def test_rounded_distribution_tie_retains_existing_first_class_badge():
    # Distinct ratios round to equal displayed counts. The established badge
    # uses the stable count sort even when the native prediction favors B.
    matrix = np.zeros((2, 1))
    tree = models.DecisionTreeClassifier(random_state=42).fit(matrix, ['A', 'B'], sample_weight=[0.49, 0.51])
    assert tree.predict(matrix).tolist() == ['B', 'B']
    root = models._tree_structure(tree, ['x'], ['Alpha', 'Beta'], matrix, ['A', 'B'])
    assert root['values'] == [
        {'classIndex': 0, 'label': 'Alpha', 'count': 1, 'ratio': 0.49},
        {'classIndex': 1, 'label': 'Beta', 'count': 1, 'ratio': 0.51},
    ]
    assert root['majority'] == root['values'][0]['label'] == 'Alpha'


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('scale', ['ordinal', 'ratio'])
def test_auto_scored_target_stays_numeric_regression(store, kind, scale):
    _save(store, _binary_frame(10, 20, pl.Int64), {
        'scaleType': scale, 'categoryOrder': ['10', '20'], 'isReversed': True,
        'valueLabels': {'10': 'Low', '20': 'High'},
    })
    result = _fit(kind)
    assert result['taskType'] == 'regression'
    assert result['targetDtype'] == 'Int64'
    assert result['classCategories'] is None and result['classLabels'] is None
    assert result['rowIds'] == ROW_IDS and result['usedRows'] == 12
    assert result['featureImportance'] == {'x': 1.0}
    root = result['treeStructures'][0]
    assert root['threshold'] == 0.5 and root['values'] == []
    expected = [2.0, 1.0] if scale == 'ordinal' else [20.0, 10.0]
    for leaf, prediction, membership in zip(root['children'], expected, result['leafMembership']):
        assert leaf['values'] == []
        assert leaf['prediction'] == prediction and leaf['majority'] == f'{prediction:.4g}'
        assert membership == {'nodeId': leaf['nodeId'], 'treeIndex': 0,
                              'rowIds': ROW_IDS[:6] if leaf['nodeId'] == 1 else ROW_IDS[6:]}
    if kind == 'random_forest':
        assert result['representativeTree'] == {
            'index': 0, 'forestAgreement': None, 'treeAgreements': None, 'forestMae': 0.0, 'treeMaes': [0.0] * 10,
        }
