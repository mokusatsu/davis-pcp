"""STAT-02: closed crosstab domains and coherent full-cell selection."""
from __future__ import annotations
import polars as pl
import pytest
from fastapi.testclient import TestClient
from app.algorithms.summaries.crosstab import compute_crosstab
from app.algorithms.summaries.core import question_summary

def _closed_crosstab_fixture():
    values = [(a, b) for a in ['1', '2'] for b in ['X', 'Y'] for _ in range(20)]
    values += [('9', 'X')] * 80
    frame = pl.DataFrame({'__rowId__': [f'r{i}' for i in range(160)],
                          'a': [a for a, b in values], 'b': [b for a, b in values]})
    book = {'columns': [
        {'name': 'a', 'columnId': 'a', 'scaleType': 'nominal', 'role': 'question', 'categoryOrder': ['1', '2']},
        {'name': 'b', 'columnId': 'b', 'scaleType': 'nominal', 'role': 'question', 'categoryOrder': ['X', 'Y']},
    ]}
    return frame, book


def test_stat02_closed_domain_excludes_invalid_from_table_and_inference():
    frame, book = _closed_crosstab_fixture()
    result = compute_crosstab(frame, 'a', 'b', book)
    assert result['effectiveN'] == 80
    assert result['algorithmVersion'] == 'crosstab-survey-3'
    assert result['analysisProvenance']['algorithmVersion'] == 'crosstab-survey-3'
    assert result['invalidCount'] == 80
    assert result['missingCount'] == 0
    assert [c['id'] for c in result['rowCategories']] == ['1', '2']
    assert [c['count'] for c in result['cells']] == [20.] * 4
    assert result['descriptiveAssociation']['pearsonChi2'] == 0
    assert result['descriptiveAssociation']['df'] == 1
    assert result['inference']['pValue'] == 1
    summary = question_summary(frame['a'], book['columns'][0])
    assert result['effectiveN'] == summary['denominators']['valid']
    assert result['invalidCount'] == summary['denominators']['invalid']
    assert set().union(*(set(c['rowIds']) for c in result['cells'])) == set(frame['__rowId__'].to_list()[:80])


@pytest.mark.parametrize('policy,expected_n', [('exclude', 1), ('include_missing', 3), ('separate_not_applicable', 3)])
def test_stat02_missing_and_invalid_are_distinct(policy, expected_n):
    frame = pl.DataFrame({'a': ['1', '9', '99', '98', '9'], 'b': ['X', 'X', 'X', 'X', None]})
    book = {'columns': [
        {'name': 'a', 'scaleType': 'nominal', 'categoryOrder': [1., 2., 99., 98.],
         'missingCodes': ['99', '98'], 'missingReasons': {'99': 'missing', '98': 'not_applicable'}},
        {'name': 'b', 'scaleType': 'nominal', 'categoryOrder': ['X', 'Y']},
    ]}
    result = compute_crosstab(frame, 'a', 'b', book, missing_policy=policy)
    assert result['invalidCount'] == 2
    assert result['effectiveN'] == expected_n
    assert result['missingCount'] == (2 if policy == 'exclude' else 0)
    assert '9' not in [c['id'] for c in result['rowCategories']]
    assert '99' not in [c['id'] for c in result['rowCategories']]
    assert '98' not in [c['id'] for c in result['rowCategories']]


def test_stat02_open_domain_still_infers_observed_categories():
    frame, book = _closed_crosstab_fixture()
    book['columns'][0].pop('categoryOrder')
    result = compute_crosstab(frame, 'a', 'b', book)
    assert result['effectiveN'] == 160
    assert result['invalidCount'] == 0
    assert [c['id'] for c in result['rowCategories']] == ['1', '2', '9']


@pytest.fixture
def audit_api(tmp_path, monkeypatch):
    from app.config import settings
    from app.main import app
    from app.api import datasets, summaries, multi_response, conjoint, analysis_results
    from app.storage.dataset_store import DatasetStore
    monkeypatch.setattr(settings, 'workspace_dir', tmp_path)
    settings.ensure_dirs()
    store = DatasetStore(tmp_path)
    for module in [datasets, summaries, multi_response, conjoint, analysis_results]:
        monkeypatch.setattr(module, 'store', store)
    multi_response._summary_cache.clear()
    with TestClient(app) as client:
        yield client, store
    multi_response._summary_cache.clear()


def test_stat02_cell_selection_cannot_resurrect_invalid_rows(audit_api):
    client, store = audit_api
    frame, _ = _closed_crosstab_fixture()
    response = client.post('/api/v1/datasets/import', files={
        'file': ('closed-domain.csv', frame.drop('__rowId__').write_csv().encode(), 'text/csv'),
    })
    assert response.status_code == 200, response.text
    dataset_id = response.json()['datasetId']
    book = client.get(f'/api/v1/datasets/{dataset_id}/codebook').json()
    by_name = {column['name']: column for column in book['columns']}
    response = client.put(f'/api/v1/datasets/{dataset_id}/codebook', json={'columns': [
        {'columnId': by_name[name]['columnId'], 'role': 'question', 'scaleType': 'nominal', 'categoryOrder': domain}
        for name, domain in [('a', ['1', '2']), ('b', ['X', 'Y'])]
    ]})
    assert response.status_code == 200, response.text
    meta = client.get(f'/api/v1/datasets/{dataset_id}').json()
    book = client.get(f'/api/v1/datasets/{dataset_id}/codebook').json()
    context = {'datasetId': dataset_id, 'expectedDataRevision': meta['dataRevision'],
               'expectedSchemaRevision': book['schemaRevision'], 'scope': 'all',
               'weightMode': 'none', 'missingPolicy': 'exclude'}
    request = {'context': context, 'rowVariableId': 'a', 'colVariableId': 'b'}
    table = client.post('/api/v1/summaries/crosstab', json={**request, 'maxRowIdsPerCell': 1})
    assert table.status_code == 200, table.text
    result = table.json()
    assert result['meta']['algorithmVersion'] == 'crosstab-survey-3'
    assert result['effectiveN'] == 80
    assert result['algorithmVersion'] == 'crosstab-survey-3'
    assert result['analysisProvenance']['algorithmVersion'] == 'crosstab-survey-3'
    assert result['invalidCount'] == 80
    imported = store.get_dataframe(dataset_id)
    expected = [str(v) for v in imported.filter((pl.col('a').cast(pl.String) == '1') & (pl.col('b') == 'X'))['__rowId__'].to_list()]
    cell = next(c for c in result['cells'] if c['rowCategoryId'] == '1' and c['colCategoryId'] == 'X')
    assert cell['rowIds'] == expected[:1]
    assert cell['rowIdCount'] == 20
    assert cell['rowIdsTruncated'] is True
    for category, expected_ids in [('1', sorted(expected)), ('9', [])]:
        response = client.post('/api/v1/summaries/crosstab/cell-row-ids', json={
            **request, 'rowCategoryId': category, 'colCategoryId': 'X',
        })
        assert response.status_code == 200, response.text
        assert response.json()['rowIdCount'] == len(expected_ids)
        assert response.json()['rowIds'] == expected_ids
        assert response.json()['rowIdsTruncated'] is False


@pytest.mark.parametrize('policy,expected_n', [('exclude', 0), ('include_missing', 2), ('separate_not_applicable', 2)])
def test_stat02_domain_containing_only_missing_codes(policy, expected_n):
    frame = pl.DataFrame({'a': ['99', '98', '9'], 'b': ['X'] * 3})
    book = {'columns': [
        {'name': 'a', 'scaleType': 'nominal', 'categoryOrder': ['99', '98'],
         'missingCodes': ['99', '98'], 'missingReasons': {'98': 'not_applicable'}},
        {'name': 'b', 'scaleType': 'nominal', 'categoryOrder': ['X']},
    ]}
    result = compute_crosstab(frame, 'a', 'b', book, missing_policy=policy)
    assert result['effectiveN'] == expected_n
    assert result['invalidCount'] == 1
    assert result['missingCount'] == (2 if policy == 'exclude' else 0)
    assert not {'99', '98', '9'}.intersection(c['id'] for c in result['rowCategories'])


def test_stat02_numeric_looking_strings_keep_their_existing_code_identity():
    frame = pl.DataFrame({'a': ['1', '01'], 'b': ['X', 'X']})
    book = {'columns': [
        {'name': 'a', 'scaleType': 'nominal', 'categoryOrder': [1.], 'valueLabels': {'1': 'One', '01': 'Leading zero'}},
        {'name': 'b', 'scaleType': 'nominal'},
    ]}
    result = compute_crosstab(frame, 'a', 'b', book)
    assert result['effectiveN'] == 1
    assert result['invalidCount'] == 1
    assert [c['id'] for c in result['rowCategories']] == ['1']


@pytest.mark.parametrize('weight_type', ['frequency', 'survey'])
def test_stat02_invalid_rows_cannot_add_weight_to_counts_or_inference(weight_type):
    frame, book = _closed_crosstab_fixture()
    result = compute_crosstab(frame, 'a', 'b', book,
                              weights=[1.] * 80 + [100.] * 80,
                              weight_type=weight_type)
    assert result['grandTotal']['count'] == 80
    assert result['effectiveN'] == 80
    assert result['algorithmVersion'] == 'crosstab-survey-3'
    assert result['analysisProvenance']['algorithmVersion'] == 'crosstab-survey-3'
    assert result['invalidCount'] == 80
    assert [cell['count'] for cell in result['cells']] == [20.] * 4
    assert result['descriptiveAssociation']['pearsonChi2'] == 0
    if weight_type == 'frequency':
        assert result['inference']['pValue'] == 1


def test_stat02_reason_keys_do_not_independently_declare_missing_values():
    frame = pl.DataFrame({'a': ['1', '2', '9'], 'b': ['X'] * 3})
    book = {'columns': [
        {'name': 'a', 'scaleType': 'nominal', 'categoryOrder': ['1', '2'],
         'missingReasons': {'2': 'not_applicable', '9': 'not_applicable'}},
        {'name': 'b', 'scaleType': 'nominal'},
    ]}
    result = compute_crosstab(frame, 'a', 'b', book, missing_policy='separate_not_applicable')
    assert result['effectiveN'] == 2
    assert result['invalidCount'] == 1
    assert result['missingCount'] == 0
    assert [c['id'] for c in result['rowCategories']] == ['1', '2']


def test_stat02_invalid_values_on_either_or_both_axes_count_rows_once():
    frame = pl.DataFrame({'a': ['1', '1', '9', '9'], 'b': ['X', 'bad', 'X', 'bad']})
    book = {'columns': [
        {'name': 'a', 'scaleType': 'nominal', 'categoryOrder': ['1']},
        {'name': 'b', 'scaleType': 'nominal', 'categoryOrder': ['X']},
    ]}
    result = compute_crosstab(frame, 'a', 'b', book)
    assert result['effectiveN'] == 1
    assert result['invalidCount'] == 3
    assert result['missingCount'] == 0
    assert result['cells'][0]['rowIds'] == ['0']
