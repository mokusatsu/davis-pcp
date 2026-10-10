"""Saved nominal KDA: public API, real stored rows/codebooks, independent oracles."""
from __future__ import annotations

from copy import deepcopy
import json

import numpy as np
import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import models
from app.domain.codebook_adapter import CodebookAdapter
from app.main import app
from app.storage.dataset_store import DatasetStore


Y = [1., 3., 4., 6., 2., 4.]
X = [0., 1., 1., 2., 0., 1.]
ROUND_ABS = 5.1e-5


@pytest.fixture
def survey(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(models, "store", store)
    with TestClient(app) as client:
        yield store, client


def save_survey(store, data, overrides=None):
    frame = pl.DataFrame({"__rowId__": [f"r{i}" for i in range(len(data["y"]))], **data})
    columns = [{"columnId": f"column-{name}", "name": name, "label": f"Saved {name}",
                "scaleType": "nominal" if name == "g" else "ratio",
                "role": "question" if name == "y" else "attribute",
                "missingCodes": [], "categoryOrder": [], "valueLabels": {}, "isReversed": False,
                **(overrides or {}).get(name, {})} for name in data]
    codebook = {"datasetId": "nominal", "schemaRevision": 3, "columns": columns, "multiResponseGroups": []}
    schema = [{"name": name, "physicalType": "string" if frame[name].dtype == pl.String else "float",
               "semanticType": "categorical" if frame[name].dtype == pl.String else "numeric"} for name in data]
    store.save("nominal", {"datasetId": "nominal", "schema": schema, "schemaRevision": 3, "dataRevision": 2}, frame, codebook)
    return frame


def request(client, **overrides):
    return client.post("/api/v1/models/kda", json={"datasetId": "nominal", "outcome": "y", "drivers": ["g"],
        "expectedSchemaRevision": 3, "expectedDataRevision": 2, **overrides})


def assert_public_allocation(result, expected, r2):
    assert result["model"]["r_squared"] == pytest.approx(r2, abs=ROUND_ABS, rel=0)
    drivers = {d["name"]: d for d in result["drivers"]}
    for name, value in expected.items():
        assert drivers[name]["importance_raw"] == pytest.approx(value, abs=ROUND_ABS, rel=0)
        assert drivers[name]["importance_pct"] == pytest.approx(value / sum(expected.values()) * 100, abs=.0051, rel=0)
    assert abs(sum(d["importance_raw"] for d in drivers.values()) - result["model"]["r_squared"]) <= (len(drivers) + 1) * ROUND_ABS


@pytest.mark.parametrize("groups,order,reference", [
    ([1, 1, 2, 2, 3, 3], ["1", "2", "3"], "1"),
    ([1, 1, 3, 3, 2, 2], ["1", "2", "3"], "1"),
    (["A", "A", "B", "B", "C", "C"], ["A", "B", "C"], "A"),
    (["A", "A", "B", "B", "C", "C"], ["unused", "C", "A", "B"], "C"),
])
def test_public_nominal_recoding_matches_group_means_and_preserves_saved_data(survey, groups, order, reference):
    store, client = survey
    frame = save_survey(store, {"g": groups, "y": Y}, {"g": {"categoryOrder": order, "valueLabels": {reference: "Reference category"}}})
    saved_book = deepcopy(store.load_codebook("nominal"))
    response = request(client, rowIds=["r5", "r4", "r3", "r2", "r1", "r0"])
    assert response.status_code == 200, response.text
    result = response.json()
    # Independent category-means fit: group means are 2, 5, 3, SSE=6,
    # SST=46/3, irrespective of code or reference representation.
    predicted = [np.mean([value for group, value in zip(groups, Y) if group == code]) for code in groups]
    total = sum((value - np.mean(Y)) ** 2 for value in Y)
    oracle = 1 - sum((value - fitted) ** 2 for value, fitted in zip(Y, predicted)) / total
    assert oracle == pytest.approx(14 / 23, abs=1e-14, rel=0)
    assert_public_allocation(result, {"g": oracle}, oracle)
    assert result["model"]["n_valid"] == 6 and result["model"]["vif_max"] is None
    driver, = result["drivers"]
    assert driver["name"] == "g" and driver["label"] == "Saved g" and driver["kind"] == "nominal"
    assert all(driver[field] is None for field in ("direction", "standardized_coef", "raw_slope", "pearson_r", "vif"))
    assert driver["encoding"]["reference_code"] == reference
    assert driver["encoding"]["levels"][0] == {"code": reference, "label": "Reference category"}
    assert driver["encoding"]["design_column_count"] == 2
    assert result["what_if_baseline"] == {"outcome_mean": pytest.approx(10 / 3, abs=ROUND_ABS), "driver_means": {}, "raw_slopes": {}}
    json.dumps(result, allow_nan=False)
    assert store.get_dataframe("nominal").equals(frame)
    assert store.load_codebook("nominal") == saved_book


@pytest.mark.parametrize("requested_indices", [list(range(14)), [12, 10, 8, 6, 5, 4, 3, 2, 1, 0]])
def test_public_common_mask_with_missing_domain_nonfinite_zero_and_scope(survey, requested_indices):
    store, client = survey
    frame = save_survey(store, {
        "g": [0., 0., 1., 1., 2., 2., 99., None, float("nan"), float("inf"), 8., 0., 0., 0.],
        "x": X + [1., 1., 1., 1., 1., 1., float("inf"), None],
        "y": Y + [3., 3., 3., 3., 3., -999., 3., 3.],
    }, {"g": {"categoryOrder": ["0", "1", "2", "99", "unobserved"], "missingCodes": ["99"]},
        "y": {"missingCodes": ["-999"]}})
    saved_book = deepcopy(store.load_codebook("nominal"))
    requested_ids = [f"r{i}" for i in requested_indices]
    # Enumerated from fixture semantics: only the original six rows survive.
    retained = [i for i in requested_indices if i in range(6)]
    assert sorted(retained) == list(range(6))
    response = request(client, drivers=["g", "x"], rowIds=requested_ids)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["model"]["n_valid"] == len(retained) == 6
    assert_public_allocation(result, {"g": 134 / 391, "x": 257 / 391}, 1)
    by_name = {d["name"]: d for d in result["drivers"]}
    assert by_name["g"]["encoding"]["levels"] == [{"code": str(i), "label": str(i)} for i in range(3)]
    assert by_name["x"]["raw_slope"] == 2
    assert result["what_if_baseline"]["driver_means"] == {"x": pytest.approx(5 / 6, abs=ROUND_ABS)}
    json.dumps(result, allow_nan=False)
    assert store.get_dataframe("nominal").equals(frame)
    assert store.load_codebook("nominal") == saved_book


def test_public_literal_codes_and_labels_do_not_close_domain(survey):
    store, client = survey
    save_survey(store, {"g": ["NaN", "NaN", "01", "01", "1.0", "1.0"], "y": Y},
                {"g": {"valueLabels": {"01": "Leading zero"}}})
    response = request(client)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["model"]["n_valid"] == 6
    assert_public_allocation(result, {"g": 14 / 23}, 14 / 23)
    assert result["drivers"][0]["encoding"] == {
        "levels": [{"code": "01", "label": "Leading zero"}, {"code": "1.0", "label": "1.0"}, {"code": "NaN", "label": "NaN"}],
        "reference_code": "01", "design_column_count": 2,
    }


def test_public_saved_reversed_ordinal_is_scored_exactly_once(survey, monkeypatch):
    store, client = survey
    frame = save_survey(store, {"g": ["A", "A", "B", "B", "C", "C"], "ordinal": [10, 20, 30, 10, 20, 30], "y": [7, 5, 3, 7, 5, 3]},
                        {"ordinal": {"scaleType": "ordinal", "role": "question", "categoryOrder": ["10", "20", "30"], "isReversed": True}})
    calls = []
    original = CodebookAdapter.analysis_frame

    def count_scoring(adapter):
        calls.append(True)
        return original(adapter)

    monkeypatch.setattr(CodebookAdapter, "analysis_frame", count_scoring)
    response = request(client, drivers=["g", "ordinal"])
    assert response.status_code == 200, response.text
    result = response.json()
    assert len(calls) == 1 and result["model"]["n_valid"] == 6
    assert_public_allocation(result, {"g": 1 / 8, "ordinal": 7 / 8}, 1)
    ordinal = next(d for d in result["drivers"] if d["name"] == "ordinal")
    assert ordinal["kind"] == "numeric" and ordinal["raw_slope"] == 2
    assert ordinal["standardized_coef"] == ordinal["pearson_r"] == ordinal["direction"] == 1
    assert result["what_if_baseline"] == {"outcome_mean": 5, "driver_means": {"ordinal": 2}, "raw_slopes": {"ordinal": 2}}
    assert store.get_dataframe("nominal").equals(frame)


@pytest.mark.parametrize("role", ["question", "attribute"])
@pytest.mark.parametrize("groups", [[1, 1, 2, 2, 3, 3], ["A", "A", "B", "B", "C", "C"]])
def test_public_nominal_driver_eligibility_uses_saved_role_and_scale(survey, role, groups):
    store, client = survey
    save_survey(store, {"g": groups, "y": Y}, {"g": {"role": role}})
    assert request(client).status_code == 200


@pytest.mark.parametrize("invalid_spec", [
    {"scaleType": "text"}, {"scaleType": "id"}, {"role": "weight"}, {"role": "id"}, {"role": "other"},
    {"multiResponseGroup": "ma"},
])
def test_public_nominal_request_rejects_ineligible_selected_driver(survey, invalid_spec):
    store, client = survey
    save_survey(store, {"g": ["A", "A", "B", "B", "C", "C"], "x": X, "y": Y}, {"x": invalid_spec})
    response = request(client, drivers=["g", "x"])
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "KDA_INPUT_INVALID"


@pytest.mark.parametrize("invalid_spec", [{"scaleType": "nominal"}, {"role": "attribute"}, {"role": "weight"}, {"multiResponseGroup": "ma"}])
def test_public_nominal_request_rejects_invalid_outcome(survey, invalid_spec):
    store, client = survey
    save_survey(store, {"g": [1, 1, 2, 2, 3, 3], "y": Y}, {"y": invalid_spec})
    response = request(client)
    assert response.status_code == 422 and response.json()["error"]["code"] == "KDA_INPUT_INVALID"


@pytest.mark.parametrize("selection", [[], ["g", "absent"], ["column-g"], ["g", "g_B"], ["g", "g"], ["g", "y"], ["g", "__rowId__"]])
def test_public_invalid_explicit_selections_never_fall_back(survey, selection):
    store, client = survey
    save_survey(store, {"g": [1, 1, 2, 2, 3, 3], "x": X, "y": Y})
    response = request(client, drivers=selection)
    assert response.status_code == 422 and response.json()["error"]["code"] == "KDA_INPUT_INVALID"


@pytest.mark.parametrize("method", ["relative_weights", "shap", "anything"])
def test_public_nominal_method_boundary_preserves_numeric_only_legacy_method(survey, method):
    store, client = survey
    save_survey(store, {"g": [1, 1, 2, 2, 3, 3], "x": X, "y": Y})
    response = request(client, method=method)
    assert response.status_code == 422 and response.json()["error"]["code"] == "KDA_METHOD_UNSUPPORTED"
    numeric = request(client, drivers=["x"], method=method)
    assert numeric.status_code == 200, numeric.text
    assert numeric.json()["method"] == method
    assert numeric.json()["drivers"][0]["kind"] == "numeric"
    assert request(client, drivers=["x"], weights=[1] * 6).status_code == 422


def test_public_numeric_only_explicit_empty_keeps_legacy_defaults(survey):
    store, client = survey
    save_survey(store, {"x": X, "y": Y})
    response = request(client, drivers=[])
    assert response.status_code == 200, response.text
    assert [d["name"] for d in response.json()["drivers"]] == ["x"]


def test_public_saturation_error(survey):
    store, client = survey
    save_survey(store, {"g": list("ABCDEF"), "y": Y})
    saturated = request(client)
    assert saturated.status_code == 400
    assert saturated.json()["error"]["code"] == "KDA_EXECUTION_ERROR"
    assert "残差自由度" in saturated.json()["error"]["message"]


def test_public_all_missing_error(survey):
    store, client = survey
    save_survey(store, {"g": [99] * 6, "y": Y}, {"g": {"missingCodes": ["99"]}})
    missing = request(client)
    assert missing.status_code == 400 and missing.json()["error"]["code"] == "KDA_EXECUTION_ERROR"


def test_public_numerical_error_and_scope_revision_errors(survey, monkeypatch):
    store, client = survey
    save_survey(store, {"g": ["A", "A", "B", "B", "C", "C"], "y": Y})
    stale = request(client, expectedSchemaRevision=2)
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "ANALYSIS_INPUT_STALE"
    unknown = request(client, rowIds=["not-a-row"])
    assert unknown.status_code == 422 and unknown.json()["error"]["code"] == "ANALYSIS_SCOPE_UNKNOWN_ROW"
    empty = request(client, rowIds=[])
    assert empty.status_code == 400 and empty.json()["error"]["code"] == "KDA_EXECUTION_ERROR"

    def fail_svd(*args, **kwargs):
        raise np.linalg.LinAlgError("controlled failure")

    monkeypatch.setattr(np.linalg, "svd", fail_svd)
    failure = request(client)
    assert failure.status_code == 400 and failure.json()["error"]["code"] == "KDA_EXECUTION_ERROR"
    assert "numerical error" in failure.json()["error"]["message"]
