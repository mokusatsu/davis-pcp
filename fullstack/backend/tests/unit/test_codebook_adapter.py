import polars as pl
import pytest
from app.domain.codebook_adapter import CodebookAdapter


def test_codebook_adapter_basic():
    df = pl.DataFrame({
        "Q1": [1, 2, 3, 98, 99],
        "gender": [1, 2, 1, 2, 1],
        "age": [20, 30, 40, 50, 60],
    })

    codebook = {
        "datasetId": "test_ds",
        "schemaRevision": 1,
        "columns": [
            {
                "columnId": "col-q1",
                "name": "Q1",
                "label": "満足度",
                "scaleType": "ordinal",
                "role": "question",
                "valueLabels": {"1": "不満", "2": "普通", "3": "満足"},
                "categoryOrder": ["1", "2", "3"],
                "missingCodes": ["98", "99"],
                "missingReasons": {"98": "非該当", "99": "無回答"},
                "isReversed": True,
            },
            {
                "columnId": "col-gender",
                "name": "gender",
                "label": "性別",
                "scaleType": "nominal",
                "role": "attribute",
                "valueLabels": {"1": "男性", "2": "女性"},
                "categoryOrder": ["1", "2"],
                "missingCodes": [],
                "isReversed": False,
            },
            {
                "columnId": "col-age",
                "name": "age",
                "label": "年齢",
                "scaleType": "ratio",
                "role": "attribute",
                "isReversed": False,
            },
        ],
    }

    adapter = CodebookAdapter(df, codebook)

    # Question & attribute pools
    assert adapter.get_question_columns() == ["Q1"]
    assert set(adapter.get_attribute_columns()) == {"gender", "age"}

    # Spec lookup
    assert adapter.get_column_spec("col-q1")["name"] == "Q1"
    assert adapter.get_column_spec("Q1")["columnId"] == "col-q1"

    # Category order
    assert adapter.get_ordered_categories("Q1") == ["1", "2", "3"]

    # Label lookup
    assert adapter.label_for_value("Q1", 1) == "不満"
    assert adapter.label_for_value("Q1", 2) == "普通"
    assert adapter.label_for_value("Q1", 99) == "99"

    # Missing masking
    masked = adapter.mask_missing_values("Q1")
    assert masked.to_list() == [1, 2, 3, None, None]

    # Reversed numeric
    # Valid values: [1, 2, 3] -> min=1, max=3, sum=4 -> 4 - X: 4-1=3, 4-2=2, 4-3=1
    rev = adapter.get_reversed_numeric_series("Q1")
    assert rev.to_list() == [3.0, 2.0, 1.0, None, None]
