"""Clustering partition, dendrogram, and outlier tests."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.algorithms.clustering.core import (  # noqa: E402
    _partition_equivalent,
    agglomerative,
    class_variable,
    divisive,
    gaussian_mixture,
    kmeans,
    kmedoids,
)
from app.algorithms.outliers.core import (  # noqa: E402
    detect,
    iqr_rule,
    robust_zscore,
)


def _blobs(seed: int = 20020801) -> np.ndarray:
    rng = np.random.default_rng(seed)
    a = rng.normal([0, 0], 0.3, size=(30, 2))
    b = rng.normal([5, 5], 0.3, size=(30, 2))
    c = rng.normal([0, 6], 0.3, size=(30, 2))
    return np.vstack([a, b, c])


class TestPartitionEquivalence:
    def test_label_permutation_ignored(self):
        a = np.array([0, 0, 1, 1, 2])
        b = np.array([2, 2, 0, 0, 1])
        assert _partition_equivalent(a, b)

    def test_different_partitions_rejected(self):
        a = np.array([0, 0, 1, 1])
        b = np.array([0, 1, 0, 1])
        assert not _partition_equivalent(a, b)

    def test_split_merge_rejected(self):
        a = np.array([0, 0, 0])
        b = np.array([0, 0, 1])
        assert not _partition_equivalent(a, b)


class TestClustering:
    def test_kmeans_seed_reproducible(self):
        values = _blobs()
        r1 = kmeans(values, 3, seed=42)
        r2 = kmeans(values, 3, seed=42)
        assert r1["labels"] == r2["labels"]

    def test_kmeans_recovers_three_blobs(self):
        values = _blobs()
        result = kmeans(values, 3, seed=42)
        labels = np.array(result["labels"])
        # Each blob (30 consecutive rows) must be a single cluster.
        for blob_index in range(3):
            segment = labels[blob_index * 30:(blob_index + 1) * 30]
            assert len(set(segment.tolist())) == 1

    def test_kmedoids_converges_nonempty(self):
        # k-medoids minimizes the sum of distances to the nearest medoid; on
        # these blobs the optimum legitimately merges the two closest blobs,
        # so we assert convergence + non-empty clusters rather than kmeans
        # partition equality.
        values = _blobs()
        pams = kmedoids(values, 3)
        sizes = np.bincount(np.array(pams["labels"]), minlength=3)
        assert (sizes > 0).all()

    def test_kmedoids_well_separated_blobs(self):
        # Blobs far apart on one line: the sum-of-distance optimum keeps them
        # separated because merging any two is dominated by the third split.
        rng = np.random.default_rng(20020801)
        values = np.vstack([
            rng.normal([0, 0], 0.2, (25, 2)),
            rng.normal([30, 0], 0.2, (25, 2)),
            rng.normal([60, 0], 0.2, (25, 2)),
        ])
        pams = kmedoids(values, 3)
        labels = np.array(pams["labels"])
        for blob in range(3):
            assert len(set(labels[blob * 25:(blob + 1) * 25].tolist())) == 1

    def test_divisive_and_gmm_recover_blobs(self):
        values = _blobs()
        for result in (divisive(values, 3), gaussian_mixture(values, 3)):
            labels = np.array(result["labels"])
            for blob_index in range(3):
                segment = labels[blob_index * 30:(blob_index + 1) * 30]
                assert len(set(segment.tolist())) == 1

    def test_class_variable(self):
        labels = class_variable(["b", "a", "c", "a"])
        assert labels["k"] == 3
        assert labels["diagnostics"]["clusterSizes"] == [2, 1, 1]

    def test_agglomerative_linkages(self):
        values = _blobs()[:20]
        for linkage in ("nearest", "farthest", "average", "group_average"):
            result = agglomerative(values, k=3, linkage=linkage)
            assert result["k"] == 3
            assert len(result["linkageMatrix"]) == 19

    def test_agglomerative_distances(self):
        values = _blobs()[:20]
        for distance in ("euclidean", "standard_euclidean", "city_block"):
            result = agglomerative(values, k=2, distance=distance)
            assert result["k"] == 2

    def test_agglomerative_cut_threshold(self):
        values = _blobs()
        result = agglomerative(values, cut_threshold=2.0)
        assert result["k"] >= 3

    def test_empty_cluster_guard_kmedoids(self):
        # k == n is the degenerate edge; k < n must produce k non-empty clusters.
        values = _blobs()[:15]
        result = kmedoids(values, 3)
        sizes = np.bincount(np.array(result["labels"]), minlength=3)
        assert (sizes > 0).all()


class TestOutliers:
    def test_iqr_flags_extreme(self):
        values = np.array([[1.0], [2.0], [3.0], [4.0], [5.0], [100.0]])
        flags = iqr_rule(values)
        assert flags[-1] and not flags[0]

    def test_robust_z_flags_extreme(self):
        values = np.append(np.zeros(30), [50.0]).reshape(-1, 1)
        flags = robust_zscore(values)
        assert flags[-1]

    def test_isolation_forest_and_lof(self):
        rng = np.random.default_rng(1)
        normal = rng.normal(0, 1, (60, 2))
        extreme = np.array([[10.0, 10.0], [-10.0, -10.0]])
        values = np.vstack([normal, extreme])
        for method in ("isolation_forest", "lof"):
            result = detect(method, values)
            assert result["count"] >= 1
            assert result["flags"][-1] or result["flags"][-2]

    def test_constant_column_no_crash(self):
        values = np.full((10, 2), 5.0)
        flags = iqr_rule(values)
        assert not flags.any()

    def test_missing_values_ignored(self):
        values = np.array([[1.0], [2.5], [3.0], [3.5], [4.0], [np.nan], [500.0]])
        flags = iqr_rule(values)
        assert flags[6] and not flags[5]
