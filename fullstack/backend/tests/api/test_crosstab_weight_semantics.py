"""WEIGHT-04/B04 acceptance tests T01-T11 (spec §23).

The bug these pin down: multiplying every survey weight by 100 used to multiply
the Pearson χ² by 100, so the p-value moved and "significant" became a function
of an arbitrary scale. The fix is not a better approximation — it is refusing to
feed an arbitrary-scale weight to a statistic that assumes counts, and using the
Rao–Scott second-order test (with the sampling design) when a real answer is
asked for.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.storage.dataset_store import DatasetStore

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "apiclus1_weight_design.csv"

# One weight per cell so the weighted and unweighted tables genuinely differ.
CELL_WEIGHTS = {("a", "x"): 1.0, ("a", "y"): 2.0, ("a", "z"): 0.5,
                ("b", "x"): 3.0, ("b", "y"): 0.25, ("b", "z"): 1.5}
# The same pattern as counts, for the frequency-weight cases.
CELL_FREQUENCIES = {cell: int(weight * 4) for cell, weight in CELL_WEIGHTS.items()}
GRID = {("a", "x"): 40, ("a", "y"): 30, ("a", "z"): 20,
        ("b", "x"): 15, ("b", "y"): 35, ("b", "z"): 60}


def _csv(weights: dict[tuple[str, str], float], factor: float = 1.0) -> str:
    lines = ["row,col,w,stratum,psu"]
    for (row, col), count in GRID.items():
        weight = weights[(row, col)] * factor
        for index in range(count):
            lines.append(f"{row},{col},{weight},s-{row},{row}-{index % 3}")
    return "\n".join(lines) + "\n"


class Harness:
    """Thin wrapper so each test reads as the decision it is testing."""

    def __init__(self, client: TestClient):
        self.client = client
        self.created: list[str] = []

    def import_dataset(self, weights, factor: float = 1.0, name: str = "w.csv") -> str:
        dataset_id = self.client.post(
            "/api/v1/datasets/import",
            files={"file": (name, _csv(weights, factor), "text/csv")}).json()["datasetId"]
        self.created.append(dataset_id)
        # The weight and design roles are codebook knowledge, not file content.
        fresh = self.client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: dict(c) for c in fresh["columns"]}
        by_name["row"].update(role="question", scaleType="nominal", categoryOrder=["a", "b"])
        by_name["col"].update(role="question", scaleType="nominal", categoryOrder=["x", "y", "z"])
        by_name["w"].update(role="weight", scaleType="ratio")
        self.client.put(f"/api/v1/datasets/{dataset_id}/codebook",
                        json={"columns": list(by_name.values())})
        return dataset_id

    def declare(self, dataset_id: str, weight_type: str | None,
                design: bool = True, missing_codes: list[str] | None = None,
                row_category_order: list[str] | None = None) -> dict:
        fresh = self.client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        by_name = {c["name"]: dict(c) for c in fresh["columns"]}
        by_name["row"].update(role="question", scaleType="nominal",
                              categoryOrder=row_category_order or ["a", "b"])
        by_name["col"].update(role="question", scaleType="nominal", categoryOrder=["x", "y", "z"])
        by_name["w"].update(role="weight", scaleType="ratio",
                            **({"missingCodes": missing_codes} if missing_codes else {}))
        payload: dict = {"columns": list(by_name.values())}
        if weight_type is not None:
            payload["weightConfig"] = {"weightColumnId": by_name["w"]["columnId"],
                                       "weightType": weight_type}
        if design:
            payload["surveyDesign"] = {"weightColumnId": by_name["w"]["columnId"],
                                       "strataColumnId": by_name["stratum"]["columnId"],
                                       "psuColumnId": by_name["psu"]["columnId"]}
        res = self.client.put(f"/api/v1/datasets/{dataset_id}/codebook", json=payload)
        assert res.status_code == 200, res.json()
        return self.context(dataset_id)

    def context(self, dataset_id: str) -> dict:
        meta = self.client.get(f"/api/v1/datasets/{dataset_id}").json()
        cb = self.client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
        return {"datasetId": dataset_id, "expectedDataRevision": meta["dataRevision"],
                "expectedSchemaRevision": cb.get("schemaRevision", 1),
                "scope": "all", "missingPolicy": "exclude"}


@pytest.fixture
def harness(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    import app.api.datasets as datasets_api
    import app.api.multi_response as multi_response_api
    import app.api.summaries as summaries_api

    monkeypatch.setattr(datasets_api, "store", store)
    monkeypatch.setattr(multi_response_api, "store", store)
    monkeypatch.setattr(summaries_api, "store", store)
    with TestClient(app) as client:
        env = Harness(client)
        yield env
        for dataset_id in env.created:
            client.delete(f"/api/v1/datasets/{dataset_id}")


def _run(harness: Harness, context: dict, weight_column: str = "w", **overrides):
    body = {"context": dict(context, **({"weightColumn": weight_column} if weight_column else {})),
            "rowVariableId": "row", "colVariableId": "col",
            "includeRowIds": False, "maxRowIdsPerCell": 10, "inference": "auto"}
    body.update(overrides)
    return harness.client.post("/api/v1/summaries/crosstab", json=body)


def _snapshot(body: dict) -> dict:
    """Everything T01 says must not move when the weights are rescaled."""
    diagnostics = body["weightDiagnostics"]
    return {
        "statistic": body["inference"]["statistic"],
        "numeratorDf": body["inference"]["numeratorDf"],
        "denominatorDf": body["inference"]["denominatorDf"],
        "pValue": body["inference"]["pValue"],
        "weightedCramersV": body["descriptiveAssociation"]["weightedCramersV"],
        "kishEffectiveN": diagnostics["kishEffectiveN"],
        "weightingDeff": diagnostics["weightingDeff"],
        "weightCv": diagnostics["weightCv"],
        # Weighted *counts* are allowed to scale — only their ratios may not.
        "rowPct": [c["rowPct"] for c in body["cells"]],
        "colPct": [c["colPct"] for c in body["cells"]],
        "totalPct": [c["totalPct"] for c in body["cells"]],
    }


@pytest.mark.parametrize("factor", [1.0, 10.0, 100.0, 0.5])
def test_t01_t10_survey_inference_is_scale_invariant(harness, factor):
    """T01/T10: w, 10w, 100w, w/2 give one answer; only weightSum moves."""
    reference_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "base.csv")
    reference_context = harness.declare(reference_id, "survey")
    reference = _run(harness, reference_context, inference="rao_scott").json()
    assert reference["inference"]["status"] == "ok", reference["inference"]
    base = _snapshot(reference)

    scaled_id = harness.import_dataset(CELL_WEIGHTS, factor, f"s{factor}.csv")
    scaled_context = harness.declare(scaled_id, "survey")
    scaled = _run(harness, scaled_context, inference="rao_scott").json()
    assert scaled["inference"]["status"] == "ok", scaled["inference"]

    observed = _snapshot(scaled)
    for key, value in base.items():
        assert observed[key] == pytest.approx(value, rel=1e-9), key
    assert scaled["weightDiagnostics"]["weightSum"] == pytest.approx(
        reference["weightDiagnostics"]["weightSum"] * factor, rel=1e-9)


def test_t02_frequency_scale_moves_the_p_value(harness):
    """A frequency weight is a count, so scaling it *must* move the p-value."""
    dataset_id = harness.import_dataset(CELL_FREQUENCIES, 1.0, "freq.csv")
    context = harness.declare(dataset_id, "frequency")
    base = _run(harness, context, inference="pearson").json()
    assert base["inference"]["status"] == "ok", base["inference"]

    dataset_id, context = harness.import_dataset(CELL_FREQUENCIES, 100.0, "freq100.csv"), None
    context = harness.declare(dataset_id, "frequency")
    scaled = _run(harness, context, inference="pearson").json()
    assert scaled["inference"]["status"] == "ok", scaled["inference"]

    assert scaled["inference"]["statistic"] == pytest.approx(
        base["inference"]["statistic"] * 100.0, rel=1e-6)
    assert scaled["inference"]["pValue"] < base["inference"]["pValue"]
    # The descriptive V is scale free even for a frequency weight, because the
    # weight sum in its denominator scales with the statistic.
    assert scaled["descriptiveAssociation"]["weightedCramersV"] == pytest.approx(
        base["descriptiveAssociation"]["weightedCramersV"], rel=1e-9)


def test_t02b_frequency_rejects_fractional_counts(harness):
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "frac.csv")
    context = harness.declare(dataset_id, "frequency")
    res = _run(harness, context, inference="pearson")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "WEIGHT_FREQUENCY_NONINTEGER"


def test_t03_survey_defaults_to_no_inference(harness):
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t03.csv")
    context = harness.declare(dataset_id, "survey")
    body = _run(harness, context, inference="auto").json()
    assert body["inference"]["requested"] is False
    assert body["inference"]["status"] == "not_requested"
    assert body["inference"]["method"] is None
    assert body["inference"]["pValue"] is None
    # Descriptive quantities stay available — that is the point of the default.
    assert body["descriptiveAssociation"]["weightedCramersV"] is not None
    assert body["weightDiagnostics"]["kishEffectiveN"] is not None


def test_t04_survey_with_pearson_is_rejected(harness):
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t04.csv")
    context = harness.declare(dataset_id, "survey")
    res = _run(harness, context, inference="pearson")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "SURVEY_PEARSON_UNSUPPORTED"


def test_t04b_frequency_with_rao_scott_is_rejected(harness):
    dataset_id = harness.import_dataset(CELL_FREQUENCIES, 1.0, "t04b.csv")
    context = harness.declare(dataset_id, "frequency")
    res = _run(harness, context, inference="rao_scott")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "SURVEY_INFERENCE_UNAVAILABLE"


def test_t04c_undeclared_weight_type_is_refused(harness):
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t04c.csv")
    context = harness.declare(dataset_id, None, design=False)
    res = _run(harness, context, inference="pearson")
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "WEIGHT_TYPE_REQUIRED"


def test_t05_rao_scott_runs_only_when_asked(harness):
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t05.csv")
    context = harness.declare(dataset_id, "survey")
    body = _run(harness, context, inference="rao_scott").json()
    assert body["inference"]["status"] == "ok"
    assert body["inference"]["method"] == "rao_scott_second_order"
    assert body["inference"]["statisticType"] == "F"
    assert body["inference"]["pValue"] is not None
    assert body["inference"]["designAssumption"] == "provided"
    assert body["inference"]["approximate"] is False
    assert body["weightDiagnostics"]["designDf"] == 4.0
    assert body["analysisProvenance"]["inferenceMethod"] == "rao_scott_second_order"


def test_t05b_weights_only_design_is_flagged_as_an_approximation(harness):
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t05b.csv")
    context = harness.declare(dataset_id, "survey", design=False)
    body = _run(harness, context, inference="rao_scott").json()
    assert body["inference"]["status"] == "ok"
    assert body["inference"]["designAssumption"] == "independent_rows"
    assert body["inference"]["approximate"] is True
    assert any(w["code"] == "SURVEY_INFERENCE_WEIGHTS_ONLY" for w in body["warnings"])


def test_t06_golden_parity_with_r_survey_end_to_end(harness):
    """R's documented apiclus1 example, driven through the real API."""
    client = harness.client
    dataset_id = client.post(
        "/api/v1/datasets/import",
        files={"file": ("apiclus1.csv", FIXTURE.read_text(encoding="utf-8"),
                        "text/csv")}).json()["datasetId"]
    harness.created.append(dataset_id)
    cb = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
    by_name = {c["name"]: dict(c) for c in cb["columns"]}
    by_name["sch.wide"].update(role="question", scaleType="nominal",
                               categoryOrder=["No", "Yes"])
    by_name["stype"].update(role="question", scaleType="nominal",
                            categoryOrder=["E", "H", "M"])
    by_name["pw"].update(role="weight", scaleType="ratio")
    res = client.put(f"/api/v1/datasets/{dataset_id}/codebook", json={
        "columns": list(by_name.values()),
        "weightConfig": {"weightColumnId": by_name["pw"]["columnId"],
                         "weightType": "survey"},
        "surveyDesign": {"weightColumnId": by_name["pw"]["columnId"],
                         "psuColumnId": by_name["dnum"]["columnId"],
                         "fpcColumnId": by_name["fpc"]["columnId"]},
    })
    assert res.status_code == 200, res.json()
    context = harness.context(dataset_id)
    res = _run(harness, context, weight_column="pw", inference="rao_scott",
               rowVariableId="sch.wide", colVariableId="stype")
    assert res.status_code == 200, res.json()
    body = res.json()
    assert body["inference"]["status"] == "ok", body["inference"]
    # R: svychisq(~sch.wide+stype, dclus1)  ->  F = 5.1934, ndf = 1.4946,
    #                                          ddf = 20.9250, p = 0.02175
    assert body["inference"]["statistic"] == pytest.approx(5.1934, abs=5e-5)
    assert body["inference"]["numeratorDf"] == pytest.approx(1.4946, abs=5e-5)
    assert body["inference"]["denominatorDf"] == pytest.approx(20.9250, abs=5e-5)
    assert body["inference"]["pValue"] == pytest.approx(0.02175, abs=5e-6)
    # R: svytable(~sch.wide+stype, dclus1)
    by_key = {(c["rowCategoryId"], c["colCategoryId"]): c["count"] for c in body["cells"]}
    assert by_key[("No", "E")] == pytest.approx(406.1640, abs=5e-5)
    assert by_key[("Yes", "M")] == pytest.approx(575.3989, abs=5e-5)


def test_t07_unobserved_categories_do_not_move_the_answer(harness):
    """A codebook category nobody chose must not change any statistic."""
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t07.csv")
    base_context = harness.declare(dataset_id, "survey")
    base_rs = _run(harness, base_context, inference="rao_scott").json()
    base_pearson = _run(harness, base_context, inference="none").json()

    padded_context = harness.declare(dataset_id, "survey",
                                     row_category_order=["a", "b", "c-unused"])
    padded_rs = _run(harness, padded_context, inference="rao_scott").json()
    padded_pearson = _run(harness, padded_context, inference="none").json()

    assert padded_rs["inference"]["statistic"] == pytest.approx(
        base_rs["inference"]["statistic"], rel=1e-12)
    assert padded_rs["inference"]["pValue"] == pytest.approx(
        base_rs["inference"]["pValue"], rel=1e-12)
    assert padded_pearson["descriptiveAssociation"]["pearsonChi2"] == pytest.approx(
        base_pearson["descriptiveAssociation"]["pearsonChi2"], rel=1e-12)
    # The empty category is still shown; it just does not enter the test.
    assert any(c["rowCategoryId"] == "c-unused" for c in padded_rs["cells"])


def test_t08_semantic_missing_weight_is_not_a_weight(harness):
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t08.csv")
    context = harness.declare(dataset_id, "survey", missing_codes=["3"])
    body = _run(harness, context, inference="none").json()
    # 3.0 was the b/x weight; 15 rows carry it and must count as missing weights,
    # not as 15 rows worth 3 each.
    assert body["weightDiagnostics"]["weightMissingCount"] == 15
    assert body["weightDiagnostics"]["weightSum"] == pytest.approx(
        sum(CELL_WEIGHTS[k] * v for k, v in GRID.items() if CELL_WEIGHTS[k] != 3.0))
    by_key = {(c["rowCategoryId"], c["colCategoryId"]): c for c in body["cells"]}
    assert by_key[("b", "x")]["count"] == 0.0
    assert by_key[("b", "x")]["unweightedCount"] == 15


def test_t09_survey_cells_carry_no_significance(harness):
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t09.csv")
    context = harness.declare(dataset_id, "survey")
    body = _run(harness, context, inference="rao_scott").json()
    assert body["cells"]
    assert all(cell["significance"] is None for cell in body["cells"])
    assert all(cell["residualType"] == "descriptive" for cell in body["cells"])
    assert all(cell["residual"] is not None for cell in body["cells"])
    # The <5 expected-count rule belongs to ordinary Pearson, not to Rao–Scott.
    assert not any(w["code"] == "EXPECTED_COUNT_LT5" for w in body["warnings"])


def test_t09b_frequency_cells_keep_significance(harness):
    """Only a survey weight suspends the cell markers; a frequency weight is counts."""
    dataset_id = harness.import_dataset(CELL_FREQUENCIES, 1.0, "t09b.csv")
    context = harness.declare(dataset_id, "frequency")
    body = _run(harness, context, inference="pearson").json()
    assert all(cell["residualType"] == "adjusted" for cell in body["cells"])
    assert any(cell["significance"] for cell in body["cells"])


def test_t11_design_change_bumps_the_revision(harness):
    """Changing strata/PSU must not be able to reuse the previous p-value."""
    dataset_id = harness.import_dataset(CELL_WEIGHTS, 1.0, "t11.csv")
    first_context = harness.declare(dataset_id, "survey", design=False)
    first = _run(harness, first_context, inference="rao_scott").json()
    assert first["inference"]["status"] == "ok"
    assert first["weightDiagnostics"]["numberOfStrata"] == 1

    changed = harness.declare(dataset_id, "survey")
    assert changed["expectedSchemaRevision"] > first_context["expectedSchemaRevision"]
    # A cache keyed on the revision cannot serve the old answer: the request is
    # rejected as stale before it reaches the algorithm.
    stale = _run(harness, first_context, inference="rao_scott")
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"

    second = _run(harness, changed, inference="rao_scott").json()
    assert second["weightDiagnostics"]["numberOfStrata"] == 2
    assert second["weightDiagnostics"]["designDf"] == 4.0
    assert second["inference"]["statistic"] != first["inference"]["statistic"]
