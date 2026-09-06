"""Logistic Regression Engine for DAVIS (Feature 12).

Provides binary logistic regression with parameter estimation, Wald statistics,
odds ratios with 95% confidence intervals, AIC/BIC/Pseudo-R², dynamic cutoff
confusion matrix with rowId tracking, sample points for brushing, and single-variable
sigmoid curves.
"""
from __future__ import annotations

import math
from typing import Any
import numpy as np
import polars as pl
from scipy import optimize, stats
from sklearn.linear_model import LogisticRegression

from ...domain.errors import BizError


def run_logistic_regression(
    df: pl.DataFrame,
    target_column: str,
    feature_columns: list[str],
    active_row_ids: list[str] | None = None,
    intercept: bool = True,
    regularization: str = "none",  # 'none' | 'l2' | 'l1'
    c_value: float = 1.0,
    cutoff: float = 0.5,
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
            "LOGISTIC_INSUFFICIENT_ROWS",
            "ロジスティック回帰には最低3行以上のデータが必要です。",
            details={"rowCount": total_initial_rows},
        )

    # Check target column
    if target_column not in df.columns:
        raise BizError(
            "LOGISTIC_TARGET_NOT_FOUND",
            f"目的変数 '{target_column}' がデータセットに存在しません。",
            details={"column": target_column},
        )

    # Check feature columns
    if not feature_columns:
        raise BizError(
            "LOGISTIC_NO_FEATURES",
            "説明変数を1つ以上選択してください。",
        )
    for feat in feature_columns:
        if feat not in df.columns:
            raise BizError(
                "LOGISTIC_FEATURE_NOT_FOUND",
                f"説明変数 '{feat}' がデータセットに存在しません。",
                details={"column": feat},
            )

    # Select needed columns and drop nulls (Listwise deletion)
    needed_cols = ["__rowId__", target_column] + feature_columns
    sub_df = df.select(needed_cols).drop_nulls()

    excluded_row_count = total_initial_rows - sub_df.height
    n_samples = sub_df.height

    min_required = len(feature_columns) + (1 if intercept else 0) + 1
    if n_samples < min_required:
        raise BizError(
            "LOGISTIC_INSUFFICIENT_VALID_ROWS",
            f"欠損値除外後の有効行数 ({n_samples}) がパラメータ数に対して不足しています (最低 {min_required} 行必要)。",
            details={"validRowCount": n_samples, "minRequired": min_required},
        )

    row_ids = sub_df["__rowId__"].to_list()
    raw_target = sub_df[target_column].to_list()

    # Determine unique classes
    unique_classes = sorted(list({str(val) for val in raw_target if val is not None}))
    if len(unique_classes) != 2:
        raise BizError(
            "LOGISTIC_NOT_BINARY",
            f"目的変数 '{target_column}' には2つのユニークなクラスが必要です (検出クラス数: {len(unique_classes)})。",
            details={"detectedClasses": unique_classes},
        )

    # Map target to 0 and 1
    # classes[0] -> 0, classes[1] -> 1
    classes = [str(c) for c in unique_classes]
    y = np.array([1.0 if str(val) == classes[1] else 0.0 for val in raw_target], dtype=np.float64)

    # Check that both classes have at least 1 sample
    if np.sum(y == 0) == 0 or np.sum(y == 1) == 0:
        raise BizError(
            "LOGISTIC_SINGLE_CLASS_SAMPLE",
            "目的変数のいずれかのクラスに有効なサンプルが存在しません。",
            details={"class0Count": int(np.sum(y == 0)), "class1Count": int(np.sum(y == 1))},
        )

    # Prepare feature matrix X
    X_raw = np.column_stack([
        sub_df[feat].cast(pl.Float64).to_numpy() for feat in feature_columns
    ])

    p_dim = len(feature_columns)
    means = np.mean(X_raw, axis=0)
    stds = np.std(X_raw, axis=0, ddof=1)
    # Avoid zero std
    stds = np.where(stds < 1e-12, 1.0, stds)

    # Standardized X for fitting
    X_scaled = (X_raw - means) / stds

    # Design matrix: prepend 1s if intercept
    if intercept:
        X_design = np.column_stack([np.ones(n_samples), X_scaled])
        feature_names_with_intercept = ["Intercept"] + feature_columns
    else:
        X_design = X_scaled.copy()
        feature_names_with_intercept = list(feature_columns)

    k_params = X_design.shape[1]

    # Optimization
    reg = regularization.lower() if regularization else "none"
    if reg not in ("none", "l2", "l1"):
        reg = "none"

    beta_scaled = np.zeros(k_params, dtype=np.float64)
    converged = True

    if reg == "l1":
        # Fit with scikit-learn LogisticRegression L1
        clf = LogisticRegression(
            C=max(1e-5, c_value),
            l1_ratio=1.0,
            fit_intercept=False,
            solver="saga",
            max_iter=2000,
        )
        clf.fit(X_design, y)
        beta_scaled = clf.coef_[0]
    elif reg == "l2":
        # Fit with scikit-learn LogisticRegression L2
        clf = LogisticRegression(
            C=max(1e-5, c_value),
            l1_ratio=0.0,
            fit_intercept=False,
            solver="saga",
            max_iter=2000,
        )
        clf.fit(X_design, y)
        beta_scaled = clf.coef_[0]
    else:
        # Unpenalized Maximum Likelihood using scipy.optimize.minimize
        def neg_log_likelihood(b: np.ndarray) -> float:
            z = np.clip(X_design @ b, -35.0, 35.0)
            p = 1.0 / (1.0 + np.exp(-z))
            p = np.clip(p, 1e-15, 1.0 - 1e-15)
            return float(-np.sum(y * np.log(p) + (1.0 - y) * np.log(1.0 - p)))

        def grad(b: np.ndarray) -> np.ndarray:
            z = np.clip(X_design @ b, -35.0, 35.0)
            p = 1.0 / (1.0 + np.exp(-z))
            return X_design.T @ (p - y)

        res = optimize.minimize(
            neg_log_likelihood,
            np.zeros(k_params),
            jac=grad,
            method="BFGS",
            options={"maxiter": 1000},
        )
        if not res.success:
            # Fallback to mild L2 regularization if separation/singularity
            clf = LogisticRegression(
                C=1e4,
                l1_ratio=0.0,
                fit_intercept=False,
                solver="saga",
                max_iter=2000,
            )
            clf.fit(X_design, y)
            beta_scaled = clf.coef_[0]
            converged = False
        else:
            beta_scaled = res.x

    # Transform beta back to original scale
    # X_scaled = (X - mean) / std = X / std - mean / std
    # beta_scaled_0 + sum_j beta_scaled_j * (X_j - mean_j) / std_j
    # = (beta_scaled_0 - sum_j beta_scaled_j * mean_j / std_j) + sum_j (beta_scaled_j / std_j) * X_j
    beta_orig = np.zeros_like(beta_scaled)
    if intercept:
        beta_orig[1:] = beta_scaled[1:] / stds
        beta_orig[0] = beta_scaled[0] - np.sum((beta_scaled[1:] * means) / stds)
        X_design_orig = np.column_stack([np.ones(n_samples), X_raw])
    else:
        beta_orig = beta_scaled / stds
        X_design_orig = X_raw.copy()

    # Predictions
    logits = np.clip(X_design_orig @ beta_orig, -35.0, 35.0)
    pred_probs = 1.0 / (1.0 + np.exp(-logits))
    pred_probs = np.clip(pred_probs, 1e-15, 1.0 - 1e-15)

    # Standard errors via Fisher Information Matrix: I(beta) = X^T W X
    w = pred_probs * (1.0 - pred_probs)
    Hessian = X_design_orig.T @ (X_design_orig * w[:, None])
    # Add tiny ridge for numerical stability in inversion
    Hessian_reg = Hessian + np.eye(k_params) * 1e-9
    try:
        cov_matrix = np.linalg.inv(Hessian_reg)
    except np.linalg.LinAlgError:
        cov_matrix = np.linalg.pinv(Hessian_reg)

    std_errors = np.sqrt(np.maximum(np.diag(cov_matrix), 1e-12))
    z_values = beta_orig / std_errors
    p_values = 2.0 * (1.0 - stats.norm.cdf(np.abs(z_values)))

    # Odds ratio and 95% CI
    odds_ratios = np.exp(np.clip(beta_orig, -20.0, 20.0))
    ci_lowers = np.exp(np.clip(beta_orig - 1.96 * std_errors, -20.0, 20.0))
    ci_uppers = np.exp(np.clip(beta_orig + 1.96 * std_errors, -20.0, 20.0))

    coefficients = []
    for i, name in enumerate(feature_names_with_intercept):
        coefficients.append({
            "name": name,
            "coefficient": round(float(beta_orig[i]), 6),
            "stdError": round(float(std_errors[i]), 6),
            "zValue": round(float(z_values[i]), 4),
            "pValue": round(float(p_values[i]), 6),
            "oddsRatio": round(float(odds_ratios[i]), 6),
            "ciLower": round(float(ci_lowers[i]), 6),
            "ciUpper": round(float(ci_uppers[i]), 6),
        })

    # Fit metrics
    log_likelihood = float(np.sum(y * np.log(pred_probs) + (1.0 - y) * np.log(1.0 - pred_probs)))
    p_null = float(np.mean(y))
    p_null = np.clip(p_null, 1e-15, 1.0 - 1e-15)
    null_log_likelihood = float(np.sum(y * np.log(p_null) + (1.0 - y) * np.log(1.0 - p_null)))

    aic = 2.0 * k_params - 2.0 * log_likelihood
    bic = k_params * np.log(n_samples) - 2.0 * log_likelihood
    pseudo_r2 = 1.0 - (log_likelihood / null_log_likelihood) if abs(null_log_likelihood) > 1e-9 else 0.0
    pseudo_r2 = max(0.0, min(1.0, pseudo_r2))

    # Confusion matrix at initial cutoff
    pred_classes = (pred_probs >= cutoff).astype(int)
    tp_mask = (y == 1) & (pred_classes == 1)
    tn_mask = (y == 0) & (pred_classes == 0)
    fp_mask = (y == 0) & (pred_classes == 1)
    fn_mask = (y == 1) & (pred_classes == 0)

    tp = int(np.sum(tp_mask))
    tn = int(np.sum(tn_mask))
    fp = int(np.sum(fp_mask))
    fn = int(np.sum(fn_mask))

    tp_ids = [row_ids[i] for i, m in enumerate(tp_mask) if m]
    tn_ids = [row_ids[i] for i, m in enumerate(tn_mask) if m]
    fp_ids = [row_ids[i] for i, m in enumerate(fp_mask) if m]
    fn_ids = [row_ids[i] for i, m in enumerate(fn_mask) if m]

    acc = (tp + tn) / n_samples if n_samples > 0 else 0.0
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2.0 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0

    confusion_matrix = {
        "tn": tn,
        "fp": fp,
        "fn": fn,
        "tp": tp,
        "tnRowIds": tn_ids,
        "fpRowIds": fp_ids,
        "fnRowIds": fn_ids,
        "tpRowIds": tp_ids,
        "accuracy": round(float(acc), 4),
        "precision": round(float(prec), 4),
        "recall": round(float(rec), 4),
        "f1Score": round(float(f1), 4),
    }

    # Samples
    samples = []
    for i in range(n_samples):
        samples.append({
            "rowId": row_ids[i],
            "actual": int(y[i]),
            "predictedProb": round(float(pred_probs[i]), 5),
            "predictedClass": int(pred_classes[i]),
            "residual": round(float(y[i] - pred_probs[i]), 5),
            "isMisclassified": bool(y[i] != pred_classes[i]),
        })

    # Sigmoid curves for each feature
    # Fix other features to median (or mode/0 if binary dummy variable)
    medians = np.median(X_raw, axis=0)
    fixed_values = np.zeros(p_dim)
    for col_i in range(p_dim):
        is_binary = np.all(np.isin(X_raw[:, col_i], [0.0, 1.0]))
        if is_binary:
            vals, counts = np.unique(X_raw[:, col_i], return_counts=True)
            fixed_values[col_i] = float(vals[np.argmax(counts)])
        else:
            fixed_values[col_i] = float(medians[col_i])

    curves: dict[str, list[dict[str, float]]] = {}

    feat_betas = beta_orig[1:] if intercept else beta_orig
    intercept_val = beta_orig[0] if intercept else 0.0

    for idx, feat_name in enumerate(feature_columns):
        col_min = float(np.min(X_raw[:, idx]))
        col_max = float(np.max(X_raw[:, idx]))
        if col_max == col_min:
            col_max += 1.0

        grid_x = np.linspace(col_min, col_max, 80)
        # Base logit contribution from fixed feature values
        base_logit = intercept_val
        for other_idx in range(p_dim):
            if other_idx != idx:
                base_logit += feat_betas[other_idx] * fixed_values[other_idx]

        curve_points = []
        for x_val in grid_x:
            logit_val = base_logit + feat_betas[idx] * x_val
            logit_val = np.clip(logit_val, -35.0, 35.0)
            prob_val = 1.0 / (1.0 + np.exp(-logit_val))
            curve_points.append({
                "x": round(float(x_val), 4),
                "probability": round(float(prob_val), 4),
            })
        curves[feat_name] = curve_points

    return {
        "target": target_column,
        "classes": classes,
        "features": feature_columns,
        "excludedRowCount": excluded_row_count,
        "coefficients": coefficients,
        "fitMetrics": {
            "logLikelihood": round(log_likelihood, 4),
            "nullLogLikelihood": round(null_log_likelihood, 4),
            "aic": round(aic, 4),
            "bic": round(bic, 4),
            "pseudoR2": round(pseudo_r2, 4),
            "converged": converged,
        },
        "confusionMatrix": confusion_matrix,
        "samples": samples,
        "curves": curves,
        "evidenceClass": "JAR-INITIAL",
    }
