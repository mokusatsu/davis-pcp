"""Fitted Discriminant classes retain the identities of their stored outcomes."""
from copy import deepcopy
import math

import polars as pl
import pytest

from app.api import datasets, discriminant
from app.algorithms.models.discriminant import run_discriminant_analysis
from app.storage.dataset_store import DatasetStore


ROW_IDS = ['r84', 'r7', 'r63', 'r21', 'r98', 'r14']
X = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0]


@pytest.fixture
def store(tmp_path, monkeypatch):
    dataset_store = DatasetStore(tmp_path)
    monkeypatch.setattr(discriminant, 'store', dataset_store)
    monkeypatch.setattr(datasets, 'store', dataset_store)
    return dataset_store


def _binary_frame(low=10, high=20, dtype=pl.Int64):
    return pl.DataFrame({'__rowId__': ROW_IDS, 'x': X,
                         'answer': pl.Series([low] * 3 + [high] * 3, dtype=dtype)})


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


def _fit(*, revision=1, active_row_ids=None):
    return discriminant.fit_discriminant(discriminant.DiscriminantRequestSchema(
        datasetId='identity', targetColumn='answer-id', featureColumns=['x-id'],
        expectedDataRevision=1, expectedSchemaRevision=revision, activeRowIds=active_row_ids,
        method='lda', shrinkage='none', priors='proportional',
    ))


def _category(raw_value, code, label):
    return {'rawValue': raw_value, 'code': code, 'label': label}


def _assert_binary_lda(result, low_class='10', high_class='20'):
    """Scalar oracle: means 1 and 4, pooled variance 1, log odds 3*x - 7.5."""
    assert result['usedRows'] == 6
    assert result['target'] == 'answer'
    assert result['features'] == ['x']
    assert result['usedColumns'] == ['x', 'answer']
    assert result['accuracy'] == 1.0
    assert result['misclassifiedRowIds'] == []
    assert result['diagnostics']['classCounts'] == {low_class: 3, high_class: 3}
    assert result['diagnostics']['withinClassRank'] == 1
    assert result['diagnostics']['singularWithinClassCovariance'] is False
    assert result['boundaryMesh'] is None
    assert result['wilksLambdaOverall'] == pytest.approx(8 / 35, abs=5e-6)
    assert result['axes'][0]['eigenvalue'] == pytest.approx(27 / 8, abs=5e-5)
    assert result['axes'][0]['explainedVarianceRatio'] == 1.0
    assert result['axes'][0]['canonicalCorrelation'] == pytest.approx(math.sqrt(27 / 35), abs=5e-5)
    by_id = {sample['rowId']: sample for sample in result['samples']}
    assert len(result['samples']) == 6
    assert set(by_id) == set(ROW_IDS)
    for row_id, x in zip(ROW_IDS, X):
        sample = by_id[row_id]
        actual = low_class if x < 3 else high_class
        high_probability = 1 / (1 + math.exp(-(3 * x - 7.5)))
        assert sample['actualClass'] == sample['predictedClass'] == actual
        assert sample['isMisclassified'] is False
        assert set(sample['posteriorProbabilities']) == {low_class, high_class}
        assert sample['posteriorProbabilities'][high_class] == pytest.approx(high_probability, abs=5e-5)
        assert sample['posteriorProbabilities'][low_class] == pytest.approx(1 - high_probability, abs=5e-5)
        assert sum(sample['posteriorProbabilities'].values()) == pytest.approx(1.0)


def _save_proved_ordinal(store):
    # Missing rows precede the fitted rows so a positional join cannot pass.
    missing = pl.DataFrame({'__rowId__': ['semantic', 'physical'], 'x': [6.0, 7.0], 'answer': [99, None]})
    frame = pl.concat([missing, _binary_frame()])
    _save(store, frame, {'scaleType': 'ordinal', 'categoryOrder': ['10', '20'],
                         'valueLabels': {'10': '低', '20': '高'}, 'missingCodes': ['99'], 'isReversed': False})
    return frame


def test_ordinary_numerical_and_missing_controls_preserve_kernel_fields(store):
    """This control also passes on the route before identity metadata is added."""
    _save_proved_ordinal(store)
    result = _fit()
    _assert_binary_lda(result, '1.0', '2.0')
    assert result['scopeCount'] == 8
    assert result['excludedRowCount'] == 2
    assert result['excludedCounts'] == {'ordinaryMissing': 2}
    # Supply the known scored input independently of the route's adapter.
    expected = run_discriminant_analysis(_binary_frame(1.0, 2.0, pl.Float64), 'answer', ['x'])
    for field, value in expected.items():
        if field != 'excludedRowCount':  # The API reports all preprocessing exclusions.
            assert result[field] == value


def test_saved_ordinal_reversal_changes_keys_meaning_but_not_decoded_results(store):
    frame = _save_proved_ordinal(store)
    initial_book, initial_meta = store.load_codebook('identity'), store.get_meta('identity')
    first = _fit()
    _assert_binary_lda(first, '1.0', '2.0')
    assert store.load_codebook('identity') == initial_book
    assert store.get_meta('identity') == initial_meta

    update = datasets.update_codebook('identity', {
        'columns': [{'columnId': 'answer-id', 'isReversed': True}], 'expectedSchemaRevision': 1,
    })
    expected_book = deepcopy(initial_book)
    expected_book['schemaRevision'] = 2
    expected_book['columns'][1]['isReversed'] = True
    assert update['status'] == 'success'
    assert update['updatedColumns'] == 1
    assert store.load_codebook('identity') == expected_book
    reversed_meta = store.get_meta('identity')
    second = _fit(revision=2)
    _assert_binary_lda(second, '2.0', '1.0')
    assert store.load_codebook('identity') == expected_book
    assert store.get_meta('identity') == reversed_meta
    assert reversed_meta['valuesFingerprint'] == initial_meta['valuesFingerprint']
    assert store.get_dataframe('identity').to_dicts() == frame.to_dicts()

    low, high = _category('10', '10', '低'), _category('20', '20', '高')
    assert first['classCategories'] == {'1.0': [low], '2.0': [high]}
    assert second['classCategories'] == {'1.0': [high], '2.0': [low]}
    decoded = []
    for revision, result in enumerate((first, second), start=1):
        assert result['targetDtype'] == 'Int64'
        assert result['classes'] == list(result['classCategories']) == ['1.0', '2.0']
        assert result['dataRevision'] == 1
        assert result['schemaRevision'] == revision
        assert result['scopeCount'] == 8
        assert result['excludedRowCount'] == 2
        assert result['excludedCounts'] == {'ordinaryMissing': 2}
        decode = {key: categories[0]['rawValue'] for key, categories in result['classCategories'].items()}
        decoded.append({sample['rowId']: {
            'actual': decode[sample['actualClass']], 'predicted': decode[sample['predictedClass']],
            'probabilities': {decode[key]: probability for key, probability in sample['posteriorProbabilities'].items()},
        } for sample in result['samples']})
        for row_id, raw in zip(ROW_IDS, ['10'] * 3 + ['20'] * 3):
            assert decoded[-1][row_id]['actual'] == decoded[-1][row_id]['predicted'] == raw
    assert decoded[0] == decoded[1]
    assert first['scopeHash'] == second['scopeHash']


@pytest.mark.parametrize(('dtype', 'low', 'high', 'raw_values', 'codes'), [
    pytest.param(pl.Int64, 10, 20, ['10', '20'], ['10', '20'], id='nominal-integers'),
    pytest.param(pl.Float64, 10.0, 20.0, ['10.0', '20.0'], ['10', '20'], id='nominal-floats'),
    pytest.param(pl.String, '01', '1', ['01', '1'], ['01', '1'], id='literal-leading-zero'),
    pytest.param(pl.String, '1', '1.0', ['1', '1.0'], ['1', '1.0'], id='literal-decimal'),
    pytest.param(pl.Int64, 9007199254740992, 9007199254740993,
                 ['9007199254740992', '9007199254740993'], ['9007199254740992', '9007199254740993'],
                 id='exact-large-integers'),
])
def test_nominal_scalar_identity_preserves_stored_text_and_type(store, dtype, low, high, raw_values, codes):
    frame = _binary_frame(low, high, dtype)
    _save(store, frame, {'valueLabels': {codes[0]: 'Low', codes[1]: 'High'}})
    result = _fit()
    _assert_binary_lda(result, *raw_values)
    assert result['targetDtype'] == str(dtype)
    assert result['classes'] == list(result['classCategories']) == raw_values
    assert result['classCategories'] == {
        raw_values[0]: [_category(raw_values[0], codes[0], 'Low')],
        raw_values[1]: [_category(raw_values[1], codes[1], 'High')],
    }
    assert store.get_dataframe('identity').to_dicts() == frame.to_dicts()


@pytest.mark.parametrize('labels', [{'10': 'Same', '20': 'Same'}, {'10': 'Low'}, {}],
                         ids=['duplicate-labels', 'partial-labels', 'raw-fallback'])
def test_fit_time_labels_are_frozen_and_do_not_replace_raw_identity(store, labels):
    _save(store, _binary_frame(), {'valueLabels': labels})
    result = _fit()
    _assert_binary_lda(result)
    expected = {code: [_category(code, code, labels.get(code, code))] for code in ['10', '20']}
    assert result['classCategories'] == expected
    datasets.update_codebook('identity', {'expectedSchemaRevision': 1, 'columns': [{
        'columnId': 'answer-id', 'valueLabels': {'10': 'Changed low', '20': 'Changed high'},
    }]})
    later = _fit(revision=2)
    assert later['classCategories'] == {
        '10': [_category('10', '10', 'Changed low')], '20': [_category('20', '20', 'Changed high')],
    }
    assert result['classCategories'] == expected
    assert result['schemaRevision'] == 1


def test_reversed_numeric_target_keeps_original_dtype_and_categories(store):
    _save(store, _binary_frame(), {'scaleType': 'ratio', 'isReversed': True, 'categoryOrder': ['10', '20'],
                                 'valueLabels': {'10': 'Low', '20': 'High'}})
    result = _fit()
    _assert_binary_lda(result, '20.0', '10.0')
    assert result['targetDtype'] == 'Int64'
    assert result['classes'] == list(result['classCategories']) == ['10.0', '20.0']
    assert result['classCategories'] == {
        '10.0': [_category('20', '20', 'High')], '20.0': [_category('10', '10', 'Low')],
    }


def test_multiclass_metadata_uses_returned_class_order_and_independent_probabilities(store):
    raw = [2, 10, 30] * 3
    x = [-1.0, 2.0, 5.0, 0.0, 3.0, 6.0, 1.0, 4.0, 7.0]
    ids = [f'r{80 - index * 7}' for index in range(9)]
    _save(store, pl.DataFrame({'__rowId__': ids, 'x': x, 'answer': raw}),
          {'valueLabels': {'2': 'Two', '10': 'Ten', '30': 'Thirty', '99': 'Unobserved'}})
    result = _fit()
    assert result['classes'] == list(result['classCategories']) == ['10', '2', '30']
    assert result['classCategories'] == {
        key: [_category(key, key, label)] for key, label in [('10', 'Ten'), ('2', 'Two'), ('30', 'Thirty')]
    }
    assert result['diagnostics']['classCounts'] == {'10': 3, '2': 3, '30': 3}
    assert result['usedRows'] == 9
    assert result['accuracy'] == 1.0
    assert result['misclassifiedRowIds'] == []
    by_id = {sample['rowId']: sample for sample in result['samples']}
    assert len(result['samples']) == 9
    assert set(by_id) == set(ids)
    # Three means 0/3/6 and pooled variance 1 give these scalar normal log scores.
    for row_id, value, actual in zip(ids, x, raw):
        scores = {key: math.exp(mean * value - mean * mean / 2) for key, mean in [('2', 0), ('10', 3), ('30', 6)]}
        sample = by_id[row_id]
        assert sample['actualClass'] == sample['predictedClass'] == str(actual)
        for key, score in scores.items():
            assert sample['posteriorProbabilities'][key] == pytest.approx(score / sum(scores.values()), abs=5e-5)


def test_ordinary_metadata_excludes_invalid_missing_unused_and_unscoped_values(store):
    excluded = pl.DataFrame({
        '__rowId__': ['semantic', 'physical', 'nan-target', 'inf-target', 'invalid', 'no-feature', 'outside'],
        'x': [0.0, 0.0, 0.0, 0.0, 0.0, None, 0.0],
        'answer': [99.0, None, float('nan'), float('inf'), 77.0, 30.0, 40.0],
    })
    frame = pl.concat([excluded, _binary_frame(10.0, 20.0, pl.Float64)])
    _save(store, frame, {'categoryOrder': ['10', '20', '30', '40', '50', '99'], 'missingCodes': ['99'],
                         'valueLabels': {'10': 'Low', '20': 'High', '30': 'Unused', '40': 'Unscoped', '50': 'Unobserved'}})
    active = [row_id for row_id in frame['__rowId__'].to_list() if row_id != 'outside']
    result = _fit(active_row_ids=list(reversed(active)))
    _assert_binary_lda(result, '10.0', '20.0')
    assert result['targetDtype'] == 'Float64'
    assert result['classCategories'] == {
        '10.0': [_category('10.0', '10', 'Low')], '20.0': [_category('20.0', '20', 'High')],
    }
    assert result['scopeCount'] == 12
    assert result['excludedRowCount'] == 6
    assert result['excludedCounts'] == {'ordinaryMissing': 6}


def test_ma_metadata_retains_all_used_source_codes_and_excludes_invalid_populations(store):
    valid = pl.DataFrame({'__rowId__': ROW_IDS, 'x': X, 'answer': [11, 10, 11, 21, 20, 21], 'sibling': [10] * 6})
    excluded = pl.DataFrame({
        '__rowId__': ['semantic', 'physical', 'invalid', 'no-feature', 'partial', 'inf-feature', 'outside'],
        'x': [0.0, 0.0, 0.0, None, 0.0, float('inf'), 0.0],
        'answer': [99, None, 77, 22, 24, 25, 23], 'sibling': [10, 10, 10, 10, 99, 10, 10],
    })
    frame = pl.concat([excluded, valid])
    _save(store, frame, {'multiResponseGroup': 'g', 'missingCodes': ['99'],
                         'valueLabels': {'10': 'No', '20': 'Selected', '21': 'Selected', '22': 'Unused', '26': 'Unobserved'}},
          other_specs=[{'columnId': 'sibling-id', 'name': 'sibling', 'role': 'question', 'scaleType': 'nominal',
                        'multiResponseGroup': 'g', 'missingCodes': ['99']}],
          groups=[{'groupId': 'g', 'selectedCodes': ['20', '21', '22', '23', '24', '25', '26'],
                   'unselectedCodes': ['10', '11', '12']}])
    active = [row_id for row_id in frame['__rowId__'].to_list() if row_id != 'outside']
    result = _fit(active_row_ids=list(reversed(active)))
    _assert_binary_lda(result, '0', '1')
    assert result['targetDtype'] == 'Int64'
    assert result['classes'] == list(result['classCategories']) == ['0', '1']
    assert result['classCategories'] == {
        '0': [_category('10', '10', 'No'), _category('11', '11', '11')],
        '1': [_category('20', '20', 'Selected'), _category('21', '21', 'Selected')],
    }
    assert result['scopeCount'] == 12
    assert result['excludedRowCount'] == 6
    assert result['excludedCounts'] == {
        'g': {'valid': 8, 'missing': 0, 'partial': 3, 'notApplicable': 0, 'invalid': 1}, 'ordinaryMissing': 2,
    }
    by_id = dict(zip(ROW_IDS, valid['answer'].to_list()))
    for sample in result['samples']:
        assert str(by_id[sample['rowId']]) in {
            category['rawValue'] for category in result['classCategories'][sample['actualClass']]
        }


@pytest.mark.parametrize(('dtype', 'values', 'selected', 'unselected', 'expected'), [
    pytest.param(pl.String, ['1', '01', '1', '1.0', '1.0', '1.0'], ['1.0'], ['01', '1'],
                 {'0': [_category('01', '01', '01'), _category('1', '1', '1')],
                  '1': [_category('1.0', '1.0', '1.0')]}, id='literal-strings'),
    pytest.param(pl.Float64, [0.0, -0.0, 0.0, 1.0, 1.0, 1.0], ['1'], ['0'],
                 {'0': [_category('-0.0', '0', '0'), _category('0.0', '0', '0')],
                  '1': [_category('1.0', '1', '1')]}, id='distinct-raw-text-same-lookup-code'),
])
def test_ma_deduplicates_raw_text_instead_of_normalized_lookup_code(store, dtype, values, selected, unselected, expected):
    _save(store, pl.DataFrame({'__rowId__': ROW_IDS, 'x': X, 'answer': pl.Series(values, dtype=dtype)}),
          {'multiResponseGroup': 'g'}, groups=[{'groupId': 'g', 'selectedCodes': selected, 'unselectedCodes': unselected}])
    result = _fit()
    _assert_binary_lda(result, '0', '1')
    assert result['targetDtype'] == str(dtype)
    assert result['classCategories'] == expected
