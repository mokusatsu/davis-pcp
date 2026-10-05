"""Independent, unsupervised numeric frame with one frozen complete-case mask."""
from __future__ import annotations

import copy
import math
from dataclasses import dataclass
from typing import Any

import numpy as np
import polars as pl
from .analysis_columns import resolve_analysis_columns
from .codebook_adapter import normalize_code
from .context import AnalysisContext, check_revisions, collect_revisions, resolve_scope
from .errors import BizError
from .portable_regression import normalize_numeric_input
from .sparse_pca_contracts import SparsePcaRequest
from .survey_weight import resolve_weight_column, resolve_weight_config
from .weight_mode import resolve_weight_request


@dataclass(frozen=True)
class PreparedSparsePcaFrame:
    values: np.ndarray
    variables: list[dict[str, Any]]
    excluded_constant_columns: list[dict[str, str]]
    row_ids: list[str]
    scope_ids: list[str]
    exclusion_counts: dict[str, int]
    revisions: dict[str, int]
    mask_revision: int | None
    data_fingerprint: str | None
    imputed_cell_count: int
    imputed_row_count: int

    @property
    def fit_count(self) -> int:
        return len(self.row_ids)


def _err(code, message, **details):
    raise BizError(code, message, status_code=422, details=details)


def require_unweighted(codebook: dict, context: dict) -> None:
    """Explicit none never consults saved weights or survey design columns."""
    mode, ref = resolve_weight_request(codebook, weight_mode=context["weightMode"],
        weight_column=context.get("weightColumn"), weight_type=context.get("weightType"))
    if mode == "none":
        return
    spec = resolve_weight_column(codebook, ref)
    if spec is not None:
        kind = resolve_weight_config(codebook, ref)
        if context.get("weightType") is not None and context["weightType"] != kind:
            _err("WEIGHT_TYPE_MISMATCH", "weightType が保存済み設定と一致しません。")
    if mode == "column" or spec is not None:
        _err("SPCA_WEIGHT_UNSUPPORTED", "SparsePCAは調査・頻度ウェイトに未対応です。明示的に非加重を選択してください。")


def _descriptor(spec, variable):
    return {"columnId": spec["columnId"], "name": spec["name"],
        "label": spec.get("label") or spec["name"], "scaleType": spec["scaleType"],
        "missingCodes": [s for v in (spec.get("missingCodes") or []) if (s := normalize_code(v)) is not None],
        "valueLabels": {str(k): str(v) for k, v in (spec.get("valueLabels") or {}).items()},
        "categoryOrder": [s for v in (spec.get("categoryOrder") or []) if (s := normalize_code(v)) is not None],
        "isReversed": bool(spec.get("isReversed", False)),
        "ordinalAsNumericAcknowledged": variable.ordinalAsNumericAcknowledged,
        "score": variable.score}


def _convert(raw, spec):
    if isinstance(raw, bool):
        return None, "invalid"
    code = normalize_code(raw)
    if raw is None or code is None or code in spec["missingCodes"] or (isinstance(raw, str) and not raw.strip()):
        return None, "missing"
    if spec["categoryOrder"] and code not in spec["categoryOrder"]:
        return None, "invalid"
    if spec["scaleType"] == "ordinal":
        order = [v for v in spec["categoryOrder"] if v not in spec["missingCodes"]]
        if code not in order:
            return None, "invalid"
        pos = order.index(code)
        return float(len(order) - pos if spec["isReversed"] else pos + 1), "ok"
    value, reason = normalize_numeric_input(raw, spec["missingCodes"])
    if reason:
        return None, "missing" if reason == "missing_value" else "invalid"
    if spec["isReversed"]:
        domain = [v for v in spec["categoryOrder"] if v not in spec["missingCodes"]]
        if code not in domain:
            return None, "invalid"
        ends = [normalize_numeric_input(v, [])[0] for v in domain]
        if any(v is None for v in ends):
            _err("SPCA_REVERSE_DOMAIN_INVALID", "逆転項目のcategoryOrderには有限の数値が必要です。")
        lo, hi = min(ends), max(ends)
        # Sum in original units with compensation, cancelling the endpoint
        # with the observed value first. This preserves one-ULP scale steps at
        # large offsets and avoids an overflowing lo+hi intermediate.
        terms = (lo, -value, hi) if value < 0 else (hi, -value, lo)
        try:
            value = math.fsum(terms)
        except OverflowError:
            _err("SPCA_NUMERIC_RANGE", "逆転値が数値表現範囲を超えました。", stage="reverse")
        if not math.isfinite(value):
            _err("SPCA_NUMERIC_RANGE", "逆転値が数値表現範囲を超えました。", stage="reverse")
    return value, "ok"


def prepare_sparse_pca_frame(req: SparsePcaRequest, *, meta: dict, codebook: dict,
                             data, mask: dict, mask_revision: int | None) -> PreparedSparsePcaFrame:
    ctx = req.context.model_dump()
    revisions = collect_revisions(meta, codebook)
    check_revisions(revisions, ctx["expectedSchemaRevision"], ctx["expectedDataRevision"])
    require_unweighted(codebook, ctx)
    refs = [v.columnId for v in req.variables]
    specs = {v["columnId"]: v for v in codebook.get("columns", [])}
    if any(v not in specs for v in refs):
        _err("SPCA_COLUMN_NOT_FOUND", "指定されたcolumnIdが見つかりません。")
    try:
        resolve_analysis_columns(codebook, refs, scales={"interval", "ratio", "ordinal"})
    except BizError as exc:
        _err("SPCA_SCALE_INVALID", exc.message, columnIds=refs)
    descriptors = []
    for var in req.variables:
        spec = specs[var.columnId]
        if spec["name"] not in data.columns:
            _err("SPCA_COLUMN_NOT_FOUND", "分析値の列が見つかりません。")
        if spec["scaleType"] == "ordinal":
            if not var.ordinalAsNumericAcknowledged or var.score != "ordered_rank":
                _err("SPCA_ORDINAL_ACK_REQUIRED", "順序尺度の固定順位得点化への承認が必要です。")
        elif var.ordinalAsNumericAcknowledged or var.score is not None:
            _err("SPCA_ORDINAL_ACK_INVALID", "順序尺度以外には順位得点化を指定できません。")
        descriptor = _descriptor(spec, var)
        domain = [v for v in descriptor["categoryOrder"] if v not in descriptor["missingCodes"]]
        if spec["scaleType"] == "ordinal" or descriptor["isReversed"]:
            if not domain or len(set(domain)) != len(domain):
                _err("ORDINAL_ORDER_REQUIRED" if spec["scaleType"] == "ordinal" else "CODEBOOK_REVERSE_RANGE_MISSING",
                     "順位得点化・逆転には重複のない固定categoryOrderが必要です。")
        descriptors.append(descriptor)
    all_ids = [str(v) for v in data["__rowId__"].to_list()]
    scope_ids = resolve_scope(all_ids, AnalysisContext(**ctx))
    # Convert only the selected immutable view to Python records. A tiny scope
    # on a large dataset must not materialize every raw row as Python objects.
    scoped_data = data.select(["__rowId__", *[v["name"] for v in descriptors]]).filter(
        pl.col("__rowId__").is_in(scope_ids))
    by_id = {str(row["__rowId__"]): row for row in scoped_data.to_dicts()}
    counts = dict.fromkeys(("invalid", "missing", "missing_weight", "zero_weight", "structural_task_exclusion"), 0)
    values, kept_ids = [], []
    for rid in scope_ids:
        row = by_id[rid]
        converted = [_convert(row[d["name"]], d) for d in descriptors]
        reasons = {reason for _, reason in converted}
        reason = "invalid" if "invalid" in reasons else "missing" if "missing" in reasons else "ok"
        if reason == "ok":
            values.append([value for value, _ in converted]); kept_ids.append(rid)
        else:
            counts[reason] += 1
    if len(kept_ids) < 2:
        _err("SPCA_INSUFFICIENT_ROWS", "共通有効行が2行以上必要です。", fitCount=len(kept_ids), exclusionCounts=counts)
    array = np.asarray(values, dtype=np.float64)
    constant = np.all(array == array[0], axis=0)
    excluded = [{key: d[key] for key in ("columnId", "name", "label")}
                for d, drop in zip(descriptors, constant) if drop]
    if bool(constant.all()):
        _err("SPCA_ALL_CONSTANT", "共通有効行ではすべての変数が定数です。")
    array = array[:, ~constant].copy()
    array.setflags(write=False)
    kept_variables = [d for d, drop in zip(descriptors, constant) if not drop]
    upper = min(array.shape[0] - 1, array.shape[1])
    if req.nComponents > upper:
        _err("SPCA_COMPONENTS_INVALID", "共通有効行・定数列除外後の成分数上限を超えています。", maximum=upper)
    fit_set, selected_columns = set(kept_ids), set(refs)
    imputed = {(str(e.get("rowId")), str(e.get("columnId")))
               for e in (mask.get("entries") or []) if isinstance(e, dict)
               and str(e.get("rowId")) in fit_set and str(e.get("columnId")) in selected_columns}
    return PreparedSparsePcaFrame(array, copy.deepcopy(kept_variables), excluded, kept_ids, scope_ids,
        counts, revisions, mask_revision, meta.get("fingerprint"), len(imputed), len({r for r, _ in imputed}))
