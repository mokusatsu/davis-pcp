"""Parallel analysis + candidate comparison (Feature 033 EFA).

Design: DAVIS-FEAT-033-DESIGN.md section 5. NumPy only (correlation
estimation is injected by the caller so observed and null sides share
the same estimator).

- Null data: independent per-item permutation of the fit matrix, keeping
  each item's category counts / continuous distribution exactly and
  breaking only inter-item association. Column processing order is fixed
  (request item order). The caller supplies shared permutation index
  streams so Pearson/Polychoric sides use identical replicate data.
- Eigenvalues: descending eigenvalues of the full correlation matrix
  with unit diagonal (eigenvalueDefinition=full_correlation).
- Quantiles: linear-interpolated per-rank quantiles. Suggested k = the
  leading run of ranks where observed strictly exceeds the reference;
  0 is never lifted to 1. Later-rank exceedances are also reported.
- Failed replicates are never redrawn or dropped: any correlation or
  definiteness failure nulls referenceQuantiles/suggestedFactors with
  reasonCode=PA_REPLICATE_FAILED. A successful main EFA is retained.
"""
from __future__ import annotations

from typing import Any, Callable

import numpy as np

from .ordinal_correlations import validate_correlation_matrix


def full_correlation_eigenvalues(r: np.ndarray) -> np.ndarray:
    r = np.asarray(r, dtype=float)
    return np.sort(np.linalg.eigvalsh((r + r.T) / 2.0))[::-1]


def linear_quantile(values: np.ndarray, q: float) -> np.ndarray:
    return np.quantile(np.asarray(values, dtype=float), q, axis=0, method="linear")


def permutation_stream(n: int, seed: int, rng_name: str = "PCG64") -> dict[str, Any]:
    return {"seed": int(seed), "rng": rng_name, "n": int(n)}


def _resolve_perm_index(fit_codes: np.ndarray, iterations: int, seed: int,
                        perm_index: np.ndarray | None = None) -> np.ndarray:
    """Shared (iterations, n, p) independent-column permutation stream."""
    x = np.asarray(fit_codes)
    n, p = x.shape
    rng = np.random.default_rng(int(seed))
    if perm_index is None:
        # Independent permutation per replicate AND per column: shape
        # (iterations, n, p). Sharing one row permutation across columns
        # would preserve inter-item association and invalidate the null.
        return np.stack(
            [np.stack([rng.permutation(n) for _ in range(p)], axis=1)
             for _ in range(iterations)])
    perm_index = np.asarray(perm_index)
    if (perm_index.ndim != 3 or perm_index.shape[0] != iterations
            or perm_index.shape[1] != n or perm_index.shape[2] != p):
        raise ValueError("perm_index must have shape (iterations, n, p)")
    return perm_index


def _run_replicate(fit_codes: np.ndarray, perm_slice: np.ndarray,
                   estimate: Callable[[np.ndarray], dict[str, Any]],
                   replicate: int) -> dict[str, Any]:
    """One null replicate: permute, estimate, eigenvalue (E011 chunkable)."""
    x = np.asarray(fit_codes)
    p = x.shape[1]
    null = np.stack([x[perm_slice[:, k], k] for k in range(p)], axis=1)
    try:
        rec = estimate(null)
    except Exception as exc:
        return {"ok": False, "replicate": replicate,
                "reasonCode": "PA_REPLICATE_FAILED", "detail": str(exc)[:200]}
    r = rec.get("correlation", None) if isinstance(rec, dict) else None
    if r is None or rec.get("status") in ("failed", "boundary"):
        return {"ok": False, "replicate": replicate,
                "reasonCode": (rec.get("reasonCode")
                               if isinstance(rec, dict) else None)
                or "PA_REPLICATE_FAILED"}
    try:
        r = np.asarray(r, dtype=float)
        validation = validate_correlation_matrix(r)
        if not validation.get("positiveDefinite"):
            return {"ok": False, "replicate": replicate,
                    "reasonCode": validation.get("reasonCode") or "PA_REPLICATE_FAILED"}
        eig = full_correlation_eigenvalues(r)
    except Exception as exc:
        return {"ok": False, "replicate": replicate,
                "reasonCode": "PA_REPLICATE_FAILED", "detail": str(exc)[:200]}
    return {"ok": True, "replicate": replicate, "eigenvalues": eig}


def parallel_analysis(fit_codes: np.ndarray,
                      estimate: Callable[[np.ndarray], dict[str, Any]],
                      *, iterations: int = 500, quantile: float = 0.95,
                      seed: int = 42,
                      perm_index: np.ndarray | None = None,
                      progress: Callable[[int, int], bool | None] | None = None,
                      chunk: int = 25) -> dict[str, Any]:
    """Run parallel analysis on the shared fit matrix.

    fit_codes: (n, p) encoded fit matrix (ranks or continuous scores).
    estimate: maps a permuted (n, p) matrix to
      {"correlation": R or None, "status": ..., "reasonCode": ...}.
    perm_index: optional precomputed (iterations, n, p) permutation index
      array shared across comparison sides (per replicate AND per column).
    progress: optional per-chunk callback progress(done, total); return
      False to abort (cancel). Chunked so background workers can poll.
    """
    x = np.asarray(fit_codes)
    perm_index = _resolve_perm_index(x, int(iterations), int(seed), perm_index)
    rep_eigs: list[np.ndarray] = []
    failures: list[dict[str, Any]] = []
    cancelled = False
    for b in range(int(iterations)):
        rec = _run_replicate(x, perm_index[b], estimate, b)
        if rec.get("ok"):
            rep_eigs.append(rec["eigenvalues"])
        else:
            failures.append({k: rec.get(k) for k in
                             ("replicate", "reasonCode", "detail") if rec.get(k) is not None})
        if progress is not None and ((b + 1) % max(int(chunk), 1) == 0
                                     or b + 1 == int(iterations)):
            try:
                if progress(b + 1, int(iterations)) is False:
                    cancelled = True
                    break
            except StopIteration:
                cancelled = True
                break
    out: dict[str, Any] = {
        "enabled": True, "status": None, "iterationsRequested": int(iterations),
        "iterationsSucceeded": int(len(rep_eigs)),
        "iterationsFailed": int(len(failures)),
        "seed": int(seed), "rng": "PCG64", "nullGenerator": "independent_column_permutation",
        "quantile": float(quantile), "quantileMethod": "linear",
        "eigenvalueDefinition": "full_correlation",
        "observedEigenvalues": None, "referenceQuantiles": None,
        "suggestedFactors": None, "exceedanceRanks": [],
        "replicateFailures": failures,
        "permutationStream": {"seed": int(seed), "rng": "PCG64",
                              "columnOrder": "request_item_order",
                              "separateFromEstimationStarts": True},
    }
    if cancelled:
        out.update({"status": "cancelled", "reasonCode": "PA_CANCELLED"})
        return out
    if failures:
        out.update({"status": "failed", "reasonCode": "PA_REPLICATE_FAILED"})
        return out
    stacked = np.stack(rep_eigs)
    out["referenceQuantiles"] = linear_quantile(stacked, float(quantile))
    out["status"] = "completed"
    out["reasonCode"] = None
    return out


def suggest_factors(observed: np.ndarray, reference: np.ndarray) -> dict[str, Any]:
    """Leading-run candidate k (0 allowed); later exceedances reported."""
    obs = np.asarray(observed, dtype=float)
    ref = np.asarray(reference, dtype=float)
    exceed = [int(i) + 1 for i in range(len(obs)) if obs[i] > ref[i]]
    k = 0
    for rank in range(1, len(obs) + 1):
        if rank in exceed:
            k = rank
        else:
            break
    return {"suggestedFactors": int(k), "exceedanceRanks": exceed}
