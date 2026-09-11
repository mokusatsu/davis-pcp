"""Variance-Covariance and Precision Matrix computational engine."""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl

from ...domain.errors import BizError


def compute_covariance(
    df: pl.DataFrame,
    columns: list[str] | None = None,
    row_ids: list[str] | None = None,
) -> dict[str, Any]:
    """Compute Variance-Covariance Matrix, Correlation Matrix, and Precision Matrix (Inverse Covariance)."""
    if "__rowId__" not in df.columns:
        df = df.with_columns(pl.int_range(0, df.height).cast(pl.String).alias("__rowId__"))

    if row_ids is not None:
        # An explicit empty selection is a valid empty scope, never a silent
        # expansion to all data: fail loudly instead of computing on all rows.
        if len(row_ids) == 0:
            raise BizError("COV_EMPTY_SELECTION", "対象行が0件です。",
                           status_code=422)
        wanted = set(row_ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))

    numeric_dtypes = (
        pl.Float32, pl.Float64,
        pl.Int8, pl.Int16, pl.Int32, pl.Int64,
        pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64,
    )
    all_numeric = [c for c in df.columns if c != "__rowId__" and df[c].dtype in numeric_dtypes]

    if columns is None or len(columns) == 0:
        selected_cols = all_numeric
    else:
        selected_cols = [c for c in columns if c in all_numeric]

    if len(selected_cols) < 2:
        raise BizError("COV_INSUFFICIENT_COLUMNS", "共分散行列の計算には最低2つ以上の数値列が必要です。", details={"columns": selected_cols})

    sub_df = df.select(selected_cols).drop_nulls()
    n = sub_df.height
    if n < 3:
        raise BizError("COV_INSUFFICIENT_ROWS", "共分散行列の計算には最低3行以上の有効データが必要です。", details={"rowCount": n})

    p = len(selected_cols)
    X = sub_df.to_numpy().astype(float)  # shape (n, p)

    # Means
    means = np.mean(X, axis=0)

    # Covariance Matrix Sigma (ddof=1)
    cov_matrix = np.cov(X, rowvar=False)

    # Standard deviations
    stds = np.sqrt(np.diag(cov_matrix))
    stds_safe = np.where(stds == 0, 1e-12, stds)

    # Correlation Matrix
    corr_matrix = cov_matrix / np.outer(stds_safe, stds_safe)
    np.fill_diagonal(corr_matrix, 1.0)

    # Precision Matrix (Inverse Covariance) with pseudo-inverse fallback
    try:
        prec_matrix = np.linalg.inv(cov_matrix)
    except np.linalg.LinAlgError:
        prec_matrix = np.linalg.pinv(cov_matrix)

    # Partial correlation matrix from precision matrix:
    # r_ij.rest = - P_ij / sqrt(P_ii * P_jj)
    diag_prec = np.sqrt(np.abs(np.diag(prec_matrix)))
    diag_prec_safe = np.where(diag_prec == 0, 1e-12, diag_prec)
    partial_corr = -prec_matrix / np.outer(diag_prec_safe, diag_prec_safe)
    np.fill_diagonal(partial_corr, 1.0)

    # Generalized variance: det(Sigma). A duplicated column makes Sigma
    # singular (non-finite inverse, NaN-prone JSON): reject explicitly unless
    # the caller accepts the pseudo-inverse path via allow_singular. The
    # audit contract requires finite JSON or an explicit rejection.
    sign, logdet = np.linalg.slogdet(cov_matrix)
    cond_number = float(np.linalg.cond(cov_matrix))
    if not (np.all(np.isfinite(cov_matrix)) and np.isfinite(cond_number)) or cond_number > 1e12:
        raise BizError("COV_SINGULAR", "共分散行列が特異です。",
                       status_code=422,
                       details={"conditionNumber": cond_number if np.isfinite(cond_number) else None})
    gen_var = float(sign * np.exp(logdet)) if logdet < 700 else float("inf")
    trace_var = float(np.trace(cov_matrix))

    # Format output as nested dict or 2D arrays
    return {
        "columns": selected_cols,
        "nRows": n,
        "means": {col: round(float(m), 4) for col, m in zip(selected_cols, means)},
        "stds": {col: round(float(s), 4) for col, s in zip(selected_cols, stds)},
        "covariance": [[round(float(cov_matrix[i, j]), 5) for j in range(p)] for i in range(p)],
        "correlation": [[round(float(corr_matrix[i, j]), 4) for j in range(p)] for i in range(p)],
        "precision": [[round(float(prec_matrix[i, j]), 5) for j in range(p)] for i in range(p)],
        "partialCorrelation": [[round(float(partial_corr[i, j]), 4) for j in range(p)] for i in range(p)],
        "diagnostics": {
            "generalizedVariance": round(gen_var, 6) if not np.isinf(gen_var) else "inf",
            "logGeneralizedVariance": round(float(logdet), 4),
            "totalVariance": round(trace_var, 5),
            "conditionNumber": round(cond_number, 2),
            "isSingular": bool(cond_number > 1e12),
        },
    }
