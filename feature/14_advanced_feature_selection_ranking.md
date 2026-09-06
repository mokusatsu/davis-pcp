# 実装計画書: 高度な特徴量選択・変数ランキング (Advanced Feature Selection & Variable Ranking Suite)

文書ID: DAVIS-FEAT-014  
版: 1.0.0  
作成日: 2026-09-05  
優先度: 3  
対象コンポーネント: Backend (ReliefF / Mutual Information / Stepwise / Random Forest MDI & Permutation API), Frontend (Feature Ranking Dashboard, Multi-metric Comparison Bar, Variable Redundancy Bubble Plot, Top-K Apply Integration)  

---

## 1. 概要・目的

### 1.1 背景と目的
元のDAVIS（2005年発表資料: Huh et al., *Data Exploration with DAVIS*）において、高次元データ探索の中核エンジンとして紹介されていた **変数ランキング（Variable Ranking）** および **特徴量選択ツール群（Feature Selection: MDI, ReliefF, Mutual Information, Stepwise）** を、現代フルスタックシステム上に統合実装する。

現代の高次元データ分析（バイオインフォマティクス、顧客購買行動、センサログ等）では、数十〜数百の変数が含まれることが日常的である。しかし、PCP（平行座標プロット）などの幾何学的可視化手法では、表示する軸数が10〜20を超えると画面が混雑し、解釈性が著しく低下する。

元のDAVISは、「決定木、ReliefF、相互情報量、ステップワイズ判別などの多様な統計的・機械学習的基準を用いて全変数を重要度順にスコアリングし、真に有意な変数群を抽出してPCPやクラスタリングに投入する」というワークフローを提案していた。

本機能では、特定の単一アルゴリズムに依存せず、**性質の異なる4つの特徴量評価エンジン（ReliefF, 相互情報量, Random Forest MDI/MDA, ステップワイズF値）** を並列実行し、各変数のスコアと統合ランク（Borda Count / Rank Aggregation）を可視化する。さらに、**「上位K個の変数を一括選択し、上部の共通 Variable Selection を通じてPCPや他ビューの表示軸にワンクリックで反映させる」** というシームレスな対話操作を実現する。

### 1.2 元のDAVISにおける原典根拠
- **2005年発表資料 (SLIDES-2005)**:
  - Slide 14: `Statistical Tools: Decision Trees, Variable ranking, MDI, ReliefF, Mutual Information, Stepwise discriminant analysis`
- **設計思想との整合**:
  - DAVISは「変数の並べ替え（Variable Arrangement: ComponentOrder, PermuteOrder）」を重視していたが、変数の並べ替えの前段として「どの変数を可視化に選ぶか（Variable Selection）」をアルゴリズム支援することで、高次元データに対する探索効率を最大化する。

---

## 2. アーキテクチャと機能要件

### 2.1 全体アーキテクチャ構成
```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend UI                            │
│  [新ナビゲーションタブ: "Ranking" (変数ランキング・選択)]   │
│  ┌──────────────────────────────┐┌────────────────────────┐ │
│  │ 1. 手法別重要度スコア比較バー││ 2. 関連度 vs 冗長性    │ │
│  │  - ReliefF, MI, MDI, Stepwise││    バブルプロット      │ │
│  │  - 正規化スコア [0, 1] 並列  ││  - 横軸: 統合重要度    │ │
│  │  - ソート・フィルタリング    ││  - 縦軸: 他変数平均相関│ │
│  └──────────────────────────────┘└────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 3. 上位K変数 一括適用コントロールバー                  │ │
│  │  - スライダー: [ 上位 6 変数を選択 (Top-K) =======| ]   │ │
│  │  - [ 上部共通 Variable Selector へ即時適用 ]           │ │
│  │  - 適用後、PCPの軸やRelationshipsの行列が自動更新      │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │ 双方向同期 (Redux Store)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             Global Variable Selection State                 │
│  activeVariableIds (全画面共通の上部バーへ即時伝播)         │
│  PCP, Table, Clusters, Models, Touring が同一軸セットを共有 │
└──────────────────────────────┬──────────────────────────────┘
                               │ JSON API Request / Response
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend (FastAPI)                         │
│  [POST /api/mining/feature-ranking]                         │
│    - ReliefF エンジン (近傍インスタンス間重み更新)          │
│    - sklearn.feature_selection.mutual_info_classif/regress  │
│    - RandomForestClassifier/Regressor MDI + Permutation    │
│    - Borda Count による頑健な統合順位集約 (Ensemble Rank)   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 主要機能要件一覧
1. **分析対象とモード設定**:
   - **ターゲット変数（Target）**:
     - 教師あり分類（Categorical Target）: 疾患、クラス、セグメント等。
     - 教師あり回帰（Continuous Target）: 金額、生存日数、スコア等。
     - 教師なし探索（Unsupervised Ranking）: 全体分散寄与率（PCA第1〜第3主成分負荷量の二乗和）およびエントロピー。
   - **評価手法の選択（マルチセレクト）**:
     - `[x] ReliefF`: 非線形な相互作用や局所的クラスタ構造を捉える。
     - `[x] 相互情報量 (Mutual Information)`: 任意の非線形依存性を捉えるノンパラメトリック測度。
     - `[x] Random Forest MDI / Permutation`: 木構造による重要度。
       > **Random Forest 重要度の計算モード**: デフォルトでは **MDI（Mean Decrease in Impurity / Gini Importance）** のみを計算する（$O(T \cdot N \cdot \log N)$）。**MDA（Permutation Importance）** は計算コストが高い（$O(P \cdot N \cdot T)$）ため、オプションパラメータ `usePermutationImportance: boolean = false` で明示的に有効化した場合のみ算出する。MDA が有効な場合、MDI と MDA のスコアをそれぞれ独立した評価指標として Borda 集約に参加させる。
     - `[x] Stepwise F / ANOVA`: 線形分離度に基づく統計的有意性。
2. **可視化ビュー**:
   - **手法別スコア並列バーチャート (Multi-Metric Ranking Bar)**:
     - 各変数を縦軸、0〜1にMin-Max正規化した重要度スコアを横軸にプロット。
     - 手法ごとに色分けされたグループバーまたはスタック表示により、特定の手法だけに依存した過学習や見落としを防止。
   - **関連度 vs 冗長性バブルプロット (mRMR: Relevance vs Redundancy)**:
     - 横軸: 目的変数との関連度（統合重要度スコア）。
     - 縦軸: 既に選ばれた変数群との平均相関（冗長性・マルチコ）。
     - バブルサイズ: 変数の分散または非欠損率。
     - 右下に位置する変数（「重要度が高く、かつ他の変数と相関が低い」）を優先抽出。

     > **冗長性（Redundancy）の定義**: API レスポンスの `meanRedundancy` は、当該変数と **全候補変数間の平均 Pearson 相関（絶対値）** を静的に算出した値とする。これは初期表示用の概観指標である。
     >
     > 真の mRMR（Minimum Redundancy Maximum Relevance）における「既に選択された変数セットとの動的冗長性」は、フロントエンド側で Top-K 選択操作に連動してインタラクティブに再計算する。ユーザーが Top-K スライダーを操作するたびに、選択済み変数セットに対する冗長性を動的に更新し、バブルプロット上のY軸位置をリアルタイムに反映する。
   - **統合ランクサマリーテーブル (Borda Count Aggregation Table)**:
     - 変数名、各手法ごとの生スコア・順位、統合Bordaスコア、推奨フラグ。
3. **共通インターフェース連携 (Global Variable Selector Integration)**:
   - 「上位 $K$ 変数を適用」ボタン：クリックすると、統合スコア上位 $K$ 個（例: 5個）の変数IDが、画面上部の共通グローバル変数マネージャ（`activeVariableIds`）へ直接上書き注入される。
   - これにより、ユーザーはタブをPCPへ切り替えるだけで、重要変数だけに絞り込まれたクリアな平行座標プロットを直ちに閲覧・分析できる。

---

## 3. 数理仕様・アルゴリズム

### 3.1 ReliefF アルゴリズム
ReliefF（Kira & Rendell 1992, Kononenko 1994）は、多クラス問題や欠損値に対応したインスタンスベースの特徴量重み付け手法である。各変数は独立に評価されるのではなく、局所的な近傍空間における識別能に基づいてスコア $W[A]$ が更新される。

各ステップで、ランダムに選ばれたサンプル $\mathbf{x}_i$ に対し：
1. 同一クラスの $k$ 個の最近傍サンプル（**Near Hits**: $H_j, j=1..k$）
2. 異なる各クラス $C \neq \text{class}(\mathbf{x}_i)$ の $k$ 個の最近傍サンプル（**Near Misses**: $M_j(C), j=1..k$）

を探索し、各変数 $A$ の重み $W[A]$ を次式で反復更新する：

$$W[A] \leftarrow W[A] - \sum_{j=1}^k \frac{\text{diff}(A, \mathbf{x}_i, H_j)}{m \cdot k} + \sum_{C \neq \text{class}(\mathbf{x}_i)} \left[ \frac{P(C)}{1 - P(\text{class}(\mathbf{x}_i))} \sum_{j=1}^k \frac{\text{diff}(A, \mathbf{x}_i, M_j(C))}{m \cdot k} \right]$$

ここで $\text{diff}(A, \mathbf{x}_1, \mathbf{x}_2)$ は正規化絶対値差分分母である。同一クラス間で差が小さく、異クラス間で差が大きい変数ほど重みが正に増大する。

> **ReliefF 実装方針**: scikit-learn には ReliefF が含まれないため、**NumPy ベースのカスタム実装** を採用する（Numba による JIT 高速化をオプションで適用）。外部ライブラリ（`skrebate` 等）への依存は安定性・メンテナンス性の観点から避ける。
>
> サンプリング反復数 $m$ はデフォルトで $m = \min(N, 500)$ とし、大規模データセット（$N > 10{,}000$）での計算時間を $O(m \cdot k \cdot p)$ に抑制する。$m$ は API パラメータとして公開する。

### 3.2 相互情報量 (Mutual Information: MI)
連続説明変数 $X$ と離散目的変数 $Y$ の相互情報量 $I(X; Y)$ は、Kraskov-Stögbauer-Grassberger (KSG) タイプの k-最近傍法（k-NN）に基づいて次のようにノンパラメトリックに推定される：

$$I(X; Y) = \psi(N) - \langle \psi(N_y) \rangle + \psi(k) - \langle \psi(m_i) \rangle$$

ここで $\psi$ はディガンマ関数、$N_y$ はクラス $y$ のサンプル数、$m_i$ はサンプル $i$ の周辺近傍点数である。$I(X; Y) = 0$ は統計的独立を意味し、値が大きいほど非線形を含む強固な関連性を示す。

### 3.3 統合ランク集約 (Borda Count & Robust Aggregation)
$M$ 個の評価手法 $m = 1, \dots, M$ において、全 $p$ 個の変数に対する変数 $j$ の順位を $R_{m}(j) \in \{1, \dots, p\}$（1が最優秀）とする。

Borda Count による統合スコア $B(j)$ は各手法の順位の和（または線形変換スコアの平均）により定義される：

$$B(j) = \sum_{m=1}^M (p - R_m(j) + 1)$$

さらに、外れ値的な過大評価を抑制するため、中央値順位（Median Rank）と最小順位（Worst-case Rank）を併記し、総合推奨度（Recommendation Tier）を算出する。

> **同順位（タイ）の処理**: 同一スコアの変数が存在する場合、**平均ランク方式（average rank）** を採用する。例: 3位タイが2変数ある場合、両者のランクは $(3+4)/2 = 3.5$ とし、次の変数は5位とする。これにより Borda ポイントの公平性を担保する。

### 3.4 カテゴリカル説明変数の前処理

`featureColumns` にカテゴリカル変数（`object` / `categorical` 型）が含まれる場合、以下の手法別前処理を適用する:

| 評価手法 | カテゴリ変数の扱い |
|----------|-------------------|
| **ReliefF** | カテゴリ変数をそのまま処理可能（`diff` 関数が離散値に対応） |
| **Mutual Information** | `discrete_features` パラメータで離散変数として指定し、KSG ではなくヒストグラムベースの MI 推定を適用 |
| **Random Forest (MDI)** | Ordinal Encoding（整数化）を適用した上でツリー分岐に使用 |
| **ANOVA F-statistic** | 非数値列は自動的にスキップし、数値列のみを対象とする |
| **PCA Dispersion** | 非数値列は自動的にスキップし、数値列のみを対象とする |

スキップされた変数はレスポンスの `rankings` に含まれるが、該当手法のスコアは `null` とし、Borda Count 集約ではスキップされた手法を除外して $M$ を調整する。

---

## 4. UI/UX 詳細設計

### 4.1 画面レイアウトワイヤーフレーム
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Variable Ranking & Feature Selection]                [Focus / 拡大表示]     │
├──────────────────────────────────────────────────────────────────────────────┤
│ 目的変数 Y: [ Species (setosa...) ▼]  評価対象 X: [ 全4変数 (Active: 4)  ▼]   │
│ 評価手法: [x] ReliefF  [x] 相互情報量(MI)  [x] Random Forest  [x] ANOVA F     │
│ [ ランキング計算実行 (Compute Rankings) ]                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ ★ アクションバー: 上位K変数の一括選択とグローバル反映                         │
│   選択基準: [ 統合Bordaスコア ▼]  上位件数 K: [ 3 ▼]                         │
│   選択対象: [ Petal.Length, Petal.Width, Sepal.Length ]                      │
│   [ 上部共通 Variable Selector へ適用 (Apply to Active Variables) ] ◄──【重要】│
├──────────────────────────────────────┬───────────────────────────────────────┤
│ ▼ 手法別スコア比較バー (正規化 0-1)  │ ▼ 関連度 vs 冗長性プロット (mRMR)     │
│  ソート: [ 統合Borda順           ▼]  │  縦軸: 他変数平均相関 (Redundancy)    │
│                                      │   1.0 ┌────────────────────────┐      │
│  Petal.Length ■■■■■■■■■■ 0.98 (Rank 1)│       │          (Sepal.L)     │      │
│  Petal.Width  ■■■■■■■■■░ 0.92 (Rank 2)│   0.5 │       (Petal.W)        │      │
│  Sepal.Length ■■■■■░░░░░ 0.54 (Rank 3)│       │            ★Petal.L    │      │
│  Sepal.Width  ■■░░░░░░░░ 0.21 (Rank 4)│   0.0 └────────────────────────┘      │
│                                      │       0.0         0.5        1.0       │
│  凡例: ■ReliefF ■MI ■RF ■F-value     │       横軸: 統合重要度 (Relevance)    │
├──────────────────────────────────────┴───────────────────────────────────────┤
│ ▼ 統合ランキング詳細テーブル                                                 │
│  ┌──────────────┬──────┬─────────┬──────┬──────┬────────┬────────┬─────────┐ │
│  │ 変数名       │ 統合 │ Borda点 │ MI点 │ R-F点│ RF-MDI │ F-値   │ 推奨度  │ │
│  ├──────────────┼──────┼─────────┼──────┼──────┼────────┼────────┼─────────┤ │
│  │ Petal.Length │ 1 位 │ 16 / 16 │ 0.99 │ 0.98 │ 0.96   │ 1180.4 │ High ★  │ │
│  │ Petal.Width  │ 2 位 │ 12 / 16 │ 0.94 │ 0.91 │ 0.92   │  960.2 │ High ★  │ │
│  │ Sepal.Length │ 3 位 │  8 / 16 │ 0.58 │ 0.52 │ 0.55   │  119.3 │ Mid     │ │
│  │ Sepal.Width  │ 4 位 │  4 / 16 │ 0.25 │ 0.18 │ 0.22   │   49.2 │ Low     │ │
│  └──────────────┴──────┴─────────┴──────┴──────┴────────┴────────┴─────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 インタラクション仕様
1. **ワンクリックでの上位変数セット適用**:
   - `[ 上部共通 Variable Selector へ適用 ]` ボタンを押下すると、Redux Store の `globalVariables.activeVariableIds` が選択された上位変数に更新される。
   - ヘッダーの「Variable Selector」タグ表示が即座に同期し、PCPタブへ戻ると余計な軸が除外され、上位変数のみで構成された見やすいプロットに生まれ変わる。
2. **テーブル行ホバー・クリック**:
   - ランキングテーブルの行をクリックすると、その変数がバブルプロット上でハイライトされ、詳細なスコア内訳ポップオーバーが表示される。

---

## 5. API・データ型定義

### 5.1 リクエスト・レスポンス型 (TypeScript)
```typescript
export interface FeatureRankingRequest {
  datasetId: string
  targetColumn?: string
  featureColumns: string[]
  activeRowIds?: string[]
  methods: ('relieff' | 'mutual_info' | 'random_forest' | 'f_statistic' | 'pca_dispersion')[]
  kNeighbors?: number // For ReliefF & MI
  relieffSampleSize?: number  // ReliefF サンプリング反復数 m (default: min(N, 500))
  nEstimators?: number // For RF
  usePermutationImportance?: boolean
  seed?: number
}

export interface MetricScoreItem {
  rawScore: number
  normalizedScore: number
  rank: number
}

export interface VariableRankItem {
  variable: string
  bordaScore: number
  overallRank: number
  recommendationTier: 'high' | 'medium' | 'low'
  meanRedundancy: number // Average Pearson/Spearman correlation with other features
  scores: {
    relieff?: MetricScoreItem
    mutualInfo?: MetricScoreItem
    randomForest?: MetricScoreItem
    fStatistic?: MetricScoreItem
    pcaDispersion?: MetricScoreItem
  }
}

export interface FeatureRankingResponse {
  target?: string
  taskType: 'classification' | 'regression' | 'unsupervised'
  evaluatedVariables: string[]
  rankings: VariableRankItem[]
  suggestedTopK: number
  executionTimeMs: number
  evidenceClass: 'SLIDES-2005' | 'MODERN-EXTENSION'
}
```

### 5.2 FastAPI エンドポイント (Python)
```python
# backend/app/api/mining.py (または feature_ranking.py)
from fastapi import APIRouter
from pydantic import BaseModel
from typing import List, Optional, Dict, Any

router = APIRouter(prefix="/mining/feature-ranking", tags=["mining"])

class FeatureRankingRequestSchema(BaseModel):
    datasetId: str
    targetColumn: Optional[str] = None
    featureColumns: List[str]
    activeRowIds: Optional[List[str]] = None
    methods: List[str] = ["relieff", "mutual_info", "random_forest", "f_statistic", "pca_dispersion"]
    kNeighbors: int = 10
    relieffSampleSize: Optional[int] = None  # default: min(N, 500)
    nEstimators: int = 100
    usePermutationImportance: bool = False
    seed: int = 42

@router.post("", response_model=Dict[str, Any])
async def compute_feature_rankings(req: FeatureRankingRequestSchema):
    """
    Computes multi-criteria feature rankings across ReliefF, Mutual Information,
    Random Forest importances, and F-statistics, aggregating them with Borda Count.
    """
    pass
```

### 5.3 バックエンド特記事項

#### タスクタイプ自動判定ルール

`targetColumn` が指定された場合、以下のヒューリスティックにより `taskType` を自動判定する:

| 条件 | 判定結果 |
|------|----------|
| `targetColumn` が未指定（`null`） | `unsupervised` |
| 列の dtype が `object` / `string` / `categorical` | `classification` |
| 列の dtype が `int` かつユニーク値数 ≤ 10 | `classification` |
| 列の dtype が `float` または（`int` かつユニーク値数 > 10） | `regression` |

バックエンドは判定結果を `taskType` としてレスポンスに含め、フロントエンドは適切な可視化モード（分類用スコア vs 回帰用スコア）を自動選択する。

> **大規模データセット対応**: `activeRowIds` が 10,000 件を超える場合、全行IDの JSON 送信はネットワーク効率が低下する。将来的には以下のいずれかの最適化を導入する:
> - サーバーサイドセッションに `activeRowIds` をキャッシュし、`sessionId` 参照で代替
> - ビットマスク圧縮（Base64 エンコードされたビット配列）による転送量削減
>
> v1.0 では JSON 配列による直接送信を維持するが、バックエンド側で 100,000 行を上限とするバリデーションを追加する。

---

## 6. テスト・検証計画

### 6.1 自動テスト
1. **合成データでの識別能テスト**:
   - 目的変数と完全に独立な純粋ガウスノイズ変数を混入させたデータセットを作成し、ノイズ変数が全手法で下位（最下位層）に正しくランク付けされることを検証。
2. **Irisデータセットでの基準検証**:
   - `Petal.Length` および `Petal.Width` が全手法（ReliefF, MI, RF, F値）において安定して第1位・第2位を独占することを確認。
3. **上部共通変数セレクタとの連携テスト (Vitest / Integration)**:
   - `Apply to Active Variables` アクションをディスパッチした際、Redux Store の `activeVariableIds` が期待通り更新され、PCPのレンダラーへ新しい軸順リストが伝達されることを確認。
