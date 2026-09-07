# 実装計画書: コードブック全系伝播・統合連携アーキテクチャ (Codebook System-wide Propagation & Integration)

文書ID: DAVIS-FEAT-019B  
版: 1.0.0  
作成日: 2026-09-07  
優先度: 1 (最優先・全機能の共通基盤)  
前提仕様: DAVIS-FEAT-017 (データモデル), DAVIS-FEAT-018 (エディタGUI), DAVIS-FEAT-019 (設問別分母)  
対象コンポーネント:
- `backend/app/domain/codebook_adapter.py` (新規: 共通アダプタ)
- `backend/app/storage/dataset_store.py`
- `backend/app/algorithms/` (mining, summaries, models, imputation, ordering, relationships)
- `backend/app/api/` (datasets, summaries, mining, models, exports)
- `frontend/src/features/pcp/pcpRenderer.ts`
- `frontend/src/features/pcp/useDatasetColumns.ts`
- `frontend/src/features/table/TablePage.tsx`
- `frontend/src/features/mosaic/LineMosaicCanvas.tsx`
- `frontend/src/features/distribution/`
- `frontend/src/features/mining/`
- `frontend/src/features/models/`
- `frontend/src/app/store.ts`

---

## 1. 概要・目的

### 1.1 背景と課題
DAVIS-FEAT-017で「コードブック」のデータ構造が定義され、FEAT-018で編集UIが設計された。しかし、**コードブックに定義された情報（カテゴリ順序、値ラベル、尺度水準、質問/属性役割、逆転フラグ、欠損コード）が、各分析画面やバックエンドアルゴリズムに正しく伝播・消費されなければ、ツール全体の信頼性は保たれない**。

4件の監査レポート（Audit-1〜3）では、以下のような致命的な「非連動・破壊」が実証されている：
1. **順序と目盛りの不一致**: PCPのカテゴリ軸やモザイク図が、意図した順序（`categoryOrder`）ではなく、出現順や文字列コード順で描画される。
2. **ラベル非適用の暗号的表示**: PCPのツールチップ、マイニングの発見ルール、決定木の分岐条件に、元の数値コード（`1`, `2`）がそのまま表示され、アンケートの選択肢（`"大いに不満"`, `"やや不満"`）が分からない。
3. **型名不一致による機能不全**: バックエンドの `categorical` とフロントエンドの `nominal/ordinal/text` の乖離により、カテゴリ抽出が空になり全変数フォールバックが起きる（Audit-1 A05 / Audit-2 S01）。
4. **役割メタデータの無視**: マイニングアルゴリズムが質問/属性のロールを正しく解釈せず、属性プールが空になって探索候補が0件になる（Audit-1 A06 / Audit-3 D08）。
5. **補完や変換によるスキーマの蒸発**: 欠損補完（impute）を実行すると `probe_table` が再実行され、手動で設定したコードブック定義や columnId が初期化・消失する（Audit-1 A12 / Audit-3 D06）。
6. **キャッシュ不整合**: 尺度やラベルを変更しても、以前の数値集計キャッシュが `cacheHit` で返る（Audit-2 B05）。

### 1.2 解決方針
本仕様では、コードブックをシステム全体の **「唯一の真実（Single Source of Truth）」** として確立し、全パイプライン（データ取込 $\to$ 前処理 $\to$ アルゴリズム実行 $\to$ 可視化描画 $\to$ エクスポート）に漏れなく伝播させる統合アーキテクチャを定義する。

---

## 2. コードブック属性別の全系伝播仕様マトリクス

| コードブック属性 | 影響を受けるコンポーネント | 具体的な伝播・消費動作の仕様 |
|---|---|---|
| **`categoryOrder`**<br>(カテゴリ表示順) | **PCP (平行座標プロット)** | 軸上の目盛り（ティック）を上から下（または下から上）へ `categoryOrder` の完全一致順序で配置。出現しないカテゴリも順序位置を保持。 |
| | **Line Mosaic Plot** | 各分割軸のセル配置順序を `categoryOrder` に準拠。 |
| | **Distribution / BarChart** | 横棒グラフ・度数分布のカテゴリ並び順を `categoryOrder` に準拠。 |
| | **Crosstab (クロス集計)** | 表頭・表側の行・列の表示順を `categoryOrder` に準拠。 |
| | **軸順計算 (Ordering)** | 順序尺度を数値化（1..K）して相関を計算する際、`categoryOrder` の順序インデックスを使用。 |
| **`valueLabels`**<br>(コード $\to$ ラベル) | **PCP** | 軸目盛りに数値コードではなくラベルを表示（文字数制限＋ホバーで完全名）。ホバーツールチップに `コード: ラベル` を併記。 |
| | **Table (データテーブル)** | テーブルヘッダーに「コード表示 ⇄ ラベル表示」トグルを新設。セル表示をラベルへ置換可能。 |
| | **Subgroup Mining** | 発見条件文をラベル化（例: `Q1 == 1` ではなく `Q1 == "大いに不満"`）。インサイト解釈文にもラベルを埋め込む。 |
| | **決定木 / モデル** | 分岐条件テキストをラベル化（例: `Q1 <= 2.5` $\to$ `Q1 in [大いに不満, やや不満]`）。目的変数クラス名をラベル化。 |
| | **CSV/Excelエクスポート** | エクスポートモーダルで「生コード値」と「ラベル置換値」を選択可能に。 |
| **`scaleType`**<br>(尺度水準: 6種) | **全フロントエンド型判定** | `nominal`, `ordinal`, `interval`, `ratio`, `text`, `id` の6種を共通型定義とし、フロントの判定ロジックを一元化。 |
| | **PCP軸描画** | `nominal`/`ordinal`/`text` は離散カテゴリ軸（等間隔ティック、ジッター可能）。`interval`/`ratio` は連続数値軸。`id` は既定で非表示。 |
| | **統計検定・相関自動選択** | 2群比較: 名義(χ²), 順序(Mann-Whitney U), 数値(Welch t)。相関: 名義(Cramér's V), 順序(Kendall τb), 数値(Pearson r)。 |
| | **クラスタリング / 次元削減** | PCA: 連続数値のみ（順序はオプション）。Cobweb/DISC: 名義・順序を受け入れ。MCA: 名義・順序のみ対象。 |
| **`role`**<br>(設問役割: 5種) | **Subgroup Mining** | 条件説明変数プール = `role == 'attribute'`。ターゲット評価変数プール = `role == 'question'`。`id`/`weight` は除外。 |
| | **KDA / PRA** | 目的変数 = `role == 'question'`。説明ドライバー = `role in ['question', 'attribute']`。 |
| | **Global Selector** | 共通変数マネージャに「設問（質問）のみ」「属性（セグメント）のみ」のクイックフィルタを提供。 |
| **`missingCodes` & `missingReasons`** | **データ取込 / パース** | 指定コードのみを欠損値として認識。指定外の99等は正常値として保持。 |
| | **設問別分母 (FEAT-019)** | 理由が「非該当」は対象者数から除外、「無回答」は有効回答数から除外。 |
| | **相関・共分散計算** | ペアワイズで欠損組を除外（0埋め禁止）。計算不能時は0ではなく `null` を返却。 |
| | **欠損補完 (Imputation)** | 「非該当（スキップ）」は補完禁止。「無回答」のみを補完対象とする。 |
| **`isReversed`**<br>(逆転項目) | **PCP** | 軸描画の上下方向（最小値〜最大値）を視覚的に反転。 |
| | **相関 / KDA / スコア** | 計算空間において値を自動反転（$X_{rev} = \max + \min - X$）して相関や寄与度を算出。 |
| **不変条件 (Invariants)** | **全データ変換・補完操作** | 補完（impute）、変数変換（transform）、派生列作成後も既存列のコードブック属性・columnIdを100%継承。 |
| **キャッシュ整合性** | **全分析キャッシュ** | コードブック更新で `schemaRevision` をインクリメント。キャッシュキーに含めて古い集計結果を自動無効化。 |

---

## 3. GUI設計（各ビューにおけるコードブック反映）

### 3.1 PCP (平行座標プロット) における値ラベル・順序・逆転表示

```text
+---------------------------------------------------------------------------------------------------------+
| [PCP View]   軸表示: [ 5 / 8 変数 ]   ラベル表示: [● ラベル / ○ コード]   ジッター: [──●──] 0.15         |
+---------------------------------------------------------------------------------------------------------+
|     gender               Q1_satisfaction             Q2_ease_of_use              age                    |
|   (名義・属性)           (順序・質問) [逆転▼]        (順序・質問)            (比率・属性)               |
|       │                         │                         │                         │ 80                |
|  女性 ┼─────────────────────────┼ 大いに満足        大いに満足 ┼─────────────────────────┼                   |
|       │                         │                         │                         │                   |
|       │                         │ やや満足          やや満足   ┼                         │ 60                |
|       │                         │                         │                         │                   |
|       │                         │ どちらでもない  どちらでもない ┼                      │                   |
|       │                         │                         │                         │ 40                |
|       │                         │ やや不満          やや不満   ┼                         │                   |
|       │                         │                         │                         │                   |
|  男性 ┼─────────────────────────┼ 大いに不満        大いに不満 ┼─────────────────────────┼ 20                |
|       │                         │                         │                         │                   |
|  ※ categoryOrder通りに配置   ※ [逆転]で上下反転        ※ 値ラベルで目盛り描画     ※ 連続軸            |
+---------------------------------------------------------------------------------------------------------+
```

### 3.2 データテーブルにおける「コード ⇄ ラベル」表示切替

```text
+---------------------------------------------------------------------------------------------------------+
| [Table View]  行スコープ: [ Active (1,200行) ▼ ]    セル値表示: [ (●) 値ラベル表示  (○) 生コード値表示 ]  |
+---------------------------------------------------------------------------------------------------------+
| 行ID    | gender (性別)    | Q1_satisfaction (総合満足度) | Q2_ease_of_use (使いやすさ) | age (年齢) |
+---------+------------------+------------------------------+-----------------------------+------------+
| row-001 | 女性 (2)         | 大いに満足 (5)               | やや満足 (4)                | 28         |
| row-002 | 男性 (1)         | やや不満 (2)                 | どちらでもない (3)          | 45         |
| row-003 | 男性 (1)         | [無回答] (99) ⚠              | やや満足 (4)                | 34         |
| row-004 | 女性 (2)         | [非該当] (98)                | [非該当] (98)               | 62         |
+---------+------------------+------------------------------+-----------------------------+------------+
| ※ セルホバーで「生コード: 5 / ラベル: 大いに満足」をツールチップ表示。欠損コードは理由別に色分けバッジ表示。|
+---------------------------------------------------------------------------------------------------------+
```

### 3.3 マイニング・モデル出力における条件式のラベル自然言語化

```text
+─ 発見カード #1 ─────────────────────────────────────────────────────────────────+
│ 条件: [ 性別 == "女性" ] かつ [ 年代 == "20代" ]  (該当 n=185)                  │
│ 対象質問: Q1_satisfaction (総合満足度)                                          │
│                                                                                 │
│  平均評価: 4.12 (等間隔得点)  [ 全体平均 3.28 より +0.84 高い ]                 │
│  回答分布:                                                                      │
│   大いに不満   █░░░░░░░░░░░░░░░░░░░░░░   2.2% ( 4人)                            │
│   やや不満     ██░░░░░░░░░░░░░░░░░░░░░   5.4% (10人)                            │
│   どちらでもない ████░░░░░░░░░░░░░░░░░░░  12.4% (23人)                          │
│   やや満足     ██████████████░░░░░░░░░  43.2% (80人)  Top2合算: 80.0%           │
│   大いに満足   ████████████░░░░░░░░░░░  36.8% (68人)                            │
│                                                                                 │
│ ※ 条件式に数値コード「gender == 2」ではなく値ラベル「性別 == "女性"」を表示。   │
+─────────────────────────────────────────────────────────────────────────────────+
```

### 3.4 エクスポートモーダルにおける出力形式選択

```text
+─ 📤 データエクスポート ─────────────────────────────────────────────────────────+
│ エクスポート形式: [ CSVファイル (.csv) ▼ ]                                      │
│ 対象行:           [ 現在のアクティブ行 (1,150行) ▼ ]                            │
│ 対象列:           [ コードブックの全列 (45変数) ▼ ]                             │
│                                                                                 │
│ ▼ 値ラベルの出力設定:                                                           │
│   (○) 生コード値を出力 (例: 1, 2, 5) — 統計解析ソフト・再投入向け              │
│   (●) 値ラベルを出力 (例: "男性", "女性", "大いに満足") — レポート・集計向け    │
│   (○) コードとラベルの両方を出力 (列を複製して `Q1_code`, `Q1_label` とする)    │
│                                                                                 │
│ 欠損値の出力形式:                                                               │
│   [ 空白 (NULL) ▼ ]   (選択肢: 空白 / 元の欠損コード(98,99) / 欠損理由テキスト) │
│                                                                                 │
│                                                     [ キャンセル ] [ 出力実行 ] │
+─────────────────────────────────────────────────────────────────────────────────+
```

---

## 4. バックエンド実装アーキテクチャ

### 4.1 共通アダプタモジュール (`CodebookAdapter`)
各アルゴリズム（マイニング、モデル、集計、PCA等）がコードブックを直接解釈するとロジックが散乱・重複するため、中間アダプタ `CodebookAdapter` を新設する。

```python
# backend/app/domain/codebook_adapter.py

from typing import Any, Dict, List, Optional, Tuple
import polars as pl
import numpy as np

class CodebookAdapter:
    """Polars DataFrame と Codebook メタデータを結合し、アルゴリズムが必要とする
    型安全かつ正規化されたビューを提供するアダプタ。"""

    def __init__(self, df: pl.DataFrame, codebook: Dict[str, Any]):
        self.df = df
        self.codebook = codebook
        self._columns_by_id = {c["columnId"]: c for c in codebook.get("columns", [])}
        self._columns_by_name = {c["name"]: c for c in codebook.get("columns", [])}

    def get_column_spec(self, col_identifier: str) -> Dict[str, Any]:
        """columnId または name のどちらからでもカラム定義を取得"""
        if col_identifier in self._columns_by_id:
            return self._columns_by_id[col_identifier]
        if col_identifier in self._columns_by_name:
            return self._columns_by_name[col_identifier]
        raise KeyError(f"Column '{col_identifier}' not found in codebook.")

    def get_attribute_columns(self) -> List[str]:
        """Subgroup Mining 等の説明変数プール (role == 'attribute')"""
        return [
            c["name"] for c in self.codebook.get("columns", [])
            if c.get("role") == "attribute"
        ]

    def get_question_columns(self) -> List[str]:
        """Subgroup Mining 等の評価変数プール (role == 'question')"""
        return [
            c["name"] for c in self.codebook.get("columns", [])
            if c.get("role") == "question"
        ]

    def get_ordered_categories(self, col_name: str) -> List[str]:
        """指定変数の正規化されたカテゴリ順序 (categoryOrder) を返却"""
        spec = self.get_column_spec(col_name)
        return spec.get("categoryOrder", [])

    def label_for_value(self, col_name: str, val: Any) -> str:
        """値からラベルへの変換（ラベル未定義時は元の値を文字列化）"""
        spec = self.get_column_spec(col_name)
        val_str = str(val)
        return spec.get("valueLabels", {}).get(val_str, val_str)

    def mask_missing_values(self, col_name: str) -> pl.Series:
        """コードブックに定義された missingCodes を NULL に置換した Series を返却"""
        spec = self.get_column_spec(col_name)
        missing_codes = [str(c) for c in spec.get("missingCodes", [])]
        series = self.df[col_name]
        if not missing_codes:
            return series
        
        # 文字列化して判定し、一致するセルを null 化
        return pl.when(series.cast(pl.Utf8).is_in(missing_codes))\
                 .then(None)\
                 .otherwise(series)

    def get_reversed_numeric_series(self, col_name: str) -> pl.Series:
        """逆転項目 (isReversed=True) の場合、値を反転させた数値を返却"""
        spec = self.get_column_spec(col_name)
        series = self.mask_missing_values(col_name)
        if not spec.get("isReversed", False):
            return series

        max_val = series.max()
        min_val = series.min()
        if max_val is None or min_val is None:
            return series
        return (max_val + min_val) - series
```

### 4.2 補完・派生列追加時のコードブック保護コントラクト
補完サービス (`dataset_service.py`) および API (`datasets.py`) において、補完後のテーブルを再保存する際、`probe_table` でスキーマをゼロから再生成する処理を禁止する。

```python
# backend/app/services/dataset_service.py (改修方針)

def apply_imputation(
    self, dataset_id: str, column_id: str, method: str, in_place: bool
) -> Dict[str, Any]:
    # 1. 既存のコードブックを取得
    codebook = self.store.get_codebook(dataset_id)
    
    # 2. 補完処理を実行 (対象列の null を補完)
    imputed_df, mask = self._run_impute(dataset_id, column_id, method)
    
    if in_place:
        # 3. 既存コードブックの定義を完全に維持し、dataRevision のみを更新
        new_data_revision = self.store.increment_data_revision(dataset_id)
        self.store.save_dataset_table(dataset_id, imputed_df)
        self.store.save_imputation_mask(dataset_id, column_id, mask)
        # ※ probe_table は実行しない。既存の codebook をそのまま維持。
        return {"datasetId": dataset_id, "dataRevision": new_data_revision}
    else:
        # 別データセットとして保存する場合
        new_id = self.store.create_derived_dataset(
            source_id=dataset_id,
            df=imputed_df,
            codebook=codebook # 元のコードブックを完全に複製
        )
        return {"datasetId": new_id}
```

### 4.3 キャッシュ無効化ルール (`schemaRevision`)
バックエンドの全集計・分析キャッシュキーに `schemaRevision` を必須とする。

```python
cache_key = f"{dataset_id}:{data_revision}:{schema_revision}:{scope}:{sorted_row_ids_hash}:{algorithm_params}"
```
これにより、ユーザーがコードブックエディタで変数の尺度を「名義」から「順序」に変えたり、値ラベルを変更した瞬間、すべての旧キャッシュが無効化され、新しい定義に基づいた検定や集計が再計算される。

---

## 5. フロントエンド実装アーキテクチャ

### 5.1 共通カラム情報フック (`useCodebookColumn`)
各コンポーネントでコードブック情報を安全かつ簡潔に取り出すためのカスタムフックを提供する。

```typescript
// frontend/src/features/dataset/useCodebookColumn.ts

import { useSelector } from 'react-redux';
import { RootState } from '../../app/store';

export interface EnrichedColumnSpec {
  columnId: string;
  name: string;
  label: string;
  scaleType: 'nominal' | 'ordinal' | 'interval' | 'ratio' | 'text' | 'id';
  role: 'question' | 'attribute' | 'weight' | 'id' | 'other';
  valueLabels: Record<string, string>;
  categoryOrder: string[];
  missingCodes: string[];
  isReversed: boolean;
  // ヘルパー関数
  getLabel: (val: any) => string;
  getTickLabels: () => { value: string; label: string }[];
}

export function useCodebookColumn(colNameOrId: string): EnrichedColumnSpec | undefined {
  const codebook = useSelector((state: RootState) => state.codebook.current);
  if (!codebook) return undefined;

  const col = codebook.columns.find(
    (c) => c.columnId === colNameOrId || c.name === colNameOrId
  );
  if (!col) return undefined;

  const getLabel = (val: any): string => {
    const valStr = String(val);
    return col.valueLabels[valStr] || valStr;
  };

  const getTickLabels = () => {
    const order = col.categoryOrder.length > 0 
      ? col.categoryOrder 
      : Object.keys(col.valueLabels);
    return order.map((val) => ({
      value: val,
      label: col.valueLabels[val] || val,
    }));
  };

  return {
    ...col,
    getLabel,
    getTickLabels,
  };
}
```

### 5.2 PCP レンダラ (`pcpRenderer.ts`) の改修
1. **軸スケールの構築**:
   - カラムの `categoryOrder` が存在する場合、D3の `scalePoint()` または `scaleOrdinal()` のドメインに `categoryOrder` 配列をそのまま渡す。
   - `isReversed: true` の場合、スケールの `range([height, 0])` と `range([0, height])` を反転。
2. **軸目盛りテキストの描画**:
   - `tickFormat` に `col.getLabel` を適用。
   - ラベルが長い場合は 12 文字で切り捨て、ツールチップで完全名を表示。

---

## 6. テスト計画

### 6.1 バックエンド単体テスト (pytest)
- **`test_codebook_adapter_role_separation`**:
  - `role="attribute"` と `role="question"` が混在するデータで、`get_attribute_columns()` と `get_question_columns()` が正確に分離されること（Audit-1 A06 再発防止）。
- **`test_category_order_in_ordering_and_mosaic`**:
  - `categoryOrder=["3","1","2"]` と定義された列に対し、相関計算やモザイク分割でこの並び順が厳密に守られること。
- **`test_imputation_preserves_codebook`**:
  - 平均補完を適用した後、対象列および他列の `scaleType`, `valueLabels`, `columnId` が一切変化しないこと（Audit-1 A12 再発防止）。
- **`test_cache_invalidation_on_codebook_update`**:
  - コードブックを更新した際、`schemaRevision` がインクリメントされ、直前の集計結果キャッシュがヒットせず再計算されること。
- **`test_missing_codes_pairwise_correlation`**:
  - `missingCodes=["99"]` の列を含む相関計算で、99を含む組が除外され、相関が 0 に丸められないこと（Audit-2 B04 再発防止）。

### 6.2 フロントエンド単体テスト (Vitest) & E2Eテスト (Playwright)
- **`useCodebookColumn.test.ts`**:
  - `categoryOrder` や `valueLabels` が未定義の古いデータセットでも安全なフォールバック値が返ること。
- **E2E シナリオ 1: PCP の値ラベル & カテゴリ順序反映**:
  1. コードブックエディタで `Q1` を順序尺度とし、カテゴリ順を `["不満", "普通", "満足"]` に設定。
  2. PCP 画面へ移動し、`Q1` 軸の目盛りにコードではなく `"不満"`, `"普通"`, `"満足"` が下から上に順に並んでいることを確認。
- **E2E シナリオ 2: マイニング発見ルールのラベル表示**:
  1. サブグループマイニングを実行。
  2. 発見されたインサイトカードの条件式が `Q1 == "満足"` とラベル表示されていることを確認。
- **E2E シナリオ 3: 補完実行後のPCPラベル保持**:
  1. 欠損補完を実行。
  2. 補完後もPCPおよびテーブル画面で設定した値ラベルや順序が消えずに維持されていることを確認。

---

## 7. 実装手順チェックリスト

- [ ] **Step 1**: `backend/app/domain/codebook_adapter.py` を作成し、DataFrameとコードブックを紐付ける基本クラスを実装。
- [ ] **Step 2**: `backend/app/algorithms/mining/modern_subgroup.py` および `subgroup.py` を改修し、`CodebookAdapter` から質問/属性プールを取得するように統一（A06バグの根絶）。
- [ ] **Step 3**: `backend/app/services/dataset_service.py` の補完・変換処理を改修し、`probe_table` によるスキーマ上書きを防止（A12バグの根絶）。
- [ ] **Step 4**: `backend/app/api/summaries.py` および `mining.py` のキャッシュキーに `schemaRevision` を追加。
- [ ] **Step 5**: `backend/app/api/exports.py` に値ラベル置換エクスポートオプションを実装。
- [ ] **Step 6**: `frontend/src/features/dataset/useCodebookColumn.ts` カスタムフックを実装。
- [ ] **Step 7**: `frontend/src/features/pcp/pcpRenderer.ts` を改修し、`categoryOrder` に基づく軸スケール配置とラベル描画を実装。
- [ ] **Step 8**: `frontend/src/features/table/TablePage.tsx` に「コード ⇄ ラベル」表示切替トグルを実装。
- [ ] **Step 9**: `frontend/src/features/mining/ModernSubgroupMiningView.tsx` の条件式・説明文描画を値ラベル対応に改修。
- [ ] **Step 10**: バックエンドpytest（アダプタ、補完保全、キャッシュ無効化）およびフロントVitestを実行し、全テストの通過を確認。
