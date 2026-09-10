<実装計画書: 順序尺度分析とLikertビュー>
文書ID: DAVIS-FEAT-022
版: 1.0.0
作成日: 2026-09-07
優先度: 2
前提仕様: DAVIS-FEAT-017
実装タスク・引き継ぎ: [tasks/DAVIS-FEAT-021-022.md](../tasks/DAVIS-FEAT-021-022.md#feature-22-順序尺度分析とlikertビュー)
対象コンポーネント: 
- fullstack/backend/app/algorithms/mining/modern_subgroup.py
- fullstack/backend/app/algorithms/mining/subgroup.py
- fullstack/backend/app/algorithms/summaries/core.py
- fullstack/backend/app/algorithms/relationships/surprise.py
- fullstack/frontend/src/features/distribution/LikertComparisonPage.tsx

---

## 1. 概要・目的
監査の指摘に基づき、Likert型などの順序尺度変数（ordinal）に対して、適切な統計手法（ノンパラメトリック検定、順位相関）を自動選択する機能を導入する。また、それらを比較・可視化するための専用ビューとして「Diverging Stacked Bar Chart（分岐積み上げ棒グラフ）」を追加する。これにより、順序尺度データを正しく評価し、単峰性と二極化の違いなどを視覚的に容易に判別できるようにする。

## 2. 要件定義

### A. 分析経路の自動選択
コードブックの `scaleType` に応じて検定・効果量を自動選択する。

| 分析場面 | ordinal | nominal | numeric |
|---|---|---|---|
| 2群比較 | Mann-Whitney U / Cliff's delta | χ² / Cramér's V | Welch t / Cohen's d |
| 多群比較 | Kruskal-Wallis / ε² | χ² / Cramér's V | Welch ANOVA / η² |
| 相関 | Kendall τb | Cramér's V | Pearson r |
| 記述統計 | 中央値, IQR, Top/Bottom-box | 最頻値 | 平均, SD |

- **平均の扱い**: 順序尺度に対して平均を計算する場合は一律禁止とせず、数値近似であることを明示するため「等間隔得点として計算」という注記を自動付与する。

### B. Diverging Stacked Bar Chart
- 順序尺度の複数設問を横並びに比較する。
- 中立カテゴリ（例：3=どちらでもない）を中央に配置する（奇数カテゴリの中央値を自動検出）。
- 左右にネガティブ/ポジティブの帯を展開する。
- Top-2-Boxを右端に数値表示する。
- 同じ平均値であっても単峰と二極化の違いが一目で判別できるような色分けと配置を行う。
- **PCPへのリンク**: バーの特定カテゴリをクリックすることで、該当する回答者をPCP（平行座標プロット）で選択状態にする。

## 3. GUI設計（ASCIIモックアップ付き）

```text
+-----------------------------------------------------------------------------------------+
| [ Likert Comparison View ]                                                              |
|                                                                                         |
| Sort by: [ Top-2 Box (Desc) ▼ ]  Filter: [ Ordinal Variables Only ☒ ]                   |
|                                                                                         |
|                   Negative <-------------- | --------------> Positive         Top-2 Box |
|                                                                                         |
| Q1: Satisfaction  [███ 15%][█████ 25%]  [■ 10%]  [████████ 40%][██ 10%]          50%    |
|                                                                                         |
| Q2: Usability        [██████ 30%][██ 10%] [■ 5%] [████ 20%][███████ 35%]         55%    |
|                                                                                         |
| Q3: Performance     [█ 5%][████ 20%]   [███ 15%]    [███████████████ 60%]        60%    |
|                                                                                         |
| * Click on any category segment to select respondents in Parallel Coordinates Plot      |
+-----------------------------------------------------------------------------------------+
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）
既存のAPIエンドポイントを変更せず、バックエンド内部でのアルゴリズム選択を拡張する。
レスポンスに選択された検定方法や注記を含めるように拡張する。

**例: `/api/v1/mining/subgroup` のレスポンス拡張**
```json
{
  "target": "Q1_Satisfaction",
  "scaleType": "ordinal",
  "comparison": {
    "groupA": "Group 1",
    "groupB": "Group 2"
  },
  "statistics": {
    "testUsed": "Mann-Whitney U",
    "effectSize": "Cliff's delta",
    "p_value": 0.035,
    "effect_value": 0.42,
    "mean_note": "等間隔得点として計算"
  }
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）

- **`fullstack/backend/app/algorithms/mining/modern_subgroup.py` & `fullstack/backend/app/algorithms/mining/subgroup.py`**
  - 変数の `scaleType` を確認するロジックを追加。
  - `scaleType == 'ordinal'` の場合、2群比較では `scipy.stats.mannwhitneyu` を使用し、効果量として Cliff's delta を計算。多群比較では `scipy.stats.kruskal` を使用する。

- **`fullstack/backend/app/algorithms/summaries/core.py`**
  - `scaleType == 'ordinal'` の場合の記述統計処理を追加。中央値、IQR、Top/Bottom-boxの計算を実装。
  - 平均を計算するルートでは、出力結果のメタデータに `mean_note: "等間隔得点として計算"` を付与。

- **`fullstack/backend/app/algorithms/relationships/surprise.py`**
  - 相関計算時に `scaleType` を参照し、ordinal同士またはordinalとnumericの場合は Kendall τb (`scipy.stats.kendalltau`) を使用するよう分岐を追加。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）

- **`fullstack/frontend/src/features/distribution/LikertComparisonPage.tsx`**
  - 新規ページコンポーネント。Reduxストアからコードブックと集計データを取得する。
  - 順序尺度（`scaleType === 'ordinal'`）の変数のみをフィルタリングする機能。
  - 中立カテゴリの自動検出機能（カテゴリ数が奇数の場合、中央のインデックスを中立とする）。
  - ソートオプション（Top-2降順、平均降順、元順）のステート管理。
  - Diverging Stacked Barの実装（中立を中心に左右にスタックするようデータを変換して描画）。
  - バーの各セグメントに対する `onClick` ハンドラを実装し、ReduxアクションをディスパッチしてPCPと連動させる。

- **ナビゲーションの追加**
  - メインナビゲーションに「Likert Comparison」のタブを追加する。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）

**バックエンド (pytest)**
- `test_ordinal_uses_mann_whitney`: `scaleType="ordinal"` の変数を用いた2群比較をリクエストし、レスポンスの `testUsed` が "Mann-Whitney U" であることを検証する。
- `test_numeric_uses_welch`: `scaleType="numeric"` の変数を用いた2群比較で、"Welch t" が選ばれることを検証する。
- `test_ordinal_correlation_uses_kendall`: 順序尺度変数間の相関計算リクエストで "Kendall τb" が使用されることを検証する。
- `test_mean_note_for_ordinal`: 順序尺度で平均値を要求した際、レスポンスに `mean_note`（等間隔得点として計算）が含まれることを検証する。

**フロントエンド (Vitest)**
- `test_diverging_chart_symmetry`: 中立カテゴリが設定されたデータに対して、Diverging Stacked Bar用データ変換関数が正しく左右対称にマッピングすることを検証する。
- `test_neutral_category_detection`: カテゴリ配列から中央の要素を正しく中立として識別するロジックを検証する。

## 8. 実装手順チェックリスト（エージェントが順に実行する手順）
- [ ] 1. バックエンド `summaries/core.py` を修正し、ordinalの記述統計計算と平均への注記追加を実装する。
- [ ] 2. バックエンド `mining/subgroup.py` および `modern_subgroup.py` を修正し、2群・多群比較時の検定分岐（Mann-Whitney等）を実装する。
- [ ] 3. バックエンド `relationships/surprise.py` を修正し、相関計算時の分岐（Kendall τb等）を実装する。
- [ ] 4. 上記のバックエンド機能に対するpytestを作成・実行し、パスすることを確認する。
- [ ] 5. フロントエンドに `LikertComparisonPage.tsx` を新規作成し、Diverging Stacked Bar Chartの骨組みを実装する。
- [ ] 6. フロントエンドにフィルタリング、ソート、中立カテゴリ検出ロジックを追加し、Vitestを作成して検証する。
- [ ] 7. グラフのセグメントクリック時にPCPと連動するアクションを実装する。
- [ ] 8. アプリケーションのナビゲーションに LikertComparisonPage へのリンクを追加する。
- [ ] 9. アプリを起動し、E2EでLikertビューが正しく表示され、PCP連携とソートが機能することを確認する。
