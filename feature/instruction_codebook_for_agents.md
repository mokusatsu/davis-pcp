# 開発者・エージェント向け指示書: コードブック仕様・実装ガイドライン

**対象機能**: DAVIS-FEAT-017 (データモデル & API), DAVIS-FEAT-018 (エディタGUI), DAVIS-FEAT-019B (全系伝播)  
**更新日**: 2026-09-07  
**ステータス**: 正式仕様（Single Source of Truth）

---

## 1. 最重要設計規約（互換コード禁止・命名統一）

コードベース全体の整合性と保守性を保つため、**古い別名や過剰な下位互換性コードは排除**し、以下の統一命名規則を厳格に遵守してください。

### 1.1 命名・型の統一基準
1. **列コレクションのキー名**: 必ず **`columns`** を使用してください。  
   - ❌ `variables` は使用禁止です。
   - ❌ `columns` と `variables` を両立させる冗長なマッピング・エイリアスは作成しないでください。
2. **リビジョン番号 (`schemaRevision`)**: 必ず **正の整数 (`int` / `number`)** で管理します。  
   - ❌ `"rev-001"` のような文字列型は使用禁止です。
   - 初期値は `1`。コードブックまたは列スキーマが更新されるたびに `+1` インクリメントします。
3. **列識別子 (`columnId`)**: 不変のUUID文字列（例: `"col-1a2b3c4d"`）。  
   - 補完 (imputation)、変換 (transform)、列追加などのいかなる操作でも既存列の `columnId` を再生成してはなりません。

---

## 2. データモデル定義

### 2.1 列メタデータ (`CodebookColumn`)
```typescript
type ScaleType = 'nominal' | 'ordinal' | 'interval' | 'ratio' | 'text' | 'id';
type RoleType = 'question' | 'attribute' | 'weight' | 'id' | 'other';

interface CodebookColumn {
  columnId: string;                     // 普遍の一意ID
  name: string;                         // 物理列名
  label: string;                        // 質問文・表示ラベル
  scaleType: ScaleType;                 // 尺度水準 (6種)
  role: RoleType;                       // 設問役割 (5種)
  valueLabels: Record<string, string>;  // コード値 -> 表示ラベル (例: {"1": "男性", "2": "女性"})
  categoryOrder: string[];              // 表示・分析順序 (例: ["1", "2", "3", "4", "5"])
  missingCodes: string[];               // 欠損値コード (例: ["98", "99"])
  missingReasons: Record<string, string>; // 欠損理由 (例: {"98": "非該当", "99": "無回答"})
  isReversed: boolean;                  // 逆転項目フラグ
  multiResponseGroup: string | null;    // 複数回答セット親ID (未指定は null)
}
```

### 2.2 コードブック全体 (`Codebook`)
```typescript
interface Codebook {
  datasetId: string;
  schemaRevision: number;
  columns: CodebookColumn[];
}
```

---

## 3. REST API 仕様

ベースパス: `/api/v1/datasets/{dataset_id}/codebook`

### 3.1 GET `/api/v1/datasets/{dataset_id}/codebook`
データセットのコードブックを取得。
- **レスポンス**: `200 OK`
```json
{
  "datasetId": "ds-12345",
  "schemaRevision": 1,
  "columns": [
    {
      "columnId": "col-001",
      "name": "Q1",
      "label": "総合満足度",
      "scaleType": "ordinal",
      "role": "question",
      "valueLabels": {"1": "不満", "2": "満足"},
      "categoryOrder": ["1", "2"],
      "missingCodes": ["99"],
      "missingReasons": {"99": "無回答"},
      "isReversed": false,
      "multiResponseGroup": null
    }
  ]
}
```

### 3.2 PUT `/api/v1/datasets/{dataset_id}/codebook`
コードブックを部分更新（指定された列の属性のみ上書き）。
- **リクエスト**:
```json
{
  "columns": [
    {
      "columnId": "col-001",
      "label": "当サービスの総合満足度",
      "isReversed": true
    }
  ]
}
```
- **レスポンス**: `200 OK`
```json
{
  "status": "success",
  "datasetId": "ds-12345",
  "schemaRevision": 2,
  "updatedColumns": 1
}
```

### 3.3 POST `/api/v1/datasets/{dataset_id}/codebook/import`
CSVまたはJSON辞書ファイルをアップロードし、列名 (`name`) をキーとして属性を一括更新。
- **リクエスト**: `multipart/form-data` (`file: UploadFile`)
- **レスポンス**: `200 OK` (`{"status": "success", "updatedColumns": 5, "schemaRevision": 3}`)

### 3.4 GET `/api/v1/datasets/{dataset_id}/codebook/export`
クエリパラメータ `?format=csv` または `?format=json` でコードブック辞書をダウンロード。

---

## 4. フロントエンド状態管理 (`codebookSlice.ts`)

```typescript
interface CodebookState {
  datasetId: string | null;
  schemaRevision: number;
  columns: CodebookColumn[];
  draftColumns: CodebookColumn[];     // 編集中の一時コピー（保存で columns に反映、破棄で rollback）
  selectedColumnIds: string[];        // 選択中の列IDリスト（一括操作用）
  activeColumnId: string | null;      // 詳細ペインで編集中の列ID
  viewMode: 'detail' | 'grid';        // 詳細フォーム表示 ⇄ スプレッドシート風グリッド表示
  isEditorOpen: boolean;
  isBulkLabelModalOpen: boolean;
  filter: {
    keyword: string;
    scaleType: string | null;
    role: string | null;
  };
  hasChanges: boolean;
}
```

---

## 5. 厳格な不変条件（Invariants: 絶対に破壊してはならないルール）

1. **データ変換・補完時の完全保護**:
   - `impute`, `binning`, `calculate (add-column)` 等の処理でバックエンドの `_finalize_dataset` が呼ばれる際、必ず既存データセットのコードブックを読み込み、既存列のメタデータ（`columnId`, `label`, `scaleType`, `role`, `valueLabels`, `missingCodes`, etc.）を完全に引き継ぐこと。
   - 勝手にコードブックを初期化・再生成してはならない。
2. **キャッシュキー連動**:
   - コードブック更新時は `schemaRevision` をインクリメントし、データセットメタデータ `meta["schemaRevision"]` および `meta["fingerprint"]` に反映すること。これにより全分析キャッシュが自動無効化される。
3. **PCP / 可視化コンポーネントへの伝播**:
   - 後続機能（FEAT-019B等）において、PCPの軸順・目盛り・ツールチップは必ず `codebook.columns` の `categoryOrder`, `valueLabels`, `scaleType`, `isReversed` を参照すること。
