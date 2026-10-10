"""Key Driver Analysis (KDA) Engine using Shapley value decomposition (Feature 04).

Decomposes model R² across all drivers via exact Shapley/LMG algorithm,
computes multicollinearity (VIF), standardized regression coefficients,
contrasts true impact vs simple correlation, and supports what-if simulation.
"""
from __future__ import annotations

import itertools
import math
import uuid
from dataclasses import dataclass
from collections.abc import Callable
from typing import Any
import numpy as np
import polars as pl
from scipy import stats

from ...domain.codebook_adapter import normalize_code


_R2_TOL = 1e-10


@dataclass
class _GroupedDesign:
    """One listwise population and whole original-driver design blocks.

    The API has already applied analysis_frame once. In particular, ordinal
    scores must never be passed through the raw-code domain/scoring again.
    """

    y: np.ndarray
    y_mean: float
    y_std: float
    matrix: np.ndarray
    blocks: list[tuple[int, ...]]
    encodings: dict[str, dict[str, Any]]
    numeric: dict[str, tuple[np.ndarray, float, float]]
    constants: list[str]


def _prepare_grouped_design(
    df: pl.DataFrame, outcome: str, drivers: list[str], meta: dict[str, dict[str, Any]],
) -> _GroupedDesign:
    y = df[outcome].to_numpy().astype(float)
    valid = np.isfinite(y)
    original: dict[str, np.ndarray] = {}
    nominal = {name for name in drivers if meta.get(name, {}).get("scaleType") == "nominal"}
    for name in drivers:
        if name in nominal:
            values = np.asarray([normalize_code(v) for v in df[name].to_list()], dtype=object)
            valid &= np.asarray([v is not None for v in values], dtype=bool)
        else:
            values = df[name].to_numpy().astype(float)
            valid &= np.isfinite(values)
        original[name] = values
    y = y[valid]
    n = len(y)
    if n < len(drivers) + 2:
        raise ValueError("有効行数が説明変数の数に対して不足しています。")
    y_mean, y_std = float(np.mean(y)), float(np.std(y, ddof=1))
    if y_std <= 1e-9:
        raise ValueError("目的変数にばらつきがないため重要度を算定できません。(NO_TARGET_VARIATION)")
    if not np.isfinite([y_mean, y_std]).all():
        raise ValueError("KDA numerical error: nonfinite outcome standardization.")
    columns = [np.ones(n)]
    blocks: list[tuple[int, ...]] = []
    encodings: dict[str, dict[str, Any]] = {}
    numeric: dict[str, tuple[np.ndarray, float, float]] = {}
    constants = []
    for name in drivers:
        values = original[name][valid]
        start = len(columns)
        if name in nominal:
            spec = meta[name]
            observed = set(values)
            ordered = list(dict.fromkeys(normalize_code(v) for v in (spec.get("categoryOrder") or [])))
            levels = [code for code in ordered if code in observed]
            levels.extend(sorted(observed - set(levels)))
            labels = {normalize_code(code): label for code, label in (spec.get("valueLabels") or {}).items()}
            encodings[name] = {
                "levels": [{"code": code, "label": labels.get(code, code)} for code in levels],
                "reference_code": levels[0],
                "design_column_count": len(levels) - 1,
            }
            columns.extend((values == code).astype(float) for code in levels[1:])
            if len(levels) == 1:
                constants.append(name)
        else:
            mean, std = float(np.mean(values)), float(np.std(values, ddof=1))
            if float(np.std(values)) < 1e-9:
                constants.append(name)
            if std < 1e-9:
                std = 1.0
            numeric[name] = (values, mean, std)
            columns.append((values - mean) / std)
        blocks.append(tuple(range(start, len(columns))))
    matrix = np.column_stack(columns)
    y_norm = (y - y_mean) / y_std
    if not np.isfinite(matrix).all() or not np.isfinite(y_norm).all():
        raise ValueError("KDA numerical error: nonfinite standardized design.")
    return _GroupedDesign(y_norm, y_mean, y_std, matrix, blocks, encodings, numeric, constants)


def _checked_r2(target: np.ndarray, prediction: np.ndarray) -> float:
    total = float(np.sum((target - np.mean(target)) ** 2))
    residual = float(np.sum((target - prediction) ** 2))
    if not np.isfinite([total, residual]).all() or total <= 0:
        raise ValueError("KDA numerical error: invalid least-squares residual or target variation.")
    value = 1.0 - residual / total
    if not np.isfinite(value) or value < -_R2_TOL or value > 1 + _R2_TOL:
        raise ValueError("KDA numerical error: R² outside numerical tolerance.")
    return min(1.0, max(0.0, value))


class _GroupedOLS:
    """All new-path fits and ranks share the full design's absolute SVD cutoff."""

    def __init__(self, design: np.ndarray):
        try:
            singular = np.linalg.svd(design, compute_uv=False)
        except np.linalg.LinAlgError as error:
            raise ValueError("KDA numerical error: full-design SVD failed.") from error
        if not np.isfinite(singular).all():
            raise ValueError("KDA numerical error: nonfinite full-design singular values.")
        self.tau = np.finfo(np.float64).eps * max(design.shape) * float(singular[0])

    def decompose(self, design: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        try:
            u, singular, vt = np.linalg.svd(design, full_matrices=False)
        except np.linalg.LinAlgError as error:
            raise ValueError("KDA numerical error: subdesign SVD failed.") from error
        if not all(np.isfinite(value).all() for value in (u, singular, vt)):
            raise ValueError("KDA numerical error: nonfinite subdesign SVD.")
        retained = singular > self.tau
        return u[:, retained], singular[retained], vt[retained, :]

    def rank(self, design: np.ndarray) -> int:
        return len(self.decompose(design)[1])

    def fit(self, design: np.ndarray, target: np.ndarray) -> tuple[np.ndarray, int, float]:
        u, singular, vt = self.decompose(design)
        coefficients = vt.T @ ((u.T @ target) / singular)
        prediction = design @ coefficients
        if not np.isfinite(coefficients).all() or not np.isfinite(prediction).all():
            raise ValueError("KDA numerical error: nonfinite least-squares solution.")
        return coefficients, len(singular), _checked_r2(target, prediction)


def _grouped_lmg(
    count: int, score: Callable[[tuple[int, ...]], float],
    max_exact_drivers: int, n_sample_permutations: int,
) -> tuple[np.ndarray, float]:
    """Allocate the original-player game, never a game over partial dummy blocks."""
    cache: dict[tuple[int, ...], float] = {(): 0.0}

    def value(subset: tuple[int, ...]) -> float:
        if subset not in cache:
            cache[subset] = score(subset)
        return cache[subset]

    def gain(after: float, before: float) -> float:
        difference = after - before
        if not np.isfinite(difference) or difference < -_R2_TOL:
            raise ValueError("KDA numerical error: negative nested R² gain exceeds tolerance.")
        return max(0.0, difference)

    full_r2 = value(tuple(range(count)))
    contributions = np.zeros(count)
    if count <= max_exact_drivers:
        for player in range(count):
            others = [j for j in range(count) if j != player]
            for size in range(count):
                weight = 1.0 / (count * math.comb(count - 1, size))
                for subset in itertools.combinations(others, size):
                    contributions[player] += weight * gain(value(tuple(sorted((*subset, player)))), value(subset))
    else:
        samples = min(n_sample_permutations, 500)
        if samples < 1:
            raise ValueError("KDA permutation sample count must be positive.")
        rng = np.random.default_rng(42)
        for _ in range(samples):
            subset: tuple[int, ...] = ()
            previous = 0.0
            for player in rng.permutation(count):
                subset = tuple(sorted((*subset, int(player))))
                current = value(subset)
                contributions[player] += gain(current, previous)
                previous = current
        contributions /= samples
    if not np.isfinite(contributions).all() or abs(float(contributions.sum()) - full_r2) > max(1, count) * _R2_TOL:
        raise ValueError("KDA numerical error: grouped contributions do not conserve full R².")
    return contributions, full_r2


def _run_nominal_kda(
    df: pl.DataFrame, outcome: str, drivers: list[str], meta: dict[str, dict[str, Any]],
    method: str, max_exact_drivers: int, n_sample_permutations: int,
) -> dict[str, Any]:
    if method != "shapley_lmg":
        raise ValueError("名義尺度を含むKDAでは shapley_lmg のみ対応しています。他の手法は未対応です。")
    data = _prepare_grouped_design(df, outcome, drivers, meta)
    solver = _GroupedOLS(data.matrix)
    coefficients, full_rank, fitted_r2 = solver.fit(data.matrix, data.y)
    n, width = data.matrix.shape
    if n <= full_rank:
        raise ValueError("名義尺度を含むモデルには正の残差自由度が必要です。カテゴリ数に対して有効行数が不足しています。")

    def score(players: tuple[int, ...]) -> float:
        indices = [0, *(column for j in players for column in data.blocks[j])]
        if len(indices) == 1:
            return 0.0  # Empty nominal blocks remain exact null players.
        return solver.fit(data.matrix[:, indices], data.y)[2]

    contributions, full_r2 = _grouped_lmg(len(drivers), score, max_exact_drivers, n_sample_permutations)
    if abs(full_r2 - fitted_r2) > _R2_TOL:
        raise ValueError("KDA numerical error: inconsistent full-model R².")
    total = float(contributions.sum())
    percentages = 100 * contributions / total if total > 1e-6 else np.zeros(len(drivers))
    warnings = []
    if total <= 1e-6:
        warnings.append("説明力がほぼゼロのため重要度は0%として返します。最優先ドライバーは提示しません。")
    if data.constants:
        warnings.append(f"分散が0のドライバーが含まれています: {', '.join(data.constants)}")
    if full_rank < width:
        warnings.append("モデルの計画行列がランク落ちしています。重複・共線な元のドライバーを保持して重要度を配分しています。")

    diagnostics = {}
    means, slopes = {}, {}
    for j, name in enumerate(drivers):
        if name not in data.numeric:
            continue
        values, mean, std = data.numeric[name]
        column = data.blocks[j][0]
        others = [i for i in range(width) if i != column]
        identifiable = solver.rank(data.matrix[:, others]) < full_rank
        beta = float(coefficients[column]) if identifiable else None
        slope = beta * data.y_std / std if beta is not None else None
        if slope is not None and not np.isfinite(slope):
            raise ValueError("KDA numerical error: nonfinite raw slope.")
        # Small score variance keeps the existing VIF preprocessing convention,
        # but does not erase a defined, scale-invariant Pearson correlation.
        correlation = 0.0 if np.all(values == values[0]) else float(stats.pearsonr(values, data.y).statistic)
        if name in data.constants:
            vif = 1.0
        else:
            auxiliary_r2 = solver.fit(data.matrix[:, others], data.matrix[:, column])[2]
            vif = 1.0 / max(1e-4, 1 - auxiliary_r2)
        if not np.isfinite([correlation, vif]).all():
            raise ValueError("KDA numerical error: nonfinite numeric diagnostics.")
        diagnostics[name] = {
            "direction": (1 if beta >= 0 else -1) if beta is not None else None,
            "standardized_coef": round(beta, 4) if beta is not None else None,
            "raw_slope": round(slope, 4) if slope is not None else None,
            "pearson_r": round(correlation, 4), "vif": round(vif, 2),
        }
        if slope is None:
            warnings.append(f"{name}: 他のドライバーと区別できる係数がないため、方向・傾きとwhat-ifを表示しません。")
        else:
            means[name], slopes[name] = round(mean, 4), round(slope, 4)
    numeric_indices = [j for j, name in enumerate(drivers) if name in diagnostics]
    importance_ranks = {j: rank for rank, j in enumerate(sorted(numeric_indices, key=lambda j: -percentages[j]))}
    correlation_ranks = {j: rank for rank, j in enumerate(sorted(numeric_indices, key=lambda j: -abs(diagnostics[drivers[j]]["pearson_r"])))}
    vifs = [metrics["vif"] for metrics in diagnostics.values()]
    vif_max = max(vifs) if vifs else None
    if vif_max is not None and vif_max > 10:
        warnings.append(f"数値ドライバーの最大VIFが {vif_max:.1f} と高く、強い多重共線性が存在します。")
    output = []
    for j, name in enumerate(drivers):
        nominal = name in data.encodings
        note = "カテゴリ全体の重要度（名義尺度・方向なし）" if nominal else "主因"
        if total <= 1e-6:
            note = "説明力なし" if not nominal else "説明力なし（名義尺度・方向なし）"
        elif not nominal:
            if correlation_ranks[j] < importance_ranks[j] - 1:
                note = "⚠️見かけの相関（共線性により真の寄与は控えめ）"
            elif importance_ranks[j] < correlation_ranks[j] - 1:
                note = "💎隠れた重要ドライバー（相関以上の貢献度）"
            elif percentages[j] > 25:
                note = "最優先キードライバー"
        item = {
            "name": name, "label": meta.get(name, {}).get("label") or name,
            "kind": "nominal" if nominal else "numeric",
            "importance_raw": round(float(contributions[j]), 4),
            "importance_pct": round(float(percentages[j]), 2), "note": note,
            **(diagnostics[name] if not nominal else dict.fromkeys(
                ("direction", "standardized_coef", "raw_slope", "pearson_r", "vif"))),
        }
        if nominal:
            item["encoding"] = data.encodings[name]
        output.append(item)
    output.sort(key=lambda item: item["importance_pct"], reverse=True)
    return {
        "run_id": str(uuid.uuid4()), "method": method,
        "outcome": {"name": outcome, "label": meta.get(outcome, {}).get("label") or outcome, "type": "numeric"},
        "model": {"r_squared": round(full_r2, 4), "n_valid": n, "vif_max": vif_max,
                  "vif_coverage": "numeric_drivers_only", "warnings": warnings},
        "drivers": output,
        "what_if_baseline": {"outcome_mean": round(data.y_mean, 4), "driver_means": means, "raw_slopes": slopes},
    }


def run_kda(
    df: pl.DataFrame,
    outcome: str,
    drivers: list[str] | None = None,
    column_meta: list[dict[str, Any]] | None = None,
    method: str = "shapley_lmg",
    max_exact_drivers: int = 12,
    n_sample_permutations: int = 500,
) -> dict[str, Any]:
    # Meta lookup
    meta_by_col: dict[str, dict[str, Any]] = {}
    if column_meta:
        for m in column_meta:
            if m.get("columnId"):
                meta_by_col[m["columnId"]] = m
            if m.get("name"):
                meta_by_col[m["name"]] = m

    # Filter out outcome and get numeric columns if drivers not given
    actual_drivers = list(drivers or [])
    if not actual_drivers:
        for c in df.columns:
            if c != outcome and c not in ("__rowId__", "id", "ID", "row_id", "rowId"):
                if df[c].dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64):
                    actual_drivers.append(c)
        actual_drivers = actual_drivers[:10]  # default top 10

    if not actual_drivers or outcome not in df.columns:
        raise ValueError(f"Outcome {outcome} or drivers not valid in dataframe.")
    if any(meta_by_col.get(name, {}).get("scaleType") == "nominal" for name in actual_drivers):
        if ((drivers is not None and not drivers) or len(set(actual_drivers)) != len(actual_drivers)
                or outcome in actual_drivers or any(name not in df.columns for name in actual_drivers)):
            raise ValueError("ドライバーには実在する目的変数以外の列を重複せず指定してください。")
        return _run_nominal_kda(df, outcome, actual_drivers, meta_by_col, method,
                                max_exact_drivers, n_sample_permutations)

    # Drop nulls across outcome and drivers (listwise deletion)
    needed_cols = [outcome] + actual_drivers
    sub_df = df.select(needed_cols).drop_nulls()
    n_valid = sub_df.height
    if n_valid < len(actual_drivers) + 2:
        raise ValueError("有効行数が説明変数の数に対して不足しています。")

    y = sub_df[outcome].to_numpy().astype(float)
    X = sub_df.select(actual_drivers).to_numpy().astype(float)
    k = len(actual_drivers)
    if float(np.std(y, ddof=1)) <= 1e-9 if n_valid > 1 else True:
        raise ValueError("目的変数にばらつきがないため重要度を算定できません。(NO_TARGET_VARIATION)")

    # Standardize X and y
    y_mean = float(np.mean(y))
    y_std = float(np.std(y, ddof=1)) if float(np.std(y, ddof=1)) > 1e-9 else 1.0
    y_norm = (y - y_mean) / y_std

    X_means = np.mean(X, axis=0)
    X_stds = np.std(X, axis=0, ddof=1)
    X_stds[X_stds < 1e-9] = 1.0
    X_norm = (X - X_means) / X_stds

    # Compute correlation with y
    pearson_rs = []
    for j in range(k):
        try:
            r_val, _ = stats.pearsonr(X[:, j], y)
            pearson_rs.append(round(float(r_val), 4) if not math.isnan(r_val) else 0.0)
        except Exception:
            pearson_rs.append(0.0)

    # Full standardized OLS regression: y_norm = X_norm * beta
    # Add intercept for stability (even though centered, lstsq handles constant)
    X_design = np.column_stack([np.ones(n_valid), X_norm])
    try:
        coefs, residuals, rank, s = np.linalg.lstsq(X_design, y_norm, rcond=None)
        std_betas = coefs[1:]
        # Unstandardized slopes for what-if simulation: beta_raw_j = std_beta_j * (y_std / x_std_j)
        raw_slopes = std_betas * (y_std / X_stds)
    except Exception:
        std_betas = np.zeros(k)
        raw_slopes = np.zeros(k)

    def calc_r2(feature_indices: tuple[int, ...]) -> float:
        if not feature_indices:
            return 0.0
        X_sub = np.column_stack([np.ones(n_valid), X_norm[:, feature_indices]])
        try:
            c_sub, _, _, _ = np.linalg.lstsq(X_sub, y_norm, rcond=None)
            y_pred = X_sub @ c_sub
            ss_res = np.sum((y_norm - y_pred)**2)
            ss_tot = np.sum((y_norm - np.mean(y_norm))**2)
            r2 = 1.0 - (ss_res / max(1e-9, ss_tot))
            return max(0.0, min(1.0, float(r2)))
        except Exception:
            return 0.0

    full_r2 = calc_r2(tuple(range(k)))

    # Compute VIF for each driver: VIF_j = 1 / (1 - R_j^2)
    vifs = []
    zero_variance_drivers = [actual_drivers[idx] for idx, s in enumerate(X_stds) if np.std(X[:, idx]) < 1e-9]
    for j in range(k):
        if np.std(X[:, j]) < 1e-9:
            vifs.append(1.0)
            continue
        other_indices = tuple(i for i in range(k) if i != j)
        if not other_indices:
            vifs.append(1.0)
            continue
        X_others = np.column_stack([np.ones(n_valid), X_norm[:, other_indices]])
        try:
            c_other, _, _, _ = np.linalg.lstsq(X_others, X_norm[:, j], rcond=None)
            pred_xj = X_others @ c_other
            ss_res_j = np.sum((X_norm[:, j] - pred_xj)**2)
            ss_tot_j = np.sum(X_norm[:, j]**2)
            r2_j = 1.0 - (ss_res_j / max(1e-9, ss_tot_j))
            vif_j = 1.0 / max(1e-4, 1.0 - r2_j)
            vifs.append(round(float(vif_j), 2))
        except Exception:
            vifs.append(1.0)

    vif_max = max(vifs) if vifs else 1.0

    # Shapley / LMG decomposition
    shapley_values = np.zeros(k, dtype=float)

    if k <= max_exact_drivers:
        # Precompute R2 for all subsets
        r2_cache: dict[tuple[int, ...], float] = {}
        for size in range(k + 1):
            for combo in itertools.combinations(range(k), size):
                r2_cache[combo] = calc_r2(combo)

        # Shapley weight formula: |S|! (k - |S| - 1)! / k!
        fact_k = math.factorial(k)
        for j in range(k):
            others = [i for i in range(k) if i != j]
            phi_j = 0.0
            for size in range(k):
                w_s = (math.factorial(size) * math.factorial(k - size - 1)) / fact_k
                for S in itertools.combinations(others, size):
                    S_with_j = tuple(sorted(S + (j,)))
                    marginal = r2_cache[S_with_j] - r2_cache[S]
                    phi_j += w_s * marginal
            shapley_values[j] = max(0.0, phi_j)
    else:
        # Sampling permutation approximation on a local RNG: never reseed or
        # advance the caller's global np.random state (contract).
        _rng = np.random.default_rng(42)
        n_samples = min(n_sample_permutations, 500)
        phi_sum = np.zeros(k, dtype=float)
        for _ in range(n_samples):
            perm = _rng.permutation(k)
            prev_r2 = 0.0
            curr_subset: list[int] = []
            for item in perm:
                curr_subset.append(item)
                curr_r2 = calc_r2(tuple(sorted(curr_subset)))
                phi_sum[item] += max(0.0, curr_r2 - prev_r2)
                prev_r2 = curr_r2
        shapley_values = phi_sum / n_samples

    # Normalize Shapley percentages; zero total explanatory power stays zero
    # instead of fabricating an even 100% split.
    sum_shapley = np.sum(shapley_values)
    if sum_shapley > 1e-6:
        importance_pcts = (shapley_values / sum_shapley) * 100.0
    else:
        importance_pcts = np.zeros(k)
        warnings_explain_none = True
    warnings = []
    if sum_shapley <= 1e-6:
        warnings.append("説明力がほぼゼロのため重要度は0%として返します。最優先ドライバーは提示しません。")

    # Rank drivers and generate diagnostic notes
    drivers_out = []
    # Rank by Shapley % desc
    shap_rank_order = np.argsort(-importance_pcts)
    corr_rank_order = np.argsort(-np.abs(np.array(pearson_rs)))

    shap_ranks = {idx: rank for rank, idx in enumerate(shap_rank_order)}
    corr_ranks = {idx: rank for rank, idx in enumerate(corr_rank_order)}

    if zero_variance_drivers:
        warnings.append(f"分散が0のドライバーが含まれています: {', '.join(zero_variance_drivers)}")
    if vif_max > 10.0:
        warnings.append(f"最大VIFが {vif_max:.1f} と高く、強い多重共線性が存在します。Shapley重要度により共線性影響を補正済みです。")

    for j in range(k):
        d_name = actual_drivers[j]
        d_label = meta_by_col.get(d_name, {}).get("label") or d_name
        s_rank = shap_ranks[j]
        c_rank = corr_ranks[j]

        note = "主因"
        if sum_shapley <= 1e-6:
            note = "説明力なし"
        elif c_rank < s_rank - 1:
            note = "⚠️見かけの相関（共線性により真の寄与は控えめ）"
        elif s_rank < c_rank - 1:
            note = "💎隠れた重要ドライバー（相関以上の貢献度）"
        elif importance_pcts[j] > 25.0:
            note = "最優先キードライバー"

        drivers_out.append({
            "name": d_name,
            "label": d_label,
            "kind": "numeric",
            "importance_raw": round(float(shapley_values[j]), 4),
            "importance_pct": round(float(importance_pcts[j]), 2),
            "direction": 1 if std_betas[j] >= 0 else -1,
            "standardized_coef": round(float(std_betas[j]), 4),
            "raw_slope": round(float(raw_slopes[j]), 4),
            "pearson_r": pearson_rs[j],
            "vif": vifs[j],
            "note": note,
        })

    # Sort drivers descending by importance_pct
    drivers_out.sort(key=lambda d: d["importance_pct"], reverse=True)

    return {
        "run_id": str(uuid.uuid4()),
        "method": method,
        "outcome": {
            "name": outcome,
            "label": meta_by_col.get(outcome, {}).get("label") or outcome,
            "type": "numeric",
        },
        "model": {
            "r_squared": round(full_r2, 4),
            "n_valid": n_valid,
            "vif_max": vif_max,
            "vif_coverage": "all_drivers",
            "warnings": warnings,
        },
        "drivers": drivers_out,
        "what_if_baseline": {
            "outcome_mean": round(y_mean, 4),
            "driver_means": {d: round(float(m), 4) for d, m in zip(actual_drivers, X_means)},
            "raw_slopes": {d: round(float(s), 4) for d, s in zip(actual_drivers, raw_slopes)},
        },
    }
