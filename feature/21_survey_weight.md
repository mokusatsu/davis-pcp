<実装計画書: 調査ウェイト統合 (DAVIS-FEAT-021)>
文書ID: DAVIS-FEAT-021
版: 1.1.0
作成日: 2026-09-07
更新日: 2026-09-10
優先度: 2
前提仕様: DAVIS-FEAT-017
実装タスク・引き継ぎ: [tasks/DAVIS-FEAT-021-022.md](../tasks/DAVIS-FEAT-021-022.md#feature-21-調査ウェイト)

版1.1.0では、調査ウェイトの適用対象・非適用対象、非適用時のAPI/UI契約、負値等の検証結果を明確化した。
対象コンポーネント: 
- `fullstack/backend/app/algorithms/summaries/core.py`
- `fullstack/backend/app/api/v1/` 配下の全集計系エンドポイント
- `fullstack/frontend/src/features/selection/GlobalHeaderControlBar.tsx`
- `fullstack/frontend/src/app/store.ts`
- 各種コンポーネント（集計カード等）

---

## 1. 概要・目的
実務のアンケート分析においては、母集団構成との歪みを補正するために回答者ウェイトを用いた集計・分析が標準的である。本仕様では、既存のクラスタリング距離重みや探索スコアとは独立した「調査ウェイト」機能を導入し、加重平均、加重比率、加重度数の算出を可能にする。非加重の実人数（n）と加重値を併記することで、実務に即した分析と結果の透明性を提供する。

## 2. 要件定義
1. **ウェイト列指定**: コードブックにて `role=weight` が設定されている列、またはグローバルヘッダーのドロップダウンでウェイト列を指定できる。
2. **加重集計（第一段階範囲）**: 加重平均、加重比率、加重度数を算出する。
3. **併記表示**: 非加重の実人数(n)と加重値を並べて表示する。
4. **共通コンテキスト**: 対象APIには `weightColumn` を渡せるようにする。ただし、パラメータを受け取ることと、計算へ適用することは別に扱う。
5. **適用範囲の明示**: 加重計算を行う画面、行単位の値をそのまま表示する画面、未対応分析を明確に分ける。
6. **未対応分析の明示**: ウェイト適用未対応の分析結果には「ウェイト未適用」と明示する。
7. **制限事項の明示**: 画面上に「標準誤差は非加重n基準。母集団推論には調査設計情報が必要」との注記を表示する。
8. **将来拡張（本計画外）**: 層化、PSU/クラスター、複製ウェイトのサポートは第二段階とする。

### 2.1 適用対象と非適用対象

「ウェイトを選択できる」ことだけでは加重計算の完了とはみなさない。以下の表で、`加重計算`が「する」の行だけがFeature 21の加重結果を返す。

| 画面・API・処理 | `weightColumn` | 加重計算 | 表示・動作 |
|---|---:|---:|---|
| `POST /summaries` | 送る | **する** | 非加重nと加重平均・度数・比率を併記する |
| Distributionの設問カード、Statisticsの記述集計 | `/summaries`へ含める | **する** | `weightStatus=applied`、分母、注記を表示する |
| Feature 22のLikert分布 | `/summaries`へ含める | **する** | 非加重/加重の表示基準を明示して切り替える。検定p値は加重しない |
| Table、PCP、Selection、Focus、Delete、Reset | 送らない | **しない** | 元の行値・rowId・選択集合をそのまま扱う。ウェイトで行を増減させない |
| Mosaic、Bar Chart、FEDF、QQ、LOESS、Covariance | 受領可（未対応表示用） | **しない**（第一段階） | 結果を非加重で出す場合は「ウェイト未適用」を表示する。加重値を返さない |
| Mining、Ranking、Key Drivers、Penalty-Reward、Robustness | 受領可（未対応表示用） | **しない**（第一段階） | 既存のscore/距離/再標本化重みとは分離し、未適用理由を表示する |
| Models、Logistic、Discriminant、Clusters、PCA、Touring | 受領可（未対応表示用） | **しない**（第一段階） | 学習・距離・p値へ調査ウェイトを入れず、警告を返す |
| Relationships、Surprise、相関・検定 | 受領可（未対応表示用） | **しない**（第一段階） | Pearson/Kendall等は非加重のまま。母集団推論と誤認させない |
| `sampledRowWeights` | 別の既存パラメータ | **調査ウェイトではない** | 抽出行の重複回数・Table並べ替えだけに使い、`weightColumn`と合成しない |

非適用画面でウェイトを選択していても、分析値を加重値へ置き換えない。APIは`weightApplied=false`と`WEIGHT_UNSUPPORTED`を返し、UIは「ウェイト未適用」と表示する。Table/PCP/Selectionのような行単位の画面は、ウェイトを受け取らず、未適用警告も表示しない。その画面でウェイトが値を変えないことが仕様だからである。

## 3. GUI設計（ASCIIモックアップ付き）

**グローバルヘッダー (GlobalHeaderControlBar.tsx)**
```text
+---------------------------------------------------------------------------------+
| DAVIS-PCP   [データセット選択 ▼]   ウェイト: [weight_col ▼]  [設定] [ヘルプ]    |
+---------------------------------------------------------------------------------+
```

**集計カード表示**
```text
+-------------------------------------------------------------+
| 変数: Q1_満足度                             [ウェイト適用中] |
|-------------------------------------------------------------|
| 統計量         | 非加重 (n=1,200) | 加重 (n'=1,000.5)       |
|----------------+------------------+-------------------------|
| 平均           | 3.82             | 3.95                    |
| 大変満足 (5)   | 25.0% (300)      | 28.5% (285.1)           |
| やや満足 (4)   | 40.0% (480)      | 42.0% (420.2)           |
| ...            | ...              | ...                     |
|-------------------------------------------------------------|
| * 注: 標準誤差は非加重n基準。母集団推論には調査設計情報が必要 |
+-------------------------------------------------------------+
```

**ウェイト未対応の分析表示**
```text
+-------------------------------------------------------------+
| K-Means クラスタリング                                      |
| [! 警告: この分析はウェイト未適用です]                      |
| ...                                                         |
+-------------------------------------------------------------+
```

## 4. API仕様（エンドポイント、リクエスト/レスポンスJSON）

**エンドポイント**: `/api/v1/summaries`
**HTTPメソッド**: `POST`

Distributionの設問カード、Statistics、Feature 22のLikert分布はこの応答を利用するため加重対象である。Mosaic、Bar Chart、FEDF、Mining、Modelsなどは表2.1の非適用対象であり、`weightColumn`を受け取る場合も警告だけを返して加重値を返さない。

**リクエストJSON例**:
```json
{
  "datasetId": "dataset-001",
  "variables": ["Q1_満足度", "Q2_推奨意向"],
  "weightColumn": "weight_col"
}
```

**レスポンスJSON例**:
```json
{
  "status": "success",
  "weightStatus": "applied",
  "weightApplied": true,
  "weightColumn": "weight_col",
  "unweightedN": 1200,
  "weightedN": 1000.5,
  "data": {
    "Q1_満足度": {
      "type": "categorical",
      "unweighted": {
        "n": 1200,
        "mean": 3.82,
        "counts": {"5": 300, "4": 480},
        "percentages": {"5": 25.0, "4": 40.0}
      },
      "weighted": {
        "n": 1000.5,
        "mean": 3.95,
        "counts": {"5": 285.1, "4": 420.2},
        "percentages": {"5": 28.5, "4": 42.0}
      }
    }
  },
  "warnings": [],
  "dataRevision": 1,
  "schemaRevision": 2,
  "scopeHash": "..."
}
```

非適用分析の例は、分析結果を非加重のまま返す場合でも次のように明示する。

```json
{
  "status": "success",
  "weightStatus": "unsupported",
  "weightApplied": false,
  "warnings": [
    {
      "code": "WEIGHT_UNSUPPORTED",
      "message": "この分析は調査ウェイトを適用しません。"
    }
  ]
}
```

## 5. バックエンド実装詳細（変更対象ファイルと変更内容）

1. **`fullstack/backend/app/api/v1/summaries.py` 他**:
   - Pydanticモデル（リクエストスキーマ）に `weightColumn: Optional[str] = None` を追加。
   - レスポンスモデルを拡張し、`unweighted` と `weighted` の両方を格納できるように変更。

2. **`fullstack/backend/app/algorithms/summaries/core.py`**:
   - `calculate_summary` 関数に `weight_column` 引数を追加。
   - PandasまたはNumPyを用いた加重計算ロジック（加重平均 `np.average(x, weights=w)`、加重度数 `df.groupby().apply(lambda x: x[w].sum())`）を実装。
   - `unweighted` と `weighted` の結果辞書を生成して返す。
   - 指定された `weight_column` の値を検証する。nullは`weightMissingCount`へ数えてその行の加重分母から除外し、負数・NaN・無限値・変換不能値は422 `WEIGHT_VALUE_INVALID`として拒否する。負の重みを0扱いにして続行しない。

## 6. フロントエンド実装詳細（コンポーネント構成と状態管理）

1. **状態管理 (`fullstack/frontend/src/app/store.ts`)**:
   - `globalSettings` スライス等に `globalWeight: string | null` を追加。
   - `setGlobalWeight` アクションを定義。

2. **グローバルヘッダー (`fullstack/frontend/src/features/selection/GlobalHeaderControlBar.tsx`)**:
   - `globalWeight` を選択するドロップダウン（Selectコンポーネント）を追加。
   - 選択肢はコードブックで `role=weight` かつ数値尺度の変数だけを抽出して表示する。数値型でもroleがweightでない列は候補にしない。

3. **集計コンポーネント (`fullstack/frontend/src/features/summaries/SummaryCard.tsx` 等)**:
   - APIレスポンスから `unweighted` と `weighted` を受け取り、テーブルまたはグリッド形式で併記する。
   - ウェイト適用時（`globalWeight !== null`）は、カード右上に「ウェイト適用中」バッジを表示し、下部に「標準誤差は非加重n基準。母集団推論には調査設計情報が必要」という注記テキストを表示する。
   - ウェイト未対応のコンポーネントには、「ウェイト未適用」のアラート（Ant Design の Alert 等）を表示する。

## 7. テスト計画（pytest単体、Vitest単体、E2Eシナリオ）

- **pytest (バックエンド)**
  - `test_weighted_mean`: 既知のデータとウェイトで算出される加重平均が手計算（期待値）と一致するか検証。
  - `test_weighted_pct`: 加重割合（カテゴリ比率）が正しく計算されるか検証。
  - `test_unweighted_coexistence`: APIレスポンスに非加重値（unweighted）と加重値（weighted）が正しく同時に含まれているか検証。
  - `test_weight_column_validation`: ウェイト列に負の値、NaN、無限値、不正な文字列が含まれる場合に422 `WEIGHT_VALUE_INVALID`となり、nullだけは`weightMissingCount`へ数えられることを検証。
  - `test_unsupported_analysis_weight_warning`: 非適用分析へ`weightColumn`を渡したとき、加重値を返さず`weightApplied=false`と`WEIGHT_UNSUPPORTED`を返すことを検証。

- **Vitest (フロントエンド)**
  - `test_global_weight_state`: Reduxストアで `setGlobalWeight` が正しく状態を更新するか検証。
  - `test_summary_card_render`: `unweighted` と `weighted` のデータが渡されたとき、両方の値が正しくレンダリングされ、注記が表示されるか検証。
  - `test_analysis_without_weight_shows_note`: 未対応コンポーネントでウェイトが選択されている場合、「ウェイト未適用」の警告が表示されるか検証。

- **E2E (Playwright等)**
  - ユーザーがデータセットをロードし、ヘッダーからウェイト列を選択後、ダッシュボードの集計カードが加重値/非加重値併記に更新されるシナリオ。

## 8. 実装手順チェックリスト（エージェントが順に実行する手順）

- [ ] 1. バックエンド: 表2.1の適用対象・非適用対象をAPI一覧へ反映し、適用対象のリクエストスキーマに `weightColumn` パラメータを追加。
- [ ] 2. バックエンド: `core.py` など集計エンジンに加重計算（加重平均、加重比率、加重度数）のロジックを実装。
- [ ] 3. バックエンド: レスポンス形式を改修し、`unweighted` と `weighted` を返すように変更。
- [ ] 4. バックエンド: pytestを実行し、`test_weighted_mean` などのテストケースを追加・パスさせる。
- [ ] 5. フロントエンド: Redux store (`store.ts`) に `globalWeight` の状態とアクションを追加。
- [ ] 6. フロントエンド: `GlobalHeaderControlBar.tsx` にウェイト選択ドロップダウンを追加。
- [ ] 7. フロントエンド: 集計コンポーネント（カード等）を修正し、加重・非加重の併記UIおよび注記テキストを追加。
- [ ] 8. フロントエンド: ウェイト未対応コンポーネントに警告表示を追加。
- [ ] 9. フロントエンド: Vitestでコンポーネントと状態管理のテストを追加・パスさせる。
- [ ] 10. 全体動作確認: 結合テストおよびE2Eテストシナリオの動作確認を行う。
- [ ] 11. Feature 21の受入時に、表2.1の各行をAPI応答・画面表示・非加重動作のいずれかで確認し、適用対象を暗黙に増やしていないことを記録する。
