"""Correspondence Analysis API (Feature 029, production)."""
from __future__ import annotations
import hashlib
import json
import time
from typing import Any
import numpy as np
import polars as pl
from fastapi import APIRouter, Body
from pydantic import ValidationError
from ..algorithms.models.correspondence import pearson_not_applicable, pearson_reference, run_ca_numeric
from ..domain.analysis_contracts import CARequest
from ..domain.analysis_frame import prepare_category_frame
from ..domain.codebook_adapter import normalize_code
from ..domain.context import AnalysisContext, check_revisions, collect_revisions, resolve_scope
from ..domain.errors import BizError
from ..services.analysis_service import build_meta, check_json_finite, model_fingerprint, new_result_id
from ..storage import analysis_result_store as result_store
from ..storage.dataset_store import DatasetStore
router = APIRouter()
store = DatasetStore()
ALGORITHM_VERSION = "davis.ca.1.0.1"
SCHEMA_VERSION = "analysis-result/1.0"


def _err(code, msg, status=422, details=None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _parse_request(payload):
    try:
        return CARequest.model_validate(payload)
    except ValidationError as exc:
        _err("ANALYSIS_REQUEST_INVALID", "bad request", 422)


def _category_id(column_id, kind, code):
    canon = json.dumps([column_id, kind, code], ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return "cat:" + hashlib.sha256(canon.encode("utf-8")).hexdigest()


def _spec_by_id(codebook, ref):
    for spec in (codebook.get("columns", []) or []):
        if not isinstance(spec, dict):
            continue
        if spec.get("columnId") == ref or spec.get("name") == ref:
            return spec
    _err("COLUMN_NOT_FOUND", "missing column", 422)


@router.post("/models/ca")
def run_ca(payload: dict = Body(...)):
    req = _parse_request(payload)
    ctx = req.context.model_dump()
    started = time.perf_counter()
    if req.input.kind == "respondents":
        return _run_respondents(req, ctx, started)
    return _run_contingency(req, ctx, started)


def _map_kernel_error(exc, t):
    msg = str(exc)
    if msg == "CA_ZERO_INERTIA":
        _err("CA_ZERO_INERTIA", "independent table", 422)
    if msg == "CA_EMPTY_TABLE":
        _err("CA_EMPTY_TABLE", "empty table", 422)
    if msg == "ANALYSIS_NUMERICAL_INVARIANT_FAILED":
        raise BizError("ANALYSIS_NUMERICAL_INVARIANT_FAILED", "invariant", status_code=500)
    _err("CA_TABLE_INVALID", "bad numeric input", 422)


def _run_respondents(req, ctx, started):
    row_ref = req.input.rowVariable
    col_ref = req.input.columnVariable
    frame, unknown_note = prepare_category_frame(dataset_id=ctx["datasetId"], context_dict=ctx, category_refs=[row_ref, col_ref], store=store)
    names = list(frame.categorical.keys())
    if len(names) != 2 or names[0] == names[1]:
        _err("CA_CATEGORY_REQUIRED", "distinct columns", 422)
    row_name, col_name = names[0], names[1]
    row_cat = frame.catalogs[row_name]
    col_cat = frame.catalogs[col_name]
    row_codes = frame.categorical[row_name]
    col_codes = frame.categorical[col_name]
    row_set = set(row_codes)
    col_set = set(col_codes)
    row_order = [c for c in row_cat.order if c in row_set]
    col_order = [c for c in col_cat.order if c in col_set]
    if len(row_order) < 1 or len(col_order) < 1:
        _err("CA_DIMENSION_TOO_SMALL", "too few categories", 422)
    ri = {c: i for i, c in enumerate(row_order)}
    ci = {c: j for j, c in enumerate(col_order)}
    w = [float(v) if v is not None else 0.0 for v in frame.weights] if frame.weights is not None else [1.0] * len(frame.row_ids)
    t = np.zeros((len(row_order), len(col_order)), dtype=np.float64)
    t_phys = np.zeros_like(t)
    members = {}
    for rid, rc, cc, ww in zip(frame.row_ids, row_codes, col_codes, w):
        i, j = ri[rc], ci[cc]
        t[i, j] += ww
        t_phys[i, j] += 1.0
        rk = row_cat.kind_by_code.get(rc, "value")
        ck = col_cat.kind_by_code.get(cc, "value")
        rcode = rc if rk == "value" else None
        ccode = cc if ck == "value" else None
        r_id = _category_id(row_cat.variable_id, rk, rcode)
        c_id = _category_id(col_cat.variable_id, ck, ccode)
        members.setdefault(("row", r_id), []).append(rid)
        members.setdefault(("column", c_id), []).append(rid)
    return _finish_respondents(req, ctx, started, t, t_phys, row_order, col_order, row_cat, col_cat, members, frame)


def _finish_respondents(req, ctx, started, t, t_phys, row_order, col_order, row_cat, col_cat, members, frame):
    row_sums = t.sum(axis=1)
    col_sums = t.sum(axis=0)
    keep_r = [i for i in range(len(row_order)) if row_sums[i] > 0]
    keep_c = [j for j in range(len(col_order)) if col_sums[j] > 0]
    active_rows = {row_order[i] for i in keep_r}
    active_columns = {col_order[j] for j in keep_c}
    omitted = []
    # The numerical table is observed-only, but the omission audit belongs to
    # the full declared catalog. Keep its indices without allocating a dense
    # matrix for potentially many unobserved levels.
    for i, code in enumerate(row_cat.order):
        if code not in active_rows:
            kind = row_cat.kind_by_code.get(code, "value")
            cval = code if kind == "value" else None
            omitted.append({"categoryId": _category_id(row_cat.variable_id, kind, cval), "variableId": row_cat.variable_id, "code": cval, "kind": kind, "label": row_cat.labels[code], "side": "row", "reason": "zero_mass", "originalIndex": i})
    for j, code in enumerate(col_cat.order):
        if code not in active_columns:
            kind = col_cat.kind_by_code.get(code, "value")
            cval = code if kind == "value" else None
            omitted.append({"categoryId": _category_id(col_cat.variable_id, kind, cval), "variableId": col_cat.variable_id, "code": cval, "kind": kind, "label": col_cat.labels[code], "side": "column", "reason": "zero_mass", "originalIndex": j})
    total = float(t.sum())
    if not np.isfinite(total) or total <= 0:
        _err("CA_EMPTY_TABLE", "empty table", 422)
    if len(keep_r) < 2 or len(keep_c) < 2:
        _err("CA_DIMENSION_TOO_SMALL", "need 2x2 positive mass", 422)
    sub = t[np.ix_(keep_r, keep_c)]
    try:
        kern = run_ca_numeric(sub, keep_row_index=keep_r, keep_col_index=keep_c)
    except ValueError as exc:
        _map_kernel_error(exc, t)
    return _finalize(req, ctx, started, kern, row_order, col_order, keep_r, keep_c, row_cat, col_cat, omitted, t, t_phys, members, frame, None)


def _run_contingency(req, ctx, started):
    from ..domain.survey_weight import declared_weight_column_id
    from ..domain.weight_mode import resolve_weight_request
    dataset_id = ctx["datasetId"]
    row_label_ref = req.input.rowLabelColumn
    value_refs = list(req.input.valueColumns)
    if req.input.structuralZerosDeclared:
        _err("CA_STRUCTURAL_ZERO_UNSUPPORTED", "structural zero", 422)
    if len(set(value_refs)) != len(value_refs) or row_label_ref in value_refs:
        _err("CA_TABLE_INVALID", "bad spec", 422)
    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
        label_spec = _spec_by_id(codebook, row_label_ref)
        value_specs = [_spec_by_id(codebook, v) for v in value_refs]
        for spec in value_specs:
            st = (spec.get("scaleType") or "")
            if st not in ("interval", "ratio"):
                _err("CA_TABLE_INVALID", "cell numeric", 422)
            if spec.get("multiResponseGroup"):
                _err("CA_TABLE_INVALID", "MA not allowed", 422)
        wm, wref = resolve_weight_request(codebook, weight_mode=ctx.get("weightMode", "dataset"), weight_column=ctx.get("weightColumn"), weight_type=ctx.get("weightType"))
        declared = declared_weight_column_id(codebook)
        resolved_weight = wref or (declared if wm == "dataset" else None)
        if resolved_weight:
            _err("CA_DOUBLE_WEIGHT_FORBIDDEN", "double weight", 422)
        scope = ctx.get("scope", "all")
        label_name = label_spec["name"]
        value_names = [s["name"] for s in value_specs]
        df = store.get_dataframe(dataset_id, columns=["__rowId__", label_name, *value_names])
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=dataset_id, expectedDataRevision=ctx.get("expectedDataRevision"), expectedSchemaRevision=ctx.get("expectedSchemaRevision"), scope=scope, rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"), selectedRowIds=ctx.get("selectedRowIds"), sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = resolve_scope(all_ids, legacy)
        df = df.filter(pl.col("__rowId__").is_in(scope_ids)) if scope_ids else df.filter(pl.col("__rowId__").is_in(["__none__"]))
        row_ids = [str(v) for v in df["__rowId__"].to_list()]
        labels = df[label_name].to_list()
        label_missing = {normalize_code(v) for v in (label_spec.get("missingCodes") or [])}
        label_missing.discard(None)
        seen = set()
        bad_rows = []
        for rid, lab in zip(row_ids, labels):
            code = normalize_code(lab)
            if code is None or code in label_missing:
                bad_rows.append({"rowId": rid, "reason": "missing_label"})
            elif code in seen:
                bad_rows.append({"rowId": rid, "reason": "duplicate_label"})
            else:
                seen.add(code)
        cell_cols = {name: df[name].to_list() for name in value_names}
        from ..domain.codebook_adapter import normalize_code as _nc2
        bad_cells = []
        for idx, rid in enumerate(row_ids):
            for spec, name in zip(value_specs, value_names):
                raw = cell_cols[name][idx]
                missing_codes = {_nc2(v) for v in (spec.get("missingCodes") or [])}
                missing_codes.discard(None)
                if raw is None or _nc2(raw) in missing_codes:
                    bad_cells.append({"rowId": rid, "reason": "missing_cell"})
                    continue
                if isinstance(raw, bool):
                    bad_cells.append({"rowId": rid, "reason": "non_numeric"})
                    continue
                try:
                    val = float(raw)
                except (TypeError, ValueError):
                    bad_cells.append({"rowId": rid, "reason": "non_numeric"})
                    continue
                if not np.isfinite(val):
                    bad_cells.append({"rowId": rid, "reason": "non_finite"})
                elif val < 0:
                    bad_cells.append({"rowId": rid, "reason": "negative"})
                elif req.input.cellSemantics == "frequency" and abs(val - round(val)) > 1e-9:
                    bad_cells.append({"rowId": rid, "reason": "non_integer"})
        if bad_rows or bad_cells:
            _err("CA_TABLE_INVALID", "bad table", 422)
        row_order = [str(normalize_code(v)) for v in labels]
        t = np.zeros((len(row_ids), len(value_names)), dtype=np.float64)
        for i in range(len(row_ids)):
            for j, name in enumerate(value_names):
                t[i, j] = float(cell_cols[name][i])
        total = float(t.sum())
        if not np.isfinite(total):
            _err("CA_TABLE_INVALID", "nonfinite total", 422)
        if total <= 0:
            _err("CA_EMPTY_TABLE", "empty table", 422)
        row_sums = t.sum(axis=1)
        col_sums = t.sum(axis=0)
        keep_r = [i for i in range(len(row_ids)) if row_sums[i] > 0]
        keep_c = [j for j in range(len(value_names)) if col_sums[j] > 0]
        omitted = []
        for i in range(len(row_ids)):
            if i not in keep_r:
                omitted.append({"categoryId": _category_id("rowlabel", "value", row_order[i]), "variableId": "rowlabel", "code": row_order[i], "kind": "value", "label": row_order[i], "side": "row", "reason": "zero_mass", "originalIndex": i})
        for j in range(len(value_names)):
            if j not in keep_c:
                omitted.append({"categoryId": _category_id("collabel", "value", value_names[j]), "variableId": "collabel", "code": value_names[j], "kind": "value", "label": value_names[j], "side": "column", "reason": "zero_mass", "originalIndex": j})
        if len(keep_r) < 2 or len(keep_c) < 2:
            _err("CA_DIMENSION_TOO_SMALL", "need 2x2", 422)
        sub = t[np.ix_(keep_r, keep_c)]
        try:
            kern = run_ca_numeric(sub, keep_row_index=keep_r, keep_col_index=keep_c)
        except ValueError as exc:
            _map_kernel_error(exc, t)
        return _finalize_contingency(req, ctx, started, kern, row_order, value_names, keep_r, keep_c, omitted, t, row_ids, scope_ids, revisions, value_specs, label_spec)


def _cat_entry(side, variable_id, code, kind, label, mass, phys, princ, std, contrib, cos2, dist2):
    return {"categoryId": _category_id(variable_id, kind, code), "side": side, "variableId": variable_id, "code": code, "kind": kind, "label": label, "mass": mass, "physicalCount": phys, "principalCoordinates": princ, "standardCoordinates": std, "contributions": contrib, "cos2": cos2, "distanceSquared": dist2}


def _finalize(req, ctx, started, kern, row_order, col_order, keep_r, keep_c, row_cat, col_cat, omitted, t, t_phys, members, frame, table_records):
    rank = int(kern["rank"])
    eig = [float(v) for v in kern["eigenvalues"].tolist()]
    total_inertia = float(kern["totalInertia"])
    ratio = [float(v) for v in kern["inertiaRatio"].tolist()]
    cum = [float(v) for v in kern["cumulativeInertiaRatio"].tolist()]
    f = kern["f"]
    g = kern["g"]
    phi = kern["phi"]
    gamma = kern["gamma"]
    row_entries = []
    for pos, i in enumerate(keep_r):
        code = row_order[i]
        kind = row_cat.kind_by_code.get(code, "value")
        cval = None if kind != "value" else code
        princ = [float(v) for v in f[pos, :].tolist()]
        std = [float(v) for v in phi[pos, :].tolist()]
        contrib = [float(v) for v in kern["rowContrib"][pos, :].tolist()]
        cosrow = kern["rowCos2"][pos, :]
        cos2 = [None if not np.isfinite(v) else float(v) for v in cosrow.tolist()]
        mass = float(kern["r"][pos])
        phys = int(round(float(t_phys[np.ix_([i], keep_c)].sum())))
        row_entries.append(_cat_entry("row", row_cat.variable_id, cval, kind, row_cat.labels[code], mass, phys, princ, std, contrib, cos2, float(kern["rowDistance2"][pos])))
    col_entries = []
    for pos, j in enumerate(keep_c):
        code = col_order[j]
        kind = col_cat.kind_by_code.get(code, "value")
        cval = None if kind != "value" else code
        princ = [float(v) for v in g[pos, :].tolist()]
        std = [float(v) for v in gamma[pos, :].tolist()]
        contrib = [float(v) for v in kern["colContrib"][pos, :].tolist()]
        coscol = kern["colCos2"][pos, :]
        cos2 = [None if not np.isfinite(v) else float(v) for v in coscol.tolist()]
        mass = float(kern["c"][pos])
        phys = int(round(float(t_phys[np.ix_(keep_r, [j])].sum())))
        col_entries.append(_cat_entry("column", col_cat.variable_id, cval, kind, col_cat.labels[code], mass, phys, princ, std, contrib, cos2, float(kern["colDistance2"][pos])))
    members_rows = []
    for (side, cid), rids in members.items():
        for rid in dict.fromkeys([str(v) for v in rids]):
            members_rows.append((cid, rid, side))
    w = [float(v) if v is not None else 0.0 for v in frame.weights] if frame.weights is not None else [1.0] * len(frame.row_ids)
    sum_w = float(sum(w)) if frame.weight_applied else None
    kish = (sum_w * sum_w / float(sum(v * v for v in w))) if (frame.weight_applied and sum_w and sum(v * v for v in w) > 0) else None
    freq_n = float(sum(int(round(v)) for v in w)) if frame.weight_applied and frame.weight_type == "frequency" else None
    survey = frame.weight_applied and frame.weight_type == "survey"
    if survey:
        pearson = pearson_not_applicable()
    elif frame.weight_applied and frame.weight_type == "frequency":
        pearson = pearson_reference(t[np.ix_(keep_r, keep_c)], kern["r"], kern["c"], float(t[np.ix_(keep_r, keep_c)].sum()))
        pearson = {"statistic": pearson["statistic"], "df": pearson["df"], "pValue": pearson["pValue"], "status": "available", "reason": None, "smallExpectedCellsLt1": pearson["smallExpectedCellsLt1"], "smallExpectedCellsLt5": pearson["smallExpectedCellsLt5"], "fractionExpectedLt5": pearson["fractionExpectedLt5"]}
    elif not frame.weight_applied:
        pearson = pearson_reference(t[np.ix_(keep_r, keep_c)], kern["r"], kern["c"], float(t[np.ix_(keep_r, keep_c)].sum()))
        pearson = {"statistic": pearson["statistic"], "df": pearson["df"], "pValue": pearson["pValue"], "status": "available", "reason": None, "smallExpectedCellsLt1": pearson["smallExpectedCellsLt1"], "smallExpectedCellsLt5": pearson["smallExpectedCellsLt5"], "fractionExpectedLt5": pearson["fractionExpectedLt5"]}
    else:
        pearson = pearson_not_applicable()
    return _publish(req, ctx, started, kern, eig, total_inertia, ratio, cum, row_entries, col_entries, omitted, t, t_phys, members_rows, frame, pearson, "respondent_row")


def _table_imputed_counts(dataset_id, scope_ids, value_specs):
    from ..storage.dataset_store import DatasetStore as _DS
    _store = _DS()
    mask_doc = _store.load_mask(dataset_id) or {}
    entries = mask_doc.get("entries", []) or []
    try:
        col_ids = {s.get("columnId") for s in value_specs} | {s.get("name") for s in value_specs}
    except Exception:
        col_ids = set()
    scope_set = set(str(v) for v in (scope_ids or []))
    try:
        df_ids = [str(v) for v in _store.get_dataframe(dataset_id, columns=["__rowId__"])["__rowId__"].to_list()]
    except Exception:
        df_ids = list(scope_set)
    id_to_pos = {rid: i for i, rid in enumerate(df_ids)}
    seen: set[tuple[str, str]] = set()
    rows: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        rid = str(entry.get("rowId", ""))
        cid = str(entry.get("columnId", ""))
        if cid not in col_ids or rid not in scope_set:
            continue
        key = (rid, cid)
        if key not in seen:
            seen.add(key)
            rows.add(rid)
    mask_rev = _store.mask_revision(dataset_id)
    return len(seen), len(rows), mask_rev


def _finalize_contingency(req, ctx, started, kern, row_order, value_names, keep_r, keep_c, omitted, t, row_ids, scope_ids, revisions, value_specs, label_spec):
    rank = int(kern["rank"])
    eig = [float(v) for v in kern["eigenvalues"].tolist()]
    total_inertia = float(kern["totalInertia"])
    ratio = [float(v) for v in kern["inertiaRatio"].tolist()]
    cum = [float(v) for v in kern["cumulativeInertiaRatio"].tolist()]
    f = kern["f"]
    g = kern["g"]
    phi = kern["phi"]
    gamma = kern["gamma"]
    row_entries = []
    for pos, i in enumerate(keep_r):
        code = row_order[i]
        princ = [float(v) for v in f[pos, :].tolist()]
        std = [float(v) for v in phi[pos, :].tolist()]
        contrib = [float(v) for v in kern["rowContrib"][pos, :].tolist()]
        cosrow = kern["rowCos2"][pos, :]
        cos2 = [None if not np.isfinite(v) else float(v) for v in cosrow.tolist()]
        row_entries.append(_cat_entry("row", "rowlabel", code, "value", code, float(kern["r"][pos]), None, princ, std, contrib, cos2, float(kern["rowDistance2"][pos])))
    col_entries = []
    for pos, j in enumerate(keep_c):
        name = value_names[j]
        spec = value_specs[j]
        cid = spec.get("columnId", name)
        princ = [float(v) for v in g[pos, :].tolist()]
        std = [float(v) for v in gamma[pos, :].tolist()]
        contrib = [float(v) for v in kern["colContrib"][pos, :].tolist()]
        coscol = kern["colCos2"][pos, :]
        cos2 = [None if not np.isfinite(v) else float(v) for v in coscol.tolist()]
        col_entries.append(_cat_entry("column", cid, cid, "value", spec.get("label") or name, float(kern["c"][pos]), None, princ, std, contrib, cos2, float(kern["colDistance2"][pos])))
    members_rows = []
    for i in keep_r:
        cid = _category_id("rowlabel", "value", row_order[i])
        members_rows.append((cid, row_ids[i], "row"))
    members = {"rows": members_rows, "frame": None, "scope": scope_ids, "revisions": revisions, "row_ids": row_ids, "table": True}
    table_cells, table_rows, table_mask_rev = _table_imputed_counts(ctx["datasetId"], scope_ids, value_specs)
    members["imputedCellCount"] = table_cells
    members["imputedRowCount"] = table_rows
    members["maskRevision"] = table_mask_rev
    if req.input.cellSemantics == "frequency" and req.input.independentCountsAcknowledged:
        pearson = pearson_reference(t[np.ix_(keep_r, keep_c)], kern["r"], kern["c"], float(t[np.ix_(keep_r, keep_c)].sum()))
        pearson = {"statistic": pearson["statistic"], "df": pearson["df"], "pValue": pearson["pValue"], "status": "available", "reason": None, "smallExpectedCellsLt1": pearson["smallExpectedCellsLt1"], "smallExpectedCellsLt5": pearson["smallExpectedCellsLt5"], "fractionExpectedLt5": pearson["fractionExpectedLt5"]}
    else:
        pearson = pearson_not_applicable()
    return _publish(req, ctx, started, kern, eig, total_inertia, ratio, cum, row_entries, col_entries, omitted, t, None, members, None, pearson, "table_record", scope_ids=scope_ids, revisions=revisions)


def _publish(req, ctx, started, kern, eig, total_inertia, ratio, cum, row_entries, col_entries, omitted, t, t_phys, members_rows, frame, pearson, unit, scope_ids=None, revisions=None):
    request_json = json.loads(req.model_dump_json())
    if frame is not None:
        fp_payload = {"datasetId": ctx["datasetId"], "dataRevision": frame.revisions["dataRevision"], "schemaRevision": frame.revisions["schemaRevision"], "maskRevision": frame.mask_revision, "snapshotFingerprint": frame.data_fingerprint, "scopeHash": None, "fitRowIdsHash": None, "effectiveConfig": request_json, "catalogs": {k: {"variableId": v.variable_id, "order": [str(x) for x in v.order]} for k, v in frame.catalogs.items()}, "algorithmVersion": ALGORITHM_VERSION}
        scope_for_hash = frame.scope_ids
        fit_ids = frame.row_ids
        rev = frame.revisions
        snap = frame.data_fingerprint
        mask_rev = frame.mask_revision
        excl_counts = dict(frame.exclusion_counts)
        imputed_cells = int(getattr(frame, "imputed_cell_count", 0) or 0)
        imputed_rows = int(getattr(frame, "imputed_row_count", 0) or 0)
        scope_count = frame.scope_count
        fit_count = frame.fit_count
        w_applied = frame.weight_applied
        w_type = frame.weight_type
        w_col = frame.weight_column
        sum_w = None
        kish = None
        freq_n = None
        if w_applied:
            w = [float(v) if v is not None else 0.0 for v in frame.weights]
            s = float(sum(w))
            sum_w = s
            denom = float(sum(v * v for v in w))
            kish = (s * s / denom) if denom > 0 else None
            if w_type == "frequency":
                freq_n = float(sum(int(round(v)) for v in w))
    else:
        extra = members_rows if isinstance(members_rows, dict) else {}
        fp_payload = {"datasetId": ctx["datasetId"], "dataRevision": revisions["dataRevision"], "schemaRevision": revisions["schemaRevision"], "maskRevision": extra.get("maskRevision"), "snapshotFingerprint": None, "effectiveConfig": request_json, "algorithmVersion": ALGORITHM_VERSION}
        scope_for_hash = scope_ids or []
        fit_ids = scope_ids or []
        rev = revisions
        snap = None
        mask_rev = extra.get("maskRevision")
        excl_counts = {"invalid": 0, "missing": 0, "missing_weight": 0, "zero_weight": 0, "structural_task_exclusion": 0}
        scope_count = len(scope_ids or [])
        fit_count = len(scope_ids or [])
        w_applied = False
        w_type = None
        w_col = None
        sum_w = None
        kish = None
        freq_n = None
        imputed_cells = int(extra.get("imputedCellCount", 0) or 0)
        imputed_rows = int(extra.get("imputedRowCount", 0) or 0)
    from ..domain.context import scope_hash as _sh
    fp_payload["scopeHash"] = _sh([str(v) for v in scope_for_hash])
    fp_payload["fitRowIdsHash"] = _sh([str(v) for v in fit_ids])
    fingerprint = model_fingerprint(fp_payload)
    runtime_ms = (time.perf_counter() - started) * 1000.0
    table_total = float(t[np.ix_(kern["keepRowIndex"], kern["keepColIndex"])].sum()) if unit == "table_record" else float(t.sum())
    summary = {"rank": int(kern["rank"]), "totalInertia": total_inertia, "eigenvalues": eig, "inertiaRatio": ratio, "cumulativeInertiaRatio": cum, "discardedNumericalInertia": float(kern.get("discardedNumericalInertia", 0.0)), "tableTotal": table_total, "activeRowCategoryCount": len(row_entries), "activeColumnCategoryCount": len(col_entries), "pearson": pearson, "degenerateBlocks": kern.get("degenerateBlocks", []), "rankTol": float(kern.get("rankTol", 0.0))}
    row_ids_out = [e["categoryId"] for e in row_entries]
    col_ids_out = [e["categoryId"] for e in col_entries]
    table = [[float(v) for v in row] for row in t[np.ix_(kern["keepRowIndex"], kern["keepColIndex"])].tolist()]
    phys = None
    if t_phys is not None:
        phys = [[int(round(float(v))) for v in row] for row in t_phys[np.ix_(kern["keepRowIndex"], kern["keepColIndex"])].tolist()]
    details = {"rowCategories": row_entries, "columnCategories": col_entries, "omittedCategories": omitted, "table": table, "tableRowCategoryIds": row_ids_out, "tableColumnCategoryIds": col_ids_out, "physicalTable": phys, "mapScaling": req.mapScaling}
    unavailable_reasons = {}
    for key in ("rowCategories", "columnCategories"):
        for i, entry in enumerate(details[key]):
            if entry["distanceSquared"] == 0.0:
                for k, value in enumerate(entry["cos2"]):
                    if value is None:
                        unavailable_reasons[f"/details/{key}/{i}/cos2/{k}"] = {
                            "code": "ZERO_DISTANCE",
                            "message": "重心からの距離が数値的に0のため、cos²は定義できません。",
                            "relatedFields": [f"/details/{key}/{i}/distanceSquared"],
                        }
    if unit == "table_record":
        meta = build_meta(dataset_id=ctx["datasetId"], revisions=rev, snapshot_fingerprint=snap, scope=ctx.get("scope", "all"), scope_ids=[str(v) for v in scope_for_hash], fit_count=fit_count, exclusion_counts=excl_counts, analysis_unit=unit, weight_applied=False, weight_type=None, weight_column=None, sum_weights=None, kish_effective_n=None, frequency_n=None, mask_revision=mask_rev, imputed_cell_count=imputed_cells, imputed_row_count=imputed_rows, fingerprint=fingerprint, algorithm_version=ALGORITHM_VERSION)
    else:
        meta = build_meta(dataset_id=ctx["datasetId"], revisions=rev, snapshot_fingerprint=snap, scope=ctx.get("scope", "all"), scope_ids=[str(v) for v in scope_for_hash], fit_count=fit_count, exclusion_counts=excl_counts, analysis_unit=unit, weight_applied=w_applied, weight_type=w_type, weight_column=w_col, sum_weights=sum_w, kish_effective_n=kish, frequency_n=freq_n, mask_revision=mask_rev, imputed_cell_count=imputed_cells, imputed_row_count=imputed_rows, fingerprint=fingerprint, algorithm_version=ALGORITHM_VERSION)
    result_id = new_result_id()
    manifest = {"schemaVersion": SCHEMA_VERSION, "resultId": result_id, "method": "ca", "ownerDatasetId": ctx["datasetId"], "config": request_json, "meta": meta, "capabilities": {"rows": False, "projection": False, "materialize": False, "selectionKinds": ["categories"], "exportTables": ["manifest", "eigenvalues", "categories", "table"], "materializeFitFields": [], "materializePredictionFields": [], "predictionIntervals": [], "simulation": False}, "summary": summary, "details": details, "summaryKeys": list(summary.keys()), "unavailableReasons": unavailable_reasons}
    arrays = {"eigenvalues": np.asarray(eig, dtype=np.float64), "f": np.asarray(kern["f"]), "g": np.asarray(kern["g"]), "r": np.asarray(kern["r"]), "c": np.asarray(kern["c"])}
    if isinstance(members_rows, dict):
        mem_df = pl.DataFrame({"categoryId": [a for a, b, c in members_rows["rows"]], "rowId": [b for a, b, c in members_rows["rows"]], "side": [c for a, b, c in members_rows["rows"]]})
    else:
        mem_df = pl.DataFrame({"categoryId": [a for a, b, c in members_rows], "rowId": [b for a, b, c in members_rows], "side": [c for a, b, c in members_rows]})
    with store.lock(ctx["datasetId"]):
        cur_meta = store.get_meta(ctx["datasetId"])
        cur_code = store.load_codebook(ctx["datasetId"]) or {}
        cur_rev = collect_revisions(cur_meta, cur_code)
        base_rev = rev
        if cur_rev["dataRevision"] != base_rev["dataRevision"] or cur_rev["schemaRevision"] != base_rev["schemaRevision"]:
            raise BizError("ANALYSIS_INPUT_STALE", "計算中にデータが更新されました。再実行してください。", status_code=409,
                           details={"expectedDataRevision": base_rev["dataRevision"], "currentDataRevision": cur_rev["dataRevision"],
                                    "expectedSchemaRevision": base_rev["schemaRevision"], "currentSchemaRevision": cur_rev["schemaRevision"]})
        result_store.save_result(result_id, manifest, arrays, members=mem_df, exclusions=None)
    out = {"status": "success", "resultId": result_id, "method": "ca", "meta": meta, "config": request_json, "capabilities": manifest["capabilities"], "summary": summary, "details": details, "unavailableReasons": unavailable_reasons}
    check_json_finite(out)
    return out
