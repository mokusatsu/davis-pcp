"""EFA orchestration service (Feature 033).

Design: DAVIS-FEAT-033-DESIGN sections 2, 5, 8. Called by
``api/factor_analysis.py``; pure kernels live in
``algorithms/models/ordinal_correlations.py``,
``factor_analysis_uls.py``, ``factor_analysis_ml.py``,
``factor_rotations.py``, ``factor_parallel.py``,
``factor_sensitivity.py``.

Pipeline per q: scope snapshot -> weight refusal -> measurement
resolution -> categoryOrder/reverse transform -> complete-case fit set
-> correlation (Pearson shared-set / polychoric two-stage shared
thresholds) -> matrix validation -> extraction (ULS profile full /
Pearson ML profile, constrained multi-start) -> rotation
(none/varimax/promax, q==1 forces none) -> diagnostics, inference
(ML-only reference), scores (Pearson suitable only), PA, candidate
comparison, sensitivity comparison.
"""
from __future__ import annotations

from typing import Any

import numpy as np
import polars as pl
from scipy import stats as _stats

from ..algorithms.models.factor_analysis_ml import (
    bartlett_sphericity,
    fit_ml_profile,
    kmo_measure,
    ml_fit_measures,
)
from ..algorithms.models.factor_analysis_uls import OBJECTIVE_ID as ULS_OBJECTIVE_ID
from ..algorithms.models.factor_analysis_uls import fit_uls_profile
from ..algorithms.models.factor_parallel import (
    full_correlation_eigenvalues,
    linear_quantile,
    parallel_analysis,
    suggest_factors,
)
from ..algorithms.models.factor_rotations import factor_scores, rotate_solution
from ..algorithms.models.factor_sensitivity import (
    align_factors,
    assess_comparison,
    comparison_metrics,
    definite_assignments,
    procrustes_residual,
)
from ..algorithms.models.ordinal_correlations import (
    pearson_correlation,
    polychoric_matrix,
    thresholds_from_cumulative,
    validate_correlation_matrix,
)
from ..domain.codebook_adapter import is_not_applicable_reason, normalize_code
from ..domain.context import (
    AnalysisContext,
    check_revisions,
    collect_revisions,
    resolve_scope,
    scope_hash,
)
from ..domain.errors import BizError
from ..domain.survey_weight import declared_weight_column_id
from ..storage.dataset_store import DatasetStore

ALGORITHM_VERSION = "davis.efa.1.0.0"


def _err(code: str, msg: str, status: int = 422, details: dict | None = None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _spec_by_ref(codebook: dict, ref: str) -> dict:
    for spec in (codebook.get("columns", []) or []):
        if not isinstance(spec, dict):
            continue
        if spec.get("columnId") == ref or spec.get("name") == ref:
            return spec
    _err("FA_COLUMN_NOT_FOUND", f"分析対象の列が存在しません: {ref}", 422,
         {"columnIds": [ref]})


def _resolve_requested_columns(codebook: dict, variables: list[dict]) -> dict[str, str]:
    """Map requested columnId -> dataset column name."""
    mapping = {}
    for v in variables:
        cid = str(v["columnId"])
        spec = _spec_by_ref(codebook, cid)
        mapping[cid] = spec["name"]
    return mapping


def prepare_efa_frame(dataset_id: str, req: dict, store: DatasetStore) -> dict[str, Any]:
    """Scope/weight/measurement/fit-set resolution. Raises BizError on stop."""
    from ..domain.weight_mode import resolve_weight_request

    ctx = req["context"]
    variables = req["variables"]
    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, ctx.get("expectedSchemaRevision"),
                        ctx.get("expectedDataRevision"))
        # --- weight: any effective dataset weight is refused ---
        weight_mode, weight_ref = resolve_weight_request(
            codebook, weight_mode=ctx.get("weightMode", "dataset"),
            weight_column=ctx.get("weightColumn"), weight_type=ctx.get("weightType"))
        declared = None
        try:
            declared = declared_weight_column_id(codebook)
        except Exception:
            declared = None
        effective_weight = weight_ref or (declared if weight_mode == "dataset" else None)
        if effective_weight:
            _err("FA_WEIGHT_UNSUPPORTED",
                 "EFAは非加重のみ対応です。weightMode=noneで再実行してください。",
                 422, {"weightColumnId": effective_weight})
        # --- scope ---
        scope = ctx.get("scope", "all")
        df_all = store.get_dataframe(dataset_id, columns=["__rowId__"])
        all_ids = [str(v) for v in df_all["__rowId__"].to_list()]
        legacy = AnalysisContext(
            datasetId=dataset_id,
            expectedDataRevision=ctx.get("expectedDataRevision"),
            expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
            scope=scope,
            rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"),
            selectedRowIds=ctx.get("selectedRowIds"),
            sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = resolve_scope(all_ids, legacy)
        name_by_cid = _resolve_requested_columns(codebook, variables)
        read_cols = ["__rowId__", *dict.fromkeys(name_by_cid.values())]
        df = store.get_dataframe(dataset_id, columns=read_cols)
        # E005: an explicitly empty scope stays empty; never fall back to all.
        df = df.filter(pl.col("__rowId__").is_in(list(scope_ids)))
        scope_count = df.height
        # --- measurement resolution + order/reverse transform ---
        # E013: the request's measurement/treatment is checked against the
        # codebook (scaleType, role, MA group). Nominal/ID/unknown columns,
        # MA parents/children, and non-ordinal-declared ordinal claims are
        # rejected here instead of trusting the request alone.
        specs = {cid: _spec_by_ref(codebook, cid) for cid in name_by_cid}
        resolutions = []
        for v in variables:
            cid = str(v["columnId"])
            spec = specs[cid]
            scale = spec.get("scaleType")
            role = spec.get("role")
            if role not in ("question", "attribute", "other", None):
                _err("FA_SCALE_UNSUPPORTED",
                     f"項目 {cid} のroleでは実行できません。", 422,
                     {"columnIds": [cid]})
            if spec.get("multiResponseGroup") or spec.get("multiResponseOptionLabel"):
                _err("FA_SCALE_UNSUPPORTED",
                     f"項目 {cid} はMA設問のため対象外です。", 422,
                     {"columnIds": [cid]})
            if v["measurement"] == "ordinal":
                # E013 3rd round: codebook nominal/unknown columns need an
                # explicit evidence-backed scaleBasis; a bare categoryOrder
                # no longer promotes a nominal column to ordinal.
                if scale in ("nominal", None):
                    basis = (v.get("scaleBasis") or "").strip()
                    if not basis:
                        _err("FA_SCALE_BASIS_REQUIRED",
                             f"項目 {cid} は名義・水準不明のため根拠付き指定が必要です。",
                             422, {"columnIds": [cid]})
                    if basis not in ("codebook_order_verified",
                                     "pre_registered_instrument",
                                     "analyst_verified_order"):
                        _err("FA_SCALE_UNSUPPORTED",
                             f"項目 {cid} の根拠では順序尺度として扱えません。",
                             422, {"columnIds": [cid]})
                elif scale != "ordinal":
                    _err("FA_SCALE_UNSUPPORTED",
                         f"項目 {cid} は順序尺度として扱えません。", 422,
                         {"columnIds": [cid]})
                req_order = [normalize_code(c) for c in (v.get("categoryOrder") or [])]
                book_order = [normalize_code(c) for c in (spec.get("categoryOrder") or [])]
                book_order = [c for c in book_order if c is not None]
                if book_order and sorted(req_order) != sorted(book_order):
                    _err("FA_CATEGORY_ORDER_REQUIRED",
                         f"項目 {cid} のcategoryOrderがコードブックと一致しません。", 422,
                         {"columnIds": [cid]})
            else:
                # E013 2nd round: a codebook-declared ordinal column must
                # keep measurement=ordinal. Pearson use requires treatment
                # continuous_approximation with per-item acknowledgement;
                # a bare continuous claim bypassing the approximation
                # contract is rejected instead of running as latent_estimate.
                if scale == "ordinal":
                    _err("FA_APPROXIMATION_ACK_REQUIRED",
                         f"項目 {cid} は順序尺度です。Pearson利用には連続近似と項目別同意が必要です。",
                         422, {"columnIds": [cid]})
                # E013 3rd round: nominal/unknown scales are not silently
                # accepted as continuous either; they need scaleBasis too.
                if scale in ("nominal", None):
                    basis = (v.get("scaleBasis") or "").strip()
                    if not basis:
                        _err("FA_SCALE_BASIS_REQUIRED",
                             f"項目 {cid} は名義・水準不明のため根拠付き指定が必要です。",
                             422, {"columnIds": [cid]})
                    _err("FA_SCALE_UNSUPPORTED",
                         f"項目 {cid} は連続変数として扱えません。", 422,
                         {"columnIds": [cid]})
                if scale not in ("interval", "ratio", "numeric"):
                    _err("FA_SCALE_UNSUPPORTED",
                         f"項目 {cid} は連続変数として扱えません。", 422,
                         {"columnIds": [cid]})
            src = "request" if v.get("categoryOrder") is not None or v.get("treatment") else "codebook"
            resolutions.append({
                "columnId": cid, "name": name_by_cid[cid],
                "source": src,
                "originalMeasurement": v["measurement"],
                "effectiveMeasurement": v["treatment"],
                "codebookScale": scale,
                "scaleBasis": v.get("scaleBasis"),
                "originalOrder": list(v.get("categoryOrder") or []),
                "reverse": bool(v.get("reverse", False)),
                "approximation": v["treatment"] == "continuous_approximation",
            })
        # --- per-item code validation & transform ---
        row_ids = [str(v) for v in df["__rowId__"].to_list()]
        n = len(row_ids)
        p = len(variables)
        rank_codes = np.full((n, p), -1, dtype=int)  # ordinal ranks / approx positions
        cont_vals = np.full((n, p), np.nan)  # continuous values
        invalid_mask = np.zeros(n, dtype=bool)
        missing_mask = np.zeros(n, dtype=bool)
        invalid_detail = {str(v["columnId"]): 0 for v in variables}
        missing_detail = {str(v["columnId"]): 0 for v in variables}
        imputed_cells = 0
        distributions = []
        for j, v in enumerate(variables):
            cid = str(v["columnId"])
            name = name_by_cid[cid]
            spec = specs[cid]
            treat = v["treatment"]
            raw = df[name].to_list()
            missing_codes = {c for c in (normalize_code(c) for c in (spec.get("missingCodes") or [])) if c is not None}
            missing_reasons = spec.get("missingReasons") or {}
            na_codes = {c for c in missing_codes
                        if is_not_applicable_reason(missing_reasons.get(c, "")
                                                    if isinstance(missing_reasons, dict) else "")}
            if treat == "continuous":
                # E006: honour the column's missingCodes (codes AND their
                # numeric values) instead of float-convertibility alone.
                missing_numeric: set[float] = set()
                for mc in missing_codes:
                    try:
                        missing_numeric.add(float(mc))
                    except (ValueError, TypeError):
                        pass
                vals = []
                row_missing_flags = []
                row_notapp_flags = []
                row_invalid_flags = []
                for val in raw:
                    code = normalize_code(val)
                    if val is None or code is None or code in missing_codes:
                        # E006 3rd round: continuous missingCodes are split
                        # into 無回答 (missing) vs 非該当 (notApplicable) via
                        # missingReasons, same as the ordinal path.
                        is_na = code in na_codes if code is not None else False
                        vals.append(np.nan)
                        row_missing_flags.append(not is_na)
                        row_notapp_flags.append(is_na)
                        row_invalid_flags.append(False)
                        continue
                    try:
                        f = float(val)
                    except (ValueError, TypeError):
                        vals.append(np.nan)
                        row_missing_flags.append(False)
                        row_notapp_flags.append(False)
                        row_invalid_flags.append(True)
                        continue
                    if f in missing_numeric or not np.isfinite(f):
                        # missing-code numeric value -> missing/NA by reason;
                        # +-inf -> invalid
                        if f in missing_numeric:
                            is_na_num = any(
                                code == mc and mc in na_codes
                                for mc in missing_codes)
                            vals.append(np.nan)
                            row_missing_flags.append(not is_na_num)
                            row_notapp_flags.append(is_na_num)
                            row_invalid_flags.append(False)
                        else:
                            vals.append(np.nan)
                            row_missing_flags.append(False)
                            row_notapp_flags.append(False)
                            row_invalid_flags.append(True)
                        continue
                    vals.append(f)
                    row_missing_flags.append(False)
                    row_notapp_flags.append(False)
                    row_invalid_flags.append(False)
                arr = np.array(vals, dtype=float)
                cont_vals[:, j] = arr
                col_missing = np.array(row_missing_flags, dtype=bool)
                col_notapp = np.array(row_notapp_flags, dtype=bool)
                col_invalid = np.array(row_invalid_flags, dtype=bool)
                missing_detail[cid] = int(np.sum(col_missing | col_notapp))
                invalid_detail[cid] = int(np.sum(col_invalid))
                distributions.append({"columnId": cid, "kind": "continuous",
                                      "n": n, "missing": int(np.sum(col_missing)),
                                      "notApplicable": int(np.sum(col_notapp)),
                                      "invalid": int(np.sum(col_invalid))})
            else:
                order = [str(c) for c in (v.get("categoryOrder") or [])]
                norm_order = [normalize_code(c) for c in order]
                pos = {c: i for i, c in enumerate(norm_order)}
                k = len(norm_order)
                counts = [0] * k
                col_invalid = np.zeros(n, dtype=bool)
                col_missing = np.zeros(n, dtype=bool)
                col_notapp = np.zeros(n, dtype=bool)
                for i, val in enumerate(raw):
                    code = normalize_code(val)
                    if code is None or code in missing_codes:
                        if code in na_codes:
                            col_notapp[i] = True
                        else:
                            col_missing[i] = True
                        rank_codes[i, j] = -1
                        continue
                    if code not in pos:
                        col_invalid[i] = True
                        rank_codes[i, j] = -1
                        continue
                    r = pos[code]
                    if v.get("reverse"):
                        r = k - 1 - r
                    rank_codes[i, j] = r
                    counts[r] += 1
                invalid_detail[cid] = int(np.sum(col_invalid))
                missing_detail[cid] = int(np.sum(col_missing))
                if treat == "continuous_approximation":
                    arr = np.array([float(r + 1) if r >= 0 else np.nan
                                    for r in rank_codes[:, j]])
                    cont_vals[:, j] = arr
                # distribution profile
                tot = sum(counts)
                props = [c / tot if tot else 0.0 for c in counts]
                g1 = _rank_skewness(rank_codes[:, j])
                distributions.append({
                    "columnId": cid, "kind": "ordinal", "k": k,
                    "categoryCounts": counts, "categoryProportions": props,
                    "minCategoryCount": min(counts) if counts else 0,
                    "maxCategoryProportion": max(props) if props else 0.0,
                    "floorProportion": props[0] if props else 0.0,
                    "ceilingProportion": props[-1] if props else 0.0,
                    "rankSkewness": g1,
                    "missing": int(np.sum(col_missing)),
                    "notApplicable": int(np.sum(col_notapp)),
                    "invalid": int(np.sum(col_invalid)),
                    "finalOrder": list(reversed(order)) if v.get("reverse") else list(order),
                    "originalOrder": list(order),
                })
        # --- complete-case fit set: invalid first, then missing ---
        # invalid takes precedence per row: a row already excluded as
        # invalid is not additionally counted as missing, so the two
        # exclusion counts never double-count the same row.
        # Continuous columns reuse the per-value classification above so
        # missingCodes / invalid strings are not collapsed into one class.
        row_invalid = np.zeros(n, dtype=bool)
        row_missing = np.zeros(n, dtype=bool)
        row_notapp = np.zeros(n, dtype=bool)
        for j, v in enumerate(variables):
            cid = str(v["columnId"])
            if v["treatment"] == "continuous":
                name = name_by_cid[cid]
                spec = specs[cid]
                missing_codes = {c for c in (normalize_code(c) for c in (spec.get("missingCodes") or [])) if c is not None}
                missing_reasons = spec.get("missingReasons") or {}
                na_here = {c for c in missing_codes
                           if is_not_applicable_reason(
                               missing_reasons.get(c, "")
                               if isinstance(missing_reasons, dict) else "")}
                missing_numeric: set[float] = set()
                for mc in missing_codes:
                    try:
                        missing_numeric.add(float(mc))
                    except (ValueError, TypeError):
                        pass
                raw = df[name].to_list()
                for i, val in enumerate(raw):
                    if row_invalid[i]:
                        continue
                    code = normalize_code(val)
                    if val is None or code is None or code in missing_codes:
                        if code in na_here:
                            row_notapp[i] = True
                        else:
                            row_missing[i] = True
                        continue
                    try:
                        f = float(val)
                    except (ValueError, TypeError):
                        row_invalid[i] = True
                        row_missing[i] = False
                        row_notapp[i] = False
                        continue
                    if f in missing_numeric:
                        row_missing[i] = True
                    elif not np.isfinite(f):
                        row_invalid[i] = True
                        row_missing[i] = False
                        row_notapp[i] = False
            else:
                # invalid = code not in order and not a missing code.
                # missing vs notApplicable follows missingReasons.
                name = name_by_cid[cid]
                spec = specs[cid]
                missing_codes = {c for c in (normalize_code(c) for c in (spec.get("missingCodes") or [])) if c is not None}
                missing_reasons_o = spec.get("missingReasons") or {}
                na_here_o = {c for c in missing_codes
                             if is_not_applicable_reason(
                                 missing_reasons_o.get(c, "")
                                 if isinstance(missing_reasons_o, dict) else "")}
                order = {normalize_code(c) for c in (v.get("categoryOrder") or [])}
                raw = df[name].to_list()
                for i, val in enumerate(raw):
                    if row_invalid[i]:
                        continue
                    code = normalize_code(val)
                    if code is None or code in missing_codes:
                        if code in na_here_o:
                            row_notapp[i] = True
                        else:
                            row_missing[i] = True
                    elif code not in order:
                        row_invalid[i] = True
                        row_missing[i] = False
                        row_notapp[i] = False
        # Non-applicable rows are excluded from the fit like missing rows,
        # but counted separately (never double-counted with invalid).
        fit_mask = ~(row_invalid | row_missing | row_notapp)
        fit_idx = np.where(fit_mask)[0]
        fit_ids = [row_ids[i] for i in fit_idx.tolist()]
        excluded_ids = [row_ids[i] for i in np.where(~fit_mask)[0].tolist()]
        # --- mask / imputation provenance (E006): same convention as
        # analysis_frame (mask entries scoped to used columns + fit rows) ---
        # specs is keyed by REQUESTED columnId (cid -> spec). name_by_cid
        # maps cid -> dataset column name. Both ids and names are accepted
        # for mask entries; a lookup failure raises instead of silently
        # aggregating zero cells.
        mask_doc = store.load_mask(dataset_id) or {}
        mask_entries = mask_doc.get("entries", []) or []
        use_col_ids: set[str] = set()
        for cid in name_by_cid:
            spec = specs[cid]
            if spec.get("columnId"):
                use_col_ids.add(str(spec["columnId"]))
            use_col_ids.add(str(cid))
            use_col_ids.add(str(name_by_cid[cid]))
        scope_set = set(str(v) for v in scope_ids)
        fit_set = set(str(v) for v in fit_ids)
        seen_cells: set[tuple[str, str]] = set()
        imputed_rows: set[str] = set()
        for entry in mask_entries:
            if not isinstance(entry, dict):
                continue
            rid = str(entry.get("rowId", ""))
            cid = str(entry.get("columnId", ""))
            if cid not in use_col_ids or rid not in scope_set or rid not in fit_set:
                continue
            if (rid, cid) not in seen_cells:
                seen_cells.add((rid, cid))
                imputed_rows.add(rid)
        imputed_cell_count = len(seen_cells)
        imputed_row_count = len(imputed_rows)
        mask_revision = store.mask_revision(dataset_id)
        return {
            "meta": meta, "codebook": codebook, "revisions": revisions,
            "scopeIds": [str(v) for v in scope_ids], "scopeCount": scope_count,
            "rowIds": row_ids, "fitIds": fit_ids, "excludedIds": excluded_ids,
            "fitIndex": fit_idx, "nameByCid": name_by_cid, "specs": specs,
            "resolutions": resolutions, "rankCodes": rank_codes,
            "contVals": cont_vals, "distributions": distributions,
            "invalidDetail": invalid_detail, "missingDetail": missing_detail,
            "invalidCount": int(np.sum(row_invalid)), "missingCount": int(np.sum(row_missing)),
            "notApplicableCount": int(np.sum(row_notapp)),
            "imputedCells": imputed_cell_count, "imputedRows": imputed_row_count,
            "maskRevision": mask_revision,
        }


def _rank_skewness(ranks: np.ndarray) -> float | None:
    vals = np.asarray([float(v) + 1 for v in ranks if int(v) >= 0], dtype=float)
    n = len(vals)
    if n <= 2:
        return None
    mean = vals.mean()
    m2 = float(np.mean((vals - mean) ** 2))
    if m2 <= 0:
        return None
    m3 = float(np.mean((vals - mean) ** 3))
    g1 = m3 / (m2 ** 1.5)
    return float(np.sqrt(n * (n - 1)) / (n - 2) * g1)


def check_identification(n: int, p: int, counts: list[int]) -> None:
    if n <= p:
        _err("FA_UNDERIDENTIFIED", "n<=p のため識別できません。", 422,
             {"n": n, "p": p})
    for q in counts:
        if q < 1 or q >= p or (p - q) ** 2 - p - q < 0:
            _err("FA_UNDERIDENTIFIED", f"因子数 q={q} は識別できません。", 422,
                 {"q": q, "p": p})


def build_fit_matrices(prep: dict, req: dict) -> dict[str, Any]:
    """Encode fit matrices + check constants/unobserved/n conditions."""
    variables = req["variables"]
    p = len(variables)
    fit_idx = prep["fitIndex"]
    n = len(fit_idx)
    cids = [str(v["columnId"]) for v in variables]
    treatments = [str(v["treatment"]) for v in variables]
    use_ordinal_codes = all(t == "ordinal" for t in treatments)
    # per-item observed-category / constant checks (ordinal path)
    n_cats = []
    for j, v in enumerate(variables):
        if v["treatment"] in ("ordinal", "continuous_approximation"):
            order = [normalize_code(c) for c in (v.get("categoryOrder") or [])]
            k = len(order)
            n_cats.append(k)
            ranks = prep["rankCodes"][fit_idx, j]
            obs = sorted(set(int(r) for r in ranks.tolist() if int(r) >= 0))
            if len(obs) < 2:
                _err("FA_CONSTANT_COLUMN" if len(obs) < 2 and k >= 2 else "FA_CATEGORY_ORDER_REQUIRED",
                     f"項目 {v['columnId']} の実観測カテゴリが不足しています。", 422,
                     {"columnIds": [str(v["columnId"])]})
            if len(obs) < k:
                _err("FA_UNOBSERVED_CATEGORY",
                     f"項目 {v['columnId']} に未観測の許容カテゴリがあります。", 422,
                     {"columnIds": [str(v["columnId"])]})
            if k < 2:
                _err("FA_CATEGORY_ORDER_REQUIRED",
                     f"項目 {v['columnId']} には2個以上の一意コードが必要です。", 422,
                     {"columnIds": [str(v["columnId"])]})
    if use_ordinal_codes or any(t == "continuous_approximation" for t in treatments):
        if any(t == "continuous_approximation" for t in treatments):
            x = prep["contVals"][np.ix_(fit_idx, [j for j, t in enumerate(treatments)
                                                  if t == "continuous_approximation"])]
            # mixed continuous + approximation handled at request level;
            # pure-approx side columns only here when all approx
            full = prep["contVals"][fit_idx, :]
            sds = np.nanstd(full, axis=0, ddof=1)
            for j, sd in enumerate(sds.tolist()):
                if not np.isfinite(sd) or sd <= 0:
                    _err("FA_CONSTANT_COLUMN",
                         f"項目 {cids[j]} が定数です。", 422, {"columnIds": [cids[j]]})
            return {"kind": "scores", "x": full, "nCats": n_cats}
        codes = prep["rankCodes"][np.ix_(fit_idx, range(p))]
        return {"kind": "codes", "codes": codes, "nCats": n_cats}
    # continuous path
    x = prep["contVals"][fit_idx, :]
    sds = np.nanstd(x, axis=0, ddof=1)
    for j, sd in enumerate(sds.tolist()):
        if not np.isfinite(sd) or sd <= 0:
            _err("FA_CONSTANT_COLUMN", f"項目 {cids[j]} が定数です。", 422,
                 {"columnIds": [cids[j]]})
    if not np.all(np.isfinite(x)):
        _err("FA_INVALID_VALUE", "非有限値が含まれています。", 422)
    return {"kind": "scores", "x": x, "nCats": n_cats}


def estimate_correlation(fit: dict, req: dict) -> dict[str, Any]:
    """Pearson shared-set or polychoric two-stage shared-threshold estimate."""
    corr = req["correlation"]
    if corr == "pearson":
        if fit["kind"] == "codes":
            # ordinal ranks are never Pearson-scored directly; caller converts.
            _err("FA_CORRELATION_MISMATCH", "Pearson経路に順位コードは使えません。",
                 422)
        try:
            out = pearson_correlation(np.asarray(fit["x"], dtype=float))
        except ValueError as exc:
            msg = str(exc)
            code = msg.split(":")[0] if ":" in msg else "FA_CONSTANT_COLUMN"
            _err(code, "Pearson相関を計算できません。", 422)
        return {"correlation": out["correlation"], "mean": out["mean"],
                "std": out["std"], "thresholds": None, "pairs": None,
                "status": "success", "reasonCode": None}
    # polychoric
    if fit["kind"] != "codes":
        _err("FA_CORRELATION_MISMATCH", "Polychoric経路には順序コードが必要です。",
             422)
    try:
        out = polychoric_matrix(np.asarray(fit["codes"], dtype=int),
                                [int(k) for k in fit["nCats"]])
    except ValueError as exc:
        _err("FA_UNOBSERVED_CATEGORY", str(exc), 422)
    if out["status"] == "failed" or out["correlation"] is None:
        return {"correlation": None, "mean": None, "std": None,
                "thresholds": out.get("thresholds"), "pairs": out.get("pairs"),
                "status": "failed",
                "reasonCode": out.get("reasonCode") or "FA_CORRELATION_NONCONVERGENCE"}
    return {"correlation": out["correlation"], "mean": None, "std": None,
            "thresholds": out.get("thresholds"), "pairs": out.get("pairs"),
            "status": out["status"],
            "reasonCode": out.get("reasonCode")}


def run_extraction(r: np.ndarray, req: dict, q: int) -> dict[str, Any]:
    if req["extraction"] == "minres":
        return fit_uls_profile(np.asarray(r, dtype=float), int(q),
                               lower=float(req.get("uniquenessLower", 0.005)),
                               n_starts=int(req.get("nStarts", 5)),
                               maxiter=int(req.get("maxIterations", 2000)),
                               seed=int(req.get("seed", 42)))
    if req.get("correlation") != "pearson":
        _err("FA_EXTRACTION_UNSUPPORTED", "MLはPearson経路のみ対応です。", 422)
    return fit_ml_profile(np.asarray(r, dtype=float), int(q),
                          lower=float(req.get("uniquenessLower", 0.005)),
                          n_starts=int(req.get("nStarts", 5)),
                          maxiter=int(req.get("maxIterations", 2000)),
                          seed=int(req.get("seed", 42)))


def solution_status(*, loadings: np.ndarray, psi: np.ndarray,
                    u_opt: np.ndarray | None, lower: float,
                    phi: np.ndarray) -> tuple[str, list[dict]]:
    """Admissible / boundary / inadmissible + diagnostics (never silent)."""
    diags: list[dict] = []
    l = np.asarray(loadings, dtype=float)
    psi = np.asarray(psi, dtype=float)
    status = "admissible"
    if u_opt is not None:
        uo = np.asarray(u_opt, dtype=float)
        if np.any(uo <= lower + 1e-9):
            status = "boundary"
            diags.append({"code": "BOUNDARY_DIAGONAL", "severity": "warning",
                          "stage": "extraction"})
    if np.any(psi <= lower + 1e-6):
        if status == "admissible":
            status = "boundary"
        diags.append({"code": "BOUNDARY_UNIQUENESS", "severity": "warning",
                      "stage": "extraction",
                      "note": "chi-square approximation not guaranteed"})
    if np.any(psi < -1e-8):
        status = "inadmissible"
        diags.append({"code": "HEYWOOD_NEGATIVE_UNIQUENESS", "severity": "error",
                      "stage": "extraction"})
    h2 = np.diag(l @ np.asarray(phi) @ l.T) if l.size else np.array([])
    if h2.size and np.any(h2 > 1 + 1e-8):
        status = "inadmissible"
        diags.append({"code": "HEYWOOD_COMMUNALITY_RANGE", "severity": "error",
                      "stage": "extraction"})
    try:
        if np.linalg.matrix_rank(np.asarray(phi)) < np.asarray(phi).shape[0]:
            status = "inadmissible"
            diags.append({"code": "SINGULAR_PHI", "severity": "error",
                          "stage": "rotation"})
    except Exception:
        pass
    return status, diags


def fit_single_q(r: np.ndarray, req: dict, q: int, *,
                 score_z: np.ndarray | None = None,
                 score_mean: np.ndarray | None = None,
                 score_sd: np.ndarray | None = None,
                 fit_n: int | None = None) -> dict[str, Any]:
    """Full single-q pipeline: extraction -> rotation -> measures -> scores.

    fit_n is the complete-case count and is independent of score
    computation (E004): ML reference inference must not vanish when
    scoreMethod=none.
    """
    lower = float(req.get("uniquenessLower", 0.005))
    ext = run_extraction(r, req, q)
    if ext["status"] != "success":
        return {"status": "failed", "reasonCode": ext.get("reasonCode") or "FA_NONCONVERGENCE",
                "starts": ext.get("starts"), "q": int(q)}
    loadings = np.asarray(ext["loadings"])
    psi = np.asarray(ext["psi"])
    u_opt = ext.get("u", None)
    u_opt = np.asarray(u_opt) if u_opt is not None else None
    rot = rotate_solution(loadings, psi, req.get("rotation", "promax"))
    if rot.get("status") != "success":
        return {"status": "failed",
                "reasonCode": rot.get("reasonCode") or "FA_ROTATION_NONCONVERGENCE",
                "starts": ext.get("starts"), "q": int(q)}
    pattern = np.asarray(rot["loadings"])
    phi = np.asarray(rot["phi"])
    struct = pattern @ phi
    h2 = np.asarray(np.diag(pattern @ phi @ pattern.T)).ravel()
    rep = pattern @ phi @ pattern.T + np.diag(psi)
    resid = r - rep
    p = r.shape[0]
    iu = np.triu_indices(p, k=1)
    rmsr = float(np.sqrt(np.mean(resid[iu] ** 2))) if len(iu[0]) else 0.0
    total_ratio = float(np.sum(h2) / p) if p else 0.0
    sstat, sdiags = solution_status(loadings=pattern, psi=psi, u_opt=u_opt,
                                    lower=lower, phi=phi)
    out: dict[str, Any] = {
        "status": "success", "q": int(q), "pattern": pattern, "structure": struct,
        "phi": phi, "rotationTransform": np.asarray(rot.get("rotationMatrix")),
        "communality": h2, "uniqueness": psi, "optimizerDiagonal": u_opt,
        "reproduced": rep, "residual": resid, "rmsr": rmsr,
        "totalCommunalityRatio": total_ratio,
        "solutionStatus": sstat, "diagnostics": sdiags,
        "starts": ext.get("starts"),
        "selectedStartIndex": ext.get("selectedStartIndex"),
        "effectiveFactorRank": ext.get("effectiveFactorRank"),
        "requestedRotation": rot.get("requestedRotation"),
        "appliedRotation": rot.get("appliedRotation"),
        "methodSwitchReason": rot.get("methodSwitchReason"),
        "objective": ext.get("objective"),
        "offDiagonalSse": ext.get("offDiagonalSse"),
        "objectiveId": ext.get("objectiveId"),
    }
    # --- reference inference: Pearson+ML only, on admissible/boundary rules ---
    inference: dict[str, Any] = {"status": "not_implemented", "fit": None,
                                 "kmo": None, "bartlett": None,
                                 "unavailable": {}}
    if req["extraction"] == "minres":
        inference["unavailable"] = {
            "/details/fitMeasures": {"code": "FA_INFERENCE_NOT_IMPLEMENTED",
                                     "message": "ULS系にML検定は提供しません。"}}
    else:
        n = int(fit_n) if fit_n is not None else (
            int(score_z.shape[0]) if score_z is not None else 0)
        boundary = bool(np.any(psi <= lower + 1e-6))
        inad = (sstat == "inadmissible")
        fitm = ml_fit_measures(float(ext["objective"]), n, p, int(q), r,
                               boundary=boundary or inad)
        inference["fit"] = fitm
        inference["kmo"] = kmo_measure(r)
        inference["bartlett"] = bartlett_sphericity(r, n)
        if fitm.get("statistic") is None or inad:
            inference["status"] = "unavailable" if inad else (
                "partial" if fitm.get("statistic") is not None else "unavailable")
        else:
            inference["status"] = "available"
    out["inference"] = inference
    # --- scores: Pearson suitable only, explicit regression/bartlett ---
    out["scores"] = None
    out["scoreCoefficients"] = None
    if (req.get("scoreMethod", "none") != "none" and score_z is not None
            and req.get("correlation") == "pearson" and sstat == "admissible"):
        sc = factor_scores(np.asarray(score_z), np.asarray(r), pattern, phi, psi,
                           req["scoreMethod"])
        if sc.get("status") == "success":
            out["scores"] = np.asarray(sc["scores"])
            out["scoreCoefficients"] = np.asarray(sc["coefficients"])
        else:
            out["diagnostics"] = list(out["diagnostics"]) + [
                {"code": "FA_SCORE_UNAVAILABLE", "severity": "warning",
                 "stage": "scoring"}]
    return out


def run_parallel_analysis(fit: dict, req: dict, r_obs: np.ndarray,
                          perm_index: np.ndarray | None = None) -> dict[str, Any]:
    pa = req.get("parallelAnalysis") or {}
    if not pa.get("enabled", True):
        return {"enabled": False, "status": "not_requested",
                "iterationsRequested": 0, "iterationsSucceeded": 0,
                "iterationsFailed": 0, "observedEigenvalues": None,
                "referenceQuantiles": None, "suggestedFactors": None,
                "exceedanceRanks": [], "reasonCode": None}
    corr = req["correlation"]
    ncats = fit.get("nCats") or []

    def estimate(mat: np.ndarray) -> dict[str, Any]:
        if corr == "pearson":
            try:
                return {"correlation": pearson_correlation(np.asarray(mat, dtype=float))["correlation"],
                        "status": "success"}
            except Exception:
                return {"correlation": None, "status": "failed",
                        "reasonCode": "FA_CORRELATION_NONCONVERGENCE"}
        try:
            from ..algorithms.models.ordinal_correlations import polychoric_matrix as _pm
            rec = _pm(np.asarray(np.round(mat).astype(int)), [int(k) for k in ncats])
        except Exception:
            return {"correlation": None, "status": "failed",
                    "reasonCode": "FA_CORRELATION_NONCONVERGENCE"}
        if rec.get("correlation") is None:
            return {"correlation": None, "status": "failed",
                    "reasonCode": rec.get("reasonCode") or "FA_CORRELATION_NONCONVERGENCE"}
        return {"correlation": rec["correlation"], "status": rec.get("status", "success"),
                "reasonCode": rec.get("reasonCode")}

    base = np.asarray(fit["codes"] if fit["kind"] == "codes" else fit["x"])
    obs_eig = full_correlation_eigenvalues(np.asarray(r_obs, dtype=float))
    res = parallel_analysis(base, estimate,
                            iterations=int(pa.get("iterations", 500)),
                            quantile=float(pa.get("quantile", 0.95)),
                            seed=int(pa.get("seed", 42)),
                            perm_index=perm_index)
    res["observedEigenvalues"] = [float(v) for v in obs_eig.tolist()]
    if res.get("status") == "completed" and res.get("referenceQuantiles") is not None:
        sug = suggest_factors(obs_eig, np.asarray(res["referenceQuantiles"]))
        res.update(sug)
    else:
        res["suggestedFactors"] = None
        res["exceedanceRanks"] = []
    return res


def run_sensitivity_comparison(prep: dict, req: dict, q: int,
                               fit_pearson: dict, fit_poly: dict,
                               res_p: dict, res_o: dict) -> dict[str, Any]:
    """Pearson-MINRES vs Polychoric-MINRES aligned comparison (same q)."""
    sa = req.get("sensitivityAnalysis") or {}
    r_p = np.asarray(res_p["correlation"])
    r_o = np.asarray(res_o["correlation"])
    pat_p = np.asarray(res_p["pattern"])
    pat_o = np.asarray(res_o["pattern"])
    h2_p = np.asarray(res_p["communality"])
    h2_o = np.asarray(res_o["communality"])
    phi_p = np.asarray(res_p["phi"])
    phi_o = np.asarray(res_o["phi"])
    struct_o = np.asarray(res_o["structure"])
    al = align_factors(pat_p, pat_o, phi_o, struct_o)
    if al.get("H") is None:
        return {"status": "indeterminate", "assessment": "indeterminate",
                "reasonCode": al.get("reasonCode"),
                "alignment": {k: al.get(k) for k in
                              ("status", "permutation", "signs", "congruences",
                               "assignmentGap", "reasonCode")}}
    metrics = comparison_metrics(r_p, r_o, pat_p, al["alignedPattern"],
                                 h2_p, h2_o, phi_p, al["alignedPhi"], int(q))
    a_p = definite_assignments(pat_p, float(sa.get("assignmentThreshold", 0.4)),
                               float(sa.get("assignmentMargin", 0.1)))
    a_o = definite_assignments(al["alignedPattern"],
                               float(sa.get("assignmentThreshold", 0.4)),
                               float(sa.get("assignmentMargin", 0.1)))
    changes = 0
    comparable = 0
    ambiguous_n = 0
    items = []
    for ap, ao, j in zip(a_p, a_o, range(len(a_p))):
        if ap["definite"] and ao["definite"]:
            comparable += 1
            changed = ap["factor"] != ao["factor"]
            changes += int(changed)
        else:
            changed = None
        if (not ap["definite"]) or (not ao["definite"]):
            ambiguous_n += 1 if (ap["ambiguous"] or ao["ambiguous"]) else 0
        items.append({"item": j, "pearsonFactor": ap["factor"],
                      "polychoricFactor": ao["factor"], "changed": changed,
                      "definite": bool(ap["definite"] and ao["definite"]),
                      "ambiguous": bool(ap["ambiguous"] or ao["ambiguous"])})
    pro = procrustes_residual(pat_o, pat_p)
    lt = float(sa.get("loadingDifferenceThreshold", 0.1))
    ct = float(sa.get("communalityDifferenceThreshold", 0.1))
    ft = float(sa.get("factorCorrelationDifferenceThreshold", 0.1))
    over = (metrics["loadingDifference"]["max"] is not None
            and metrics["loadingDifference"]["max"] > lt) or \
           (metrics["communalityDifference"]["max"] is not None
            and metrics["communalityDifference"]["max"] > ct) or \
           (metrics["factorCorrelationDifference"]["max"] is not None
            and metrics["factorCorrelationDifference"]["max"] > ft)
    pa_p = res_p.get("parallelSuggested")
    pa_o = res_o.get("parallelSuggested")
    pa_diff = None
    if pa_p is not None and pa_o is not None:
        pa_diff = int(pa_o) - int(pa_p)
    failed = (res_p.get("status") != "success" or res_o.get("status") != "success")
    pa_un = (pa_p is None or pa_o is None)
    bad = (res_p.get("solutionStatus") != "admissible"
           or res_o.get("solutionStatus") != "admissible")
    unal = al.get("status") != "aligned"
    assessment = assess_comparison(
        failed_side=failed, pa_unavailable=pa_un, boundary_or_inadmissible=bad,
        unalignable=unal, candidate_diff=bool(pa_diff),
        over_threshold=bool(over), assignment_changes=changes,
        ambiguous_items=ambiguous_n, all_aligned=not unal)
    return {"status": "completed", "assessment": assessment,
            "alignment": {k: (al.get(k).tolist() if isinstance(al.get(k), np.ndarray) else al.get(k))
                          for k in ("status", "permutation", "signs", "congruences",
                                    "assignmentGap", "H", "reasonCode")},
            "procrustes": {"relativeResidual": pro.get("relativeResidual")},
            "metrics": metrics, "items": items,
            "assignmentChanges": int(changes), "comparableCount": int(comparable),
            "ambiguousCount": int(ambiguous_n),
            "paComparison": {"pearsonSuggested": pa_p, "polychoricSuggested": pa_o,
                             "difference": pa_diff},
            "thresholds": {"loading": lt, "communality": ct,
                           "factorCorrelation": ft,
                           "assignment": float(sa.get("assignmentThreshold", 0.4)),
                           "margin": float(sa.get("assignmentMargin", 0.1))}}
