from __future__ import annotations

from typing import Any

import polars as pl

from .codebook_adapter import is_not_applicable_reason, normalize_code


def _normalize_code_list(values: list[Any] | None) -> list[str]:
    return [code for code in (normalize_code(v) for v in (values or [])) if code is not None]


def _strict_normalize_codes(values: list[Any] | None, field_name: str) -> list[str]:
    normalized: list[str] = []
    for value in values or []:
        code = normalize_code(value)
        if code is None:
            raise ValueError(f"{field_name} contains null or non-finite codes")
        normalized.append(code)
    return normalized


def _required_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be a non-empty string")
    return value


def _column_id_list(group: dict[str, Any]) -> list[str]:
    return [c.get("columnId") for c in (group.get("columns") or []) if isinstance(c, dict) and isinstance(c.get("columnId"), str)]


def resolve_groups(codebook: dict[str, Any]) -> list[dict[str, Any]]:
    columns = list((codebook or {}).get("columns") or [])
    group_specs = list((codebook or {}).get("multiResponseGroups") or [])

    groups: dict[str, dict[str, Any]] = {}
    ordered_group_ids: list[str] = []
    for raw_group in group_specs:
        if not isinstance(raw_group, dict):
            continue
        group_id = _required_str(raw_group.get("groupId"), "groupId")
        if group_id in groups:
            raise ValueError("multiResponseGroup identifiers must be unique")
        group = {
            "groupId": group_id,
            "label": group_id,
            "selectedCodes": ["1"],
            "unselectedCodes": ["0"],
            "allUnselectedMeaning": "valid",
            "maxSelections": None,
            "optionOrder": [],
            "columns": [],
            **raw_group,
        }
        if group.get("selectedCodes") is None:
            group["selectedCodes"] = ["1"]
        if group.get("unselectedCodes") is None:
            group["unselectedCodes"] = ["0"]
        if group.get("allUnselectedMeaning") is None:
            group["allUnselectedMeaning"] = "valid"
        if group.get("optionOrder") is None:
            group["optionOrder"] = []
        group["columns"] = []
        groups[group_id] = group
        ordered_group_ids.append(group_id)

    for col in columns:
        if not isinstance(col, dict):
            continue
        group_id = col.get("multiResponseGroup")
        if not isinstance(group_id, str) or not group_id:
            continue

        group = groups.get(group_id)
        if group is None:
            group = {
                "groupId": group_id,
                "label": group_id,
                "selectedCodes": ["1"],
                "unselectedCodes": ["0"],
                "allUnselectedMeaning": "valid",
                "maxSelections": None,
                "optionOrder": [],
                "columns": [],
            }
            groups[group_id] = group
            ordered_group_ids.append(group_id)

        group["columns"].append(col)

    return [groups[group_id] for group_id in ordered_group_ids]


def validate_group(group: dict[str, Any]) -> None:
    _required_str(group.get("groupId"), "groupId")
    _required_str(group.get("label"), "label")

    if group.get("allUnselectedMeaning", "valid") not in {"valid", "missing", "notApplicable"}:
        raise ValueError("allUnselectedMeaning must be one of valid, missing, notApplicable")

    max_selections = group.get("maxSelections")
    if max_selections is not None:
        if isinstance(max_selections, bool) or not isinstance(max_selections, int) or max_selections <= 0:
            raise ValueError("maxSelections must be null or a positive integer")

    members = [col for col in (group.get("columns") or []) if isinstance(col, dict)]
    if len(members) == 0:
        raise ValueError("multi-response group must have at least one member column")
    member_ids = [col.get("columnId") for col in members if isinstance(col.get("columnId"), str)]
    if len(member_ids) != len(members):
        raise ValueError("multi-response group member columnId must be non-empty strings")
    if len(member_ids) != len(set(member_ids)):
        raise ValueError("multi-response group columns must have unique columnId")
    if any(not isinstance(col.get("name"), str) or not col.get("name") for col in members):
        raise ValueError("multi-response group member names must be non-empty strings")

    roles = {str(col.get("role")) for col in members}
    if len(roles) != 1:
        raise ValueError("multi-response group members must have same role")

    scales = {str(col.get("scaleType")) for col in members}
    if scales != {"nominal"}:
        raise ValueError("multi-response group members must all have nominal scaleType")

    for col in members:
        if bool(col.get("isReversed", False)):
            raise ValueError("multi-response group members with isReversed=true are invalid")

    selected_codes = _strict_normalize_codes(group.get("selectedCodes"), "selectedCodes")
    if not selected_codes:
        raise ValueError("selectedCodes must not be empty")
    if len(selected_codes) != len(set(selected_codes)):
        raise ValueError("selectedCodes must not contain duplicates")

    unselected_codes = _strict_normalize_codes(group.get("unselectedCodes"), "unselectedCodes")
    if not unselected_codes:
        raise ValueError("unselectedCodes must not be empty")
    if len(unselected_codes) != len(set(unselected_codes)):
        raise ValueError("unselectedCodes must not contain duplicates")

    overlap = set(selected_codes) & set(unselected_codes)
    if overlap:
        raise ValueError("selectedCodes and unselectedCodes must not overlap")

    missing_codes = set()
    for col in members:
        missing_codes.update(_normalize_code_list(col.get("missingCodes")))

    if missing_codes & set(selected_codes):
        raise ValueError("selectedCodes must not overlap with missingCodes")
    if missing_codes & set(unselected_codes):
        raise ValueError("unselectedCodes must not overlap with missingCodes")

    option_order = [code for code in (group.get("optionOrder") or []) if isinstance(code, str)]
    member_ids = _column_id_list(group)
    if len(option_order) > 0:
        if len(option_order) != len(set(option_order)):
            raise ValueError("optionOrder must not contain duplicates")
        if set(option_order) != set(member_ids) or len(option_order) != len(member_ids):
            raise ValueError("optionOrder must contain each member columnId exactly once")


def _member_column_ids(group: dict[str, Any]) -> list[str]:
    return [c.get("columnId") for c in (group.get("columns") or []) if isinstance(c, dict)]


def _option_order(group: dict[str, Any]) -> list[str]:
    option_order = [code for code in (group.get("optionOrder") or []) if isinstance(code, str)]
    if option_order:
        return option_order
    return _member_column_ids(group)


def prepare_classifier(group: dict[str, Any]):
    members = [col for col in (group.get("columns") or []) if isinstance(col, dict)]
    selected_codes = set(_normalize_code_list(group.get("selectedCodes")))
    unselected_codes = set(_normalize_code_list(group.get("unselectedCodes")))

    max_selections_raw = group.get("maxSelections")
    max_selections = (
        max_selections_raw
        if isinstance(max_selections_raw, int)
        and not isinstance(max_selections_raw, bool)
        and max_selections_raw > 0
        else None
    )
    option_order = _option_order(group)
    all_unselected_meaning = group.get("allUnselectedMeaning", "valid")
    missing_config = [
        (set(_normalize_code_list(col.get("missingCodes"))),
         {normalize_code(k): str(v) for k, v in (col.get("missingReasons") or {}).items() if normalize_code(k) is not None})
        for col in members
    ]

    def classify(values: list[Any]) -> tuple[str, list[str]]:
        ordered_selected: list[str] = []
        selected_set: set[str] = set()

        states: list[str] = []

        for idx, col in enumerate(members):
            value = values[idx] if idx < len(values) else None
            norm = normalize_code(value)
            missing_codes, missing_reasons = missing_config[idx]
            if norm is None:
                state = "M"
            elif norm in selected_codes:
                state = "S"
            elif norm in unselected_codes:
                state = "U"
            elif norm in missing_codes:
                reason = missing_reasons.get(norm, "")
                state = "N" if is_not_applicable_reason(reason) else "M"
            else:
                state = "X"

            states.append(state)
            if state == "S":
                column_id = col.get("columnId")
                if isinstance(column_id, str):
                    selected_set.add(column_id)

        for cid in option_order:
            if cid in selected_set:
                ordered_selected.append(cid)

        if "X" in states or (max_selections is not None and len(selected_set) > max_selections):
            return "invalid", ordered_selected

        n_count = states.count("N")
        m_count = states.count("M")
        s_count = states.count("S")
        u_count = states.count("U")
        total_count = len(states)

        if total_count == 0:
            return "invalid", ordered_selected

        if n_count > 0 and n_count != total_count:
            return "invalid", ordered_selected
        if n_count == total_count:
            return "notApplicable", ordered_selected
        if m_count == total_count:
            return "missing", ordered_selected
        if m_count > 0 and (s_count + u_count) > 0:
            return "partial", ordered_selected

        if s_count == 0 and u_count == total_count:
            if all_unselected_meaning == "notApplicable":
                return "notApplicable", ordered_selected
            if all_unselected_meaning == "missing":
                return "missing", ordered_selected
            return "valid", ordered_selected

        if s_count + u_count == total_count and s_count >= 1:
            return "valid", ordered_selected

        return "invalid", ordered_selected

    return classify


def classify_row(values: list[Any], group: dict[str, Any]) -> tuple[str, list[str]]:
    return prepare_classifier(group)(values)


def summarize_group(
    df: pl.DataFrame,
    group: dict[str, Any],
    selected_row_ids: list[str] | None = None,
    selection_masks: dict[str, int] | None = None,
    weights: list[float | None] | None = None,
) -> dict[str, Any]:
    """Counts and (optionally) weighted sums for one multi-response group.

    ``weights`` holds one survey weight per row of ``df`` (``None`` = the
    respondent carries no usable weight).  Unweighted counts are always
    reported; when weights are given, the ratios become weighted and the
    unweighted ratio is kept alongside them (``pctRespondentUnweighted``,
    ``pctResponseUnweighted``).  A respondent with a missing or zero weight is
    dropped from the weighted denominators but keeps contributing to the
    unweighted ones.
    """
    validate_group(group)

    group_id = group.get("groupId")
    label = group.get("label", group_id)

    option_cols = [col for col in (group.get("columns") or []) if isinstance(col, dict)]
    member_names = [col.get("name") for col in option_cols if isinstance(col.get("name"), str)]
    member_labels = {
        col.get("columnId"): (col.get("multiResponseOptionLabel") or col.get("label") or col.get("name") or "")
        for col in option_cols
    }
    option_ids = _option_order(group)

    selected_ids_set = set(selected_row_ids or [])

    selected_counts: dict[str, int] = {cid: 0 for cid in option_ids}
    selected_in_selection: dict[str, int] = {cid: 0 for cid in option_ids}
    selected_weights: dict[str, float] = {cid: 0.0 for cid in option_ids}
    mask_buffers = {cid: bytearray((df.height + 7) // 8) for cid in option_ids} if selection_masks is not None else {}
    # Weighted denominators mirror the unweighted ones: ``valid`` counts
    # respondents, the response denominator counts selections.
    den_valid_weight = 0.0
    weighted = weights is not None
    if weighted and len(weights or []) != df.height:
        from .errors import BizError
        raise BizError("CROSSTAB_WEIGHT_LENGTH", "ウェイト長が対象行数と一致しません。",
                       status_code=422)

    denominators = {
        "total": 0,
        "target": 0,
        "valid": 0,
        "missing": 0,
        "partial": 0,
        "invalid": 0,
        "notApplicable": 0,
    }
    all_unselected_n = 0

    if "__rowId__" not in df.columns:
        raise ValueError("__rowId__ is required")
    row_ids = df["__rowId__"].to_list()

    classify = prepare_classifier(group)
    for idx, row in enumerate(df.iter_rows(named=True)):
        row_values = [row.get(name) for name in member_names]
        state, selected = classify(row_values)
        denominators["total"] += 1

        if state == "notApplicable":
            denominators["notApplicable"] += 1
            continue
        if state == "missing":
            denominators["missing"] += 1
            continue
        if state == "partial":
            denominators["partial"] += 1
            continue
        if state == "invalid":
            denominators["invalid"] += 1
            continue

        denominators["valid"] += 1
        if not selected:
            all_unselected_n += 1

        row_weight = weights[idx] if weighted else 1.0
        carries_weight = row_weight is not None and row_weight > 0
        if carries_weight:
            den_valid_weight += row_weight

        row_id = row_ids[idx]
        for cid in selected:
            if cid in selected_counts:
                selected_counts[cid] += 1
                if carries_weight:
                    selected_weights[cid] += row_weight
                if selection_masks is not None:
                    mask_buffers[cid][idx // 8] |= 1 << (idx % 8)
                if row_id in selected_ids_set:
                    selected_in_selection[cid] += 1

    if selection_masks is not None:
        selection_masks.update({cid: int.from_bytes(bits, 'little') for cid, bits in mask_buffers.items()})
    denominators["target"] = max(0, denominators["total"] - denominators["notApplicable"])

    if denominators["valid"] < 0:
        denominators["valid"] = 0

    total_responses = sum(selected_counts.values())
    den_valid = denominators["valid"]
    den_total_responses = total_responses
    # Σ w_r × (その回答者の選択数) — every accumulation above is one selection,
    # so summing the weighted selections gives the weighted response total.
    den_total_weight = sum(selected_weights.values())

    items: list[dict[str, Any]] = []
    for cid in option_ids:
        selected_n = selected_counts.get(cid, 0)
        selected_weighted = selected_weights.get(cid, 0.0)
        pct_respondent_unweighted = (selected_n / den_valid * 100.0) if den_valid > 0 else None
        pct_response_unweighted = (selected_n / den_total_responses * 100.0) if den_total_responses > 0 else None
        if weighted:
            pct_respondent = (selected_weighted / den_valid_weight * 100.0) if den_valid_weight > 0 else None
            pct_response = (selected_weighted / den_total_weight * 100.0) if den_total_weight > 0 else None
        else:
            pct_respondent = pct_respondent_unweighted
            pct_response = pct_response_unweighted
        items.append({
            "columnId": cid,
            "name": next((c.get("name") for c in option_cols if c.get("columnId") == cid), ""),
            "label": member_labels.get(cid, ""),
            "selectedN": selected_n,
            "selectedWeighted": selected_weighted,
            "selectedInSelection": selected_in_selection.get(cid, 0),
            # With no weights the two coincide; with weights the plain ratio
            # stays available so the UI can show both.
            "pctRespondent": pct_respondent,
            "pctRespondentUnweighted": pct_respondent_unweighted,
            "pctResponse": pct_response,
            "pctResponseUnweighted": pct_response_unweighted,
        })

    return {
        "groupId": group_id,
        "label": label,
        "denominators": denominators,
        "allUnselectedN": all_unselected_n,
        "totalResponses": total_responses,
        "weightedValidN": den_valid_weight if weighted else None,
        "weightedResponses": den_total_weight if weighted else None,
        "items": items,
    }


def match_group(
    df: pl.DataFrame,
    group: dict[str, Any],
    option_ids: list[str],
    mode: str,
    status: str | None = None,
) -> list[str]:
    validate_group(group)

    members = [col for col in (group.get("columns") or []) if isinstance(col, dict)]
    if not members:
        return []

    if mode not in {"any", "all", "unselected", "status"}:
        raise ValueError("unsupported mode")

    known_option_ids = [col.get("columnId") for col in members if isinstance(col.get("columnId"), str)]
    if mode == "status":
        if status not in {"valid", "partial", "missing", "notApplicable", "invalid"}:
            raise ValueError("unsupported status")
    else:
        if not option_ids:
            return []
        if any(not isinstance(cid, str) for cid in option_ids):
            raise ValueError("option_ids must be strings")
        if any(cid not in known_option_ids for cid in option_ids):
            raise ValueError("optionId not found in group columns")
        option_ids = [cid for cid in _option_order(group) if cid in set(option_ids)]
        if not option_ids:
            raise ValueError("option_ids is required")

    if "__rowId__" not in df.columns:
        raise ValueError("__rowId__ is required")

    member_names = [col.get("name") for col in members if isinstance(col.get("name"), str)]
    row_ids = df["__rowId__"].to_list()

    matched: list[str] = []
    classify = prepare_classifier(group)
    for idx, row in enumerate(df.iter_rows(named=True)):
        values = [row.get(name) for name in member_names]
        state, selected = classify(values)
        if mode == "status":
            if status is None or state != status:
                continue
            matched.append(row_ids[idx])
            continue

        if state != "valid":
            continue

        if mode == "any":
            if any(cid in selected for cid in option_ids):
                matched.append(row_ids[idx])
        elif mode == "all":
            if all(cid in selected for cid in option_ids):
                matched.append(row_ids[idx])
        elif mode == "unselected":
            if all(cid not in selected for cid in option_ids):
                matched.append(row_ids[idx])


    return matched
