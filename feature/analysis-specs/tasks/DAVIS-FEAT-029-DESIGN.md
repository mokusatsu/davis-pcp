# DAVIS-FEAT-029：通常CA 実装詳細化設計書

版1.0／対応仕様：[Feature 029](../feature/29_correspondence_analysis.md)／前提：[共通実装設計](DAVIS-FEAT-029-034-COMMON-DESIGN.md)。

## 1. 実装対象と既存再利用

新規`backend/app/algorithms/models/correspondence.py`に純粋数値kernel、`api/correspondence.py`にrouteを作る。`algorithms/summaries/crosstab.py`の度数計算・欠損意味と一致させるが、旧APIレスポンスの丸めた割合や上限付きrowIdsから行列を逆算しない。共通のカテゴリエンコーダで回答者配列を一度生成し、そこからcount tableとrow-set indexを構築する。

FEは`features/models/CorrespondenceAnalysisPage.tsx`、routeは`/models/ca`。main.tsx、KeepAliveOutlet、AppShellへの登録を同じPRに含める。

## 2. API入力

`POST /api/v1/models/ca`。

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"none","missingPolicy":"exclude"},"input":{"kind":"respondents","rowVariable":"q_brand","columnVariable":"q_need"},"mapScaling":"symmetric"}
```

input unionのもう一方は`{kind:'contingency',rowLabelColumn:string,valueColumns:string[],cellSemantics:'frequency'|'mass',independentCountsAcknowledged:boolean,structuralZerosDeclared:boolean}`。frequencyのackはtrue必須、massではfalse。構造的ゼロtrueは422。両モードとも同じ列の二重指定を拒否。nComponentsは入力に置かず、全スペクトルを計算し表示axisは結果側の操作とする。

respondentsの場合、nominal/ordinal2列、同一列不可、両列とも非MA。contingencyの場合、ラベルは非欠損一意、セル列はinterval/ratioで2つ以上、選択scope内に2つ以上の表行。tableではmissingPolicy=excludeのみとし、欠損セル/欠損行ラベルは行除外ではなく表不正として422。入力の意味が崩れるため、列ごとに違う有効表をつくらない。

## 3. 行列構築

respondentsでは共通前処理後の各原行iに行カテゴリr_i、列カテゴリc_iを整数付番する。非加重ならw_i=1。`T=coo_matrix((w,(r,c)),shape=(I,J)).toarray()`またはnp.add.atによる同値実装を使う。非加重実人数の`Tphysical`も別に加算する。カテゴリー順は共通catalog。tableではscope内のセル値そのものをTにする。表の行レコード数はrespondentCountではない。

周辺質量が0の行/列は数値計算から除き、その順序とoriginalIndexをomittedCategoriesへ保存する。セル全体の総和が0ならCA_EMPTY_TABLE。除いた後のI/Jが2未満ならCA_DIMENSION_TOO_SMALL。全表を比率にする前にfloat64のfiniteを再検証し、sum overflowもCA_NONFINITE_TOTAL。

## 4. CAの数式

T∈R^(I×J)、t=Σ_ab T_ab>0、P=T/t、r=P1、c=P'1。全r,c>0を確認する。

```
S = diag(r)^(-1/2) (P - r c') diag(c)^(-1/2)
S = U diag(s) V'
lambda_l = s_l^2
F = diag(r)^(-1/2) U diag(s)          # 行主座標
G = diag(c)^(-1/2) V diag(s)          # 列主座標
Phi = diag(r)^(-1/2) U               # 行標準座標
Gamma = diag(c)^(-1/2) V             # 列標準座標
```

共通thin_svdとrankTolを使う。理論最大ランクmin(I−1,J−1)を超える数値軸は許さず、超過が丸め誤差の範囲外なら内部不変条件エラー。全慣性=sum(S*S)。rank=0ならCA_ZERO_INERTIA、summaryに表の診断をerror.detailsとして添える。成功の空scatterを返さない。

axis lの寄与はrowContrib_a,l=r_a F_a,l²/lambda_l、columnContrib_b,l=c_b G_b,l²/lambda_l。全軸距離はrowDistance²_a=Σ_b(P_ab/r_a−c_b)²/c_b、columnDistance²_b=Σ_a(P_ab/c_b−r_a)²/r_a。cos2は主座標²をこの距離で割る。距離0ならnull。標準座標表示へ切り替えても寄与とcos2は主座標による定義を変えない。

inertiaRatio=lambda/totalInertia。display2DInertiaRatio=lambda_axis1/total+lambda_axis2/total。分母に表示軸の合計を使わない。軸符号は列主座標の最大絶対成分を正、同率は列catalog順。UとV、F/G/Phi/Gammaをまとめて反転する。

## 5. 統計量と注意

独立frequency度数の場合だけexpected_ab=t r_a c_b、pearson=sum((T−expected)²/expected)、df=(I−1)(J−1)、p=scipy.stats.chi2.sf(pearson,df)。identityとしてpearson≈t totalInertiaをrtol1e-10で検査する。Yatesなし。smallExpectedCellsLt1、smallExpectedCellsLt5、fractionExpectedLt5を返し、推測統計の注記を付ける。

survey/massでは`pearson={statistic:null,df:null,pValue:null,status:'not_applicable',reason:'NON_INDEPENDENT_FREQUENCY_INPUT'}`。Tとtとinertiaは返すが`t*inertia`を検定として強調しない。CAの参考Pearsonは軸の検定や残差セルの多重比較ではない。

## 6. 結果型

summaryは`rank,totalInertia,eigenvalues:number[],inertiaRatio:number[],cumulativeInertiaRatio:number[],discardedNumericalInertia,tableTotal,activeRowCategoryCount,activeColumnCategoryCount,pearson`。

detailsは`rowCategories,columnCategories,omittedCategories,table,physicalTable,mapScaling`。各categoryは`categoryId,side,variableId,code,kind,label,mass,physicalCount,principalCoordinates,standardCoordinates,contributions,cos2,distanceSquared`。tableモードのphysicalCountはnullで、表セル度数を実際の回答者レコード件数と呼ばない。physicalTableもnull。

rowStorageはCA専用category-index。capabilitiesはrows=false,projection=false,materialize=false,selectionKinds=[categories]とexportTablesの一覧。category row-set indexはfull original __rowId__を保存し、上限付きの代表行リストで選択を代用しない。

## 7. UI実装手順

1. input.kindごとにフォームを分け、dataset weight適用表示を共通バーに置く。tableモード切替だけでweightModeをnoneへ裏変更しない。利用者が明示切替する。
2. コンポーネントの図にはprincipal/standardのどちらを渡すかをmapScalingで決定し、軸名に変換方式を書く。
3. 表示rank1のとき第2軸selectを無効化して1Dへ切替。有効カテゴリ0質量情報は折りたたみ表へ表示。
4. category clickを直接selectionAppliedへ流さず、CA用select APIで元行集合に解決し、existing operationを適用する。
5. tableモードの列カテゴリclickは選択ではなくセル列強調。rowカテゴリclickだけ原表行レコードへの選択ボタンを表示する。
6. 点のカテゴリラベル、質量、cos2をhoverで表示し、軸ラベルにraw inertia比を常時表示。

## 8. エラーと回復

|code|条件|画面対応|
|---|---|---|
|CA_CATEGORY_REQUIRED|非カテゴリ/同一列/MA|列選択を強調|
|CA_TABLE_INVALID|欠損・負数・重複行ラベル・非整数frequency|セル位置/行ID/列IDを最大20件、全件数も返す|
|CA_DOUBLE_WEIGHT_FORBIDDEN|table入力＋解決済み重み|明示的noneへの操作|
|CA_STRUCTURAL_ZERO_UNSUPPORTED|構造的ゼロ宣言|対象外の説明。擬似度数は加えない|
|CA_EMPTY_TABLE|全質量0|入力表を確認|
|CA_DIMENSION_TOO_SMALL|正質量行/列不足|行/列選択を確認|
|CA_ZERO_INERTIA|独立表で数値ランク0|関連を配置できない説明|

すべてHTTP422。数値不変条件違反は500 ANALYSIS_NUMERICAL_INVARIANT_FAILEDとしてtraceIdを残し、ユーザーデータ全体をログに流さない。

## 9. 実装・受入順序

kernel→表モード→回答者mode/weight→category選択→FE→export→staticの順。テスト新規`backend/tests/stats_tests/test_100_ca.py`、API`test_160_new_analysis_api.py`、FE`frontend/tests/correspondence.test.tsx`。

正解fixture、独立表、零周辺、表倍率、行列転置（FとGの交換）、カテゴリ置換、rank1、少数期待度数、missing3方針、weight none/frequency/survey、部分スコープ、stale選択を全てテストする。R caまたはFactoMineR CAと比較する際はscaling・重み・質量0処理を合わせ、符号と縮退を調整する。

## 10. 分割表モードの件数契約

表として妥当な入力ではmeta.scopeCount=fitCount=effectiveN=選択された表レコード数、excludedCount=0とする。幾何で除く零周辺行は入力不正でも回答者除外でもないため、omittedCategoriesとactiveRowCategoryCountだけに反映する。meta.analysisUnit=table_record、sumWeights=null、kishEffectiveN=null、frequencyN=null。summary.tableTotalはセル総量であり、独立frequencyモードの推論に使う度数総数もこの値である。cellSemantics=frequencyであってもfrequencyNを表行の複製数と誤認させない。weightApplied=false。回答者モードの通常metaと同一視しない。

## 一次資料との対応

[S-CA](../references/PRIMARY_SOURCES.md#s-ca)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。
