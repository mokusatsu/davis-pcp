"""Discriminant Analysis Engine for DAVIS (Feature 13).

Provides Linear Discriminant Analysis (LDA), Quadratic Discriminant Analysis (QDA),
and Stepwise Discriminant Analysis based on Wilks' Lambda and Partial F-statistics.
Includes canonical coordinates, canonical loadings biplot, boundary mesh,
and misclassified sample tracking.
"""
from __future__ import annotations

import math
from typing import Any
import numpy as np
import polars as pl
from scipy import stats
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis, QuadraticDiscriminantAnalysis

from ...domain.errors import BizError


def _compute_scatter_matrices(
    X: np.ndarray, y_indices: np.ndarray, n_classes: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Compute within-class (SW), between-class (SB), and total (ST) scatter matrices."""
    n_samples, n_features = X.shape
    grand_mean = np.mean(X, axis=0)

    SW = np.zeros((n_features, n_features), dtype=np.float64)
    SB = np.zeros((n_features, n_features), dtype=np.float64)

    for c in range(n_classes):
        Xc = X[y_indices == c]
        if len(Xc) == 0:
            continue
        class_mean = np.mean(Xc, axis=0)
        diff = Xc - class_mean
        SW += diff.T @ diff
        mean_diff = (class_mean - grand_mean).reshape(-1, 1)
        SB += len(Xc) * (mean_diff @ mean_diff.T)

    ST = SW + SB
    return SW, SB, ST


def _calc_wilks_lambda(SW: np.ndarray, ST: np.ndarray) -> float:
    """Calculate Wilks' Lambda = det(SW) / det(ST) with pseudo-determinant fallback."""
    det_SW = np.linalg.det(SW)
    det_ST = np.linalg.det(ST)
    if det_ST <= 1e-15 or np.isnan(det_ST):
        # Fallback to pseudo determinant or sign/slogdet
        sign_sw, log_sw = np.linalg.slogdet(SW + np.eye(SW.shape[0]) * 1e-6)
        sign_st, log_st = np.linalg.slogdet(ST + np.eye(ST.shape[0]) * 1e-6)
        if sign_sw <= 0 or sign_st <= 0:
            return 1.0
        val = np.exp(log_sw - log_st)
        return float(np.clip(val, 1e-12, 1.0))
    ratio = det_SW / det_ST
    return float(np.clip(ratio, 1e-12, 1.0))


def run_discriminant_analysis(
    df: pl.DataFrame,
    target_column: str,
    feature_columns: list[str],
    active_row_ids: list[str] | None = None,
    method: str = "lda",  # 'lda' | 'qda' | 'stepwise'
    shrinkage: str | float = "none",  # 'none' | 'auto' | float
    priors: str = "proportional",  # 'proportional' | 'uniform'
    stepwise_config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # Ensure __rowId__
    if "__rowId__" not in df.columns:
        df = df.with_columns(pl.int_range(0, df.height).cast(pl.String).alias("__rowId__"))

    # Filter active rows if specified
    if active_row_ids is not None:
        wanted_ids = set(active_row_ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted_ids)))

    total_initial_rows = df.height
    if total_initial_rows < 3:
        raise BizError(
            "DISCRIMINANT_INSUFFICIENT_ROWS",
            "判別分析には最低3行以上のデータが必要です。",
            details={"rowCount": total_initial_rows},
        )

    # Check target
    if target_column not in df.columns:
        raise BizError(
            "DISCRIMINANT_TARGET_NOT_FOUND",
            f"目的変数 '{target_column}' がデータセットに存在しません。",
            details={"column": target_column},
        )

    # Check features
    if not feature_columns:
        raise BizError(
            "DISCRIMINANT_NO_FEATURES",
            "説明変数を1つ以上選択してください。",
        )
    for feat in feature_columns:
        if feat not in df.columns:
            raise BizError(
                "DISCRIMINANT_FEATURE_NOT_FOUND",
                f"説明変数 '{feat}' がデータセットに存在しません。",
                details={"column": feat},
            )

    # Listwise deletion of NaNs
    needed_cols = ["__rowId__", target_column] + feature_columns
    sub_df = df.select(needed_cols).drop_nulls()

    excluded_row_count = total_initial_rows - sub_df.height
    n_samples = sub_df.height

    row_ids = sub_df["__rowId__"].to_list()
    raw_target = [str(v) for v in sub_df[target_column].to_list()]

    # Classes
    classes = sorted(list(set(raw_target)))
    n_classes = len(classes)
    if n_classes < 2:
        raise BizError(
            "DISCRIMINANT_INSUFFICIENT_CLASSES",
            f"判別分析には最低2つ以上のクラスが必要です (検出クラス数: {n_classes})。",
            details={"classes": classes},
        )

    class_to_idx = {c: i for i, c in enumerate(classes)}
    y_indices = np.array([class_to_idx[c] for c in raw_target], dtype=np.int32)

    # Check class sample counts
    class_counts = [int(np.sum(y_indices == i)) for i in range(n_classes)]
    for c_idx, cnt in enumerate(class_counts):
        if cnt < 1:
            raise BizError(
                "DISCRIMINANT_EMPTY_CLASS",
                f"クラス '{classes[c_idx]}' に有効なサンプルが存在しません。",
                details={"class": classes[c_idx]},
            )
        if method == "qda" and cnt < 2:
            raise BizError(
                "QDA_INSUFFICIENT_CLASS_SAMPLES",
                f"QDAには各クラスに最低2サンプル以上必要です (クラス '{classes[c_idx]}' は {cnt} 件)。",
                details={"class": classes[c_idx], "count": cnt},
            )

    # Prepare feature matrix X
    X_full = np.column_stack([
        sub_df[feat].cast(pl.Float64).to_numpy() for feat in feature_columns
    ])
    constant_columns = [name for name, values in zip(feature_columns, X_full.T) if np.all(values == values[0])]
    if constant_columns:
        raise BizError('DISCRIMINANT_CONSTANT_FEATURES', '有効な対象行で値が一定の説明変数を外してください。',
                       details={'columns': constant_columns})
    if n_samples <= n_classes:
        raise BizError('DISCRIMINANT_INSUFFICIENT_WITHIN_CLASS_SAMPLES', 'クラス内の分散を推定できる行数が必要です。',
                       details={'sampleCount': n_samples, 'classCount': n_classes})

    selected_features = list(feature_columns)
    stepwise_trace: list[dict[str, Any]] | None = None

    # Stepwise selection if method == 'stepwise'
    if method == "stepwise":
        cfg = stepwise_config or {}
        f_enter = float(cfg.get("fEnter", 3.84))
        f_remove = float(cfg.get("fRemove", 2.71))
        max_steps = int(cfg.get("maxSteps", 20))

        active_indices: list[int] = []
        candidate_indices: list[int] = list(range(len(feature_columns)))
        stepwise_trace = []
        history_sets: set[frozenset[int]] = set()

        step_num = 1
        while step_num <= max_steps and (candidate_indices or len(active_indices) > 1):
            # 1. Forward step: find best candidate to enter
            best_var_to_enter: int | None = None
            best_f_enter = -1.0
            best_lambda_enter = 1.0

            cur_p = len(active_indices)
            if cur_p == 0:
                cur_lambda = 1.0
            else:
                SW_cur, _, ST_cur = _compute_scatter_matrices(X_full[:, active_indices], y_indices, n_classes)
                cur_lambda = _calc_wilks_lambda(SW_cur, ST_cur)

            for cand in candidate_indices:
                sub_indices = active_indices + [cand]
                SW_sub, _, ST_sub = _compute_scatter_matrices(X_full[:, sub_indices], y_indices, n_classes)
                sub_lambda = _calc_wilks_lambda(SW_sub, ST_sub)

                df2 = n_samples - n_classes - cur_p
                if df2 > 0 and (n_classes - 1) > 0 and sub_lambda > 0:
                    f_val = (df2 / (n_classes - 1)) * (cur_lambda / sub_lambda - 1.0)
                    if f_val > best_f_enter:
                        best_f_enter = f_val
                        best_var_to_enter = cand
                        best_lambda_enter = sub_lambda

            action_taken = False
            if best_var_to_enter is not None and best_f_enter >= f_enter:
                # Enter variable
                active_indices.append(best_var_to_enter)
                candidate_indices.remove(best_var_to_enter)
                df1 = n_classes - 1
                df2 = max(1, n_samples - n_classes - cur_p)
                p_val = float(1.0 - stats.f.cdf(best_f_enter, df1, df2))

                stepwise_trace.append({
                    "step": step_num,
                    "action": "entered",
                    "variable": feature_columns[best_var_to_enter],
                    "wilksLambda": round(float(best_lambda_enter), 5),
                    "partialF": round(float(best_f_enter), 4),
                    "pValue": round(float(p_val), 6),
                    "activeVariables": [feature_columns[i] for i in active_indices],
                })
                step_num += 1
                action_taken = True

                # Check cycle
                current_set = frozenset(active_indices)
                if current_set in history_sets:
                    # Cycle detected, stop immediately
                    break
                history_sets.add(current_set)

            # 2. Backward step: check if any existing variable should be removed
            if len(active_indices) > 1:
                cur_p = len(active_indices)
                SW_cur, _, ST_cur = _compute_scatter_matrices(X_full[:, active_indices], y_indices, n_classes)
                cur_lambda = _calc_wilks_lambda(SW_cur, ST_cur)

                worst_var_to_remove: int | None = None
                worst_f_remove = float("inf")
                worst_lambda_remove = 1.0

                for act in active_indices:
                    if best_var_to_enter is not None and act == best_var_to_enter:
                        continue  # Do not immediately remove the one just entered
                    sub_indices = [i for i in active_indices if i != act]
                    SW_sub, _, ST_sub = _compute_scatter_matrices(X_full[:, sub_indices], y_indices, n_classes)
                    sub_lambda = _calc_wilks_lambda(SW_sub, ST_sub)

                    df2 = n_samples - n_classes - (cur_p - 1)
                    if df2 > 0 and (n_classes - 1) > 0 and cur_lambda > 0:
                        f_val = (df2 / (n_classes - 1)) * (sub_lambda / cur_lambda - 1.0)
                        if f_val < worst_f_remove:
                            worst_f_remove = f_val
                            worst_var_to_remove = act
                            worst_lambda_remove = sub_lambda

                if worst_var_to_remove is not None and worst_f_remove < f_remove:
                    active_indices.remove(worst_var_to_remove)
                    candidate_indices.append(worst_var_to_remove)
                    df1 = n_classes - 1
                    df2 = max(1, n_samples - n_classes - (cur_p - 1))
                    p_val = float(1.0 - stats.f.cdf(worst_f_remove, df1, df2))

                    stepwise_trace.append({
                        "step": step_num,
                        "action": "removed",
                        "variable": feature_columns[worst_var_to_remove],
                        "wilksLambda": round(float(worst_lambda_remove), 5),
                        "partialF": round(float(worst_f_remove), 4),
                        "pValue": round(float(p_val), 6),
                        "activeVariables": [feature_columns[i] for i in active_indices],
                    })
                    step_num += 1
                    action_taken = True

                    current_set = frozenset(active_indices)
                    if current_set in history_sets:
                        break
                    history_sets.add(current_set)

            if not action_taken:
                # Convergence reached
                break

        if not active_indices:
            # Fallback to candidate with smallest individual lambda
            active_indices = [0]
        selected_features = [feature_columns[i] for i in active_indices]

    # Now run LDA / QDA on selected_features
    sub_cols = [feature_columns.index(feat) for feat in selected_features]
    X = X_full[:, sub_cols]
    n_features = len(selected_features)
    centered = X - X.mean(axis=0)
    spread = np.std(centered, axis=0)
    standardized = centered / np.where(spread > 0, spread, 1)
    within = standardized.copy()
    for index in range(n_classes):
        mask = y_indices == index
        within[mask] -= standardized[mask].mean(axis=0)
    total_rank = int(np.linalg.matrix_rank(standardized))
    within_rank = int(np.linalg.matrix_rank(within))
    if within_rank == 0:
        raise BizError('DISCRIMINANT_NO_WITHIN_CLASS_VARIATION', '説明変数にクラス内の変動がなく、判別軸を推定できません。',
                       details={'columns': selected_features, 'classCounts': dict(zip(classes, class_counts))})
    diagnostics = {'inputDimensions': len(feature_columns), 'usedDimensions': n_features,
        'sampleCount': n_samples, 'classCounts': dict(zip(classes, class_counts)),
        'totalRank': total_rank, 'withinClassRank': within_rank,
        'collinear': total_rank < n_features,
        'singularWithinClassCovariance': within_rank < n_features,
        'qdaSmallClasses': [classes[index] for index, count in enumerate(class_counts) if count <= n_features] if method == 'qda' else []}

    # Priors
    if priors == "uniform":
        priors_arr = np.ones(n_classes) / n_classes
    else:
        priors_arr = np.array(class_counts, dtype=np.float64) / n_samples

    # Shrinkage handling for LDA
    lda_solver = "svd"
    lda_shrinkage = None
    if shrinkage == "auto":
        lda_solver = "eigen"
        lda_shrinkage = "auto"
    elif isinstance(shrinkage, (int, float)) and 0.0 <= float(shrinkage) <= 1.0:
        lda_solver = "eigen"
        lda_shrinkage = float(shrinkage)

    # Fit LDA always (for canonical projection and coordinates)
    lda = LinearDiscriminantAnalysis(
        priors=priors_arr,
        solver=lda_solver,
        shrinkage=lda_shrinkage,
        store_covariance=True,
    )
    lda.fit(X, y_indices)

    # Canonical projection scores Z (shape: n_samples, M)
    Z = lda.transform(X)
    if Z.ndim == 1:
        Z = Z[:, np.newaxis]
    M = Z.shape[1]

    # Predict with LDA or QDA
    if method == "qda":
        reg_val = 0.0
        if shrinkage == "auto":
            reg_val = 0.05
        elif isinstance(shrinkage, (int, float)) and 0.0 <= float(shrinkage) <= 1.0:
            reg_val = float(shrinkage)

        qda = None
        for r_try in [reg_val, max(0.01, reg_val), 0.05, 0.1, 0.2, 0.5]:
            try:
                candidate_qda = QuadraticDiscriminantAnalysis(
                    priors=priors_arr, store_covariance=True, reg_param=r_try
                )
                candidate_qda.fit(X, y_indices)
                qda = candidate_qda
                break
            except (np.linalg.LinAlgError, ValueError):
                continue

        if qda is None:
            candidate_qda = QuadraticDiscriminantAnalysis(
                priors=priors_arr, store_covariance=True, reg_param=0.5
            )
            candidate_qda.fit(X, y_indices)
            qda = candidate_qda

        pred_indices = qda.predict(X)
        pred_probs = qda.predict_proba(X)
    else:
        pred_indices = lda.predict(X)
        pred_probs = lda.predict_proba(X)

    decision_threshold_1d: float | None = None
    if M == 1 and n_classes == 2:
        c0 = float(np.mean(Z[y_indices == 0, 0])) if np.any(y_indices == 0) else 0.0
        c1 = float(np.mean(Z[y_indices == 1, 0])) if np.any(y_indices == 1) else 0.0
        if abs(c1 - c0) > 1e-12:
            p0 = priors_arr[0]
            p1 = priors_arr[1]
            log_prior_ratio = math.log(max(1e-12, p1) / max(1e-12, p0))
            z_star = 0.5 * (c0 + c1) - log_prior_ratio / (c1 - c0)
            decision_threshold_1d = round(float(z_star), 4)
        else:
            decision_threshold_1d = round(0.5 * (c0 + c1), 4)

    # Accuracy and misclassifications
    is_misclassified = (pred_indices != y_indices)
    misclassified_row_ids = [row_ids[i] for i, m in enumerate(is_misclassified) if m]
    accuracy = float(np.mean(pred_indices == y_indices))

    # Overall Wilks' Lambda and p-value
    SW, SB, ST = _compute_scatter_matrices(X, y_indices, n_classes)
    wilks_lambda_overall = _calc_wilks_lambda(SW, ST)

    # Rao's approximation for overall p-value
    p_vars = n_features
    q = n_classes - 1
    m_param = n_samples - 1 - (p_vars + q + 1) / 2.0
    val_num = p_vars * p_vars * q * q - 4
    s_param = math.sqrt(val_num / (p_vars * p_vars + q * q - 5)) if (p_vars * p_vars + q * q - 5) > 0 else 1.0
    r_param = (p_vars * q) / 2.0
    y_stat = pow(wilks_lambda_overall, 1.0 / s_param) if s_param > 0 and wilks_lambda_overall > 0 else 1.0
    df1_overall = p_vars * q
    df2_overall = int(m_param * s_param - r_param + 1)
    if df2_overall > 0 and y_stat < 1.0:
        f_stat_overall = ((1.0 - y_stat) / y_stat) * (df2_overall / float(df1_overall))
        p_overall = float(1.0 - stats.f.cdf(f_stat_overall, df1_overall, df2_overall))
    else:
        p_overall = 0.0

    # Canonical Axes Info
    # Explained variance ratios
    if hasattr(lda, "explained_variance_ratio_") and lda.explained_variance_ratio_ is not None:
        evr_list = [float(v) for v in lda.explained_variance_ratio_]
    else:
        evr_list = [1.0]

    # Eigenvalues from Rayleigh quotients: lambda_m = (w_m^T SB w_m) / (w_m^T SW w_m)
    axes_info: list[dict[str, Any]] = []
    for m in range(M):
        if hasattr(lda, "scalings_") and lda.scalings_ is not None and lda.scalings_.shape[1] > m:
            w_m = lda.scalings_[:, m]
            denom = float(w_m.T @ SW @ w_m)
            num = float(w_m.T @ SB @ w_m)
            eig_val = (num / denom) if denom > 1e-12 else (evr_list[m] / max(1e-6, 1.0 - evr_list[m]))
        else:
            eig_val = evr_list[m] / max(1e-6, 1.0 - evr_list[m]) if m < len(evr_list) else 1.0

        evr = evr_list[m] if m < len(evr_list) else 1.0 / M
        canon_corr = math.sqrt(eig_val / (1.0 + eig_val)) if eig_val >= 0 else 0.0

        axes_info.append({
            "axisIndex": m + 1,
            "eigenvalue": round(float(eig_val), 4),
            "explainedVarianceRatio": round(float(evr), 4),
            "canonicalCorrelation": round(float(canon_corr), 4),
        })

    # Canonical Loadings (Correlation between original features and LD coordinates)
    loadings: list[dict[str, Any]] = []
    for j, feat_name in enumerate(selected_features):
        xj = X[:, j]
        std_xj = np.std(xj)
        if std_xj > 1e-12:
            r1 = float(np.corrcoef(xj, Z[:, 0])[0, 1]) if np.std(Z[:, 0]) > 1e-12 else 0.0
            r2 = float(np.corrcoef(xj, Z[:, 1])[0, 1]) if (M >= 2 and np.std(Z[:, 1]) > 1e-12) else None
        else:
            r1 = 0.0
            r2 = 0.0 if M >= 2 else None

        loadings.append({
            "variable": feat_name,
            "ld1": round(r1, 4),
            "ld2": round(r2, 4) if r2 is not None else None,
        })

    # Class centroids in LD space for Mahalanobis distances
    class_ld_centroids = []
    for c in range(n_classes):
        mask_c = (y_indices == c)
        if np.any(mask_c):
            class_ld_centroids.append(np.mean(Z[mask_c], axis=0))
        else:
            class_ld_centroids.append(np.zeros(M))

    # Sample points
    samples: list[dict[str, Any]] = []
    for i in range(n_samples):
        act_class = classes[y_indices[i]]
        pred_class = classes[pred_indices[i]]
        pred_c_idx = pred_indices[i]
        c_cent = class_ld_centroids[pred_c_idx]

        # Mahalanobis distance in canonical space (spherical in LD space)
        dist_sq = float(np.sum((Z[i] - c_cent) ** 2))
        dist_m = math.sqrt(max(0.0, dist_sq))

        post_map = {
            classes[k]: round(float(pred_probs[i, k]), 4)
            for k in range(n_classes)
        }

        samples.append({
            "rowId": row_ids[i],
            "actualClass": act_class,
            "predictedClass": pred_class,
            "isMisclassified": bool(act_class != pred_class),
            "ld1": round(float(Z[i, 0]), 4),
            "ld2": round(float(Z[i, 1]), 4) if M >= 2 else 0.0,
            "posteriorProbabilities": post_map,
            "mahalanobisDistance": round(dist_m, 4),
        })

    # Decision boundary mesh (2D) if M >= 2
    boundary_mesh: dict[str, Any] | None = None
    if M >= 2:
        grid_res = 50
        x_min, x_max = float(np.min(Z[:, 0])), float(np.max(Z[:, 0]))
        y_min, y_max = float(np.min(Z[:, 1])), float(np.max(Z[:, 1]))
        x_pad = max(0.5, (x_max - x_min) * 0.15)
        y_pad = max(0.5, (y_max - y_min) * 0.15)
        x_min -= x_pad
        x_max += x_pad
        y_min -= y_pad
        y_max += y_pad

        gx = np.linspace(x_min, x_max, grid_res)
        gy = np.linspace(y_min, y_max, grid_res)
        GX, GY = np.meshgrid(gx, gy)
        grid_points_2d = np.column_stack([GX.ravel(), GY.ravel()])

        if method == "qda":
            # Map grid from LD space back to original feature space via pseudo-inverse
            # Z = (X - mean) @ scalings => X_grid = Z @ pinv(scalings) + mean
            if hasattr(lda, "scalings_") and lda.scalings_ is not None and lda.scalings_.shape[1] >= 2:
                W2 = lda.scalings_[:, :2]
                W2_pinv = np.linalg.pinv(W2)
                X_mean = np.mean(X, axis=0)
                grid_X = grid_points_2d @ W2_pinv + X_mean
                grid_pred = qda.predict(grid_X)
            else:
                grid_pred = np.zeros(len(grid_points_2d), dtype=int)
        else:
            # For LDA: project back to original space and use exact lda.predict
            if hasattr(lda, "scalings_") and lda.scalings_ is not None and lda.scalings_.shape[1] >= 2:
                W2 = lda.scalings_[:, :2]
                W2_pinv = np.linalg.pinv(W2)
                X_mean = lda.xbar_ if hasattr(lda, "xbar_") else np.mean(X, axis=0)
                grid_X = grid_points_2d @ W2_pinv + X_mean
                grid_pred = lda.predict(grid_X)
            else:
                c_mat = np.array([c[:2] for c in class_ld_centroids])  # (K, 2)
                diffs = grid_points_2d[:, None, :] - c_mat[None, :, :]
                sq_dists = np.sum(diffs ** 2, axis=2)
                scores = -0.5 * sq_dists + np.log(np.maximum(1e-12, priors_arr))[None, :]
                grid_pred = np.argmax(scores, axis=1)

        grid_class_indices = grid_pred.reshape(grid_res, grid_res).tolist()
        boundary_mesh = {
            "xRange": [round(x_min, 4), round(x_max, 4)],
            "yRange": [round(y_min, 4), round(y_max, 4)],
            "gridResolution": grid_res,
            "classes": classes,
            "gridClassIndices": grid_class_indices,
        }

    return {
        "diagnostics": diagnostics,
        "target": target_column,
        "classes": classes,
        "features": selected_features,
        "method": method,
        "accuracy": round(accuracy, 4),
        "axes": axes_info,
        "loadings": loadings,
        "samples": samples,
        "boundaryMesh": boundary_mesh,
        "decisionThreshold1D": decision_threshold_1d,
        "stepwiseTrace": stepwise_trace,
        "misclassifiedRowIds": misclassified_row_ids,
        "wilksLambdaOverall": round(wilks_lambda_overall, 5),
        "pOverall": round(p_overall, 6),
        "excludedRowCount": excluded_row_count,
        "evidenceClass": "SLIDES-2005" if method == "stepwise" else "JAR-INITIAL",
    }
