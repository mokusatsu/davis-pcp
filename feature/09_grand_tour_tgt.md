# 実装計画書: Grand Tour / Tracking Grand Tour (TGT)

文書ID: DAVIS-FEAT-009  
版: 1.0.0  
作成日: 2026-09-04  
優先度: 4  
対象コンポーネント: Backend (Tour Projection API / Wasm Helper), Frontend (TGT Canvas Engine, Animation Loop & Linked Brushing)  

---

## 1. 概要・目的

### 1.1 背景と目的
元のDAVIS（Huh et al., 2001, 2002, 2005）において、PCPと並ぶ動的グラフィックス（Dynamic Graphics）の象徴的機能が **Grand Tour / Tracking Grand Tour (TGT)** である。

Grand Tour は、3次元以上の高次元データ空間に存在する観測点群を、時間の経過とともに滑らかに回転する2次元直交射影平面上に連続投影するアニメーション可視化手法である（Asimov 1985, Buja et al. 1986, Wegman 1991, Huh 2001）。静的な散布図行列では見落とされがちな高次元クラスタの分離、非線形な多様体構造、特異な外れ値を、人間の動体視力によって直感的に発見できる。

さらに Huh らは、通常の Grand Tour に加えて **Tracking Grand Tour (TGT)** を考案・実装した。TGT では、各データ点の直近数フレームの運動軌跡（トレイル/残像線）を描画することで、高次元空間でのサンプルの移動方向やクラスタの回転挙動をより明瞭に知覚できるようにしている。

本機能では、ブラウザの `requestAnimationFrame` および High-DPI Canvas / WebAssembly を活用し、60fpsで滑らかに回転する TGT エンジンを復元し、DAVIS の中核である連動ブラッシング（Linked Brushing / Focus / Delete / Undo）と統合する。

### 1.2 元のDAVISにおける原典根拠
- **2001年原論文 (PAPER-2001)**:
  - 『Algorithms for Grand Tour and Parallel Coordinates』: 測地パス（Geodesic Path）補間アルゴリズム、直交基底の連続回転、変数の寄与円（Projection Circle）の定式化。
  - 『The Structure of DAVIS: Java beans approach』: `TgtBean` と他Beanとのリアルタイム連動。
- **2002年原論文 (PAPER-2002)**:
  - Section 4 / Section 9: `Touring start/stop, Tracking toggle, brushing is available only when tour is stopped`
- **初版JARバイトコード**:
  - `davis.plot.tgt.TGT`
  - `davis.plot.tgt.TgtBean`
  - 主要フィールド・メソッド: `Tracking`, `newTrack`, `running`, `speedBar`, `rot_mat`, `delta`, `axis`, `frozen`, `repeatno`, `drawLines()`
- **2005年発表資料 (SLIDES-2005)**:
  - Slide 13: `Multivariate plots: Touring`

---

## 2. 現代フルスタックシステムにおける設計仕様

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend UI                            │
│  [新ナビゲーションタブ: "Touring" (TGT)]                    │
│  ┌─────────────────────────────────┐  ┌───────────────────┐ │
│  │ 1. TGT メインビュー (Canvas 60fps│  │ 2. 軸寄与円       │ │
│  │  - 投影散布点 (高DPI Canvas)    │  │   (Projection      │ │
│  │  - Tracking 軌跡線 (残像トレイル│  │    Circle)         │ │
│  │  - 一時停止時の矩形ブラシ       │  │  - 各変数の基底    │ │
│  │  - 選択点ハイライト / グループ色│  │    ベクトル矢印    │ │
│  └─────────────────────────────────┘  └───────────────────┘ │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 3. コントロールバー                                    │ │
│  │  - [Play / Pause] [Step] [Reset View]                  │ │
│  │  - Speed スライダー (回転角速度 Δθ)                    │ │
│  │  - [x] Tracking (軌跡表示) / トレイル長スライダー      │ │
│  │  - 変数選択チェックボックス (3軸以上)                  │ │
│  └────────────────────────────────────────────────────────┘ │
└──────────────────────────────┬──────────────────────────────┘
                               │ 双方向同期 (Redux / Zustand)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Shared Selection State                      │
│    - 一時停止中にブラシした行がPCP/Table/Distributionへ同期 │
│    - PCPで選択した行がTouring画面でも即時ハイライト         │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 詳細アルゴリズム仕様

### 3.1 測地パス補間による回転平面の連続更新 (Huh 2001)

$p$ 次元空間のデータを標準化した行列を $Z \in \mathbb{R}^{N \times p}$ とする。

1. **射影基底 (2D Orthonormal Basis)**:
   時刻 $t$ における投影面は、正規直交する2つのベクトル $\alpha(t), \beta(t) \in \mathbb{R}^p$（$\alpha^T \alpha = 1, \beta^T \beta = 1, \alpha^T \beta = 0$）で定義される。
   データ点 $i$ のスクリーン座標 $(x_i(t), y_i(t))$ は次式で算出される：
   $$x_i(t) = Z_i \alpha(t), \quad y_i(t) = Z_i \beta(t)$$
2. **ランダム目標平面の生成と測地補間**:
   - 現在の基底面 $\Pi_{\text{curr}} = \text{span}\{\alpha_0, \beta_0\}$ に対し、ランダムな新しい正規直交基底 $\Pi_{\text{target}} = \text{span}\{\alpha_1, \beta_1\}$ を生成（QR分解）。
   - 主回転角（Principal Angles）$\theta_1, \theta_2$ を特異値分解（SVD）により算出。
   - ステップサイズ $\Delta \theta$（速度スライダー依存）ごとに、測地線（Geodesic Path）に沿って現在基底を目標基底へ滑らかに回転補間：
     $$\alpha(t) = \cos(\theta_1 t) u_1 + \sin(\theta_1 t) w_1$$
     $$\beta(t) = \cos(\theta_2 t) u_2 + \sin(\theta_2 t) w_2$$
   - 目標基底に到達したら、新たな目標基底を自動選定し、途切れなく連続回転を維持する。

### 3.2 Tracking（軌跡描画）アルゴリズム
- 各データ点 $i$ ごとに、直近 $M$ フレーム（既定: 8〜16フレーム）の投影座標履歴キュー $H_i = \{(x_i(t-k), y_i(t-k))\}_{k=0}^M$ をリングバッファで保持。
- 描画時、時間減衰する透明度（Alpha: $1.0 \to 0.0$）を持つ折れ線としてトレイルを描画。
- これにより、点が単に飛び跳ねるのではなく、どの方向へ向かって回転しているかが軌跡として視覚化される。

### 3.3 軸寄与円 (Projection Circle / Star Coordinates)
- 各元変数 $j \in \{1, \dots, p\}$ の単位ベクトル $e_j$ の現在平面への射影 $(\alpha_j(t), \beta_j(t))$ を、半径1の単位円内に矢印としてプロット。
- ユーザーは「現在プロットの横軸・縦軸がどの変数の合成で構成されているか」をリアルタイムに直感把握できる。

### 3.4 原典準拠のブラッシング仕様 (2002原論文 / 初版JAR)
- **回転中**: データ探索・クラスタ鑑賞モード。
- **一時停止 (Freeze / Pause)**:
  - マウス操作による矩形選択が可能になる。
  - 選択された点はグループ色（赤色等）でハイライト。
  - 右クリックで `Focus Selected` / `Delete Selected` / `Undo` を実行可能。
  - 回転を再開しても、選択された点の色分けは保持され、グループが高次元空間でどのように振る舞うかを観察可能。

---

## 4. API & データフロー設計

### 4.1 データ転送
Grand Tour は 60fps の高頻度描画を要求するため、回転計算を毎フレームバックエンドへ問い合わせる方式は採用せず、**クライアントサイド（TypeScript / Canvas 2D または WebGL）で完全ローカル実行**する。

1. **データ取得**:
   - 既存の `GET /api/datasets/{id}/view`（Arrow IPC / Float32Array）を利用し、標準化済み数値配列を一括取得。
2. **基底生成・回転計算**:
   - クライアントの `TgtEngine`（または軽量 Wasm モジュール）が `requestAnimationFrame` 内で $\alpha(t), \beta(t)$ の積和演算を実行（$N=10,000$ 点でも 1ms 未満で完了）。

---

## 5. UI/UX・GUI詳細設計

### 5.1 画面配置とレイアウト
本機能は、ヘッダーナビゲーションに新規メインタブ `[Touring]` (`/touring`) を追加して提供する。
画面全体を没入感のあるキャンバスとし、操作系は下部にフローティング配置（Floating Dock）する。

```
+---------------------------------------------------------------------------------------------------------+
| [PCP] [Table] [Distribution] [Relationships] [Clusters] [Models] [PCA] [(o) Touring]       | [Sidebar] |
+---------------------------------------------------------------------------------------------------------+
| Variables in Tour: [ (x) SepalLength  (x) SepalWidth  (x) PetalLength  (x) PetalWidth ]   [ Select All ] |
+---------------------------------------------------------------------------------------------------------+
|                                                                     +---------------------------------+ |
|                                                                     | Projection Circle (Axes Basis)  | |
|                           *                                         |                PetalLength      | |
|                       * * *                                         |                    ^            | |
|                     * * * * *                                       |                    |            | |
|                   * * * * * * *                                     |         SepalW. <--+--> PetalW. | |
|                    \ \ \ \ \ \ \  <- Tracking Trails                |                    |            | |
|                     \ \ \ \ \ \ \    (Fading residual lines)        |                    v            | |
|                                                                     |               SepalLength       | |
|                                       * * *                         +---------------------------------+ |
|                                   * * * * * *                                                           |
|                                 * * * * * * * *   <- Brush Box (Active when Paused)                     |
|                                   * * * * * [     ]                                                     |
|                                       * * *                                                             |
|                                                                                                         |
+---------------------------------------------------------------------------------------------------------+
|  Floating Control Dock (Bottom Center):                                                                 |
|  [ ❚❚ Pause (Space) ]  [ >| Step ]  [ Reset View ]  |  Speed: [--o-------] 1.0x  |  [x] Tracking        |
|  Trail Length: [------o----] 12 frames  |  Point Size: [ 4px ]  |  Status: [ Touring: Geodesic Path ]   |
+---------------------------------------------------------------------------------------------------------+
```

### 5.2 UIコンポーネント構成 (`frontend/src/features/tgt/`)
1. **メインアニメーション領域 (`TgtCanvas.tsx`)**:
   - WebGL または High-DPI Canvas 2D による 60fps レンダラー。
   - **Tracking Trail レイヤー**: 直近 $M$ フレームの座標履歴を結ぶフェードアウト折れ線。クラスタの回転方向やねじれ構造が残像として立体的に浮かび上がる。
   - **点描画レイヤー**: 現在フレームの投影点 $(x_i(t), y_i(t))$。クラスタ色または選択色（赤色）で描画。
2. **軸寄与円 HUD (`ProjectionCircle.tsx`)**:
   - 画面右上に半透明フローティング表示される単位円（半径 70px の円形オーバーレイ）。
   - 円の中心から各変数の射影基底ベクトル矢印がリアルタイムに伸縮・回転。
   - 「いま投影面がどの変数の組み合わせで構成されているか」を直感的に把握可能。
3. **フローティング・コントロールバー (`TgtControlDock.tsx`)**:
   - 画面下部中央に常駐する操作ドック。
   - `Play / Pause`: アニメーションの再生と一時停止。
   - `Speed`: 測地回転ステップ角 $\Delta \theta$ のスライダー調整。
   - `Tracking`: 軌跡描画のON/OFFおよび残像フレーム数（4〜24フレーム）のスライダー。
   - `Reset View`: 最初の平面座標へリセット。

### 5.3 インタラクション & 連動仕様
1. **再生と停止のデュアルモード**:
   - **Touring モード（再生中）**:
     - 高次元データの立体的な形状、球状・帯状クラスタの分離、外れ値の飛び出しを視覚認知で探索。
   - **Frozen モード（一時停止中 / Spaceキー）**:
     - キャンバスが即座に「ブラッシング可能」状態に移行。
     - マウスドラッグで分離したクラスタを矩形選択すると、即座に赤色でハイライト。
     - 右クリックで DAVIS ネイティブメニュー（`Focus Selected`, `Delete Selected`, `Identify`, `Undo`）が起動。
2. **連動ブラッシングの双方向性**:
   - 一時停止中にブラシで選択したデータ群は、再生を再開しても赤色のまま高次元空間を回転し続けるため、「このクラスタが高次元でどのようにまとまっているか」を動的に確認できる。
   - PCP 画面へ移動すると、Touring で見つけたクラスタがそのまま PCP のポリライン群として赤く浮き上がる。逆に PCP で選んだ行も Touring 画面で即座に着色される。
3. **キーボード操作**:
   - `Space`: 再生 / 一時停止の即時切り替え。
   - `.` (ピリオド): 1ステップ進める（Step forward）。
   - `R`: 視点を初期平面へ戻す。
   - `Esc`: 選択解除。

---

## 6. テスト・検証計画

### 6.1 アルゴリズム単体テスト (`frontend/src/features/tgt/__tests__/geodesic.test.ts`)
- 生成された射影基底が常に正規直交性（$\|\alpha\|=1, \|\beta\|=1, \alpha \cdot \beta = 0$）を維持すること。
- 目標基底への測地補間が不連続なジャンプを起こさず滑らかに遷移すること。

### 6.2 性能ベンチマーク
- サンプル数 $N = 5,000$、変数数 $p = 10$ において、Tracking ON 状態で 60fps（フレーム時間 < 16.6ms）を安定維持すること。

### 6.3 E2E・連動テスト (`e2e/test_tgt_linking.py`)
- TGT画面で一時停止し、矩形ブラシで特定クラスタを選択。
- PCP画面へ遷移した際、同一サンプルが正確に選択・ハイライトされていること。

---

## 7. 実装ステップ

| Step | 作業内容 | 主要変更ファイル |
|---|---|---|
| 1 | クライアントサイド測地回転エンジンの実装 | `frontend/src/features/tgt/geodesicEngine.ts` |
| 2 | Canvas 2D アニメーション描画 & Tracking トレイル実装 | `frontend/src/features/tgt/TgtCanvas.tsx` |
| 3 | 軸寄与円 (Projection Circle) の実装 | `frontend/src/features/tgt/ProjectionCircle.tsx` |
| 4 | コントロールバー (再生/停止/速度/トレイル長) 実装 | `frontend/src/features/tgt/TgtControlPanel.tsx` |
| 5 | 一時停止時の矩形ブラシ & 共有ストア連動 | `frontend/src/features/tgt/TgtCanvas.tsx`, `store.ts` |
| 6 | AppShell ナビゲーションへの追加 | `frontend/src/app/AppShell.tsx`, `features/tgt/TgtPage.tsx` |
| 7 | 性能ベンチマーク & E2E テスト作成 | `tests/unit/test_tgt.py`, `e2e/test_tgt_linking.py` |
