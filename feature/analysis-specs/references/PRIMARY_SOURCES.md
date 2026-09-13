# 一次資料・採用根拠

033b EFA／033c CFAの根拠は[拡張一次資料](FACTOR_EXTENSIONS_SOURCES.md)に追加する。新しい順序経路・推論の設計は各個別仕様を参照する。

確認日：2026-09-12。書誌情報と公開一次資料を参照し、引用は各URLにつき最小限に留めた。出力数式は本設計の定義と独立参照計算に基づく。閾値・API・機能範囲・エラーポリシーは製品として採用した規約であり、原典で唯一許容される方法だという主張ではない。

URLのmaster/stableは将来更新される。製品のoracle fixtureを更新する際は取得commit・実行パッケージ版・入力hashを併記し、Webの現在版を過去の検証版と取り違えない。原典全文・ライブラリコードは配布ZIPに含めない。

<a id="s-ca"></a>

## S-CA：通常CA：原著による実装・表示規約

参照先：`https://www.jstatsoft.org/article/view/v020i03`

原文の最小引用：`different scaling options for biplots`

確認・採用：CAとMCAが同じ名前の図ではなく、質量・寄与・表示スケーリングを区別する原著。本文のSVD式は定義から独立導出し、2×2解析解・転置不変性で検証した。

差異・範囲：supplementary点や3D等をすべて実装するという約束ではない。

<a id="s-mca"></a>

## S-MCA：FactoMineR MCA：指示行列方式と補正慣性

参照先：`https://raw.githubusercontent.com/cran/FactoMineR/master/R/MCA.R`

原文の最小引用：`method="Indicator"`

確認・採用：完全指示行列方式を比較対象にする。設問数に依存する補正慣性を確認。

差異・範囲：Burt法・自動ventilation・原典既定の欠損処理は採用しない。境界で全補正固有値0となる場合を明示した。

<a id="s-famd"></a>

## S-FAMD：FactoMineR FAMD：混合行列の正規化

参照先：`https://raw.githubusercontent.com/cran/FactoMineR/master/R/FAMD.R`

原文の最小引用：`QualiAct <- t(t(QualiAct)/sqrt(prop))`

確認・採用：数値の加重標準化、カテゴリ指示列のsqrt(p)正規化、カテゴリ重心・寄与の規約を比較した。

差異・範囲：暗黙の平均補完は採用しない。sqrt(p(1−p))標準化やMCAのsqrt(m)は混入させない。UIでは個体空間と相関円を区別する。

<a id="s-hc3"></a>

## S-HC3：Statsmodels HC3 標準誤差

参照先：`https://www.statsmodels.org/stable/generated/statsmodels.regression.linear_model.OLSResults.HC3_se.html`

原文の最小引用：`heteroskedasticity robust standard errors.`

確認・採用：非加重HC3の外部参照先。実行検証では別途インストール済みStatsmodels 0.14.6をoracleに用いた。

差異・範囲：公開stableドキュメントの版と検証環境の版は同一ではない。frequencyは非加重データを実際に複製したoracleとの一致を定義とした。

<a id="s-wls"></a>

## S-WLS：Statsmodels WLS：重みの意味

参照先：`https://www.statsmodels.org/stable/generated/statsmodels.regression.linear_model.WLS.html`

原文の最小引用：`The weights are presumed to be (proportional to) the inverse of the variance of the observations.`

確認・採用：WLSの精度重みと調査ウェイトが異なることを確認した。

差異・範囲：survey重みをWLSに渡しただけの標準誤差を流用しない。frequency/精度/surveyを混同しない。

<a id="s-survey"></a>

## S-SURVEY：R survey：PSU集約・領域推定・FPC

参照先：`https://raw.githubusercontent.com/cran/survey/master/R/survey.R`

原文の最小引用：`First collapse over PSUs`

確認・採用：PSU単位集約、領域外の0スコア、層内分散、FPC・singletonの処理経路を確認した。

差異・範囲：本版は一段Taylor設計に限定。singletonを無警告0扱いにせず、certaintyの根拠がない場合は推測不能。R survey全機能を再実装する設計ではない。

<a id="s-fa"></a>

## S-FA：R stats factanal：最尤因子分析

参照先：`https://www.stat.ethz.ch/R-manual/R-patched/library/stats/html/factanal.html`

原文の最小引用：`Perform maximum-likelihood factor analysis`

確認・採用：正規共通因子モデル、uniqueness最適化、下限0.005、回転・得点、境界解への注意を確認した。

差異・範囲：初期値5組・seed・失敗条件は本製品の確定設定。調査ウェイトの疑似最尤推定は本版では対象外。

<a id="s-fa-src"></a>

## S-FA-SRC：R factanal 実装：得点・適合度計算

参照先：`https://raw.githubusercontent.com/wch/r-source/trunk/src/library/stats/R/factanal.R`

原文の最小引用：`sc <- zz %*% solve(cv, Lambda)`

確認・採用：regression得点は標本相関を使う規約、回転後の因子相関、最尤適合度の補正を確認した。

差異・範囲：コードを逐語移植しない。標本相関と再現相関は別に保存し、得点の規約を変えない。

<a id="s-rot"></a>

## S-ROT：R stats：Varimax/Promax

参照先：`https://stat.ethz.ch/R-manual/R-devel/library/stats/html/varimax.html`

原文の最小引用：`Rotation Methods for Factor Analysis`

確認・採用：回転方式の比較先。無回転・直交・斜交の出力と因子相関の区別を設計した。

差異・範囲：Promaxの非加算的な負荷二乗和を、直交と同じ累積寄与率として表示しない。

<a id="s-clogit"></a>

## S-CLOGIT：Statsmodels ConditionalLogit

参照先：`https://www.statsmodels.org/stable/generated/statsmodels.discrete.conditional_models.ConditionalLogit.html`

原文の最小引用：`Do not include an intercept in this array.`

確認・採用：グループ化された0/1選択データの条件付き尤度と、共通切片を除く識別性を確認した。

差異・範囲：1選択/集合の場合を選択型oracleに使用。回答者クラスター補正・frequencyブロック複製・完全順位stage化・分離LPは本設計で別途定義・検証した。

<a id="s-svd"></a>

## S-SVD：SciPy exact SVD

参照先：`https://docs.scipy.org/doc/scipy/reference/generated/scipy.linalg.svd.html`

原文の最小引用：`The singular values, sorted in non-increasing order.`

確認・採用：薄型SVD、gesdd/gesvd、降順特異値を使う数値接続先。

差異・範囲：近似ランダムSVDへの暗黙fallbackは設けない。符号・縮退空間は不定であるため不変量を比較する。

<a id="s-lstsq"></a>

## S-LSTSQ：SciPy rank-aware least squares

参照先：`https://docs.scipy.org/doc/scipy/reference/generated/scipy.linalg.lstsq.html`

原文の最小引用：`Compute least-squares solution to the equation`

確認・採用：SVDベースの最小二乗とrank判定の実装接続先。

差異・範囲：rank欠損を最小ノルム解で黙って成功させず、モデル仕様の識別不能として返す。

## 参照できなかった経路と代替

一部のsurveyドキュメントとFAMD参照URLは通常取得・r.jina.ai経由の再試行でも利用できなかった。その本文を根拠にしたとは扱わず、上記の公式/CRANソースとR公式マニュアルを確認できた経路として採用した。R本体・FactoMineRの実行照合はこの成果物作成時には行っていない。
