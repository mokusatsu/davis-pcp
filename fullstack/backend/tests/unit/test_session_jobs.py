"""Session store, job transitions, and migration tests."""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))

from app.domain.errors import BizError  # noqa: E402
from app.storage.session_store import JobStore, SessionStore, revision_token  # noqa: E402


@pytest.fixture()
def stores(tmp_path):
    return SessionStore(tmp_path), JobStore(tmp_path)


class TestSessionStore:
    def test_create_get_revision(self, stores):
        ss, _ = stores
        s = ss.create("test", None, {"a": 1})
        assert s["revision"] == 1
        fetched = ss.get(s["sessionId"])
        assert fetched["state"] == {"a": 1}
        assert fetched["versionToken"] == revision_token(s["sessionId"], 1)

    def test_update_increments_revision(self, stores):
        ss, _ = stores
        s = ss.create("t", None, {})
        token = s["versionToken"]
        updated = ss.update(s["sessionId"], {"b": 2}, token)
        assert updated["revision"] == 2
        assert updated["state"] == {"b": 2}

    def test_stale_update_rejected_409(self, stores):
        ss, _ = stores
        s = ss.create("t", None, {"v": 1})
        stale_token = s["versionToken"]
        ss.update(s["sessionId"], {"v": 2}, stale_token)
        with pytest.raises(BizError) as exc:
            ss.update(s["sessionId"], {"v": 3}, stale_token)
        assert exc.value.status_code == 409
        assert "state" in exc.value.details

    def test_delete_missing_raises_404(self, stores):
        ss, _ = stores
        with pytest.raises(BizError):
            ss.delete("nope")

    def test_list_sessions(self, stores):
        ss, _ = stores
        ss.create("alpha", None, {})
        ss.create("beta", None, {})
        names = [s["name"] for s in ss.list_sessions()]
        assert set(names) >= {"alpha", "beta"}


class TestJobTransitions:
    def test_lifecycle(self, stores):
        _, js = stores
        job = js.create("job-1", "ordering", None, {})
        assert job["status"] == "queued"
        job = js.transition("job-1", "running", phase="compute", units_done=5)
        assert job["status"] == "running" and job["unitsDone"] == 5
        job = js.transition("job-1", "completed", result={"order": ["a"]})
        assert job["status"] == "completed"

    def test_cancelled_never_completes(self, stores):
        """A cancelled job must never transition back to completed."""
        _, js = stores
        js.create("job-2", "clustering", None, {})
        js.transition("job-2", "cancelled")
        for target in ("running", "completed"):
            result = js.transition("job-2", target)
            assert result["status"] == "cancelled", f"{target} after cancelled"

    def test_completed_is_terminal(self, stores):
        _, js = stores
        js.create("job-3", "import", None, {})
        js.transition("job-3", "completed")
        result = js.transition("job-3", "failed", error={"message": "late"})
        assert result["status"] == "completed"
