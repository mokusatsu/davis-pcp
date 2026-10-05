# Built-in R numerical references

These fixtures were computed independently in R 4.5.0, psych 2.4.12 and survey
4.4.2 from the shipped raw public built-in data. Native tests consume only the
JSON fixture; R is not a pytest dependency.

`references.json` records source CSV SHA256 values, generator provenance,
parameters, exact expected values, and tolerance notes. No source observations
were altered, uploaded externally, reverse-scored implicitly, or imputed.

## Equivalent estimands

- Both full 13-item EDSS samples: three-factor unrotated EFA, with Pearson ML
  compared to `stats::factanal`; polychoric marginal-threshold estimates compared
  to `psych::polychoric(global=TRUE, correct=0, smooth=FALSE)`; ULS compared to the
  explicit full-profile objective, including diagonal residuals. The additional
  psych MINRES comparison is diagnostic, since objective definitions must not be
  assumed interchangeable. The sample named CFA is still used for EFA here.
- Census: `weighted.mean`, raw category weight masses, Kish effective N, and
  `survey::svychisq(statistic="F")` under `svydesign(ids=~1, weights=~MARSUPWT)`.
  `svymean` standard error is stored as reference context, not asserted against a
  scalar-summary API that does not expose a standard error.
- Siechnice: all 96 respondents, 1,152 tasks and 3,456 alternatives; independent
  raw-code effect coding (last codebook level is reference), opt-out ASC, stable
  conditional multinomial logit likelihood, and respondent-cluster CR1 covariance
  with G/(G-1) correction and 95 reference degrees of freedom.

## Tolerances and convergence

Polychoric package estimates differ by up to about 2.02e-5, consistent with the
independent scalar-optimization settings; fixed marginal thresholds agree to
about 5e-15. Tests use 5e-5 for correlations and 1e-4 for resulting ULS matrices.

An exploratory choice comparison used coefficient/probability tolerances of
1e-6/1e-7 and saw deviations of 3.64e-6/1.17e-6. This is not an application
failure: an independent raw-score calculation reproduces its normalized score
2.9967196911e-7, below the declared 1e-6 stopping bound. One independent Newton
correction accounts for the coefficient difference and reaches the R solution to
8.83e-13. Permanent tests explicitly validate that stopping rule as well as
likelihood, covariance, probabilities and coefficients; the numerical fixture
stores the corresponding tolerances rather than concealing the distinction.

## Regeneration

Both R scripts take one directory argument containing CSVs exported directly
from built-in-import API datasets. For the two EDSS CSVs keep the original item
names/order plus `__rowId__`; no source ID is an analysis item. Census and
Siechnice exports retain their original columns. `choice-levels.csv` has columns
`attribute,code,reference` from the five Siechnice codebook `categoryOrder`
arrays, with 1 only for the last level. Preserve the respondent identifier as
text and structural opt-out blanks.

Run `generate_references.R DIRECTORY` and `generate_census_survey.R DIRECTORY`.
They create independent CSV matrices/scalars and an R session manifest. Review
changes against the exact source hashes, then update the JSON fixture from those
outputs. Do not regenerate expectations from DAVIS-PCP result arrays.

End-to-end regeneration from the repository root (requires the Python backend
requirements and the named R packages already installed):

```sh
# If using this audit's workspace-local R, first source .temp/r-runtime/env.sh
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 POLARS_MAX_THREADS=2 \
  python fullstack/backend/tests/fixtures/builtin_r_reference/regenerate.py
```

The helper performs actual built-in imports, verifies source hashes, creates raw
inputs and effect-level metadata, runs both R scripts, and assembles JSON.
Everything goes to `.temp/builtin-r-reference-regeneration/` by default. It does
not install software, access the network, or replace the checked fixture.

To explicitly replace the reviewed checked expectation file, pass its path:

```sh
python fullstack/backend/tests/fixtures/builtin_r_reference/regenerate.py \
  --output fullstack/backend/tests/fixtures/builtin_r_reference/references.json
```

Use `--rscript /verified/path/to/Rscript` if it is not on PATH. `--workdir` may
only select a directory under repository `.temp/`.
