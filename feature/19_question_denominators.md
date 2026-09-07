<実装計画書: 設問別分母と分布カード>
文書ID: DAVIS-FEAT-019
版: 1.0.0
作成日: 2026-09-07
優先度: 1
前提仕様: DAVIS-FEAT-017
対象コンポーネント: 
- `fullstack/backend/app/algorithms/summaries/core.py`
- `fullstack/backend/app/api/summaries.py`
- `fullstack/frontend/src/features/distribution/DistributionPage.tsx`
- `fullstack/frontend/src/features/distribution/QuestionCard.tsx`

---

## 1. 概要・目的
アンケート集計の基本として、全対象者数(N)、設問対象者数(n_target)、有効回答数(n_valid)、無回答数(n_missing)を設問単位で明確に区別し表示する。割合を100%に揃えることよりも、分母を明示することを優先し、データの正確な解釈を支援する。さらに、Distribution View のカードを再設計し、補助統計の追加やPCP（並行座標プロット）との連携を強化する。

## 2. 要件定義
1. **4種類の分母を区別**: 全対象者数（N）、設問対象者数（非該当コードで減算）、有効回答数（無回答コードで減算）、無回答数を計算し表示する。
2. **分布カード再設計**: Distribution View の各設問カードに分母情報（N、n_target、n_valid、n_missing）を追加する。
3. **分母切替**: 割合計算の基準となる分母を「有効回答ベース」と「全対象者ベース」で切り替え可能にする。
4. **補助統計の追加**: 順序尺度（Ordinal）には中央値、Top-2-Box（上位2カテゴリの合算%）、Bottom-2-Box（下位2カテゴリの合算%）を表示する。
5. **数値近似の注記**: 平均を表示する場合、「等間隔得点として計算」という注記を自動付与する。
6. **PCPリンク**: カテゴリごとの回答者をPCP上で選択・ハイライトするボタンを提供する。

## 3. GUI設計（ASCIIモックアップ付き）
```text
+-------------------------------------------------------------+
| Q1. 製品の満足度を教えてください (順序尺度)                     |
|                                                             |
| 対象者情報: [全: 500 | 設問対象: 480 | 有効: 465 | 無回答: 15]  |
|                                                             |
| 1. 大変満足      █████████████░░░░░░░░░░ 26.0% (121) [PCP]  |
| 2. やや満足      ██████████░░░░░░░░░░░░░ 20.0% ( 93) [PCP]  |
| 3. どちらでもない ████████░░░░░░░░░░░░░░░ 16.0% ( 74) [PCP]  |
| 4. やや不満      ██████░░░░░░░░░░░░░░░░░ 12.0% ( 56) [PCP]  |
| 5. 大変不満      █████░░░░░░░░░░░░░░░░░░ 11.5% ( 53) [PCP]  |
| 9. 無回答        ████░░░░░░░░░░░░░░░░░░░ 14.5% ( 68) [PCP]  |
|                                                             |
| 補助統計:                                                   |
| - 平均: 3.28 (※等間隔得点として計算)    - 中央値: 3         |
| - Top-2-Box: 46.0% (214)              - Bottom-2-Box: 23.5% (109)|
|                                                             |
| [ 分母: 有効回答ベース ▼ ]                                  |
+-------------------------------------------------------------+
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）
**エンドポイント**: `GET /api/v1/summaries` または対象設問のサマリ取得API

**レスポンス拡張内容**:
既存のレスポンスに `denominators` と `auxiliaryStats` オブジェクトを追加する。

**レスポンスJSON例**:
```json
{
  "columnId": "Q1",
  "denominators": {
    "total": 500,
    "target": 480,
    "valid": 465,
    "missing": 15,
    "notApplicable": 20
  },
  "distribution": [
    {
      "code": 1,
      "label": "大変満足",
      "count": 121,
      "percentageValid": 26.0,
      "percentageTotal": 24.2
    }
  ],
  "auxiliaryStats": {
    "mean": 3.28,
    "meanNote": "等間隔得点として計算",
    "median": 3,
    "top2Box": {"pct": 46.0, "n": 214},
    "bottom2Box": {"pct": 23.5, "n": 109}
  }
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）
- `fullstack/backend/app/algorithms/summaries/core.py`
  - **分母計算ロジックの追加**: 欠損値（無回答）、非該当値の設定に基づき、`total`, `target`, `valid`, `missing`, `notApplicable` を計算する処理を実装。
  - **補助統計の計算**: 順序尺度の変数に対して、中央値、Top-2-Box、Bottom-2-Boxの計算ロジックを実装。また、平均値計算時に注記フラグ/文字列を返すようにする。
- `fullstack/backend/app/api/summaries.py`
  - レスポンスモデル（Pydanticスキーマ）の拡張：`Denominators` および `AuxiliaryStats` モデルを追加。
  - 計算コアから返されたデータをAPIレスポンスの形式にマッピングする処理を更新。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）
- `fullstack/frontend/src/features/distribution/QuestionCard.tsx` (新規)
  - 個別の設問ごとの分布カードコンポーネント。
  - 対象者情報（分母）、分布横棒グラフ、補助統計の表示を担当。
  - 分母切り替え（有効回答/全対象者）のローカルState（またはRedux連動）を持ち、表示するパーセンテージを切り替える。
  - 各カテゴリの `[PCP]` ボタンクリック時に、対象カテゴリのフィルタリング・ハイライトアクションをディスパッチする。
- `fullstack/frontend/src/features/distribution/DistributionPage.tsx`
  - 複数の `QuestionCard` をリスト表示するようにUIを再設計。
  - 状態管理として、APIから取得したサマリデータ（分母や補助統計含む）をRedux Storeで保持し、各カードに渡す。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）
- **バックエンド（pytest）**
  - `test_denominator_with_missing_codes`: 欠損コードが設定されたデータにおいて、無回答数が正しくカウントされ、有効回答数が正しく計算されることを検証。
  - `test_denominator_with_not_applicable`: 非該当コードが設定されたデータにおいて、設問対象者数から正しく除外されることを検証。
  - `test_top2_bottom2_box`: 順序尺度のデータに対して、Top-2-BoxおよびBottom-2-Boxの割合と実数が正しく計算されることを検証。
  - `test_mean_note_for_ordinal`: 順序尺度のデータのサマリ計算時に、平均値に対して「等間隔得点として計算」の注記が含まれることを検証。
- **フロントエンド（Vitest）**
  - `QuestionCard.test.tsx`: 分母切替ドロップダウンの操作により、表示されるパーセンテージが有効回答ベースと全対象者ベースで正しく切り替わることを検証。
  - PCPボタンのクリック時に適切なイベント（アクション）が発火することを検証。
- **E2Eシナリオ**
  - Distribution View を開き、設問カード上に分母情報や補助統計が正しく表示されていることを確認。
  - 分母切替操作により、グラフと割合の表示が動的に変化することを確認。

## 8. 実装手順チェックリスト（エージェントが順に実行する手順）
1. `backend/app/algorithms/summaries/core.py` に分母（N, n_target, n_valid, n_missing）および補助統計（中央値, Top/Bottom-2-Box, 平均注記）の計算ロジックを追加する。
2. `backend/app/api/summaries.py` および関連スキーマを更新し、新しい分母・補助統計フィールドをレスポンスに含める。
3. `backend` 側のpytestテスト（`test_denominator_with_missing_codes`, `test_denominator_with_not_applicable`, `test_top2_bottom2_box`, `test_mean_note_for_ordinal`）を実装し、テストをパスさせる。
4. `frontend/src/features/distribution/QuestionCard.tsx` を新規作成し、分母情報、横棒グラフ、補助統計、PCPリンクボタン、分母切替機能を実装する。
5. `frontend/src/features/distribution/DistributionPage.tsx` を更新し、`QuestionCard` を用いて分布一覧を表示するように変更する。
6. `frontend` 側のVitest単体テストを実装し、コンポーネントの表示切替機能等を検証する。
7. E2Eテストを実行（または手動確認用シナリオ作成）し、Distribution Viewでの全体動作を確認する。
