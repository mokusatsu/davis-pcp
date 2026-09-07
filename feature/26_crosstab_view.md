<実装計画書: 2変量クロス集計表と調整済み残差ビュー>
文書ID: DAVIS-FEAT-026
版: 1.0.0
作成日: 2026-09-07
優先度: 2
前提仕様: DAVIS-FEAT-017, DAVIS-FEAT-019
対象コンポーネント: 
- fullstack/backend/app/algorithms/summaries/
- fullstack/backend/app/api/
- fullstack/frontend/src/features/crosstab/
- fullstack/frontend/src/components/Navigation/

---

## 1. 概要・目的
アンケート分析の実務において基本的な集計である「2変量クロス集計表（Crosstab）」を提供する。行%、列%、全体%、実数の表示切り替えに加え、調整済み残差（Adjusted Standardized Residuals: ASR）を算出し、有意なセルを自動でハイライトする残差分析の機能を持つ。Mosaicプロットに加えてフォーマルな数値クロス集計表を追加し、より詳細なEDAを可能にする。

## 2. 要件定義
1. **クロス集計表マトリクス**:
   - 表頭（横軸変数） × 表側（縦軸変数）の2次元集計をサポート。
   - 表示切替: (1) 行パーセント (Row %), (2) 列パーセント (Col %), (3) 全体パーセント (Total %), (4) 実度数 (Count)
   - 各セルの度数、パーセント、調整済み標準化残差（ASR）の算出。
2. **統計的検定とハイライト**:
   - カイ二乗独立性検定による統計量（χ²値, 自由度df, p値）およびCramér's V（効果量）の算出。
   - 期待度数が 5 未満のセル比率判定と警告（20%超の場合は警告表示またはFisher正確検定）。
   - 調整済み残差によるセルの自動ハイライト機能: |ASR| ≥ 1.96 (p < .05: *), |ASR| ≥ 2.58 (p < .01: **) を色分け表示。
3. **アンケート基盤との統合**:
   - コードブックで定義された値ラベル・カテゴリ順序の反映。
   - 調査ウェイトの適用（加重度数・加重%での集計）。
   - 設問別の分母制御（無回答・非該当の除外）。
   - 小標本（セル度数・周辺度数 n < 30）での警告バッジ表示。
4. **PCP・選択行とのインタラクション**:
   - セルクリックによる該当回答者のPCP上でのブラッシング選択（Add/Replace/Toggle）。
   - 共通行スコープ（All / Active / Selected / Sampled）の適用。
   - CSVおよびExcel形式でのクロス集計表のエクスポート。

## 3. GUI設計（ASCIIモックアップ付き）
```
+-----------------------------------------------------------------------------------+
|  [ Crosstab (クロス集計) ]                                                         |
|-----------------------------------------------------------------------------------|
|                                                                                   |
|  [Row Variable (表側) v]  [Col Variable (表頭) v]   [Weight Column v]             |
|  [Scope: Active v]  [Missing Policy: Exclude v]    [Export ▼] [To PCP Action]     |
|                                                                                   |
|  [ Tab: Row % | Col % | Total % | Count ]                                         |
|                                                                                   |
|  +----------------+--------------------------+--------------------------+-------+ |
|  |                | Col Variable (Q2)        |                          |       |
|  | Row Var (Q1)   | Category A | Category B  | Category C | ...         | Total | |
|  +----------------+------------+-------------+------------+-------------+-------+ |
|  | Label 1        | 35.0% *    | 40.0%       | 25.0% **   |             | 100%  | |
|  |                | (n=35)     | (n=40)      | (n=25)     |             | (100) | |
|  +----------------+------------+-------------+------------+-------------+-------+ |
|  | Label 2        | 10.0% **   | 80.0% **    | 10.0%      |             | 100%  | |
|  |                | (n=10)     | (n=80)      | (n=10)     |             | (100) | |
|  +----------------+------------+-------------+------------+-------------+-------+ |
|  | Total          | 22.5%      | 60.0%       | 17.5%      |             | 100%  | |
|  |                | (n=45)     | (n=120)     | (n=35)     |             | (200) | |
|  +----------------+------------+-------------+------------+-------------+-------+ |
|                                                                                   |
|  [ 統計検定サマリー ]                                                             |
|  χ² = 34.56, df = 2, p < 0.001 (***)  | Cramér's V = 0.41                         |
|  ! 警告: 期待度数5未満のセルが0%です。                                            |
+-----------------------------------------------------------------------------------+
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）

### `POST /api/v1/summaries/crosstab`

**リクエストJSON**
```json
{
  "datasetId": "dataset-uuid",
  "rowVariableId": "var_q1",
  "colVariableId": "var_q2",
  "scope": "active",
  "weightColumn": "weight_var",
  "missingPolicy": "exclude"
}
```

**レスポンスJSON**
```json
{
  "cells": [
    {
      "rowLabel": "Label 1",
      "colLabel": "Category A",
      "count": 35,
      "rowPct": 35.0,
      "colPct": 77.8,
      "totalPct": 17.5,
      "expectedCount": 22.5,
      "asr": 3.42,
      "isSignificant": "**",
      "rowIds": [1, 5, 12, "..."]
    }
  ],
  "rowTotals": [
    { "label": "Label 1", "count": 100, "totalPct": 50.0 }
  ],
  "colTotals": [
    { "label": "Category A", "count": 45, "totalPct": 22.5 }
  ],
  "grandTotal": 200,
  "chi2": 34.56,
  "df": 2,
  "pValue": 0.0003,
  "cramersV": 0.41,
  "warnings": []
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）

1. `fullstack/backend/app/algorithms/summaries/crosstab.py` (新規)
   - クロス集計計算ロジック（pandasの`crosstab`や`scipy.stats.chi2_contingency`を利用）。
   - Adjusted Standardized Residuals (ASR) の計算。
   - 調査ウェイトが存在する場合の加重クロス集計（`statsmodels`等の対応関数、または加重合計を手動で計算してχ²検定）。
2. `fullstack/backend/app/api/summaries.py` (既存)
   - `/crosstab` エンドポイントを新規追加。
   - リクエストのバリデーションと `crosstab.py` への処理委譲。レスポンスの生成。
3. `fullstack/backend/app/schemas/summaries.py` (既存、あれば)
   - Crosstabのリクエスト・レスポンススキーマ（Pydanticモデル）を定義。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）

1. `fullstack/frontend/src/features/crosstab/CrosstabPage.tsx` (新規)
   - クロス集計ビュー全体を囲むページコンポーネント。
   - 上部の変数選択・オプション選択パネルと下部の結果表示領域を構成。
2. `fullstack/frontend/src/features/crosstab/CrosstabTable.tsx` (新規)
   - Ant Design の `Table` や カスタムグリッドを用いてクロス集計表を描画。
   - セルコンポーネントでASRに基づく色分け（赤：有意に高い、青：有意に低い等）とアスタリスクを表示。
   - クリックイベントで該当セルの `rowIds` を抽出し、PCPの選択状態を更新する。
3. `fullstack/frontend/src/features/crosstab/crosstabSlice.ts` (新規、または既存storeへの追加)
   - APIコールの状態管理（RTK Query推奨）。
   - 現在の表示モード（Row %, Col %, Total %, Count）の状態保持。
4. `fullstack/frontend/src/components/Navigation/TopMenu.tsx` (既存)
   - タブまたはメニューに「Crosstab」を追加。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）

- **pytest (バックエンド)**:
  - `test_crosstab_row_col_total_pct`: 行%、列%、全体%の各計算値が正しいか（合計が100%になること）。
  - `test_adjusted_standardized_residuals`: ASRの算出値がRやSPSSの出力と一致するかどうか。
  - `test_crosstab_with_weights`: 調査ウェイトを適用した際に、加重度数と加重%が正しく計算されることの検証。
  - `test_crosstab_chi2_warning`: 期待度数 < 5 のセルが20%を超えた場合の警告メッセージの生成検証。
- **Vitest (フロントエンド)**:
  - `CrosstabTable.test.tsx`: 集計モードの切り替えにより、セル内に適切な値（% または 数値）が表示されること。
  - `CrosstabTable_click.test.tsx`: セルをクリックした際に、PCP選択（ブラッシング）アクションが正しくディスパッチされること。
- **E2E (Playwright等)**:
  - `crosstab_scenario`: ユーザーが表側と表頭の変数を選択し、クロス表が表示され、有意なセルがハイライトされるまでの一連のフロー。

## 8. 実装手順チェックリスト（エージェントが順に実行する手順）

- [ ] 1. バックエンド: `backend/app/schemas/summaries.py` にCrosstabのPydanticスキーマを追加
- [ ] 2. バックエンド: `backend/app/algorithms/summaries/crosstab.py` にASR計算・クロス集計ロジックを実装
- [ ] 3. バックエンド: `backend/app/api/summaries.py` に `/crosstab` エンドポイントを追加
- [ ] 4. バックエンド: 単体テスト（pytest）の作成と実行
- [ ] 5. フロントエンド: API通信用エンドポイントを定義（RTK Query設定）
- [ ] 6. フロントエンド: `CrosstabTable.tsx` コンポーネントの実装（ASRハイライト・表示切替含む）
- [ ] 7. フロントエンド: `CrosstabPage.tsx` コンポーネントの実装（変数セレクタ・検定サマリー含む）
- [ ] 8. フロントエンド: ナビゲーションメニューにCrosstabタブを追加
- [ ] 9. フロントエンド: セルクリック時のPCP連動処理（PCPのRedux slice呼び出し）を実装
- [ ] 10. フロントエンド: 単体テスト（Vitest）の作成と実行
