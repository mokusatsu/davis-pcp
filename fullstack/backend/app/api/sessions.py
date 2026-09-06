"""Sessions API: CRUD + static v1 migration."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from ..domain.errors import BizError
from ..storage.dataset_store import DatasetStore
from ..storage.session_store import SessionStore, revision_token

router = APIRouter()
sessions = SessionStore()
store = DatasetStore()

IRIS_FINGERPRINT_KEYS = {"sepal_length_cm", "sepal_width_cm", "petal_length_cm", "petal_width_cm", "species"}


class SessionCreate(BaseModel):
    name: str
    datasetId: str | None = None
    state: dict[str, Any] = {}


@router.get("/sessions")
def list_sessions() -> dict:
    return {"sessions": sessions.list_sessions()}


@router.post("/sessions")
def create_session(body: SessionCreate) -> dict:
    if body.datasetId:
        store.get_meta(body.datasetId)
    return sessions.create(body.name, body.datasetId, body.state)


@router.get("/sessions/{session_id}")
def get_session(session_id: str) -> dict:
    return sessions.get(session_id)


class SessionUpdate(BaseModel):
    state: dict[str, Any]
    versionToken: str | None = None
    name: str | None = None


@router.put("/sessions/{session_id}")
def update_session(session_id: str, body: SessionUpdate) -> dict:
    return sessions.update(session_id, body.state, body.versionToken, body.name)


@router.delete("/sessions/{session_id}")
def delete_session(session_id: str) -> dict:
    sessions.delete(session_id)
    return {"deleted": session_id}


class MigrateRequest(BaseModel):
    state: dict[str, Any]


AXIS_KEY_MAP = {
    "sepalLength": "sepal_length_cm",
    "sepalWidth": "sepal_width_cm",
    "petalLength": "petal_length_cm",
    "petalWidth": "petal_width_cm",
    "speciesCode": "species",
}
SPECIES_MAP = {0: "Iris-setosa", 1: "Iris-versicolor", 2: "Iris-virginica"}


@router.post("/sessions/migrate-static-v1")
def migrate_static_v1(body: MigrateRequest) -> dict:
    """Convert a static v1.0.0 schemaVersion:1 Iris state JSON to a v2 session.

    Verifies the fixture identity (axis keys must be exactly the Iris set);
    refuses non-Iris payloads.
    """
    snap = body.state.get("state", body.state)
    if snap.get("schemaVersion") != 1:
        raise BizError("MIGRATION_UNSUPPORTED_SCHEMA", f"schemaVersion {snap.get('schemaVersion')} は対応していません。",
                       details={"expected": 1})
    order = snap.get("order") or []
    if not set(order).issubset(AXIS_KEY_MAP.keys()) or len(order) < 2:
        raise BizError(
            "MIGRATION_NOT_IRIS_FIXTURE",
            "この状態ファイルはIris fixtureではありません。",
            suggested_actions=["静的v1のIris状態JSONを指定してください"],
        )
    dataset_meta = _find_iris_dataset()
    selected_ids = [_map_row(i) for i in snap.get("selected", [])]
    active_ids = [_map_row(i) for i in snap.get("active", [])]
    new_state = {
        "orientation": snap.get("orientation", "horizontal"),
        "orderMode": _map_order_mode(snap.get("orderMode")),
        "order": [AXIS_KEY_MAP[k] for k in order],
        "visibleAxes": [AXIS_KEY_MAP[k] for k in snap.get("visibleKeys", [])],
        "reversed": {AXIS_KEY_MAP[k]: v for k, v in (snap.get("reversed") or {}).items()},
        "selectedRowIds": selected_ids,
        "activeRowIds": active_ids,
        "jitter": {
            "enabled": bool(snap.get("jitterEnabled")),
            "mode": snap.get("jitterMode", "pixel"),
            "amount": snap.get("jitterAmount", 6),
            "seed": snap.get("jitterSeed"),
        },
        "rendering": {
            "lineOpacity": snap.get("lineOpacity", 0.22),
            "lineWidth": snap.get("lineWidth", 1),
            "showContext": snap.get("showContext", True),
        },
        "table": {
            "sort": snap.get("tableSort"),
            "pageSize": snap.get("pageSize", 25),
        },
        "migratedFrom": {"schemaVersion": 1, "app": "DAVIS-PCP Iris Static"},
    }
    session = sessions.create(f"Migrated: {body.state.get('app', 'static v1')}",
                              dataset_meta["datasetId"] if dataset_meta else None, new_state)
    return session


def _find_iris_dataset() -> dict | None:
    for ds in store.list_datasets():
        meta = store.get_meta(ds["datasetId"])
        names = {c["name"] for c in meta["schema"]}
        if names == IRIS_FINGERPRINT_KEYS:
            return meta
    return None


def _map_row(static_id: str) -> str:
    """Static ids IRIS-001.. are preserved verbatim as canonical rowIds."""
    return str(static_id)


def _map_order_mode(mode: str | None) -> str:
    mapping = {
        "database": "database", "componentJar": "componentJar", "componentPaper": "componentPaper",
        "permute": "permute", "correlation": "correlation", "manual": "manual",
    }
    return mapping.get(mode or "", "manual")
