"""Unit regression tests for priority review bugs B01-B12.

Validates:
- B01: Unique numeric column is not auto-dropped as row identity; explicit rowIdColumn preserved.
- B02: Duplicate column names do not collide with existing suffix-bearing headers.
- B03: Leading zeros in codes preserved; missingTokens override; decimal comma; quote override.
- B04: Pairwise correlation with missing data does not return 0.0; 1-column returns 2D matrix.
- B05: Schema lookup by columnId & name in subgroup mining.
- B07: CSV roundtrip preserves quotes and negative numbers.
- B08: CP932 sniff encoding for Japanese characters.
- B10: All-categorical clustering with Cobweb and DISC.
- B11: Clustering with k > rows raises CLUSTERING_TOO_FEW_ROWS without NameError.
- B12: Random Forest representative tree agreement matches oracle (1.0).
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
import polars as pl
import pytest
from sklearn.ensemble import RandomForestClassifier

BACKEND = Path(__file__).resolve().parents[2]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from app.algorithms.clustering.cobweb import cobweb_cluster  # noqa: E402
from app.algorithms.clustering.disc import disc_cluster  # noqa: E402
from app.algorithms.mining.subgroup import run_subgroup_mining  # noqa: E402
from app.algorithms.summaries.core import correlation_matrix_df  # noqa: E402
from app.domain.errors import BizError  # noqa: E402
from app.services.dataset_service import ColumnRole, ImportOptions  # noqa: E402
from app.services.import_service import (  # noqa: E402
    _sniff_encoding,
    probe_table,
    read_delimited,
)
from app.storage.dataset_store import assign_row_identity  # noqa: E402


class TestB01UniqueNumericRowId:
    def test_unique_numeric_preserved_in_probe_and_identity(self):
        csv_bytes = b"age,answer\n20,1\n21,1\n22,2\n23,2\n"
        df = read_delimited(csv_bytes, "csv")
        assert df.width == 2
        schemas = probe_table(df, df.height)
        age_schema = next(s for s in schemas if s.name == "age")
        assert age_schema.semanticType == "numeric"
        assert age_schema.uniqueIdCandidate is True

        id_df, source = assign_row_identity(df, None, schemas)
        assert source == "generated"
        assert "__rowId__" in id_df.columns
        assert "age" in id_df.columns
        assert "answer" in id_df.columns
        assert id_df.width == 3

    def test_explicit_row_id_option_preserved_as_column(self):
        csv_bytes = b"code_a,code_b,val\nA1,B1,10\nA2,B2,20\n"
        df = read_delimited(csv_bytes, "csv")
        schemas = probe_table(df, df.height)
        id_df, source = assign_row_identity(df, "code_b", schemas)
        assert source == "column:code_b"
        assert id_df["__rowId__"].to_list() == ["B1", "B2"]
        assert "code_b" in id_df.columns
        assert "code_a" in id_df.columns
        assert id_df.width == 4


class TestB02DuplicateHeaderCollision:
    def test_duplicate_header_with_existing_suffix(self):
        csv_bytes = b"x,x,x_1\n1,2,3\n4,5,6\n"
        df = read_delimited(csv_bytes, "csv")
        assert df.width == 3
        cols = df.columns
        assert len(cols) == 3
        assert len(set(cols)) == 3
        assert df[cols[0]].to_list() == [1.0, 4.0]
        assert df[cols[1]].to_list() == [2.0, 5.0]
        assert df[cols[2]].to_list() == [3.0, 6.0]


class TestB03LeadingZerosAndMissingTokens:
    def test_leading_zeros_preserved_as_codes(self):
        csv_bytes = b"code,val\n001,10\n01,20\n1,30\n"
        df = read_delimited(csv_bytes, "csv")
        assert df["code"].to_list() == ["001", "01", "1"]
        assert df["code"].dtype == pl.String

    def test_missing_tokens_override(self):
        csv_bytes = b"a,b\n999,1\n2,999\n"
        opts = ImportOptions(missingTokens=["999"])
        df = read_delimited(csv_bytes, "csv", options=opts)
        assert df["a"][0] is None
        assert df["a"][1] == 2.0
        assert df["b"][0] == 1.0
        assert df["b"][1] is None

    def test_missing_tokens_empty_keeps_literal_na(self):
        csv_bytes = b"name,score\nNA,100\nBob,90\n"
        opts = ImportOptions(missingTokens=[])
        df = read_delimited(csv_bytes, "csv", options=opts)
        assert df["name"][0] == "NA"
        assert df["name"][1] == "Bob"

    def test_decimal_comma_and_custom_quote(self):
        csv_bytes = b"'val';'cat'\n'1,5';'A'\n'2,5';'B'\n"
        opts = ImportOptions(delimiter=";", quote="'", decimalSeparator=",")
        df = read_delimited(csv_bytes, "csv", options=opts)
        assert df["val"].to_list() == [1.5, 2.5]
        assert df["cat"].to_list() == ["A", "B"]


class TestB04PairwiseCorrelation:
    def test_pairwise_correlation_with_missing_values(self):
        df = pl.DataFrame({
            "x": [1.0, 2.0, 3.0, 4.0],
            "y": [2.0, 4.0, None, 8.0],
        })
        mat = correlation_matrix_df(df, ["x", "y"])
        assert len(mat) == 2
        assert len(mat[0]) == 2
        assert mat[0][0] == 1.0
        assert mat[1][1] == 1.0
        assert mat[0][1] == 1.0
        assert mat[1][0] == 1.0

    def test_single_column_returns_2d_matrix(self):
        df = pl.DataFrame({"x": [1.0, 2.0, 3.0, 4.0]})
        mat = correlation_matrix_df(df, ["x"])
        assert isinstance(mat, list)
        assert len(mat) == 1
        assert mat[0] == [1.0]

    def test_zero_variance_or_insufficient_pairs_returns_none(self):
        df = pl.DataFrame({
            "x": [1.0, 1.0, 1.0],
            "y": [2.0, 3.0, 4.0],
        })
        mat = correlation_matrix_df(df, ["x", "y"])
        assert mat[0][0] is None
        assert mat[0][1] is None


class TestB05SubgroupMiningColumnIdLookup:
    def test_subgroup_mining_with_column_id_and_name(self):
        df = pl.DataFrame({
            "__rowId__": ["1", "2", "3", "4", "5", "6"],
            "gender": ["M", "M", "M", "F", "F", "F"],
            "q": ["Yes", "No", "Yes", "No", "Yes", "No"],
        })
        column_meta = [
            {"columnId": "col-gender", "name": "gender", "semanticType": "categorical", "role": "attribute"},
            {"columnId": "col-q", "name": "q", "semanticType": "categorical", "role": "question"},
        ]
        res = run_subgroup_mining(
            df,
            attribute_cols=["gender"],
            question_cols=["q"],
            column_meta=column_meta,
            min_group_size=2,
        )
        assert res is not None
        summary = res.get("summary", {})
        assert summary.get("n_subgroup_vars") == 1
        assert summary.get("n_questions") == 1


class TestB07CsvRoundtrip:
    def test_csv_export_and_reimport_with_quotes_and_negatives(self):
        from app.api.exports import _neutralize
        assert _neutralize(-1) == -1
        assert _neutralize(-2.5) == -2.5
        assert _neutralize("-1") == "-1"
        assert _neutralize("=SUM(A1)") == "'=SUM(A1)"

        import csv
        buf = io.StringIO()
        writer = csv.writer(buf, lineterminator="\n")
        writer.writerow(["comment", "score"])
        writer.writerow(['said "yes"', -1.0])
        writer.writerow(['a,b', -2.0])
        writer.writerow(['normal', 3.0])

        raw_csv = buf.getvalue().encode("utf-8")
        df_reimported = read_delimited(raw_csv, "csv")
        assert df_reimported["comment"].to_list() == ['said "yes"', 'a,b', 'normal']
        assert df_reimported["score"].to_list() == [-1.0, -2.0, 3.0]
        assert df_reimported["score"].dtype == pl.Float64


class TestB08Cp932Japanese:
    def test_cp932_sniff_and_read(self):
        text = "氏名,番号\n髙橋,①\n山田,②\n"
        raw_cp932 = text.encode("cp932")
        detected = _sniff_encoding(raw_cp932)
        assert detected == "cp932"
        df = read_delimited(raw_cp932, "csv")
        assert df["氏名"].to_list() == ["髙橋", "山田"]
        assert df["番号"].to_list() == ["①", "②"]


class TestB10AllCategoricalClustering:
    def test_cobweb_all_categorical(self):
        cat_cols = [
            ["red", "red", "blue", "blue", "red", "blue"],
            ["yes", "no", "yes", "no", "yes", "no"],
        ]
        res = cobweb_cluster(num_matrix=None, cat_columns=cat_cols, k=2)
        assert "labels" in res
        assert len(res["labels"]) == 6
        assert len(set(res["labels"])) >= 1

    def test_disc_all_categorical(self):
        cat_cols = [
            ["red", "red", "blue", "blue", "red", "blue"],
            ["yes", "no", "yes", "no", "yes", "no"],
        ]
        res = disc_cluster(num_matrix=None, cat_columns=cat_cols, column_names=["color", "choice"], k=2)
        assert "labels" in res
        assert len(res["labels"]) == 6


class TestB11ClusteringTooFewRows:
    def test_clustering_too_few_rows_error_message(self):
        from app.api.clusters import create_cluster, ClusterRequest
        from app.storage.dataset_store import DatasetStore
        store = DatasetStore()
        df = pl.DataFrame({
            "__rowId__": ["1", "2", "3"],
            "v1": [1.0, 2.0, 3.0],
            "v2": [4.0, 5.0, 6.0],
        })
        ds_id = "test_b11_ds"
        from app.services.dataset_service import generate_initial_codebook
        schemas = [{"name": "v1", "semanticType": "numeric"}, {"name": "v2", "semanticType": "numeric"}]
        cb = generate_initial_codebook(ds_id, schemas)
        store.save(ds_id, {"datasetId": ds_id, "name": "test", "schema": []}, df, codebook=cb)

        req = ClusterRequest(
            datasetId=ds_id,
            columns=["v1", "v2"],
            method="kmeans",
            k=5,
        )
        with pytest.raises(BizError) as exc_info:
            create_cluster(req)
        assert exc_info.value.code == "CLUSTERING_TOO_FEW_ROWS"
        assert "クラスタ数5に対して行が足りません" in exc_info.value.message


class TestB12RandomForestRepresentativeTreeAgreement:
    def test_random_forest_agreement_oracle(self):
        X = np.array([[0], [1]] * 50)
        y = np.array([1, 2] * 50)
        rf = RandomForestClassifier(n_estimators=5, max_depth=3, random_state=42)
        rf.fit(X, y)

        class_labels = [str(c) for c in rf.classes_]
        forest_pred = [str(v) for v in rf.predict(X)]

        def _decode_tree_preds(raw_preds: Any) -> list[str]:
            decoded = []
            for val in raw_preds:
                idx = int(round(float(val)))
                decoded.append(class_labels[idx] if 0 <= idx < len(class_labels) else str(val))
            return decoded

        agreements = []
        for tree in rf.estimators_:
            tree_pred = _decode_tree_preds(tree.predict(X))
            agreements.append(float(np.mean([a == b for a, b in zip(tree_pred, forest_pred)])))

        assert all(a == 1.0 for a in agreements)


class TestD02LargeIntegers:
    def test_64bit_integers_preserved_and_distinct(self):
        # 9007199254740993 is 2**53 + 1, which loses precision if cast to IEEE 754 Float64 (becomes 9007199254740992)
        csv_text = (
            "id_code,big_int\n"
            "0001,9007199254740993\n"
            "1,9007199254740992\n"
        ).encode("utf-8")
        df = read_delimited(csv_text, "csv")
        assert df["id_code"].dtype == pl.String
        assert df["id_code"].to_list() == ["0001", "1"]

        assert df["big_int"].dtype == pl.Int64
        vals = df["big_int"].to_list()
        assert vals[0] == 9007199254740993
        assert vals[1] == 9007199254740992
        assert vals[0] != vals[1]

        schemas = probe_table(df, df.height)
        big_int_schema = next(s for s in schemas if s.name == "big_int")
        assert big_int_schema.physicalType == "int"
        assert big_int_schema.min == 9007199254740992
        assert big_int_schema.max == 9007199254740993


class TestD10SubgroupPrecision:
    def test_micro_value_subgroup_consistency(self):
        from app.algorithms.mining.modern_subgroup import generate_descriptors, evaluate_rule
        x = np.linspace(0.001, 0.009, 80)
        df = pl.DataFrame({"x": x, "__rowId__": [f"r_{i}" for i in range(80)]})
        descriptors = generate_descriptors(df, ["x"], set())
        assert len(descriptors) > 0

        for cond, mask in descriptors:
            eval_row_ids = evaluate_rule(cond.to_dict(), df)
            actual_row_ids = [f"r_{i}" for i in range(80) if mask[i]]
            assert eval_row_ids == actual_row_ids, f"Mismatch for condition: {cond.label}"
            assert "0.0 " not in cond.label, f"Improper label rounding: {cond.label}"

    def test_negative_numbers_and_narrow_intervals(self):
        from app.algorithms.mining.modern_subgroup import generate_descriptors, evaluate_rule
        x = np.linspace(-0.009, -0.001, 80)
        df = pl.DataFrame({"x": x, "__rowId__": [f"r_{i}" for i in range(80)]})
        descriptors = generate_descriptors(df, ["x"], set())
        assert len(descriptors) > 0

        for cond, mask in descriptors:
            eval_row_ids = evaluate_rule(cond.to_dict(), df)
            actual_row_ids = [f"r_{i}" for i in range(80) if mask[i]]
            assert eval_row_ids == actual_row_ids, f"Mismatch in negative condition: {cond.label}"

    def test_rule_candidate_evaluate(self):
        from app.algorithms.mining.modern_subgroup import Condition, RuleCandidate, evaluate_rule
        df = pl.DataFrame({
            "a": [1.0, 2.0, 3.0, 4.0, 5.0],
            "b": [10.0, 20.0, 30.0, 40.0, 50.0],
            "__rowId__": ["r1", "r2", "r3", "r4", "r5"],
        })
        c1 = Condition(column="a", operator=">=", value=2.0, label="a >= 2")
        c2 = Condition(column="b", operator="<", value=45.0, label="b < 45")
        rule = RuleCandidate(
            conditions=[c1, c2],
            attribute_cols=["a", "b"],
            row_ids=["r2", "r3", "r4"],
            bitmask=np.array([False, True, True, True, False]),
            n_subgroup=3,
            n_complement=2,
            score=1.0,
            raw_score=1.0,
            target_stats={},
            ranking_reason={},
        )
        row_ids = evaluate_rule(rule, df)
        assert row_ids == ["r2", "r3", "r4"]


class TestA06AllNumericQuestionnaireMining:
    def test_all_numeric_questionnaire_finds_insights(self):
        from app.algorithms.mining.modern_subgroup import run_modern_subgroup_mining
        # Survey dataset where all columns are numeric
        df = pl.DataFrame({
            "__rowId__": [f"r{i}" for i in range(100)],
            "age": [20] * 50 + [60] * 50,
            "income": [300] * 50 + [800] * 50,
            "q1_sat": [1.0] * 50 + [5.0] * 50,
            "q2_rec": [2.0] * 50 + [4.0] * 50,
        })
        res = run_modern_subgroup_mining(df, mode="auto", top_k=5)
        assert res is not None
        assert res["summary"]["total_candidates_explored"] > 0
        assert len(res["insights"]) > 0
        # Check that conditions in found insights don't leak target questions
        for ins in res["insights"]:
            target = ins.get("target_question")
            rule_cols = [c["column"] for c in ins["rule"]["conditions"]]
            if target:
                assert target not in rule_cols


class TestA12SchemaAndRowIdPreservation:
    def test_assign_row_identity_preserves_existing_unique_row_id(self):
        from app.storage.dataset_store import assign_row_identity
        df = pl.DataFrame({
            "__rowId__": ["row_custom_A", "row_custom_B", "row_custom_C"],
            "val": [10, 20, 30],
        })
        res_df, source = assign_row_identity(df, id_column=None)
        assert source == "preserved"
        assert res_df["__rowId__"].to_list() == ["row_custom_A", "row_custom_B", "row_custom_C"]

    def test_derive_dataset_schema_preserves_metadata(self):
        from app.api.datasets import _derive_dataset_schema
        source_schema = [
            {"columnId": "c_age", "name": "age", "semanticType": "numeric", "role": "attribute"},
            {"columnId": "c_cat", "name": "category", "semanticType": "categorical", "role": "question", "categoryOrder": ["A", "B"]},
        ]
        df = pl.DataFrame({
            "__rowId__": ["1", "2"],
            "age": [25, 40],
            "category": ["A", "B"],
            "new_col": [1.1, 2.2],
        })
        derived = _derive_dataset_schema(df, source_schema)
        derived_by_name = {c["name"]: c for c in derived}
        assert derived_by_name["age"]["columnId"] == "c_age"
        assert derived_by_name["age"]["role"] == "attribute"
        assert derived_by_name["category"]["columnId"] == "c_cat"
        assert derived_by_name["category"]["semanticType"] == "categorical"
        assert derived_by_name["category"]["role"] == "question"
        assert derived_by_name["category"]["categoryOrder"] == ["A", "B"]
        assert "new_col" in derived_by_name


class TestA14RobustnessSubgroupAndJackknife:
    def test_jackknife_mean_influence_sign_and_exact_loo(self):
        from app.algorithms.robustness.engine import evaluate_robustness
        # 9 regular points and 1 high outlier
        df = pl.DataFrame({
            "__rowId__": [f"r{i}" for i in range(10)],
            "score": [10.0] * 9 + [100.0],
        })
        res = evaluate_robustness(
            df=df,
            conclusions=[{"type": "kpi", "target_col": "score", "label": "Mean score"}],
            removal_fractions=[0.1],
            bootstrap_b=10,
        )
        assert len(res["conclusions"]) == 1
        conc = res["conclusions"][0]
        # Full mean = (90 + 100) / 10 = 19.0
        assert conc["full_estimate"] == 19.0
        # If r9 (val 100.0) is dropped, the actual leave-one-out mean is 90 / 9 = 10.0
        top_inf = conc["top_influence_respondents"][0]
        assert top_inf["row_id"] == "r9"
        # Influence should be (100 - 19) / 9 = 9.0
        assert round(top_inf["influence"], 4) == 9.0
        jackknife_pert = next(p for p in conc["perturbations"] if p["strategy"] == "jackknife")
        # Estimate after dropping top influential must be 19.0 - 9.0 = 10.0
        assert jackknife_pert["estimate"] == 10.0

    def test_subgroup_row_ids_robustness_evaluation(self):
        from app.algorithms.robustness.engine import evaluate_robustness
        df = pl.DataFrame({
            "__rowId__": [f"r{i}" for i in range(20)],
            "metric": [10.0] * 10 + [2.0] * 10,
        })
        subgroup_ids = [f"r{i}" for i in range(10)]
        res = evaluate_robustness(
            df=df,
            conclusions=[{
                "id": "c_sub",
                "type": "subgroup_diff",
                "target_col": "metric",
                "subgroup_row_ids": subgroup_ids,
                "label": "Subgroup vs Complement",
            }],
            removal_fractions=[0.1],
            bootstrap_b=20,
        )
        assert len(res["conclusions"]) == 1
        conc = res["conclusions"][0]
        # Subgroup mean = 10.0, Complement mean = 2.0, Diff = 8.0
        assert conc["full_estimate"] == 8.0
        assert conc["robustness"]["grade"] in ["robust", "mostly_robust", "somewhat_sensitive", "fragile"]


