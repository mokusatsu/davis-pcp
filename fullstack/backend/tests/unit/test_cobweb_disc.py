"""Unit tests for Cobweb and DISC (AAAI 2026) clustering algorithms."""
from __future__ import annotations

import sys
from pathlib import Path
import numpy as np
import pytest

BACKEND = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(BACKEND))

from app.algorithms.clustering.cobweb import cobweb_cluster
from app.algorithms.clustering.disc import disc_cluster


class TestCobwebClustering:
    def test_cobweb_numeric_clustering(self):
        # 3 clusters of 2D Gaussian blobs
        rng = np.random.default_rng(42)
        c1 = rng.normal([0.0, 0.0], 0.2, size=(20, 2))
        c2 = rng.normal([5.0, 5.0], 0.2, size=(20, 2))
        c3 = rng.normal([0.0, 6.0], 0.2, size=(20, 2))
        data = np.vstack([c1, c2, c3])

        result = cobweb_cluster(data, k=3, acuity=0.1)

        assert result["method"] == "cobweb"
        assert result["k"] >= 2
        assert len(result["labels"]) == 60
        assert "conceptTree" in result
        assert result["conceptTree"]["count"] == 60
        assert len(result["conceptTree"]["children"]) > 0

    def test_cobweb_categorical_clustering(self):
        # Categorical data
        cats1 = [["cat", "red"], ["cat", "red"], ["cat", "pink"]] * 10
        cats2 = [["dog", "blue"], ["dog", "blue"], ["dog", "navy"]] * 10
        all_cats = cats1 + cats2
        col1 = [r[0] for r in all_cats]
        col2 = [r[1] for r in all_cats]

        result = cobweb_cluster(None, cat_columns=[col1, col2], k=2, acuity=0.1)

        assert result["method"] == "cobweb"
        assert result["k"] >= 2
        assert len(result["labels"]) == len(all_cats)
        assert result["conceptTree"]["count"] == len(all_cats)


class TestDiscClustering:
    def test_disc_categorical_clustering(self):
        # Synthetic categorical data with cluster-specific category affinity
        rng = np.random.default_rng(123)
        n = 40
        # Cluster 0: A and B co-occur with X
        # Cluster 1: C and D co-occur with Y
        c0_col1 = rng.choice(["A", "B"], size=n).tolist()
        c0_col2 = rng.choice(["X", "X1"], size=n).tolist()

        c1_col1 = rng.choice(["C", "D"], size=n).tolist()
        c1_col2 = rng.choice(["Y", "Y1"], size=n).tolist()

        col1 = c0_col1 + c1_col1
        col2 = c0_col2 + c1_col2

        result = disc_cluster(
            num_matrix=None,
            cat_columns=[col1, col2],
            column_names=["feature1", "feature2"],
            k=2,
            max_iter=20,
            seed=42,
        )

        assert result["method"] == "disc"
        assert result["k"] == 2
        assert len(result["labels"]) == 2 * n
        assert "categoryMatrices" in result
        assert "0" in result["categoryMatrices"]
        assert "feature1" in result["categoryMatrices"]["0"]
        mat_info = result["categoryMatrices"]["0"]["feature1"]
        assert "matrix" in mat_info
        assert len(mat_info["matrix"]) == len(mat_info["categories"])

    def test_disc_mixed_numeric_clustering(self):
        # Numeric data discretized automatically
        rng = np.random.default_rng(42)
        c1 = rng.normal([1.0, 1.0], 0.2, size=(25, 2))
        c2 = rng.normal([8.0, 8.0], 0.2, size=(25, 2))
        matrix = np.vstack([c1, c2])

        result = disc_cluster(
            num_matrix=matrix,
            cat_columns=None,
            column_names=["num1", "num2"],
            k=2,
            max_iter=15,
            seed=42,
        )

        assert result["method"] == "disc"
        assert result["k"] == 2
        assert len(result["labels"]) == 50
        assert "categoryMatrices" in result
