"""Conjoint data validation + estimation orchestration (Feature 034, production).

Implements DAVIS-FEAT-034-DESIGN sections 2-9 on top of the shared
context/codebook/weight/survey-Taylor helpers. Thin by design: numeric work
delegates to algorithms/models/conjoint_* kernels (ratings reuses the
Feature 032 pure WLS core; choice/ranking share the stage kernel).
"""
from __future__ import annotations

import hashlib
import json
import math
from typing import Any

import numpy as np
import polars as pl
from scipy import stats

from ..algorithms.models import conjoint_choice as _choice
from ..algorithms.models import conjoint_covariance as _cov
from ..algorithms.models import conjoint_encoding as _enc
from ..algorithms.models import conjoint_ratings as _ratings
from ..algorithms.models import conjoint_simulation as _sim
from ..algorithms.survey.model_covariance import build_regression_design_frame
from ..domain.analysis_frame import _regression_weight_block  # noqa: SLF001 (shared helper)
from ..domain.analysis_frame import _validate_regression_context  # noqa: SLF001 (shared helper)
from ..domain.codebook_adapter import normalize_code
from ..domain.context import check_revisions, collect_revisions, resolve_scope
from ..domain.context import AnalysisContext, scope_hash
from ..domain.errors import BizError

ALGORITHM_VERSION = "davis.conjoint.1.0.0"
SCHEMA_VERSION = "analysis-result/1.0"


def _err(code: str, msg: str, status: int = 422, details: dict | None = None):
    raise BizError(code, msg, status_code=status, details=details or {})


def _codebook_scale(codebook: dict, ref: str) -> str | None:
    for spec in (codebook.get("columns", []) or []):
        if isinstance(spec, dict) and (
                spec.get("columnId") == ref or spec.get("name") == ref):
            return spec.get("scaleType")
    return None


def _col_name(codebook: dict, ref: Any) -> str | None:
    if not ref:
        return None
    for spec in (codebook.get("columns", []) or []):
        if not isinstance(spec, dict):
            continue
        if spec.get("columnId") == ref or spec.get("name") == ref:
            return spec.get("name")
    return None


def _parse_bool_cell(raw: Any, *, allow_missing: bool = False) -> bool | None:
    """Spec 2.1-3: availability/optOut accept boolean, 0/1, '0'/'1' only."""
    if raw is None:
        return None if allow_missing else None
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        if raw == 1:
            return True
        if raw == 0:
            return False
        _err("CONJOINT_INVALID_AVAILABILITY",
             "availability/opt-out は boolean・0/1 のみ受け付けます。", 422)
    if isinstance(raw, str):
        s = raw.strip()
        if s in ("1", "true", "True", "TRUE"):
            return True
        if s in ("0", "false", "False", "FALSE"):
            return False
        _err("CONJOINT_INVALID_AVAILABILITY",
             "availability/opt-out は boolean・0/1 のみ受け付けます。", 422)
    _err("CONJOINT_INVALID_AVAILABILITY",
         "availability/opt-out は boolean・0/1 のみ受け付けます。", 422)
    return None


def prepare_conjoint_frame(
    *,
    dataset_id: str,
    context_dict: dict[str, Any],
    mode: str,
    columns: dict[str, Any],
    attributes: list[dict[str, Any]],
    store,
) -> dict[str, Any]:
    """Validate scope/ids/attributes and return the analysis frame dict."""
    ctx = context_dict
    scope, missing_policy = _validate_regression_context(ctx)
    if missing_policy != "exclude":
        _err("ANALYSIS_REQUEST_INVALID",
             "conjoint は missingPolicy=exclude のみ対応です。", 422)
    attr_ids = [str(a.get("columnId")) for a in attributes]
    if len(set(attr_ids)) != len(attr_ids):
        _err("ANALYSIS_REQUEST_INVALID", "attributes に重複があります。", 422)
    mapped = {str(v) for v in columns.values() if v is not None}
    if mapped & set(attr_ids):
        _err("CONJOINT_MAPPING_ATTRIBUTE_OVERLAP",
             "mapping列と属性列を重複使用できません。", 422)
    with store.lock(dataset_id):
        meta = store.get_meta(dataset_id)
        codebook = store.load_codebook(dataset_id) or {}
        revisions = collect_revisions(meta, codebook)
        check_revisions(revisions, ctx.get("expectedSchemaRevision"),
                        ctx.get("expectedDataRevision"))
        # Attribute scale validation.
        for attr in attributes:
            cid, kind = str(attr.get("columnId")), str(attr.get("kind"))
            scale = _codebook_scale(codebook, cid)
            if kind == "categorical" and scale not in ("nominal", "ordinal", "binary"):
                _err("CONJOINT_SCALE_INVALID",
                     f"カテゴリ属性は nominal/ordinal を指定してください: {cid}", 422,
                     {"columnIds": [cid]})
            if kind == "linear" and scale not in ("interval", "ratio"):
                _err("CONJOINT_SCALE_INVALID",
                     f"線形属性は interval/ratio を指定してください: {cid}", 422,
                     {"columnIds": [cid]})
        # Replicate weights need a declared type; survey design extras.
        design_spec = (codebook.get("surveyDesign") or {}) \
            if isinstance(codebook, dict) else {}
        if not isinstance(design_spec, dict):
            design_spec = {}
        if design_spec.get("replicateWeightColumnIds"):
            _err("ANALYSIS_SURVEY_REPLICATE_UNSUPPORTED",
                 "replicate weights には未対応です。", 422)
        weight_spec, weight_name, weight_type = _regression_weight_block(codebook, ctx)
        strata_name = _col_name(codebook, design_spec.get("strataColumnId"))
        psu_name = _col_name(codebook, design_spec.get("psuColumnId"))
        fpc_name = _col_name(codebook, design_spec.get("fpcColumnId"))

        id_names = {}
        for key in ("respondentId", "taskId", "alternativeId"):
            nm = _col_name(codebook, columns.get(key))
            if nm is None:
                _err("CONJOINT_COLUMN_UNRESOLVED",
                     f"列を解決できません: {columns.get(key)}", 422,
                     {"columnIds": [str(columns.get(key))]})
            id_names[key] = nm
        resp_name = _col_name(codebook, columns.get("response"))
        if resp_name is None:
            _err("CONJOINT_COLUMN_UNRESOLVED",
                 f"列を解決できません: {columns.get('response')}", 422)
        avail_name = _col_name(codebook, columns.get("availability")) \
            if columns.get("availability") else None
        opt_name = _col_name(codebook, columns.get("optOutIndicator")) \
            if columns.get("optOutIndicator") else None
        attr_names = {}
        for cid in attr_ids:
            nm = _col_name(codebook, cid)
            if nm is None:
                _err("CONJOINT_COLUMN_UNRESOLVED",
                     f"列を解決できません: {cid}", 422, {"columnIds": [cid]})
            attr_names[cid] = nm
        read_cols = ["__rowId__", id_names["respondentId"],
                     id_names["taskId"], id_names["alternativeId"],
                     resp_name, *[attr_names[c] for c in attr_ids]]
        for extra in (avail_name, opt_name, weight_name, strata_name,
                      psu_name, fpc_name):
            if extra:
                read_cols.append(extra)
        read_cols = list(dict.fromkeys(read_cols))
        try:
            df = store.get_dataframe(dataset_id, columns=read_cols)
        except BizError:
            raise
        all_ids = [str(v) for v in df["__rowId__"].to_list()]
        legacy = AnalysisContext(
            datasetId=dataset_id,
            expectedDataRevision=ctx.get("expectedDataRevision"),
            expectedSchemaRevision=ctx.get("expectedSchemaRevision"),
            scope=scope, rowIds=ctx.get("rowIds"),
            activeRowIds=ctx.get("activeRowIds"),
            selectedRowIds=ctx.get("selectedRowIds"),
            sampledRowIds=ctx.get("sampledRowIds"))
        scope_ids = resolve_scope(all_ids, legacy)
        scope_list = list(scope_ids)
        raw_all = {c: df[c].to_list() for c in read_cols if c in df.columns}
        full_order = list(all_ids)
        pos_of = {rid: i for i, rid in enumerate(full_order)}
        scope_pos = [pos_of[r] for r in scope_list]

        def col_all(name: str | None) -> list:
            if name is None:
                return [None] * len(full_order)
            return list(raw_all.get(name, [None] * len(full_order)))

        r_resp = col_all(id_names["respondentId"])
        r_task = col_all(id_names["taskId"])
        r_alt = col_all(id_names["alternativeId"])
        r_y = col_all(resp_name)
        r_avail = col_all(avail_name)
        r_opt = col_all(opt_name)
        r_w = col_all(weight_name)
        r_attr = {cid: col_all(attr_names[cid]) for cid in attr_ids}

        # ---- Full-task index for partial-task validation (before exclusions).
        task_members: dict[tuple[str, str], list[int]] = {}
        for i in range(len(full_order)):
            rr, tt = r_resp[i], r_task[i]
            if rr is None or tt is None or (isinstance(rr, float) and not math.isfinite(rr)):
                continue
            key = (str(rr), str(tt))
            task_members.setdefault(key, []).append(i)
        scope_set = set(scope_list)
        scope_pos_set = set(scope_pos)
        if mode in ("choice", "ranking"):
            touched: set[tuple[str, str]] = set()
            for p in scope_pos:
                key = (str(r_resp[p]), str(r_task[p]))
                touched.add(key)
            partial: list[list[str]] = []
            for key in sorted(touched):
                members = task_members.get(key, [])
                missing = [full_order[i] for i in members if i not in scope_pos_set]
                if missing:
                    partial.append([str(key[0]), str(key[1])])
                    if len(partial) >= 20:
                        break
            if partial:
                _err("CONJOINT_PARTIAL_TASK",
                     "選択に含まれるタスク全体を対象にしてください。", 422,
                     {"tasks": partial,
                      "hint": "expand-scope でタスク全体へ拡張できます。"})
        # ---- Per-row validation inside scope.
        # Task scope rows: same task's raw rows (for availability of full set).
        rows: list[dict[str, Any]] = []
        seen_task_alt: set[tuple[str, str, str]] = set()
        for p in scope_pos:
            rid = full_order[p]
            rr, tt, aa = r_resp[p], r_task[p], r_alt[p]
            if rr is None or tt is None or aa is None or str(rr) == "" \
                    or str(tt) == "" or str(aa) == "":
                _err("CONJOINT_INVALID_ID",
                     "respondentId/taskId/alternativeId に欠損があります。", 422,
                     {"rowIds": [rid]})
            key = (str(rr), str(tt), str(aa))
            if key in seen_task_alt:
                _err("CONJOINT_DUPLICATE_ALTERNATIVE",
                     "タスク内で alternativeId が重複しています。", 422,
                     {"tasks": [[str(rr), str(tt)]]})
            seen_task_alt.add(key)
            avail = _parse_bool_cell(r_avail[p], allow_missing=True)
            if avail is None:
                avail = True
            opt = _parse_bool_cell(r_opt[p], allow_missing=True)
            opt = bool(opt) if opt is not None else False
            if mode == "ratings" and columns.get("optOutIndicator"):
                _err("ANALYSIS_REQUEST_INVALID",
                     "ratings では opt-out を指定できません。", 422)
            rows.append({
                "rowId": rid, "pos": p,
                "respondentId": str(rr), "taskId": str(tt),
                "alternativeId": str(aa),
                "rawResponse": r_y[p], "available": avail,
                "optOut": opt,
                "rawAttrs": {cid: r_attr[cid][p] for cid in attr_ids},
                "rawWeight": r_w[p],
            })
        # Respondent weight/design consistency incl. scope-outside rows.
        resp_weight_vals: dict[str, set[str]] = {}
        for i in range(len(full_order)):
            if r_resp[i] is None:
                continue
            resp_weight_vals.setdefault(str(r_resp[i]), set()).add(repr(r_w[i]))
        # (checked after weight parsing below)
        return {
            "rows": rows, "scopeIds": scope_list, "fullOrder": full_order,
            "revisions": revisions, "meta": meta, "codebook": codebook,
            "weightSpec": weight_spec, "weightName": weight_name,
            "weightType": weight_type if weight_name else None,
            "weightApplied": weight_name is not None,
            "strataName": strata_name, "psuName": psu_name,
            "fpcName": fpc_name,
            "rawAll": {"respondent": r_resp, "task": r_task,
                       "weight": r_w,
                       "strata": col_all(strata_name),
                       "psu": col_all(psu_name), "fpc": col_all(fpc_name)},
            "respWeightRepr": resp_weight_vals,
            "idNames": id_names, "respName": resp_name,
            "attrNames": attr_names,
        }


def _parse_weight_value(raw, weight_type):
    if raw is None:
        return None
    if isinstance(raw, bool):
        _err("CONJOINT_WEIGHT_INVALID",
             "ウェイト列に真偽値が含まれています。", 422)
    try:
        if isinstance(raw, str) and raw.strip() == "":
            _err("CONJOINT_WEIGHT_INVALID",
                 "ウェイト列に空文字が含まれています。", 422)
        value = float(raw)
    except (TypeError, ValueError):
        _err("CONJOINT_WEIGHT_INVALID",
             "ウェイト列に変換不能値が含まれています。", 422)
    if not math.isfinite(value) or value < 0:
        _err("CONJOINT_WEIGHT_INVALID",
             "ウェイトは非負有限値である必要があります。", 422)
    if weight_type == "frequency" and abs(value - round(value)) > 1e-9:
        _err("WEIGHT_FREQUENCY_NONINTEGER",
             "頻度ウェイトには非負整数を指定してください。", 422)
    return float(value)


def resolve_conjoint_weights(frame):
    raw_all_w = frame["rawAll"]["weight"]
    raw_all_r = frame["rawAll"]["respondent"]
    full_order = frame["fullOrder"]
    weight_applied = frame["weightApplied"]
    weight_type = frame["weightType"]
    per_resp = {}
    for i, rid in enumerate(full_order):
        rr = raw_all_r[i]
        if rr is None:
            continue
        per_resp.setdefault(str(rr), []).append(raw_all_w[i])
    respondent_weight = {}
    respondent_flag = {}
    if not weight_applied:
        for resp in per_resp:
            respondent_weight[resp] = 1.0
            respondent_flag[resp] = None
    else:
        for resp, vals in per_resp.items():
            parsed = [_parse_weight_value(raw, weight_type) for raw in vals]
            present = [v for v in parsed if v is not None]
            if any(v is None for v in parsed) and present:
                respondent_weight[resp] = None
                respondent_flag[resp] = "missing_weight"
                continue
            if not present:
                respondent_weight[resp] = None
                respondent_flag[resp] = "missing_weight"
                continue
            first = present[0]
            if any(v != first for v in present):
                _err("CONJOINT_RESPONDENT_WEIGHT_CONFLICT",
                     "同じ回答者のウェイトが一致しません。", 422,
                     {"respondentIds": [resp]})
            respondent_weight[resp] = float(first)
            respondent_flag[resp] = "zero_weight" if first == 0 else None
    for key, label in (("strata", "層"), ("psu", "PSU"), ("fpc", "FPC")):
        col = frame["rawAll"][key]
        if all(v is None for v in col):
            continue
        per = {}
        for i in range(len(full_order)):
            rr = raw_all_r[i]
            if rr is None or col[i] is None:
                continue
            per.setdefault(str(rr), set()).add(repr(col[i]))
        bad = sorted([r for r, s in per.items() if len(s) > 1])[:20]
        if bad:
            _err("CONJOINT_RESPONDENT_DESIGN_CONFLICT",
                 "同じ回答者の%sが一致しません。" % label, 422,
                 {"respondentIds": bad})
    return {"respondentWeight": respondent_weight,
            "respondentFlag": respondent_flag}


def _category_domain(codebook, column_id):
    for spec in (codebook.get("columns", []) or []):
        if isinstance(spec, dict) and spec.get("columnId") == column_id:
            order = [normalize_code(v) for v in (spec.get("categoryOrder") or [])]
            order = [v for v in order if v is not None]
            missing = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
            missing.discard(None)
            labels = dict(spec.get("valueLabels") or {})
            return {"order": order, "missing": missing, "labels": labels,
                    "label": spec.get("label") or column_id}
    return {"order": [], "missing": set(), "labels": {}, "label": column_id}


def _classify_attr_value(kind, raw, domain):
    if kind == "linear":
        if raw is None:
            return None, "missing"
        if isinstance(raw, bool):
            return None, "invalid"
        try:
            v = float(raw)
        except (TypeError, ValueError):
            return None, "invalid"
        if not math.isfinite(v):
            return None, "invalid"
        return v, "ok"
    code = normalize_code(raw)
    if code is None:
        return None, "missing"
    if code in domain["missing"]:
        return None, "missing"
    closed = [c for c in domain["order"] if c not in domain["missing"]]
    if closed and code not in closed:
        return None, "invalid"
    return code, "ok"


def _parse_response(mode, raw):
    if raw is None:
        return None, "missing"
    if mode == "ratings":
        if isinstance(raw, bool):
            return None, "invalid"
        try:
            v = float(raw)
        except (TypeError, ValueError):
            return None, "invalid"
        if not math.isfinite(v):
            return None, "invalid"
        return v, "ok"
    if mode == "choice":
        if isinstance(raw, bool):
            return (1 if raw else 0), "ok"
        if isinstance(raw, (int, float)):
            if raw == 1:
                return 1, "ok"
            if raw == 0:
                return 0, "ok"
            return None, "invalid"
        if isinstance(raw, str):
            s = raw.strip()
            if s == "1":
                return 1, "ok"
            if s == "0":
                return 0, "ok"
            return None, "invalid"
        return None, "invalid"
    if isinstance(raw, bool):
        return None, "invalid"
    if isinstance(raw, float):
        if raw.is_integer() and raw >= 1:
            return int(raw), "ok"
        return None, "invalid"
    if isinstance(raw, int):
        if raw >= 1:
            return raw, "ok"
        return None, "invalid"
    if isinstance(raw, str):
        s = raw.strip()
        if s.isdigit() and int(s) >= 1:
            return int(s), "ok"
        return None, "invalid"
    return None, "invalid"


def finalize_fit_inputs(frame, mode, columns, attributes, weights):
    rows = frame["rows"]
    codebook = frame["codebook"]
    resp_weight = weights["respondentWeight"]
    resp_flag = weights["respondentFlag"]
    domains = {str(a["columnId"]): _category_domain(codebook, str(a["columnId"]))
               for a in attributes if str(a.get("kind")) == "categorical"}
    has_opt = columns.get("optOutIndicator") is not None
    exclusions = {}
    aux_counts = {"availability_excluded": 0}
    warnings = []
    for row in rows:
        rid = row["rowId"]
        resp = row["respondentId"]
        flag = resp_flag.get(resp)
        if flag in ("missing_weight", "zero_weight"):
            exclusions[rid] = flag
            continue
        w = resp_weight.get(resp)
        if w is None:
            exclusions[rid] = "missing_weight"
            continue
        if w == 0:
            exclusions[rid] = "zero_weight"
            continue
        y, y_status = _parse_response(mode, row["rawResponse"])
        row["responseValue"] = y
        row["responseStatus"] = y_status
        if y_status == "invalid":
            if mode == "ratings":
                exclusions[rid] = "invalid"
                continue
            _err("CONJOINT_INVALID_RESPONSE",
                 "response が不正です。", 422, {"rowIds": [rid]})
        attr_status = {}
        attr_vals = {}
        is_opt = bool(row["optOut"]) and has_opt
        for attr in attributes:
            cid = str(attr["columnId"])
            kind = str(attr.get("kind"))
            if is_opt:
                raw = row["rawAttrs"].get(cid)
                if raw is not None:
                    warnings.append({"code": "CONJOINT_OPTOUT_ATTR_IGNORED",
                                     "message": "opt-out 行の属性値を無視しました。",
                                     "count": 1, "columnIds": [cid]})
                attr_status[cid] = "optout_ignored"
                attr_vals[cid] = None
                continue
            val, st = _classify_attr_value(
                kind, row["rawAttrs"].get(cid), domains.get(cid, {}))
            attr_status[cid] = st
            attr_vals[cid] = val
        row["attrStatus"] = attr_status
        row["attrValues"] = attr_vals
        if mode == "ratings":
            bad = [c for c, s in attr_status.items() if s == "invalid"]
            miss = [c for c, s in attr_status.items() if s == "missing"]
            if bad:
                exclusions[rid] = "invalid"
                continue
            if y_status == "missing" or miss:
                exclusions[rid] = "missing"
                continue
    tasks = []
    respondent_ids = []
    if mode == "ratings":
        seen = set()
        for r in rows:
            if r["respondentId"] not in seen:
                seen.add(r["respondentId"])
                respondent_ids.append(r["respondentId"])
    else:
        by_task = {}
        for r in rows:
            by_task.setdefault((r["respondentId"], r["taskId"]), []).append(r)
        for (resp, task) in sorted(by_task.keys()):
            members = by_task[(resp, task)]
            for m in members:
                if not m["available"]:
                    mstat = m.get("responseStatus")
                    mval = m.get("responseValue")
                    if mode == "choice" and mstat == "ok" and mval == 1:
                        _err("CONJOINT_UNAVAILABLE_CHOSEN",
                             "利用不可の代替案が選択されています。", 422,
                             {"rowIds": [m["rowId"]]})
                    if mode == "ranking" and mstat == "ok":
                        _err("CONJOINT_UNAVAILABLE_RANKED",
                             "利用不可の代替案に順位があります。", 422,
                             {"rowIds": [m["rowId"]]})
            cand = [m for m in members if m["available"]]
            aux_counts["availability_excluded"] += len(members) - len(cand)
            if len(cand) < 2:
                _err("CONJOINT_TOO_FEW_ALTERNATIVES",
                     "利用可能な代替案が2つ以上必要です。", 422,
                     {"tasks": [[resp, task]]})
            opt_rows = [m for m in cand if m["optOut"] and has_opt]
            if len(opt_rows) > 1:
                _err("CONJOINT_MULTIPLE_OPTOUT",
                     "1タスクの opt-out は最大1件です。", 422,
                     {"tasks": [[resp, task]]})
            task_bad_invalid = False
            task_missing = False
            for m in cand:
                if m["rowId"] in exclusions:
                    why = exclusions[m["rowId"]]
                    if why in ("missing_weight", "zero_weight"):
                        task_missing = True
                        break
                    continue
                if m.get("responseStatus") == "missing":
                    task_missing = True
                    break
                for cid, st in (m.get("attrStatus") or {}).items():
                    if st == "invalid":
                        task_bad_invalid = True
                        break
                    if st == "missing":
                        task_missing = True
                        break
                if task_bad_invalid or task_missing:
                    break
            if task_bad_invalid:
                _err("CONJOINT_INVALID_ATTRIBUTE",
                     "属性に不正なコードがあります。", 422,
                     {"tasks": [[resp, task]]})
            if task_missing:
                for m in cand:
                    if m["rowId"] not in exclusions:
                        exclusions[m["rowId"]] = "structural_task_exclusion"
                continue
            if mode == "choice":
                chosen = [m for m in cand
                          if m.get("responseStatus") == "ok"
                          and m.get("responseValue") == 1]
                if len(chosen) != 1:
                    _err("CONJOINT_INVALID_RESPONSE",
                         "choice はタスク内で選択1件が必要です。", 422,
                         {"tasks": [[resp, task]]})
            else:
                ranks = [m.get("responseValue") for m in cand
                         if m.get("responseStatus") == "ok"]
                if len(ranks) != len(cand):
                    for m in cand:
                        if m["rowId"] not in exclusions:
                            exclusions[m["rowId"]] = "structural_task_exclusion"
                    continue
                if sorted(ranks) != list(range(1, len(cand) + 1)):
                    _err("CONJOINT_INVALID_RESPONSE",
                         "ranking は 1..J の完全順位が必要です。", 422,
                         {"tasks": [[resp, task]]})
            for m in cand:
                m["chosen"] = (mode == "choice" and m.get("responseStatus") == "ok"
                               and m.get("responseValue") == 1)
                if mode == "ranking":
                    m["rank"] = int(m.get("responseValue"))
            tasks.append({"respondentId": resp, "taskId": task,
                          "rows": cand,
                          "respondentWeight": float(resp_weight.get(resp) or 0.0)})
            if resp not in respondent_ids:
                respondent_ids.append(resp)
    catalog = {}
    omitted_levels = []
    fit_set = {r["rowId"] for r in rows if r["rowId"] not in exclusions}
    for attr in attributes:
        if str(attr.get("kind")) != "categorical":
            continue
        cid = str(attr["columnId"])
        dom = domains[cid]
        observed = []
        for r in rows:
            if r["rowId"] not in fit_set:
                continue
            if r["optOut"] and has_opt:
                continue
            v = (r.get("attrValues") or {}).get(cid)
            if v is not None and v not in observed:
                observed.append(v)
        order = [c for c in dom["order"]
                 if c not in dom["missing"] and c in observed]
        for v in observed:
            if v not in order:
                order.append(v)
        if len(order) < 2:
            _err("CONJOINT_CONSTANT_ATTRIBUTE",
                 "属性に2水準以上の観測が必要です。", 422,
                 {"columnIds": [cid]})
        catalog[cid] = order
        for c in dom["order"]:
            if c not in dom["missing"] and c not in observed:
                omitted_levels.append({"attributeId": cid, "levelCode": c,
                                       "reason": "unobserved"})
    fit_row_ids = [r["rowId"] for r in rows if r["rowId"] not in exclusions]
    return {"exclusions": exclusions, "auxCounts": aux_counts,
            "warnings": warnings, "tasks": tasks,
            "respondentIds": respondent_ids, "catalog": catalog,
            "omittedLevels": omitted_levels,
            "fitRowIds": fit_row_ids}
