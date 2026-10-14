"""Exact KNN donor-snapshot regression coverage; no wall-clock assertions."""
from __future__ import annotations

import unittest
import warnings
from unittest.mock import patch

import numpy as np

from app.algorithms.imputation.core import _knn_impute_series
from app.domain.errors import BizError


# Frozen pre-hoisting algorithm from 412dd4d8, including its donor order and ties.
def _reference_knn_impute_series(target_arr: np.ndarray, feature_mat: np.ndarray, k: int = 5) -> np.ndarray:
    """Impute missing numeric values using K-Nearest Neighbors on observed rows."""
    is_nan = np.isnan(target_arr)
    if np.all(is_nan):
        raise BizError("IMPUTATION_NO_DONOR", "観測値がなく近傍補完ができません。",
                       status_code=422)
    if not np.any(is_nan):
        return target_arr.copy()

    obs_indices = np.where(~is_nan)[0]
    mis_indices = np.where(is_nan)[0]

    # Standardize feature matrix for fair distance calculation
    col_means = np.nanmean(feature_mat, axis=0)
    col_stds = np.nanstd(feature_mat, axis=0)
    col_stds[col_stds < 1e-6] = 1.0
    norm_features = np.nan_to_num((feature_mat - col_means) / col_stds, nan=0.0)

    imputed_arr = target_arr.copy()
    for m_idx in mis_indices:
        query_vec = norm_features[m_idx]
        obs_features = norm_features[obs_indices]
        # Euclidean distance to all observed rows
        dists = np.linalg.norm(obs_features - query_vec, axis=1)
        k_actual = min(k, len(obs_indices))
        nearest_obs_pos = np.argpartition(dists, k_actual - 1)[:k_actual]
        nearest_rows = obs_indices[nearest_obs_pos]
        weights = 1.0 / (dists[nearest_obs_pos] + 1e-5)
        weights /= np.sum(weights)
        imputed_arr[m_idx] = float(np.sum(target_arr[nearest_rows] * weights))

    return imputed_arr

class TestKnnDonorSnapshot(unittest.TestCase):
    def assert_matches_reference(self, target, features, k):
        target_before = target.tobytes()
        features_before = features.tobytes()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            expected = _reference_knn_impute_series(target, features, k)
            actual = _knn_impute_series(target, features, k)
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(actual.tobytes(), expected.tobytes())
        self.assertEqual(actual.dtype, target.dtype)
        self.assertEqual(target.tobytes(), target_before)
        self.assertEqual(features.tobytes(), features_before)
        self.assertFalse(np.shares_memory(actual, target))
        observed = ~np.isnan(target)
        np.testing.assert_array_equal(actual[observed], target[observed])
        return actual

    def test_varied_missing_patterns_match_bit_for_bit(self):
        for seed in range(8):
            rng = np.random.default_rng(seed)
            features = rng.normal(size=(83, 7))
            features[rng.random(features.shape) < 0.2] = np.nan
            for rate in (0.01, 0.2, 0.8):
                target = rng.normal(size=83)
                target[rng.random(83) < rate] = np.nan
                target[0], target[-1] = 2.0, np.nan
                for k in (1, 5, 50):
                    with self.subTest(seed=seed, rate=rate, k=k):
                        self.assert_matches_reference(target, features, k)

    def test_all_missing_and_empty_targets_keep_no_donor_error(self):
        for size in (0, 1, 9):
            for function in (_reference_knn_impute_series, _knn_impute_series):
                with self.subTest(size=size, function=function.__name__):
                    with self.assertRaises(BizError) as error:
                        function(np.full(size, np.nan), np.zeros((size, 2)), 5)
                    self.assertEqual(error.exception.code, "IMPUTATION_NO_DONOR")
                    self.assertEqual(error.exception.status_code, 422)

    def test_no_missing_target_returns_independent_copy_without_normalizing(self):
        target = np.array([0.0, -0.0, 2.0, 5.0])
        with patch.object(np, "nan_to_num", side_effect=AssertionError("unneeded normalization")):
            self.assert_matches_reference(target, np.ones((4, 2)), 50)

    def test_constant_targets_and_all_missing_or_constant_predictors(self):
        target = np.array([7.0, np.nan, 7.0, np.nan, 7.0, np.nan])
        matrices = [np.zeros((6, 0)), np.ones((6, 3)), np.full((6, 3), np.nan),
                    np.column_stack((np.ones(6), np.full(6, np.nan), np.arange(6)))]
        for features in matrices:
            for k in (1, 5, 50):
                with self.subTest(features=features.shape, k=k):
                    result = self.assert_matches_reference(target, features, k)
                    np.testing.assert_allclose(result, 7.0, rtol=0, atol=2e-15)

    def test_tied_distances_and_k_larger_than_donor_count(self):
        target = np.array([1.0, np.nan, 3.0, np.nan, 9.0, np.nan])
        for k in (1, 2, 3, 5, 50):
            with self.subTest(k=k):
                self.assert_matches_reference(target, np.ones((6, 2)), k)
        # Even the upper UI bound must clamp to the single available donor.
        result = self.assert_matches_reference(np.array([np.nan, 4.0, np.nan]), np.zeros((3, 1)), 50)
        np.testing.assert_array_equal(result, [4.0, 4.0, 4.0])

    def test_read_only_noncontiguous_and_aliasing_inputs_are_unchanged(self):
        base = np.arange(60, dtype=np.float64).reshape(10, 6)
        base[::3, 0] = np.nan
        target, features = base[:, 0], base[:, ::2]
        target.setflags(write=False)
        features.setflags(write=False)
        self.assert_matches_reference(target, features, 5)
        self.assert_matches_reference(target[::-1], features[::-1], 50)
        self.assert_matches_reference(target.astype(np.float32), features.astype(np.float32), 1)

    def test_donor_matrix_is_copied_once_and_never_written_during_imputation(self):
        target = np.array([1.0, np.nan, 3.0, np.nan, 5.0, np.nan])
        features = np.column_stack((np.arange(6, dtype=float), target))
        original = np.nan_to_num
        observed_copies = []
        donor_snapshots = []
        normalized = []

        class ReadOnlyFeatures(np.ndarray):
            def __getitem__(self, key):
                result = super().__getitem__(key)
                if normalized and self is normalized[0] and isinstance(key, np.ndarray):
                    observed_copies.append(key.copy())
                    result.setflags(write=False)
                    donor_snapshots.append((result, result.tobytes()))
                return result

        def normalize(*args, **kwargs):
            value = original(*args, **kwargs).view(ReadOnlyFeatures)
            value.setflags(write=False)
            normalized.append(value)
            return value

        expected = _reference_knn_impute_series(target, features, 2)
        with patch.object(np, "nan_to_num", side_effect=normalize):
            actual = _knn_impute_series(target, features, 2)
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(actual.tobytes(), expected.tobytes())
        self.assertEqual(len(observed_copies), 1)
        np.testing.assert_array_equal(observed_copies[0], np.array([0, 2, 4]))
        self.assertFalse(normalized[0].flags.writeable)
        self.assertEqual(len(donor_snapshots), 1)
        self.assertFalse(donor_snapshots[0][0].flags.writeable)
        self.assertEqual(donor_snapshots[0][0].tobytes(), donor_snapshots[0][1])
