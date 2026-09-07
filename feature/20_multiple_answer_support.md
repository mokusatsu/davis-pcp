<実装計画書: 複数回答（Multiple Answer）サポート>
文書ID: DAVIS-FEAT-020
版: 1.0.0
作成日: 2026-09-07
優先度: 2
前提仕様: DAVIS-FEAT-017
対象コンポーネント: 
- fullstack/backend/app/api/datasets.py
- fullstack/backend/app/api/summaries.py
- fullstack/backend/app/algorithms/summaries/core.py
- fullstack/frontend/src/features/dataset/MultiResponseGroupDialog.tsx
- fullstack/frontend/src/features/distribution/MultiResponseCard.tsx

---

## 1. 概要・目的
複数回答設問（あてはまるものをすべて選択）は通常0/1のダミー変数の集合として記録される。これを1つの設問グループとして束ね、回答者ベース(N%)および延べ回答ベースの集計・可視化を行えるようにする。

## 2. 要件定義
1. **MAグループ定義**:
   - プレフィックス一致（例: Q3_1, Q3_2...）による自動検出機能。
   - 手動での変数選択によるグループ化。
2. **2種類の集計**:
   - 回答者ベース：分母＝回答者数（各選択肢の%の合計が100%を超える場合がある）。
   - 延べ回答ベース：分母＝総選択数（各選択肢の%の合計が100%になる）。
3. **未選択vs非該当の区別**:
   - 値0が「選択しなかった」のか、「設問自体に非該当だった」のかを設定可能とする（非該当の場合は分母から除外）。
4. **集計表示**:
   - MAグループ専用の集計カードを提供。
   - 回答者ベースと延べ回答ベースの表示切替機能。
5. **PCP連動**:
   - MA項目の特定選択肢を選んだ対象者をPCP（平行座標プロット）上でハイライト確認できること。

## 3. GUI設計（ASCIIモックアップ付き）

### MAグループ定義ダイアログ
```text
+--------------------------------------------------------+
| MAグループの定義                                    [X] |
+--------------------------------------------------------+
| グループ名: [ Q3 (利用しているサービス)              ] |
|                                                        |
| [o] プレフィックスで自動検出                           |
|     プレフィックス: [ Q3_ ] [ 検出実行 ]               |
|                                                        |
| [ ] 手動で選択                                         |
|                                                        |
| 対象変数一覧:                                          |
| +----------------------------------------------------+ |
| | [x] Q3_1: サービスA                                | |
| | [x] Q3_2: サービスB                                | |
| | [x] Q3_3: サービスC                                | |
| | [x] Q3_4: その他                                   | |
| +----------------------------------------------------+ |
|                                                        |
| 非該当の扱い:                                          |
| ( ) 全員回答 (0は未選択)                               |
| (*) 条件付き回答 (欠損値/非該当を除外してNを計算)      |
|                                                        |
|                                     [ キャンセル ] [ 保存 ] |
+--------------------------------------------------------+
```

### MA集計カード
```text
+--------------------------------------------------------+
| Q3 (利用しているサービス)                       [MA] [:] |
+--------------------------------------------------------+
| ベース: (o) 回答者ベース  ( ) 延べ回答ベース             |
|                                                        |
| 有効回答者数: N=250                                    |
|                                                        |
| サービスA    |██████████████████        | 60.0% (150)  |
| サービスB    |██████████                | 32.0% ( 80)  |
| サービスC    |█████                     | 16.0% ( 40)  |
| その他      |██                        |  8.0% ( 20)  |
+--------------------------------------------------------+
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）

### MAグループ定義
`POST /api/v1/datasets/{id}/codebook/multi-response-groups`

**Request:**
```json
{
  "groupId": "q3_group",
  "groupName": "Q3 (利用しているサービス)",
  "variables": ["Q3_1", "Q3_2", "Q3_3", "Q3_4"],
  "excludeMissing": true
}
```

**Response:**
```json
{
  "status": "success",
  "groupId": "q3_group",
  "message": "Multi-response group created successfully."
}
```

### MA集計
`GET /api/v1/datasets/{id}/summaries/multi-response/{groupId}?baseType=respondent`

**Response:**
```json
{
  "groupId": "q3_group",
  "groupName": "Q3 (利用しているサービス)",
  "validN": 250,
  "totalResponses": 290,
  "items": [
    { "variable": "Q3_1", "label": "サービスA", "count": 150, "pctRespondent": 60.0, "pctResponse": 51.7 },
    { "variable": "Q3_2", "label": "サービスB", "count": 80,  "pctRespondent": 32.0, "pctResponse": 27.6 },
    { "variable": "Q3_3", "label": "サービスC", "count": 40,  "pctRespondent": 16.0, "pctResponse": 13.8 },
    { "variable": "Q3_4", "label": "その他", "count": 20,  "pctRespondent": 8.0,  "pctResponse": 6.9 }
  ]
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）
- `fullstack/backend/app/api/datasets.py`
  - `/api/v1/datasets/{id}/codebook/multi-response-groups` の POST (新規追加), GET, PUT, DELETE エンドポイントを追加する。
  - Pydanticモデルでリクエストのバリデーションを定義する。
- `fullstack/backend/app/api/summaries.py`
  - `/api/v1/datasets/{id}/summaries/multi-response/{groupId}` の GET エンドポイントを追加。
- `fullstack/backend/app/algorithms/summaries/core.py`
  - MAグループの集計関数を実装。指定された変数の値(1)をカウントし、回答者数（validN）および総選択数（totalResponses）を分母として割合を計算。非該当フラグに基づく除外処理もここで行う。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）
- `fullstack/frontend/src/features/dataset/MultiResponseGroupDialog.tsx`
  - ダイアログコンポーネントを新規作成。プレフィックスによる自動検出ロジック（対象変数リストのフィルタリング）を実装。
- `fullstack/frontend/src/features/distribution/MultiResponseCard.tsx`
  - 集計結果を表示するカードコンポーネントを新規作成。
  - 回答者ベースと延べ回答ベースの切り替え用Radioボタンを配置。
  - プログレスバーまたは横棒グラフで結果を可視化。
- `frontend/src/app/store.ts` (または関連Slice)
  - MAグループの定義情報をStateに保持し、PCP連動時にフィルター対象として使えるようRedux状態を追加・更新。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）
- バックエンド (pytest):
  - `test_ma_respondent_pct_exceeds_100`: 回答者ベースのパーセンテージ合計が100%を超える場合が正しく計算されることの確認。
  - `test_ma_response_pct_sums_to_100`: 延べ回答ベースのパーセンテージ合計が100%になることの確認。
  - `test_ma_not_applicable`: 非該当の行がカウントから除外され、分母（N）が正しく調整されることの確認。
- フロントエンド (Vitest):
  - `test_ma_prefix_detection`: プレフィックス入力時に正しく変数が抽出・選択されることの確認。
- E2E:
  - MAグループ定義の作成から、集計カードでのグラフ表示とベース切替が正常に動くことの確認。

## 8. 実装手順チェックリスト
1. [ ] バックエンド: データモデルにMAグループ定義用のスキーマを追加。
2. [ ] バックエンド: `api/datasets.py` に MAグループCRUDエンドポイントを実装。
3. [ ] バックエンド: `algorithms/summaries/core.py` に MA集計計算ロジックを実装。
4. [ ] バックエンド: `api/summaries.py` に MA集計取得エンドポイントを実装。
5. [ ] フロントエンド: MAグループ情報を保持する Redux Slice を更新。
6. [ ] フロントエンド: `MultiResponseGroupDialog.tsx` を実装し、一覧画面等からの呼び出し処理を追加。
7. [ ] フロントエンド: `MultiResponseCard.tsx` を実装し、集計結果画面にマウント。
8. [ ] バックエンド・フロントエンドのテスト（pytest, Vitest）を実装。
9. [ ] E2Eでの動作確認および修正。
