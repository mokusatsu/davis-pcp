import polars as pl

from app.algorithms.relationships.surprise import compute_phik_and_surprise


def test_empty_targets_stay_empty_and_same_parent_pairs_require_explicit_opt_in():
    frame = pl.DataFrame({'__rowId__': [f'r{i}' for i in range(12)], 'a': [0, 1] * 6,
                          'b': [1, 0] * 6, 'x': [0, 0, 1, 1] * 3})
    metadata = [{'name': name, 'semanticType': 'categorical', 'multiResponseGroup': 'q' if name != 'x' else None}
                for name in ['a', 'b', 'x']]
    assert compute_phik_and_surprise(frame, columns=[], column_meta=metadata)['pairs'] == []
    result = compute_phik_and_surprise(frame, columns=['a', 'b', 'x'], column_meta=metadata)
    assert {frozenset((pair['x']['name'], pair['y']['name'])) for pair in result['pairs']} == {frozenset(('a', 'x')), frozenset(('b', 'x'))}
    included = compute_phik_and_surprise(frame, columns=['a', 'b'], column_meta=metadata, include_same_ma=True)
    assert len(included['pairs']) == 1
