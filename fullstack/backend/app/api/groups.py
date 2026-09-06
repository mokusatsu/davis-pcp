"""Groups API: row-level group layer persisted per dataset."""
from __future__ import annotations

import json
import uuid
from pathlib import Path

from fastapi import APIRouter
from pydantic import BaseModel

from ..config import settings
from ..domain.errors import BizError
from ..services.dataset_service import now_iso

router = APIRouter()

DAVIS_PALETTE = ["#c8c8c8", "#d62728", "#2ca02c", "#17becf", "#e377c2", "#ff7f0e", "#ff9896", "#ffff3e"]


def _groups_path(dataset_id: str) -> Path:
    return settings.workspace_dir / "datasets" / f"{dataset_id}.groups.json"


class GroupDefinition(BaseModel):
    name: str
    rowIds: list[str]
    color: str | None = None
    source: str = "manual"
    evidenceClass: str = "MODERN-EXTENSION"
    algorithmVersion: str | None = None


@router.get("/datasets/{dataset_id}/groups")
def list_groups(dataset_id: str) -> dict:
    path = _groups_path(dataset_id)
    if not path.exists():
        return {"groups": []}
    return {"groups": json.loads(path.read_text(encoding="utf-8"))}


@router.post("/datasets/{dataset_id}/groups")
def create_group(dataset_id: str, group: GroupDefinition) -> dict:
    groups = _load(dataset_id)
    existing_names = {g["name"] for g in groups}
    entry = {
        "groupId": f"grp-{uuid.uuid4().hex[:10]}",
        "name": group.name,
        "rowIds": sorted(set(group.rowIds)),
        "color": group.color or DAVIS_PALETTE[min(len(groups) + 1, len(DAVIS_PALETTE) - 1)],
        "source": group.source,
        "evidenceClass": group.evidenceClass,
        "algorithmVersion": group.algorithmVersion,
        "createdAt": now_iso(),
    }
    if entry["name"] in existing_names:
        entry["name"] = f"{entry['name']} ({len(groups) + 1})"
    groups.append(entry)
    _save(dataset_id, groups)
    return entry


@router.patch("/datasets/{dataset_id}/groups/{group_id}")
def update_group(dataset_id: str, group_id: str, patch: dict) -> dict:
    groups = _load(dataset_id)
    for g in groups:
        if g["groupId"] == group_id:
            for key in ("name", "rowIds", "color"):
                if key in patch:
                    g[key] = sorted(set(patch[key])) if key == "rowIds" else patch[key]
            _save(dataset_id, groups)
            return g
    raise BizError("GROUP_NOT_FOUND", f"グループ {group_id} が見つかりません。", status_code=404)


@router.delete("/datasets/{dataset_id}/groups/{group_id}")
def delete_group(dataset_id: str, group_id: str) -> dict:
    groups = _load(dataset_id)
    remaining = [g for g in groups if g["groupId"] != group_id]
    if len(remaining) == len(groups):
        raise BizError("GROUP_NOT_FOUND", f"グループ {group_id} が見つかりません。", status_code=404)
    _save(dataset_id, remaining)
    return {"deleted": group_id}


def _load(dataset_id: str) -> list[dict]:
    path = _groups_path(dataset_id)
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def _save(dataset_id: str, groups: list[dict]) -> None:
    path = _groups_path(dataset_id)
    path.write_text(json.dumps(groups, ensure_ascii=False, indent=1), encoding="utf-8")
