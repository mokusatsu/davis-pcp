"""STAT-04: pooled ratings covariance retains the fitted intercept."""
from __future__ import annotations
import numpy as np
import polars as pl
import pytest
from scipy import stats
from fastapi.testclient import TestClient

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


def _rating_data(balanced=False):
    x = np.tile([1., 1., -1., -1.] if balanced else [1., 1., 1., -1.], 8)
    delta = np.array([-.15, .05, .10, -.05, .15, -.10, .05, -.05])
    y = 5 + np.repeat(np.arange(8), 4) + (1 + np.repeat(delta, 4)) * x
    frame = pl.DataFrame({'respondent_id': np.repeat([f'R{i}' for i in range(8)], 4),
                          'task_id': np.tile(['T1', 'T2', 'T3', 'T4'], 8),
                          'alternative_id': ['P'] * 32,
                          'brand': ['A' if v == 1 else 'B' for v in x],
                          'contrast': x, 'rating': y})
    return frame, x, y


def _full_cr1_oracle(x, y):
    design = np.column_stack([np.ones(len(x)), x])
    beta = np.linalg.lstsq(design, y, rcond=None)[0]
    residual = y - design @ beta
    bread = np.linalg.inv(design.T @ design)
    score = [design[i:i + 4].T @ residual[i:i + 4] for i in range(0, len(x), 4)]
    covariance = len(score) / (len(score) - 1) * bread @ sum(np.outer(u, u) for u in score) @ bread
    return beta[1:], covariance[1:, 1:]


@pytest.mark.parametrize('balanced', [False, True])
def test_stat04_pooled_ratings_full_intercept_cr1_oracle_and_coding_invariance(audit_api, balanced):
    client, store = audit_api
    frame, x, y = _rating_data(balanced)
    beta, covariance = _full_cr1_oracle(x, y)
    expected_se = np.sqrt(covariance[0, 0])
    if not balanced:
        assert covariance[0, 0] == pytest.approx(.001339285714285717, rel=1e-12)
    response = client.post('/api/v1/datasets/import', files={'file': ('ratings.csv', frame.write_csv().encode(), 'text/csv')})
    assert response.status_code == 200, response.text
    ds = response.json()['datasetId']
    context = {'datasetId': ds, 'expectedDataRevision': 1, 'expectedSchemaRevision': 1, 'scope': 'all', 'weightMode': 'none', 'missingPolicy': 'exclude', 'imputationPolicy': 'use_current_values'}
    request = {'context': context, 'method': 'conjoint', 'mode': 'ratings', 'ratingEffects': 'pooled',
               'columns': {'respondentId': 'respondent_id', 'taskId': 'task_id', 'alternativeId': 'alternative_id', 'response': 'rating'}}
    results = []
    for column, kind in [('brand', 'categorical'), ('contrast', 'linear')]:
        response = client.post('/api/v1/models/conjoint', json={**request, 'attributes': [{'columnId': column, 'kind': kind}]})
        assert response.status_code == 200, response.text
        result = response.json()
        coefficient = result['details']['coefficients'][0]
        assert coefficient['estimate'] == pytest.approx(beta[0], rel=1e-12)
        assert coefficient['standardError'] == pytest.approx(expected_se, rel=1e-11)
        assert coefficient['pValue'] == pytest.approx(2 * stats.t.sf(abs(beta[0] / expected_se), 7), rel=1e-10)
        assert result['summary']['referenceDf'] == 7
        results.append(coefficient)
    assert results[0]['standardError'] == pytest.approx(results[1]['standardError'], rel=1e-11)


def _fit_api(client, store, frame, *, attributes=None, weight_type=None,
             scope_respondents=None, rating_effects='pooled', price_attribute=None):
    response = client.post('/api/v1/datasets/import', files={'file': ('covariance.csv', frame.write_csv().encode(), 'text/csv')})
    assert response.status_code == 200, response.text
    ds = response.json()['datasetId']
    if weight_type:
        book = client.get(f'/api/v1/datasets/{ds}/codebook').json()
        weight_id = next(c['columnId'] for c in book['columns'] if c['name'] == 'w')
        response = client.put(f'/api/v1/datasets/{ds}/codebook', json={
            'columns': [{'columnId': weight_id, 'role': 'weight', 'scaleType': 'ratio'}],
            'weightConfig': {'weightColumnId': weight_id, 'weightType': weight_type},
        })
        assert response.status_code == 200, response.text
    book = client.get(f'/api/v1/datasets/{ds}/codebook').json()
    meta = client.get(f'/api/v1/datasets/{ds}').json()
    context = {'datasetId': ds, 'expectedDataRevision': meta['dataRevision'],
               'expectedSchemaRevision': book['schemaRevision'], 'scope': 'all',
               'weightMode': 'dataset' if weight_type else 'none',
               'missingPolicy': 'exclude', 'imputationPolicy': 'use_current_values'}
    if scope_respondents is not None:
        df = store.get_dataframe(ds)
        context.update(scope='explicit', rowIds=df.filter(pl.col('respondent_id').is_in(scope_respondents))['__rowId__'].to_list())
    response = client.post('/api/v1/models/conjoint', json={
        'context': context, 'method': 'conjoint', 'mode': 'ratings',
        'ratingEffects': rating_effects, 'priceAttribute': price_attribute,
        'columns': {'respondentId': 'respondent_id', 'taskId': 'task_id', 'alternativeId': 'alternative_id', 'response': 'rating'},
        'attributes': attributes or [{'columnId': 'brand', 'kind': 'categorical'}],
    })
    assert response.status_code == 200, response.text
    return response.json()


def _weighted_oracle(x, y, weights, *, survey=False, active_respondents=8):
    design = np.column_stack([np.ones(len(x)), x])
    active = np.arange(len(x)) < active_respondents * 4
    weighted_design = design[active] * np.sqrt(weights[active, None])
    weighted_y = y[active] * np.sqrt(weights[active])
    beta = np.linalg.lstsq(weighted_design, weighted_y, rcond=None)[0]
    residual = y - design @ beta
    bread = np.linalg.inv(design[active].T @ (weights[active, None] * design[active]))
    scores = np.vstack([design[i:i + 4].T @ residual[i:i + 4] if i < active_respondents * 4 else np.zeros(design.shape[1]) for i in range(0, len(x), 4)])
    respondent_weights = weights[::4]
    if survey:
        scores *= respondent_weights[:, None]
        centered = scores - scores.mean(axis=0)
        g = len(scores)
        meat = centered.T @ centered
    else:
        g = float(respondent_weights[:active_respondents].sum())
        meat = scores.T @ (respondent_weights[:, None] * scores)
    covariance = g / (g - 1) * bread @ meat @ bread
    return beta[1:], covariance[1:, 1:], g - 1


def test_stat04_multiple_attributes_match_full_matrix_oracle(audit_api):
    client, store = audit_api
    frame, contrast, y = _rating_data()
    second = np.tile([0., 1., 0., 1.], 8)
    shifts = np.repeat([.02, -.03, .04, -.01, .03, -.04, .01, -.02], 4)
    y = y + (-.6 + shifts) * second
    frame = frame.with_columns(pl.Series('second', second), pl.Series('rating', y))
    # The service centers linear attributes. This changes the intercept but
    # leaves slopes and their covariance exactly equivalent to this raw matrix.
    beta, covariance = _full_cr1_oracle(np.column_stack([contrast, second]), y)
    result = _fit_api(client, store, frame, attributes=[{'columnId': 'brand', 'kind': 'categorical'}, {'columnId': 'second', 'kind': 'linear'}], price_attribute='second')
    coefficients = result['details']['coefficients']
    np.testing.assert_allclose([c['estimate'] for c in coefficients], beta, rtol=1e-11)
    np.testing.assert_allclose([c['standardError'] for c in coefficients], np.sqrt(np.diag(covariance)), rtol=1e-9)
    brand_utilities = [item for item in result['details']['levelUtilities'] if item['attributeId'] == 'brand']
    assert {item['levelCode'] for item in brand_utilities} == {'A', 'B'}
    for item in brand_utilities:
        assert item['standardError'] == pytest.approx(np.sqrt(covariance[0, 0]), rel=1e-9)
    # A price-ratio uncertainty uses both slopes and their off-diagonal
    # covariance. A diagonal-only implementation cannot pass this oracle.
    assert abs(covariance[0, 1]) > 1e-5
    wtp = result['details']['wtp']
    assert len(wtp) == 1 and wtp[0]['attributeId'] == 'brand'
    assert wtp[0]['status'] == 'available'
    gradient = np.array([-2 / beta[1], 2 * beta[0] / beta[1] ** 2])
    assert wtp[0]['value'] == pytest.approx(-2 * beta[0] / beta[1], rel=1e-11)
    assert wtp[0]['standardError'] == pytest.approx(np.sqrt(gradient @ covariance @ gradient), rel=1e-9)
    from app.storage import analysis_result_store
    np.testing.assert_allclose(analysis_result_store.load_arrays(result['resultId'])['cov'], covariance, rtol=1e-9)


def test_stat04_frequency_weights_match_full_oracle_and_respondent_block_replication(audit_api):
    client, store = audit_api
    frame, x, y = _rating_data()
    replications = np.array([1., 2., 1., 3., 2., 1., 2., 1.])
    weights = np.repeat(replications, 4)
    beta, covariance, df = _weighted_oracle(x, y, weights)
    weighted = _fit_api(client, store, frame.with_columns(pl.Series('w', weights)), weight_type='frequency')
    expanded = []
    for respondent, count in enumerate(replications.astype(int)):
        block = frame.slice(respondent * 4, 4)
        for copy in range(count):
            expanded.append(block.with_columns(pl.lit(f'R{respondent}-copy{copy}').alias('respondent_id')))
    replicated = _fit_api(client, store, pl.concat(expanded))
    for result in [weighted, replicated]:
        coefficient = result['details']['coefficients'][0]
        assert coefficient['estimate'] == pytest.approx(beta[0], rel=1e-11)
        assert coefficient['standardError'] == pytest.approx(np.sqrt(covariance[0, 0]), rel=1e-10)
        assert coefficient['pValue'] == pytest.approx(2 * stats.t.sf(abs(beta[0] / np.sqrt(covariance[0, 0])), df), rel=1e-9)
        assert result['summary']['referenceDf'] == df


@pytest.mark.parametrize('active_respondents', [8, 6])
def test_stat04_survey_full_sandwich_and_scaling_with_scope_outside_scores(audit_api, active_respondents):
    client, store = audit_api
    frame, x, y = _rating_data()
    baseline_se = None
    for scale in [1., 1e-6, 1e6]:
        weights = np.repeat([1., 2., 1., 3., 2., 1., 4., 2.], 4) * scale
        beta, covariance, df = _weighted_oracle(x, y, weights, survey=True, active_respondents=active_respondents)
        result = _fit_api(client, store, frame.with_columns(pl.Series('w', weights)), weight_type='survey',
                          scope_respondents=[f'R{i}' for i in range(active_respondents)] if active_respondents < 8 else None)
        coefficient = result['details']['coefficients'][0]
        se = coefficient['standardError']
        assert coefficient['estimate'] == pytest.approx(beta[0], rel=1e-10)
        assert se == pytest.approx(np.sqrt(covariance[0, 0]), rel=1e-9)
        assert coefficient['pValue'] == pytest.approx(2 * stats.t.sf(abs(beta[0] / np.sqrt(covariance[0, 0])), df), rel=1e-8)
        assert result['summary']['referenceDf'] == df == 7
        if baseline_se is None:
            baseline_se = se
        else:
            assert se == pytest.approx(baseline_se, rel=1e-9)


def test_stat04_respondent_fixed_effects_keep_the_within_covariance(audit_api):
    client, store = audit_api
    frame, x, y = _rating_data()
    within_x = x - np.repeat(x.reshape(8, 4).mean(axis=1), 4)
    within_y = y - np.repeat(y.reshape(8, 4).mean(axis=1), 4)
    beta = float(np.dot(within_x, within_y) / np.dot(within_x, within_x))
    residual = within_y - within_x * beta
    scores = np.array([within_x[i:i + 4] @ residual[i:i + 4] for i in range(0, 32, 4)])
    variance = 8 / 7 * np.sum(scores ** 2) / np.dot(within_x, within_x) ** 2
    result = _fit_api(client, store, frame, rating_effects='respondent_fixed')
    coefficient = result['details']['coefficients'][0]
    assert coefficient['estimate'] == pytest.approx(beta, rel=1e-12)
    assert coefficient['standardError'] == pytest.approx(np.sqrt(variance), rel=1e-11)
    assert result['summary']['referenceDf'] == 7


def test_stat04_corrected_fits_have_a_new_method_version_and_preserve_existing_results(audit_api):
    from app.services import conjoint_service
    from app.storage import analysis_result_store
    import json
    client, store = audit_api
    assert conjoint_service.ALGORITHM_VERSION == 'davis.conjoint.1.0.1'
    frame, _, _ = _rating_data()
    first = _fit_api(client, store, frame)
    assert first['meta']['algorithmVersion'] == 'davis.conjoint.1.0.1'
    folder = analysis_result_store.result_dir(first['resultId'])
    before = {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()}
    manifest = json.loads(before['manifest.json'])
    assert manifest['meta']['algorithmVersion'] == 'davis.conjoint.1.0.1'
    second = _fit_api(client, store, frame)
    assert second['meta']['algorithmVersion'] == 'davis.conjoint.1.0.1'
    assert second['resultId'] != first['resultId']
    assert {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()} == before
