# 実装計画書: Logistic Regression (ロジスティック回帰分析と確率境界可視化)

文書ID: DAVIS-FEAT-012  
版: 1.0.0  
作成日: 2026-09-05  
優先度: 3  
対象コンポーネント: Backend (Logistic Regression API / statsmodels & scikit-learn), Frontend (Logistic Regression View, Sigmoid Curve, Odds Ratio Forest Plot, ROC/Confusion Matrix, Linked Brushing)  

---

## 1. 概要・目的

> **スコープ制限 (v1.0)**: 本バージョンでは **2値（Binary）ロジスティック回帰のみ** をサポートする。多値（Multinomial）分類への拡張（$K \times K$ 混同行列、クラスごとの確率曲線、MNLogit 対応の係数出力形式）は v1.1 以降で対応予定とする。

### 1.1 背景と目的
元のDAVIS（Huh & Song, 2002; Huh et al., 2005）において、統計解析モジュール（Statistics Module）の主要な教師あり多変量解析手法として搭載されていた **Logistic Regression（ロジスティック回帰）** を現代フルスタックアーキテクチャ上に復元・拡張する。

ロジスティック回帰は、2値または多値の名義・カテゴリカルな目的変数（例: 疾患有無、離脱有無、タイタニックの生存/死亡、アヤメの種など）に対し、複数の連続・カテゴリカル説明変数が与える影響度を対数オッズ比としてモデル化し、事後確率を予測する統計手法である。

DAVISにおけるロジスティック回帰の核心的価値は、単なるパラメータ推定値のテキスト出力にとどまらず、**「予測確率のS字曲線やオッズ比プロット、混同行列上のサンプル群をマウスで直接ブラッシングし、誤分類サンプルや境界近傍の不確実なサンプルを即座にPCP（平行座標プロット）やデータテーブル、クラスタリング画面へ連動伝播させる（Linked Brushing）」** という対話的探索（Exploratory Data Analysis）の実現にある。

本機能により、アナリストは「多変量空間での変数の効果検証 → 個別サンプルの予測確率と乖離の診断 → PCPでの外れ値・境界例の特定 → Focus / Delete による部分集団解析」というDAVIS本来の洗練された探索ループを実行できるようになる。

### 1.2 元のDAVISにおける原典根拠
- **初版JARバイトコード (JAR-INITIAL)**:
  - メインメニュー: `Statistics -> Logistic Reg.`
  - パッケージ: `davis.plot.logistic`
  - 主要クラス:
    - `davis.plot.logistic.Logistic`: コントローラおよび回帰計算ロジック
    - `davis.plot.logistic.LogisticBean`: Java Beanとしての他プロット連携インターフェース
    - `davis.plot.logistic.LogisticPanel`: パラメータ設定および結果描画UI
    - `Logistic` extends `DavisPlot` extends `PlotData`（共有選択配列 `PlotData.index[]`、描画基底、右クリックメニュー `Focus`, `Delete`, `Undo`, `Identify` を自動継承）
- **2005年発表資料 (SLIDES-2005)**:
  - Slide 6: `Statistical Tools: Logistic Regression`

---

## 2. アーキテクチャと機能要件

### 2.1 全体アーキテクチャ構成
```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend UI                            │
│  [新ナビゲーションタブ: "Logistic" または Models 内サブタブ]│
│  ┌──────────────────────────────┐┌────────────────────────┐ │
│  │ 1. 予測確率 S字曲線プロット  ││ 2. オッズ比フォレスト  │ │
│  │  - 選択変数のシグモイド曲線  ││    プロット (Forest)   │ │
│  │  - 上下にジッターした実測点  ││  - Odds Ratio + 95% CI │ │
│  │  - 矩形ブラシ / 点クリック   ││  - 有意変数の視覚化    │ │
│  └──────────────────────────────┘└────────────────────────┘ │
│  ┌──────────────────────────────┐┌────────────────────────┐ │
│  │ 3. 混同行列 & ROC / PR 曲線  ││ 4. 回帰係数サマリー表  │ │
│  │  - 閾値スライダー (Cutoff)   ││  - 係数 β, SE, z, p値  │ │
│  │  - FP/FN サンプルの即時選択  ││  - AIC, BIC, 擬似R²    │ │
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
│  [POST /api/models/logistic]                                │
│    - statsmodels.api.Logit / MNLogit (厳密な検定統計量・p値)│
│    - scikit-learn.linear_model.LogisticRegression (高速予測)│
│    - 各データ行の予測確率 P(y=1|x) および対数オッズの算出    │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 主要機能要件一覧
1. **モデル設定**:
   - **目的変数（Target）**: 2値カテゴリカル変数（0/1 または 2クラス名義変数）。多値（Multinomial）にも自動拡張。
   - **説明変数（Features）**: グローバル選択された変数（Active Variables）から自動候補提示。数値およびワンホット展開カテゴリ変数。
   - **切片項（Intercept）**: 有り（デフォルト）/ 無し。
   - **正則化（Regularization）**: None（最尤推定 / Unpenalized）、L2（Ridge）、L1（Lasso）。
     - > **正則化適用時の特徴量標準化**: L1/L2 正則化を適用する場合、バックエンドでは特徴量を内部的に標準化（平均0、標準偏差1）した上でモデルを推定する。レスポンスで返却する係数 $\hat{\beta}_j$、標準誤差、オッズ比は **元のスケールに逆変換した値** とし、ユーザーが直感的に解釈できるようにする。
2. **可視化ビュー**:
   - **S字曲線プロット (Sigmoid Probability Curve)**:
     - ユーザーが着目した主要説明変数1軸を横軸、予測確率 $P(Y=1)$ を縦軸にプロット。
     - 実測データを $Y=0$（下部）と $Y=1$（上部）に配置し、縦方向に微小なジッターを付与して重なりを解消。
     - 各データ点はグループ色・選択状態（赤ハイライト）で描画。ドラッグによる矩形範囲ブラシ、ホバーツールチップを完備。
   - **オッズ比フォレストプロット (Odds Ratio Forest Plot)**:
     - 各説明変数のオッズ比 $\exp(\beta_j)$ と95%信頼区間を対数スケール上にエラーバー表示。基準線（$\text{OR}=1.0$）を明示し、正の効果・負の効果・有意性を一目で把握。
   - **混同行列 (Confusion Matrix) & 閾値調整**:
     - 確率カットオフ閾値（デフォルト 0.5）をスライダーで変更可能。
     - 混同行列の各セル（True Positive, False Positive, True Negative, False Negative）をクリックすると、該当サンプル群が一発でブラッシング選択される。
     - > **ROC / PR 曲線の算出方針**: レスポンスの `samples[].predictedProb` と `samples[].actual` をフロントエンド側で利用し、閾値を 0.0〜1.0 で走査することで ROC 曲線（TPR vs FPR）および PR 曲線（Precision vs Recall）をクライアントサイドで動的に描画する。AUC-ROC / AUC-PR もフロントエンドで算出する。これにより、閾値スライダーとの連動をサーバーラウンドトリップなしで実現する。
   - **統計サマリー表**:
     - 変数名、係数 $\beta$、標準誤差 $\text{SE}(\beta)$、z値（Wald統計量）、p値（$P > |z|$）、オッズ比、95%信頼区間（Lower/Upper）。
     - モデル適合度指標: 対数尤度（Log-Likelihood）、AIC、BIC、McFaddenの擬似決定係数（Pseudo $R^2$）。
3. **対話的連動 (Linked Interaction)**:
   - 誤判別サンプル（特に False Positive や False Negative）をブラッシング → PCP上でそのサンプル群がどの軸で特異な値を取っているかを追跡。
   - 右クリックコンテキストメニュー（Focus Selected / Delete Selected / Reset to Base Data）を全ビューで完全サポート。

---

## 3. 数理仕様・アルゴリズム

### 3.1 2値ロジスティック回帰モデル
目的変数 $y_i \in \{0, 1\}$、説明変数ベクトル $\mathbf{x}_i = (1, x_{i1}, x_{i2}, \dots, x_{ip})^T$ に対し、成功確率 $p_i = P(y_i = 1 \mid \mathbf{x}_i)$ をロジット関数でモデル化する：

$$\text{logit}(p_i) = \ln\left(\frac{p_i}{1 - p_i}\right) = \mathbf{x}_i^T \boldsymbol{\beta} = \beta_0 + \sum_{j=1}^p \beta_j x_{ij}$$

予測確率はシグモイド関数 $\sigma(z) = \frac{1}{1 + e^{-z}}$ により求められる：

$$p_i = \sigma(\mathbf{x}_i^T \boldsymbol{\beta}) = \frac{1}{1 + \exp\left(-(\beta_0 + \sum_{j=1}^p \beta_j x_{ij})\right)}$$

### 3.2 パラメータ推定と統計的推測
対数尤度関数 $\ln L(\boldsymbol{\beta})$ は次式で表され、ニュートン・ラフソン法（IRLS: Iteratively Reweighted Least Squares）により最尤推定量 $\hat{\boldsymbol{\beta}}$ を求める：

$$\ln L(\boldsymbol{\beta}) = \sum_{i=1}^N \left[ y_i \ln p_i + (1 - y_i) \ln (1 - p_i) \right]$$

推定された分散共分散行列 $\widehat{\text{Cov}}(\hat{\boldsymbol{\beta}}) = \mathbf{I}(\hat{\boldsymbol{\beta}})^{-1} = (\mathbf{X}^T \mathbf{W} \mathbf{X})^{-1}$（ここで $\mathbf{W} = \text{diag}(p_i (1 - p_i))$）より、各係数の標準誤差 $\text{SE}(\hat{\beta}_j)$ を算出し、Wald検定統計量 $z_j$ およびオッズ比の95%信頼区間を導出する：

$$z_j = \frac{\hat{\beta}_j}{\text{SE}(\hat{\beta}_j)}, \quad p\text{-value} = 2(1 - \Phi(|z_j|))$$

$$\text{OR}_j = \exp(\hat{\beta}_j), \quad 95\% \text{ CI} = \left[ \exp\left(\hat{\beta}_j - 1.96 \cdot \text{SE}(\hat{\beta}_j)\right), \exp\left(\hat{\beta}_j + 1.96 \cdot \text{SE}(\hat{\beta}_j)\right) \right]$$

### 3.3 単一説明変数に対する条件付き確率曲線の可視化
多変量モデルにおいて、着目変数 $X_k$ に対する確率曲線を描画する際、他の説明変数 $X_{m} (m \neq k)$ は有効データ行の中央値（または平均値） $\bar{x}_m$ に固定する：

$$z(x_k) = \hat{\beta}_0 + \hat{\beta}_k x_k + \sum_{m \neq k} \hat{\beta}_m \bar{x}_m$$

$$P(Y=1 \mid x_k) = \frac{1}{1 + \exp(-z(x_k))}$$

> **カテゴリ変数（ワンホット列）の代表値固定**: カテゴリ変数をワンホット符号化した列に対しては、中央値や平均値ではなく **最頻値（mode）** または **参照カテゴリの値（= 0）** に固定する。これにより、非現実的な中間値（例: 0.35）による条件付き確率の歪みを回避する。

### 3.4 欠損値（NaN）の処理方針

説明変数または目的変数に欠損値（NaN / null）を含む行は **リストワイズ削除（Listwise Deletion）** により解析対象から除外する。除外された行は以下のように処理する:

1. `LogisticResponse.samples` には除外行を含めない（`samples` の件数は有効行数と一致）
2. 除外された行数をレスポンスに `excludedRowCount: number` として返却する
3. `activeRowIds` が指定されている場合、その中から欠損行を除外した上でモデルを推定する
4. フロントエンドでは除外行数を通知バナーで表示する（例: 「3行が欠損値により除外されました」）

---

## 4. UI/UX 詳細設計

### 4.1 画面レイアウトワイヤーフレーム
```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Logistic Regression]                                  [Focus / 拡大表示]     │
├──────────────────────────────────────────────────────────────────────────────┤
│ 目的変数 Y: [ Survived (0/1)      ▼]  説明変数 X: [ 4変数選択中 (Age, Fare...) ▼]│
│ 正則化: (•) None  ( ) L2 (Ridge)      閾値 Cutoff: [===|========] 0.50       │
│ [ モデル再学習 (Run Model) ]         [ 誤分類サンプルを一括選択 (Select FP+FN) ]│
├──────────────────────────────────────┬───────────────────────────────────────┤
│ ▼ 予測確率・S字シグモイド曲線 (Age)  │ ▼ オッズ比フォレストプロット (Odds Ratio)│
│  着目軸: [ Age                 ▼]    │  変数名       OR (95% CI)             │
│  P(Y=1)                              │  Sex_male    0.08 [0.05, 0.13]  |--*--|│
│  1.0 ┌───────────────────────┐       │  Pclass_3    0.28 [0.18, 0.44]  |--*--|│
│      │               ••••••••│ Y=1   │  Age         0.96 [0.94, 0.98]    |*|  │
│  0.5 │          /‾‾‾‾        │       │  Fare        1.01 [1.00, 1.02]     |*| │
│      │        /              │       │                                       │
│  0.0 │••••••/                │ Y=0   │              0.01   0.1   1.0   10.0   │
│      └───────────────────────┘       │               <--抑制--|--促進-->      │
│       0    20    40    60    80 Age  │                                       │
├──────────────────────────────────────┴───────────────────────────────────────┤
│ ▼ モデル診断・混同行列 (Confusion Matrix) & 係数詳細サマリー                 │
│  ┌─────────────────────────┐  AIC: 784.2   BIC: 808.1   Pseudo R²: 0.342    │
│  │ 混同行列 (N=891)        │                                                 │
│  │                予測:0 予測:1│  変数      係数β    SE(β)     z値     p値      │
│  │ 実測: 0 (Dead) [ 478 ][ 71 ]│  Intercept  3.742   0.451    8.30   <0.001 ***│
│  │ 実測: 1 (Alive)[  92 ][ 250]│  Sex_male  -2.524   0.211  -11.96   <0.001 ***│
│  │ ※セルクリックでサンプル選択 │  Age       -0.039   0.008   -4.88   <0.001 ***│
│  └─────────────────────────┘  Pclass_3  -1.266   0.231   -5.48   <0.001 ***│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 インタラクション仕様
1. **S字曲線上の矩形ブラシ**:
   - Canvas/SVG上の任意の領域をドラッグすると、バウンディングボックス内に含まれるデータ点が選択される。
   - `Shift` キーで追加（Add）、`Alt` キーで除外（Subtract）、通常ドラッグで置換（Replace）。
2. **混同行列セルの直接選択**:
   - `[ 71 ]`（False Positive: 死亡なのに生存と誤予測）をクリックすると、その71行のIDが一括で `selectedRowIds` に設定される。
   - 即座に上部や他タブ（PCP、Relationships）へ切り替えることで、「モデルがなぜこれらを生存と誤認したのか」を高次元空間で特定可能。
3. **着目軸の即時切り替え**:
   - 「着目軸」ドロップダウンで `Fare` を選ぶと、横軸が `Fare` のスケールに切り替わり、S字曲線とデータ点が滑らかにアニメーション遷移して再描画される。
4. **閾値スライダーのリアルタイム更新**:
   - > **閾値スライダーのリアルタイム更新**: 閾値（Cutoff）スライダーの操作時は、サーバーへの再リクエストを行わず、初回レスポンスで取得済みの `samples[].predictedProb` を用いてフロントエンド側で混同行列（TP/FP/TN/FN）、Accuracy、Precision、Recall、F1-Score をリアルタイムに再計算・再描画する。

---

## 5. API・データ型定義

### 5.1 リクエスト・レスポンス型 (TypeScript)
```typescript
export interface LogisticRequest {
  datasetId: string
  targetColumn: string
  featureColumns: string[]
  activeRowIds?: string[]
  intercept?: boolean
  regularization?: 'none' | 'l2' | 'l1'
  cValue?: number
  cutoff?: number
}

export interface CoefficientItem {
  name: string
  coefficient: number
  stdError: number
  zValue: number
  pValue: number
  oddsRatio: number
  ciLower: number
  ciUpper: number
}

export interface SigmoidCurvePoint {
  x: number
  probability: number
}

export interface LogisticSamplePoint {
  rowId: string
  // フロントエンド側で rowId をキーにデータセットの元データから各変数の実測値を参照する
  actual: number
  predictedProb: number
  predictedClass: number
  residual: number
  isMisclassified: boolean
}

export interface ConfusionMatrix {
  tn: number
  fp: number
  fn: number
  tp: number
  tnRowIds: string[]
  fpRowIds: string[]
  fnRowIds: string[]
  tpRowIds: string[]
  accuracy: number
  precision: number
  recall: number
  f1Score: number
}

export interface LogisticResponse {
  target: string
  classes: (string | number)[]
  features: string[]
  excludedRowCount: number
  coefficients: CoefficientItem[]
  fitMetrics: {
    logLikelihood: number
    nullLogLikelihood: number
    aic: number
    bic: number
    pseudoR2: number
    converged: boolean
  }
  confusionMatrix: ConfusionMatrix
  samples: LogisticSamplePoint[]
  curves: Record<string, SigmoidCurvePoint[]>
  evidenceClass: 'JAR-INITIAL' | 'MODERN-EXTENSION'
}
```

### 5.2 FastAPI エンドポイント (Python)
```python
# backend/app/api/logistic.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any

router = APIRouter(prefix="/models/logistic", tags=["models"])

class LogisticRequestSchema(BaseModel):
    datasetId: str
    targetColumn: str
    featureColumns: List[str]
    activeRowIds: Optional[List[str]] = None
    intercept: bool = True
    regularization: str = "none"
    cValue: Optional[float] = 1.0
    cutoff: float = Field(0.5, ge=0.0, le=1.0)

@router.post("", response_model=Dict[str, Any])
async def fit_logistic_regression(req: LogisticRequestSchema):
    """
    Fits binary/multinomial logistic regression, returning coefficients, 
    Wald statistics, odds ratios with 95% CIs, prediction probabilities, 
    confusion matrix, and sigmoid curves for plotting.
    """
    pass
```

---

## 6. テスト・検証計画

### 6.1 自動テスト
1. **数値精度検証 (Backend Property Test)**:
   - Rの `glm(family=binomial)` および Python `statsmodels` の標準出力と、係数・標準誤差・p値・オッズ比が相対誤差 $10^{-4}$ 以内で一致することを検証。
2. **完全分離・多重共線性ハンドリング**:
   - 変数間に完全分離（Perfect Separation）が存在する場合に例外でクラッシュせず、L2ペナルティへのフォールバックまたは警告メッセージを返すこと。
3. **連動ブラッシング検証 (Frontend / Vitest & E2E)**:
   - 混同行列の `FP` セルをクリックした際、Redux Store の `selectedRowIds` に期待されるサンプルID配列がセットされることを確認。
   - S字曲線上の矩形ブラシにより、指定領域内の行IDが選択されることを確認。
