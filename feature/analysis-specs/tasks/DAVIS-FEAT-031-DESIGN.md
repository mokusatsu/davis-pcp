# DAVIS-FEAT-031：FAMD 実装詳細化設計書

版1.0／対応仕様：[Feature 031](../feature/31_famd.md)／原典：FactoMineR FAMD実装を規約の比較先とする。ソースの逐語移植ではなく、以下の数式を独立実装する。

## 1. ファイル・API

新規`backend/app/algorithms/models/famd.py`、`api/famd.py`、`frontend/src/features/models/FamdPage.tsx`。route `/models/famd`、POST `/api/v1/models/famd`。

```json
{"context":{"datasetId":"survey-demo","expectedDataRevision":1,"expectedSchemaRevision":1,"scope":"all","weightMode":"dataset","missingPolicy":"exclude"},"numericVariables":["age","satisfaction"],"categoricalVariables":["region","brand"]}
```

各配列長>=1、相互重複なし。MA列とordinal数値扱いは拒否し、前段の明示派生列化を案内する。全列の有効行を同一maskで確定後に標準化する。変数ごとに別nや別平均を使わない。

## 2. 行列構築

有効row数n、正規化重みa、数値列数p、カテゴリ変数数m、各水準数K_j>=2、K=ΣK_jとする。

数値変数x_jについてμ_j=Σa_i x_ij、σ²_j=Σa_i(x_ij−μ_j)²、Z_ij=(x_ij−μ_j)/σ_j。σ²<=0はFAMD_CONSTANT_VARIABLE。平均の大きさに依存した不安定な`E[x²]−E[x]²`ではなく中心化した二段階の分散を使う。

カテゴリ指示行列Gについてp_k=Σa_i G_ik、B_ik=(G_ik−p_k)/sqrt(p_k)。各変数のカテゴリ確率和は1。質量0の宣言カテゴリは行列から外しカタログだけ保持する。二値指示列の標準偏差sqrt(p_k(1−p_k))で割らない。MCAのsqrt(m)をここへ持ち込まない。

```
X = [ Z | B ]              # n×(p+K)
A = diag(sqrt(a)) X
A = U diag(s) V'
lambda = s^2
F = X V = diag(a)^(-1/2) U diag(s)
```

全慣性=Σ_j Σ_i a_i Z_ij²+Σ_kΣ_i a_i B_ik²=p+Σ_j(K_j−1)。rank<=min(n−1,p+K−m)。MCA全慣性(K−m)/mとは異なる。exact薄型SVD、共通rankTol、縮退取り扱いを使用する。

## 3. 個体・数値変数・カテゴリの意味

### 3.1 個体

coordinates=F、distanceSquared_i=||X_i||²、contribution_i,l=a_i F_il²/lambda_l、cos2_i,l=F_il²/distanceSquared_i。Σa_iF_il=0、Σa_iF_il²=lambda_l。

### 3.2 数値変数

numericCoordinate_j,l=cor_w(x_j,F_l)=V_j,l sqrt(lambda_l)。表示名correlations。contribution_j,l=V_j,l²。cos2はcorrelation²（標準化変数の長さ1）。元スケールの回帰係数や独立した因子負荷と混同しない。

### 3.3 カテゴリ

表示座標は個体の重心である。

```
barycenter_k,l = sum_i a_i G_ik F_il / p_k
               = lambda_l V_(p+k),l / sqrt(p_k)
categoryContribution_k,l = V_(p+k),l^2
```

`p*barycenter²/lambda`を寄与とするのは誤り。今回のFAMD規約では`p*barycenter²/lambda²=V²`が対応する。CAの式をそのまま流用しない。

カテゴリcos2は`barycenter_k,l² / ||b_k||²`、`b_k=Σ_i a_i G_ik X_i/p_k`を全標準化特徴空間で計算した重心。分母を表示2軸だけの重心距離にしない。分母0ならnull。

### 3.4 元変数単位

数値変数のrelationStrength=correlation²。カテゴリ変数jのrelationStrength=η²_j,l=Σ_{k∈j}p_k barycenter_k,l²/lambda_l。変数のcontributionは数値V²、カテゴリはΣ_{k∈j}V_(p+k),l²。axisごとに全元変数contributionの和=1。relationStrengthの変数間和は1になる必要がなく、寄与率として出力しない。

## 4. 結果契約

summary={rank,totalInertia,eigenvalues,inertiaRatio,cumulativeInertiaRatio,nNumericVariables,nCategoricalVariables,nCategories,degenerateBlocks}。

details.numericVariables=[{variableId,label,mean,scale,correlations,contributions,cos2}]。

details.categoricalVariables=[{variableId,label,categoryIds,relationStrength,contributions}]。

details.categories=[{categoryId,variableId,code,kind,label,probability,physicalCount,barycenterCoordinates,contributions,cos2,distanceSquared}]。coordinateConvention='weighted_individual_barycenter'を全体に記載。details.omittedCategoriesも保持する。

row結果はrowId,coordinates,contributions,cos2,mass。model.npzにμ,σ,p,V、encoded列順を保存する。categoricalVariablesのprobabilityは変数ごとに合計1であり、MCAのcategoryMass=p/mとは違う。名前をmassに省略して混同させない。

## 5. 学習済み射影

新規x_new,g_newに対しz_new=(x_new−μ_fit)/σ_fit、b_new=(g_new−p_fit)/sqrt(p_fit)、f_new=[z_new,b_new]V_fit。予測対象の平均やカテゴリ比率を計算し直さない。新規行重みは座標を変えない。学習時未観測カテゴリ/unknownは変換不能。欠損方針で追加したmissingカテゴリが学習時に存在しなければ、予測時の欠損は未知カテゴリと同じ未計算になる。

数値の外挿は学習min/maxに対して警告を返すが、有限値なら射影可能。fit行を再射影した座標の一致をテストする。予測行のcontributionは学習軸の慣性を説明する量ではないため返さずnullとする。cos2は同じX空間の距離で表示可能。

## 6. FE詳細

3つの図を同じFactorMapの異なるvariantで実装する。individualsはF、categoriesは重心、numeric_correlationsは相関円。個体とカテゴリを重ねる場合はどちらもF座標系なので重心関係を説明できるが、数値相関円を同じスケールに重ねない。

`variable_relation`タブはrelationStrengthで軸別に[0,1]に配置し、数値はr²、カテゴリはη²とtooltipに明記。contributionランキングは別タブ/別列。カテゴリを選択したら当該カテゴリを持つfit行のIDを解決する。図の色を変数色/L1色で切り替えても学習をやり直さない。

保存列はcoordinate:1等の個体座標だけ。correlationやカテゴリ重心を全回答者へ貼り付けない。min(2,rank)初期軸とrank1 fallbackを共通実装から使用する。

## 7. エラー・受入

FAMD_MIXED_INPUT_REQUIRED、FAMD_SCALE_INVALID、FAMD_MA_UNSUPPORTED、FAMD_CONSTANT_VARIABLE、FAMD_ZERO_INERTIA、FAMD_UNKNOWN_CATEGORY。データ依存422、未知カテゴリ予測だけrow statusとする。

`test_120_famd.py`に、カテゴリ比率不均等の3水準＋数値2列を使う正規化fixture、数値の+1000/×100、カテゴリの水準順逆転、数値符号反転、重み×100、frequency展開、共通mask、予測再現、η²恒等式、寄与合計、重心の直接平均比較を実装する。

FactoMineR FAMDとのoracle比較はrow.w、scale=加重ddof0、カテゴリmissingなし、同じ行/列順で行う。R側の既定欠損補完と本版listwiseは違うため、欠損ありデータを前処理の違いを無視して比較しない。慣性比とカテゴリ重心は同じ規約を確認してから照合する。

## 一次資料との対応

[S-FAMD](../references/PRIMARY_SOURCES.md#s-famd)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。
