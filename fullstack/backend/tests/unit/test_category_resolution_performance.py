"""Ordering regressions and deterministic work bound for open-domain labels."""
import polars as pl
import pytest
import app.domain.codebook_adapter as module
from app.domain.codebook_adapter import CodebookAdapter
from app.algorithms.summaries.core import question_summary


@pytest.mark.parametrize('order,expected', [
    ([], ['3', '1', '2', '4', '5']),
    (['2', 1, '1', '-99'], ['2', '1']),
])
def test_label_resolution_preserves_order_missing_and_closed_domain(order, expected):
    spec = {'name': 'q', 'valueLabels': {3: 'Three', '3': 'Duplicate', 1: 'One', 2: 'Two', '-99': 'Skip'},
            'categoryOrder': order, 'missingCodes': [-99], 'missingReasons': {'-99': 'not_applicable'}}
    df = pl.DataFrame({'q': [4.0, 2.0, None, -99.0, 4.0, 5.0, float('nan'), 1.0]})
    assert CodebookAdapter(df, {'columns': [spec]}).get_ordered_categories('q') == expected
    result = question_summary(df['q'], spec)
    assert result['denominators']['notApplicable'] == 1
    assert result['denominators']['missing'] == 2


def test_open_domain_label_membership_has_linear_comparison_bound(monkeypatch):
    comparisons = 0
    class CountedCode(str):
        __hash__ = str.__hash__
        def __eq__(self, other):
            nonlocal comparisons
            comparisons += 1
            return str.__eq__(self, other)
    normalize = module.normalize_code
    def counted(value):
        code = normalize(value)
        return CountedCode(code) if code is not None else None
    monkeypatch.setattr(module, 'normalize_code', counted)
    n, k = 2000, 200
    df = pl.DataFrame({'q': [str(i % k) for i in range(n)]})
    spec = {'name': 'q', 'valueLabels': {str(i): str(i) for i in range(k)}}
    result = CodebookAdapter(df, {'columns': [spec]}).get_ordered_categories('q')
    assert result == [str(i) for i in range(k)]
    # A label-list scan makes about N*K/2 comparisons; lookup stays O(N+K).
    assert comparisons < 5 * (n + k)
