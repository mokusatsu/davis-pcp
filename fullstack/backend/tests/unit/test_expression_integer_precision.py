"""Reject exact-integer-domain precision loss before values can be committed."""
import polars as pl
import pytest

from app.algorithms.transformation.expression import evaluate_expression, preview_expression
from app.domain.errors import BizError

LIMIT = 2**53


@pytest.mark.parametrize('values,dtype', [
    ([LIMIT, LIMIT + 1, LIMIT + 2], pl.Int64),
    ([-LIMIT - 2, -LIMIT - 1, -LIMIT], pl.Int64),
    ([LIMIT - 1, None, LIMIT + 1], pl.Int64),
    ([2**63, None, 2**63 + 1], pl.UInt64),
    ([2**64 - 1], pl.UInt64),
    ([-2**63], pl.Int64),
])
@pytest.mark.parametrize('expression', ['q', 'q - 9007199254740991', 'q == 1', 'minmax(q)'])
def test_unsafe_integer_sources_fail_before_conversion(values, dtype, expression):
    frame = pl.DataFrame({'q': pl.Series(values, dtype=dtype)})
    original = frame.clone()
    preview = preview_expression(frame, expression)
    assert not preview['valid']
    with pytest.raises(BizError) as error:
        evaluate_expression(frame, expression, 'result')
    assert error.value.code == 'EXPRESSION_INTEGER_PRECISION'
    assert error.value.status_code == 422
    assert preview['error'] == error.value.message
    assert frame.equals(original)


@pytest.mark.parametrize('expression', [
    '9007199254740992', '-9007199254740992',
    'q == 9007199254740993', 'q + 9223372036854775807',
    'q + 1', 'q * 2 - q', '(q + 1) / 2',
    '2 ** 53', '2 ** 1000', 'q ** 1000',
    'where(q > 0, q, False) + 1', '(q > 0) + q', 'q + True',
    'round(q, -2)', 'abs(-9007199254740992)',
    'where(q > 0, q + 1, 0)', 'q + 1 if q > 0 else 0',
    'ifelse(cond=q > 0, a=q + 1, b=None)',
])
def test_unsafe_literals_intermediates_results_and_overflow_fail(expression):
    frame = pl.DataFrame({'q': pl.Series([LIMIT - 1], dtype=pl.Int64)})
    with pytest.raises(BizError) as error:
        evaluate_expression(frame, expression, 'result')
    assert error.value.code == 'EXPRESSION_INTEGER_PRECISION'
    assert not preview_expression(frame, expression)['valid']


def test_preview_checks_referenced_integer_inputs_beyond_sample():
    frame = pl.DataFrame({'q': [1] * 100 + [LIMIT + 1]})
    assert not preview_expression(frame, 'q - 1')['valid']


@pytest.mark.parametrize('dtype', [pl.Int64, pl.UInt64])
@pytest.mark.parametrize('expression,expected', [
    ('q', [1., None, 2., 99.]),
    ('q * 2', [2., None, 4., 198.]),
    ('q == 2', [False, False, True, False]),
    ('where(q == 2, q, None)', [None, None, 2., None]),
    ('clip(q, 1, 2)', [1., None, 2., 2.]),
    ('abs(-q)', [1., None, 2., 99.]),
])
def test_safe_integer_and_raw_code_semantics_unchanged(dtype, expression, expected):
    frame = pl.DataFrame({'q': pl.Series([1, None, 2, 99], dtype=dtype),
                          'unused': pl.Series([LIMIT + 1] * 4, dtype=pl.Int64)})
    _, result, _ = evaluate_expression(frame, expression, 'result')
    assert result.to_list() == expected
    assert preview_expression(frame, expression)['valid']


def test_safe_boundary_and_explicit_floating_domain_remain_supported():
    frame = pl.DataFrame({'q': [LIMIT - 1], 'floating': [1e20]})
    for expression, expected in [('q - 1', [float(LIMIT - 2)]),
                                  ('floating + 1', [1e20]),
                                  ('q / 0.5', [float((LIMIT - 1) * 2)]),
                                  ('q * 2.0', [float((LIMIT - 1) * 2)])]:
        _, result, _ = evaluate_expression(frame, expression, 'result')
        assert result.to_list() == expected


@pytest.mark.parametrize('expression', [
    'abs(4503599627370496) * 4096',
    'round(4503599627370496) * 4096',
    'where(True, 4503599627370496, 0) * 4096',
    '((q > 0) & (q < 2)) * 4503599627370496 * 4096',
    '((q > 0) | (q < 2)) * 4503599627370496 * 4096',
    'clip(q, 0, 2) * 4503599627370496 * 4096',
    'abs(4503599627370496) ** 2',
    'round(4503599627370496) * 4096 - round(4503599627370496) * 4096',
    '2 ** exponent',
])
def test_numpy_fixed_width_arithmetic_cannot_wrap_before_guard(expression):
    frame = pl.DataFrame({'q': [1, 2], 'exponent': [-1, 53]})
    with pytest.raises(BizError) as error:
        evaluate_expression(frame, expression, 'result')
    assert error.value.code == 'EXPRESSION_INTEGER_PRECISION'
    assert not preview_expression(frame, expression)['valid']


@pytest.mark.parametrize('expression,expected', [
    ('clip(q, 1e20, 1e21)', [1e20]),
    ('clip(a=q, lo=1e20, hi=1e21)', [1e20]),
    ('(q ** -1) * 4503599627370496 * 8', [float(2**54)]),
])
def test_explicit_floating_bounds_and_negative_power_transition(expression, expected):
    frame = pl.DataFrame({'q': [2]})
    _, result, _ = evaluate_expression(frame, expression, 'result')
    assert result.to_list() == expected
    assert preview_expression(frame, expression)['valid']
