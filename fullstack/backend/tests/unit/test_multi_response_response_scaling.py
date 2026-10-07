"""Independent MA percentage contracts across finite Float64 weight scales."""
from __future__ import annotations

from fractions import Fraction
import json
import math
import sys
from typing import NamedTuple

import polars as pl
import pytest

from app.domain.errors import BizError
from app.domain.multi_response import match_group, summarize_group


class Row(NamedTuple):
    row_id: str
    a: int | None
    b: int | None
    weight: float | None
    state: str
    selections: tuple[str, ...]


def group(*, member_order=('a', 'b'), option_order=('a', 'b'), policy='valid', maximum=None):
    return {
        'groupId': 'q', 'label': 'MA scale contract',
        'selectedCodes': ['1'], 'unselectedCodes': ['0'],
        'allUnselectedMeaning': policy, 'maxSelections': maximum,
        'optionOrder': list(option_order),
        'columns': [
            {'columnId': name, 'name': name, 'label': name.upper(),
             'role': 'question', 'scaleType': 'nominal',
             'missingCodes': ['98', '99'], 'missingReasons': {'98': '非該当'}}
            for name in member_order
        ],
    }


def pair(scale):
    return [Row('r1', 1, 0, float(scale), 'valid', ('a',)),
            Row('r2', 1, 1, float(2 * scale), 'valid', ('a', 'b'))]


def frame(rows):
    return pl.DataFrame(
        {'__rowId__': [r.row_id for r in rows],
         'a': [r.a for r in rows], 'b': [r.b for r in rows]},
        schema_overrides={'__rowId__': pl.String, 'a': pl.Int64, 'b': pl.Int64},
    )


def oracle(rows, *, weighted=True):
    """Membership is fixture data; no production classifier or arithmetic is used."""
    valid = [r for r in rows if r.state == 'valid']
    usable = [r for r in valid if not weighted or (r.weight is not None and r.weight > 0)]
    weight = lambda r: Fraction.from_float(float(r.weight)) if weighted else Fraction(1)
    option_mass = {name: sum((weight(r) for r in usable if name in r.selections), Fraction())
                   for name in ('a', 'b')}
    respondent_mass = sum((weight(r) for r in usable), Fraction())
    response_mass = sum((weight(r) * len(r.selections) for r in usable), Fraction())
    counts = {name: sum(name in r.selections for r in valid) for name in ('a', 'b')}
    denominators = {
        'total': len(rows), 'target': sum(r.state != 'notApplicable' for r in rows),
        **{state: sum(r.state == state for r in rows)
           for state in ('valid', 'missing', 'partial', 'invalid', 'notApplicable')},
    }
    percentage = lambda n, d: 100 * n / d if d else None
    return {
        'denominators': denominators,
        'allUnselectedN': sum(not r.selections for r in valid),
        'totalResponses': sum(counts.values()),
        'weightedValidN': respondent_mass if weighted else None,
        'weightedResponses': response_mass if weighted else None,
        'items': {
            name: {
                'selectedN': counts[name],
                'selectedWeighted': option_mass[name],
                'pctRespondent': percentage(option_mass[name], respondent_mass),
                'pctResponse': percentage(option_mass[name], response_mass),
                'pctRespondentUnweighted': percentage(Fraction(counts[name]), len(valid)),
                'pctResponseUnweighted': percentage(Fraction(counts[name]), sum(counts.values())),
            } for name in ('a', 'b')
        },
    }


def assert_percentage(actual, exact):
    if exact is None:
        assert actual is None
        return
    expected = float(exact)
    assert actual is not None and math.isfinite(actual)
    if expected == 0:
        assert actual == 0
    elif expected < sys.float_info.min:
        # A broad absolute tolerance would wrongly accept zero here.
        assert actual > 0
        assert abs(actual - expected) <= 4 * math.ulp(expected)
    else:
        assert actual > 0
        assert actual == pytest.approx(expected, rel=1e-14, abs=0)


def assert_original_mass(actual, exact):
    if exact is None or exact > Fraction.from_float(sys.float_info.max):
        assert actual is None
    elif not exact:
        assert actual == 0.0
    else:
        assert actual is not None and math.isfinite(actual) and actual > 0
        assert actual == pytest.approx(float(exact), rel=1e-14, abs=0)


def check(rows, *, weighted=True, selected=('r1',), member_order=('a', 'b'),
          option_order=('a', 'b'), policy='valid', maximum=None):
    definition = group(member_order=member_order, option_order=option_order,
                       policy=policy, maximum=maximum)
    df = frame(rows)
    masks = {'unrelated': 17}
    result = summarize_group(df, definition, selected_row_ids=list(selected),
                             selection_masks=masks,
                             weights=[r.weight for r in rows] if weighted else None)
    expected = oracle(rows, weighted=weighted)
    assert result['groupId'] == 'q' and result['label'] == 'MA scale contract'
    assert [i['columnId'] for i in result['items']] == list(option_order)
    for key in ('denominators', 'allUnselectedN', 'totalResponses'):
        assert result[key] == expected[key]
    for item in result['items']:
        name = item['columnId']
        want = expected['items'][name]
        assert item['name'] == name and item['label'] == name.upper()
        assert item['selectedN'] == want['selectedN']
        assert item['selectedInSelection'] == sum(
            r.state == 'valid' and name in r.selections and r.row_id in set(selected)
            for r in rows)
        # Ratio checks precede unavailable-total assertions in baseline red runs.
        for key in ('pctResponse', 'pctRespondent',
                    'pctResponseUnweighted', 'pctRespondentUnweighted'):
            assert_percentage(item[key], want[key])
        assert_original_mass(item['selectedWeighted'], want['selectedWeighted'])
    assert_original_mass(result['weightedValidN'], expected['weightedValidN'])
    assert_original_mass(result['weightedResponses'], expected['weightedResponses'])
    assert masks == {
        'unrelated': 17,
        **{name: sum(1 << index for index, r in enumerate(rows)
                     if r.state == 'valid' and name in r.selections)
           for name in ('a', 'b')},
    }
    for name in ('a', 'b'):
        assert match_group(df, definition, [name], 'any') == [
            r.row_id for r in rows if r.state == 'valid' and name in r.selections]
    for state in ('missing', 'partial', 'invalid', 'notApplicable'):
        assert match_group(df, definition, [], 'status', state) == [
            r.row_id for r in rows if r.state == state]
    json.dumps(result, allow_nan=False)
    return result


@pytest.mark.parametrize('scale', [1.0, 1e-300, 1e-12, 1e160, 4e307])
def test_proved_response_shares_preserve_both_bases_and_original_units(scale):
    result = check(pair(scale))
    assert [i['pctResponse'] for i in result['items']] == pytest.approx([60, 40], rel=1e-14, abs=0)
    assert result['denominators']['valid'] == 2
    assert result['totalResponses'] == 3


@pytest.mark.parametrize('member_order', [('a', 'b'), ('b', 'a')])
@pytest.mark.parametrize('option_order', [('a', 'b'), ('b', 'a')])
@pytest.mark.parametrize('reverse_rows', [False, True])
def test_proved_boundary_is_independent_of_rows_members_and_option_order(member_order, option_order, reverse_rows):
    rows = pair(4e307)
    check(rows[::-1] if reverse_rows else rows, selected=('r2', 'unknown', 'r2'),
          member_order=member_order, option_order=option_order)


def test_response_and_respondent_ratios_survive_option_and_denominator_overflow():
    rows = [Row('r1', 1, 0, 1e308, 'valid', ('a',)),
            Row('r2', 1, 1, 1e308, 'valid', ('a', 'b'))]
    result = check(rows)
    assert [i['pctRespondent'] for i in result['items']] == [100, 50]
    assert result['weightedValidN'] is None and result['weightedResponses'] is None
    assert result['items'][0]['selectedWeighted'] is None
    assert result['items'][1]['selectedWeighted'] == 1e308


@pytest.mark.parametrize('extra', [
    Row('giant', 99, 99, 1e308, 'missing', ()),
    Row('giant', 1, 99, 1e308, 'partial', ('a',)),
    Row('giant', 2, 0, 1e308, 'invalid', ()),
    Row('giant', 98, 98, 1e308, 'notApplicable', ()),
])
def test_excluded_giant_never_sets_a_valid_mass_scale(extra):
    result = check([*pair(1e-300), extra], selected=('r1', 'giant'))
    assert result['weightedValidN'] > 0 and result['weightedResponses'] > 0
    assert [i['pctResponse'] for i in result['items']] == pytest.approx([60, 40], rel=1e-14, abs=0)


@pytest.mark.parametrize('policy', ['valid', 'missing', 'notApplicable'])
def test_giant_all_unselected_row_only_enters_its_actual_denominator(policy):
    rows = [*pair(1e-300), Row('giant', 0, 0, 1e308, policy, ())]
    result = check(rows, policy=policy)
    assert [i['pctResponse'] for i in result['items']] == pytest.approx([60, 40], rel=1e-14, abs=0)
    assert result['weightedResponses'] > 0
    assert result['allUnselectedN'] == int(policy == 'valid')


def test_zero_and_missing_weights_preserve_nonvacuous_raw_counts_and_selection():
    rows = [*pair(4e307),
            Row('zero', 0, 1, 0.0, 'valid', ('b',)),
            Row('missing-weight', 0, 1, None, 'valid', ('b',))]
    result = check(rows, selected=('zero', 'missing-weight'))
    assert [i['selectedN'] for i in result['items']] == [2, 3]
    assert [i['selectedInSelection'] for i in result['items']] == [0, 2]
    assert [i['pctResponseUnweighted'] for i in result['items']] == [40, 60]
    assert [i['pctResponse'] for i in result['items']] == pytest.approx([60, 40], rel=1e-14, abs=0)


@pytest.mark.parametrize('weights', [(0.0, None), (0.0, 0.0), (None, None)])
def test_provided_no_positive_weights_do_not_fabricate_a_weighted_percentage(weights):
    rows = [Row('r1', 1, 0, weights[0], 'valid', ('a',)),
            Row('r2', 1, 1, weights[1], 'valid', ('a', 'b'))]
    result = check(rows)
    assert result['weightedValidN'] == result['weightedResponses'] == 0.0
    assert all(i['pctRespondent'] is None and i['pctResponse'] is None for i in result['items'])


def test_omitted_weights_and_unit_weights_keep_the_existing_item_contract():
    rows = [Row('r1', 1, 0, 1.0, 'valid', ('a',)),
            Row('r2', 1, 1, 1.0, 'valid', ('a', 'b')),
            Row('r3', 0, 0, 1.0, 'valid', ())]
    plain = check(rows, weighted=False)
    units = check(rows)
    assert plain['items'] == units['items']
    assert plain['weightedValidN'] is None and plain['weightedResponses'] is None


@pytest.mark.parametrize('scale', [1.0, 1e-300, 1e308])
@pytest.mark.parametrize('policy', ['valid', 'missing', 'notApplicable'])
def test_zero_response_mass_is_distinct_from_zero_respondent_mass(scale, policy):
    rows = [Row('r1', 0, 0, scale, policy, ()), Row('r2', 0, 0, scale, policy, ())]
    result = check(rows, policy=policy)
    assert result['totalResponses'] == 0 and result['weightedResponses'] == 0
    assert [i['pctResponse'] for i in result['items']] == [None, None]
    assert [i['pctRespondent'] for i in result['items']] == ([0, 0] if policy == 'valid' else [None, None])


@pytest.mark.parametrize('weighted', [False, True])
def test_empty_frame_has_no_mass_or_masks(weighted):
    result = check([], weighted=weighted)
    assert result['denominators']['total'] == 0 and result['totalResponses'] == 0


@pytest.mark.parametrize('ordering', ['original', 'reverse', 'rotate'])
@pytest.mark.parametrize('option_order', [('a', 'b'), ('b', 'a')])
def test_aggregate_tiny_option_mass_keeps_a_positive_subnormal_percentage(ordering, option_order):
    rows = [Row(f'tiny-{i}', 1, 0, 1e-16, 'valid', ('a',)) for i in range(10)]
    rows.append(Row('giant', 0, 1, 1e308, 'valid', ('b',)))
    if ordering == 'reverse':
        rows.reverse()
    elif ordering == 'rotate':
        rows = rows[5:] + rows[:5]
    result = check(rows, selected=('tiny-0', 'tiny-9', 'giant'), option_order=option_order)
    exact = oracle(rows)['items']['a']['pctResponse']
    assert float(exact).hex() == '0x0.00000000000cap-1022'
    item = next(i for i in result['items'] if i['columnId'] == 'a')
    assert item['pctResponse'] > 0 and item['pctRespondent'] > 0
    assert item['selectedWeighted'] > 0


@pytest.mark.parametrize('scale', [1.0, 4e307])
@pytest.mark.parametrize('reverse_rows', [False, True])
def test_masks_cross_byte_boundaries_without_weight_or_classification_leakage(scale, reverse_rows):
    rows = [
        Row('r1', 1, 0, scale, 'valid', ('a',)),
        Row('r2', 1, 1, 2 * scale, 'valid', ('a', 'b')),
        Row('r3', 99, 99, scale, 'missing', ()),
        Row('r4', 1, 99, scale, 'partial', ('a',)),
        Row('r5', 2, 0, scale, 'invalid', ()),
        Row('r6', 98, 98, scale, 'notApplicable', ()),
        Row('r7', 0, 0, 0.0, 'valid', ()),
        Row('r8', 0, 1, 0.0, 'valid', ('b',)),
        Row('r9', 0, 1, None, 'valid', ('b',)),
        Row('r10', 1, 0, None, 'valid', ('a',)),
    ]
    if reverse_rows:
        rows.reverse()
    selected = ('r1', 'r4', 'r8', 'r9', 'r10', 'r10', 'unknown')
    result = check(rows, selected=selected, member_order=('b', 'a'), option_order=('b', 'a'))
    assert [i['selectedInSelection'] for i in result['items']] == [2, 2]
    without_selection = check(rows, selected=(), member_order=('b', 'a'), option_order=('b', 'a'))
    for item in result['items']:
        item['selectedInSelection'] = 0
    assert result == without_selection


def test_max_selections_exclusion_and_weight_length_error_keep_the_existing_boundary():
    rows = [Row('r1', 1, 0, 1e-300, 'valid', ('a',)),
            Row('r2', 1, 1, 1e308, 'invalid', ('a', 'b'))]
    check(rows, maximum=1)
    with pytest.raises(BizError) as error:
        summarize_group(frame(rows), group(), weights=[1.0])
    assert error.value.code == 'CROSSTAB_WEIGHT_LENGTH'
