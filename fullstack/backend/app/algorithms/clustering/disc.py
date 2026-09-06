"""DISC (AAAI 2026): Learning Cluster-Customized Category Relationships for Categorical Data Clustering.

Reference:
Zhao et al., AAAI 2026 / arXiv:2511.09049:
"Break the Tie: Learning Cluster-Customized Category Relationships for Categorical Data Clustering"
"""
from __future__ import annotations

from typing import Any
import numpy as np


def _discretize_numeric(matrix: np.ndarray, n_bins: int = 5) -> list[list[str]]:
    """Convert continuous numeric matrix into categorical bin columns."""
    n_rows, n_cols = matrix.shape
    cat_cols: list[list[str]] = []
    for col_idx in range(n_cols):
        vals = matrix[:, col_idx]
        valid_vals = vals[~np.isnan(vals)]
        if len(valid_vals) == 0 or np.all(valid_vals == valid_vals[0]):
            cat_cols.append([f"Q1" for _ in range(n_rows)])
            continue
        qs = np.linspace(0, 100, n_bins + 1)
        bin_edges = np.percentile(valid_vals, qs)
        # remove duplicate edges
        bin_edges = np.unique(bin_edges)
        if len(bin_edges) <= 2:
            mid = np.median(valid_vals)
            col_cats = [f"High" if v >= mid else f"Low" for v in vals]
        else:
            bin_idx = np.digitize(vals, bin_edges[1:-1])
            col_cats = [f"Bin-{b + 1}" for b in bin_idx]
        cat_cols.append(col_cats)
    return cat_cols


def disc_cluster(
    num_matrix: np.ndarray | None,
    cat_columns: list[list[str]] | None = None,
    column_names: list[str] | None = None,
    k: int = 3,
    max_iter: int = 50,
    seed: int = 42,
    alpha_smooth: float = 0.6,
    num_weight: float = 1.0,
) -> dict[str, Any]:
    """Execute DISC clustering with cluster-customized category relationship learning."""
    rng = np.random.default_rng(seed)

    if cat_columns is None or len(cat_columns) == 0:
        if num_matrix is None:
            raise ValueError("Either num_matrix or cat_columns must be provided.")
        # Discretize continuous columns
        cat_columns = _discretize_numeric(num_matrix, n_bins=5)
        cat_names = [f"{column_names[i]}_cat" if column_names else f"col_{i}_cat" for i in range(len(cat_columns))]
    else:
        cat_names = column_names if column_names else [f"cat_{i}" for i in range(len(cat_columns))]

    n_rows = len(cat_columns[0])
    n_cat_cols = len(cat_columns)

    # Encode categories into integer indices
    cat_maps: list[dict[str, int]] = []
    inv_cat_maps: list[list[str]] = []
    encoded_cat = np.zeros((n_rows, n_cat_cols), dtype=np.int32)

    for j, col in enumerate(cat_columns):
        unique_cats = sorted(list(set(col)))
        c_map = {c: idx for idx, c in enumerate(unique_cats)}
        cat_maps.append(c_map)
        inv_cat_maps.append(unique_cats)
        for i, val in enumerate(col):
            encoded_cat[i, j] = c_map[val]

    # Global co-occurrence context vectors for prior smoothing
    # For attribute j, category a, compute co-occurrence distribution over all categories of other attributes
    total_context_dim = sum(len(cats) for cats in inv_cat_maps)
    offsets = np.cumsum([0] + [len(cats) for cats in inv_cat_maps[:-1]])

    global_context = []
    for j in range(n_cat_cols):
        v_j = len(inv_cat_maps[j])
        ctx = np.zeros((v_j, total_context_dim), dtype=np.float64)
        for i in range(n_rows):
            a = encoded_cat[i, j]
            for other_j in range(n_cat_cols):
                if other_j != j:
                    other_a = encoded_cat[i, other_j]
                    ctx[a, offsets[other_j] + other_a] += 1.0
        # Normalize
        row_sums = ctx.sum(axis=1, keepdims=True)
        row_sums[row_sums == 0] = 1.0
        ctx /= row_sums
        global_context.append(ctx)

    # Compute global baseline distances
    global_dist = []
    for j in range(n_cat_cols):
        v_j = len(inv_cat_maps[j])
        d_mat = np.zeros((v_j, v_j), dtype=np.float64)
        for a in range(v_j):
            for b in range(a + 1, v_j):
                dist = 0.5 * np.sum(np.abs(global_context[j][a] - global_context[j][b]))
                d_mat[a, b] = dist
                d_mat[b, a] = dist
        global_dist.append(d_mat)

    # Initialize cluster relationship matrices M[k, j] = global_dist[j]
    cluster_matrices: list[list[np.ndarray]] = []
    for _ in range(k):
        cluster_matrices.append([d.copy() for d in global_dist])

    # Initial cluster assignments (random or stratified)
    labels = rng.integers(0, k, size=n_rows)
    # Ensure all clusters are non-empty initially
    for c in range(k):
        labels[c % n_rows] = c

    # Numerical feature normalization
    if num_matrix is not None:
        num_std = np.nanstd(num_matrix, axis=0)
        num_std[num_std == 0] = 1.0
        num_norm = (num_matrix - np.nanmean(num_matrix, axis=0)) / num_std
    else:
        num_norm = None

    prototypes_cat = np.zeros((k, n_cat_cols), dtype=np.int32)
    prototypes_num = np.zeros((k, num_matrix.shape[1])) if num_matrix is not None else None

    # Alternating Optimization Loop
    converged = False
    iteration = 0
    prev_labels = labels.copy()

    for iteration in range(1, max_iter + 1):
        # 1. Update prototypes
        for cluster_idx in range(k):
            mask = (labels == cluster_idx)
            if not np.any(mask):
                continue
            for j in range(n_cat_cols):
                # Mode of categorical
                counts = np.bincount(encoded_cat[mask, j], minlength=len(inv_cat_maps[j]))
                prototypes_cat[cluster_idx, j] = int(np.argmax(counts))
            if num_norm is not None:
                prototypes_num[cluster_idx] = np.mean(num_norm[mask], axis=0)

        # 2. Update cluster-customized relationship matrices M[k, j]
        for cluster_idx in range(k):
            mask = (labels == cluster_idx)
            n_c = int(np.sum(mask))
            if n_c < 2:
                # Keep global or previous matrix
                continue

            for j in range(n_cat_cols):
                v_j = len(inv_cat_maps[j])
                cluster_ctx = np.zeros((v_j, total_context_dim), dtype=np.float64)
                cluster_rows = np.where(mask)[0]
                for i in cluster_rows:
                    a = encoded_cat[i, j]
                    for other_j in range(n_cat_cols):
                        if other_j != j:
                            other_a = encoded_cat[i, other_j]
                            cluster_ctx[a, offsets[other_j] + other_a] += 1.0

                row_sums = cluster_ctx.sum(axis=1, keepdims=True)
                has_counts = (row_sums.ravel() > 0)
                row_sums[row_sums == 0] = 1.0
                cluster_ctx /= row_sums

                # Blend with global context (shrinkage / smoothing)
                smoothed_ctx = cluster_ctx.copy()
                for a in range(v_j):
                    if has_counts[a]:
                        smoothed_ctx[a] = alpha_smooth * cluster_ctx[a] + (1.0 - alpha_smooth) * global_context[j][a]
                    else:
                        smoothed_ctx[a] = global_context[j][a]

                # Update distance matrix
                for a in range(v_j):
                    for b in range(a + 1, v_j):
                        dist = 0.5 * np.sum(np.abs(smoothed_ctx[a] - smoothed_ctx[b]))
                        cluster_matrices[cluster_idx][j][a, b] = float(dist)
                        cluster_matrices[cluster_idx][j][b, a] = float(dist)
                    cluster_matrices[cluster_idx][j][a, a] = 0.0

        # 3. Update cluster assignments
        distances = np.zeros((n_rows, k), dtype=np.float64)
        for cluster_idx in range(k):
            proto_c = prototypes_cat[cluster_idx]
            for j in range(n_cat_cols):
                mat_kj = cluster_matrices[cluster_idx][j]
                pj = proto_c[j]
                # lookup distance from x_ij to prototype pj
                distances[:, cluster_idx] += mat_kj[encoded_cat[:, j], pj]

            if num_norm is not None:
                proto_num = prototypes_num[cluster_idx]
                diff = num_norm - proto_num
                sq_dist = np.sum(diff * diff, axis=1)
                distances[:, cluster_idx] += num_weight * sq_dist

        new_labels = np.argmin(distances, axis=1)

        # Check convergence
        changed = int(np.sum(new_labels != labels))
        labels = new_labels
        if changed == 0:
            converged = True
            break

    # Format cluster-customized relationship matrices for frontend
    formatted_matrices: dict[str, dict[str, Any]] = {}
    for cluster_idx in range(k):
        formatted_matrices[str(cluster_idx)] = {}
        for j in range(n_cat_cols):
            attr_name = cat_names[j]
            categories = inv_cat_maps[j]
            d_mat = cluster_matrices[cluster_idx][j]
            formatted_matrices[str(cluster_idx)][attr_name] = {
                "categories": categories,
                "matrix": [[round(float(v), 4) for v in row] for row in d_mat],
            }

    unique_clusters = sorted(list(set(labels.tolist())))
    cluster_counts = {str(c): int(np.sum(labels == c)) for c in unique_clusters}

    return {
        "method": "disc",
        "k": len(unique_clusters),
        "labels": labels.tolist(),
        "evidenceClass": "MODERN-EXTENSION",
        "algorithmVersion": "2.0.0-disc-aaai2026",
        "categoryMatrices": formatted_matrices,
        "diagnostics": {
            "converged": converged,
            "iterations": iteration,
            "clusterCounts": cluster_counts,
            "catAttributes": cat_names,
            "alphaSmooth": alpha_smooth,
            "numWeight": num_weight,
        },
    }
