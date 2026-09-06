# DAVIS-PCP 初版JAR バイトコード解析と互換アルゴリズム設計

文書ID: DAVIS-PCP-RE-001  
版: 1.0  
作成日: 2026-08-20  
対象: ユーザー提供 `davis.jar`  
目的: DAVIS 初期JARのPCP実装をバイトコードから復元し、DAVIS-PCPクローンの互換アルゴリズム仕様を確定する

---

## 0. 結論

このJARを追うことで、既存の `07_PCPクローン_現代GUI設計書.md` で未確認としていたPCPの主要挙動のかなりの部分を確定できた。

特に重要な発見は次の通りである。

1. `PermuteOrder` は全順列を探索しない。変数数を `p` とすると、Wegman/Huh型の規則で生成した `ceil(p/2)` 個だけの候補順を評価し、隣接軸間ユークリッド距離合計が最小の候補を採用する。
2. `ComponentOrder` の初版実装は論文を素直に読んだ実装と異なる。まず `R = corr(X)` を作り、さらに `PrincipalComponentAnalysis` が既定値 `useCorr=true` のため `corr(R)` を計算して固有分解する。反復時も縮約した `R` の相関を取り直す。初版互換モードではこの「二段相関」を再現する必要がある。
3. PCPの矩形ブラシは、ポリラインと矩形の交差判定ではない。各rowの「各軸上の頂点」のどれか1点が矩形内なら、そのrowをgroup `1`にする。線分だけが矩形を横切っても選択されない。
4. linked brushing の共有状態は `PlotData.index[]` というstatic int配列である。`0`はcontext、`1`は通常のbrushed group、`2+`もクラスタ等の色グループとして利用される。
5. 各plotはイベント購読ではなく独自threadで1秒ごとに共有 `index[]` を監視する。監視するのは「0の件数」と「最大group番号+1」だけなので、同じ件数のままmembershipだけ変わった場合には他plotのrepaintを検出できない。
6. `Delete` は `index==1` のrowだけをworking graphics datasetから削除する。`Focus` は `index==0` のrowを削除して、全nonzero groupを残す。
7. `Undo` は多段Undoではない。plot操作開始前に保持されている `CurrentDataSet` を `GraphicDataSet` に戻し、group indexを全0にする「解析用working setの全復帰」である。
8. `Jittering` の意図された処理は各raw cellへ `Math.random()*0.2 - 0.1`、すなわち一様乱数 `[-0.1,+0.1)` を加えること。ただし `drawLines()` 冒頭で毎回元のGraphicDataSetを再取得して `setParaData()` するため、初版JARではjitter結果が描画時に上書きされる。実装上の不具合と判断できる。
9. `User define` はメニューに存在するが、PCPのActionListener側の処理が空である。別途 `UserOrder` GUIクラスも存在するが `OK` 処理が空で、初版では完成していない。
10. 固定軸を想定した `VariableOrder.setOrder(method, fix)` も実装上破綻しており、実際のプローブでは `ArrayIndexOutOfBoundsException` となる。通常のPCPでは `fix=-1` のままなのでこの経路は使われない。

したがってDAVIS-PCPでは、アルゴリズム互換を「論文準拠」と一括りにせず、少なくとも次の2モードを分ける。

- `INITIAL_JAR_COMPAT`: このJARの実装結果を基準とする。軸順結果やvertex brush semanticsを回帰テストで固定する。
- `MODERN_CORRECTED`: DAVISの分析思想を保ちつつ、ポーリング、jitter不具合、8色制限、定数列数値不安定性等を修正する。

---

## 1. 解析対象の同一性

### 1.1 JAR情報

解析したファイル:

```text
davis.jar
SHA-256: 145caa03f070670d25343e52f04378f1094426ce5034423ddd331e910e672096
```

Manifest:

```text
Manifest-Version: 1.0
Created-By: 1.4.1_02 (Sun Microsystems Inc.)
Main-Class: davis.main.Main
```

`ParallelCoordinate.class` のclass file major versionは `46`。JAR内には727 classがあり、そのうち `davis/` 以下は352 class。Borland JBCL等の依存クラスも同梱されている。

ZIP entryのタイムスタンプは多くが2003-04-03だが、これを公式リリース日とは断定しない。本書ではユーザーが「初版」として提供したこのJARを、単に「提供初版JAR」または「initial JAR」と呼ぶ。

### 1.2 JAR内部のAbout文

`davis.main.AboutFrame` 自身にDAVISの目的と操作説明が文字列として埋め込まれている。PCPに関する記述は次の通り。

> “There are two buttons for the plot : Direction and Ordering.”

> “We can arrange the variable in 3 different methods; data base arrangement, component method arrangement, permutation arrangement.”

Dynamic Graphicsについては、`Delete`、`Focus`、`Undo`が他plotへ伝播することもAbout文で説明されている。

この内部ヘルプは「当時の意図」、バイトコードは「実際の挙動」の証拠として扱う。

---

## 2. PCPに関係するクラス地図

### 2.1 直接経路

```text
davis.plot.parallel.Para
  └─ execute()
      ├─ new ParallelCoordinate(DataSet)
      ├─ ParallelCoordinate.start()
      └─ JFrame 600×300

ParallelCoordinate
  └─ extends DavisPlot
       └─ extends PlotData
```

主要クラス:

|クラス|役割|
|---|---|
|`davis.plot.parallel.ParallelCoordinate`|PCPのUI、軸描画、polyline描画、vertex brush、orientation、ordering、jitter|
|`davis.plot.VariableOrder`|NoOrder / ComponentOrder / PermuteOrder|
|`davis.plot.DavisPlot`|矩形selection、popup、Delete/Focus/Undo、1秒polling thread、描画共通部|
|`davis.plot.PlotData`|全plot共有のstatic row group stateとGraphicDataSetアクセス|
|`davis.plot.DavisColor`|group index→8色palette|
|`davis.core.math.Statistics`|min-max正規化、相関、transpose、minmax等|
|`davis.core.math.Distance`|ユークリッド距離|
|`davis.core.math.PrincipalComponentAnalysis`|ComponentOrder内で利用する固有分解入口|
|`davis.main.DavisBeanManager`|Original / Current / Graphics のDataSet snapshot管理|
|`davis.main.ManageData`|DataSetを一時ファイルへserialize / deserialize|

### 2.2 未完成経路

`davis.plot.parallel.UserOrder` は変数選択用らしいJFrameを持つが、`okButton_actionPerformed()` は何もしない。また `ParallelCoordinate$1.actionPerformed()` の `User define` 分岐も空である。

よって初版PCPの有効なorderingは3種類だけとする。

---

## 3. 共有データモデルとlinked brushing

### 3.1 `PlotData.index[]`

`PlotData` は次のstatic stateを持つ。

```text
static int[] index
static int[] labelIndex
static String[] variables
static double[][] data
static String methodTitle
static int cluster
```

PCPのlinked stateの中心は `index[]` である。

初期化時:

```text
index = new int[rowCount]   // Java初期値なので全0
cluster = 1
```

`setIndex(int[])` では配列をそのまま共有static fieldへ代入し、

```text
cluster = max(index) + 1
```

とする。

したがってinitial JARの概念モデルは、現在の設計書にある `selectedRowIds` のboolean集合だけよりもむしろ、各rowが整数のgroup IDを持つモデルに近い。

```text
rowGroup[rowId] = 0,1,2,...
```

### 3.2 color mapping

`DavisColor` の固定paletteは以下。

|index|Java Color|
|---:|---|
|0|LIGHT_GRAY|
|1|RED|
|2|green|
|3|cyan|
|4|magenta|
|5|orange|
|6|pink|
|7|yellow|

`getColor()` は0〜7以外で `IllegalArgumentException("Index out of range")` を投げる。

つまり初版は描画上8 groupまでしか安全に扱えない。これは現代版で継承すべき制限ではない。

### 3.3 real-time interaction の実体

`DavisPlot.start()` は各plotに独立threadを作る。`run()` は次を繰り返す。

```text
while (this.thread == currentThread) {
    if (isChange()) repaint();
    sleep(1000 ms);
}
```

`isChange()` が見るのは:

1. `index[]` 内の `0` の個数
2. `max(index)+1`

だけである。

このため、例えば100行中20行がgroup 1という状態から、別の20行がgroup 1へ入れ替わっても、zero count=80、cluster count=2のままなので別plot側が変化を検知できない可能性がある。

これは「DAVISの設計思想」ではなく、初版実装の粗い同期方式である。

### 3.4 現代版への設計変換

現代版では1秒pollingは再現しない。互換対象は共有row group stateである。

推奨:

```text
RowVisualState {
    groupId: int          // legacy compatible semantic
    selected: boolean     // modern transient selection
    active: boolean
    hidden: boolean
}
```

`groupId` と transient `selected` を分ける理由は、初版の `index==1` が「brush selection」と「group/color」の両方を兼ねており、Delete等の意味がgroup番号へ結合しているからである。

初版互換操作では `selected` を確定時に `groupId=1` へ投影する。

---

## 4. PCPの描画アルゴリズム

### 4.1 初期値

`ParallelCoordinate(DataSet)` の主要初期値:

```text
eps = 1e-9
orderMethod = 0       // NoOrder
fix = -1
horizontal = true
MARGIN = 20
sx = 20
sy = 60
off = 70
lineStroke = 0.5f
```

`Para.execute()` が作るJFrame初期サイズは `600×300`。

### 4.2 描画ごとの再読込

`drawLines()` の先頭は必ず:

```text
setParaData(getData())
normalized = Statistics.standard01(getParaData())
```

`getData()` は `DavisBeanManager.getGraphicDataSet().getArray()` であり、`DataSet.getArray()` は新しい `double[][]` を作って全セルをコピーする。

したがってPCPはpaintごとにworking datasetを新しい配列として読み直し、orderingも再計算する。

### 4.3 軸値の標準化

`Statistics.standard01(double[][])` はtransposeして列単位で `standard01(double[])` を呼ぶ。

通常列では:

```text
range = max - min
normalized = (x - min) / range
```

ただしlegacy guardは独特である。

```text
if (range < 1e-4 * min) {
    range = 1
}
```

これは `abs(range)` や `abs(min)` を使っていない。したがって定数が正の場合はrange=1となるが、minが0または負の定数列では0除算からNaNになり得る。

PCP自身は標準化後の各列min/max差を調べ、`< eps` の列を `isZero=true` とし、描画位置を `0.5` に固定する。NaN経由でもminmax結果が異常値となり、結果的に中心へ寄るケースがある。

`MODERN_CORRECTED` ではこの数値バグを再現せず、`max==min` を明示判定する。

### 4.4 値域の描画

値方向には全幅/全高を使わず `scale=0.9` を使う。つまり値域の両端に各5%の余白を残す。

Horizontal:

- variable axisは縦線
- 軸は左→右
- normalized 1が上、0が下
- constant columnは0.5位置
- labelは下側で交互に約10 pxずらす

Vertical:

- variable axisは横線
- 軸は上→下
- normalized 0が左、1が右

各axisは1 pxずらした線を2本描き、見かけ上太くしている。

### 4.5 polyline色

row `r` の描画色:

```text
DavisColor.getColor(PlotData.index[r])
```

そのためbrushにより `index[r]=1` になると赤になる。

---

## 5. NoOrder

`VariableOrder.noOrder()` は単純に:

```text
[0,1,2,...,p-1]
```

を返す。

初版互換ではファイル/GraphicDataSetに存在する現在の列順をbaselineとする。

---

## 6. PermuteOrder — バイトコードで確定した実装

### 6.1 前処理

入力データを `X (n×p)` とする。

`VariableOrder.permuteOrder()` は:

```text
Z = Statistics.standard01(X)
D = Distance.euclidean(transpose(Z))
```

を計算する。

`Distance.euclidean()` は本当に平方根まで取る通常のEuclidean distanceである。

```text
D[i,j] = sqrt( Σ_k (Z[k,i] - Z[k,j])² )
```

### 6.2 p<3

`p < 3` の場合は最適化せずidentityを返す。

```text
p=1 -> [0]
p=2 -> [0,1]
```

### 6.3 候補列生成

候補数:

```text
m = floor((p+1)/2) = ceil(p/2)
```

まず1始まりの基本列 `q[0]` を作る。

```text
q[0][0] = 1
sign = -1
for i = 1 .. p-1:
    sign = -sign
    temp = q[0][i-1] + i*sign
    q[0][i] = modulo1(temp, p)
```

ここで `modulo1()` はDAVIS独自の1始まりmodulo。

```text
modulo1(0,p) = p
modulo1(p,p) = p
modulo1(a<0,p) = p + (a % p)
otherwise = a % p
```

その後、残りの候補を直前候補の各要素へ+1してwrapすることで作る。

```text
for r = 1 .. m-1:
    for j = 0 .. p-1:
        q[r][j] = modulo1(q[r-1][j] + 1, p)
```

最後に全要素から1を引き、Java配列indexへ変換する。

### 6.4 p=5の実際の候補

初版クラス自身をreflectionで実行した結果:

```text
[
  [0,1,4,2,3],
  [1,2,0,3,4],
  [2,3,1,4,0]
]
```

候補は `5! = 120` 個ではなく3個しかない。

### 6.5 評価関数

候補 `o` に対し:

```text
score(o) = Σ_{i=0}^{p-2} D[o[i], o[i+1]]
```

閉路ではないため、最後→最初の距離は加えない。

初期best scoreは `1e12`。

比較は厳密な `<` のみなので、同点なら先に生成された候補を保持する。

### 6.6 実装用擬似コード

```python
def davis_initial_permute_order(X):
    Z = legacy_standard01_columns(X)
    D = euclidean_distance_between_columns(Z)
    p = X.shape[1]

    if p < 3:
        return list(range(p))

    m = (p + 1) // 2
    candidates = [[0] * p for _ in range(m)]

    # one-based construction
    candidates[0][0] = 1
    sign = -1
    for i in range(1, p):
        sign = -sign
        temp = candidates[0][i - 1] + i * sign
        candidates[0][i] = modulo1(temp, p)

    for r in range(1, m):
        for j in range(p):
            candidates[r][j] = modulo1(candidates[r - 1][j] + 1, p)

    # convert to zero-based
    candidates = [[v - 1 for v in row] for row in candidates]

    best_index = 0
    best_score = 1e12
    for i, order in enumerate(candidates):
        score = sum(D[order[j], order[j+1]] for j in range(p-1))
        if score < best_score:  # strict
            best_score = score
            best_index = i

    return candidates[best_index]
```

### 6.7 現代版での扱い

`INITIAL_JAR_COMPAT` ではこれをそのままreference implementationにする。

`MODERN_CORRECTED` で別のTSP近似、hierarchical ordering、correlation ordering等を入れる場合は、名称を `PermuteOrder` のまま置換しない。DAVIS由来の結果と比較不能になるため、別アルゴリズム名にする。

---

## 7. ComponentOrder — 初版実装の重要な差異

### 7.1 入口

`VariableOrder.componentOrder()` はまず:

```text
R = Statistics.corr(data)
```

を計算する。

ここまでは「similarity matrixとして相関行列を作る」と解釈できる。

### 7.2 `getMaxComponent(R)` の実装

問題は次の段である。

`VariableOrder` のconstructorは:

```text
pp = new PrincipalComponentAnalysis()
```

だけであり、`setUseCorr(false)` を呼ばない。

一方 `PrincipalComponentAnalysis` constructorは:

```text
useCorr = true
```

である。

したがって `pp.setData(R); pp.getEigenVector()` は、`R` を直接固有分解するのではなく:

```text
C = corr(R)
eig(C)
```

を行う。

つまり最初のstepは実際には:

```text
R0 = corr(X)
C0 = corr(R0)
V0 = eig(C0)
```

である。

### 7.3 選択するcomponent

`getEigenVector()` の返す固有ベクトル行列の「最後の列」を使う。

```text
v[i] = eigenvectors[i][p-1]
```

初版に同梱された固有分解では、対称行列に対する固有値は小→大の順となるため、この最後列が最大固有値に対応する。

その後:

```text
abs(v)
maxIndx(abs(v))
```

で絶対値最大の変数indexを選ぶ。

`maxIndx` の比較もstrict `>` なので絶対値同点なら先頭indexが選ばれる。

### 7.4 反復

選んだindex `k` について、現在の `R` からrow `k` とcolumn `k` を削除する。

```text
R <- delete_row_and_column(R, k)
```

次のiterationも `getMaxComponent(R)` に入り、その縮約 `R` の列を「観測変数」として再度 `corr(R)` を作り固有分解する。

original column indexへの対応は `present[]` の0/1配列と `findIndex()` で復元する。

### 7.5 残り2変数の扱い

`getMaxComponent(matrix)` は列数が3未満なら即座に `0` を返す。

したがって残り2列になった時点ではPCAを行わず、残存しているうち先頭側を次に選び、最後の1列は末尾へ入る。

### 7.6 初版互換擬似コード

```python
def davis_initial_component_order(X):
    R = corr(X)
    p = R.shape[0]
    present = [1] * p
    result = []

    while len(result) < p - 1:
        q = R.shape[0]

        if q < 3:
            k_reduced = 0
        else:
            # IMPORTANT: PCA default useCorr=true
            C = corr(R)
            eigenvalues, eigenvectors = symmetric_eig_ascending(C)
            loading = abs(eigenvectors[:, -1])
            k_reduced = first_argmax_strict(loading)

        k_original = kth_present_index(present, k_reduced)
        result.append(k_original)
        present[k_original] = 0
        R = remove_row_col(R, k_reduced)

    result.append(kth_present_index(present, 0))
    return result
```

### 7.7 論文準拠版との区別

公開資料からは「similarity matrixの最大principal componentを使い、選択列を除いて反復」と読める。そこから自然に設計すると `eig(corr(X))` または `PCA(X)` を反復する実装になりやすい。

しかし初版JARは `corr(X)` を作った後、その行列に対しPCAクラスが再度 `corr()` を行っている。

したがって今後は次の名称を使い分ける。

```text
ComponentOrder / INITIAL_JAR_COMPAT
    = corr(X) -> iterative corr(R_sub) -> eig

ComponentOrder / PAPER_INTERPRETATION
    = 原典を数理的に再実装した別reference
```

両者の結果が一致すると仮定してはならない。

---

## 8. 軸固定 (`fix`) 経路の不具合

`ParallelCoordinate.fix` の初期値は `-1`。通常のUI操作ではこれを変更する処理は確認できない。

`fix > -1` の場合は `VariableOrder.setOrder(method, fix)` へ入るが、このmethodには不整合がある。

1. `reduceDataColumn(data, fix)` を作る
2. `order(reduced, method)` を呼ぶ
3. しかし `order(double[][], method)` は渡された第1引数を使わず、instance field `this.data` に対する `componentOrder()` / `permuteOrder()` を呼ぶ
4. そのため返るorder長は `p` のまま
5. 出力配列のindex 1..へp個を書こうとしてoverflowする

実際に初版classを呼んだ検証:

```text
setOrder(component, fix=2)
→ java.lang.ArrayIndexOutOfBoundsException: Index 5 out of bounds for length 5
```

よって「fixed axis ordering」は初版互換機能として提供しない。

現代版に固定軸を追加する場合は完全な `MODERN-EXTENSION` とする。

---

## 9. Mouse brushing — exact semantics

### 9.1 gesture

`DavisPlot$MouseDetect` の挙動:

- mouse press: `start_drag_selection=true`, `release=false`, start pointを保存
- drag: MotionDetectが矩形のrubber-bandを描く
- mouse release: 4方向のdragすべてに対応する正規化Rectangleを `selectionBounds` に設定
- release後 `repaint()`
- method titleを `Grouping Statistics from<plotName>` に更新

選択判定そのものはrelease handlerではなく、その後の各plotの描画コードの中で行われる。

### 9.2 PCPのhit test

HorizontalでもVerticalでも、rowごとに各axis頂点を計算し、各頂点について:

```text
if selectionBounds.contains(vertexX, vertexY):
    PlotData.index[row] = 1
```

とする。

rowは「いずれか1つのaxis vertexが矩形内ならhit」である。

重要:

```text
NOT segment-rectangle intersection
NOT polyline bounding-box intersection
NOT point-to-segment distance
```

したがって、2本の軸の中間を線分だけが通過する矩形では、その線は選択されない。

### 9.3 selectionは置換ではなく加算的

brushの前に `index[]` を0クリアする処理はない。

新しくhitしたrowだけが `1` へ書き換わり、hitしなかったrowの既存group IDは残る。

よって連続brushは実質的にgroup 1へのunionとなる。

クラスタリング等で `2+` groupを持つrowも、brush hitすると `1` に上書きされる。

### 9.4 clear selection

通常左ボタン相当（legacy modifier `16`）のdouble-clickで:

```text
start_drag_selection = false
release = false
selectionBounds = empty
setIndex(currentGraphicRowCount)
```

となり、`index[]` が全0へ戻る。

### 9.5 modern design

現代版には2種類のbrush semanticsを持たせるのがよい。

`DAVIS Vertex Brush`:

- initial JARと同じ
- rectangle内にPCP vertexが1つでもあればrow hit
- DAVIS再現/比較用途のdefault compatibility mode

`Polyline Brush`:

- `MODERN-EXTENSION`
- polyline segmentとselection geometryの交差を判定
- 見た目として線を囲ったユーザー期待へ近い

この2つを混同しない。

---

## 10. Identify / Delete / Focus / Undo

### 10.1 popup

DavisPlot共通popupには:

```text
Identify [checkbox]
-------------------
Delete
Focus
Undo
```

PCPはこれに `Jittering` checkboxを追加する。

### 10.2 Identify

初版PCPの `drawLines()` には `mouseIdentify` や `labelIndex` を参照する処理がない。

ScatterPlot、BoxPlot、Dendrogram等にはIdentify時のlabel描画処理が存在するが、PCP自体にはない。

したがってPCPで`Identify`をONにしてbrushした場合、groupingは起きてもPCP自身がrow IDを描画するとは限らない。他linked view側の表示を期待した共通機能だったと考えるのが安全である。

現代版ではPCP上に無理にラベルを散らすのではなく、Data Table / Record Inspectorへselected rowを表示する。

### 10.3 Delete

条件:

```text
start_drag_selection == true
release == true
isGrouping() == true
```

処理:

```text
ds = GraphicDataSet
for row from last to first:
    if index[row] == 1:
        ds.delete(row)
setDataSet(ds)
```

`setDataSet()` はgroup indexを新しいrow数で全0に作り直し、変更したDataSetをGraphicDataSet snapshotとして保存する。

Deleteが対象とするのは厳密に `groupId==1` だけである。

### 10.4 Focus

処理:

```text
ds = GraphicDataSet
for row from last to first:
    if index[row] == 0:
        ds.delete(row)
setDataSet(ds)
```

Focusは `index==1` だけを残すのではなく「nonzero groupをすべて残す」。

### 10.5 Undo

`undoData()`:

```text
if start_drag_selection:
    ds = getOriginalDataSet()   // 実体は DavisBeanManager.getCurrentDataSet()
    setDataSet(ds)              // GraphicDataSetへ戻す
    setIndex(ds.rowCount)       // all 0
    setLabelIndex(ds.rowCount)
    repaint()
```

ここでmethod名 `getOriginalDataSet()` は紛らわしい。実際には `DavisBeanManager.getCurrentDataSet()` を返す。

`DavisBeanManager` は `ORIGINAL`、`CURRENT`、`GRAPHICS` を別々の一時serialize fileへ保存する。各getterはdeserializeして新しいDataSetを返すので、GraphicDataSetを削除してもCurrentDataSet snapshotは残る。

よってplotのUndoは:

```text
Graphic working state -> Current analysis dataset へ全復帰
```

であり、コマンド履歴を一段戻すUndoではない。

内部About文の:

> “you can come back to the original data anytime during the Davis experimentation.”

という説明と整合する。

### 10.6 modern design

現代版では、ユーザー体験上のUndoは多段command historyにした方がよい。ただしDAVIS初版の `Undo to Current Dataset` も明示的なコマンドとして残す。

推奨名称:

```text
Undo                // modern multi-step Ctrl+Z
Reset to Base Data  // initial DAVIS Undo semantic
```

互換テストでは後者を使う。

---

## 11. Jittering — 意図されたアルゴリズムと初版不具合

### 11.1 checkbox ON

`itemStateChanged()` は `Jittering` ON時に:

```text
jittering = true
A = getData()   // GraphicDataSet.getArray() のコピー
for every cell A[r][c]:
    A[r][c] += Math.random()*2/10 - 0.1
setParaData(A)
```

すなわち:

```text
ε ~ Uniform[-0.1, +0.1)
x' = x + ε
```

である。

特徴:

- 全列同じabsolute amplitude
- raw data unit上で±0.1
- row/column型を区別しない
- seedなし
- checkboxを入れた瞬間に1回だけ乱数を生成

### 11.2 なぜ初版では持続しないか

`DataSet.getArray()` はdeep copyを返すので、上の `A` を変更してもGraphicDataSetそのものは変わらない。

さらに `drawLines()` の最初は常に:

```text
setParaData(getData())
```

である。

このため `setParaData(A)` で一時的に入れたjittered arrayは、次のpaintで元データcopyに差し替えられる。

しかも `drawLines()` 内では `jittering` flagを参照しない。

したがって初版JARでは「jitterの計算コードは存在するが、通常の再描画経路では効果を維持できない」と結論づける。

### 11.3 checkbox OFF

OFF時は:

```text
jittering = false
undoData()
setParaData(getData())
```

となる。

`undoData()` はselection開始済みならGraphicDataSetをCurrentDataSetへ戻すため、jitter OFF操作がworking filter状態まで巻き戻す可能性がある。これも現代版では再現しない。

### 11.4 modern corrected jitter

DAVISの「overplottingを散らす」という意図だけを継承し、通常モードはdeterministicにする。

```text
noise = signed_hash(rowId, columnId, jitterSeed) * amplitude(column)
```

amplitudeはraw fixed `0.1` ではなく、表示rangeまたはpixel space基準を推奨する。

ただし比較検証用に:

```text
Legacy raw jitter amplitude = 0.1
```

も持てるようにする。

---

## 12. User define とmanual ordering

PCPのOrdering menu:

```text
NoOrder
ComponentOrder
PermuteOrder
User define
```

しかしActionListenerは `"User define"` との一致判定後に何もせず、そのまま `repaint()` へ進む。

`UserOrder` classは別に存在するが:

- variable list
- selected list
- `->`, `<-`
- OK / Cancel

のGUI骨格だけで、`okButton_actionPerformed()` は空。

したがってinitial JARに「完成したmanual axis ordering」があるとは扱わない。

現代版のdrag reorderは `MODERN-EXTENSION` である。

---

## 13. 回帰テスト用fixture

初版classをJava 21上で直接ロードし、次の固定データで実行した。

```text
X =
[ 2, 9, 4, 7, 1]
[ 3, 7, 5, 6, 4]
[ 5, 8, 1, 2, 7]
[ 7, 4, 9, 5, 3]
[11, 6, 2, 8, 5]
[13, 1, 8, 3, 9]
[17, 5, 6, 9, 2]
[19, 2, 7, 1, 8]
```

初版出力:

```text
NoOrder       = [0, 1, 2, 3, 4]
ComponentOrder= [1, 3, 2, 0, 4]
PermuteOrder  = [2, 3, 1, 4, 0]
```

`p=5` のPermute candidates:

```text
[0,1,4,2,3]
[1,2,0,3,4]
[2,3,1,4,0]
```

`R=corr(X)` を `PrincipalComponentAnalysis` へ渡したときの既定 `useCorr=true` 固有値:

```text
[2.1149568772229213E-16,
 0.012739162649552977,
 0.2355628852233542,
 0.8426508645410499,
 3.9090470875860426]
```

最後の固有ベクトル:

```text
[ 0.45817660686547856,
 -0.49699887624524963,
  0.398958864823969,
 -0.42530117498742986,
  0.4505741322633584]
```

絶対値最大はindex 1なのでComponentOrderの第1軸が1になる。

このfixtureをPython reference implementationのgolden testとして採用する。

---

## 14. 既存設計書 `07_...` の未確定事項を更新する

`07_PCPクローン_現代GUI設計書.md` の以下は本解析で更新可能になった。

|旧ID|旧状態|初版JAR解析後|
|---|---|---|
|`U-001` brush形状・hit-test|未確認|矩形brush。各軸vertexの包含OR。segment交差ではない|
|`U-002` jitter分布・振幅・seed|未確認|raw cellへUniform[-0.1,+0.1)、seedなし。ただしpaint経路で消えるbugあり|
|`U-006` Identify表示先|未確認|PCP自身はIdentify描画を実装していない。共通popupだけ存在|
|`U-007` Delete意味|推定で可逆Exclude|initial JARではGraphicDataSetから `index==1` rowを実際に削除しsnapshot更新。CurrentDataSetは保持|
|`U-008` Undo履歴|未確認|多段履歴なし。CurrentDataSetへ全復帰|
|`U-012` Component similarity|高信頼推定correlation|`R=corr(X)` は確定。さらにPCA既定値により各stepで `corr(R_sub)` を固有分解する二段相関|
|`C-008` Permute tie-break|未確認|strict `<` なので同点は最初の候補|
|`C-024` Permute候補数|原典準拠|実装は `ceil(p/2)` 候補と確定|

この文書を初版挙動については `07` より新しい規範情報として扱う。

---

## 15. DAVIS-PCP実装への規範仕様

### 15.1 バックエンドに置くもの

Python側にreference implementationを置く。

```text
ordering/
  no_order.py
  davis_initial_permute.py
  davis_initial_component.py
  paper_component.py          # 必要なら別実装
  numeric_compat.py
```

APIはアルゴリズム名だけでなくvariantを返す。

例:

```json
{
  "method": "ComponentOrder",
  "variant": "initial-jar-compat",
  "order": [1, 3, 2, 0, 4],
  "evidence": "davis.jar sha256:145c...2096"
}
```

### 15.2 フロントエンドに置くもの

ブラウザ側:

- PCP vertex geometry
- `DAVIS Vertex Brush`
- hover preview
- transient selected rows
- linked state propagation

brush完了時にrow ID集合を共有storeへ同期する。

### 15.3 初版をそのまま再現しないもの

次は互換fixtureとしてテストはするが、通常UIでは不具合を継承しない。

- 1秒polling
- zero count / max groupだけのchange detection
- jitterがpaintで消える挙動
- jitter OFFでworking setがresetされる挙動
- 8色を超えると例外
- broken fixed-axis route
- no-op `User define`
- legacy constant-column division behavior

### 15.4 初版互換として必ず残すもの

- 3 ordering methodの初版結果
- Permute候補生成規則
- PermuteのEuclidean scoreとstrict tie-break
- Componentの二段相関を含む初版結果
- Horizontal / Vertical
- 0.9 value scaleの基本幾何を再現可能にすること
- rectangular vertex brush semantics
- group 0 / 1 / 2+ のrow-level coloring concept
- Delete = group 1削除、Focus = group 0削除というinitial semanticsを検証可能にすること
- CurrentDataSetへ戻るlegacy reset semantic

---

## 16. 互換性レベル

実装では次の3レベルを明示する。

### L0 — Visual resemblance

見た目だけ近い。互換性とは呼ばない。

### L1 — DAVIS interaction compatible

- shared row state
- vertex brush
- linked views
- Focus/Delete/Reset
- 3 ordering method

ユーザー体験上のDAVISクローンの最低ライン。

### L2 — Initial-JAR algorithm compatible

同じ数値データに対して:

- ComponentOrderが同じ軸順
- PermuteOrderが同じ軸順
- tie-breakが同じ
- brush hit rowが同じ
- Delete/Focus対象rowが同じ

になる。

DAVIS-PCPではL2を自動テスト対象とする。

legacyの明白なbugまで通常UIで再現する必要はない。

---

## 17. テスト設計

### Ordering golden tests

- 上記8×5 fixture
- p=1,2,3,4,5,6,7,8でPermute candidate生成を直接比較
- tie scoreを人工的に作り先頭candidateが選ばれること
- highly correlated variables
- negative-valued constant column
- zero constant column
- positive constant column

### Brush geometry tests

必ず次を分ける。

```text
A. vertex inside rectangle -> selected
B. segment crosses rectangle but all vertices outside -> NOT selected in legacy mode
C. two vertices inside -> selected once
D. repeated brush -> previous group1 remains; union
E. pre-existing group2 row brushed -> group1へ上書き
```

### Data action tests

```text
index = [0,1,2,1,0]
Delete -> group1 rowsだけ削除
Focus  -> group1 + group2 rowsを残す
Reset  -> CurrentDataSet全行へ戻りindex全0
```

### Polling compatibility test

これは通常実装には使わないが、initial behavior理解用に:

```text
A = [1,1,0,0]
B = [0,0,1,1]
```

ではzero count=2、max+1=2が同じなのでlegacy `isChange()` はmembership変更を検知できないことをfixture化しておく。

---

## 18. 設計判断

今回の逆解析によって、DAVIS-PCPを「似たPCPライブラリを作る」プロジェクトから、「初版DAVISの分析操作を検証可能な形で再実装する」プロジェクトへ一段具体化できる。

今後の実装規則は次の優先順位とする。

```text
初版JARのexact behaviorを問う場合:
    bytecode + executable golden test
        > JAR内部About文
        > 2001/2002論文
        > 2005スクリーンショット
        > 現代的推定

DAVISの設計意図を問う場合:
    論文 / About文
        > bytecode上の明白なbug
```

この区別が重要である。たとえばComponentOrderの二段相関はinitial JAR互換には必須だが、それが研究上意図されたアルゴリズムだったとはこのJARだけでは断定できない。一方、jitterがpaintで消える挙動はコードから確定できても、再現すべき「機能仕様」とはみなさない。

---

## 19. 次工程で実装するreference module

まずPythonでGUIから独立した次のpure functionsを実装し、初版JARとgolden comparisonを行う。

```text
legacy_standard01(X)
legacy_permute_candidates(p)
legacy_permute_order(X)
legacy_component_order(X)
legacy_vertex_brush(projected_vertices, rectangle)
legacy_delete(row_groups)
legacy_focus(row_groups)
```

JARをoracleとして小規模fixtureを多数生成し、Python版が同じ結果になるところまでを「アルゴリズム復元完了」とする。

その後、React/TypeScript側のPCP rendererへ接続する。

---

## 20. 解析の限界

今回確定したのは、提供されたこのJARに含まれる実装である。

まだ別版との比較が必要な事項:

- `ComponentOrder` の二段相関が後続版で修正されたか
- `Jittering` の描画上書きbugが後続版で修正されたか
- `User define` / fixed axisが後続版で完成したか
- linked updateがpollingからevent-drivenへ変わったか
- PCP Identifyが後続版で直接labelを描くようになったか

別バージョンのJARが入手できた場合は、同じclass/methodに対するbytecode diffを行うことで「初版のbug」と「DAVISとして維持された仕様」をさらに分離できる。

---

## 付録A. 初版互換で重要なclass/method

```text
davis.plot.parallel.ParallelCoordinate
  <init>
  itemStateChanged
  setParaData
  setOrdering
  drawLines

davis.plot.parallel.ParallelCoordinate$1
  actionPerformed

davis.plot.VariableOrder
  setOrder
  order
  noOrder
  componentOrder
  getMaxComponent
  permuteOrder
  setPermute
  doOrder
  totalDistance

davis.plot.DavisPlot
  run
  isChange
  undoData
  deleteData
  focusData
  isGrouping

davis.plot.DavisPlot$MouseDetect
  mousePressed
  mouseReleased
  mouseClicked
davis.plot.PlotData
  getDataSet
  getOriginalDataSet
  setDataSet
  setIndex
davis.core.math.Statistics
  standard01
  corr
  modulo
davis.core.math.Distance
  euclidean
davis.core.math.PrincipalComponentAnalysis
  getEigenVector
  getEigenValue
davis.main.DavisBeanManager
  setCurrentDataSet
  getCurrentDataSet
  setGraphicDataSet
  getGraphicDataSet
```

## 付録B. 解析対象SHA

```text
145caa03f070670d25343e52f04378f1094426ce5034423ddd331e910e672096  davis.jar
```
