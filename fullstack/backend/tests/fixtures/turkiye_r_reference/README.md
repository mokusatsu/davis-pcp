# Türkiye full 28-item EFA references

These expectations use all600 raw rows and Q1–Q28 from the built-in sample,
three unrotated factors, no missing imputation and no source reversal. Raw data
and codebook hashes, R4.5.0 version, generator/helper hashes and numerical settings
are recorded in `references.json`.

Pearson ML uses `stats::factanal`. Ordinal polychoric uses an independent,
deterministic R conditional-normal integral for all378pairs with fixed marginal
thresholds. Positive-tail probabilities use survival-tail subtraction. Observed
cells are never discarded, clipped or pseudocounted. Bounded scalar optimization
uses[-.9999,.9999] and tolerance1e-10. Full-profile ULS uses the same explicit
Frobenius objective as the app, including diagonal residuals, with bounds[.005,1],
three starts and max1000iterations.

The original psych2.4.12 comparison was intentionally rejected as an oracle for
two high-correlation pairs. For Q21/Q22 it returned.978166590 versus independent
adaptive optimum.955989548 (NLL1305.251991 versus1277.778805); for Q13/Q14 it
returned.983408721 versus.972226835 (NLL1246.083929 versus1235.364010). Marginal
subtraction loses tiny tail-cell probabilities (including one observed cell),
and its likelihood may then omit that cell. Independent Python and R adaptive
integrals agree with the app. No app behavior was changed to match that external
approximation. The separate batch1Rfixtures are untouched.

Regenerate offline from the repository root with backend requirements and an
already installed R runtime (base `stats` is sufficient):

```sh
# Optional for this audit's local runtime: source .temp/r-runtime/env.sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 POLARS_MAX_THREADS=2 \
  python fullstack/backend/tests/fixtures/turkiye_r_reference/regenerate.py
```

Default input exports, logs and output JSON go only into
`.temp/turkiye-r-reference-regeneration/`. To replace the checked expectation,
explicitly pass:

```sh
python fullstack/backend/tests/fixtures/turkiye_r_reference/regenerate.py \
  --output fullstack/backend/tests/fixtures/turkiye_r_reference/references.json
```

Use `--rscript` for a verified executable outside PATH. The helper performs a
real built-in-import API call in fresh isolated `.temp`storage, verifies source
hashes, runs the independent Rscript and assembles JSON. It installs nothing and
makes no network requests. `--workdir` must stay under repository `.temp/`.
