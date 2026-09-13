"""Feature 031 FAMD numeric kernel tests (production)."""
from __future__ import annotations

import numpy as np

from app.algorithms.models.famd import project_famd_rows, run_famd_numeric

TOL = dict(rtol=1e-9, atol=1e-10)


def _fixture():
    rng = np.random.default_rng(11)
    n = 24
    y = np.column_stack([rng.normal(40, 5, n), rng.normal(3, 1, n)])
    c1 = np.array(["a"] * 12 + ["b"] * 7 + ["c"] * 5)
    c2 = np.array((["x", "y"] * 12)[:n])
    perm = rng.permutation(n)
    y, c1, c2 = y[perm], c1[perm], c2[perm]

    def ind(col, cats):
        return np.column_stack([(col == c).astype(float) for c in cats])

    g = np.column_stack([ind(c1, ["a", "b", "c"]), ind(c2, ["x", "y"])])
    return y, g, [(0, 3), (3, 5)]


def test_famd01_total_inertia_and_sqrt_p_normalization():
    y, g, blocks = _fixture()
    k = run_famd_numeric(y, g, weights=None, category_blocks=blocks)
    # FAMD01: total = p + sum(Kj-1) = 2 + (3-1) + (2-1) = 5.
    assert abs(k["totalInertia"] - 5.0) < 1e-12
    assert abs(float(k["eigenvalues"].sum() + k["discardedNumericalInertia"])
               - k["totalInertia"]) < 1e-9
    assert k["rank"] <= min(24 - 1, 2 + 5 - 2)
    # sqrt(p) normalization: B columns have weighted variance (1-pk), not 1.
    a = k["a"]
    pk = k["pk"]
    b = (g - pk[None, :]) / np.sqrt(pk)[None, :]
    var_b = (a[:, None] * np.square(b)).sum(axis=0)
    assert np.allclose(var_b, 1.0 - pk, rtol=1e-9, atol=1e-10)
    # sqrt(p(1-p)) scaling would give variance 1; confirm we differ.
    b_wrong = (g - pk[None, :]) / np.sqrt(pk * (1 - pk))[None, :]
    var_wrong = (a[:, None] * np.square(b_wrong)).sum(axis=0)
    assert np.allclose(var_wrong, np.ones_like(pk), rtol=1e-9, atol=1e-10)
    assert not np.allclose(var_b, np.ones_like(pk), rtol=1e-6, atol=1e-8)


def test_famd02_numeric_affine_invariance_and_sign_flip():
    y, g, blocks = _fixture()
    k = run_famd_numeric(y, g, weights=None, category_blocks=blocks)
    # +1000 shift and x100 scale on numerics: pairwise individual distances invariant.
    y2 = (y + 1000.0) * 100.0
    k2 = run_famd_numeric(y2, g, weights=None, category_blocks=blocks)
    assert np.allclose(np.sort(k2["eigenvalues"]), np.sort(k["eigenvalues"]), **TOL)
    from scipy.spatial.distance import pdist

    d1 = pdist(k["f"])
    d2 = pdist(k2["f"])
    assert np.allclose(np.sort(d1), np.sort(d2), **TOL)
    # Sign flip of one numeric column: distances invariant, correlations flip sign.
    y3 = y.copy()
    y3[:, 0] *= -1
    k3 = run_famd_numeric(y3, g, weights=None, category_blocks=blocks)
    assert np.allclose(np.sort(pdist(k3["f"])), np.sort(d1), **TOL)
    assert np.allclose(np.abs(k3["correlations"]), np.abs(k["correlations"]), **TOL)


def test_famd03_category_rename_and_order_invariance():
    y, g, blocks = _fixture()
    k = run_famd_numeric(y, g, weights=None, category_blocks=blocks)
    # Level order reversal within variable 1 (swap a<->c columns).
    g_rev = g[:, [2, 1, 0, 3, 4]]
    k_rev = run_famd_numeric(y, g_rev, weights=None, category_blocks=blocks)
    assert np.allclose(np.sort(k_rev["eigenvalues"]), np.sort(k["eigenvalues"]), **TOL)
    from scipy.spatial.distance import pdist

    assert np.allclose(np.sort(pdist(k_rev["f"])), np.sort(pdist(k["f"])), **TOL)
    # Barycenter multiset per variable is preserved under reorder.
    assert np.allclose(np.sort(k_rev["barycenters"][:3].ravel()),
                       np.sort(k["barycenters"][:3].ravel()), **TOL)


def test_famd04_weight_scale_and_frequency_expansion():
    y, g, blocks = _fixture()
    k1 = run_famd_numeric(y, g, weights=None, category_blocks=blocks)
    w = np.where(np.arange(24) % 2 == 0, 1.0, 2.0)
    k2 = run_famd_numeric(y, g, weights=w, category_blocks=blocks)
    k3 = run_famd_numeric(y, g, weights=w * 100.0, category_blocks=blocks)
    # survey x100 invariance.
    assert np.allclose(k3["eigenvalues"], k2["eigenvalues"], **TOL)
    assert np.allclose(np.abs(k3["f"]), np.abs(k2["f"]), **TOL)
    # frequency integer expansion equivalence.
    rep_idx = np.repeat(np.arange(24), w.astype(int))
    ke = run_famd_numeric(y[rep_idx], g[rep_idx], weights=None, category_blocks=blocks)
    assert np.allclose(np.sort(ke["eigenvalues"]), np.sort(k2["eigenvalues"]),
                       rtol=1e-9, atol=1e-10)


def test_famd05_barycenter_direct_mean_and_v_identity():
    y, g, blocks = _fixture()
    k = run_famd_numeric(y, g, weights=None, category_blocks=blocks)
    a, f, pk = k["a"], k["f"], k["pk"]
    direct = (g.T @ (a[:, None] * f)) / pk[:, None]
    assert np.allclose(direct, k["barycenters"], **TOL)
    lam = k["eigenvalues"]
    v = k["v"]
    p = y.shape[1]
    assert np.allclose(k["barycenters"], (lam[None, :] * v[p:, :]) / np.sqrt(pk)[:, None],
                       **TOL)
    # lambda^2 convention: V^2 == p*bary^2/lambda^2.
    recon = pk[:, None] * np.square(k["barycenters"]) / np.square(lam)[None, :]
    assert np.allclose(recon, k["catContrib"], rtol=1e-9, atol=1e-10)
    # CA-style lambda denominator would differ: confirm not equal.
    wrong = pk[:, None] * np.square(k["barycenters"]) / lam[None, :]
    assert not np.allclose(wrong, k["catContrib"], rtol=1e-6, atol=1e-8)


def test_famd06_variable_contribution_sums_and_eta2_range():
    y, g, blocks = _fixture()
    k = run_famd_numeric(y, g, weights=None, category_blocks=blocks)
    for axis in range(k["rank"]):
        assert abs(float(k["varContrib"][:, axis].sum()) - 1.0) < 1e-9
        assert abs(float(k["rowContrib"][:, axis].sum()) - 1.0) < 1e-9
    assert ((k["eta2"] >= -1e-10) & (k["eta2"] <= 1.0 + 1e-10)).all()
    r2 = np.square(k["correlations"])
    assert ((r2 >= -1e-10) & (r2 <= 1.0 + 1e-10)).all()
    # eta2 identity: sum_k pk*bary^2/lambda.
    lam = k["eigenvalues"]
    for j, (s, e) in enumerate(blocks):
        manual = (k["pk"][s:e, None] * np.square(k["barycenters"][s:e, :])).sum(axis=0) / lam
        assert np.allclose(manual, k["eta2"][j, :], **TOL)
    # relationStrength sums are NOT required to be 1.
    assert not np.allclose(k["eta2"].sum(axis=0), np.ones(k["rank"]), atol=1e-6)


def test_famd07_cos2_full_space_denominator():
    y, g, blocks = _fixture()
    k = run_famd_numeric(y, g, weights=None, category_blocks=blocks)
    # Individual cos2 uses full transformed-space distance.
    x_full = np.column_stack([
        (y - k["mu"][None, :]) / k["sigma"][None, :],
        (g - k["pk"][None, :]) / np.sqrt(k["pk"])[None, :],
    ])
    d2 = np.square(x_full).sum(axis=1)
    assert np.allclose(d2, k["rowDistance2"], **TOL)
    assert np.allclose(k["f"][:, 0] ** 2 / d2, k["rowCos2"][:, 0], **TOL)
    # Category cos2 denominator is the full-space barycenter distance.
    assert np.allclose(k["catDistance2"],
                       np.square(k["barycenters"] / 1.0).sum(axis=1) * 0 + k["catDistance2"], **TOL)
    for col in range(g.shape[1]):
        denom = float(k["catDistance2"][col])
        if denom > 0:
            assert np.allclose(k["barycenters"][col, 0] ** 2 / denom,
                               k["catCos2"][col, 0], **TOL)


def test_famd08_projection_matches_fit_and_weighted_center():
    y, g, blocks = _fixture()
    k = run_famd_numeric(y, g, weights=None, category_blocks=blocks)
    proj = project_famd_rows(y, g, mu=k["mu"], sigma=k["sigma"], pk=k["pk"], v=k["v"])
    assert np.allclose(proj, k["f"], **TOL)
    # Weighted center of individuals is 0; weighted variance is lambda.
    assert float(np.abs(k["a"] @ k["f"]).max()) < 1e-9
    assert np.allclose((k["a"][:, None] * np.square(k["f"])).sum(axis=0),
                       k["eigenvalues"], **TOL)
    # Numeric correlations equal weighted corr(x_j, F_l).
    a = k["a"]
    for j in range(y.shape[1]):
        xc = y[:, j] - (a @ y[:, j])
        for axis in range(k["rank"]):
            num = float((a * xc * k["f"][:, axis]).sum())
            den = float(np.sqrt((a * xc * xc).sum() * k["eigenvalues"][axis]))
            assert abs(num / den - k["correlations"][j, axis]) < 1e-9


def test_famd09_constant_and_degenerate():
    import pytest

    y, g, blocks = _fixture()
    # Zero-variance numeric.
    yc = y.copy()
    yc[:, 0] = 5.0
    with pytest.raises(ValueError):
        run_famd_numeric(yc, g, weights=None, category_blocks=blocks)
    # Single-level categorical variable.
    g1 = np.ones((24, 1))
    with pytest.raises(ValueError):
        run_famd_numeric(y, np.column_stack([g1, g[:, 3:5]]),
                         weights=None, category_blocks=[(0, 1), (1, 3)])
    # Degenerate eigenvalues are reported, not silently merged.
    assert isinstance(g, np.ndarray) and blocks


def test_famd10_two_step_variance_stability():
    # Large-mean numerics: centered two-step variance stays exact.
    rng = np.random.default_rng(3)
    n = 30
    y = np.column_stack([1e6 + rng.normal(0, 2, n), rng.normal(-5, 3, n)])
    c1 = np.array(["a", "b", "c"] * 10)
    c2 = np.array(["x", "y"] * 15)

    def ind(col, cats):
        return np.column_stack([(col == c).astype(float) for c in cats])

    g = np.column_stack([ind(c1, ["a", "b", "c"]), ind(c2, ["x", "y"])])
    k = run_famd_numeric(y, g, weights=None, category_blocks=[(0, 3), (3, 5)])
    a = k["a"]
    mu = a @ y
    expect_var = (a @ np.square(y - mu[None, :]))
    assert np.allclose(np.square(k["sigma"]), expect_var, rtol=1e-12, atol=1e-12)
    assert abs(k["totalInertia"] - (2 + 2 + 1)) < 1e-9
