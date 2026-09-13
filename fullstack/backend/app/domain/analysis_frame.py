"""Shared preprocessing for Features 029-034 (production, CA slice).

Steps: revisions -> V2 scope checks -> column plan -> snapshot -> category
domain classification -> weight resolution -> single validMask application.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

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


@dataclass
class CategoryCatalog:
    variable_id: str
    column_name: str
    kind_by_code: dict[str, str]  # normalized code -> 'value'|'missing'|'not_applicable'
    order: list[str]  # normalized codes incl. missing sentinels kept for display
    labels: dict[str, str]


@dataclass
class PreparedAnalysisFrame:
    dataset_id: str
    scope_ids: list[str]
    row_ids: list[str]
    categorical: dict[str, list[str | None]]  # column name -> normalized code or None
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
        codes: dict[str, list[str | None]] = {}
        kinds: dict[str, list[str]] = {}
        reasons: list[str] = ["ok"] * len(ordered_ids)
        for name in names:
            spec = specs[name]
            col_codes: list[str | None] = []
            col_kinds: list[str] = []
            for i, raw in enumerate(raw_cols[name]):
                code, kind, reason = _classify_category(raw, spec, missing_policy)
                col_codes.append(code)
                col_kinds.append(kind)
                if reason != "ok" and reasons[i] == "ok":
                    reasons[i] = reason
            codes[name] = col_codes
            kinds[name] = col_kinds

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
                        and c not in ("__missing__", "__not_applicable__")]
            full_order = [*ordered, *observed]
            if missing_policy != "exclude":
                for sentinel in ("__missing__", "__not_applicable__"):
                    if sentinel in kept_codes[name] and sentinel not in full_order:
                        full_order.append(sentinel)
            kind_map = {c: ("missing" if c == "__missing__"
                            else "not_applicable" if c == "__not_applicable__" else "value")
                        for c in full_order}
            label_map = {}
            for c in full_order:
                if c == "__missing__":
                    label_map[c] = "欠損"
                elif c == "__not_applicable__":
                    label_map[c] = "非該当"
                else:
                    label_map[c] = str(labels_src.get(c, c))
            catalogs[name] = CategoryCatalog(variable_id=id_map[name], column_name=name,
                                             kind_by_code=kind_map, order=full_order,
                                             labels=label_map)
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
        ), unknown_note  # type: ignore[return-value]
