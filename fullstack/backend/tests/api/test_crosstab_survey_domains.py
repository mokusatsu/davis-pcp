"""Public-API domain regressions: identical bytes run against old/new production.

No imports of new helper names. The Fraction ratio/PSU oracle is independent of
DAVIS numerical code. Larger-table F tails use a separately derived beta-CDF
route through the same SciPy dependency, not an independent library or live R.
"""
from __future__ import annotations

import copy
import csv
from fractions import Fraction as Q
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re

import pytest
from fastapi.testclient import TestClient
import pyarrow.ipc
from scipy.special import betainc

from app.main import app
from app.storage.dataset_store import DatasetStore


def fixture_rows():
    rows = []
    cells = [("a", "x"), ("a", "y"), ("b", "x"), ("b", "y")]
    for psu, vector in [("P1", [3, 0, 0, 1]), ("P2", [0, 1, 1, 2]), ("P3", [1, 1, 1, 1])]:
        for (row, col), count in zip(cells, vector):
            for _ in range(count):
                rows.append(dict(case_id=f"r{len(rows)+1:02}", row=row, col=col,
                                 w=1, stratum="S1", psu=psu, fpc=6))
    return rows


def solve_fraction(a, b):
    """Small exact Gauss-Jordan solve, independent of the production QR/SVD."""
    n = len(a)
    aug = [list(a[i]) + list(b[i]) for i in range(n)]
    for j in range(n):
        pivot = next(i for i in range(j, n) if aug[i][j])
        aug[j], aug[pivot] = aug[pivot], aug[j]
        scale = aug[j][j]
        aug[j] = [x/scale for x in aug[j]]
        for i in range(n):
            if i != j:
                scale = aug[i][j]
                aug[i] = [x-scale*y for x, y in zip(aug[i], aug[j])]
    return [row[n:] for row in aug]


def independent_oracle(rows, fit_ids, *, fpc=False, psu=True, strata=True):
    universe = [r for r in rows if r["w"] is not None and Q(str(r["w"])) > 0]
    fitted = [r for r in universe if r["case_id"] in fit_ids]
    row_cats = sorted({r["row"] for r in fitted})
    col_cats = sorted({r["col"] for r in fitted})
    cells = [(r, c) for r in row_cats for c in col_cats]
    n, k = len(fitted), len(cells)
    weight_sum = sum(Q(str(r["w"])) for r in fitted)
    p = [sum(Q(str(r["w"])) for r in fitted if (r["row"], r["col"]) == cell)/weight_sum for cell in cells]
    totals = {}
    pops = {}
    for r in universe:
        s = r["stratum"] if strata else "single"
        g = r["psu"] if psu else r["case_id"]
        totals.setdefault(s, {}).setdefault(g, [Q(0)]*k)
        if fpc:
            pops[s] = Q(str(r["fpc"]))
        if r["case_id"] in fit_ids:
            score = [Q(str(r["w"]))/weight_sum * (int((r["row"], r["col"]) == cell)-p[j])
                     for j, cell in enumerate(cells)]
            totals[s][g] = [a+b for a, b in zip(totals[s][g], score)]
    v = [[Q(0) for _ in range(k)] for _ in range(k)]
    for s, psus in totals.items():
        m = len(psus)
        if m < 2:
            assert all(x == 0 for score in psus.values() for x in score)
            continue
        center = [sum(t[j] for t in psus.values())/m for j in range(k)]
        factor = Q(m, m-1) * ((1-Q(m)/pops[s]) if fpc else 1)
        for i in range(k):
            for j in range(k):
                v[i][j] += factor*sum((t[i]-center[i])*(t[j]-center[j]) for t in psus.values())
    contrasts = []
    nr, nc = len(row_cats), len(col_cats)
    for i in range(nr-1):
        for j in range(nc-1):
            h = [Q(0)]*k
            for rr, cc, value in [(i,j,1), (i,nc-1,-1), (nr-1,j,-1), (nr-1,nc-1,1)]:
                h[rr*nc+cc] = Q(value)
            contrasts.append(h)
    # The referenced R observed-proportion correction sets the inverse entry
    # to zero for an empty cell, while retaining positive-margin categories.
    inverse = [1/value if value else Q(0) for value in p]
    a = [[sum(x[t]*y[t]*inverse[t] for t in range(k))/n for y in contrasts] for x in contrasts]
    b = [[sum(x[i]*v[i][j]*y[j]*inverse[i]*inverse[j] for i in range(k) for j in range(k))
          for y in contrasts] for x in contrasts]
    delta = solve_fraction(a, b)
    trace = sum(delta[i][i] for i in range(len(delta)))
    trace_square = sum(delta[i][j]*delta[j][i] for i in range(len(delta)) for j in range(len(delta)))
    ndf = trace**2/trace_square
    pairs = {(r["stratum"] if strata else "single", r["psu"] if psu else r["case_id"]) for r in fitted}
    domain_df = len(pairs)-len({s for s, _ in pairs})
    ddf = ndf*domain_df
    rm = [sum(p[i*nc+j] for j in range(nc)) for i in range(nr)]
    cm = [sum(p[i*nc+j] for i in range(nr)) for j in range(nc)]
    chi2 = n*sum((p[i*nc+j]-rm[i]*cm[j])**2/(rm[i]*cm[j]) for i in range(nr) for j in range(nc))
    statistic = chi2/trace
    f = float(statistic)
    if ndf == 1 and ddf == 1:
        tail = 1-2*math.atan(math.sqrt(f))/math.pi
    elif ndf == 1 and ddf == 2:
        tail = 1-math.sqrt(f/(f+2))
    else:
        tail = float(betainc(float(ddf)/2, float(ndf)/2, float(ddf/(ddf+ndf*statistic))))
    return dict(F=float(statistic), numeratorDf=float(ndf), denominatorDf=float(ddf),
                pValue=tail, designDf=domain_df, covariance=[[float(x) for x in row] for row in v])


class Harness:
    def __init__(self, client, evidence):
        self.client, self.evidence, self.sequence = client, evidence, 0
        self.imported = {}

    def request(self, method, path, **kwargs):
        response = self.client.request(method, path, **kwargs)
        if self.evidence:
            self.sequence += 1
            stem = self.evidence / f"{self.sequence:03}"
            request = response.request
            raw = request.read()
            stem.with_suffix(".request.bin").write_bytes(raw)
            stem.with_suffix(".response.bin").write_bytes(response.content)
            stem.with_suffix(".json").write_text(json.dumps(dict(
                method=method, url=str(request.url), status=response.status_code,
                request_headers=dict(request.headers), response_headers=dict(response.headers),
                request_sha256=hashlib.sha256(raw).hexdigest(),
                response_sha256=hashlib.sha256(response.content).hexdigest()), indent=2))
        return response

    def create(self, rows=None, *, fpc=False, psu=True, strata=True, weight_type="survey", edits=None):
        rows = fixture_rows() if rows is None else rows
        text = io.StringIO(newline="")
        writer = csv.DictWriter(text, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        response = self.request("POST", "/api/v1/datasets/import",
                                files={"file": ("domain.csv", text.getvalue(), "text/csv")})
        assert response.status_code == 200, response.text
        dataset_id = response.json()["datasetId"]
        url = f"/api/v1/datasets/{dataset_id}"
        cb = self.request("GET", url+"/codebook").json()
        columns = {c["name"]: dict(c) for c in cb["columns"]}
        columns["row"].update(role="question", scaleType="nominal", categoryOrder=["a", "b"])
        columns["col"].update(role="question", scaleType="nominal", categoryOrder=["x", "y"])
        columns["w"].update(role="weight", scaleType="ratio")
        for name, updates in (edits or {}).items():
            columns[name].update(updates)
        design = {"weightColumnId": columns["w"]["columnId"]}
        for enabled, key, name in [(psu, "psuColumnId", "psu"), (strata, "strataColumnId", "stratum"), (fpc, "fpcColumnId", "fpc")]:
            if enabled:
                design[key] = columns[name]["columnId"]
        response = self.request("PUT", url+"/codebook", json={
            "columns": list(columns.values()), "weightConfig": {
                "weightColumnId": columns["w"]["columnId"], "weightType": weight_type}, "surveyDesign": design})
        assert response.status_code == 200, response.text
        meta = self.request("GET", url).json()
        cb = self.request("GET", url+"/codebook").json()
        view = self.request("POST", url+"/view", json={"columns": list(rows[0])})
        assert view.status_code == 200, view.text
        mapping = pyarrow.ipc.open_stream(view.content).read_all().to_pylist()
        self.imported[dataset_id] = mapping
        assert len(mapping) == len(rows)
        ids = {r["case_id"]: r["__rowId__"] for r in mapping}
        assert set(ids) == {r["case_id"] for r in rows}
        context = dict(datasetId=dataset_id, expectedDataRevision=meta["dataRevision"],
                       expectedSchemaRevision=cb["schemaRevision"], scope="all",
                       weightMode="dataset", missingPolicy="exclude")
        return context, ids

    def run(self, context, ids, fit_ids=None, *, inference="rao_scott", missing="exclude", weight_mode="dataset"):
        context = dict(context, missingPolicy=missing, weightMode=weight_mode)
        if fit_ids is not None:
            context.update(scope="selected", selectedRowIds=[ids[x] for x in fit_ids])
        request = dict(context=context, rowVariableId="row", colVariableId="col", includeRowIds=True,
                       maxRowIdsPerCell=10000, inference=inference)
        response = self.request("POST", "/api/v1/summaries/crosstab", json=request)
        return response, context

    def exact_ids(self, body, context, expected):
        found = []
        for cell in body["cells"]:
            key = cell["rowCategoryId"], cell["colCategoryId"]
            response = self.request("POST", "/api/v1/summaries/crosstab/cell-row-ids", json=dict(
                context=context, rowVariableId="row", colVariableId="col",
                rowCategoryId=key[0], colCategoryId=key[1]))
            assert response.status_code == 200, response.text
            full = response.json()
            assert sorted(cell["rowIds"]) == sorted(full["rowIds"]) == sorted(expected.get(key, []))
            assert cell["rowIdCount"] == full["rowIdCount"] == cell["unweightedCount"] == len(expected.get(key, []))
            assert cell["rowIdsTruncated"] is False
            found.extend(cell["rowIds"])
        assert len(found) == len(set(found)) == sum(map(len, expected.values()))
        assert set(found) == {i for ids in expected.values() for i in ids}


@pytest.fixture
def harness(tmp_path, monkeypatch, request):
    import app.api.datasets as datasets_api
    import app.api.multi_response as multi_response_api
    import app.api.summaries as summaries_api
    store = DatasetStore(tmp_path)
    for module in (datasets_api, multi_response_api, summaries_api):
        monkeypatch.setattr(module, "store", store)
    evidence = None
    if os.environ.get("DAVIS_DOMAIN_EVIDENCE"):
        evidence = Path(os.environ["DAVIS_DOMAIN_EVIDENCE"]) / re.sub(r"[^A-Za-z0-9_.-]", "_", request.node.name)
        evidence.mkdir(parents=True, exist_ok=False)
    with TestClient(app) as client:
        yield Harness(client, evidence)


def assert_oracle(body, expected):
    assert body["inference"]["status"] == "ok", body["inference"]
    actual = body["inference"]
    assert actual["statistic"] == pytest.approx(expected["F"], rel=1e-10, abs=1e-12)
    for field in ("numeratorDf", "denominatorDf", "pValue"):
        assert actual[field] == pytest.approx(expected[field], rel=1e-10, abs=1e-12)
    assert body["weightDiagnostics"]["designDf"] == expected["designDf"]


def expected_ids(rows, ids, fit_ids):
    result = {}
    for r in rows:
        if r["case_id"] in fit_ids:
            result.setdefault((r["row"], r["col"]), []).append(ids[r["case_id"]])
    return result


@pytest.mark.parametrize("fpc", [False, True])
@pytest.mark.parametrize("selected", [False, True])
def test_d01_original_frame_with_domain_df_and_complete_ids(harness, fpc, selected):
    rows = fixture_rows()
    fit = [r["case_id"] for r in rows if not selected or r["psu"] != "P3"]
    context, ids = harness.create(rows, fpc=fpc)
    response, used_context = harness.run(context, ids, fit if selected else None)
    assert response.status_code == 200, response.text
    body = response.json()
    # Membership and diagnostics are checked before the intended old-source
    # red assertion, so a numerical failure cannot conceal ID/count leakage.
    harness.exact_ids(body, used_context, expected_ids(rows, ids, fit))
    assert body["meta"]["scopeCount"] == body["effectiveN"] == len(fit)
    assert body["missingCount"] == body["invalidCount"] == 0
    assert body["weightDiagnostics"]["numberOfPSUs"] == (2 if selected else 3)
    assert body["weightDiagnostics"]["numberOfStrata"] == 1
    assert body["weightDiagnostics"]["positiveWeightN"] == len(fit)
    assert body["weightDiagnostics"]["weightSum"] == len(fit)
    assert body["analysisProvenance"]["weightSum"] == len(fit)
    assert body["meta"]["dataRevision"] == context["expectedDataRevision"]
    assert body["meta"]["schemaRevision"] == context["expectedSchemaRevision"]
    assert_oracle(body, independent_oracle(rows, set(fit), fpc=fpc))


def test_d02_domain_id_order_does_not_change_mapping(harness):
    rows = fixture_rows()
    fit = [r["case_id"] for r in rows[:8]]
    context, ids = harness.create(rows)
    first, _ = harness.run(context, ids, fit)
    second, _ = harness.run(context, ids, list(reversed(fit)))
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert_oracle(second.json(), independent_oracle(rows, set(fit)))


@pytest.mark.parametrize("outside_outcome", ["outside-category", None, "999"])
def test_d03_outside_outcomes_do_not_leak(harness, outside_outcome):
    rows = fixture_rows()
    for r in rows[8:]:
        r["row"] = outside_outcome
    context, ids = harness.create(rows, edits={"row": {"missingCodes": ["999"]}})
    fit = [r["case_id"] for r in rows[:8]]
    response, ctx = harness.run(context, ids, fit)
    assert response.status_code == 200, response.text
    body = response.json()
    assert [c["id"] for c in body["rowCategories"]] == ["a", "b"]
    assert body["missingCount"] == body["invalidCount"] == 0
    harness.exact_ids(body, ctx, expected_ids(rows, ids, fit))
    assert_oracle(body, independent_oracle(rows, set(fit)))


@pytest.mark.parametrize("excluded_weight", [0, None, 999])
@pytest.mark.parametrize("missing_design", [False, True])
def test_d04_d07_original_zero_and_missing_weights_are_excluded(harness, excluded_weight, missing_design):
    rows = fixture_rows()
    for r in rows[8:]:
        r["w"] = excluded_weight
        if missing_design:
            r["psu"] = r["fpc"] = None
    context, ids = harness.create(rows, fpc=True, edits={"w": {"missingCodes": ["999"]}})
    oracle_rows = copy.deepcopy(rows)
    for r in oracle_rows[8:]:
        if excluded_weight == 999:
            r["w"] = None
    fit = {r["case_id"] for r in rows}
    response, ctx = harness.run(context, ids)
    assert response.status_code == 200, response.text
    body = response.json()
    harness.exact_ids(body, ctx, expected_ids(rows, ids, fit))
    assert body["effectiveN"] == 12
    assert body["weightDiagnostics"]["positiveWeightN"] == 8
    assert body["weightDiagnostics"]["weightMissingCount"] == (0 if excluded_weight == 0 else 4)
    assert body["weightDiagnostics"]["weightZeroCount"] == (4 if excluded_weight == 0 else 0)
    assert_oracle(body, independent_oracle(oracle_rows, fit, fpc=True))


@pytest.mark.parametrize("invalid", [-1, float("inf"), pytest.param(float("nan"), id="stored-float-nan"),
                                     "not-a-number", pytest.param(True, id="serialized-True-text")])
def test_d05_in_scope_invalid_weights_keep_422(harness, invalid):
    rows = fixture_rows()
    rows[0]["w"] = invalid
    context, ids = harness.create(rows)
    stored = harness.imported[context["datasetId"]][0]["w"]
    if invalid is True:
        # Mixed CSV weights serialize True as text; this is a non-convertible
        # text control, not proof of the physical Boolean validation branch.
        assert isinstance(stored, str) and stored == "True"
    elif invalid == "not-a-number":
        assert stored == invalid and isinstance(stored, str)
    elif invalid == -1:
        assert stored == -1 and isinstance(stored, (int, float))
    elif isinstance(invalid, float) and math.isnan(invalid):
        # The real Polars CSV route retains this as physical Float64 NaN.
        # Assert that observed storage before asking the weight validator.
        assert isinstance(stored, float) and math.isnan(stored)
    else:
        assert isinstance(stored, float) and math.isinf(stored)
    response, _ = harness.run(context, ids)
    assert response.status_code == 422, response.text
    assert response.json()["error"]["code"] == "WEIGHT_VALUE_INVALID"


@pytest.mark.parametrize("inference", ["rao_scott", "auto", "none"])
def test_d06_outside_invalid_weight_controls_only_requested_inference(harness, inference):
    rows = fixture_rows()
    rows[8]["w"] = -1
    context, ids = harness.create(rows)
    fit = [r["case_id"] for r in rows[:8]]
    response, ctx = harness.run(context, ids, fit, inference=inference)
    assert response.status_code == 200, response.text
    body = response.json()
    harness.exact_ids(body, ctx, expected_ids(rows, ids, fit))
    assert body["grandTotal"]["count"] == 8
    if inference == "rao_scott":
        assert body["inference"]["status"] == "unavailable"
        warning = next(w for w in body["warnings"] if w["code"] == "SURVEY_DOMAIN_DESIGN_INCOMPLETE")
        assert warning["details"]["reason"] == "invalid_sampling_weight"
        assert body["inference"]["statistic"] is body["inference"]["pValue"] is None
    else:
        assert body["inference"]["status"] == "not_requested"
        assert all(w["code"] != "SURVEY_DOMAIN_DESIGN_INCOMPLETE" for w in body["warnings"])


def test_d07_reason_only_weight_key_is_not_a_missing_code(harness):
    rows = fixture_rows()
    for r in rows[8:]:
        r["w"] = 999
    context, ids = harness.create(rows, edits={"w": {"missingReasons": {"999": "item_nonresponse"}}})
    fit = [r["case_id"] for r in rows[:8]]
    response, _ = harness.run(context, ids, fit)
    assert response.status_code == 200, response.text
    assert_oracle(response.json(), independent_oracle(rows, set(fit)))


@pytest.mark.parametrize("field,value", [("psu", None), ("stratum", None), ("fpc", None),
                                         ("fpc", "bad"), ("fpc", 7), ("fpc", 2)])
@pytest.mark.parametrize("inference", ["rao_scott", "auto"])
def test_d08_d09_new_original_design_failures_preserve_table(harness, field, value, inference):
    rows = fixture_rows()
    if field == "fpc" and value == 2:
        # Valid for the reduced domain (m=2), invalid for original m=3.
        for r in rows:
            r["fpc"] = 2
    else:
        rows[8][field] = value
    context, ids = harness.create(rows, fpc=True)
    fit = [r["case_id"] for r in rows[:8]]
    response, ctx = harness.run(context, ids, fit, inference=inference)
    assert response.status_code == 200, response.text
    body = response.json()
    harness.exact_ids(body, ctx, expected_ids(rows, ids, fit))
    assert body["inference"]["status"] == ("unavailable" if inference == "rao_scott" else "not_requested")
    if inference == "rao_scott":
        assert any(w["code"] == "SURVEY_DOMAIN_DESIGN_INCOMPLETE" for w in body["warnings"])


def test_d08_design_missing_codes_do_not_gain_new_semantics(harness):
    rows = fixture_rows()
    context, ids = harness.create(rows, edits={"psu": {"missingCodes": ["P3"]}})
    fit = [r["case_id"] for r in rows[:8]]
    response, _ = harness.run(context, ids, fit)
    assert response.status_code == 200, response.text
    assert_oracle(response.json(), independent_oracle(rows, set(fit)))


@pytest.mark.parametrize("value", [None, "bad"])
@pytest.mark.parametrize("inference", ["rao_scott", "auto", "none"])
def test_d09b_in_scope_declared_fpc_parse_failure_preserves_all_scope_table(harness, value, inference):
    rows = fixture_rows()
    rows[0]["fpc"] = value
    context, ids = harness.create(rows, fpc=True)
    stored = harness.imported[context["datasetId"]][0]["fpc"]
    if value is None:
        assert stored is None
    else:
        assert isinstance(stored, str) and stored == "bad"
    response, ctx = harness.run(context, ids, inference=inference)
    assert response.status_code == 200, response.text
    body = response.json()
    fit = {r["case_id"] for r in rows}
    expected = expected_ids(rows, ids, fit)
    harness.exact_ids(body, ctx, expected)
    for cell in body["cells"]:
        assert cell["count"] == len(expected[(cell["rowCategoryId"], cell["colCategoryId"])])
    assert body["grandTotal"] == {"count": 12., "unweightedCount": 12}
    assert body["meta"]["scopeCount"] == body["effectiveN"] == 12
    assert body["missingCount"] == body["invalidCount"] == 0
    assert body["meta"]["dataRevision"] == context["expectedDataRevision"]
    assert body["meta"]["schemaRevision"] == context["expectedSchemaRevision"]
    if inference == "rao_scott":
        assert body["inference"]["status"] == "unavailable"
        warning = next(w for w in body["warnings"] if w["code"] == "SURVEY_DOMAIN_DESIGN_INCOMPLETE")
        assert warning["details"]["reason"] == "invalid_fpc"
        assert all(body["inference"][field] is None for field in ("statistic", "numeratorDf", "denominatorDf", "pValue"))
    else:
        assert body["inference"]["status"] == "not_requested"
        assert all(w["code"] != "SURVEY_DOMAIN_DESIGN_INCOMPLETE" for w in body["warnings"])


def test_d08_existing_in_scope_design_error_remains_422(harness):
    rows = fixture_rows()
    rows[0]["psu"] = None
    context, ids = harness.create(rows)
    response, _ = harness.run(context, ids)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SURVEY_DESIGN_MISSING"


@pytest.mark.parametrize("invalid", [False, True])
@pytest.mark.parametrize("fpc", [False, True])
def test_d10_excluded_positive_outcome_units_retain_original_design(harness, invalid, fpc):
    rows = fixture_rows()
    for r in rows[8:]:
        r["row"] = "outside" if invalid else None
    context, ids = harness.create(rows, fpc=fpc)
    response, ctx = harness.run(context, ids)
    assert response.status_code == 200, response.text
    body = response.json()
    fit = {r["case_id"] for r in rows[:8]}
    assert body["scopeCount"] == 12 and body["effectiveN"] == 8
    assert body["missingCount"] == (0 if invalid else 4)
    assert body["invalidCount"] == (4 if invalid else 0)
    harness.exact_ids(body, ctx, expected_ids(rows, ids, fit))
    assert_oracle(body, independent_oracle(rows, fit, fpc=fpc))


@pytest.mark.parametrize("policy,reason,label", [
    ("include_missing", "item_nonresponse", "__missing__"),
    ("separate_not_applicable", "not_applicable", "__not_applicable__"),
])
def test_d11_admitted_missing_outcomes_are_domain_members(harness, policy, reason, label):
    rows = fixture_rows()
    # Mix admitted missing cells through both retained PSUs; avoid a domain
    # lonely-PSU issue or a zero-marginal pseudo-category.
    rows[0]["row"] = rows[4]["row"] = "999"
    context, ids = harness.create(rows, edits={"row": {
        "missingCodes": ["999"], "missingReasons": {"999": reason}}})
    fit = [r["case_id"] for r in rows[:8]]
    response, ctx = harness.run(context, ids, fit, missing=policy)
    assert response.status_code == 200, response.text
    normalized = copy.deepcopy(rows)
    for r in normalized:
        if r["row"] == "999":
            r["row"] = label
    body = response.json()
    assert body["effectiveN"] == 8 and body["missingCount"] == 0
    harness.exact_ids(body, ctx, expected_ids(normalized, ids, fit))
    assert label in [c["id"] for c in body["rowCategories"]]
    assert_oracle(body, independent_oracle(normalized, set(fit)))


@pytest.mark.parametrize("factor", [1, 10, Q(1, 2)])
def test_d12_unequal_weights_use_domain_denominator_and_scale_invariance(harness, factor):
    rows = fixture_rows()
    for i, r in enumerate(rows):
        r["w"] = float(factor*(1+i%4))
    context, ids = harness.create(rows, fpc=True)
    fit = [r["case_id"] for r in rows[:8]]
    response, _ = harness.run(context, ids, fit)
    assert response.status_code == 200, response.text
    assert_oracle(response.json(), independent_oracle(rows, set(fit), fpc=True))


@pytest.mark.parametrize("strata,fpc", [(False, False), (True, False), (True, True)])
def test_d13_implicit_psus_match_explicit_row_psus(harness, strata, fpc):
    rows = fixture_rows()
    for r in rows:
        r["psu"] = r["case_id"]
        r["fpc"] = 24
    fit = [r["case_id"] for r in rows[:8]]
    answers = []
    for explicit in (False, True):
        context, ids = harness.create(rows, psu=explicit, strata=strata, fpc=fpc)
        response, _ = harness.run(context, ids, fit)
        assert response.status_code == 200, response.text
        body = response.json()
        assert_oracle(body, independent_oracle(rows, set(fit), psu=explicit, strata=strata, fpc=fpc))
        assert body["inference"]["approximate"] is (not explicit)
        answers.append(body["inference"])
    for field in ("statistic", "numeratorDf", "denominatorDf", "pValue"):
        assert answers[0][field] == pytest.approx(answers[1][field])


def test_d13_fpc_without_any_design_variable_remains_unsupported(harness):
    context, ids = harness.create(psu=False, strata=False, fpc=True)
    response, _ = harness.run(context, ids)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SURVEY_DESIGN_UNSUPPORTED"


def test_d14_nested_psus_and_outside_only_singleton_stratum(harness):
    rows = []
    for stratum in ("S1", "S2"):
        for r in fixture_rows():
            r.update(case_id=stratum+"_"+r["case_id"], stratum=stratum)
            rows.append(r)
    rows.append(dict(case_id="outside", row="a", col="x", w=1, stratum="S3", psu="P1", fpc=6))
    fit = [r["case_id"] for r in rows if r["stratum"] != "S3" and r["psu"] != "P3"]
    context, ids = harness.create(rows, fpc=True)
    response, _ = harness.run(context, ids, fit)
    assert response.status_code == 200, response.text
    assert response.json()["weightDiagnostics"]["numberOfPSUs"] == 4
    assert_oracle(response.json(), independent_oracle(rows, set(fit), fpc=True))


def test_d14_domain_lonely_psu_remains_unavailable(harness):
    rows = fixture_rows()
    context, ids = harness.create(rows)
    response, _ = harness.run(context, ids, [r["case_id"] for r in rows[:4]])
    assert response.status_code == 200, response.text
    assert response.json()["inference"]["status"] == "unavailable"
    assert any(w["code"] == "SURVEY_LONELY_PSU" for w in response.json()["warnings"])


@pytest.mark.parametrize("fpc", [False, True])
def test_d15_larger_table_satterthwaite_df_uses_correct_covariance(harness, fpc):
    rows = []
    # S1 retains2/3 PSUs, S2 retains3/3. Their non-collinear interaction
    # covariances receive different correction factors, changing Delta's
    # shape as well as scale. A one-stratum fixture could not test this.
    vectors = [[4,1,0,0,1,2], [1,2,1,2,1,1], [1,1,1,1,1,1],
               [0,1,3,3,0,1], [2,0,1,1,3,1], [3,1,2,1,2,3]]
    cells = [(r,c) for r in ("a", "b") for c in ("x", "y", "z")]
    for g, vector in enumerate(vectors):
        for (r,c), count in zip(cells, vector):
            for _ in range(count):
                rows.append(dict(case_id=f"r{len(rows):03}", row=r, col=c, w=1,
                                 stratum="S1" if g < 3 else "S2", psu=f"P{g}", fpc=10))
    fit = [r["case_id"] for r in rows if r["psu"] != "P2"]
    expected = independent_oracle(rows, set(fit), fpc=fpc)
    reduced = independent_oracle([r for r in rows if r["case_id"] in fit], set(fit), fpc=fpc)
    assert 1 < expected["numeratorDf"] < 2
    assert expected["numeratorDf"] != pytest.approx(reduced["numeratorDf"], rel=1e-8)
    assert expected["designDf"] == reduced["designDf"] == 3
    context, ids = harness.create(rows, fpc=fpc, edits={"col": {"categoryOrder": ["x", "y", "z"]}})
    response, _ = harness.run(context, ids, fit)
    assert response.status_code == 200, response.text
    assert_oracle(response.json(), expected)


@pytest.mark.parametrize("weight_type,mode", [("frequency", "dataset"), ("survey", "none")])
def test_d16_non_survey_inference_ignores_outside_design(harness, weight_type, mode):
    rows = fixture_rows()
    rows[8]["psu"] = rows[8]["fpc"] = None
    context, ids = harness.create(rows, fpc=True, weight_type=weight_type)
    fit = [r["case_id"] for r in rows[:8]]
    response, ctx = harness.run(context, ids, fit, inference="auto", weight_mode=mode)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["inference"]["method"] == "pearson"
    assert body["inference"]["statistic"] == pytest.approx(2)
    harness.exact_ids(body, ctx, expected_ids(rows, ids, fit))
