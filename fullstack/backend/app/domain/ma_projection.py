"""Explicit MA display columns; dependencies are never returned as plot axes."""
from typing import Any

import polars as pl

from .multi_response import prepare_classifier, resolve_groups, validate_group


def plan_ma_axes(codebook: dict, axes: list[dict], physical_names: set[str]) -> tuple[list, list[str]]:
    groups = {group['groupId']: group for group in resolve_groups(codebook)}
    plans = []
    dependencies: list[str] = []
    keys = set(physical_names)
    for axis in axes:
        if axis.get('kind') not in {'maOption', 'maCount'}:
            raise ValueError('MAの選択肢または選択数を指定してください。')
        key = axis.get('key')
        if not isinstance(key, str) or not key or key in keys or key == '__rowId__':
            raise ValueError('MA軸の識別子が空、または重複しています。')
        keys.add(key)
        group = groups.get(axis.get('groupId'))
        if group is None:
            raise ValueError('指定設問が存在しません。')
        validate_group(group)
        if axis['kind'] == 'maOption' and axis.get('columnId') not in {c['columnId'] for c in group['columns']}:
            raise ValueError('指定選択肢は設問に所属していません。')
        plans.append((axis, group))
        for column in group['columns']:
            if column['name'] not in dependencies:
                dependencies.append(column['name'])
    return plans, dependencies


def append_ma_axes(frame: pl.DataFrame, plans: list) -> pl.DataFrame:
    by_group: dict[str, list] = {}
    for axis, group in plans:
        by_group.setdefault(group['groupId'], []).append((axis, group))
    result = frame
    for entries in by_group.values():
        group = entries[0][1]
        classify = prepare_classifier(group)
        values: dict[str, list[Any]] = {axis['key']: [] for axis, _ in entries}
        for row in frame.select([column['name'] for column in group['columns']]).iter_rows():
            status, selected = classify(list(row))
            selected_ids = set(selected)
            for axis, _ in entries:
                value = None
                if status == 'valid':
                    value = len(selected) if axis['kind'] == 'maCount' else int(axis['columnId'] in selected_ids)
                values[axis['key']].append(value)
        result = result.with_columns([
            pl.Series(axis['key'], values[axis['key']], dtype=pl.UInt32 if axis['kind'] == 'maCount' else pl.UInt8)
            for axis, _ in entries
        ])
    return result
