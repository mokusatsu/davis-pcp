# DAVIS-PCPクローン　現代GUI設計書

文書ID：DAVIS-PCP-GUI-001  
版：0.1  
作成日：2026-08-20  
状態：ファーストステップ実装基準案  
対象：Pythonバックエンド＋ブラウザGUIによるParallel Coordinates Plot先行クローン

---

## 0. この文書の結論

DAVIS-PCPの第1実装では、2000年代のJavaウィンドウ外観を再現しない。再現対象は、次の分析体験である。

1. 軸順を`NoOrder`、`ComponentOrder`、`PermuteOrder`で切り替え、同じデータの構造がどう見え方を変えるか比較できる。
2. PCP上で行集合をブラッシングし、その選択がData Tableと補助ビューへ即時伝播する。
3. 選択集合に対して`Identify`、`Focus`、`Delete`、`Undo`相当の操作を行い、いつでも原データ集合へ戻れる。
4. selection、active rows、group／cluster、color、historyをplot固有状態に閉じ込めず、共有されたrow-level stateとして扱う。

現代GUIは、React＋TypeScript＋Ant Designを採用し、ボタン、メニュー、選択器、テーブル、分割ペイン、ダイアログ、ドロワー、通知等を実コンポーネントで構成する。`div`にCSSを当てただけの偽ボタン、偽タブ、偽セレクト、偽チェックボックスは作らない。PCP描画領域だけは分析固有のため、Canvas 2D＋SVG＋DOM overlayの専用レンダラーとする。

バックエンドはFastAPIを中心に、Polars、NumPy、PyArrowを用いる。軸順アルゴリズム、データ取込、統計要約、セッション保存、エクスポート、長時間ジョブをPython側へ置く。一方、ポインター追従、ブラシプレビュー、hover、現在表示中データのselection更新はブラウザ側で完結させ、操作ごとの往復通信を避ける。

仕様は全項目を次の3区分で管理する。

|区分|意味|設計上の扱い|
|---|---|---|
|`DAVIS-CONFIRMED`|原典本文、数式、当時の実画面のいずれかで明示確認できる|互換中核。原則として実装する|
|`DAVIS-INFERRED`|資料から強く推定できるが、exact specificationが残っていない|推定であること、信頼度、代替可能性を明記する|
|`MODERN-EXTENSION`|現代の操作性、性能、アクセシビリティ、再現性のために追加する|DAVIS由来機能とUI上・コード上で混同しない|

---

## 1. 目的と適用範囲

### 1.1 目的

この文書は、`02_PCP先行実装方針.md`に従い、DAVIS全体ではなくPCPとshared selection／linked interactionを独立アプリとして先行実装するためのGUI・フロントエンド・バックエンド設計を定義する。

目標は「昔の画面に似たPCP」ではない。DAVISが優れていた理由である、軸順の分析、行集合への直接操作、複数ビューの実時間連動、探索履歴の短いループを、現代的なGUIとして再構成することである。

### 1.2 第1段階に含むもの

- 表形式データの取込とスキーマ確認
- 数値列のPCP描画
- Horizontal／Vertical
- NoOrder／ComponentOrder／PermuteOrder
- Jitter on／off
- mouse brushingによるrow selection
- selected／context／groupのレイヤー分離
- Identify／Focus／Delete／Undo相当
- 原集合への復帰
- Data Tableとの双方向linked selection
- Box Plotとのlinked highlighting
- 解析状態の保存・復元
- DAVIS由来、推定、現代追加の表示・記録

### 1.3 第1段階に含めないもの

- Grand Tour／Tracking Grand Tour
- Scatterplot Matrix
- Dendrogramの本格実装
- KMeans／EM等のクラスタリング実行機能
- Decision Tree、variable ranking等
- 元DAVISのMDIウィンドウ外観コピー
- モバイル端末向け完全オーサリング
- 自由配置のドッキングウィンドウ
- categorical axisとmissing valueの完全互換
- 元DAVISの`+Graphics`、`Summary`、`Update`の未確認挙動の推測実装

### 1.4 規範語

- MUST：第1実装の合格に必須
- SHOULD：原則として実装する。外す場合は設計判断記録を残す
- MAY：将来拡張またはオプション

---

## 2. 参照したDAVIS-PCPフォルダ全体

この設計では、フォルダ内の全ファイルを役割別に参照した。

|パス|参照目的|
|---|---|
|`00_README.md`|調査パッケージの目的、原典と推定の分離方針、未取得物の確認|
|`01_DAVIS調査サマリー.md`|既調査の全体像、PCP機能、linked brushing、未確認事項|
|`02_PCP先行実装方針.md`|MVP範囲、状態モデル、描画方式、受入条件|
|`03_一次資料・参考資料一覧.md`|書誌、URL、取得状況、証拠能力|
|`04_Data_Exploration_with_DAVIS_発表資料記録.md`|2005年スライドの画面証拠と操作項目|
|`05_DAVIS.bib`|DAVIS関連書誌の照合|
|`06_SHA256SUMS.txt`|保存資料の同一性確認|
|`sources/2001_The_Structure_of_DAVIS_Java_beans_approach.pdf`|DAVISの構造、data flow、PCPのDirection／Arrangement、linked operation|
|`sources/2001_Algorithms_for_Grand_Tour_and_Parallel_Coordinates.pdf`|Permutation methodとComponent methodの原式・手順・実験図|
|`screenshots/slide07_parallel_coordinates_features.jpg`|Horizontal／Vertical、Component／Permutation、Jitteringの機能一覧|
|`screenshots/slide08_parallel_coordinates_options.jpg`|PCP実画面、3軸順、2方向、下部コントロール|
|`screenshots/slide15_linked_brushing_highlighting.jpg`|mouse brushing、2 subset、赤／水色のlinked highlighting、原集合復帰|
|`screenshots/slide16_delete_focus_undo.jpg`|Identify／Delete／Focus／UndoとBoxPlot連動|
|`screenshots/slide17_interactive_clustering_linking.jpg`|DendrogramとPCPの共通selection color|
|`screenshots/slide18_clustering_em_3_groups.jpg`|3 groupの色分けがBoxPlotとPCPへ伝播|
|`screenshots/slide19_outlier_detection_linking.jpg`|outlier／subset coloringのビュー間伝播|

原典の中核を一文で表すと、構造資料には次の記述がある。

> “The key feature of DAVIS is the real-time interaction between the modules.”

PCP軸順資料の中核は、Permutation methodについての次の記述である。

> “consider all pairwise permutation of the axes so that every possible adjacency is present.”

2005年のlinked interaction資料には、復帰可能性が明示される。

> “Always can go back to the original data set”

### 2.1 証拠ID

以後の表では次の証拠IDを用いる。

|ID|資料|
|---|---|
|`P-STRUCT`|`2001_The_Structure_of_DAVIS_Java_beans_approach.pdf`|
|`P-ALGO`|`2001_Algorithms_for_Grand_Tour_and_Parallel_Coordinates.pdf`|
|`S-07`|slide07|
|`S-08`|slide08|
|`S-15`|slide15|
|`S-16`|slide16|
|`S-17`|slide17|
|`S-18`|slide18|
|`S-19`|slide19|

---

## 3. DAVIS PCPの復元仕様

### 3.1 確認できる仕様

|ID|区分|根拠|復元仕様|未確認境界|
|---|---|---|---|---|
|`C-001`|DAVIS-CONFIRMED|`P-STRUCT` p.1、p.4|DAVISは複数module間のreal-time interactionを中核とする|通信のexact timing、thread modelは現代実装に継承しない|
|`C-002`|DAVIS-CONFIRMED|`P-STRUCT` p.4|brushed subsetに対応するdata point index arrayが関連moduleへ伝播する|indexの型、重複処理、イベント順序は不明|
|`C-003`|DAVIS-CONFIRMED|`P-STRUCT` p.3、`S-07`、`S-08`|PCPに`Direction`操作がある|初期値は資料だけでは確定しない|
|`C-004`|DAVIS-CONFIRMED|`S-07`、`S-08`|`Horizontal`を選べる|切替時のアニメーション有無は不明|
|`C-005`|DAVIS-CONFIRMED|`S-07`、`S-08`|`Vertical`を選べる|ラベルの細かな配置規則は不明|
|`C-006`|DAVIS-CONFIRMED|`P-STRUCT` p.3、`S-08`|database arrangementに相当する`NoOrder`がある|列型による例外挙動は不明|
|`C-007`|DAVIS-CONFIRMED|`P-STRUCT` p.3、`P-ALGO` pp.5-7、`S-08`|`ComponentOrder`がある|similarity matrixのexact definitionは不明|
|`C-008`|DAVIS-CONFIRMED|`P-STRUCT` p.3、`P-ALGO` pp.4-7、`S-08`|`PermuteOrder`がある|同点時のtie-breakは不明|
|`C-009`|DAVIS-CONFIRMED|`S-07`|PCP機能として`Jittering`がある|分布、振幅、対象列、seedは不明|
|`C-010`|DAVIS-CONFIRMED|`S-07`、`S-08`|Horizontal画面では変数ごとに縦軸を置き、rowをpolylineで結ぶ|line width、alpha、anti-aliasingは不明|
|`C-011`|DAVIS-CONFIRMED|`S-07`、`S-08`|連続軸の端点付近にmin／max値、軸外にvariable labelを表示する|小数桁、format、余白計算は不明|
|`C-012`|DAVIS-CONFIRMED|`S-07`、`S-08`|離散数値軸とcategory labelを含む画面例がある|ordinalizationとcategory orderは不明|
|`C-013`|DAVIS-CONFIRMED|`P-STRUCT` p.4、`S-15`|mouse brushingでrow subsetを選択できる|freehand／rectangle等のexact gestureは不明|
|`C-014`|DAVIS-CONFIRMED|`S-15`|brushingによりdata setを2 subsetへ分ける例がある|常に2群か、一時selectionか、group作成かは画面だけでは断定しない|
|`C-015`|DAVIS-CONFIRMED|`S-15`|選択例ではselected rowsが赤、context rowsが水色で描かれる|固定色かtheme依存かは不明|
|`C-016`|DAVIS-CONFIRMED|`S-15`|元のdata setへ戻れる|操作名と履歴深度は不明|
|`C-017`|DAVIS-CONFIRMED|`P-STRUCT` p.4、`S-16`|subsetに対する`Identify`、`Delete`、`Focus`、`Undo`が存在する|各コマンドのexact state transitionは不明|
|`C-018`|DAVIS-CONFIRMED|`P-STRUCT` p.4|Data Tableのrow selectionが他moduleへ伝播し、他moduleからのselectionもtableでhighlightされる|multi-select gestureは不明|
|`C-019`|DAVIS-CONFIRMED|`S-16`|BoxPlotとPCP間でselection highlightingが同期する|2001資料時点ではBoxPlotの一部linking未完成という記述があり、2005画面を完成形の証拠として扱う|
|`C-020`|DAVIS-CONFIRMED|`S-17`|DendrogramとPCPで同じsubsetが共通色表示される|link対象を限定するUIは不明|
|`C-021`|DAVIS-CONFIRMED|`S-18`|EM clusteringの3 group色がBoxPlotとPCPへ伝播する|色割当規則は不明|
|`C-022`|DAVIS-CONFIRMED|`S-19`|BoxPlot上のoutlier／subset coloringがPCPへ伝播する|outlier selectionのgestureは不明|
|`C-023`|DAVIS-CONFIRMED|`S-08`|PCP下部に`Print`、`+Graphics`、`Update`、`Summary`が見える|ラベル以外の意味は断定しない|
|`C-024`|DAVIS-CONFIRMED|`P-ALGO` pp.4-6|Permutation methodは所定の候補permutationを生成し、隣接変数のdissimilarity合計を最小化する|欠損値・定数列の扱いは不明|
|`C-025`|DAVIS-CONFIRMED|`P-ALGO` p.6|Component methodは最大固有値のcomponent vectorから最大絶対成分の変数を選び、列を除去して反復する|similarity matrixと前処理は不明|

### 3.2 画面から復元できるorientationの意味

#### Horizontal

`DAVIS-CONFIRMED`

- 変数軸は左から右へ並ぶ。
- 各変数軸は縦方向である。
- 1 rowのpolylineは画面を横方向に進む。
- variable labelは主に軸下、min／maxは軸端に表示される。

#### Vertical

`DAVIS-CONFIRMED`

- 変数は上から下へ並ぶ。
- 各変数軸は横方向である。
- 1 rowのpolylineは画面を縦方向に進む。
- variable labelは画面左側に置かれる例が確認できる。

orientation名称は「軸の向き」ではなく「plot全体の進行方向」と解釈する。現代GUIでも表示名は元の`Horizontal`／`Vertical`を維持し、tooltipで意味を説明する。

### 3.3 元画面の構造

`S-08`から、PCPウィンドウは概ね次の4領域に分かれる。

```text
┌ Parallel Coordinates ───────────────────────────┐
│            Direction   Ordering                 │
├─────────────────────────────────────────────────┤
│                                                 │
│                 PCP plot                        │
│                                                 │
├─────────────────────────────────────────────────┤
│ Print   □ +Graphics   Update   Summary          │
└─────────────────────────────────────────────────┘
```

この構造自体は`DAVIS-CONFIRMED`である。ただし、現代版で同じ位置・同じボタン配置にすることは`MODERN-EXTENSION`であり、互換要件ではない。

### 3.4 確認できない仕様

以下は資料不足のため、確認済み仕様として実装してはならない。

|ID|区分|未確認事項|初期実装での扱い|
|---|---|---|---|
|`U-001`|DAVIS-INFERRED|brushの形状、hit-test、tolerance|推定アルゴリズムとして明示する|
|`U-002`|DAVIS-INFERRED|jitterの乱数分布、振幅、seed|deterministic jitterを現代追加として実装する|
|`U-003`|DAVIS-INFERRED|polylineのalpha、width、描画順|現代のレイヤー設計で決める|
|`U-004`|DAVIS-INFERRED|missing valueの線表現|MVPでは対象外、列状態として警告する|
|`U-005`|DAVIS-INFERRED|categoryの内部値と順序|MVPでは数値列優先、後続版で明示設定する|
|`U-006`|DAVIS-INFERRED|`Identify`の表示先、複数行時の挙動|record inspectorとして設計する|
|`U-007`|DAVIS-INFERRED|`Delete`が物理削除か解析集合からの一時除外か|可逆な`Exclude`として実装する|
|`U-008`|DAVIS-INFERRED|`Undo`の履歴単位と深度|domain command単位の多段履歴とする|
|`U-009`|DAVIS-INFERRED|`Update`が必要な操作範囲|現代版では原則即時反映、重い計算のみ明示jobとする|
|`U-010`|DAVIS-INFERRED|`Summary`の表示内容|右inspectorのSummary tabへ置き換える|
|`U-011`|DAVIS-INFERRED|`+Graphics`のexact behavior|意味を捏造せず、v0.1では出さない|
|`U-012`|DAVIS-INFERRED|ComponentOrderのsimilarity matrix|後述のIris再現結果に基づきcorrelationを高信頼推定とする|

---

## 4. 軸順アルゴリズムの復元

### 4.1 NoOrder

`DAVIS-CONFIRMED`

2001資料ではdatabase arrangement、2005画面では`NoOrder`と表示される。初期列順をそのまま用いる。

`MODERN-EXTENSION`

初期列順の定義を曖昧にしないため、次の優先順位を保存する。

1. ファイル内の物理列順
2. import時にユーザーが確定したvisible column順
3. sessionで保存されたmanual order

`NoOrder`へ戻したときは、1または2のbaseline orderへ戻す。manual drag後の順を`NoOrder`と呼ばない。

### 4.2 PermuteOrder

#### 4.2.1 原典どおりの候補生成

`DAVIS-CONFIRMED`

変数数を`p`、1始まりの基本列を`v_1,…,v_p`とする。

```text
v_1 = 1
v_{i+1} = [v_i + (-1)^(i+1) i] mod p, i = 1,…,p-1
```

原典のmodは`0 mod p = p`とし、負値も1〜pへwrapする。

この基本列から、全要素を1ずつ巡回加算した候補を生成する。候補数は次である。

```text
floor((p + 1) / 2)
```

`p=4`の原典例は次の2候補である。

```text
{1, 2, 4, 3}
{2, 3, 1, 4}
```

これは全`p!`順列の総当たりではない。実装名に`permutation`が含まれていても、Hamilton path最適化等の別問題に置き換えてはならない。

#### 4.2.2 dissimilarityと評価

`DAVIS-CONFIRMED`

列`j`をmin-max正規化する。

```math
b_{kj}=\frac{x_{kj}-\min(x_{\cdot j})}{\max(x_{\cdot j})-\min(x_{\cdot j})}
```

変数`i,j`のdissimilarityは、観測方向のEuclidean distanceである。

```math
D_{ij}=\sqrt{\sum_{k=1}^{n}(b_{ki}-b_{kj})^2}
```

各候補について隣接する変数の`D`を合計し、最小の候補を採用する。

```math
score(\pi)=\sum_{r=1}^{p-1}D_{\pi_r,\pi_{r+1}}
```

#### 4.2.3 再現テスト

`DAVIS-CONFIRMED`＋実装検証

原典のIris図におけるPermuteOrderは次である。

```text
sepal width → petal length → sepal length → petal width
```

保存原典の式をIrisデータへ適用した検証では、候補scoreは次になり、図と同じ順を選んだ。

|候補|score|結果|
|---|---:|---|
|sepal length → sepal width → petal width → petal length|9.961958|不採用|
|sepal width → petal length → sepal length → petal width|9.207083|採用|

このfixtureをbackend unit testへ固定する。

#### 4.2.4 原典が定義しない場合の現代ポリシー

`MODERN-EXTENSION`

- score同点は、候補生成順を優先するstable tie-breakとする。
- constant columnは原式で0除算になるため、黙って値を作らない。v0.1では警告し、constant columnをordering対象外としてbaseline位置に固定する。
- missing valueを含む場合は、order計算前に明示的な処理方法をユーザーへ要求する。既定で勝手に平均補完しない。
- 結果には`method_version`、input columns、score、candidate scores、warningsを保存する。

### 4.3 ComponentOrder

#### 4.3.1 原典手順

`DAVIS-CONFIRMED`

1. 現在のdata matrix`X`からsimilarity matrixを得る。
2. 最大固有値に対応するprincipal component vector`u`を求める。
3. `|u_k|`が最大となる変数`k`を次の軸として選ぶ。
4. `X`から`k`列を除去する。
5. 変数がなくなるまで1〜4を反復する。

単発のPCAを1回行い、loading絶対値で全列をsortする実装は不適合である。

#### 4.3.2 similarity matrixの推定

`DAVIS-INFERRED`、信頼度：高

原典はsimilarity matrixの語だけを示し、correlationかcovarianceかを明記していない。Irisの原典図を用いて候補を比較した。

|候補定義|得られた順|原典図との一致|
|---|---|---|
|correlation matrix|petal length → petal width → sepal length → sepal width|一致|
|標準化列のcovariance|petal length → petal width → sepal length → sepal width|一致|
|raw covariance|petal length → sepal length → petal width → sepal width|不一致|
|raw Gram matrix|sepal length → petal length → sepal width → petal width|不一致|

したがってv0.1 reference implementationは、各iterationで残存列のcorrelation matrixを再計算する。ただし、これはIrisの1例による復元であり、`DAVIS-CONFIRMED`へ昇格させない。

実装結果には必ず次を含める。

```json
{
  "method": "component_order",
  "method_version": "davis-reconstruction-0.1",
  "similarity_matrix": "correlation_inferred",
  "evidence_class": "DAVIS-INFERRED",
  "confidence": "high",
  "iteration_trace": []
}
```

#### 4.3.3 数値上の規則

`MODERN-EXTENSION`

- 固有値計算は対称行列用`eigh`を用いる。
- 固有vectorの符号反転不定性を避けるため、原典どおりabsolute coefficientを比較する。
- 同値はbaseline orderの先頭を採用する。
- 1列だけ残った場合はその列を採用して終了する。
- zero variance、NaN、singular matrixはwarningを返し、黙って別アルゴリズムへfallbackしない。
- iterationごとのremaining columns、largest eigenvalue、absolute loading、selected columnをtraceとしてテスト可能にする。

### 4.4 algorithm serviceの共通出力

```ts
type AxisOrderEvidence = 'DAVIS-CONFIRMED' | 'DAVIS-INFERRED' | 'MODERN-EXTENSION';

type AxisOrderResult = {
  method: 'no_order' | 'component_order' | 'permute_order' | 'manual';
  methodVersion: string;
  evidenceClass: AxisOrderEvidence;
  inputColumnIds: string[];
  orderedColumnIds: string[];
  score?: number;
  candidateScores?: Array<{ order: string[]; score: number }>;
  parameters: Record<string, unknown>;
  warnings: string[];
  trace?: unknown[];
  elapsedMs: number;
};
```

軸順結果を単なる`string[]`にしない。復元アルゴリズムの出自、推定パラメータ、warning、再現性情報を結果の一部とする。

---

## 5. 現代GUIの設計原則

### 5.1 外観ではなく操作モデルを継承する

`DAVIS-CONFIRMED`

DAVISらしさは、灰色のJavaウィンドウ、古いmenu、重なった内部windowではなく、軸順、brushing、linked state、Focus／Delete／Undoにある。

`MODERN-EXTENSION`

- 元のMDIウィンドウは、resizable split panesとtabsへ置き換える。
- 元の明示的`Update`は、安価な操作では即時反映へ置き換える。
- 元のcontext menuに隠れていた主要操作は、selectionがあるときだけcommand barへ明示表示する。
- 原語はtooltipやcompatibility inspectorに残し、日本語ラベルは誤操作を減らす表現へ変える。

### 5.2 全ビューは同じselection sourceを読む

PCP、Data Table、Box Plotが互いにイベントを投げ合う構造にしない。中央のselection modelへcommandをcommitし、全ビューはそのstateをprojectionする。

```text
PCP brush ───────┐
Table selection ─┼─> Selection Engine ─> versioned shared state ─> all views
BoxPlot range ───┘
```

これにより、循環イベント、二重選択、ビューごとの色不一致を防ぐ。

### 5.3 selectionとgroupを分離する

- selection：現在操作対象となる一時的なrow set
- active rows：現在の解析母集団
- excluded rows：activeから一時除外されたrow set
- group／cluster：持続的なrow label
- hover：ポインター下の一時状態
- identified row：inspectorで詳細表示しているrow

selection colorとgroup colorを同じプロパティへ潰さない。

### 5.4 可逆性を最優先する

- FocusとExcludeは破壊的データ変更ではなくsession stateのcommandとする。
- 実行直後にUndo actionをnotificationへ出す。
- headerに常時Undoを置く。
- `原集合へ戻す`をHistory panelとdataset menuの双方へ置く。
- permanent deletionはv0.1では実装しない。

### 5.5 progressive disclosure

最初から全scale、jitter seed、brush tolerance、render samplingをtoolbarへ並べない。

- 常用：Orientation、Ordering、Jitter、Select、Focus、Exclude、Undo
- 詳細：axis reverse、scale、jitter amplitude、seed、brush tolerance
- 開発・検証：algorithm trace、candidate score、render backend、sampling diagnostics

### 5.6 component-library-first

すべての一般GUIは既製コンポーネントを使う。

禁止例：

```tsx
<div className="fake-button" onClick={...}>Focus</div>
<div className="fake-tab active">Data</div>
<div className="fake-select">ComponentOrder ▼</div>
```

許可するcustom描画：

- PCPのpolyline canvas
- PCPのaxis／brush SVG
- plot内のhit-test layer
- EChartsを包む薄いReact adapter
- layout glueのCSS Modules

CSSで実装してよいのは、plot geometry、canvas重ね合わせ、overflow、minimum size、token参照等に限定する。

---

## 6. 採用するモダンGUIスタック

### 6.1 決定

|領域|採用|理由|区分|
|---|---|---|---|
|UI framework|React 19系|component分割、状態駆動、周辺tooling|MODERN-EXTENSION|
|language|TypeScript strict|selection／axis state／API contractを型で固定|MODERN-EXTENSION|
|build|Vite|React＋TypeScriptの標準的なSPA構成、Worker分割|MODERN-EXTENSION|
|component system|Ant Design 6系|Splitter、Table、Upload、Segmented、Drawer、Form等を一つのdesign systemで揃えられる|MODERN-EXTENSION|
|global state|Redux Toolkit＋RTK Query|domain command、undo、API cache、DevTools trace|MODERN-EXTENSION|
|plot renderer|専用Canvas 2D＋SVG|DAVIS固有の大量polylineとbrushを制御する必要がある|MODERN-EXTENSION|
|supplemental charts|Apache ECharts 6系|BoxPlot、scatter overlay、brush、Canvas／SVGを利用できる|MODERN-EXTENSION|
|backend|FastAPI|typed API、file upload、WebSocket job event|MODERN-EXTENSION|
|data engine|Polars＋NumPy|columnar処理、lazy query、軸順数値計算|MODERN-EXTENSION|
|transport|JSON＋Arrow IPC|metadataはJSON、大量列データはcolumnar binary|MODERN-EXTENSION|
|testing|Vitest、Testing Library、Playwright、pytest|component、E2E、algorithmを分離して検証|MODERN-EXTENSION|

### 6.2 Ant Designを中核にする理由

PCP用の独自plotを作る必要はあるが、アプリ全体まで独自design systemにしてはならない。Ant Designの実コンポーネントを次の用途に直接使う。

|用途|コンポーネント|
|---|---|
|application shell|`App`、`ConfigProvider`、`Layout`|
|可変ペイン|`Splitter`、`Splitter.Panel`|
|toolbar|`Flex`、`Space`、`Button`、`Dropdown`、`Segmented`、`Select`、`Switch`|
|import|`Upload.Dragger`、`Modal`、`Steps`、`Table`|
|data table|`Table`、`rowSelection`、`Pagination`|
|inspector|`Tabs`、`Descriptions`、`Collapse`、`Form`、`Drawer`|
|数値設定|`Slider`、`InputNumber`|
|状態表示|`Badge`、`Tag`、`Alert`、`Progress`、`Skeleton`、`Empty`、`Result`|
|確認・通知|`Popconfirm`、`notification`、`message`|
|help|`Tooltip`、`Popover`、`Tour`|
|theme|`ConfigProvider.theme`、design tokens|

軸drag reorderには`dnd-kit`を用いる。drag handleだけに依存せず、軸menuへ`左へ移動`、`右へ移動`、`先頭へ`、`末尾へ`を用意する。

### 6.3 バージョン方針

- major versionは上表をbaselineとする。
- minor／patchはimplementation開始時にlockfileへ固定する。
- design docへ日々変化するminor versionを埋め込まない。
- upgradeはvisual regression、keyboard、row selection、Splitter persistenceのtest通過を条件にする。

### 6.4 公式資料による選定根拠

以下はDAVISの原典ではなく、現代実装技術の一次資料である。

React公式：<https://react.dev/>

> “React lets you build user interfaces out of individual pieces called components.”

TypeScript公式：<https://www.typescriptlang.org/>

> “TypeScript is JavaScript with syntax for types.”

Ant Design Splitter：<https://ant.design/components/splitter/>

> “Can be used to separate areas horizontally or vertically.”

Ant Design Table：<https://ant.design/components/table/>

> “Rows can be selectable by making first column as a selectable column.”

Ant Design Upload：<https://ant.design/components/upload/>

> “Used to select and upload files or drag and drop files.”

Ant Design Segmented：<https://ant.design/components/segmented/>

> “Display multiple options and allow users to select a single option.”

Redux Toolkit公式：<https://redux-toolkit.js.org/introduction/getting-started>

> “The Redux Toolkit package is intended to be the standard way to write Redux logic.”

FastAPI WebSocket：<https://fastapi.tiangolo.com/advanced/websockets/>

> “You can receive and send binary, text, and JSON data.”

Polars LazyFrame：<https://docs.pola.rs/api/python/stable/reference/lazyframe/index.html>

> “This allows for whole-query optimisation in addition to parallelism.”

Apache Arrow format：<https://arrow.apache.org/docs/format/Intro.html>

> “Protocol to share Arrow data between processes or over the network is called Serialization and Interprocess Communication.”

Apache ECharts features：<https://echarts.apache.org/en/feature.html>

> “ECharts supports…boxplot series for statistics…parallel series for multi-dimensional data.”

WCAG 2.2：<https://www.w3.org/TR/WCAG22/>

> “The size of the target for pointer inputs is at least 24 by 24 CSS pixels.”

---

## 7. 情報アーキテクチャ

### 7.1 画面階層

```text
DAVIS-PCP
├─ Welcome / Recent Projects
├─ Import Dataset Wizard
├─ PCP Workspace
│  ├─ Project Header
│  ├─ Analysis Command Bar
│  ├─ Variable Panel
│  ├─ PCP Viewport
│  ├─ Inspector / History Panel
│  └─ Linked Views
│     ├─ Data Table
│     ├─ Box Plot
│     └─ Selection Log
└─ Settings
   ├─ Appearance
   ├─ Compatibility Profile
   ├─ Performance
   └─ Privacy / Storage
```

### 7.2 空状態

初回起動時は空のplotを表示せず、`Empty`と`Upload.Dragger`を中心に置く。

```text
┌────────────────────────────────────────────────────┐
│ DAVIS-PCP                                Settings   │
├────────────────────────────────────────────────────┤
│                                                    │
│        ┌──────────────────────────────────┐        │
│        │  CSV / TSV / Parquetをドロップ   │        │
│        │  またはファイルを選択            │        │
│        └──────────────────────────────────┘        │
│        Sample dataset     Open recent project      │
│                                                    │
└────────────────────────────────────────────────────┘
```

`Upload.Dragger`をCSSで模倣しない。ファイルをdropしても即確定せず、Import Wizardへ遷移する。

### 7.3 PCP Workspace

```text
┌ Project Header ───────────────────────────────────────────────────────────────┐
│ Dataset ▾  Import  Save  Undo  Redo                 Job status  Help  Settings│
├ Analysis Command Bar ────────────────────────────────────────────────────────┤
│ Orientation [Horizontal|Vertical]  Order [No|Component|Permute|Manual]        │
│ Jitter [on]  Brush [Free]  Selected 128 / Active 150  Identify Focus Exclude │
├───────────────┬────────────────────────────────────────┬─────────────────────┤
│ Variable      │ PCP Viewport                           │ Inspector           │
│ Panel         │                                        │ Selection           │
│               │ Canvas + SVG                           │ Axis                 │
│ Search        │                                        │ Algorithm            │
│ ☑ mpg         │                                        │ History              │
│ ☑ disp        │                                        │                     │
│ ☑ hPower      │                                        │                     │
│ ☑ weight      │                                        │                     │
│ ...           │                                        │                     │
├───────────────┴────────────────────────────────────────┴─────────────────────┤
│ [Data Table] [Box Plot] [Selection Log]                                      │
│ linked view content                                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ Active 150  Selected 128  8 axes  Full render  Canvas2D  Order score 9.207   │
└──────────────────────────────────────────────────────────────────────────────┘
```

上段3ペインと下段linked viewの境界は`Splitter`でresizeできる。v0.1では自由なwindow dockingを実装しない。配置を安定させ、操作学習とkeyboard focusを単純に保つ。

### 7.4 推奨寸法

`MODERN-EXTENSION`

|領域|既定|最小|最大|
|---|---:|---:|---:|
|Header|48px|48px|48px|
|Command Bar|44px|44px|自動wrap時88px|
|Variable Panel|280px|220px|420px|
|Inspector|320px|280px|480px|
|Linked Views|260px|160px|workspaceの50%|
|PCP中心領域|残余|480×320px|制限なし|

- 推奨desktop viewport：1440×900以上
- 実用最小：1180×720
- 1180px未満では右inspectorを`Drawer`へ退避する
- mobileはv0.1でread-only summaryとproject閲覧に限定する

---

## 8. コンポーネント詳細

### 8.1 Project Header

|要素|コンポーネント|仕様|
|---|---|---|
|dataset／project名|`Dropdown`＋`Button`|dataset切替、rename、close|
|Import|`Button`|Import Wizardを開く|
|Save|`Button`|session stateを保存|
|Undo／Redo|`Button`＋`Tooltip`|domain command history。無効時はdisabled|
|job status|`Badge`＋`Popover`|ordering、import、exportの進行状況|
|Help|`Button`＋`Tour`|初回操作とshortcut|
|Settings|`Button`＋`Drawer`|theme、compatibility、performance|

Undo／Redoはselectionのポインター移動を1件ずつ記録しない。後述のcommit commandだけを対象にする。

### 8.2 Analysis Command Bar

#### Orientation

- `Segmented`で`Horizontal`と`Vertical`を表示する。
- アイコンだけにせずtext labelを残す。
- 切替時にselection、axis order、scale、groupsを保持する。
- plot geometryだけを再計算する。

#### Ordering

- 幅があるときは`Segmented`、狭いときは`Select`へresponsiveに切り替える。
- 項目は`NoOrder`、`ComponentOrder`、`PermuteOrder`、`Manual`。
- `Manual`はMODERN-EXTENSIONであり、DAVISの3方式とvisual groupを分ける。
- algorithm実行中は現在のplotを維持し、`Progress`を表示する。完了後にatomic swapする。
- algorithm error時は旧orderを保持し、`Alert`で原因を示す。

#### Jitter

- 常用部には`Switch`だけを置く。
- amplitude、seed、対象列は右inspectorのAdvancedへ置く。
- deterministic seedをsessionへ保存する。
- on／offでselection identityは変化させない。線の視覚位置だけを変える。

#### Selection actions

selection countが0のとき、Identify／Focus／Excludeをdisabledにする。

|DAVIS原語|現代日本語label|作用|
|---|---|---|
|Identify|レコードを確認|Selection inspectorを開き、対象行をtableで表示|
|Focus|選択のみ表示|`active = selected`|
|Delete|選択を除外|`active = active - selected`。物理削除しない|
|Undo|元に戻す|直前のdomain commandをrevert|

context menuにも同じcommandを出すが、toolbarと別ロジックにしない。同じRedux action creatorを呼ぶ。

### 8.3 Variable Panel

`Tabs`を用いて`Variables`と`Dataset`を分ける。

#### Variables tab

- `Input.Search`：column name検索
- `Checkbox`：visible axisのon／off
- type icon：numeric、categorical、datetime、unsupported
- role `Tag`：Axis、ID、Label、Ignored
- drag handle：manual order
- column menu：Move、Reverse、Scale、Hide、Inspect
- warning icon：missing、constant、high cardinality

MVPでPCP非対応の列を消さず、disabled状態と理由を見せる。

軸drag後はorder modeを`Manual`へ変更する。Component／Permuteの計算結果そのものを書き換えず、`computed order`と`manual override`を別に保存する。

#### Dataset tab

- row count、active count、selected count
- column count、numeric count
- missing summary
- dataset fingerprint
- import options
- `原集合へ戻す`

### 8.4 PCP Viewport

PCP Viewportは次の層を持つ。

```text
PCPViewport
├─ CanvasContextLayer
├─ CanvasGroupLayer
├─ CanvasSelectionLayer
├─ CanvasHoverLayer
├─ SvgAxisLayer
├─ SvgInteractionLayer
└─ DomOverlayLayer
```

|層|内容|再描画契機|
|---|---|---|
|Context|activeかつ非selectedのlines|data、axis、orientation、scale変更|
|Group|group／cluster color lines|group、axis変更|
|Selection|selected linesを最前面描画|selection、axis変更|
|Hover|hover／identified row|pointer move、identify|
|Axis SVG|axis、ticks、labels、handles|axis state、resize|
|Interaction SVG|brush path、range、focus ring|pointer／keyboard interaction|
|DOM overlay|tooltip、popover anchor、empty/error|状態変化|

Canvasはdevice pixel ratioへ追随し、CSS sizeとbitmap sizeを分ける。軸と操作handleはSVG／DOMを用い、keyboard focusとaccessible nameを持たせる。

### 8.5 Inspector

`Tabs`：

1. Selection
2. Axis
3. Algorithm
4. History
5. Summary

#### Selection

- selected count
- group内訳
- first rows preview
- selection source view
- replace／add／subtractの履歴
- Identify drawerへの導線

#### Axis

- name、type、unit
- min／max、missing count
- direction reverse
- scale
- tick format
- jitter policy

scaleの`linear`以外はMODERN-EXTENSIONとしてAdvanced groupへ置く。

#### Algorithm

- method
- evidence class
- ordered columns
- score
- parameters
- warnings
- ComponentOrderの`correlation_inferred`表示
- PermuteOrderのcandidate scores
- computation time
- `再計算`

#### History

- command名
- timestamp
- active／selected countのbefore／after
- source view
- Undo／Redo
- `原集合へ戻す`

### 8.6 Data Table

Ant Design `Table`を使用し、`rowSelection.selectedRowKeys`を中央selection stateへcontrolled接続する。

- PCPから選択されたrowはcheckboxとrow highlightで示す。
- tableからのcheckbox／row actionは同じselection commandをcommitする。
- current page selectionと全active selectionを混同しない。
- header selection menuに次を明示する。
  - このページを選択
  - 表示filterに一致する全行を選択
  - active rowsを全選択
  - 選択解除
- large dataではserver paginationを使う。
- row keyはdisplay indexではなくstable row IDとする。
- selected rowを先頭へ固定する機能はoptionalとし、元のsort orderを破壊しない。

Data Tableをv0.1の双方向linked view合格対象とする。

### 8.7 Box Plot

Apache EChartsを用い、少なくとも次を表示する。

- active rows全体のbox plot
- selected rowsのbox plotまたはraw point overlay
- group別color
- selected outlier pointのrow ID tooltip

v0.1必須はPCP selectionの反映である。逆方向selectionは、raw point clickまたはrange brushを実装できた変数から段階的に有効化する。Data Tableの双方向selectionが先に完成条件を満たす。

### 8.8 Selection Log

分析再現性のため、次をtable表示する。

- sequence number
- source view
- selection operation
- selected count
- active count
- Focus／Exclude／Group等のcommand
- axis order method
- timestamp

これは元DAVISの機能として確認されていないため、`MODERN-EXTENSION`である。

---

## 9. 主要ワークフロー

### 9.1 データ取込

1. `Upload.Dragger`へfileをdropする。
2. backendがformat、encoding、delimiter、schemaをprobeする。
3. Wizard step 1でfile情報とwarningを表示する。
4. step 2でcolumn type、role、missing、sample valuesを`Table`表示する。
5. row ID候補がuniqueなら選択可能にする。なければstable generated row IDを使う。
6. numerical axis候補を既定選択する。
7. `PCPを開く`でdataset sessionを作成する。

v0.1の必須formatはCSV／TSVとする。Parquet／ArrowはMODERN-EXTENSIONだが、backend構造は追加可能にする。

### 9.2 軸順比較

1. datasetをNoOrderで開く。
2. OrderingからComponentOrderを選ぶ。
3. backend jobを開始し、現plotはそのまま維持する。
4. 完了後、axis移動を短いtransitionまたは即時切替で示す。
5. Algorithm inspectorに推定matrix、iteration trace、warningを表示する。
6. PermuteOrderへ切り替え、candidate scoreを比較する。
7. NoOrderへ戻すとbaselineへ復帰する。

軸順変更でselectionを解除しない。同じrow identityを異なる軸配置で比較することが目的である。

### 9.3 PCPブラッシング

1. plot上でpointer downする。
2. brush pathをoverlayへ描く。
3. drag中はsampled／raster previewで候補線を薄くhighlightする。
4. pointer up時にWorkerでexact hit-testを行う。
5. `replace` selection commandを1件commitする。
6. PCP、Data Table、Box Plot、count表示が同一transactionで更新される。
7. Escapeでcommit前のbrushをcancelする。

### 9.4 Focus

1. selectionがある状態で`選択のみ表示`を押す。
2. command previewに`Active 150 → 37`を表示する。
3. commit後、active bitsetをselection bitsetへ置換する。
4. selectionは新active内で保持する。
5. Undo notificationを表示する。

### 9.5 Exclude

1. selectionがある状態で`選択を除外`を押す。
2. permanent deleteではないことをtooltipで示す。
3. `active = active AND NOT selected`をcommitする。
4. selectionをclearする。
5. Historyへ追加し、Undo可能にする。

### 9.6 Identify

1. `レコードを確認`でSelection inspectorを開く。
2. 1 rowなら`Descriptions`で全columnを表示する。
3. 複数rowならData Tableをfiltered表示する。
4. rowを選ぶとPCPの該当lineをhover layerへ太く表示する。
5. plot外でもrow identityを失わない。

### 9.7 原集合へ戻す

- active rowsをimport時のoriginal bitsetへ戻す。
- selectionをclearする。
- groupは既定では保持し、確認dialogで`groupも消す`を選択可能にする。
- axis order、orientation、scaleは保持する。
- command historyに`Reset active rows`を追加し、直後のUndoを可能にする。

---

## 10. selection gestureの仕様

### 10.1 DAVIS互換ブラシの推定

`DAVIS-INFERRED`、信頼度：中

実画面と説明からmouse brushingは確認できるが、形状が残っていない。v0.1では、polylineを横切るfreehand strokeとして復元する。

#### hit-test

- pointer pathを一定距離ごとにsampleする。
- row polylineを隣接axis間のline segment集合として扱う。
- brush path segmentとrow segmentの最小距離が`tolerance`以下ならhitとする。
- pointer up後の確定判定は全表示対象rowへ正確に行う。
- drag中previewは軽量化してよいが、sampling中であることを内部diagnosticへ記録する。

これは原典のexact ruleではないため、algorithm名を`freehand-polyline-intersection-v1`としてsessionに保存する。

### 10.2 現代のselection set演算

`MODERN-EXTENSION`

|入力|演算|
|---|---|
|通常drag|Replace|
|Shift＋drag|Add／Union|
|Alt／Option＋drag|Subtract|
|Ctrl／Cmd＋drag|Toggle／XOR|

keyboard modifierに依存できないtouch／assistive環境向けに、command barへ`Replace`、`Add`、`Subtract`の`Segmented`を用意する。

### 10.3 将来の選択方式

- axis range brush
- rectangular brush
- lasso
- multi-axis AND／OR filters
- query builder

すべて`MODERN-EXTENSION`として、DAVIS freehand brushとmode名を分ける。

---

## 11. 軸操作

### 11.1 軸の表示／非表示

- Variable Panelのcheckboxで切替える。
- 2軸未満にならないようにする。
- 非表示列はdatasetから削除しない。
- ordering計算のinput columnsを明示する。

### 11.2 manual reorder

`MODERN-EXTENSION`

- drag handleで移動する。
- keyboard menuでも移動できる。
- 手動変更時、order modeを`Manual`へする。
- 直前のcomputed orderを保持し、`計算結果へ戻す`を出す。

### 11.3 reverse axis

`MODERN-EXTENSION`

- axis header menuとinspectorに`Reverse`を置く。
- reverse状態はorderingと独立する。
- reverseによってalgorithm scoreを再計算しない。
- labelに方向iconを表示する。

### 11.4 scale

`MODERN-EXTENSION`

v0.1既定はlinear min-max display scaleとする。これは画面観察から自然だが、元DAVISのvisual normalizationの数式が明記されていないため、`DAVIS-INFERRED`として記録する。

将来候補：

- linear
- log
- symlog
- z-score
- quantile

scaleを変更してもPermuteOrderの原典score用min-max normalizationは変えない。表示scaleとordering metricを分離する。

### 11.5 高次元時の表示

軸を極端に圧縮しない。

- 既定axis gapを保ち、plotをorientation方向へscroll可能にする。
- `Fit`、`100%`、zoom sliderを用意する。
- variable searchとvisible axis presetを用意する。
- 省略されたlabelはtooltipで完全表示する。
- 画面外axisもvirtualizeできる設計にする。

---

## 12. Jitter設計

### 12.1 DAVISで確認できること

`DAVIS-CONFIRMED`

Jittering機能が存在する。

### 12.2 確認できないこと

`DAVIS-INFERRED`

- noise distribution
- amplitude
- discrete／continuousのどちらへ適用するか
- redrawごとに値が変わるか
- seed

### 12.3 現代版実装

`MODERN-EXTENSION`

```text
jitter(rowId, columnId, seed) = signedHash(rowId, columnId, seed) × amplitude
```

- deterministicにする。
- dataset、row、column、seedが同じなら再描画しても位置を変えない。
- 既定ではdiscrete／categorical軸にのみ適用する。
- continuous軸への適用はAdvanced optionとする。
- amplitudeはaxis pixel spanに対する割合で保存し、viewport resizeで意味が変わりすぎないよう上限を設ける。
- selection hit-testはjitter後geometryを用いる。
- exportにも同じseedを使う。

compatibility profileで`Jittering`を表示しても、exact互換を示す表現は避け、`再構成方式`のTagを出す。

---

## 13. visual design

### 13.1 theme

Ant Designの`ConfigProvider`とdesign tokensを使う。raw hex colorをcomponentごとに散在させない。

application semantic tokens：

```ts
type PCPThemeTokens = {
  plotBackground: string;
  axisStroke: string;
  axisLabel: string;
  contextLine: string;
  selectedHalo: string;
  hoverHalo: string;
  excludedLine: string;
  groupPalette: string[];
  brushStroke: string;
  brushFill: string;
};
```

`theme.useToken()`からbase tokenを取得し、plot専用tokenへ変換する。

### 13.2 line layer

|状態|描画|
|---|---|
|Context|細線、低opacity、最背面|
|Group|group color、contextより高opacity|
|Selected|元のgroup colorを維持し、外側haloと太線で強調|
|Hover／Identified|最前面、別halo、endpoint marker|
|Excluded|通常は描画しない。History preview時だけ破線等で一時表示|

selectedを単に赤へ上書きするとgroup identityが失われる。group color＋selection haloの2重strokeとする。

### 13.3 色だけに依存しない

- selectedはline widthとhaloでも示す。
- hoverはendpoint markerを追加する。
- group legendにlabelとcountを出す。
- high contrast modeを用意する。
- original red／cyan配色は`DAVIS 2005 visual profile`としてoptionalにし、defaultにしない。

### 13.4 animation

- axis reorder transitionは150〜250ms程度の短時間とする。
- reduced motion設定では即時切替にする。
- dense linesを常時揺らす、pulseさせる等の装飾は行わない。
- selection feedbackはopacity／layer切替を中心にする。

### 13.5 tickとlabel

- continuous axis：min、max、必要に応じ中間ticks
- discrete numeric：重なりを避けたticks
- categorical：明示category labels
- long label：ellipsis＋tooltip
- unitがある場合はlabel直下またはinspectorへ表示
- number formatはdataset localeから独立した明示設定とする

MVPは数値軸を優先し、category displayを未完成のまま「互換済み」としない。

---

## 14. アクセシビリティ

目標はWCAG 2.2 AAである。

### 14.1 keyboard

- 全toolbar controlをTabで到達可能にする。
- `Segmented`は実radio groupとしてarrow key操作可能にする。
- axis reorderにdrag不要のmenu actionを用意する。
- panel resizeにcollapse／expand buttonを用意する。
- Escapeでbrush cancel、popover close。
- Ctrl／Cmd＋ZでUndo、Shift＋Ctrl／Cmd＋ZでRedo。
- shortcutはHelp内で一覧化し、文字1キーだけのglobal shortcutを既定で使わない。

### 14.2 focus

- Ant Designのfocus styleを消さない。
- custom SVG handleにはvisible focus ringを描く。
- canvas自体にfocusable containerとaccessible nameを持たせる。
- tooltipだけに情報を閉じ込めない。

### 14.3 drag alternative

WCAG 2.2のDragging Movementsを考慮し、次をdrag以外でも実行可能にする。

- axis move
- panel collapse／restore
- selection set operation
- file selection

PCPのfreehand brushそのものはpointer固有であるため、同等のaxis range formとData Table selectionを代替手段として提供する。

### 14.4 plotの代替表現

- Data Tableを常時利用可能にする。
- current axis orderとselected countをscreen reader live regionへ通知する。
- `選択された37行。Active 150行。`のようなstatus messageを出す。
- Summary tabに変数ごとのmin、max、median、missing等をtextで出す。
- line一本ごとのscreen reader読み上げは行わず、Identifyしたrowだけを詳細化する。

### 14.5 target sizeとcontrast

- pointer targetは原則32×32 CSS px以上、最低24×24を下回らない。
- text contrastは4.5:1以上を目標とする。
- UI component stateとfocus indicatorは背景に対して3:1以上を確認する。

---

## 15. frontend architecture

### 15.1 directory案

```text
frontend/
  src/
    app/
      App.tsx
      store.ts
      routes.tsx
    components/
      shell/
      command-bar/
      variable-panel/
      inspector/
      linked-views/
    features/
      dataset/
      analysis/
      selection/
      pcp/
      history/
      jobs/
    pcp-renderer/
      geometry/
      layers/
      interaction/
      workers/
      scales/
      jitter/
    api/
      generated/
      arrow/
    theme/
      tokens.ts
    tests/
```

### 15.2 component tree

```text
<App>
  <ConfigProvider>
    <AntdApp>
      <ProjectHeader />
      <AnalysisCommandBar />
      <WorkspaceSplitter>
        <VariablePanel />
        <PCPViewport />
        <InspectorPanel />
      </WorkspaceSplitter>
      <LinkedViewsSplitter>
        <LinkedViewTabs />
      </LinkedViewsSplitter>
      <StatusBar />
    </AntdApp>
  </ConfigProvider>
</App>
```

### 15.3 state slices

|slice|主なstate|
|---|---|
|`datasetSlice`|dataset ID、schema、column metadata、row identity、fingerprint|
|`pcpSlice`|visible columns、orientation、order mode、computed order、manual order、scales、reverse、jitter、render config|
|`analysisSlice`|active set handle、selected set handle、groups、identified row|
|`historySlice`|undo stack、redo stack、command metadata|
|`uiSlice`|panel sizes、active tabs、drawer、theme、density、help state|
|`jobsApi`|import、ordering、summary、export job|

### 15.4 大規模selectionの持ち方

巨大な`rowId[]`をReduxへ毎回格納しない。

- backendのstable row IDと、ブラウザ内の0始まり`rowOrdinal`を分ける。
- Worker内に`Uint32Array`またはbitsetとしてactive／selected membershipを保持する。
- Reduxにはserializableなsnapshot descriptorだけを置く。

```ts
type SelectionSnapshot = {
  id: string;
  version: number;
  count: number;
  sourceViewId: string;
  operation: 'replace' | 'add' | 'subtract' | 'toggle';
  createdAt: string;
};
```

ビューはsnapshot versionを購読し、bitsetをSharedArrayBufferまたはtransferable bufferで受け取る。SharedArrayBufferが使えない環境ではcopy fallbackとする。

### 15.5 command model

```ts
type AnalysisCommand =
  | { type: 'selection/commit'; before: string; after: string; source: string }
  | { type: 'analysis/focus'; beforeActive: string; afterActive: string }
  | { type: 'analysis/exclude'; beforeActive: string; afterActive: string }
  | { type: 'analysis/resetActive'; beforeActive: string; afterActive: string }
  | { type: 'groups/assign'; groupId: string; rows: string }
  | { type: 'pcp/setAxisOrder'; before: string[]; after: string[]; method: string };
```

pointer moveやhoverはcommand historyへ入れない。pointer upで確定したselectionを1 commandとする。

### 15.6 linked updateのtransaction

各commitに`transactionId`を付ける。

```text
selection command
  -> Selection Engine computes bitset
  -> Redux snapshot version increments
  -> PCP selector updates
  -> Table controlled selectedRowKeys updates
  -> BoxPlot data transform updates
  -> status live region updates
```

view Aがview Bへ直接selection eventを再送しないため、loop suppression flagは不要になる。

### 15.7 Worker分担

- polyline geometry生成
- min-max display normalization
- deterministic jitter
- brush exact hit-test
- adaptive sampling
- line ordering buffer生成
- large selection set演算

DOM／Ant Design component stateはmain threadに残す。

### 15.8 renderer adapter

```ts
interface PCPRenderer {
  setData(data: PCPColumnarData): void;
  setAxes(axes: AxisSpec[]): void;
  setMembership(state: MembershipBuffers): void;
  resize(width: number, height: number, dpr: number): void;
  render(reason: RenderReason): void;
  hitTest(input: BrushInput): Promise<SelectionResult>;
  exportBitmap(options: ExportOptions): Promise<Blob>;
}
```

Canvas 2D実装を最初に作り、WebGL実装を同interfaceへ追加できるようにする。

---

## 16. Python backend architecture

### 16.1 構成

```text
backend/
  app/
    main.py
    api/
      datasets.py
      orderings.py
      sessions.py
      summaries.py
      exports.py
      jobs.py
    domain/
      models.py
      commands.py
      evidence.py
    services/
      import_service.py
      dataset_service.py
      ordering_service.py
      session_service.py
      export_service.py
    algorithms/
      no_order.py
      permutation_davis.py
      component_davis.py
      modern/
    storage/
      workspace_repository.py
      arrow_repository.py
    workers/
      process_pool.py
    tests/
```

### 16.2 責務分担

|領域|backend|browser|
|---|---|---|
|file parse／schema inference|主担当|Wizard表示|
|axis ordering|主担当|job要求、結果表示|
|summary statistics|主担当|表示|
|PCP line rendering|data供給|主担当|
|hover／brush preview|なし|主担当|
|brush確定|小〜中規模はbrowser。巨大dataはbackend option|主担当|
|Focus／Exclude set演算|browser即時、backendへcheckpoint|主担当|
|session保存|主担当|state送信|
|export|高解像度／CSVはbackend、viewport PNGはbrowser|双方|

すべてをWebSocketで同期しない。長時間jobのprogressとcancelだけにWebSocketを使い、通常APIはRESTとする。

### 16.3 data import pipeline

```text
UploadFile
  -> file type validation
  -> parser probe
  -> schema inference
  -> stable row ID assignment
  -> Polars LazyFrame / DataFrame
  -> canonical Parquet or Arrow cache
  -> metadata JSON
  -> dataset fingerprint
```

- serverは既定で`127.0.0.1`へbindする。
- 外部serviceへデータを送信しない。
- filenameだけでformatを信用せず、contentも検査する。
- upload limitとtemporary storage quotaをconfig化する。
- CSV exportではformula injectionを避ける。

### 16.4 row identity

優先順位：

1. ユーザー指定のunique ID column
2. import時に検証できたunique候補
3. generated immutable row ID

generated IDはrow orderから直接再計算せず、canonical datasetへ保存する。sort、Focus、Exclude後もidentityを保つ。

### 16.5 data transport

#### JSON

- dataset metadata
- column metadata
- algorithm parameters／result
- session state
- job status
- error details

#### Arrow IPC

- visible numeric columns
- row ID／row ordinal
- group labels
- optional active／selected flags

CSVをbrowserへそのまま再送して解析させない。PythonとJavaScript間の大量列データをcolumnar形式で渡す。

### 16.6 API案

|method|path|用途|
|---|---|---|
|POST|`/api/v1/datasets/import`|file upload、import job作成|
|GET|`/api/v1/datasets/{dataset_id}`|metadata|
|PATCH|`/api/v1/datasets/{dataset_id}/schema`|type／role override|
|POST|`/api/v1/datasets/{dataset_id}/view`|visible columnsのArrow data取得|
|POST|`/api/v1/orderings`|axis order計算|
|GET|`/api/v1/orderings/{result_id}`|結果・trace取得|
|GET|`/api/v1/jobs/{job_id}`|job status|
|WS|`/api/v1/jobs/{job_id}/events`|progress、warning、completion|
|POST|`/api/v1/summaries`|active／selected summary|
|POST|`/api/v1/sessions`|session作成|
|GET|`/api/v1/sessions/{session_id}`|session読込|
|PUT|`/api/v1/sessions/{session_id}`|versioned save|
|POST|`/api/v1/exports`|PNG、selected CSV、state export|

### 16.7 error contract

```json
{
  "error": {
    "code": "ORDERING_CONSTANT_COLUMN",
    "message": "PermuteOrderを計算できない定数列があります。",
    "details": {
      "columnIds": ["col_7"]
    },
    "evidenceClass": "MODERN-EXTENSION",
    "recoverable": true,
    "suggestedActions": [
      "定数列をordering対象から外す",
      "NoOrderを使用する"
    ]
  }
}
```

technical stack traceを通常UIへ出さず、recoverable actionを返す。

### 16.8 long-running job

- 状態：queued、running、completed、failed、cancelled
- progress：phase、completed units、total units
- cancel endpoint
- 同一dataset／parameterの結果cache
- process poolでCPU計算し、FastAPI event loopをblockしない

---

## 17. domain data model

### 17.1 Dataset

```ts
type DatasetMetadata = {
  id: string;
  name: string;
  fingerprint: string;
  rowCount: number;
  columns: ColumnMetadata[];
  rowIdentity: {
    mode: 'source_column' | 'generated';
    columnId?: string;
  };
  importedAt: string;
};
```

### 17.2 Column

```ts
type ColumnMetadata = {
  id: string;
  name: string;
  physicalType: string;
  semanticType: 'numeric' | 'categorical' | 'datetime' | 'text' | 'unknown';
  role: 'axis' | 'row_id' | 'label' | 'ignored';
  nullable: boolean;
  missingCount: number;
  uniqueCount?: number;
  min?: number;
  max?: number;
  constant: boolean;
  categories?: string[];
};
```

### 17.3 AnalysisState

```ts
type AnalysisState = {
  originalRows: SetHandle;
  activeRows: SetHandle;
  selectedRows: SetHandle;
  excludedRows: SetHandle;
  groups: GroupDefinition[];
  identifiedRowId?: string;
  historyVersion: number;
};
```

### 17.4 PCPState

```ts
type PCPState = {
  visibleColumnIds: string[];
  baselineOrder: string[];
  computedOrder?: AxisOrderResult;
  manualOrder?: string[];
  orientation: 'horizontal' | 'vertical';
  axisDirections: Record<string, 'normal' | 'reversed'>;
  scales: Record<string, ScaleSpec>;
  jitter: {
    enabled: boolean;
    mode: 'deterministic';
    seed: number;
    amplitude: number;
    target: 'discrete' | 'all';
  };
  brush: BrushSpec;
  rendering: RenderSpec;
};
```

### 17.5 Group

```ts
type GroupDefinition = {
  id: string;
  name: string;
  rowSet: SetHandle;
  colorToken: string;
  source: 'manual' | 'cluster' | 'outlier' | 'imported_class';
  createdAt: string;
};
```

selectionとgroupは独立しているため、selected group rowはgroup colorを保持したままselection haloを持つ。

---

## 18. Focus／Exclude／Undoのstate transition

### 18.1 Focus

```text
before:
  active = A
  selected = S, S ⊆ A

after:
  active = S
  selected = S
  excluded = original - S
```

### 18.2 Exclude

```text
before:
  active = A
  selected = S, S ⊆ A

after:
  active = A - S
  selected = ∅
  excluded = excluded ∪ S
```

### 18.3 Reset active rows

```text
after:
  active = original
  selected = ∅
  excluded = ∅
```

### 18.4 Undo

`DAVIS-INFERRED`

元のUndo単位は不明である。

`MODERN-EXTENSION`

- Focus、Exclude、Reset、Group assignment、axis order commitをdomain commandとしてUndo可能にする。
- hover、brush path preview、panel resizeはUndo対象外とする。
- selection commitをUndo対象に含めるかは設定可能にする。既定では最新selectionだけ`選択を戻す`として別操作にし、分析historyを大量に汚さない。
- undo stackはsession内で多段とし、上限はconfig化する。

---

## 19. 保存・再現性

### 19.1 session format

`MODERN-EXTENSION`

versioned JSONを基本とする。

```json
{
  "schemaVersion": "1.0",
  "dataset": {
    "fingerprint": "sha256:...",
    "sourceName": "cars.csv"
  },
  "pcp": {
    "visibleColumns": [],
    "orientation": "horizontal",
    "orderResultId": "...",
    "manualOrder": null,
    "axisDirections": {},
    "scales": {},
    "jitter": {
      "enabled": true,
      "seed": 12345,
      "amplitude": 0.01
    }
  },
  "analysis": {
    "activeSet": {},
    "selectedSet": {},
    "groups": []
  },
  "history": [],
  "compatibilityProfile": "modern"
}
```

### 19.2 compatibility profile

|profile|目的|
|---|---|
|`DAVIS reconstruction`|確認済み3軸順、2方向、freehand brush、保守的な表示を中心にする|
|`Modern exploration`|manual reorder、reverse、advanced scale、selection algebra、保存等を有効にする|

profileは機能の由来を整理するものであり、「完全互換」を保証する名称にしない。

### 19.3 provenance表示

Algorithm inspectorやSettingsで次のTagを使う。

- Original evidence
- Reconstructed behavior
- Modern feature

日常toolbarへすべてのTagを並べず、必要時に追跡可能な形にする。

---

## 20. performance設計

### 20.1 初期レンダリング方針

- 軸、labels、brush：SVG／DOM
- 大量polyline：Canvas 2D
- supplemental BoxPlot：ECharts Canvas
- WebGL：renderer adapter後続実装

### 20.2 adaptive rendering

`MODERN-EXTENSION`

- row数がbenchmark threshold以下ならfull render。
- 超える場合はcontext rowsをdeterministic sampleまたはdensityへ切り替える。
- selected rows、hover row、identified rowは常に全件正確に描く。
- sampling中はstatus barへ`50,000 / 1,000,000行を表示`等を明示する。
- analysis resultをsampleで計算しない。描画samplingと軸順計算対象を分離する。

### 20.3 再描画最適化

- `requestAnimationFrame`でrenderをcoalesceする。
- base、group、selection、hover layerを独立cacheする。
- selection変更だけでaxis SVGを作り直さない。
- geometryはtyped arrayで保持する。
- resize中はlow-quality preview、終了後にfull-quality renderする。
- pointer moveはstate storeへ毎回dispatchせず、local／Worker channelで処理する。

### 20.4 benchmark gate

数値は製品性能の断定ではなく、実装時の目標値とする。

|case|目標|
|---|---|
|10,000 rows×12 axesの初期plot|reference desktopで1秒以内を目標|
|selection commit後のvisible update|100ms以内を目標|
|brush preview|可能な範囲で60fps、最低30fpsを維持|
|orientation切替|500ms以内を目標|
|large dataset|sampling状態と精度を明示し、UI freezeを起こさない|

benchmark hardware、browser、datasetをrepositoryへ固定する。

---

## 21. missing valueとcategoricalの段階設計

### 21.1 元DAVISから確認できる範囲

- DAVIS全体にmissing value processがある。
- PCP画面にcategory labelsを持つ軸例がある。

PCPでのexact missing lineとcategory ordinalizationは不明である。

### 21.2 v0.1

- 数値列を正式対応とする。
- missingを含む列はvisibleにできるが、ordering前に処理方針を求める。
- category／text列はVariable Panelへ表示し、PCP axisはdisabledとする。
- unsupported理由を隠さない。

### 21.3 後続版

`MODERN-EXTENSION`

- category順をmanual、frequency、alphabetical、imported orderから選ぶ。
- missing専用laneを用意する。
- polyline gap、missing marker、row omissionを選択可能にする。
- sessionにordinal mappingを保存する。

元実装の証拠が増えた場合は、compatibility profileへ別方式を追加する。

---

## 22. loading、empty、error状態

### 22.1 loading

- data import：`Steps`＋`Progress`
- ordering：plotを残してtoolbarとinspectorにprogress
- summary：panel単位の`Skeleton`
- export：background job notification

画面全体を不必要なspinnerで覆わない。

### 22.2 empty

- no dataset：Upload empty state
- no numeric columns：Result＋schema修正導線
- no selection：Selection tabに操作説明
- all rows excluded：Result＋Undo／Reset
- fewer than 2 axes：Alert＋Variable Panelへのfocus

### 22.3 errors

- import parse error：line／column、sample、suggested encoding
- order error：constant／missing／insufficient columns
- renderer error：fallback renderer提示
- stale session：dataset fingerprint mismatchを明示
- WebSocket断：polling fallback

errorをtoastだけで消さず、回復操作をpanel内にも残す。

---

## 23. privacyとsecurity

`MODERN-EXTENSION`

- local single-user modeを第1配布形態とする。
- FastAPIは既定でlocalhost bind。
- frontend assetをCDNからruntime取得しない。
- uploaded dataを外部telemetryへ送らない。
- crash reportは明示opt-in。
- file size、temporary disk、row／column数のlimitをconfig化する。
- archive importを許可する場合はpath traversalとzip bomb対策を行う。
- CSV formula injectionをexport時にneutralizeする。
- HTML tooltipへraw cell contentをinnerHTMLで挿入しない。
- session file読込時にschema validationとversion migrationを行う。

---

## 24. testing strategy

### 24.1 algorithm tests

#### PermuteOrder

- `p=4`候補が`[1,2,4,3]`、`[2,3,1,4]`になる。
- candidate countが`floor((p+1)/2)`になる。
- custom modが0とnegativeを1〜pへwrapする。
- min-max normalizationとdistanceをfixtureで照合する。
- Irisで原典と同じ順になる。
- 全順列探索へ置換されていないことをtraceで検証する。

#### ComponentOrder

- 各iterationで最大absolute loadingを選ぶ。
- 選択列を除去してmatrixを再計算する。
- correlation inferenceでIris原典順を再現する。
- raw covariance modeはreference modeに使われない。
- sign反転したeigenvectorでも同じ列を選ぶ。
- tie、constant、NaNを明示warningにする。

### 24.2 state tests

- selectionとgroupが独立する。
- Focus、Exclude、Reset、Undoのset invariant。
- selected⊆activeを維持する。
- view sourceが異なっても同一snapshotへ収束する。
- orientation／order変更でrow identityとselectionが維持される。

### 24.3 component tests

- Orientationが実`radio` semanticsを持つ。
- Tableがcontrolled `rowSelection`で動く。
- disabled actionに理由tooltipがある。
- context menuとtoolbarが同じcommandをdispatchする。
- Splitter panel sizeが保存／復元される。
- clickable `div`が一般controlとして追加されていない。

`eslint-plugin-jsx-a11y`とTesting Libraryのrole queryをquality gateにする。

### 24.4 E2E

1. Iris CSVをimportする。
2. 4 numerical axesを表示する。
3. PermuteOrderが期待順になる。
4. brushでselectionを作る。
5. table selectionが一致する。
6. tableからselectionを変更しPCPへ戻る。
7. Focus、Exclude、Undo、Resetを行う。
8. session保存後、同じaxis order、jitter、selectionを復元する。
9. Horizontal／Vertical双方のscreenshotを比較する。

### 24.5 visual regression

- light／dark
- 1280×720、1440×900、4K
- horizontal／vertical
- no selection／selection／3 groups
- 8 axes／30 axes
- long Japanese／English labels
- high contrast／reduced motion

### 24.6 accessibility tests

- axe-core自動test
- keyboard-only E2E
- focus order
- live region message
- color contrast
- 200% zoom
- drag alternative

### 24.7 evidence conformance test

仕様表の`DAVIS-CONFIRMED` IDごとにtestまたはinspection itemを紐づける。推定仕様には`inferred` flagがAPI／session／UIのいずれかへ残ることを検証する。

---

## 25. 実装フェーズ

### Phase 0：GUI shellとcomponent policy

- React／TypeScript／Vite
- Ant Design ConfigProvider、Layout、Splitter
- Header、Command Bar、Variable／Inspector／Linked Viewの空shell
- theme token
- fake component禁止lint／review rule

完了条件：plotが空でもresize、keyboard focus、responsive drawerが動く。

### Phase 1：importとstatic PCP

- CSV／TSV import
- schema Wizard
- stable row ID
- numerical column dataをArrowで取得
- Canvas＋SVGによるNoOrder Horizontal
- Vertical切替
- Data Table表示

完了条件：同じrow identityをPCPとTableで確認できる。

### Phase 2：軸順

- PermuteOrder reference implementation
- ComponentOrder correlation-inferred implementation
- algorithm inspector
- job progress／cancel
- Iris fixture

完了条件：原典のIris軸順を再現し、推定部分をUIに明示する。

### Phase 3：linked selection

- freehand brush
- Selection Engine／Worker
- selected／context layer
- Table双方向selection
- selection count／live region

完了条件：PCPとTableのどちらから操作しても同じrow setになる。

### Phase 4：探索command

- Identify inspector
- Focus
- Exclude
- Undo／Redo
- Reset active rows
- History panel

完了条件：一連の操作後に原集合へ戻れる。

### Phase 5：Box Plotとgroup layer

- ECharts BoxPlot
- active／selected overlay
- group palette
- outlier point identify
- 2005 red／cyan profile optional

完了条件：PCPとBoxPlotでgroup／selectionの意味が一致する。

### Phase 6：性能と保存

- adaptive rendering
- Worker最適化
- session serialization
- export
- benchmark／visual regression

---

## 26. v0.1受入条件

1. `DAVIS-CONFIRMED`、`DAVIS-INFERRED`、`MODERN-EXTENSION`が仕様、API result、Algorithm inspectorで混同されない。
2. Horizontal／Verticalが動作し、画面の意味が元資料と一致する。
3. NoOrder／ComponentOrder／PermuteOrderが切り替わる。
4. PermuteOrderが原典式とIris順を再現する。
5. ComponentOrderが反復除去を実装し、correlation matrixを推定仕様として表示する。
6. Jitterがon／offでき、deterministicであることが明示される。
7. PCPでmouse brushingできる。
8. selected、context、groupが別layer／stateである。
9. Data TableとPCPが双方向にselectionを共有する。
10. Identify／Focus／Exclude／Undoが動作する。
11. 原集合へ戻れる。
12. Box Plotへselection／groupが反映される。
13. project stateを保存・復元できる。
14. 一般GUIにCSS製の偽button、偽select、偽tab、偽tableを使わない。
15. keyboard、focus、drag alternative、target sizeの基準を満たす。
16. large dataでsamplingを使う場合、対象行数を明示する。
17. runtimeで外部CDNへdatasetまたはassetを送らない。

---

## 27. 仕様トレーサビリティ

|ユーザー価値|DAVIS根拠|復元機能|現代GUI|
|---|---|---|---|
|異なる軸順で構造を発見|`P-ALGO`、`S-08`|3 order modes|Segmented／Select、Algorithm inspector|
|縦横で関係を見直す|`P-STRUCT`、`S-07`、`S-08`|Horizontal／Vertical|Orientation Segmented|
|重なりを緩和|`S-07`|Jittering|Switch＋deterministic advanced settings|
|subsetを直接選ぶ|`P-STRUCT`、`S-15`|mouse brushing|custom SVG brush＋Worker hit-test|
|他ビューで同じrowを見る|`P-STRUCT`、`S-16`〜`S-19`|linked highlighting|central Selection Engine、controlled Table、ECharts|
|対象だけへ絞る|`S-16`|Focus|選択のみ表示|
|対象を外す|`S-16`|Delete|可逆な選択を除外|
|rowを特定する|`S-16`|Identify|Selection／Record inspector|
|探索を戻す|`S-15`、`S-16`|Undo、original dataset|Undo／Redo、Reset active rows|
|cluster色を共有|`S-17`〜`S-19`|row-level group color|group layer＋legend|

---

## 28. 現時点の未解決事項

|項目|状態|実装前の方針|
|---|---|---|
|original JAR／source|未取得|clean-room implementationを維持する|
|2002査読論文全文|未取得|取得できた場合、PCP節を再照合する|
|brush exact rule|不明|推定実装にversion名を付ける|
|jitter exact rule|不明|deterministic modern methodとして分離する|
|Component similarity matrix|高信頼推定|correlation_inferredを明示する|
|missing PCP rendering|不明|MVP正式対応外|
|categorical ordinalization|不明|MVP正式対応外|
|`+Graphics`|不明|UIへ出さない|
|`Summary`|不明|modern inspectorと混同しない|
|`Update`|不明|modern live updateへ置換したことを記録する|
|Undo scope|不明|domain command historyとして定義する|
|line alpha／width|不明|visual tokenとして調整し、互換値を名乗らない|

---

## 29. 設計判断記録

### ADR-001：Ant Designを中核component systemにする

- 状態：採用
- 理由：Splitter、Table row selection、Upload、Segmented、Drawer、Form、notification等を一体系で揃え、独自CSS controlを避けられる。
- 影響：plot固有要素以外はAnt Design APIとtokenに従う。

### ADR-002：自由dockではなく固定Splitterから始める

- 状態：採用
- 理由：v0.1で操作モデルを検証する前にwindow layout自由度を増やすと、keyboard、保存、focus、testが複雑になる。
- 影響：左／中央／右＋下の4領域をresizableにする。free dockingは後続版。

### ADR-003：PCPはCanvas 2D＋SVG hybrid

- 状態：採用
- 理由：大量polylineをSVG node化せず、axisと操作handleのaccessibilityを残す。
- 影響：renderer interfaceを定義し、WebGLは差し替え可能にする。

### ADR-004：selectionはrow-level central state

- 状態：採用
- 理由：DAVISのindex array propagationを現代的に再構成し、plot間event loopを防ぐ。
- 影響：全ビューはstate projectionとなる。

### ADR-005：ComponentOrderのcorrelationは推定扱い

- 状態：採用
- 理由：Iris原典図を再現するが、原文にmatrix定義がない。
- 影響：API、session、UIに`DAVIS-INFERRED`を残す。

### ADR-006：Deleteを可逆なExcludeとして表示する

- 状態：採用
- 理由：元の物理削除有無が不明で、現代GUIでは誤解とデータ損失を避ける必要がある。
- 影響：tooltipにDAVIS原語を併記し、permanent deleteは実装しない。

### ADR-007：大規模selection bitsetをReduxへ直接置かない

- 状態：採用
- 理由：serializabilityとrender performanceを保つ。
- 影響：Worker内set repositoryとversioned descriptorを使う。

---

## 30. 実装開始時に作る最初の成果物

1. Ant Design実コンポーネントだけで構成したworkspace shell
2. 4領域Splitterのresponsive prototype
3. Irisデータを固定表示するCanvas＋SVG PCP prototype
4. Horizontal／Verticalと3 order modeを配置したcommand bar
5. Data Tableのcontrolled row selection prototype
6. fake control禁止のlint／review rule
7. 本文書のIDを参照するtest plan

この段階では、装飾的な色調整よりも、component semantics、focus、panel resize、state boundary、row identityを先に固める。

---

## 31. 次の設計ゲート

実装へ進む前に、次の3点をprototypeで確認する。

1. HorizontalとVerticalの双方で、8〜30軸を無理なく操作できるか。
2. freehand brushの推定gestureが、DAVISの「線を直接選ぶ」感覚として妥当か。
3. fixed Splitter layoutで、PCP、Table、Inspectorを同時に見ながら探索できるか。

この3点が通った後に、backend APIとrenderer最適化を固定する。特にbrush gestureは原典のexact ruleが不明であるため、静的仕様だけで確定せず、Irisとcarsデータによる操作prototypeで検証する。
