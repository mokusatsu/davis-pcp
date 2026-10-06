"""Real API deletion/Undo contracts for survey-design references.

Only the dataset store is isolated; import, codebook, delete, and Undo handlers
run normally. The synthetic fixture includes stable IDs, metadata, and MA groups.
"""
from __future__ import annotations

from copy import deepcopy

import pytest
from fastapi.testclient import TestClient

from app.api import datasets, exports
from app.main import app
from app.storage.dataset_store import DatasetStore
from .test_data_roundtrips import configured_codebook, import_codebook, upload


EDITOR_FIELDS = (
    "columnId", "name", "label", "scaleType", "role", "valueLabels",
    "categoryOrder", "missingCodes", "missingReasons", "isReversed",
    "multiResponseGroup", "multiResponseOptionLabel",
)


class DatasetCase:
    def __init__(self, client, dataset_id, store):
        self.client, self.dataset_id, self.store = client, dataset_id, store
        self.base = f"/api/v1/datasets/{dataset_id}"

    def capture(self):
        responses = [self.client.get(self.base + suffix)
                     for suffix in ("/codebook", "", "/provenance")]
        for response in responses:
            assert response.status_code == 200, response.text
        codebook, meta, history = [response.json() for response in responses]
        frame = self.store.get_dataframe(self.dataset_id)
        assert codebook == self.store.load_codebook(self.dataset_id)
        return {
            "codebook": codebook, "api_meta": meta, "api_history": history,
            "meta": self.store.get_meta(self.dataset_id),
            "history": self.store.load_provenance(self.dataset_id),
            "mask": self.store.load_mask(self.dataset_id),
            "physical_columns": frame.columns,
            "physical_dtypes": {name: str(dtype) for name, dtype in frame.schema.items()},
            "physical_values": frame.to_dict(as_series=False),
            "canonical_ids": {col["name"]: col["columnId"] for col in codebook["columns"]},
        }

    def update(self, payload):
        response = self.client.put(self.base + "/codebook", json=payload)
        assert response.status_code == 200, response.text
        return self.capture()

    def delete(self, column):
        response = self.client.delete(self.base + "/columns/" + column)
        assert response.status_code == 200, response.text
        return self.capture()


@pytest.fixture(params=[True, False], ids=["configured", "design_only"])
def case(request, tmp_path, monkeypatch):
    store = DatasetStore(tmp_path)
    monkeypatch.setattr(datasets, "store", store)
    monkeypatch.setattr(exports, "store", store)
    with TestClient(app) as client:
        dataset_id = upload(client)
        configured_codebook(client, dataset_id)
        case = DatasetCase(client, dataset_id, store)
        before = case.capture()
        if not request.param:
            # Explicit design-only configuration is a supported API state.
            before = case.update({
                "weightConfig": None, "surveyDesign": before["codebook"]["surveyDesign"],
                "expectedSchemaRevision": before["codebook"]["schemaRevision"],
            })
            assert "weightConfig" not in before["codebook"]
        ids = before["canonical_ids"]
        assert before["codebook"]["surveyDesign"] == {
            "weightColumnId": ids["w"], "strataColumnId": ids["stratum"],
            "psuColumnId": ids["psu"], "fpcColumnId": ids["fpc"],
            "replicateWeightColumnIds": [ids["rw2"], ids["rw1"]],
        }
        yield case, before


def assert_deletion_integrity(before, after, column):
    assert after["physical_columns"] == [name for name in before["physical_columns"] if name != column]
    for field in ("physical_values", "physical_dtypes", "canonical_ids"):
        assert after[field] == {name: value for name, value in before[field].items() if name != column}
    assert after["codebook"]["columns"] == [
        col for col in before["codebook"]["columns"] if col["name"] != column
    ]
    assert after["codebook"]["multiResponseGroups"] == before["codebook"]["multiResponseGroups"]
    assert after["meta"]["columnCount"] == before["meta"]["columnCount"] - 1
    assert after["meta"]["rowCount"] == before["meta"]["rowCount"]
    assert after["meta"]["schema"] == [col for col in before["meta"]["schema"] if col["name"] != column]
    assert after["api_meta"]["columnCount"] == after["meta"]["columnCount"]
    assert after["api_meta"]["rowCount"] == after["meta"]["rowCount"]
    assert after["meta"]["dataRevision"] == before["meta"]["dataRevision"] + 1
    assert after["meta"]["schemaRevision"] == before["meta"]["schemaRevision"] + 1
    assert after["codebook"]["schemaRevision"] == after["meta"]["schemaRevision"]
    assert after["meta"]["fingerprint"] != before["meta"]["fingerprint"]
    assert len(after["history"]["operations"]) == len(before["history"]["operations"]) + 1
    assert after["history"]["operations"][-1]["operation"] == "delete_column"


def assert_undo_restores(case, before, current):
    response = case.client.post(case.base + "/undo", json={
        "expectedDataRevision": current["meta"]["dataRevision"],
        "expectedSchemaRevision": current["codebook"]["schemaRevision"],
    })
    assert response.status_code == 200, response.text
    outcome = response.json()
    assert outcome["restoreWarnings"] == []
    restored = case.capture()
    # Exact data (including internal row IDs), column IDs, and complete metadata.
    for field in ("physical_columns", "physical_dtypes", "physical_values", "canonical_ids", "codebook"):
        assert restored[field] == before[field], field
    for field in ("schema", "schemaRevision", "rowCount", "columnCount", "rowIdentity", "fingerprint", "valuesFingerprint"):
        assert restored["meta"].get(field) == before["meta"].get(field), field
    assert restored["mask"]["entries"] == before["mask"]["entries"]
    # Undo restores schemaRevision but advances data/mask revisions and history.
    assert restored["meta"]["dataRevision"] == current["meta"]["dataRevision"] + 1
    assert restored["mask"]["maskRevision"] == current["mask"]["maskRevision"] + 1
    assert len(restored["history"]["operations"]) == len(current["history"]["operations"]) + 1
    assert restored["history"]["operations"][-1]["operation"] == "undo"
    assert restored["history"]["cursorOperationId"] == before["history"]["cursorOperationId"]
    assert restored["history"]["currentOperationId"] == before["history"]["currentOperationId"]
    assert restored["history"]["redoStack"] == [current["history"]["cursorOperationId"]]
    assert outcome["targetDataRevision"] == before["meta"]["dataRevision"]
    assert outcome["canUndo"] is False and outcome["canRedo"] is True


def editor_payload(codebook, label):
    columns = [{key: deepcopy(col[key]) for key in EDITOR_FIELDS if key in col}
               for col in codebook["columns"]]
    next(col for col in columns if col["name"] == "answer")["label"] = label
    return {"columns": columns, "multiResponseGroups": deepcopy(codebook["multiResponseGroups"]),
            "expectedSchemaRevision": codebook["schemaRevision"]}


def file_snapshot(root):
    return {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in root.rglob("*") if path.is_file()}


def test_weight_deletion_clears_design_editor_save_and_undo(case, monkeypatch):
    case, before = case
    deleted = case.delete("w")
    assert_deletion_integrity(before, deleted, "w")
    assert "weightConfig" not in deleted["codebook"]
    assert "surveyDesign" not in deleted["codebook"]

    # A caller's stale orphan remains invalid and cannot publish any files.
    orphan = deepcopy(before["codebook"]["surveyDesign"])
    orphan.pop("weightColumnId")
    payload = editor_payload(deleted["codebook"], "SHOULD NOT PERSIST")
    payload["surveyDesign"] = orphan
    disk_before = file_snapshot(case.store.root)
    publications = []
    original_publish = case.store._publish_files

    def record_publication(payloads):
        publications.append(payloads)
        return original_publish(payloads)

    with monkeypatch.context() as patch:
        patch.setattr(case.store, "_publish_files", record_publication)
        rejected = case.client.put(case.base + "/codebook", json=payload)
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["error"]["code"] == "CODEBOOK_INVALID"
    assert "weightColumnId" in rejected.json()["error"]["message"]
    assert publications == []
    assert file_snapshot(case.store.root) == disk_before
    assert case.capture() == deleted

    # Ordinary editor saves omit weight/design; they succeed and keep them absent.
    payload = editor_payload(deleted["codebook"], "Edited after deleting weight")
    assert "weightConfig" not in payload and "surveyDesign" not in payload
    edited = case.update(payload)
    assert "weightConfig" not in edited["codebook"]
    assert "surveyDesign" not in edited["codebook"]
    expected_columns = deepcopy(deleted["codebook"]["columns"])
    next(col for col in expected_columns if col["name"] == "answer")["label"] = "Edited after deleting weight"
    assert edited["codebook"]["columns"] == expected_columns
    assert edited["codebook"]["multiResponseGroups"] == deleted["codebook"]["multiResponseGroups"]
    assert edited["physical_values"] == deleted["physical_values"]
    assert edited["meta"]["dataRevision"] == deleted["meta"]["dataRevision"]
    assert edited["codebook"]["schemaRevision"] == deleted["codebook"]["schemaRevision"] + 1
    assert edited["history"] == deleted["history"]
    assert_undo_restores(case, before, edited)


@pytest.mark.parametrize("column,field,only_replicate", [
    ("stratum", "strataColumnId", False), ("psu", "psuColumnId", False),
    ("fpc", "fpcColumnId", False), ("rw2", "replicateWeightColumnIds", False),
    ("rw2", "replicateWeightColumnIds", True), ("answer", None, False),
])
def test_other_deletion_preserves_valid_design_and_undo(case, column, field, only_replicate):
    case, before = case
    if only_replicate:
        design = deepcopy(before["codebook"]["surveyDesign"])
        design["replicateWeightColumnIds"] = [before["canonical_ids"][column]]
        before = case.update({"surveyDesign": design,
                              "expectedSchemaRevision": before["codebook"]["schemaRevision"]})
    deleted = case.delete(column)
    assert_deletion_integrity(before, deleted, column)
    expected = deepcopy(before["codebook"]["surveyDesign"])
    if field == "replicateWeightColumnIds":
        if only_replicate:
            expected.pop(field)
        else:
            expected[field] = [cid for cid in expected[field] if cid != before["canonical_ids"][column]]
    elif field:
        expected.pop(field)
    assert deleted["codebook"].get("weightConfig") == before["codebook"].get("weightConfig")
    assert deleted["codebook"]["surveyDesign"] == expected
    assert_undo_restores(case, before, deleted)


def test_roundtrip_omission_preserves_valid_design_and_explicit_clear(case):
    case, before = case
    exported = case.client.get(case.base + "/codebook/export?format=json")
    assert exported.status_code == 200, exported.text
    payload = exported.json()
    payload.pop("weightConfig", None)
    payload.pop("surveyDesign")
    response = import_codebook(case.client, case.dataset_id, payload)
    assert response.status_code == 200, response.text
    roundtripped = case.capture()
    for field in ("columns", "multiResponseGroups", "weightConfig", "surveyDesign"):
        assert roundtripped["codebook"].get(field) == before["codebook"].get(field)
    assert roundtripped["physical_values"] == before["physical_values"]
    assert roundtripped["history"] == before["history"]
    assert roundtripped["meta"]["dataRevision"] == before["meta"]["dataRevision"]
    assert roundtripped["codebook"]["schemaRevision"] == before["codebook"]["schemaRevision"] + 1

    # Clearing configured weight implicitly clears design; design-only must be explicit.
    clear = {"weightConfig": None} if "weightConfig" in before["codebook"] else {"surveyDesign": None}
    cleared = case.update({**clear, "expectedSchemaRevision": roundtripped["codebook"]["schemaRevision"]})
    assert "weightConfig" not in cleared["codebook"]
    assert "surveyDesign" not in cleared["codebook"]
    for field in ("physical_values", "canonical_ids", "history"):
        assert cleared[field] == before[field]
    assert cleared["codebook"]["columns"] == before["codebook"]["columns"]
    assert cleared["meta"]["dataRevision"] == before["meta"]["dataRevision"]
    assert cleared["codebook"]["schemaRevision"] == roundtripped["codebook"]["schemaRevision"] + 1
