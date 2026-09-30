"""Principal Component Analysis (PCA) computational core for DAVIS PCA Suite."""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl
from sklearn.decomposition import PCA

from ...domain.errors import BizError


def compute_pca(
    df: pl.DataFrame,
    columns: list[str] | None = None,
    use_correlation: bool = True,
    n_components: int | None = None,
    row_ids: list[str] | None = None,
) -> dict[str, Any]:
    if "__rowId__" not in df.columns:
        df = df.with_columns(pl.int_range(0, df.height).cast(pl.String).alias("__rowId__"))

    if row_ids is not None:
        wanted = set(row_ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))

    if df.height < 2:
        raise BizError("PCA_INSUFFICIENT_ROWS", "PCAには2行以上の有効データが必要です。", details={"rowCount": df.height})


    # Filter columns
    all_numeric = [c for c in df.columns if c != "__rowId__" and df[c].dtype in (pl.Float32, pl.Float64, pl.Int8, pl.Int16, pl.Int32, pl.Int64, pl.UInt8, pl.UInt16, pl.UInt32, pl.UInt64)]
    if columns is None:
        selected_columns = all_numeric
    else:
        for c in columns:
            if c not in df.columns:
                raise BizError("PCA_COLUMN_NOT_FOUND", f"列 '{c}' がデータセットに見つかりません。", details={"column": c})
            if c not in all_numeric:
                raise BizError("PCA_NON_NUMERIC_COLUMN", f"列 '{c}' は数値型ではありません。", details={"column": c})
        selected_columns = columns

    if len(selected_columns) < 2:
        raise BizError("PCA_INSUFFICIENT_COLUMNS", "PCAの実行には2つ以上の数値列が必要です。", details={"columns": selected_columns})

    # Extract matrix and row IDs
    row_id_list = df["__rowId__"].to_list() if "__rowId__" in df.columns else [str(i) for i in range(df.height)]
    raw_matrix = []
    for c in selected_columns:
        raw_matrix.append(df[c].cast(pl.Float64).to_list())
    
    # X shape: (N, p)
    X = np.array(raw_matrix, dtype=np.float64).T

    # Drop NaNs
    valid_mask = np.isfinite(X).all(axis=1)
    if not np.any(valid_mask):
        raise BizError("PCA_ALL_ROWS_NAN", "指定された列に有効な（非欠損）データ行がありません。")

    X_clean = X[valid_mask]
    clean_row_ids = [r for r, v in zip(row_id_list, valid_mask) if v]
    n_samples, p = X_clean.shape

    if n_samples < 2:
        raise BizError("PCA_INSUFFICIENT_ROWS", "非欠損値を持つデータが2行未満です。")

    # A constant variable has no correlation and contributes no covariance.
    # Detect constants in the analysed rows, after scope and missing filtering.
    constant_mask = np.all(X_clean == X_clean[0], axis=0)
    constant_columns = [name for name, constant in zip(selected_columns, constant_mask) if constant]
    if constant_mask.all():
        raise BizError("PCA_ZERO_VARIANCE", "対象行ではすべての分析変数が定数です。分散がないためPCAを計算できません。",
                       details={"columns": constant_columns})
    warnings = []
    if constant_columns:
        warnings.append({"code": "PCA_CONSTANT_COLUMNS_EXCLUDED",
                         "message": f"対象行で値が一定の列をPCAから除外しました: {', '.join(constant_columns)}",
                         "details": {"columns": constant_columns}})
        selected_columns = [name for name, constant in zip(selected_columns, constant_mask) if not constant]
        X_clean = X_clean[:, ~constant_mask]
        p = len(selected_columns)

    # Center and scale
    mean = np.mean(X_clean, axis=0)
    X_centered = X_clean - mean
    
    if use_correlation:
        # Sample std with ddof=1
        std = np.std(X_clean, axis=0, ddof=1)
        # Prevent division by zero for constant columns
        std[std == 0] = 1.0
        X_scaled = X_centered / std
    else:
        X_scaled = X_centered

    max_k = min(n_samples - 1, p)
    k = max_k if n_components is None or n_components <= 0 else min(n_components, max_k)

    full = PCA(n_components=max_k)
    full.fit(X_scaled)
    full_eigenvalues = full.explained_variance_
    pca = PCA(n_components=k)
    scores = pca.fit_transform(X_scaled)
    eigenvalues = pca.explained_variance_
    explained_variance_ratio = pca.explained_variance_ratio_
    cumulative_variance_ratio = np.cumsum(explained_variance_ratio)
    eigenvectors = pca.components_  # shape: (k, p)

    # Kaiser threshold: eigenvalue >= 1.0 for correlation matrix, or mean eigenvalue for covariance.
    # Always from the full spectrum, never from a truncated request (contract).
    kaiser_val = 1.0 if use_correlation else float(np.mean(full_eigenvalues))
    kaiser_count = int(np.sum(eigenvalues >= kaiser_val))
    if kaiser_count == 0:
        kaiser_count = 1

    # Factor loadings: L_jk = v_k,j * sqrt(lambda_k)
    # Shape of eigenvectors: (k, p)
    # Loadings shape: (p, k)
    loadings: dict[str, list[float]] = {}
    for j, col_name in enumerate(selected_columns):
        col_loadings = []
        for comp_idx in range(k):
            load_val = eigenvectors[comp_idx, j] * np.sqrt(max(0.0, eigenvalues[comp_idx]))
            col_loadings.append(round(float(load_val), 4))
        loadings[col_name] = col_loadings

    # Format scores
    formatted_scores = []
    for r_id, sc in zip(clean_row_ids, scores):
        formatted_scores.append({
            "rowId": r_id,
            "row_id": r_id,
            "pc": [round(float(val), 4) for val in sc],
        })

    return {
        "columns": selected_columns,
        "excludedConstantColumns": constant_columns,
        "warnings": warnings,
        "nSamples": n_samples,
        "n_samples": n_samples,
        "nComponents": k,
        "n_components": k,
        "useCorrelation": use_correlation,
        "use_correlation": use_correlation,
        "eigenvalues": [round(float(e), 5) for e in eigenvalues],
        "explainedVarianceRatio": [round(float(r), 4) for r in explained_variance_ratio],
        "explained_variance_ratio": [round(float(r), 4) for r in explained_variance_ratio],
        "cumulativeVarianceRatio": [round(float(c), 4) for c in cumulative_variance_ratio],
        "cumulative_variance_ratio": [round(float(c), 4) for c in cumulative_variance_ratio],
        "kaiserThreshold": round(kaiser_val, 4),
        "kaiserThresholdComponents": kaiser_count,
        "kaiser_threshold_components": kaiser_count,
        "eigenvectors": [[round(float(v), 6) for v in comp] for comp in eigenvectors],
        "loadings": loadings,
        "scores": formatted_scores,
        "evidenceClass": "MODERN-EXTENSION",
    }
