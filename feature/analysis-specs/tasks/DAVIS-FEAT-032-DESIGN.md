# DAVIS-FEAT-032：重回帰 実装詳細化設計書

版1.0／対応仕様：[Feature 032](../feature/32_multiple_linear_regression.md)。共通設計の重み・スコープ・版・推測統計契約を適用する。

## 1. 接続先・入力

新規`backend/app/algorithms/models/linear_regression.py`、`api/linear_regression.py`、`frontend/src/features/models/LinearRegressionPage.tsx`。route `/models/linear-regression`、POST `/api/v1/models/linear-regression`。既存`api/regression.py`のLOESSを置き換えない。

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"none","missingPolicy":"exclude"},"target":"overall","predictors":[{"columnId":"quality","kind":"numeric"},{"columnId":"brand","kind":"categorical","referenceCategory":"A"}],"interactions":[],"intercept":true,"covariance":"auto","confidenceLevel":0.95}
```

covariance=autoは非加重/frequencyでhc3、surveyでtaylorに解決し、effectiveConfigへ解決後を保存する。明示したhc3/classical/taylorがweightTypeと不整合ならLR_COVARIANCE_WEIGHT_CONFLICT。purpose=精度WLSの入力フィールドは存在しない。

predictor.numericはinterval/ratio、またはordinalで`ordinalAsNumericAcknowledged=true,score='ordered_rank'`。categoricalはnominal/ordinal、referenceCategoryはnormalize_code済みの実値カテゴリのcodeを指定する。欠損カテゴリを基準にしたい場合のUIは本版では未提供とし、referenceCategoryに内部missing sentinelを渡させない。基準省略時は有効な通常value水準の先頭、通常valueがない場合はLR_NO_REFERENCE_CATEGORY。

説明変数/target重複・predictor重複・interaction重複・自己交互作用・3項以上・未採用主効果との交互作用を拒否する。式文字列をevalしない。

## 2. モデル行列

学習validMaskを先に確定し、カテゴリcatalogと基準水準を学習行だけから作る。通常のvalue水準に加えmissingPolicyで採用したmissing水準もk−1符号化する。各カテゴリ変数は有効水準>=2。宣言カテゴリが未観測なら列を生成せずomittedLevelsへ返す。指定基準が未観測ならLR_REFERENCE_UNOBSERVED。評価/予測行から水準を追加しない。

列順は切片（有の場合）、predictorsの指定順、各変数内のcatalog順（基準除外）、interactionsの指定順で展開する。interaction内は第一変数の列を外側、第二変数の列を内側とする。数値は元尺度または宣言ordinal得点のまま。自動中心化/標準化はせず、条件数が大きければ警告する。

X∈R^(n×p)、pは切片とダミーと交互作用を含む列数。すべて有限。`Xw=sqrt(w)[:,None]*X`、`yw=sqrt(w)*y`。`scipy.linalg.lstsq(Xw,yw,cond=eps*max(Xw.shape),lapack_driver='gelsd')`でβを得る。rank<pならLR_RANK_DEFICIENTを422。rankTolと依存候補列（SVDのnull方向から最大係数の列名）をdetailsに返す。黙ってダミーを削除しない。

bread B=(X'WX)^−1はrank確認済みのXwのSVDからV diag(1/s²)V'で構成する。正規方程式を直接逆行列化して係数推定しない。n physical<pなら必ず識別不能だが、frequencyN>pだけで通過させない。

## 3. 残差・標本数・適合

fitted=Xβ、e=y−fitted、SSE=Σw e²。非加重w=1、frequency w=fは整数度数。nStat=nまたはΣf。surveyではnStat=null。sumWeightsは倍率依存するがmean/R²は比なので不変。

切片ありはTSS=Σw(y−ybar_w)²、なしはTSS=Σw y²。R²=1−SSE/TSS、rSquaredType=centered|uncentered。TSS=0ならnull。RMSE=sqrt(SSE/Σw)とresidualStdError=sqrt(SSE/(nStat−p))を別々に表示する。後者は非加重/frequencyだけ。

非加重/frequencyの残差dfν=nStat−p、ν>0を要求する。surveyのt/CI参照dfは共通設計のD−(p−intercept)。adjustedR²=1−(1−R²)(nStat−intercept)/(nStat−p)、切片なしは見出しもadjusted uncenteredにする。surveyではadjustedR²=null。

完全当てはまりSSE<=eps*max(1,TSS)はLR_NEAR_PERFECT_FIT警告。SSE=0のとき通常Gaussian log likelihoodとAIC/BICは未定義としてnull。係数が計算できることと誤差分散が安定して推定できることを分ける。

classicalかつ非加重/frequencyでSSE>0なら`logLik=−nStat/2*(log(2π)+1+log(SSE/nStat))`、`kAic=p+1`（誤差分散も1パラメータ）、AIC=−2logLik+2kAic、BIC=−2logLik+kAic log nStat。statsmodels OLSの表示AIC/BICは誤差分散を数えない規約なので、oracle比較時はAICへ2、BICへlog(nStat)を加えて比較する。HC3/Taylorでは本版のAIC/BIC表示はnullとする。

## 4. 分散の正本

### 4.1 classical

非加重/frequencyのみ。σhat²=SSE/(nStat−p)、V=σhat²B。係数SE=sqrt(diagV)。95%等CIはt_(ν,1−α/2)。frequency重みを平均1に正規化してからSSE/dfを計算しない。原度数で複製と同値にする。

### 4.2 HC3：非加重

h_i=x_i'Bx_i、meat=Σ x_i x_i' e_i²/(1−h_i)²、V=B meat B。h>=1−1e-12の行があればHC3は数値的に未定義のためSE/CI/pをnullとし、HC3_LEVERAGE_ONEを返す。分母へ適当なepsilonを足して大きなSEを作らない。

### 4.3 HC3：frequency

f_i回同じ独立観測を複製したものとして扱う。B=(X' diag(f)X)^−1。一つの複製観測のleverageは`h0_i=x_i' B x_i`。したがって

`meat=Σ_i f_i x_i x_i' e_i²/(1−h0_i)²`。

f_i²を使う式、h0の代わりにf_i h0を分母へ入れる式はいずれも禁止。これは調査ウェイトのsandwichと別物である。参照dfν=Σf−pを使うt近似であり、有限標本の厳密なHC3分布を保証しない。

### 4.4 survey Taylor

βは同じ重み付き最小二乗。単位score u_i=w_i x_i e_i、scope外/分析変数欠損行のscore=0。共通model_covarianceで層/PSUのmeatを求めV=B meat B'。survey重みを任意にc倍したらBは1/c、meatはc²となりVが不変であることをテストする。PSUなしは独立行の近似とラベル付けする。

設計情報不足/不正/単一PSU層でVを得られない場合は係数だけ成功、inferenceStatus=unavailable。negative/FPC範囲外等の明らかな設計入力不正は422、それ以外のsingleton/df不足は推測不能として返す。この区別をUIの警告とエラーで分ける。

## 5. 検定・標準化係数

係数t=β_j/SE_j、p=2*t.sf(abs(t),ν)。SE=0なら非有限tを送らずnull、ZERO_STANDARD_ERROR。p値0は浮動小数のunderflowとして起こり得るため0を許すが「p=0で絶対」と表示せず表示下限で`p<1e-300`等にする。

全傾きの同時検定はRβを取りq=rankR、`F=(Rβ)'(RVR')^−1(Rβ)/q`、df=(q,ν)のrobust Wald。RVR'がfull rankでなければnull。classicalでは通常Fも計算し一致を検査する。切片だけのモデルはpredictors>=1規約により本版入力対象外だが、交絡で傾きrankが0の場合は推定不可。

標準化係数は連続/ordinal数値の主効果に限りβ_j*sd_w(x_j)/sd_w(y)、両sdはddof0の同じ重み比で計算する。交互作用・ダミーにはnull、reason=NOT_COMPARABLE_STANDARDIZED_EFFECT。共線性や交互作用がある状況で大きさだけを重要度の順位にしない。

## 6. 診断

non-survey：leveragePerReplica=h0、leverageTotal=f*h0（noneはf=1）。行表でこの2つを分ける。studentizedInternal=e/(σhat sqrt(1−h0))、CookPerReplica=e²*h0/(p*σhat²*(1−h0)²)。frequencyでは「一つの複製観測」を削除する診断であって元の圧縮行ブロック全削除の影響ではない。ブロック削除診断は本版未提供。

survey：leverageTotal=w*x'Bxを幾何的診断として出す。通常のCook距離とstudentized residualはnullであり設計補正済みと偽装しない。fitted/residualは通常通り出す。

VIFは各非切片設計列x_jを他の設計列＋補助切片へ重み付き回帰し、centered補助R²から1/(1−R²)。補助回帰に重複切片を追加しない。1−R²<=1e-12ならnull理由PERFECT_COLLINEARITY、定数列ならnull。結果は元変数ではなくdesignColumnIdに紐付ける。GVIFや自動変数除去は実装しない。

QQは有効なeを標準化して並べ、非加重の表示位置(i−0.5)/nに対する標準正規quantileを使う。frequencyでは頻度重みのmid-CDF位置(累積前f+f/2)/Σfを使用する。surveyは加重CDFを使っても正規性検定とは呼ばず参考図である。

## 7. 予測・評価・保存

保存モデルにdesignColumns、category/reference、ordinal/reverse、学習数値min/max、β、V、σ²、νを保持。row予測ではtargetの欠損を理由に予測を除外しない。平均CIはβ推定共分散Vから`yhat±tcrit sqrt(x'Vx)`。individualPIはclassicalのみ`yhat±tcrit sqrt(x'Vx+σ²)`。入力の新しいweight値で予測値や誤差分散を変えない。

予測評価のyがある行だけRMSE/MAE/R²を計算し、評価数、fitRowOverlap、fitRespondentOverlap（通常rowIdのみならnull）を返す。評価の重みは予測contextの宣言を使うが、係数を更新しない。評価指標のスコープと学習スコープを別metaにする。

保存可能fieldはfitted/residual/leverage_total/leverage_per_replica、およびpredictionのpredicted/mean_ci_lower/mean_ci_upper/individual_pi_lower/individual_pi_upper。inference未対応fieldを全null列として保存することは拒否する。fit外行へresidualを埋めない。

## 8. 結果フィールド・FE

summary={targetLabel,nDesignColumns,rank,conditionNumber,rSquared,rSquaredType,adjustedRSquared,rmse,residualStdError,residualDf,referenceDf,logLikelihood,aic,bic,kAic,inferenceStatus,covarianceMethod,jointTest}。details={designColumns,coefficients,categoryReferences,vif,omittedLevels,designDiagnostics}。coefはdesignColumnId/termId/label/estimate/standardError/statistic/pValue/ciLower/ciUpper/standardizedEstimate。

係数表の見出しにcovarianceMethodとreferenceDfを表示する。設定フォームのカテゴリ基準選択は表示ラベルを検索できるがAPI valueはcode。UI上で選択したvariable一覧と展開後design columnsの両方を確認可能にする。個体図はx=fitted,y=residualを初期値とし、selectionは全保存rowへ適用する。

## 9. 実装テストと完了条件

`test_130_linear_regression.py`、API共通試験、FE linear-regression.test.tsxを追加。検証順はOLS点推定→classic→HC3→frequency展開→カテゴリ/交互作用→survey→予測→FE/保存。準備したfixtureで、factor列/row順変更と符号ではなく係数codingを一致させて比較する。

surveyは少なくとも2層×各3PSU、PSU内複数行の手計算fixture、scopeが1PSUを除くdomain解析、certainty singleton、非certainty singleton、FPCあり/なし、PSU番号が層間重複するcaseを置く。現行のsurvey helperが違う値を出した場合はその値へ新期待値を合わせず数式と原典から原因を確認する。

## 一次資料との対応

[S-HC3](../references/PRIMARY_SOURCES.md#s-hc3)、[S-WLS](../references/PRIMARY_SOURCES.md#s-wls)、[S-LSTSQ](../references/PRIMARY_SOURCES.md#s-lstsq)、[S-SURVEY](../references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。
