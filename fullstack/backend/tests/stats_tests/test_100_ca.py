"""Feature 029 CA kernel/API tests (production)."""
from __future__ import annotations

import csv
from fractions import Fraction
import io
import json

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.algorithms.models.correspondence import run_ca_numeric, pearson_reference
from app.main import app

TOL = dict(rtol=1e-9, atol=1e-10)


def _table():
    return np.array([[30.0, 10.0], [10.0, 30.0]])


def test_ca01_analytic():
    k = run_ca_numeric(_table(), keep_row_index=[0, 1], keep_col_index=[0, 1])
    assert abs(k["eigenvalues"][0] - 0.25) < 1e-12
    assert abs(k["totalInertia"] - 0.25) < 1e-12
    assert all(abs(abs(v) - 0.5) < 1e-12 for v in k["f"][:, 0].tolist())
    p = pearson_reference(_table(), k["r"], k["c"], 80.0)
    assert abs(p["statistic"] - 20.0) < 1e-9
    assert p["df"] == 1


def test_ca02_scale_transpose():
    k = run_ca_numeric(_table(), keep_row_index=[0, 1], keep_col_index=[0, 1])
    k2 = run_ca_numeric(3.0 * _table(), keep_row_index=[0, 1], keep_col_index=[0, 1])
    assert np.allclose(np.abs(k2["f"]), np.abs(k["f"]), **TOL)
    kt = run_ca_numeric(_table().T, keep_row_index=[0, 1], keep_col_index=[0, 1])
    assert np.allclose(np.abs(kt["f"]), np.abs(k["g"]), **TOL)


def test_ca03_zero_inertia():
    import pytest

    with pytest.raises(ValueError, match="CA_ZERO_INERTIA"):
        run_ca_numeric(np.array([[10.0, 10.0], [10.0, 10.0]]),
                       keep_row_index=[0, 1], keep_col_index=[0, 1])


def _import_csv(client, name, df):
    r = client.post("/api/v1/datasets/import",
                    files={"file": (name, df.write_csv().encode(), "text/csv")})
    assert r.status_code == 200, r.text
    return r.json()["datasetId"]


def _codebook(client, did):
    r = client.get(f"/api/v1/datasets/{did}/codebook")
    assert r.status_code == 200
    return {x["name"]: x for x in r.json()["columns"]}


def _respondent_rows():
    rows = []
    for _ in range(30):
        rows.append(("R1", "C1"))
    for _ in range(10):
        rows.append(("R1", "C2"))
    for _ in range(10):
        rows.append(("R2", "C1"))
    for _ in range(30):
        rows.append(("R2", "C2"))
    return rows


def test_ca_api_contingency_and_respondents_agree():
    client = TestClient(app)
    did = _import_csv(client, "ca.csv", pl.DataFrame({"lab": ["R1", "R2"], "C1": [30, 10], "C2": [10, 30]}))
    cols = _codebook(client, did)
    body = {
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "input": {"kind": "contingency", "rowLabelColumn": cols["lab"]["columnId"],
                  "valueColumns": [cols["C1"]["columnId"], cols["C2"]["columnId"]],
                  "cellSemantics": "frequency", "independentCountsAcknowledged": True},
    }
    r = client.post("/api/v1/models/ca", json=body)
    assert r.status_code == 200, r.text
    tab = r.json()
    assert abs(tab["summary"]["eigenvalues"][0] - 0.25) < 1e-12
    assert tab["summary"]["pearson"]["status"] == "available"
    assert abs(tab["summary"]["pearson"]["statistic"] - 20.0) < 1e-9
    rows = _respondent_rows()
    did2 = _import_csv(client, "resp.csv",
                       pl.DataFrame({"brand": [a for a, _ in rows], "need": [b for _, b in rows]}))
    cols2 = _codebook(client, did2)
    r2 = client.post("/api/v1/models/ca", json={
        "context": {"datasetId": did2, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "input": {"kind": "respondents", "rowVariable": cols2["brand"]["columnId"],
                  "columnVariable": cols2["need"]["columnId"]}})
    assert r2.status_code == 200, r2.text
    resp = r2.json()
    assert abs(resp["summary"]["eigenvalues"][0] - 0.25) < 1e-12
    f1 = np.array([e["principalCoordinates"] for e in tab["details"]["rowCategories"]])
    f2 = np.array([e["principalCoordinates"] for e in resp["details"]["rowCategories"]])
    assert np.allclose(np.abs(f1), np.abs(f2), **TOL)


def test_ca_api_rejects():
    client = TestClient(app)
    did = _import_csv(client, "neg.csv",
                      pl.DataFrame({"lab": ["R1", "R2"], "C1": [30, -5], "C2": [10, 30]}))
    cols = _codebook(client, did)
    bad = {
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "input": {"kind": "contingency", "rowLabelColumn": cols["lab"]["columnId"],
                  "valueColumns": [cols["C1"]["columnId"], cols["C2"]["columnId"]],
                  "cellSemantics": "mass", "independentCountsAcknowledged": False},
    }
    r = client.post("/api/v1/models/ca", json=bad)
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "CA_TABLE_INVALID"
    bad2 = dict(bad["input"])
    bad2["structuralZerosDeclared"] = True
    r = client.post("/api/v1/models/ca", json={"context": bad["context"], "input": bad2})
    assert r.json()["error"]["code"] == "CA_STRUCTURAL_ZERO_UNSUPPORTED"


def test_ca_select_and_or_and_stale():
    client = TestClient(app)
    rows = _respondent_rows()
    did = _import_csv(client, "s.csv",
                      pl.DataFrame({"brand": [a for a, _ in rows], "need": [b for _, b in rows]}))
    cols = _codebook(client, did)
    body = client.post("/api/v1/models/ca", json={
        "context": {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
                    "scope": "all", "weightMode": "none"},
        "input": {"kind": "respondents", "rowVariable": cols["brand"]["columnId"],
                  "columnVariable": cols["need"]["columnId"]}}).json()
    rid = body["resultId"]
    rc = {e["code"]: e["categoryId"] for e in body["details"]["rowCategories"]}
    cc = {e["code"]: e["categoryId"] for e in body["details"]["columnCategories"]}
    ctx = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
           "scope": "all", "weightMode": "none"}
    aand = client.post(f"/api/v1/analysis-results/{rid}/select",
                       json={"context": ctx,
                             "selector": {"kind": "categories",
                                          "categoryIds": [rc["R1"], cc["C1"]],
                                          "betweenVariables": "and"}}).json()
    assert aand["contextIntersectionCount"] == 30
    oor = client.post(f"/api/v1/analysis-results/{rid}/select",
                      json={"context": ctx,
                            "selector": {"kind": "categories",
                                         "categoryIds": [rc["R1"], cc["C1"]],
                                         "betweenVariables": "or"}}).json()
    assert oor["contextIntersectionCount"] == 50
    stale = client.post(f"/api/v1/analysis-results/{rid}/select",
                        json={"context": {**ctx, "expectedDataRevision": 999},
                              "selector": {"kind": "categories", "categoryIds": [rc["R1"]]}})
    assert stale.status_code == 409
    exp = client.post(f"/api/v1/analysis-results/{rid}/export",
                      json={"format": "csv", "table": "eigenvalues"}).json()
    assert exp["total"] == 1 and "eigenvalue" in exp["payload"]
    assert client.post(f"/api/v1/analysis-results/{rid}/predict",
                       json={"context": ctx}).status_code == 422
    assert client.post(f"/api/v1/analysis-results/{rid}/materialize",
                       json={"context": ctx}).status_code == 422


def _centroid_tables():
    saved = np.array([[96, 96, 96, 192], [96, 96, 96, 96],
                      [96, 192, 96, 96], [192, 96, 96, 96], [96, 96, 192, 96]], dtype=float)
    rp, cp = [4, 1, 2, 0, 3], [2, 0, 3, 1]
    both = saved[np.ix_(rp, cp)]
    binary = np.array([[3, 1], [2, 2], [1, 3], [2, 2]], dtype=float)
    near = saved * 2**20
    near[1, 0] += 1
    near[1, 1] -= 1
    near[0, 0] -= 1
    near[0, 1] += 1
    fractional = np.array([[.25, .25, .5], [.25, .75, 1.], [.25, 1.25, 1.5]])
    perturbed = fractional.copy()
    h = 2**-12
    perturbed[1, 0] += h
    perturbed[1, 1] -= h
    perturbed[0, 0] -= h
    perturbed[0, 1] += h
    return {"saved": saved, "scale3": 3 * saved, "scale97": 97 * saved,
            "row_permutation": saved[rp], "column_permutation": saved[:, cp],
            "both_permutations": both, "transpose": saved.T, "transpose_reordered": both.T,
            "binary": binary, "binary_transpose": binary.T,
            "near": near, "near_transpose": near.T,
            "fractional": fractional, "fractional_transpose": fractional.T,
            "fractional_perturbed": perturbed, "fractional_perturbed_transpose": perturbed.T,
            "subnormal_binary": binary * 2**-1070}


def _exact_ca_geometry(table):
    # Fractions describe the received floats exactly, including noninteger weights.
    t = [[Fraction(float(v)) for v in row] for row in table]
    total = sum(map(sum, t))
    rt, ct = list(map(sum, t)), list(map(sum, zip(*t)))
    r, c = [v / total for v in rt], [v / total for v in ct]
    rd = [[v / rt[i] - c[j] for j, v in enumerate(row)] for i, row in enumerate(t)]
    cd = [[t[i][j] / ct[j] - r[i] for i in range(len(r))] for j in range(len(c))]
    def gram(residuals, masses):
        return [[sum(a * b / mass for a, b, mass in zip(x, y, masses))
                 for y in residuals] for x in residuals]
    rg, cg = gram(rd, c), gram(cd, r)
    return r, c, rg, cg


def _assert_positive_cos2(values, mass, exact_distance):
    assert all(v is not None for v in values)
    assert np.isfinite(values).all()
    assert np.min(values) >= -1e-10 and np.max(values) <= 1 + 1e-10
    # Absolute residual error is amplified by the inverse direction length.
    budget = max(1e-10, 32 * np.finfo(float).eps / np.sqrt(float(mass * exact_distance)))
    assert abs(sum(values) - 1) <= budget
    return budget


@pytest.mark.parametrize("case", list(_centroid_tables()))
def test_ca_centroid_kernel_contract(case):
    table = _centroid_tables()[case]
    k = run_ca_numeric(table, keep_row_index=list(range(len(table))),
                       keep_col_index=list(range(table.shape[1])))
    r, c, rg, cg = _exact_ca_geometry(table)
    assert k["rank"] == (3 if case in {"saved", "scale3", "scale97", "row_permutation",
                                     "column_permutation", "both_permutations", "transpose",
                                     "transpose_reordered", "near", "near_transpose"} else 1)
    assert np.allclose(k["r"], np.array(r, dtype=float), rtol=1e-12, atol=0)
    assert np.allclose(k["c"], np.array(c, dtype=float), rtol=1e-12, atol=0)
    assert np.allclose(k["f"] @ k["f"].T, np.array(rg, dtype=float), rtol=1e-12, atol=5e-15)
    assert np.allclose(k["g"] @ k["g"].T, np.array(cg, dtype=float), rtol=1e-12, atol=5e-15)
    expected_inertia = float(sum(mass * rg[i][i] for i, mass in enumerate(r)))
    assert k["totalInertia"] == pytest.approx(expected_inertia, rel=1e-12, abs=1e-15)
    assert k["eigenvalues"].sum() == pytest.approx(expected_inertia, rel=1e-12, abs=1e-15)
    assert (k["eigenvalues"] > 0).all()
    assert k["discardedNumericalInertia"] < 1e-25
    reconstructed = np.outer(k["r"], k["c"]) + np.sqrt(np.outer(k["r"], k["c"])) * ((k["u"] * k["s"]) @ k["v"].T)
    assert np.allclose(reconstructed, k["p"], rtol=1e-12, atol=5e-15)
    for prefix, masses, exact_gram in (("row", r, rg), ("col", c, cg)):
        assert np.allclose(k[prefix + "Contrib"].sum(axis=0), 1, rtol=1e-12, atol=1e-12)
        for i, mass in enumerate(masses):
            distance = exact_gram[i][i]
            cos2 = k[prefix + "Cos2"][i]
            if distance == 0:
                assert k[prefix + "Distance2"][i] == 0
                assert np.isnan(cos2).all()
            else:
                budget = _assert_positive_cos2(cos2, mass, distance)
                assert k[prefix + "Distance2"][i] > 0
                assert k[prefix + "Distance2"][i] == pytest.approx(float(distance), rel=budget, abs=0)
    if case == "near":
        assert rg[1][1] == Fraction(1, 20266198323167232)
    if case == "fractional_perturbed":
        assert rg[1][1] == Fraction(1, 3 * 2**21)
        assert cg[2][2] == 0


def _fit_centroid_api(client, table, *, mode="contingency", omitted=False, scaling="symmetric", weight_scale=1, mass=False):
    source = np.pad(table, ((1, 0), (1, 0))) if omitted else table
    row_labels = [f"R{i}" for i in range(len(source))]
    col_labels = [f"C{j}" for j in range(source.shape[1])]
    if mode == "contingency":
        frame = pl.DataFrame({"label": row_labels,
                              **{name: source[:, j] for j, name in enumerate(col_labels)}})
    else:
        rows = []
        for i, row in enumerate(source):
            for j, value in enumerate(row):
                if mode == "weighted":
                    if value > 0:
                        rows.append((row_labels[i], col_labels[j], float(value) * weight_scale))
                else:
                    rows.extend([(row_labels[i], col_labels[j], 1.)] * int(value))
        frame = pl.DataFrame({"row_category": [a for a, _, _ in rows],
                              "column_category": [b for _, b, _ in rows],
                              "weight": [w for _, _, w in rows]})
    did = _import_csv(client, "centroids.csv", frame)
    cols = _codebook(client, did)
    context = {"datasetId": did, "expectedDataRevision": 1, "expectedSchemaRevision": 1,
               "scope": "all", "weightMode": "none"}
    if mode == "contingency":
        frequency = not mass and np.equal(source, np.floor(source)).all()
        inp = {"kind": "contingency", "rowLabelColumn": cols["label"]["columnId"],
               "valueColumns": [cols[name]["columnId"] for name in col_labels],
               "cellSemantics": "frequency" if frequency else "mass",
               "independentCountsAcknowledged": bool(frequency)}
    else:
        inp = {"kind": "respondents", "rowVariable": cols["row_category"]["columnId"],
               "columnVariable": cols["column_category"]["columnId"]}
        if mode == "weighted":
            cols["weight"].update(role="weight", scaleType="ratio")
            updated = client.put(f"/api/v1/datasets/{did}/codebook", json={
                "columns": list(cols.values()),
                "weightConfig": {"weightColumnId": cols["weight"]["columnId"], "weightType": "survey"}})
            assert updated.status_code == 200, updated.text
            context["expectedSchemaRevision"] = updated.json()["schemaRevision"]
            context["weightMode"] = "dataset"
    response = client.post("/api/v1/models/ca", json={"context": context, "input": inp, "mapScaling": scaling})
    assert response.status_code == 200, response.text
    body = response.json()
    expected_table = table * (weight_scale if mode == "weighted" else 1)
    assert body["details"]["table"] == expected_table.tolist()
    assert [e["label"] for e in body["details"]["rowCategories"]] == row_labels[1 if omitted else 0:]
    assert [e["label"] for e in body["details"]["columnCategories"]] == col_labels[1 if omitted else 0:]
    if omitted:
        assert {(e["side"], e["originalIndex"], e["reason"]) for e in body["details"]["omittedCategories"]} == {
            ("row", 0, "zero_mass"), ("column", 0, "zero_mass")}
    else:
        assert body["details"]["omittedCategories"] == []
    return body, frame.height


def _assert_ca_api_centroids(client, body, table):
    r, c, rg, cg = _exact_ca_geometry(table)
    expected_reasons = {}
    rank = body["summary"]["rank"]
    for key, masses, gram in (("rowCategories", r, rg), ("columnCategories", c, cg)):
        entries = body["details"][key]
        assert len(entries) == len(masses)
        for i, entry in enumerate(entries):
            assert entry["mass"] == pytest.approx(float(masses[i]), rel=1e-12, abs=0)
            assert len(entry["cos2"]) == rank
            if gram[i][i] == 0:
                assert entry["distanceSquared"] == 0
                assert entry["cos2"] == [None] * rank
                for axis in range(rank):
                    expected_reasons[f"/details/{key}/{i}/cos2/{axis}"] = f"/details/{key}/{i}/distanceSquared"
            else:
                assert entry["distanceSquared"] > 0
                _assert_positive_cos2(entry["cos2"], masses[i], gram[i][i])
    assert set(body["unavailableReasons"]) == set(expected_reasons)
    for pointer, related in expected_reasons.items():
        reason = body["unavailableReasons"][pointer]
        assert reason["code"] == "ZERO_DISTANCE"
        assert isinstance(reason["message"], str) and reason["message"]
        assert reason["relatedFields"] == [related]
    rid = body["resultId"]
    stored_response = client.get(f"/api/v1/analysis-results/{rid}")
    assert stored_response.status_code == 200, stored_response.text
    stored = stored_response.json()
    assert stored["details"] == body["details"]
    assert stored["unavailableReasons"] == body["unavailableReasons"]
    assert stored["meta"]["algorithmVersion"] == body["meta"]["algorithmVersion"] == "davis.ca.1.0.1"
    categories = body["details"]["rowCategories"] + body["details"]["columnCategories"]
    for fmt in ("json", "csv"):
        response = client.post(f"/api/v1/analysis-results/{rid}/export", json={"format": fmt, "table": "categories"})
        assert response.status_code == 200, response.text
        export = response.json()
        assert export["total"] == len(categories) and export["nextOffset"] is None
        if fmt == "json":
            data = json.loads(export["payload"])
            records = [dict(zip(data["columns"], row)) for row in data["rows"]]
        else:
            records = list(csv.DictReader(io.StringIO(export["payload"])))
        assert [e["categoryId"] for e in records] == [e["categoryId"] for e in categories]
        for record, entry in zip(records, categories):
            for axis, value in enumerate(entry["cos2"], 1):
                actual = record[f"cos2_{axis}"]
                if value is None:
                    assert actual == (None if fmt == "json" else "")
                else:
                    assert float(actual) == value


@pytest.mark.parametrize("case,omitted,scaling", [
    ("saved", False, "symmetric"), ("row_permutation", False, "symmetric"),
    ("column_permutation", False, "symmetric"), ("transpose", False, "symmetric"),
    ("binary", True, "symmetric"), ("binary_transpose", True, "symmetric"),
    ("near", False, "symmetric"), ("near_transpose", False, "symmetric"),
    ("saved", False, "row_principal"), ("saved", False, "column_principal"),
    ("fractional", False, "symmetric"), ("fractional_perturbed", False, "symmetric"),
])
def test_ca_centroid_api_contingency_contract(case, omitted, scaling):
    table = _centroid_tables()[case]
    with TestClient(app) as client:
        body, count = _fit_centroid_api(client, table, omitted=omitted, scaling=scaling)
        _assert_ca_api_centroids(client, body, table)
    assert body["meta"]["analysisUnit"] == "table_record"
    assert body["meta"]["scopeCount"] == body["meta"]["fitCount"] == body["meta"]["effectiveN"] == count
    assert body["meta"]["excludedCount"] == 0 and not any(body["meta"]["exclusionCounts"].values())
    assert body["meta"]["weightApplied"] is False
    assert body["meta"]["sumWeights"] is None and body["details"]["physicalTable"] is None
    assert all(e["physicalCount"] is None for key in ("rowCategories", "columnCategories") for e in body["details"][key])


@pytest.mark.parametrize("case", ["saved", "binary", "binary_transpose"])
def test_ca_centroid_api_respondents_contract(case):
    table = _centroid_tables()[case]
    with TestClient(app) as client:
        body, count = _fit_centroid_api(client, table, mode="respondents")
        _assert_ca_api_centroids(client, body, table)
    assert count == int(table.sum())
    assert body["meta"]["analysisUnit"] == "respondent_row"
    assert body["meta"]["scopeCount"] == body["meta"]["fitCount"] == body["meta"]["effectiveN"] == count
    assert body["meta"]["excludedCount"] == 0 and not any(body["meta"]["exclusionCounts"].values())
    assert body["meta"]["weightApplied"] is False and body["meta"]["sumWeights"] is None
    assert body["details"]["physicalTable"] == table.astype(int).tolist()
    assert [e["physicalCount"] for e in body["details"]["rowCategories"]] == table.sum(axis=1).astype(int).tolist()
    assert [e["physicalCount"] for e in body["details"]["columnCategories"]] == table.sum(axis=0).astype(int).tolist()


@pytest.mark.parametrize("case", ["fractional", "fractional_perturbed"])
@pytest.mark.parametrize("weight_scale", [1, 8])
def test_ca_centroid_api_fractional_survey_weights(case, weight_scale):
    table = _centroid_tables()[case]
    with TestClient(app) as client:
        body, count = _fit_centroid_api(client, table, mode="weighted", weight_scale=weight_scale)
        _assert_ca_api_centroids(client, body, table * weight_scale)
        mass_body, _ = _fit_centroid_api(client, table * weight_scale, mass=True)
        _assert_ca_api_centroids(client, mass_body, table * weight_scale)
    assert count == 9
    meta = body["meta"]
    assert meta["scopeCount"] == meta["fitCount"] == meta["effectiveN"] == 9
    assert meta["excludedCount"] == 0 and not any(meta["exclusionCounts"].values())
    assert meta["weightApplied"] is True and meta["weightType"] == "survey"
    assert meta["sumWeights"] == 6 * weight_scale
    assert meta["kishEffectiveN"] == pytest.approx(float(table.sum()**2 / np.square(table).sum()))
    if case == "fractional":
        assert meta["kishEffectiveN"] == pytest.approx(288 / 47)
    assert meta["frequencyN"] is None and body["summary"]["pearson"]["status"] == "not_applicable"
    assert body["details"]["physicalTable"] == np.ones_like(table, dtype=int).tolist()
    assert all(e["physicalCount"] == 3 for key in ("rowCategories", "columnCategories") for e in body["details"][key])
    assert np.allclose(body["summary"]["eigenvalues"], mass_body["summary"]["eigenvalues"], rtol=1e-12, atol=1e-15)
    for key in ("rowCategories", "columnCategories"):
        f = np.array([e["principalCoordinates"] for e in body["details"][key]])
        g = np.array([e["principalCoordinates"] for e in mass_body["details"][key]])
        assert np.allclose(f @ f.T, g @ g.T, rtol=1e-12, atol=5e-15)
