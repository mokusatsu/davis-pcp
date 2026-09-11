"""Server-side store for pinned mining candidate sets (Feature 24 / VERIFY-02).

Exploration persists the candidate set it produced; verification loads it by
hash instead of rediscovering candidates. Storing the rule set on the server
means the client cannot substitute rules that were never explored.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..config import settings
from ..domain.mining_candidate import PinnedCandidateSet, compute_candidate_set_hash

_HASH_PREFIX = "sha256:"


class CandidateSetStore:
    def __init__(self, workspace: Path | None = None) -> None:
        self.root = (workspace or settings.workspace_dir) / "candidate-sets"

    def _path(self, dataset_id: str, candidate_set_hash: str) -> Path:
        digest = candidate_set_hash.split(_HASH_PREFIX, 1)[-1]
        safe = "".join(ch for ch in digest if ch.isalnum() or ch in "-_")[:128]
        safe_dataset = "".join(ch for ch in str(dataset_id) if ch.isalnum() or ch in "-_")[:96]
        return self.root / safe_dataset / f"{safe}.json"

    def save(self, candidate_set: PinnedCandidateSet | dict[str, Any]) -> str:
        if isinstance(candidate_set, PinnedCandidateSet):
            payload = candidate_set.model_dump()
        else:
            payload = dict(candidate_set)
        digest = payload.get("candidateSetHash") or compute_candidate_set_hash(payload)
        payload["candidateSetHash"] = digest
        path = self._path(str(payload.get("datasetId") or "unknown"), digest)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
        return digest

    def load(self, dataset_id: str, candidate_set_hash: str) -> dict[str, Any] | None:
        if not candidate_set_hash:
            return None
        path = self._path(dataset_id, candidate_set_hash)
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None
        return payload if isinstance(payload, dict) else None

    def delete_dataset(self, dataset_id: str) -> None:
        import shutil

        safe_dataset = "".join(ch for ch in str(dataset_id) if ch.isalnum() or ch in "-_")[:96]
        target = self.root / safe_dataset
        if target.exists():
            shutil.rmtree(target, ignore_errors=True)


candidate_store = CandidateSetStore()
