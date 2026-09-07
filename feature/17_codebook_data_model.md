<実装計画書: コードブック データモデル & API>
文書ID: DAVIS-FEAT-017
版: 1.0.0
作成日: 2026-09-07
優先度: 1
前提仕様: なし
対象コンポーネント: 
- `fullstack/backend/app/storage/dataset_store.py`
- `fullstack/backend/app/services/import_service.py`
- `fullstack/backend/app/services/dataset_service.py`
- `fullstack/backend/app/api/datasets.py`
- `fullstack/backend/app/domain/`

---

## 1. 概要・目的
4件の監査レポートが共通して指摘した最重要課題を解決するため、変数の「意味」（尺度水準・役割・値ラベル・欠損コードなど）を全機能で共有する仕組みを構築する。
現在の ColumnSchema は semanticType の種類が不足しており（ordinalがない等）、また補完などの処理で columnId が再生成される問題がある。
本仕様では、不変の識別子と豊富なメタデータを持つ「コードブック」を定義し、データの意味を一元管理・永続化するデータモデルおよびAPIを実装する。

## 2. 要件定義
1. **コードブックスキーマの定義**: 各列について以下の属性を永続保持する。
   - `columnId`: 安定した識別子。補完や変換処理によって変化しない。
   - `name`: 表示名
   - `label`: 質問文
   - `scaleType`: `nominal`, `ordinal`, `interval`, `ratio`, `text`, `id` の6種
   - `role`: `question`, `attribute`, `weight`, `id`, `other` の5種
   - `valueLabels`: `dict[str, str]` 形式。コードからラベルへのマッピング。
   - `categoryOrder`: `list[str]` 形式。カテゴリの表示順序。
   - `missingCodes`: `list[str]` 形式。欠損値として扱うコード。
   - `missingReasons`: `dict[str, str]` 形式。欠損理由の記述。
   - `isReversed`: bool。逆転項目フラグ。
   - `multiResponseGroup`: `str | null`。複数回答セットの親ID。

2. **ストレージ**:
   - `dataset_store.py` においてコードブックをJSON形式で永続保存する。
   - データリビジョンとスキーマリビジョンを明確に分離して管理する。

3. **API仕様**:
   - `GET /api/v1/datasets/{id}/codebook`: コードブックの取得
   - `PUT /api/v1/datasets/{id}/codebook`: コードブックの更新（部分更新に対応）
   - `POST /api/v1/datasets/{id}/codebook/import`: CSV/JSON辞書ファイルからの一括インポート
   - `GET /api/v1/datasets/{id}/codebook/export`: コードブックのCSV/JSONエクスポート

4. **初期推定ロジック**:
   - `probe_table` の結果を利用し、コードブックの初期値を自動生成する。
   - ただし、既存の定義を自動的に削除したり、無理な自動転用は行わない。

5. **保護ルール**:
   - 補完 (impute)、変換 (transform)、派生列追加などの操作によって、既存列のコードブック属性が破壊されないことを保証する。

6. **fingerprintへの反映**:
   - `schemaRevision` をキャッシュキーに含め、型変更などが即座にキャッシュ無効化を引き起こすようにする。

## 3. GUI設計（ASCIIモックアップ付き）
本仕様はバックエンドのデータモデル・API定義が中心であり、GUIの詳細は次期仕様（DAVIS-FEAT-018）で扱うため本項は割愛する。

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）

### 4.1 GET `/api/v1/datasets/{id}/codebook`
**レスポンス**: `200 OK`
```json
{
  "datasetId": "dataset-uuid",
  "schemaRevision": 2,
  "columns": [
    {
      "columnId": "col-uuid-1",
      "name": "Q1",
      "label": "総合満足度",
      "scaleType": "ordinal",
      "role": "question",
      "valueLabels": {"1": "非常に不満", "5": "非常に満足"},
      "categoryOrder": ["1", "2", "3", "4", "5"],
      "missingCodes": ["98", "99"],
      "missingReasons": {"98": "非該当", "99": "無回答"},
      "isReversed": false,
      "multiResponseGroup": null
    }
  ]
}
```

### 4.2 PUT `/api/v1/datasets/{id}/codebook`
**リクエスト** (部分更新に対応):
```json
{
  "columns": [
    {
      "columnId": "col-uuid-1",
      "label": "サービス総合満足度",
      "isReversed": true
    }
  ]
}
```
**レスポンス**: `200 OK`
```json
{
  "datasetId": "dataset-uuid",
  "schemaRevision": 3,
  "status": "success"
}
```

### 4.3 POST `/api/v1/datasets/{id}/codebook/import`
マルチパートフォームデータによるCSV/JSONファイルアップロード。
**レスポンス**: `200 OK`
```json
{
  "updatedColumns": 5,
  "schemaRevision": 4,
  "status": "success"
}
```

### 4.4 GET `/api/v1/datasets/{id}/codebook/export`
クエリパラメータ `format` に応じて CSVまたはJSONファイルとしてダウンロードされる。
CSVのフォーマット例:
```csv
name,label,scaleType,role,valueLabels,missingCodes
age,年齢,ratio,attribute,,
gender,性別,nominal,attribute,"{""1"":""男性"",""2"":""女性""}",
Q1,総合満足度,ordinal,question,"{""1"":""非常に不満"",""5"":""非常に満足""}","[""98"",""99""]"
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）

1. **`fullstack/backend/app/domain/` (Codebook Pydanticモデル定義)**
   - `codebook.py` を新規作成し、`CodebookColumn`, `Codebook` などのPydanticモデルを定義する。
   - `scaleType` Enum (nominal, ordinal, interval, ratio, text, id) の定義。
   - `role` Enum (question, attribute, weight, id, other) の定義。

2. **`fullstack/backend/app/storage/dataset_store.py`**
   - コードブックのJSONファイル読み書き用メソッド (`save_codebook`, `load_codebook`) を追加する。
   - 保存の際、`schemaRevision` を管理し、更新時にインクリメントする機構を実装する。

3. **`fullstack/backend/app/services/import_service.py`**
   - データロード時に `probe_table` の結果をパースし、各列の初期 `CodebookColumn` を生成する処理を追加する。
   - カテゴリカルデータの場合は `nominal`、数値は `ratio` もしくは `interval` 等の初期推定を行う。

4. **`fullstack/backend/app/services/dataset_service.py`**
   - `get_codebook()`, `update_codebook()`, `import_codebook()`, `export_codebook()` メソッドを実装。
   - 更新時は既存の列情報を維持しながら、指定されたフィールドのみを上書き更新（部分更新）するロジックを実装。
   - 補完 (impute) 等の処理時に、`dataset_store` から既存コードブックを引き継ぐ処理を組み込む。

5. **`fullstack/backend/app/api/datasets.py`**
   - 新規エンドポイント `GET /datasets/{id}/codebook`, `PUT /datasets/{id}/codebook`, `POST /datasets/{id}/codebook/import`, `GET /datasets/{id}/codebook/export` を追加。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）
本仕様のスコープ外（GUIなし、次期仕様18にて対応）。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）
以下をバックエンドのpytestで検証する。
- `test_codebook_create_and_read`: 作成したコードブックが正しく取得できる往復テスト。
- `test_codebook_survives_imputation`: 欠損値補完処理を行っても、対象列・非対象列のコードブック情報が保持される。
- `test_codebook_survives_transformation`: データ変換・派生列追加を行っても、元のコードブック情報が保持される。
- `test_codebook_csv_import`: 例示のCSV辞書ファイルをインポートし、列情報が正しくパース・更新される。
- `test_codebook_schema_revision`: コードブックの部分更新により `schemaRevision` がインクリメントされ、キャッシュキーが更新される（キャッシュ無効化）。
- `test_codebook_partial_update`: 一部の列・属性のみを更新し、他の属性が不変に保たれる。
- `test_probe_table_initial_estimation`: データ読み込み時の `probe_table` 実行で、妥当な初期コードブックが生成される。

## 8. 実装手順チェックリスト
1. `backend/app/domain/` に Codebook および Enum のPydanticモデルを定義する。
2. `backend/app/storage/dataset_store.py` にコードブックのJSON永続化とリビジョン管理処理を追加する。
3. `backend/app/services/import_service.py` で `probe_table` の結果から初期コードブックを生成する処理を実装する。
4. `backend/app/services/dataset_service.py` にコードブックの取得・更新・インポート・エクスポートロジックを実装する。
5. 補完・変換系サービスのロジックを見直し、既存のコードブック設定が保持されるように修正する。
6. `backend/app/api/datasets.py` に各エンドポイントを追加する。
7. テストケース（pytest）を実装し、全件PASSすることを確認する。
