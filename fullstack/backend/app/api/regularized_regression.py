"""Regularized regression: separate inference-free model and frozen Predict."""
from __future__ import annotations

import copy
import csv
import io
import json
import math
import platform
import uuid
from collections import Counter
from contextlib import nullcontext
from datetime import datetime, timezone
from typing import Any

import numpy as np
import polars as pl
import sklearn
from fastapi import APIRouter, Body
from pydantic import ValidationError

from ..domain.analysis_frame import _regression_weight_block, prepare_regression_frame
from ..domain.codebook_adapter import normalize_code
from ..domain.portable_regression import normalize_numeric_input
from ..domain.context import AnalysisContext, check_revisions, collect_revisions, resolve_scope, scope_hash
from ..domain.errors import BizError
from ..domain.regularized_contracts import ExportPredictRequest, RegularizedRegressionRequest
from ..services.analysis_service import build_meta, check_json_finite, escape_formula_prefix, new_result_id
from ..storage import analysis_result_store as result_store
from ..storage.dataset_store import DatasetStore

router = APIRouter()
store = DatasetStore()
ALGORITHM_VERSION = "davis.regularized_regression.1.0.0"


def _err(code, message, status=422, details=None):
    raise BizError(code, message, status_code=status, details=details or {})


def _context_scope(context, ids):
    ctx = {k: context.get(k) for k in (
        "datasetId", "expectedDataRevision", "expectedSchemaRevision", "scope", "rowIds",
        "activeRowIds", "selectedRowIds", "sampledRowIds")}
    return resolve_scope(ids, AnalysisContext(**ctx))


def _portable_raw_valid(value, kind):
    """Reject ambiguous coercions before the shared OLS frame can erase types."""
    if value is None:
        return True  # Shared missing policy determines whether it is usable.
    if isinstance(value, bool):
        return False
    if isinstance(value, str):
        if kind != "numeric":
            return True
        _, reason = normalize_numeric_input(value, [])
        return reason in (None, "missing_value")
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        return False
    return kind == "numeric" or (float(value).is_integer() and abs(value) <= 9007199254740991)


class _SnapshotStore:
    """Immutable in-memory read facade; fitting cannot see changing codebooks."""
    def __init__(self, meta, codebook, frame, mask, mask_revision):
        self.meta, self.codebook, self.frame = meta, codebook, frame
        self.mask, self.revision = mask, mask_revision

    def lock(self, _):
        return nullcontext()

    def get_meta(self, _):
        return self.meta

    def load_codebook(self, _):
        return self.codebook

    def get_dataframe(self, _, columns=None):
        return self.frame.select(columns) if columns is not None else self.frame

    def load_mask(self, _):
        return self.mask

    def mask_revision(self, _):
        return self.revision


def _prepare(req):
    ctx = req.context.model_dump()
    did = ctx["datasetId"]
    with store.lock(did):
        meta = copy.deepcopy(store.get_meta(did))
        codebook = copy.deepcopy(store.load_codebook(did) or {})
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, ctx["expectedSchemaRevision"], ctx["expectedDataRevision"])
        _, _, weight_type = _regression_weight_block(codebook, ctx)
        if weight_type == "survey":
            _err("RR_SURVEY_UNSUPPORTED", "正則化回帰は調査ウェイトに未対応です。頻度ウェイト、または明示的な非加重を選んでください。")
        design = codebook.get("surveyDesign") or {}
        if req.selection == "cv" and any(design.get(k) for k in (
                "psuColumnId", "strataColumnId", "replicateWeightColumnIds")):
            _err("RR_CV_SPLIT_UNSUPPORTED", "調査のPSU・層を含むデータではランダムCVを利用できません。分割設計への対応が必要です。")
        # Explicit none/frequency does not inherit unrelated survey filtering.
        codebook["surveyDesign"] = {}
        data = store.get_dataframe(did)
        specs = {str(c.get("columnId")): c for c in codebook.get("columns", [])}
        if req.target not in specs:
            _err("RR_INPUT_COLUMN_MISSING", "目的変数が見つかりません。")
        target_spec = copy.deepcopy(specs[req.target])
        invalid_ids = set()
        checks = [(target_spec, "numeric")]
        for pred in req.predictors:
            if pred.columnId not in specs:
                _err("RR_INPUT_COLUMN_MISSING", "説明変数が見つかりません。")
            spec = specs[pred.columnId]
            kind = "numeric" if pred.kind == "numeric" and spec.get("scaleType") != "ordinal" else "categorical"
            checks.append((spec, kind))
        ids = data["__rowId__"].to_list()
        for spec, kind in checks:
            name = spec["name"]
            missing_codes = {normalize_code(v) for v in spec.get("missingCodes", [])}
            if kind == "numeric":
                normalized = []
                for rid, raw in zip(ids, data[name].to_list()):
                    value, reason = normalize_numeric_input(raw, [c for c in missing_codes if c is not None])
                    if reason not in (None, "missing_value"):
                        invalid_ids.add(str(rid))
                    normalized.append(value if reason is None else None)
                data = data.with_columns(pl.Series(name, normalized, dtype=pl.Float64))
                continue
            for rid, value in zip(ids, data[name].to_list()):
                if not _portable_raw_valid(value, kind):
                    invalid_ids.add(str(rid))
        if invalid_ids:
            # Shared frame's ordinary invalid-row path preserves scope/exclusion
            # counts. Change only the in-memory target snapshot, never the data.
            target_name = target_spec["name"]
            raw_y = data[target_name].to_list()
            data = data.with_columns(pl.Series(target_name, [
                "invalid regularized input" if str(rid) in invalid_ids else
                normalize_code(value) for rid, value in zip(ids, raw_y)
            ], dtype=pl.String))
        snapshot = _SnapshotStore(meta, codebook, data, copy.deepcopy(store.load_mask(did) or {}),
                                  store.mask_revision(did))
    frame = prepare_regression_frame(dataset_id=did, context_dict=ctx,
        target_ref=req.target, predictor_specs=[p.model_dump() for p in req.predictors],
        interactions=[], store=snapshot)
    if frame.fit_count < 1:
        _err("RR_NO_USABLE_ROWS", "欠損・無効値・ゼロウェイトを除くと学習行がありません。",
             details={"exclusionCounts": frame.exclusion_counts})
    return frame, target_spec


@router.post("/models/regularized-regression")
def fit_regularized_regression(payload: dict = Body(...)):
    from ..algorithms.models.regularized_regression import fit_regularized
    from ..domain.portable_regression import seal_model

    try:
        req = RegularizedRegressionRequest.model_validate(payload)
    except ValidationError as exc:
        if payload.get("lambdaValue") == 0:
            _err("RR_LAMBDA_POSITIVE_REQUIRED", "λ=0 は通常の重回帰を選んでください。正則化では正のλを指定します。")
        _err("ANALYSIS_REQUEST_INVALID", "正則化回帰の設定が不正です。未対応の交互作用・推論設定は指定できません。",
             details={"fields": [list(e["loc"]) for e in exc.errors()]})
    ctx = req.context.model_dump()
    frame, target_spec = _prepare(req)
    config = req.model_dump(exclude={"context"})
    result = fit_regularized(frame, [p.model_dump() for p in req.predictors],
                             {**config, "missingPolicy": ctx["missingPolicy"]}, target_spec)
    rid = new_result_id()
    model = result["model"]
    model["identity"] = {"modelId": rid, "modelVersion": "1", "algorithmVersion": ALGORITHM_VERSION,
        "exporterVersion": "1", "runtimeVersion": "1", "createdAt": datetime.now(timezone.utc).isoformat()}
    model["provenance"] = {"revisions": {**frame.revisions, "maskRevision": frame.mask_revision},
        "scopeFingerprint": scope_hash(frame.scope_ids), "fitCount": frame.fit_count,
        "libraryVersions": {"python": platform.python_version(), "numpy": np.__version__, "sklearn": sklearn.__version__}}
    model = seal_model(model)
    weights = np.asarray(frame.weights if frame.weights is not None else np.ones(frame.fit_count), dtype=float)
    # Metadata is descriptive; no unbounded squared weight accumulation.
    wscaled = weights / float(np.max(weights))
    kish = float(wscaled.sum() ** 2 / np.square(wscaled).sum())
    sum_w = float(weights.sum())
    if not math.isfinite(sum_w):
        _err("RR_NUMERIC_RANGE", "ウェイト合計が数値表現範囲を超えています。")
    warnings = list(result.get("warnings") or [])
    meta = build_meta(dataset_id=ctx["datasetId"], revisions=frame.revisions,
        snapshot_fingerprint=frame.data_fingerprint, scope=ctx["scope"], scope_ids=frame.scope_ids,
        fit_count=frame.fit_count, exclusion_counts=frame.exclusion_counts, analysis_unit="respondent_row",
        weight_applied=frame.weight_applied, weight_type=frame.weight_type, weight_column=frame.weight_column,
        sum_weights=sum_w, kish_effective_n=kish, frequency_n=sum_w if frame.weight_type == "frequency" else None,
        mask_revision=frame.mask_revision, imputed_cell_count=frame.imputed_cell_count,
        imputed_row_count=frame.imputed_row_count, fingerprint=model["identity"]["contentHash"],
        algorithm_version=ALGORITHM_VERSION, warnings=warnings)
    caps = {"rows": True, "projection": True, "materialize": False, "selectionKinds": [],
        "exportTables": ["manifest", "coefficients", "rows"], "predictionIntervals": ["none"], "exportPredict": True}
    manifest = {"schemaVersion": "analysis-result/1.0", "resultId": rid, "method": "regularized_regression",
        "ownerDatasetId": ctx["datasetId"], "config": config, "meta": meta, "capabilities": caps,
        "summary": result["summary"], "details": result["details"], "portableModel": model,
        "targetSpec": target_spec, "unavailableReasons": {"inference": {"code": "RR_POINT_PREDICTION_ONLY",
            "message": "正則化回帰は点予測のみです。通常OLSのp値・区間推定・診断量は適用しません。", "relatedFields": []}}}
    rows = pl.DataFrame({"rowId": frame.row_ids, "observed": frame.target_values,
                         "fitted": np.asarray(result["fitted"]).tolist(), "residual": np.asarray(result["residual"]).tolist()})
    arrays = {"coefficients": np.asarray(model["linearModel"]["coefficients"], dtype=float),
              "fitted": np.asarray(result["fitted"], dtype=float), "residual": np.asarray(result["residual"], dtype=float)}
    check_json_finite(manifest)
    with store.lock(ctx["datasetId"]):
        now = collect_revisions(store.get_meta(ctx["datasetId"]), store.load_codebook(ctx["datasetId"]) or {})
        check_revisions(now, frame.revisions["schemaRevision"], frame.revisions["dataRevision"])
        if store.mask_revision(ctx["datasetId"]) != frame.mask_revision:
            _err("ANALYSIS_INPUT_STALE", "計算中に補完情報が更新されました。再実行してください。", 409)
        result_store.save_result(rid, manifest, arrays, rows=rows)
    return {k: manifest[k] for k in ("resultId", "method", "meta", "config", "capabilities", "summary", "details", "portableModel", "unavailableReasons")} | {"status": "success"}


def rr_rows(result_id, manifest, meta, offset=0, limit=5000, axes=None):
    if axes is not None or offset < 0 or not 1 <= limit <= 10000:
        _err("ANALYSIS_REQUEST_INVALID", "回帰の行ページ指定が不正です。")
    rows = result_store.load_rows(result_id)
    if rows is None:
        _err("ANALYSIS_RESULT_NOT_FOUND", "学習行がありません。", 404)
    total = rows.height
    part = rows.slice(offset, limit)
    return {"status": "success", "resultId": result_id, "offset": offset, "limit": limit,
        "total": total, "nextOffset": offset + part.height if offset + part.height < total else None,
        "rows": part.to_dicts(), "meta": meta}


def _evaluation(rows, fit_ids, weights=None):
    selected = [r for r in rows if r["predicted"] is not None and r["observed"] is not None
                and (weights is None or weights.get(r["rowId"], 0) > 0)]
    metrics = {"rmse": None, "mae": None, "rSquared": None}
    if selected:
        y = np.asarray([r["observed"] for r in selected], dtype=np.longdouble)
        p = np.asarray([r["predicted"] for r in selected], dtype=np.longdouble)
        w = np.asarray([weights[r["rowId"]] if weights else 1 for r in selected], dtype=np.longdouble)
        w /= w.max(); w /= w.sum()
        # Subtract first: scaling two 1e16 values before subtracting loses
        # representable residuals of size 2. Center the target around an anchor
        # before averaging as well, rather than rounding its large mean.
        with np.errstate(over="ignore", invalid="ignore", divide="ignore", under="ignore"):
            err = y - p
            centered = y - y[0]
            centered -= np.dot(w, centered)

            def rms(values):
                scale = np.max(np.abs(values))
                return scale * np.sqrt(np.dot(w, (values / scale) ** 2)) if scale > 0 else np.longdouble(0)

            rmse = rms(err)
            target_sd = rms(centered)
            error_scale = np.max(np.abs(err))
            mae = error_scale * np.dot(w, np.abs(err / error_scale)) if error_scale > 0 else np.longdouble(0)
            raw_metrics = {"rmse": rmse, "mae": mae,
                           "rSquared": 1 - (rmse / target_sd) ** 2 if target_sd > 0 else None}
            metrics = {k: float(v) if v is not None and np.isfinite(v) and abs(v) <= np.finfo(float).max else None
                       for k, v in raw_metrics.items()}
    overlap = sum(r["rowId"] in fit_ids for r in selected)
    return {"evaluatedCount": len(selected), "fitOverlapCount": overlap,
        "nonFitEvaluationCount": len(selected) - overlap, "metrics": metrics,
        "interpretation": "descriptive; overlapping fit rows are not independent test data"}


def rr_predict(result_id, manifest, req):
    from ..domain.portable_regression import predict_batch
    from ..domain.survey_weight import check_weights_valid, extract_weights, validate_weight_semantics

    ctx = req.context.model_dump()
    if ctx["datasetId"] != manifest["ownerDatasetId"]:
        _err("ANALYSIS_DATASET_MISMATCH", "結果の所有データセットと一致しません。")
    if req.options.interval != "none":
        _err("RR_INTERVAL_UNSUPPORTED", "正則化回帰では区間推定に未対応です。点予測を選んでください。")
    did = ctx["datasetId"]
    with store.lock(did):
        codebook = store.load_codebook(did) or {}
        revisions = collect_revisions(store.get_meta(did), codebook)
        check_revisions(revisions, ctx["expectedSchemaRevision"], ctx["expectedDataRevision"])
        if any(revisions[k] != manifest["meta"][k] for k in ("dataRevision", "schemaRevision")):
            _err("ANALYSIS_INPUT_STALE", "結果の学習後にデータが更新されました。再学習するか、保存モデルを出力して利用してください。", 409)
        data = store.get_dataframe(did)
        ids = _context_scope(ctx, [str(v) for v in data["__rowId__"].to_list()])
        selected = set(ids)
        raw_rows = [r for r in data.to_dicts() if str(r["__rowId__"]) in selected]
        weight_map = None
        if req.options.evaluate:
            weight_spec, weight_name, weight_type = _regression_weight_block(codebook, ctx)
            if weight_type == "survey":
                _err("RR_SURVEY_UNSUPPORTED", "正則化回帰の調査ウェイト評価には未対応です。")
            if weight_spec:
                values, _, invalid = extract_weights(data, weight_name, weight_spec)
                check_weights_valid(values, invalid); validate_weight_semantics(values, weight_type)
                weight_map = {str(rid): w or 0 for rid, w in zip(data["__rowId__"].to_list(), values)}
    model = manifest["portableModel"]
    # Frozen names and conversion rules, never new codebook labels/levels.
    records = [{inp["key"]: row[inp["name"]] for inp in model["inputs"] if inp["name"] in row}
               for row in raw_rows]
    try:
        predictions = predict_batch(model, records)
    except ValueError:
        _err("RR_MODEL_INVALID", "保存モデルの形式・版・整合性を確認できません。再学習してください。")
    target = manifest["targetSpec"]
    rows = []
    for raw, pred in zip(raw_rows, predictions):
        observed, reason = normalize_numeric_input(raw.get(target["name"]), [
            code for code in (normalize_code(c) for c in target.get("missingCodes", [])) if code is not None
        ]) if req.options.evaluate else (None, "missing_value")
        observed = observed if reason is None else None
        predicted = pred["prediction"]
        residual = observed - predicted if observed is not None and predicted is not None else None
        if residual is not None and not math.isfinite(residual):
            residual = None
        rows.append({"rowId": str(raw["__rowId__"]), "predicted": predicted, "observed": observed,
            "residual": residual, "predictionStatus": pred["status"], "warnings": pred["warnings"]})
    fit_rows = result_store.load_rows(result_id)
    fit_ids = set(fit_rows["rowId"].to_list()) if fit_rows is not None else set()
    evaluation = _evaluation(rows, fit_ids, weight_map) if req.options.evaluate else None
    pid = "pred-" + uuid.uuid4().hex[:12]
    # JSON warning strings keep empty/all-error prediction batches schema-stable.
    schema = {"rowId": pl.String, "predicted": pl.Float64, "observed": pl.Float64, "residual": pl.Float64,
              "predictionStatus": pl.String, "warnings": pl.String}
    stored = [{**r, "warnings": json.dumps(r["warnings"], ensure_ascii=False, allow_nan=False)} for r in rows]
    pdf = pl.DataFrame(stored, schema=schema)
    with store.lock(did):
        now = collect_revisions(store.get_meta(did), store.load_codebook(did) or {})
        check_revisions(now, revisions["schemaRevision"], revisions["dataRevision"])
        result_store.save_prediction_rows(result_id, pid, pdf)
    counts = dict(Counter(r["predictionStatus"] for r in rows))
    return {"status": "success", "resultId": result_id, "predictionId": pid,
        "summary": {"requestedCount": len(rows), "successfulPredictions": counts.get("ok", 0),
            "failedPredictions": len(rows) - counts.get("ok", 0), "statusCounts": counts, "evaluation": evaluation}}


def rr_prediction_rows(result_id, manifest, meta, prediction_id, offset=0, limit=5000):
    if offset < 0 or not 1 <= limit <= 10000:
        _err("ANALYSIS_REQUEST_INVALID", "予測の行ページ指定が不正です。")
    rows = result_store.load_prediction_rows(result_id, prediction_id)
    if rows is None:
        _err("ANALYSIS_RESULT_NOT_FOUND", "予測結果がありません。", 404)
    part = rows.slice(offset, limit)
    return {"status": "success", "resultId": result_id, "predictionId": prediction_id,
        "offset": offset, "limit": limit, "total": rows.height,
        "nextOffset": offset + part.height if offset + part.height < rows.height else None,
        "rows": [{**r, "warnings": json.loads(r["warnings"])} for r in part.to_dicts()], "meta": meta}


@router.post("/analysis-results/{result_id}/export-predict")
def export_predict(result_id: str, payload: dict = Body(...)):
    from ..services.regularized_export import export_artifacts

    try:
        req = ExportPredictRequest.model_validate(payload)
    except ValidationError:
        _err("ANALYSIS_REQUEST_INVALID", "Predict出力の設定が不正です。")
    manifest = result_store.load_manifest(result_id)
    if manifest.get("method") != "regularized_regression":
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "この結果は可搬Predictモデルではありません。")
    model = manifest["portableModel"]
    if model["identity"]["modelVersion"] != req.expectedModelVersion:
        _err("RR_MODEL_VERSION_MISMATCH", "指定されたモデル版が一致しません。", 409)
    try:
        result = export_artifacts(model, req.language, req.artifact, req.columnMapping)
    except ValueError as exc:
        _err("RR_EXPORT_INVALID", str(exc))
    # Export is immutable and remains usable after dataset/codebook changes.
    return result


def rr_export_table(manifest, meta, result_id, req):
    if req.table == "manifest":
        body = {k: manifest[k] for k in ("method", "config", "capabilities", "summary", "details")}
        body["meta"] = meta
        return {"fileName": f"{result_id}-manifest.json", "mime": "application/json", "payload": json.dumps(body, ensure_ascii=False, indent=2, allow_nan=False)}
    if req.table == "coefficients":
        source = manifest["portableModel"]["display"]["coefficients"]
        columns = ["designColumnId", "columnId", "label", "kind", "estimate", "estimateReason", "standardizedEstimate", "standardizedReason", "exactZero", "unit"]
    elif req.table == "rows":
        frame = result_store.load_rows(result_id)
        source = frame.to_dicts() if frame is not None else []
        columns = ["rowId", "observed", "fitted", "residual"]
    else:
        _err("ANALYSIS_OPERATION_UNSUPPORTED", "この表は正則化回帰の出力対象ではありません。")
    page = source[req.offset:req.offset + req.limit]
    values = [[row.get(k) for k in columns] for row in page]
    if req.format == "json":
        payload = json.dumps({"columns": columns, "rows": values}, ensure_ascii=False, allow_nan=False)
    else:
        stream = io.StringIO(); writer = csv.writer(stream)
        writer.writerow(columns)
        writer.writerows([[escape_formula_prefix(v) if isinstance(v, str) else v for v in row] for row in values])
        payload = stream.getvalue()
    return {"fileName": f"{result_id}-{req.table}.{req.format}", "mime": "application/json" if req.format == "json" else "text/csv",
        "payload": payload, "total": len(source), "offset": req.offset,
        "nextOffset": req.offset + len(page) if req.offset + len(page) < len(source) else None}
