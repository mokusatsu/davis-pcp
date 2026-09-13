<実装計画書: PCP改善・多重対応分析(MCA)・UI安定化>
文書ID: DAVIS-FEAT-027
版: 1.0.0
作成日: 2026-09-07
優先度: 4
前提仕様: なし
実装タスク・引き継ぎ: [tasks/DAVIS-FEAT-027-028.md](../tasks/DAVIS-FEAT-027-028.md#feature-27-実装仕様)
関連する追加分析設計: [Feature 030 MCA仕様](analysis-specs/feature/30_multiple_correspondence_analysis.md) / [詳細設計](analysis-specs/tasks/DAVIS-FEAT-030-DESIGN.md)
対象コンポーネント: 
- `fullstack/backend/app/algorithms/models/mca.py`
- `fullstack/backend/app/api/models.py`
- `fullstack/frontend/src/features/pcp/pcpRenderer.ts`
- `fullstack/frontend/src/features/pcp/PcpPage.tsx`
- `fullstack/frontend/src/features/mca/McaPage.tsx`
- `fullstack/frontend/src/features/selection/`

---

## 1. 概要・目的
本仕様書は、DAVIS-PCPプロジェクトにおいて、監査指摘に基づいたPCP(平行座標プロット)のUI/UX改善、およびアンケートなどのカテゴリカルデータ分析に有用な多重対応分析(MCA)機能の追加を定義する。
主な目的は、離散データ表示時のオーバープロッティング解消（ジッター、リボン表示）、高DPI環境や多数の変数環境での表示・操作性の安定化（座標オフセット補正、ラベル対応、ドロップダウンUIのポータル化）、カテゴリ主体の次元削減手法の提供、および小標本時の警告表示を行うことである。

## 2. 要件定義

### 2.1 PCP描画の高度化
- **ジッター（Jittering）**: 離散カテゴリ軸上で線に乱数オフセットを付与する。強度調整スライダーを設け、乱数シードは固定可能とする。注記として「統計計算にはジッター前の値を使用する」旨を表示。
- **Parallel Sets / リボン表示モード**: カテゴリ間の移動を度数に応じた幅の帯（ポリゴン）として描画するモードを追加。
- **軸ラベル表示の改善**: 45度斜め回転、文字数制限（ellipsis + ホバーでツールチップ表示）、軸多数時のスムーズな水平パン/スクロールに対応。

### 2.2 PCP座標系・UI安定化
- **座標変換補正**: `getBoundingClientRect()` と `devicePixelRatio` を厳密に反映した座標変換補正を行い、高DPIやブラウザスケーリング環境でのブラッシングのズレを解消する。
- **ドロップダウン・セレクター**: すべてのドロップダウン・メニューをReact Portalによって最上位DOMへマウントし、親要素の `overflow: hidden` によるクリッピングを防止する。

### 2.3 多重対応分析 (MCA: Multiple Correspondence Analysis)
- **MCAアルゴリズム**: カテゴリ変数群（名義・順序）を入力とし、Burt行列またはIndicator行列の特異値分解(SVD)によるMCAを実装する。
- **可視化**: 2次元平面上にカテゴリ点および回答者サンプルをプロット（バイプロット）。主慣性・寄与率のScree表示。各カテゴリの座標・寄与度・再現性の算出。
- **インタラクション**: 選択点群とPCPとの双方向ブラッシングリンク機能。

### 2.4 小標本警告・不確実性表示
- フィルタ後またはサブグループの有効サンプルサイズが n < 30 の場合、アラートバッジと「推定不安定性」の警告を表示する。

## 3. GUI設計（ASCIIモックアップ付き）

```text
[PCP 画面 - コントロールバーとPCP]
+-----------------------------------------------------------------------------------+
| [表示モード: [ 線▼ ] ] [ ジッター強度: --O------ ] [x] ラベル斜め表示             |
|                                                                                   |
|  [!] 有効サンプルサイズが少ない(n=25)ため、結果の解釈には注意が必要です。         |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|   Q1_満足度(…)       Q2_利用頻度         Q3_年代             Q4_職業              |
|        |                  |                  |                  |                 |
|   非常 ┼====\             |                  |                  |                 |
|   に満 |     \======\     |                  |                  |                 |
|   足   |             \==> ┼ 毎日             |                  |                 |
|        |                  |                  |                  |                 |
|   やや ┼--\               |             /--> ┼ 20代             |                 |
|   満足 |   \              |            /     |                  |                 |
|        |    \---------\   |           /      |                  |                 |
|   普通 ┼               \> ┼ 週2-3回 -/       |             /--> ┼ 会社員          |
|        |                  |                  |            /     |                 |
|   不満 ┼                  |                  ┼ 30代 -----/      |                 |
|        |                  ┼ 月1回未満                           ┼ 学生            |
|        |                  |                  ┼ 40代             |                 |
|                                                                                   |
|   <================== (水平スクロールバー) ==================>                    |
+-----------------------------------------------------------------------------------+

[MCA 分析画面]
+-----------------------------------------------------------------------------------+
| MCA(多重対応分析) [変数選択...] [実行]                                            |
|                                                                                   |
| 主慣性(Scree)          | バイプロット (Dim1: 15.2% vs Dim2: 12.5%)                |
|   |                    |                                                          |
|   |*                   |          [Q1:非常に満足]                                 |
|   |**                  |    +              o(サンプル)                            |
|   |**                  |          [Q2:毎日]                                       |
|   |***                 |               +                                          |
|   |***                 |                      + [Q3:20代]                         |
|   +-----------         |   o        o                                             |
|                        |          + [Q1:不満]                                     |
|                        |                                                          |
+-----------------------------------------------------------------------------------+
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）

### 4.1 MCA分析エンドポイント
- **エンドポイント**: `POST /api/v1/models/mca`
- **概要**: 選択されたカテゴリカル変数を元にMCAを計算する。

**リクエストJSON例**
```json
{
  "dataset_id": "dataset-123",
  "variables": ["Q1", "Q2", "Q3", "Q4"],
  "n_components": 2
}
```

**レスポンスJSON例**
```json
{
  "status": "success",
  "eigenvalues": [0.45, 0.35, 0.20],
  "explained_inertia": [0.45, 0.35, 0.20],
  "explained_inertia_percent": [45.0, 35.0, 20.0],
  "categories": [
    {
      "variable": "Q1",
      "category": "非常に満足",
      "coordinates": [1.2, -0.5],
      "contribution": [15.2, 5.1],
      "cos2": [0.6, 0.2]
    }
  ],
  "row_coordinates": [
    {"row_id": 0, "coordinates": [0.8, -0.1]},
    {"row_id": 1, "coordinates": [-1.2, 1.1]}
  ]
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）

- `fullstack/backend/app/algorithms/models/mca.py` (新規作成)
  - `prince` ライブラリ、または `scipy.linalg.svd` などを利用してMCAアルゴリズムを実装。
  - Indicator行列の作成、特異値分解、カテゴリおよび行(サンプル)の座標、主慣性(Eigenvalues)、寄与率の計算を行う `MCAProcessor` クラスを定義。
- `fullstack/backend/app/api/models.py`
  - `/models/mca` のPOSTエンドポイントを追加。
  - Pydanticモデルを用いたリクエストバリデーション (`MCARequest`, `MCAResponse`)。
  - DataFrameから指定列を抽出し、`MCAProcessor` に渡し、結果をJSON形式で返却する。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）

- **状態管理 (`fullstack/frontend/src/app/store.ts` 等)**
  - `pcpSlice`: `jitterIntensity` (number), `displayMode` ("lines" | "ribbons"), `rotateLabels` (boolean) などの表示設定状態を追加。
  - `mcaSlice`: MCAの計算結果（主慣性、座標データなど）を保持する状態を追加。
- `fullstack/frontend/src/features/pcp/pcpRenderer.ts`
  - **ジッター**: `displayMode === 'lines'` の際、`Math.random()` (シード固定なら独自疑似乱数)を用いてX/Y座標にオフセットを加算する。
  - **リボン表示**: `displayMode === 'ribbons'` の場合、カテゴリ間の遷移数を集計し、太さを持ったポリゴンパス（svg `path` あるいは Canvas `fill`）を描画する。
  - **高DPI補正**: `devicePixelRatio` を用いてCanvasの実際のピクセルサイズとCSSサイズを合わせる修正を行う。マウスイベント時の座標取得を `getBoundingClientRect()` を元に正しくスケール変換する関数 (`getCanvasPos`) を実装。
- `fullstack/frontend/src/features/pcp/PcpPage.tsx`
  - コントロールバー（スライダー、セレクトボックス、トグル）を追加し、Reduxの `pcpSlice` アクションと紐付ける。
  - フィルタ後の行数が30未満の場合、小標本アラート(`Alert` コンポーネント)を表示するロジックを追加。
  - 長い軸ラベルのellipsisとツールチップ（`title` 属性または Ant Design `Tooltip`）を実装。
- `fullstack/frontend/src/features/mca/McaPage.tsx` (新規作成)
  - 変数選択用のUI、計算実行ボタン。
  - MCA結果を描画するための散布図コンポーネント（D3.js や Recharts 等を利用）。バイプロット（カテゴリ点と行点）の表示。
  - 散布図上での矩形選択（ブラッシング）と、グローバルな選択状態（`selectionSlice`）の連携。
- `fullstack/frontend/src/features/selection/` 以下のドロップダウンUI等
  - Ant Designの `Select` 等を使用している場合、`getPopupContainer={(triggerNode) => triggerNode.parentNode}` から `getPopupContainer={() => document.body}` への変更などを行い、Portalマウントにより `overflow: hidden` によるクリッピングを回避する。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）

- **バックエンド (pytest)**
  - `test_mca_eigenvalues_and_coordinates`: ダミーのカテゴリカルデータセットを与え、MCAの主慣性・固有値とカテゴリ/行座標が正しく計算されること、合計が制約を満たすことを検証。
- **フロントエンド (Vitest)**
  - `test_brushing_dpi_offset`: 高DPIスケーリング環境（`devicePixelRatio = 2` 等）をモックし、マウスクリック/ドラッグ座標が正しく内部データ座標に変換されることを検証。
  - `test_pcp_jitter_does_not_affect_data`: ジッター付与時においても、データモデル上の選択ロジック（ブラッシング判定）には元の値が用いられ、選択 `rowId` が正確であることを検証。
- **E2E (Playwright/Cypress等)**
  - PCP画面でジッター強度を変更し、描画が更新されること。
  - リボンモードへの切り替えが正常に行われること。
  - 絞り込みを行い n < 30 になった際にアラートが表示されること。
  - ドロップダウンメニューが表や他のコンポーネントに隠れず最前面に表示されること。

## 8. 実装手順チェックリスト

- [ ] `backend/app/algorithms/models/mca.py` の新規作成とMCAアルゴリズム（`MCAProcessor`）の実装
- [ ] `backend/app/api/models.py` に `/models/mca` エンドポイントの実装・ルーティング追加
- [ ] バックエンドのpytest (`test_mca_eigenvalues_and_coordinates`) の作成とパス確認
- [ ] `frontend` のReduxストア (`pcpSlice`, `mcaSlice`) の状態定義とアクション作成
- [ ] `frontend/src/features/pcp/pcpRenderer.ts` に高DPI補正、ジッター処理、リボン描画処理を実装
- [ ] `frontend/src/features/pcp/PcpPage.tsx` にコントロールバー、小標本アラート、ラベル回転処理を実装
- [ ] `frontend/src/features/selection/` 等のドロップダウンをReact Portalマウントに変更（クリッピング対策）
- [ ] `frontend/src/features/mca/McaPage.tsx` の新規作成、散布図描画とブラッシング連携の実装
- [ ] フロントエンドのVitest (`test_brushing_dpi_offset`, `test_pcp_jitter_does_not_affect_data`) の作成とパス確認
- [ ] 統合テスト・E2E動作確認と最終的な表示・動作検証
