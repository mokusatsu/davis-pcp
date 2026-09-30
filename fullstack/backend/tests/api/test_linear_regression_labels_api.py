"""Regression: fitted target labels must not expose generated column IDs."""
import importlib.util
from pathlib import Path
import zipfile

import pytest
from fastapi.testclient import TestClient
from app.main import app


@pytest.mark.parametrize('label', ['Outcome', '総合評価', ''])
def test_target_label_and_formula_preserve_fit(label):
    client = TestClient(app)
    response = client.post('/api/v1/datasets/import', files={
        'file': ('lr-label.csv', b'Outcome,X,Z\n2,0,1\n4,1,0\n5,2,1\n9,3,0\n10,4,2\n14,5,1\n', 'text/csv')})
    assert response.status_code == 200, response.text
    did = response.json()['datasetId']
    columns = client.get(f'/api/v1/datasets/{did}/codebook').json()['columns']
    ids = {c['name']: c['columnId'] for c in columns}
    context = {'datasetId': did, 'expectedDataRevision': 1,
               'expectedSchemaRevision': 1, 'scope': 'all', 'weightMode': 'none'}
    payload = {'context': context, 'target': ids['Outcome'],
               'predictors': [{'columnId': ids[c], 'kind': 'numeric'} for c in ['X', 'Z']]}
    before = client.post('/api/v1/models/linear-regression', json=payload)
    assert before.status_code == 200, before.text
    saved = client.put(f'/api/v1/datasets/{did}/codebook', json={
        'columns': [{'columnId': ids['Outcome'], 'label': label}]})
    assert saved.status_code == 200, saved.text
    context['expectedSchemaRevision'] = saved.json()['schemaRevision']
    response = client.post('/api/v1/models/linear-regression', json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    expected = label or 'Outcome'
    assert result['summary']['targetLabel'] == expected
    assert result['summary']['modelFormula'] == f'{expected} ~ X + Z'
    assert result['details']['modelFormula'] == f'{expected} ~ X + Z'
    assert ids['Outcome'] not in result['summary']['modelFormula']
    assert result['config']['target'] == ids['Outcome']
    assert result['details']['coefficients'] == before.json()['details']['coefficients']
    for field in ['rSquared', 'rmse', 'conditionNumber']:
        assert result['summary'][field] == before.json()['summary'][field]


def test_static_backend_archive_contains_same_linear_regression_fix(tmp_path, monkeypatch):
    """The static worker imports this Python module from backend_app.zip."""
    root = Path(__file__).resolve().parents[4]
    spec = importlib.util.spec_from_file_location('build_static_lr_test', root / 'fullstack/scripts/build_static.py')
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    monkeypatch.setattr(builder, 'CACHE_DIR', tmp_path)
    archive = builder.package_backend_app()
    source = (root / 'fullstack/backend/app/api/linear_regression.py').read_bytes()
    with zipfile.ZipFile(archive) as zf:
        assert zf.read('app/api/linear_regression.py') == source
    assert b'"targetLabel": target_label' in source
