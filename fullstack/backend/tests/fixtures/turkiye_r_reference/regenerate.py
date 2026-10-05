"""Offline Türkiye full-EFA reference regeneration; default output stays in .temp."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
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
SAMPLE = "turkiye-student-evaluation-600"


def assemble(work, spec, r_version):
    import numpy as np
    def matrix(filename):
        return np.loadtxt(work / filename, delimiter=",").tolist()
    def metrics(filename):
        with (work / filename).open() as handle:
            return {k: float(v) for k, v in next(csv.DictReader(handle)).items()}
    result = {"provenance": {
        "R": r_version, "generatedDate": datetime.now(timezone.utc).date().isoformat(),
        "generator": "generate_reference.R", "generatorSha256": hashlib.sha256((HERE / "generate_reference.R").read_bytes()).hexdigest(),
        "helper": "regenerate.py", "helperSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "polychoricEstimator": "fixed marginal thresholds; deterministic adaptive conditional-normal integration with survival-tail subtraction; no clipping, pseudocounts, or ignored observed cells",
        "integrationAbsoluteTolerance": 1e-12, "integrationRelativeTolerance": 1e-12,
        "rhoBounds": [-.9999, .9999], "rhoOptimizerTolerance": 1e-10,
        "externalReferenceCaution": "psych2.4.12 has marginal-subtraction cancellation on Q21/Q22 and Q13/Q14 for this sample; its correlations are diagnostics, not these expectations"},
        "sampleId": SAMPLE, "dataSha256": spec["dataSha256"], "codebookSha256": spec["codebookSha256"],
        "nRows": 600, "nVariables": 28, "nFactors": 3, "rotation": "none"}
    for mode, prefix in (("pearson", "turkiye-pearson-R-"), ("polychoric", "turkiye-adaptive-R-")):
        result[mode] = {"sampleCorrelation": matrix(prefix + "correlation.csv"),
                        "uniqueness": matrix(prefix + "uniqueness.csv"),
                        "reproducedCorrelation": matrix(prefix + "reproduced.csv"),
                        "metrics": metrics(prefix + "metrics.csv")}
        if mode == "polychoric":
            result[mode]["thresholds"] = matrix(prefix + "thresholds.csv")
            with (work / "turkiye-adaptive-R-pairs.csv").open() as handle:
                result[mode]["pairReferences"] = [{k: int(v) if k in ("first", "second") else float(v)
                                                   for k, v in row.items()} for row in csv.DictReader(handle)]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rscript", default="Rscript")
    parser.add_argument("--workdir", type=Path, default=REPO / ".temp" / "turkiye-r-reference-regeneration")
    parser.add_argument("--output", type=Path, help="Explicit destination; default is WORKDIR/references.json")
    args = parser.parse_args()
    work = args.workdir.resolve()
    if not work.is_relative_to((REPO / ".temp").resolve()):
        parser.error("--workdir must be inside repository .temp/")
    work.mkdir(parents=True, exist_ok=True)
    destination = args.output.resolve() if args.output else work / "references.json"
    os.environ["DAVIS_PCP_WORKSPACE"] = tempfile.mkdtemp(prefix="api-workspace-", dir=work)
    for name in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "POLARS_MAX_THREADS"):
        os.environ.setdefault(name, "1")
    sys.path.insert(0, str(BACKEND))
    from fastapi.testclient import TestClient
    from app.main import app
    from app.api import datasets
    from app.services.builtin_samples import sample_spec, asset_path
    spec = sample_spec(SAMPLE)
    for field, hash_field in (("dataFile", "dataSha256"), ("codebookFile", "codebookSha256")):
        if hashlib.sha256(asset_path(spec[field]).read_bytes()).hexdigest() != spec[hash_field]:
            raise RuntimeError(f"Shipped source hash mismatch: {field}")
    with TestClient(app) as client:
        imported = client.post("/api/v1/datasets/import/sample", json={"sampleId": SAMPLE})
        imported.raise_for_status()
        datasets.store.get_dataframe(imported.json()["datasetId"]).write_csv(work / f"{SAMPLE}.csv")
    version = subprocess.check_output([args.rscript, "-e", "cat(as.character(getRversion()))"], text=True).strip()
    with (work / "reference.log").open("w") as log:
        subprocess.run([args.rscript, str(HERE / "generate_reference.R"), str(work)], check=True, stdout=log, stderr=subprocess.STDOUT)
    result = assemble(work, spec, version)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    print(f"Wrote independent R references to {destination}")
    print(f"All 378 pair references and logs remain in {work}")


if __name__ == "__main__":
    main()
