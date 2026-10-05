"""Real Kakegawa closed-domain edits have one complete-case population.

Preparation is tested independently of numerical fitting. Explicit row scope is
intentionally reversed to verify each service's ordering and value alignment.
"""
from __future__ import annotations

import copy
from contextlib import nullcontext

import numpy as np
import polars as pl
import pytest

from app.domain.analysis_frame import prepare_famd_frame, prepare_regression_frame
from app.domain.sparse_pca_contracts import SparsePcaRequest
from app.domain.sparse_pca_frame import prepare_sparse_pca_frame
from app.services.builtin_samples import install_codebook, load_sample
from app.services.dataset_service import generate_initial_codebook
from app.services.factor_analysis_service import prepare_efa_frame
from app.services.import_service import probe_table


class SnapshotStore:
    def __init__(self, frame, codebook):
        self.frame, self.codebook = frame, codebook

    def lock(self, _dataset_id):
        return nullcontext()

    def get_meta(self, _dataset_id):
        return {"dataRevision": 1}

    def load_codebook(self, _dataset_id):
        return self.codebook

    def get_dataframe(self, _dataset_id, columns=None):
        return self.frame.select(columns) if columns is not None else self.frame

    def load_mask(self, _dataset_id):
        return {}

    def mask_revision(self, _dataset_id):
        return 0


@pytest.fixture(scope="module")
def kakegawa():
    raw, template = load_sample("kakegawa-citizen2022-adult600")
    codebook = install_codebook(generate_initial_codebook("kakegawa", probe_table(raw, raw.height)), template)
    frame = raw.with_columns(pl.Series("__rowId__", [f"r{i}" for i in range(raw.height)]))
    return frame, codebook


@pytest.mark.parametrize("method", ["sparse_pca", "efa", "regression", "famd"])
@pytest.mark.parametrize("domain_size", [3, 4])
@pytest.mark.parametrize("scope", ["all", "reversed_explicit"])
def test_edited_interval_domain_controls_fit_rows_and_exact_values(kakegawa, method, domain_size, scope):
    frame, original_book = kakegawa
    before = frame.clone()
    book = copy.deepcopy(original_book)
    names = [f"問20_満足度_0{i}" for i in (1, 2, 3)]
    specs = [next(c for c in book["columns"] if c["name"] == name) for name in names]
    allowed = list(range(1, domain_size + 1))
    for spec in specs:
        spec.update(categoryOrder=[str(value) for value in allowed], scaleType="interval")
    context = {"datasetId": "kakegawa", "expectedDataRevision": 1,
               "expectedSchemaRevision": 1, "weightMode": "none"}
    source = frame
    if scope == "reversed_explicit":
        requested_ids = frame["__rowId__"].to_list()[::3][::-1]
        context.update(scope="explicit", rowIds=requested_ids)
        source = frame.filter(pl.col("__rowId__").is_in(requested_ids))
    # Raw response values, not any application adapter, define this oracle.
    expected = source.filter(pl.all_horizontal([pl.col(name).is_in(allowed) for name in names]))
    expected_ids = expected["__rowId__"].to_list()
    expected_count = {(3, "all"): 200, (4, "all"): 252,
                      (3, "reversed_explicit"): 74, (4, "reversed_explicit"): 90}[domain_size, scope]
    assert len(expected_ids) == expected_count
    store = SnapshotStore(frame, book)
    refs = [spec["columnId"] for spec in specs]
    if method == "sparse_pca":
        request = SparsePcaRequest.model_validate({"context": context, "nComponents": 1,
            "variables": [{"columnId": ref, "kind": "numeric"} for ref in refs]})
        prepared = prepare_sparse_pca_frame(request, meta={"dataRevision": 1}, codebook=book,
                                            data=frame, mask={}, mask_revision=0)
        expected_order = ([rid for rid in context["rowIds"] if rid in set(expected_ids)]
                          if scope == "reversed_explicit" else expected_ids)
        assert prepared.row_ids == expected_order
        by_id = {row["__rowId__"]: row for row in expected.to_dicts()}
        values = [[by_id[rid][name] for name in names] for rid in expected_order]
        np.testing.assert_array_equal(prepared.values, values)
        assert not prepared.values.flags.writeable
    elif method == "efa":
        prepared = prepare_efa_frame("kakegawa", {"context": context,
            "variables": [{"columnId": ref, "measurement": "continuous", "treatment": "continuous"}
                          for ref in refs]}, store)
        assert prepared["fitIds"] == expected_ids
        np.testing.assert_array_equal(prepared["contVals"][prepared["fitIndex"]], expected.select(names).to_numpy())
        assert set(prepared["excludedIds"]).isdisjoint(expected_ids)
        assert len(prepared["excludedIds"]) + len(expected_ids) == source.height
    elif method == "regression":
        prepared = prepare_regression_frame(dataset_id="kakegawa", context_dict=context,
            target_ref=refs[2], predictor_specs=[{"columnId": ref, "kind": "numeric"} for ref in refs[:2]],
            interactions=[], store=store)
        assert prepared.row_ids == expected_ids
        np.testing.assert_array_equal(prepared.target_values, expected[names[2]].to_numpy())
        for name in names[:2]:
            np.testing.assert_array_equal(prepared.numeric_inputs[name], expected[name].to_numpy())
        assert [prepared.design_row_ids[pos] for pos in prepared.fit_pos_in_design] == expected_ids
    else:
        specs[2]["scaleType"] = "nominal"
        prepared = prepare_famd_frame(dataset_id="kakegawa", context_dict=context,
            numeric_refs=refs[:2], categorical_refs=refs[2:], store=store)
        assert prepared.row_ids == expected_ids
        assert prepared.numeric_names == names[:2]
        np.testing.assert_array_equal(np.asarray(prepared.numeric_values).T, expected.select(names[:2]).to_numpy())
        categories = prepared.variables[0]["categories"]
        for category in categories:
            positions = [i for i, raw in enumerate(expected[names[2]]) if str(raw) == category["code"]]
            assert category["rows"] == positions
            assert category["count"] == len(positions)
    # Neither preparation nor the metadata edit changes the raw sample or cache.
    assert frame.equals(before)
    assert all(c["scaleType"] == "ordinal" for c in original_book["columns"] if c["name"] in names)
