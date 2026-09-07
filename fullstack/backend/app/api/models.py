"""Decision Tree and Random Forest membership service (MODERN-EXTENSION).

Node/leaf selections resolve to row-ID sets for the central Selection Engine.
"""
from __future__ import annotations

import time
from typing import Any, Literal

import numpy as np
import polars as pl
from fastapi import APIRouter
from pydantic import BaseModel
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

from ..algorithms.models.pca import compute_pca
from ..algorithms.models.kda import run_kda
from ..domain.errors import BizError
from ..services.dataset_service import now_iso
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()
_results: dict[str, dict] = {}


class PcaRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    columns: list[str] | None = None
    useCorrelation: bool | None = None
    use_correlation: bool | None = None
    nComponents: int | None = None
    n_components: int | None = None
    rowIds: list[str] | None = None
    row_ids: list[str] | None = None


@router.post("/models/pca")
def run_pca(req: PcaRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    use_corr = req.useCorrelation if req.use_correlation is None else req.use_correlation
    if use_corr is None:
        use_corr = True
    n_comp = req.nComponents if req.n_components is None else req.n_components
    row_ids = req.rowIds if req.rowIds is not None else req.row_ids

    result = compute_pca(
        df=df,
        columns=req.columns,
        use_correlation=use_corr,
        n_components=n_comp,
        row_ids=row_ids,
    )
    return result



class ModelRequest(BaseModel):
    datasetId: str
    modelType: Literal["decision_tree", "random_forest"] = "decision_tree"
    taskType: Literal["auto", "classification", "regression"] = "auto"
    features: list[str]
    target: str
    maxDepth: int | None = 5
    nEstimators: int = 100
    seed: int = 42


def _infer_task(series: pl.Series) -> str:
    if series.dtype == pl.String:
        return "classification"
    values = [v for v in series.to_list() if v is not None]
    if len(values) and all(float(v) == int(v) for v in values):
        unique_ratio = len(set(values)) / len(values)
        if unique_ratio <= 0.05:
            return "classification"
    return "regression"


def _tree_structure(tree: Any, feature_names: list[str], class_labels: list[str] | None,
                    matrix: np.ndarray, y: list[Any]) -> dict[str, Any]:
    """Full tree structure for SVG rendering: split rule, samples, class mix."""
    t = tree.tree_
    leaf_ids = tree.apply(matrix)

    def value_counts(node_id: int) -> list[dict[str, Any]]:
        counts = t.value[node_id][0]
        total = float(counts.sum())
        out: list[dict[str, Any]] = []
        for i, c in enumerate(counts):
            if c <= 0:
                continue
            label = class_labels[i] if class_labels and i < len(class_labels) else str(i)
            out.append({"label": label, "count": int(c), "ratio": round(float(c) / max(total, 1), 3)})
        return sorted(out, key=lambda x: -x["count"])

    def build(node_id: int) -> dict[str, Any]:
        is_leaf = t.children_left[node_id] == -1
        members = np.where(leaf_ids == node_id)[0]
        node: dict[str, Any] = {
            "nodeId": int(node_id),
            "isLeaf": bool(is_leaf),
            "count": int(t.n_node_samples[node_id]),
            "rowIdsCount": int(len(members)),
            "values": value_counts(node_id),
        }
        if not is_leaf:
            feature_index = int(t.feature[node_id])
            node["feature"] = feature_names[feature_index] if feature_index < len(feature_names) else str(feature_index)
            node["threshold"] = round(float(t.threshold[node_id]), 4)
            node["children"] = [
                build(int(t.children_left[node_id])),
                build(int(t.children_right[node_id])),
            ]
        else:
            # Majority class for the leaf badge.
            values = node["values"]
            node["majority"] = values[0]["label"] if values else None
            node["rowIds"] = [str(i) for i in members.tolist()] if False else None
        return node

    return build(0)


def _tree_membership(tree: Any, matrix: np.ndarray) -> list[dict[str, Any]]:
    """Return node records with row membership from leaf application."""
    leaf_ids = tree.apply(matrix)
    nodes = []
    tree_structure = tree.tree_
    for node_id in range(tree_structure.node_count):
        member_rows = np.where(leaf_ids == node_id)[0]
        is_leaf = tree_structure.children_left[node_id] == -1
        nodes.append({
            "nodeId": int(node_id),
            "isLeaf": bool(is_leaf),
            "rowIndexes": member_rows.tolist(),
            "count": int(len(member_rows)),
            "feature": int(tree_structure.feature[node_id]) if not is_leaf else None,
        })
    return nodes


@router.post("/models")
def create_model(req: ModelRequest) -> dict:
    meta = store.get_meta(req.datasetId)
    df = store.get_dataframe(req.datasetId)
    missing = [c for c in req.features + [req.target] if c not in df.columns]
    if missing:
        raise BizError("COLUMN_NOT_FOUND", f"列が見つかりません: {', '.join(missing)}",
                       details={"columnIds": missing})
    feature_df = df.select(req.features)
    for c in req.features:
        if feature_df[c].dtype == pl.String:
            raise BizError("MODEL_NON_NUMERIC_FEATURE", f"説明変数は数値列のみ対応です: {c}",
                           details={"columnIds": [c]})
    X = np.array([df[c].cast(pl.Float64).to_list() for c in req.features]).T
    y_series = df[req.target]
    task = req.taskType
    if task == "auto":
        task = _infer_task(y_series)
    if (X == np.nan).any():
        mask = ~np.isnan(X).any(axis=1)
        X = X[mask]
        y_full = y_series.to_list()
        y = [v for v, keep in zip(y_full, mask) if keep]
        row_ids_all = df["__rowId__"].to_list()
        row_ids = [r for r, keep in zip(row_ids_all, mask) if keep]
    else:
        y = y_series.to_list()
        row_ids = df["__rowId__"].to_list()
    started = time.perf_counter()
    if req.modelType == "decision_tree":
        model = (DecisionTreeClassifier(max_depth=req.maxDepth, random_state=req.seed)
                 if task == "classification" else
                 DecisionTreeRegressor(max_depth=req.maxDepth, random_state=req.seed))
    else:
        model = (RandomForestClassifier(n_estimators=req.nEstimators, max_depth=req.maxDepth,
                                        random_state=req.seed)
                 if task == "classification" else
                 RandomForestRegressor(n_estimators=req.nEstimators, max_depth=req.maxDepth,
                                       random_state=req.seed))
    try:
        model.fit(X, y)
    except Exception as exc:
        raise BizError("MODEL_FIT_FAILED", f"モデル学習に失敗しました: {exc}") from exc
    runtime_ms = (time.perf_counter() - started) * 1000
    trees = model.estimators_ if req.modelType == "random_forest" else [model]
    # Class labels for value display (needed before representative-tree scoring).
    class_labels: list[str] | None = None
    if task == "classification" and hasattr(model, "classes_"):
        class_labels = [str(c) for c in model.classes_]

    # Representative tree: the tree whose predictions agree most with the whole
    # forest (agreement rate on training data). Shown as THE forest view.
    representative_index: int | None = None
    forest_agreement: float | None = None
    tree_agreements: list[float] | None = None
    if req.modelType == "random_forest":
        if task == "classification":
            forest_pred = [str(v) for v in model.predict(X)]

            def _decode_tree_preds(raw_preds: Any) -> list[str]:
                decoded = []
                for val in raw_preds:
                    try:
                        idx = int(round(float(val)))
                        if class_labels and 0 <= idx < len(class_labels):
                            decoded.append(class_labels[idx])
                        else:
                            decoded.append(str(val))
                    except (ValueError, TypeError):
                        decoded.append(str(val))
                return decoded

            agreements = []
            for tree in trees:
                tree_pred = _decode_tree_preds(tree.predict(X))
                agreements.append(float(np.mean([a == b for a, b in zip(tree_pred, forest_pred)])))
        else:
            def _norm_reg(values: list[Any]) -> list[str]:
                return [str(round(float(v), 4)) for v in values]

            forest_pred = _norm_reg(list(model.predict(X)))
            agreements = []
            for tree in trees:
                tree_pred = _norm_reg(list(tree.predict(X)))
                agreements.append(float(np.mean([a == b for a, b in zip(tree_pred, forest_pred)])))
        tree_agreements = [round(a, 4) for a in agreements]
        representative_index = int(np.argmax(agreements))
        forest_agreement = round(agreements[representative_index], 4)

    # Full structure of the representative tree (forest) / the tree (single).
    structure_source = trees[representative_index] if representative_index is not None else trees[0]
    structures = [_tree_structure(structure_source, req.features, class_labels, X, y)]

    # Compute node membership for the displayed tree (structures[0], index 0)
    # so leaves are clickable and selectable across all views for both single tree and random forest.
    nodes = []
    for node in _tree_membership(structure_source, X):
        node["treeIndex"] = 0
        node["rowIds"] = [row_ids[i] for i in node.pop("rowIndexes")]
        nodes.append(node)

    result_id = f"mdl-{int(time.time() * 1000):x}"
    payload = {
        "resultId": result_id,
        "datasetId": req.datasetId,
        "modelType": req.modelType,
        "taskType": task,
        "evidenceClass": "MODERN-EXTENSION",
        "algorithmVersion": f"sklearn-{type(model).__name__}",
        "features": req.features,
        "target": req.target,
        "trainedRows": len(X),
        "rowIds": row_ids,
        "featureImportance": dict(zip(req.features,
                                      [round(float(v), 6) for v in model.feature_importances_])),
        "treeStructures": structures,
        "representativeTree": {
            "index": representative_index,
            "forestAgreement": forest_agreement,
            "treeAgreements": tree_agreements,
        },
        "classLabels": class_labels,
        "nodes": nodes,
        "leafMembership": [
            {"nodeId": n["nodeId"], "treeIndex": n["treeIndex"], "rowIds": n["rowIds"]}
            for n in nodes if n["isLeaf"]
        ],
        "diagnostics": {
            "runtimeMs": round(runtime_ms, 2),
            "nEstimators": req.nEstimators if req.modelType == "random_forest" else 1,
            "oobScore": float(model.oob_score_) if hasattr(model, "oob_score_") else None,
            "depth": getattr(getattr(model, "tree_", None), "max_depth", None),
        },
        "createdAt": now_iso(),
    }
    _results[result_id] = payload
    summary = {k: v for k, v in payload.items() if k != "nodes"}
    summary["nodeCount"] = len(payload["nodes"])
    summary["leafCount"] = len(payload["leafMembership"])
    return summary


@router.get("/models/{result_id}")
def get_model(result_id: str) -> dict:
    if result_id not in _results:
        raise BizError("MODEL_RESULT_NOT_FOUND", f"モデル結果 {result_id} が見つかりません。", status_code=404)
    return _results[result_id]


@router.get("/models/{result_id}/leaves")
def get_leaves(result_id: str) -> dict:
    result = get_model(result_id)
    return {"leaves": result["leafMembership"], "evidenceClass": result["evidenceClass"]}


class KdaRequest(BaseModel):
    datasetId: str | None = None
    dataset_id: str | None = None
    outcome: str
    drivers: list[str] | None = None
    method: str = "shapley_lmg"


@router.post("/models/kda")
def calculate_kda(req: KdaRequest) -> dict[str, Any]:
    dataset_id = req.datasetId or req.dataset_id
    if not dataset_id:
        raise BizError("DATASET_ID_REQUIRED", "datasetId は必須です。")

    df = store.get_dataframe(dataset_id)
    meta = store.get_meta(dataset_id)
    schema = meta.get("schema", [])

    try:
        result = run_kda(
            df=df,
            outcome=req.outcome,
            drivers=req.drivers,
            column_meta=schema,
            method=req.method,
        )
        return result
    except ValueError as e:
        raise BizError("KDA_EXECUTION_ERROR", str(e), status_code=400)

