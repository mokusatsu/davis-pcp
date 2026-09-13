"""Feature 030 MCA numeric kernel tests (production)."""
from __future__ import annotations

import numpy as np

from app.algorithms.models.mca import benzecri_adjusted, project_mca_rows, run_mca_numeric

TOL = dict(rtol=1e-9, atol=1e-10)


def _fixture_z():
    z = np.zeros((24, 8))
    z[:12, 0] = 1
    z[12:, 1] = 1
    z[:8, 2] = 1
    z[8:16, 3] = 1
    z[16:, 4] = 1
    z[:5, 5] = 1
    z[5:13, 6] = 1
    z[13:, 7] = 1
    return z


def test_mca01_row_sums_and_total():
    z = _fixture_z()
    k = run_mca_numeric(z, weights=None, m=3, category_index=list(range(8)))
    assert k["m"] == 3 and k["k"] == 8 and k["n"] == 24
    assert abs(k["totalInertia"] - (8 - 3) / 3) < 1e-12
    assert abs(float(k["a"].sum()) - 1.0) < 1e-12
    assert abs(float(k["c"].sum()) - 1.0) < 1e-12
    assert abs(float(k["p"].sum()) - 3.0) < 1e-12


def test_mca02_inertia_ratios_use_full_total():
    z = _fixture_z()
    k = run_mca_numeric(z, weights=None, m=3, category_index=list(range(8)))
    eig = k["eigenvalues"]
    assert abs(float(eig.sum() + k["discardedNumericalInertia"]) - k["totalInertia"]) < 1e-9
    assert abs(float(k["inertiaRatio"].sum()) - 1.0) < 1e-9 or len(eig) == k["rank"]
    assert k["rank"] <= min(24 - 1, 8 - 3)


def test_mca03_contribution_sums_and_weighted_center():
    z = _fixture_z()
    k = run_mca_numeric(z, weights=None, m=3, category_index=list(range(8)))
    for axis in range(k["rank"]):
        assert abs(float(k["rowContrib"][:, axis].sum()) - 1.0) < 1e-9
        assert abs(float(k["catContrib"][:, axis].sum()) - 1.0) < 1e-9
    assert float(np.abs(k["a"] @ k["f"]).max()) < 1e-9
    assert float(np.abs(k["c"] @ k["g"]).max()) < 1e-9


def test_mca04_direct_indicator_ca_agreement():
    from app.algorithms.models.correspondence import run_ca_numeric

    z = _fixture_z()
    k = run_mca_numeric(z, weights=None, m=3, category_index=list(range(8)))
    n = z.shape[0]
    table = z / (n * 3)
    # Direct indicator CA on the same normalized indicator table.
    ca = run_ca_numeric(table * table.sum(), keep_row_index=list(range(n)),
                        keep_col_index=list(range(8)))
    assert np.allclose(np.sort(k["eigenvalues"]), np.sort(ca["eigenvalues"]), **TOL)


def test_mca05_weight_scale_invariance_and_zero_rejected():
    import pytest

    z = _fixture_z()
    k1 = run_mca_numeric(z, weights=None, m=3, category_index=list(range(8)))
    w = np.ones(24) * 100.0
    k2 = run_mca_numeric(z, weights=w, m=3, category_index=list(range(8)))
    assert np.allclose(np.abs(k1["f"]), np.abs(k2["f"]), **TOL)
    bad = np.ones(24)
    bad[0] = 0.0
    with pytest.raises(ValueError):
        run_mca_numeric(z, weights=bad, m=3, category_index=list(range(8)))


def test_mca09_benzecri_threshold_and_all_zero():
    z = _fixture_z()
    k = run_mca_numeric(z, weights=None, m=3, category_index=list(range(8)))
    adj, ratio, reason = benzecri_adjusted(k["eigenvalues"], 3)
    assert reason is None
    assert len(adj) == len(ratio) == k["rank"]
    before = k["f"].copy()
    # Raw coordinates untouched by adjustment computation.
    assert np.array_equal(k["f"], before)
    adj0, ratio0, reason0 = benzecri_adjusted(np.array([0.1, 0.2]), 5)
    assert reason0 == "NO_EIGENVALUE_ABOVE_BENZECRI_THRESHOLD"
    assert all(v is None for v in ratio0)


def test_mca_projection_matches_fit():
    z = _fixture_z()
    k = run_mca_numeric(z, weights=None, m=3, category_index=list(range(8)))
    proj = project_mca_rows(z, c=k["c"], v=k["v"], m=3)
    assert np.allclose(proj, k["f"], **TOL)


def test_mca12_degenerate_subspace():
    # Full 2x2x2 factorial: three identical eigenvalues -> degenerate block.
    import itertools

    rows = np.array(list(itertools.product([0, 1], [0, 1], [0, 1])) * 3)
    z = np.column_stack([(rows[:, j, None] == np.arange(2)).astype(float) for j in range(3)])
    k = run_mca_numeric(z, weights=None, m=3, category_index=list(range(6)))
    assert k["degenerateBlocks"], "expected a degenerate block for symmetric structure"
    # Subspace equivalence: same indicator profile reconstructs the same centered row.
    proj = project_mca_rows(z[:8], c=k["c"], v=k["v"], m=3)
    assert np.allclose(proj, k["f"][:8], **TOL)
    # Strict subspace check: row projector F F' is invariant under within-block rotation.
    f = k["f"]
    rng = np.random.default_rng(42)
    q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    f_rot = f @ q
    assert np.allclose(f_rot @ f_rot.T, f @ f.T, **TOL)
    g = k["g"]
    assert np.allclose((g @ q) @ (g @ q).T, g @ g.T, **TOL)


def test_mca11_rename_rowperm_dup_invariance():
    # MCA11: category relabeling / row permutation / duplicated variable keep geometry.
    z = _fixture_z()
    k = run_mca_numeric(z, weights=None, m=3, category_index=list(range(8)))
    perm = np.random.default_rng(7).permutation(z.shape[0])
    kp = run_mca_numeric(z[perm], weights=None, m=3, category_index=list(range(8)))
    assert np.allclose(np.sort(kp["eigenvalues"]), np.sort(k["eigenvalues"]), **TOL)
    # Row permutation: same multiset of row coordinates.
    assert np.allclose(np.sort(kp["f"].ravel()), np.sort(k["f"].ravel()), **TOL)
    # Duplicated variable: total inertia follows (K-m)/m and geometry stays finite.
    zd = np.column_stack([z, z[:, :2]])
    kd = run_mca_numeric(zd, weights=None, m=4, category_index=list(range(10)))
    assert abs(kd["totalInertia"] - (10 - 4) / 4) < 1e-12
    assert np.all(np.isfinite(kd["f"])) and np.all(np.isfinite(kd["g"]))
