"""Factor extension contract tests (standard library unittest only)."""
from pathlib import Path
import copy
import json
import sys
import unittest

from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "contracts"))
from factor_extension_requests import CFARequest, EFARequest  # noqa: E402


def load(name):
    return json.loads((ROOT / "contracts" / "examples" / name).read_text(encoding="utf-8"))


def efa_payload():
    return load("efa.request.json")


def cfa_payload():
    return load("cfa.request.json")


def ordinal_var(column, order=None, **over):
    body = {
        "columnId": column,
        "measurement": "ordinal",
        "treatment": "ordinal",
        "categoryOrder": list(order or ["1", "2", "3", "4", "5"]),
        "reverse": False,
        "approximationAcknowledged": False,
    }
    body.update(over)
    return body


def approx_var(column, order=None):
    return ordinal_var(
        column,
        order=order,
        treatment="continuous_approximation",
        approximationAcknowledged=True,
    )


def continuous_var(column):
    return {
        "columnId": column,
        "measurement": "continuous",
        "treatment": "continuous",
        "categoryOrder": None,
        "reverse": False,
        "approximationAcknowledged": False,
    }


def set_cfa_variables(payload, variables):
    payload["variables"] = variables
    return payload


class FactorExtensionContractTests(unittest.TestCase):
    def test_sensitivity_requires_explicit_acknowledgement(self):
        for enabled, acknowledged in ((True, False), (False, True)):
            with self.subTest(enabled=enabled, acknowledged=acknowledged):
                bad = efa_payload()
                bad["sensitivityAnalysis"] = {
                    "enabled": enabled, "approximationAcknowledged": acknowledged}
                with self.assertRaises(ValidationError):
                    EFARequest.model_validate(bad)

    def test_sensitivity_is_disabled_when_omitted(self):
        good = efa_payload()
        good.pop("sensitivityAnalysis", None)
        self.assertFalse(EFARequest.model_validate(good).sensitivityAnalysis.enabled)

    def test_sensitivity_preserves_primary_ml_and_ordinal_measurement(self):
        good = efa_payload()
        good["variables"] = [approx_var(f"q{i}") for i in range(1, 7)]
        good["correlation"] = "pearson"
        good["extraction"] = "ml"
        parsed = EFARequest.model_validate(good)
        self.assertEqual(parsed.extraction, "ml")
        self.assertEqual(parsed.sensitivityAnalysis.comparisonExtraction, "minres")
        self.assertTrue(all(v.measurement == "ordinal" for v in parsed.variables))

    def test_sensitivity_rejects_original_continuous_variables(self):
        bad = efa_payload()
        bad["variables"] = [continuous_var(f"q{i}") for i in range(1, 7)]
        bad["correlation"] = "pearson"
        with self.assertRaises(ValidationError):
            EFARequest.model_validate(bad)
        bad["sensitivityAnalysis"] = {"enabled": False, "approximationAcknowledged": False}
        self.assertEqual(EFARequest.model_validate(bad).correlation, "pearson")

    def test_sensitivity_requires_parallel_analysis(self):
        bad = efa_payload()
        bad["parallelAnalysis"]["enabled"] = False
        with self.assertRaises(ValidationError):
            EFARequest.model_validate(bad)

    def test_sensitivity_rejects_alternative_alignment_or_extraction(self):
        for key, value in (("alignment", "procrustes"), ("comparisonExtraction", "ml")):
            with self.subTest(field=key):
                bad = efa_payload()
                bad["sensitivityAnalysis"][key] = value
                with self.assertRaises(ValidationError):
                    EFARequest.model_validate(bad)

    def test_sensitivity_threshold_ranges_and_finiteness(self):
        for key in ("loadingDifferenceThreshold", "communalityDifferenceThreshold",
                    "factorCorrelationDifferenceThreshold", "assignmentThreshold", "assignmentMargin"):
            for value in (-0.1, 1.1, float("nan"), float("inf")):
                with self.subTest(field=key, value=value):
                    bad = efa_payload()
                    bad["sensitivityAnalysis"][key] = value
                    with self.assertRaises(ValidationError):
                        EFARequest.model_validate(bad)
            for value in (0.01, 1.0):
                with self.subTest(valid_field=key, value=value):
                    good = efa_payload()
                    good["sensitivityAnalysis"][key] = value
                    EFARequest.model_validate(good)

    def test_sensitivity_does_not_make_cfa_a_comparison_request(self):
        bad = cfa_payload()
        bad["sensitivityAnalysis"] = efa_payload()["sensitivityAnalysis"]
        with self.assertRaises(ValidationError):
            CFARequest.model_validate(bad)

    def test_valid_examples(self):
        efa = EFARequest.model_validate(efa_payload())
        cfa = CFARequest.model_validate(cfa_payload())
        self.assertEqual([v.columnId for v in efa.variables], [f"q{i}" for i in range(1, 7)])
        self.assertEqual(
            (efa.correlation, efa.extraction, efa.rotation, efa.scoreMethod),
            ("polychoric", "minres", "promax", "none"))
        self.assertEqual(efa.nFactors, 2)
        self.assertTrue(efa.sensitivityAnalysis.enabled)
        self.assertEqual([f.markerColumnId for f in cfa.factors], ["q1", "q4"])
        self.assertEqual(cfa.estimator, "wlsmv")

    def test_static_schema_matches_model(self):
        for name, model in (("efa.schema.json", EFARequest), ("cfa.schema.json", CFARequest)):
            with self.subTest(schema=name):
                static = json.loads((ROOT / "contracts" / "schemas" / name).read_text(encoding="utf-8"))
                self.assertEqual(static, model.model_json_schema())

    def test_context_missing_policy_rejected(self):
        for make, model in ((efa_payload, EFARequest), (cfa_payload, CFARequest)):
            with self.subTest(model=model.__name__):
                bad = make()
                bad["context"]["missingPolicy"] = "include_missing"
                with self.assertRaises(ValidationError):
                    model.model_validate(bad)

    def test_context_column_weights_rejected_structurally(self):
        for make, model in ((efa_payload, EFARequest), (cfa_payload, CFARequest)):
            with self.subTest(model=model.__name__):
                bad = make()
                bad["context"]["weightMode"] = "column"
                bad["context"]["weightColumn"] = "w"
                bad["context"]["weightType"] = "survey"
                with self.assertRaises(ValidationError):
                    model.model_validate(bad)

    def test_context_dataset_mode_syntactically_valid(self):
        for make, model in ((efa_payload, EFARequest), (cfa_payload, CFARequest)):
            with self.subTest(model=model.__name__):
                base = make()
                good = {**base, "context": {**base["context"], "weightMode": "dataset"}}
                self.assertEqual(model.model_validate(good).context.weightMode, "dataset")

    def test_ordinal_correlation_extraction_score_mismatch(self):
        for key, value in (("correlation", "pearson"), ("extraction", "ml"), ("scoreMethod", "regression")):
            with self.subTest(field=key):
                bad = copy.deepcopy(efa_payload())
                bad[key] = value
                with self.assertRaises(ValidationError):
                    EFARequest.model_validate(bad)

    def test_non_ordinal_treatment_requires_pearson(self):
        bad = efa_payload()
        bad["variables"] = [
            approx_var("q1"), approx_var("q2"), approx_var("q3"),
            continuous_var("x1"), continuous_var("x2"), continuous_var("x3"),
        ]
        bad["correlation"] = "polychoric"
        with self.assertRaises(ValidationError):
            EFARequest.model_validate(bad)

    def test_invalid_ordinal_variable_states(self):
        for patch in (
            {"treatment": "continuous", "approximationAcknowledged": False},
            {"treatment": "ordinal", "approximationAcknowledged": True},
            {"treatment": "continuous_approximation", "approximationAcknowledged": False},
            {"treatment": "ordinal", "categoryOrder": ["1"]},
            {"treatment": "ordinal", "categoryOrder": ["1", "1", "2"]},
        ):
            with self.subTest(patch=patch):
                bad = efa_payload()
                bad["variables"][0] = {**ordinal_var("q1"), **patch}
                with self.assertRaises(ValidationError):
                    EFARequest.model_validate(bad)

    def test_invalid_continuous_variable_states(self):
        for patch in (
            {"treatment": "ordinal"},
            {"categoryOrder": ["1", "2"]},
            {"reverse": True},
            {"approximationAcknowledged": True},
        ):
            with self.subTest(patch=patch):
                bad = efa_payload()
                bad["variables"][0] = {**continuous_var("q1"), **patch}
                with self.assertRaises(ValidationError):
                    EFARequest.model_validate(bad)

    def test_mixed_ordinal_treatment_rejected_efa(self):
        bad = efa_payload()
        bad["variables"][1] = approx_var("q2")
        with self.assertRaises(ValidationError):
            EFARequest.model_validate(bad)

    def test_duplicate_variable_ids_rejected(self):
        for make, model in ((efa_payload, EFARequest), (cfa_payload, CFARequest)):
            with self.subTest(model=model.__name__):
                bad = make()
                bad["variables"][1]["columnId"] = bad["variables"][0]["columnId"]
                with self.assertRaises(ValidationError):
                    model.model_validate(bad)

    def test_cfa_duplicate_factor_ids_rejected(self):
        bad = cfa_payload()
        bad["factors"][1]["factorId"] = bad["factors"][0]["factorId"]
        with self.assertRaises(ValidationError):
            CFARequest.model_validate(bad)

    def test_cfa_duplicate_indicators_rejected(self):
        bad = cfa_payload()
        bad["factors"][1]["indicatorIds"][0] = "q1"
        with self.assertRaises(ValidationError):
            CFARequest.model_validate(bad)

    def test_cfa_missing_coverage_rejected(self):
        bad = cfa_payload()
        bad["factors"][1]["indicatorIds"] = ["q4", "q5", "q5b"]
        bad["factors"][1]["markerColumnId"] = "q4"
        with self.assertRaises(ValidationError):
            CFARequest.model_validate(bad)

    def test_cfa_invalid_marker_rejected(self):
        bad = cfa_payload()
        bad["factors"][0]["markerColumnId"] = "q4"
        with self.assertRaises(ValidationError):
            CFARequest.model_validate(bad)

    def test_category_order_preserved(self):
        for order in (["1", "2", "3", "4", "5", "6"], ["7", "6", "5", "4", "3", "2", "1"]):
            with self.subTest(order=order):
                good = efa_payload()
                good["variables"] = [ordinal_var(f"q{i}", order=order) for i in range(1, 7)]
                parsed = EFARequest.model_validate(good)
                self.assertEqual([v.categoryOrder for v in parsed.variables], [order] * 6)

    def test_seven_category_ordinal_not_coerced(self):
        good = cfa_payload()
        order = ["1", "2", "3", "4", "5", "6", "7"]
        good["variables"] = [ordinal_var(f"q{i}", order=order) for i in range(1, 7)]
        parsed = CFARequest.model_validate(good)
        self.assertTrue(all(
            v.measurement == "ordinal" and v.categoryOrder == order for v in parsed.variables))
        self.assertEqual(parsed.estimator, "wlsmv")

    def test_extra_keys_rejected(self):
        bad = efa_payload()
        bad["lavaanModel"] = "f1 =~ q1 + q2"
        with self.assertRaises(ValidationError):
            EFARequest.model_validate(bad)
        bad = cfa_payload()
        bad["factors"][0]["rawFormula"] = "f1 =~ q1"
        with self.assertRaises(ValidationError):
            CFARequest.model_validate(bad)

    def test_invalid_factor_counts_rejected(self):
        for n_factors, compare in ((6, []), (2, [1, 1]), (2, [6]), (5, [])):
            with self.subTest(nFactors=n_factors, compareFactors=compare):
                bad = efa_payload()
                bad["nFactors"] = n_factors
                bad["compareFactors"] = compare
                with self.assertRaises(ValidationError):
                    EFARequest.model_validate(bad)

    def test_compare_factor_equal_to_primary_accepted(self):
        good = efa_payload()
        good["nFactors"] = 2
        good["compareFactors"] = [2]
        parsed = EFARequest.model_validate(good)
        self.assertEqual(parsed.nFactors, 2)
        self.assertEqual(parsed.compareFactors, [2])

    def test_cfa_all_ordinal_treatment_uses_wlsmv_family(self):
        for estimator in ("wlsmv", "ulsmv"):
            with self.subTest(estimator=estimator):
                good = cfa_payload()
                good["estimator"] = estimator
                self.assertEqual(CFARequest.model_validate(good).estimator, estimator)
        for estimator in ("mlr", "ml"):
            with self.subTest(estimator=estimator):
                bad = cfa_payload()
                bad["estimator"] = estimator
                with self.assertRaises(ValidationError):
                    CFARequest.model_validate(bad)

    def test_cfa_all_approximated_ordinal_uses_mlr_family(self):
        variables = [approx_var(f"q{i}") for i in range(1, 7)]
        for estimator in ("mlr", "ml"):
            with self.subTest(estimator=estimator):
                good = set_cfa_variables(cfa_payload(), copy.deepcopy(variables))
                good["estimator"] = estimator
                self.assertEqual(CFARequest.model_validate(good).estimator, estimator)
        for estimator in ("wlsmv", "ulsmv"):
            with self.subTest(estimator=estimator):
                bad = set_cfa_variables(cfa_payload(), copy.deepcopy(variables))
                bad["estimator"] = estimator
                with self.assertRaises(ValidationError):
                    CFARequest.model_validate(bad)

    def test_cfa_ordinal_continuous_treatment_mix_rejected(self):
        bad = set_cfa_variables(cfa_payload(), [
            ordinal_var("q1"), ordinal_var("q2"), ordinal_var("q3"),
            continuous_var("q4"), continuous_var("q5"), continuous_var("q6"),
        ])
        for estimator in ("wlsmv", "ulsmv", "mlr", "ml"):
            with self.subTest(estimator=estimator):
                bad["estimator"] = estimator
                with self.assertRaises(ValidationError):
                    CFARequest.model_validate(bad)

    def test_cfa_ordinal_approximation_treatment_mix_rejected(self):
        bad = set_cfa_variables(cfa_payload(), [
            ordinal_var("q1"), ordinal_var("q2"), ordinal_var("q3"),
            approx_var("q4"), approx_var("q5"), approx_var("q6"),
        ])
        for estimator in ("wlsmv", "ulsmv", "mlr", "ml"):
            with self.subTest(estimator=estimator):
                bad["estimator"] = estimator
                with self.assertRaises(ValidationError):
                    CFARequest.model_validate(bad)

    def test_cfa_continuous_and_approximation_mix_uses_mlr_family(self):
        variables = [
            continuous_var("q1"), continuous_var("q2"), continuous_var("q3"),
            approx_var("q4"), approx_var("q5"), approx_var("q6"),
        ]
        for estimator in ("mlr", "ml"):
            with self.subTest(estimator=estimator):
                good = set_cfa_variables(cfa_payload(), copy.deepcopy(variables))
                good["estimator"] = estimator
                self.assertEqual(CFARequest.model_validate(good).estimator, estimator)
        for estimator in ("wlsmv", "ulsmv"):
            with self.subTest(estimator=estimator):
                bad = set_cfa_variables(cfa_payload(), copy.deepcopy(variables))
                bad["estimator"] = estimator
                with self.assertRaises(ValidationError):
                    CFARequest.model_validate(bad)

    def test_source_and_intent_not_coupled(self):
        good = cfa_payload()
        good["sourceEfaResultId"] = "efa-1"
        good["validationIntent"] = "same_data"
        parsed = CFARequest.model_validate(good)
        self.assertEqual(parsed.sourceEfaResultId, "efa-1")
        self.assertEqual(parsed.validationIntent, "same_data")


if __name__ == "__main__":
    unittest.main()
