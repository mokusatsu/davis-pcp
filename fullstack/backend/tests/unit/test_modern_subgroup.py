"""Unit tests for Modern Subgroup Discovery & Exceptional Model Mining (Feature 11)."""
import numpy as np
import polars as pl
import pytest

from app.algorithms.mining.modern_subgroup import (
    generate_descriptors,
    compute_numeric_score,
    compute_binary_score,
    compute_kendall_emm_score,
    run_modern_subgroup_mining,
)


def test_specification_numeric_values_exact():
    """Test the exact mathematical values from Feature 11 specifications:
    N=1000, y_all=3.20, s_all=1.10
    #1 Subgroup: n=200, mean=3.95, s=0.80 -> Complement: n=800, mean=3.0125, s=1.0856
       Score should be ~14.95
    #2 Subgroup: n=50, mean=4.40, s=0.60 -> Complement: n=950, mean=3.1368, s=1.0841
       Score should be ~12.16, parent_delta_mean = +0.45
    """
    N = 1000
    y = np.zeros(N)

    # Subgroup 2 (50 rows): mean 4.40, std 0.60
    np.random.seed(42)
    s2 = np.random.normal(loc=4.40, scale=0.60, size=50)
    s2 = (s2 - np.mean(s2)) / np.std(s2, ddof=1) * 0.60 + 4.40
    y[:50] = s2

    # Subgroup 1 remainder (150 rows): mean 3.80, std 0.80
    s1_rem = np.random.normal(loc=3.80, scale=0.80, size=150)
    s1_rem = (s1_rem - np.mean(s1_rem)) / np.std(s1_rem, ddof=1) * 0.80 + 3.80
    y[50:200] = s1_rem

    # Complement 800 rows: mean 3.0125, std 1.0856
    comp = np.random.normal(loc=3.0125, scale=1.0856, size=800)
    comp = (comp - np.mean(comp)) / np.std(comp, ddof=1) * 1.0856 + 3.0125
    y[200:] = comp

    # Test #1 (first 200 rows)
    mask1 = np.zeros(N, dtype=bool)
    mask1[:200] = True

    res1 = compute_numeric_score(
        y=y,
        subgroup_mask=mask1,
        min_group_size=30,
        complexity=1,
        lambda_penalty=0.05,
        s_max=50.0,
    )
    assert res1 is not None
    score1, raw1, stats1, reason1, comp_sep1 = res1
    assert not comp_sep1
    assert round(score1, 1) == pytest.approx(15.0, abs=0.2)
    assert stats1["subgroup_mean"] == pytest.approx(3.95, abs=0.02)
    assert stats1["complement_mean"] == pytest.approx(3.01, abs=0.02)

    # Test #2 (first 50 rows)
    mask2 = np.zeros(N, dtype=bool)
    mask2[:50] = True

    res2 = compute_numeric_score(
        y=y,
        subgroup_mask=mask2,
        min_group_size=30,
        complexity=2,
        lambda_penalty=0.05,
        s_max=50.0,
    )
    assert res2 is not None
    score2, raw2, stats2, reason2, comp_sep2 = res2
    assert not comp_sep2
    assert round(score2, 1) == pytest.approx(12.2, abs=0.2)
    assert stats2["subgroup_mean"] == pytest.approx(4.40, abs=0.02)


def test_zero_variance_and_complete_separation():
    """Test handling of zero variance and complete separation."""
    y = np.array([5.0] * 50 + [2.0] * 50)
    mask = np.array([True] * 50 + [False] * 50)

    # Complete separation: s_R = 0, s_comp = 0, mean_R != mean_comp
    res = compute_numeric_score(y=y, subgroup_mask=mask, min_group_size=10, complexity=1, s_max=50.0)
    assert res is not None
    score, raw, stats_dict, reason, comp_sep = res
    assert comp_sep is True
    assert raw == 50.0
    assert score == 50.0 - 0.05

    # Constant target everywhere
    y_const = np.array([3.0] * 100)
    res_const = compute_numeric_score(y=y_const, subgroup_mask=mask, min_group_size=10, complexity=1)
    assert res_const is None  # Pruned because entirely constant


def test_kendall_emm_score():
    """Test Kendall tau-b EMM with rank reversal."""
    # X and Y have positive correlation for complement, negative for subgroup
    np.random.seed(42)
    N = 200
    x = np.linspace(1, 10, N)

    y = np.zeros(N)
    # Subgroup (first 50): y decreases with x (tau negative)
    y[:50] = 10 - x[:50] + np.random.normal(0, 0.2, 50)
    # Complement (150): y increases with x (tau positive)
    y[50:] = x[50:] + np.random.normal(0, 0.2, 150)

    mask = np.zeros(N, dtype=bool)
    mask[:50] = True

    res = compute_kendall_emm_score(x=x, y=y, subgroup_mask=mask, min_group_size=20, complexity=1)
    assert res is not None
    score, raw_score, target_stats, reason, emm_stats = res
    assert emm_stats["subgroup_tau"] < -0.5
    assert emm_stats["complement_tau"] > 0.5
    assert emm_stats["reversal"] is True
    assert score > 5.0


def test_descriptor_generation_and_canonical_intervals():
    """Test pre-generation of descriptors including one-sided and intervals."""
    df = pl.DataFrame({
        "age": [20, 25, 30, 40, 45, 50, 60, 65, 70, 75, 80, 85] * 5,
        "region": ["Tokyo", "Osaka", "Nagoya"] * 20,
    })
    descriptors = generate_descriptors(df, attribute_cols=["age", "region"], excluded_cols=set())

    labels = [cond.label for cond, _ in descriptors]
    # Check that age has <, >=, and <= age < intervals
    has_lt = any("age <" in l for l in labels)
    has_ge = any("age >=" in l for l in labels)
    has_between = any("<= age <" in l for l in labels)
    has_region = any("region ==" in l for l in labels)

    assert has_lt
    assert has_ge
    assert has_between
    assert has_region


def test_run_modern_subgroup_pipeline():
    """End-to-end run of modern subgroup mining pipeline."""
    np.random.seed(123)
    n = 300
    age = np.random.randint(20, 70, n)
    income = np.random.randint(200, 1200, n)
    # Question Q1: high when age >= 50 and income >= 700
    q1 = np.random.normal(3.0, 0.8, n)
    for i in range(n):
        if age[i] >= 50 and income[i] >= 700:
            q1[i] += 1.5

    df = pl.DataFrame({
        "id": [str(i) for i in range(n)],
        "age": age,
        "income": income,
        "q1": q1,
    })

    meta = [
        {"columnId": "age", "role": "attribute", "semanticType": "numeric"},
        {"columnId": "income", "role": "attribute", "semanticType": "numeric"},
        {"columnId": "q1", "role": "question", "semanticType": "numeric"},
    ]

    res = run_modern_subgroup_mining(
        df=df,
        target_questions=["q1"],
        mode="standard",
        attribute_cols=["age", "income"],
        column_meta=meta,
        max_depth=2,
        min_group_size=20,
        top_k=5,
    )

    assert res["mode"] == "standard"
    assert len(res["insights"]) > 0
    top_insight = res["insights"][0]
    assert top_insight["score"] > 0
    assert "target_stats" in top_insight
    assert "ranking_reason" in top_insight


def test_api_modern_subgroup_endpoint():
    """Test the POST /api/v1/mining/modern-subgroup endpoint."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.storage.dataset_store import DatasetStore

    client = TestClient(app)
    store = DatasetStore()

    ds_id = "test_modern_ds"
    df = pl.DataFrame({
        "id": [str(i) for i in range(100)],
        "age": [25 if i < 50 else 55 for i in range(100)],
        "satisfaction": [2.0 if i < 50 else 4.5 for i in range(100)],
    })
    meta = {
        "datasetId": ds_id,
        "schema": [
            {"columnId": "age", "role": "attribute", "semanticType": "numeric"},
            {"columnId": "satisfaction", "role": "question", "semanticType": "numeric"},
        ],
    }
    store.save(ds_id, meta, df.with_columns(pl.col('id').alias('__rowId__')))
    store.save_codebook(ds_id, {'datasetId': ds_id, 'schemaRevision': 1, 'columns': [
        {**column, 'name': column['columnId'], 'scaleType': 'nominal' if column['semanticType'] == 'categorical' else 'ratio'}
        for column in meta['schema']
    ]})

    resp = client.post(
        "/api/v1/mining/modern-subgroup",
        json={
            "datasetId": ds_id,
            "mode": "standard",
            "targetQuestions": ["satisfaction"],
            "maxDepth": 1,
            "minGroupSize": 20,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["mode"] == "standard"
    assert len(data["insights"]) > 0
    top_ins = data["insights"][0]
    assert "score" in top_ins
    assert "target_stats" in top_ins
    assert abs(top_ins["target_stats"]["delta_mean"]) == pytest.approx(2.5, abs=0.1)


def test_omnipresent_auto_mining_all_questions():
    """Test omnipresent mining when no target questions are specified."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.storage.dataset_store import DatasetStore

    client = TestClient(app)
    store = DatasetStore()

    ds_id = "test_omnipresent_ds"
    df = pl.DataFrame({
        "id": [str(i) for i in range(120)],
        "gender": ["F" if i < 60 else "M" for i in range(120)],
        "q1_price": [1.0 if i < 60 else 5.0 for i in range(120)],
        "q2_service": [5.0 if i < 60 else 2.0 for i in range(120)],
    })
    meta = {
        "datasetId": ds_id,
        "schema": [
            {"columnId": "gender", "role": "attribute", "semanticType": "categorical"},
            {"columnId": "q1_price", "role": "question", "semanticType": "numeric"},
            {"columnId": "q2_service", "role": "question", "semanticType": "numeric"},
        ],
    }
    store.save(ds_id, meta, df.with_columns(pl.col('id').alias('__rowId__')))
    store.save_codebook(ds_id, {'datasetId': ds_id, 'schemaRevision': 1, 'columns': [
        {**column, 'name': column['columnId'], 'scaleType': 'nominal' if column['semanticType'] == 'categorical' else 'ratio'}
        for column in meta['schema']
    ]})

    # Call API without specifying targetQuestions
    resp = client.post(
        "/api/v1/mining/modern-subgroup",
        json={
            "datasetId": ds_id,
            "mode": "auto",
            "maxDepth": 1,
            "minGroupSize": 20,
            "topK": 6,
        },
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["summary"]["questions_evaluated_count"] >= 2
    assert len(data["insights"]) >= 2
    # Check that insights cover multiple questions or question pairs
    questions_covered = set()
    for ins in data["insights"]:
        if ins.get("target_question"):
            questions_covered.add(ins["target_question"])
        elif ins.get("target_pair"):
            questions_covered.add(":".join(ins["target_pair"]))
    assert len(questions_covered) >= 2
