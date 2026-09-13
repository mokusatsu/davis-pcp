# Feature 033b・033c：入力・結果契約

版1.1／2026-09-13。対象はEFA/CFA拡張のみ。[共通結果契約](RESULT_CONTRACT.md)の行ID・保存・stale・有限JSON・CSV安全性を継承し、本書でmethodとcapabilities、診断を追加定義する。既存033契約の自動互換変換は行わない。

## 1. 正本・入力

実行可能な構文正本は[factor_extension_requests.py](factor_extension_requests.py)、生成Schemaは[efa.schema.json](schemas/efa.schema.json)と[cfa.schema.json](schemas/cfa.schema.json)。入力例は[efa.request.json](examples/efa.request.json)、[cfa.request.json](examples/cfa.request.json)。既存analysis_requests.pyのAnalysisContextV2とStrictModelを再利用する。データ依存検証・エンジン能力はSchema外でサービスが検査する。

|入力|033b EFA|033c CFA|
|---|---|---|
|context|既存V2、missingPolicy=exclude|同左|
|weightMode|none/dataset。dataset解決後にweightなしのみ|同左|
|variables|columnId、measurement、treatment、categoryOrder、reverse、approximationAcknowledged|同左|
|尺度|measurement=ordinal/continuous。treatment=ordinal/continuous/continuous_approximation|同左|
|相関・方法|correlation=pearson/polychoric、extraction=minres/ml|estimator=wlsmv/mlr/ulsmv/ml|
|因子指定|nFactors、compareFactors|factors内factorId/indicatorIds/markerColumnId|
|回転・因子相関|rotation=promax/varimax/none|factorCovariance=free/orthogonal|
|得点|scoreMethod=none/regression/bartlett、ordinal経路はnoneのみ|初期版なし|
|補助|parallelAnalysis、sensitivityAnalysis、seed、nStarts、maxIterations、uniquenessLower|confidenceLevel、sourceEfaResultId、validationIntent|

measurementの根拠はサービスでコードブック・分析時指定を照合し、結果に保存する。categoryOrderの値は正規化済みコード文字列で、表示ラベルではない。ordinalでは2個以上の一意コードが必須、連続変数ではnull。ordinal→continuous_approximationにはack=true、それ以外はfalse。連続変数のreverseはfalse。真の順序treatmentと連続treatmentの混在は拒否する。ordinalのカテゴリ数に上限・自動連続化規則を設けない。

EFA qは1以上p未満、df≥0、比較候補も同条件。CFAは全項目がちょうど一因子に所属、因子ごとに3項目以上、markerは所属項目、因子IDは一意。未知キー・不適切な尺度／推定器の組合せは拒否する。

生成JSON Schemaはフィールド型・enum・基本範囲を表し、Pydanticのmodel_validatorによる複数項目間の制約を自動では表現しない。JSON Schemaだけの合格を実行許可とせず、Python契約でtreatmentと推定器・因子割当・欠損・ウェイト設定等を再検証し、その後サービスがデータ依存条件を検証する。

sensitivityAnalysisはenabled=false、approximationAcknowledged=falseがAPI既定。両者を同時にtrueにした場合だけ比較を実行する。全項目の元measurement=ordinal、parallelAnalysis.enabled=trueが必須。主treatmentは全ordinal／全continuous_approximationを許すが、その混在は禁止。alignment=signed_permutation、comparisonExtraction=minresを固定し、主のML指定は保持する。差分目安3種は(0,1]、割当閾値とmarginは[0,1]で、全て有限値。定義と既定値は033b詳細設計第9節を正本とする。CFARequestではこの比較指定を受け付けない。

## 2. 共通エンベロープ拡張

共通の`{status,resultId,method,meta,config,capabilities,summary,details,unavailableReasons}`を使用し、methodへefa/cfaを追加する。schemaVersion=`factor_extensions.1`。status=successは保存された計算結果の応答を意味し、統計的な妥当性の宣言ではない。

|フィールド|型・意味|
|---|---|
|summary.computationStatus|completed。failed/cancelledは失敗試行の診断で使用し、成功結果にしない|
|summary.solutionStatus|admissible / boundary / inadmissible|
|summary.inferenceStatus|available / partial / unavailable / not_implemented|
|meta.analysisPurpose|efa=exploratory、cfa=confirmatory_model|
|meta.isExplorative|両方true。CFAの分析目的と独立検証済みを分離|
|meta.requestedMethod|要求correlation/extraction/rotationまたはestimator|
|meta.appliedMethod|実相関・実抽出・回転、objectiveId、engineEstimator、SE/test定義|
|meta.routingReasons|code、columnIds、根拠の配列。UIの既定候補提示の理由|
|meta.methodSwitchReason|変更なしnull。1因子回転不要等の実適用差のみ。別推定器への自動切替不可|
|meta.matrixCorrection|applied=false、method=null、originalMatrixHash、effectiveMatrixHash|
|meta.attemptId / previousAttemptId|当該試行／明示再実行元。過去失敗を削除しない|
|meta.fitRowsRef / excludedRowsRef|保存行集合参照とcount/hash。HTTPへ全IDを二重埋込みしない|
|meta.measurementResolution|各列のsource、original/effective measurement、order、reverse、approximation|
|meta.engineManifest|algorithmVersion、sourceHash、runtime、libraryVersions、resolvedOptions、validationSuiteId|

既存のdataset/revision/scope/count/imputation/warnings/fingerprintは保持する。全経路非加重のためweightApplied=false、weightType/weightColumn/sumWeights/frequencyN=null。effectiveN=fitCount。未対応ウェイト入力の結果をこの形で成功返却してはならない。

診断レコードは`{code,severity,stage,columnIds,pairIds,factorIds,count,value,threshold,reason}`。severity=info/warning/error、配列なしは[]、数値未提供はnull。文字列messageではなくcodeでUI分岐する。stageはinput/correlation/extraction/rotation/parallel/scoring/identification/inference/fit/persistence。

422失敗は共通errorに`attemptId,stage,diagnosticsRef`を追加できる。失敗記録は独立した診断保存でありresultIdを使った有効モデル操作の対象ではない。元回答・内部パス・スタックを公開errorへ含めない。

失敗を再試行後も参照できるよう、実装予定APIはGET `/api/v1/analysis-attempts/{attemptId}`（要求・解決済み設定・段階・状態・診断要約）とGET `/api/v1/analysis-attempts/{attemptId}/diagnostics?offset=0&limit=500`（上限10000、total/nextOffset）を追加する。所有datasetの照合と明示削除・dataset削除への追従を共通結果storeと揃える。失敗attemptにrows/predict/materialize APIは設けない。成功結果の大量診断は共通exportのdiagnostics表で取得する。

## 3. EFA結果

p=項目数、q=主因子数、Kj=項目jのカテゴリ数。配列順はdetails.variablesとfactorIdsで明示する。

|項目|型・形状|
|---|---|
|summary.nVariables/nFactors/modelDf|整数|
|summary.objective|{id,value,offDiagonalSse,optimizerDiagonalParametersRef}。MLでは最後の参照null|
|summary.rmsr/totalCommunalityRatio|有限値またはnull。RMSRは非対角p(p−1)/2分母|
|summary.selectedStartIndex/effectiveFactorRank|整数|
|summary.scoreMethod/scoreInterpretation|none/regression/bartlett、latent_estimate/continuous_approximation/null|
|details.variables|p件、columnId、label、order、変換、mean/sampleScale（順序モデルはnull）|
|details.factorIds/factorLabels|q件|
|details.pattern/structure|p×q|
|details.factorCorrelation/rotationTransform|q×q|
|details.communality/uniqueness|p件|
|details.sampleCorrelation/reproducedCorrelation/residualCorrelation|p×p、対角残差も保持|
|details.thresholds|順序のみp件の{columnId,cuts[Kj−1],scale:standard_normal}、他null|
|details.correlationDiagnostics|対別診断へのページ参照、総対数p(p−1)/2|
|details.optimizerStarts|startごと初期u/ψ、status、iterations、objective、projectedGradientNorm|
|details.ssLoadings/varianceRatios|q件またはPromax時null|
|details.parallelAnalysis|下記|
|details.factorComparisons|q候補ごとのstatus、objective、RMSR、診断・行列参照。失敗も保持|
|details.distributionProfiles|項目別N、categoryCounts/Proportions、minCategoryCount、maxCategoryProportion、rankSkewness、floor/ceilingProportion、reasonCodes|
|details.sensitivityAnalysis|enabled、comparisonIdまたはnull、現在の実行状態。主結果を変更するものではない|

parallelAnalysisは`{enabled,status,iterationsRequested,iterationsSucceeded,iterationsFailed,seed,rng,nullGenerator,quantile,quantileMethod,eigenvalueDefinition,observedEigenvalues,referenceQuantiles,suggestedFactors,exceedanceRanks,replicatesRef,reasonCode}`。nullGenerator=independent_column_permutation、eigenvalueDefinition=full_correlation、quantileMethod=linear。未実行はstatus=not_requested、統計量null。失敗反復があればreferenceQuantiles/suggestedFactors=null。観測固有値p件はスクリープロット用として残す。

MLの参考適合度・KMO/BartlettはfitMeasuresとunavailableReasonsで033規約に対応させる。ULS系にML検定を返さない。算出されたが不適解のため利用できない値は、公開推論valueをnullとし、内部診断値と区別する。

### 3.1 感度比較の独立結果

GET `/api/v1/analysis-comparisons/{comparisonId}`は次を返す。主resultIdの計算値やfingerprintは比較完了で書き換えない。進捗・比較索引はGET時に解決し、完成した比較データは不変とする。

|フィールド|型・内容|
|---|---|
|comparisonId/primaryResultId|保存された比較／主結果のID|
|status/stage/progress|queued/running/completed/partial/failed/cancelled、段階名、完了反復数と予定数|
|meta|dataset/revisions/rowHash/itemHash/fitCount、同意、engine版、比較版、置換ストリーム参照、stale状態|
|methods|pearson/polychoricそれぞれのresultIdまたはattemptId、抽出・q・回転・得点none、solutionStatus|
|alignment|method、status、permutation、signs、congruences、assignmentGap、H、procrustesResidual/Q（未計算null）|
|metrics|相関・負荷量・共通性・Φの最大/中央値差、割当変更・比較可能・曖昧数、PA候補数と差|
|itemDifferences|columnId、共通性差、整合済み負荷量差、各側確定/曖昧割当、変更の有無|
|factorCountComparison|pearsonSuggestedFactors、polychoricSuggestedFactors、difference、各PA参照、reasonCode|
|assessment|small_observed_difference / method_sensitive / indeterminate / null（未完了）|
|thresholds/assessmentVersion|要求された比較目安、固定整合目安、判定ロジック版|
|unavailableReasons/diagnostics|各差分のnull理由、片側失敗や低整合を含む|

`completed`は比較処理完了を示し、assessment=indeterminateもあり得る。副解析失敗のpartial/failedを「差なし」に変換しない。両側の行hash・項目hash等が一致しなければ`COMPARISON_CONTEXT_MISMATCH`で指標を計算しない。適用qが異なる場合に係数差を0補完しない。

比較には回答者得点・PCP選択・materialize能力を付けない。GET同URLの`/export?table=manifest|items|metrics|diagnostics&offset=0&limit=500`で同じ所有確認と上限10000のページ出力を行う。POST同URLの`/cancel`は比較だけを中断し、主結果の閲覧を保持する。削除は明示操作またはdataset削除に追従し、関連IDの参照切れは削除済みと示して別結果に付け替えない。

## 4. CFA結果

|項目|型・形状|
|---|---|
|summary.nVariables/nFactors/nFreeParameters/modelDf|整数、自由度はエンジンと独立数え上げを照合|
|summary.estimator/parameterization/scaleIdentification|wlsmv/mlr/ulsmv/ml、thetaまたはcontinuous、marker|
|details.model|確認済み割当・制約・marker・modelHash|
|details.parameters|下記Parameter配列|
|details.factorCovariance/factorCorrelation|q×q|
|details.loadings/stdLvLoadings/stdAllLoadings|p×q、非所属は固定0|
|details.residualVariances/stdAllResidualVariances|p件、単位を明示|
|details.intercepts|連続p件、順序null|
|details.thresholds|順序p件の有限内部閾値と尺度、連続null|
|details.observedMoments/reproducedMoments/residualMoments|共分散／潜在応答相関をkindで区別する参照|
|details.sampleStatistics|ordered statisticIds、nStatistics、GammaShape、GammaScale、GammaRef、WlsWeightRef|
|details.identification|parameterCount、jacobianRank、informationRank、conditionNumbers、reasonCodes|
|details.fitMeasures|下記FitMeasure配列|
|details.testStatistics|target/baseline/h1、通常・補正検定、係数・shift・エンジン参照|
|meta.validationEvidence|下記|

Parameterは`{parameterId,lhs,op,rhs,freeIndex,fixed,fixedValue,estimate,standardError,statistic,pValue,ciLower,ciUpper,confidenceLevel,stdLvEstimate,stdAllEstimate,scale,reasonCode}`。固定値はestimateにも含め、SE/statistic/p/CIはnull、reasonCode=FIXED_PARAMETER。推定値・SE等は有限数またはnull。統計量はSEに対応するz等の定義をtestStatisticsに保存する。

FitMeasureは`{metric,variant,engineKey,value,ciLower,ciUpper,confidenceLevel,statisticDefinition,correctionMethod,df,n,availability,reasonCode}`。variant=standard/scaled/robust/descriptive。SRMR/RMSRはdescriptive、参考χ²等は適切なvariant。未定義の統計量を空配列で隠さず、初期UI対象指標についてnullのレコードと理由を返す。χ²のrobust別値は捏造せず、補正χ²をscaledで記録する。

validationEvidenceは`{intent,sourceEfaResultId,sourceModelHash,sourceDatasetLineage,currentDatasetLineage,overlapCount,splitDefinitionRef,modelFrozenAt,evidenceStatus,reasonCode}`。intent=exploratory/same_data/holdout/external/unknown、evidenceStatus=same_data/holdout_recorded/unknown。別データの行IDが偶然一致・不一致であることだけを回答者の同一性判定に使わない。

## 5. 能力・結果操作

|能力|EFA得点なし／不適解|EFA得点あり・適切な解|CFA初期版|
|---|---|---|---|
|rows/projection/materialize|false|true|false|
|selectionKinds|[]|rectangle,row_ids|[]|
|materializeFitFields/PredictionFields|[]|score:1..q|[]|
|simulation|false|false|false|

境界解は得点・保存を無効にする。EFA得点rowは共通のrowId/scores、学習外欠損はnullのpredictionStatus。scoresを計算していない行の代わりに負荷量をPCPに載せない。

拡張専用exportTablesはEFA=`manifest,variables,diagnostics,parallel_analysis,factor_comparisons`と得点がある場合のrows、CFA=`manifest,parameters,fit_measures,diagnostics`。共通の既存enumには実装時に明示追加し、他手法の同名表の意味を変えない。diagnostics・反復・比較はkindごとのlong table、offset/limitを使い全件を出力できる。

result storeは共通の原子的保存と版照合を使用する。schemaVersionとmethodに応じて追加serializerを選ぶ。現在の共通Python/Schemaはこれらの結果・export拡張をまだ実装していないため、本書を実装契約の追加要件とする。request Schema成功を結果API実装済みの根拠にしない。
