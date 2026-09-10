"""CodebookAdapter: Unifies Polars DataFrame and Codebook metadata to provide
normalized, type-safe views and utilities for algorithms and API endpoints."""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np
import polars as pl


def is_not_applicable_reason(reason: Any) -> bool:
    if not isinstance(reason, str):
        return False
    return "非該当" in reason or "not_applicable" in reason.lower() or "skip" in reason.lower()


def normalize_code(value: Any) -> Optional[str]:
    """Normalize code values used by codebook lookups.

    - None or non-finite float values are normalized to None.
    - Numeric values are converted to strings, with integer-like floats normalized to int form.
    - String values are kept as-is.
    """
    if value is None:
        return None

    if isinstance(value, str):
        return value

    if isinstance(value, bool):
        return str(value)

    if isinstance(value, (int, np.integer)):
        return str(int(value))

    if isinstance(value, (float, np.floating)):
        if not np.isfinite(value):
            return None
        return str(int(value)) if float(value).is_integer() else str(float(value))

    return str(value)


def _iter_unique(values: List[str]) -> List[str]:
    """Normalize list while preserving order and deduplicating values."""
    seen = set()
    result: List[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else (value.dict() if hasattr(value, "dict") else {})


def _to_float_if_possible(value: Any) -> Optional[float]:
    code = normalize_code(value)
    if code is None:
        return None
    try:
        num = float(code)
    except ValueError:
        return None
    if not np.isfinite(num):
        return None
    return num


class CodebookAdapter:
    """Polars DataFrame と Codebook メタデータを結合し、アルゴリズムが必要とする
    型安全かつ正規化されたビューを提供するアダプタ。"""

    def __init__(self, df: pl.DataFrame, codebook: Dict[str, Any] | Any):
        self.df = df
        if hasattr(codebook, "dict"):
            self.codebook = codebook.dict()
        elif isinstance(codebook, dict):
            self.codebook = codebook
        else:
            self.codebook = {"columns": []}

        columns = self.codebook.get("columns", [])
        self._columns_by_id: dict[str, dict] = {}
        self._columns_by_name: dict[str, dict] = {}
        for c in columns:
            col_dict = _as_dict(c)
            col_id = col_dict.get("columnId")
            name = col_dict.get("name")
            if col_id:
                self._columns_by_id[col_id] = col_dict
            if name:
                self._columns_by_name[name] = col_dict

    def get_column_spec(self, col_identifier: str) -> Dict[str, Any]:
        """columnId または name のどちらからでもカラム定義を取得"""
        if col_identifier in self._columns_by_id:
            return self._columns_by_id[col_identifier]
        if col_identifier in self._columns_by_name:
            return self._columns_by_name[col_identifier]
        raise KeyError(f"Column '{col_identifier}' not found in codebook.")

    def get_column_spec_optional(self, col_identifier: str) -> Optional[Dict[str, Any]]:
        """カラム定義が存在すれば取得、なければ None"""
        if col_identifier in self._columns_by_id:
            return self._columns_by_id[col_identifier]
        if col_identifier in self._columns_by_name:
            return self._columns_by_name[col_identifier]
        return None

    def get_attribute_columns(self) -> List[str]:
        """Subgroup Mining 等の説明変数プール (role == 'attribute')"""
        return [
            c.get("name")
            for raw in self.codebook.get("columns", [])
            if (c := _as_dict(raw)).get("role") == "attribute"
            and c.get("name") in self.df.columns
        ]

    def get_question_columns(self) -> List[str]:
        """Subgroup Mining 等の評価変数プール (role == 'question')"""
        return [
            c.get("name")
            for raw in self.codebook.get("columns", [])
            if (c := _as_dict(raw)).get("role") == "question"
            and c.get("name") in self.df.columns
        ]

    def get_ordered_categories(self, col_name: str) -> List[str]:
        """指定変数の正規化されたカテゴリ順序 (categoryOrder) を返却"""
        spec = self.get_column_spec_optional(col_name)
        if not spec:
            if col_name in self.df.columns:
                return _iter_unique(
                    [v for v in [normalize_code(v) for v in self.df[col_name].drop_nulls().to_list()] if v is not None]
                )
            return []

        order = spec.get("categoryOrder") or []
        labels = spec.get("valueLabels") or {}
        missing_codes = {v for v in [normalize_code(v) for v in (spec.get("missingCodes") or [])] if v is not None}

        ordered: List[str] = []
        if order:
            ordered = _iter_unique(
                [v for v in [normalize_code(v) for v in order] if v is not None and v not in missing_codes]
            )

        if not ordered and labels:
            ordered = _iter_unique(
                [v for v in [normalize_code(v) for v in labels.keys()] if v is not None and v not in missing_codes]
            )

        if col_name in self.df.columns:
            observed = [
                v
                for v in [normalize_code(v) for v in self.mask_missing_values(col_name).drop_nulls().to_list()]
                if v is not None and v not in ordered and v not in missing_codes
            ]
            ordered.extend(_iter_unique(observed))

        return ordered

    def label_for_value(self, col_name: str, val: Any) -> str:
        """値からラベルへの変換（ラベル未定義時は元の値を文字列化）"""
        norm_val = normalize_code(val)
        if norm_val is None:
            return ""
        val_str = norm_val
        spec = self.get_column_spec_optional(col_name)
        if not spec:
            return val_str
        labels = spec.get("valueLabels") or {}
        if not labels:
            return val_str

        normalized_labels = {normalize_code(k): v for k, v in labels.items() if normalize_code(k) is not None}
        return normalized_labels.get(val_str, val_str)

    def mask_missing_values(self, col_name: str) -> pl.Series:
        """コードブックに定義された missingCodes を NULL に置換した Series を返却"""
        if col_name not in self.df.columns:
            raise KeyError(f"Column '{col_name}' not in DataFrame.")
        series = self.df[col_name]
        spec = self.get_column_spec_optional(col_name)
        missing_codes = {normalize_code(code) for code in ((spec or {}).get("missingCodes") or [])}
        missing_codes.discard(None)
        normalized_series = series.map_elements(
            normalize_code,
            return_dtype=pl.Utf8,
            skip_nulls=False,
        )
        is_missing = normalized_series.is_null() | normalized_series.is_in(list(missing_codes))
        return self.df.select(pl.when(is_missing).then(None).otherwise(pl.col(col_name)).alias(col_name)).to_series()

    def analysis_series(self, col_name: str) -> pl.Series:
        """Normalize ordinal scores and exclude missing codes before analysis."""
        spec = self.get_column_spec_optional(col_name) or {}
        series = self.mask_missing_values(col_name)
        if spec.get("scaleType") == "ordinal":
            categories = self.get_ordered_categories(col_name)
            if not categories:
                raise KeyError(f"Column '{col_name}' has no fixed ordinal categories.")
            if spec.get("isReversed"):
                categories = list(reversed(categories))
            scores = {code: float(i + 1) for i, code in enumerate(categories)}
            return pl.Series(col_name, [scores.get(normalize_code(v)) for v in series], dtype=pl.Float64)
        if spec.get("scaleType") in ("ratio", "interval", "numeric"):
            return self.get_reversed_numeric_series(col_name).cast(pl.Float64, strict=False)
        return series

    def analysis_frame(self) -> pl.DataFrame:
        return self.df.with_columns([
            self.analysis_series(name) for name in self._columns_by_name if name in self.df.columns
        ])

    def condition_label(self, column: str, operator: str, value: Any) -> str:
        spec = self.get_column_spec_optional(column) or {}
        title = spec.get("label") or column
        if operator in ("==", "=", "eq", "!=", "in", "not in"):
            values = value if isinstance(value, (list, tuple)) else [value]
            text = ", ".join(self.label_for_value(column, v) for v in values)
            return f'{title} {operator} "{text}"'
        return f"{title} {operator} {value}"

    def get_reversed_numeric_series(self, col_name: str) -> pl.Series:
        """逆転項目 (isReversed=True) の場合、値を反転（max + min - X）させた数値を返却"""
        from .errors import BizError

        series = self.mask_missing_values(col_name)
        spec = self.get_column_spec_optional(col_name)
        if not spec or not spec.get("isReversed", False):
            return series

        numeric_series = series.map_elements(_to_float_if_possible, return_dtype=pl.Float64, skip_nulls=False)
        category_order = spec.get("categoryOrder") or []
        missing_codes = {normalize_code(v) for v in (spec.get("missingCodes") or [])}
        missing_codes.discard(None)
        category_order_values = [v for v in [_to_float_if_possible(v) for v in category_order]
                                 if v is not None and normalize_code(v) not in missing_codes]

        if category_order_values:
            max_val = max(category_order_values)
            min_val = min(category_order_values)
        else:
            raise BizError("CODEBOOK_REVERSE_RANGE_MISSING",
                           f"逆転項目 '{col_name}' には固定の尺度範囲(categoryOrder)が必要です。",
                           status_code=422)

        return ((max_val + min_val) - numeric_series).rename(col_name)
