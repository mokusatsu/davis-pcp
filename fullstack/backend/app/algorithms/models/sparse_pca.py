"""SparsePCA's nonorthogonal B/W/T contract; no ordinary-PCA eigenvalues."""
from __future__ import annotations

import math
import warnings
from dataclasses import dataclass

import numpy as np
from sklearn.decomposition import SparsePCA
from sklearn.linear_model import ridge_regression

from ...domain.errors import BizError
from ...domain.sparse_pca_contracts import SparsePcaConvergence, SparsePcaDetails, SparsePcaRequest, SparsePcaSummary
from ...domain.sparse_pca_frame import PreparedSparsePcaFrame

MAX_ROWS = 10000
MAX_VARIABLES = 100
MAX_COMPONENTS = 20
MAX_WORK = 150_000_000
RANK_TOLERANCE = 1e-15  # sklearn ridge SVD's absolute singular-value cutoff (1.6/1.9)


@dataclass(frozen=True)
class SparsePcaFit:
    summary: SparsePcaSummary
    details: SparsePcaDetails
    scores: np.ndarray
    arrays: dict[str, np.ndarray]
    warnings: list[dict]


def _range(stage: str):
    raise BizError("SPCA_NUMERIC_RANGE", "SparsePCAの数値表現範囲を超えました。変数の単位・設定を見直してください。",
                   status_code=422, details={"stage": stage})


def check_size(n: int, p: int, k: int, iterations: int) -> None:
    work = max(n, 500) * p * k * iterations
    if n > MAX_ROWS or p > MAX_VARIABLES or k > MAX_COMPONENTS or work > MAX_WORK:
        raise BizError("SPCA_SIZE_LIMIT", "SparsePCAの計算規模上限を超えています。行・変数・成分数または最大反復数を減らしてください。",
            status_code=422, details={"nRows": n, "nVariables": p, "nComponents": k,
                "maxIterations": iterations, "workUnits": work,
                "limits": {"nRows": MAX_ROWS, "nVariables": MAX_VARIABLES,
                           "nComponents": MAX_COMPONENTS, "workUnits": MAX_WORK,
                           "minimumRowsForWorkEstimate": 500}})


def diagnose_convergence(history, n_iterations: int, max_iterations: int, tolerance: float) -> SparsePcaConvergence:
    errors = np.asarray(history, dtype=float)
    if errors.ndim != 1 or len(errors) != n_iterations or not len(errors) or not np.isfinite(errors).all() or np.any(errors < 0):
        _range("objective_history")
    improvement = float(errors[-2] - errors[-1]) if len(errors) > 1 else None
    # A meaningful increase anywhere is not convergence, even if the last pair
    # later decreases. Relative roundoff is scaled to the actual objective.
    previous, current = errors[:-1], errors[1:]
    slack = 64 * np.finfo(float).eps * np.maximum(np.maximum(np.abs(previous), np.abs(current)), np.finfo(float).tiny)
    increased = bool(np.any(current - previous > slack))
    if increased:
        status = "objective_increase"
    elif improvement is not None and improvement < tolerance * float(errors[-1]):
        status = "tolerance_reached"
    else:
        status = "iteration_limit"
    return SparsePcaConvergence(status=status, nIterations=int(n_iterations), maxIterations=max_iterations,
        tolerance=tolerance, objectiveHistory=errors.tolist(), finalObjective=float(errors[-1]), finalImprovement=improvement)


def score_coefficients(components: np.ndarray, ridge_alpha: float) -> tuple[np.ndarray, int, float]:
    """W maps centered input rows into ridge scores; never invert the Gram."""
    b = np.asarray(components, dtype=float)
    singular = np.linalg.svd(b, compute_uv=False)
    rank = int(np.count_nonzero(singular > RANK_TOLERANCE))
    # Use the same ridge primitive as sklearn.transform. At rho=0 force its
    # SVD least-squares path to guarantee a minimum-norm rank-deficient result.
    w = ridge_regression(b.T, np.eye(b.shape[1]), ridge_alpha,
                         solver="svd" if ridge_alpha == 0 else "cholesky")
    return np.asarray(w, dtype=float).reshape(b.shape[1], b.shape[0]), rank, RANK_TOLERANCE


def _center_columns(x):
    """Subtract a raw anchor before dividing, preserving large-offset deltas.

    Raw subtraction can overflow for opposite endpoints. Only those entries use
    difference-of-normalized-values; their contrast is large, so cancellation is
    not a concern. Both paths represent (A-inputAnchor)/inputMagnitude.
    """
    values = np.asarray(x, dtype=float)
    if values.ndim != 2 or not len(values) or not np.isfinite(values).all():
        _range("input")
    scales = np.max(np.abs(values), axis=0)
    scales = np.where(scales > 0, scales, 1.0)
    anchors = values[0].copy()
    with np.errstate(over="ignore", invalid="ignore", under="ignore"):
        differences = values - anchors
        offsets = differences / scales
    overflow = ~np.isfinite(differences)
    if overflow.any():
        fallback = values / scales - anchors / scales
        offsets[overflow] = fallback[overflow]
    means = offsets.mean(axis=0)
    centered = offsets - means
    if not np.isfinite(centered).all():
        _range("centering")
    return centered, anchors, means, scales


def _normalized_centered(x):
    centered, _, _, scale = _center_columns(x)
    norms = np.sqrt(np.sum(centered * centered, axis=0))
    unit = centered / np.where(norms > 0, norms, 1.0)
    return unit, norms, scale


def correlations(left, right, *, left_reason="constant_variable", right_reason="constant_score"):
    a, an, _ = _normalized_centered(np.asarray(left))
    b, bn, _ = _normalized_centered(np.asarray(right))
    raw = a.T @ b
    values, reasons = [], []
    for i in range(raw.shape[0]):
        row, reason_row = [], []
        for j in range(raw.shape[1]):
            reason = left_reason if an[i] == 0 else right_reason if bn[j] == 0 else None
            value = float(raw[i, j]) if reason is None else None
            if value is not None:
                if not math.isfinite(value) or abs(value) > 1 + 256 * np.finfo(float).eps:
                    _range("correlation")
                value = min(1.0, max(-1.0, value))  # bounded roundoff only
            row.append(value); reason_row.append(reason)
        values.append(row); reasons.append(reason_row)
    return values, reasons


def _variance(scores):
    _, norms, scales = _normalized_centered(scores)
    values, reasons = [], []
    for norm, scale in zip(norms, scales):
        if norm == 0 or scale == 0:
            values.append(0.0); reasons.append(None); continue
        logarithm = 2 * (math.log(float(norm)) + math.log(float(scale))) - math.log(len(scores) - 1)
        if logarithm > math.log(np.finfo(float).max):
            values.append(None); reasons.append("numeric_range_overflow")
        elif logarithm < math.log(float(np.nextafter(0., 1.))):
            values.append(None); reasons.append("numeric_range_underflow")
        else:
            values.append(math.exp(logarithm)); reasons.append(None)
    return values, reasons


def _raw_stat(normalized, magnitude):
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        raw = float(normalized * magnitude)
    if not math.isfinite(raw):
        return None, "numeric_range_overflow"
    if raw == 0 and normalized != 0:
        return None, "numeric_range_underflow"
    return raw, None


def _raw_mean(values):
    """Compensated mean independent of the anchored transform's rounded mean.

    fsum preserves cancellation residuals in original units. If its partial
    sum overflows (even though a finite-input mean is bounded by the inputs),
    accumulate exact binary ratios with Python integers, then divide once.
    The slow fallback is only needed for extreme original-unit sums.
    """
    scalars = [float(value) for value in values]
    try:
        total = math.fsum(scalars)
        mean = total / len(scalars)
        nonzero = total != 0
    except OverflowError:
        ratios = [value.as_integer_ratio() for value in scalars]
        denominator = max(den for _, den in ratios)
        numerator = sum(num * (denominator // den) for num, den in ratios)
        mean = numerator / (denominator * len(scalars))
        nonzero = numerator != 0
    if not math.isfinite(mean):
        return None, "numeric_range_overflow"
    if mean == 0 and nonzero:
        return None, "numeric_range_underflow"
    return float(mean), None


def preprocess(values: np.ndarray, mode: str, column_ids: list[str]):
    centered, anchors, offsets, magnitudes = _center_columns(values)
    sd = np.sqrt(np.sum(centered * centered, axis=0) / (len(values) - 1))
    if not np.isfinite(sd).all() or np.any(sd <= 0):
        _range("standardization")
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        z = centered / sd if mode == "correlation" else centered * magnitudes
    if not np.isfinite(z).all() or np.any(np.all(z == 0, axis=0)):
        _range("preprocessing")
    columns = []
    for j, (cid, anchor, offset, sigma, magnitude) in enumerate(zip(column_ids, anchors, offsets, sd, magnitudes)):
        mean = float(anchor / magnitude + offset)
        raw_mean, mean_reason = _raw_mean(np.asarray(values)[:, j])
        if raw_mean is not None:
            mean = raw_mean / float(magnitude)
        raw_sd, sd_reason = _raw_stat(float(sigma), float(magnitude))
        columns.append({"columnId": cid, "inputMagnitude": float(magnitude),
            "inputAnchor": float(anchor), "normalizedMeanOffset": float(offset),
            "normalizedMean": mean, "normalizedSampleSd": float(sigma),
            "rawMean": raw_mean, "rawMeanReason": mean_reason,
            "rawSampleSd": raw_sd, "rawSampleSdReason": sd_reason})
    return z, columns


def reconstruction_fraction(zc, scores, components):
    with np.errstate(over="ignore", invalid="ignore"):
        reconstruction = scores @ components
    if not np.isfinite(reconstruction).all():
        _range("reconstruction")
    scale = max(float(np.max(np.abs(zc))), float(np.max(np.abs(reconstruction))))
    if scale == 0:
        _range("zero_input_energy")
    z = zc / scale
    residual = z - reconstruction / scale
    denominator = float(np.sum(z * z))
    numerator = float(np.sum(residual * residual))
    if denominator <= 0 or not math.isfinite(numerator):
        _range("reconstruction_norm")
    value = 1 - numerator / denominator
    slack = 1024 * np.finfo(float).eps
    if not math.isfinite(value) or not -slack <= value <= 1 + slack:
        _range("reconstruction_fraction")
    return float(min(1., max(0., value)))


def fit_sparse_pca(frame: PreparedSparsePcaFrame, req: SparsePcaRequest) -> SparsePcaFit:
    values = frame.values
    n, p = values.shape
    check_size(n, p, req.nComponents, req.maxIterations)
    z, columns = preprocess(values, req.preprocessing, [v["columnId"] for v in frame.variables])
    # Do NOT internally rescale covariance input: that would alter alpha's L1
    # problem and optimization trajectory. Check squared-energy headroom first.
    magnitude = float(np.max(np.abs(z)))
    upper = math.sqrt(np.finfo(float).max) / (32 * math.sqrt(n * p))
    lower = 32 * math.sqrt(np.finfo(float).tiny)
    if magnitude > upper or magnitude < lower or req.alpha > upper:
        _range("solver_input_energy")
    estimator = SparsePCA(n_components=req.nComponents, alpha=req.alpha, ridge_alpha=req.ridgeAlpha,
        max_iter=req.maxIterations, tol=req.tolerance, method="lars", n_jobs=1, random_state=req.seed)
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            estimator.fit(z.copy())
            b = np.asarray(estimator.components_, dtype=float)
            w, rank, rank_tolerance = score_coefficients(b, req.ridgeAlpha)
            zc = z - estimator.mean_
            scores = zc @ w
        except (ValueError, FloatingPointError, OverflowError, np.linalg.LinAlgError) as exc:
            raise BizError("SPCA_NUMERIC_RANGE", "SparsePCAの数値計算が安定して完了しませんでした。単位・設定を見直してください。",
                           status_code=422, details={"stage": "fit_or_transform"}) from exc
    if not all(np.isfinite(a).all() for a in (b, w, scores, zc, estimator.mean_)):
        _range("fit_or_transform")
    convergence = diagnose_convergence(estimator.error_, int(estimator.n_iter_), req.maxIterations, req.tolerance)
    fraction = reconstruction_fraction(zc, scores, b)
    variable_corr, variable_reasons = correlations(values, scores)
    score_corr, score_reasons = correlations(scores, scores, left_reason="constant_score")
    score_variance, variance_reasons = _variance(scores)
    nonzero = np.count_nonzero(b, axis=1).tolist()
    summary = SparsePcaSummary(nComponents=req.nComponents, nVariables=p, basisRank=rank,
        nonzeroPerComponent=nonzero, zeroFraction=float(np.count_nonzero(b == 0) / b.size),
        reconstructionFraction=fraction, reconstructionSpace="standardized" if req.preprocessing == "correlation" else "centered_analysis_values",
        convergence=convergence)
    details = SparsePcaDetails(variables=frame.variables, excludedConstantColumns=frame.excluded_constant_columns,
        preprocessing={"mode": req.preprocessing, "columns": columns, "estimatorMean": estimator.mean_.tolist()},
        componentOrder=[f"SP{i + 1}" for i in range(req.nComponents)], components=b.tolist(), scoreCoefficients=w.tolist(),
        variableScoreCorrelations=variable_corr, variableScoreCorrelationReasons=variable_reasons,
        scoreCorrelations=score_corr, scoreCorrelationReasons=score_reasons, componentGram=(b @ b.T).tolist(),
        scoreVariances=score_variance, scoreVarianceReasons=variance_reasons, rankTolerance=rank_tolerance)
    notices = [{"code": "SPCA_SOLVER_WARNING", "message": str(item.message),
                "category": item.category.__name__, "count": 1, "columnIds": []} for item in caught]
    if convergence.status != "tolerance_reached":
        notices.append({"code": "SPCA_" + convergence.status.upper(),
            "message": "学習目的関数が増加しました。探索的な結果として確認してください。" if convergence.status == "objective_increase" else "反復上限に達しました。収束済みの結果ではありません。",
            "count": 1, "columnIds": []})
    if frame.excluded_constant_columns:
        notices.append({"code": "SPCA_CONSTANT_COLUMNS_EXCLUDED", "message": "共通有効行で定数となった列を除外しました。",
            "count": len(frame.excluded_constant_columns), "columnIds": [v["columnId"] for v in frame.excluded_constant_columns]})
    return SparsePcaFit(summary, details, scores, {"components": b, "scoreCoefficients": w, "scores": scores,
        "inputMagnitude": np.asarray([v["inputMagnitude"] for v in columns]),
        "inputAnchor": np.asarray([v["inputAnchor"] for v in columns]),
        "normalizedMeanOffset": np.asarray([v["normalizedMeanOffset"] for v in columns]),
        "normalizedMean": np.asarray([v["normalizedMean"] for v in columns]),
        "normalizedSampleSd": np.asarray([v["normalizedSampleSd"] for v in columns]),
        "estimatorMean": np.asarray(estimator.mean_)}, notices)
