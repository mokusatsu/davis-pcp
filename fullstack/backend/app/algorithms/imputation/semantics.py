"""Imputation-only codebook views; ordinary missing and skipped cells differ."""
from __future__ import annotations
from typing import Any
import polars as pl
from ...domain.codebook_adapter import CodebookAdapter, is_not_applicable_reason, normalize_code


def prepare_imputation_frame(df: pl.DataFrame, codebook: dict[str, Any]):
    """Exclude all missing codes from donors, but never authorize skipped cells.

    Declared-invalid observed values retain their existing imputation behavior.
    This is deliberately not a change to the generic analysis/calculation view.
    """
    adapter = CodebookAdapter(df, codebook)
    masked, protected = [], {}
    for name in df.columns:
        if name == '__rowId__':
            continue
        spec = adapter.get_column_spec_optional(name) or {}
        skipped = {normalize_code(code) for code, reason in (spec.get('missingReasons') or {}).items()
                   if is_not_applicable_reason(reason)}
        skipped.discard(None)
        mask = pl.Series(name, ([normalize_code(value) in skipped for value in df[name].to_list()] if skipped else [False] * df.height), dtype=pl.Boolean)
        protected[name] = mask
        values = adapter.mask_missing_values(name)
        # A skip reason is authoritative even if the code was omitted from missingCodes.
        masked.append(values.zip_with(~mask, pl.Series(name, [None] * df.height, dtype=values.dtype)))
    return df.with_columns(masked), protected
