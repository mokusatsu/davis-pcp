"""DAVIS axis-ordering algorithms: Python authoritative implementation.

Ported from the static v1.0.0 JavaScript implementation, which was itself
derived from initial-JAR bytecode analysis (08_初版JAR_バイトコード解析.md).
Golden fixtures in tests/ordering_golden.json pin the exact behavior.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Sequence

import numpy as np


@dataclass
class TraceStep:
    step: int
    selected: str
    rule: str
    remaining: list[str] = field(default_factory=list)
    eigenvalue: float | None = None
    loading: list[float] = field(default_factory=list)


def _clamp(value: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, value))


def correlation_matrix(values: np.ndarray) -> np.ndarray:
    """Sample Pearson correlation between columns, matching the JS reference.

    Constant columns yield 0 correlation (not NaN); diagonal is 1.
    """
    n, p = values.shape
    if n < 2:
        return np.eye(p)
    centered = values - values.mean(axis=0)
    std = np.sqrt((centered ** 2).sum(axis=0) / (n - 1))
    result = np.eye(p)
    for i in range(p):
        for j in range(i + 1, p):
            if std[i] == 0.0 or std[j] == 0.0:
                cov = 0.0
            else:
                cov = float((centered[:, i] * centered[:, j]).sum() / (n - 1) / (std[i] * std[j]))
                cov = _clamp(cov, -1.0, 1.0)
            result[i, j] = result[j, i] = cov
    return result


def correlation_of_matrix_columns(matrix: np.ndarray) -> np.ndarray:
    """Treat matrix rows as observations over its columns: corr(R)."""
    return correlation_matrix(matrix)


def jacobi_eigen_symmetric(input_matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Jacobi eigensolver for symmetric matrices, ascending eigenvalues.

    Mirrors the static-v1 Jacobi implementation so eigenvalue ordering and
    eigenvector signs match the golden fixtures.
    """
    n = input_matrix.shape[0]
    if n == 0:
        return np.array([]), np.zeros((0, 0))
    a = input_matrix.copy()
    v = np.eye(n)
    max_iterations = max(40, n * n * 30)
    for _ in range(max_iterations):
        p, q, biggest = 0, 1, 0.0
        for i in range(n):
            for j in range(i + 1, n):
                value = abs(a[i, j])
                if value > biggest:
                    biggest = value
                    p, q = i, j
        if biggest < 1e-12:
            break
        phi = 0.5 * math.atan2(2 * a[p, q], a[q, q] - a[p, p])
        c, s = math.cos(phi), math.sin(phi)
        app = c * c * a[p, p] - 2 * s * c * a[p, q] + s * s * a[q, q]
        aqq = s * s * a[p, p] + 2 * s * c * a[p, q] + c * c * a[q, q]
        a[p, p] = app
        a[q, q] = aqq
        a[p, q] = 0.0
        a[q, p] = 0.0
        for k in range(n):
            if k == p or k == q:
                continue
            akp, akq = a[k, p], a[k, q]
            a[k, p] = c * akp - s * akq
            a[p, k] = a[k, p]
            a[k, q] = s * akp + c * akq
            a[q, k] = a[k, q]
        for k in range(n):
            vkp, vkq = v[k, p], v[k, q]
            v[k, p] = c * vkp - s * vkq
            v[k, q] = s * vkp + c * vkq
    indices = list(range(n))
    indices.sort(key=lambda i: a[i, i])
    values = np.array([a[i, i] for i in indices])
    vectors = np.array([[v[row, i] for i in indices] for row in range(n)])
    return values, vectors


def _remove_row_col(matrix: np.ndarray, index: int) -> np.ndarray:
    return np.delete(np.delete(matrix, index, axis=0), index, axis=1)


def _first_arg_max_abs(values: np.ndarray) -> int:
    best, biggest = 0, -math.inf
    for index, value in enumerate(values):
        magnitude = abs(float(value))
        if magnitude > biggest:
            biggest = magnitude
            best = index
    return best


def component_order(keys: Sequence[str], values: np.ndarray, double_correlation: bool) -> dict[str, Any]:
    """ComponentOrder: JAR two-stage correlation (double_correlation=True)
    or paper interpretation (direct R_sub eigendecomposition, False)."""
    r = correlation_matrix(values)
    present = list(keys)
    result: list[str] = []
    trace: list[dict[str, Any]] = []
    while len(present) > 1:
        q = len(present)
        selected = 0
        eigenvalue = None
        loading: list[float] = []
        if q >= 3:
            target = correlation_of_matrix_columns(r) if double_correlation else r
            eig_values, eig_vectors = jacobi_eigen_symmetric(target)
            eigenvalue = float(eig_values[-1])
            loading_vector = eig_vectors[:, -1]
            loading = [float(x) for x in loading_vector]
            selected = _first_arg_max_abs(loading_vector)
        rule = (
            "q<3のため先頭を選択" if q < 3
            else "corr(R_sub)の最大固有ベクトル" if double_correlation
            else "R_subの最大固有ベクトル"
        )
        trace.append({
            "step": len(result) + 1,
            "remaining": present.copy(),
            "selected": present[selected],
            "eigenvalue": eigenvalue,
            "loading": [round(x, 6) for x in loading],
            "rule": rule,
        })
        result.append(present.pop(selected))
        r = _remove_row_col(r, selected)
    if present:
        trace.append({
            "step": len(result) + 1,
            "remaining": present.copy(),
            "selected": present[0],
            "eigenvalue": None,
            "loading": [],
            "rule": "最後の残存軸",
        })
        result.append(present[0])
    return {"order": result, "trace": trace}


def _modulo1(value: int, p: int) -> int:
    """JS-style modulo1: result in 1..p. Python's % already returns
    non-negative for positive p, so mirror the JS reference directly."""
    if value == 0:
        return p
    remainder = value % p
    return p if remainder == 0 else remainder


def permute_order(keys: Sequence[str], values: np.ndarray) -> dict[str, Any]:
    """PermuteOrder / INITIAL_JAR_COMPAT: ceil(p/2) Wegman-Huh candidates,
    min-max normalized Euclidean distance, adjacent-distance sum, strict <."""
    p = len(keys)
    if p < 3:
        return {
            "order": list(keys),
            "candidates": [{"order": list(keys), "score": 0.0}],
            "trace": [],
        }
    mins = values.min(axis=0)
    maxs = values.max(axis=0)
    spans = maxs - mins
    normalized = np.divide(values - mins, spans, out=np.zeros_like(values, dtype=float), where=spans != 0)
    distances = np.sqrt(((normalized[:, :, None] - normalized[:, None, :]) ** 2).sum(axis=0))
    m = (p + 1) // 2
    candidates_1based = [[0] * p for _ in range(m)]
    candidates_1based[0][0] = 1
    sign = -1
    for i in range(1, p):
        sign = -sign
        candidates_1based[0][i] = _modulo1(candidates_1based[0][i - 1] + i * sign, p)
    for row in range(1, m):
        for col in range(p):
            candidates_1based[row][col] = _modulo1(candidates_1based[row - 1][col] + 1, p)
    candidates = []
    for candidate in candidates_1based:
        indexes = [value - 1 for value in candidate]
        score = float(sum(distances[indexes[i], indexes[i + 1]] for i in range(p - 1)))
        candidates.append({"order": [keys[index] for index in indexes], "score": score})
    best = candidates[0]
    for candidate in candidates[1:]:
        if candidate["score"] < best["score"]:  # strict tie: keep earlier candidate
            best = candidate
    trace = [
        {"step": index + 1, "selected": " → ".join(candidate["order"]),
         "rule": f"score={candidate['score']:.6f}"}
        for index, candidate in enumerate(candidates)
    ]
    return {"order": list(best["order"]), "candidates": candidates, "trace": trace}


def _permutations(values: list[str]) -> list[list[str]]:
    if len(values) <= 1:
        return [values.copy()]
    result: list[list[str]] = []
    for index, value in enumerate(values):
        rest = values[:index] + values[index + 1:]
        for tail in _permutations(rest):
            result.append([value, *tail])
    return result


def correlation_seriation(keys: Sequence[str], values: np.ndarray) -> dict[str, Any]:
    """MODERN correlation seriation: exhaustive permutations minimizing Σ(1−|r|)."""
    corr = correlation_matrix(values)
    index = {key: i for i, key in enumerate(keys)}
    best_order = list(keys)
    best_score = math.inf
    for candidate in _permutations(list(keys)):
        score = sum(
            1 - abs(corr[index[candidate[i]], index[candidate[i + 1]]])
            for i in range(len(candidate) - 1)
        )
        if score < best_score:
            best_score = score
            best_order = candidate.copy()
    return {
        "order": best_order,
        "candidates": [{"order": best_order, "score": best_score}],
        "trace": [{
            "step": 1,
            "selected": " → ".join(best_order),
            "rule": f"全順列からΣ(1−|r|)={best_score:.6f}を最小化",
        }],
    }


def no_order(keys: Sequence[str]) -> dict[str, Any]:
    return {
        "order": list(keys),
        "candidates": [],
        "trace": [{"step": 1, "selected": " → ".join(keys), "rule": "入力列順"}],
    }


def compute_order(
    mode: str,
    keys: Sequence[str],
    values: np.ndarray,
    manual_order: Sequence[str] | None = None,
) -> dict[str, Any]:
    """Dispatch to ordering algorithm by mode name.

    Modes: database (NoOrder), componentJar, componentPaper, permute,
    correlation, manual.
    """
    if mode == "database":
        result = no_order(keys)
        result["evidence"] = "JAR-INITIAL"
    elif mode == "componentJar":
        result = component_order(keys, values, True)
        result["evidence"] = "JAR-INITIAL"
    elif mode == "componentPaper":
        result = component_order(keys, values, False)
        result["evidence"] = "PAPER-INTERPRETATION"
    elif mode == "permute":
        result = permute_order(keys, values)
        result["evidence"] = "JAR-INITIAL"
    elif mode == "correlation":
        result = correlation_seriation(keys, values)
        result["evidence"] = "MODERN-EXTENSION"
    elif mode == "manual":
        order = list(manual_order) if manual_order else list(keys)
        result = {
            "order": order,
            "candidates": [],
            "trace": [{"step": 1, "selected": " → ".join(order), "rule": "ユーザー指定"}],
            "evidence": "MODERN-EXTENSION",
        }
    else:
        raise ValueError(f"unknown ordering mode: {mode}")
    return result
