import csv
import io
import zipfile
from xml.etree import ElementTree as ET

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.algorithms.summaries.core import question_summary
from app.domain.codebook_adapter import CodebookAdapter, normalize_code


@pytest.fixture
def survey():
    with TestClient(app) as client:
        text = 'gender,Q1,Q2\n' + '\n'.join(
            f'{1 if i < 40 else 2},{1 if i < 40 else 4},{2 if i < 40 else 5}' for i in range(80)
        ) + '\n1,98,99\n2,99,98\n1,,\n'
        response = client.post('/api/v1/datasets/import', files={'file': ('survey.csv', text, 'text/csv')})
        assert response.status_code == 200, response.text
        dataset_id = response.json()['datasetId']
        cb = client.get(f'/api/v1/datasets/{dataset_id}/codebook').json()
        for c in cb['columns']:
            c.update(role='attribute' if c['name'] == 'gender' else 'question',
                     scaleType='nominal' if c['name'] == 'gender' else 'ordinal',
                     label='性別' if c['name'] == 'gender' else '満足度',
                     categoryOrder=['1', '2'] if c['name'] == 'gender' else ['1', '2', '3', '4', '5'],
                     valueLabels={'1': '男性', '2': '女性'} if c['name'] == 'gender' else {'1': '不満', '4': '満足', '98': '非該当', '99': '無回答'},
                     missingCodes=['98', '99'], missingReasons={'98': '非該当', '99': '無回答'})
        assert client.put(f'/api/v1/datasets/{dataset_id}/codebook', json={'columns': cb['columns']}).status_code == 200
        yield client, dataset_id, cb
        client.delete(f'/api/v1/datasets/{dataset_id}')


def test_summary_api_denominators_and_revision(survey):
    client, ds, cb = survey
    request = {'datasetId': ds, 'columns': ['Q1']}
    first = client.post('/api/v1/summaries', json=request).json()
    summary = first['columns']['Q1']
    assert summary['denominators'] == {'total': 83, 'target': 82, 'valid': 80, 'missing': 2, 'notApplicable': 1}
    assert summary['auxiliaryStats']['top2Box'] == {'pct': 50.0, 'n': 40}
    assert next(d for d in summary['distribution'] if d['code'] == '5')['count'] == 0
    assert client.post('/api/v1/summaries', json=request).json()['cacheHit'] is True
    col = next(c for c in cb['columns'] if c['name'] == 'Q1')
    client.put(f'/api/v1/datasets/{ds}/codebook', json={'columns': [{'columnId': col['columnId'], 'isReversed': True}]})
    updated = client.post('/api/v1/summaries', json=request).json()
    assert not updated.get('cacheHit', False)
    assert updated['schemaRevision'] == first['schemaRevision'] + 1
    assert updated['columns']['Q1']['auxiliaryStats']['mean'] == 3.5
    empty = client.post('/api/v1/summaries', json={**request, 'rowIds': []}).json()
    assert empty['columns']['Q1']['denominators']['total'] == 0


def test_sparse_order_and_float_missing_codes():
    spec = {'name': 'Q', 'scaleType': 'ordinal', 'categoryOrder': ['1', '2', '3', '4', '5'],
            'missingCodes': ['98', '99'], 'missingReasons': {'98': '非該当'}}
    result = question_summary(pl.Series('Q', [1., 3., 4., 98., 99., float('nan'), None]), spec)
    assert result['denominators'] == {'total': 7, 'target': 6, 'valid': 3, 'missing': 3, 'notApplicable': 1}
    assert result['auxiliaryStats']['top2Box']['n'] == 1
    assert result['auxiliaryStats']['bottom2Box']['n'] == 1
    assert normalize_code('01') == '01'
    assert normalize_code(1.) == '1'
    adapter = CodebookAdapter(pl.DataFrame({'Q': [2., 3., 99.]}), {'columns': [{**spec, 'isReversed': True}]})
    assert adapter.get_reversed_numeric_series('Q').to_list() == [4., 3., None]


def test_projected_cards_share_base_counts_and_match_canonical_ids(survey, monkeypatch):
    from app.api import summaries
    client, ds, cb = survey
    calls = []
    read = summaries.store.get_dataframe
    def projected(dataset_id, columns=None):
        calls.append(columns)
        return read(dataset_id, columns=columns)
    monkeypatch.setattr(summaries.store, 'get_dataframe', projected)
    column_id = next(c['columnId'] for c in cb['columns'] if c['name'] == 'Q1')
    match = client.post(f'/api/v1/datasets/{ds}/column-matches', json={'columnId': column_id, 'code': '1'}).json()
    assert match['count'] == 40
    body = {'datasetId': ds, 'columns': ['Q1'], 'selectedRowIds': match['rowIds'][:2]}
    first = client.post('/api/v1/summaries', json=body).json()
    assert first['selectedCountByCode'] == {'Q1': {'1': 2}}
    second = client.post('/api/v1/summaries', json={**body, 'selectedRowIds': []}).json()
    assert second['cacheHit'] and second['selectedCountByCode'] == {'Q1': {}}
    assert second['columns'] == first['columns']
    assert all(c == ['__rowId__', 'Q1'] for c in calls)
    empty = client.post('/api/v1/summaries', json={**body, 'columns': [], 'rowIds': []}).json()
    assert empty['columns'] == {} and empty['rowCount'] == 0
    assert client.post(f'/api/v1/datasets/{ds}/column-matches', json={'columnId': column_id, 'code': '1', 'rowIds': []}).json()['rowIds'] == []


def test_labels_csv_xlsx_preserve_missing_reason(survey):
    client, ds, _ = survey
    response = client.post('/api/v1/exports', json={'datasetId': ds, 'format': 'csv', 'useValueLabels': True})
    rows = list(csv.reader(io.StringIO(response.content.decode('utf-8-sig'))))
    assert rows[1] == ['男性', '不満', '2.0'] or rows[1] == ['男性', '不満', '2']
    assert rows[-3][1:] == ['非該当', '無回答']
    response = client.post('/api/v1/exports', json={'datasetId': ds, 'format': 'xlsx', 'useValueLabels': True})
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        root = ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        texts = [n.text for n in root.findall('.//s:t', ns)]
        assert '女性' in texts and '非該当' in texts
        assert not root.findall('.//s:f', ns)


def test_mining_role_separation_and_labels(survey):
    client, ds, _ = survey
    response = client.post('/api/v1/mining/modern-subgroup', json={'datasetId': ds, 'minGroupSize': 5, 'mode': 'standard'})
    assert response.status_code == 200, response.text
    insights = response.json()['insights']
    assert insights
    for insight in insights:
        assert insight['target_question'] in ['Q1', 'Q2']
        assert all(c['column'] == 'gender' for c in insight['rule']['conditions'])
        assert any(label in insight['rule']['text'] for label in ['男性', '女性'])
    legacy = client.post('/api/v1/mining/subgroups', json={'datasetId': ds, 'minGroupSize': 5})
    assert legacy.status_code == 200, legacy.text
    assert legacy.json()['summary']['n_subgroup_vars'] == 1


def test_model_labels_missing_and_stale_result(survey):
    client, ds, cb = survey
    response = client.post('/api/v1/models', json={'datasetId': ds, 'features': ['gender'], 'target': 'Q1'})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['trainedRows'] == 80
    assert '性別' in result['treeStructures'][0]['feature']
    client.put(f'/api/v1/datasets/{ds}/codebook', json={'columns': [{'columnId': cb['columns'][0]['columnId'], 'label': '属性'}]})
    assert client.get(f"/api/v1/models/{result['resultId']}").status_code == 409


def test_pairwise_correlation_excludes_missing_codes(survey):
    client, ds, _ = survey
    result = client.post('/api/v1/summaries', json={'datasetId': ds, 'columns': ['Q1', 'Q2'], 'correlation': True}).json()
    assert result['correlation']['matrix'] == [[1., 1.], [1., 1.]]


def test_numeric_nominal_attributes_use_category_conditions():
    from app.algorithms.mining.modern_subgroup import generate_descriptors
    descriptors = generate_descriptors(pl.DataFrame({'group': list(range(12))}), ['group'], set(),
                                       column_meta={'group': {'scaleType': 'nominal'}})
    assert descriptors
    assert all(condition.operator == '==' for condition, _ in descriptors)
