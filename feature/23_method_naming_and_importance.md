<実装計画書: 手法名称の正確化と特徴重要度の分離表示 (DAVIS-FEAT-023)>
文書ID: DAVIS-FEAT-023
版: 1.0.0
作成日: 2026-09-07
優先度: 3
前提仕様: なし
実装タスク・引き継ぎ: [tasks/DAVIS-FEAT-023-024.md](../tasks/DAVIS-FEAT-023-024.md#feature-23-実装仕様)
対象コンポーネント: 
- fullstack/backend/app/algorithms/mining/feature_ranking.py
- fullstack/backend/app/algorithms/imputation/tabdiff.py
- fullstack/backend/app/algorithms/relationships/surprise.py
- fullstack/frontend/src/features/mining/FeatureRankingPage.tsx
- fullstack/frontend/src/features/relationships/SurpriseAssociationView.tsx
- fullstack/frontend/src/features/dataset/ImputationModal.tsx

---

## 1. 概要・目的
監査で指摘された独自近似法の標準的な統計量名への正確化、および特徴重要度におけるMDIとPermutation Importanceの混合表示の解消を目的とする。手法の名称を実際の計算に基づくものに修正または計算方法を標準に合わせる。さらに、それぞれ意味合いの異なる重要度指標を分離して表示することで、ユーザーの誤解を防ぐ。

## 2. 要件定義
### 要件A: 手法名称の正確化
以下の各指標について、名称の変更または計算式の標準化を実施する。
- **TabDiff**: ガウス条件付き平均+周辺頻度による計算であるため、「実験的条件付き補完」に改名し、UI説明文も更新する。
- **Φk**: 補正Cramér's V型指標となっているため、「補正V」に改名するか、公式Φk実装を導入する。
- **相互情報量(教師なし)**: 平均絶対Pearson相関による近似となっているため、「平均絶対相関」に改名する。
- **Wasserstein距離**: 平均差の絶対値による計算となっているため、「平均差」に改名するか、`scipy.stats.wasserstein_distance` を使用するように修正する。
- **ReliefF(教師なし)**: 分散による計算となっているため、「分散」に改名する。

各指標名の横に「ⓘ」アイコンを配置し、クリックで計算式と適用範囲の説明をツールチップ表示する。

### 要件B: 特徴重要度の分離表示
MDI (Gini/Entropy) と Permutation Importance を混合せず個別に表示する。
- `feature_ranking.py:315-326` の混合平均を削除する。
- フロントエンドにて並列表示（左にMDIバー、右にPermutationバー）を行う。
- 以下の注意書きをUI上に表示する：
  - 「訓練データ上の重要度は予測への貢献であり、因果効果ではない」
  - 「相関した変数間では重要度が分散する場合がある」

## 3. GUI設計（ASCIIモックアップ付き）
```
================================================================================
 特徴重要度ダッシュボード (Feature Ranking)
================================================================================
 ⚠️ 注意事項:
  - 訓練データ上の重要度は予測への貢献であり、因果効果ではありません。
  - 相関した変数間では重要度が分散する場合があります。

 ------------------------------------------------------------------------------
  MDI (Mean Decrease Impurity) ⓘ            |  Permutation Importance (train) ⓘ
 ------------------------------------------------------------------------------
  [高カーディナリティ特徴にバイアス]           |  [過学習の影響を受ける]
                                            |
  Feature_A | ███████████████ 0.35          |  Feature_B | █████████████ 0.28
  Feature_B | ██████████      0.22          |  Feature_A | █████████     0.19
  Feature_C | █████           0.12          |  Feature_C | ████          0.08
  Feature_D | ███             0.07          |  Feature_D | ██            0.05
 ------------------------------------------------------------------------------

 [ツールチップ例: MDI ⓘ クリック時]
 +---------------------------------------------------+
 | MDI (Gini/Entropy)                                |
 | 訓練データ内での不純度減少量を測定します。        |
 | 高カーディナリティ（カテゴリ数が多い等）の        |
 | 特徴量に対して過大評価するバイアスがあります。    |
 +---------------------------------------------------+
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）
**エンドポイント**: `GET /api/v1/mining/feature-ranking`

**レスポンスJSON**:
```json
{
  "ranking": {
    "mdi": [
      {
        "feature_name": "Feature_A",
        "importance": 0.35
      },
      {
        "feature_name": "Feature_B",
        "importance": 0.22
      }
    ],
    "permutation_train": [
      {
        "feature_name": "Feature_B",
        "importance": 0.28
      },
      {
        "feature_name": "Feature_A",
        "importance": 0.19
      }
    ]
  },
  "metadata": {
    "warnings": [
      "訓練データ上の重要度は予測への貢献であり、因果効果ではない",
      "相関した変数間では重要度が分散する場合がある"
    ]
  }
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）
- **`fullstack/backend/app/algorithms/mining/feature_ranking.py`**
  - 行315-326付近のMDIとPermutation Importanceの混合平均を算出しているロジックを削除する。
  - レスポンスの構造を改修し、MDIとPermutation Importanceをそれぞれ独立した配列で返す。
  - 「相互情報量(教師なし)」の出力を「平均絶対相関」に変更する。
  - 「ReliefF(教師なし)」の出力を「分散」に変更する。
- **`fullstack/backend/app/algorithms/imputation/tabdiff.py`**
  - 「TabDiff」というアルゴリズム名を「実験的条件付き補完」に変更してレスポンスに含める。
  - 「Wasserstein距離」という名称を「平均差」に変更するか、または `scipy.stats.wasserstein_distance` を利用して正しい計算に置き換える。
- **`fullstack/backend/app/algorithms/relationships/surprise.py`**
  - 「Φk」を「補正V」に変更するか、公式のΦk実装を利用するように更新する。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）
- **`fullstack/frontend/src/features/mining/FeatureRankingPage.tsx`**
  - `ranking` のレスポンスを2つの配列（`mdi`, `permutation_train`）として受け取るよう型定義を更新。
  - レイアウトを2列（CSS Grid または Flexbox）に変更し、左列にMDI、右列にPermutation Importanceのバーグラフを並列表示する。
  - 画面上部に注意事項のテキストコンポーネントを追加する。
  - 「相互情報量(教師なし)」のラベル表示を「平均絶対相関」、「ReliefF(教師なし)」を「分散」に変更し、横にⓘアイコンとTooltip（Ant Designの`Tooltip`など）を配置する。
- **`fullstack/frontend/src/features/relationships/SurpriseAssociationView.tsx`**
  - 「Φk」のラベル表示を「補正V」に変更し、計算式と適用範囲のTooltipを追加。
- **`fullstack/frontend/src/features/dataset/ImputationModal.tsx`**
  - 補完手法の選択肢から「TabDiff」を「実験的条件付き補完」に変更し、説明文を更新する。Tooltipを追加。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）
- **バックエンドテスト (pytest)**:
  - `test_mdi_and_permutation_separate`: `/api/v1/mining/feature-ranking` のレスポンスにおいて、MDIとPermutation Importanceが別々の配列（`mdi`, `permutation_train`）として返ることを検証。
  - `test_no_mixed_importance`: 混合平均スコアが計算・返却されないことを検証。
  - `test_unsupervised_mi_label`: 教師なしMIのラベルとして「平均絶対相関」が返ることを検証。
  - `test_phik_label`: Phikのラベルとして「補正V」（あるいは公式名）が返ることを検証。
  - `test_wasserstein_or_rename`: wasserstein距離が「平均差」または `scipy.stats.wasserstein_distance` に基づく正しい計算結果になっていることを検証。
- **フロントエンドテスト (Vitest/RTL)**:
  - `FeatureRankingPage` のレンダリングテスト: 2列の重要度バーと注意事項が正しく表示されること。
  - 各Tooltipコンポーネントの表示テスト。
- **E2Eシナリオ**:
  - 特徴量重要度画面を開き、MDIとPermutation Importanceが正しく分かれて表示され、ツールチップをホバーしたときに説明が表示されることを確認。

## 8. 実装手順チェックリスト（エージェントが順に実行する手順）
1. [ ] `feature_ranking.py` を修正し、混合平均の削除、およびMDIとPermutationの分離出力化を行う。
2. [ ] `feature_ranking.py` にて、教師なしMIおよびReliefFの名称（ラベル）を「平均絶対相関」「分散」に更新する。
3. [ ] `tabdiff.py` を修正し、「TabDiff」を「実験的条件付き補完」に名称変更し、Wasserstein距離の名称変更または計算修正を行う。
4. [ ] `surprise.py` を修正し、Φkを「補正V」に名称変更または公式実装化する。
5. [ ] `FeatureRankingPage.tsx` の型定義とレイアウトを更新し、2列表示と注意事項の表示を実装する。
6. [ ] `ImputationModal.tsx` と `SurpriseAssociationView.tsx` でラベル変更と説明文の更新を行う。
7. [ ] フロントエンドの各ラベル横に `Tooltip` による ⓘ アイコンと説明を追加する。
8. [ ] バックエンド (pytest) の単体テストを作成し、全てパスすることを確認する。
9. [ ] フロントエンド (Vitest) の単体テストを作成・修正し、全てパスすることを確認する。
</実装計画書: 手法名称の正確化と特徴重要度の分離表示 (DAVIS-FEAT-023)>
