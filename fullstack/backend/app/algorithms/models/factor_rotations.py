"""Varimax / Promax rotation conventions (Feature 033 EFA).

Design: DAVIS-FEAT-033-DESIGN.md section 6.1. NumPy + SciPy only.

- q == 1: requested rotation is recorded but applied rotation is none,
  with a reason kept by the caller in meta.methodSwitchReason.
- Unrotated: canonicalize each column sign so the max-abs loading is
  positive; order factors by descending sum of squared loadings
  (ties keep original order). Phi = I; same signed permutation
  applies to scores.
- Varimax: fixed Kaiser normalization. h_j = sqrt(sum_l L_jl^2), zero
  rows stay zero; B = L / h. From T = I iterate at most 500 times:
  Lambda = B T; C = B' [Lambda^3 - Lambda diag(colSums(Lambda^2))/p];
  C = U D V'; T_new = U V'. Converge when the relative improvement of
  sum(diag(D)) is < 1e-8. Un-normalize L_v = (B T) h and verify
  L_v L_v' + Psi == Sigma within rtol=1e-9. Non-convergence is
  FA_ROTATION_NONCONVERGENCE (no fallback to none). After convergence
  order by descending squared-loading sums and canonicalize signs.
- Promax: after Varimax, target = sign(L_v) |L_v|^4 (power=4 fixed).
  B = least_squares(L_v, target) requires rank q; Phi_0 = (B'B)^-1;
  D = diag(sqrt(diag(Phi_0))); T_p = B D; L_p = L_v T_p;
  Phi = D^-1 Phi_0 D^-1. pattern = L_p, structure = L_p Phi,
  diag(Phi) = 1. Verify L_p Phi L_p' + Psi == Sigma. A signed
  permutation H transforms pattern_new = L_p H, Phi_new = H' Phi H,
  structure_new = structure H, score_new = score H. Near-singular Phi
  (rank loss, |corr| ~ 1) is FA_ROTATION_SINGULAR.
"""
from __future__ import annotations

from typing import Any

import numpy as np
from scipy import linalg

VARIMAX_MAXITER = 500
VARIMAX_TOL = 1e-8
RECON_RTOl = 1e-9
PROMAX_POWER = 4


def canonicalize_columns(loadings: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Sign-canonicalize columns and order by descending SS loadings.

    Returns (rotated, H) with loadings @ H == rotated. H combines the
    SS-descending permutation and the sign flips, so callers can apply
    the SAME H to Phi/structure/scores and keep P @ Phi @ P' invariant
    (E003: never flip the pattern without the matching Phi signs).
    """
    l = np.asarray(loadings, dtype=float)
    p, q = l.shape
    signs_pre = np.ones(q)
    for j in range(q):
        col = l[:, j]
        k = int(np.argmax(np.abs(col))) if p else 0
        if p and col[k] < 0:
            signs_pre[j] = -1.0
    l1 = l * signs_pre[None, :]
    ss = np.sum(l1 * l1, axis=0)
    order = sorted(range(q), key=lambda j: (-ss[j], j))
    h = np.zeros((q, q))
    for new, old in enumerate(order):
        h[old, new] = signs_pre[old]
    return l @ h, h


def unrotated_solution(loadings: np.ndarray) -> dict[str, Any]:
    l, h = canonicalize_columns(loadings)
    q = l.shape[1]
    return {"loadings": l, "phi": np.eye(q), "rotationMatrix": h,
            "appliedRotation": "none"}


def varimax_rotation(loadings: np.ndarray, psi: np.ndarray) -> dict[str, Any]:
    import math as _math
    l = np.asarray(loadings, dtype=float)
    psi = np.asarray(psi, dtype=float)
    p, q = l.shape
    h = np.sqrt(np.sum(l * l, axis=1))
    b = np.zeros_like(l)
    nz = h > 0
    b[nz] = l[nz] / h[nz][:, None]
    t = np.eye(q)
    lam = b @ t

    def _criterion(m: np.ndarray) -> float:
        return float(np.sum(np.var(m * m, axis=0)))

    sweeps = 0
    converged = False
    if q >= 2:
        for sweeps in range(1, VARIMAX_MAXITER + 1):
            prev = _criterion(lam)
            for a in range(q - 1):
                for bb in range(a + 1, q):
                    x = lam[:, a]
                    y = lam[:, bb]
                    u = x * x - y * y
                    v = 2.0 * x * y
                    # Kaiser (1958) planar rotation with column-mean
                    # correction: A = sum(u^2-v^2) - (sum u)^2/p + (sum v)^2/p,
                    # B = 2 sum(uv) - 2 (sum u)(sum v)/p, phi = atan2(B,A)/4.
                    # Without the correction the sweep maximizes the wrong
                    # objective (E002).
                    a_num = (float(np.sum(u * u - v * v))
                             - float(np.sum(u)) ** 2 / p
                             + float(np.sum(v)) ** 2 / p)
                    b_num = (float(2.0 * np.sum(u * v))
                             - 2.0 * float(np.sum(u)) * float(np.sum(v)) / p)
                    phi = 0.25 * _math.atan2(b_num, a_num)
                    if phi == 0.0:
                        continue
                    c, s_ = _math.cos(phi), _math.sin(phi)
                    rot = np.array([[c, -s_], [s_, c]])
                    lam[:, [a, bb]] = lam[:, [a, bb]] @ rot
                    t[:, [a, bb]] = t[:, [a, bb]] @ rot
            cur = _criterion(lam)
            if abs(cur - prev) <= VARIMAX_TOL * max(abs(cur), 1.0):
                converged = True
                break
    else:
        converged = True
    it = sweeps
    if not converged:
        return {"status": "failed", "reasonCode": "FA_ROTATION_NONCONVERGENCE",
                "iterations": it}
    lv = lam * h[:, None]
    sigma = l @ l.T + np.diag(psi)
    recon = lv @ lv.T + np.diag(psi)
    if not np.allclose(recon, sigma, rtol=RECON_RTOl, atol=1e-10):
        return {"status": "failed", "reasonCode": "FA_ROTATION_NONCONVERGENCE",
                "iterations": it, "detail": "reconstruction mismatch"}
    lc, hperm = canonicalize_columns(lv)
    phi_eye = np.eye(q)
    phi_new = hperm.T @ phi_eye @ hperm
    out_recon = lc @ phi_new @ lc.T + np.diag(psi)
    if not np.allclose(out_recon, sigma, rtol=RECON_RTOl, atol=1e-10):
        return {"status": "failed", "reasonCode": "FA_ROTATION_NONCONVERGENCE",
                "iterations": it, "detail": "final reconstruction mismatch"}
    return {"status": "success", "reasonCode": None, "loadings": lc,
            "phi": phi_new, "rotationMatrix": t @ hperm,
            "iterations": it, "appliedRotation": "varimax"}


def promax_rotation(loadings_v: np.ndarray, phi_v: np.ndarray,
                    psi: np.ndarray, power: int = PROMAX_POWER) -> dict[str, Any]:
    lv = np.asarray(loadings_v, dtype=float)
    psi = np.asarray(psi, dtype=float)
    p, q = lv.shape
    if int(power) != PROMAX_POWER:
        return {"status": "failed", "reasonCode": "FA_ROTATION_NONCONVERGENCE",
                "detail": "promax power is fixed at 4"}
    target = np.sign(lv) * (np.abs(lv) ** PROMAX_POWER)
    try:
        b, *_ = linalg.lstsq(lv, target)
    except Exception:
        return {"status": "failed", "reasonCode": "FA_ROTATION_SINGULAR"}
    if np.linalg.matrix_rank(np.asarray(b)) < q:
        return {"status": "failed", "reasonCode": "FA_ROTATION_SINGULAR"}
    phi0 = linalg.inv(np.asarray(b).T @ np.asarray(b))
    dvec = np.sqrt(np.clip(np.diag(phi0), 1e-300, None))
    d = np.diag(dvec)
    try:
        d_inv = linalg.inv(d)
    except Exception:
        return {"status": "failed", "reasonCode": "FA_ROTATION_SINGULAR"}
    tp = np.asarray(b) @ d
    lp = lv @ tp
    phi = d_inv @ phi0 @ d_inv
    dd = np.sqrt(np.clip(np.diag(phi), 1e-300, None))
    phi = (phi / dd[:, None]) / dd[None, :]
    if np.linalg.matrix_rank(phi) < q:
        return {"status": "failed", "reasonCode": "FA_ROTATION_SINGULAR"}
    sigma = lv @ np.asarray(phi_v, dtype=float) @ lv.T + np.diag(psi)
    recon = lp @ phi @ lp.T + np.diag(psi)
    if not np.allclose(recon, sigma, rtol=RECON_RTOl, atol=1e-10):
        return {"status": "failed", "reasonCode": "FA_ROTATION_NONCONVERGENCE",
                "detail": "reconstruction mismatch"}
    lc, hperm = canonicalize_columns(lp)
    phi_new = hperm.T @ phi @ hperm
    out_recon = lc @ phi_new @ lc.T + np.diag(psi)
    if not np.allclose(out_recon, sigma, rtol=RECON_RTOl, atol=1e-10):
        return {"status": "failed", "reasonCode": "FA_ROTATION_NONCONVERGENCE",
                "detail": "final reconstruction mismatch"}
    return {"status": "success", "reasonCode": None, "loadings": lc,
            "phi": phi_new, "rotationMatrix": tp @ hperm,
            "appliedRotation": "promax"}


def apply_signed_permutation(pattern: np.ndarray, phi: np.ndarray,
                             structure: np.ndarray, h: np.ndarray) -> dict[str, np.ndarray]:
    h = np.asarray(h, dtype=float)
    return {"pattern": np.asarray(pattern) @ h,
            "phi": h.T @ np.asarray(phi) @ h,
            "structure": np.asarray(structure) @ h}


def rotate_solution(loadings: np.ndarray, psi: np.ndarray,
                    rotation: str) -> dict[str, Any]:
    """Rotate raw loadings; q==1 always applies none with a reason."""
    l = np.asarray(loadings, dtype=float)
    psi = np.asarray(psi, dtype=float)
    q = l.shape[1]
    if q == 1:
        out = unrotated_solution(l)
        out.update({"requestedRotation": rotation, "appliedRotation": "none",
                    "methodSwitchReason": "single factor requires no rotation",
                    "status": "success", "reasonCode": None})
        return out
    if rotation == "none":
        out = unrotated_solution(l)
        out.update({"requestedRotation": "none", "appliedRotation": "none",
                    "status": "success", "reasonCode": None})
        return out
    if rotation == "varimax":
        out = varimax_rotation(l, psi)
        out["requestedRotation"] = "varimax"
        return out
    if rotation == "promax":
        v = varimax_rotation(l, psi)
        if v.get("status") != "success":
            return {**v, "requestedRotation": "promax"}
        p = promax_rotation(v["loadings"], v["phi"], psi)
        return {**p, "requestedRotation": "promax"}
    return {"status": "failed", "reasonCode": "FA_ROTATION_NONCONVERGENCE",
            "requestedRotation": rotation}


def factor_scores(z: np.ndarray, r: np.ndarray, loadings: np.ndarray,
                  phi: np.ndarray, psi: np.ndarray,
                  method: str) -> dict[str, Any]:
    """Regression (solve(R, L) Phi) and Bartlett (pattern-based) scores."""
    z = np.asarray(z, dtype=float)
    r = np.asarray(r, dtype=float)
    l = np.asarray(loadings, dtype=float)
    phi = np.asarray(phi, dtype=float)
    psi = np.asarray(psi, dtype=float)
    if method == "regression":
        try:
            coef = linalg.solve(r, l, assume_a="pos") @ phi
        except Exception:
            return {"status": "failed", "reasonCode": "FA_SCORE_UNAVAILABLE"}
        return {"status": "success", "scores": z @ coef, "coefficients": coef}
    if method == "bartlett":
        try:
            w = 1.0 / np.clip(psi, 1e-12, None)
            wl = l * w[:, None]
            mid = linalg.inv(wl.T @ l)
            coef = wl @ mid
        except Exception:
            return {"status": "failed", "reasonCode": "FA_SCORE_UNAVAILABLE"}
        return {"status": "success", "scores": z @ coef, "coefficients": coef}
    return {"status": "failed", "reasonCode": "FA_SCORE_UNAVAILABLE"}
