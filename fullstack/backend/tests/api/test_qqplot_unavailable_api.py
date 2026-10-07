"""Q-Q preserves unavailable constant diagnostics and genuine finite zero fits."""
from __future__ import annotations

import math
from statistics import NormalDist

import pytest
from fastapi.testclient import TestClient

from app.api import datasets, summaries
from app.config import settings
from app.main import app
from app.storage.dataset_store import DatasetStore


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspace_dir", tmp_path)
    store = DatasetStore(tmp_path)
    for module in (datasets, summaries):
        monkeypatch.setattr(module, "store", store)
    with TestClient(app) as client:
        yield client, store


def qq(client, dataset_id, column, row_ids=None):
    response = client.post('/api/v1/summaries/qqplot', json={
        'datasetId': dataset_id, 'column': column, 'rowIds': row_ids,
    })
    assert response.status_code == 200, response.text
    return response.json()


def test_iris_first_five_constant_response_remains_unavailable(api):
    client, store = api
    imported = client.post('/api/v1/datasets/import/sample', json={'sampleId': 'iris'})
    assert imported.status_code == 200, imported.text
    did = imported.json()['datasetId']
    first_five = store.get_dataframe(did).head(5)
    ids = first_five['__rowId__'].to_list()
    assert first_five['petal_width_cm'].to_list() == [.2] * 5
    result = qq(client, did, 'petal_width_cm', ids)
    assert result['count'] == 5
    assert result['normalityTest'] == dict.fromkeys([
        'shapiroWilkW', 'pValue', 'isNormalAlpha05', 'skewness', 'kurtosis',
    ])
    assert {key: result['referenceLine'][key] for key in ('slope', 'intercept', 'q1Sample', 'q3Sample')} == dict.fromkeys(['slope', 'intercept', 'q1Sample', 'q3Sample'])
    assert result['referenceLine']['q1Theoretical'] == pytest.approx(NormalDist().inv_cdf(.25))
    assert result['referenceLine']['q3Theoretical'] == pytest.approx(NormalDist().inv_cdf(.75))
    assert result['points'] == []
    assert result['minZ'] is None and result['maxZ'] is None
    assert result['minVal'] == result['maxVal'] == .2
    # The same scoped dataset can still produce a finite normality decision.
    normal = qq(client, did, 'sepal_length_cm', ids)
    assert normal['count'] == 5
    assert len(normal['points']) == 5
    assert normal['normalityTest']['isNormalAlpha05'] is True
    assert normal['normalityTest']['pValue'] >= .05
    non_normal = qq(client, did, 'petal_width_cm')
    assert non_normal['count'] == 150
    assert non_normal['normalityTest']['isNormalAlpha05'] is False
    assert non_normal['normalityTest']['pValue'] < .05


def test_finite_zero_moments_and_slope_are_available(api):
    client, _store = api
    uploaded = client.post('/api/v1/datasets/import', files={
        'file': ('zero-controls.csv', b'symmetric,tied\n-2,0\n-1,0\n0,0\n1,0\n2,1\n'),
    })
    assert uploaded.status_code == 200, uploaded.text
    did = uploaded.json()['datasetId']
    for column, values, normal in [('symmetric', [-2., -1., 0., 1., 2.], True), ('tied', [0., 0., 0., 0., 1.], False)]:
        result = qq(client, did, column)
        # Independent central-moment/order-statistic oracle: no scipy/skew/kurtosis/percentile calls.
        mean = sum(values) / len(values)
        m2, m3, m4 = [sum((value - mean) ** order for value in values) / len(values) for order in (2, 3, 4)]
        q1, q3 = sorted(values)[1], sorted(values)[3]
        slope = (q3 - q1) / (NormalDist().inv_cdf(.75) - NormalDist().inv_cdf(.25))
        intercept = q1 - slope * NormalDist().inv_cdf(.25)
        assert result['normalityTest']['skewness'] == pytest.approx(m3 / m2 ** 1.5)
        assert result['normalityTest']['kurtosis'] == pytest.approx(m4 / m2 ** 2 - 3)
        assert result['referenceLine']['slope'] == pytest.approx(slope)
        assert result['referenceLine']['intercept'] == pytest.approx(intercept)
        assert result['normalityTest']['isNormalAlpha05'] is normal
        assert all(math.isfinite(point['theoreticalQuantile']) for point in result['points'])
        if column == 'symmetric':
            assert result['normalityTest']['skewness'] == 0
        else:
            assert result['referenceLine']['slope'] == 0
        assert result['referenceLine']['intercept'] == 0
