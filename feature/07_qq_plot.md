# 実装計画書: QQ-Plot (正規Q-Qプロット)

文書ID: DAVIS-FEAT-007  
版: 1.0.0  
作成日: 2026-09-04  
優先度: 2  
対象コンポーネント: Backend (Statistics / QQ-Plot API), Frontend (Distribution / QQPlot Feature & Linked Brushing)  

---

## 1. 概要・目的

### 1.1 背景と目的
元のDAVIS（Huh et al., 2002, 2005）において、単変量可視化ツール群（Univariate Plots）の1つとして搭載されていた **QQ-Plot（Quantile-Quantile Plot）** を現代フルスタックアーキテクチャ上に復元する。

QQ-Plotは、観測データの経験分位点と理論正規分布の分位点を直交座標系にプロットすることで、データの正規性からの乖離（裾の重さ、歪み、外れ値）を視覚的に診断する統計プロットである。
DAVISにおけるQQ-Plotの最大の特徴は、単なる静的なグラフではなく、**プロット上のデータ点をマウスでブラッシング（矩形選択・クリック）することで、外れ値や正規性から外れたデータ群を抽出し、その行選択がPCPやデータテーブル、箱ひげ図へ即座に連動・反映される**点にある。

本機能により、ユーザーは「QQ-Plotで外れ値や歪みの原因となっているサンプルを特定し、Focus / Delete してPCP上で多変量構造の変化を検証する」というDAVIS本来の探索ループを実行できるようになる。

### 1.2 元のDAVISにおける原典根拠
- **初版JARバイトコード**:
  - `davis.plot.qqplot.QQPlot`
  - `davis.plot.qqplot.QQPlotBean`
  - 主要メソッド: `drawQQPlot()`, `normalQuantile()`, `qqSort()`, `quickSort()`
  - 継承関係: `QQPlot` extends `DavisPlot` extends `PlotData`（共有選択配列 `PlotData.index[]` および右クリックコンテキストメニュー `Focus`, `Delete`, `Undo`, `Identify` を自動継承）
- **2005年発表資料 (SLIDES-2005)**:
  - Slide 11: `Univariate plots: Bar Charts, Histogram, QQ Plot, FEDF, BoxPlot`

---

## 2. 現代フルスタックシステムにおける設計仕様

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend UI                            │
│  [DistributionPage 内の QQ-Plot タブ または 独立ビュー]     │
│    - 変数選択ドロップダウン (数値カラム)                    │
│    - Canvas / SVG レンダラー (高速散布点 + 基準線)           │
│    - 矩形ブラシ (2D Bounding Box) / 点クリック選択          │
│    - 選択行の赤色ハイライト & グループ色分け                │
│    - 右クリックメニュー (Focus, Delete, Undo, Identify)     │
│    - 診断パネル: Shapiro-Wilk検定、歪度、尖度               │
└──────────────────────────────┬──────────────────────────────┘
                               │ 双方向同期 (Redux / Zustand Store)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Shared Selection State                      │
│    - activeRowIds, selectedRowIds, groupAssignments          │
│    - PCP, Table, BoxPlot へ即時伝播 (0 latency)             │
└──────────────────────────────┬──────────────────────────────┘
                               │ 必要時 (大量データ/厳密検定)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend (FastAPI)                         │
│  [GET /api/summaries/qqplot?column={col}]                   │
│    - 分位点計算 (SciPy probplot / Blom式)                   │
│    - 理論正規分位点 $z_i$ と 実測値 $x_{(i)}$ の対応ペア     │
│    - 回帰基準線パラメータ (傾き slope, 切片 intercept)     │
│    - Shapiro-Wilk p値、歪度、尖度                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 詳細アルゴリズム仕様

### 3.1 分位点とプロット座標の算出式

有効サンプルサイズを $N$、昇順ソートしたサンプル値を $x_{(1)} \le x_{(2)} \le \dots \le x_{(N)}$ とする。

1. **プロット位置 (Plotting Position) $p_i$ の計算**:
   元のDAVISおよび標準統計学（Blom's formula, 1958）に準拠：
   $$p_i = \frac{i - 0.375}{N + 0.25} \quad (i = 1, \dots, N)$$
   ※ または Weisberg 式 $p_i = \frac{i - 0.5}{N}$。設定により切り替え可能。
2. **理論正規分位点 $z_i$**:
   標準正規分布の累積分布関数の逆関数 $\Phi^{-1}$ を用いる：
   $$z_i = \Phi^{-1}(p_i) = \sqrt{2} \cdot \text{erf}^{-1}(2 p_i - 1)$$
3. **基準線（Q-Q Reference Line）**:
   - **45度頑健線 (Robust Quartile Line)**:
     第1四分位点 $(z_{0.25}, Q_1)$ と 第3四分位点 $(z_{0.75}, Q_3)$ を通過する直線：
     $$\text{Slope} = \frac{Q_3 - Q_1}{z_{0.75} - z_{0.25}}, \quad \text{Intercept} = Q_1 - \text{Slope} \cdot z_{0.25}$$
   - 外れ値の影響を受けずに中心部の分布適合度を評価できる。

### 3.2 統計的診断指標の計算
- **Shapiro-Wilk 検定 ($W$ 統計量および $p$ 値)**:
  - $p < 0.05$ の場合、「正規分布から有意に乖離」と判定。
- **歪度 (Skewness)**:
  - $\gamma_1 = \frac{m_3}{m_2^{3/2}}$（正なら右裾が長い、負なら左裾が長い）。
- **尖度 (Kurtosis)**:
  - $\gamma_2 = \frac{m_4}{m_2^2} - 3$（正規分布で0。正なら尖鋭・重裾、負なら平坦・軽裾）。

### 3.3 連動ブラッシング（Linked Brushing）の幾何判定
- プロット画面上の各データ点 $i$ は、元のデータセットの固有 `rowId` と紐付いている。
- ユーザーがマウスドラッグにより選択矩形 $R = [x_{\min}, x_{\max}] \times [y_{\min}, y_{\max}]$ を指定した際：
  $$\text{Selected}(i) \iff (z_i, x_{(i)}) \in R$$
- 選択された `rowId` 集合を共有ストアの `selectedRowIds` に代入（または加算・減算）。
- 同時に PCP 上の対応ポリライン、テーブルの行、箱ひげ図のプロット点が瞬時に赤色ハイライトされる。

---

## 4. API設計

### 4.1 エンドポイント仕様

#### `GET /api/summaries/qqplot`
指定した列のQQプロット用座標データと正規性診断指標を取得する。

**クエリパラメータ**:
- `dataset_id`: string (必須)
- `column`: string (必須)
- `plotting_position`: `"blom"` | `"weisberg"` (省略時: `"blom"`)

**レスポンス (JSON)**:
```json
{
  "column": "SepalLength",
  "count": 150,
  "normality_test": {
    "shapiro_wilk_w": 0.97609,
    "p_value": 0.01018,
    "is_normal_alpha_05": false,
    "skewness": 0.3149,
    "kurtosis": -0.5520
  },
  "reference_line": {
    "slope": 0.8123,
    "intercept": 5.8433,
    "q1_theoretical": -0.6745,
    "q1_sample": 5.1,
    "q3_theoretical": 0.6745,
    "q3_sample": 6.4
  },
  "points": [
    { "row_id": "IRIS-014", "rank": 1, "sample_value": 4.3, "theoretical_quantile": -2.5758 },
    { "row_id": "IRIS-009", "rank": 2, "sample_value": 4.4, "theoretical_quantile": -2.1489 },
    "..."
  ]
}
```

---

## 5. UI/UX・GUI詳細設計

### 5.1 画面配置とレイアウト
本機能は、`DistributionPage` (`/distribution`) 内のセグメントコントロール（タブ切替）として提供し、箱ひげ図（Box Plot）と並ぶ単変量診断の主要ビューとして位置付ける。

```
+---------------------------------------------------------------------------------------------------------+
| [PCP] [Table] [Distribution] [Relationships] [Clusters] [Models] [Statistics] [Overview]   | [Sidebar] |
+---------------------------------------------------------------------------------------------------------+
| Mode: [ (Box Plot) | (o) QQ-Plot | (Histogram) ]                                                        |
| Variable: [ SepalLength       v ]   Ref Line: [ Robust (Q1-Q3) v ]   [x] 95% Envelope   [x] Cluster Colors|
+---------------------------------------------------------------------+-----------------------------------+
|  QQ-Plot (Sample vs Theoretical Normal)                             | Normality Diagnostics             |
|                                                                     |                                   |
|  Sample Quantiles (x)                                               |  Shapiro-Wilk Test:               |
|   8.0 +                                              * *   <- Brush |    W = 0.9761, p = 0.0102         |
|       |                                          * * [   ] Box      |    Status: [ Non-Normal (p<0.05) ]|
|   7.0 +                                      * *                    |                                   |
|       |                                  * *                        |  Shape Metrics:                   |
|   6.0 +                              * *                            |    Skewness: +0.315 (Slight Right)|
|       |                          * *                                |    Kurtosis: -0.552 (Platykurtic) |
|   5.0 +                      * *                                    |                                   |
|       |                  * *                                        |  Selected in QQ-Plot:             |
|   4.0 +              * *                                            |    Count: 6 rows (4.0%)           |
|       |          * *                                                |    Actions:                       |
|       +----------+----------+----------+----------+                 |    [ Focus Selected ]             |
|                 -2         -1          0         +1        +2       |    [ Delete Selected ]            |
|                           Theoretical Quantiles (z)                 |    [ Clear Selection ]            |
+---------------------------------------------------------------------+-----------------------------------+
```

### 5.2 UIコンポーネント構成 (`frontend/src/features/qqplot/`)
- `QQPlotView.tsx`: 画面全体の親コンポーネント。変数選択、設定ツールバー、プロット本体、診断カードを統括。
- `QQPlotCanvas.tsx`: High-DPI Canvas 2D レンダラー。
  - 数千〜数万点の散布点と基準線・信頼区間帯を60fpsで描画。
  - レイヤー構造: 背景グリッド $\to$ 95%信頼包絡線（グレー半透明帯） $\to$ 基準直線（赤色点線） $\to$ 非選択点（グレー/クラスタ薄色） $\to$ 選択点（赤色太枠/強調色）。
- `QQDiagnosticsCard.tsx`: 右側の統計診断カード。
  - Shapiro-Wilk 検定結果を視覚的バッジ（緑「Normal」/ 赤「Non-Normal」）で明示。
  - 歪度・尖度をミニバーインジケータ付きで解説。

### 5.3 インタラクション & DAVIS連動仕様
1. **マウス操作体系**:
   - **矩形ドラッグ (Bounding Box Brush)**:
     マウスでドラッグして四角形を描き、直線から乖離した外れ値群を一括選択。
   - **Shift + ドラッグ**: 既存選択への追加（Union）。
   - **Alt + ドラッグ**: 既存選択からの除外（Subtract）。
   - **点ホバー (Hover Tooltip)**:
     点の上にカーソルを置くと、該当サンプルの `rowId`、実測値 $x_{(i)}$、理論分位点 $z_i$、および他変数の値をツールチップ表示。
   - **ダブルクリック**: 全選択解除（Clear Selection）。
2. **右クリックコンテキストメニュー (DAVIS Native Popup)**:
   - プロット上で右クリックすると DAVIS 伝統のメニューが開く：
     - `Focus Selected`: 選択された外れ値（または正常値）以外の全行を解析対象から除外。
     - `Delete Selected`: 選択された外れ値を一時除外（クレンジング）。
     - `Identify`: 選択サンプルの属性一覧モーダルを開く。
     - `Undo / Reset to Base`: 除外前の全データ状態に戻す。
3. **PCP & 他画面との即座な双方向同期**:
   - QQ-Plot 上で外れ値 6 点を囲むと、右側 Selection Sidebar の選択件数が「6 / 150」に更新され、PCP 画面を開くと該当 6 本のポリラインが鮮烈な赤色で描画される。
   - 逆に PCP 上でブラシしたデータ点群も、QQ-Plot 画面上で該当する位置の点が即座にハイライトされる。

---

## 6. テスト・検証計画

### 6.1 バックエンド単体テスト (`tests/unit/test_qqplot.py`)
- 標準正規分布乱数（$N=1000$）に対して Shapiro-Wilk の $p > 0.05$ となること。
- Iris の `SepalWidth`（正規に近い）と `PetalLength`（明確な二峰性・非正規）で適切な検定結果およびプロット座標が得られること。
- `row_id` と元の行の整合性が100%維持されていること。

### 6.2 フロントエンド連動テスト
- QQ-Plot 上で外れ値2点を選択した際、PCP上の選択件数が即座に `2 / 150` となり、PCPの該当ラインがハイライトされること。
- 右クリックで `Focus Selected` を実行した際、PCP・テーブル・QQ-Plotが同時に2件のサブセットへ絞り込まれること。

---

## 7. 実装ステップ

| Step | 作業内容 | 主要変更ファイル |
|---|---|---|
| 1 | バックエンドのQQプロット計算コアロジック実装 | `backend/app/algorithms/summaries/qqplot.py` |
| 2 | サマリーAPIに `/api/summaries/qqplot` エンドポイント追加 | `backend/app/api/summaries.py` |
| 3 | フロントエンド API クライアント・型定義追加 | `frontend/src/api/client.ts`, `frontend/src/engine/types.ts` |
| 4 | QQPlotCanvas および UI コンポーネント実装 | `frontend/src/features/qqplot/QQPlotPanel.tsx`, `QQPlotCanvas.tsx` |
| 5 | DistributionPage タブ または ナビゲーションへの統合 | `frontend/src/features/distribution/DistributionPage.tsx`, `AppShell.tsx` |
| 6 | 共有選択・Focus/Deleteコンテキストメニューの接続 | `frontend/src/app/store.ts` |
| 7 | 単体・E2Eテスト作成および検証 | `tests/unit/test_qqplot.py`, `e2e/test_qqplot_linking.py` |
