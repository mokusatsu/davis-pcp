"""Offline built-in samples: independent data/codebook numerical contract oracles.

These are acceptance tests against the shipped raw observations, not synthetic
examples or snapshots of the current implementation. No network or user storage.
"""
from __future__ import annotations

from collections import Counter
from functools import lru_cache

import numpy as np
import polars as pl
import pytest

from app.algorithms.summaries.core import summarize
from app.domain.analysis_columns import resolve_analysis_columns
from app.domain.codebook_adapter import CodebookAdapter
from app.domain.errors import BizError
from app.domain.multi_response import resolve_groups, summarize_group
from app.services.builtin_samples import catalog, install_codebook, load_sample
from app.services.dataset_service import generate_initial_codebook
from app.services.import_service import probe_table

SAMPLE_IDS = [entry["id"] for entry in catalog()]
NUMERIC_SCALES = {"ordinal", "interval", "ratio"}


@lru_cache(maxsize=12)
def loaded(sample_id):
    raw, template = load_sample(sample_id)
    book = install_codebook(generate_initial_codebook(sample_id, probe_table(raw, raw.height)), template)
    frame = raw.with_columns(pl.Series("__rowId__", [f"{sample_id}:{i}" for i in range(raw.height)]))
    return frame, book


def raw_code(value):
    # Independent of normalize_code: shipped CSVs contain finite numeric and
    # string observations only; preserve strings such as respondent_id 001.
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def independent_scores(frame, spec):
    missing = set(spec.get("missingCodes") or [])
    order = [v for v in (spec.get("categoryOrder") or []) if v not in missing]
    if spec.get("isReversed"):
        order = list(reversed(order))
    rank = {code: float(index + 1) for index, code in enumerate(order)}
    result = []
    for raw in frame[spec["name"]].to_list():
        code = raw_code(raw)
        if code is None or code in missing or (order and code not in order):
            result.append(np.nan)
        elif spec["scaleType"] == "ordinal":
            result.append(rank[code])
        else:
            value = float(raw)
            if spec.get("isReversed"):
                bounds = [float(c) for c in order]
                value = min(bounds) + max(bounds) - value
            result.append(value)
    return np.asarray(result)


@pytest.mark.parametrize("sample_id", SAMPLE_IDS)
def test_all_builtin_summary_denominators_and_numeric_statistics(sample_id):
    frame, book = loaded(sample_id)
    column_types = {c["name"]: "numeric" if c["scaleType"] in NUMERIC_SCALES else "categorical"
                    for c in book["columns"]}
    result = summarize(frame, column_types, codebook=book)
    for spec in book["columns"]:
        name = spec["name"]
        actual = result[name]
        missing_codes = set(spec.get("missingCodes") or [])
        declared = set(spec.get("categoryOrder") or []) - missing_codes
        raw = [raw_code(v) for v in frame[name].to_list()]
        valid = [v for v in raw if v is not None and v not in missing_codes and (not declared or v in declared)]
        assert actual["denominators"]["valid"] == len(valid), (sample_id, name)
        assert sum(d["count"] for d in actual["distribution"]) == frame.height, (sample_id, name)
        assert sum(d["count"] for d in actual["distribution"] if not d["isMissing"] and not d.get("isInvalid")) == len(valid)
        if spec["scaleType"] in NUMERIC_SCALES:
            values = independent_scores(frame, spec)
            values = values[np.isfinite(values)]
            assert actual["count"] == len(values), (sample_id, name)
            assert actual["missing"] == frame.height - len(values), (sample_id, name)
            assert actual["mean"] == pytest.approx(values.mean(), rel=1e-12), (sample_id, name)
            assert actual["std"] == pytest.approx(values.std(ddof=1), rel=1e-12), (sample_id, name)
            assert actual["median"] == pytest.approx(np.median(values)), (sample_id, name)
            assert actual["q1"] == pytest.approx(np.quantile(values, .25)), (sample_id, name)
            assert actual["q3"] == pytest.approx(np.quantile(values, .75)), (sample_id, name)
            np.testing.assert_allclose(CodebookAdapter(frame, book).analysis_series(name).to_numpy(),
                                       independent_scores(frame, spec), rtol=0, atol=0)


@pytest.mark.parametrize("sample_id", ["tokyo-traffic2020-adult600", "stackoverflow2024-ma600"])
def test_builtin_ma_parent_denominators_and_selection_counts(sample_id):
    frame, book = loaded(sample_id)
    for group in resolve_groups(book):
        names = [c["name"] for c in group["columns"]]
        rows = frame.select(names).rows()
        counts = Counter()
        expected_selected = np.zeros(len(names), dtype=int)
        all_unselected = 0
        for values in rows:
            if all(value is None for value in values):
                status = "missing"
            elif any(value is None for value in values):
                status = "partial"
            elif any(value not in (0, 1) for value in values):
                status = "invalid"
            elif not any(values):
                status = group["allUnselectedMeaning"]
            else:
                status = "valid"
            counts[status] += 1
            if status == "valid":
                expected_selected += np.asarray(values, dtype=int)
                all_unselected += not any(values)
        actual = summarize_group(frame, group)
        for status in ("valid", "missing", "partial", "invalid", "notApplicable"):
            assert actual["denominators"][status] == counts[status], (sample_id, group["groupId"], status)
        assert actual["allUnselectedN"] == all_unselected
        assert actual["totalResponses"] == sum(expected_selected)
        by_name = dict(zip(names, expected_selected))
        for item in actual["items"]:
            assert item["selectedN"] == by_name[item["name"]]
            assert item["pctRespondent"] == pytest.approx(100 * by_name[item["name"]] / counts["valid"])
            assert item["pctResponse"] == pytest.approx(100 * by_name[item["name"]] / sum(expected_selected))


def test_census_builtin_survey_weight_mean_and_category_masses():
    frame, book = loaded("census-kdd-adult600")
    spec_by_name = {c["name"]: c for c in book["columns"]}
    weight_id = book["weightConfig"]["weightColumnId"]
    weight_name = next(c["name"] for c in book["columns"] if c["columnId"] == weight_id)
    assert weight_name == "MARSUPWT" and book["weightConfig"]["weightType"] == "survey"
    weights = np.asarray(frame[weight_name].to_list(), dtype=float)
    assert np.isfinite(weights).all() and (weights > 0).all()
    result = summarize(frame.select("weeks_worked", "migration_msa"),
                       {"weeks_worked": "numeric", "migration_msa": "categorical"},
                       codebook=book, weights=weights.tolist())
    values = independent_scores(frame, spec_by_name["weeks_worked"])
    valid = np.isfinite(values)
    expected = np.average(values[valid], weights=weights[valid])
    assert result["weeks_worked"]["weighted"]["weightedMean"] == pytest.approx(expected, abs=5e-5, rel=0)
    assert abs(expected - values[valid].mean()) > .1  # Effective oracle, not a coincidentally unweighted result.
    missing = set(spec_by_name["migration_msa"]["missingCodes"])
    category_values = np.asarray(frame["migration_msa"].to_list())
    valid = ~np.isin(category_values, list(missing))
    actual = result["migration_msa"]["weighted"]
    assert actual["weightedN"] == pytest.approx(weights[valid].sum(), abs=5e-5, rel=0)
    for item in actual["distribution"]:
        mass = weights[category_values == item["code"]].sum()
        assert item["weightedCount"] == pytest.approx(mass, abs=5e-5, rel=0)
        assert item["weightedPct"] == pytest.approx(100 * mass / weights[valid].sum(), abs=5e-5, rel=0)


def test_siechnice_choice_units_and_structural_nulls_are_preserved():
    frame, book = loaded("siechnice-cbc96")
    assert frame.height == 3456
    assert frame["respondent_id"].dtype == pl.String
    assert frame["respondent_id"].n_unique() == 96
    assert frame["__rowId__"].n_unique() == 3456
    # Each respondent sees twelve sets, each containing three alternatives.
    sets = frame.group_by("respondent_id", "zadanie").agg(pl.len().alias("n"), pl.col("wybor").sum().alias("chosen"))
    assert sets.height == 96 * 12
    assert sets["n"].to_list() == [3] * (96 * 12)
    assert sets["chosen"].to_list() == [1] * (96 * 12)
    optout = frame.filter(pl.col("status_quo") == 1)
    assert optout.height == 1152
    assert all(optout[c].null_count() == 1152 for c in ["profil_id", "atr1", "atr2", "atr3", "atr4", "atr5"])
    with pytest.raises(BizError):
        resolve_analysis_columns(book, ["respondent_id", "atr1"], scales=NUMERIC_SCALES)


@pytest.mark.parametrize("sample_id", SAMPLE_IDS)
def test_ordinary_numeric_candidates_never_include_ids_weights_or_ma_options(sample_id):
    _, book = loaded(sample_id)
    by_name = {c["name"]: c for c in book["columns"]}
    plan = resolve_analysis_columns(book, None, scales=NUMERIC_SCALES)
    expected = [c["name"] for c in book["columns"] if c["scaleType"] in NUMERIC_SCALES
                and c["role"] in {"attribute", "question"} and not c.get("multiResponseGroup")]
    assert plan.names == expected
    for name in plan.names:
        assert by_name[name]["role"] not in {"id", "weight"}


@pytest.mark.parametrize("sample_id", ["edss-efa-613x13", "edss-cfa-646x13", "atopp-541x31"])
def test_builtin_efa_ml_initial_uniqueness_matches_specification(sample_id):
    """033 design §4.2: psi0=clip((1-.5*q/p)/diag(inv(R)), lower, 1)."""
    from app.algorithms.models.factor_analysis_ml import _initial_psi

    frame, book = loaded(sample_id)
    specs = book["columns"][:6]
    x = np.column_stack([independent_scores(frame, spec) for spec in specs])
    r = np.corrcoef(x, rowvar=False)
    q, lower = 1, .005
    expected = np.clip((1 - .5 * q / r.shape[0]) / np.diag(np.linalg.inv(r)), lower, 1)
    np.testing.assert_allclose(_initial_psi(r, q, lower), expected, rtol=1e-12, atol=1e-14)


FIT_SAMPLE_IDS = [s for s in SAMPLE_IDS if s not in {
    "census-kdd-adult600", "stackoverflow2024-ma600", "siechnice-cbc96"}]


@pytest.mark.parametrize("sample_id", FIT_SAMPLE_IDS)
@pytest.mark.parametrize("use_correlation", [True, False])
def test_builtin_pca_spectrum_scores_and_loadings_match_direct_svd(sample_id, use_correlation):
    from app.algorithms.models.pca import compute_pca

    frame, book = loaded(sample_id)
    specs = [c for c in book["columns"] if c["scaleType"] in NUMERIC_SCALES and c["role"] in {"attribute", "question"}
             and not c.get("multiResponseGroup")][:6]
    names = [c["name"] for c in specs]
    x = np.column_stack([independent_scores(frame, c) for c in specs])
    valid = np.isfinite(x).all(axis=1)
    x = x[valid]
    keep = np.any(x != x[0], axis=0)
    x = x[:, keep]
    names = [name for name, included in zip(names, keep) if included]
    z = x - x.mean(axis=0)
    if use_correlation:
        z /= x.std(axis=0, ddof=1)
    _, singular_values, _ = np.linalg.svd(z, full_matrices=False)
    eigenvalues = singular_values ** 2 / (len(z) - 1)
    adapted = frame.with_columns([CodebookAdapter(frame, book).analysis_series(c["name"]) for c in specs])
    result = compute_pca(adapted, columns=[c["name"] for c in specs], use_correlation=use_correlation)
    np.testing.assert_allclose(result["eigenvalues"], eigenvalues, rtol=2e-12, atol=1e-12)
    scores = np.asarray([row["pc"] for row in result["scores"]])
    loadings = np.asarray([result["loadings"][name] for name in names])
    vectors = loadings / np.sqrt(eigenvalues)[None, :]
    np.testing.assert_allclose(scores @ vectors.T, z, rtol=1e-9, atol=1e-10)
    np.testing.assert_allclose(scores.T @ scores / (len(z) - 1), np.diag(eigenvalues), rtol=1e-10, atol=1e-10)
    assert [row["rowId"] for row in result["scores"]] == [rid for rid, use in zip(frame["__rowId__"], valid) if use]


@pytest.mark.parametrize("sample_id", ["wine", "kakegawa-citizen2022-adult600", "edss-efa-613x13", "atopp-541x31"])
def test_builtin_sparse_pca_rank_missing_and_reconstruction_match_sklearn(sample_id):
    from sklearn.decomposition import SparsePCA
    from app.algorithms.models.sparse_pca import fit_sparse_pca
    from app.domain.sparse_pca_contracts import SparsePcaRequest
    from app.domain.sparse_pca_frame import prepare_sparse_pca_frame

    frame, book = loaded(sample_id)
    specs = [c for c in book["columns"] if c["scaleType"] in NUMERIC_SCALES and c["role"] in {"attribute", "question"}][:4]
    variables = [{"columnId": c["columnId"], "kind": "numeric", **({"ordinalAsNumericAcknowledged": True,
                  "score": "ordered_rank"} if c["scaleType"] == "ordinal" else {})} for c in specs]
    req = SparsePcaRequest.model_validate({"context": {"datasetId": sample_id, "expectedDataRevision": 1,
        "expectedSchemaRevision": book["schemaRevision"], "weightMode": "none"}, "variables": variables,
        "nComponents": 2, "maxIterations": 100})
    prep = prepare_sparse_pca_frame(req, meta={"dataRevision": 1}, codebook=book, data=frame, mask={}, mask_revision=0)
    x = np.column_stack([independent_scores(frame, c) for c in specs])
    valid = np.isfinite(x).all(axis=1)
    np.testing.assert_array_equal(prep.values, x[valid])
    z = (x[valid] - x[valid].mean(axis=0)) / x[valid].std(axis=0, ddof=1)
    oracle = SparsePCA(n_components=2, alpha=1, ridge_alpha=.01, max_iter=100,
                       tol=1e-8, method="lars", n_jobs=1, random_state=0).fit(z)
    result = fit_sparse_pca(prep, req)
    np.testing.assert_allclose(result.details.components, oracle.components_, rtol=1e-9, atol=1e-10)
    np.testing.assert_allclose(result.scores, oracle.transform(z), rtol=1e-8, atol=1e-9)
    expected = 1 - np.sum((z - oracle.mean_ - result.scores @ oracle.components_) ** 2) / np.sum((z - oracle.mean_) ** 2)
    assert result.summary.reconstructionFraction == pytest.approx(expected, abs=1e-12)
    assert not {"eigenvalues", "explainedVarianceRatio"}.intersection(result.summary.model_dump())


@pytest.mark.parametrize("sample_id", ["edss-efa-613x13", "edss-cfa-646x13", "atopp-541x31"])
@pytest.mark.parametrize("extraction", ["ml", "minres"])
def test_builtin_efa_objective_gradient_and_rotation_match_formulas(sample_id, extraction):
    from app.algorithms.models.factor_analysis_ml import fit_ml_profile, ml_profile_gradient
    from app.algorithms.models.factor_analysis_uls import fit_uls_profile, uls_profile_gradient
    from app.algorithms.models.factor_rotations import rotate_solution

    frame, book = loaded(sample_id)
    x = np.column_stack([independent_scores(frame, c) for c in book["columns"][:6]])
    r = np.corrcoef(x, rowvar=False)
    q = 2
    fit = (fit_ml_profile if extraction == "ml" else fit_uls_profile)(r, q, n_starts=2, maxiter=300, seed=19)
    assert fit["status"] == "success", fit
    l, psi = fit["loadings"], fit["psi"]
    if extraction == "ml":
        sigma = l @ l.T + np.diag(psi)
        objective = np.linalg.slogdet(sigma)[1] + np.trace(np.linalg.solve(sigma, r)) - np.linalg.slogdet(r)[1] - len(r)
        point = psi
        def oracle(v):
            a = r / np.sqrt(v)[:, None] / np.sqrt(v)[None, :]
            vals, vecs = np.linalg.eigh(a)
            b = np.sqrt(v)[:, None] * vecs[:, -q:] * np.sqrt(np.maximum(vals[-q:] - 1, 0))
            sigma = b @ b.T + np.diag(v)
            return np.linalg.slogdet(sigma)[1] + np.trace(np.linalg.solve(sigma, r)) - np.linalg.slogdet(r)[1] - len(r)
        gradient = ml_profile_gradient
    else:
        objective = np.sum((r - np.diag(fit["u"]) - l @ l.T) ** 2)
        point = fit["u"]
        def oracle(v):
            vals, vecs = np.linalg.eigh(r - np.diag(v))
            b = vecs[:, -q:] * np.sqrt(np.maximum(vals[-q:], 0))
            return np.sum((r - np.diag(v) - b @ b.T) ** 2)
        gradient = uls_profile_gradient
        np.testing.assert_allclose(psi, 1 - np.sum(l * l, axis=1), atol=1e-12)
    assert fit["objective"] == pytest.approx(objective, abs=1e-11)
    step = 1e-6
    for probe in (point, np.linspace(.35, .65, len(point))):
        numerical_gradient = np.asarray([(oracle(probe + step * unit) - oracle(probe - step * unit)) / (2 * step)
                                         for unit in np.eye(len(probe))])
        np.testing.assert_allclose(gradient(probe, r, q), numerical_gradient, atol=2e-7)
    # The off-optimum probe makes a false all-zero gradient fail decisively.
    assert np.max(np.abs(gradient(np.linspace(.35, .65, len(point)), r, q))) > .01
    rotated = rotate_solution(l, psi, "promax")
    assert rotated["status"] == "success", rotated
    np.testing.assert_allclose(rotated["loadings"] @ rotated["phi"] @ rotated["loadings"].T,
                               l @ l.T, rtol=1e-9, atol=1e-10)


@pytest.mark.parametrize("scale,reverse", [("ordinal", False), ("ordinal", True), ("interval", False)])
def test_builtin_kakegawa_closed_domain_edit_excludes_outside_codes_in_all_analyses(scale, reverse):
    """Editing a declared domain must not give PCA/model inputs extra categories."""
    import copy

    frame, original = loaded("kakegawa-citizen2022-adult600")
    book = copy.deepcopy(original)
    spec = next(c for c in book["columns"] if c["name"] == "問20_満足度_01")
    spec.update(categoryOrder=["1", "2", "3"], isReversed=reverse, scaleType=scale)
    # Real shipped responses contain 4 as well as the 0/5 missing sentinels.
    assert frame[spec["name"]].to_list().count(4) > 0
    expected = independent_scores(frame, spec)
    summary = summarize(frame.select(spec["name"]), {spec["name"]: "numeric"}, codebook=book)[spec["name"]]
    assert summary["denominators"]["valid"] == int(np.isfinite(expected).sum())
    clean = expected[np.isfinite(expected)]
    for field, value in {"mean": clean.mean(), "std": clean.std(ddof=1),
                         "median": np.median(clean), "q1": np.quantile(clean, .25),
                         "q3": np.quantile(clean, .75)}.items():
        assert summary[field] == pytest.approx(value, abs=1e-12), (scale, reverse, field)
    assert summary["auxiliaryStats"]["mean"] == pytest.approx(clean.mean(), abs=.005)
    actual = CodebookAdapter(frame, book).analysis_series(spec["name"]).to_numpy()
    np.testing.assert_allclose(actual, expected, equal_nan=True, rtol=0, atol=0)


class BuiltinSnapshotStore:
    """Minimal immutable store for service-level contracts using real samples."""
    def __init__(self, sample_id):
        self.frame, self.book = loaded(sample_id)
        self.meta = {"dataRevision": 1, "schemaRevision": self.book["schemaRevision"], "fingerprint": sample_id}

    def lock(self, _dataset_id):
        from contextlib import nullcontext
        return nullcontext()

    def get_meta(self, _dataset_id):
        return self.meta

    def load_codebook(self, _dataset_id):
        return self.book

    def get_dataframe(self, _dataset_id, columns=None):
        return self.frame.select(columns) if columns is not None else self.frame

    def load_mask(self, _dataset_id):
        return {}


def test_builtin_census_saved_weights_are_refused_by_efa_and_sparse_pca():
    from app.domain.sparse_pca_frame import require_unweighted
    from app.services.factor_analysis_service import prepare_efa_frame

    store = BuiltinSnapshotStore("census-kdd-adult600")
    ctx = {"datasetId": "census", "expectedDataRevision": 1, "expectedSchemaRevision": 1, "weightMode": "dataset"}
    with pytest.raises(BizError) as sparse:
        require_unweighted(store.book, ctx)
    assert sparse.value.code == "SPCA_WEIGHT_UNSUPPORTED"
    require_unweighted(store.book, {**ctx, "weightMode": "none"})
    with pytest.raises(BizError) as efa:
        prepare_efa_frame("census", {"context": ctx, "variables": []}, store)
    assert efa.value.code == "FA_WEIGHT_UNSUPPORTED"


@pytest.mark.parametrize("sample_id", ["edss-efa-613x13", "edss-cfa-646x13", "atopp-541x31", "turkiye-student-evaluation-600"])
def test_builtin_ordinal_sparse_pca_requires_explicit_rank_acknowledgment(sample_id):
    from app.domain.sparse_pca_contracts import SparsePcaRequest
    from app.domain.sparse_pca_frame import prepare_sparse_pca_frame

    frame, book = loaded(sample_id)
    req = SparsePcaRequest.model_validate({"context": {"datasetId": sample_id, "expectedDataRevision": 1,
        "expectedSchemaRevision": 1, "weightMode": "none"},
        "variables": [{"columnId": c["columnId"], "kind": "numeric"} for c in book["columns"][:2]]})
    with pytest.raises(BizError) as exc:
        prepare_sparse_pca_frame(req, meta={"dataRevision": 1}, codebook=book, data=frame, mask={}, mask_revision=0)
    assert exc.value.code == "SPCA_ORDINAL_ACK_REQUIRED"


def test_edss_cfa_sample_cannot_silently_run_efa_as_cfa():
    from app.api.factor_analysis import _parse_request

    _, book = loaded("edss-cfa-646x13")
    with pytest.raises(BizError) as exc:
        _parse_request({"method": "cfa", "variables": [{"columnId": c["columnId"]} for c in book["columns"]]})
    assert exc.value.code == "ANALYSIS_REQUEST_INVALID"


@pytest.mark.parametrize("sample_id,model_type", [
    ("wine", "decision_tree"), ("wine", "random_forest"),
    ("kakegawa-citizen2022-adult600", "decision_tree")])
def test_builtin_model_importances_and_row_membership_match_sklearn(sample_id, model_type, monkeypatch):
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor
    from app.api import models

    store = BuiltinSnapshotStore(sample_id)
    monkeypatch.setattr(models, "store", store)
    monkeypatch.setattr(models, "_results", {})
    frame, book = store.frame, store.book
    if sample_id == "wine":
        names = ["Alcohol", "Malicacid", "Ash", "Alcalinity_of_ash"]
        target, task = "class", "classification"
    else:
        names = ["問20_満足度_01", "問20_満足度_02", "問20_満足度_03"]
        target, task = "問15_住みやすさ", "regression"
    by_name = {c["name"]: c for c in book["columns"]}
    x = np.column_stack([independent_scores(frame, by_name[name]) for name in names])
    y = frame[target].to_numpy() if task == "classification" else independent_scores(frame, by_name[target])
    valid = np.isfinite(x).all(axis=1) & np.isfinite(y)
    x, y = x[valid], y[valid]
    if model_type == "random_forest":
        oracle = RandomForestClassifier(n_estimators=7, max_depth=3, random_state=42).fit(x, y)
    else:
        model = DecisionTreeClassifier if task == "classification" else DecisionTreeRegressor
        oracle = model(max_depth=3, random_state=42).fit(x, y)
    actual = models.create_model(models.ModelRequest(datasetId=sample_id, features=names, target=target,
        modelType=model_type, taskType="auto", maxDepth=3, nEstimators=7, seed=42))
    assert actual["taskType"] == task
    assert actual["trainedRows"] == len(x)
    for name, expected in zip(names, oracle.feature_importances_):
        assert actual["featureImportance"][name] == pytest.approx(expected, abs=5.1e-7)
    ids = [rid for rid, keep in zip(frame["__rowId__"], valid) if keep]
    assert actual["rowIds"] == ids
    tree = oracle
    if model_type == "random_forest":
        predictions = oracle.predict(x)
        agreements = [np.mean(oracle.classes_[t.predict(x).astype(int)] == predictions) for t in oracle.estimators_]
        best = int(np.argmax(agreements))
        assert actual["representativeTree"]["index"] == best
        tree = oracle.estimators_[best]
    leaves = tree.apply(x)
    for membership in actual["leafMembership"]:
        assert membership["rowIds"] == [rid for rid, leaf in zip(ids, leaves) if leaf == membership["nodeId"]]


def test_builtin_yokohama_nominal_closed_domain_excludes_invalid_headline_frequencies():
    import copy

    frame, original = loaded("yokohama-citizen2022-adult600")
    book = copy.deepcopy(original)
    spec = next(c for c in book["columns"] if c["name"] == "F1")
    spec["categoryOrder"] = ["1"]
    actual = summarize(frame.select("F1"), {"F1": "categorical"}, codebook=book)["F1"]
    raw = [raw_code(value) for value in frame["F1"].to_list()]
    expected_valid = raw.count("1")
    assert actual["denominators"]["valid"] == expected_valid == 257
    assert actual["denominators"]["invalid"] == raw.count("2") == 329
    assert actual["count"] == expected_valid
    assert actual["uniqueCount"] == 1
    assert actual["frequencies"] == {"1": expected_valid}
    # The diagnostic raw distribution must still reveal excluded answers.
    invalid = next(item for item in actual["distribution"] if item["code"] == "2")
    assert invalid["isInvalid"] and invalid["count"] == 329
    assert CodebookAdapter(frame, book).analysis_series("F1").drop_nulls().to_list() == [1] * expected_valid


def test_builtin_efa_ml_initial_uniqueness_keeps_documented_solve_failure_fallback(monkeypatch):
    from app.algorithms.models import factor_analysis_ml

    frame, book = loaded("edss-efa-613x13")
    x = np.column_stack([independent_scores(frame, spec) for spec in book["columns"][:6]])
    r = np.corrcoef(x, rowvar=False)
    def failed_solve(*_args, **_kwargs):
        raise np.linalg.LinAlgError("forced initialization solve failure")
    monkeypatch.setattr(factor_analysis_ml.linalg, "solve", failed_solve)
    q, lower = 1, .005
    expected = np.clip(np.full(len(r), (1 - .5 * q / len(r)) / .5), lower, 1)
    np.testing.assert_array_equal(factor_analysis_ml._initial_psi(r, q, lower), expected)
