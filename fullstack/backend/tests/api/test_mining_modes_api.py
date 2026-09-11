"""Feature 24-M / V01: exploration, post-hoc stability, independent validation."""
from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def mining_ds():
    with TestClient(app) as client:
        rows = []
        for i in range(200):
            seg = "a" if i < 100 else "b"
            score = (10 + (i % 5)) if seg == "a" else (20 + (i % 5))
            rows.append(f"{seg},{score}")
        text = "seg,score\n" + "\n".join(rows) + "\n"
        dataset_id = client.post(
            "/api/v1/datasets/import", files={"file": ("m.csv", text, "text/csv")}).json()["datasetId"]
        cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: dict(c) for c in cb["columns"]}
        by_name["score"].update(role="question")
        assert client.put(f"/api/v1/datasets/{dataset_id}/codebook",
                          json={"columns": list(by_name.values())}).status_code == 200
        yield client, dataset_id
        client.delete(f"/api/v1/datasets/{dataset_id}")


def base_body(ds: str) -> dict:
    return {"datasetId": ds, "attributeCols": ["seg"], "questionCols": ["score"]}


def test_exploration_uses_descriptive_only_engine(mining_ds):
    client, ds = mining_ds
    res = client.post("/api/v1/mining/subgroups", json=base_body(ds)).json()
    assert res["analysisMode"] == "exploration" and res["isExploratory"] is True
    assert res["candidateSetHash"].startswith("sha256:")
    assert res["explorationNote"]
    assert res["insights"], "fixture must yield at least one insight"
    for item in res["insights"]:
        assert item["is_exploratory"] is True or item["isExploratory"] is True
        assert item["test"]["method"] == "descriptive_only"
        assert item["test"]["p_value"] is None and item["test"]["q_value"] is None
        assert item["test"]["significant"] is False
        assert item.get("p_value") is None
        assert "FDR q=" not in item.get("narrative", "")
        assert "探索的" in item.get("narrative", "")


def _assert_posthoc_stability(payload: dict) -> None:
    """V01: splitting after full-data discovery is not independent validation.

    Do not infer statistical status from the legacy verification route name.
    Require descriptive effects, but no confirmatory p/q or replication flag.
    """
    assert payload["isExploratory"] is True
    assert payload["results"], "stability must evaluate the pinned candidates"
    for item in payload["results"]:
        estimate = item["effect"]["estimate"]
        assert estimate is not None and math.isfinite(estimate)
        assert item["test"]["pValue"] is None
        assert item["test"]["pAdjusted"] is None
        assert item["test"]["significant"] is None
        assert item["replicationStatus"] is None


def test_posthoc_holdout_preserves_split_and_suppresses_inference(mining_ds):
    client, ds = mining_ds
    first = client.post("/api/v1/mining/subgroups", json=base_body(ds)).json()
    body = {**base_body(ds), "analysisMode": "verification",
            "verificationConfig": {"method": "holdout", "test_size": 0.3, "seed": 42},
            "candidateSetHash": first["candidateSetHash"]}
    response = client.post("/api/v1/mining/subgroups", json=body)
    assert response.status_code == 200, response.text
    res = response.json()
    _assert_posthoc_stability(res)
    verification = res["verification"]
    assert verification["method"] == "holdout"
    # VERIFY-01: the contrast is the group difference, never question-vs-0.
    assert "one_sample_mean" not in verification["testUsed"]
    assert verification["seed"] == 42
    # These are split sizes, not evidence of independence from discovery.
    assert verification["nSelection"] + verification["nEvaluation"] == 200
    assert verification["pinnedCandidateCount"] == len(res["results"]) >= 1
    assert verification["selectionScopeHash"] != verification["evaluationScopeHash"]
    assert verification["candidateSetHash"] == first["candidateSetHash"]
    for item in res["results"]:
        assert item["estimand"]["type"] == "mean_difference"
        assert item["effect"]["estimate"] > 0
        assert item["directionConsistent"] is True
        # The two contrasted levels are the exploration's highest/lowest groups.
        labels = [group["label"] for group in item["effect"]["groupStats"]]
        assert labels == [item["estimand"]["numerator"], item["estimand"]["denominator"]]

    pinned = client.post("/api/v1/mining/subgroups", json={
        **body, "candidateIds": [first["insights"][0]["id"]]})
    assert pinned.status_code == 200
    assert len(pinned.json()["results"]) == 1
    _assert_posthoc_stability(pinned.json())
    mismatch = client.post("/api/v1/mining/subgroups", json={
        **body, "candidateIds": ["no-such-candidate"]})
    assert mismatch.status_code == 422
    assert mismatch.json()["error"]["code"] == "VERIFICATION_CANDIDATE_UNKNOWN"
    # VERIFY-02: a candidate set from a stale revision is refused, not re-discovered.
    expired = client.post("/api/v1/mining/subgroups", json={
        **body, "candidateSetHash": "sha256:deadbeef"})
    assert expired.status_code == 409
    assert expired.json()["error"]["code"] == "VERIFICATION_CANDIDATE_SET_EXPIRED"
    missing_hash = client.post("/api/v1/mining/subgroups", json={
        **base_body(ds), "analysisMode": "verification"})
    assert missing_hash.status_code == 422
    assert missing_hash.json()["error"]["code"] == "VERIFICATION_CANDIDATE_SET_REQUIRED"


def test_posthoc_cross_validation_reports_folds_without_inference(mining_ds):
    client, ds = mining_ds
    first = client.post("/api/v1/mining/subgroups", json=base_body(ds)).json()
    body = {**base_body(ds), "analysisMode": "verification",
            "verificationConfig": {"method": "cross_validation", "k": 5, "seed": 42},
            "candidateSetHash": first["candidateSetHash"]}
    res = client.post("/api/v1/mining/subgroups", json=body)
    assert res.status_code == 200, res.text
    payload = res.json()
    _assert_posthoc_stability(payload)
    verification = payload["verification"]
    assert verification["method"] == "cross_validation"
    assert verification["seed"] == 42
    # All rows were used for discovery. These folds measure stability only;
    # pinning the candidates does not turn them into independent evaluation.
    assert len(verification["folds"]) == 5
    assert verification["nEvaluation"] == 200
    assert verification["candidateSetHash"] == first["candidateSetHash"]
    assert verification["pinnedCandidateCount"] == len(payload["results"]) >= 1
    candidate_ids = {item["candidateId"] for item in payload["results"]}
    assert sum(fold["nEvaluation"] for fold in verification["folds"]) == 200
    for fold in verification["folds"]:
        assert fold["nEvaluation"] == 40
        assert {effect["candidateId"] for effect in fold["effects"]} == candidate_ids
        for effect in fold["effects"]:
            assert effect["effect"] is not None and math.isfinite(effect["effect"])
    for item in payload["results"]:
        assert item["estimand"]["type"] == "mean_difference"
        assert item["effect"]["estimate"] == pytest.approx(10.0)
        assert item["directionConsistent"] is True


def test_verification_cross_validation_rejects_bad_k(mining_ds):
    client, ds = mining_ds
    res = client.post("/api/v1/mining/subgroups",
                      json={**base_body(ds), "analysisMode": "verification",
                            "verificationConfig": {"method": "cross_validation", "k": 1}})
    assert res.status_code == 422


def test_verification_independent_success_and_overlap_rejected(mining_ds):
    """VERIFY-04/A04: rowIds are dataset-scoped, so auto-generated ids that
    happen to collide as strings must not be read as the same respondent."""
    client, ds = mining_ds
    first = client.post("/api/v1/mining/subgroups", json=base_body(ds)).json()
    # No rowIdColumn => both datasets generate ROW-000001… ids that collide
    # textually; verification must rely on the dataset boundary, not the id.
    rows = [f"{'a' if i < 20 else 'b'},{12 + (i % 5) if i < 20 else (22 + (i % 5))}"
            for i in range(40)]
    text = "seg,score\n" + "\n".join(rows) + "\n"
    other = client.post(
        "/api/v1/datasets/import",
        files={"file": ("m_independent.csv", text, "text/csv")}).json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{other}/codebook").json()
    by_name = {c["name"]: dict(c) for c in cb["columns"]}
    by_name["score"].update(role="question")
    assert client.put(f"/api/v1/datasets/{other}/codebook",
                      json={"columns": list(by_name.values())}).status_code == 200
    try:
        ok = client.post("/api/v1/mining/subgroups",
                         json={**base_body(ds), "analysisMode": "verification",
                               "verificationConfig": {"method": "independent",
                                                      "independent_dataset_id": other},
                               "candidateSetHash": first["candidateSetHash"]})
        assert ok.status_code == 200, ok.text
        payload = ok.json()
        verification = payload["verification"]
        assert verification["method"] == "independent"
        assert verification["rowIdNamespace"] == "dataset-scoped"
        assert verification["nSelection"] == 200
        assert verification["nEvaluation"] == 40
        assert verification["evaluationScopeHash"] != verification["selectionScopeHash"]
        assert payload["results"], "independent data must yield evaluated candidates"
    finally:
        client.delete(f"/api/v1/datasets/{other}")

    same = client.post("/api/v1/mining/subgroups",
                       json={**base_body(ds), "analysisMode": "verification",
                             "verificationConfig": {"method": "independent",
                                                    "independent_dataset_id": ds},
                             "candidateSetHash": first["candidateSetHash"]})
    assert same.status_code == 422
    assert first["candidateSetHash"].startswith("sha256:")


def test_verification_rejects_bad_config_and_overlap(mining_ds):
    client, ds = mining_ds
    bad_mode = client.post("/api/v1/mining/subgroups",
                           json={**base_body(ds), "analysisMode": "prove"})
    assert bad_mode.status_code == 422
    missing = client.post("/api/v1/mining/subgroups",
                          json={**base_body(ds), "analysisMode": "verification",
                                "verificationConfig": {"method": "independent"}})
    assert missing.status_code == 422
    same = client.post("/api/v1/mining/subgroups",
                       json={**base_body(ds), "analysisMode": "verification",
                             "verificationConfig": {"method": "independent",
                                                    "independent_dataset_id": ds}})
    assert same.status_code == 422


def test_mining_stale_revision_rejected(mining_ds):
    client, ds = mining_ds
    stale = client.post("/api/v1/mining/subgroups",
                        json={**base_body(ds), "expectedSchemaRevision": 9999})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
    stale_data = client.post("/api/v1/mining/subgroups",
                             json={**base_body(ds), "expectedDataRevision": 9999})
    assert stale_data.status_code == 409


def test_feature_ranking_reports_weight_unsupported_and_stale(mining_ds):
    client, ds = mining_ds
    body = {"datasetId": ds, "targetColumn": "score", "featureColumns": ["seg"]}
    plain = client.post("/api/v1/mining/feature-ranking", json=body)
    assert plain.status_code == 200, plain.text
    payload = plain.json()
    assert payload["weightApplied"] is False
    assert payload["weightStatus"] == "omitted"

    # Unknown weight column must fail loudly instead of looking applied.
    bad = client.post("/api/v1/mining/feature-ranking",
                      json={**body, "weightColumn": "nope"})
    assert bad.status_code == 422

    stale = client.post("/api/v1/mining/feature-ranking",
                        json={**body, "expectedSchemaRevision": 9999})
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"


def test_sensitivity_stale_revision_rejected(sensitivity_ds_unused=None):
    # Sensitivity shares the same revision guard; use the mining fixture shape.
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as client:
        text = "seg,score\n" + "\n".join(f"a,{10 + (i % 3)}" for i in range(12)) + "\n"
        ds = client.post(
            "/api/v1/datasets/import", files={"file": ("st.csv", text, "text/csv")}).json()["datasetId"]
        try:
            stale = client.post("/api/v1/robustness/sensitivity", json={
                "datasetId": ds, "targetColumn": "score",
                "candidate": {"type": "subgroup_diff", "groupColumn": "seg",
                              "compareGroups": ["a", "b"]},
                "expectedSchemaRevision": 9999})
            assert stale.status_code == 409
            assert stale.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
        finally:
            client.delete(f"/api/v1/datasets/{ds}")


def test_modern_keeps_algorithm_mode_and_reports_inference(mining_ds):
    client, ds = mining_ds
    res = client.post("/api/v1/mining/modern-subgroup",
                      json={"datasetId": ds, "attributeCols": ["seg"],
                            "targetQuestions": ["score"], "mode": "emm_kendall"}).json()
    assert res["inferenceMode"] == "exploration" and res["algorithmMode"] == "emm_kendall"
    assert res["candidateSetHash"].startswith("sha256:")
    bad = client.post("/api/v1/mining/modern-subgroup",
                      json={"datasetId": ds, "attributeCols": ["seg"],
                            "targetQuestions": ["score"], "inferenceMode": "verification"})
    assert bad.status_code == 422


def test_modern_pinned_candidates_receive_posthoc_stability(mining_ds):
    """V01: the classic route evaluates pinned modern rules without re-search.

    A holdout drawn after full-data discovery is descriptive stability even
    when the candidates came from the modern search engine.
    """
    client, ds = mining_ds
    first = client.post("/api/v1/mining/modern-subgroup",
                        json={"datasetId": ds, "attributeCols": ["seg"],
                              "targetQuestions": ["score"], "mode": "standard"}).json()
    assert first["inferenceMode"] == "exploration"
    assert first["candidates"], "fixture must pin at least one modern candidate"
    pinned_ids = {candidate["candidateId"] for candidate in first["candidates"]}
    assert pinned_ids <= {insight["id"] for insight in first["insights"]}

    res = client.post("/api/v1/mining/subgroups", json={
        "datasetId": ds, "attributeCols": ["seg"], "questionCols": ["score"],
        "analysisMode": "verification",
        "verificationConfig": {"method": "holdout", "test_size": 0.3, "seed": 42},
        "candidateSetHash": first["candidateSetHash"]})
    assert res.status_code == 200
    payload = res.json()
    _assert_posthoc_stability(payload)
    assert payload["candidateSetHash"] == first["candidateSetHash"]
    assert {item["candidateId"] for item in payload["results"]} == pinned_ids
    assert all(item["estimand"]["type"] in ("mean_difference", "kendall_tau_difference")
               for item in payload["results"])
    assert payload["verification"]["pinnedCandidateCount"] == len(pinned_ids)
