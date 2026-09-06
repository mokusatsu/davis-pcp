# 機能仕様書: 感度分析（結果の頑健性診断 / Robustness & Sensitivity Analysis）

## 1. 概要・目的

アプリが提示した各「結論（conclusion）」が、データの摂動（perturbation）に対してどれだけ頑健かを定量評価し、**「信頼できる結論」と「サンプルや分析選択に依存する脆い結論」を自動的に区別**して提示する機能。

アンケート分析で軽視されがちな「この結論は回答者を何人か除いたら覆るのでは？」という問いに、機械的・定量的に答える。既存 EDA ツールにはほぼ存在しない差別化機能。

## 2. 位置づけ・依存関係

- 診断対象は**結論レジストリ**（conclusion registry）に登録された既存分析の出力。以下が主要な登録元:
  - サブグループ自動マイニング（01）の有意差発見
  - Key Driver Analysis（04）のドライバーランキング
  - Penalty-Reward 分析（05）の三因子分類
  - 基本集計の主要指標（総合満足度平均、NPS、Top-2 Box 比率）
- 回答者品質スコア（データ品質モジュール）を摂動の軸の1つとして利用する。

## 3. 入力

```json
{
  "data": "…",
  "weights": "weight_col または null",
  "respondent_quality": "quality_score_col または null",
  "conclusions": [
    { "id": "c001", "type": "subgroup_diff", "ref": "ins_001",
      "metric": "q12_mean", "target": 3.8, "direction": "higher",
      "compare_groups": ["20代", "60代"] },
    { "id": "c002", "type": "kpi", "metric": "nps", "target": 12.4 },
    { "id": "c003", "type": "driver_rank", "ref": "kda_001", "ranking": ["q1","q2","q3"] },
    { "id": "c004", "type": "pra_class", "ref": "pra_001", "classification": "basic" }
  ]
}
```

結論の型: `kpi`（主要指標の値）, `subgroup_diff`（群間差・有意差）, `driver_rank`（KDAランキング）, `pra_class`（PRA分類）。

## 4. 摂動戦略（perturbation strategies）

以下の摂動を個別に、または一括で適用し、各摂動後の結論の変化を計測する。全戦略とも**同じ評価関数**（§5）で結論を再評価する。

### 4.1 品質ベース除去スイープ（quality-based removal sweep）— 既定

回答者品質スコアが低い順に、下位 x% を段階的に除去して再計算する。

```
x ∈ {0, 5, 10, 20, 30}（設定可能）
各 x について:
  - 品質スコア下位 x% の回答者を除去
  - 結論を再評価
  - フルサンプル（x=0）との差分を記録
```

品質スコアがない場合、この戦略は無効化し警告。

### 4.2 Leave-one-out / ジャックナイフ（influence）

各回答者を1人ずつ除去して主要なスカラー結論（`kpi`, `subgroup_diff` の効果量）を再計算し、影響度を算出する。

```
for each respondent i:
  drop i → 再計算 → Δ_i = (metric_full - metric_minus_i)
influence_i = Δ_i の二乗和 または max|Δ_i|
```

- 全回答者のフル再計算は重いため、**効率的近似**を実装:
  - 線形統計量（平均・比率）は影響関数（influence function）で解析的に高速計算できる。
  - 例: 平均 μ に対する i の影響は `(μ - x_i) / (n-1)`。NPS・Top-2 Box は指示関数の平均なので同様に解析的。
  - 回帰系（KDA）は `statsmodels` の影響診断（Cook's distance, DFBETAS）を利用。
- 上位影響回答者（既定: 影響度上位 1%）を「影響力のある回答者」としてレポート。

### 4.3 ブートストラップ（bootstrap）

復元抽出を B 回（既定 500）行い、結論の標本分布を推定する。

- `kpi` / `subgroup_diff`: 各リサンプルで点推定を再計算 → 95% CI、および「結論が反転する割合」を算出。
- `driver_rank`: 各リサンプルでランキングを再計算 → 各ドライバーの順位分布、順位が ±1 を超えて変動する割合。
- 重みがある場合は、重みを考慮したリサンプリング（または設計を尊重したリサンプリング）を注記。

### 4.4 重み感度（weight sensitivity）— 重みがある場合のみ

- 無重み vs 重み付き、および重みトリミング（上下1%/5%でカット）を比較。
- 重み効率 `(Σw)²/Σw²` を併記し、有効サンプルサイズの縮小を可視化。

### 4.5 欠損処理感度（missing-data sensitivity）

- 完全ケース分析（listwise）vs 中央値/最頻値代入 vs 多重代入（MVPでは簡易版）で主要指標を比較。

## 5. 頑健性指標（robustness metrics）

各結論について以下を計算する。

### 5.1 点推定のドリフト（estimate drift）

```
drift = max over perturbations | estimate_perturbed - estimate_full | / scale
scale = |estimate_full| が 0 でなければ |estimate_full|、そうでなければ全体の標準偏差
```

### 5.2 結論安定性（conclusion stability）— 二値判定

結論の型ごとに「反転（flip）」を定義し、全摂動中で反転が起きた割合 `flip_rate` を算出する。

| 結論の型 | 反転の定義 |
|---|---|
| kpi | 符号反転、または `|drift| > 0.20`（20%超の変動） |
| subgroup_diff | 有意性が q<0.05 ⇄ q≥0.05 をまたぐ、または効果量が small 未満に落ちる、または方向（どちらの群が高いか）が逆転 |
| driver_rank | 上位2位の順序が入れ替わる、または1位が2位以下に落ちる |
| pra_class | 分類ラベル（basic/performance/excitement/indifferent）が変化 |

### 5.3 頑健性グレード（robustness grade）

```
flip_rate = 0            → "頑健（robust）"
0 < flip_rate ≤ 0.10     → "概ね頑健（mostly robust）"
0.10 < flip_rate ≤ 0.25  → "やや敏感（somewhat sensitive）"
flip_rate > 0.25         → "脆い（fragile）"
```

`fragile` 判定の結論は、UI 上で強調表示し、「この結論は回答者サンプルや分析選択に依存する可能性があります」と警告する。

## 6. 出力

### 6.1 頑健性レポートスキーマ（JSON）

```json
{
  "run_id": "uuid",
  "generated_at": "…",
  "config": { "removal_fractions": [0,5,10,20,30], "bootstrap_B": 500,
              "influence_top_pct": 1.0 },
  "conclusions": [
    {
      "id": "c001", "type": "subgroup_diff", "ref": "ins_001",
      "full_estimate": { "metric": "q12_mean", "value": 3.8, "groups": {"20代":3.1,"60代":4.4},
                         "q_value": 3.4e-5, "effect": {"measure":"eta_sq","value":0.11} },
      "perturbations": [
        { "strategy": "quality_removal", "param": 0.20, "estimate": 3.7,
          "drift": 0.026, "flipped": false },
        { "strategy": "bootstrap", "param": null,
          "ci_low": 3.5, "ci_high": 4.1, "flip_rate": 0.02 }
      ],
      "influence": { "top_respondents": [ { "row_id": 4123, "influence": 0.18 } ],
                     "max_influence": 0.18 },
      "robustness": { "max_drift": 0.03, "flip_rate": 0.02, "grade": "mostly_robust" },
      "narrative": "この結論は低品質回答者を20%除去してもほぼ変化せず、概ね頑健です。"
    }
  ]
}
```

### 6.2 UI/UX・GUI詳細設計

#### 6.2.1 画面配置とレイアウト
本機能は、メインナビゲーションの独立タブ `[Robustness]` (`/robustness`) または各インサイト画面の診断モーダルとして提供する。
分析者は「どの結論が、どんな前提変化で覆るか」を一目で把握できるダッシュボード型UIで操作する。

```
+---------------------------------------------------------------------------------------------------------+
| [PCP] [Table] [Distribution] [Relationships] [Clusters] [Models] [Auto Mining] [(o) Robustness] [Mosaic]|
+---------------------------------------------------------------------------------------------------------+
| Registered Conclusion: [ #1 60代の総合満足度平均が突出 (c001: Δ=1.3, p=1.2e-6) v ]  [ + Add Custom KPI ] |
| Perturbation Suite: [x] Quality Sweep  [x] Jackknife  [x] Bootstrap 500x  [x] Weight Trim   [ Run Audit ]|
+----------------------------------------------------+----------------------------------------------------+
|  Pane 1: Robustness Scorecard & Stability Gauge    |  Pane 2: Perturbation Sensitivity & Tornado Plot   |
|                                                    |                                                    |
|  Overall Verdict:  [ MOSTLY ROBUST (Grade: B+) ]   |  Strategy               Estimate Drift / 95% CI    |
|  Robustness Score:  86 / 100                       |  Full Sample (Baseline) |------[ 3.80 ]------|     |
|                                                    |  Quality Drop 10%       |-----[ 3.78 ]-------|     |
|  Key Metrics:                                      |  Quality Drop 20%       |----[ 3.72 ]--------|     |
|  - Max Estimate Drift: 2.1% (許容閾値 5.0%以内)    |  Quality Drop 30%       |---[ 3.65 ]---------|     |
|  - Conclusion Flip Rate: 1.8% (反転確率 極低)      |  Weight 1% Trimmed      |------[ 3.81 ]------|     |
|  - High Influence Concentration: 0.18 (安全水準)   |  Bootstrap 95% CI       |---[ 3.52 ==== 4.08 ]---| |
|                                                    |                                                    |
|  [Summary Narrative]                               |  [Quality Removal Drift Band]                      |
|  「この結論は回答者品質下位20%を除去しても反転     |  Est  0%      10%     20%     30% Removed          |
|  せず、標本リサンプリング下でも98.2%の確率で       |  4.0 +--------------------+------------------+     |
|  維持されるため、頑健なビジネス判断の根拠として     |  3.8 +---o--------o--------o--------o (Stable)     |
|  利用可能です。」                                  |  3.6 +--------------------+------------------+     |
+----------------------------------------------------+----------------------------------------------------+
|  Pane 3: High-Influence Respondents & Outlier Inspector (Top 1% Influential Cases)                     |
|                                                                                                         |
|  [!] 以下の特定回答者の除外によって推定量が最も大きく変動します:                                         |
|  [x] Rank | RowId    | Influence (Δ) | 年齢 | 満足度 | 品質スコア | フラグ / 備考                     |
|  [ ] #1   | IRIS-042 | +0.18 (大)    | 68歳 | 1点    | 32 (低)    | ストレートライン回答の疑い        |
|  [ ] #2   | IRIS-109 | +0.11 (中)    | 61歳 | 2点    | 45 (中)    | 自由記述欄が無意味文字列          |
|  [ ] #3   | IRIS-088 | -0.09 (小)    | 22歳 | 5点    | 88 (高)    | 正常な極値回答                    |
|                                                                                                         |
|  [Actions]                                                                                              |
|  [ (o) Highlight Influential Rows in PCP (2 rows) ]  [ Exclude Checked & Re-evaluate ]  [ Reset Sample ]|
+---------------------------------------------------------------------------------------------------------+
```

#### 6.2.2 コンポーネント階層構造
- `frontend/src/features/robustness/`
  - `RobustnessPage.tsx`: 結論セレクタ・診断実行管理・全体の統合ビュー
  - `ConclusionSelector.tsx`: 自動マイニング・KDA・主要KPIから登録された結論の選択ドロップダウン
  - `RobustnessScorecard.tsx`: 頑健性総合スコア、グレードバッジ（Robust A / Mostly B / Fragile D）、要約判定文
  - `PerturbationTornadoPlot.tsx`: 各摂動（品質カット、重みトリム、ブートストラップ）の推定量ドリフト幅トルネードチャート
  - `QualitySweepBandPlot.tsx`: 除去割合（0%〜30%）に伴う推定値と有意水準の推移折れ線グラフ
  - `InfluentialRespondentsTable.tsx`: ジャックナイフ/影響関数による上位影響回答者一覧テーブル
  - `RobustnessActionBar.tsx`: 影響回答者のPCPハイライト・除外即時再計算・フルサンプルリセット

#### 6.2.3 インタラクション & DAVIS連携ワークフロー
1. **影響回答者のPCP追跡ブラッシング (`Highlight Influential Rows in PCP`)**:
   - 結論を大きく左右している特定回答者（例: RowId IRIS-042, 109）のチェックボックスを選択し、`[Highlight Influential Rows in PCP]` をクリック。
   - PCP画面へ遷移し、その回答者の全軸プロファイルが赤色太線でハイライト表示される。回答時間が極端に短いか、他設問で矛盾した回答をしていないかを視覚的に精査できる。
2. **疑わしい回答者の除外シミュレーション (`Exclude Checked & Re-evaluate`)**:
   - 不正または特異な外れ値と判明した回答者をチェックし、ワンクリックで一時除外。
   - 即座に結論が再計算され、結論の有意性や推定量が維持されるかをリアルタイム検証可能。
3. **他機能からの1クリック診断呼び出し**:
   - Feature 01（自動マイニング）のインサイト詳細や、Feature 04（KDA）のドライバーランキングから `[Check Robustness]` ボタンを押すだけで、自動的に結論レジストリへ登録され本画面へジャンプする。

## 7. エッジケースと対処

| ケース | 対処 |
|---|---|
| 品質スコアなし | 4.1 を無効化し、他の戦略のみ実行。警告表示 |
| 重みなし | 4.4 を無効化 |
| 結論が1件も登録されていない | 「先に分析を実行してください」を表示 |
| 回答者数が極小（n<100） | ブートストラップ・除去スイープの信頼性が低い旨の警告 |
| 影響関数が定義不能な結論（非線形） | フル再計算にフォールバック（遅延警告） |
| 摂動でグループが空になる | その摂動結果を `null` とし、`flipped` は「評価不能」と記録 |

## 8. パフォーマンス要件

- 影響関数（解析的）を優先し、ジャックナイフのフル再計算を避ける。
- ブートストラップは並列化（joblib / multiprocessing）。
- 大規模データでは「主要結論のみ全戦略、残りは除去スイープのみ」という2段階モードを用意。
- 目標: 主要KPI 5件 + 発見20件に対して、10万行で 60秒以内。

## 9. 依存ライブラリ（Python 想定）

- `numpy`, `pandas` / `polars`
- `statsmodels`（影響診断: `OLSInfluence`, Cook's distance, DFBETAS）
- `joblib`（並列化）

## 10. テスト計画

**単体テスト:**

1. 影響関数: 平均に対する影響度が手計算 `(μ - x_i)/(n-1)` と一致するか。
2. flip 判定: 各結論型の反転条件が正しく判定されるか。
3. グレード分類: `flip_rate` から正しいグレードが付与されるか。
4. 除去スイープ: 既知データで除去後の再計算値が手計算と一致するか。

**統合テスト（合成データ）:**

5. 「頑健な結論」（大規模・明確な差）と「脆い結論」（少数の外れ値に依存する差）を埋め込み、前者が robust、後者が fragile と判定されるか。
6. 品質スコア下位30%除去で覆る結論が正しく fragile になるか。

**受入基準:**

- 影響関数とフル再計算の結果が、線形統計量で 1e-6 以内で一致。
- 埋め込んだ「脆い結論」が fragile と判定される再現率 > 0.9。
- タイムアウトなしで完了。
