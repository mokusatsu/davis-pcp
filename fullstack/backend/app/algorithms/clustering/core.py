"""Clustering algorithms: KMeans, KMedoids (PAM), Divisive, GMM/EM,
ClassVariable grouping, Agglomerative.

Evidence classes: JAR-INITIAL where the initial JAR bytecode confirmed
behavior (interactive clustering existed in later DAVIS; exact initial
specifications were not recoverable), otherwise RECONSTRUCTED or
MODERN-EXTENSION per order.txt §12.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy.cluster.hierarchy import linkage as scipy_linkage, fcluster
from scipy.spatial.distance import pdist, squareform
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.mixture import GaussianMixture
from sklearn.metrics import silhouette_samples, silhouette_score


def _partition_equivalent(a: np.ndarray, b: np.ndarray) -> bool:
    """Label-permutation-invariant partition equality."""
    if len(a) != len(b):
        return False
    pairs = {}
    for x, y in zip(a, b):
        if x in pairs and pairs[x] != y:
            return False
        pairs[x] = y
    if len(set(pairs.values())) != len(pairs):
        return False
    return True


LINKAGE_MAP = {
    # internal id -> scipy method; names follow the DAVIS materials.
    "nearest": "single",          # Nearest neighbor / single linkage
    "farthest": "complete",       # Farthest neighbor / complete linkage
    "average": "average",         # Average between clusters (UPGMA-like)
    "group_average": "average",   # UPGMA: unweighted pair-group average
}

DISTANCE_MAP = {
    "euclidean": "euclidean",
    "standard_euclidean": "seuclidean",
    "city_block": "cityblock",
}


def silhouette_summary(values: np.ndarray, labels: list[int]) -> dict[str, Any]:
    """Silhouette coefficient per row + per cluster (cluster-quality evidence)."""
    unique = sorted(set(labels))
    if len(unique) < 2 or len(unique) >= len(labels):
        return {"byRow": [0.0] * len(labels), "mean": 0.0,
                "byCluster": [{"label": label, "mean": 0.0, "count": labels.count(label)} for label in unique]}
    sample = silhouette_samples(values, np.array(labels))
    return {
        "byRow": [round(float(v), 4) for v in sample],
        "mean": round(float(silhouette_score(values, np.array(labels))), 4),
        "byCluster": [
            {"label": label, "mean": round(float(sample[np.array(labels) == label].mean()), 4),
             "count": labels.count(label)}
            for label in unique
        ],
    }


def kmeans(values: np.ndarray, k: int, seed: int = 42, max_iter: int = 300,
           tol: float = 1e-4) -> dict[str, Any]:
    model = KMeans(n_clusters=k, random_state=seed, max_iter=max_iter, tol=tol, n_init=10)
    labels = model.fit_predict(values)
    return {
        "labels": labels.tolist(),
        "k": k,
        "inertia": float(model.inertia_),
        "iterations": int(model.n_iter_),
        "converged": bool(model.n_iter_ < max_iter),
        "algorithmVersion": f"sklearn-{KMeans.__module__}",
        "evidenceClass": "RECONSTRUCTED",
        "diagnostics": {"inertia": float(model.inertia_), "clusterSizes": np.bincount(labels).tolist()},
    }


def pam_fit(distance_matrix: np.ndarray, k: int, max_iter: int = 100) -> tuple[np.ndarray, np.ndarray]:
    """Small reference PAM (Kaufman-Rousseeuw BUILD + SWAP)."""
    n = distance_matrix.shape[0]
    first = int(np.argmin(distance_matrix.sum(axis=1)))
    medoids = [first]
    nearest = distance_matrix[:, first].copy()
    while len(medoids) < k:
        gains = np.zeros(n)
        for candidate in range(n):
            if candidate in medoids:
                continue
            gains[candidate] = np.maximum(0, nearest - distance_matrix[:, candidate]).sum()
        best = int(np.argmax(gains))
        medoids.append(best)
        nearest = np.minimum(nearest, distance_matrix[:, best])
    medoid_arr = np.array(medoids)
    for _ in range(max_iter):
        labels = np.argmin(distance_matrix[:, medoid_arr], axis=1)
        total_cost = distance_matrix[np.arange(n), medoid_arr[labels]].sum()
        best_swap = None
        best_cost = total_cost
        medoid_set = set(medoid_arr.tolist())
        for m_index in range(k):
            non_medoids = [i for i in range(n) if i not in medoid_set]
            for swap_in in non_medoids:
                trial = medoid_arr.copy()
                trial[m_index] = swap_in
                trial_labels = np.argmin(distance_matrix[:, trial], axis=1)
                trial_cost = float(distance_matrix[np.arange(n), trial[trial_labels]].sum())
                if trial_cost < best_cost - 1e-12:
                    best_cost = trial_cost
                    best_swap = (m_index, swap_in, trial)
        if best_swap is None:
            break
        medoid_arr = best_swap[2]
    labels = np.argmin(distance_matrix[:, medoid_arr], axis=1)
    return labels, medoid_arr


def kmedoids(values: np.ndarray, k: int, distance: str = "euclidean") -> dict[str, Any]:
    dist = squareform(pdist(values, metric=DISTANCE_MAP.get(distance, "euclidean")))
    labels, medoids = pam_fit(dist, k)
    cost = float(dist[np.arange(len(labels)), medoids[labels]].sum())
    return {
        "labels": labels.tolist(),
        "k": k,
        "medoidRowIndexes": medoids.tolist(),
        "cost": cost,
        "evidenceClass": "RECONSTRUCTED",
        "diagnostics": {"cost": cost, "clusterSizes": np.bincount(labels, minlength=k).tolist()},
    }


def divisive(values: np.ndarray, k: int, seed: int = 42) -> dict[str, Any]:
    """Top-down divisive clustering via recursive 2-mean splits."""
    rng = np.random.default_rng(seed)
    n = len(values)
    labels = np.zeros(n, dtype=int)
    next_label = 1
    while labels.max() + 1 < k:
        sizes = np.bincount(labels)
        target = int(np.argmax(sizes))
        members = np.where(labels == target)[0]
        if len(members) < 2:
            break
        sub = values[members]
        km = KMeans(n_clusters=2, random_state=seed, n_init=10).fit(sub)
        split_labels = km.labels_
        if split_labels.min() == split_labels.max():
            break
        first_half = members[split_labels == 0]
        second_half = members[split_labels == 1]
        labels[second_half] = next_label
        next_label += 1
    return {
        "labels": labels.tolist(),
        "k": int(labels.max() + 1),
        "evidenceClass": "RECONSTRUCTED",
        "diagnostics": {"clusterSizes": np.bincount(labels).tolist(), "seed": seed},
    }


def gaussian_mixture(values: np.ndarray, k: int, seed: int = 42,
                     max_iter: int = 200, reg_covar: float = 1e-6) -> dict[str, Any]:
    model = GaussianMixture(n_components=k, random_state=seed, max_iter=max_iter,
                            reg_covar=reg_covar)
    labels = model.fit_predict(values)
    return {
        "labels": labels.tolist(),
        "k": k,
        "aic": float(model.aic(values)),
        "bic": float(model.bic(values)),
        "converged": bool(model.converged_),
        "iterations": int(model.n_iter_),
        "evidenceClass": "LATER-DAVIS",
        "algorithmVersion": "EM/sklearn-GaussianMixture",
        "diagnostics": {
            "aic": float(model.aic(values)), "bic": float(model.bic(values)),
            "clusterSizes": np.bincount(labels, minlength=k).tolist(),
            "logLikelihood": float(model.score(values) * len(values)),
        },
    }


def class_variable(classes: list[str]) -> dict[str, Any]:
    """Group rows by an imported class column (initial-DAVIS class usage)."""
    unique = sorted(set(classes))
    index = {c: i for i, c in enumerate(unique)}
    labels = np.array([index[c] for c in classes])
    return {
        "labels": labels.tolist(),
        "k": len(unique),
        "classLabels": unique,
        "evidenceClass": "JAR-INITIAL",
        "diagnostics": {"clusterSizes": np.bincount(labels).tolist()},
    }


def agglomerative(values: np.ndarray, k: int | None = None, linkage: str = "average",
                  distance: str = "euclidean", cut_threshold: float | None = None
                  ) -> dict[str, Any]:
    """Hierarchical agglomerative clustering with DAVIS linkage/distance names."""
    metric = DISTANCE_MAP.get(distance, "euclidean")
    condensed_kwargs = {"metric": metric}
    if metric == "seuclidean":
        condensed_kwargs["V"] = np.var(values, axis=0, ddof=1)
    condensed = pdist(values, **condensed_kwargs)
    method = LINKAGE_MAP.get(linkage, "average")
    Z = scipy_linkage(condensed, method=method)
    if cut_threshold is not None:
        labels = fcluster(Z, t=cut_threshold, criterion="distance")
    elif k is not None:
        labels = fcluster(Z, t=k, criterion="maxclust")
    else:
        labels = fcluster(Z, t=len(values), criterion="maxclust")
    return {
        "labels": (labels - 1).tolist(),  # 0-based to match other algorithms
        "k": int(labels.max()),
        "linkageMatrix": Z.tolist(),
        "linkage": linkage,
        "distance": distance,
        "cutThreshold": cut_threshold,
        "evidenceClass": "LATER-DAVIS",
        "algorithmVersion": f"scipy-hierarchy:{method}/{metric}",
        "diagnostics": {"clusterSizes": np.bincount(labels - 1).tolist()},
    }
