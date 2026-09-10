"""Feature 25 Stage 2: provenance sidecars, raw/snapshot roundtrip, atomic commit."""
from __future__ import annotations

import polars as pl
import pytest

from app.domain.errors import BizError
from app.storage import dataset_store
from app.storage.dataset_store import DatasetStore


def _frame() -> pl.DataFrame:
    return pl.DataFrame({"__rowId__": ["r1", "r2"], "a": [1.0, None]})


def _step(op_id: str, operation: str) -> dict[str, Any]:
    from typing import Any  # noqa: F401  (kept local to avoid import churn)
    return {
        "operationId": op_id,
        "parentOperationId": None,
        "operation": operation,
        "params": {},
        "targetRowIds": [],
        "targetCells": [],
        "inputSchemaRevision": 1,
        "outputSchemaRevision": 1,
        "algorithmVersion": "test-1",
        "timestamp": "2026-09-11T00:00:00Z",
        "createdBy": "test",
    }


def test_commit_records_provenance_mask_raw_and_snapshot(tmp_path):
    store = DatasetStore(tmp_path)
    result = store.commit_data_change(
        "d", {"datasetId": "d", "name": "t"}, _frame(), None,
        _step("op-1", "import"),
        mask_entries=[{"rowId": "r2", "columnId": "a", "methodId": "mean",
                       "methodLabel": "平均値補完", "createdByOperationId": "op-1",
                       "inputDataRevision": 1, "maskRevision": 1}],
    )
    assert result["provenance"]["rawDataRevision"] == 1
    assert result["mask"]["maskRevision"] == 1
    assert store.read_raw("d").equals(_frame())
    assert store.read_snapshot("d", 1).equals(store.get_dataframe("d"))
    assert store.mask_revision("d") == 1
    assert store.load_provenance("d")["currentOperationId"] == "op-1"


def test_raw_snapshot_immutable_across_later_commits(tmp_path):
    store = DatasetStore(tmp_path)
    store.commit_data_change("d", {"datasetId": "d"}, _frame(), None, _step("op-1", "import"))
    changed = pl.DataFrame({"__rowId__": ["r1", "r2"], "a": [9.0, 9.0]})
    store.commit_data_change("d", dict(store.get_meta("d")), changed, None, _step("op-2", "transform"))
    assert store.read_raw("d").equals(_frame())
    assert store.get_meta("d")["dataRevision"] == 2


def test_commit_failure_leaves_values_and_history_untouched(tmp_path, monkeypatch):
    from pathlib import Path

    store = DatasetStore(tmp_path)
    store.commit_data_change("d", {"datasetId": "d"}, _frame(), None, _step("op-1", "import"))
    meta_path = Path(str(store._meta_path("d")))
    before_files = {p.name for p in Path(str(store.root)).iterdir() if p.is_file()}
    real_write = dataset_store.atomic_write_bytes

    def boom(path, payload):
        if Path(str(path)) == meta_path:
            raise OSError("disk gone")
        return real_write(path, payload)

    monkeypatch.setattr(dataset_store, "atomic_write_bytes", boom)
    with pytest.raises(OSError, match="disk gone"):
        store.commit_data_change("d", dict(store.get_meta("d")), _frame(), None, _step("op-2", "impute"))
    assert store.get_dataframe("d").equals(_frame())
    assert len(store.load_provenance("d")["operations"]) == 1
    assert {p.name for p in Path(str(store.root)).iterdir() if p.is_file()} == before_files
