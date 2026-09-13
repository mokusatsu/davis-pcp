"""Shared preprocessing for Features 029-034 (production, CA slice).

Steps: revisions -> V2 scope checks -> column plan -> snapshot -> category
domain classification -> weight resolution -> single validMask application.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import polars as pl

from .codebook_adapter import is_not_applicable_reason, normalize_code
from .context import check_revisions, collect_revisions, resolve_scope, scope_hash, AnalysisContext
from .errors import BizError
from .survey_weight import (
    check_weights_valid,
    extract_weights,
    resolve_weight_column,
    resolve_weight_config,
    validate_weight_semantics,
)
from .weight_mode import resolve_weight_request


@dataclass(frozen=True)
class MissingKey:
    kind: str


MISSING_M = MissingKey("missing")
MISSING_NA = MissingKey("not_applicable")


@dataclass
class CategoryCatalog:
    variable_id: str
    column_name: str
    kind_by_code: dict[Any, str]  # code key -> 'value'|'missing'|'not_applicable'
    order: list[Any]  # codes incl. missing keys kept for display
    labels: dict[Any, str]


@dataclass
class PreparedAnalysisFrame:
    dataset_id: str
    scope_ids: list[str]
    row_ids: list[str]
    categorical: dict[str, list[Any]]  # column name -> code key or None
    numeric_raw: dict[str, list[Any]]
    catalogs: dict[str, CategoryCatalog]
    weights: list[float | None] | None
    weight_applied: bool
    weight_type: str | None
    weight_column: str | None
    weight_column_id: str | None
    exclusions: list[str]
    exclusion_counts: dict[str, int]
    scope_count: int
    fit_count: int
    revisions: dict[str, int]
    mask_revision: int | None
    data_fingerprint: str | None
    imputed_cell_count: int = 0
    imputed_row_count: int = 0


@dataclass
class PreparedFamdFrame:
    dataset_id: str
    scope_ids: list[str]
    row_ids: list[str]
    numeric_names: list[str]
    numeric_values: list[list[float | None]]
    numeric_specs: list[dict[str, Any]]
    numeric_ids: list[str]
    variables: list[dict[str, Any]]  # categorical variableId/label/categories
    weights: list[float | None] | None
    weight_applied: bool
    weight_type: str | None
    weight_column: str | None
    weight_column_id: str | None
    exclusions: list[str]
    exclusion_counts: dict[str, int]
    scope_count: int
    fit_count: int
    revisions: dict[str, int]
    mask_revision: int | None
    data_fingerprint: str | None
    imputed_cell_count: int = 0
    imputed_row_count: int = 0
    numeric_ranges: list[dict[str, float]] = field(default_factory=list)


@dataclass
class PreparedRegressionFrame:
    dataset_id: str
    scope_ids: list[str]
    # Full-dataset design rows (survey Taylor keeps scope-outside rows).
    design_row_ids: list[str]
    design_strata: list[Any] | None
    design_psu: list[Any] | None
    design_fpc: list[Any] | None
    design_weights_full: list[float | None]
    fit_pos_in_design: list[int]
    row_ids: list[str]
    target_values: list[float]
    target_name: str
    target_id: str
    # Model-matrix inputs in predictor order (raw numeric / raw category code).
    numeric_inputs: dict[str, list[float | None]]
    numeric_specs: dict[str, dict]
    numeric_ids: dict[str, str]
    numeric_ordinal: dict[str, dict[str, Any]]
    category_inputs: dict[str, list[Any]]
    category_specs: dict[str, dict]
    category_ids: dict[str, str]
    catalogs: dict[str, CategoryCatalog]
    weights: list[float | None] | None
    weight_applied: bool
    weight_type: str | None
    weight_column: str | None
    weight_column_id: str | None
    exclusions: list[str]
    exclusion_counts: dict[str, int]
    scope_count: int
    fit_count: int
    revisions: dict[str, int]
    mask_revision: int | None
    data_fingerprint: str | None
    imputed_cell_count: int = 0
    imputed_row_count: int = 0


@dataclass
class PreparedMcaFrame:
    dataset_id: str
    scope_ids: list[str]
    row_ids: list[str]
    variables: list[dict[str, Any]]  # variableId/label/categories/isMaOption/maParentId
    weights: list[float | None] | None
    weight_applied: bool
    weight_type: str | None
    weight_column: str | None
    weight_column_id: str | None
    exclusions: list[str]
    exclusion_counts: dict[str, int]
    scope_count: int
    fit_count: int
    revisions: dict[str, int]
    mask_revision: int | None
    data_fingerprint: str | None
    imputed_cell_count: int = 0
    imputed_row_count: int = 0
    ma_diagnostics: list[dict[str, Any]] = field(default_factory=list)


def _spec_by_id(codebook: dict, ref: str) -> dict:
    for spec in (codebook.get("columns", []) or []):
        if not isinstance(spec, dict):
            continue
        if spec.get("columnId") == ref or spec.get("name") == ref:
            return spec
    raise BizError("COLUMN_NOT_FOUND", f"分析対象の列が存在しません: {ref}", status_code=422)


def _classify_category(raw: Any, spec: dict, missing_policy: str) -> tuple[str | None, str, str]:
    """Return (code, kind, first-exclusion-or-ok).

    kind: value|missing|not_applicable. Invalid (out of closed domain) -> (None,'value','invalid').
    Missing sentinels map by missingPolicy; None raw with exclude -> missing.
    """
    missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
    missing_codes.discard(None)
    reasons = spec.get("missingReasons") or {}
    code = normalize_code(raw)
    if code is None or code in missing_codes:
        reason = reasons.get(code, "") if isinstance(reasons, dict) else ""
        if missing_policy == "include_missing":
            return "__missing__", "missing", "ok"
        if missing_policy == "separate_not_applicable" and is_not_applicable_reason(reason):
            return "__not_applicable__", "not_applicable", "ok"
        if missing_policy == "separate_not_applicable":
            return "__missing__", "missing", "ok"
        return None, "missing", "missing"
    # Closed domain AV02
    order = spec.get("categoryOrder") or []
    declared = {normalize_code(v) for v in order}
    declared.discard(None)
    declared -= missing_codes
    if declared and code not in declared:
        return None, "value", "invalid"
    return code, "value", "ok"


def prepare_category_frame(
    *,
    dataset_id: str,
    context_dict: dict[str, Any],
    category_refs: list[str],
    store,
) -> PreparedAnalysisFrame:
    from .analysis_columns import resolve_analysis_columns

    ctx = context_dict
    scope = ctx.get("scope", "all")
    required = {"active": "activeRowIds", "selected": "selectedRowIds",
                "sampled": "sampledRowIds", "explicit": "rowIds"}.get(scope)
    for name in ("rowIds", "activeRowIds", "selectedRowIds", "sampledRowIds"):
        value = ctx.get(name)
        if name == required and value is None:
            raise BizError("ANALYSIS_REQUEST_INVALID", f"scope={scope} requires {name}",
                           status_code=422)
        if name != required and value is not None:
            raise BizError("ANALYSIS_REQUEST_INVALID", f"{name} is not allowed for scope={scope}",
                           status_code=422)
    if ctx.get("weightMode") == "column" and not ctx.get("weightColumn"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "weightMode=column requires weightColumn",
                       status_code=422)
    if ctx.get("weightMode") != "column" and (ctx.get("weightColumn") is not None or ctx.get("weightType") is not None):
        raise BizError("ANALYSIS_REQUEST_INVALID",
                       "weightColumn/weightType are only allowed with weightMode=column",
                       status_code=422)
    missing_policy = ctx.get("missingPolicy", "exclude")
    if missing_policy not in ("exclude", "include_missing", "separate_not_applicable"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "missingPolicy が不正です。", status_code=422)
    if ctx.get("imputationPolicy", "use_current_values") != "use_current_values":
        raise BizError("ANALYSIS_REQUEST_INVALID", "imputationPolicy は use_current_values のみ対応です。",
                       status_code=422)

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
        try:
            plan = resolve_analysis_columns(
                codebook, category_refs, scales={"nominal", "ordinal", "binary"},
                allow_ma_options=False)
        except BizError as exc:
            if exc.code in ("MA_METHOD_UNSUPPORTED", "COLUMN_NOT_FOUND"):
                raise BizError("CA_CATEGORY_REQUIRED", exc.message, status_code=422,
                               details={"columnIds": category_refs}) from exc
            raise
        names = plan.names
        id_map = {}
        for ref, name in zip(category_refs, names):
            id_map[name] = _spec_by_id(codebook, ref).get("columnId", ref)

        weight_mode, weight_ref = resolve_weight_request(
            codebook, weight_mode=ctx.get("weightMode", "dataset"),
            weight_column=ctx.get("weightColumn"), weight_type=ctx.get("weightType"))
        declared_weight_col = None
        try:
            from .survey_weight import declared_weight_column_id
            declared_weight_col = declared_weight_column_id(codebook)
        except Exception:
            declared_weight_col = None
        if weight_mode == "dataset" and weight_ref is None and declared_weight_col:
            # Saved weight exists but its type declaration is the gate.
            weight_ref = declared_weight_col
        weight_spec = resolve_weight_column(codebook, weight_ref)
        weight_name = weight_spec["name"] if weight_spec else None
        # Declared-type gate: a dataset default without declared type cannot be used silently.
        weight_type = resolve_weight_config(codebook, weight_ref) if weight_spec else None
        if ctx.get("weightType") is not None and weight_type is not None and ctx["weightType"] != weight_type:
            raise BizError("WEIGHT_TYPE_MISMATCH", "weightType が保存済み設定と一致しません。",
                           status_code=422)

        read_cols = ["__rowId__", *dict.fromkeys([*names, *([weight_name] if weight_name else [])])]
        df = store.get_dataframe(dataset_id, columns=read_cols)
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=dataset_id,
                                 expectedDataRevision=ctx.get("expectedDataRevision"),
                                 expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
                                 scope=scope,  # type: ignore[arg-type]
                                 rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"),
                                 selectedRowIds=ctx.get("selectedRowIds"),
                                 sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = resolve_scope(all_ids, legacy)
        unknown_note = None
        if scope in ("active", "selected", "sampled"):
            wanted = set(str(v) for v in (ctx.get(required) or []))
            unknown = sorted(wanted - set(all_ids))
            if unknown:
                unknown_note = {"code": "UNKNOWN_SCOPE_ROWS_IGNORED", "count": len(unknown)}
        df = df.filter(pl.col("__rowId__").is_in(scope_ids)) if scope_ids else df.filter(
            pl.col("__rowId__").is_in(["__none__"]))
        ordered_ids = [str(v) for v in df["__rowId__"].to_list()]

        specs = {name: _spec_by_id(codebook, ref) for name, ref in zip(names, category_refs)}
        # MA columns are never valid category inputs.
        for name, spec in specs.items():
            if spec.get("multiResponseGroup"):
                raise BizError("CA_CATEGORY_REQUIRED", f"MA設問は指定できません: {name}",
                               status_code=422, details={"columnIds": [id_map[name]]})
            if (spec.get("scaleType") or "nominal") not in ("nominal", "ordinal", "binary"):
                raise BizError("CA_CATEGORY_REQUIRED",
                               f"nominal/ordinal/binaryを指定してください: {name}",
                               status_code=422, details={"columnIds": [id_map[name]]})

        raw_cols = {name: df[name].to_list() for name in names}
        codes: dict[str, list[Any]] = {}
        kinds: dict[str, list[str]] = {}
        col_reasons: dict[str, list[str]] = {}
        for name in names:
            spec = specs[name]
            col_codes: list[Any] = []
            col_kinds: list[str] = []
            col_rs: list[str] = []
            for i, raw in enumerate(raw_cols[name]):
                code, kind, reason = _classify_category(raw, spec, missing_policy)
                if code == "__missing__" and kind in ("missing", "not_applicable"):
                    code = MISSING_M
                elif code == "__not_applicable__" and kind in ("missing", "not_applicable"):
                    code = MISSING_NA
                col_codes.append(code)
                col_kinds.append(kind)
                col_rs.append(reason)
            codes[name] = col_codes
            kinds[name] = col_kinds
            col_reasons[name] = col_rs
        # R007: 除外理由はinvalid > missing > missing_weight > zero_weightの優先順位で決定
        _priority = {"invalid": 0, "missing": 1, "missing_weight": 2, "zero_weight": 3}
        reasons = []
        for i in range(len(ordered_ids)):
            best = "ok"
            for name in names:
                r = col_reasons[name][i]
                if r == "ok":
                    continue
                if best == "ok" or _priority.get(r, 9) < _priority.get(best, 9):
                    best = r
            reasons.append(best)

        weights: list[float | None] | None = None
        weight_applied = False
        if weight_spec is not None:
            weights, _missing, has_invalid = extract_weights(df, weight_name or "", weight_spec)
            check_weights_valid(weights, has_invalid)
            validate_weight_semantics(weights, weight_type)

        # Single validMask application: invalid -> missing -> missing_weight -> zero_weight
        keep = [True] * len(ordered_ids)
        final_reasons = list(reasons)
        if weights is not None:
            for i in range(len(ordered_ids)):
                if final_reasons[i] != "ok":
                    continue
                w = weights[i]
                if w is None:
                    final_reasons[i] = "missing_weight"
                elif w == 0:
                    final_reasons[i] = "zero_weight"
        for i, r in enumerate(final_reasons):
            if r != "ok":
                keep[i] = False
        counts = {"invalid": 0, "missing": 0, "missing_weight": 0, "zero_weight": 0,
                  "structural_task_exclusion": 0}
        for r in final_reasons:
            if r in counts:
                counts[r] += 1
        kept_idx = [i for i, k in enumerate(keep) if k]
        kept_ids = [ordered_ids[i] for i in kept_idx]
        kept_codes = {name: [codes[name][i] for i in kept_idx] for name in names}
        kept_raw = {name: [raw_cols[name][i] for i in kept_idx] for name in names}
        kept_weights = [weights[i] if weights is not None else None for i in kept_idx] \
            if weights is not None else None
        if weight_spec is not None:
            positive = sum(w for w in (kept_weights or []) if w is not None and w > 0)
            weight_applied = positive > 0

        catalogs: dict[str, CategoryCatalog] = {}
        for name in names:
            spec = specs[name]
            order_raw = spec.get("categoryOrder") or []
            missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
            missing_codes.discard(None)
            ordered = [c for c in (normalize_code(v) for v in order_raw)
                       if c is not None and c not in missing_codes]
            labels_src = spec.get("valueLabels") or {}
            if not ordered and labels_src:
                ordered = [c for c in (normalize_code(k) for k in labels_src.keys()) if c is not None]
            observed = [c for c in dict.fromkeys(kept_codes[name]) if c is not None and c not in ordered
                        and c not in (MISSING_M, MISSING_NA)]
            full_order = [*ordered, *observed]
            if missing_policy != "exclude":
                for sentinel in (MISSING_M, MISSING_NA):
                    if sentinel in kept_codes[name] and sentinel not in full_order:
                        full_order.append(sentinel)
            kind_map = {}
            for c in full_order:
                if c == MISSING_M:
                    kind_map[c] = "missing"
                elif c == MISSING_NA:
                    kind_map[c] = "not_applicable"
                else:
                    kind_map[c] = "value"
            label_map = {}
            for c in full_order:
                if c == MISSING_M:
                    label_map[c] = "欠損"
                elif c == MISSING_NA:
                    label_map[c] = "非該当"
                else:
                    label_map[c] = str(labels_src.get(c, c))
            catalogs[name] = CategoryCatalog(variable_id=id_map[name], column_name=name,
                                             kind_by_code=kind_map, order=full_order,
                                             labels=label_map)
        mask_doc = store.load_mask(dataset_id) or {}
        mask_entries = mask_doc.get("entries", []) or []
        try:
            use_col_ids = {specs[n].get("columnId") for n in names} | {specs[n].get("name") for n in names}
        except Exception:
            use_col_ids = set()
        scope_set = set(ordered_ids)
        fit_set = set(kept_ids)
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
        fingerprint = meta.get("fingerprint")
        return PreparedAnalysisFrame(
            dataset_id=dataset_id, scope_ids=scope_ids, row_ids=kept_ids,
            categorical=kept_codes, numeric_raw=kept_raw, catalogs=catalogs,
            weights=kept_weights, weight_applied=weight_applied,
            weight_type=weight_type if weight_applied or weight_spec else None,
            weight_column=weight_name, weight_column_id=weight_spec["columnId"] if weight_spec else None,
            exclusions=final_reasons, exclusion_counts=counts,
            scope_count=len(scope_ids), fit_count=len(kept_ids),
            revisions=revisions, mask_revision=mask_revision,
            data_fingerprint=fingerprint,
            imputed_cell_count=imputed_cell_count, imputed_row_count=imputed_row_count,
        ), unknown_note  # type: ignore[return-value]


def prepare_mca_frame(
    *,
    dataset_id: str,
    context_dict: dict[str, Any],
    variable_refs: list[str],
    ma_mode: str = "ordinary_only",
    store,
) -> PreparedMcaFrame:
    """MCA-specific shared preprocessing (Feature 030).

    Ordinary nominal/ordinal/binary variables plus explicit MA binary options.
    MA parents are judged on the full member set; only explicitly requested
    children become binary variables. Non-selected categories stay categories.
    """
    from .analysis_columns import resolve_analysis_columns
    from .multi_response import prepare_classifier, resolve_groups, validate_group

    if not variable_refs or len(variable_refs) < 2:
        raise BizError("MCA_TOO_FEW_VARIABLES", "分析変数は2つ以上必要です。", status_code=422)
    if len(set(variable_refs)) != len(variable_refs):
        raise BizError("ANALYSIS_REQUEST_INVALID", "variables に重複があります。", status_code=422)
    if ma_mode not in ("ordinary_only", "explicit_binary_options"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "maMode が不正です。", status_code=422)
    ctx = context_dict
    scope = ctx.get("scope", "all")
    required = {"active": "activeRowIds", "selected": "selectedRowIds",
                "sampled": "sampledRowIds", "explicit": "rowIds"}.get(scope)
    for name in ("rowIds", "activeRowIds", "selectedRowIds", "sampledRowIds"):
        value = ctx.get(name)
        if name == required and value is None:
            raise BizError("ANALYSIS_REQUEST_INVALID", f"scope={scope} requires {name}",
                           status_code=422)
        if name != required and value is not None:
            raise BizError("ANALYSIS_REQUEST_INVALID", f"{name} is not allowed for scope={scope}",
                           status_code=422)
    if ctx.get("weightMode") == "column" and not ctx.get("weightColumn"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "weightMode=column requires weightColumn",
                       status_code=422)
    if ctx.get("weightMode") != "column" and (ctx.get("weightColumn") is not None or ctx.get("weightType") is not None):
        raise BizError("ANALYSIS_REQUEST_INVALID",
                       "weightColumn/weightType are only allowed with weightMode=column",
                       status_code=422)
    missing_policy = ctx.get("missingPolicy", "exclude")
    if missing_policy not in ("exclude", "include_missing", "separate_not_applicable"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "missingPolicy が不正です。", status_code=422)
    if ctx.get("imputationPolicy", "use_current_values") != "use_current_values":
        raise BizError("ANALYSIS_REQUEST_INVALID", "imputationPolicy は use_current_values のみ対応です。",
                       status_code=422)

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
        try:
            plan = resolve_analysis_columns(
                codebook, variable_refs, scales={"nominal", "ordinal", "binary"},
                allow_ma_options=(ma_mode == "explicit_binary_options"))
        except BizError as exc:
            if exc.code in ("MA_METHOD_UNSUPPORTED", "COLUMN_NOT_FOUND"):
                code = "MCA_MA_UNSUPPORTED" if "MA" in str(exc.message) else "MCA_CATEGORY_REQUIRED"
                raise BizError(code, exc.message, status_code=422,
                               details={"columnIds": variable_refs}) from exc
            raise
        specs = {name: _spec_by_id(codebook, ref) for name, ref in zip(plan.names, variable_refs)}
        id_by_name = {}
        for ref, name in zip(variable_refs, plan.names):
            id_by_name[name] = _spec_by_id(codebook, ref).get("columnId", ref)
        # Ordinary-mode gate: MA children/parents never enter silently.
        group_by_name: dict[str, dict[str, Any]] = {}
        if plan.groups:
            try:
                groups = resolve_groups(codebook)
                for group in groups:
                    validate_group(group)
                    for col in group.get("columns", []):
                        group_by_name[col.get("name")] = group
            except ValueError as exc:
                raise BizError("MA_DEFINITION_INVALID", str(exc), status_code=422) from exc
        for name, spec in specs.items():
            scale = (spec.get("scaleType") or "nominal")
            if spec.get("multiResponseGroup"):
                if ma_mode != "explicit_binary_options":
                    raise BizError("MCA_MA_UNSUPPORTED",
                                   f"MA選択肢は explicit_binary_options でのみ使用できます: {name}",
                                   status_code=422, details={"columnIds": [id_by_name[name]]})
                if scale != "nominal":
                    raise BizError("MCA_MA_UNSUPPORTED", f"MA選択肢の尺度が不正です: {name}",
                                   status_code=422)
            elif scale not in ("nominal", "ordinal", "binary"):
                raise BizError("MCA_CATEGORY_REQUIRED",
                               f"nominal/ordinal/binaryを指定してください: {name}",
                               status_code=422, details={"columnIds": [id_by_name[name]]})
            role = spec.get("role")
            if role not in ("question", "attribute"):
                raise BizError("MCA_CATEGORY_REQUIRED", f"対象外の役割です: {name}",
                               status_code=422, details={"columnIds": [id_by_name[name]]})
        # MA diagnostics + full-parent classification.
        ma_diagnostics: list[dict[str, Any]] = []
        classifiers: dict[str, Any] = {}
        member_values: dict[str, list[Any]] = {}
        group_members: dict[str, list[str]] = {}
        for group in plan.groups:
            gid = group["groupId"]
            members = [c["name"] for c in group.get("columns", [])]
            group_members[gid] = members
            classifiers[gid] = prepare_classifier(group)
            counts = {s: 0 for s in ("valid", "missing", "partial", "notApplicable", "invalid")}
            ma_diagnostics.append({
                "parentId": gid,
                "selectedChildIds": [c.get("columnId") for c in group.get("columns", [])
                                     if c.get("name") in plan.names],
                "dependencyChildIds": [c.get("columnId") for c in group.get("columns", [])],
                "statusCounts": counts})
        weight_mode, weight_ref = resolve_weight_request(
            codebook, weight_mode=ctx.get("weightMode", "dataset"),
            weight_column=ctx.get("weightColumn"), weight_type=ctx.get("weightType"))
        try:
            from .survey_weight import declared_weight_column_id
            declared_weight_col = declared_weight_column_id(codebook)
        except Exception:
            declared_weight_col = None
        if weight_mode == "dataset" and weight_ref is None and declared_weight_col:
            weight_ref = declared_weight_col
        weight_spec = resolve_weight_column(codebook, weight_ref)
        weight_name = weight_spec["name"] if weight_spec else None
        weight_type = resolve_weight_config(codebook, weight_ref) if weight_spec else None
        if ctx.get("weightType") is not None and weight_type is not None and ctx["weightType"] != weight_type:
            raise BizError("WEIGHT_TYPE_MISMATCH", "weightType が保存済み設定と一致しません。",
                           status_code=422)
        read_cols = ["__rowId__", *dict.fromkeys([*plan.dependencies,
                                                  *([weight_name] if weight_name else [])])]
        df = store.get_dataframe(dataset_id, columns=read_cols)
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=dataset_id,
                                 expectedDataRevision=ctx.get("expectedDataRevision"),
                                 expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
                                 scope=scope,  # type: ignore[arg-type]
                                 rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"),
                                 selectedRowIds=ctx.get("selectedRowIds"),
                                 sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = resolve_scope(all_ids, legacy)
        df = df.filter(pl.col("__rowId__").is_in(scope_ids)) if scope_ids else df.filter(
            pl.col("__rowId__").is_in(["__none__"]))
        ordered_ids = [str(v) for v in df["__rowId__"].to_list()]
        raw_cols = {name: df[name].to_list() for name in dict.fromkeys([*plan.names, *plan.dependencies])}
        # Per-variable codes + first-exclusion reasons (invalid > missing > weights).
        var_codes: dict[str, list[Any]] = {}
        var_reasons: dict[str, list[str]] = {}
        ma_row_status: dict[str, list[str]] = {}
        for name in plan.names:
            spec = specs[name]
            group = group_by_name.get(name)
            codes: list[Any] = []
            reasons: list[str] = []
            if group is not None:
                gid = group["groupId"]
                members = [c["name"] for c in group.get("columns", [])]
                mvals = [raw_cols[m] for m in members]
                diag = next(d for d in ma_diagnostics if d["parentId"] == gid)
                for i in range(len(ordered_ids)):
                    status, _selected = classifiers[gid]([col[i] for col in mvals])
                    diag["statusCounts"][status] += 1
                    if status == "valid":
                        code, kind, reason = _classify_category(raw_cols[name][i], spec, missing_policy)
                        # MA valid rows use binary 0/1 categories; keep sentinel keys for missing.
                        codes.append(code)
                        reasons.append(reason)
                    elif status == "partial":
                        codes.append(None)
                        reasons.append("missing")
                    elif status == "notApplicable":
                        if missing_policy == "exclude":
                            codes.append(None)
                            reasons.append("missing")
                        else:
                            codes.append(MISSING_NA if missing_policy == "separate_not_applicable" else MISSING_M)
                            reasons.append("ok")
                    elif status == "missing":
                        if missing_policy == "exclude":
                            codes.append(None)
                            reasons.append("missing")
                        else:
                            codes.append(MISSING_M)
                            reasons.append("ok")
                    else:
                        codes.append(None)
                        reasons.append("invalid")
            else:
                for raw in raw_cols[name]:
                    code, kind, reason = _classify_category(raw, spec, missing_policy)
                    if code == "__missing__" and kind in ("missing", "not_applicable"):
                        code = MISSING_M
                    elif code == "__not_applicable__" and kind in ("missing", "not_applicable"):
                        code = MISSING_NA
                    codes.append(code)
                    reasons.append(reason)
            var_codes[name] = codes
            var_reasons[name] = reasons
        _priority = {"invalid": 0, "missing": 1, "missing_weight": 2, "zero_weight": 3}
        reasons_all = []
        for i in range(len(ordered_ids)):
            best = "ok"
            for name in plan.names:
                r = var_reasons[name][i]
                if r == "ok":
                    continue
                if best == "ok" or _priority.get(r, 9) < _priority.get(best, 9):
                    best = r
            reasons_all.append(best)
        weights: list[float | None] | None = None
        weight_applied = False
        if weight_spec is not None:
            weights, _missing, has_invalid = extract_weights(df, weight_name or "", weight_spec)
            check_weights_valid(weights, has_invalid)
            validate_weight_semantics(weights, weight_type)
        final_reasons = list(reasons_all)
        if weights is not None:
            for i in range(len(ordered_ids)):
                if final_reasons[i] != "ok":
                    continue
                w = weights[i]
                if w is None:
                    final_reasons[i] = "missing_weight"
                elif w == 0:
                    final_reasons[i] = "zero_weight"
        counts = {"invalid": 0, "missing": 0, "missing_weight": 0, "zero_weight": 0,
                  "structural_task_exclusion": 0}
        for r in final_reasons:
            if r in counts:
                counts[r] += 1
        kept_idx = [i for i, r in enumerate(final_reasons) if r == "ok"]
        kept_ids = [ordered_ids[i] for i in kept_idx]
        kept_weights = [weights[i] if weights is not None else None for i in kept_idx] \
            if weights is not None else None
        if weight_spec is not None:
            positive = sum(w for w in (kept_weights or []) if w is not None and w > 0)
            weight_applied = positive > 0
        # Build per-variable observed categories (positive mass only here; zero-mass
        # declared categories are re-added by the caller from codebook order).
        variables: list[dict[str, Any]] = []
        for name in plan.names:
            spec = specs[name]
            vid = id_by_name[name]
            group = group_by_name.get(name)
            order_raw = spec.get("categoryOrder") or []
            missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
            missing_codes.discard(None)
            labels_src = spec.get("valueLabels") or {}
            if group is not None:
                declared = ["0", "1"]
                label_map = {"0": "非選択", "1": "選択"}
            else:
                ordered = [c for c in (normalize_code(v) for v in order_raw)
                           if c is not None and c not in missing_codes]
                if not ordered and labels_src:
                    ordered = [c for c in (normalize_code(k) for k in labels_src.keys()) if c is not None]
                declared = ordered
                label_map = {c: str(labels_src.get(c, c)) for c in declared}
            if missing_policy != "exclude":
                for sentinel, label in ((MISSING_M, "欠損"), (MISSING_NA, "非該当")):
                    if sentinel in [var_codes[name][i] for i in kept_idx] and sentinel not in declared:
                        declared.append(sentinel)
                        label_map[sentinel] = label
            else:
                declared = [c for c in declared if c not in (MISSING_M, MISSING_NA)]
            # Observed positive-mass categories in declared-then-observed order.
            seen: list[Any] = []
            for i in kept_idx:
                code = var_codes[name][i]
                if code is None or code not in declared:
                    if code is not None and code not in declared and code not in seen:
                        # include_missing sentinels already merged; other observed codes
                        # fall back when the codebook declares no closed domain.
                        if not [c for c in declared if not isinstance(c, MissingKey)]:
                            seen.append(code)
                            label_map[code] = str((spec.get("valueLabels") or {}).get(code, code))
                    continue
                if code not in seen:
                    seen.append(code)
            ordered_cats = [c for c in declared if c in seen] + [c for c in seen if c not in declared]
            # Zero-mass declared categories for omittedCategories.
            zero_mass = [c for c in declared if c not in seen]
            cat_entries = []
            for code in ordered_cats:
                rows = [pos for pos, i in enumerate(kept_idx) if var_codes[name][i] == code]
                kind = ("missing" if code == MISSING_M
                        else "not_applicable" if code == MISSING_NA else "value")
                cat_entries.append({
                    "code": code if kind == "value" else code,
                    "kind": kind,
                    "label": label_map.get(code, str(code)),
                    "count": len(rows), "rows": rows})
            for code in zero_mass:
                kind = ("missing" if code == MISSING_M
                        else "not_applicable" if code == MISSING_NA else "value")
                cat_entries.append({
                    "code": code if kind == "value" else code,
                    "kind": kind,
                    "label": label_map.get(code, str(code)),
                    "count": 0, "rows": []})
            variables.append({
                "variableId": vid, "columnName": name,
                "label": spec.get("label") or name,
                "categories": cat_entries,
                "isMaOption": group is not None,
                "maParentId": group["groupId"] if group is not None else None})
        mask_doc = store.load_mask(dataset_id) or {}
        mask_entries = mask_doc.get("entries", []) or []
        try:
            use_col_ids = {specs[n].get("columnId") for n in plan.names} | {specs[n].get("name") for n in plan.names}
        except Exception:
            use_col_ids = set()
        scope_set = set(ordered_ids)
        fit_set = set(kept_ids)
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
        mask_revision = store.mask_revision(dataset_id)
        fingerprint = meta.get("fingerprint")
        return PreparedMcaFrame(
            dataset_id=dataset_id, scope_ids=scope_ids, row_ids=kept_ids,
            variables=variables,
            weights=kept_weights, weight_applied=weight_applied,
            weight_type=weight_type if weight_applied or weight_spec else None,
            weight_column=weight_name, weight_column_id=weight_spec["columnId"] if weight_spec else None,
            exclusions=final_reasons, exclusion_counts=counts,
            scope_count=len(scope_ids), fit_count=len(kept_ids),
            revisions=revisions, mask_revision=mask_revision,
            data_fingerprint=fingerprint,
            imputed_cell_count=len(seen_cells), imputed_row_count=len(imputed_rows),
            ma_diagnostics=ma_diagnostics)


def _numeric_value(raw: Any, spec: dict[str, Any] | None = None) -> tuple[float | None, str]:
    """Return (finite float or None, reason). Non-finite/non-numeric is invalid.

    When a codebook ``spec`` is supplied, its missingCodes are honored first so
    sentinel numerics (e.g. 98/99) become missing, never fitted values. Numeric
    missing always excludes regardless of missingPolicy.
    """
    if isinstance(raw, bool):
        return None, "invalid"
    code = normalize_code(raw)
    if spec is not None:
        missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
        missing_codes.discard(None)
        if code is None or code in missing_codes:
            return None, "missing"
    if raw is None:
        return None, "missing"
    if isinstance(raw, bool):
        return None, "invalid"
    if isinstance(raw, (int, float, np.integer, np.floating)):
        try:
            val = float(raw)
        except (TypeError, ValueError):
            return None, "invalid"
        import math as _math
        if not _math.isfinite(val):
            return None, "invalid"
        return val, "ok"
    if isinstance(raw, str):
        text = raw.strip()
        if text == "":
            return None, "missing"
        try:
            val = float(text)
        except ValueError:
            return None, "invalid"
        import math as _math
        if not _math.isfinite(val):
            return None, "invalid"
        return val, "ok"
    return None, "invalid"


def prepare_famd_frame(
    *,
    dataset_id: str,
    context_dict: dict[str, Any],
    numeric_refs: list[str],
    categorical_refs: list[str],
    store,
) -> PreparedFamdFrame:
    """FAMD-specific shared preprocessing (Feature 031).

    Numeric interval/ratio + categorical nominal/ordinal. MA parents/children,
    weight columns, text/ID columns are rejected as FAMD inputs. A single common
    valid mask is fixed before standardization; numeric missing always excludes.
    """
    import numpy as _np

    from .analysis_columns import resolve_analysis_columns

    if not numeric_refs or not categorical_refs:
        raise BizError("FAMD_MIXED_INPUT_REQUIRED",
                       "数値変数とカテゴリ変数をそれぞれ1列以上指定してください。",
                       status_code=422)
    if len(set(numeric_refs)) != len(numeric_refs):
        raise BizError("ANALYSIS_REQUEST_INVALID", "numericVariables に重複があります。",
                       status_code=422)
    if len(set(categorical_refs)) != len(categorical_refs):
        raise BizError("ANALYSIS_REQUEST_INVALID", "categoricalVariables に重複があります。",
                       status_code=422)
    if set(numeric_refs) & set(categorical_refs):
        raise BizError("ANALYSIS_REQUEST_INVALID",
                       "数値変数とカテゴリ変数に同じ列を指定できません。",
                       status_code=422)
    ctx = context_dict
    scope = ctx.get("scope", "all")
    required = {"active": "activeRowIds", "selected": "selectedRowIds",
                "sampled": "sampledRowIds", "explicit": "rowIds"}.get(scope)
    for name in ("rowIds", "activeRowIds", "selectedRowIds", "sampledRowIds"):
        value = ctx.get(name)
        if name == required and value is None:
            raise BizError("ANALYSIS_REQUEST_INVALID", f"scope={scope} requires {name}",
                           status_code=422)
        if name != required and value is not None:
            raise BizError("ANALYSIS_REQUEST_INVALID", f"{name} is not allowed for scope={scope}",
                           status_code=422)
    if ctx.get("weightMode") == "column" and not ctx.get("weightColumn"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "weightMode=column requires weightColumn",
                       status_code=422)
    if ctx.get("weightMode") != "column" and (ctx.get("weightColumn") is not None or ctx.get("weightType") is not None):
        raise BizError("ANALYSIS_REQUEST_INVALID",
                       "weightColumn/weightType are only allowed with weightMode=column",
                       status_code=422)
    missing_policy = ctx.get("missingPolicy", "exclude")
    if missing_policy not in ("exclude", "include_missing", "separate_not_applicable"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "missingPolicy が不正です。", status_code=422)
    if ctx.get("imputationPolicy", "use_current_values") != "use_current_values":
        raise BizError("ANALYSIS_REQUEST_INVALID", "imputationPolicy は use_current_values のみ対応です。",
                       status_code=422)

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
        try:
            num_plan = resolve_analysis_columns(
                codebook, numeric_refs, scales={"interval", "ratio"})
            cat_plan = resolve_analysis_columns(
                codebook, categorical_refs, scales={"nominal", "ordinal", "binary"},
                allow_ma_options=False)
        except BizError as exc:
            raise BizError("FAMD_SCALE_INVALID", exc.message, status_code=422,
                           details={"columnIds": [*numeric_refs, *categorical_refs]}) from exc
        if num_plan.groups or cat_plan.groups:
            raise BizError("FAMD_MA_UNSUPPORTED",
                           "MA設問はFAMDの入力に指定できません。通常の派生列を事前に作成してください。",
                           status_code=422)
        num_specs = {name: _spec_by_id(codebook, ref) for name, ref in zip(num_plan.names, numeric_refs)}
        cat_specs = {name: _spec_by_id(codebook, ref) for name, ref in zip(cat_plan.names, categorical_refs)}
        num_ids = {name: _spec_by_id(codebook, ref).get("columnId", ref)
                   for name, ref in zip(num_plan.names, numeric_refs)}
        cat_ids = {name: _spec_by_id(codebook, ref).get("columnId", ref)
                   for name, ref in zip(cat_plan.names, categorical_refs)}
        for name, spec in {**num_specs, **cat_specs}.items():
            if spec.get("multiResponseGroup"):
                raise BizError("FAMD_MA_UNSUPPORTED",
                               f"MA設問は指定できません: {name}",
                               status_code=422, details={"columnIds": [name]})
            if (spec.get("role") or "") not in ("question", "attribute"):
                raise BizError("FAMD_SCALE_INVALID", f"対象外の役割です: {name}",
                               status_code=422, details={"columnIds": [name]})
        for name, spec in num_specs.items():
            if (spec.get("scaleType") or "") not in ("interval", "ratio"):
                raise BizError("FAMD_SCALE_INVALID",
                               f"数値変数はinterval/ratioを指定してください: {name}",
                               status_code=422, details={"columnIds": [num_ids[name]]})
        for name, spec in cat_specs.items():
            if (spec.get("scaleType") or "") not in ("nominal", "ordinal", "binary"):
                raise BizError("FAMD_SCALE_INVALID",
                               f"カテゴリ変数はnominal/ordinalを指定してください: {name}",
                               status_code=422, details={"columnIds": [cat_ids[name]]})
        weight_mode, weight_ref = resolve_weight_request(
            codebook, weight_mode=ctx.get("weightMode", "dataset"),
            weight_column=ctx.get("weightColumn"), weight_type=ctx.get("weightType"))
        try:
            from .survey_weight import declared_weight_column_id
            declared_weight_col = declared_weight_column_id(codebook)
        except Exception:
            declared_weight_col = None
        if weight_mode == "dataset" and weight_ref is None and declared_weight_col:
            weight_ref = declared_weight_col
        weight_spec = resolve_weight_column(codebook, weight_ref)
        weight_name = weight_spec["name"] if weight_spec else None
        weight_type = resolve_weight_config(codebook, weight_ref) if weight_spec else None
        if ctx.get("weightType") is not None and weight_type is not None and ctx["weightType"] != weight_type:
            raise BizError("WEIGHT_TYPE_MISMATCH", "weightType が保存済み設定と一致しません。",
                           status_code=422)
        read_cols = ["__rowId__", *dict.fromkeys([*num_plan.names, *cat_plan.names,
                                                  *([weight_name] if weight_name else [])])]
        df = store.get_dataframe(dataset_id, columns=read_cols)
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=dataset_id,
                                 expectedDataRevision=ctx.get("expectedDataRevision"),
                                 expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
                                 scope=scope,  # type: ignore[arg-type]
                                 rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"),
                                 selectedRowIds=ctx.get("selectedRowIds"),
                                 sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = resolve_scope(all_ids, legacy)
        df = df.filter(pl.col("__rowId__").is_in(scope_ids)) if scope_ids else df.filter(
            pl.col("__rowId__").is_in(["__none__"]))
        ordered_ids = [str(v) for v in df["__rowId__"].to_list()]
        raw_num = {name: df[name].to_list() for name in num_plan.names}
        raw_cat = {name: df[name].to_list() for name in cat_plan.names}
        num_vals: dict[str, list[float | None]] = {}
        num_reasons: dict[str, list[str]] = {}
        for name in num_plan.names:
            vals: list[float | None] = []
            reasons: list[str] = []
            for raw in raw_num[name]:
                val, reason = _numeric_value(raw, num_specs[name])
                vals.append(val)
                reasons.append(reason)
            num_vals[name] = vals
            num_reasons[name] = reasons
        cat_codes: dict[str, list[Any]] = {}
        cat_reasons: dict[str, list[str]] = {}
        for name in cat_plan.names:
            spec = cat_specs[name]
            codes: list[Any] = []
            reasons: list[str] = []
            for raw in raw_cat[name]:
                code, kind, reason = _classify_category(raw, spec, missing_policy)
                if code == "__missing__" and kind in ("missing", "not_applicable"):
                    code = MISSING_M
                elif code == "__not_applicable__" and kind in ("missing", "not_applicable"):
                    code = MISSING_NA
                codes.append(code)
                reasons.append(reason)
            cat_codes[name] = codes
            cat_reasons[name] = reasons
        _priority = {"invalid": 0, "missing": 1, "missing_weight": 2, "zero_weight": 3}
        reasons_all = []
        for i in range(len(ordered_ids)):
            best = "ok"
            for name in [*num_plan.names, *cat_plan.names]:
                r = (num_reasons if name in num_reasons else cat_reasons)[name][i]
                if r == "ok":
                    continue
                if best == "ok" or _priority.get(r, 9) < _priority.get(best, 9):
                    best = r
            reasons_all.append(best)
        weights: list[float | None] | None = None
        weight_applied = False
        if weight_spec is not None:
            weights, _missing, has_invalid = extract_weights(df, weight_name or "", weight_spec)
            check_weights_valid(weights, has_invalid)
            validate_weight_semantics(weights, weight_type)
        final_reasons = list(reasons_all)
        if weights is not None:
            for i in range(len(ordered_ids)):
                if final_reasons[i] != "ok":
                    continue
                w = weights[i]
                if w is None:
                    final_reasons[i] = "missing_weight"
                elif w == 0:
                    final_reasons[i] = "zero_weight"
        counts = {"invalid": 0, "missing": 0, "missing_weight": 0, "zero_weight": 0,
                  "structural_task_exclusion": 0}
        for r in final_reasons:
            if r in counts:
                counts[r] += 1
        kept_idx = [i for i, r in enumerate(final_reasons) if r == "ok"]
        kept_ids = [ordered_ids[i] for i in kept_idx]
        kept_weights = [weights[i] if weights is not None else None for i in kept_idx] \
            if weights is not None else None
        if weight_spec is not None:
            positive = sum(w for w in (kept_weights or []) if w is not None and w > 0)
            weight_applied = positive > 0
        kept_num = {name: [num_vals[name][i] for i in kept_idx] for name in num_plan.names}
        kept_cat = {name: [cat_codes[name][i] for i in kept_idx] for name in cat_plan.names}
        # Zero-variance numerics are explicit errors here (checked again on weights).
        for name in num_plan.names:
            vals = [float(v) for v in kept_num[name]]
            if len(vals) >= 2 and _np.var(np.asarray(vals, dtype=float)) <= 0:
                raise BizError("FAMD_CONSTANT_VARIABLE",
                               f"数値変数の分散が0です: {num_specs[name].get('label') or name}",
                               status_code=422, details={"columnIds": [num_ids[name]]})
        variables: list[dict[str, Any]] = []
        for name in cat_plan.names:
            spec = cat_specs[name]
            vid = cat_ids[name]
            order_raw = spec.get("categoryOrder") or []
            missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
            missing_codes.discard(None)
            labels_src = spec.get("valueLabels") or {}
            ordered = [c for c in (normalize_code(v) for v in order_raw)
                       if c is not None and c not in missing_codes]
            # valueLabels alone never closes the domain: labels only decorate.
            declared = ordered
            label_map = {c: str(labels_src.get(c, c)) for c in declared}
            if missing_policy != "exclude":
                for sentinel, label in ((MISSING_M, "欠損"), (MISSING_NA, "非該当")):
                    if sentinel in kept_cat[name] and sentinel not in declared:
                        declared.append(sentinel)
                        label_map[sentinel] = label
            else:
                declared = [c for c in declared if c not in (MISSING_M, MISSING_NA)]
            seen: list[Any] = []
            for code in kept_cat[name]:
                if code is None or code not in declared:
                    if code is not None and code not in declared and code not in seen:
                        if not [c for c in declared if not isinstance(c, MissingKey)]:
                            seen.append(code)
                            label_map[code] = str((spec.get("valueLabels") or {}).get(code, code))
                    continue
                if code not in seen:
                    seen.append(code)
            ordered_cats = [c for c in declared if c in seen] + [c for c in seen if c not in declared]
            if len(ordered_cats) < 2:
                raise BizError("FAMD_CONSTANT_VARIABLE",
                               f"カテゴリ変数の有効水準が1つだけです: {spec.get('label') or name}",
                               status_code=422, details={"columnIds": [vid]})
            zero_mass = [c for c in declared if c not in seen]
            cat_entries = []
            for code in ordered_cats:
                rows = [pos for pos, c in enumerate(kept_cat[name]) if c == code]
                kind = ("missing" if code == MISSING_M
                        else "not_applicable" if code == MISSING_NA else "value")
                cat_entries.append({
                    "code": code if kind == "value" else code,
                    "kind": kind,
                    "label": label_map.get(code, str(code)),
                    "count": len(rows), "rows": rows})
            for code in zero_mass:
                kind = ("missing" if code == MISSING_M
                        else "not_applicable" if code == MISSING_NA else "value")
                cat_entries.append({
                    "code": code if kind == "value" else code,
                    "kind": kind,
                    "label": label_map.get(code, str(code)),
                    "count": 0, "rows": []})
            variables.append({
                "variableId": vid, "columnName": name,
                "label": spec.get("label") or name,
                "categories": cat_entries})
        numeric_ranges = []
        for name in num_plan.names:
            vals = [float(v) for v in kept_num[name]]
            numeric_ranges.append({"min": float(min(vals)), "max": float(max(vals))} if vals else
                                  {"min": float("nan"), "max": float("nan")})
        mask_doc = store.load_mask(dataset_id) or {}
        mask_entries = mask_doc.get("entries", []) or []
        try:
            use_col_ids = ({num_specs[n].get("columnId") for n in num_plan.names}
                           | {num_specs[n].get("name") for n in num_plan.names}
                           | {cat_specs[n].get("columnId") for n in cat_plan.names}
                           | {cat_specs[n].get("name") for n in cat_plan.names})
        except Exception:
            use_col_ids = set()
        scope_set = set(ordered_ids)
        fit_set = set(kept_ids)
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
        mask_revision = store.mask_revision(dataset_id)
        fingerprint = meta.get("fingerprint")
        return PreparedFamdFrame(
            dataset_id=dataset_id, scope_ids=scope_ids, row_ids=kept_ids,
            numeric_names=list(num_plan.names),
            numeric_values=[[num_vals[name][i] for i in kept_idx] for name in num_plan.names],
            numeric_specs=[num_specs[name] for name in num_plan.names],
            numeric_ids=[num_ids[name] for name in num_plan.names],
            variables=variables,
            weights=kept_weights, weight_applied=weight_applied,
            weight_type=weight_type if weight_applied or weight_spec else None,
            weight_column=weight_name, weight_column_id=weight_spec["columnId"] if weight_spec else None,
            exclusions=final_reasons, exclusion_counts=counts,
            scope_count=len(scope_ids), fit_count=len(kept_ids),
            revisions=revisions, mask_revision=mask_revision,
            data_fingerprint=fingerprint,
            imputed_cell_count=len(seen_cells), imputed_row_count=len(imputed_rows),
            numeric_ranges=numeric_ranges)


def _validate_regression_context(ctx: dict[str, Any]) -> tuple[str, str]:
    scope = ctx.get("scope", "all")
    required = {"active": "activeRowIds", "selected": "selectedRowIds",
                "sampled": "sampledRowIds", "explicit": "rowIds"}.get(scope)
    for name in ("rowIds", "activeRowIds", "selectedRowIds", "sampledRowIds"):
        value = ctx.get(name)
        if name == required and value is None:
            raise BizError("ANALYSIS_REQUEST_INVALID", f"scope={scope} requires {name}",
                           status_code=422)
        if name != required and value is not None:
            raise BizError("ANALYSIS_REQUEST_INVALID",
                           f"{name} is not allowed for scope={scope}",
                           status_code=422)
    if ctx.get("weightMode") == "column" and not ctx.get("weightColumn"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "weightMode=column requires weightColumn",
                       status_code=422)
    if ctx.get("weightMode") != "column" and (ctx.get("weightColumn") is not None or ctx.get("weightType") is not None):
        raise BizError("ANALYSIS_REQUEST_INVALID",
                       "weightColumn/weightType are only allowed with weightMode=column",
                       status_code=422)
    missing_policy = ctx.get("missingPolicy", "exclude")
    if missing_policy not in ("exclude", "include_missing", "separate_not_applicable"):
        raise BizError("ANALYSIS_REQUEST_INVALID", "missingPolicy が不正です。", status_code=422)
    if ctx.get("imputationPolicy", "use_current_values") != "use_current_values":
        raise BizError("ANALYSIS_REQUEST_INVALID", "imputationPolicy は use_current_values のみ対応です。",
                       status_code=422)
    return scope, missing_policy


def _regression_weight_block(codebook: dict, ctx: dict[str, Any]):
    from .survey_weight import (
        extract_weights,
        resolve_weight_column,
        resolve_weight_config,
    )
    from .weight_mode import resolve_weight_request

    weight_mode, weight_ref = resolve_weight_request(
        codebook, weight_mode=ctx.get("weightMode", "dataset"),
        weight_column=ctx.get("weightColumn"), weight_type=ctx.get("weightType"))
    try:
        from .survey_weight import declared_weight_column_id
        declared_weight_col = declared_weight_column_id(codebook)
    except Exception:
        declared_weight_col = None
    if weight_mode == "dataset" and weight_ref is None and declared_weight_col:
        weight_ref = declared_weight_col
    weight_spec = resolve_weight_column(codebook, weight_ref)
    weight_name = weight_spec["name"] if weight_spec else None
    weight_type = resolve_weight_config(codebook, weight_ref) if weight_spec else None
    if ctx.get("weightType") is not None and weight_type is not None and ctx["weightType"] != weight_type:
        raise BizError("WEIGHT_TYPE_MISMATCH", "weightType が保存済み設定と一致しません。",
                       status_code=422)
    return weight_spec, weight_name, weight_type


def _regression_mask_counts(store, dataset_id: str, ordered_ids: list[str],
                             kept_ids: list[str], use_col_ids: set[str]) -> tuple[int, int]:
    mask_doc = store.load_mask(dataset_id) or {}
    mask_entries = mask_doc.get("entries", []) or []
    scope_set = set(ordered_ids)
    fit_set = set(kept_ids)
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
    return len(seen_cells), len(imputed_rows)


def prepare_regression_frame(
    *,
    dataset_id: str,
    context_dict: dict[str, Any],
    target_ref: str,
    predictor_specs: list[dict[str, Any]],
    interactions: list[list[str]],
    store,
) -> PreparedRegressionFrame:
    """Feature 032 shared preprocessing (target + structured predictors).

    Target missing always excludes. Numeric predictor missing always
    excludes. Categorical predictors follow missingPolicy categories.
    Weight/design-ID missing rows can never form a complete survey design,
    so they stay in the full design frame but leave the fit. Learning rows
    alone fix category catalogs and reference levels; evaluation rows never
    add levels.
    """
    import numpy as _np

    from .analysis_columns import resolve_analysis_columns

    ctx = context_dict
    scope, missing_policy = _validate_regression_context(ctx)
    pred_ids = [str(p.get("columnId")) for p in predictor_specs]
    if len(set(pred_ids)) != len(pred_ids):
        raise BizError("ANALYSIS_REQUEST_INVALID", "predictors に重複があります。",
                       status_code=422)
    if str(target_ref) in pred_ids:
        raise BizError("LR_TARGET_PREDICTOR_OVERLAP",
                       "目的変数を説明変数に含められません。", status_code=422)
    numeric_refs = [str(p.get("columnId")) for p in predictor_specs if p.get("kind") == "numeric"]
    categorical_refs = [str(p.get("columnId")) for p in predictor_specs if p.get("kind") == "categorical"]
    for p in predictor_specs:
        if p.get("kind") == "numeric":
            if bool(p.get("ordinalAsNumericAcknowledged", False)) != (p.get("score") == "ordered_rank"):
                raise BizError("ANALYSIS_REQUEST_INVALID",
                               "ordered_rank と ordinal acknowledgement は同時に指定してください。",
                               status_code=422)
        elif p.get("kind") == "categorical":
            pass
        else:
            raise BizError("ANALYSIS_REQUEST_INVALID", "predictor kind が不正です。",
                           status_code=422)
    seen_pairs: set[tuple[str, str]] = set()
    for pair in interactions or []:
        if len(pair) != 2 or pair[0] == pair[1] or pair[0] not in pred_ids or pair[1] not in pred_ids:
            raise BizError("LR_INTERACTION_INVALID",
                           "交互作用は採用済み主効果の異なる2変数で指定してください。",
                           status_code=422)
        key = tuple(sorted([str(pair[0]), str(pair[1])]))
        if key in seen_pairs:
            raise BizError("LR_INTERACTION_INVALID", "交互作用に重複があります。",
                           status_code=422)
        seen_pairs.add(key)

    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, ctx.get("expectedSchemaRevision"), ctx.get("expectedDataRevision"))
        try:
            target_plan = resolve_analysis_columns(
                codebook, [target_ref], scales={"interval", "ratio"})
            num_plan = resolve_analysis_columns(
                codebook, numeric_refs or None,
                scales={"interval", "ratio", "ordinal"}) if numeric_refs else None
            cat_plan = resolve_analysis_columns(
                codebook, categorical_refs or None,
                scales={"nominal", "ordinal", "binary"},
                allow_ma_options=False) if categorical_refs else None
        except BizError as exc:
            raise BizError("LR_SCALE_INVALID", exc.message, status_code=422,
                           details={"columnIds": [target_ref, *pred_ids]}) from exc
        if (num_plan and num_plan.groups) or (cat_plan and cat_plan.groups):
            raise BizError("LR_MA_UNSUPPORTED",
                           "MA設問は重回帰の入力に指定できません。",
                           status_code=422)
        target_name = target_plan.names[0]
        target_spec = _spec_by_id(codebook, target_ref)
        target_id = str(target_spec.get("columnId", target_ref))
        if (target_spec.get("scaleType") or "") not in ("interval", "ratio"):
            raise BizError("LR_SCALE_INVALID", "目的変数はinterval/ratioを指定してください。",
                           status_code=422, details={"columnIds": [target_id]})
        if (target_spec.get("role") or "") not in ("question", "attribute"):
            raise BizError("LR_SCALE_INVALID", "対象外の役割です。",
                           status_code=422, details={"columnIds": [target_id]})
        num_specs = {name: _spec_by_id(codebook, ref)
                     for name, ref in zip(num_plan.names, numeric_refs)} if num_plan else {}
        num_ids = {name: str(_spec_by_id(codebook, ref).get("columnId", ref))
                   for name, ref in zip(num_plan.names, numeric_refs)} if num_plan else {}
        cat_specs = {name: _spec_by_id(codebook, ref)
                     for name, ref in zip(cat_plan.names, categorical_refs)} if cat_plan else {}
        cat_ids = {name: str(_spec_by_id(codebook, ref).get("columnId", ref))
                   for name, ref in zip(cat_plan.names, categorical_refs)} if cat_plan else {}
        for name, spec in {**num_specs, **cat_specs}.items():
            if spec.get("multiResponseGroup"):
                raise BizError("LR_MA_UNSUPPORTED", f"MA設問は指定できません: {name}",
                               status_code=422)
            if (spec.get("role") or "") not in ("question", "attribute"):
                raise BizError("LR_SCALE_INVALID", f"対象外の役割です: {name}",
                               status_code=422)
        ordinal_numeric: dict[str, dict[str, Any]] = {}
        for pref in predictor_specs:
            if pref.get("kind") != "numeric":
                continue
            cid = str(pref.get("columnId"))
            name = next((n for n, vid in num_ids.items() if vid == cid), None)
            if name is None:
                # resolve by request order fallback
                name = (num_plan.names[numeric_refs.index(cid)] if num_plan else cid)
            spec = num_specs[name]
            scale = (spec.get("scaleType") or "")
            if scale in ("interval", "ratio"):
                if bool(pref.get("ordinalAsNumericAcknowledged", False)):
                    raise BizError("ANALYSIS_REQUEST_INVALID",
                                   "interval/ratio に ordinal acknowledgement は不要です。",
                                   status_code=422)
                continue
            if scale == "ordinal":
                if not bool(pref.get("ordinalAsNumericAcknowledged", False)):
                    raise BizError("LR_ORDINAL_ACK_REQUIRED",
                                   "ordinal の数値扱いには明示の同意が必要です。",
                                   status_code=422)
                order_raw = spec.get("categoryOrder") or []
                order = [c for c in (normalize_code(v) for v in order_raw) if c is not None]
                missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
                missing_codes.discard(None)
                order = [c for c in order if c not in missing_codes]
                if not order:
                    raise BizError("LR_ORDINAL_ORDER_REQUIRED",
                                   "ordinal の順序が確定していません。",
                                   status_code=422, details={"columnIds": [cid]})
                rank_of = {c: i + 1 for i, c in enumerate(order)}
                ordinal_numeric[name] = {
                    "columnId": cid, "order": order,
                    "reversed": bool(spec.get("isReversed", False)), "rankOf": rank_of,
                }
            else:
                raise BizError("LR_SCALE_INVALID",
                               f"数値説明変数はinterval/ratio/ordinalを指定してください: {name}",
                               status_code=422, details={"columnIds": [cid]})
        # Survey design columns (optional): resolved by columnId/name.
        design_spec = (codebook.get("surveyDesign") or {}) if isinstance(codebook, dict) else {}
        if not isinstance(design_spec, dict):
            design_spec = {}
        if design_spec.get("replicateWeightColumnIds"):
            raise BizError("ANALYSIS_SURVEY_REPLICATE_UNSUPPORTED",
                           "replicate weights には未対応です。", status_code=422)
        weight_spec, weight_name, weight_type = _regression_weight_block(codebook, ctx)

        def _col_name(col_ref: Any) -> str | None:
            if not col_ref:
                return None
            for spec in (codebook.get("columns", []) or []):
                if not isinstance(spec, dict):
                    continue
                if spec.get("columnId") == col_ref or spec.get("name") == col_ref:
                    return spec.get("name")
            return None

        strata_name = _col_name(design_spec.get("strataColumnId"))
        psu_name = _col_name(design_spec.get("psuColumnId"))
        fpc_name = _col_name(design_spec.get("fpcColumnId"))
        read_cols = ["__rowId__", target_name, *dict.fromkeys([
            *(num_plan.names if num_plan else []), *(cat_plan.names if cat_plan else []),
            *([weight_name] if weight_name else []),
            *([strata_name] if strata_name else []),
            *([psu_name] if psu_name else []),
            *([fpc_name] if fpc_name else [])])]
        try:
            df = store.get_dataframe(dataset_id, columns=read_cols)
        except BizError:
            raise
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(datasetId=dataset_id,
                                 expectedDataRevision=ctx.get("expectedDataRevision"),
                                 expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
                                 scope=scope,  # type: ignore[arg-type]
                                 rowIds=ctx.get("rowIds"), activeRowIds=ctx.get("activeRowIds"),
                                 selectedRowIds=ctx.get("selectedRowIds"),
                                 sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = resolve_scope(all_ids, legacy)
        # Full design frame: every dataset row (survey Taylor keeps
        # scope-outside rows as score 0).
        design_ids = list(all_ids)
        raw_all = {name: df[name].to_list() for name in read_cols if name in df.columns}
        raw_target_all = list(raw_all.get(target_name, []))
        raw_num_all = {name: list(raw_all.get(name, [])) for name in (num_plan.names if num_plan else [])}
        raw_cat_all = {name: list(raw_all.get(name, [])) for name in (cat_plan.names if cat_plan else [])}
        df = df.filter(pl.col("__rowId__").is_in(scope_ids)) if scope_ids else df.filter(
            pl.col("__rowId__").is_in(["__none__"]))
        ordered_ids = [str(v) for v in df["__rowId__"].to_list()]
        pos_of_all = {rid: i for i, rid in enumerate(design_ids)}
        scope_pos = [pos_of_all[rid] for rid in ordered_ids]
        raw_target = [raw_target_all[i] for i in scope_pos]
        raw_num = {name: [raw_num_all[name][i] for i in scope_pos]
                   for name in (num_plan.names if num_plan else [])}
        raw_cat = {name: [raw_cat_all[name][i] for i in scope_pos]
                   for name in (cat_plan.names if cat_plan else [])}

        # Target: interval/ratio finite values only; missingCodes honored;
        # missing always excludes.
        target_vals: list[float | None] = []
        target_reasons: list[str] = []
        for raw in raw_target:
            val, reason = _numeric_value(raw, target_spec)
            target_vals.append(val)
            target_reasons.append(reason)
        # Numeric predictors: raw finite or ordinal rank scores.
        num_vals: dict[str, list[float | None]] = {}
        num_reasons: dict[str, list[str]] = {}
        for name in (num_plan.names if num_plan else []):
            spec = num_specs[name]
            ordinal = ordinal_numeric.get(name)
            vals: list[float | None] = []
            reasons: list[str] = []
            missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
            missing_codes.discard(None)
            for raw in raw_num[name]:
                if ordinal is not None:
                    code = normalize_code(raw)
                    if code is None or code in missing_codes:
                        vals.append(None)
                        reasons.append("missing")
                        continue
                    rank = ordinal["rankOf"].get(code)
                    if rank is None:
                        vals.append(None)
                        reasons.append("invalid")
                        continue
                    k = len(ordinal["order"])
                    score = (k + 1 - rank) if ordinal["reversed"] else rank
                    vals.append(float(score))
                    reasons.append("ok")
                    continue
                val, reason = _numeric_value(raw, spec)
                vals.append(val)
                reasons.append(reason)
            num_vals[name] = vals
            num_reasons[name] = reasons
        # Categorical predictors: closed-domain classification.
        cat_codes: dict[str, list[Any]] = {}
        cat_reasons: dict[str, list[str]] = {}
        for name in (cat_plan.names if cat_plan else []):
            spec = cat_specs[name]
            codes: list[Any] = []
            reasons: list[str] = []
            for raw in raw_cat[name]:
                code, kind, reason = _classify_category(raw, spec, missing_policy)
                if code == "__missing__" and kind in ("missing", "not_applicable"):
                    code = MISSING_M
                elif code == "__not_applicable__" and kind in ("missing", "not_applicable"):
                    code = MISSING_NA
                codes.append(code)
                reasons.append(reason)
            cat_codes[name] = codes
            cat_reasons[name] = reasons
        _priority = {"invalid": 0, "missing": 1, "missing_weight": 2, "zero_weight": 3}
        reasons_all: list[str] = []
        for i in range(len(ordered_ids)):
            best = "ok"
            seq = [target_reasons[i]]
            seq += [num_reasons[n][i] for n in (num_plan.names if num_plan else [])]
            seq += [cat_reasons[n][i] for n in (cat_plan.names if cat_plan else [])]
            for r in seq:
                if r == "ok":
                    continue
                if best == "ok" or _priority.get(r, 9) < _priority.get(best, 9):
                    best = r
            reasons_all.append(best)
        weights_full: list[float | None] | None = None
        weight_applied = False
        if weight_spec is not None:
            from .survey_weight import check_weights_valid, extract_weights, validate_weight_semantics
            weights_full, _missing, has_invalid = extract_weights(df, weight_name or "", weight_spec)
            check_weights_valid(weights_full, has_invalid)
            validate_weight_semantics(weights_full, weight_type)
        final_reasons = list(reasons_all)
        if weights_full is not None:
            for i in range(len(ordered_ids)):
                if final_reasons[i] != "ok":
                    continue
                w = weights_full[i]
                if w is None:
                    final_reasons[i] = "missing_weight"
                elif w == 0:
                    final_reasons[i] = "zero_weight"
        counts = {"invalid": 0, "missing": 0, "missing_weight": 0, "zero_weight": 0,
                  "structural_task_exclusion": 0}
        for r in final_reasons:
            if r in counts:
                counts[r] += 1
        kept_idx = [i for i, r in enumerate(final_reasons) if r == "ok"]
        kept_ids = [ordered_ids[i] for i in kept_idx]
        kept_weights = [weights_full[i] if weights_full is not None else None for i in kept_idx] \
            if weights_full is not None else None
        if weight_spec is not None:
            positive = sum(w for w in (kept_weights or []) if w is not None and w > 0)
            weight_applied = positive > 0
        kept_target = [float(target_vals[i]) for i in kept_idx]
        kept_num = {name: [num_vals[name][i] for i in kept_idx]
                    for name in (num_plan.names if num_plan else [])}
        kept_cat = {name: [cat_codes[name][i] for i in kept_idx]
                    for name in (cat_plan.names if cat_plan else [])}
        # Catalogs from learning rows only (codebook order, then observed).
        catalogs: dict[str, CategoryCatalog] = {}
        for name in (cat_plan.names if cat_plan else []):
            spec = cat_specs[name]
            order_raw = spec.get("categoryOrder") or []
            missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
            missing_codes.discard(None)
            ordered = [c for c in (normalize_code(v) for v in order_raw)
                       if c is not None and c not in missing_codes]
            labels_src = spec.get("valueLabels") or {}
            if not ordered and labels_src:
                ordered = [c for c in (normalize_code(k) for k in labels_src.keys()) if c is not None]
            observed = [c for c in dict.fromkeys(kept_cat[name])
                        if c is not None and c not in ordered and c not in (MISSING_M, MISSING_NA)]
            full_order = [*ordered, *observed]
            if missing_policy != "exclude":
                for sentinel in (MISSING_M, MISSING_NA):
                    if sentinel in kept_cat[name] and sentinel not in full_order:
                        full_order.append(sentinel)
            kind_map = {}
            for c in full_order:
                if c == MISSING_M:
                    kind_map[c] = "missing"
                elif c == MISSING_NA:
                    kind_map[c] = "not_applicable"
                else:
                    kind_map[c] = "value"
            label_map = {}
            for c in full_order:
                if c == MISSING_M:
                    label_map[c] = "欠損"
                elif c == MISSING_NA:
                    label_map[c] = "非該当"
                else:
                    label_map[c] = str(labels_src.get(c, c))
            catalogs[name] = CategoryCatalog(variable_id=cat_ids[name], column_name=name,
                                             kind_by_code=kind_map, order=full_order,
                                             labels=label_map)
        # Full design columns (raw reads in dataset order).
        full_weights: list[float | None] = [None] * len(design_ids)
        if weight_spec is not None:
            from .survey_weight import extract_weights as _extract
            df_all = store.get_dataframe(dataset_id, columns=["__rowId__", weight_name]) \
                if weight_name else None
            if df_all is not None:
                by_id_w = {str(r["__rowId__"]): r[weight_name] for r in df_all.rows(named=True)}
                tmp = _extract(pl.DataFrame({weight_name: [by_id_w.get(rid) for rid in design_ids]}),
                               weight_name or "", weight_spec)[0]
                full_weights = list(tmp)
        full_strata = [raw_all.get(strata_name, [None] * len(design_ids))[i]
                       if strata_name else None for i in range(len(design_ids))] \
            if strata_name else None
        full_psu = [raw_all.get(psu_name, [None] * len(design_ids))
                    [i] if psu_name else None for i in range(len(design_ids))] \
            if psu_name else None
        full_fpc = [raw_all.get(fpc_name, [None] * len(design_ids))[i]
                    if fpc_name else None for i in range(len(design_ids))] \
            if fpc_name else None
        fit_pos = [pos_of_all[rid] for rid in kept_ids]
        try:
            use_col_ids = ({target_spec.get("columnId"), target_spec.get("name")}
                           | {num_specs[n].get("columnId") for n in (num_plan.names if num_plan else [])}
                           | {num_specs[n].get("name") for n in (num_plan.names if num_plan else [])}
                           | {cat_specs[n].get("columnId") for n in (cat_plan.names if cat_plan else [])}
                           | {cat_specs[n].get("name") for n in (cat_plan.names if cat_plan else [])})
        except Exception:
            use_col_ids = set()
        use_col_ids = {str(v) for v in use_col_ids if v}
        cell_count, row_count = _regression_mask_counts(store, dataset_id, ordered_ids, kept_ids, use_col_ids)
        mask_revision = store.mask_revision(dataset_id)
        fingerprint = meta.get("fingerprint")
        raw_numeric_inputs = {name: [num_vals[name][i] for i in kept_idx]
                              for name in (num_plan.names if num_plan else [])}
        return PreparedRegressionFrame(
            dataset_id=dataset_id, scope_ids=scope_ids,
            design_row_ids=design_ids, design_strata=full_strata, design_psu=full_psu,
            design_fpc=full_fpc, design_weights_full=full_weights,
            fit_pos_in_design=fit_pos, row_ids=kept_ids,
            target_values=kept_target, target_name=target_name, target_id=target_id,
            numeric_inputs=raw_numeric_inputs, numeric_specs=dict(num_specs),
            numeric_ids=dict(num_ids), numeric_ordinal=dict(ordinal_numeric),
            category_inputs={name: [cat_codes[name][i] for i in kept_idx]
                             for name in (cat_plan.names if cat_plan else [])},
            category_specs=dict(cat_specs), category_ids=dict(cat_ids),
            catalogs=catalogs,
            weights=kept_weights, weight_applied=weight_applied,
            weight_type=weight_type if weight_applied or weight_spec else None,
            weight_column=weight_name, weight_column_id=weight_spec["columnId"] if weight_spec else None,
            exclusions=final_reasons, exclusion_counts=counts,
            scope_count=len(scope_ids), fit_count=len(kept_ids),
            revisions=revisions, mask_revision=mask_revision,
            data_fingerprint=fingerprint,
            imputed_cell_count=cell_count, imputed_row_count=row_count,
        )
