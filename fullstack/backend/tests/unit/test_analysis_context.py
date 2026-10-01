"""Feature 25/26: shared AnalysisContext / ResultMeta contract."""
from __future__ import annotations

import pytest

from app.domain.context import (
    AnalysisContext,
    build_meta,
    check_revisions,
    collect_revisions,
    require_revisions,
    resolve_scope,
    scope_hash,
)
from app.domain.errors import BizError


def test_scope_hash_stable_regardless_of_order():
    assert scope_hash(["b", "a", "a"]) == scope_hash(["a", "b"])


def test_collect_and_check_revisions_ok_and_stale():
    revisions = collect_revisions({"dataRevision": 12}, {"schemaRevision": 4})
    assert revisions == {"schemaRevision": 4, "dataRevision": 12}
    check_revisions(revisions, 4, 12)
    with pytest.raises(BizError) as exc:
        check_revisions(revisions, 4, 11)
    assert exc.value.code == "ANALYSIS_INPUT_STALE"
    assert exc.value.status_code == 409


def test_require_revisions_rejects_missing_expectations():
    with pytest.raises(BizError) as exc:
        require_revisions(AnalysisContext(datasetId="d"))
    assert exc.value.code == "ANALYSIS_CONTEXT_INCOMPLETE"


def test_explicit_scope_requires_row_ids():
    with pytest.raises(ValueError):
        AnalysisContext(datasetId="d", scope="explicit")


def test_resolve_scope_presets_intersect_current_rows():
    current = ["r1", "r2", "r3"]
    assert resolve_scope(current, AnalysisContext(datasetId="d", scope="all")) == current
    ctx = AnalysisContext(datasetId="d", scope="active", activeRowIds=["r2", "r9"])
    assert resolve_scope(current, ctx) == ["r2"]
    ctx = AnalysisContext(datasetId="d", scope="selected", selectedRowIds=["r3", "r1"])
    assert resolve_scope(current, ctx) == ["r1", "r3"]
    ctx = AnalysisContext(datasetId="d", scope="sampled", sampledRowIds=["r3", "r9"])
    assert resolve_scope(current, ctx) == ["r3"]


@pytest.mark.parametrize("scope,field", [
    ("active", "activeRowIds"), ("selected", "selectedRowIds"),
    ("sampled", "sampledRowIds"), ("explicit", "rowIds"),
])
def test_scope_requires_an_explicit_set_and_empty_never_means_all(scope, field):
    with pytest.raises(ValueError):
        AnalysisContext(datasetId="d", scope=scope)
    assert resolve_scope(["r1", "r2"], AnalysisContext(datasetId="d", scope=scope, **{field: []})) == []
    # The resolver also protects callers which use an unvalidated model.
    with pytest.raises(BizError) as exc:
        resolve_scope(["r1"], AnalysisContext.model_construct(datasetId="d", scope=scope))
    assert exc.value.code == "ANALYSIS_SCOPE_INCOMPLETE"


def test_resolve_scope_explicit_rejects_unknown_rows():
    with pytest.raises(BizError) as exc:
        resolve_scope(["r1"], AnalysisContext(datasetId="d", scope="explicit", rowIds=["r1", "zzz"]))
    assert exc.value.code == "ANALYSIS_SCOPE_UNKNOWN_ROW"


def test_build_meta_shape():
    meta = build_meta(
        dataset_id="d", revisions={"schemaRevision": 4, "dataRevision": 12},
        scope="active", scope_ids=["r1", "r2"], effective_n=2, missing_count=0,
        algorithm_version="crosstab-1", is_explorative=False,
    )
    assert meta["scopeHash"].startswith("sha256:")
    assert meta["scopeCount"] == 2
    assert meta["effectiveN"] == 2
    assert meta["algorithmVersion"] == "crosstab-1"
    assert meta["isExplorative"] is False
