# 実装計画書: 共通変数選択・観測行選択統合マネージャ (Global Variable & Observation Selection Suite)

文書ID: DAVIS-FEAT-015  
版: 1.0.0  
作成日: 2026-09-05  
優先度: 1 (アーキテクチャ刷新・最優先)  
対象コンポーネント: Frontend AppShell (Global Header Control Bar, Variable Selection Modal, Observation & Sampling Modal), Redux Global Store (globalVariables, globalObservations), All Feature Views Refactoring (PCP, Distribution, Relationships, Models, Statistics, Touring, Clusters, Mosaic)  

---

## 1. 概要・目的

### 1.1 背景と課題
元のDAVIS（Huh & Song, 2002; 初版JARバイトコード）において、システム全体のデータ操作基盤として備わっていた **Variable Selection（グローバル変数選択）** および **Observation Selection / Simple Random Sampling（観測行範囲指定・無作為抽出）** を、現代Webフルスタックの共通UIアーキテクチャとして再構築・統合する。

#### 現行システムにおける課題（UIの散在と重複）
現在の `DAVIS-PCP Fullstack v2.0.0` では、以下のように各画面・各コンポーネント内に個別の変数選択ドロップダウンや行選択コントロールが乱立している：
- **PCP**: 軸ごとの表示チェックボックスや軸並べ替えコントロールが画面上部に独自配置。
- **Relationships (ペアプロット)**: 数値列のみを内部で自動抽出し、画面固有の列選択ロジックを持つ。
- **Distribution / QQ-Plot**: 画面上部に変数選択セレクトボックスが個別配置。
- **Statistics / Covariance**: 画面ごとに集計対象の変数を個別指定。
- **Touring (TGT)**: 画面下部コントロールバーに3軸以上の変数チェックボックス群が重複配置。
- **Models (決定木/RF/ロジスティック/判別)**: 目的変数や説明変数の選択ボックスが各モデル画面内に散在。
- **行の選択・絞り込み**: 右サイドバーや右クリックメニューに Focus / Delete / Undo があるが、「行番号の範囲指定（例: 1〜100行目）」や「無作為サンプリング（例: 20%非復元抽出）」を行う統一的インターフェースが存在しない。

この結果、ユーザーは「ある特定の変数セット（例: 上位重要4変数）に着目してデータセットを絞り込んだ上で、PCP $\to$ 散布図行列 $\to$ クラスタリング $\to$ 統計量 を横断的に確認したい」場合でも、画面を切り替えるたびに変数を再選択する必要があり、探索の思考フローが分断されていた。

### 1.2 解決方針と目的
本機能では、**画面各所に散在していた変数選択プルダウンおよび行選択UIをアプリ最上部（ヘッダー直下の共通コントロールバー）へ一元移設・集約** する。

1. **Global Variable Selector（共通変数マネージャ）**:
   - アプリ全体で「現在分析対象とするアクティブ変数セット（`activeVariableIds`）」を一元管理。
   - 上部ヘッダーでの素早いタグ・ドロップダウン操作と、原典DAVIS準拠の「Variable Selection Modal（2カラムの追加/除外リストボックス、型別フィルタ、重要度順一括適用）」を提供。
2. **Global Observation Selector（共通観測行マネージャ & サンプリング）**:
   - 行スコープのクイック切替（All: 全行 / Active: 有効行 / Selected: 選択中 / Sampled: サンプル抽出）。
   - 原典DAVIS準拠の「Observation Selection Modal（行範囲 `from-to` 指定、復元/非復元無作為サンプリング、条件式フィルタ）」を提供。
3. **全プロット・画面の共通コンテキスト統合**:
   - PCP、Relationships、Distribution、Touring、Clusters、Statistics 等は、原則としてこの共通変数・共通行セットを自動参照する形に整理・スリム化する。各画面は「その画面固有の描画パラメータ（軸順アルゴリズムやプロット形式）」に集中できるようになる。

### 1.3 元のDAVISにおける原典根拠
- **2002年原論文 (PAPER-2002)**:
  - Section 4 / Figure 7: `Variable Selection dialog`, `Variable Manager`, `Observation subset`, `simple random sampling`
  - 全ての可視化ツール・統計ツールが、Variable Manager で選択された変数を共通基盤として動作する思想。
- **初版JARバイトコード (JAR-INITIAL)**:
  - `davis.main.VariableSelection`: `varList`, `selectList`, `selectButton`, `deselectButton`, `addVariableList()`（利用可能変数と選択中変数の2ペイン管理）
  - `davis.main.ObservationSelection`: `rangePanel` (`fromField`, `toField`), `samplingPanel` (`sizeField`, `seedField`), `buttonGroup1`
  - `davis.core.math.Sampling`: `with`（復元抽出: with replacement）, `without`（非復元抽出: without replacement）

---

## 2. UI/UX 詳細設計

### 2.1 全体画面レイアウト構成（上部共通バーの配置）

```
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ [DAVIS-PCP]  データセット: [ Iris (built-in) ▼] [Import] [Save]                                  │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ★ 共通グローバル・コントロールバー (Global Header Control Bar)                                   │
│ ┌────────────────────────────────────────────────────────┐ ┌───────────────────────────────────┐│
│ │ [V] Variables: [ 4 / 5列 選択中 (Sepal.L, Petal.L...) ▼]│ │ [O] Rows: (•)Active(150) ( )Sel(0)││
│ │     [クイック: 全選択 | 数値のみ | カテゴリのみ]        │ │     [ 観測行マネージャ (Filter) ]  ││
│ │     [ 変数マネージャを開く (Variable Manager) ]         │ │     [ サンプリング (Sampling) ]    ││
│ └────────────────────────────────────────────────────────┘ └───────────────────────────────────┘│
│  選択行: 0 / 150  [解除] [Focus] [Delete] [Undo] [Redo] [全復帰(Reset)]                          │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ナビゲーションタブ: [PCP] [Table] [Distribution] [Relationships] [Clusters] [Models] [Touring]... │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│ （アクティブな各ビュー: 上記の Variables と Rows を自動継承して描画）                           │
│                                                                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Global Variable Selector (上部変数マネージャ) の詳細仕様

#### A. ヘッダー上のクイック操作 (Dropdown & Badges)
- ヘッダーに `Variables: [ 4 / 5列 ▼ ]` バッジボタンを常時配置。
- ドロップダウン展開時：
  - 各変数名のチェックボックスリスト（検索フィルタ付き）。
  - クイックプリセットボタン：
    - `[すべて選択]`: 全列を有効化。
    - `[数値列のみ]`: 連続値・数値型のみを有効化（PCPや散布図行列で即座に活用）。
    - `[カテゴリ列のみ]`: 名義・カテゴリカル列のみを有効化（クロス集計やモザイクプロットで活用）。
    - `[重要度上位K列]`: `feature/14` のランキング上位を直接反映。
  - `[ 詳細変数マネージャを開く... ]` リンク。

#### B. Variable Selection Dialog (原典DAVIS 2カラムモーダル)
原典 `davis.main.VariableSelection` の思想を現代的に再構築した本格ダイアログ：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 変数マネージャ (Variable Selection Manager)                                  │
├──────────────────────────────────────────────────────────────────────────────┤
│ 検索: [___________]  型フィルタ: [ すべて ▼]                                 │
│                                                                              │
│ ┌─ 利用可能変数 (Available) ─┐        ┌─ 選択・表示変数 (Selected / Active) ┐│
│ │ [x] ID (__rowId__)         │        │  1. Sepal.Length  (numeric)     ::: ││
│ │ [ ] Description            │ ──►    │  2. Sepal.Width   (numeric)     ::: ││
│ │                            │ ◄──    │  3. Petal.Length  (numeric)     ::: ││
│ │                            │        │  4. Petal.Width   (numeric)     ::: ││
│ │                            │        │  5. Species       (nominal)     ::: ││
│ └────────────────────────────┘        └─────────────────────────────────────┘│
│   (未選択: 2変数)                       (選択中: 5変数 / ドラッグで順序変更) │
├──────────────────────────────────────────────────────────────────────────────┤
│ [ 特徴量ランキングから上位を選択 (Top-K) ]           [ キャンセル ] [ 適用 (Apply) ] │
└──────────────────────────────────────────────────────────────────────────────┘
```
- **左カラム (Available Variables)**: 現在非アクティブな変数一覧。
- **右カラム (Selected / Active Variables)**: 現在アクティブな変数一覧。右側のハンドル（`:::`）でドラッグ＆ドロップして並べ替え可能（PCPの軸順の初期配置に直接反映）。
- **移動ボタン (`-->` / `<--`)**: 選択した変数を左右に移動。ダブルクリックでも即時移動。
- **下部連携ボタン**: `[ 特徴量ランキングから上位を選択 ]` を押すと、`feature/14` の計算結果に基づき、上位 $K$ 変数が右カラムに自動配置される。

---

### 2.3 Global Observation Selector & Sampling (上部観測行マネージャ) の詳細仕様

#### A. ヘッダー上のクイックスコープ切り替え
- ヘッダーにスコープラジオボタンを配置：
  - `(•) Active (N=150)`: 現在有効なワーキング行セット（Focus/Deleteが適用された状態）。
  - `( ) Selected (M=42)`: 現在ブラッシング選択されている行セットのみに一時フォーカス。
  - `( ) Sampled (K=50)`: 無作為抽出されたサンプルサブセット。
  - `( ) All (Total=150)`: 初期ベースデータ全体。

> **スコープ切り替えの有効性制御**: 各スコープラジオボタンは、対応するデータが空の場合に `disabled` となる:
> - `Selected`: `selectedRowIds.length === 0` の場合は無効化（グレーアウト + ツールチップ「選択行なし」）
> - `Sampled`: `sampledRowIds.length === 0`（サンプリング未実行）の場合は無効化
> - `Active` / `All`: 常に有効
>
> 現在選択中のスコープのデータが空になった場合（例: 選択解除で `selectedRowIds` が空に）、自動的に `Active` スコープにフォールバックし、トースト通知を表示する。

#### B. Observation Selection & Sampling Dialog (原典DAVISモーダル)
原典 `davis.main.ObservationSelection` および `davis.core.math.Sampling` に基づくダイアログ：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 観測行選択・サンプリングマネージャ (Observation Selection & Sampling)         │
├──────────────────────────────────────────────────────────────────────────────┤
│  [ タブ1: 無作為サンプリング (Sampling) ]  [ タブ2: 行番号範囲指定 (Range) ] │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▼ 無作為サンプリング設定 (Simple Random Sampling)                            │
│   抽出方式: (•) 非復元抽出 (Without Replacement)                             │
│             ( ) 復元抽出   (With Replacement / ブートストラップ)             │
│                                                                              │
│   抽出サイズ: (•) 件数指定: [ 50 ] 行 / 全 150 行                            │
│               ( ) 比率指定: [ 30 ] %                                         │
│                                                                              │
│   乱数シード (Seed): [ 42        ] (空欄で完全ランダム、数値入力で再現性固定)│
│                                                                              │
│   適用対象: (•) 現在の有効行 (Active: 150行) から抽出                        │
│             ( ) 初期データ全体 (Base: 150行) から抽出                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ ▼ （タブ2選択時）行番号範囲指定 (Range Index Selection)                      │
│   開始行番号 (From): [ 1     ]   〜   終了行番号 (To): [ 100   ]             │
│   ※ 連続した行区間を一括して有効行（Active）または選択行（Selected）に指定   │
├──────────────────────────────────────────────────────────────────────────────┤
│ プレビュー: 抽出予定 50 行 (全体の 33.3%)                                    │
│ [ サンプリング実行 (Apply Sample) ]                              [ 閉じる ]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **非復元抽出 (Without Replacement)**:
  - 1行が最大1回のみ選ばれる標準的なサンプリング（大規模データの軽量表示や検証用）。
- **復元抽出 (With Replacement)**:
  - 同一行の重複選択を許容するブートストラップサンプリング（統計的推定の安定性診断用）。重複数に応じた重み付け表示をサポート。
- **乱数シード固定**:
  - シード値を保持・セッション保存可能とし、共同分析やレポート作成時の厳密な再現性を担保。

#### Bootstrap（With Replacement）サンプリング時の重複行処理

復元抽出（`with_replacement`）では同一行IDが複数回抽出される。重複行の管理は以下の方式とする:

1. **データ構造**: `sampledRowIds: string[]` に加え、頻度マップ `sampledRowWeights: Record<string, number>` を `SamplingConfig` に追加する。例: `{ "row_1": 3, "row_5": 1, "row_8": 2 }`
2. **React キー生成**: テーブル・SVG等のレンダリングでは合成キー `${rowId}__rep_${index}` を使用し、React の重複キー警告を回避する
3. **可視化での重み表現**:
   - **PCP（平行座標）**: 重複行は線の不透明度（alpha）を `baseAlpha * weight` で増幅する（最大 alpha = 1.0 にクランプ）
   - **散布図**: 重複行はポイントサイズを `baseRadius * sqrt(weight)` でスケーリングする
   - **データテーブル**: Weight 列を追加表示し、頻度 > 1 の行をバッジで強調する
4. **統計計算**: 集約関数（平均、分散等）では `sampledRowWeights` を重み付き計算に使用する

> **インデックス規約**: UI 上では行番号を **1-indexed（1始まり）** の **inclusive（両端含む）** で表示する（例: 「行 1 〜 100」は第1行から第100行まで）。バックエンドAPI では **0-indexed** の **半開区間 `[fromIndex, toIndex)`** として送信する。フロントエンドは送信時に `fromIndex = UI入力値 - 1`, `toIndex = UI入力値` に変換する。
>
> 例: UI で「1 〜 100」を指定 → API には `{ fromIndex: 0, toIndex: 100 }` を送信 → 物理行 index 0〜99 が選択される。
>
> Range は物理行インデックス（データロード順）に対して適用され、テーブルビューでのソート順には影響されない。

---

### 2.4 各画面（Features）の移設・スリム化方針

上部共通コントロールバーの導入に伴い、各画面内に散在していた重複UIを次のように整理・移設する：

| 画面名 | 従来の散在UI（削除・移設対象） | 移設後の画面内UI（画面固有コントロールに特化） |
|---|---|---|
| **PCP** | 画面上部の軸表示チェックボックス列、最小2軸バリデーションロジック | 共通バーの `activeVariableIds` をそのまま軸として描画。<br>画面内には「軸順アルゴリズム（NoOrder, Component, Permute, Manual）」、「方向（Horiz/Vert）」、「Jitter」のみを残す。 |
| **Relationships (散布図行列)** | 内部で全数値列を自動収集していた暗黙ロジック | 共通バーの `activeVariableIds` のうち数値型のものを散布図行列の軸として使用。<br>画面内には「全体表示 / Iris基準サイズ」および「セルクリック時のフォーカス」のみを残す。 |
| **Distribution / QQ-Plot** | 画面上部の変数選択ドロップダウン（`Select`） | 共通バーで選択中の変数リストがドロップダウンのデフォルト選択肢として連動。<br>共通バーで変数を1つ選んだ場合、即座にその変数のプロットへ切り替わる。 |
| **Touring (TGT)** | 下部コントロールバーの変数チェックボックス群（3軸以上選択） | 共通バーの `activeVariableIds` の数値列を自動採用（3軸以上）。<br>画面内には「Play/Pause」、「Speed」、「Tracking軌跡トグル」のみを残す。 |
| **Models (決定木/ロジスティック/判別)** | 画面内の説明変数チェックボックス群 | 共通バーの `activeVariableIds` から目的変数（Target）を除いたものが、説明変数（Features）としてデフォルト一括投入される。 |
| **Statistics / Covariance** | 画面内の全列対象テーブル | 共通バーの `activeVariableIds` に絞り込んだ記述統計・共分散行列をデフォルト表示。 |

#### ビュー別最低変数数制約とフォールバック表示

`activeVariableIds` が各ビューの最低要件を満たさない場合、ビューは以下の標準フォールバック表示を行う:

| ビュー | 最低要件 | フォールバック表示 |
|--------|---------|-------------------|
| **PCP** | 数値変数 ≥ 2 | 空白パネル + 「平行座標プロットには2つ以上の数値変数が必要です。上部の変数セレクタから追加してください。」 |
| **Touring (TGT)** | 数値変数 ≥ 3 | 空白パネル + 「Grand Tour には3つ以上の数値変数が必要です。上部の変数セレクタから追加してください。」 |
| **Relationships** | 数値変数 ≥ 2 | 空白パネル + 「散布図行列には2つ以上の数値変数が必要です。」 |
| **Distribution / QQ** | 変数 ≥ 1 | — （ドロップダウンが空になるため選択不可状態を表示） |
| **Statistics** | 変数 ≥ 1 | — （空テーブルを表示） |

フォールバック表示は共通コンポーネント `<EmptyStatePanel message={...} />` を使用し、変数セレクタへのリンクボタンを含める。

#### グローバル変数順序とビューローカル軸順序の関係

`GlobalVariableState.variableOrder` は**初期順序（デフォルト軸配列）**として全ビューに提供される。各ビューのローカル軸操作との関係は以下の通り:

| 操作 | スコープ | `variableOrder` への反映 |
|------|---------|------------------------|
| Global Header でのドラッグ並べ替え | グローバル | 即時反映。全ビューの初期順序が更新される |
| PCP の `Manual` 軸ドラッグ | PCP ローカル | **反映しない**。PCP 固有の `localAxisOrder` として保持 |
| PCP の `Permute` / `Component` 自動並べ替え | PCP ローカル | **反映しない**。アルゴリズム結果は PCP 内に閉じる |
| PCP の `NoOrder`（初期化） | — | `variableOrder` にリセットされる |

PCP は `localAxisOrder: string[] | null` をビューローカル状態として保持し、`null` の場合はグローバルの `variableOrder` にフォールバックする。ユーザーが明示的に軸順序をグローバルに反映したい場合は、PCP コントロールバーの **「軸順序をグローバルに保存」** ボタンで `variableOrder` を上書きする。

---

## 3. 状態管理アーキテクチャ (Redux Store)

### 3.1 状態構造設計 (`app/store.ts`)
```typescript
export interface GlobalVariableState {
  allVariables: string[]
  activeVariableIds: string[]
  variableOrder: string[]
  targetVariableId: string | null
  variableMeta: Record<string, {
    name: string
    semanticType: 'numeric' | 'nominal' | 'ordinal' | 'text'
    physicalType: string
    missingCount: number
    isTargetCandidate: boolean
  }>
}

export interface SamplingConfig {
  enabled: boolean
  method: 'without_replacement' | 'with_replacement'
  mode: 'count' | 'ratio'
  size: number
  ratio: number
  seed?: number
  sampledRowIds: string[]
  sampledRowWeights: Record<string, number>  // Bootstrap時の行別出現頻度
}

export interface GlobalObservationState {
  totalRowIds: string[]
  activeRowIds: string[]
  selectedRowIds: string[]
  scopeMode: 'active' | 'selected' | 'sampled' | 'all'
  sampling: SamplingConfig
  rangeSelection?: { from: number; to: number }
}
```

> **グローバル目的変数（Target Variable）の指定**: `GlobalVariableState` にオプショナルな `targetVariableId: string | null` を追加する。これにより:
> - Models 系ビュー（Decision Tree, Logistic, Discriminant）は初期状態でグローバル target を参照し、説明変数を `activeVariableIds.filter(id => id !== targetVariableId)` で自動設定する
> - Feature Ranking（FEAT-014）は `targetColumn` のデフォルト値としてグローバル target を使用する
> - 各ビューでローカルに target を変更することも可能（ローカルオーバーライド）
> - 目的変数が未設定（`null`）の場合、従来通り各ビューで個別に選択する


### 3.2 Redux Actions & Reducers
- `activeVariablesSet(variableIds: string[])`: アクティブ変数を一括更新。
- `variableToggled(variableId: string)`: 単一変数のアクティブ/非アクティブをトグル。
- `variableOrderReordered(newOrder: string[])`: 変数の表示優先順位を更新。
- `samplingApplied(config: SamplingConfig)`: サンプリングを実行し、`sampledRowIds` を更新。
- `rangeSelectionApplied({ from: number, to: number })`: 行番号の範囲指定により選択行または有効行を更新。
- `observationScopeChanged(scope: 'active' | 'selected' | 'sampled' | 'all')`: 全ビューが参照する有効行スコープを切り替え。

---

## 4. バックエンド API 仕様

サンプリングや範囲選択はフロントエンド（メモリ内Arrowテーブル / JavaScript）で高速に実行可能であるが、10万行以上の大規模データセットや完全再現性のシード計算のために、バックエンドAPIも提供する。

> **大規模データセットでの `activeRowIds` 転送最適化**: `activeRowIds` が 10,000 件を超える場合、全行IDの JSON 送信はネットワーク効率が低下する。将来バージョンでは以下の最適化を導入予定:
> - サーバーサイドセッションキャッシュ（`sessionId` による参照）
> - ビットマスク圧縮（Base64 エンコードされたビット配列）
>
> v1.0 では JSON 配列による直接送信を維持するが、バックエンド側で `activeRowIds` の上限を 100,000 行とするバリデーションを追加する。上限超過時は HTTP 413 エラーと共にサンプリング機能の利用を推奨するメッセージを返却する。

### 4.1 エンドポイント定義
```python
# backend/app/api/observations.py
from fastapi import APIRouter
from pydantic import BaseModel, Field
from typing import List, Optional

router = APIRouter(prefix="/datasets/{dataset_id}/observations", tags=["observations"])

class SamplingRequest(BaseModel):
    method: str = Field("without_replacement", regex="^(with_replacement|without_replacement)$")
    size: Optional[int] = None
    ratio: Optional[float] = None
    seed: Optional[int] = 42
    activeRowIds: Optional[List[str]] = None

class RangeSelectionRequest(BaseModel):
    fromIndex: int = Field(..., ge=0)
    toIndex: int = Field(..., ge=0)
    activeRowIds: Optional[List[str]] = None

@router.post("/sample")
async def sample_observations(dataset_id: str, req: SamplingRequest):
    """
    Executes simple random sampling (with/without replacement)
    using numpy.random.default_rng(seed), returning sampled row IDs.
    """
    pass

@router.post("/range")
async def select_range_observations(dataset_id: str, req: RangeSelectionRequest):
    """
    Selects a contiguous row slice by index, returning the matching row IDs.
    """
    pass
```

> **`size` / `ratio` の排他制御**: `SamplingRequest` で `size` と `ratio` の両方が指定された場合は `size` を優先する。`SamplingConfig.mode` フィールド（`'count'` | `'ratio'`）により、フロントエンドは一方のみを送信することを推奨する。バックエンドは以下のバリデーションを適用する:
> - `size` のみ指定: $1 \le \text{size} \le N$（$N$ は対象行数）
> - `ratio` のみ指定: $0.0 < \text{ratio} \le 1.0$
> - 両方指定: `size` を採用し、`ratio` は無視する
> - 両方未指定: HTTP 422 エラーを返却する

---

## 5. テスト・検証計画

### 5.1 単体テスト (Frontend Unit / Vitest)
1. **共通変数マネージャの状態同期テスト**:
   - `activeVariablesSet` をディスパッチした際、PCPの軸リスト、散布図行列の列、TGTの投影次元が連動して同一の変数配列を受け取ること。
2. **無作為サンプリングの非復元・復元検証**:
   - 非復元抽出において重複行が一切発生せず、指定件数 $n$ に正確に一致すること。
   - 復元抽出において、乱数シード固定時に同一の行ID配列が100%再現されること。
3. **行範囲選択境界値テスト**:
   - `from` > `to` の不正入力時のバリデーション。
   - インデックスが総行数を超過した場合のクリッピング処理の検証。

### 5.2 E2E 結合テスト (Playwright)
1. **上部バーでの変数選択とPCPの即時連動シナリオ**:
   - ヘッダーの `Variables` から `Sepal.Width` のチェックを外す $\to$ PCP画面に遷移した際、`Sepal.Width` 軸が消え、3軸のみで即座にレンダリングされることを確認。
2. **特徴量ランキングからの上位適用シナリオ**:
   - Ranking タブで重要度上位3変数を計算 $\to$ `[上部共通 Variable Selector へ適用]` をクリック $\to$ 上部バーのバッジが `Variables: 3 / 5列` に更新され、PCPの軸もその3軸に同期することを確認。
3. **サンプリング実行と全画面伝播シナリオ**:
   - Observation Selector で 50 行のサンプリングを実行 $\to$ スコープを `Sampled` に切替 $\to$ PCP、Table、BoxPlot のすべての表示件数が 50 件に同期して減少することを確認。
