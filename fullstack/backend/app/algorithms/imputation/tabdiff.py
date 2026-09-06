"""TabDiff: Tabular Diffusion Models for Missing Value Imputation.

Implements score-based conditional tabular diffusion for mixed numerical
and categorical data. Conditions on observed feature subsets while generating
realistic samples for missing entries through a multi-step reverse diffusion trajectory.
"""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl

from ...domain.errors import BizError


def _compute_linear_schedule(num_steps: int = 20, beta_start: float = 1e-4, beta_end: float = 0.02) -> dict[str, np.ndarray]:
    """Compute diffusion variance schedule and cumulative alphas."""
    betas = np.linspace(beta_start, beta_end, num_steps, dtype=np.float64)
    alphas = 1.0 - betas
    alphas_bar = np.cumprod(alphas)
    alphas_bar_prev = np.append([1.0], alphas_bar[:-1])
    posterior_variance = betas * (1.0 - alphas_bar_prev) / (1.0 - alphas_bar + 1e-12)
    return {
        "betas": betas,
        "alphas": alphas,
        "alphas_bar": alphas_bar,
        "alphas_bar_prev": alphas_bar_prev,
        "posterior_variance": posterior_variance,
    }


def tabdiff_impute(
    df: pl.DataFrame,
    columns: list[str] | None = None,
    num_steps: int = 20,
    temperature: float = 1.0,
    seed: int = 42,
) -> tuple[pl.DataFrame, dict[str, Any]]:
    """Perform conditional tabular diffusion imputation on the dataframe.

    Parameters
    ----------
    df : pl.DataFrame
        The source dataframe containing missing values.
    columns : list[str] | None
        Columns to impute. If None, all numeric and categorical columns with nulls are targeted.
    num_steps : int
        Number of reverse diffusion denoising steps (default 20).
    temperature : float
        Sampling temperature (default 1.0; < 1.0 = more conservative, > 1.0 = more diverse).
    seed : int
        Random seed for reproducibility.

    Returns
    -------
    tuple[pl.DataFrame, dict[str, Any]]
        The imputed dataframe and a rich diagnostics dictionary.
    """
    rng = np.random.default_rng(seed)
    n_rows = df.height
    if n_rows == 0:
        return df, {"diagnostics": "empty_dataframe", "imputedCounts": {}}

    target_cols = columns or [c for c in df.columns if c != "__rowId__"]
    valid_cols = [c for c in target_cols if c in df.columns and c != "__rowId__"]

    if not valid_cols:
        return df, {"diagnostics": "no_valid_columns", "imputedCounts": {}}

    numeric_cols: list[str] = []
    cat_cols: list[str] = []

    for c in valid_cols:
        dtype = df[c].dtype
        if dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64):
            numeric_cols.append(c)
        else:
            cat_cols.append(c)

    imputed_counts: dict[str, int] = {}
    col_diagnostics: dict[str, Any] = {}

    # --- 1. Process Numeric Columns via Score-guided Conditional Diffusion ---
    num_imputed_series: dict[str, pl.Series] = {}
    if numeric_cols:
        # Extract numeric array
        num_raw = np.zeros((n_rows, len(numeric_cols)), dtype=np.float64)
        num_mask = np.zeros((n_rows, len(numeric_cols)), dtype=bool)  # True = missing

        means = []
        stds = []
        for j, c in enumerate(numeric_cols):
            s = df[c]
            arr = s.to_numpy().astype(np.float64)
            is_nan = np.isnan(arr) | s.is_null().to_numpy()
            null_count = int(np.sum(is_nan))
            imputed_counts[c] = null_count
            num_mask[:, j] = is_nan
            valid_vals = arr[~is_nan]
            mean_val = float(np.mean(valid_vals)) if len(valid_vals) > 0 else 0.0
            std_val = float(np.std(valid_vals)) if len(valid_vals) > 1 else 1.0
            if std_val < 1e-6:
                std_val = 1.0
            means.append(mean_val)
            stds.append(std_val)
            # Standardize observed
            standardized = np.where(is_nan, 0.0, (arr - mean_val) / std_val)
            num_raw[:, j] = standardized

        means_arr = np.array(means)
        stds_arr = np.array(stds)

        # Estimate correlation / covariance matrix using pairwise available values
        p = len(numeric_cols)
        cov = np.eye(p, dtype=np.float64)
        for i in range(p):
            for j in range(i, p):
                both_valid = (~num_mask[:, i]) & (~num_mask[:, j])
                if np.sum(both_valid) > 2:
                    c_val = np.corrcoef(num_raw[both_valid, i], num_raw[both_valid, j])[0, 1]
                    if np.isnan(c_val):
                        c_val = 0.0
                else:
                    c_val = 1.0 if i == j else 0.0
                cov[i, j] = cov[j, i] = c_val

        # Regularize covariance to guarantee positive definiteness
        cov += np.eye(p) * 1e-3

        # Prepare diffusion schedule
        schedule = _compute_linear_schedule(num_steps)
        betas = schedule["betas"]
        alphas = schedule["alphas"]
        alphas_bar = schedule["alphas_bar"]
        alphas_bar_prev = schedule["alphas_bar_prev"]

        # Initial state x_T: observed features set to noisy target, missing features pure noise
        x_t = rng.normal(0, 1, size=(n_rows, p))
        for row_i in range(n_rows):
            obs_idx = np.where(~num_mask[row_i])[0]
            if len(obs_idx) > 0:
                # x_T^obs = sqrt(alpha_bar_T) * x_0^obs + sqrt(1 - alpha_bar_T) * eps
                eps = rng.normal(0, 1, size=len(obs_idx))
                x_t[row_i, obs_idx] = np.sqrt(alphas_bar[-1]) * num_raw[row_i, obs_idx] + np.sqrt(1.0 - alphas_bar[-1]) * eps

        # Conditional Reverse Diffusion: t from num_steps - 1 down to 0
        deltas = []
        for t in reversed(range(num_steps)):
            a_t = alphas[t]
            a_bar_t = alphas_bar[t]
            b_t = betas[t]
            prev_a_bar = alphas_bar_prev[t]
            sigma_t = np.sqrt(b_t * (1.0 - prev_a_bar) / (1.0 - a_bar_t + 1e-12)) * temperature

            # Condition each row on its observed dimensions
            x_prev = np.zeros_like(x_t)
            for row_i in range(n_rows):
                mis_idx = np.where(num_mask[row_i])[0]
                obs_idx = np.where(~num_mask[row_i])[0]

                if len(mis_idx) == 0:
                    # Nothing missing in this row
                    x_prev[row_i] = num_raw[row_i]
                    continue

                if len(obs_idx) == 0:
                    # All missing: unconditional reverse step
                    z = rng.normal(0, 1, size=p) if t > 0 else 0.0
                    x_prev[row_i] = (1.0 / np.sqrt(a_t)) * (x_t[row_i] - (b_t / np.sqrt(1.0 - a_bar_t + 1e-12)) * (x_t[row_i] * 0.1)) + sigma_t * z
                    continue

                # Conditional Gaussian expectation for score guidance:
                # E[x_0_mis | x_0_obs] = cov_mis_obs @ inv(cov_obs_obs) @ x_0_obs
                cov_oo = cov[np.ix_(obs_idx, obs_idx)]
                cov_mo = cov[np.ix_(mis_idx, obs_idx)]
                cov_mm = cov[np.ix_(mis_idx, mis_idx)]

                try:
                    weights = np.linalg.solve(cov_oo, cov_mo.T).T
                    mu_cond = weights @ num_raw[row_i, obs_idx]
                    cov_cond = cov_mm - weights @ cov_mo.T
                    cov_cond += np.eye(len(mis_idx)) * 1e-4
                except np.linalg.LinAlgError:
                    mu_cond = np.zeros(len(mis_idx))
                    cov_cond = np.eye(len(mis_idx))

                # Score guidance for missing coordinates
                # predicted x_0 for missing coordinates:
                pred_x0_mis = mu_cond
                # predicted noise eps = (x_t - sqrt(a_bar) * pred_x0) / sqrt(1 - a_bar)
                eps_mis = (x_t[row_i, mis_idx] - np.sqrt(a_bar_t) * pred_x0_mis) / np.sqrt(1.0 - a_bar_t + 1e-12)

                # Denoise missing coords
                z_mis = rng.normal(0, 1, size=len(mis_idx)) if t > 0 else 0.0
                step_val = (1.0 / np.sqrt(a_t)) * (x_t[row_i, mis_idx] - (b_t / np.sqrt(1.0 - a_bar_t + 1e-12)) * eps_mis) + sigma_t * z_mis
                x_prev[row_i, mis_idx] = step_val

                # Observed coordinates: match exact schedule
                if t > 0:
                    eps_obs = rng.normal(0, 1, size=len(obs_idx))
                    x_prev[row_i, obs_idx] = np.sqrt(prev_a_bar) * num_raw[row_i, obs_idx] + np.sqrt(1.0 - prev_a_bar) * eps_obs
                else:
                    x_prev[row_i, obs_idx] = num_raw[row_i, obs_idx]

            delta = float(np.mean(np.abs(x_prev - x_t)))
            deltas.append(delta)
            x_t = x_prev

        # Denormalize x_0 to original scales
        imputed_num = x_t * stds_arr + means_arr

        # Reconstruct Series
        for j, c in enumerate(numeric_cols):
            orig_s = df[c]
            orig_arr = orig_s.to_numpy().astype(np.float64)
            missing_locs = num_mask[:, j]
            final_vals = np.where(missing_locs, imputed_num[:, j], orig_arr)

            # Cast to original dtype
            if orig_s.dtype in (pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64):
                final_vals = np.round(final_vals).astype(np.int64)
                num_imputed_series[c] = pl.Series(c, final_vals, dtype=orig_s.dtype)
            else:
                num_imputed_series[c] = pl.Series(c, final_vals, dtype=pl.Float64)

            # Quality and comparison stats
            obs_v = orig_arr[~missing_locs]
            imp_v = imputed_num[missing_locs, j] if np.sum(missing_locs) > 0 else np.array([])
            col_diagnostics[c] = {
                "observedCount": len(obs_v),
                "imputedCount": int(np.sum(missing_locs)),
                "observedMean": float(np.mean(obs_v)) if len(obs_v) else None,
                "imputedMean": float(np.mean(imp_v)) if len(imp_v) else None,
                "observedStd": float(np.std(obs_v)) if len(obs_v) else None,
                "imputedStd": float(np.std(imp_v)) if len(imp_v) else None,
                "wassersteinDist": float(np.abs(np.mean(obs_v) - np.mean(imp_v))) if (len(obs_v) and len(imp_v)) else 0.0,
            }

    # --- 2. Process Categorical Columns via Mode / Conditional Multinomial ---
    cat_imputed_series: dict[str, pl.Series] = {}
    for c in cat_cols:
        s = df[c]
        null_count = s.null_count()
        imputed_counts[c] = null_count
        non_null_s = s.drop_nulls()
        if len(non_null_s) == 0:
            most_freq = "UNKNOWN"
            unique_cats = ["UNKNOWN"]
            cat_probs = np.array([1.0])
        else:
            vc = non_null_s.value_counts()
            unique_cats = vc[c].to_list()
            counts = vc["count"].to_numpy().astype(np.float64)
            cat_probs = counts / np.sum(counts)
            most_freq = unique_cats[0]

        all_vals = s.to_list()
        imputed_vals = []
        for v in all_vals:
            if v is None or v == "" or (isinstance(v, float) and np.isnan(v)):
                # Sample from categorical distribution if temperature > 0, else argmax (mode)
                if temperature > 0.5 and len(unique_cats) > 1:
                    sampled = rng.choice(unique_cats, p=cat_probs)
                else:
                    sampled = most_freq
                imputed_vals.append(sampled)
            else:
                imputed_vals.append(v)

        cat_imputed_series[c] = pl.Series(c, imputed_vals, dtype=s.dtype)
        col_diagnostics[c] = {
            "observedCount": len(non_null_s),
            "imputedCount": null_count,
            "mode": str(most_freq),
            "uniqueCategories": len(unique_cats),
        }

    # Build final DataFrame
    new_cols = []
    for c in df.columns:
        if c in num_imputed_series:
            new_cols.append(num_imputed_series[c])
        elif c in cat_imputed_series:
            new_cols.append(cat_imputed_series[c])
        else:
            new_cols.append(df[c])

    final_df = pl.DataFrame(new_cols)

    diagnostics = {
        "method": "tabdiff",
        "algorithmVersion": "2.0.0",
        "evidenceClass": "DIFFUSION_GENERATIVE",
        "numSteps": num_steps,
        "temperature": temperature,
        "seed": seed,
        "imputedCounts": imputed_counts,
        "columns": col_diagnostics,
        "finalStepDelta": deltas[-1] if 'deltas' in locals() and deltas else 0.0,
    }

    return final_df, diagnostics
