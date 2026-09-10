"""Feature 24: split determinism/disjointness and isRobust boundary rule."""
from __future__ import annotations

import pytest

from app.domain.verification import (
    benjamini_hochberg_adjust,
    check_row_disjoint,
    split_folds,
    split_holdout,
    wilson_interval,
)
from app.domain.errors import BizError


def test_holdout_split_70_30_disjoint_and_seeded():
    ids = [f"r{i}" for i in range(10)]
    sel, ev = split_holdout(ids, 0.3, 42)
    assert len(sel) == 7 and len(ev) == 3
    assert set(sel).isdisjoint(set(ev)) and sorted(sel + ev) == sorted(ids)
    assert split_holdout(ids, 0.3, 42) == (sel, ev)
    with pytest.raises(BizError):
        split_holdout(ids, 0.0, 42)


def test_folds_cover_all_rows_without_overlap():
    ids = [f"r{i}" for i in range(10)]
    folds = split_folds(ids, 5, 42)
    assert sum(len(f) for f in folds) == 10
    flat = [rid for fold in folds for rid in fold]
    assert len(set(flat)) == 10
    check_row_disjoint(folds[0], [r for f in folds[1:] for r in f])
    with pytest.raises(BizError):
        check_row_disjoint(["r1"], ["r1"])
    with pytest.raises(BizError):
        split_folds(["r1"], 5, 42)


def test_bh_adjust_and_wilson_null_safe():
    q, _, m = benjamini_hochberg_adjust([0.01, 0.04, 0.5])
    assert m == 3 and q[0] <= q[1] <= q[2]
    ci = wilson_interval(8, 10)
    assert ci is not None and ci[0] <= 0.8 <= ci[1]
    assert wilson_interval(0, 0) is None


def test_is_robust_boundary_rule():
    from app.algorithms.robustness.sensitivity import _direction, _relative_change

    assert _direction(0.5) == "positive"
    assert _direction(-0.5) == "negative"
    assert _direction(1e-13) == "flat"
    assert _relative_change(2.5, 2.4) == round(0.1 / 2.5, 4)
    assert _relative_change(0.0, 0.1) == round(0.1 / 1e-9, 4)
    assert _relative_change(None, 1.0) is None
