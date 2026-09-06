# 実装計画書: Discriminant Analysis (判別分析・ステップワイズ変数選択・判別空間マッピング)

文書ID: DAVIS-FEAT-013  
版: 1.0.0  
作成日: 2026-09-05  
優先度: 3  
対象コンポーネント: Backend (LDA / QDA / Stepwise Discriminant API), Frontend (Discriminant Analysis View, 2D Decision Boundary Canvas, Canonical Loadings Biplot, Stepwise Trace Table, Linked Brushing)  

---

## 1. 概要・目的

### 1.1 背景と目的
元のDAVIS（Huh & Song, 2002; Huh et al., 2005）において、統計解析モジュール（Statistics Module）の主要な教師あり分類・次元削減手法として搭載されていた **Discriminant Analysis（判別分析）** および **Stepwise Discriminant Analysis（ステップワイズ判別分析）** を現代フルスタックシステム上に復元・再構成する。

判別分析は、あらかじめ既知のグループ（例: アヤメの品種、顧客セグメント、信用リスク分類など）に属するサンプル群に基づき、各群の群間分散を最大化し群内分散を最小化する判別関数（Fisherの線形判別関数）を構成する。これにより、新サンプルの所属判別や、高次元空間におけるグループ分離の構造を把握することができる。

さらに、2005年の発表資料で強調されていた **ステップワイズ判別分析（Stepwise Discriminant Analysis）** は、多数の変数群からWilksのラムダ（$\Lambda$）や偏F値（Partial F-statistic）に基づいて、グループの分離に真に寄与する変数セットを自動的・逐次的に選定する強力な変数選択手法である。

DAVISにおける判別分析の真骨頂は、**「正準判別得点（LD1 vs LD2）の2次元射影空間上に判別境界線と各グループの等高線（確率楕円）を描画し、グループ境界に位置するサンプルや誤分類サンプルをマウスでブラッシングして、即座にPCPやペアプロット、データテーブルへ連動伝播させる（Linked Brushing）」** 点にある。

### 1.2 元のDAVISにおける原典根拠
- **初版JARバイトコード (JAR-INITIAL)**:
  - メインメニュー: `Statistics -> Disc. Analysis`
  - パッケージ: `davis.plot.discriminant`
  - 主要クラス:
    - `davis.plot.discriminant.Discriminant`: 判別分析の計算エンジン
    - `davis.plot.discriminant.DiscriminantBean`: Java Beanとしての連携インターフェース
    - `Discriminant` extends `DavisPlot` extends `PlotData`（共有選択配列 `PlotData.index[]` および右クリックメニュー `Focus`, `Delete`, `Undo`, `Identify` を自動継承）
- **2005年発表資料 (SLIDES-2005)**:
  - Slide 14: `Statistical Tools: Stepwise discriminant analysis`

---

## 2. アーキテクチャと機能要件

### 2.1 全体アーキテクチャ構成
```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend UI                            │
│  [新ナビゲーションタブ: "Discriminant" または Models 内]     │
│  ┌──────────────────────────────┐┌────────────────────────┐ │
│  │ 1. 判別空間 (LD1-LD2) 散布図 ││ 2. 正準負荷量バイプロット│ │
│  │  - 背景に判別境界 & 等高線   ││  - 各変数の判別軸寄与   │ │
│  │  - サンプル散布点 (クラス色) ││    ベクトル矢印          │ │
│  │  - 矩形ブラシ / 境界サンプル ││  - 寄与の大きい軸を把握  │ │
│  └──────────────────────────────┘└────────────────────────┘ │
│  ┌──────────────────────────────┐┌────────────────────────┐ │
│  │ 3. ステップワイズ変数選択パス││ 4. 誤分類サンプル一覧  │ │
│  │  - Stepごとの投入/除外変数   ││  - 事後所属確率 (Post.)│ │
│  │  - Wilks' Λ 推移, 偏F値      ││  - クリックでPCPへ即時 │ │
│  │  - 最適変数セットの一括適用  ││    ハイライト連動      │ │
│  └──────────────────────────────┘└────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │ 双方向同期 (Redux / Zustand Store)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Shared Selection State                      │
│  activeRowIds, selectedRowIds, globalVariables              │
│  (PCP, Data Table, BoxPlot, Line Mosaic へ即時伝播)         │
└──────────────────────────────┬──────────────────────────────┘
                               │ JSON API Request / Response
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                   Backend (FastAPI)                         │
│  [POST /api/models/discriminant]                            │
│    - sklearn.discriminant_analysis.LinearDiscriminantAnalysis│
│    - scipy / statsmodels による Wilks' Λ & 偏F値 ステップワイズ│
│    - 正準判別関数 (Eigenvalues / Canonical Correlations)     │
│    - 判別境界メッシュ座標 & 確率等高線データの生成           │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 主要機能要件一覧
1. **モデル設定**:
   - **グループ変数（Target / Class）**: 2値または多値（3クラス以上）の名義・カテゴリカル変数（例: `Species`, `Segment`）。
   - **説明変数（Features）**: 数値型変数群。上部の共通 Variable Selector からのアクティブ変数を自動同期。
   - **判別手法（Method）**:
     - **LDA (Linear Discriminant Analysis)**: 等分散性を仮定した線形境界。
     - **QDA (Quadratic Discriminant Analysis)**: 群ごとの個別分散共分散行列を許容する2次曲線境界。
     - **Stepwise Forward / Backward**: Wilksの $\Lambda$ 最小化とF検定による変数増減法。
   - **正則化（Shrinkage / Priors）**: 自動（Ledoit-Wolf）/ 無し、事前確率は一様または各群のサンプル比率。
2. **可視化ビュー**:
   - **判別空間マップ (2D Canonical Discriminant Map)**:
     - 第1正準判別軸（LD1）を横軸、第2正準判別軸（LD2）を縦軸にした散布図。
     - 2クラスの場合は LD1 のみとなるため、LD1 軸のヒストグラム＋確率密度曲線（KDE）表示に自動切り替え。
     - 背景に各クラスの決定領域（Decision Boundary）を薄い背景色メッシュで描画。
     - サンプル点は実測クラス色で描画し、誤分類された点は外枠を強調（または $\times$ マーク）。
     - 矩形ブラシにより、境界線上（確率が拮抗しているサンプル）や誤分類サンプルを直感的に囲んで選択可能。
   - **正準判別負荷量バイプロット (Canonical Loadings Biplot)**:
     - 原点から各変数の寄与方向・大きさを示すベクトル矢印を描画。
     - どの変数がグループをどの方向に引き離しているかを一目で診断。
   - **ステップワイズ変数選択トレース (Stepwise Trace)**:
     - ステップごとの投入変数（Variable Entered）、除外変数（Variable Removed）、Wilks' $\Lambda$、偏F値（$F_{\text{to-enter}} / F_{\text{to-remove}}$）、p値の推移テーブル。
     - 「このステップの変数セットを全体適用」ボタンをクリックすると、グローバル変数マネージャのアクティブ変数がその変数セットに一括更新される。
   - **誤分類サンプル・事後確率サマリー**:
     - 各サンプルの真のクラス、予測クラス、事後確率 $P(C_k \mid \mathbf{x})$、Mahalanobis距離。
     - 「誤分類行を一括選択」ボタンで、判別に失敗した行群を一発でブラッシング。
3. **対話的連動 (Linked Interaction)**:
   - 判別平面上で境界付近のグレーゾーンサンプルを囲む $\to$ PCP上でそれらのサンプルの特徴（どの変数が中間的な値を取っているか）を直ちに視認。
   - 右クリックメニュー（Focus / Delete / Reset / Identify）完備。

---

## 3. 数理仕様・アルゴリズム

### 3.1 Fisherの線形判別分析 (LDA)
$K$ 個のクラス $C_1, C_2, \dots, C_K$ に対し、クラス $k$ のサンプル数を $N_k$、総サンプル数を $N = \sum N_k$、クラス内平均ベクトルを $\boldsymbol{\mu}_k$、全体平均ベクトルを $\boldsymbol{\mu}$ とする。

群内変動行列（Within-class Scatter Matrix） $\mathbf{S}_W$ および 群間変動行列（Between-class Scatter Matrix） $\mathbf{S}_B$ は次のように定義される：

$$\mathbf{S}_W = \sum_{k=1}^K \sum_{i \in C_k} (\mathbf{x}_i - \boldsymbol{\mu}_k)(\mathbf{x}_i - \boldsymbol{\mu}_k)^T$$

$$\mathbf{S}_B = \sum_{k=1}^K N_k (\boldsymbol{\mu}_k - \boldsymbol{\mu})(\boldsymbol{\mu}_k - \boldsymbol{\mu})^T$$

正準判別関数は、群間分散と群内分散の比（Rayleigh商）を最大化するベクトル $\mathbf{w}$ を求める一般化固有値問題に帰着される：

$$\mathbf{S}_W^{-1} \mathbf{S}_B \mathbf{w} = \lambda \mathbf{w}$$

得られた最大 $M = \min(p, K-1)$ 個の固有値 $\lambda_1 \ge \lambda_2 \ge \dots \ge \lambda_M$ に対応する固有ベクトル $\mathbf{w}_1, \mathbf{w}_2$ を用いて、各サンプル $\mathbf{x}_i$ の第1・第2正準判別得点 $z_{i1}, z_{i2}$ を算出する：

$$z_{i1} = \mathbf{w}_1^T \mathbf{x}_i, \quad z_{i2} = \mathbf{w}_2^T \mathbf{x}_i$$

### 3.2 事後確率と決定境界
各クラスの事前確率を $\pi_k$、共通共分散行列を $\boldsymbol{\Sigma} = \frac{1}{N - K} \mathbf{S}_W$ とするとき、線形判別関数（Linear Discriminant Function） $\delta_k(\mathbf{x})$ は次式となる：

$$\delta_k(\mathbf{x}) = \mathbf{x}^T \boldsymbol{\Sigma}^{-1} \boldsymbol{\mu}_k - \frac{1}{2} \boldsymbol{\mu}_k^T \boldsymbol{\Sigma}^{-1} \boldsymbol{\mu}_k + \ln \pi_k$$

サンプル $\mathbf{x}$ がクラス $k$ に属する事後確率はソフトマックス形式で計算される：

$$P(C_k \mid \mathbf{x}) = \frac{\exp(\delta_k(\mathbf{x}))}{\sum_{j=1}^K \exp(\delta_j(\mathbf{x}))}$$

決定境界は $\delta_k(\mathbf{x}) = \delta_j(\mathbf{x})$ となる超平面である。

> **QDA 実行時の 2D 射影方式**: QDA ではクラスごとに個別の分散共分散行列 $\boldsymbol{\Sigma}_k$ を使用するため、LDA のような共通の正準判別軸は定義できない。QDA 実行時の 2D 散布図は、**LDA の正準判別軸（$\mathbf{w}_1, \mathbf{w}_2$）を借用して射影する方式** を採用する（scikit-learn の `LinearDiscriminantAnalysis.transform()` と同等）。決定境界のみ QDA の2次判別関数に基づいて描画し、射影座標系自体は LDA ベースとする。これにより、LDA / QDA 間の結果比較が同一座標系上で直感的に行える。

### 3.3 ステップワイズ変数選択の停止基準 (Wilks' Lambda & Partial F)
現在の変数集合 $S$ における Wilksの $\Lambda$ は、群内行列式と全変動行列式の比で表される：

$$\Lambda(S) = \frac{|\mathbf{S}_W(S)|}{|\mathbf{S}_T(S)|} = \frac{|\mathbf{S}_W(S)|}{|\mathbf{S}_W(S) + \mathbf{S}_B(S)|}$$

$\Lambda \in (0, 1]$ であり、値が小さいほどグループ間の分離度が優れている。

新たな変数 $X_v$ を追加したときの偏F統計量（Partial F-to-enter）は次式により評価される：

$$F_{\text{enter}} = \frac{N - K - p}{K - 1} \left( \frac{\Lambda(S)}{\Lambda(S \cup \{X_v\})} - 1 \right)$$

指定した閾値 $F_{\text{in}}$（例: 3.84, $p \approx 0.05$）を超える変数のうち、$\Lambda$ を最も減少させる変数を採用する。逆に、既存変数の中で $F_{\text{remove}} < F_{\text{out}}$（例: 2.71, $p \approx 0.10$）となった変数は除外する。

#### ステップワイズの停止条件と安全制御

以下のいずれかの条件を満たした時点でステップワイズ処理を終了する:

1. **収束**: 投入基準 $F_{\text{enter}} > F_{\text{in}}$ を満たす変数が存在せず、かつ除外基準 $F_{\text{remove}} < F_{\text{out}}$ を満たす変数も存在しない
2. **最大ステップ数到達**: `stepwiseConfig.maxSteps`（デフォルト: 20）に到達
3. **サイクル検出**: 過去のステップで出現した選択変数セット（集合として同一）が再度出現した場合、無限ループと判定して即座に終了する。直前のサイクル開始前の状態を最終結果として採用する
4. **全変数投入/全変数除外**: 候補変数がすべて投入済み、またはすべて除外済みとなった場合

#### 欠損値（NaN）の処理方針

説明変数または目的変数に欠損値（NaN / null）を含む行は **リストワイズ削除（Listwise Deletion）** により解析対象から除外する。除外された行は以下のように処理する:

1. `DiscriminantResponse.samples` には除外行を含めない
2. 除外された行数をレスポンスに `excludedRowCount: number` として返却する
3. `activeRowIds` が指定されている場合、その中から欠損行を除外した上でモデルを推定する
4. フロントエンドでは除外行数を通知バナーで表示する

---

## 4. UI/UX 詳細設計

### 4.1 画面レイアウトワイヤーフレーム
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Discriminant Analysis]                                [Focus / 拡大表示]     │
├──────────────────────────────────────────────────────────────────────────────┤
│ クラス Y: [ Species (setosa, versicolor...) ▼]  手法: (•) LDA  ( ) QDA  ( ) Stepwise │
│ 変数 X: [ 4変数選択中 (Sepal.L, Petal.L...) ▼]  正則化: [ Auto (Ledoit-Wolf) ▼] │
│ [ 判別分析実行 (Run Analysis) ]       [ 誤分類サンプル選択 (Select Misclassified) ] │
├──────────────────────────────────────┬───────────────────────────────────────┤
│ ▼ 2D 正準判別空間マップ (LD1 vs LD2) │ ▼ 正準負荷量バイプロット (Loadings)   │
│  寄与率: LD1 (99.1%)  LD2 (0.9%)     │                                       │
│  LD2                                 │  LD2                                  │
│   4 ┌────────────────────────┐       │    1 ┌───────────────┐               │
│     │        (versicolor)    │       │      │       ▲Petal.W│               │
│   2 │       • ••▲•••••       │       │      │       │       │               │
│     │   ••••• ••/   ••       │       │    0 │───────┼───────│──► LD1        │
│   0 │  (setosa)/  •••••••    │       │      │       │Petal.L│               │
│     │ ••••••••/ (virginica)  │       │   -1 └───────┴───────┘               │
│  -2 │ •••••••/               │       │     -1       0       1  矢印=変数の寄与│
│     └────────────────────────┘       │                                       │
│     -8    -4     0     4     8  LD1  │                                       │
│  境界: --- 決定境界線  •:観測サンプル│                                       │
├──────────────────────────────────────┴───────────────────────────────────────┤
│ ▼ ステップワイズ変数選択トレース (Stepwise Trace) & モデル性能指標           │
│  Wilks' Λ: 0.0234   近似F値: 546.2 (p < 0.0001)   全体正解率: 98.0% (147/150)│
│  ┌──────┬──────────┬──────────┬──────────┬────────────┬─────────┬──────────────┐ │
│  │ Step │ Action   │ Variable │ Wilks' Λ │ Partial F  │ p-value │ [適用]       │ │
│  ├──────┼──────────┼──────────┼──────────┼────────────┼─────────┼──────────────┤ │
│  │ 1    │ Entered  │ Petal.L  │ 0.0543   │ 1180.4     │ <0.0001 │ [この状態に] │ │
│  │ 2    │ Entered  │ Sepal.W  │ 0.0321   │ 52.3       │ <0.0001 │ [この状態に] │ │
│  │ 3    │ Entered  │ Petal.W  │ 0.0234   │ 28.1       │ <0.0001 │ [この状態に] │ │
│  └──────┴──────────┴──────────┴──────────┴────────────┴─────────┴──────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 インタラクション仕様
1. **境界付近サンプルの矩形ブラッシング**:
   - LD1-LD2 判別マップ上でドラッグすると、矩形枠内のサンプル行が即時選択される。
   - 特に `versicolor` と `virginica` の境界付近で混在しているサンプルを囲むと、右側サイドバーおよびPCP上にその行が赤く浮き上がり、「どの計測値が中間的であるか」が直ちに明らかになる。
2. **ステップワイズ結果からの変数一括反映**:
   - ステップワイズのテーブルにある `[この状態に]` ボタンを押すと、そのステップで選ばれた変数群（例: `Petal.L, Sepal.W, Petal.W` の3変数）が、画面上部の共通グローバル変数選択に反映され、PCPの軸も自動的にその3変数へ絞り込まれる。
3. **誤分類サンプルの1クリック選択**:
   - `Select Misclassified` ボタンで、事後確率と正解ラベルが一致しなかった行（Irisでは3行）が一括選択される。

> **2クラス（$K=2$）時の表示モード切替**: クラス数が2の場合、正準判別軸は LD1 のみ（$M = \min(p, K-1) = 1$）となる。この場合:
> - **判別空間マップ**: LD1 軸上の1次元ヒストグラム + KDE（カーネル密度推定）曲線をクラス別に重ね描きする。2D 散布図は表示しない。
> - **バイプロット**: 各変数の LD1 負荷量のみを水平バーチャートとして描画する（`ld2` は `null` / `0` として無視）。
> - **`BoundaryMesh`**: 2クラス時は `null` とし、代わりに LD1 軸上の決定境界点（閾値）を1本の垂直線として描画する。
> - **`CanonicalAxisInfo`**: `axes` 配列の長さが 1 の場合、フロントエンドは自動的に1Dモードに切り替える。

---

## 5. API・データ型定義

### 5.1 リクエスト・レスポンス型 (TypeScript)
```typescript
export interface DiscriminantRequest {
  datasetId: string
  targetColumn: string
  featureColumns: string[]
  activeRowIds?: string[]
  method?: 'lda' | 'qda' | 'stepwise'
  shrinkage?: 'none' | 'auto' | number
  priors?: 'uniform' | 'proportional'
  stepwiseConfig?: {
    fEnter: number
    fRemove: number
    maxSteps: number
  }
}

export interface CanonicalAxisInfo {
  axisIndex: number
  eigenvalue: number
  explainedVarianceRatio: number
  canonicalCorrelation: number
}

export interface VariableLoading {
  variable: string
  ld1: number
  ld2?: number
}

export interface StepwiseTraceStep {
  step: number
  action: 'entered' | 'removed'
  variable: string
  wilksLambda: number
  partialF: number
  pValue: number
  activeVariables: string[]
}

export interface DiscriminantSamplePoint {
  rowId: string
  actualClass: string
  predictedClass: string
  isMisclassified: boolean
  ld1: number
  ld2: number
  posteriorProbabilities: Record<string, number>
  mahalanobisDistance: number
}

export interface BoundaryMesh {
  xRange: [number, number]
  yRange: [number, number]
  gridResolution: number
  classes: string[]
  gridClassIndices: number[][] // 2D grid of predicted class index
}

export interface DiscriminantResponse {
  target: string
  classes: string[]
  features: string[]
  method: 'lda' | 'qda' | 'stepwise'
  accuracy: number
  axes: CanonicalAxisInfo[]
  loadings: VariableLoading[]
  samples: DiscriminantSamplePoint[]
  boundaryMesh?: BoundaryMesh
  stepwiseTrace?: StepwiseTraceStep[]
  misclassifiedRowIds: string[]
  wilksLambdaOverall: number
  pOverall: number
  evidenceClass: 'JAR-INITIAL' | 'SLIDES-2005' | 'MODERN-EXTENSION'
  excludedRowCount: number
}
```

### 5.2 FastAPI エンドポイント (Python)
```python
# backend/app/api/discriminant.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any, Union

router = APIRouter(prefix="/models/discriminant", tags=["models"])

class StepwiseConfigSchema(BaseModel):
    fEnter: float = 3.84
    fRemove: float = 2.71
    maxSteps: int = 20

class DiscriminantRequestSchema(BaseModel):
    datasetId: str
    targetColumn: str
    featureColumns: List[str]
    activeRowIds: Optional[List[str]] = None
    method: str = "lda"
    shrinkage: Union[str, float] = "none"  # 'none' | 'auto' | float (0.0-1.0)
    priors: str = "proportional"
    stepwiseConfig: Optional[StepwiseConfigSchema] = None

@router.post("", response_model=Dict[str, Any])
async def run_discriminant_analysis(req: DiscriminantRequestSchema):
    """
    Executes Linear/Quadratic Discriminant Analysis or Stepwise Discriminant Selection.
    Returns canonical scores, loadings, boundary mesh, misclassified rows, and stepwise trace.
    """
    pass
```

---

## 6. テスト・検証計画

### 6.1 自動テスト
1. **FisherのIris再現検証**:
   - Iris 150行（4変数）に対するLDA実行時、第1正準軸の寄与率が約99.1%、固有値の比率および正解率が $98.0\%$（誤分類3件）となる標準結果と完全一致することを検証。
2. **ステップワイズ変数選択の単調減少検証**:
   - ステップワイズ進行に伴い、Wilks' $\Lambda$ が各ステップで単調に減少することを確認。
3. **特異分散共分散行列の自動正則化**:
   - 変数数がサンプル数を超える場合や完全共線変数が含まれる場合に、例外停止せずLedoit-Wolf縮小（Shrinkage）が作動することを確認。
4. **連動ブラッシングテスト (E2E)**:
   - 誤分類サンプルの選択ボタン押下により、PCPおよびデータテーブルに正しいIDが即時伝播することを確認。
