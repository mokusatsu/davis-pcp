"""Unit tests for Feature 04: Key Driver Analysis (KDA)."""
import pytest
import numpy as np
import polars as pl
from fastapi.testclient import TestClient

from app.algorithms.models.kda import run_kda
from app.algorithms.models.kda import _GroupedOLS, _checked_r2, _grouped_lmg, _prepare_grouped_design
from app.main import app


def test_kda_shapley_sum_property():
    np.random.seed(42)
    n = 100
    x1 = np.random.normal(0, 1, n)
    x2 = np.random.normal(0, 1, n)
    x3 = np.random.normal(0, 1, n)
    # y is strong linear combination
    y = 3.0 * x1 + 1.5 * x2 + 0.2 * x3 + np.random.normal(0, 0.5, n)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "target": y,
        "d1": x1,
        "d2": x2,
        "d3": x3,
    })

    res = run_kda(df, outcome="target", drivers=["d1", "d2", "d3"])
    
    full_r2 = res["model"]["r_squared"]
    shapley_sum = sum(d["importance_raw"] for d in res["drivers"])
    # Sum of Shapley values must equal full R2
    assert math_close(shapley_sum, full_r2, tol=0.01)

    # d1 must have highest importance
    top_driver = res["drivers"][0]
    assert top_driver["name"] == "d1"
    assert top_driver["importance_pct"] > res["drivers"][1]["importance_pct"]
    assert top_driver["direction"] == 1


def test_kda_multicollinearity_vif():
    np.random.seed(42)
    n = 100
    x1 = np.random.normal(0, 1, n)
    # x2 collinear with x1
    x2 = x1 * 0.98 + np.random.normal(0, 0.05, n)
    x3 = np.random.normal(0, 1, n)
    y = 2.0 * x1 + 0.5 * x3 + np.random.normal(0, 0.5, n)

    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(n)],
        "y": y,
        "x1": x1,
        "x2": x2,
        "x3": x3,
    })

    res = run_kda(df, outcome="y", drivers=["x1", "x2", "x3"])
    assert res["model"]["vif_max"] > 5.0
    assert "warnings" in res["model"]


def test_kda_api(tmp_path, monkeypatch):
    from app.api import datasets, models
    from app.storage.dataset_store import DatasetStore

    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, "store", store)
    monkeypatch.setattr(models, "store", store)
    client = TestClient(app)
    import_resp = client.post("/api/v1/datasets/import/sample", json={"name": "Iris Sample"})
    dataset_id = import_resp.json()["datasetId"]

    resp = client.post("/api/v1/models/kda", json={
        "datasetId": dataset_id,
        "outcome": "petal_width_cm",
        "drivers": ["sepal_length_cm", "sepal_width_cm", "petal_length_cm"],
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["outcome"]["name"] == "petal_width_cm"
    assert len(body["drivers"]) == 3
    assert "what_if_baseline" in body


def test_kda_zero_variance_driver_handling():
    # Verify driver with 0 variance is handled without numerical breakdown and generates warning
    df = pl.DataFrame({
        "__rowId__": [f"r_{i}" for i in range(30)],
        "target": [float(i) for i in range(30)],
        "d_const": [5.0] * 30,
        "d_var": [float(i * 2) for i in range(30)],
    })
    res = run_kda(df, outcome="target", drivers=["d_const", "d_var"])
    assert res["model"]["r_squared"] > 0.9
    assert any("d_const" in w for w in res["model"]["warnings"])


def math_close(a: float, b: float, tol: float = 0.01) -> bool:
    return abs(a - b) <= tol


# These small oracles use category means and independently specified coalition
# values, never production-generated indicator columns to define expectations.
PROOF_Y = [1., 3., 4., 6., 2., 4.]
PROOF_X = [0., 1., 1., 2., 0., 1.]


def nominal_spec(name="g", order=None, labels=None):
    return {"name": name, "columnId": name, "scaleType": "nominal", "role": "attribute",
            "categoryOrder": order or [], "valueLabels": labels or {}}


def group_means_r2(groups, outcomes):
    y = np.asarray(outcomes, dtype=float)
    fitted = np.asarray([np.mean([value for code, value in zip(groups, y) if code == group]) for group in groups])
    return 1 - float(np.sum((y - fitted) ** 2) / np.sum((y - y.mean()) ** 2))


def unrounded_grouped(frame, drivers, specs, exact=12, samples=500):
    data = _prepare_grouped_design(frame, "y", drivers, {spec["name"]: spec for spec in specs})
    solver = _GroupedOLS(data.matrix)

    def score(players):
        columns = [0, *(column for player in players for column in data.blocks[player])]
        if len(columns) == 1:
            return 0.0
        return solver.fit(data.matrix[:, columns], data.y)[2]

    values, r2 = _grouped_lmg(len(drivers), score, exact, samples)
    coefficients, rank, _ = solver.fit(data.matrix, data.y)
    return values, r2, data, coefficients, rank


@pytest.mark.parametrize("codes,order,reference", [
    ([1, 1, 2, 2, 3, 3], [1, 2, 3], "1"),
    ([1, 1, 3, 3, 2, 2], [1, 2, 3], "1"),
    (["A", "A", "B", "B", "C", "C"], ["C", "A", "B", "unobserved"], "C"),
    (["A", "A", "B", "B", "C", "C"], [], "A"),
])
def test_nominal_recoding_reference_and_original_player_oracle(codes, order, reference):
    frame = pl.DataFrame({"g": codes, "y": PROOF_Y})
    meta = [nominal_spec(order=order, labels={reference: "Reference label"})]
    expected = group_means_r2(codes, PROOF_Y)
    assert expected == pytest.approx(14 / 23, abs=1e-14)
    values, r2, data, _, _ = unrounded_grouped(frame, ["g"], meta)
    assert r2 == pytest.approx(expected, abs=1e-10, rel=0)
    assert values == pytest.approx([expected], abs=1e-10, rel=0)
    assert data.blocks == [(1, 2)]
    result = run_kda(frame, "y", ["g"], meta)
    driver, = result["drivers"]
    assert driver["kind"] == "nominal" and driver["importance_pct"] == 100
    assert driver["importance_raw"] == pytest.approx(expected, abs=5.1e-5, rel=0)
    assert all(driver[key] is None for key in ("direction", "standardized_coef", "raw_slope", "pearson_r", "vif"))
    assert driver["encoding"]["reference_code"] == reference
    assert driver["encoding"]["levels"][0] == {"code": reference, "label": "Reference label"}
    assert driver["encoding"]["design_column_count"] == 2
    assert result["model"]["vif_max"] is None
    assert result["model"]["vif_coverage"] == "numeric_drivers_only"
    assert result["what_if_baseline"]["driver_means"] == result["what_if_baseline"]["raw_slopes"] == {}


@pytest.mark.parametrize("order", [["A", "B", "C"], ["C", "B", "A"]])
def test_mixed_exact_threshold_counts_players_and_identifiable_slope(order):
    frame = pl.DataFrame({"g": ["A", "A", "B", "B", "C", "C"], "x": PROOF_X, "y": PROOF_Y})
    meta = [nominal_spec(order=order)]
    expected = np.asarray([134 / 391, 257 / 391])
    values, r2, data, coefficients, rank = unrounded_grouped(frame, ["g", "x"], meta, exact=2, samples=1)
    assert data.blocks == [(1, 2), (3,)] and rank == 4 < len(PROOF_Y)
    assert r2 == pytest.approx(1, abs=1e-10, rel=0)
    assert values == pytest.approx(expected, abs=1e-10, rel=0)
    slope = coefficients[3] * data.y_std / data.numeric["x"][2]
    assert slope == pytest.approx(2, abs=3e-9, rel=0)
    result = run_kda(frame, "y", ["g", "x"], meta, max_exact_drivers=2, n_sample_permutations=1)
    by_name = {driver["name"]: driver for driver in result["drivers"]}
    assert by_name["x"]["raw_slope"] == 2 and by_name["x"]["direction"] == 1
    assert result["what_if_baseline"]["driver_means"] == {"x": pytest.approx(5 / 6, abs=5.1e-5)}
    assert result["what_if_baseline"]["raw_slopes"] == {"x": 2}
    # X's auxiliary model uses the entire G block: within-group SSE=1.5,
    # total X SS=17/6, so VIF=(17/6)/1.5=17/9.
    assert by_name["x"]["vif"] == pytest.approx(17 / 9, abs=.0051, rel=0)


@pytest.mark.parametrize("samples", [1, 17, 800])
def test_sampled_whole_player_oracle_recoding_cap_and_global_rng(samples):
    # Sampling is compared to its actual seed-42 permutations, not exact LMG.
    rng = np.random.default_rng(42)
    count = min(samples, 500)
    g_first = sum(rng.permutation(2)[0] == 0 for _ in range(count)) / count
    expected_g = (30 + 208 * g_first) / 391
    global_before = np.random.get_state()
    for codes, order in [([1, 1, 2, 2, 3, 3], [1, 2, 3]),
                         ([1, 1, 3, 3, 2, 2], [2, 3, 1]),
                         (["A", "A", "B", "B", "C", "C"], ["C", "A", "B"])]:
        frame = pl.DataFrame({"g": codes, "x": PROOF_X, "y": PROOF_Y})
        values, r2, _, _, _ = unrounded_grouped(frame, ["g", "x"], [nominal_spec(order=order)], exact=1, samples=samples)
        assert values == pytest.approx([expected_g, 1 - expected_g], abs=1e-10, rel=0)
        assert values.sum() == pytest.approx(r2, abs=2e-10, rel=0)
    global_after = np.random.get_state()
    assert global_before[0] == global_after[0]
    assert np.array_equal(global_before[1], global_after[1])
    assert global_before[2:] == global_after[2:]


def test_binary_nominal_has_numeric_model_space_but_unsigned_semantics():
    frame = pl.DataFrame({"g": [0, 0, 0, 1, 1, 1], "y": PROOF_Y})
    nominal = run_kda(frame, "y", ["g"], [nominal_spec()])
    numeric = run_kda(frame, "y", ["g"], [{"name": "g", "scaleType": "ratio", "valueLabels": {"0": "No", "1": "Yes"}}])
    assert nominal["model"]["r_squared"] == numeric["model"]["r_squared"]
    assert nominal["drivers"][0]["importance_raw"] == numeric["drivers"][0]["importance_raw"]
    assert nominal["drivers"][0]["direction"] is None
    assert numeric["drivers"][0]["direction"] in (-1, 1)
    assert numeric["drivers"][0]["kind"] == "numeric"


def test_mixed_small_varying_numeric_score_keeps_defined_pearson():
    frame = pl.DataFrame({"g": ["A", "A", "B", "B", "C", "C"], "x": np.asarray(PROOF_X) * 1e-10, "y": PROOF_Y})
    mixed = run_kda(frame, "y", ["g", "x"], [nominal_spec()])
    numeric = run_kda(frame, "y", ["x"])
    x = next(d for d in mixed["drivers"] if d["name"] == "x")
    assert x["pearson_r"] == numeric["drivers"][0]["pearson_r"]
    assert x["pearson_r"] == pytest.approx(np.sqrt(361 / 391), abs=5.1e-5, rel=0)
    assert x["vif"] == 1  # Preserve the legacy small-variance VIF rule.


def test_constant_nominal_is_empty_null_player_and_all_missing_errors():
    frame = pl.DataFrame({"g": ["A"] * 6, "x": PROOF_X, "y": PROOF_Y})
    meta = [nominal_spec(order=["unused", "A"])]
    values, _, data, _, _ = unrounded_grouped(frame, ["g", "x"], meta)
    assert data.blocks == [(), (1,)] and values[0] == 0
    result = run_kda(frame, "y", ["g", "x"], meta)
    constant = next(d for d in result["drivers"] if d["name"] == "g")
    assert constant["importance_raw"] == constant["importance_pct"] == 0
    assert constant["encoding"] == {"levels": [{"code": "A", "label": "A"}], "reference_code": "A", "design_column_count": 0}
    assert any("g" in warning for warning in result["model"]["warnings"])
    with pytest.raises(ValueError, match="有効行数"):
        run_kda(frame.with_columns(pl.lit(None).alias("g")), "y", ["g", "x"], meta)


@pytest.mark.parametrize("order", [["A", "B", "C"], ["B", "C", "A"]])
def test_mixed_alias_preserves_importance_but_suppresses_unidentified_slope(order):
    frame = pl.DataFrame({"g": ["A", "A", "B", "B", "C", "C"], "x": [0, 0, 1, 1, 0, 0], "y": PROOF_Y})
    meta = [nominal_spec(order=order)]
    values, r2, _, _, rank = unrounded_grouped(frame, ["g", "x"], meta)
    assert rank == 3
    assert r2 == pytest.approx(14 / 23, abs=1e-10, rel=0)
    assert values == pytest.approx([31 / 92, 25 / 92], abs=1e-10, rel=0)
    result = run_kda(frame, "y", ["g", "x"], meta)
    numeric = next(d for d in result["drivers"] if d["name"] == "x")
    assert all(numeric[key] is None for key in ("direction", "standardized_coef", "raw_slope"))
    assert numeric["pearson_r"] is not None and numeric["vif"] == 10000
    assert result["what_if_baseline"]["raw_slopes"] == result["what_if_baseline"]["driver_means"] == {}
    assert any("ランク" in warning for warning in result["model"]["warnings"])


def test_duplicate_original_nominals_share_importance_without_removal():
    frame = pl.DataFrame({"g": ["A", "A", "B", "B", "C", "C"], "h": [3, 3, 1, 1, 2, 2], "y": PROOF_Y})
    meta = [nominal_spec(), nominal_spec("h", order=[2, 1, 3])]
    values, r2, _, _, rank = unrounded_grouped(frame, ["g", "h"], meta)
    assert rank == 3
    assert r2 == pytest.approx(14 / 23, abs=1e-10, rel=0)
    assert values == pytest.approx([7 / 23, 7 / 23], abs=1e-10, rel=0)
    assert len(run_kda(frame, "y", ["g", "h"], meta)["drivers"]) == 2


def test_identifiable_numeric_slope_survives_aliased_nominal_blocks():
    frame = pl.DataFrame({"g": ["A", "A", "B", "B", "C", "C"], "h": [3, 3, 1, 1, 2, 2], "x": PROOF_X, "y": PROOF_Y})
    for reference in ([3, 1, 2], [2, 1, 3]):
        meta = [nominal_spec(), nominal_spec("h", order=reference)]
        result = run_kda(frame, "y", ["g", "h", "x"], meta)
        numeric = next(d for d in result["drivers"] if d["name"] == "x")
        assert numeric["raw_slope"] == 2 and numeric["direction"] == 1
        assert result["what_if_baseline"]["raw_slopes"] == {"x": 2}
        assert any("ランク" in warning for warning in result["model"]["warnings"])


def test_nominal_saturation_is_distinct_from_perfect_fit_and_constant_target():
    frame = pl.DataFrame({"g": list("ABCDEF"), "y": PROOF_Y})
    with pytest.raises(ValueError, match="残差自由度"):
        run_kda(frame, "y", ["g"], [nominal_spec()])
    with pytest.raises(ValueError, match="NO_TARGET_VARIATION"):
        run_kda(frame.with_columns(pl.lit(1).alias("y")), "y", ["g"], [nominal_spec()])


@pytest.mark.parametrize("power", [0., .5e-6, 2e-6])
def test_nominal_power_threshold_does_not_rescale_raw_values(power):
    # Balanced group contrast and within-group residual are orthogonal and have
    # equal SS. Thus y=sqrt(p)*contrast+sqrt(1-p)*residual has R²=p.
    contrast = np.asarray([-1., -1., -1., -1., 1., 1., 1., 1.])
    residual = np.asarray([-1., 1., -1., 1., -1., 1., -1., 1.])
    frame = pl.DataFrame({"g": ["A"] * 4 + ["B"] * 4, "y": np.sqrt(power) * contrast + np.sqrt(1 - power) * residual})
    values, r2, _, _, _ = unrounded_grouped(frame, ["g"], [nominal_spec()])
    assert r2 == pytest.approx(power, abs=1e-10, rel=0)
    assert values == pytest.approx([power], abs=1e-10, rel=0)
    result = run_kda(frame, "y", ["g"], [nominal_spec()])
    assert result["drivers"][0]["importance_pct"] == (100 if power > 1e-6 else 0)
    assert result["drivers"][0]["importance_raw"] == 0  # Four-decimal serialization stays unchanged.
    assert any("説明力がほぼゼロ" in w for w in result["model"]["warnings"]) == (power <= 1e-6)


def test_grouped_common_mask_precedes_expansion_and_preserves_literal_codes():
    frame = pl.DataFrame({"g": ["NaN", "01", "1.0", "NaN", "01", "1.0", None, "extra", "extra"],
                          "x": [0., 1., 2., 3., 4., 5., 6., float("inf"), 8.],
                          "y": [1., 3., 2., 4., 6., 5., 7., 8., float("nan")]})
    data = _prepare_grouped_design(frame, "y", ["g", "x"], {"g": nominal_spec()})
    assert data.matrix.shape == (6, 4)
    assert data.numeric["x"][0].tolist() == [0., 1., 2., 3., 4., 5.]
    assert [level["code"] for level in data.encodings["g"]["levels"]] == ["01", "1.0", "NaN"]
    assert data.blocks == [(1, 2), (3,)]


def test_scored_ordinal_stays_one_column_and_uses_once_scored_oracle():
    frame = pl.DataFrame({"g": ["A", "A", "B", "B", "C", "C"], "ordinal": [3., 2., 1., 3., 2., 1.], "y": [7., 5., 3., 7., 5., 3.]})
    specs = [nominal_spec(), {"name": "ordinal", "scaleType": "ordinal", "categoryOrder": ["10", "20", "30"], "isReversed": True}]
    values, r2, data, coefficients, _ = unrounded_grouped(frame, ["g", "ordinal"], specs)
    assert data.blocks == [(1, 2), (3,)]
    assert values == pytest.approx([1 / 8, 7 / 8], abs=1e-10, rel=0)
    assert r2 == pytest.approx(1, abs=1e-10, rel=0)
    assert coefficients[3] == pytest.approx(1, abs=1e-10, rel=0)
    result = run_kda(frame, "y", ["g", "ordinal"], specs)
    ordinal = next(d for d in result["drivers"] if d["name"] == "ordinal")
    assert ordinal["kind"] == "numeric" and ordinal["raw_slope"] == 2
    assert ordinal["pearson_r"] == ordinal["standardized_coef"] == 1
    assert result["what_if_baseline"] == {"outcome_mean": 5, "driver_means": {"ordinal": 2}, "raw_slopes": {"ordinal": 2}}


def test_new_path_numerical_failures_and_nested_tolerance_are_explicit(monkeypatch):
    with pytest.raises(ValueError, match="negative nested"):
        _grouped_lmg(2, lambda players: .3 if len(players) == 2 else .5, 2, 500)
    # Tiny negative gains may be clipped, but raw contributions are not rescaled.
    values, r2 = _grouped_lmg(2, lambda players: .5 if len(players) == 2 else .5 + 1e-11, 2, 500)
    assert values.sum() > r2 and values.sum() - r2 < 2e-10
    with pytest.raises(ValueError, match="nonfinite|invalid"):
        _checked_r2(np.asarray([0., 1.]), np.asarray([float("nan"), 1.]))
    with pytest.raises(ValueError, match="outside numerical tolerance"):
        _checked_r2(np.asarray([0., 1.]), np.asarray([20., 20.]))

    def fail_svd(*args, **kwargs):
        raise np.linalg.LinAlgError("test failure")

    monkeypatch.setattr(np.linalg, "svd", fail_svd)
    with pytest.raises(ValueError, match="numerical error.*SVD failed"):
        run_kda(pl.DataFrame({"g": ["A", "A", "B", "B", "C", "C"], "y": PROOF_Y}), "y", ["g"], [nominal_spec()])


def test_nominal_method_boundary_and_numeric_legacy_alias_diagnostics():
    frame = pl.DataFrame({"g": [1, 1, 2, 2, 3, 3], "y": PROOF_Y})
    with pytest.raises(ValueError, match="shapley_lmg"):
        run_kda(frame, "y", ["g"], [nominal_spec()], method="relative_weights")
    numeric = frame.with_columns(pl.col("g").alias("copy"))
    result = run_kda(numeric, "y", ["g", "copy"], method="legacy_method_name")
    assert result["method"] == "legacy_method_name"
    assert all(d["raw_slope"] is not None and d["direction"] is not None for d in result["drivers"])
