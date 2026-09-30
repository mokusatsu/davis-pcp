# Non-PCP chart migration to Apache ECharts

## Scope and dependencies

The migration inventories the current source rather than treating the older public-build comparison's 50 display cases / 27 families as a component count. Current source includes CA, MCA, FAMD, linear regression, discriminant diagnostics, key-driver analysis, exploratory factor analysis and conjoint diagnostics, which are included below. Integration base: main `3da6a18`; the added header navigation and GraphPanel expansion infrastructure are retained.

- Apache ECharts **6.1.0** and zrender **6.1.0** are exact production dependencies with lockfile integrity hashes
- ECharts' Apache-2.0 license/NOTICE and zrender's BSD-3-Clause license are registered in the application license dialog
- `features/pcp/PcpPage.tsx`, the PCP pipeline and `engine/pcpRenderer.ts` are unchanged; ECharts parallel coordinates is not substituted for PCP
- Numeric tables, codebook forms, analysis configuration, exportable data and statistical calculations remain application-owned. Tables are not converted merely because they contain numerical results
- No old chart renderer is mounted invisibly behind the new renderer

## Rendering architecture

`features/charts/EChart.tsx` owns init, option update, ResizeObserver/window/visibility resize, event binding and cleanup, and disposal. One instance survives ordinary React updates. GraphPanel scale/DPR changes do not remount analysis components. SVG instances stay alive; the animated Canvas painter is renewed only when its effective pixel density changes, and its projection/trail state stays in the unchanged engine. Its default renderer is SVG; animated Grand Tour explicitly uses ECharts Canvas. `onReady` runs after the first option is installed. SVG references used by existing model exporters point to the actual ECharts SVG.

Option replacement removes obsolete series, axes and graphics. Native legend choices and dataZoom viewports survive a same-view refresh; native tree zoom/center also survive controlled selection/collapse changes. Dataset identity (from optional Redux context), `resetKey`, changed series signature, and changed tree topology reset the applicable state. Tree expansion itself remains controller-owned.

`RowScatter`, `CategoryBars` and `MatrixHeatmap` share standard native-series options. Model charts additionally use `models/ModelScatter` and `OddsRatioForest`. None computes a replacement statistical model.

`EChartSurface.tsx` is a deliberate **custom-geometry adapter** for specialized or already-defined statistical layouts. Existing declarative line/circle/rect/text/path coordinates become ECharts graphic/zrender objects; those JSX shapes are data, not mounted SVG nodes. The adapter preserves metric linkage heights, confidence polygons, ordered strips, zero/reference lines and group memberships. A single registered zrender path shape supports arbitrary existing path data without registering a class per observation/frame. Native line/rect/circle graphics, nested tspan text, rotations, opacities and full codebook-question tooltips are retained. Geometry math has not been claimed to disappear.

## Inventory

Paths below are under `fullstack/frontend/src/features/`.

| Chart family / variants | Source | ECharts implementation |
|---|---|---|
| Ordinary count / percentage bars | `barchart/BarChartPage.tsx` | Native bars, selected-count overlay |
| Grouped multiple-response counts / rates | `barchart/MultiResponseBarChart.tsx` | Native bar, common scale across pages |
| Question category distributions | `distribution/QuestionCard.tsx` | Native bar; valid/all denominators retained |
| Multiple-response respondent / response distributions | `distribution/MultiResponseCard.tsx` | Native bar; raw and weighted totals retained |
| Horizontal / vertical boxplots and individual observations | `distribution/DistributionPage.tsx` | Graphic geometry, original summaries / row identity |
| Likert 5 / 6 and other ordered scales | `distribution/LikertComparisonPage.tsx`, `likertTransform.ts` | Custom interval rectangles on native axes |
| Numeric / categorical statistics plots | `dataset/StatisticsPage.tsx` | Graphic geometry and shared question/MA bars |
| Binning preview | `dataset/BinningModal.tsx` | Graphic geometry |
| Derived-variable / imputation previews | `dataset/AddVariableModal.tsx`, `dataset/ImputationModal.tsx` | Native histograms, observed/imputed stacks with unchanged counts |
| PCA scree, explained/cumulative variance, Kaiser line | `pca/ScreePlot.tsx` | Graphic geometry, component-click behavior |
| PCA score/loading biplot | `pca/BiplotView.tsx` | Native scatter + oriented markLine arrows |
| PCA score matrix and diagonal histograms | `pca/PcaMatrixPlot.tsx` | Native multi-grid scatter/bar |
| Clustering PCA projection | `clustering/ClustersPage.tsx` | Graphic geometry |
| Silhouette plot | `clustering/ClustersPage.tsx` | Graphic geometry; existing coefficient/ordering |
| Metric dendrogram | `clustering/ClustersPage.tsx` | Graphic geometry; linkage distances retained |
| Cobweb concept hierarchy | `clustering/CobwebTreeViewer.tsx` | Native tree, controlled collapse and row memberships |
| DISC category matrix | `clustering/DiscCategoryMatrix.tsx` | Native heatmap |
| Covariance / correlation / partial-correlation matrix | `covariance/CovariancePage.tsx` | Native heatmap, cell inspector/PCP action retained |
| Pairwise correlation matrix | `relationships/RelationshipsPage.tsx` | Native heatmap, missing cells shown separately |
| Focused relationship scatter | `relationships/RelationshipCanvas.tsx` | Native scatter, canonical row IDs |
| Surprise-association scatter / heatmap | `relationships/SurpriseAssociationView.tsx` | Graphic scatter geometry / native heatmap |
| LOESS scatter, fitted curve, received confidence band | `loess/LoessPlotPage.tsx` | Graphic geometry; no CI recalculation |
| Normal Q-Q plot and Q1–Q3 reference line | `qqplot/QQPlotView.tsx` | Native scatter + line |
| Standard / folded empirical distribution | `fedf/FedfPage.tsx` | Graphic geometry; quantile presets/axis brushes retained |
| Grand Tour projected points and fading trails | `tgt/TgtCanvas.tsx` | Native scatter + custom trail series, Canvas renderer |
| Grand Tour basis projection circle | `tgt/ProjectionCircle.tsx` | Graphic geometry |
| Line Mosaic cells and internal category strips | `mosaic/LineMosaicCanvas.tsx` | Graphic geometry; original cell normalization/strip widths |
| Mosaic selected-cell distribution | `mosaic/LineMosaicPage.tsx` | Native bar |
| PRA low/high coefficient scatter and paired coefficient bars | `pra/PenaltyRewardPage.tsx`, `praCharts.ts` | Native scatter/bar, signed raw coefficients |
| Feature ranking / importance / permutation / multi-method plots | `mining/FeatureRankingPage.tsx` | Native bar/scatter |
| Perturbation/tornado drift | `robustness/RobustnessPage.tsx` | Native bar; raw percentages are not clipped at 100 |
| Decision tree | `models/ModelsPage.tsx` | Native graph with application-owned node layout |
| Linear regression diagnostic scatter | `models/LinearRegressionFigure.tsx` | Native scatter / reference series |
| Logistic diagnostic scatter | `models/LogisticRegressionPage.tsx` | Native scatter |
| Logistic odds ratio / received 95% CI forest | `models/OddsRatioForest.tsx` | Custom CI geometry in log domain, no exp20 clipping |
| Discriminant projection / structure biplot | `models/DiscriminantAnalysisPage.tsx` | Native scatter / vector series |
| Correspondence analysis category map | `models/caFigure.tsx` | Native scatter; one-dimensional case retained |
| Multiple correspondence analysis maps | `models/McaFigure.tsx` | Native scatter |
| FAMD observation/category/numeric relationship maps | `models/FamdFigure.tsx`, `models/FamdPage.tsx` | Native scatter/bar |
| Key-driver Shapley relative importance | `models/kda/KeyDriverAnalysisPage.tsx` | Native bar; rank/direction/importance retained |
| Conjoint diagnostic scatter | `models/ConjointFigure.tsx`, `models/ConjointPage.tsx` | Native scatter; supplied ranking row order, omitted absent residuals, selection and SVG export |
| EFA factor scores | `models/EfaScoreFigure.tsx`, `models/FactorAnalysisPage.tsx` | Native scatter; nullable/nonfinite omissions and shared selection/color |
| EFA scree / parallel analysis | `models/FactorAnalysisPage.tsx` | Native line; aligned ranks, null gaps, signed eigenvalues and reference lines |

## Data and interaction contracts

- Selection is still the Redux `selection` slice. Data marks retain raw `rowId`, category, component, variable or cell identities. Display labels and ECharts indexes are not respondent IDs
- Rectangle/group operations read the existing `getBrushOp()` registry. Point toggles keep their original point semantics; histogram/category/cell actions use original membership queries or row sets. Selection is visibly projected back into the same chart
- Shared row colors remain L1 hue × L2 luminance from the existing resolver. Native PCA/relationship points retain their composed fill and use size, opacity and selected outlines
- Native scatter pointer bridges convert client coordinates through ECharts' `convertToPixel` / `convertFromPixel`, accounting for CSS display scaling. Nearest-point selection uses an 8px screen-space radius. Starting on a point does not turn that point click into a rectangular brush
- Graphic point marks have transparent hit targets of at least 24px equivalent. Specialized geometric brushes keep logical coordinates through resize/focus scaling
- Drag rectangles are ECharts top-layer graphics with the shared blue translucent fill, 1.5px stroke and no hit interception. Cancel/lost-capture and source changes clear pending drags
- Hover continues to use the central hovered-row state where supplied by the originating chart. Tooltips retain original values/IDs and full question text; HTML tooltip data is escaped or rendered as rich text
- Chart hosts expose ARIA descriptions. Native row-scatter hosts support keyboard row navigation and selection. Graphic hosts support keyboard mark navigation/activation; semantic category and mosaic controls also remain available
- The latest GraphPanel expansion shells, context menus, selection menus, CSV/table exports and analysis controllers remain in place

## Likert contract

The default is conventional `stacked100`; `diverging` is selectable for both five and six categories. The choice persists per dataset in local display preferences. Both modes consume one unrounded aggregate and use the same ordered codes, colors, denominator, weighted counts and selection tokens.

In diverging mode, low ordered levels are on the left and high ordered levels on the right; these are positions, not judgments of desirability. A five-level middle category is **one interval crossing zero** with half its width on either side, and therefore is neither counted twice nor split into different selection memberships. Six levels have no added neutral category. All compared questions share the same percentage axis. Tooltip percentages remain nonnegative.

Missing, invalid and not-applicable entries are excluded from the scale order. Valid zero-count categories remain. Declared missing codes, `isMissing`, `isInvalid` and summary sentinels cannot manufacture a seventh level. Weighted counts are not rounded to integers for drawing. Explicit cleared-weight requests send `weightMode: 'none'`.

## PRA contract

Both low and high bars use the received **signed coefficient**, with no absolute-value sign fabrication, automatic reverse coding or desirability setting. Bars are paired rather than stacked. The scatter is x=low coefficient, y=high coefficient, contains zero on both axes and draws zero reference lines; arbitrary Kano quadrant thresholds are not introduced. Existing classification is explicitly described as originating from the existing model. Received SE, p and confidence bounds remain in details/tooltips. Causal effects are not inferred by the chart.

## Exports and lifecycle

Every host adds an image export toolbox without dropping caller toolbox features. SVG charts export SVG; Grand Tour exports PNG. Existing model SVG export references now refer to generated ECharts SVG. Statistical CSV and table export paths are unchanged. ResizeObserver, global listeners and instances are released on unmount, including GraphPanel transitions and keep-alive navigation.

## Verification snapshot

- Refreshed-main frontend regression run: **74 suites / 356 tests passed**, including all 11 WASM parity tests
- Backend unit/API regression run: **518 passed, 1 skipped** (optional student-data fixture absent). The earlier Iris tests now use actual generated canonical row IDs rather than display IDs
- Survey audit: **70 passed**. Statistical audit earlier passed **432** Python cases; **14** R-reference setup cases require an Rscript installation and are not counted as passed
- TypeScript checking and dependency/license checks passed. Pages CI also runs frontend tests before publishing the artifact
- Native PCA biplot/matrix, relationship and mosaic pointer regression: **27 tests passed**, including 0.5× / 1× / 2× display scaling, all four brush operations, point identity, empty selections, cancellation and stale-result changes
- Shared graphic-host tests exercise real ECharts SSR and DOM mouse dispatch, path registration, metadata tooltips, nested tspan contents, keyboard access, SVG export, instance reuse/disposal, legend persistence and zoom/tree-state resets
- Likert pure tests cover both five/six level modes, neutral splitting, stable IDs/colors/widths and missing/invalid order exclusions
- TypeScript checking and OSS license checking passed during integration
- The local cloud browser returned `ERR_BLOCKED_BY_CLIENT` for localhost. This restriction was not bypassed. Unit/DOM/SSR checks are not described as completed real-browser acceptance. Published-site browser acceptance and final production/static build results belong in the release verification record

Suggested final commands: `npx tsc --noEmit`, `npm run check:licenses`, `npm test`, followed by the authorized production/static build and published-site pointer/export/focus checks. Include sparse/constant data, empty selection scope, long labels, changed codebooks, repeated navigation and large row counts in browser acceptance.

## Integration with the refreshed main branch

The source refresh adds EFA/conjoint analyses, the shared GraphPanel display host, and compact header navigation. These changes are not replaced by the earlier migration implementation. Statistical backends for the new analyses are retained; only their plot renderers are adapted.

Display coordinates are converted once through the chart's actual client rectangle. Pending drags are cancelled when GraphPanel dimensions, zoom, scale or DPR change. Selection and configuration popups use the active GraphPanel dialog's popup container. Specialized geometry controllers receive `onViewportChange` to clear their pending gesture state.
