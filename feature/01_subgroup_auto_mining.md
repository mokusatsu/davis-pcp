# 機能仕様書: サブグループ×全質問の自動マイニング（Automatic Subgroup Mining）

## 1. 概要・目的

データセット内の**属性変数（セグメント/バナー）** と **全質問変数** の全組み合わせについて、適切な統計検定と効果量を自動実行し、「統計的に有意 × 実質的に意味がある × 実務で使える」発見だけを、重要度順にランキングして提示する機能。

既存ツール（クロス集計を1つずつ手で作る）との決定的な差は、**「どの組み合わせを見るべきか」をアプリが自律的に探索し、多重比較を補正した上で、解釈文つきで返す**点にある。

## 2. 位置づけ・依存関係

- 本機能は「自律的インサイト発見エンジン」の中核。
- 入力として、**メタデータ付きデータモデル** を前提とする（変数ラベル・値ラベル・変数種別・質問/属性ロール・欠損値コード）。
- オプションで「意外性スコアリング（02）」の結果を重要度スコアに合成できる。
- 出力される発見は「感度分析（03）」の頑健性診断の対象となる。

## 3. 入力データモデル

各カラムに以下のメタデータが付与されていることを前提とする。

| フィールド | 型 | 説明 |
|---|---|---|
| `name` | str | カラム名 |
| `label` | str | 変数ラベル（質問文） |
| `type` | enum | `numeric`（連続/スケール）, `ordinal`（順序）, `categorical`（名義）, `datetime`, `text` |
| `role` | enum | `question`（分析対象の質問）, `attribute`（属性/バナー/セグメント）, `weight`, `id`, `other` |
| `value_labels` | dict[int,str] | 値ラベル（例: `{1:"男性",2:"女性"}`） |
| `missing_codes` | list[int] | 欠損値コード（例: `[98,99]`） |
| `multiple_response` | bool | マルチアンサー質問か（MVPではオプション対応） |

## 4. 処理アルゴリズム

### 4.1 前処理

1. `role == attribute` かつ `type in {categorical, ordinal}` のカラムを**サブグループ変数**候補とする。
2. サブグループ変数の前処理:
   - カーディナリティが閾値（既定 `max_subgroup_levels = 8`）を超える場合は、度数上位N-1カテゴリ + `その他` に集約（集約ロジックは設定可能。または対象から除外して警告）。
   - 連続型の属性を使いたい場合（例: 年齢・収入）は、設定に応じて**ビニング**（分位点 or 等間隔）してサブグループ化。既定では `attribute` ロールの連続カラムは対象外とし、明示指定時のみビニング。
   - カテゴリごとの有効度数 `n_cat < min_group_size`（既定 `30`）のカテゴリは「小ベース」フラグを立てる。
3. 質問変数（`role == question`）のうち `type in {categorical, ordinal, numeric}` を対象。`text`/`id`/`other` は除外。

### 4.2 検定選定ロジック（決定表）

`サブグループの水準数` × `質問の型` で検定と効果量を決定する。

| 質問の型 | サブグループ2水準 | サブグループ3水準以上 |
|---|---|---|
| **categorical（名義）** | χ²検定（期待度数<5のセルが20%超 or 2×2でセル<5 なら Fisher 正確検定）／効果量 Cramér's V | χ²検定（同上の Fisher 代替）／効果量 Cramér's V（df補正） |
| **ordinal（順序）** | Mann-Whitney U 検定／効果量 Cliff's delta（一次）＋補助的に平均値比較 | Kruskal-Wallis 検定／効果量 epsilon²（または Cliff's delta の多群一般化） |
| **numeric（連続）** | Welch の t 検定／効果量 Cohen's d | Welch の ANOVA／効果量 eta²（ω²を併記） |

設計上の注意:

- **ordinal の扱い**: 順序尺度の質問は、主検定をノンパラメトリック（Mann-Whitney/Kruskal-Wallis）とし、平均スコアは表示用に併記する。χ²/Cramér's V は名義質問のみに使う。
- **numeric の正規性**: Welch 検定を既定（等分散仮定を置かない）。歪みが強い場合は設定で Mann-Whitney にフォールバック可能。
- **分散分析後の多重比較**: 3水準以上で有意だった場合、ペアワイズ対比（Welch なら Games-Howell、等分散なら Tukey HSD）を実行し、どの群間に差があるかを特定。対比の p 値も BH-FDR 補正する。

### 4.3 効果量の計算と閾値

各効果量の解釈閾値（Cohen 1988 準拠）を定数として実装する。

**Cramér's V**（名義×名義）:

```
V = sqrt(χ² / (n * df_min))
df_min = min(r - 1, c - 1)
```

| df_min | small | medium | large |
|---|---|---|---|
| 1 | 0.10 | 0.30 | 0.50 |
| 2 | 0.07 | 0.21 | 0.35 |
| 3 | 0.06 | 0.17 | 0.29 |
| 4 | 0.05 | 0.15 | 0.25 |

（表にない df は線形補間）

**Cohen's d**（2群の連続）:

```
d = (mean_1 - mean_2) / s_pooled
s_pooled = sqrt(((n1-1)*s1^2 + (n2-1)*s2^2) / (n1+n2-2))
```

閾値: small=0.20, medium=0.50, large=0.80。

**Cliff's delta**（順序）: `P(X1 > X2) - P(X1 < X2)`。閾値: small=0.147, medium=0.330, large=0.474（Romano 2006）。

**eta² / ω²**（3群以上の連続）:

```
eta² = SS_between / SS_total
ω²  = (SS_between - (k-1)*MS_within) / (SS_total + MS_within)
```

閾値: small=0.01, medium=0.06, large=0.14。

**epsilon²**（Kruskal-Wallis の効果量）:

```
epsilon² = H / ((n²-1)/(n+1))   # H は Kruskal-Wallis 統計量
```

閾値: eta² に準拠（0.01/0.06/0.14）。

### 4.4 多重比較補正（Benjamini-Hochberg FDR）

全組み合わせ（サブグループ × 質問）で算出した p 値の集合 `P = {p_1, ..., p_m}` に対して BH-FDR を適用する。

```
# Python (statsmodels)
from statsmodels.stats.multitest import multipletests
reject, qvals, _, _ = multipletests(pvals, alpha=alpha, method='fdr_bh')
```

- 既定 `alpha = 0.05`。探索的利用を想定し、設定で `0.10` に緩和可能。
- **q値**（FDR補正後 p 値）を必ず保持し、表示・ソートに使う。
- 対比（post-hoc）の p 値も、その対比ファミリー内で別途 FDR 補正する。
- 参考値として Bonferroni 補正後の「有意だった件数」も併記（FDR との差を見せるため）。

### 4.5 実質的重要性（practical significance）フィルタ

「有意だが実務上どうでもよい」発見を排除するため、以下を満たす場合のみ発見候補とする。

1. **効果量が small 以上**（上記閾値）。
2. **最小セル度数/サブグループ有効度数が `min_group_size` 以上**（既定 30）。
3. **表示上の差が `min_pct_diff`（既定 3%ポイント）以上**、または連続では群平均の差が `min_mean_diff`（既定: スケール幅の 2%相当）以上。

### 4.6 複合インサイトスコア（ランキング用）

各発見に `insight_score` を付与して降順ソートする。

```
insight_score =
    w_stat  * stat_score      # 統計的信頼度（-log10(q) を正規化 or q の逆数）
  + w_eff   * eff_score       # 効果量（small=0.33, medium=0.66, large=1.0 に正規化）
  + w_prac  * prac_score      # 実質的重要性（pct差/mean差を正規化）
  + w_surp  * surprise_score  # 任意。02の意外性スコア（無効時は0）
```

既定重み: `w_stat=0.35, w_eff=0.30, w_prac=0.20, w_surp=0.15`（合計1.0）。全重みは設定変更可能。

`stat_score` は `clip(1 - q/alpha, 0, 1)`、`eff_score` は効果量を large 閾値で割って `clip(0,1)`、`prac_score` は pct差/mean差を `min_pct_diff` の k 倍（既定 k=5）で正規化して `clip(0,1)`。

### 4.7 方向・文脈の特定

各発見について「どのサブグループがどう違うか」を特定する。

- 2水準: 高い方/低い方の値を特定。
- 3水準以上: 全体平均からの偏差が最も大きい群（＋対比で有意だった群ペア）を特定。
- 連続質問: 群ごとの平均・中央値・標準偏差を記録。
- 名義質問: 群ごとの最頻カテゴリと、期待度数からの**調整済み残差（adjusted residual）** が最大のセルを「特徴的なセル」として記録。

### 4.8 自然言語説明（NL説明）の生成

テンプレートで解釈文を生成する。変数ラベル・値ラベルを埋め込む。

```
【テンプレート例】
「{subgroup_label}」で見ると、「{question_label}」に有意な差があります
（q = {q}, 効果量 {effect_label} = {effect_value}）。
特に {top_subgroup} の平均/比率は {value} で、全体（{overall_value}）より
{pct_diff}%ポイント高い/低くなっています。
```

## 5. 出力スキーマ（JSON）

```json
{
  "run_id": "uuid",
  "generated_at": "2026-08-21T10:00:00+09:00",
  "config": { "alpha": 0.05, "min_group_size": 30, "min_pct_diff": 3.0 },
  "summary": {
    "n_subgroup_vars": 12, "n_questions": 85, "n_tests_run": 1020,
    "n_significant_fdr": 142, "n_significant_bonferroni": 64,
    "n_insights_after_filters": 38
  },
  "insights": [
    {
      "id": "ins_001",
      "subgroup": { "name": "age_group", "label": "年代", "type": "ordinal" },
      "question": { "name": "q12", "label": "総合満足度", "type": "numeric" },
      "test": { "method": "welch_anova", "statistic": 8.42, "df_between": 4, "df_within": 1200,
                "p_value": 1.2e-6, "q_value": 3.4e-5, "significant": true },
      "effect": { "measure": "eta_sq", "value": 0.11, "label": "medium" },
      "group_stats": [
        { "group": "20代", "n": 210, "mean": 3.1, "sd": 1.2 },
        { "group": "60代", "n": 180, "mean": 4.4, "sd": 1.0 }
      ],
      "direction": { "highest_group": "60代", "lowest_group": "20代",
                     "delta": 1.3, "delta_pct": 26.0 },
      "posthoc": [ { "pair": ["20代","60代"], "p_adj": 1.1e-4, "significant": true } ],
      "scores": { "stat": 0.99, "effect": 0.66, "practical": 0.85, "surprise": null,
                  "insight_score": 0.82 },
      "narrative": "「年代」で見ると、「総合満足度」に有意な差があります（q=3.4e-5, 効果量 medium=0.11）。…",
      "warnings": ["60代 のサブグループは n=180 で問題なし"]
    }
  ]
}
```

## 6. UI/UX・GUI詳細設計

### 6.1 画面配置とレイアウト
本機能は、メインナビゲーションの独立タブ `[Auto Mining]` (`/subgroups`) または `[Insights]` として提供する。
画面は、大量の検定結果から有望な発見を迅速に走査し、証拠データを検証してPCP探索へ接続できる「マスター・詳細スプリットビュー」を採用する。

```
+---------------------------------------------------------------------------------------------------------+
| [PCP] [Table] [Distribution] [Relationships] [Clusters] [Models] [(o) Auto Mining] [Touring] [Mosaic]   |
+---------------------------------------------------------------------------------------------------------+
| Attributes: [ (x) 性別  (x) 年代  (x) 地域  (x) 会員ランク ]   Questions: [ 全78問選択中 v ]             |
| Significance: [ FDR α=0.05 v ]  Min Size: [ 30 ]  Min Diff: [ 3.0% ]   [ > Run Auto Mining (1,020 tests)]|
+----------------------------------------------------+----------------------------------------------------+
|  Pane 1: Discovered Insights Ranking (38 items)    |  Pane 2: Evidence & Drilldown Inspector            |
|  Sort: [ Insight Score v ]  Filter: [ Effect: All v|  Selected: #1 年代 × 総合満足度 (q=3.4e-5, eta²=0.11) |
|                                                    |                                                    |
|  +-----------------------------------------------+ |  [NL Summary]                                      |
|  | #1 年代 × 総合満足度             [Large] [FDR]| |  「年代」で見ると、「総合満足度」に有意な差があります。   |
|  | Score: 0.82  q=3.4e-5  Welch ANOVA            | |  特に 60代の平均満足度は 4.4 で、全体（3.6）より +26%高く、 |
|  | 60代の平均が 4.4 (+26% vs 全体) で突出        | |  20代（3.1）と有意なコントラストを形成しています。         |
|  | [View Evidence >]    [Select Rows (n=180)]    | |                                                    |
|  +-----------------------------------------------+ |  [Group Comparison Chart]                          |
|  | #2 性別 × ブランド推奨度 (NPS)    [Medium] [FDR]| |  Score  20代    30代    40代    50代    60代       |
|  | Score: 0.74  q=1.1e-4  Mann-Whitney U         | |   5.0 +                 [===]   [===]   [===]        |
|  | 女性の推奨度が +18.4pt 高い                   | |   4.0 +         [===]   |   |   |   |   | * | (4.4)  |
|  | [View Evidence >]    [Select Rows (n=450)]    | |   3.0 + [===]   |   |   |   |   |   |   |   |        |
|  +-----------------------------------------------+ |   2.0 + | * | (3.1)                                |
|  | #3 会員ランク × 購入頻度          [Medium] [FDR]| |         +-------+-------+-------+-------+--------+   |
|  | Score: 0.69  q=8.2e-4  χ²検定 (V=0.28)         | |                                                    |
|  | ゴールド会員の週3回以上利用が突出(残差+4.2)   | |  [Post-hoc Pairwise Contrasts]                    |
|  | [View Evidence >]    [Select Rows (n=120)]    | |  Pair: 20代 vs 60代 (Δ=1.3, p_adj=1.1e-4) ***       |
|  +-----------------------------------------------+ |  Pair: 30代 vs 60代 (Δ=0.9, p_adj=0.002) **         |
|  | ... (残り35件の有意インサイト)                | |                                                    |
|  |                                               | |  [Actions]                                         |
|  | [Download Excel Report] [Export HTML Insights]| |  [ (o) Select Subgroup in PCP (180 rows) ]        |
|  |                                               | |  [ ⤢ Focus PCP on this Pair ] [ Send to Robustness]|
+----------------------------------------------------+----------------------------------------------------+
```

### 6.2 コンポーネント階層構造
- `frontend/src/features/mining/`
  - `SubgroupMiningPage.tsx`: ページ全体管理・設定バー・マスター詳細ステート連携
  - `MiningConfigBar.tsx`: 属性変数／質問変数のマルチセレクト、有意水準、最小サンプルサイズ、実行ボタン、プログレスバー
  - `InsightRankingList.tsx`: 重要度スコア順のインサイトカードリスト、フィルタ（効果量・有意性・変数型）
  - `InsightCard.tsx`: 個別インサイトカード（スコア、バッジ、一行要約、クイック選択ボタン）
  - `EvidenceDrilldownPane.tsx`: 選択中インサイトの多角的エビデンス表示
    - `GroupComparisonPlot.tsx`: 群別平均棒グラフ／箱ひげ図（連続質問）または帯グラフ／残差ヒートマップ（名義質問）
    - `ContingencyResidualTable.tsx`: 分割表・セル度数・調整済み残差テーブル（残差 > +2.0 青、< -2.0 赤）
    - `PostHocContrastTable.tsx`: Games-Howell / Tukey HSD ペアワイズ対比結果テーブル
    - `MiningActionBar.tsx`: PCPポリライン同期・軸フォーカス・感度分析連携アクション

### 6.3 インタラクション & DAVIS連携ワークフロー
1. **ワンクリックPCPブラッシング (`Select Subgroup in PCP`)**:
   - インサイトカードの `[Select Rows]` または詳細ペインの選択ボタンをクリックすると、該当サブグループの `rowIds` が中央選択エンジン（`selectionStore`）へ即座に設定される。
   - 他のタブ（PCP、Table、Scatterplot等）に切り替えた際、そのサブグループのポリラインやデータ点がハイライト表示される。
2. **PCP軸自動フォーカス (`Focus PCP on this Pair`)**:
   - `[Focus PCP on this Pair]` をクリックすると、PCP画面へ遷移し、PCPの最左端軸に対象の「属性変数（例: 年代）」、2番目の軸に対象の「質問変数（例: 総合満足度）」を自動配置し、2変数間の関係性を即座に視覚確認できる。
3. **感度分析へのシームレス登録 (`Send to Robustness`)**:
   - 発見された群間差結論を、ワンクリックで「Feature 03: 感度分析」の診断結論レジストリへ登録し、外れ値や品質による結果の脆弱性を検証可能。
4. **一括レポート出力**:
   - 発見された全インサイトを、表形式・要約文・効果量・p値付きでExcelファイル（.xlsx）およびHTMLレポートとしてダウンロード可能。

## 7. エッジケースと対処

| ケース | 対処 |
|---|---|
| 定数列（分散0） | 検定対象から除外し、サマリーに「除外 n 件」として計上 |
| 高カーディナリティ属性 | 上位N-1 + その他に集約（既定 N=8）。集約後も水準数<2 なら除外 |
| 疎な分割表（期待度数<5 が多数） | Fisher 正確検定に自動切替。それでも計算不可なら発見対象から除外 |
| 全欠損の組み合わせ | スキップし、有効 N=0 として記録 |
| サブグループが全体の極小比率（<5%） | 発見を出すが `small_base` 警告を付与 |
| 重み変数あり | 検定は無重み（または有効サンプルサイズ `(Σw)²/Σw²` を併記）。重み付き検定は将来対応として注記 |
| マルチアンサー質問 | MVP では対象外とし警告。P1 で「% of cases」ベースの集計に対応 |

## 8. パフォーマンス要件

- 組み合わせ数 `M = n_subgroup_vars × n_questions` が 50,000 を超える場合、全実行は重いため以下を実装:
  - **事前絞り込み**: カーディナリティ・分散・欠損率で明らかに無意味な組み合わせを除外。
  - **並列化**: 検定は独立なのでマルチプロセス/スレッドで実行。
  - **段階評価**: まず全組み合わせの検定のみ高速実行 → 有意候補だけ効果量・対比・NL生成を実行（2段階パイプライン）。
  - **キャッシュ**: 同一データ+同一設定の実行結果をキャッシュし再計算を回避。
- 目標: 10万行 × 100列 × 15属性 で 60秒以内（8コア想定）。

## 9. 依存ライブラリ（Python 想定）

- データ操作: `polars`（大規模）または `pandas`
- 検定/効果量: `scipy.stats`（chi2_contingency, fisher_exact, mannwhitneyu, kruskal, ttest_ind, f_oneway）
- 多重比較: `statsmodels.stats.multitest.multipletests`
- 効果量: 自前実装（Cramér's V, Cohen's d, Cliff's delta, eta², ω², epsilon²）＋ `pingouin`（補助）

## 10. テスト計画

**単体テスト:**

1. 検定選定ロジック: 各（水準数 × 質問型）の組み合わせで正しい検定・効果量が選ばれるか。
2. Cramér's V の df 補正閾値が正しく補間されるか。
3. BH-FDR: 既知の p 値ベクトルで q 値・reject が `statsmodels` と一致するか。
4. 効果量: 既知データで Cohen's d / eta² / Cliff's delta の値が手計算と一致するか。
5. NL説明: テンプレートが値ラベルを正しく埋めるか（日本語・欠損時フォールバック）。

**統合テスト（合成データ）:**

6. 既知の差を埋め込んだデータ（例: 40代女性のみ満足度を+1σ ずらす）で、その発見が上位にランクされるか。
7. 完全にランダムなデータで、FDR 補正後に発見がほぼ出ないこと（偽陽性率の確認）。
8. 小セル・定数列・全欠損を含むデータで例外なく完了するか。

**受入基準:**

- ランダムデータでの有意発見率が α 以下（FDR 制御の実証）。
- 埋め込み差の再現率が高く（再現率 > 0.8）、上位10件に含まれる。
- 10万行規模でタイムアウトせず完了。
