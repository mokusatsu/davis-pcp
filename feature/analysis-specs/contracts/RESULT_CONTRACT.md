# 結果契約・データ辞書 v1.0

033 EFA／033c CFAでは[拡張入力・結果契約](FACTOR_EXTENSIONS_CONTRACT.md)がmethod、状態、適合度variant、capabilities、export表を追加する。本書の旧ML因子分析項目や「CA以外rows=true」は拡張機能へ自動適用しない。

本書はFeature 029〜034のJSON出力名・単位・配列形状の正本。数式は各実装設計、入力型は`analysis_requests.py`。未提供値はnullと理由を返す。以下の型表記はTypeScript相当で、`Float`は有限JSON number、`Count`は0以上の整数、`Nullable<T>`はTまたはnullである。公開APIのcamelCaseとmaterialize用の固定sourceField識別子を混同しない。

## 1. 共通エンベロープ

```ts
type Method = 'ca'|'mca'|'famd'|'linear_regression'|'factor_analysis'|'conjoint';
type Reason = {code:string; message:string; relatedFields:string[]};
type Warning = {code:string; message:string; count:number|null; columnIds:string[]};
type AnalysisResult = {
  status:'success'; resultId:string; method:Method;
  meta:AnalysisMeta; config:object; capabilities:Capabilities;
  summary:object; details:object;
  unavailableReasons:Record<string,Reason>;
};
```

resultIdはUUID、meta.modelFingerprintは`sha256:`付きhash。configはdefault補完済み入力とresolvedEncoding/resolvedWeightを含むeffectiveConfigを返す。リクエスト値を変更した設定は表示中configに混ぜない。meta.warningsのcodeでUI分岐しmessageの日本語部分で判定しない。構文誤りのerrorも共通API例外ハンドラからJSONへ変換する。

```json
{"status":"error","error":{"code":"ANALYSIS_INPUT_STALE","message":"入力の版が変更されています。再実行してください。","details":{"expectedDataRevision":1,"currentDataRevision":2}},"traceId":"server-generated-id"}
```

HTTPは入力・推定不能422、競合409、未存在404、内部不変条件500、実際のメモリ/保存資源枯渇503。中断表示はFE状態であってHTTP成功ではない。公開エラーにPythonスタック、原データ全体、ファイルシステム絶対パスを含めない。

## 2. AnalysisMeta

|フィールド|型・単位|規約|
|---|---|---|
|datasetId|str|所有データセット|
|dataRevision/schemaRevision|正整数|学習snapshotの版。GET時に現在版で上書きしない|
|maskRevision|整数またはnull|既存mask_revisionの戻り値を型を保って記録|
|currentDataRevision/currentSchemaRevision|正整数|GET時の現版|
|resultState|`current` / `stale`|旧結果の閲覧を区別|
|scope|入力scope enum|学習時scope|
|scopeHash|str|既存scope_hashの規約|
|scopeCount/fitCount/effectiveN/excludedCount|Count|物理行、effectiveN=fitCount|
|exclusionCounts|下記オブジェクト|first reasonによる排他計数|
|analysisUnit|`respondent_row` / `table_record` / `profile_row`|行の意味|
|weightApplied|bool|解決後の有効な重み使用有無|
|weightType|`survey` / `frequency` / null|未適用時null|
|weightColumn|strまたはnull|解決後columnId|
|sumWeights|Floatまたはnull|有効物理行の重み合計。CA表はnull|
|kishEffectiveN|Floatまたはnull|通常は有効物理行wのKish。CJは後述回答者単位。CA表null|
|frequencyN|Floatまたはnull|frequencyのみ複製数。CJは回答者数。CA表null|
|imputedCellCount/imputedRowCount|Count|実際に使用したモデル入力の補完済みセル・原行。親MA判定用だけの補助セルは別診断|
|modelFingerprint|str|学習内容hash|
|algorithmVersion|str|本版は各`davis.<method>.1.0.0`|
|numericalRuntime|object|python/numpy/scipy/polars/pydantic、platform、engine=`local`/`pyodide`、BLAS識別（取得不能null）|
|isExplorative|true|全6機能でtrue。データ探索で確認的検証済みとはしない|
|warnings|Warning[]|なしは[]|
|runtimeCapabilities|object|resultPersistence=`workspace`/`idbfs`/`tab_only`、logicalCancel=true、hardCancel=false|

exclusionCountsの固定キーはinvalid,missing,missing_weight,zero_weight,structural_task_exclusion。0件も0を返す。合計=excludedCount、scopeCount=fitCount+excludedCount。meta.exclusionDiagnosticsに詳細の非排他件数を追加できるが主内訳へ足さない。

CJはmeta.kishEffectiveNを有効回答者重みで一度ずつ計算し、meta.frequencyN=summary.frequencyRespondentN。summary.sumRespondentWeightsを必須併記する。meta.sumWeightsはプロフィール行合計であり、モデル自由度・回答者数に使わない。非加重CJのkishEffectiveNはrespondentCount。観測数が異なる回答者がいる試験でこの差を検証する。

整数がJavaScript安全整数を超えるfrequency総量は推測処理を422 `FREQUENCY_TOTAL_UNSAFE`で止める。これはページ件数による制限ではなく、現API型の整数同一性を守る制限である。物理行数・revisionも安全整数であることを保証する。

## 3. 配列・ID・軸

全スペクトルを返すCA/MCA/FAMDではrank=r、summary.eigenvalues長r。数値閾値未満を除いた全有効軸であり、表示2軸への切詰めではない。慣性比の分母は全行列慣性。summary.discardedNumericalInertiaも3機能で必須。軸IDは1..r、配列indexはaxisId−1。因子分析では軸でなく因子ID1..q。縮退ブロックは`[{axisIds:[1,2],relativeGapTolerance:1e-10}]`、縮退なしは[]。

categoryIdは`cat:`+SHA256(canonical JSON `[columnId,kind,normalizedCode]`)。CA表の行カテゴリはcolumnId=rowLabelColumnとkind=value、列カテゴリはcolumnId=対応valueColumnとnormalizedCode=同columnIdとする。省略カテゴリにも安定IDを付ける。kind=missing/not_applicable時code=null、kind=value時codeは既存normalize_codeに従う文字列。ラベル欠落時はcodeを表示、missing/NAは明示日本語ラベル。

designColumnIdは`design:`+SHA256(canonical JSON `[termId,codingColumnDescriptors]`)。termIdは切片`intercept`、主効果は`main:<columnId>`、交互作用は元predictors順で並べた2列のcanonical JSONにhashを付ける。IDに表示ラベルを含めない。designColumnDescriptorsにdummy水準・基準水準・coding方式を保存し、式文字列から復元しない。

## 4. CapabilitiesとsourceField

```ts
type Capabilities = {
 rows:boolean; projection:boolean; materialize:boolean;
 selectionKinds:('rectangle'|'categories'|'row_ids'|'respondents'|'diagnostic_rectangle')[];
 exportTables:string[]; materializeFitFields:string[]; materializePredictionFields:string[];
 predictionIntervals:('none'|'mean_ci'|'individual_pi')[];
 simulation:boolean;
};
```

|手法|selectionKinds|保存field|projection|
|---|---|---|---|
|CA|categories|なし|false|
|MCA/FAMD|rectangle,categories,row_ids|fit/predictionともcoordinate:1..r|true|
|ML因子|rectangle,row_ids|fit/predictionともscore:1..q|true|
|重回帰|diagnostic_rectangle,row_ids|fit:fitted,residual,leverage_total,leverage_per_replica。prediction:predicted,mean_ci_lower,mean_ci_upper,individual_pi_lower,individual_pi_upper|true|
|CJ|row_ids,respondents|predicted_rating / probability / residualのうちmodeで定義されたもの|true|

capabilities.materializeFitFields等は、その結果で本当に保存可能なfieldだけを列挙する。CI不可ならそのfieldを入れない。surveyの通常leverage診断は個別仕様に従う。rectangleをCAカテゴリ座標に適用する別意味のAPIは設けない。CAのrows=false、他はtrue。simulationはCJのみtrue。

exportTablesはCA:`manifest,eigenvalues,categories`、MCA:`manifest,eigenvalues,categories,rows`、FAMD:`manifest,eigenvalues,categories,variables,rows`、回帰:`manifest,coefficients,diagnostics,rows`、FA:`manifest,variables,rows`、CJ:`manifest,coefficients,diagnostics,rows,utilities`。表の主要全項目はmanifest JSONから取得できる。追加export table enumは本版に勝手に追加しない。

## 5. 手法別summary/details

個別設計の列挙フィールドは必須。該当しない場合nullとする。以下は配列の形と省略記述を確定する補則。

### 5.1 CA

summary.pearson={statistic:Float|null,df:Count|null,pValue:Float|null,status:`available`|`not_applicable`,reason:str|null,smallExpectedCellsLt1:Count|null,smallExpectedCellsLt5:Count|null,fractionExpectedLt5:Float|null}。pValueは確率0..1。

details.tableは正質量カテゴリだけの二次元配列I×J、details.tableRowCategoryIds/ tableColumnCategoryIdsで順序固定。physicalTableは同形、表入力時null。削除前の0質量カテゴリはomittedCategoriesに置き、入力全体をmanifestへ二重保存しない。

rowCategories/columnCategoriesの各coordinates/contributions/cos2長r。physicalCountは有効非加重原行数（surveyでも同じ物理数）、table入力時null。variableIdは元列ID、side=`row`/`column`。omittedCategoriesは`{categoryId,variableId,code,kind,label,side,reason:'zero_mass'}`。

### 5.2 MCA

details.categories各項目長r、details.variables=`[{variableId,label,categoryIds,isMaOption,maParentId}]`、details.maDiagnostics=`[{parentId,selectedChildIds,dependencyChildIds,statusCounts}]`。ordinary-onlyでMAなしは[]。summary.inertiaAdjustment=rawではadjustedEigenvalues/adjustedInertiaRatio=null。benzecriの場合は長r配列で、分母0ならadjustedInertiaRatio=[null,...]。adjustedEigenvaluesはこのとき0。

### 5.3 FAMD

numericVariablesはp件、categoricalVariablesはm件、categoriesはK件。numericVariables.scaleは母分母ddof0の標準偏差、sampleScaleという名前にしない。summary.coordinateConvention=`weighted_individual_barycenter`。カテゴリcos2のdistanceSquaredは全変換特徴空間での重心距離。個体とのユークリッド座標は共有できるが相関円とは共有しない。

### 5.4 重回帰

coefficients配列はdesignColumns順、両者length=p。全係数のフィールドは`designColumnId,termId,label,estimate,standardError,statistic,pValue,ciLower,ciUpper,standardizedEstimate`。`statistic`は採用referenceDfによるt。推測不能時SE/t/p/CIをnullとし係数は残す。標準化係数の計算法・未定義条件は個別設計通り。

summary.jointTest=`{kind:'classical_f'|'robust_wald_f'|null,statistic:Float|null,dfNumerator:Count|null,dfDenominator:Float|null,pValue:Float|null}`。切片を除いた全係数を検定。切片だけモデルは入力で成立しない。基準水準はcategoryReferencesに`{columnId,referenceCategoryId,observedCategoryIds,coding:'treatment'}`。

vif=`[{designColumnId,value:Float|null,status:'available'|'constant'|'perfect_collinearity'}]`。大きさ∞はJSON数値にせずnull。summary.rSquaredType=`centered`/`uncentered`、rmseは重み和分母、residualStdErrorは残差自由度分母で区別する。

### 5.5 旧最尤因子分析資料

この節は旧FactorAnalysisRequestに対応する参照検証資産であり、現行Feature 033 EFAの結果正本ではない。現行のEFA結果、得点能力、平行分析、感度比較は[拡張入力・結果契約](FACTOR_EXTENSIONS_CONTRACT.md)を参照する。

pattern/structureはp×q、factorCorrelation/rotationTransformはq×q。sample/reproduced/residualCorrelationはp×p、uniqueness/communalityはp、ssLoadings/varianceRatiosはqまたはPromax時null。variables順とfactorLabels順が共通。

summary.bartlett=`{statistic:Float|null,df:Count,pValue:Float|null}`。kmoは0..1またはnull。optimizerStarts=`[{index,initialUniqueness,converged,iterations,fitFunction,projectedGradientInfNorm,messageCode}]`。最終採用startはsummary.selectedStartIndex。乱数seedを記録し、最適化message文字列に依存した成功判定を禁止。

### 5.6 コンジョイント

coefficientsは重回帰と同じ明示長名称standardError/statistic/ciLower/ciUpperを使う。実装設計中のSE/t/CIは説明上の略記であってJSONキーでない。levelUtilities=`[{attributeId,categoryId,levelCode,label,utility,standardError,ciLower,ciUpper,referenceLevel}]`。

attributeImportance=`[{attributeId,label,kind,range,importance,rangeLower,rangeUpper}]`。カテゴリrangeLower/Upperは最小/最大効用、linearは指定属性値範囲（この違いをkindで明示）。推定レンジ量のCIは返さない。omittedLevelsに未観測水準を保持。

fitMetricsはratings:`{rmse,mae,overallRSquared,withinRSquared}`、choice/ranking:`{logLikelihood,nullLogLikelihood,meanNegativeLogLikelihood,mcfaddenRSquared,hitRate,hitRateDefinition}`。ratings pooledのwithinRSquared=null。未採用modeの指標を0で混在させない。

大量のrespondentIntercepts/taskDiagnosticsはPOST/GETのdetails配列に無制限に載せない。detailsでは`{available:true,total,exportTable:'diagnostics',subtables:[...]}`という索引とする。diagnostics出力はkind=`respondent_intercept`/`task`/`stage`のlong format。row結果と同じページングで取得し、ページ順はkind順→回答者保存順→タスク保存順→stage番号。model.npz/Parquetからの読み出しが正本。これは「全件を分析する」と「全件を一度にHTTP返送する」を分ける契約である。

## 6. rows/予測API

```ts
type RowPage = {
 status:'success'; resultId:string; predictionId?:string;
 offset:number; limit:number; total:number; nextOffset:number|null;
 axes:number[]|null; rows:object[]; meta:{dataRevision:number;schemaRevision:number;resultState:'current'|'stale'};
};
```

fit rowsは有効fit行のみ、prediction rowsは指定scopeの全行を保持しstatus別にnullを返す。offset>=totalは空配列、limit超過は422。axesの重複/範囲外/回帰・CJでの指定は422。FAのaxesも因子IDを意味し、配列scoresを要求した順序に並べる。

|手法|fit rowの必須フィールド|
|---|---|
|MCA/FAMD|rowId,coordinates,contributions,cos2,mass,distanceSquared|
|FA|rowId,scores|
|重回帰|rowId,observed,fitted,residual,leverageTotal,leveragePerReplica,studentizedResidual,cooksDistance|
|CJ|rowId,respondentId,taskId,alternativeId,observed,predictedRating,probability,residual,predictionStatus|

MCA/FAMDの射影rowは上記にpredictionStatus追加、contributions=null、mass=null。cos2は学習空間の全距離から計算し、MCAも新行カテゴリプロファイルのχ²距離を分母とする。FAの予測rowはscoresとpredictionStatus。回帰予測rowはpredicted,observed,residual,meanCiLower,meanCiUpper,individualPiLower,individualPiUpper,predictionStatus。未依頼区間の上下限はnull。

predict応答=`{status,resultId,predictionId,summary,meta,unavailableReasons}`。summaryにはrequestedCount,successfulPredictions,failedPredictions,statusCounts,evaluationを必須。statusCountsのkeyはok,unknown_category,missing,invalid,unavailable。evaluationにはfitOverlapCount,nonFitEvaluationCountと別々のmetricsを返し、学習行を含む集計をholdout精度と呼ばない。evaluate=falseならevaluation=null。MCA/FAMD/FAは評価yを持たないためevaluation=null。

CJ予測は原task構造を保つ。未知属性/属性欠損があるchoice/ranking taskは全候補を未計算にする。responseは予測だけなら欠損可、evaluate時に整った回答を持つタスクのみ評価する。ランキングの予測確率は第1位のみ。availability=falseはunavailable。ratings fixedで未知回答者はmeanInterceptを用い、predictionAssumption=`population_mean_intercept`、既知なら`fitted_respondent_intercept`を追加する。

## 7. select/materialize/export

select応答rowIdsは結果保存順、重複なし。matchedCountはselectorに一致した保存結果の行数、fitMatchedCountはそのうち学習fit行（現版では同数）、contextIntersectionCountは要求scopeとの交差数。返却rowIdsは交差後のみ。FEはさらに現在activeに交差し、実適用件数を表示する。row_ids/respondentsで未知IDは無視するがignoredIdsCountを返す。categoriesでunknown categoryIdは入力誤り422（別結果の辞書混入を検出）。

materialize成功=`{status:'success',resultId,source,operationId,datasetId,dataRevision,schemaRevision,createdColumns:[{columnId,name,label,sourceField}],writtenRowCount,idempotentReplay:false}`。同一key/payload再送では同じ内容でidempotentReplay=true。writtenRowCountは少なくとも一つの非null保存値を持つ行数。sourceFieldごとにnonNullCountもcreatedColumnsへ含める。

export=`{status:'success',mime,fileName,encoding:'utf-8',payload,offset,total,nextOffset,hasHeader,snapshot:{datasetId,dataRevision,schemaRevision,resultId}}`。csv hasHeader=trueで各ページ同ヘッダ。manifest JSONはnextOffset=null。各テーブルJSONは`{columns,rows}`。配列列をCSV化するときはaxisIdでlong formatに展開し、曖昧なカンマ連結文字列にしない。ヘッダ順はschemaの固定field順、locale依存並べ替え禁止。HTML/SVGやExcel数式を文字列のまま実行させない。

## 8. simulate/WTP

simulate応答=`{status:'success',resultId,profiles:[{alternativeId,utility,predictedRating,probability,firstChoiceShare}],attributeImportance,wtp,warnings}`。各alternativeは入力順。ratingsではprobability=null、choice/rankingではpredictedRating/firstChoiceShare=null。効用に同じ定数を加えてもlogit確率不変であることを試験する。

includeWtp=falseならwtp=null。trueでは非価格カテゴリの各非基準水準対基準水準、および非価格linear属性のrangeLower→rangeUpperの比較を固定で出す。`[{attributeId,fromLevel,toLevel,deltaUtility,value,standardError,ciLower,ciUpper,priceUnit,status,reason}]`。価格は自分自身との比較を作らず、opt-outも含めない。価格の単位は保存codebook label/unitから表示し、単位未登録なら`per recorded price unit`。価格係数が負でCIが0を含まない条件を満たさないと値/SE/CI=null、status=unavailable、reason=WTP_UNSTABLE。

## 9. 未確定値・失敗例

距離0のcos2は`/details/categories/0/cos2/0`等にZERO_DISTANCE。推測不可SEはINFERENCE_UNAVAILABLE、survey非適用AICはUNSUPPORTED_FOR_SURVEY。nullが多数の行ページではunavailableReasonsを行ごとに重複文字列展開せず、pageのreasonCatalogとrow.reasonCodes（field→code）に正規化してよい。その場合reasonCatalogを必須とし、理由の省略とはしない。

本書の必須追加field（例CA tableカテゴリ順、FA selectedStartIndex）は個別設計の列挙に補完する。受入時は本書と入力Python契約からFE型・response serializerを作り、フィールド名のその場の略記を禁止する。

## 10. CJスコープ拡張API

`POST /models/conjoint/expand-scope`は学習前の補助API。入力はConjointExpandScopeRequest、出力は実装設計§11の固定field。expandedRowCount=originalRowCount+addedRowCount、expandedRowIds長=expandedRowCountを検証する。ID欠損/重複代替案などを見つけた場合はCONJOINT_INVALID_ID/CONJOINT_DUPLICATE_ALTERNATIVEで422。実行しないことを選んでも現在の設定・選択・結果は変更されない。
