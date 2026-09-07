"""Clusters, outliers, dendrograms APIs."""
from __future__ import annotations

import time
from typing import Any, Literal

import numpy as np
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel

from ..algorithms.clustering import core as clustering
from ..algorithms.clustering.core import silhouette_summary
from ..algorithms.clustering.cobweb import cobweb_cluster
from ..algorithms.clustering.disc import disc_cluster
from ..algorithms.outliers.core import detect as detect_outliers
from ..domain.errors import BizError
from ..services.dataset_service import now_iso
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()


def _numeric_matrix(dataset_id: str, columns: list[str], row_ids: list[str] | None = None,
                    scaling: str = "none") -> tuple[np.ndarray, list[str], dict]:
    meta = store.get_meta(dataset_id)
    df = store.get_dataframe(dataset_id)
    if row_ids is not None:
        wanted = set(row_ids)
        df = df.filter(pl.col("__rowId__").is_in(list(wanted)))
    missing_cols = [c for c in columns if c not in df.columns]
    if missing_cols:
        raise BizError("COLUMN_NOT_FOUND", f"列が見つかりません: {', '.join(missing_cols)}",
                       details={"columnIds": missing_cols})
    arrays = []
    kept_columns: list[str] = []
    dropped_columns: list[str] = []
    for c in columns:
        series = df[c]
        if series.dtype == pl.String:
            raise BizError("CLUSTERING_NON_NUMERIC_COLUMN", f"数値以外の列は指定できません: {c}",
                           details={"columnIds": [c]},
                           suggested_actions=["数値軸のみを選択してください"])
        col_values = [np.nan if v is None else float(v) for v in series.to_list()]
        # Audit #13: drop all-NaN and zero-variance columns — they carry no
        # clustering signal and break z-scaling / covariance paths.
        finite = [v for v in col_values if not np.isnan(v)]
        if not finite:
            dropped_columns.append(c)
            continue
        if len(set(finite)) == 1:
            dropped_columns.append(c)
            continue
        arrays.append(col_values)
        kept_columns.append(c)
    if not arrays:
        raise BizError("CLUSTERING_NO_USABLE_COLUMNS",
                       "クラスタリングに使用できる(欠損や定数でない)数値列がありません。",
                       details={"droppedColumns": dropped_columns},
                       suggested_actions=["数値値を含む列を指定してください"])
    matrix = np.array(arrays).T
    if dropped_columns:
        columns[:] = kept_columns
    col_means = np.nanmean(matrix, axis=0)
    nan_idx = np.where(np.isnan(matrix))
    matrix[nan_idx] = np.take(col_means, nan_idx[1])
    if scaling == "zscore":
        std = matrix.std(axis=0, ddof=1)
        std[std == 0] = 1.0
        matrix = (matrix - matrix.mean(axis=0)) / std
    elif scaling == "minmax":
        mins, maxs = matrix.min(axis=0), matrix.max(axis=0)
        spans = maxs - mins
        spans[spans == 0] = 1.0
        matrix = (matrix - mins) / spans
    return matrix, df["__rowId__"].to_list(), meta


class ClusterRequest(BaseModel):
    datasetId: str
    method: Literal["kmeans", "kmedoids", "divisive", "gmm", "class_variable", "agglomerative", "cobweb", "disc"]
    columns: list[str]
    k: int = 3
    seed: int = 42
    scaling: str = "none"
    maxIter: int = 300
    tolerance: float = 1e-4
    linkage: str = "average"
    distance: str = "euclidean"
    cutThreshold: float | None = None
    classColumn: str | None = None
    acuity: float = 0.1
    cutoff: float = 0.001
    alphaSmooth: float = 0.6
    numWeight: float = 1.0
    categoricalColumns: list[str] | None = None


_cluster_results: dict[str, dict] = {}


@router.post("/clusters")
def create_cluster(req: ClusterRequest) -> dict:
    started = time.perf_counter()
    if req.method == "class_variable":
        if not req.classColumn:
            raise BizError("CLASS_COLUMN_REQUIRED", "class_variableにはclassColumnの指定が必要です。")
        meta = store.get_meta(req.datasetId)
        df = store.get_dataframe(req.datasetId)
        classes = df[req.classColumn].cast(pl.String).to_list()
        result = clustering.class_variable(classes)
        columns_used = [req.classColumn]
        row_ids = df["__rowId__"].to_list()
    else:
        is_cat_clustering = req.method in ("cobweb", "disc") and bool(req.categoricalColumns)
        if not req.columns and not is_cat_clustering:
            raise BizError("CLUSTERING_NO_COLUMNS", "クラスタリング対象の列がありません。",
                           suggested_actions=["数値軸またはカテゴリ軸を含むデータセットを使用してください"])

        if req.columns:
            matrix, row_ids, _meta = _numeric_matrix(req.datasetId, req.columns, scaling=req.scaling)
            columns_used = req.columns
        else:
            matrix = None
            df = store.get_dataframe(req.datasetId)
            row_ids = df["__rowId__"].to_list() if "__rowId__" in df.columns else [str(i) for i in range(df.height)]
            columns_used = req.categoricalColumns or []

        if len(set(row_ids)) < req.k:
            raise BizError("CLUSTERING_TOO_FEW_ROWS", f"クラスタ数{req.k}に対して行が足りません。",
                           suggested_actions=["クラスタ数を減らす"])
        if req.method == "kmeans":
            result = clustering.kmeans(matrix, req.k, req.seed, req.maxIter, req.tolerance)
        elif req.method == "kmedoids":
            result = clustering.kmedoids(matrix, req.k, req.distance)
        elif req.method == "divisive":
            result = clustering.divisive(matrix, req.k, req.seed)
        elif req.method == "gmm":
            result = clustering.gaussian_mixture(matrix, req.k, req.seed, req.maxIter)
        elif req.method == "cobweb":
            cat_cols = None
            if req.categoricalColumns:
                df = store.get_dataframe(req.datasetId)
                cat_cols = [df[c].cast(pl.String).to_list() for c in req.categoricalColumns if c in df.columns]
            result = cobweb_cluster(matrix, cat_columns=cat_cols, k=req.k, acuity=req.acuity, cutoff=req.cutoff)
        elif req.method == "disc":
            cat_cols = None
            if req.categoricalColumns:
                df = store.get_dataframe(req.datasetId)
                cat_cols = [df[c].cast(pl.String).to_list() for c in req.categoricalColumns if c in df.columns]
            result = disc_cluster(
                matrix,
                cat_columns=cat_cols,
                column_names=req.categoricalColumns if cat_cols else req.columns,
                k=req.k,
                max_iter=min(req.maxIter, 50),
                seed=req.seed,
                alpha_smooth=req.alphaSmooth,
                num_weight=req.numWeight,
            )
        else:
            result = clustering.agglomerative(matrix, req.k, req.linkage, req.distance, req.cutThreshold)
    runtime_ms = (time.perf_counter() - started) * 1000
    silhouette = None
    pca_projection = None
    if req.method != "class_variable" and matrix is not None:
        if len(set(result["labels"])) >= 2:
            try:
                silhouette = silhouette_summary(matrix, result["labels"])
            except Exception:
                silhouette = None
        # PCA projection to the first two principal components for 2D display.
        try:
            centered = matrix - matrix.mean(axis=0)
            std = centered.std(axis=0, ddof=1)
            std[std == 0] = 1.0
            z = centered / std
            covariance = (z.T @ z) / max(1, len(z) - 1)
            eigenvalues, eigenvectors = np.linalg.eigh(covariance)
            order = np.argsort(eigenvalues)[::-1][:2]
            components = eigenvectors[:, order]
            projected = z @ components
            total_var = float(eigenvalues.sum())
            pca_projection = {
                "pc1": [round(float(v), 5) for v in projected[:, 0]],
                "pc2": [round(float(v), 5) for v in projected[:, 1]],
                "varianceRatio": [
                    round(float(eigenvalues[order[0]] / total_var), 4),
                    round(float(eigenvalues[order[1]] / total_var), 4),
                ],
            }
        except Exception:
            pca_projection = None
    result_id = f"clu-{int(time.time() * 1000):x}"
    payload = {
        "resultId": result_id,
        "datasetId": req.datasetId,
        "method": req.method,
        "algorithmVersion": result.get("algorithmVersion", "2.0.0"),
        "evidenceClass": result.get("evidenceClass", "RECONSTRUCTED"),
        "columns": columns_used,
        "scaling": req.scaling if req.method != "class_variable" else "none",
        "seed": req.seed,
        "rowIds": row_ids,
        "labels": result["labels"],
        "k": result["k"],
        "diagnostics": {**result.get("diagnostics", {}), "runtimeMs": round(runtime_ms, 2)},
        "linkageMatrix": result.get("linkageMatrix"),
        "conceptTree": result.get("conceptTree"),
        "categoryMatrices": result.get("categoryMatrices"),
        "silhouette": silhouette,
        "pcaProjection": pca_projection,
        "createdAt": now_iso(),
    }
    _cluster_results[result_id] = payload
    return payload


@router.get("/clusters/{result_id}")
def get_cluster(result_id: str) -> dict:
    if result_id not in _cluster_results:
        raise BizError("CLUSTER_RESULT_NOT_FOUND", f"クラスタ結果 {result_id} が見つかりません。", status_code=404)
    return _cluster_results[result_id]


class DendrogramRequest(BaseModel):
    clusterResultId: str


@router.post("/dendrograms")
def create_dendrogram(req: DendrogramRequest) -> dict:
    cluster = get_cluster(req.clusterResultId)
    if not cluster.get("linkageMatrix"):
        raise BizError(
            "DENDROGRAM_REQUIRES_HIERARCHICAL",
            "階層的クラスタリング(agglomerative)の結果のみDendrogramを描画できます。",
            details={"method": cluster["method"]},
            suggested_actions=["method=agglomerativeで再実行してください"],
        )
    return {
        "dendrogramId": f"dnd-{req.clusterResultId}",
        "clusterResultId": req.clusterResultId,
        "linkageMatrix": cluster["linkageMatrix"],
        "rowIds": cluster["rowIds"],
        "labels": cluster["labels"],
        "evidenceClass": cluster["evidenceClass"],
    }


@router.get("/dendrograms/{result_id}")
def get_dendrogram(result_id: str) -> dict:
    cluster_result_id = result_id.replace("dnd-", "")
    return create_dendrogram(DendrogramRequest(clusterResultId=cluster_result_id))


class OutlierRequest(BaseModel):
    datasetId: str
    method: Literal["iqr", "robust_z", "isolation_forest", "lof"]
    columns: list[str]
    contamination: float = 0.05
    seed: int = 42
    threshold: float = 3.5
    scaling: str = "none"


_outlier_results: dict[str, dict] = {}


@router.post("/outliers")
def create_outliers(req: OutlierRequest) -> dict:
    started = time.perf_counter()
    if not req.columns:
        raise BizError("OUTLIER_NO_COLUMNS", "外れ値検出対象の数値列がありません。",
                       suggested_actions=["数値軸を含むデータセットを使用してください"])
    matrix, row_ids, _meta = _numeric_matrix(req.datasetId, req.columns, scaling=req.scaling)
    result = detect_outliers(req.method, matrix, contamination=req.contamination,
                             seed=req.seed, threshold=req.threshold)
    runtime_ms = (time.perf_counter() - started) * 1000
    result_id = f"out-{int(time.time() * 1000):x}"
    payload = {
        "resultId": result_id,
        "datasetId": req.datasetId,
        "method": result["method"],
        "algorithmVersion": result["algorithmVersion"],
        "evidenceClass": result["evidenceClass"],
        "columns": req.columns,
        "rowIds": row_ids,
        "outlierRowIds": [rid for rid, flag in zip(row_ids, result["flags"]) if flag],
        "count": result["count"],
        "diagnostics": {**result["diagnostics"], "runtimeMs": round(runtime_ms, 2)},
        "createdAt": now_iso(),
    }
    _outlier_results[result_id] = payload
    return payload


@router.get("/outliers/{result_id}")
def get_outliers(result_id: str) -> dict:
    if result_id not in _outlier_results:
        raise BizError("OUTLIER_RESULT_NOT_FOUND", f"外れ値結果 {result_id} が見つかりません。", status_code=404)
    return _outlier_results[result_id]
