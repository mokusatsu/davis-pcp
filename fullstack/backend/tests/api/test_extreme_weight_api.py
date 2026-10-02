"""Real JSON contracts for finite extreme weights; no sanitized fake success."""
import json

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.api import datasets, summaries, multi_response
    store = DatasetStore(tmp_path)
    for module in (datasets, summaries, multi_response):
        monkeypatch.setattr(module, 'store', store)
    with TestClient(app, raise_server_exceptions=False) as http:
        yield http


def load(client, rows, kind='survey', design=False):
    header = ['x', 'w', 'b', 'strata', 'psu'] if design else ['x', 'w']
    text = ','.join(header) + '\n' + '\n'.join(','.join(map(str, row)) for row in rows) + '\n'
    res = client.post('/api/v1/datasets/import', files={'file': ('edge.csv', text, 'text/csv')})
    assert res.status_code == 200, res.text
    did = res.json()['datasetId']
    cb = client.get(f'/api/v1/datasets/{did}/codebook').json()
    by_name = {c['name']: c for c in cb['columns']}
    for name, spec in by_name.items():
        spec.update(role='weight' if name == 'w' else 'question',
                    scaleType='ratio' if name == 'w' or (name == 'x' and not design) else 'nominal')
    cb['weightConfig'] = {'weightColumnId': by_name['w']['columnId'], 'weightType': kind}
    if design:
        cb['surveyDesign'] = {key: by_name[name]['columnId'] for key, name in
                              [('weightColumnId', 'w'), ('strataColumnId', 'strata'), ('psuColumnId', 'psu')]}
    res = client.put(f'/api/v1/datasets/{did}/codebook', json=cb)
    assert res.status_code == 200, res.text
    revision = client.get(f'/api/v1/datasets/{did}/codebook').json()['schemaRevision']
    return did, revision


def test_overflow_summary_serializes_mean_percentages_and_visible_range_warning(client):
    did, _ = load(client, [[x, 1e308] for x in [1, 2, 3, 1, 2, 3, 1, 2]])
    for cached in (False, True):
        response = client.post('/api/v1/summaries', json={'datasetId': did, 'columns': ['x']})
        assert response.status_code == 200, response.text
        data = response.json(); weighted = data['columns']['x']['weighted']
        assert data['cacheHit'] is cached
        assert data['weightApplied'] is True and data['weightStatus'] == 'applied'
        assert data['weightedN'] is None and data['weightedNStatus'] == 'out_of_range'
        assert data['warnings'][0]['code'] == 'WEIGHT_TOTAL_OUT_OF_RANGE'
        assert weighted['weightedMean'] == 1.875
        assert [d['weightedPct'] for d in weighted['distribution']] == [37.5, 37.5, 25.]
        assert weighted['warnings'][0]['code'] == 'WEIGHT_TOTAL_OUT_OF_RANGE'
        json.dumps(data, allow_nan=False)


@pytest.mark.parametrize('factor', [1., 1e-160, 1e160])
def test_survey_crosstab_extreme_weights_match_independent_r_reference(client, factor):
    rows = [[('甲' if i % 3 else '乙'), [.5, 1, 2, 3, 1.5][i % 5] * factor,
             ('賛成' if (i * 7) % 11 < 6 else '反対'), f'S{i % 2}', f'P{i % 6}'] for i in range(72)]
    did, revision = load(client, rows, design=True)
    response = client.post('/api/v1/summaries/crosstab', json={
        'context': {'datasetId': did, 'expectedDataRevision': 1, 'expectedSchemaRevision': revision},
        'rowVariableId': 'x', 'colVariableId': 'b', 'inference': 'rao_scott'})
    assert response.status_code == 200, response.text
    data = response.json(); inference = data['inference']; diag = data['weightDiagnostics']
    # R 4.5.0 / survey 4.4-2 svydesign(ids=~psu,strata=~strata,weights=~w,nest=TRUE).
    assert inference['status'] == 'ok'
    assert inference['pValue'] == pytest.approx(.9747186375354857, abs=1e-13)
    assert inference['statistic'] == pytest.approx(.001136800085432, abs=1e-15)
    assert inference['numeratorDf'] == 1 and inference['denominatorDf'] == 4
    assert diag['numberOfPSUs'] == 6 and diag['numberOfStrata'] == 2 and diag['positiveWeightN'] == 72
    assert diag['weightSumStatus'] == 'ok' and diag['weightSum'] > 0
    assert data['grandTotal']['count'] > 0
    assert all(cell['expectedCount'] is not None and cell['expectedCount'] > 0 for cell in data['cells'])
    assert data['descriptiveAssociation']['weightedCramersV'] is not None
    json.dumps(data, allow_nan=False)


@pytest.mark.parametrize('weight,kind,code', [(-1, 'survey', 'WEIGHT_VALUE_INVALID'),
    ('NaN', 'survey', 'WEIGHT_VALUE_INVALID'), ('Infinity', 'survey', 'WEIGHT_VALUE_INVALID'),
    (1.5, 'frequency', 'WEIGHT_FREQUENCY_NONINTEGER')])
def test_extreme_fix_does_not_weaken_weight_validation(client, weight, kind, code):
    did, _ = load(client, [[1, weight], [2, 1]], kind=kind)
    response = client.post('/api/v1/summaries', json={'datasetId': did, 'columns': ['x']})
    assert response.status_code == 422, response.text
    assert response.json()['error']['code'] == code


def test_unrepresentable_absolute_crosstab_has_specific_range_error(client):
    did, revision = load(client, [['a', 1e308, 'x', 's', 'p1'], ['b', 1e308, 'y', 's', 'p2']], design=True)
    response = client.post('/api/v1/summaries/crosstab', json={
        'context': {'datasetId': did, 'expectedDataRevision': 1, 'expectedSchemaRevision': revision},
        'rowVariableId': 'x', 'colVariableId': 'b', 'inference': 'rao_scott'})
    assert response.status_code == 422, response.text
    assert response.json()['error']['code'] == 'WEIGHT_TOTAL_OUT_OF_RANGE'


def test_extreme_summary_preserves_scope_missing_invalid_and_zero_semantics(client):
    from app.api import datasets
    did, _ = load(client, [[1, 1e308], [2, 1e308], [99, 1e308], [9, 1e308], [3, ''], [1, 0], [1, -1]])
    cb = client.get(f'/api/v1/datasets/{did}/codebook').json()
    spec = next(c for c in cb['columns'] if c['name'] == 'x')
    spec.update(scaleType='ordinal', categoryOrder=['1', '2', '3'], missingCodes=['99'])
    changed = client.put(f'/api/v1/datasets/{did}/codebook', json=cb)
    assert changed.status_code == 200, changed.text
    ids = datasets.store.get_dataframe(did)['__rowId__'].to_list()
    response = client.post('/api/v1/summaries', json={'datasetId': did, 'columns': ['x'],
                           'rowIds': ids[:6], 'selectedRowIds': ids[6:]})
    assert response.status_code == 200, response.text
    data = response.json(); column = data['columns']['x']; weighted = column['weighted']
    assert data['unweightedN'] == 6 and data['weightMissingCount'] == 1
    assert data['selectedCountByCode'] == {'x': {}}
    assert column['denominators']['valid'] == 4 and column['count'] == 4
    assert weighted['weightMissingCount'] == 1 and weighted['weightedMean'] == 1.5
    assert [d['weightedPct'] for d in weighted['distribution']] == [50, 50, 0]
    assert [d['weightedCount'] for d in weighted['distribution']] == [1e308, 1e308, 0]
    assert weighted['weightedN'] is None and weighted['weightedNStatus'] == 'out_of_range'


@pytest.mark.parametrize('kind', ['survey', 'frequency'])
def test_absolute_chi_square_overflow_has_explicit_json_and_warning(client, kind):
    did, revision = load(client, [[str(i), 2.5e307, str(i), 's', f'p{i}-{j}']
                                 for i in range(3) for j in range(2)], kind=kind, design=True)
    response = client.post('/api/v1/summaries/crosstab', json={
        'context': {'datasetId': did, 'expectedDataRevision': 1, 'expectedSchemaRevision': revision},
        'rowVariableId': 'x', 'colVariableId': 'b'})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['grandTotal']['count'] == pytest.approx(1.5e308)
    assert data['descriptiveAssociation']['pearsonChi2'] is None
    assert data['descriptiveAssociation']['pearsonChi2Status'] == 'out_of_range'
    assert data['descriptiveAssociation']['weightedCramersV'] == pytest.approx(1.)
    assert 'CROSSTAB_CHI2_OUT_OF_RANGE' in {warning['code'] for warning in data['warnings']}
    if kind == 'frequency':
        assert data['inference']['status'] == 'unavailable'
        assert data['inference']['statisticStatus'] == 'out_of_range'
        assert data['inference']['pValue'] is None
    json.dumps(data, allow_nan=False)
