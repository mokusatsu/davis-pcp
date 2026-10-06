"""API tests for Feature 033 EFA (B0/B1/B3 slice)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import polars as pl
import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)


def _make_continuous(n=200, seed=5):
    rng = np.random.default_rng(seed)
    p = 4
    L = np.zeros((p, 1))
    L[:, 0] = [0.8, 0.7, 0.6, 0.5]
    Sig = L @ L.T + np.diag(1 - np.diag(L @ L.T))
    X = rng.multivariate_normal(np.zeros(p), Sig, size=n)
    df = pl.DataFrame({f"q{i+1}": X[:, i].tolist() for i in range(p)})
    ds = client.post("/api/v1/datasets/import", files={"file": ("efa.csv", df.write_csv().encode(), "text/csv")}).json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{ds}/codebook").json()
    colids = [c["columnId"] for c in cb["columns"][:p]]
    ctx = {"datasetId": ds, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none", "missingPolicy": "exclude",
           "imputationPolicy": "use_current_values"}
    return ds, ctx, colids


def test_pearson_ml_scores_rows_predict_materialize():
    ds, ctx, colids = _make_continuous()
    payload = {
        "context": ctx,
        "variables": [{"columnId": c, "measurement": "continuous", "treatment": "continuous"} for c in colids],
        "correlation": "pearson", "extraction": "ml", "nFactors": 1,
        "rotation": "varimax", "scoreMethod": "regression",
        "parallelAnalysis": {"enabled": False},
        "uniquenessLower": 0.005, "nStarts": 1, "maxIterations": 300, "seed": 1,
        "method": "efa", "schemaVersion": "factor_extensions.1",
    }
    r = client.post("/api/v1/models/factor-analysis", json=payload)
    assert r.status_code == 200, r.text[:500]
    j = r.json()
    assert j["method"] == "efa"
    assert j["summary"]["solutionStatus"] == "admissible"
    assert j["capabilities"]["rows"] is True
    rid = j["resultId"]
    rows = client.get(f"/api/v1/analysis-results/{rid}/rows?offset=0&limit=10").json()
    assert rows["total"] > 0 and len(rows["rows"]) > 0
    sel = client.post(f"/api/v1/analysis-results/{rid}/select",
                      json={"context": ctx, "selector": {"kind": "row_ids", "rowIds": [rows["rows"][0]["rowId"]]}}).json()
    assert sel["matchedCount"] == 1
    pred = client.post(f"/api/v1/analysis-results/{rid}/predict",
                       json={"context": ctx, "options": {"interval": "none", "evaluate": False}}).json()
    assert pred["summary"]["requestedCount"] > 0
    mat = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                      json={"context": ctx, "source": "fit",
                            "columns": [{"source": "score:1", "name": "efa_f1_test"}],
                            "idempotencyKey": "k1"}).json()
    assert mat["idempotentReplay"] is False
    mat2 = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                       json={"context": ctx, "source": "fit",
                             "columns": [{"source": "score:1", "name": "efa_f1_test"}],
                             "idempotencyKey": "k1"}).json()
    assert mat2["idempotentReplay"] is True
    exp = client.post(f"/api/v1/analysis-results/{rid}/export",
                      json={"format": "json", "table": "variables", "offset": 0, "limit": 10}).json()
    assert exp["total"] == 4


@pytest.mark.parametrize("source_kind", ["fit", "prediction"])
def test_materialize_replay_retains_original_receipt_after_later_mutation(source_kind):
    """Replay returns the committed receipt, even after a newer dataset revision."""
    from app.storage.dataset_store import DatasetStore

    store = DatasetStore()
    ds, ctx, colids = _make_continuous()
    fitted = client.post("/api/v1/models/factor-analysis", json={
        "context": ctx,
        "variables": [{"columnId": c, "measurement": "continuous", "treatment": "continuous"}
                      for c in colids],
        "correlation": "pearson", "extraction": "ml", "nFactors": 1,
        "rotation": "varimax", "scoreMethod": "regression",
        "parallelAnalysis": {"enabled": False},
        "uniquenessLower": 0.005, "nStarts": 1, "maxIterations": 300, "seed": 1,
        "method": "efa", "schemaVersion": "factor_extensions.1",
    })
    assert fitted.status_code == 200, fitted.text
    assert fitted.json()["capabilities"]["materialize"] is True
    rid = fitted.json()["resultId"]
    source = "fit"
    if source_kind == "prediction":
        predicted = client.post(f"/api/v1/analysis-results/{rid}/predict", json={
            "context": ctx, "options": {"interval": "none", "evaluate": False}})
        assert predicted.status_code == 200, predicted.text
        source = predicted.json()["predictionId"]

    def persisted_bytes():
        files = {}
        for path in store.root.glob(f"{ds}.*"):
            for item in path.rglob("*") if path.is_dir() else [path]:
                if item.is_file():
                    files[str(item.relative_to(store.root))] = item.read_bytes()
        assert files
        return files

    endpoint = f"/api/v1/analysis-results/{rid}/materialize"
    request = {"context": ctx, "source": source,
               "columns": [{"source": "score:1", "name": "efa_receipt_score"}],
               "idempotencyKey": "receipt"}
    first = client.post(endpoint, json=request)
    assert first.status_code == 200, first.text
    receipt = first.json()
    assert receipt == {
        "status": "success", "resultId": rid, "idempotentReplay": False,
        "columns": request["columns"], "datasetId": ds,
        "dataRevision": 2, "schemaRevision": 2,
    }
    saved_provenance = store.load_provenance(ds)
    assert len(saved_provenance["operations"]) == 2
    saved_operation = saved_provenance["operations"][-1]
    assert saved_operation["outputDataRevision"] == receipt["dataRevision"]
    assert saved_operation["outputSchemaRevision"] == receipt["schemaRevision"]

    for current_revision in (2, 3):
        if current_revision == 3:
            changed = client.post(f"/api/v1/datasets/{ds}/calculate", json={
                "expression": "q1 * 2", "columnName": "later_calculation", "mode": "create",
                "expectedDataRevision": 2, "expectedSchemaRevision": 2,
            })
            assert changed.status_code == 200, changed.text
            assert changed.json()["dataRevision"] == 3
            assert changed.json()["schemaRevision"] == 3
        before = persisted_bytes()
        provenance = store.load_provenance(ds)
        assert len(provenance["operations"]) == current_revision
        assert provenance["operations"][1] == saved_operation

        # Original, saved and current expected revisions all replay before
        # stale-fit checks. The receipt must never use the newer dataset head.
        for expected_revision in range(1, current_revision + 1):
            replay = client.post(endpoint, json={**request, "context": dict(
                ctx, expectedDataRevision=expected_revision,
                expectedSchemaRevision=expected_revision)})
            assert replay.status_code == 200, replay.text
            assert replay.json() == {**receipt, "idempotentReplay": True}
            assert persisted_bytes() == before
            assert store.load_provenance(ds) == provenance

        conflict = client.post(endpoint, json={**request,
            "columns": [{"source": "score:1", "name": "changed_payload"}]})
        assert conflict.status_code == 409, conflict.text
        assert conflict.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
        assert persisted_bytes() == before
        stale = client.post(endpoint, json={**request, "idempotencyKey": "new-save",
            "context": dict(ctx, expectedDataRevision=current_revision,
                            expectedSchemaRevision=current_revision),
            "columns": [{"source": "score:1", "name": "new_score"}]})
        assert stale.status_code == 409, stale.text
        assert stale.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
        assert persisted_bytes() == before
        assert store.load_provenance(ds) == provenance


def test_rejects_weight_and_mixed_and_old_inputs():
    ds, ctx, colids = _make_continuous()
    base_vars = [{"columnId": c, "measurement": "continuous", "treatment": "continuous"} for c in colids]
    # old input without method/schemaVersion-shaped legacy must be rejected: unknown method value
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx, "variables": base_vars, "correlation": "pearson",
                          "extraction": "ml", "nFactors": 1, "method": "factor",
                          "schemaVersion": "factor_extensions.1"})
    assert r.status_code == 422
    # ordinal/continuous treatment mix rejected at contract level
    mix = [{"columnId": colids[0], "measurement": "ordinal", "treatment": "ordinal",
            "categoryOrder": ["1", "2"]},
           *[dict(v) for v in base_vars[1:]]]
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx, "variables": mix, "correlation": "pearson",
                          "extraction": "ml", "nFactors": 1, "method": "efa",
                          "schemaVersion": "factor_extensions.1"})
    assert r.status_code == 422
    # constant column refused with FA_CONSTANT_COLUMN
    df = pl.DataFrame({"a": [1.0, 2.0, 3.0, 4.0, 5.0, 6.0], "b": [5.0, 5.0, 5.0, 5.0, 5.0, 5.0],
                       "c": [1.0, 3.0, 2.0, 5.0, 4.0, 6.0], "d": [2.0, 1.0, 3.0, 6.0, 5.0, 4.0]})
    ds2 = client.post("/api/v1/datasets/import", files={"file": ("c.csv", df.write_csv().encode(), "text/csv")}).json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{ds2}/codebook").json()
    ids = [c["columnId"] for c in cb["columns"] if c["name"] in ("a", "b", "c", "d")]
    ctx2 = dict(ctx, datasetId=ds2)
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx2,
                          "variables": [{"columnId": c, "measurement": "continuous", "treatment": "continuous"} for c in ids],
                          "correlation": "pearson", "extraction": "minres", "nFactors": 1,
                          "parallelAnalysis": {"enabled": False},
                          "method": "efa", "schemaVersion": "factor_extensions.1"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] in ("FA_CONSTANT_COLUMN", "FA_UNDERIDENTIFIED")


def test_attempt_and_comparison_endpoints():
    ds, ctx, colids = _make_continuous(n=3)
    # n<=p triggers a service-level saved attempt (contract df-check passes q=1/p=4)
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx,
                          "variables": [{"columnId": c, "measurement": "continuous", "treatment": "continuous"} for c in colids],
                          "correlation": "pearson", "extraction": "minres", "nFactors": 1,
                          "parallelAnalysis": {"enabled": False},
                          "method": "efa", "schemaVersion": "factor_extensions.1"})
    assert r.status_code == 422
    aid = r.json()["error"]["details"].get("attemptId")
    assert aid
    got = client.get(f"/api/v1/analysis-attempts/{aid}").json()
    assert got["attemptId"] == aid
    diag = client.get(f"/api/v1/analysis-attempts/{aid}/diagnostics?offset=0&limit=10").json()
    assert diag["total"] >= 0
    assert client.get("/api/v1/analysis-comparisons/nope").status_code == 404


def test_stale_predict_materialize_rejected_and_idempotency_conflict():
    """E007/E008: stale fit refuses new ops; same-key/diff-payload conflicts."""
    ds, ctx, colids = _make_continuous(n=100)
    payload = {
        "context": ctx,
        "variables": [{"columnId": c, "measurement": "continuous", "treatment": "continuous"} for c in colids],
        "correlation": "pearson", "extraction": "ml", "nFactors": 1,
        "rotation": "none", "scoreMethod": "regression",
        "parallelAnalysis": {"enabled": False},
        "uniquenessLower": 0.005, "nStarts": 1, "maxIterations": 300, "seed": 1,
        "method": "efa", "schemaVersion": "factor_extensions.1",
    }
    rid = client.post("/api/v1/models/factor-analysis", json=payload).json()["resultId"]
    m1 = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                     json={"context": ctx, "source": "fit",
                           "columns": [{"source": "score:1", "name": "efa_s1"}],
                           "idempotencyKey": "k1"}).json()
    assert m1["idempotentReplay"] is False
    assert "dataRevision" in m1 and "schemaRevision" in m1
    cb2 = client.get(f"/api/v1/datasets/{ds}/codebook").json()
    ctx2 = dict(ctx, expectedSchemaRevision=cb2.get("schemaRevision"))
    p1 = client.post(f"/api/v1/analysis-results/{rid}/predict",
                     json={"context": ctx2, "options": {"interval": "none", "evaluate": False}})
    assert p1.status_code == 409
    m2 = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                     json={"context": ctx2, "source": "fit",
                           "columns": [{"source": "score:1", "name": "efa_s2"}],
                           "idempotencyKey": "k2"})
    assert m2.status_code == 409
    m3 = client.post(f"/api/v1/analysis-results/{rid}/materialize",
                     json={"context": ctx, "source": "fit",
                           "columns": [{"source": "score:1", "name": "efa_other"}],
                           "idempotencyKey": "k1"})
    assert m3.status_code == 409
    assert m3.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"


def test_empty_selected_scope_stays_empty_and_ml_inference_without_scores():
    """E004/E005: empty scope is not all; scoreMethod=none keeps ML inference."""
    ds, ctx, colids = _make_continuous(n=100)
    ctx_empty = dict(ctx, scope="selected", selectedRowIds=[])
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx_empty,
                          "variables": [{"columnId": c, "measurement": "continuous", "treatment": "continuous"} for c in colids],
                          "correlation": "pearson", "extraction": "ml", "nFactors": 1,
                          "rotation": "none", "scoreMethod": "none",
                          "parallelAnalysis": {"enabled": False},
                          "method": "efa", "schemaVersion": "factor_extensions.1"})
    assert r.status_code == 422
    payload = {
        "context": ctx,
        "variables": [{"columnId": c, "measurement": "continuous", "treatment": "continuous"} for c in colids],
        "correlation": "pearson", "extraction": "ml", "nFactors": 1,
        "rotation": "none", "scoreMethod": "none",
        "parallelAnalysis": {"enabled": False},
        "uniquenessLower": 0.005, "nStarts": 1, "maxIterations": 300, "seed": 1,
        "method": "efa", "schemaVersion": "factor_extensions.1",
    }
    j = client.post("/api/v1/models/factor-analysis", json=payload).json()
    assert j["summary"]["inferenceStatus"] == "available"


def test_nominal_column_rejected_and_attempt_persisted():
    """E011/E013: nominal-as-continuous refused; attempts readable with revisions."""
    import polars as pl2
    df = pl2.DataFrame({"g": ["a", "b", "a", "b"] * 50, "q1": list(range(200)),
                        "q2": list(range(200, 400)), "q3": list(range(400, 600))})
    ds = client.post("/api/v1/datasets/import", files={"file": ("nom.csv", df.write_csv().encode(), "text/csv")}).json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{ds}/codebook").json()
    ids = {x["name"]: x["columnId"] for x in cb["columns"][:4]}
    ctx = {"datasetId": ds, "expectedDataRevision": 1, "expectedSchemaRevision": 1, "scope": "all",
           "weightMode": "none", "missingPolicy": "exclude", "imputationPolicy": "use_current_values"}
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx,
                          "variables": [{"columnId": ids[k], "measurement": "continuous", "treatment": "continuous"}
                                        for k in ("g", "q1", "q2", "q3")],
                          "correlation": "pearson", "extraction": "minres", "nFactors": 1,
                          "rotation": "none", "scoreMethod": "none",
                          "parallelAnalysis": {"enabled": False},
                          "method": "efa", "schemaVersion": "factor_extensions.1"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] in ("FA_SCALE_UNSUPPORTED",
                                         "FA_SCALE_BASIS_REQUIRED")
    from app.api import factor_analysis as fa
    fa._attempts.clear()
    aid = fa._save_attempt(ds, {"x": 1}, "input", "FA_TEST", "test")
    fa._attempts.clear()
    got = client.get(f"/api/v1/analysis-attempts/{aid}").json()
    assert got["attemptId"] == aid
    assert got["dataRevision"] == 1 and got["schemaRevision"] == 1


def test_ordinal_continuous_disguise_refused():
    """E013 2nd round: codebook-ordinal with bare continuous claim is refused."""
    import polars as pl2
    import numpy as np2
    rng = np2.random.default_rng(0)
    X = rng.normal(size=(200, 4))
    df = pl2.DataFrame({f"q{i+1}": X[:, i].tolist() for i in range(4)})
    ds = client.post("/api/v1/datasets/import", files={"file": ("o1.csv", df.write_csv().encode(), "text/csv")}).json()["datasetId"]
    from app.storage.dataset_store import DatasetStore as _DS
    store = _DS()
    cb = store.load_codebook(ds)
    for col in cb["columns"][:4]:
        col["scaleType"] = "ordinal"
        col["categoryOrder"] = ["1", "2", "3"]
    store.save_codebook(ds, cb)
    cb2 = store.load_codebook(ds)
    ids = [x["columnId"] for x in cb2["columns"][:4]]
    ctx = {"datasetId": ds, "expectedDataRevision": 1,
           "expectedSchemaRevision": cb2.get("schemaRevision", 1), "scope": "all",
           "weightMode": "none", "missingPolicy": "exclude",
           "imputationPolicy": "use_current_values"}
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx,
                          "variables": [{"columnId": x, "measurement": "continuous", "treatment": "continuous"} for x in ids],
                          "correlation": "pearson", "extraction": "ml", "nFactors": 1,
                          "rotation": "none", "scoreMethod": "none",
                          "parallelAnalysis": {"enabled": False},
                          "method": "efa", "schemaVersion": "factor_extensions.1"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "FA_APPROXIMATION_ACK_REQUIRED"


def test_nominal_with_evidence_basis_passes_scale_gate():
    """E013 3rd round: nominal + scaleBasis reaches fit stage (not scale refusal)."""
    import polars as pl2
    df = pl2.DataFrame({"g": ["a", "b", "a", "b"] * 50, "q1": list(range(200)),
                        "q2": list(range(200, 400)), "q3": list(range(400, 600))})
    ds = client.post("/api/v1/datasets/import", files={"file": ("nom3.csv", df.write_csv().encode(), "text/csv")}).json()["datasetId"]
    cb = client.get(f"/api/v1/datasets/{ds}/codebook").json()
    ids = {x["name"]: x["columnId"] for x in cb["columns"][:4]}
    ctx = {"datasetId": ds, "expectedDataRevision": 1, "expectedSchemaRevision": 1, "scope": "all",
           "weightMode": "none", "missingPolicy": "exclude", "imputationPolicy": "use_current_values"}
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx,
                          "variables": [{"columnId": ids["g"], "measurement": "ordinal",
                                         "treatment": "ordinal",
                                         "categoryOrder": ["a", "b"],
                                         "scaleBasis": "analyst_verified_order"}
                                        ] + [{"columnId": ids[k], "measurement": "continuous",
                                              "treatment": "continuous"} for k in ("q1", "q2", "q3")],
                          "correlation": "pearson", "extraction": "minres", "nFactors": 1,
                          "rotation": "none", "scoreMethod": "none",
                          "parallelAnalysis": {"enabled": False},
                          "method": "efa", "schemaVersion": "factor_extensions.1"})
    # Must not be a scale refusal; any later-stage outcome is acceptable here.
    assert r.json().get("error", {}).get("code", "") not in (
        "FA_SCALE_UNSUPPORTED", "FA_SCALE_BASIS_REQUIRED")


def test_continuous_na_split_and_basis_gate():
    """E006/E013 3rd round: continuous NA split; nominal needs scaleBasis."""
    import polars as pl2
    import numpy as np2
    rng = np2.random.default_rng(0)
    X = rng.normal(size=(100, 3))
    df = pl2.DataFrame({f"q{i+1}": X[:, i].tolist() for i in range(3)})
    v1 = df["q1"].to_list(); v1[0] = -999.0
    v2 = df["q2"].to_list(); v2[1] = -888.0
    df = df.with_columns([pl2.Series("q1", v1), pl2.Series("q2", v2)])
    ds = client.post("/api/v1/datasets/import", files={"file": ("na.csv", df.write_csv().encode(), "text/csv")}).json()["datasetId"]
    from app.storage.dataset_store import DatasetStore as _DS2
    store = _DS2()
    cb = store.load_codebook(ds)
    for col in cb["columns"][:3]:
        if col["name"] == "q1":
            col["missingCodes"] = [-999]
        if col["name"] == "q2":
            col["missingCodes"] = [-888]
            col["missingReasons"] = {"-888": "非該当スキップ"}
    store.save_codebook(ds, cb)
    cb2 = store.load_codebook(ds)
    ids = [x["columnId"] for x in cb2["columns"][:3]]
    ctx = {"datasetId": ds, "expectedDataRevision": 1,
           "expectedSchemaRevision": cb2.get("schemaRevision", 1), "scope": "all",
           "weightMode": "none", "missingPolicy": "exclude",
           "imputationPolicy": "use_current_values"}
    r = client.post("/api/v1/models/factor-analysis",
                    json={"context": ctx,
                          "variables": [{"columnId": x, "measurement": "continuous", "treatment": "continuous"} for x in ids],
                          "correlation": "pearson", "extraction": "minres", "nFactors": 1,
                          "rotation": "none", "scoreMethod": "none",
                          "parallelAnalysis": {"enabled": False},
                          "method": "efa", "schemaVersion": "factor_extensions.1"}).json()
    assert r["meta"]["fitCount"] == 98
    assert r["meta"]["exclusionBreakdown"] == {"invalid": 0, "missing": 1, "notApplicable": 1}
    assert r["meta"]["exclusionCounts"]["missing"] == 2
    d0, d1 = r["details"]["distributionProfiles"][:2]
    assert (d0["missing"], d0["notApplicable"]) == (1, 0)
    assert (d1["missing"], d1["notApplicable"]) == (0, 1)
