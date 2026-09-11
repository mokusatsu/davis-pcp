"""WEIGHT-03 / B05: the MA summary must actually apply the survey weight.

Before this change ``MultiResponseSummaryRequest`` had no ``weightColumn``
field at all, so the UI could send one and pydantic dropped it — every ratio
was unweighted and nothing said so.  These tests pin the weighted contract:

- unit weights reproduce the unweighted ratios exactly;
- scaling every weight by k leaves the ratios alone and scales the weighted
  totals;
- a respondent whose weight is missing drops out of the weighted denominator
  (and is counted), while the unweighted denominator is untouched;
- a weight column that cannot be used degrades to unweighted with
  ``weightStatus: "unsupported"`` instead of a 422.

Fixture (5 rows, MA group ``q`` over columns ``a``/``b``)::

    rowId  a   b   area  wt   wt_unit  wt_x2  wt_missing
    r1     1   0   M     1.5  1.0      3.0    1.5      valid, selected {a}
    r2     1   1   F     2.5  1.0      5.0    2.5      valid, selected {a,b}
    r3     0   0   M     4.0  1.0      8.0    (null)   valid, selected {}
    r4     1   99  M     1.0  1.0      2.0    1.0      partial
    r5     99  99  99    1.0  1.0      2.0    1.0      missing
"""
from __future__ import annotations

import polars as pl
import pytest
from fastapi.testclient import TestClient

from app.api import multi_response
from app.main import app
from app.storage.dataset_store import DatasetStore

PATH = "/api/v1/summaries/multi-response"
COMPARISON_PATH = "/api/v1/summaries/multi-response/comparison"

WEIGHTS = {
    "wt": [1.5, 2.5, 4.0, 1.0, 1.0],
    "wt_unit": [1.0, 1.0, 1.0, 1.0, 1.0],
    "wt_x2": [3.0, 5.0, 8.0, 2.0, 2.0],
    "wt_missing": [1.5, 2.5, None, 1.0, 1.0],
    "wt_bad": [1.5, -2.5, 4.0, 1.0, 1.0],
}


@pytest.fixture
def weight_api(tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    columns = [
        {"columnId": name, "name": name, "multiResponseGroup": "q", "scaleType": "nominal",
         "role": "question", "missingCodes": ["99"]}
        for name in ("a", "b")
    ]
    columns.append({"columnId": "area", "name": "area", "role": "attribute", "scaleType": "nominal",
                    "missingCodes": ["99"], "categoryOrder": ["M", "F"]})
    columns.append({"columnId": "grp", "name": "grp", "role": "attribute", "scaleType": "nominal",
                    "missingCodes": []})
    columns += [{"columnId": name, "name": name, "role": "weight", "scaleType": "ratio", "missingCodes": []}
                for name in WEIGHTS]
    codebook = {"datasetId": "ma", "schemaRevision": 2, "columns": columns,
                "multiResponseGroups": [{"groupId": "q", "label": "利用サービス"}]}
    frame = pl.DataFrame({
        "__rowId__": ["r1", "r2", "r3", "r4", "r5"],
        "a": [1, 1, 0, 1, 99],
        "b": [0, 1, 0, 99, 99],
        "area": ["M", "F", "M", "M", "99"],
        "grp": ["x", "x", "y", "y", "x"],
        **{name: pl.Series(values, dtype=pl.Float64) for name, values in WEIGHTS.items()},
    })
    store.save("ma", {"datasetId": "ma", "schemaRevision": 2}, frame, codebook=codebook)
    monkeypatch.setattr(multi_response, "store", store)
    multi_response._summary_cache.clear()
    with TestClient(app) as client:
        yield client


def summary(client, weight_column: str | None = None, **extra):
    body = {"datasetId": "ma", "groupIds": ["q"], **extra}
    if weight_column is not None:
        body["weightColumn"] = weight_column
    response = client.post(PATH, json=body)
    assert response.status_code == 200, response.text
    return response.json()


def test_unit_weights_reproduce_the_unweighted_ratios(weight_api):
    body = summary(weight_api, "wt_unit")
    assert body["weightStatus"] == "applied"
    assert body["weightColumn"] == "wt_unit"
    assert body["weightedN"] == 5.0
    group = body["groups"][0]
    assert group["denominators"]["valid"] == 3
    assert group["weightedValidN"] == 3.0
    for item in group["items"]:
        assert item["selectedWeighted"] == float(item["selectedN"])
        assert item["pctRespondent"] == item["pctRespondentUnweighted"]
        assert item["pctResponse"] == item["pctResponseUnweighted"]
    # …and the very same numbers come back with no weight at all.
    plain = summary(weight_api)["groups"][0]
    assert plain["weightedValidN"] is None
    assert [(i["selectedN"], i["pctRespondent"]) for i in plain["items"]] == \
           [(i["selectedN"], i["pctRespondent"]) for i in group["items"]]


def test_scaling_every_weight_leaves_ratios_and_scales_the_totals(weight_api):
    base = summary(weight_api, "wt")
    doubled = summary(weight_api, "wt_x2")
    assert base["weightedN"] == 10.0 and doubled["weightedN"] == 20.0
    base_group, doubled_group = base["groups"][0], doubled["groups"][0]
    assert base_group["weightedValidN"] == 8.0 and doubled_group["weightedValidN"] == 16.0
    for one, two in zip(base_group["items"], doubled_group["items"]):
        assert two["selectedWeighted"] == 2 * one["selectedWeighted"]
        assert two["pctRespondent"] == one["pctRespondent"]
        assert two["pctResponse"] == one["pctResponse"]
    item = base_group["items"][0]  # a: selected by r1 (1.5) and r2 (2.5)
    assert item["selectedN"] == 2 and item["selectedWeighted"] == 4.0
    assert item["pctRespondent"] == 50.0            # 4.0 / 8.0
    assert item["pctResponse"] == pytest.approx(4.0 / 6.5 * 100)
    # The plain ratios are still reported next to the weighted ones.
    assert item["pctRespondentUnweighted"] == pytest.approx(200 / 3)
    assert base["warnings"][0]["code"] == "MA_WEIGHT_APPLIED"


def test_missing_weights_leave_the_weighted_denominator(weight_api):
    body = summary(weight_api, "wt_missing")
    assert body["weightStatus"] == "applied"
    assert body["weightMissingCount"] == 1
    assert body["weightZeroCount"] == 0
    # r3 is a valid respondent whose weight is missing: it keeps the unweighted
    # denominator at 3 but leaves the weighted one at r1 + r2 = 4.0.
    assert body["weightedN"] == 6.0
    group = body["groups"][0]
    assert group["denominators"]["valid"] == 3
    assert group["weightedValidN"] == 4.0
    item = group["items"][0]
    assert item["selectedN"] == 2 and item["pctRespondentUnweighted"] == pytest.approx(200 / 3)
    assert item["selectedWeighted"] == 4.0 and item["pctRespondent"] == 100.0


def test_zero_weight_rows_are_counted_and_excluded(weight_api, monkeypatch):
    store = multi_response.store
    frame = store.get_dataframe("ma").with_columns(
        pl.when(pl.col("__rowId__") == "r2").then(0.0).otherwise(pl.col("wt")).alias("wt"))
    store.save("ma", store.get_meta("ma"), frame, codebook=store.load_codebook("ma"))
    body = summary(weight_api, "wt")
    assert body["weightZeroCount"] == 1
    assert body["weightedN"] == 7.5          # r2 contributes nothing
    group = body["groups"][0]
    assert group["weightedValidN"] == 5.5    # r1 + r3
    item = group["items"][0]
    assert item["selectedN"] == 2 and item["selectedWeighted"] == 1.5


@pytest.mark.parametrize("weight_column,message", [
    ("a", "role=weight"),
    ("area", "role=weight"),
    ("nope", "存在しません"),
    ("wt_bad", "負値"),
])
def test_unusable_weight_columns_degrade_instead_of_failing(weight_api, weight_column, message):
    body = summary(weight_api, weight_column)
    assert body["weightStatus"] == "unsupported"
    assert body["weightedN"] is None
    assert body["warnings"][0]["code"] == "WEIGHT_UNSUPPORTED"
    assert message in body["warnings"][0]["message"]
    group = body["groups"][0]
    assert group["weightedValidN"] is None
    for item in group["items"]:
        assert item["pctRespondent"] == item["pctRespondentUnweighted"]
        assert item["selectedWeighted"] == float(item["selectedN"])
    # The unsupported answer matches the unweighted one exactly.
    assert group["items"] == summary(weight_api)["groups"][0]["items"]


def test_weight_is_part_of_the_cache_key(weight_api, monkeypatch):
    computed = []
    summarize = multi_response.summarize_group

    def tracked(frame, group, **kwargs):
        computed.append(frame.height)
        return summarize(frame, group, **kwargs)

    monkeypatch.setattr(multi_response, "summarize_group", tracked)
    first = summary(weight_api, "wt")
    again = summary(weight_api, "wt")
    assert computed == [5] and first["weightedN"] == again["weightedN"]
    other = summary(weight_api, "wt_x2")
    assert computed == [5, 5]
    assert other["weightedN"] == 2 * first["weightedN"]


def test_comparison_strata_are_weighted_per_stratum(weight_api):
    response = weight_api.post(COMPARISON_PATH, json={
        "datasetId": "ma", "groupId": "q", "attributeColumnId": "area", "weightColumn": "wt"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["weightStatus"] == "applied" and body["weightedN"] == 10.0
    strata = {item["code"]: item["summary"] for item in body["strata"]}
    # M = r1 (1.5) + r3 (4.0) valid, r4 partial; F = r2 (2.5) valid.
    assert strata["M"]["weightedValidN"] == 5.5
    assert strata["F"]["weightedValidN"] == 2.5
    assert strata["M"]["items"][0]["selectedWeighted"] == 1.5
    assert strata["M"]["items"][0]["pctRespondentUnweighted"] == 50.0
    assert strata["M"]["items"][0]["pctRespondent"] == pytest.approx(1.5 / 5.5 * 100)
    assert strata["F"]["items"][0]["pctRespondent"] == 100.0
    plain = weight_api.post(COMPARISON_PATH, json={
        "datasetId": "ma", "groupId": "q", "attributeColumnId": "area"}).json()
    assert plain["weightStatus"] == "omitted" and plain["weightedN"] is None
    assert all(item["summary"]["weightedValidN"] is None for item in plain["strata"])
