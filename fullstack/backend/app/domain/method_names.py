"""Canonical display names for approximate methods (Feature 23).

Internal routing keys stay untouched so in-flight callers keep working.
Only user-facing display names, tooltips, formulas, and scopes change.
"""
from __future__ import annotations

METHOD_DISPLAY: dict[str, dict[str, str]] = {
    "tabdiff": {
        "displayName": "実験的条件付き補完",
        "formula": "Gaussian条件付き平均と周辺頻度による近似",
        "scope": "欠損補完の実験機能",
        "deprecatedAlias": "TabDiff",
    },
    "phik": {
        "displayName": "補正V（Cramér's V系）",
        "formula": "補正Cramér's V系。公式PhiKとは呼ばない",
        "scope": "カテゴリ関連（Surprise）",
        "deprecatedAlias": "Φk / Phik",
    },
    "mutual_info_unsupervised": {
        "displayName": "平均絶対相関（教師なし代理指標）",
        "formula": "他特徴量との絶対相関の平均",
        "scope": "targetなしの特徴ランキング",
        "deprecatedAlias": "相互情報量（教師なし）",
    },
    "mutual_info_supervised": {
        "displayName": "相互情報量",
        "formula": "mutual_info_classif / mutual_info_regression",
        "scope": "targetありの特徴ランキング",
        "deprecatedAlias": "",
    },
    "wasserstein": {
        "displayName": "絶対平均差",
        "formula": "平均差の絶対値",
        "scope": "TabDiff診断の分布差",
        "deprecatedAlias": "Wasserstein距離",
    },
    "relieff_unsupervised": {
        "displayName": "分散（教師なし代理指標）",
        "formula": "列分散",
        "scope": "targetなしの特徴ランキング",
        "deprecatedAlias": "ReliefF（教師なし）",
    },
    "relieff_supervised": {
        "displayName": "ReliefF",
        "formula": "教師ありReliefF近似",
        "scope": "targetありの特徴ランキング",
        "deprecatedAlias": "",
    },
}


def display_of(key: str) -> dict[str, str]:
    entry = METHOD_DISPLAY.get(key)
    if entry is None:
        return {"displayName": key, "formula": "", "scope": "", "deprecatedAlias": ""}
    return dict(entry)
