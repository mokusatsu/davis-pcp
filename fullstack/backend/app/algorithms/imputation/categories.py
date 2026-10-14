"""Shared deterministic category ordering for mode and diffusion sampling."""
import polars as pl


def ordered_frequencies(series: pl.Series) -> list[tuple[object, int]]:
    """Frequency descending, then code-string ascending (existing TabDiff policy).

    A string key works for numeric, string and boolean columns alike without
    comparing incompatible Python types. Values keep their original dtype.
    """
    return sorted(series.rename('__imputation_category__').value_counts().iter_rows(), key=lambda pair: (-int(pair[1]), str(pair[0])))


def deterministic_mode(series: pl.Series):
    return ordered_frequencies(series)[0][0]
