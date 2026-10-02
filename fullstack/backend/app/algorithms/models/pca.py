"""Principal Component Analysis (PCA) computational core for DAVIS PCA Suite."""
from __future__ import annotations

from typing import Any
import numpy as np
import polars as pl
from sklearn.decomposition import PCA

from ...domain.errors import BizError
from ._scaling import normalized_columns


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

    # Remove physical units before centering or squaring. Correlation PCA is
    # invariant to independent positive column rescaling, including units whose
    # squares are outside float64 even though the observations are finite.
    unit, mean, std, _ = normalized_columns(X_clean, "PCA_NUMERIC_RANGE")
    if use_correlation:
        X_scaled = (unit - mean) / std
        output_scale = 1.0
    else:
        # A common factor preserves covariance PCA's relative variable scales.
        # Keep it factored until after SVD so nonrepresentable eigenvalues are
        # an explicit range error, not zero/Infinity returned as a successful PCA.
        output_scale = float(np.max(np.abs(X_clean)))
        unit = X_clean / output_scale
        X_scaled = unit - np.mean(unit, axis=0)
    if not np.isfinite(X_scaled).all() or np.any(np.all(X_scaled == X_scaled[0], axis=0)):
        raise BizError("PCA_NUMERIC_RANGE", "変数の標準化が数値の表現範囲外です。変数の単位を変更してください。",
                       status_code=422, details={"stage": "standardization", "useCorrelation": use_correlation})

    max_k = min(n_samples - 1, p)
    k = max_k if n_components is None or n_components <= 0 else min(n_components, max_k)

    full = PCA(n_components=max_k, svd_solver="full")
    full.fit(X_scaled)
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        full_eigenvalues = (full.explained_variance_ * output_scale) * output_scale
        scores = full.transform(X_scaled)[:, :k] * output_scale
    if (not np.isfinite(full_eigenvalues).all() or not np.isfinite(scores).all()
            or np.any((full.explained_variance_ > 0) & (full_eigenvalues == 0))
            or not np.isfinite(full.explained_variance_ratio_).all()):
        raise BizError("PCA_NUMERIC_RANGE", "主成分の分散または得点が数値の表現範囲外です。変数の単位を変更してください。",
                       status_code=422, details={"stage": "spectrum", "useCorrelation": use_correlation})
    eigenvalues = full_eigenvalues[:k]
    explained_variance_ratio = full.explained_variance_ratio_[:k]
    cumulative_variance_ratio = np.cumsum(explained_variance_ratio)
    eigenvectors = full.components_[:k]  # shape: (k, p)

    # Kaiser threshold: eigenvalue >= 1.0 for correlation matrix, or mean eigenvalue for covariance.
    # Always from the full spectrum, never from a truncated request (contract).
    # Include implicit zero eigenvalues when there are more variables than rows.
    kaiser_val = 1.0 if use_correlation else float(np.sum(full_eigenvalues / p))
    kaiser_count = int(np.sum(full_eigenvalues >= kaiser_val))
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
            col_loadings.append(float(load_val))
        loadings[col_name] = col_loadings

    # Format scores
    formatted_scores = []
    for r_id, sc in zip(clean_row_ids, scores):
        formatted_scores.append({
            "rowId": r_id,
            "row_id": r_id,
            "pc": [float(val) for val in sc],
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
        "eigenvalues": [float(e) for e in eigenvalues],
        "explainedVarianceRatio": [round(float(r), 4) for r in explained_variance_ratio],
        "explained_variance_ratio": [round(float(r), 4) for r in explained_variance_ratio],
        "cumulativeVarianceRatio": [round(float(c), 4) for c in cumulative_variance_ratio],
        "cumulative_variance_ratio": [round(float(c), 4) for c in cumulative_variance_ratio],
        "kaiserThreshold": kaiser_val,
        "kaiserThresholdComponents": kaiser_count,
        "kaiser_threshold_components": kaiser_count,
        "eigenvectors": [[round(float(v), 6) for v in comp] for comp in eigenvectors],
        "loadings": loadings,
        "scores": formatted_scores,
        "evidenceClass": "MODERN-EXTENSION",
    }
