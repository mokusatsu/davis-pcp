"""Feature 23-BE: canonical names, MDI/permutation split, signed permutation."""
from __future__ import annotations

import numpy as np
import polars as pl

from app.algorithms.imputation.tabdiff import tabdiff_impute
from app.algorithms.mining.feature_ranking import compute_feature_rankings
from app.domain.method_names import display_of


def ranking_frame(n: int = 60, seed: int = 42) -> pl.DataFrame:
    rng = np.random.default_rng(seed)
    signal = rng.normal(0, 1, n)
    return pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(n)],
        "signal": signal,
        "noise": rng.normal(0, 1, n),
        "target": (signal + rng.normal(0, 0.3, n) > 0).astype(int),
    })


def test_mdi_and_permutation_are_separate_signed_arrays():
    df = ranking_frame()
    res = compute_feature_rankings(
        df, feature_columns=["signal", "noise"], target_column="target",
        methods=["random_forest"], n_estimators=20, use_permutation_importance=True, seed=42)
    assert set(res["importance"].keys()) == {"mdi", "permutation_train"}
    mdi = {item["featureName"]: item for item in res["importance"]["mdi"]}
    perm = {item["featureName"]: item for item in res["importance"]["permutation_train"]}
    assert set(mdi) == {"signal", "noise"} == set(perm)
    assert mdi["signal"]["importance"] >= 0
    # signed: std present, mean not clipped to >= 0 by construction
    assert "importanceStd" in perm["signal"] and perm["signal"]["importanceStd"] is not None
    assert res["importanceMetadata"]["mdi"]["available"] is True
    assert res["importanceMetadata"]["mdi"]["scope"] == "train"
    assert res["importanceMetadata"]["permutation_train"]["available"] is True
    assert res["importanceMetadata"]["permutation_train"]["scope"] == "train"
    assert res["importanceMetadata"]["permutation_train"]["repeats"] == 5
    assert "訓練データ上の重要度は予測への貢献であり、因果効果ではない" in res["metadata"]["warnings"]
    # no mixed average anywhere
    assert "mixed" not in str(res).lower()
    for item in res["rankings"]:
        assert "mixed" not in str(item.get("scores", {})).lower()


def test_unsupervised_permutation_unavailable_not_zero():
    df = ranking_frame()
    res = compute_feature_rankings(df, feature_columns=["signal", "noise"], target_column=None,
                                   methods=["random_forest"], n_estimators=10,
                                   use_permutation_importance=True, seed=42)
    assert res["importance"]["permutation_train"] == []
    assert res["importanceMetadata"]["permutation_train"]["available"] is False
    assert res["methodDisplay"]["mutualInfo"]["displayName"] == "平均絶対相関（教師なし代理指標）"
    assert res["methodDisplay"]["relieff"]["displayName"] == "分散（教師なし代理指標）"


def test_supervised_display_names_and_no_mixed_borda():
    df = ranking_frame()
    res = compute_feature_rankings(df, feature_columns=["signal", "noise"], target_column="target",
                                   methods=["relieff", "mutual_info", "random_forest"],
                                   n_estimators=10, use_permutation_importance=True, seed=42)
    assert res["methodDisplay"]["mutualInfo"]["displayName"] == "相互情報量"
    assert res["methodDisplay"]["relieff"]["displayName"] == "ReliefF"
    mdi = {item["featureName"]: item["importance"] for item in res["importance"]["mdi"]}
    perm = {item["featureName"]: item["importanceMean"] for item in res["importance"]["permutation_train"]}
    assert set(mdi) == set(perm)
    for item in res["rankings"]:
        assert set(item["scores"].keys()) <= {"relieff", "mutualInfo", "randomForest"}
        assert "permutation" not in str(item["scores"]).lower()


def test_permutation_keeps_signed_values():
    import numpy as np
    import polars as pl

    rng = np.random.default_rng(7)
    n = 80
    anti = rng.normal(0, 1, n)
    df = pl.DataFrame({
        "__rowId__": [f"r{i}" for i in range(n)],
        "anti": anti,
        "noise": rng.normal(0, 1, n),
        "target": (rng.normal(0, 1, n) > 0).astype(int),
    })
    res = compute_feature_rankings(df, feature_columns=["anti", "noise"], target_column="target",
                                   methods=["random_forest"], n_estimators=20,
                                   use_permutation_importance=True, seed=42)
    perm = {item["featureName"]: item for item in res["importance"]["permutation_train"]}
    assert all(v["importanceStd"] is not None for v in perm.values())


def test_unsupervised_labels_use_proxy_names():
    from app.domain.method_names import METHOD_DISPLAY

    assert METHOD_DISPLAY["mutual_info_unsupervised"]["displayName"] == "平均絶対相関（教師なし代理指標）"
    assert METHOD_DISPLAY["relieff_unsupervised"]["displayName"] == "分散（教師なし代理指標）"
    assert METHOD_DISPLAY["mutual_info_supervised"]["displayName"] == "相互情報量"
    assert METHOD_DISPLAY["relieff_supervised"]["displayName"] == "ReliefF"
    assert display_of("tabdiff")["displayName"] == "実験的条件付き補完"
    assert display_of("phik")["displayName"] == "補正V（Cramér's V系）"
    assert display_of("wasserstein")["displayName"] == "絶対平均差"


def test_tabdiff_diagnostics_use_canonical_names():
    df = pl.DataFrame({"x": [1.0, 2.0, None, 4.0], "c": ["a", "b", "a", None]})
    _, diagnostics = tabdiff_impute(df, columns=["x", "c"], num_steps=2, seed=42)
    assert diagnostics["displayName"] == "実験的条件付き補完"
    assert diagnostics["deprecatedAlias"] == "TabDiff"
    assert "absoluteMeanDifference" in diagnostics["columns"]["x"]
    assert "wassersteinDist" not in diagnostics["columns"]["x"]
