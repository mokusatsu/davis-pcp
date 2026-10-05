"""Regenerate R references from built-in-import API data, entirely offline.

By default outputs only under repository .temp/. A checked fixture is replaced
only when its exact location is explicitly supplied with --output.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2]
REPO = HERE.parents[4]
SAMPLES = ("edss-efa-613x13", "edss-cfa-646x13", "census-kdd-adult600", "siechnice-cbc96")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rscript", default="Rscript", help="Installed Rscript executable; no dependencies are installed")
    parser.add_argument("--workdir", type=Path, default=REPO / ".temp" / "builtin-r-reference-regeneration")
    parser.add_argument("--output", type=Path, help="Explicit JSON destination; default is WORKDIR/references.json")
    args = parser.parse_args()
    work = args.workdir.resolve()
    temp_root = (REPO / ".temp").resolve()
    if not work.is_relative_to(temp_root):
        parser.error("--workdir must be inside repository .temp/")
    work.mkdir(parents=True, exist_ok=True)
    destination = args.output.resolve() if args.output else work / "references.json"
    if destination == HERE / "references.json" and args.output is None:
        parser.error("Replacing the checked fixture requires explicit --output")
    os.environ["DAVIS_PCP_WORKSPACE"] = tempfile.mkdtemp(prefix="api-workspace-", dir=work)
    for name, value in (("OPENBLAS_NUM_THREADS", "1"), ("OMP_NUM_THREADS", "1"), ("POLARS_MAX_THREADS", "2")):
        os.environ.setdefault(name, value)
    sys.path.insert(0, str(BACKEND))
    import numpy as np
    from fastapi.testclient import TestClient
    from app.api import datasets
    from app.main import app
    from app.services.builtin_samples import asset_path, sample_spec

    specs = {}
    with TestClient(app) as client:
        for sample in SAMPLES:
            spec = sample_spec(sample)
            actual_hash = hashlib.sha256(asset_path(spec["dataFile"]).read_bytes()).hexdigest()
            if actual_hash != spec["dataSha256"]:
                raise RuntimeError(f"Shipped source hash mismatch: {sample}")
            response = client.post("/api/v1/datasets/import/sample", json={"sampleId": sample})
            response.raise_for_status()
            dataset_id = response.json()["datasetId"]
            frame = datasets.store.get_dataframe(dataset_id)
            book = client.get(f"/api/v1/datasets/{dataset_id}/codebook").json()
            frame.write_csv(work / f"{sample}.csv")
            specs[sample] = spec
            if sample == "siechnice-cbc96":
                with (work / "choice-levels.csv").open("w", newline="") as handle:
                    writer = csv.writer(handle)
                    writer.writerow(["attribute", "code", "reference"])
                    by_name = {c["name"]: c for c in book["columns"]}
                    for index in range(1, 6):
                        column = by_name[f"atr{index}"]
                        for code in column["categoryOrder"]:
                            writer.writerow([column["name"], code, int(code == column["categoryOrder"][-1])])
    versions = subprocess.check_output([args.rscript, "-e", 'cat(as.character(getRversion()),as.character(packageVersion("psych")),as.character(packageVersion("survey")),sep="\\n")'], text=True).strip().splitlines()
    for name in ("generate_references.R", "generate_census_survey.R"):
        with (work / f"{name}.log").open("w") as log:
            subprocess.run([args.rscript, str(HERE / name), str(work)], check=True, stdout=log, stderr=subprocess.STDOUT)

    def matrix(filename):
        return np.loadtxt(work / filename, delimiter=",").tolist()

    def metrics(filename):
        with (work / filename).open() as handle:
            return {k: float(v) for k, v in next(csv.DictReader(handle)).items()}

    provenance = {
        "generatedDate": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).date().isoformat(),
        "R": versions[0], "psych": versions[1], "survey": versions[2],
        "generator": "generate_references.R",
        "generatorSha256": hashlib.sha256((HERE / "generate_references.R").read_bytes()).hexdigest(),
        "surveyGenerator": "generate_census_survey.R",
        "surveyGeneratorSha256": hashlib.sha256((HERE / "generate_census_survey.R").read_bytes()).hexdigest(),
        "regenerationHelper": "regenerate.py",
        "regenerationHelperSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "notes": [
            "References use complete raw built-in observations exported after actual built-in-import API calls.",
            "EDSS-CFA names a source sample; the analysis is EFA, not a CFA runtime claim.",
            "Pearson uses stats::factanal. Ordinal uses psych global marginal thresholds without cell corrections/smoothing and explicit full-profile ULS.",
            "Choice uses 96 respondents, 1152 tasks and 3456 alternatives, a conditional logit likelihood and respondent CR1 covariance.",
            "Initial exploratory choice coefficient/probability limits of 1e-6/1e-7 were tighter than normalized-score stopping at 1e-6; independent score and Newton-correction checks explained micro-deviations.",
            "Census Rao-Scott uses independent-row svydesign(ids=~1,weights=~MARSUPWT); svymean SE is reference context, not an exposed summary-API field.",
        ],
    }
    reference = {"provenance": provenance, "efa": {}, "choice": {}, "census": {}}
    for sample in SAMPLES[:2]:
        entry = {"dataSha256": specs[sample]["dataSha256"], "nRows": specs[sample]["rowCount"],
                 "nVariables": 13, "nFactors": 3, "rotation": "none"}
        for mode in ("pearson", "polychoric"):
            prefix = f"{sample}-{mode}-R-"
            entry[mode] = {"sampleCorrelation": matrix(prefix + "correlation.csv"),
                           "uniqueness": matrix(prefix + "uniqueness.csv"),
                           "reproducedCorrelation": matrix(prefix + "reproduced.csv"),
                           "metrics": metrics(prefix + "metrics.csv")}
            if mode == "polychoric":
                entry[mode]["thresholds"] = matrix(prefix + "thresholds.csv")
        reference["efa"][sample] = entry
    reference["choice"] = {"dataSha256": specs[SAMPLES[3]]["dataSha256"],
        "beta": matrix("siechnice-R-beta.csv"), "covariance": matrix("siechnice-R-covariance.csv"),
        "metrics": metrics("siechnice-R-metrics.csv"), "tolerances": {
            "coefficient": 1e-5, "probability": 3e-6, "covariance": 1e-6, "logLikelihood": 1e-7, "normalizedScore": 1e-6}}
    with (work / "census-R-masses.csv").open() as handle:
        masses = [{k: v if k == "code" else float(v) for k, v in row.items()} for row in csv.DictReader(handle)]
    with (work / "census-survey-R-reference.csv").open() as handle:
        survey = {k: v if k.endswith("Version") else float(v) for k, v in next(csv.DictReader(handle)).items()}
    reference["census"] = {"dataSha256": specs[SAMPLES[2]]["dataSha256"],
        "summary": metrics("census-R-summary.csv"), "masses": masses, "survey": survey}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(reference, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(f"Wrote independent R references to {destination}")
    print(f"Raw exports, R session information and logs remain in {work}")


if __name__ == "__main__":
    main()
