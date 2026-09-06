# 実装計画書: PCA専用プロット群 (PCA Diagnostics Suite)

文書ID: DAVIS-FEAT-008  
版: 1.0.0  
作成日: 2026-09-04  
優先度: 3  
対象コンポーネント: Backend (Algorithms PCA / Models API), Frontend (PCA Diagnostics Suite / Scree / Components Matrix / Biplot)  

---

## 1. 概要・目的

### 1.1 背景と目的
元のDAVIS（Huh et al., 2002, 2005）では、多変量統計解析の中核として独立した **PCA（主成分分析）モジュール** が提供されていた。
現在の `DAVIS-PCP Fullstack v2.0.0` では、クラスタリング結果の背景として2次元PCA散布図を描画する機能（F072）が存在するものの、元のDAVISが備えていた本格的なPCA診断ビュー（スクリープロット、主成分散布図行列、固有ベクトル詳細表など）は未実装である。

本機能では、元のDAVISのPCAモジュールを完全に復元・現代化し、以下の統合診断画面「PCA Suite」を提供する。

1. **スクリープロット (Scree Plot)**:
   - 各主成分の固有値（分散）と累積寄与率の可視化。
   - 主成分選択基準（Kaiser-Guttman基準: 固有値 $\ge 1.0$、累積寄与率80%線、エルボー点）の表示。
2. **主成分散布図行列 (Components Plot / PC Scatterplot Matrix)**:
   - 抽出された上位 $k$ 個の主成分（例: PC1〜PC4）による散布図行列。
   - 各セルでマウスブラッシングが可能であり、高次元空間での分離構造を探索。
3. **固有値・固有ベクトル・因子負荷量テーブル (Eigenvalue & Loading Table)**:
   - 各主成分に対する各元変数の寄与（ローディング/ウェイト）を数値およびヒートバーで可視化。
4. **バイプロット (Biplot) 拡張**:
   - サンプルの主成分スコア散布図上に、元変数の軸方向（負荷量ベクトル）を矢印として重畳表示。
5. **双方向連動 (Bidirectional Linking)**:
   - 主成分空間でブラシされたデータ点は、PCPのポリライン、元の生データテーブル、箱ひげ図へ即座に連動・ハイライト。

### 1.2 元のDAVISにおける原典根拠
- **2002年原論文 (PAPER-2002)**:
  - Section 4 / Figure 6: `Statistics -> PCA, Scree plot, scatterplot matrix of principal components`
- **初版JARバイトコード**:
  - `davis.plot.pca.PCA`
  - `davis.plot.pca.PCABean`
  - `davis.plot.pca.ScreePlot`
  - `davis.plot.pca.ComponentsPlot`
  - `davis.plot.pca.EvecTable`
  - `davis.plot.pca.EvecTableData`
  - `davis.plot.pca.EvecComparator`
- **2005年発表資料 (SLIDES-2005)**:
  - Slide 13: `Multivariate plots: PCA plot`

---

## 2. 現代フルスタックシステムにおける設計仕様

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend UI                            │
│  [新ナビゲーションタブ: "PCA" または Relationships内拡張]   │
│  ┌─────────────────────────┐  ┌───────────────────────────┐ │
│  │ 1. Scree Plot           │  │ 2. Loading / Evec Table   │ │
│  │  - 固有値バー (Kaiser線)│  │  - 変数 × PC 負荷量       │ │
│  │  - 累積寄与率ライン     │  │  - 正負着色バー           │ │
│  └─────────────────────────┘  └───────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 3. PC Scatterplot Matrix / Biplot (Canvas/SVG)         │ │
│  │  - PC1 vs PC2 vs PC3 ペアマトリクス                    │ │
│  │  - 変数ベクトル矢印重畳 (Biplot)                       │ │
│  │  - 矩形ブラシ (2D Bounding Box) & ホバーツールチップ   │ │
│  │  - 右クリック: Focus / Delete / Undo / Identify        │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │ 双方向同期 (Redux / Zustand)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Shared Selection State                      │
│    - 選択された rowId が PCP、Table、Distribution へ即時同期│
└──────────────────────────────┬──────────────────────────────┘
                               │ POST /api/models/pca
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend (FastAPI)                         │
│  [PCAService]                                               │
│    - 相関行列 (corr) または 分散共分散行列 (cov) の固有分解  │
│    - 固有値、寄与率、累積寄与率の計算                       │
│    - 固有ベクトル、因子負荷量 (Loadings) の計算             │
│    - 全サンプルの主成分スコア行列 (PC Scores) 算出          │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 詳細アルゴリズム仕様

### 3.1 PCA計算モデル

サンプル数 $N$、数値変数数 $p$ のデータ行列 $X \in \mathbb{R}^{N \times p}$ とする。

1. **標準化（Standardization）**:
   各列を中心化・スケーリング（平均0、分散1）：
   $$Z_{ij} = \frac{X_{ij} - \bar{X}_j}{s_j}$$
   ※ オプションで共分散行列ベース（中心化のみ）も選択可能。
2. **固有値分解（Eigendecomposition）**:
   相関行列 $R = \frac{1}{N-1} Z^T Z$ に対し、
   $$R v_k = \lambda_k v_k \quad (\lambda_1 \ge \lambda_2 \ge \dots \ge \lambda_p \ge 0)$$
   $\lambda_k$: 第 $k$ 主成分の固有値（分散）、$v_k \in \mathbb{R}^p$: 固有ベクトル（主成分係数）。
3. **寄与率（Explained Variance Ratio）**:
   $$\text{Ratio}_k = \frac{\lambda_k}{\sum_{j=1}^p \lambda_j}, \quad \text{Cumulative}_k = \sum_{m=1}^k \text{Ratio}_m$$
4. **因子負荷量（Factor Loadings）**:
   元変数 $j$ と第 $k$ 主成分スコアとの相関係数：
   $$L_{jk} = v_{jk} \sqrt{\lambda_k}$$
5. **主成分得点（PC Scores）**:
   各サンプルの第 $k$ 主成分スコア：
   $$S_{ik} = \sum_{j=1}^p Z_{ij} v_{jk} \quad (S = Z V)$$

### 3.2 判定基準（Scree Plot Diagnostics）
- **Kaiser-Guttman基準**: $\lambda_k \ge 1.0$ となる主成分を有意とみなす。
- **累積寄与率基準**: 累積寄与率が 70% または 80% に達する主成分数を推奨。
- **エルボー法（Elbow Detection）**: 固有値の階差 $\Delta \lambda_k = \lambda_k - \lambda_{k+1}$ が急激に鈍化する変曲点をハイライト。

---

## 4. API設計

### 4.1 エンドポイント仕様

#### `POST /api/models/pca`
データセットの指定列に基づくPCA計算を実行する。

**リクエストボディ (JSON)**:
```json
{
  "dataset_id": "iris-uuid",
  "columns": ["SepalLength", "SepalWidth", "PetalLength", "PetalWidth"],
  "use_correlation": true,
  "n_components": 4
}
```

**レスポンス (JSON)**:
```json
{
  "columns": ["SepalLength", "SepalWidth", "PetalLength", "PetalWidth"],
  "n_samples": 150,
  "n_components": 4,
  "eigenvalues": [2.91849, 0.91403, 0.14675, 0.02072],
  "explained_variance_ratio": [0.7296, 0.2285, 0.0367, 0.0052],
  "cumulative_variance_ratio": [0.7296, 0.9581, 0.9948, 1.0],
  "kaiser_threshold_components": 1,
  "eigenvectors": [
    [0.5211, -0.2693, 0.5804, 0.5649],
    [-0.3774, -0.9233, -0.0245, -0.0669],
    [0.7196, -0.2444, -0.1421, -0.6343],
    [0.2613, 0.1235, -0.8014, 0.5236]
  ],
  "loadings": {
    "SepalLength": [0.8902, -0.2577, 0.2223, 0.0813],
    "SepalWidth": [-0.4601, -0.8827, -0.0094, -0.0096],
    "PetalLength": [0.9915, -0.0234, -0.0544, -0.0913],
    "PetalWidth": [0.9650, 0.0642, -0.3070, 0.0754]
  },
  "scores": [
    { "row_id": "IRIS-001", "pc": [-2.2647, -0.5057, -0.1219, -0.0231] },
    { "row_id": "IRIS-002", "pc": [-2.0864, 0.3388, -0.2276, -0.1032] },
    "..."
  ]
}
```

---

## 5. UI/UX・GUI詳細設計

### 5.1 画面配置とレイアウト
本機能は、ヘッダーナビゲーションに独立したメインタブ `[PCA]` (`/pca`) を新設して提供する。
画面は、探索の論理的思考フローに沿った「3ペイン統合レイアウト」とする。

```
+---------------------------------------------------------------------------------------------------------+
| [PCP] [Table] [Distribution] [Relationships] [Clusters] [Models] [(o) PCA] [Statistics]   | [Sidebar] |
+---------------------------------------------------------------------------------------------------------+
| Variables: [ (x) SepalLength  (x) SepalWidth  (x) PetalLength  (x) PetalWidth ]   Method: [(o) Corr | Cov]|
+----------------------------------------------------+----------------------------------------------------+
|  Pane 1: Scree Plot & Variance Explained           |  Pane 2: Eigenvectors & Factor Loadings            |
|                                                    |                                                    |
|  Eigenvalue / Variance Ratio                       |  Variable     | PC1 (+73.0%) | PC2 (+22.8%) | Sort |
|   3.0 + [###] 73.0%                                |  PetalLength  | [====+] 0.99 | [    ] -0.02 | [v]  |
|       | [###]                                      |  PetalWidth   | [====+] 0.96 | [    ] +0.06 |      |
|   2.0 + [###]                 Cumulative: 95.8%    |  SepalLength  | [===+ ] 0.89 | [==  ] -0.26 |      |
|       | [###]                   o---------o        |  SepalWidth   | [==   ] -0.46 | [====] -0.88 |      |
|   1.0 +-------Kaiser Line (1.0)----------          |                                                    |
|       | [###]      [#] 22.8%                       |  [Note: Red/Blue mini-bars indicate loading signs] |
|   0.0 +--+----------+----------+----------+        |                                                    |
|         PC1        PC2        PC3        PC4       |                                                    |
+----------------------------------------------------+----------------------------------------------------+
|  Pane 3: Primary Projection View   [ Tabs: (o) Biplot (2D) | ( ) PC Scatterplot Matrix (4x4) ]          |
|  Axes: Horizontal = [ PC1 v ]  Vertical = [ PC2 v ]   [x] Show Loading Vectors   [x] Cluster Colors     |
|                                                                                                         |
|     PC2 (+22.8%)                                                                                        |
|      +2 +                         * (setosa)                                                            |
|         |                     * * *                                                                     |
|      +1 +                 * * * * *                                                                     |
|         |                           ^ SepalWidth Vector                                                 |
|       0 +---------------------------+-------------------------> PetalLength / Width                     |
|         |                           |          * * * (versicolor)                                       |
|      -1 +                           |        * * * *   * * (virginica)   <- 2D Brush Box                |
|         |                           v SepalLength    * * * * * [     ]                                  |
|      -2 +                                              * * *                                            |
|         +-------------+-------------+-------------+-------------+                                       |
|                      -2            -1             0            +1            +2                         |
|                                           PC1 (+73.0%)                                                  |
+---------------------------------------------------------------------------------------------------------+
```

### 5.2 各ペインのUIコンポーネント詳細
1. **Pane 1: Scree Plot コンポーネント (`ScreePlot.tsx`)**:
   - 棒グラフ（各主成分の分散 / 固有値）＋折れ線グラフ（累積寄与率）。
   - **Kaiser基準線（$\lambda = 1.0$）**: 点線で表示され、採択すべき主成分数を視覚的に明示。
   - **インタラクティブ軸割り当て**: スクリープロット上の棒をクリックすると、Pane 3 の水平軸（PC1）または垂直軸（PC2）にワンクリックでアサイン可能。
2. **Pane 2: Loading / 固有ベクトルテーブル (`LoadingTable.tsx`)**:
   - 各主成分に対する各元変数の寄与率（$-1.0 \sim +1.0$）を表示。
   - 正の相関は青色バー、負の相関は赤色バーをセル内にインライン描画。
   - 列ヘッダーのクリックで「PC1への寄与度が大きい順」「PC2への寄与度が大きい順」にソート可能。
3. **Pane 3: Biplot & PC Scatterplot Matrix (`BiplotView.tsx`, `PcaMatrixPlot.tsx`)**:
   - **Biplot View**:
     - サンプルスコアの散布図上に、元変数の負荷量ベクトル矢印を重畳。
     - 矢印の長さと向きにより、どのサンプルがどの変数の高値によってその位置にあるのかを一目で解釈可能。
     - 矢印ホバーで「寄与率、元データ平均・SD」のポップオーバー表示。
   - **PC Scatterplot Matrix View**:
     - 上位 $k$ 個の主成分（PC1〜PC4）の総当たり散布図行列（4×4）。
     - 対角線には各主成分スコアの分布ヒストグラムを描画。
     - どのサブプロットでもマウス矩形ブラシが可能。

### 5.3 インタラクション & DAVIS連携ワークフロー
1. **主成分空間でのクラスタ・外れ値ブラッシング**:
   - Biplot または PCマトリクス上でマウスドラッグして外れ値クラスタを矩形選択。
   - 選択された点は赤色ハイライトされ、右側 Sidebar および PCP、データテーブルへ即座に同期。
2. **右クリックによる探索的絞り込みループ**:
   - `Focus Selected`: 選択した主成分クラスタだけに絞り込み。
   - `Delete Selected`: 主成分空間で見つかった特異な外れ値を除外。
   - **動的再計算**: サブセットが変更された際、`[Re-run PCA on Active Subset]` アクションが有効化され、外れ値を除去したクリーンなデータに対する新たな主成分空間へワンクリックで更新可能。
   - `Undo / Reset`: 初期の全サンプル空間へ瞬時に復帰。

---

## 6. テスト・検証計画

### 6.1 バックエンド単体テスト (`tests/unit/test_pca.py`)
- Iris データセットに対する固有値・寄与率が NumPy / scikit-learn のゴールデン値と絶対誤差 $10^{-5}$ 以内で一致すること。
- 固有ベクトルの直交性 ($V^T V = I$) の検証。
- 定数列や相関1.0の特異データに対するロバストネス検証。

### 6.2 フロントエンド連動・E2Eテスト (`e2e/test_pca_suite.py`)
- Scree Plot が正しく描画され、Kaiser基準線が表示されていること。
- PC1 vs PC2 散布図上でクラスタをドラッグ選択した際、PCP上の選択カウントが即時同期すること。
- Biplot の矢印トグルが正常に機能すること。

---

## 7. 実装ステップ

| Step | 作業内容 | 主要変更ファイル |
|---|---|---|
| 1 | バックエンド PCA アルゴリズムコア実装 | `backend/app/algorithms/models/pca.py` |
| 2 | モデルAPIに `/api/models/pca` エンドポイント追加 | `backend/app/api/models.py` |
| 3 | フロントエンド API クライアント・型定義追加 | `frontend/src/api/client.ts`, `frontend/src/engine/types.ts` |
| 4 | ScreePlot & LoadingTable コンポーネント実装 | `frontend/src/features/pca/ScreePlot.tsx`, `LoadingTable.tsx` |
| 5 | PcaMatrixPlot & BiplotView コンポーネント実装 | `frontend/src/features/pca/PcaMatrixPlot.tsx`, `BiplotView.tsx` |
| 6 | ナビゲーションメニューおよびAppShellへの統合 | `frontend/src/app/AppShell.tsx`, `features/pca/PcaPage.tsx` |
| 7 | 単体テスト・E2Eテストの作成および動作確認 | `tests/unit/test_pca.py`, `e2e/test_pca_suite.py` |
