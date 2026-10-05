# ATOPP full 31-item exploratory EFA references

These expectations use the built-in sample's 541 rows and all 31 raw items,
with their original 1–5 coding and reversal flags unchanged. The calculation
uses three unrotated factors and no imputation, scores, or parallel analysis.
It is a numerical exploratory test, not a final 21-item scale, scoring key,
factor-count recommendation, or claim of psychometric validity.

The fixture records source data and codebook SHA256 hashes, R version,
generator and helper hashes, and numerical settings. Only independent R
expectations are checked in; backend responses are not used as references.

## Equivalent estimators

- Pearson ML uses `stats::factanal`, three starts, uniqueness lower bound
  0.005, and an explicit full log-determinant/trace objective. The API uses
  acknowledged continuous approximation of the original ordinal responses
- Ordinal correlations use all 465 pairs, fixed empirical marginal thresholds,
  deterministic conditional-normal integration, and stable survival-tail
  subtraction. Integration tolerances are 1e-12 absolute and relative. There
  are no pseudocounts, clipped probabilities, or discarded observed cells.
  Scalar optimization uses bounds [-0.9999, 0.9999] and tolerance 1e-10
- Full-profile ULS includes diagonal residuals, diagonal parameter bounds
  [0.005, 1], three starts, and at most 1000 iterations. It is distinct from
  an off-diagonal-only MINRES objective

The initial comparison against the published cycle2 numerical implementation
had maximum absolute Pearson correlation error 1.89e-15, uniqueness error
7.28e-7, and objective error 2.41e-13. Ordinal correlation error was 6.90e-8,
pair negative-log-likelihood error 3.22e-10, uniqueness error 3.44e-8, and
full-profile ULS objective error 7.52e-8. The API regression retains the 1e-7
objective tolerance used by the other independent full-sample references.

## Regeneration

From the repository root, with backend requirements and R already installed
(base `stats` is sufficient):

```sh
# Optional for this audit's local runtime: source .temp/r-runtime/env.sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 POLARS_MAX_THREADS=2 \
  python fullstack/backend/tests/fixtures/atopp_r_reference/regenerate.py
```

The helper makes a real built-in-import API call in fresh isolated storage,
checks source hashes, exports the raw frame, runs the independent R generator,
and assembles JSON. It installs nothing and makes no network requests.
Default exports, logs, session information, and generated expectations remain
under `.temp/atopp-r-reference-regeneration/`. `--workdir` must be inside
repository `.temp/`; `--rscript` selects an already available R executable.
The original end-to-end run took 36.19 seconds with R 4.5.0.

Replacing checked expectations requires an explicit destination:

```sh
python fullstack/backend/tests/fixtures/atopp_r_reference/regenerate.py \
  --output fullstack/backend/tests/fixtures/atopp_r_reference/references.json
```
