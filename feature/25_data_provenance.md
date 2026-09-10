<実装計画書: データ来歴・補完マスクと再現パッケージ>
文書ID: DAVIS-FEAT-025
版: 1.0.0
作成日: 2026-09-07
優先度: 3
前提仕様: DAVIS-FEAT-017
実装タスク・引き継ぎ: [tasks/DAVIS-FEAT-025-026.md](../tasks/DAVIS-FEAT-025-026.md#feature-25-実装仕様)
対象コンポーネント: 
  - fullstack/backend/app/storage/dataset_store.py
  - fullstack/backend/app/domain/
  - fullstack/backend/app/api/datasets.py
  - fullstack/frontend/src/features/dataset/
  - fullstack/frontend/src/features/pcp/pcpRenderer.ts
  - fullstack/frontend/src/app/store.ts

---

## 1. 概要・目的
監査や共同研究において、分析結果の再現性を確保することは極めて重要である。本機能では、原データを改変せずに補完・派生列追加・絞り込みといった操作履歴（データ来歴・Provenance）を追跡可能にする。分析結果には必ずリビジョン情報やスコープ、補完設定などのコンテキスト情報を含め、どこからでも同一の集計・再現ができる仕組みを構築する。さらに、補完されたセルを元データと視覚的に区別できるマスク情報の管理や、セッション全体の再現パッケージ（エクスポート・インポート）機能を提供する。

## 2. 要件定義
1. **データ来歴管理 (Data Provenance)**
   - `dataRevision` (データ自体の版) と `schemaRevision` (コードブックの版) の分離・管理
   - データに対する変換・補完・絞り込み操作の履歴（スタック）管理。各履歴は「操作名」「パラメータ」「対象セル/行」「タイムスタンプ」を保持する
   - 原データへの復帰 (Revert to Raw) および、任意の履歴ステップへの Undo/Redo
2. **補完マスク (Imputation Mask)**
   - 各セルについて、どの補完手法（mean, median, tabdiff等）で補完されたかを示す真偽値/手法ラベルマトリクスの記録
   - 平行座標プロット (PCP) やデータテーブル上で補完値であることを視覚的にハイライト（線の点線表示、アイコン表示など）
   - 「補完値を含む行のみ表示」「補完値なし行のみ表示」のクイックフィルタ機能
3. **API共通コンテキスト (AnalysisContext & ResultMeta)**
   - すべての分析・集計エンドポイントで共通コンテキスト（`dataRevision`, `schemaRevision`, `scope`, `rowIds`, `weightColumn`, `missingPolicy`）をリクエストに要求する
   - レスポンスとして、使用行数 (`effectiveN`)、欠損除外数 (`missingCount`)、アルゴリズムバージョン (`algorithmVersion`)、探索的分析フラグ (`isExplorative`) などのメタ情報をエコーバックする
4. **再現パッケージ (Reproduction Package / Session Export)**
   - 原データCSV、コードブックJSON、変換操作履歴JSON、選択行セット、セッション状態を1つのZipファイルまたは自己完結JSONとしてエクスポートおよびインポートできる

## 3. GUI設計（ASCIIモックアップ）

### データ来歴・操作履歴パネル
```text
+-------------------------------------------------+
| Data Provenance History                 [ X ]   |
+-------------------------------------------------+
| [Revert to Raw Data]                            |
|                                                 |
| 1. Original Data Loaded      (10:00) [ ✓ ]      |
| 2. Filter: Age > 20          (10:05) [ ✓ ]      |
| 3. Impute: BMI (Mean)        (10:12) [ ✓ ]      |
| 4. Derive: IncomeCategory    (10:15) [Undo]     |
|                                                 |
| + Export Reproduction Package (Zip)             |
+-------------------------------------------------+
```

### 補完マスクとPCPハイライト表示トグル
```text
[ Data Table ]
+------+-------+-----------+
| ID   | Age   | BMI       |
| 001  | 25    | 22.4      |
| 002  | 30    | 24.1 (M)* | <- (M) means imputed by Mean
+------+-------+-----------+
* Show imputed cells: [x] Highlight  [ ] Hide
* Filter: [ All ] [ Has Imputed ] [ No Imputed ]
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）

### 4.1. データ来歴操作API (Undo/Revert)
**POST** `/api/v1/datasets/{datasetId}/revert`
- Request:
```json
{
  "targetRevision": "rev-0" // or specific step id
}
```
- Response:
```json
{
  "datasetId": "dataset-123",
  "currentDataRevision": "rev-0",
  "message": "Reverted to raw data"
}
```

### 4.2. 再現パッケージ エクスポート
**GET** `/api/v1/datasets/{datasetId}/export_package`
- Response: Application/Zip (contains CSV, codebook.json, provenance.json, state.json)

### 4.3. 分析共通リクエスト・レスポンス形式 (例: PCA)
- Request:
```json
{
  "context": {
    "dataRevision": "rev-3",
    "schemaRevision": "sch-2",
    "scope": "filtered_selection",
    "rowIds": ["001", "002", "003"],
    "weightColumn": "survey_weight",
    "missingPolicy": "drop"
  },
  "columns": ["Age", "BMI", "Income"]
}
```
- Response:
```json
{
  "meta": {
    "effectiveN": 2,
    "missingCount": 1,
    "algorithmVersion": "1.0",
    "isExplorative": true
  },
  "result": {
    "components": [...]
  }
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）

- **`fullstack/backend/app/domain/context.py` (新規または既存拡張)**
  - `AnalysisContext` と `ResultMeta` のPydanticモデルを定義。

- **`fullstack/backend/app/domain/provenance.py` (新規)**
  - `ProvenanceStep` クラス（id, operation, params, target_cells, timestamp）を定義。
  - `ImputationMask` モデルの定義。

- **`fullstack/backend/app/storage/dataset_store.py`**
  - データセットのバージョン管理（`dataRevision`, `schemaRevision`）の永続化ロジックを追加。
  - `ProvenanceStep` の履歴配列の保持。
  - セル単位の補完マスク情報をDataFrameやSparse Matrixとして保持・ロードする処理を追加。

- **`fullstack/backend/app/api/datasets.py`**
  - `POST /datasets/{id}/revert` の実装。
  - `GET /datasets/{id}/export_package` の実装（zipfileモジュール等を使用して原データと履歴を結合してダウンロード可能にする）。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）

- **`fullstack/frontend/src/app/store.ts` (及び `provenanceSlice.ts`)**
  - `provenanceSlice` を新設し、`dataRevision`, `schemaRevision`, `historySteps`, `imputationMasks` を管理。

- **`fullstack/frontend/src/features/dataset/ProvenanceHistoryPanel.tsx`**
  - 履歴ステップ一覧の描画。
  - Undo/Revertアクションをディスパッチするボタンの実装。
  - 再現パッケージのエクスポート/インポートボタンの配置。

- **`fullstack/frontend/src/features/pcp/pcpRenderer.ts`**
  - 描画時に `imputationMasks` を参照し、補完された値を通る線のスタイルを点線（`setLineDash([5, 5])`など）に変更する。
  - 対象軸上に補完マーカー（異なる色や形状）をオーバーレイ描画。

- **`fullstack/frontend/src/features/table/DataTable.tsx` (該当箇所)**
  - 補完マスクを参照し、該当セルの背景色やテキストスタイルを変更（アイコン追加など）。
  - クイックフィルタ（補完値を含む行/含まない行）機能の組み込み。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）

- **pytest (バックエンド)**
  - `test_provenance_recording`: 補完・変換操作時に正しい `ProvenanceStep` がスタックに追加されることを確認。
  - `test_imputation_mask_preservation`: 補完処理後のデータセットに、補完マスクが正しく生成・永続化されることを確認。
  - `test_revert_to_raw`: 復帰操作 (`revert`) によって、履歴とデータ状態が初期ロード状態（原データ）に戻ることを確認。
  - `test_reproduction_package_roundtrip`: エクスポートしたZipパッケージから新しいデータセットとしてインポートし、状態が完全に復元されることを確認。

- **Vitest (フロントエンド)**
  - `test_provenance_slice`: Reduxストアで Undo/Revert アクションが正しく状態を更新するかテスト。
  - `test_pcp_mask_rendering`: `pcpRenderer` において補完マスクが適用されたデータポイントが適切なスタイリング（点線など）を適用されるか関数の出力を確認。

## 8. 実装手順チェックリスト

- [ ] バックエンド: `domain/context.py` に `AnalysisContext`, `ResultMeta` を定義
- [ ] バックエンド: `domain/provenance.py` に `ProvenanceStep`, `ImputationMask` を定義
- [ ] バックエンド: `storage/dataset_store.py` に履歴・マスクの保存とロードロジックを追加
- [ ] バックエンド: `api/datasets.py` に履歴操作（Undo/Revert）とエクスポート機能を追加
- [ ] フロントエンド: `provenanceSlice.ts` を作成し、ストアに組み込む
- [ ] フロントエンド: `ProvenanceHistoryPanel.tsx` を実装し、UIに組み込む
- [ ] フロントエンド: `pcpRenderer.ts` およびデータテーブルでの補完値強調表示を実装
- [ ] フロントエンド: 分析APIリクエスト時に `AnalysisContext` を付与するように API クライアントを改修
- [ ] バックエンド・フロントエンドの単体テストを実装し、すべてパスすることを確認
- [ ] E2Eで一連の操作（データロード -> 補完 -> 履歴表示 -> エクスポート -> Revert）が動作するか確認
