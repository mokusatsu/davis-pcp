"""Stored outcome identities must follow the fitted Logistic sample membership."""
import math

import polars as pl
import pytest

from app.api import logistic
from app.algorithms.models.logistic import run_logistic_regression
from app.storage.dataset_store import DatasetStore


ROW_IDS = ['r84', 'r7', 'r63', 'r21', 'r98', 'r14', 'r77', 'r35']
X = [0.0] * 4 + [1.0] * 4
ACTUAL = [0, 0, 0, 1, 0, 1, 1, 1]


@pytest.fixture
def store(tmp_path, monkeypatch):
    dataset_store = DatasetStore(tmp_path)
    monkeypatch.setattr(logistic, 'store', dataset_store)
    return dataset_store


def _binary_frame(low, high, dtype):
    return pl.DataFrame({
        '__rowId__': ROW_IDS,
        'x': X,
        'answer': pl.Series([high if actual else low for actual in ACTUAL], dtype=dtype),
    })


def _fit(store, frame, target_spec=None, *, other_specs=(), groups=(), active_row_ids=None):
    codebook = {'schemaRevision': 1, 'columns': [
        {'columnId': 'x-id', 'name': 'x', 'scaleType': 'ratio', 'role': 'attribute', 'missingCodes': []},
        {'columnId': 'answer-id', 'name': 'answer', 'scaleType': 'nominal',
         'role': 'question', 'missingCodes': [], **(target_spec or {})},
        *other_specs,
    ], 'multiResponseGroups': list(groups)}
    store.save('identity', {'datasetId': 'identity', 'fingerprint': 'class-identity'}, frame, codebook=codebook)
    return logistic.fit_logistic(logistic.LogisticRequestSchema(
        datasetId='identity', targetColumn='answer-id', featureColumns=['x-id'],
        expectedDataRevision=1, expectedSchemaRevision=1, activeRowIds=active_row_ids,
        intercept=True, regularization='none', cutoff=0.5,
    ))


def _category(raw_value, code, label):
    return {'rawValue': raw_value, 'code': code, 'label': label}


def _assert_grouped_binomial(result, *, reverse=False):
    """Independent eight-row oracle: P(event|x=0)=1/4 and P(event|x=1)=3/4."""
    assert result['usedRows'] == 8
    assert result['features'] == ['x']
    assert result['usedColumns'] == ['x', 'answer']
    assert result['fitMetrics']['converged'] is True
    assert result['diagnostics']['fallbackUsed'] is False
    assert result['diagnostics']['completeSeparation'] is False
    coefficients = {item['name']: item for item in result['coefficients']}
    sign = -1 if reverse else 1
    assert coefficients['Intercept']['coefficient'] == pytest.approx(-sign * math.log(3), abs=2e-5)
    assert coefficients['x']['coefficient'] == pytest.approx(sign * math.log(9), abs=2e-5)
    assert coefficients['x']['oddsRatio'] == pytest.approx(9 ** sign, rel=2e-5)
    assert result['fitMetrics']['logLikelihood'] == pytest.approx(
        2 * math.log(0.25) + 6 * math.log(0.75), abs=1e-4)
    by_id = {sample['rowId']: sample for sample in result['samples']}
    assert len(result['samples']) == 8
    assert set(by_id) == set(ROW_IDS)
    cells = {'tn': [], 'fp': [], 'fn': [], 'tp': []}
    for row_id, x, actual in zip(ROW_IDS, X, ACTUAL):
        actual = 1 - actual if reverse else actual
        probability = (0.75 if x == 0 else 0.25) if reverse else (0.25 if x == 0 else 0.75)
        predicted = int(probability >= 0.5)
        sample = by_id[row_id]
        assert sample['actual'] == actual
        assert sample['predictedProb'] == pytest.approx(probability, abs=1e-5)
        assert sample['predictedClass'] == predicted
        assert sample['residual'] == pytest.approx(actual - probability, abs=1e-5)
        assert sample['isMisclassified'] is (actual != predicted)
        assert sample['featureValues'] == {'x': x}
        cells[('tn', 'fp', 'fn', 'tp')[2 * actual + predicted]].append(row_id)
    for name, row_ids in cells.items():
        assert result['confusionMatrix'][name] == len(row_ids)
        assert set(result['confusionMatrix'][name + 'RowIds']) == set(row_ids)


@pytest.mark.parametrize(('scale', 'reverse', 'low', 'high', 'classes'), [
    pytest.param('nominal', False, 0, 1, ['0', '1'], id='literal-control'),
    pytest.param('nominal', False, 10, 20, ['10', '20'], id='nominal-codes'),
    pytest.param('ordinal', False, 10, 20, ['1.0', '2.0'], id='ordinal'),
    pytest.param('ordinal', True, 10, 20, ['1.0', '2.0'], id='ordinal-reversed'),
])
def test_proved_binary_cases_keep_numbers_and_expose_raw_event(store, scale, reverse, low, high, classes):
    frame = _binary_frame(low, high, pl.Int64)
    result = _fit(store, frame, {
        'scaleType': scale, 'isReversed': reverse, 'categoryOrder': [str(low), str(high)],
        'valueLabels': {str(low): '低', str(high): '高'},
    })
    categories = [[_category(str(low), str(low), '低')], [_category(str(high), str(high), '高')]]
    assert result['targetDtype'] == 'Int64'
    assert result['classCategories'] == (list(reversed(categories)) if reverse else categories)
    assert result['classes'] == classes
    assert result['scopeCount'] == 8
    assert result['excludedRowCount'] == 0
    assert result['excludedCounts'] == {'ordinaryMissing': 0}
    assert store.get_dataframe('identity').to_dicts() == frame.to_dicts()
    _assert_grouped_binomial(result, reverse=reverse)

    # The route must pass every existing kernel field through unchanged. Supply
    # the known analysis target explicitly, independently of the route adapter.
    if scale == 'ordinal':
        scores = [float(2 - actual if reverse else 1 + actual) for actual in ACTUAL]
        analysis_frame = frame.with_columns(pl.Series('answer', scores))
    else:
        analysis_frame = frame
    expected = run_logistic_regression(analysis_frame, 'answer', ['x'])
    for field, expected_value in expected.items():
        if field == 'samples':
            assert [{key: value for key, value in sample.items() if key != 'featureValues'}
                    for sample in result['samples']] == expected_value
        else:
            assert result[field] == expected_value


@pytest.mark.parametrize(('dtype', 'low', 'high', 'dtype_name', 'raw_values', 'codes'), [
    pytest.param(pl.Int64, 1, 2, 'Int64', ['1', '2'], ['1', '2'], id='integer'),
    pytest.param(pl.Float64, 1.0, 2.0, 'Float64', ['1.0', '2.0'], ['1', '2'], id='float'),
    pytest.param(pl.String, '01', '1', 'String', ['01', '1'], ['01', '1'], id='literal-leading-zero'),
    pytest.param(pl.String, '1', '1.0', 'String', ['1', '1.0'], ['1', '1.0'], id='literal-decimal'),
    pytest.param(pl.Int64, 9007199254740992, 9007199254740993, 'Int64',
                 ['9007199254740992', '9007199254740993'],
                 ['9007199254740992', '9007199254740993'], id='exact-large-integers'),
])
def test_stored_scalar_identity_is_separate_from_lookup_code(store, dtype, low, high, dtype_name, raw_values, codes):
    result = _fit(store, _binary_frame(low, high, dtype), {'valueLabels': {codes[0]: 'Low', codes[1]: 'High'}})
    assert result['targetDtype'] == dtype_name
    assert result['classCategories'] == [
        [_category(raw_values[0], codes[0], 'Low')], [_category(raw_values[1], codes[1], 'High')],
    ]
    assert result['classes'] == raw_values
    _assert_grouped_binomial(result)


@pytest.mark.parametrize('labels', [{'10': 'Same', '20': 'Same'}, {'10': 'Low'}, {}],
                         ids=['duplicate-labels', 'partial-labels', 'raw-fallback'])
def test_labels_are_a_snapshot_and_never_replace_raw_identity(store, labels):
    result = _fit(store, _binary_frame(10, 20, pl.Int64), {'valueLabels': labels})
    expected = [[_category(code, code, labels.get(code, code))] for code in ['10', '20']]
    assert result['classCategories'] == expected
    # Later dictionary edits cannot reinterpret this already-completed response.
    changed = store.load_codebook('identity')
    changed['columns'][1]['valueLabels'] = {'10': 'Changed low', '20': 'Changed high'}
    store.save_metadata('identity', store.get_meta('identity'), changed)
    assert result['classCategories'] == expected
    _assert_grouped_binomial(result)


def test_reversed_numeric_target_keeps_stored_dtype_and_event_identity(store):
    result = _fit(store, _binary_frame(10, 20, pl.Int64), {
        'scaleType': 'ratio', 'isReversed': True, 'categoryOrder': ['10', '20'],
        'valueLabels': {'10': 'Low', '20': 'High'},
    })
    assert result['targetDtype'] == 'Int64'
    assert result['classes'] == ['10.0', '20.0']
    assert result['classCategories'] == [[_category('20', '20', 'High')], [_category('10', '10', 'Low')]]
    _assert_grouped_binomial(result, reverse=True)


def test_ordinary_metadata_excludes_missing_invalid_unused_and_unscoped_rows(store):
    valid = _binary_frame(10.0, 20.0, pl.Float64)
    excluded = pl.DataFrame({
        '__rowId__': ['semantic', 'physical', 'nan-target', 'inf-target', 'invalid', 'no-feature', 'outside'],
        'x': [0.0, 0.0, 0.0, 0.0, 0.0, None, 0.0],
        'answer': [99.0, None, float('nan'), float('inf'), 77.0, 30.0, 40.0],
    })
    # Excluded rows come before valid rows to detect positional rather than rowId joins.
    frame = pl.concat([excluded, valid])
    active = [row_id for row_id in frame['__rowId__'].to_list() if row_id != 'outside']
    result = _fit(store, frame, {
        'categoryOrder': ['10', '20', '30', '40', '50', '99'], 'missingCodes': ['99'],
        'valueLabels': {'10': 'Low', '20': 'High', '30': 'Unused', '40': 'Unscoped', '50': 'Unobserved', '99': 'Missing'},
    }, active_row_ids=list(reversed(active)))
    assert result['targetDtype'] == 'Float64'
    assert result['classCategories'] == [[_category('10.0', '10', 'Low')], [_category('20.0', '20', 'High')]]
    assert result['scopeCount'] == 14
    assert result['excludedRowCount'] == 6
    assert result['excludedCounts'] == {'ordinaryMissing': 6}
    _assert_grouped_binomial(result)


def test_ma_metadata_keeps_all_used_source_codes_and_excludes_invalid_populations(store):
    valid = pl.DataFrame({'__rowId__': ROW_IDS, 'x': X,
                          'answer': [10, 11, 10, 20, 11, 20, 21, 21], 'sibling': [10] * 8})
    excluded = pl.DataFrame({
        '__rowId__': ['semantic', 'physical', 'invalid', 'no-feature', 'partial', 'inf-feature', 'outside'],
        'x': [0.0, 0.0, 0.0, None, 0.0, float('inf'), 0.0],
        'answer': [99, None, 77, 22, 24, 25, 23],
        'sibling': [10, 10, 10, 10, 99, 10, 10],
    })
    frame = pl.concat([excluded, valid])
    active = [row_id for row_id in frame['__rowId__'].to_list() if row_id != 'outside']
    result = _fit(store, frame, {
        'multiResponseGroup': 'g', 'missingCodes': ['99'],
        'valueLabels': {'10': 'No', '20': 'Selected', '21': 'Selected', '22': 'Unused', '23': 'Unscoped', '26': 'Unobserved'},
    }, other_specs=[{'columnId': 'sibling-id', 'name': 'sibling', 'role': 'question',
                     'scaleType': 'nominal', 'multiResponseGroup': 'g', 'missingCodes': ['99']}],
       groups=[{'groupId': 'g', 'selectedCodes': ['20', '21', '22', '23', '24', '25', '26'],
                'unselectedCodes': ['10', '11', '12']}], active_row_ids=list(reversed(active)))
    assert result['targetDtype'] == 'Int64'
    assert result['classes'] == ['0', '1']
    assert result['classCategories'] == [
        [_category('10', '10', 'No'), _category('11', '11', '11')],
        [_category('20', '20', 'Selected'), _category('21', '21', 'Selected')],
    ]
    assert result['scopeCount'] == 14
    assert result['excludedRowCount'] == 6
    assert result['excludedCounts'] == {
        'g': {'valid': 10, 'missing': 0, 'partial': 3, 'notApplicable': 0, 'invalid': 1},
        'ordinaryMissing': 2,
    }
    _assert_grouped_binomial(result)


@pytest.mark.parametrize(('dtype', 'values', 'selected', 'unselected', 'expected'), [
    pytest.param(pl.String, ['01', '1', '01', '1.0', '1', '1.0', '1.0', '1.0'], ['1.0'], ['01', '1'],
                 [[_category('01', '01', '01'), _category('1', '1', '1')], [_category('1.0', '1.0', '1.0')]],
                 id='distinct-literal-strings'),
])
def test_ma_deduplicates_raw_identity_not_lookup_codes(store, dtype, values, selected, unselected, expected):
    frame = pl.DataFrame({'__rowId__': ROW_IDS, 'x': X, 'answer': pl.Series(values, dtype=dtype)})
    result = _fit(store, frame, {'multiResponseGroup': 'g'},
                  groups=[{'groupId': 'g', 'selectedCodes': selected, 'unselectedCodes': unselected}])
    assert result['targetDtype'] == str(dtype)
    assert result['classes'] == ['0', '1']
    assert result['classCategories'] == expected
    _assert_grouped_binomial(result)
