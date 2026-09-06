# 機能仕様書: 「意外性」を重視した関連性スコアリング（Surprise-First Association Scoring）

## 1. 概要・目的

全変数ペアの関連性を計算し、**「強い関連」だけでなく「意外な関連」を優先して提示する**機能。

従来の相関行列は「強い相関」を単純に並べるだけで、分析者が既に知っている自明な関連（例: 「年齢」と「既婚率」）が上位を占める。本機能は、**周辺分布から予測される水準からの逸脱（lift）と、全ペア分布の中での外れ度（unexpectedness）**を組み合わせ、分析者が「思いつかない・予想外の」関連を上位に出す。

## 2. 位置づけ・依存関係

- 「自律的インサイト発見エンジン」の一部。
- 出力の `surprise_score` は「サブグループ自動マイニング（01）」の複合スコアに合成可能（重み `w_surp`）。
- 相関行列（クラスタリング済みヒートマップ）は汎用 EDA 機能としても独立利用できる。

## 3. 入力データモデル

01 と共通のメタデータ付きデータモデルを前提とする（`type`: numeric/ordinal/categorical、`role`: question/attribute、`missing_codes`）。

## 4. 関連性指標の選定（変数型ペア別決定表）

ペアの型に応じて一次指標を選定する。

| X の型 | Y の型 | 一次指標 | 符号回復 | 備考 |
|---|---|---|---|---|
| numeric | numeric | Pearson r、Spearman ρ、Kendall τ | 不要（値がそのまま符号） | 3つ併記し、非線形は ρ/τ で捕捉 |
| categorical | categorical | Cramér's V、Theil's U（非対称）、正規化相互情報量 | V は非負 | U は X→Y / Y→X の方向性を出す |
| numeric | categorical | 相関比 η（correlation ratio）、Phik φ_k | η は非負、φ_k は符号回復 | η = sqrt(SS_between/SS_total) |
| ordinal | ordinal / numeric | Spearman ρ、Kendall τ-b、φ_k | ρ/τ は符号付き | ordinal は順位相関を主とする |
| （混合・一般） | （混合・一般） | **Phik φ_k**（既定の統一指標） | φ_k は符号回復 | 全ペア共通の補助指標として必ず算出 |

設計方針:

- **統一スコアの基盤として Phik φ_k を使う**（混合型・順序・名義・連続を同一スケール [-1,1] で比較できる）。
- 解釈・表示では、ペア型に応じた一次指標を主に示し、φ_k を「比較用の正規化スコア」として併記する。

## 5. Phik（φ_k）の実装詳細

Phik は相互情報量（MI）ベースの係数で、独立な場合に 0、完全従属で 1 に近づく。連続×連続が二変量正規なら |Pearson r| に一致する性質を持つ。

```
MI(X, Y) = Σ_x Σ_y p(x, y) * log( p(x, y) / (p(x) p(y)) )
φ_k_raw  = sqrt( MI(X, Y) / H(X, Y) )        # H は結合エントロピー
```

### 5.1 有限サンプルバイアス補正（必須）

MI はサンプルサイズが小さい・ビン数が多いと正のバイアスを持つため、**独立性帰無仮説の下での期待値**を差し引く補正を実装する。

補正方式（実装は方式Bを既定、Aはフォールバック）:

- **方式A（permutation）**: 片方の変数をシャッフルした M 回（既定 100）の順列で φ_k を計算し、その平均を期待値として差し引く: `φ_k_corrected = φ_k_obs - mean(φ_k_perm)`。正確だが重い。
- **方式B（解析的/参照実装準拠）**: 参照実装 `phik` が採用する解析的補正（ビン数とサンプルサイズから期待値を推定）に相当する補正。Python `phik` パッケージの `phik_from_array` をそのまま利用するのが実装コスト最小。

### 5.2 ビニング（連続変数の離散化）

連続変数は適応的ビニングで離散化して MI を推定する。

- 参照実装 `phik` は χ² ベースの適応ビニングを採用。既定では `phik` のデフォルト（`bins=10` を上限に適応統合）を踏襲。
- 順序・名義は既存カテゴリをそのまま使用。

### 5.3 符号回復

φ_k は非負なので、方向（正/負の関連）を以下で回復して [-1,1] にマップする:

- 両方 numeric/ordinal: Spearman ρ の符号。
- それ以外: 相関比 η の方向、または主要セルの調整済み残差の符号。
- 符号を決められない場合（純粋な名義×名義）は非負のまま扱い、`sign="unsigned"` を記録。

## 6. 「意外性（surprise）」の定義と計算

意外性は**強度（strength）と非自明性（unexpectedness）の2軸**で定義する。

### 6.1 強度スコア（strength）

```
strength = |φ_k_corrected|   # 0〜1
```

### 6.2 非自明性スコア（unexpectedness）

2つのサブスコアを定義し、どちらか（または両方）を設定で有効化する。

**(a) 経験的ベースライン（empirical baseline） — 既定**

全ペアの `strength` 分布の中で、そのペアがどれだけ外れているかを測る。

```
z_unexpected = (strength - mean(strength_all)) / std(strength_all)
unexpectedness = clip(z_unexpected / 3, 0, 1)   # 3σ で飽和
```

これにより「データセット内で相対的に異例に強い関連」が浮かぶ。ただし、全体が全体的に強相関だと埋もれるため、後述の (b) と併用できる。

**(b) 周辺期待からの逸脱（lift / 独立性逸脱） — 任意**

単純な強度ではなく、「周辺分布から予測される結合よりどれだけズレているか」を測る。名義・順序ペアの各セルについて:

```
lift_cell = p_obs(x, y) / (p(x) * p(y))
max_lift  = max over cells of lift_cell        # 最も予想外のセル
```

連続ペアでは、ビニング後の 2×2 外側セル（例: 低×低、高×高）の lift を用いる。

```
unexpectedness_lift = clip((max_lift - 1) / (max_lift_cap - 1), 0, 1)
# max_lift_cap は既定 5（lift 5倍で飽和）
```

### 6.3 複合サプライズスコア

```
surprise_score = w_strength * strength
               + w_unexpected * unexpectedness
```

既定重み: `w_strength = 0.5, w_unexpected = 0.5`。設定変更可能。`unexpectedness` が (a)(b) 両方有効な場合は `max(a, b)` を採用（どちらか一方で異例ならば意外とみなす）。

## 7. 出力

### 7.1 ペア結果スキーマ（JSON）

```json
{
  "run_id": "uuid",
  "config": { "primary_measure": "phik", "unexpectedness_mode": "empirical",
              "permutation_iters": 100 },
  "pairs": [
    {
      "id": "pair_001",
      "x": { "name": "q08", "label": "通勤時間（分）", "type": "numeric" },
      "y": { "name": "q31", "label": "ブランド推奨度", "type": "ordinal" },
      "primary": { "measure": "phik", "value": 0.62, "sign": -1, "signed_value": -0.62 },
      "secondary": { "pearson_r": 0.58, "spearman_rho": 0.64, "kendall_tau": 0.51,
                     "correlation_ratio": 0.60 },
      "surprise": { "strength": 0.62, "unexpectedness_empirical": 0.81,
                    "unexpectedness_lift": 0.55, "unexpectedness": 0.81,
                    "surprise_score": 0.715 },
      "top_lift": { "cell": "通勤時間_高 × 推奨度_低", "lift": 3.4,
                    "p_obs": 0.11, "p_expected": 0.032 },
      "n_valid": 4820, "warnings": []
    }
  ],
  "pair_matrix": { /* 変数×変数の signed phik 行列（クラスタリング用） */ }
}
```

### 7.2 UI/UX・GUI詳細設計

#### 7.2.1 画面配置とレイアウト
本機能は、ヘッダーの `[Relationships]` (`/relationships`) タブ内のサブモード、または独立タブ `[Associations]` として提供する。
分析者は「強度×意外性の象限散布図」「クラスタリングヒートマップ」「サプライズカード一覧」を同一画面で連動させて探索できる。

```
+---------------------------------------------------------------------------------------------------------+
| [PCP] [Table] [Distribution] [(o) Relationships] [Clusters] [Models] [Auto Mining] [Touring] [Mosaic]   |
+---------------------------------------------------------------------------------------------------------+
| Mode: [(o) Surprise Quadrant | ( ) Clustered Heatmap | ( ) Matrix ]   Metric: [ Phik (φ_k) v ]          |
| Surprise Weights: Strength [===O===] Unexpectedness (50:50)   Lift Cap: [ 5.0x ]  Min N: [ 50 ]        |
+----------------------------------------------------+----------------------------------------------------+
|  Pane 1: Strength vs Unexpectedness Quadrant Plot  |  Pane 2: Top Surprise Pairs & Lift Inspector       |
|                                                    |  Selected Pair: 通勤時間 (min) × ブランド推奨度 (NPS)  |
|  Unexpectedness (非自明度)                         |                                                    |
|  1.0 +                      ★ [Hidden Gems]        |  [Surprise Diagnostics]                            |
|      |                        #1 通勤時間 × 推奨度   |  Surprise Score: 0.715  (Strength=0.62, Unexp=0.81)|
|      |                     *  #2 年収 × 店舗来店頻度 |  Phik φ_k: -0.62 (負の関連)  Pearson r: -0.58       |
|  0.5 +        [Noise]                              |  有効回答数 N: 4,820名                             |
|      |        * *                                  |                                                    |
|      |       * * * *        #3 年齢 × 既婚フラグ   |  [Top Deviation Cell (Maximum Lift)]               |
|  0.0 +------+-------+-------+-------+-------+      |  ★ 「通勤時間_長(60分超)」×「推奨度_低(0-4点)」     |
|     0.0    0.2     0.4     0.6     0.8     1.0     |  - 観測確率: 11.0%  (530名)                        |
|                     Strength (|φ_k|)   [Trivial]   |  - 期待確率:  3.2%  (154名)                        |
|                                                    |  - Lift倍率:  3.44倍 (期待値の3.4倍集中!)           |
+----------------------------------------------------+----------------------------------------------------+
|  Pane 3: Clustered Phik Correlation Matrix / Contingency Cross-Examination                              |
|                                                                                                         |
|       通勤時間 推奨度   年収   購入額   年齢   既婚    [Contingency / Scatter Mini-View]                 |
|  通勤  [ +1.0  -0.62   +0.12   -0.08   +0.05  -0.02 ]  NPS (0-10)                                        |
|  推奨  [ -0.62  +1.0   +0.45   +0.52   +0.15  +0.10 ]   10 +            *                                |
|  年収  [ +0.12  +0.45  +1.0    +0.78   +0.42  +0.38 ]    5 +        * * * *   <- Lift Outlier Cluster   |
|  購入  [ -0.08  +0.52  +0.78   +1.0    +0.35  +0.29 ]    0 + * * * * [     ]   (通勤>60分 & NPS<4)      |
|  年齢  [ +0.05  +0.15  +0.42   +0.35   +1.0   +0.68 ]      +-------+-------+                             |
|  既婚  [ -0.02  +0.10  +0.38   +0.29   +0.68  +1.0  ]     0       30      60 min (通勤時間)             |
|                                                                                                         |
|  [Actions] [ (o) Select Lift Cell Rows in PCP (530 rows) ]  [ ⤢ Plot as 2-Axis PCP ]  [ Export Matrix ] |
+---------------------------------------------------------------------------------------------------------+
```

#### 7.2.2 コンポーネント階層構造
- `frontend/src/features/relationships/`
  - `SurpriseAssociationView.tsx`: サプライズ探索モード親コンポーネント
  - `SurpriseQuadrantPlot.tsx`: 強度 vs 非自明性の2次元散布図（SVG/Canvas、マウスドラッグ矩形選択）
  - `SurpriseInspectorCard.tsx`: 選択中ペアのサプライズ指標・Phik・最大リフトセル詳細
  - `ClusteredHeatmapCanvas.tsx`: Ward法階層クラスタリング樹形図付き相関ヒートマップ
  - `PairCrossExaminationPlot.tsx`: 2変数の散布図（連続×連続）または分割表ヒートマップ（カテゴリ×カテゴリ）
  - `SurpriseActionBar.tsx`: PCP軸連動・リフトセル該当回答者ブラッシング・行列エクスポート

#### 7.2.3 インタラクション & DAVIS連携ワークフロー
1. **隠れた宝石（Hidden Gems）の矩形ブラッシング**:
   - 象限散布図の右上（強くて意外）領域をマウスドラッグで囲むと、該当する変数ペア群が一括ハイライトされる。
2. **リフトセルの回答者群をPCPへ即時投影 (`Select Lift Cell Rows in PCP`)**:
   - 最大リフトセル（例: 「通勤時間_長」かつ「推奨度_低」の530名）の選択ボタンを押すと、中央選択エンジンへ即時通知され、PCP上でその回答者群のポリラインが赤色ハイライトされる。
   - 分析者は「なぜ通勤が長い人が極端に不満なのか？（例: リモート手当の有無、居住地域、職種などの他軸の並び）」をPCP上で瞬時に視覚追跡できる。
3. **PCP軸への2変数アサイン (`Plot as 2-Axis PCP`)**:
   - 発見された意外なペアをPCPの先頭2軸に配置し、平行座標上での束の交差や交差パターン（負の相関）を直感的に視認可能。

## 8. エッジケースと対処

| ケース | 対処 |
|---|---|
| 定数列 | ペア計算から除外（分散 0 は φ_k 定義不能） |
| 高カーディナリティ（>50カテゴリ） | MI が過大になるため、上位N-1+その他に集約（既定 N=20）。集約を明示ログに記録 |
| サンプルサイズ小（n<50） | `small_sample` 警告を付与し、φ_k の信頼性が低い旨を表示 |
| 完全従属ペア（ID系） | φ_k=1 になるため「実質同一変数」とラベル付けして上位から分離表示 |
| 欠損 | ペアごとの有効ケース（pairwise）で計算。`n_valid` を必ず記録し、`n_valid < min_pair_n`（既定50）は除外 |
| 名義×名義の符号 | `sign="unsigned"` とし、符号回復を試みない |

## 9. パフォーマンス要件

- ペア数 `C(n,2)`（例: 100列 → 4,950ペア）。φ_k 行列計算は `phik.phik_matrix` で一括実行。
- permutation 補正を全ペアに掛けると重いため、既定は方式B（解析的補正）とし、方式Aは「上位ペアの精査時」のみ実行する。
- 目標: 100列 × 10万行で 120秒以内。

## 10. 依存ライブラリ（Python 想定）

- `phik`（φ_k 行列・符号回復・解析的バイアス補正）
- `scipy.stats`（spearmanr, kendalltau, pearsonr）
- `sklearn.metrics.mutual_info_score`（必要時の MI 直接計算）
- `scipy.cluster.hierarchy`（クラスタリング）
- `pandas` / `polars`

## 11. テスト計画

**単体テスト:**

1. 独立な2変数の `φ_k_corrected` が 0 付近（|値|<0.05）になるか。
2. 完全従属（例: y=2x）で `φ_k ≈ 1` になるか。
3. 二変量正規で `φ_k` が |Pearson r| に近似するか（既知 r との誤差 <0.05）。
4. 符号回復: 負相関データで `signed_value < 0` になるか。
5. lift 計算: 既知の分割表で max lift が手計算と一致するか。
6. 意外性: 全ペア均一な強度のデータで unexpectedness が 0 付近になるか。

**統合テスト（合成データ）:**

7. 自明な関連（年齢↔既婚率）と、埋め込んだ「意外な関連」を混在させ、後者がサプライズ上位に出るか。
8. 高カーディナリティ列を混ぜても φ_k が異常値にならないか（集約が働くか）。

**受入基準:**

- 独立データで補正済み φ_k の平均が 0.05 未満。
- 埋め込み関連の再現率 > 0.8。
- 100列規模でタイムアウトなし。
