"""Frozen input snapshot, unlocked fit, revision recheck, atomic publication."""
from __future__ import annotations

import copy
import hashlib
import sys

import numpy as np
import polars as pl
import sklearn

from ..domain.context import check_revisions, collect_revisions
from ..domain.errors import BizError
from ..domain.sparse_pca_contracts import SparsePcaRequest
from ..domain.sparse_pca_frame import prepare_sparse_pca_frame
from ..storage import analysis_result_store as result_store
from ..storage.dataset_store import DatasetStore
from .analysis_service import build_meta, check_json_finite, model_fingerprint, new_result_id

store = DatasetStore()
ALGORITHM_VERSION = "davis.sparse_pca.1.0.0"

CAPABILITIES = {"rows": True, "projection": False, "materialize": False,
    "selectionKinds": ["row_ids", "rectangle"],
    "exportTables": ["manifest", "coefficients", "variables", "diagnostics", "rows"],
    "predictionIntervals": [], "exportPredict": False}

MEANINGS = {
    "components": "B (k×p): sparse reconstruction coefficients, returned component order; not orthogonal loadings or correlations",
    "scoreCoefficients": "W (p×k): ridge least-squares coefficients; T=(Z-estimatorMean)W; B=0 does not imply W=0",
    "variableScoreCorrelations": "Direct Pearson correlations of frozen analysis values and fitted scores on the same complete-case rows",
    "scoreCorrelations": "Direct Pearson correlations between fitted scores; null with reason for constant scores, including diagonal",
    "reconstructionFraction": "1-||Zc-TB||_F²/||Zc||_F² using actual ridge scores; descriptive fit reconstruction, not additive explained variance",
    "objectiveHistory": "sklearn dictionary-learning objective before returned B normalization; not a loss recomputed from B and ridge scores",
    "scoreVariances": "Descriptive sample score variances (ddof=1), not eigenvalues",
    "alpha": "Unmodified sklearn SparsePCA L1 coefficient; depends on units, preprocessing, and sample size; not divided by n or p",
    "ridgeAlpha": "Ridge stabilization of score transformation; separate from the sparsity coefficient alpha",
    "preprocessing": "Canonical centered normalized value: (A-inputAnchor)/inputMagnitude-normalizedMeanOffset; use A/inputMagnitude-inputAnchor/inputMagnitude only when raw subtraction overflows. Correlation divides by normalizedSampleSd; covariance multiplies by inputMagnitude. normalizedMean and rawMean are descriptive and must not replace anchored centering; raw statistics may be null with a range reason",
    "componentOrder": "Estimator return order, not decreasing variance order; components are fitted jointly for the requested count",
    "zeroFraction": "Exact zero entries in B divided by k*p; display rounding and W zeros are not counted"}


def prepare_snapshot(req: SparsePcaRequest, dataset_store=None):
    target = dataset_store or store
    did = req.context.datasetId
    with target.lock(did):
        meta = copy.deepcopy(target.get_meta(did))
        codebook = copy.deepcopy(target.load_codebook(did) or {})
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, req.context.expectedSchemaRevision, req.context.expectedDataRevision)
        data = target.get_dataframe(did).clone()
        mask = copy.deepcopy(target.load_mask(did) or {})
        mask_revision = target.mask_revision(did)
    return prepare_sparse_pca_frame(req, meta=meta, codebook=codebook, data=data,
                                   mask=mask, mask_revision=mask_revision)


def fit_and_save(req: SparsePcaRequest):
    from ..algorithms.models import sparse_pca as kernel

    frame = prepare_snapshot(req)
    result = kernel.fit_sparse_pca(frame, req)
    config = {**req.model_dump(exclude={"context"}), "solver": "lars"}
    summary, details = result.summary.model_dump(), result.details.model_dump()
    snapshot_fingerprint = model_fingerprint({"datasetFingerprint": frame.data_fingerprint,
        "scopeIds": frame.scope_ids, "fitRowIds": frame.row_ids,
        "revisions": frame.revisions, "maskRevision": frame.mask_revision,
        "analysisValuesSha256": hashlib.sha256(frame.values.tobytes(order="C")).hexdigest(),
        "variables": details["variables"], "excludedConstantColumns": details["excludedConstantColumns"],
        "imputedCellCount": frame.imputed_cell_count, "imputedRowCount": frame.imputed_row_count})
    fingerprint = model_fingerprint({"config": config, "snapshotFingerprint": snapshot_fingerprint,
                                     "summary": summary, "details": details, "algorithmVersion": ALGORITHM_VERSION})
    engine = "pyodide" if sys.platform == "emscripten" else "local"
    meta = build_meta(dataset_id=req.context.datasetId, revisions=frame.revisions,
        snapshot_fingerprint=snapshot_fingerprint, scope=req.context.scope, scope_ids=frame.scope_ids,
        fit_count=frame.fit_count, exclusion_counts=frame.exclusion_counts, analysis_unit="respondent_row",
        weight_applied=False, weight_type=None, weight_column=None, sum_weights=None,
        kish_effective_n=None, frequency_n=None, mask_revision=frame.mask_revision,
        imputed_cell_count=frame.imputed_cell_count, imputed_row_count=frame.imputed_row_count,
        fingerprint=fingerprint, algorithm_version=ALGORITHM_VERSION, engine=engine, warnings=result.warnings)
    pyodide_version = None
    if engine == "pyodide":
        import pyodide
        pyodide_version = pyodide.__version__
    meta["numericalRuntime"].update({"sklearn": sklearn.__version__, "pyodide": pyodide_version})
    rid = new_result_id()
    unavailable = {field: {"code": "SPCA_NONORTHOGONAL_COMPONENTS", "message":
        "SparsePCAの非直交成分には通常PCAの固有値・加法的な寄与率・Kaiser基準を適用できません。",
        "relatedFields": [field]} for field in ("eigenvalues", "explainedVarianceRatio", "cumulativeVarianceRatio", "kaiser")}
    manifest = {"schemaVersion": "analysis-result/1.0", "resultId": rid, "method": "sparse_pca",
        "ownerDatasetId": req.context.datasetId, "config": config, "meta": meta,
        "capabilities": copy.deepcopy(CAPABILITIES), "summary": summary, "details": details,
        "unavailableReasons": unavailable, "meanings": MEANINGS}
    rows = pl.DataFrame({"rowId": frame.row_ids, **{name: result.scores[:, j].tolist()
                for j, name in enumerate(details["componentOrder"])}})
    check_json_finite(manifest)
    with store.lock(req.context.datasetId):
        current = collect_revisions(store.get_meta(req.context.datasetId), store.load_codebook(req.context.datasetId) or {})
        check_revisions(current, frame.revisions["schemaRevision"], frame.revisions["dataRevision"])
        if store.mask_revision(req.context.datasetId) != frame.mask_revision:
            raise BizError("ANALYSIS_INPUT_STALE", "計算中に補完情報が更新されました。再実行してください。", status_code=409)
        result_store.save_result(rid, manifest, result.arrays, rows=rows)
    return {"status": "success", **{key: manifest[key] for key in (
        "resultId", "method", "meta", "config", "capabilities", "summary", "details", "unavailableReasons")}}
