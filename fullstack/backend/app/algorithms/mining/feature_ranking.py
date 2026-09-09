"""Feature Ranking and Multi-criteria Feature Selection Engine (Feature 14).

Implements:
- ReliefF (Custom NumPy implementation for classification and regression)
- Mutual Information (sklearn)
- Random Forest MDI & Permutation Importance (sklearn)
- ANOVA F-statistic / F-regression (sklearn)
- PCA Dispersion (unsupervised)
- Borda Count Rank Aggregation
"""
from __future__ import annotations

import time
from typing import Any, Dict, List, Optional
import numpy as np
import polars as pl
from scipy import stats
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.feature_selection import (
    f_classif,
    f_regression,
    mutual_info_classif,
    mutual_info_regression,
)
from sklearn.inspection import permutation_importance
from sklearn.preprocessing import LabelEncoder


def _infer_task_type(target_series: pl.Series) -> str:
    """Infer classification, regression, or unsupervised."""
    dtype = target_series.dtype
    if dtype in (pl.String, pl.Categorical, pl.Boolean):
        return "classification"
    values = [v for v in target_series.to_list() if v is not None and not (isinstance(v, float) and np.isnan(v))]
    if not values:
        return "regression"
    unique_vals = set(values)
    if all(float(v) == int(v) for v in unique_vals) and len(unique_vals) <= 10:
        return "classification"
    return "regression"


def _custom_relieff(
    X: np.ndarray,
    y: np.ndarray,
    task_type: str,
    k: int = 10,
    m: int = 500,
    seed: int = 42,
) -> np.ndarray:
    """NumPy-based ReliefF algorithm for classification and regression.

    Returns weight vector of shape (n_features,).
    """
    n_samples, n_features = X.shape
    if n_samples <= 1:
        return np.zeros(n_features)

    # Normalize features to [0, 1]
    mins = np.nanmin(X, axis=0)
    maxs = np.nanmax(X, axis=0)
    ranges = maxs - mins
    ranges[ranges == 0] = 1.0
    X_norm = (X - mins) / ranges

    m_samples = min(n_samples, max(1, m))
    rng = np.random.default_rng(seed)
    sampled_indices = rng.choice(n_samples, size=m_samples, replace=False)

    weights = np.zeros(n_features)
    k_eff = min(k, n_samples - 1)
    if k_eff < 1:
        return weights

    if task_type == "classification":
        classes, class_counts = np.unique(y, return_counts=True)
        class_probs = {c: count / n_samples for c, count in zip(classes, class_counts)}

        # Pre-organize sample indices by class
        class_indices = {c: np.where(y == c)[0] for c in classes}

        for idx in sampled_indices:
            xi = X_norm[idx]
            yi = y[idx]

            # 1. Near hits (same class)
            same_cls_idx = class_indices[yi]
            same_cls_candidates = same_cls_idx[same_cls_idx != idx]
            if len(same_cls_candidates) > 0:
                dists = np.sum(np.abs(X_norm[same_cls_candidates] - xi), axis=1)
                k_hits = min(k_eff, len(same_cls_candidates))
                nearest_hit_idx = same_cls_candidates[np.argsort(dists)[:k_hits]]
                hit_diffs = np.mean(np.abs(xi - X_norm[nearest_hit_idx]), axis=0)
                weights -= hit_diffs / m_samples

            # 2. Near misses (other classes)
            p_yi = class_probs[yi]
            denom = 1.0 - p_yi if (1.0 - p_yi) > 0 else 1.0

            for c in classes:
                if c == yi:
                    continue
                diff_cls_idx = class_indices[c]
                if len(diff_cls_idx) == 0:
                    continue
                dists = np.sum(np.abs(X_norm[diff_cls_idx] - xi), axis=1)
                k_miss = min(k_eff, len(diff_cls_idx))
                nearest_miss_idx = diff_cls_idx[np.argsort(dists)[:k_miss]]
                miss_diffs = np.mean(np.abs(xi - X_norm[nearest_miss_idx]), axis=0)
                p_c = class_probs[c]
                weights += (p_c / denom) * miss_diffs / m_samples

    else:  # Regression ReliefF
        y_min, y_max = np.nanmin(y), np.nanmax(y)
        y_range = y_max - y_min if (y_max - y_min) > 0 else 1.0
        y_norm = (y - y_min) / y_range

        for idx in sampled_indices:
            xi = X_norm[idx]
            yi = y_norm[idx]

            all_other_idx = np.arange(n_samples)
            all_other_idx = all_other_idx[all_other_idx != idx]
            dists = np.sum(np.abs(X_norm[all_other_idx] - xi), axis=1)
            nearest = all_other_idx[np.argsort(dists)[:k_eff]]

            for neighbor in nearest:
                dy = abs(yi - y_norm[neighbor])
                dx = np.abs(xi - X_norm[neighbor])
                weights += (dy * dx) / (m_samples * k_eff)

    return weights


def _borda_rank(scores_dict: Dict[str, Dict[str, Optional[float]]], features: List[str]) -> Dict[str, Any]:
    """Computes normalized scores, ranks per method, and aggregates with Borda count.

    Handles ties with average rank and gracefully excludes skipped (None) methods.
    """
    method_normalized: Dict[str, Dict[str, Optional[float]]] = {}
    method_ranks: Dict[str, Dict[str, Optional[float]]] = {}

    for method, scores in scores_dict.items():
        valid_feats = [f for f in features if scores.get(f) is not None]
        method_normalized[method] = {}
        method_ranks[method] = {}

        if len(valid_feats) > 0:
            vals = [float(scores[f]) for f in valid_feats]
            min_v = min(vals)
            max_v = max(vals)
            range_v = max_v - min_v if (max_v - min_v) > 1e-12 else 1.0

            for f in valid_feats:
                v = float(scores[f])
                method_normalized[method][f] = float(np.clip((v - min_v) / range_v, 0.0, 1.0))

            ranks = stats.rankdata([-v for v in vals], method="average")
            for f, r in zip(valid_feats, ranks):
                method_ranks[method][f] = float(r)

        for f in features:
            if f not in method_normalized[method]:
                method_normalized[method][f] = None
                method_ranks[method][f] = None

    # Aggregate Borda scores
    borda_scores: Dict[str, float] = {}
    for f in features:
        score = 0.0
        for method in scores_dict:
            r = method_ranks[method].get(f)
            if r is not None:
                p_m = sum(1 for feat in features if method_ranks[method].get(feat) is not None)
                score += (p_m - r + 1)
        borda_scores[f] = score

    # Sort features by Borda score descending
    def sort_key(f: str) -> tuple[float, float]:
        norm_scores = [
            method_normalized[m][f]
            for m in scores_dict
            if method_normalized[m].get(f) is not None
        ]
        mean_norm = float(np.mean(norm_scores)) if norm_scores else 0.0
        return (-borda_scores[f], -mean_norm)

    sorted_features = sorted(features, key=sort_key)
    overall_ranks = {f: i + 1 for i, f in enumerate(sorted_features)}

    return {
        "borda_scores": borda_scores,
        "overall_ranks": overall_ranks,
        "method_ranks": method_ranks,
        "method_normalized": method_normalized,
    }


def compute_feature_rankings(
    df: pl.DataFrame,
    feature_columns: List[str],
    target_column: Optional[str] = None,
    active_row_ids: Optional[List[str]] = None,
    methods: Optional[List[str]] = None,
    k_neighbors: int = 10,
    relieff_sample_size: Optional[int] = None,
    n_estimators: int = 100,
    use_permutation_importance: bool = False,
    seed: int = 42,
) -> Dict[str, Any]:
    """Calculates multi-criteria feature rankings."""
    start_time = time.perf_counter()

    if methods is None or len(methods) == 0:
        methods = ["relieff", "mutual_info", "random_forest", "f_statistic", "pca_dispersion"]

    # Filter active rows if specified
    if active_row_ids is not None:
        row_id_col = "__rowId__" if "__rowId__" in df.columns else df.columns[0]
        df = df.filter(pl.col(row_id_col).is_in(active_row_ids))

    n_rows = df.height
    if n_rows == 0:
        raise ValueError("対象データ行が0件です。")

    # Determine task type
    if target_column is None or target_column not in df.columns:
        task_type = "unsupervised"
        target_series = None
    else:
        target_series = df[target_column]
        task_type = _infer_task_type(target_series)

    # Valid feature columns (exclude target)
    valid_features = [f for f in feature_columns if f in df.columns and f != target_column]
    if len(valid_features) == 0:
        raise ValueError("評価対象の特徴量列が指定されていません。")

    # Prepare feature matrix X (numeric or ordinal-encoded)
    X_cols = []
    numeric_feature_names = []
    for col_name in valid_features:
        s = df[col_name]
        if s.dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64):
            arr = s.fill_nan(None).to_numpy()
            median_val = float(np.nanmedian(arr)) if np.any(~np.isnan(arr)) else 0.0
            arr = np.nan_to_num(arr, nan=median_val)
            X_cols.append(arr.astype(float))
            numeric_feature_names.append(col_name)
        else:
            # Categorical: Label encode
            str_vals = [str(v) if v is not None else "__MISSING__" for v in s.to_list()]
            le = LabelEncoder()
            arr = le.fit_transform(str_vals)
            X_cols.append(arr.astype(float))

    X = np.column_stack(X_cols)

    # Prepare target vector y if supervised
    y: Optional[np.ndarray] = None
    discrete_mask = [col not in numeric_feature_names for col in valid_features]

    if task_type == "classification" and target_series is not None:
        target_vals = [str(v) if v is not None else "__MISSING__" for v in target_series.to_list()]
        y = LabelEncoder().fit_transform(target_vals)
        if len(np.unique(y)) < 2:
            task_type = "unsupervised"
            y = None
    elif task_type == "regression" and target_series is not None:
        raw_y = target_series.fill_nan(None).to_numpy()
        median_y = float(np.nanmedian(raw_y)) if np.any(~np.isnan(raw_y)) else 0.0
        y = np.nan_to_num(raw_y, nan=median_y).astype(float)
        if np.all(y == y[0]):
            task_type = "unsupervised"
            y = None

    scores_by_method: Dict[str, Dict[str, float]] = {}

    # 1. ReliefF
    if "relieff" in methods:
        sample_size = relieff_sample_size or min(n_rows, 500)
        if task_type != "unsupervised" and y is not None:
            r_scores = _custom_relieff(X, y, task_type, k=k_neighbors, m=sample_size, seed=seed)
        else:
            # Unsupervised ReliefF: variance-weighted distance contrast
            var_weights = np.nanvar(X, axis=0)
            r_scores = np.nan_to_num(var_weights)
        scores_by_method["relieff"] = {f: float(r_scores[i]) for i, f in enumerate(valid_features)}

    # 2. Mutual Information
    if "mutual_info" in methods:
        if task_type == "classification" and y is not None:
            mi = mutual_info_classif(
                X, y, discrete_features=discrete_mask, n_neighbors=k_neighbors, random_state=seed
            )
            scores_by_method["mutualInfo"] = {f: float(mi[i]) for i, f in enumerate(valid_features)}
        elif task_type == "regression" and y is not None:
            mi = mutual_info_regression(
                X, y, discrete_features=discrete_mask, n_neighbors=k_neighbors, random_state=seed
            )
            scores_by_method["mutualInfo"] = {f: float(mi[i]) for i, f in enumerate(valid_features)}
        else:
            # Unsupervised MI proxy: average correlation with other features
            if len(valid_features) > 1:
                corr_mat = np.abs(np.corrcoef(X, rowvar=False))
                np.fill_diagonal(corr_mat, 0.0)
                mean_corr = np.nanmean(corr_mat, axis=1)
                scores_by_method["mutualInfo"] = {f: float(mean_corr[i]) for i, f in enumerate(valid_features)}

    # 3. Random Forest (MDI & optional MDA)
    if "random_forest" in methods:
        if task_type == "classification" and y is not None:
            clf = RandomForestClassifier(n_estimators=n_estimators, random_state=seed, max_depth=6)
            clf.fit(X, y)
            importances = clf.feature_importances_
            if use_permutation_importance and n_rows >= 10:
                perm = permutation_importance(clf, X, y, n_repeats=5, random_state=seed)
                importances = (importances + np.maximum(0, perm.importances_mean)) / 2.0
            scores_by_method["randomForest"] = {f: float(importances[i]) for i, f in enumerate(valid_features)}
        elif task_type == "regression" and y is not None:
            reg = RandomForestRegressor(n_estimators=n_estimators, random_state=seed, max_depth=6)
            reg.fit(X, y)
            importances = reg.feature_importances_
            if use_permutation_importance and n_rows >= 10:
                perm = permutation_importance(reg, X, y, n_repeats=5, random_state=seed)
                importances = (importances + np.maximum(0, perm.importances_mean)) / 2.0
            scores_by_method["randomForest"] = {f: float(importances[i]) for i, f in enumerate(valid_features)}

    # 4. F-Statistic / ANOVA
    if "f_statistic" in methods and task_type != "unsupervised" and y is not None:
        num_indices = [i for i, f in enumerate(valid_features) if f in numeric_feature_names]
        if len(num_indices) > 0:
            X_num = X[:, num_indices]
            if task_type == "classification":
                f_vals, _ = f_classif(X_num, y)
            else:
                f_vals, _ = f_regression(X_num, y)
            f_vals = np.nan_to_num(f_vals, nan=0.0)
            f_map = {valid_features[idx]: float(f_vals[k]) for k, idx in enumerate(num_indices)}
        else:
            f_map = {}
        scores_by_method["fStatistic"] = {f: f_map.get(f) for f in valid_features}

    # 5. PCA Dispersion
    if "pca_dispersion" in methods or task_type == "unsupervised":
        num_indices = [i for i, f in enumerate(valid_features) if f in numeric_feature_names]
        if len(num_indices) >= 2:
            X_num = X[:, num_indices]
            stds = np.std(X_num, axis=0)
            stds[stds == 0] = 1.0
            X_std = (X_num - np.mean(X_num, axis=0)) / stds
            cov = np.cov(X_std, rowvar=False)
            if np.ndim(cov) == 2:
                eigvals, eigvecs = np.linalg.eigh(cov)
                idx = np.argsort(eigvals)[::-1]
                eigvals = eigvals[idx]
                eigvecs = eigvecs[:, idx]
                total_var = np.sum(np.maximum(0, eigvals))
                evr = np.maximum(0, eigvals) / (total_var if total_var > 0 else 1.0)

                n_comps = min(3, len(num_indices))
                pca_scores = np.zeros(len(num_indices))
                for c in range(n_comps):
                    pca_scores += evr[c] * (eigvecs[:, c] ** 2)
                pca_map = {valid_features[idx]: float(pca_scores[k]) for k, idx in enumerate(num_indices)}
            else:
                pca_map = {}
        else:
            pca_map = {}
        scores_by_method["pcaDispersion"] = {f: pca_map.get(f) for f in valid_features}

    # If no methods yielded scores, fallback to variance
    if len(scores_by_method) == 0:
        variances = np.var(X, axis=0)
        scores_by_method["relieff"] = {f: float(variances[i]) for i, f in enumerate(valid_features)}

    # Mean Redundancy (average correlation with other features)
    if len(valid_features) > 1:
        corr_matrix = np.abs(np.corrcoef(X, rowvar=False))
        np.fill_diagonal(corr_matrix, 0.0)
        redundancy_map = {f: float(np.nanmean(corr_matrix[i])) for i, f in enumerate(valid_features)}
    else:
        corr_matrix = np.zeros((1, 1))
        redundancy_map = {valid_features[0]: 0.0}

    # Borda aggregation
    borda_res = _borda_rank(scores_by_method, valid_features)
    borda_scores = borda_res["borda_scores"]
    overall_ranks = borda_res["overall_ranks"]
    method_ranks = borda_res["method_ranks"]
    method_normalized = borda_res["method_normalized"]

    p = len(valid_features)
    rankings = []
    for f in valid_features:
        rank = overall_ranks[f]
        tier = "high" if rank <= max(1, int(p * 0.35)) else ("medium" if rank <= max(2, int(p * 0.70)) else "low")
        scores_item: Dict[str, Any] = {}
        for m_key, scores_m in scores_by_method.items():
            raw_v = scores_m.get(f)
            norm_v = method_normalized[m_key].get(f)
            rank_v = method_ranks[m_key].get(f)
            if raw_v is not None and norm_v is not None and rank_v is not None:
                scores_item[m_key] = {
                    "rawScore": round(float(raw_v), 6),
                    "normalizedScore": round(float(norm_v), 4),
                    "rank": round(float(rank_v), 2),
                }
            else:
                scores_item[m_key] = None

        rankings.append({
            "variable": f,
            "bordaScore": round(float(borda_scores[f]), 2),
            "overallRank": int(rank),
            "recommendationTier": tier,
            "meanRedundancy": round(float(redundancy_map.get(f, 0.0)), 4),
            "scores": scores_item,
        })

    rankings.sort(key=lambda x: x["overallRank"])

    suggested_top_k = min(len(valid_features), max(2, int(len(valid_features) * 0.5)))
    execution_time_ms = (time.perf_counter() - start_time) * 1000.0

    return {
        "target": target_column,
        "taskType": task_type,
        "evaluatedVariables": valid_features,
        "redundancyMatrix": np.nan_to_num(corr_matrix, nan=0.0).tolist(),
        "rankings": rankings,
        "suggestedTopK": suggested_top_k,
        "executionTimeMs": round(execution_time_ms, 2),
        "evidenceClass": "SLIDES-2005",
    }
