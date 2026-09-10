<実装計画書: 探索/検証モード分離と感度分析>
文書ID: DAVIS-FEAT-024
版: 1.0.0
作成日: 2026-09-07
優先度: 3
前提仕様: なし
実装タスク・引き継ぎ: [tasks/DAVIS-FEAT-023-024.md](../tasks/DAVIS-FEAT-023-024.md#feature-24-実装仕様)
対象コンポーネント: 
- fullstack/backend/app/algorithms/robustness/engine.py
- fullstack/backend/app/api/robustness.py
- fullstack/backend/app/api/mining.py
- fullstack/frontend/src/features/robustness/RobustnessPage.tsx
- fullstack/frontend/src/features/mining/ModernSubgroupMiningView.tsx
- fullstack/frontend/src/features/mining/SubgroupMiningPage.tsx

---

## 1. 概要・目的
監査指摘に基づき、同一データを用いた条件探索と確証的検定（p値）の混同を解消する。探索的データ分析（EDA）で得られた「候補」には、過剰適合を避けるため「探索的」であることを明示し、p値を非表示にする（探索モード）。一方、独立したデータ等を用いて仮説を検証する場合のための「検証モード」を導入する。
また、現在のロバストネス評価における「品質下位」という呼称を、実態に合わせて「数値的外れ度に基づく感度分析」に改名し、外れ値フラグによる自動除外から、除外前後の結論比較（感度分析）へと機能を変更する。

## 2. 要件定義

### 要件A: 探索/検証モードの明示的区別
- **探索モード（既定）**:
  - 全データを用いて差の大きさ・分布差を発見する。
  - 結果には「🔍 探索的候補」バッジを表示。
  - p値は表示・計算せず、効果量（差の大きさ等）に焦点を当てる。
  - 注記：「この結果は全データ上の探索であり、母集団への確証ではありません」を明記。
- **検証モード**:
  - ユーザーが明示的に選択した場合のみ実行。
  - 独立データやホールドアウト法、交差検証を用いて、固定候補の統計的評価を行う。
  - 信頼区間と多重比較補正されたp値（BH-FDR等）を表示。
- 探索から検証への遷移ボタンを提供。
- 検証モード設定ダイアログを用意。

### 要件B: 外れ値と回答品質の区別
- 現在の「品質下位」という判定指標（標準化偏差による）を「数値的外れ度に基づく感度分析」に改名。
- 対象データを自動除外するのではなく、除外前後の結論を比較する感度分析を実装。
- 感度分析パネルにて、全データを用いた結果と、外れ値を除外した場合の結果を並列表示。

## 3. GUI設計（ASCIIモックアップ付き）

### 3.1 探索的候補カード (ModernSubgroupMiningView)
```text
+-------------------------------------------------------------+
| 🔍 探索的候補 (探索モード)                                    |
+-------------------------------------------------------------+
|  条件: A = "High" AND B > 10                                |
|  効果量: +2.5                                               |
|                                                             |
|  [!] この結果は全データ上の探索であり、母集団への確証では     |
|      ありません。                                           |
|                                                             |
|  [ 検証モードへ移行 (Holdout等で評価) ]                     |
+-------------------------------------------------------------+
```

### 3.2 検証モード設定ダイアログ
```text
+-------------------------------------------------------------+
| 検証モードの設定                                            |
+-------------------------------------------------------------+
| 評価方法:                                                   |
|  (*) ホールドアウト分割 (学習 70% / 検証 30%)               |
|  ( ) 交差検証 (k=5)                                         |
|  ( ) 独立データ指定 [ ファイルを選択... ]                   |
|                                                             |
| 多重比較補正:                                               |
|  [v] Benjamini-Hochberg (FDR)                               |
|                                                             |
|                                     [ キャンセル ] [ 実行 ] |
+-------------------------------------------------------------+
```

### 3.3 感度分析パネル (RobustnessPage)
```text
+-------------------------------------------------------------+
| 数値的外れ度に基づく感度分析                                |
+-------------------------------------------------------------+
| 指標: 標準化偏差に基づく除外                                |
|                                                             |
| 【分析結果の比較】                                          |
|                                                             |
| 項目          | 全データ (N=1000)   | 外れ値除外 (N=980)    |
|---------------+---------------------+-----------------------|
| 平均差        | +2.5                | +2.4                  |
| 信頼区間(95%) | [1.2, 3.8]          | [1.5, 3.3]            |
| 結論の方向性  | 有意な差あり        | 有意な差あり          |
|                                                             |
| [結論] 外れ値を除外しても、主要な結果の方向性は変化しません。|
+-------------------------------------------------------------+
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）

### 4.1 マイニングAPI (探索/検証モード)
**エンドポイント**: `POST /api/v1/mining/subgroups`

**リクエスト例**:
```json
{
  "target_column": "score",
  "features": ["A", "B", "C"],
  "mode": "exploration",
  "verification_config": {
    "method": "holdout",
    "test_size": 0.3,
    "correction": "bh-fdr"
  }
}
```

**レスポンス例 (探索モード)**:
```json
{
  "mode": "exploration",
  "results": [
    {
      "condition": "A == 'High'",
      "effect_size": 2.5,
      "p_value": null,
      "confidence_interval": null,
      "is_exploratory": true
    }
  ]
}
```

### 4.2 ロバストネス・感度分析API
**エンドポイント**: `POST /api/v1/robustness/sensitivity`

**リクエスト例**:
```json
{
  "target_column": "score",
  "condition": "A == 'High'",
  "outlier_method": "standardized_deviation"
}
```

**レスポンス例**:
```json
{
  "method": "standardized_deviation",
  "baseline": {
    "n": 1000,
    "effect_size": 2.5,
    "confidence_interval": [1.2, 3.8]
  },
  "sensitivity": {
    "n": 980,
    "effect_size": 2.4,
    "confidence_interval": [1.5, 3.3]
  },
  "is_robust": true
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）

- **`fullstack/backend/app/algorithms/robustness/engine.py`**:
  - `QualityEvaluator` クラス等の名称を `SensitivityAnalyzer` に変更するか、ロジック内の「品質下位(Low Quality)」といった文言を「数値的外れ度(Numerical Outlier)」にリファクタリング。
  - 外れ値の自動除外処理を削除し、全データと除外データの両方に対する指標（平均、効果量、CIなど）を並行して計算・比較する `run_sensitivity_analysis()` メソッドを追加。
- **`fullstack/backend/app/api/robustness.py`**:
  - 上記の感度分析エンジンを呼び出す新しいエンドポイント `POST /sensitivity` を実装。
- **`fullstack/backend/app/api/mining.py`**:
  - リクエストスキーマを拡張し、`mode` (exploration/verification) を受け付けるようにする。
  - `mode == "exploration"` の場合はp値計算をスキップし、`p_value = null` で返す。
  - `mode == "verification"` の場合は指定された手法（ホールドアウト等）でデータを分割し、補正付きp値を計算する。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）

- **`fullstack/frontend/src/features/robustness/RobustnessPage.tsx`**:
  - タイトルとラベル「品質下位」を「数値的外れ度に基づく感度分析」に変更。
  - 新たに `SensitivityComparisonPanel` コンポーネントを導入し、ベースライン（全データ）と感度（外れ値除外後）のメトリクスを比較表でレンダリング。
- **`fullstack/frontend/src/features/mining/SubgroupMiningPage.tsx`**:
  - 状態管理（Redux またはローカルstate）に `miningMode: 'exploration' | 'verification'` を追加。
  - 検証モード設定用のモーダル (`VerificationConfigModal`) を実装。
- **`fullstack/frontend/src/features/mining/ModernSubgroupMiningView.tsx`**:
  - 各結果カードのヘッダーに条件付きで「🔍 探索的候補」バッジをレンダリング。
  - 探索モード時はp値の表示部分を隠すか、「（探索モードのため非表示）」と表示。
  - 「検証モードへ移行」ボタンを設置し、クリック時に `VerificationConfigModal` を開く。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）

- **pytest単体テスト**:
  - `test_exploration_mode_no_pvalue`: 探索モード（mode="exploration"）でAPIを呼び出し、レスポンス内の `p_value` が `null` または含まれないことを検証。
  - `test_verification_mode_with_holdout`: 検証モード（mode="verification", method="holdout"）でAPIを呼び出し、分割データに対するp値とCIが計算され返却されることを検証。
  - `test_robustness_rename`: `Robustness` エンジンにおけるカテゴリ名や出力キー名が "low_quality" から "numerical_outlier" 等に変更されていることを検証。
  - `test_sensitivity_comparison`: `run_sensitivity_analysis` 関数が、ベースラインと除外後の両方の結果を正しく辞書型で返すことを検証。
- **Vitest単体テスト**:
  - `ModernSubgroupMiningView`: 探索モード時にバッジが表示されること、p値が表示されないことの検証。
  - `SensitivityComparisonPanel`: プロップスとして渡されたベースラインと感度のデータが正しく表にマッピングされることの検証。
- **E2Eシナリオ (Playwright/Cypress)**:
  - ユーザーがマイニングを実行し、探索的候補が表示される -> 検証モードへの移行ボタンを押下 -> ホールドアウト設定で実行 -> 検証結果（p値あり）が表示されるまでの一連の流れを確認。

## 8. 実装手順チェックリスト（エージェントが順に実行する手順）

1. [ ] `backend/app/api/mining.py` および関連するマイニングエンジンのリクエスト/レスポンススキーマを更新し、`mode` パラメータと `verification_config` を追加する。
2. [ ] 探索モードのロジック（p値非表示・計算スキップ）をバックエンドに実装する。
3. [ ] 検証モードのロジック（データ分割、BH-FDR等でのp値計算）をバックエンドに実装する。
4. [ ] pytestにて、マイニングAPIの探索・検証モード切り替えに関するテスト (`test_exploration_mode_no_pvalue`, `test_verification_mode_with_holdout`) を追加・実行する。
5. [ ] `backend/app/algorithms/robustness/engine.py` の「品質」ロジックを「数値的外れ度」に改名し、感度分析ロジック (`run_sensitivity_analysis`) を追加する。
6. [ ] `backend/app/api/robustness.py` に感度分析用エンドポイントを追加する。
7. [ ] pytestにて、感度分析エンジンのテスト (`test_robustness_rename`, `test_sensitivity_comparison`) を追加・実行する。
8. [ ] フロントエンドの API クライアント (RTK Query 等) の型定義を更新し、バックエンドの変更を反映させる。
9. [ ] `frontend/src/features/mining/SubgroupMiningPage.tsx` および `ModernSubgroupMiningView.tsx` に探索バッジ、注記、検証モード遷移UIを実装する。
10. [ ] 検証モード設定ダイアログコンポーネントを作成し、APIに正しくパラメータが渡るように接続する。
11. [ ] `frontend/src/features/robustness/RobustnessPage.tsx` のUIを更新し、外れ値の自動除外ではなく感度分析パネルによる比較表示を実装する。
12. [ ] Vitestにてフロントエンドコンポーネントの単体テストを追加・実行する。
