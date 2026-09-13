# DAVIS-FEAT-030：MCA 実装詳細化設計書

版1.0／対応仕様：[Feature 030](../feature/30_multiple_correspondence_analysis.md)。既存tasks/DAVIS-FEAT-027-028.mdの§2.5〜2.7を置き換える。

## 1. ソース構成・優先事項

新規`backend/app/algorithms/models/mca.py`、`api/mca.py`、`frontend/src/features/models/MultipleCorrespondencePage.tsx`。route `/models/mca`、API `/api/v1/models/mca`。このソースsnapshotではMCAの実装routeは確認できなかったため、新設として設計する。別ブランチに既存MCAがあっても旧nK正規化を温存しない。

共通numerics/encodingとCAの一般計算を再利用するが、MCA固有のm・K・補正慣性・MA親判定を独立にテストする。Burt法への分岐は作らない。

## 2. 入力契約

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"selected","selectedRowIds":["r1","r2","r3"],"weightMode":"dataset","missingPolicy":"exclude"},"variables":["q1","q2","q3"],"maMode":"ordinary_only","inertiaAdjustment":"raw"}
```

variablesはcolumnIdの重複なし配列、長さ>=2。input列にbinaryという存在しないscale enumを要求しない。通常2水準のnominalが二値変数である。maMode explicit_binary_optionsでMA子を含める場合はgroupId→全member dependenciesを解決し、採用columnsはvariablesに明示した子のみ。親全体の判定がvalid以外ならその親に由来する採用子全てを欠損/不正状態にする。MAのpartialは通常のmissingとして扱うがinvalidはinvalidのまま、notApplicableはその理由を保つ。共通missingPolicyがそれをカテゴリ化できる。

逆転ordinalはカテゴリの同一性を変えない。表示順の逆転をコードブック規約通り行ってよいが数値距離は同じ。使用変数ごとの観測正質量カテゴリ数K_j>=2を要求する。

## 3. 正規化の正本

nは正の重みをもつ有効物理行数、mは変数数、K=ΣK_j、Zはn×K完全指示行列。各行の和mをassertする。w_i>0、a_i=w_i/Σw、p_k=Σ_i a_i Z_ik、c_k=p_k/m。

```
P_ik = a_i Z_ik / m
r_i = a_i
S_ik = sqrt(a_i) (Z_ik - p_k) / sqrt(m p_k)
S = U diag(s) V'
lambda = s^2
F_il = U_il s_l / sqrt(a_i)
G_kl = V_kl s_l / sqrt(c_k)
Gamma_kl = V_kl / sqrt(c_k)
```

非加重ではP=Z/(nm)である。旧仕様のQ=KによるZ/(nK)を禁止する。ΣP=1、Σr=Σc=1、Σ_k p_k=m、変数jのΣ_{k∈j}p_k=1を検査する。

行列はscipy sparse CSRで構築してよいが、中心化後のSは一般にdenseになる。密行列のexact SVDを正本とし、疎行列近似に黙って変えない。行列サイズを理由に先頭行だけを計算しない。np.bincountでカテゴリmassを求め、重みを二重に掛けない。

全慣性=||S||²_F=(K−m)/m。これは全変数が完全指示で各使用カテゴリのp>0である場合の値で、未観測カテゴリをKへ数えない。数値rank<=min(n−1,K−m)。行数だけでなく回答パターンによるrank低下を許す。

## 4. 寄与・cos2・軸補正

個体寄与=a_i F_il²/lambda_l、カテゴリ寄与=c_k G_kl²/lambda_l。個体全次元距離²=Σ_k (Z_ik/m−c_k)²/c_k。カテゴリ距離²=(1−p_k)/p_k。cos2はF²/G²を各距離²で割る。全軸について個体平均0、カテゴリ主座標の質量加重平均0、axisごとの寄与和1を検査する。

rawRatio=lambda/totalInertia。Benzécriを選択すると、全固有値について`adjustedLambda_l=(m/(m−1))² max(lambda_l−1/m,0)²`、`adjustedRatio=adjustedLambda/Σ_all adjustedLambda`。閾値と同じ固有値は0。分母0は比率配列の各値をnull、reason=NO_EIGENVALUE_ABOVE_BENZECRI_THRESHOLD。raw座標、raw寄与、raw cos2は一切変えない。

カテゴリ点による符号規則はGの最大絶対成分正。縮退ブロックは共通規約通り。カテゴリー座標のscatterを「個人間距離」と説明しない。カテゴリpが小さければ距離が大きくなりやすいことを警告するが、自動でカットしない。

## 5. 結果・永続化

summary={nVariables:m,nCategories:K,rank,totalInertia,eigenvalues,rawInertiaRatio,rawCumulativeInertiaRatio,inertiaAdjustment,adjustedEigenvalues,adjustedInertiaRatio,degenerateBlocks}。raw時のadjusted配列はnull。details.categoriesはcategoryId/variableId/code/kind/label/physicalCount/categoryProbability:p/categoryMass:c/principalCoordinates/standardCoordinates/contributions/cos2。未観測の宣言カテゴリはomittedCategoriesに理由zero_massとして残す。

row結果はrowId、coordinates、contributions、cos2、mass:a。rowStorage全軸、model.npzにp,c,V,sとfit encodingを保存する。選択・射影・保存のcapabilitiesをtrueとする。新規rowへは次式で主座標を計算する。

`F_new = (z_new/m − c)' diag(c)^(-1/2) V`（row-vector表記では`(z/m-c) @ (V/sqrt(c)[:,None])`）。ここで新規rowの重みで点の座標を動かさない。学習済みmとカテゴリ順を固定する。学習rowで射影と保存Fがrtol1e-9で一致することを検査する。

## 6. MA境界の具体例

親QMAにA,B,Cの3子があり、採用はA,BだけでもCを読みvalid判定に使用する。行(1,0,9)が親宣言のselected={1},unselected={0}ならinvalid。A=1,B=0だけを使って成功させない。行(0,0,0)の意味はallUnselectedMeaningに従う。validならA非選択/B非選択の2カテゴリとして使う。missingならmissingPolicyで両変数の欠損カテゴリへ写像し、その実行はm=採用変数数に含む。すべてmissingの変数が1水準しか持たなければconstantとして拒否する。

選択された子数を親ごとにmaDiagnosticsへ返す。MAを一つの通常カテゴリ変数にするため選択組合せを連結するモード、選択数に応じて各rowを複製するモードは本版に存在しない。

## 7. FE実装

個体図とカテゴリ図を分け、個体図はL1色、カテゴリ図は変数ごとの色。1変数のカテゴリを点shapeではなく変数凡例で区別する。カテゴリ表をクリックして選択する場合は変数間AND/ORを設定し、その条件をselection labelにする。表と図のaxis IDは1始まりで統一する。

Benzécri表示はスクリープロットにraw/adjustedの2系列を明示、軸ラベルはデフォルトraw。切替は結果JSONの別系列を読むだけで実行ボタンを押さない。n<30、稀少カテゴリ、MAブロック重みの注意を別コードで表示する。

座標materializeでsourceField=coordinate:lを選び、name既定MCA1等。rankを超えたfieldを拒否する。カテゴリ負荷や座標を個体列へ自動転記しない。

## 8. エラー・テスト・完了条件

MCA_CATEGORY_REQUIRED、MCA_TOO_FEW_VARIABLES、MCA_CONSTANT_VARIABLE、MCA_MA_UNSUPPORTED、MCA_ZERO_INERTIA、MCA_INVALID_INDICATOR。通常入力不備422、indicator row sum不変条件の破れは500として実装バグを検出。

`test_110_mca.py`に少なくとも、3変数・2/3/4カテゴリ(m≠K)、同一変数複製、カテゴリー改名、row permutation、frequency整数複製、survey×100、zero weight、MA親invalid、missing3種、Benzécri全0、projection、重複固有値を置く。

FactoMineR MCAのmethod=Indicatorとのoracle比較では欠損処理、row.w、カテゴリ順、raw固有値を合わせる。Burtの固有値はindicatorと同じではないためoracleに混ぜない。Feature27旧試験のnK・selected rowIds・isExplorative=false・MA無視の期待値は本仕様に更新し、PCP関連試験は削除しない。

## 一次資料との対応

[S-MCA](../references/PRIMARY_SOURCES.md#s-mca)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。
