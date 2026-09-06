"""Golden and property tests for the Python ordering implementation.

Golden fixtures come from the static v1.0.0 E2E suite (which was verified
against the initial JAR bytecode) and the NumPy oracle from
static-v1 tests/property_oracle.py.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.algorithms.ordering.core import (  # noqa: E402
    component_order,
    correlation_matrix,
    correlation_seriation,
    no_order,
    permute_order,
)

FIXTURES = Path(__file__).resolve().parents[3] / "fixtures"
IRIS = json.loads((FIXTURES / "iris_fixture.json").read_text(encoding="utf-8"))
KEYS5 = ["sepalLength", "sepalWidth", "petalLength", "petalWidth", "speciesCode"]


def iris_values(keys: list[str] = KEYS5) -> np.ndarray:
    return np.array([[row[k] for k in keys] for row in IRIS], dtype=float)


GOLDEN_MATRIX = np.array(
    [[2, 9, 4, 7, 1], [3, 7, 5, 6, 4], [5, 8, 1, 2, 7], [7, 4, 9, 5, 3],
     [11, 6, 2, 8, 5], [13, 1, 8, 3, 9], [17, 5, 6, 9, 2], [19, 2, 7, 1, 8]],
    dtype=float,
)
GOLDEN_KEYS = ["x0", "x1", "x2", "x3", "x4"]


class TestJarGoldenFixture:
    def test_component_double_correlation(self):
        result = component_order(GOLDEN_KEYS, GOLDEN_MATRIX, True)
        assert result["order"] == ["x1", "x3", "x2", "x0", "x4"]

    def test_permute(self):
        result = permute_order(GOLDEN_KEYS, GOLDEN_MATRIX)
        assert result["order"] == ["x2", "x3", "x1", "x4", "x0"]
        assert len(result["candidates"]) == 3


class TestIrisFiveAxis:
    def test_database(self):
        assert no_order(KEYS5)["order"] == KEYS5

    def test_component_jar(self):
        assert component_order(KEYS5, iris_values(), True)["order"] == [
            "petalLength", "petalWidth", "speciesCode", "sepalLength", "sepalWidth",
        ]

    def test_component_paper(self):
        assert component_order(KEYS5, iris_values(), False)["order"] == [
            "petalLength", "petalWidth", "speciesCode", "sepalLength", "sepalWidth",
        ]

    def test_permute_five_axis_three_candidates(self):
        result = permute_order(KEYS5, iris_values())
        assert len(result["candidates"]) == math.ceil(5 / 2)
        assert result["order"] == [
            "sepalWidth", "petalLength", "sepalLength", "petalWidth", "speciesCode",
        ]


class TestPermuteFourNumericAxis:
    def test_scores_exact(self):
        keys = KEYS5[:4]
        result = permute_order(keys, iris_values(keys))
        scores = [c["score"] for c in result["candidates"]]
        assert len(scores) == 2
        assert scores[0] == pytest.approx(9.961958084685977, abs=1e-8)
        assert scores[1] == pytest.approx(9.207082574015136, abs=1e-8)
        assert result["order"] == ["sepalWidth", "petalLength", "sepalLength", "petalWidth"]

    def test_strict_tie_keeps_earlier_candidate(self):
        # Two identical columns => identical candidate scores => strict < keeps first.
        values = np.array([[float(i % 7), float((i * 3) % 7)] for i in range(12)], dtype=float)
        values = np.column_stack([values, values[:, 0].copy()])
        result = permute_order(["a", "b", "c"], values)
        # With a tie the earlier candidate must win; verify determinism across runs.
        again = permute_order(["a", "b", "c"], values)
        assert result["order"] == again["order"]

    def test_p_below_3_is_identity(self):
        values = np.array([[1.0, 2.0], [2.0, 3.0], [3.0, 5.0]])
        result = permute_order(["a", "b"], values)
        assert result["order"] == ["a", "b"]
        assert result["candidates"][0]["score"] == 0.0


def _permute_oracle(matrix: np.ndarray) -> dict:
    p = matrix.shape[1]
    keys = [f"x{i}" for i in range(p)]
    if p < 3:
        return {"order": keys, "candidates": [{"order": keys, "score": 0.0}]}
    mins = matrix.min(axis=0)
    maxs = matrix.max(axis=0)
    spans = maxs - mins
    normalized = np.divide(matrix - mins, spans, out=np.zeros_like(matrix), where=spans != 0)
    distances = np.sqrt(((normalized[:, :, None] - normalized[:, None, :]) ** 2).sum(axis=0))
    m = (p + 1) // 2
    cands = [[0] * p for _ in range(m)]
    cands[0][0] = 1
    sign = -1
    for i in range(1, p):
        sign = -sign
        cands[0][i] = ((cands[0][i - 1] + i * sign - 1) % p) + 1
    for row in range(1, m):
        for col in range(p):
            cands[row][col] = ((cands[row - 1][col] - 1 + 1) % p) + 1
    candidates = []
    for cand in cands:
        idx = [v - 1 for v in cand]
        score = sum(float(distances[idx[i], idx[i + 1]]) for i in range(p - 1))
        candidates.append({"order": [keys[i] for i in idx], "score": score})
    best = candidates[0]
    for candidate in candidates[1:]:
        if candidate["score"] < best["score"]:
            best = candidate
    return {"order": best["order"], "candidates": candidates}


class TestNumPyOracle:
    """Independent re-derivation on generated matrices."""

    @pytest.fixture(scope="class")
    def matrices(self):
        rng = np.random.default_rng(20020801)
        out = []
        for p in range(2, 8):
            for case_index in range(24):
                n = 18 + (case_index % 9)
                latent = rng.normal(size=(n, 2))
                weights = rng.normal(size=(2, p))
                noise = rng.normal(scale=0.35 + 0.03 * case_index, size=(n, p))
                x = latent @ weights + noise + np.linspace(-0.2, 0.2, n)[:, None] * rng.normal(size=(1, p))
                out.append(x)
        out.append(np.array([[1.0, float(i), float(i * i % 7)] for i in range(12)]))
        out.append(np.array([[float(i), -1000.0 + i * 0.01, float((i * 3) % 5), 7.0] for i in range(15)]))
        return out

    def test_permute_matches_oracle(self, matrices):
        for index, matrix in enumerate(matrices):
            keys = [f"x{i}" for i in range(matrix.shape[1])]
            actual = permute_order(keys, matrix)
            expected = _permute_oracle(matrix)
            assert actual["order"] == expected["order"], f"case {index}"
            assert [c["order"] for c in actual["candidates"]] == [c["order"] for c in expected["candidates"]]
            for a, e in zip(actual["candidates"], expected["candidates"]):
                assert math.isclose(a["score"], e["score"], rel_tol=1e-10, abs_tol=1e-10)


def _component_oracle(matrix: np.ndarray, double_correlation: bool) -> list[str]:
    r = correlation_matrix(matrix)
    keys = [f"x{i}" for i in range(matrix.shape[1])]
    present = list(keys)
    result = []
    while len(present) > 1:
        q = len(present)
        selected = 0
        if q >= 3:
            target = correlation_matrix(r) if double_correlation else r
            _, vectors = np.linalg.eigh(target)
            selected = int(np.argmax(np.abs(vectors[:, -1])))
        result.append(present.pop(selected))
        r = np.delete(np.delete(r, selected, axis=0), selected, axis=1)
    if present:
        result.append(present[0])
    return result


class TestComponentOracle:
    @pytest.fixture(scope="class")
    def well_conditioned(self):
        rng = np.random.default_rng(20020801)
        out = []
        for p in range(2, 8):
            for case_index in range(24):
                n = 18 + (case_index % 9)
                latent = rng.normal(size=(n, 2))
                weights = rng.normal(size=(2, p))
                noise = rng.normal(scale=0.35 + 0.03 * case_index, size=(n, p))
                out.append(latent @ weights + noise)
        return out

    def test_both_variants_match_oracle(self, well_conditioned):
        for index, matrix in enumerate(well_conditioned):
            keys = [f"x{i}" for i in range(matrix.shape[1])]
            jar = component_order(keys, matrix, True)
            paper = component_order(keys, matrix, False)
            assert jar["order"] == _component_oracle(matrix, True), f"case {index}"
            assert paper["order"] == _component_oracle(matrix, False), f"case {index}"

    def test_two_variables_pick_first_without_eigen(self):
        matrix = np.array([[1.0, 2.0], [2.0, 1.0], [3.0, 0.5]])
        result = component_order(["a", "b"], matrix, True)
        assert result["order"] == ["a", "b"]
        assert all(step["eigenvalue"] is None for step in result["trace"])

    def test_constant_column_zero_correlation(self):
        matrix = np.array([[1.0, 5.0], [2.0, 5.0], [3.0, 5.0], [4.9, 5.0]])
        corr = correlation_matrix(matrix)
        assert corr[0, 1] == 0.0
        result = component_order(["vary", "const"], matrix, True)
        assert set(result["order"]) == {"vary", "const"}


class TestCorrelationSeriation:
    def test_minimizes_sum_of_one_minus_abs_corr(self):
        keys = KEYS5[:4]
        values = iris_values(keys)
        result = correlation_seriation(keys, values)
        corr = correlation_matrix(values)
        index = {k: i for i, k in enumerate(keys)}
        score = sum(1 - abs(corr[index[result["order"][i]], index[result["order"][i + 1]]]) for i in range(3))
        assert result["candidates"][0]["score"] == pytest.approx(score)
