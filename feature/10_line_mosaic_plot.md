# 実装計画書: Line Mosaic Plot (ラインモザイクプロット)

文書ID: DAVIS-FEAT-010  
版: 1.0.0  
作成日: 2026-09-04  
優先度: 5  
対象コンポーネント: Backend (Mosaic Aggregation API), Frontend (Line Mosaic Canvas/SVG Renderer, Target Variable & Linked Brushing)  

---

## 1. 概要・目的

### 1.1 背景と目的
**Line Mosaic Plot（ラインモザイクプロット）** は、成均館大学の Moon Yul Huh 教授が考案し、2004年に国際統計計算会議（COMPSTAT 2004）で発表し、DAVIS の拡張モジュールとして正式実装された独自の多次元カテゴリカルデータ可視化手法である（Huh 2004, COMPSTAT）。

従来のモザイクプロット（Friendly 1994 等）は、多次元分割表のセル度数を「長方形の面積」で表現するが、変数の数が増えるにつれてアスペクト比が極端に細長くなったり、非整列な矩形同士の面積比較が視覚認知上困難になるという重大な課題を抱えていた。
これに対し Huh 教授が開発した Line Mosaic Plot では、以下の革新的アプローチが採用された：

1. **「面積」から「整列された線の長さ」への転換**:
   - 多次元クロス表の全セルを規則正しい長方形の格子（Grid Box）に配置し、セル度数を**ボックス内の水平な「線の長さ」**として共通スケール上で表現する。
2. **階層的ギャップ（Hierarchical Gaps）**:
   - 上位階層のカテゴリ境界には広い隙間、下位階層には狭い隙間を自動配置し、変数の階層構造を一目で識別可能にする。
3. **目的変数（Target Variable）の色分け分割**:
   - 分類問題（例: タイタニック号の生存/死亡、疾患の有無）において目的変数を選択すると、各セル内の線が目的変数の比率に応じて色分け分割され、サブグループごとの条件付き確率を直感的に比較できる。

本機能では、Huh 教授の 2004 年原論文の定式化に厳密に準拠してアルゴリズムを完全再現し、PCPやデータテーブルとの双方向連動ブラッシング基盤として実装する。

### 1.2 元のDAVISにおける原典根拠
- **2004年原論文 (PAPER-2004)**:
  - Moon Yul Huh, 『Line Mosaic Plot: Algorithm and Implementation』, COMPSTAT 2004:
    - 2次元モザイク配列 $F(I, J)$ の再帰的生成式
    - 最大度数による正規化長 $\text{Length} = F(I, J) / \max(F)$
    - 3次元目的変数配列 $F(I, J, K)$ と色分けセグメンテーション
    - Figure 4: DAVIS 上での実稼働画面（Titanic データの可視化例）
- **2005年発表資料 (SLIDES-2005)**:
  - Slide 13: `Multivariate plots: Line Mosaic Plot`

---

## 2. 現代フルスタックシステムにおける設計仕様

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend UI                            │
│  [新ナビゲーションタブ: "Mosaic" (Line Mosaic Plot)]        │
│  ┌─────────────────────────────────┐  ┌───────────────────┐ │
│  │ 1. Line Mosaic Canvas/SVG       │  │ 2. 凡例 & 変数設定│ │
│  │  - 行変数 / 列変数の階層ラベル  │  │  - 列変数 (奇数番)│ │
│  │  - 整列されたセルボックス       │  │  - 行変数 (偶数番)│ │
│  │  - セル度数に応じた線長描画     │  │  - Target Variable│ │
│  │  - 目的変数による色分けセグメント│ │    選択ドロップダウン│
│  │  - セルホバー (度数・比率・オッズ)│ │  - 階層ギャップ幅  │ │
│  └─────────────────────────────────┘  └───────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 3. 選択操作                                            │ │
│  │  - セルクリック / 矩形ブラシで特定セグメントを選択     │ │
│  │  - 右クリック: Focus / Delete / Undo / Identify        │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │ 双方向同期 (Redux / Zustand)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Shared Selection State                      │
│    - クリックされたセルに属する行IDがPCPやTableへ即時同期   │
│    - PCPで選択された行がモザイクプロット上で即時強調        │
└──────────────────────────────┬──────────────────────────────┘
                               │ POST /api/summaries/line_mosaic
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend (FastAPI)                         │
│  [MosaicService]                                            │
│    - 多次元クロス集計 ($p$ 変数グループ化)                   │
│    - 奇数変数を列インデックス $I$、偶数変数を列 $J$ へ畳み込み│
│    - 目的変数 $K$ ごとの度数カウント                         │
│    - 各セルに該当する rowId リストのインデックス作成         │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 詳細アルゴリズム仕様 (Huh 2004 原論文準拠)

### 3.1 2次元モザイク配列 $F(I, J)$ への写像

$p$ 個のカテゴリ変数 $V_1, V_2, \dots, V_p$ を考える。各変数 $V_m$ は $c_m$ 個の水準を持つ。

1. **行・列への交互変数割り当て**:
   - 列方向（Horizontal / Column $J$）: 奇数番目の変数群 $\{V_1, V_3, V_5, \dots\}$
   - 行方向（Vertical / Row $I$）: 偶数番目の変数群 $\{V_2, V_4, V_6, \dots\}$
2. **多次元インデックスの2次元平坦化**:
   各データ行のカテゴリ値 $(k_1, k_2, \dots, k_p)$（$1 \le k_m \le c_m$）に対し、セル座標 $(I, J)$ は次式で一意に定まる：
   $$J = 1 + \sum_{m \in \text{odd}} (k_m - 1) \prod_{r \in \text{odd}, r > m} c_r$$
   $$I = 1 + \sum_{m \in \text{even}} (k_m - 1) \prod_{r \in \text{even}, r > m} c_r$$
   ※ 原論文は逆に $(I, J)$ から元のカテゴリ水準を復元する逆写像式も与えている。
3. **セル度数の正規化と描画**:
   - 各セル $(I, J)$ の全度数を $F(I, J)$ とする。
   - 最大セル度数 $M = \max_{I, J} F(I, J)$。
   - セル幅を $W_{\text{box}}$ としたとき、線の描画長は：
     $$\text{LineLength}(I, J) = W_{\text{box}} \times \frac{F(I, J)}{M}$$
   - 全ての線はボックスの左端から右に向かって描画され、一目で相対度数を比較できる。

### 3.2 目的変数（Target Variable）による色分けセグメンテーション

目的変数 $T$ が $K$ 個の水準を持つ場合、配列は3次元 $F(I, J, k)$ となる。
各セル内で、線は各水準の度数比率に応じて分割される：
- セグメント $k$ の長さ:
  $$\text{SegLength}(I, J, k) = W_{\text{box}} \times \frac{F(I, J, k)}{M}$$
- 各セグメントは水準ごとのパレット色（例: 生存=Blue, 死亡=Orange）で連続して描画される。
- これにより、「どのセル（属性の組み合わせ）で目的変数の比率が高いか」が直感的に判明する。

### 3.3 階層的ギャップ（Hierarchical Gaps）の計算
- 上位の変数（$V_1, V_2$）の境界には広い隙間 $G_{\text{major}}$（例: 16px）。
- 下位の変数（$V_3, V_4$）の境界には中程度の隙間 $G_{\text{minor}}$（例: 4px）。
- これにより、グリッド構造が視覚的に木構造（Tree Hierarchy）として知覚される。

### 3.4 共有ブラッシング連動
- 各セル $(I, J)$（またはセグメント $(I, J, k)$）には、その条件に合致するデータセットの `row_id` リストが紐付けられている。
- ユーザーがセルをクリックすると、そのセルの全サンプルが選択状態（`selectedRowIds`）になり、PCP画面に切り替えた際に該当サンプルのポリライン群が強調表示される。

---

## 4. API設計

### 4.1 エンドポイント仕様

#### `POST /api/summaries/line_mosaic`
選択した変数群に基づくLine Mosaicプロット用集計データを取得する。

**リクエストボディ (JSON)**:
```json
{
  "dataset_id": "titanic-uuid",
  "column_variables": ["Class", "Age"],
  "row_variables": ["Sex"],
  "target_variable": "Survived"
}
```

**レスポンス (JSON)**:
```json
{
  "grid": {
    "n_cols": 8,
    "n_rows": 2,
    "col_labels": [
      { "path": ["1st", "Child"], "j": 1 },
      { "path": ["1st", "Adult"], "j": 2 },
      "..."
    ],
    "row_labels": [
      { "path": ["Male"], "i": 1 },
      { "path": ["Female"], "i": 2 }
    ]
  },
  "target": {
    "name": "Survived",
    "categories": ["No", "Yes"],
    "colors": ["#e15759", "#4e79a7"]
  },
  "max_cell_frequency": 387,
  "cells": [
    {
      "i": 1,
      "j": 2,
      "total_count": 175,
      "target_counts": { "No": 118, "Yes": 57 },
      "row_ids": ["TITANIC-003", "TITANIC-004", "..."]
    }
  ]
}
```

---

## 5. UI/UX・GUI詳細設計

### 5.1 画面配置とレイアウト
本機能は、ヘッダーナビゲーションに新規メインタブ `[Mosaic]` (`/mosaic`) を新設して提供する。
上部に変数階層スロット（ドラッグ＆ドロップ対応）、中央に Huh 2004 論文準拠の整列型 Line Mosaic プロット領域、右側に集計サマリーと凡例を配置する。

```
+---------------------------------------------------------------------------------------------------------+
| [PCP] [Table] [Distribution] [Relationships] [Clusters] [Models] [PCA] [Touring] [(o) Mosaic]| [Sidebar]|
+---------------------------------------------------------------------------------------------------------+
| Column Variables (Odd):  [ (::) Class ] [ (::) Age ]   <- Drag to reorder hierarchy                      |
| Row Variables (Even):    [ (::) Sex ]                                                                   |
| Target Variable:         [ Survived           v ]   Gap Size: [ Normal v ]   Normalization: [ Global v ]|
+-----------------------------------------------------------------------------+---------------------------+
|  Line Mosaic Plot (Titanic Data Example)                                    | Target Legend & Metrics   |
|                                                                             |                           |
|       +----------------- 1st Class -----------------+-------- 2nd Class ... |  Target: [ Survived ]     |
|       |         Child          |       Adult        |     Adult             |   [===] Yes (Alive)       |
|       +------------------------+--------------------+-----------------------|   [---] No (Perished)     |
|       | Male       | Female    | Male    | Female   | Male    | Female      |                           |
|       |            |           |         |          |         |             |  Max Frequency: 387 rows  |
|  Sex  +------------+-----------+---------+----------+---------+-------------+  Total Cells: 16          |
|       |            |           |         |          |         |             |                           |
|  M    | [===     ] |           | [===--] |          | [=--  ] |             |  Selected Cell Info:      |
|       | 5 rows     |           | 175 rows|          | 168 rows|             |   Class: 1st              |
|       +------------+-----------+---------+----------+---------+-------------+   Sex: Female             |
|       |            |           |         |          |         |             |   Age: Adult              |
|  F    |            | [=====  ] |         | [======] |         | [==== ]     |   Total: 144 rows         |
|       |            | 1 row     |         | 144 rows |         | 93 rows     |   Survived: 97.2% (140)   |
|       |            |           |         |   ^      |         |             |                           |
|       +------------+-----------+---------+---|------+---------+-------------+  Actions:                 |
|                                         Click / Brush Box                   |   [ Focus Selected ]      |
|                                                                             |   [ Delete Selected ]     |
|                                                                             |   [ Clear Selection ]     |
+-----------------------------------------------------------------------------+---------------------------+
```

### 5.2 UIコンポーネント構成 (`frontend/src/features/mosaic/`)
1. **変数階層ドロップゾーン (`MosaicVariableSlots.tsx`)**:
   - カラム一覧からカテゴリ変数を「列軸（奇数階層）」および「行軸（偶数階層）」スロットにドラッグ＆ドロップ配置。
   - スロット内のチップを左右に入れ替えることで、階層ツリーのネスト順序を瞬時に再構築。
2. **メインプロット領域 (`LineMosaicCanvas.tsx`)**:
   - SVG および Canvas 2D による精密レイアウト。
   - **階層境界線とラベル**: 最上位カテゴリ（例: 1st, 2nd, 3rd）は太い枠線と大マージン、下位カテゴリ（例: Adult, Child）は細い枠線と小マージン（Hierarchical Gaps）で区切られ、視覚的な入れ子構造を表現。
   - **均一セルボックス**: 全ての組み合わせセルが完全に合同な長方形ボックスとして縦横に整列。
   - **水平線長描画**: ボックス左端から、セル度数に比例した長さの水平線分を描画（面積ではなく線の長さのため、異なる階層のセル同士でも正確な定量比較が可能）。
   - **目的変数カラーセグメント**: 目的変数が指定されている場合、線が各カテゴリの度数比率に応じて分割着色（例: 生存=青, 死亡=赤）。
3. **インタラクティブ・ツールチップ (`MosaicCellTooltip.tsx`)**:
   - セルにマウスを乗せると、条件式（`Class=1st AND Sex=Female AND Age=Adult`）、セル度数、目的変数各水準の比率、パーセンタイル、オッズ比をリッチカードで表示。

### 5.3 インタラクション & DAVIS連動仕様
1. **セル選択とPCP即時同期**:
   - **単一セルクリック**: 例として「1st Class Female Adult（生存率97.2%の144名）」のセルをクリックすると、その144名の `rowId` が選択状態（`selectedRowIds`）となる。
   - **PCP画面への切り替え**: PCPを開くと、1st Class Female Adult に該当する144本のポリラインが一斉に赤色ハイライトされ、彼女たちの年齢・運賃・同乗者数などの多変量プロファイルが即座に確認できる。
   - **複数セル選択 (Shift + クリック / 矩形ブラシ)**: 複数のセル（例: 1st Class 全員）をまとめて選択可能。
2. **右クリック探索操作 (DAVIS Native Popup)**:
   - セル上で右クリック：
     - `Focus Selected`: 選択したカテゴリセグメントのみに解析母集団を絞り込み。
     - `Delete Selected`: 特定の異常カテゴリセルを一時除外。
     - `Undo / Reset`: 絞り込み前の全体データに戻す。
3. **PCP側からの逆方向連動**:
   - PCP上で特定のポリライン群をブラシすると、Line Mosaic Plot 側の各セル内の線分上に「PCPで選択された割合」がハイライト表示され、カテゴリと連続値の双方向クロス分析が完成する。

---

## 6. テスト・検証計画

### 6.1 バックエンド単体テスト (`tests/unit/test_line_mosaic.py`)
- Titanic データセット（Class, Sex, Age, Survived）を用いたクロス集計結果が、Huh 2004 原論文 Figure 4 の数値と完全一致すること。
- 逆写像関数 $(I, J) \to (k_1, \dots, k_p)$ の可逆性検証。
- 欠損値を含むカテゴリ変数のハンドリング検証。

### 6.2 E2E・連動テスト (`e2e/test_line_mosaic_linking.py`)
- Titanic データをインポートし、Line Mosaic Plot を生成。
- 1st Class Female のセルをクリックし、PCP 画面で該当 145 行が赤色ハイライトされることを検証。
- `Focus` 実行後に全体のデータセットが選択サブセットに絞り込まれることを検証。

---

## 7. 実装ステップ

| Step | 作業内容 | 主要変更ファイル |
|---|---|---|
| 1 | バックエンドの多次元クロス集計・配列写像ロジック実装 | `backend/app/algorithms/summaries/line_mosaic.py` |
| 2 | サマリーAPIに `/api/summaries/line_mosaic` エンドポイント追加 | `backend/app/api/summaries.py` |
| 3 | フロントエンド API クライアント・型定義追加 | `frontend/src/api/client.ts`, `frontend/src/engine/types.ts` |
| 4 | LineMosaicCanvas レンダラー & 階層ギャップレイアウト実装 | `frontend/src/features/mosaic/LineMosaicCanvas.tsx` |
| 5 | 変数割り当て・Target Variable コントロールパネル実装 | `frontend/src/features/mosaic/MosaicControlPanel.tsx` |
| 6 | 共有選択状態 (Shared Selection) & 右クリックメニュー連動 | `frontend/src/features/mosaic/LineMosaicPage.tsx`, `store.ts` |
| 7 | 単体テスト・E2Eテストの作成および動作確認 | `tests/unit/test_line_mosaic.py`, `e2e/test_line_mosaic_linking.py` |
