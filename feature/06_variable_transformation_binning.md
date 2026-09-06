# 実装計画書: カテゴリ変数の二値化・離散化、連続変数のビン分割 (Variable Transformation & Binning)

文書ID: DAVIS-FEAT-006  
版: 1.0.0  
作成日: 2026-09-04  
優先度: 1 (即時着手)  
対象コンポーネント: Backend (Dataset / Transform API), Frontend (Dataset Overview / Variable Manager, PCP Integration)  

---

## 1. 概要・目的

### 1.1 背景と目的
元のDAVIS（Huh et al., 2002, 2005）では、データ探索の過程で変数の型変換や前処理を動的に行い、その結果を即座にPCPやクラスタリング等の分析ツールへ投入できる「Data Manipulation（データ操作）モジュール」が備わっていた。
特に以下の2つの前処理は、PCPの軸順最適化や多次元カテゴリ可視化において不可欠な役割を果たしていた。

1. **カテゴリ変数の二値化（Nominal to Binary / One-Hot Encoding）**:
   - 名義尺度変数の各水準を独立した0/1の数値軸に変換し、PCPの数値軸として配置可能にする。
   - 重相関分析（ComponentOrder）や距離ベースの順序付け（PermuteOrder）にカテゴリ情報を組み込む。
2. **連続変数の離散化・ビン分割（Discretization / Binning）**:
   - 歪んだ連続変数や多峰性データに対し、等幅（Equal-width）または等度数/分位点（Equal-frequency）で離散区間に分割する。
   - 後続のクロス集計、決定木、およびLine Mosaic Plotなどのカテゴリカル分析ツールの入力データとして活用する。

本機能では、`DAVIS-PCP Fullstack v2.0.0` の既存のデータセット管理・スキーマ推論アーキテクチャを拡張し、非破壊的かつバージョン管理された「導出列（Derived Columns）」の生成・編集・PCP即時同期パイプラインを実装する。

### 1.2 元のDAVISにおける原典根拠
- **初版JARバイトコード**:
  - `davis.core.util.NominalToBinaryFilter`
  - `davis.core.util.AddFilter`
  - `davis.core.util.VariableFilter`
  - `davis.core.base.Range`
- **2005年発表資料 (SLIDES-2005)**:
  - Slide 12: `Data Manipulation: Missing value process, Discretization, Observation/variable selection`
- **設計原則**:
  - 元のParquetデータセット（immutable）を破壊せず、セッション・リビジョン単位で導出変数を安全に管理・永続化する。

---

## 2. 現代フルスタックシステムにおける設計仕様

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend UI                            │
│  [Dataset Overview / Variable Manager]                     │
│    - カラムリスト一覧に「Transform / Bin」アクションボタン   │
│    - モーダル: 変換方式選択 (One-Hot, Equal-width, Quantile)│
│    - プレビュー (分割境界、度数ヒストグラム、生成列名)       │
└──────────────────────────────┬──────────────────────────────┘
                               │ POST /api/datasets/{id}/transform
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend (FastAPI)                         │
│  [TransformService]                                         │
│    - 変換パイプライン実行 (Polars / Pandas / NumPy)          │
│    - 新規列の追加 + スキーマメタデータ生成                   │
│    - Parquetストアの新しいRevisionまたは導出ストアへ保存    │
│    - キャッシュの無効化 (summaries, orderings)              │
└──────────────────────────────┬──────────────────────────────┘
                               │ Response: 更新後スキーマ & 列データ
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 PCP & Downstream Views                      │
│    - 新規生成された軸がPCPの軸選択リストに即座に追加         │
│    - 軸順アルゴリズム (ComponentOrder, PermuteOrder) に即座に│
│      組み込み可能                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 詳細アルゴリズム仕様

### 3.1 カテゴリ変数の二値化 (Nominal to Binary / One-Hot)

#### 変換ロジック
カテゴリ変数 $C$ が $K$ 個のユニーク値 $\{v_1, v_2, \dots, v_K\}$ を持つ場合：
1. **変換モード**:
   - `full`: $K$ 個すべてのダミー変数 $\{C\_v_1, \dots, C\_v_K\}$ を生成。
   - `drop_first`: 線形独立性を保つため最初の1水準を除いた $K-1$ 個を生成（回帰・主成分分析用）。
2. **欠損値 (NaN / Null) の扱い**:
   - `as_missing`: 欠損行は全ダミー列で `NaN`。
   - `as_category`: 欠損値自体を `C_missing` 列として二値化。
3. **カーディナリティ制約**:
   - ユニーク値数 $K > 30$ の場合は警告または「上位N件 + その他(Other)」への集約オプションを提供。

### 3.2 連続変数のビン分割 (Discretization / Binning)

連続変数 $X = \{x_1, \dots, x_N\}$ に対し、ビン数 $B$（既定: 4 または 5）を指定：

1. **等幅ビン分割 (Equal-width)**:
   - 最小値 $x_{\min}$、最大値 $x_{\max}$ に対し、区間幅 $W = (x_{\max} - x_{\min}) / B$。
   - 境界点: $e_k = x_{\min} + k \cdot W \quad (k = 0, \dots, B)$。
   - ラベル: `[e0-e1)`, `[e1-e2)`, ..., `[e_{B-1}-e_B]` または 順序カテゴリ `Bin 1`〜`Bin B`。
2. **等度数 / 分位点ビン分割 (Equal-frequency / Quantile)**:
   - 各ビンに含まれるサンプル数がほぼ等しくなるよう、分位点 $q_k = \text{Quantile}(X, k/B)$ を境界とする。
   - 同一値多数（タイ）が存在する場合の重複境界除去・フォールバック。
3. **カスタム閾値分割 (Custom Cut points)**:
   - ユーザーがUI上でカンマ区切りまたはスライダーで指定した数値境界点で分割。

---

## 4. API設計

### 4.1 エンドポイント仕様

#### `POST /api/datasets/{dataset_id}/transform`
データセットに変形列を追加する。

**リクエストボディ (JSON)**:
```json
{
  "type": "nominal_to_binary",
  "source_column": "Species",
  "options": {
    "drop_first": false,
    "prefix": "Species",
    "handle_null": "as_missing",
    "max_categories": 10
  }
}
```
または
```json
{
  "type": "binning",
  "source_column": "SepalLength",
  "options": {
    "method": "quantile",
    "num_bins": 4,
    "output_column_name": "SepalLength_bin4",
    "labels": "range"
  }
}
```

**レスポンス (JSON)**:
```json
{
  "dataset_id": "iris-uuid",
  "revision": 2,
  "created_columns": [
    {
      "name": "Species_setosa",
      "type": "integer",
      "role": "dimension",
      "stats": { "min": 0, "max": 1, "null_count": 0 }
    },
    {
      "name": "Species_versicolor",
      "type": "integer",
      "role": "dimension",
      "stats": { "min": 0, "max": 1, "null_count": 0 }
    },
    {
      "name": "Species_virginica",
      "type": "integer",
      "role": "dimension",
      "stats": { "min": 0, "max": 1, "null_count": 0 }
    }
  ],
  "total_columns": 8,
  "total_rows": 150
}
```

#### `DELETE /api/datasets/{dataset_id}/columns/{column_name}`
導出列を削除する。

---

## 5. UI/UX・GUI詳細設計

### 5.1 画面配置と導線
本機能は、ユーザーの思考を妨げないよう、2箇所からシームレスにアクセスできる設計とする。
1. **Primary Entry: OverviewPage (`/overview`) の「Variables & Schema」テーブル**:
   - 各カラム行の右端アクション列に `[Transform]` ボタン（カテゴリ型は `[One-Hot]`, 数値型は `[Bin]`) を常時配置。
   - 複数列の一括変換に対応するバッチセレクタ。
2. **Secondary Entry: PCP画面 (`/pcp`) の軸設定ドロワー (Axis Settings Drawer)**:
   - 軸リストの各軸アイテム横に小さな `[fx]` アイコンを配置。PCP上で可視化を見ながら「この連続軸を4分割ビンにしてカテゴリ軸として観察したい」場合に画面遷移なしで即時変形モーダルを起動可能。

```
+-----------------------------------------------------------------------------------+
| Overview / Variables                                                              |
+-----------------------------------------------------------------------------------+
| Name          | Type     | Role      | Distinct | Range / Values    | Actions     |
+---------------+----------+-----------+----------+-------------------+-------------+
| SepalLength   | numeric  | dimension | 35       | 4.3 - 7.9         | [Binning]   |
| Species       | category | label     | 3        | setosa, versi...  | [One-Hot]   |
+---------------+----------+-----------+----------+-------------------+-------------+
```

### 5.2 インタラクティブ・ビン分割モーダル (`BinningModal.tsx`)
数値変数の `[Binning]` ボタンをクリックすると開く専用モーダル。

```
+-----------------------------------------------------------------------------------+
|  Bin Variable: SepalLength                                                        |
+-----------------------------------------------------------------------------------+
|  Method:  (o) Equal-width     ( ) Quantile (Equal-freq)     ( ) Custom            |
|                                                                                   |
|  Number of Bins: [ 4 ]  ---o----------------- (2 to 10)                           |
|                                                                                   |
|  Distribution Preview:                                                            |
|    |      _/\_                                                                    |
|    |   _ /    \ _                                                                 |
|    |  /  |  |  | \                                                                |
|    +--|--|--|--|--+                                                               |
|      e0 e1 e2 e3 e4   <- 垂直カットライン（ドラッグで微調整可能）                |
|                                                                                   |
|  Generated Bins Preview:                                                          |
|    [x] Bin 1: [4.30, 5.20)  |  45 rows (30.0%)                                    |
|    [x] Bin 2: [5.20, 6.10)  |  50 rows (33.3%)                                    |
|    [x] Bin 3: [6.10, 7.00)  |  43 rows (28.7%)                                    |
|    [x] Bin 4: [7.00, 7.90]  |  12 rows ( 8.0%)                                    |
|                                                                                   |
|  Output Column Name: [ SepalLength_bin4             ]                             |
|  [x] Add to PCP axes immediately upon creation                                    |
|                                                     [ Cancel ]  [ Apply Transform]|
+-----------------------------------------------------------------------------------+
```

- **リアルタイム・ミニヒストグラム**:
  - スライダーを動かした瞬間に、ヒストグラム上に配置された縦のカットライン境界値がアニメーションし、各ビンのサンプル数バーが即座に再計算される。
- **直感的なカスタム閾値ドラッグ**:
  - `Custom` モードでは、ヒストグラム上のカットラインをマウスで左右にドラッグして境界位置を自由に微調整できる。

### 5.3 One-Hot二値化モーダル (`OneHotModal.tsx`)
カテゴリ変数の `[One-Hot]` ボタンをクリックすると開く専用モーダル。

- **ユニーク値リストと生成列名プレビュー**:
  - カテゴリの全水準（値、出現度数、割合）をテーブル表示。
  - 生成予定の列名（例: `Species_setosa`, `Species_versicolor`, `Species_virginica`）をタグ一覧でプレビュー。
- **詳細オプション**:
  - `Drop First Category`: 基準カテゴリを1つ落として $K-1$ 列にする（重回帰・多変量解析の多重共線性防止用）。
  - `Missing Values (NaN)`: `Create null dummy (Species_missing)` または `Keep as NaN across all dummies`。
- **カーディナリティガード**:
  - ユニーク値が 20 を超える高カーディナリティ変数の場合、自動的に「度数上位 N 件 + その他（Other）」への集約トグルを有効化し、不要な列の爆発的増加を防止。

### 5.4 PCP軸連携・UXフィードバック
1. **即時反映**:
   - `[Apply Transform]` を押すと、バックエンドで高速に列生成が行われ、PCPの軸選択ドロワーに新設列が追加される。
   - `[x] Add to PCP axes immediately` にチェックが入っていた場合、PCP画面に切り替わると自動的に新しい軸が描画列として配置される。
2. **軸順アルゴリズムとの統合**:
   - 生成された二値列や順序ビン列は、直ちに `ComponentOrder` や `PermuteOrder` の最適化対象に含まれ、カテゴリと連続値の複合的な関係をPCP上で分析できる。

---

## 6. テスト・検証計画

### 6.1 バックエンド単体テスト (`tests/unit/test_transform.py`)
- `TestNominalToBinary`:
  - 3水準のカテゴリ列のOne-Hot変換結果が $3$ 列の $\{0, 1\}$ に正しく写像されること。
  - `drop_first=True` で正しく $K-1$ 列になること。
  - 欠損値を含む場合の挙動検証。
- `TestBinning`:
  - Iris の `SepalLength` に対し `equal_width` 4分割で境界値とビン所属数が期待通りになること。
  - `quantile` 4分割で各ビンのカウントが均等（約37〜38件）になること。
  - 同一値が密集したデータで境界が重複した際のエラーハンドリング。

### 6.2 API・統合テスト (`tests/api/test_transform_api.py`)
- セッションリビジョンがインクリメントされ、Arrow IPCビューおよびサマリーAPIで新しい列が取得できること。
- PCPの軸順計算（ComponentOrder / PermuteOrder）に新設列を含めて正常終了すること。

### 6.3 E2Eテスト (`e2e/test_transform_ui.py`)
- OverviewPageでビニングモーダルを開き、ビン分割を実行。
- PCP画面へ遷移し、生成されたビン軸が有効化できることをPlaywrightで自動確認。

---

## 7. 実装ステップ

| Step | 作業内容 | 主要変更ファイル |
|---|---|---|
| 1 | バックエンドの変換サービス実装 | `backend/app/services/transform_service.py`, `backend/app/algorithms/transform/core.py` |
| 2 | データセットAPIに `/transform` および列削除エンドポイント追加 | `backend/app/api/datasets.py` |
| 3 | フロントエンド API クライアント & 型定義 | `frontend/src/api/client.ts`, `frontend/src/engine/types.ts` |
| 4 | OverviewPage に Transform モーダル & UI コンポーネント実装 | `frontend/src/features/dataset/TransformModal.tsx`, `OverviewPage.tsx` |
| 5 | PCP軸選択・ストア連携の動作確認とリグレッション試験 | `frontend/src/app/store.ts`, `features/pcp/PcpPage.tsx` |
| 6 | 単体・API・E2Eテストの作成・実行 | `tests/unit/test_transform.py`, `tests/api/test_transform_api.py` |
