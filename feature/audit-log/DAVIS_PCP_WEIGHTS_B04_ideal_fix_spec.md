# DAVIS-PCP 調査ウェイト対応の理想修正方針
## WEIGHT-04 / B04：調査ウェイトの倍率で p 値が変化する問題

作成日: 2026-09-11  
対象: DAVIS-PCP のクロス集計・調査ウェイト・推測統計  
優先度: 最優先  
推奨方針: 「survey は既定で推測統計を非表示」＋「明示時は Rao–Scott 第2次補正」  
対象外: 時系列分析

---

# 1. 結論

WEIGHT-04 / B04 は、単純にウェイトを実効サンプルサイズへ正規化して Pearson χ² 検定を継続するだけでは、正式な修正としない。

DAVIS-PCP の最終仕様は次とする。

1. ウェイトの意味を `survey` と `frequency` に明確に分離する。
2. `frequency` は「同一観測の件数」を表すため、生の加重度数を Pearson χ² に使用できる。
3. `survey` は「母集団代表性を調整する調査ウェイト」とし、生の加重度数を通常の Pearson χ² に入れない。
4. `survey` 適用時は、加重度数・加重百分率・記述的な加重 Cramér's V は常時表示してよい。
5. `survey` 適用時の推測統計は既定で非表示とする。
6. 利用者が「調査設計を考慮した検定を表示」を明示的に選んだ場合のみ、Rao–Scott 第2次補正を実行する。
7. 層化・PSU 等の調査設計情報がある場合はそれを使用する。
8. 最終ウェイトしか存在しない場合は「各回答者を独立 PSU と仮定した近似」として Rao–Scott を実行し、その仮定を結果に明示する。
9. `survey` 時のセル別の有意マーカー（★等）は、設計ベースのセル別検定を実装するまで表示しない。
10. Kish の実効サンプルサイズは検定統計量の代用品ではなく、ウェイト診断値として表示する。

要するに、次のように分離する。

```text
                         ┌─ none ──────── 通常 Pearson χ²
weight ──────────────────┼─ frequency ─── 生の頻度で Pearson χ²
                         │
                         └─ survey ────── 記述統計は常時表示
                                          │
                                          ├─ inference=off
                                          │      → p 値を出さない（既定）
                                          │
                                          └─ inference=rao_scott
                                                 → Rao–Scott 第2次補正
```

---

# 2. 現行実装の問題

現行の `app/algorithms/summaries/crosstab.py` では、ウェイトを使用すると概ね次の処理になっている。

```python
chi2_stat, p_value, _, _ = stats.chi2_contingency(
    np.where(use_weights, counts, unweighted.astype(float)),
    correction=False,
)
```

ここで `counts` はウェイトを加算した加重度数である。

そのため、すべてのウェイトを 100 倍すると加重度数も 100 倍になり、Pearson χ² もほぼ 100 倍になる。

一方、これは同じ回答者に対する同じ調査ウェイトを単に倍率変換しただけであり、情報量が 100 倍になったわけではない。

したがって、

```text
w
```

と

```text
100 × w
```

で p 値が変化する現在の挙動は、`survey` ウェイトとしては不正である。

現行コード自身も、

```text
WEIGHTED_INFERENCE_APPROXIMATION
```

として「設計効果は推定しない」と警告しているが、警告だけでは不十分である。誤った p 値や有意マーカーを通常の分析結果として返しているためである。

---

# 3. なぜ「実効 N へ正規化して Pearson χ²」だけでは不足するか

例えば Kish の実効サンプルサイズを

\[
n_{\mathrm{eff}}
=
\frac{(\sum_i w_i)^2}{\sum_i w_i^2}
\]

とし、

\[
w_i^{*}
=
w_i
\frac{n_{\mathrm{eff}}}{\sum_i w_i}
\]

のように正規化すれば、`w` と `100w` の倍率差は消せる。

これは WEIGHT-04 の「倍率依存性」だけを除去する手段としては成立する。

しかし、クロス集計の推測統計としては不十分である。

理由は、Kish ESS がウェイト全体を単一のスカラーへ要約する一方、クロス集計の独立性検定に必要なのはセル比率の分散・共分散だからである。

同じウェイト列でも、

```text
年代 × 満足度
```

と

```text
地域 × 購入意向
```

では、ウェイトとセル所属の関係が異なる。

したがって「どの表でも同じ ESS 比率だけ Pearson χ² を弱める」方法は、倍率不変ではあっても、調査設計を反映した検定にはならない。

ESS 正規化 Pearson は以下に限定する。

- 開発中の比較用ベースライン
- デバッグ用
- Rao–Scott 実装との比較
- ユーザー向け正式結果には使用しない

API の正式な `inferenceMethod` としても公開しない。

---

# 4. 統計的な目標

## 4.1 `frequency` と `survey` の意味を分離する

### frequency weight

1 行が複数件の同一観測を代表する。

例:

```text
sex=male, satisfaction=yes, weight=12
sex=male, satisfaction=no,  weight=3
```

これは実際に 12 件、3 件存在した圧縮表現である。

この場合、重みを 100 倍することは「観測件数を 100 倍した」ことになるので、p 値が変わってよい。

### survey weight

1 行は 1 回答者であり、ウェイトは母集団代表性を補正する係数である。

例:

```text
respondent_001, weight=0.72
respondent_002, weight=1.38
respondent_003, weight=2.11
```

この場合、ウェイトの全体倍率は任意である。

`w`、`100w`、`w / mean(w)` は同じ推定比率を表し、推測結果も倍率に依存してはならない。

---

# 5. データモデル

## 5.1 `role=weight` だけでは不足

現在はコードブックの

```text
role=weight
```

でウェイト列を識別している。

これに「何のウェイトか」を追加する。

推奨するデータセットレベルの仕様は次。

```json
{
  "weightConfig": {
    "weightColumnId": "col_weight",
    "weightType": "survey"
  }
}
```

`weightType`:

```typescript
type WeightType =
  | "survey"
  | "frequency";
```

ウェイト未使用は `weightConfig = null` で表現し、`weightType="none"` を永続化しなくてよい。

理由は「列の意味」と「今回ウェイトを使うか」は別だからである。

---

## 5.2 調査設計を独立したオブジェクトにする

将来の拡張を考え、調査設計をウェイト列自身の属性に埋め込まない。

```json
{
  "surveyDesign": {
    "weightColumnId": "col_weight",
    "strataColumnId": "col_stratum",
    "psuColumnId": "col_psu",
    "fpcColumnId": null,
    "replicateWeightColumnIds": []
  }
}
```

初期実装では以下だけでもよい。

```json
{
  "surveyDesign": {
    "weightColumnId": "col_weight",
    "strataColumnId": null,
    "psuColumnId": null
  }
}
```

ただし API と保存形式は後から破壊的変更をしなくて済むよう、最初からオブジェクト化する。

---

# 6. ウェイト値の検証

これは B04 だけでなく B03 の修正にも共通する。

## 6.1 survey

許可:

- 正の有限実数
- 0 は許可してよいが、分析対象の情報量には寄与しない
- 任意倍率

禁止:

- 負値
- ±Infinity
- NaN
- 数値変換不能
- コードブック上の欠損コード
- 非該当コード

欠損コード `99` 等は「99 というウェイト」ではなく欠損として扱う。

現在の `extract_weights()` は物理 null を中心に扱っているため、`CodebookAdapter` と同じ意味的欠損処理を通す。

---

## 6.2 frequency

frequency は件数なので、原則として非負整数を要求する。

許可:

```text
0, 1, 2, 3, ...
```

禁止:

```text
-1
1.3
NaN
Infinity
```

浮動小数型で読み込まれていても、

```python
abs(w - round(w)) <= tolerance
```

なら整数として受け入れてよい。

これにより、

```text
survey weight を誤って frequency として指定
```

する事故もある程度検出できる。

---

# 7. クロス集計計算を 3 層へ分割する

現在の `compute_crosstab()` に処理を集中させない。

理想構成:

```text
crosstab/
    prepare.py
    descriptive.py
    association.py
    inference_unweighted.py
    inference_frequency.py
    inference_survey.py
    diagnostics.py
```

または既存構成を保つ場合でも、少なくとも関数単位で分ける。

```python
prepared = prepare_crosstab_input(...)
table = compute_descriptive_table(prepared)

association = compute_descriptive_association(table)

if weight_type == "survey":
    inference = compute_survey_inference(...)
elif weight_type == "frequency":
    inference = compute_frequency_inference(...)
else:
    inference = compute_unweighted_inference(...)
```

重要なのは、

```text
表を作る処理
関連の強さを記述する処理
仮説検定する処理
```

を別物にすること。

---

# 8. 記述統計

## 8.1 survey でも常時表示してよいもの

- 非加重回答者数
- 加重度数
- 行百分率
- 列百分率
- 全体百分率
- ウェイト合計
- Kish ESS
- ウェイト CV
- Kish weighting DEFF
- 記述的な加重 Cramér's V

---

## 8.2 `weightedN` という名称を廃止する

現在はウェイト合計を `weightedN` として返している。

survey weight ではウェイト合計は、

- 母集団総数相当
- 1 に正規化された合計
- 標本数に正規化された合計

など、ウェイトのスケーリング次第で意味が変わる。

したがって `N` と呼ばない。

推奨:

```json
{
  "unweightedN": 1243,
  "weightSum": 83412.72,
  "kishEffectiveN": 921.4,
  "weightCv": 0.591,
  "weightingDeff": 1.349
}
```

---

# 9. 加重 Cramér's V

survey 時にも関連の記述量は必要である。

加重クロス表から通常の Pearson 型統計量

\[
X_w^2
=
\sum_{ij}
\frac{(O_{ij}-E_{ij})^2}{E_{ij}}
\]

を計算し、

\[
V_w
=
\sqrt{
\frac{X_w^2}
{W \min(r-1,c-1)}
}
\]

とする。

ここで `W = Σw`。

この量はウェイトを一律に `c` 倍しても、

```text
X² → c X²
W  → c W
```

なので値が変わらない。

ただし、これは Rao–Scott 補正後の統計量から求めない。

明確に次を分ける。

```text
descriptiveAssociation.weightedCramersV
```

と

```text
inference.statistic
```

名称も単に `cramersV` ではなく、

```text
weightedCramersV
```

を推奨する。

UI では、

```text
関連の強さ：加重 Cramér's V = 0.23
```

と表示する。

「調査設計補正済み Cramér's V」などとは表示しない。

---

# 10. survey 時の推測統計の既定動作

既定:

```text
surveyInference = off
```

したがって、

```json
{
  "inference": {
    "requested": false,
    "status": "not_requested",
    "method": null,
    "pValue": null
  }
}
```

を返す。

UI は、

```text
統計的検定
調査ウェイトを使用しているため、検定は既定で表示していません。

[調査設計を考慮した検定を表示]
```

とする。

「検定できない」と表示するのではなく、

```text
EDA では記述量を優先し、推測統計は明示要求時のみ実行する
```

という設計にする。

---

# 11. survey 時の推測統計：Rao–Scott 第2次補正

## 11.1 採用方式

正式方式:

```text
Rao–Scott second-order correction
+ Satterthwaite approximation
```

R `survey::svychisq()` の既定動作を参照実装とする。

R `survey` のドキュメントは次のように明記している。

> `svychisq computes first and second-order Rao-Scott corrections`

また既定方式について、

> `The default ... is the Rao-Scott second-order correction.`

としている。

参照:
https://r-survey.r-forge.r-project.org/pkgdown/docs/reference/svychisq.html

---

## 11.2 なぜ第1次ではなく第2次か

第1次 Rao–Scott は主として Pearson χ² の平均を補正する。

第2次は分散側も考慮し、Satterthwaite 近似によって F 型の参照分布を使う。

R `survey` の資料にも、

> `second order ... corrects the variance as well`

とある。

参照:
https://r-survey.r-forge.r-project.org/survey/survey-wss.pdf

DAVIS-PCP はアンケート EDA を主眼とするため、独自の簡易補正より、既存の survey methodology に寄せた実装を採用する。

---

# 12. Rao–Scott エンジンの実装方針

## 12.1 独自の「簡易式」を直接 UI へ出さない

Rao–Scott はセル比率の共分散行列と単純無作為抽出時の共分散を比較する処理を含む。

ここを「ESS で χ² を割る」等の独自近似に置き換えない。

新規モジュールを用意する。

```text
app/algorithms/survey/
    design.py
    covariance.py
    rao_scott.py
    diagnostics.py
```

---

## 12.2 入力

概念的には以下。

```python
compute_rao_scott(
    row_codes,
    col_codes,
    weights,
    strata=None,
    psu=None,
    method="second_order",
)
```

---

## 12.3 共通前処理

1. 対象 scope を確定する。
2. 行変数・列変数の意味的欠損を処理する。
3. ウェイトの意味的欠損を処理する。
4. `weight <= 0` の扱いを確定する。
5. 未出現カテゴリは表示用表には残してよい。
6. 推測用行列ではゼロ周辺カテゴリを除く。
7. 有効な `r × c` 表を確定する。
8. 推測用表が 2 次元で成立しなければ検定を返さない。

B06 の「未出現カテゴリを追加しただけで検定が消える」問題もこの段階で同時に防止する。

---

## 12.4 調査設計情報がある場合

`strataColumn` と `psuColumn` が指定されている場合は、それをそのまま使用する。

設計自由度を概ね、

```text
number of PSUs - number of strata
```

に基づいて管理する。

ただし実際の自由度計算は Rao–Scott モジュールの責務とし、UI コードへ埋め込まない。

---

## 12.5 最終ウェイトしかない場合

ウェイトしか指定されていない場合、元の標本設計を復元することはできない。

この場合だけ、明示的に

```text
designAssumption = independent_rows
```

とする。

概念的には、

```text
1 回答者 = 1 PSU
strata = 1
```

として線形化分散を計算する。

この結果は、

```text
Rao–Scott（独立回答者近似）
```

と表示する。

UI 警告:

```text
調査ウェイトは考慮していますが、
層化・クラスタ抽出等の標本設計情報は指定されていません。
各回答者を独立した一次抽出単位として近似しています。
```

この仮定は API にも残す。

```json
{
  "designAssumption": "independent_rows"
}
```

---

# 13. 推測統計レスポンス

現行の

```json
{
  "chi2": 10.0,
  "df": 1,
  "pValue": 0.0015
}
```

だけでは Rao–Scott を表現できない。

次のようにする。

```json
{
  "inference": {
    "requested": true,
    "status": "ok",
    "method": "rao_scott_second_order",
    "statisticType": "F",
    "statistic": 4.4639,
    "numeratorDf": 1.4197,
    "denominatorDf": 19.8762,
    "pValue": 0.03577,
    "designAssumption": "provided",
    "approximate": false
  }
}
```

ウェイトだけの場合:

```json
{
  "inference": {
    "requested": true,
    "status": "ok",
    "method": "rao_scott_second_order",
    "statisticType": "F",
    "statistic": 3.82,
    "numeratorDf": 1.0,
    "denominatorDf": 487.0,
    "pValue": 0.0512,
    "designAssumption": "independent_rows",
    "approximate": true
  }
}
```

重要なのは `chi2` を汎用フィールドとして使わないこと。

Rao–Scott 第2次補正では F 型統計量になるため、

```text
statistic
statisticType
numeratorDf
denominatorDf
```

に一般化する。

---

# 14. API リクエスト

推奨:

```typescript
type CrosstabInference =
  | "auto"
  | "none"
  | "pearson"
  | "fisher_exact"
  | "rao_scott";
```

ただし、ユーザーが誤った組合せを指定できないよう、サーバ側で厳密に解決する。

推奨リクエスト:

```json
{
  "context": {
    "datasetId": "...",
    "weightColumn": "survey_weight"
  },
  "rowVariableId": "age",
  "colVariableId": "satisfaction",
  "inference": "auto"
}
```

`auto` の解決規則:

```text
no weight
  → pearson

frequency
  → pearson

survey
  → none
```

survey で UI のボタンを押した場合だけ、

```json
{
  "inference": "rao_scott"
}
```

を送る。

---

# 15. 不正な組合せは 422 にする

例:

```text
weightType=survey + inference=pearson
```

は自動で黙って Rao–Scott に置換しない。

422:

```json
{
  "code": "SURVEY_PEARSON_UNSUPPORTED",
  "message": "調査ウェイトに通常の Pearson χ² 検定は使用できません。Rao–Scott を指定してください。"
}
```

同様に、

```text
frequency + rao_scott
```

も原則として拒否する。

API が曖昧な意味を許容しないことを優先する。

---

# 16. セル別 ASR と「★」の扱い

ここは重要。

現在はセルごとに adjusted standardized residual を計算し、

```text
*
**
***
```

等の significance marker を付けられる構造になっている。

しかし、Rao–Scott の全体独立性検定を導入しても、現在の通常 ASR が自動的に調査設計対応になるわけではない。

したがって survey 時は、

```text
cell.significance = null
```

とする。

当面表示してよいもの:

- 観測加重度数
- 期待加重度数
- 行 %
- 列 %
- 全体 %
- 記述的な残差

ただし残差には「有意」の意味を持たせない。

例:

```json
{
  "residual": 1.82,
  "residualType": "descriptive",
  "significance": null
}
```

将来、セル別の design-based contrast と多重比較補正を実装した場合のみ、セル別有意性を復活させる。

全体 Rao–Scott p 値が 0.01 だからといって、通常 ASR のセルに `**` を付ける設計は禁止する。

---

# 17. 期待度数 5 未満ルール

通常 Pearson χ² の

```text
expected count < 5
```

診断を、そのまま survey の Rao–Scott に適用しない。

survey 時には診断を分ける。

表示候補:

```text
unweightedCellN
weightedCellTotal
numberOfPSUs
designDf
```

警告例:

```text
SURVEY_SMALL_UNWEIGHTED_CELL
SURVEY_LOW_DESIGN_DF
SURVEY_SINGLE_PSU_STRATUM
```

`EXPECTED_COUNT_LT5` は、

- unweighted Pearson
- frequency Pearson

に限定する。

---

# 18. Kish ESS は診断として実装する

Kish ESS:

\[
n_\text{eff}
=
\frac{(\sum w)^2}{\sum w^2}
\]

weighting DEFF:

\[
DEFF_w
=
\frac{n}{n_\text{eff}}
\]

ウェイト CV を用いる場合、

\[
DEFF_w
\approx
1 + CV(w)^2
\]

も診断表示可能。

例:

```text
回答者数               1,243
ウェイト合計          83,412.7
Kish 実効サンプル数      921.4
Weighting DEFF           1.35
Weight CV                0.59
```

これらは、

```text
ウェイトのばらつきがどの程度情報量を減らしているか
```

を見る診断であり、Rao–Scott の代替検定ではない。

---

# 19. UI 設計

## 19.1 ウェイト列設定

単に、

```text
ウェイト列：weight
```

としない。

設定時に意味を明示する。

```text
ウェイトの種類

○ 調査ウェイト
  回答者の母集団代表性を補正するウェイト

○ 頻度ウェイト
  1行が同一観測を複数件代表する件数
```

アンケート分析主体なので、初期候補は `survey` でよい。

ただし既存ファイルを勝手に survey と確定して保存しない。

既存の `role=weight` だけがある場合は、

```text
未分類のウェイト
```

として初回使用時に分類を要求するのが最も安全。

---

## 19.2 クロス集計

survey 時:

```text
クロス集計
─────────────────────────
回答者数                  1,243
加重合計                 83,413
Kish 実効サンプル数         921

関連の強さ
加重 Cramér's V             0.23

統計的検定
調査ウェイトを使用しているため、
推測統計は既定では表示していません。

[調査設計を考慮した検定を表示]
```

検定を表示した後:

```text
Rao–Scott 第2次補正
F = 4.46
df = 1.42, 19.88
p = 0.036

調査設計：
ウェイト あり
層化     あり
PSU      あり
```

ウェイトしかない場合:

```text
Rao–Scott 第2次補正
F = ...
p = ...

近似条件：
各回答者を独立 PSU として扱っています。
層化・クラスタ情報は反映されていません。
```

---

# 20. 現行コードに対する変更点

## 20.1 `app/domain/survey_weight.py`

現在の責務:

- ウェイト列解決
- 数値検証
- 欠損
- status

追加する責務:

```python
resolve_weight_config(...)
validate_weight_semantics(...)
compute_weight_diagnostics(...)
```

追加データ:

```python
WeightType = Literal["survey", "frequency"]
```

survey の意味的欠損コードを CodebookAdapter 経由で除外する。

frequency は整数性を検証する。

---

## 20.2 `app/algorithms/summaries/crosstab.py`

現在の以下を分離する。

```python
stats.chi2_contingency(...)
```

と、

```python
cramers_v = sqrt(chi2_stat / denom_v)
```

を同じ `chi2_stat` に依存させない。

推奨:

```python
descriptive_chi2 = compute_pearson_table_statistic(counts)
weighted_v = compute_cramers_v(descriptive_chi2, weight_sum, ...)
```

その後、

```python
inference_result = ...
```

を別に求める。

survey では `inference_result` に Rao–Scott を使用する。

---

## 20.3 新規 `app/algorithms/survey/rao_scott.py`

公開関数例:

```python
def rao_scott_test(
    row_codes: Sequence[str],
    col_codes: Sequence[str],
    weights: np.ndarray,
    strata: Sequence[str] | None = None,
    psu: Sequence[str] | None = None,
) -> RaoScottResult:
    ...
```

戻り値:

```python
@dataclass
class RaoScottResult:
    statistic: float
    statistic_type: str
    numerator_df: float
    denominator_df: float
    p_value: float
    design_df: float
    design_assumption: str
    approximate: bool
```

---

## 20.4 `app/api/summaries.py`

`CrosstabContext` に設計設定を直接大量に持たせるより、データセット側の `weightConfig/surveyDesign` を参照する。

`CrosstabRequest.inference` は現在、

```text
pearson / fisher_exact
```

だけなので拡張する。

```text
auto / none / pearson / fisher_exact / rao_scott
```

サーバ側で weightType と整合性検証を行う。

---

# 21. キャッシュキー

調査設計を導入するとキャッシュ条件も増える。

最低限、以下を含める。

```text
datasetId
dataRevision
schemaRevision
scopeHash
rowVariableId
colVariableId
missingPolicy
weightColumnId
weightType
surveyDesignRevision
inferenceMethod
```

特に、

```text
同じ weightColumn だが survey / frequency の意味が変わった
```

場合に古い p 値を返してはいけない。

`surveyDesignRevision` を新設するか、schemaRevision に調査設計変更を必ず含める。

---

# 22. provenance / 再現性

結果には、何を使って計算したかを残す。

```json
{
  "analysisProvenance": {
    "weightColumnId": "weight",
    "weightType": "survey",
    "weightSum": 83412.72,
    "kishEffectiveN": 921.4,
    "surveyDesignRevision": 3,
    "inferenceMethod": "rao_scott_second_order",
    "designAssumption": "independent_rows",
    "algorithmVersion": "crosstab-survey-2"
  }
}
```

エクスポート・レポートにも保存する。

「当時どのウェイト意味で解析したか」が後から再現できることを必須とする。

---

# 23. 受け入れテスト

## T01 survey の倍率不変性

同じデータについて、

```text
w
10w
100w
w / mean(w)
```

を使用する。

以下が一致すること。

```text
加重百分率
weightedCramersV
Rao–Scott statistic
df
pValue
KishEffectiveN
```

許容誤差内で完全一致。

`weightSum` のみ倍率に応じて変化してよい。

---

## T02 frequency は倍率で p 値が変化する

frequency weight を

```text
w → 100w
```

とした場合はサンプル件数が 100 倍になった意味なので、Pearson χ² と p 値が変化すること。

これにより survey/frequency の意味が実装上も区別されていることを確認する。

---

## T03 survey の既定値

```text
weightType=survey
inference=auto
```

なら、

```text
pValue = null
method = null
status = not_requested
```

であること。

---

## T04 survey + pearson を拒否

```text
weightType=survey
inference=pearson
```

→ 422。

黙って通常 Pearson を実行しない。

---

## T05 Rao–Scott を明示したときだけ実行

```text
weightType=survey
inference=rao_scott
```

で初めて p 値を返す。

---

## T06 R `survey` との golden test

独自実装の正しさは、手計算だけではなく R `survey` を参照実装にして固定 fixture を作る。

CI に R 自体を入れる必要はない。

開発時に R で以下を生成する。

```r
svychisq(~row + col, design, statistic="F")
```

結果を JSON fixture として保存する。

例:

```json
{
  "statistic": 4.4639,
  "numeratorDf": 1.4197,
  "denominatorDf": 19.8762,
  "pValue": 0.03577
}
```

Python/Pyodide 実装が許容誤差内で一致することを unit test にする。

R `survey` の公開例では Rao–Scott 第2次補正の出力例として、

```text
F = 4.4639
ndf = 1.4197
ddf = 19.8762
p-value = 0.03577
```

が掲載されている。

参照:
https://r-survey.r-forge.r-project.org/pkgdown/docs/reference/svychisq.html

---

## T07 未出現カテゴリ

コードブックに存在するが観測数 0 のカテゴリを追加しても、

```text
Rao–Scott 結果
Pearson 結果
```

が変化しないこと。

表示表には 0 件カテゴリを残してよい。

推測用行列ではゼロ周辺を除く。

---

## T08 semantic missing weight

ウェイト列の `99` を欠損コードに指定。

```text
1.0
0.8
99
1.2
```

なら `99` を 99 倍のウェイトとして使用しない。

`weightMissingCount=1` になること。

---

## T09 セル別 ★ を出さない

survey 時:

```text
cell.significance = null
```

であること。

Rao–Scott の全体 p 値を通常 ASR に流用しない。

---

## T10 ESS は倍率不変

```text
w
100w
```

で、

```text
kishEffectiveN
weightingDeff
weightCv
```

が一致すること。

---

## T11 調査設計変更でキャッシュ無効化

strata または PSU を変更した後、以前の inference 結果が cache hit しないこと。

---

## T12 Pyodide parity

CPython のテストだけでなく、配布物と同じ Pyodide / NumPy / SciPy 環境でも golden test を実行する。

DAVIS-PCP はブラウザ内実行が本番なので、ここを受け入れ条件から外さない。

---

# 24. 数値精度

内部では丸めない。

```text
float64
```

で計算し、API でも原則として十分な精度を保持する。

UI だけ、

```text
F 4.46
p 0.036
V 0.23
```

等に整形する。

現在のようにアルゴリズム途中で `round(..., 4)` した値を次の統計量へ使わない。

---

# 25. エラー・警告コード

推奨追加:

```text
WEIGHT_TYPE_REQUIRED
WEIGHT_FREQUENCY_NONINTEGER
WEIGHT_SEMANTIC_MISSING
SURVEY_PEARSON_UNSUPPORTED
SURVEY_INFERENCE_NOT_REQUESTED
SURVEY_INFERENCE_WEIGHTS_ONLY
SURVEY_DESIGN_INVALID
SURVEY_LOW_DESIGN_DF
SURVEY_SINGLE_PSU_STRATUM
SURVEY_INFERENCE_UNAVAILABLE
```

警告とエラーを分ける。

例:

- 負ウェイト → error
- survey で inference 未要求 → info/status
- strata/PSU 不足で独立回答者近似 → warning
- 設計自由度が成立しない → inference unavailable

---

# 26. 後方互換性

既存データで、

```text
role=weight
```

だけ存在し weightType がない場合、従来動作を自動継続しない。

特に、

```text
旧挙動 = weighted Pearson
```

を暗黙に維持すると B04 が残る。

理想動作:

```text
このウェイトの種類が未設定です。
○ 調査ウェイト
○ 頻度ウェイト
```

と一度だけ選ばせる。

API では `weightColumn` を指定しているのに `weightType` を解決できなければ、

```text
WEIGHT_TYPE_REQUIRED
```

を返す。

---

# 27. 移行段階

理想仕様は Rao–Scott まで含むが、安全に段階導入する。

## Phase 0：誤推測を止める

最優先。

```text
survey
→ Pearson p 値を出さない
→ セル ★ を出さない

frequency
→ 現行 Pearson を許可
```

ここまでを B04 の緊急修正とする。

---

## Phase 1：ウェイト診断

追加:

```text
weightSum
Kish ESS
weighting DEFF
weight CV
weighted Cramér's V
```

---

## Phase 2：weights-only Rao–Scott

最終ウェイトだけでも、

```text
1 respondent = 1 PSU
```

の独立回答者近似で Rao–Scott 第2次補正を実装。

UI では明示的な opt-in。

---

## Phase 3：strata / PSU

データセットの surveyDesign に、

```text
strata
PSU
```

を追加。

本来の complex survey inference に拡張する。

---

## Phase 4：replicate weights / FPC

必要性が出た場合のみ。

DAVIS-PCP の主目的が一般的なアンケート EDA であれば、初期リリース必須ではない。

---

## Phase 5：セル別 design-based inference

必要性が高ければ、

```text
セル比率の contrast
design-based SE
multiple comparison correction
```

を実装し、その時点で初めて survey 時のセル別有意マーカーを復活させる。

---

# 28. やってはいけない修正

以下は正式修正として採用しない。

## 28.1 ウェイト合計を N に正規化するだけ

倍率問題は消えるが、調査設計対応ではない。

---

## 28.2 Kish ESS をそのまま χ² の N として使う

診断量と推測統計を混同する。

---

## 28.3 警告文だけ追加して現行 Pearson を残す

p 値と ★ が通常表示される限り、ユーザーは結果を使用できてしまう。

---

## 28.4 Rao–Scott の p 値だけ導入し、セル ★ は現行 ASR のまま

全体検定とセル検定の標準誤差モデルが異なるため不整合。

---

## 28.5 補正後 Rao–Scott 統計量から Cramér's V を計算する

関連の記述量と推測統計量を混同する。

---

## 28.6 survey / frequency を自動推定する

ウェイト値が整数だから frequency、少数だから survey、などと推測しない。

ウェイトの意味はデータの意味論であり、値だけから安全に判定できない。

---

# 29. 完了条件

B04 を「修正済み」と判定する最低条件:

- [ ] weightType が survey / frequency に分離されている
- [ ] survey で通常 Pearson χ² を実行しない
- [ ] survey の既定 p 値は null
- [ ] survey のセル有意マーカーは null
- [ ] frequency は従来の頻度ベース Pearson を使用可能
- [ ] survey でウェイト倍率を変えても記述結果・推測結果が不変
- [ ] semantic missing のウェイトを数値として扱わない
- [ ] weightedN を weightSum と KishEffectiveN に分離
- [ ] weighted Cramér's V と inference statistic を別計算にする
- [ ] Rao–Scott 第2次補正を opt-in で利用可能
- [ ] 設計情報不足時は independent_rows 近似と明記
- [ ] R `survey::svychisq(statistic="F")` との golden parity test がある
- [ ] Pyodide 上でも同じ golden test が通る
- [ ] surveyDesign / weightType がキャッシュキーまたは revision に反映される

---

# 30. 推奨する最終判断

今回提示されていた 3 案のうち、正式採用は次とする。

```text
既定は非表示＋明示で近似検定
```

ただし、その「近似検定」は、

```text
実効 N 正規化 Pearson
```

ではなく、

```text
Rao–Scott 第2次補正
```

とする。

最終ウェイトしかない場合には、

```text
Rao–Scott 第2次補正
+ 各回答者を独立 PSU とする近似
```

とし、層化・PSU 情報が与えられた時点で同じ API のまま完全な調査設計へ昇格できる構造にする。

DAVIS-PCP の目的が「アンケートを探索的に理解すること」である以上、

```text
加重割合と効果量をまず見る
→ 必要なときだけ設計ベースの推測統計を見る
```

という順序が最も一貫している。

---

# 31. 参考資料

## R `survey`：`svychisq`

https://r-survey.r-forge.r-project.org/pkgdown/docs/reference/svychisq.html

原文の最小引用:

> `svychisq computes first and second-order Rao-Scott corrections`

同ページでは既定方式について、

> `The default ... is the Rao-Scott second-order correction.`

としている。

---

## R `survey`：two-way table tests

https://r-survey.r-forge.r-project.org/survey/survey-wss.pdf

原文の最小引用:

> `second order ... corrects the variance as well`

---

## Rao & Scott (1984)

J. N. K. Rao and A. J. Scott,  
“On Chi-Squared Tests for Multiway Contingency Tables with Cell Proportions Estimated from Survey Data”,  
The Annals of Statistics, Vol. 12, No. 1, pp. 46–60.

https://www.jstor.org/stable/2241033

---

# 32. 実装上の重要ポイントを一文でまとめる

`survey weight` を「件数」として扱うのをやめ、記述用の加重表と推測用の survey-design variance を完全に分離する。
