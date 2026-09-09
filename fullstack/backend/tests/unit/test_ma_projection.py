import polars as pl

from app.domain.ma_projection import append_ma_axes, plan_ma_axes


def test_custom_codes_and_all_answer_states_keep_row_ids_and_mask_every_derived_axis():
    columns = [{'columnId': name, 'name': name, 'multiResponseGroup': 'q', 'scaleType': 'nominal',
                'role': 'question', 'missingCodes': ['98', '99'], 'missingReasons': {'98': '非該当', '99': '無回答'}} for name in ['a', 'b']]
    codebook = {'columns': columns, 'multiResponseGroups': [{'groupId': 'q', 'label': 'Q',
                'selectedCodes': ['2'], 'unselectedCodes': ['3'], 'maxSelections': 1}]}
    frame = pl.DataFrame({'__rowId__': list('abcdefg'), 'a': [2, 3, 2, 99, 98, 7, 2], 'b': [3, 3, 99, 99, 98, 3, 2]})
    axes = [{'key': 'a-axis', 'kind': 'maOption', 'groupId': 'q', 'columnId': 'a'},
            {'key': 'n-axis', 'kind': 'maCount', 'groupId': 'q'}]
    plans, deps = plan_ma_axes(codebook, axes, set(frame.columns))
    assert deps == ['a', 'b']
    result = append_ma_axes(frame, plans)
    assert result['__rowId__'].to_list() == list('abcdefg')
    assert result['a-axis'].to_list() == [1, 0, None, None, None, None, None]
    assert result['n-axis'].to_list() == [1, 0, None, None, None, None, None]
