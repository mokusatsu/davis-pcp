"""Multiple linear regression pure numeric kernel (Feature 032, production).

Implements DAVIS-FEAT-032-DESIGN sections 2-6 on already-clean arrays:

- Weighted least squares via scipy.linalg.lstsq gelsd (never the normal
  equations inverse for point estimates). bread comes from the SVD of Xw
  after rank verification.
- classical covariance only for none/frequency; HC3 with the per-replica
  leverage form for frequency; survey Taylor delegated to
  algorithms/survey/model_covariance (full design frame, scope-outside rows
  kept with score 0).
- Fit statistics (centered/uncentered R2, adjusted R2, RMSE, residual
  standard error, condition number, AIC/BIC only for classical with SSE>0),
  t inference, robust Wald joint F, standardized effects for numeric main
  effects only, and diagnostics (leverage split, studentized, Cook,
  weighted VIF, QQ positions).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
from scipy import linalg, stats

RANK_TOL_FALLBACK = 1e-12
LEVERAGE_ONE_TOL = 1e-12
VIF_SINGULAR_TOL = 1e-12


class LinearRegressionNumericRangeError(ValueError):
    """A required quantity cannot be represented as a finite float64."""

    def __init__(self, field: str):
        self.field = field
        super().__init__("LR_NUMERIC_RANGE")


def normalize_response(y: np.ndarray) -> tuple[np.ndarray, float]:
    """Keep response squares in range; retain the original unit separately.

    Inference, R2 and standardized diagnostics are homogeneous in y. Working
    in these units avoids overflowing SSE/TSS even when every reported
    coefficient, standard error, RMSE and stored covariance is representable.
    """
    vec = np.asarray(y, dtype=np.float64)
    if not np.isfinite(vec).all():
        raise LinearRegressionNumericRangeError("response")
    scale = float(np.max(np.abs(vec))) if vec.size else 0.0
    if scale == 0.0:
        return vec.copy(), 1.0
    normalized = vec / scale
    if np.any((vec != 0) & (normalized == 0)):
        raise LinearRegressionNumericRangeError("normalizedResponse")
    return normalized, scale


def rescale_response_quantity(value: Any, scale: float, power: int = 1,
                              *, field: str = "result") -> Any:
    """Restore y or y² units without ever forming scale².

    frexp/ldexp also avoid losing a small intermediate that becomes finite
    after scaling. A nonzero value rounded to zero is an explicit range
    failure, not a fabricated zero variance/standard error.
    """
    values = np.asarray(value, dtype=np.float64)
    if not np.isfinite(values).all() or not math.isfinite(scale) or scale <= 0:
        raise LinearRegressionNumericRangeError(field)
    mantissa, exponent = np.frexp(values)
    scale_mantissa, scale_exponent = math.frexp(scale)
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        restored = np.ldexp(mantissa * scale_mantissa ** power,
                            exponent + power * scale_exponent)
    if (not np.isfinite(restored).all()
            or np.any((values != 0) & (restored == 0))):
        raise LinearRegressionNumericRangeError(field)
    return float(restored) if restored.ndim == 0 else restored


def _finite_matrix(name: str, mat: np.ndarray) -> np.ndarray:
    arr = np.asarray(mat, dtype=np.float64)
    if arr.ndim != 2 or not np.isfinite(arr).all():
        raise ValueError(f"{name} requires a finite 2D float64 matrix")
    return arr


def solve_weighted_least_squares(
    x: np.ndarray,
    y: np.ndarray,
    weights: np.ndarray | list[float] | None,
) -> dict[str, Any]:
    """Solve WLS via gelsd and build bread from the verified SVD of Xw."""
    mat = _finite_matrix("X", x)
    vec = np.asarray(y, dtype=np.float64)
    if vec.ndim != 1 or vec.shape[0] != mat.shape[0]:
        raise ValueError("y must be a finite vector matching X rows")
    if not np.isfinite(vec).all():
        raise ValueError("y must be a finite vector matching X rows")
    n, p = mat.shape
    if p < 1:
        raise ValueError("LR_DESIGN_EMPTY")
    if weights is None:
        w = np.ones(n, dtype=np.float64)
    else:
        w = np.asarray(weights, dtype=np.float64)
        if w.shape != (n,) or not np.isfinite(w).all() or (w < 0).any():
            raise ValueError("LR kernel requires finite nonnegative weights")
    sqrt_w = np.sqrt(w)
    xw = sqrt_w[:, None] * mat
    numerical_y, response_scale = normalize_response(vec)
    yw = sqrt_w * numerical_y
    cond = float(np.finfo(float).eps) * max(xw.shape) if xw.size else 0.0
    beta, _resid, rank, _sv = linalg.lstsq(xw, yw, cond=cond, lapack_driver="gelsd")
    beta = np.asarray(beta, dtype=np.float64).reshape((p,))
    if int(rank) != p:
        raise ValueError("LR_RANK_DEFICIENT")
    _u, s_vals, vt = linalg.svd(xw, full_matrices=False, check_finite=True)
    s_vals = np.asarray(s_vals, dtype=np.float64)
    rank_tol = max(RANK_TOL_FALLBACK, float(np.finfo(float).eps) * max(xw.shape) * (float(s_vals[0]) if len(s_vals) else 0.0))
    if (s_vals <= rank_tol).any():
        raise ValueError("LR_RANK_DEFICIENT")
    # Dependent-column candidates: null direction with the largest loading.
    null_candidates: list[int] = []
    try:
        _uf, sf, vtf = linalg.svd(xw, full_matrices=True, check_finite=True)
        tail = vtf[int(rank):, :] if int(rank) < vtf.shape[0] else np.zeros((0, p))
        for row in tail:
            if np.isfinite(row).all() and float(np.abs(row).max()) > 0:
                null_candidates.append(int(np.argmax(np.abs(row))))
    except Exception:
        null_candidates = []
    inv = 1.0 / (s_vals * s_vals)
    bread = (vt.T * inv) @ vt
    cond_number = float(s_vals[0] / s_vals[-1]) if len(s_vals) and s_vals[-1] > 0 else float("inf")
    fitted = mat @ beta
    residual = numerical_y - fitted
    sse = float(np.dot(w, residual * residual))
    beta = rescale_response_quantity(beta, response_scale, field="estimates")
    fitted = rescale_response_quantity(fitted, response_scale, field="fitted")
    residual = rescale_response_quantity(residual, response_scale, field="residual")
    # A direct kernel caller requests SSE in original units. The API instead
    # keeps this internal sum in normalized units through all inference.
    sse = rescale_response_quantity(sse, response_scale, 2, field="sse")
    return {
        "beta": beta,
        "bread": np.asarray(bread, dtype=np.float64),
        "singularValues": s_vals,
        "rank": int(rank),
        "rankTol": float(rank_tol),
        "nullCandidates": sorted(set(null_candidates)),
        "conditionNumber": float(cond_number),
        "fitted": fitted,
        "residual": residual,
        "sse": float(sse),
        "weights": w,
    }


def classical_covariance(sse: float, n_stat: float, p: int, bread: np.ndarray) -> tuple[np.ndarray, float]:
    """Classical covariance sigma^2 * bread with sigma^2 = SSE/(nStat-p)."""
    bread = np.asarray(bread, dtype=np.float64)
    dof = float(n_stat) - int(p)
    if not np.isfinite(dof) or dof <= 0:
        raise ValueError("LR_RESIDUAL_DF_NONPOSITIVE")
    if not np.isfinite(sse) or sse < 0:
        raise ValueError("LR_INVALID_SSE")
    sigma2 = float(sse) / float(dof)
    if not np.isfinite(sigma2) or sigma2 < 0:
        raise ValueError("LR_INVALID_SSE")
    return np.asarray(sigma2 * bread, dtype=np.float64), float(sigma2)


def hc3_covariance(
    x: np.ndarray,
    residual: np.ndarray,
    weights: np.ndarray | None,
    bread: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, list[int]]:
    """HC3 covariance.

    Non-weighted rows use h=x'Bx with meat=sum x x' e^2/(1-h)^2. Frequency
    rows treat f as replicated independent observations: per-replica
    leverage h0=x'Bx and meat=sum f x x' e^2/(1-h0)^2. f^2 or f*h0 in the
    denominator are forbidden by the design.
    """
    mat = _finite_matrix("X", x)
    resid = np.asarray(residual, dtype=np.float64).reshape((-1,))
    n = mat.shape[0]
    if resid.shape[0] != n:
        raise ValueError("residual length must match X rows")
    bread = np.asarray(bread, dtype=np.float64)
    if weights is None:
        f = np.ones(n, dtype=np.float64)
    else:
        f = np.asarray(weights, dtype=np.float64)
        if f.shape != (n,) or not np.isfinite(f).all() or (f < 0).any():
            raise ValueError("LR kernel requires finite nonnegative weights")
    xb = mat @ bread
    h0 = np.einsum("ij,ij->i", xb, mat)
    bad = [int(i) for i, h in enumerate(h0.tolist()) if h >= 1.0 - LEVERAGE_ONE_TOL]
    if bad:
        raise ValueError("HC3_LEVERAGE_ONE")
    denom = np.square(1.0 - h0)
    scaled = (f * np.square(resid) / denom)[:, None] * mat
    meat = mat.T @ scaled
    cov = bread @ meat @ bread
    return np.asarray(cov, dtype=np.float64), np.asarray(h0, dtype=np.float64), bad


def fit_statistics(
    y: np.ndarray,
    weights: np.ndarray | list[float] | None,
    sse: float,
    intercept: bool,
    n_stat: float | None,
    p: int,
) -> dict[str, Any]:
    """R2/RMSE/residual-SE/AIC/BIC per the Feature 032 design."""
    vec = np.asarray(y, dtype=np.float64).reshape((-1,))
    if weights is None:
        w = np.ones(vec.shape[0], dtype=np.float64)
    else:
        w = np.asarray(weights, dtype=np.float64)
    w_sum = float(w.sum())
    if intercept:
        y_bar = float(np.dot(w, vec) / w_sum) if w_sum > 0 else float("nan")
        tss = float(np.dot(w, np.square(vec - y_bar)))
        r2_type = "centered"
    else:
        tss = float(np.dot(w, np.square(vec)))
        r2_type = "uncentered"
    if not np.isfinite(tss) or tss <= 0:
        r2: float | None = None
    else:
        r2 = float(1.0 - float(sse) / float(tss))
    rmse = float(math.sqrt(float(sse) / w_sum)) if w_sum > 0 else None
    residual_se: float | None = None
    residual_df: float | None = None
    if n_stat is not None:
        dof = float(n_stat) - int(p)
        residual_df = float(dof)
        if dof > 0 and np.isfinite(sse):
            residual_se = float(math.sqrt(float(sse) / float(dof)))
        else:
            residual_se = None
    adjusted: float | None = None
    if r2 is not None and n_stat is not None:
        dof = float(n_stat) - int(p)
        denom = float(n_stat) - (1 if intercept else 0)
        if dof > 0 and denom > 0:
            adjusted = float(1.0 - (1.0 - float(r2)) * (float(n_stat) - (1 if intercept else 0)) / float(dof))
    return {
        "rSquared": r2,
        "rSquaredType": r2_type,
        "adjustedRSquared": adjusted,
        "rmse": rmse,
        "residualStdError": residual_se,
        "residualDf": residual_df,
        "totalSumSquares": float(tss) if np.isfinite(tss) else None,
        "weightSum": float(w_sum),
    }


def gaussian_loglik_aic_bic(sse: float, n_stat: float, p: int) -> dict[str, float | None]:
    """Classical Gaussian logLik/AIC/BIC with kAic=p+1 (error variance counts)."""
    if not np.isfinite(sse) or sse <= 0 or not np.isfinite(n_stat) or n_stat <= 0:
        return {"logLikelihood": None, "aic": None, "bic": None, "kAic": int(p) + 1}
    n = float(n_stat)
    loglik = float(-n / 2.0 * (math.log(2.0 * math.pi) + 1.0 + math.log(float(sse) / n)))
    k = int(p) + 1
    if not np.isfinite(loglik):
        return {"logLikelihood": None, "aic": None, "bic": None, "kAic": k}
    return {
        "logLikelihood": float(loglik),
        "aic": float(-2.0 * loglik + 2.0 * k),
        "bic": float(-2.0 * loglik + k * math.log(n)),
        "kAic": k,
    }


def t_inference(
    beta: np.ndarray,
    cov: np.ndarray | None,
    reference_df: float | None,
    confidence_level: float,
) -> list[dict[str, Any]]:
    """Per-coefficient t statistics, two-sided p values, and CIs."""
    coefs = np.asarray(beta, dtype=np.float64).reshape((-1,))
    alpha = 1.0 - float(confidence_level)
    rows: list[dict[str, Any]] = []
    for j in range(coefs.shape[0]):
        if cov is None:
            rows.append({
                "standardError": None, "statistic": None, "pValue": None,
                "ciLower": None, "ciUpper": None, "reason": "INFERENCE_UNAVAILABLE",
            })
            continue
        var = float(cov[j, j]) if cov.shape == (coefs.shape[0], coefs.shape[0]) and np.isfinite(cov[j, j]) else float("nan")
        if not np.isfinite(var) or var < 0:
            rows.append({
                "standardError": None, "statistic": None, "pValue": None,
                "ciLower": None, "ciUpper": None, "reason": "INFERENCE_UNAVAILABLE",
            })
            continue
        se = float(math.sqrt(var))
        if se == 0.0:
            rows.append({
                "standardError": 0.0, "statistic": None, "pValue": None,
                "ciLower": None, "ciUpper": None, "reason": "ZERO_STANDARD_ERROR",
            })
            continue
        if reference_df is None or not np.isfinite(reference_df) or float(reference_df) <= 0:
            rows.append({
                "standardError": se, "statistic": None, "pValue": None,
                "ciLower": None, "ciUpper": None, "reason": "INFERENCE_UNAVAILABLE",
            })
            continue
        stat = float(coefs[j] / se)
        if not np.isfinite(stat):
            rows.append({
                "standardError": se, "statistic": None, "pValue": None,
                "ciLower": None, "ciUpper": None, "reason": "INFERENCE_UNAVAILABLE",
            })
            continue
        p_value = float(2.0 * stats.t.sf(abs(stat), float(reference_df)))
        if not np.isfinite(p_value):
            p_value = None
        crit = float(stats.t.ppf(1.0 - alpha / 2.0, float(reference_df)))
        if not np.isfinite(crit):
            rows.append({
                "standardError": se, "statistic": stat, "pValue": p_value,
                "ciLower": None, "ciUpper": None, "reason": "INFERENCE_UNAVAILABLE",
            })
            continue
        rows.append({
            "standardError": se, "statistic": stat, "pValue": p_value,
            "ciLower": float(coefs[j] - crit * se), "ciUpper": float(coefs[j] + crit * se),
            "reason": None,
        })
    return rows


def joint_wald_test(
    beta: np.ndarray,
    cov: np.ndarray | None,
    slope_positions: list[int],
    reference_df: float | None,
    kind: str,
) -> dict[str, Any]:
    """Joint F over non-intercept slopes: classical F or robust Wald F."""
    coefs = np.asarray(beta, dtype=np.float64).reshape((-1,))
    positions = [int(v) for v in slope_positions]
    if not positions or cov is None:
        return {"kind": kind if positions else None, "statistic": None,
                "dfNumerator": None, "dfDenominator": reference_df,
                "pValue": None, "reason": "INFERENCE_UNAVAILABLE"}
    sub_beta = coefs[positions]
    sub_cov = np.asarray(cov, dtype=np.float64)[np.ix_(positions, positions)]
    q = int(sub_beta.shape[0])
    if q < 1 or not np.isfinite(sub_cov).all():
        return {"kind": kind, "statistic": None, "dfNumerator": q or None,
                "dfDenominator": reference_df, "pValue": None,
                "reason": "INFERENCE_UNAVAILABLE"}
    try:
        solved = linalg.solve(sub_cov, sub_beta, assume_a="sym")
    except Exception:
        return {"kind": kind, "statistic": None, "dfNumerator": q,
                "dfDenominator": reference_df, "pValue": None,
                "reason": "SINGULAR_JOINT_COVARIANCE"}
    if not np.isfinite(solved).all():
        return {"kind": kind, "statistic": None, "dfNumerator": q,
                "dfDenominator": reference_df, "pValue": None,
                "reason": "SINGULAR_JOINT_COVARIANCE"}
    stat = float(sub_beta @ solved / q)
    if not np.isfinite(stat) or stat < 0:
        return {"kind": kind, "statistic": None, "dfNumerator": q,
                "dfDenominator": reference_df, "pValue": None,
                "reason": "INFERENCE_UNAVAILABLE"}
    if kind == "classical_f" and reference_df is not None and np.isfinite(reference_df) and float(reference_df) > 0:
        p_value = float(stats.f.sf(stat, q, float(reference_df)))
        return {"kind": kind, "statistic": stat, "dfNumerator": q,
                "dfDenominator": float(reference_df),
                "pValue": p_value if np.isfinite(p_value) else None, "reason": None}
    if kind == "robust_wald_f" and reference_df is not None and np.isfinite(reference_df) and float(reference_df) > 0:
        p_value = float(stats.f.sf(stat, q, float(reference_df)))
        return {"kind": kind, "statistic": stat, "dfNumerator": q,
                "dfDenominator": float(reference_df),
                "pValue": p_value if np.isfinite(p_value) else None, "reason": None}
    return {"kind": kind, "statistic": stat, "dfNumerator": q,
            "dfDenominator": reference_df, "pValue": None,
            "reason": "INFERENCE_UNAVAILABLE"}


def standardized_effects(
    x: np.ndarray,
    y: np.ndarray,
    weights: np.ndarray | list[float] | None,
    beta: np.ndarray,
    numeric_main_positions: dict[int, bool],
) -> list[dict[str, Any]]:
    """Standardized effects for numeric main effects only (ddof=0, same weights)."""
    mat = np.asarray(x, dtype=np.float64)
    vec = np.asarray(y, dtype=np.float64).reshape((-1,))
    coefs = np.asarray(beta, dtype=np.float64).reshape((-1,))
    if weights is None:
        w = np.ones(vec.shape[0], dtype=np.float64)
    else:
        w = np.asarray(weights, dtype=np.float64)
    w_sum = float(w.sum())
    out: list[dict[str, Any]] = []
    if w_sum <= 0:
        for _ in range(coefs.shape[0]):
            out.append({"value": None, "reason": "NOT_COMPARABLE_STANDARDIZED_EFFECT"})
        return out
    y_bar = float(np.dot(w, vec) / w_sum)
    y_sd = float(math.sqrt(np.dot(w, np.square(vec - y_bar)) / w_sum))
    for j in range(coefs.shape[0]):
        if not numeric_main_positions.get(int(j), False):
            out.append({"value": None, "reason": "NOT_COMPARABLE_STANDARDIZED_EFFECT"})
            continue
        col = mat[:, j]
        x_bar = float(np.dot(w, col) / w_sum)
        x_sd = float(math.sqrt(np.dot(w, np.square(col - x_bar)) / w_sum))
        if not np.isfinite(x_sd) or x_sd <= 0 or not np.isfinite(y_sd) or y_sd <= 0:
            out.append({"value": None, "reason": "NOT_COMPARABLE_STANDARDIZED_EFFECT"})
            continue
        out.append({"value": float(coefs[j] * x_sd / y_sd), "reason": None})
    return out


def non_survey_diagnostics(
    x: np.ndarray,
    residual: np.ndarray,
    weights: np.ndarray | list[float] | None,
    bread: np.ndarray,
    sigma2: float | None,
    p: int,
) -> dict[str, Any]:
    """Per-replica leverage/total leverage, studentized residuals, Cook distances."""
    mat = _finite_matrix("X", x)
    resid = np.asarray(residual, dtype=np.float64).reshape((-1,))
    n = mat.shape[0]
    if weights is None:
        f = np.ones(n, dtype=np.float64)
    else:
        f = np.asarray(weights, dtype=np.float64)
    bread = np.asarray(bread, dtype=np.float64)
    h0 = np.einsum("ij,jk,ik->i", mat, bread, mat)
    h_total = f * h0
    studentized: list[float | None] = []
    cooks: list[float | None] = []
    for i in range(n):
        denom = 1.0 - float(h0[i])
        if sigma2 is None or not np.isfinite(sigma2) or sigma2 <= 0 or denom <= 0:
            studentized.append(None)
            cooks.append(None)
            continue
        studentized.append(float(resid[i] / (math.sqrt(sigma2) * math.sqrt(denom))))
        cooks.append(float(resid[i] * resid[i] * float(h0[i]) / (int(p) * sigma2 * denom * denom)) if int(p) > 0 else None)
    return {
        "leveragePerReplica": [float(v) for v in h0.tolist()],
        "leverageTotal": [float(v) for v in h_total.tolist()],
        "studentizedResidual": studentized,
        "cooksDistance": cooks,
    }


def survey_leverage(x: np.ndarray, weights: np.ndarray, bread: np.ndarray) -> list[float]:
    """Geometric survey leverage w*x'Bx (diagnostic only, not Cook/studentized)."""
    mat = _finite_matrix("X", x)
    w = np.asarray(weights, dtype=np.float64)
    bread = np.asarray(bread, dtype=np.float64)
    h0 = np.einsum("ij,jk,ik->i", mat, bread, mat)
    return [float(a * b) for a, b in zip(w.tolist(), h0.tolist())]


def weighted_vif(
    x: np.ndarray,
    weights: np.ndarray | list[float] | None,
    intercept_present: bool,
    column_ids: list[str],
) -> list[dict[str, Any]]:
    """Design-column VIF via auxiliary weighted regressions with one intercept."""
    mat = _finite_matrix("X", x)
    n, p = mat.shape
    if weights is None:
        w = np.ones(n, dtype=np.float64)
    else:
        w = np.asarray(weights, dtype=np.float64)
    positions = [j for j in range(p) if not (intercept_present and j == 0)]
    out: list[dict[str, Any]] = []
    for j in positions:
        target = mat[:, j]
        others = np.delete(mat, j, axis=1)
        # Avoid a duplicated intercept: drop a constant sibling when the model
        # already carries one, then add exactly one auxiliary intercept.
        keep_cols: list[np.ndarray] = []
        for k in range(others.shape[1]):
            col = others[:, k]
            if intercept_present and float(np.var(col)) <= 0:
                continue
            keep_cols.append(col)
        aux = np.column_stack([np.ones(n), *keep_cols]) if keep_cols else np.ones((n, 1))
        if float(np.var(target)) <= 0:
            out.append({"designColumnId": column_ids[j], "value": None, "status": "constant"})
            continue
        try:
            aux_fit = solve_weighted_least_squares(aux, target, w)
        except ValueError:
            out.append({"designColumnId": column_ids[j], "value": None,
                        "status": "perfect_collinearity"})
            continue
        resid = target - aux @ aux_fit["beta"]
        w_sum = float(w.sum())
        if w_sum <= 0:
            out.append({"designColumnId": column_ids[j], "value": None,
                        "status": "perfect_collinearity"})
            continue
        mean = float(np.dot(w, target) / w_sum)
        tss = float(np.dot(w, np.square(target - mean)))
        sse = float(np.dot(w, np.square(resid)))
        if not np.isfinite(tss) or tss <= 0:
            out.append({"designColumnId": column_ids[j], "value": None, "status": "constant"})
            continue
        r2 = 1.0 - sse / tss
        if (1.0 - r2) <= VIF_SINGULAR_TOL:
            out.append({"designColumnId": column_ids[j], "value": None,
                        "status": "perfect_collinearity"})
            continue
        out.append({"designColumnId": column_ids[j], "value": float(1.0 / (1.0 - r2)),
                    "status": "available"})
    return out


def qq_positions(residual: np.ndarray, weights: np.ndarray | list[float] | None) -> dict[str, Any]:
    """Normal QQ display positions.

    Unweighted rows use (i-0.5)/n; frequency rows use the mid-CDF
    (cumulative-before + f/2)/sum(f). Survey callers must label the weighted
    CDF reference explicitly; this helper never claims a normality test.
    """
    resid = np.asarray(residual, dtype=np.float64).reshape((-1,))
    order = np.argsort(resid, kind="stable")
    sorted_resid = resid[order]
    if weights is None:
        n = len(sorted_resid)
        positions = [(i + 0.5) / n for i in range(n)] if n else []
        return {"order": [int(v) for v in order.tolist()],
                "sortedResidual": [float(v) for v in sorted_resid.tolist()],
                "position": positions, "kind": "uniform"}
    f = np.asarray(weights, dtype=np.float64)
    total = float(f.sum())
    if total <= 0:
        return {"order": [int(v) for v in order.tolist()],
                "sortedResidual": [float(v) for v in sorted_resid.tolist()],
                "position": [None] * len(sorted_resid), "kind": "weighted_mid_cdf"}
    ordered_w = f[order]
    cum_before = np.concatenate([[0.0], np.cumsum(ordered_w)[:-1]])
    positions_w = ((cum_before + ordered_w / 2.0) / total).tolist()
    return {"order": [int(v) for v in order.tolist()],
            "sortedResidual": [float(v) for v in sorted_resid.tolist()],
            "position": [float(v) for v in positions_w], "kind": "weighted_mid_cdf"}


def _mean_response_standard_error(x_row: np.ndarray, cov: np.ndarray | None) -> float | None:
    """Square root of x'Cov x without overflowing its quadratic intermediate."""
    if cov is None:
        return None
    row = np.asarray(x_row, dtype=np.float64).reshape((-1,))
    mat = np.asarray(cov, dtype=np.float64)
    if (mat.shape != (row.shape[0], row.shape[0])
            or not np.isfinite(mat).all() or not np.isfinite(row).all()):
        return None
    mat_scale = float(np.max(np.abs(mat))) if mat.size else 0.0
    row_scale = float(np.max(np.abs(row))) if row.size else 0.0
    if mat_scale == 0 or row_scale == 0:
        return 0.0
    normalized_row = row / row_scale
    var = float(normalized_row @ (mat / mat_scale) @ normalized_row)
    if not np.isfinite(var) or var < 0:
        return None
    se = math.sqrt(var) * math.sqrt(mat_scale)
    return rescale_response_quantity(se, row_scale, field="prediction.standardError")


def mean_ci_half_width(x_row: np.ndarray, cov: np.ndarray | None, t_crit: float | None) -> float | None:
    """Half width of the mean-response CI from the adopted coefficient covariance."""
    if t_crit is None or not np.isfinite(t_crit) or t_crit <= 0:
        return None
    se = _mean_response_standard_error(x_row, cov)
    if se is None:
        return None
    return rescale_response_quantity(se, t_crit, field="prediction.meanCiHalfWidth")


def individual_pi_half_width(
    x_row: np.ndarray,
    cov: np.ndarray | None,
    sigma2: float | None,
    t_crit: float | None,
    classical_available: bool,
) -> float | None:
    """Individual PI half width; classical non-survey fits only."""
    if not classical_available or sigma2 is None or not np.isfinite(sigma2) or sigma2 < 0:
        return None
    mean_se = _mean_response_standard_error(x_row, cov)
    if mean_se is None or t_crit is None or not np.isfinite(t_crit) or t_crit <= 0:
        return None
    total_se = math.hypot(mean_se, math.sqrt(sigma2))
    return rescale_response_quantity(total_se, t_crit,
                                     field="prediction.individualPiHalfWidth")
