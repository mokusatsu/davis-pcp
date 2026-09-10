# Feature 27 / 28 実装仕様・受入条件・引き継ぎ

状態:

- DAVIS-FEAT-027: 未着手（PCP拡張とMCA画面/APIが未登録）
- DAVIS-FEAT-028: 既存タスク記録では完了（Feature 27の共有PCP変更後に回帰再確認が必要）

引き継ぎ時点の作業ツリー:

- 確認日時: 2026-09-11 Asia/Tokyo
- branch: master
- HEAD: 13a70d5a32b8a5f1a3e9052a5aef9e6c9a6b3930
- git status: 既存の変更・未追跡を含む44行の差分があるため、引き継ぎ先は対象外ファイルを保持する

対象仕様:

- [Feature 27: PCP改善・MCA・UI安定化](../feature/27_pcp_mca_ui.md)
- [Feature 28: 列名設問文ポップアップとL1色分け](../feature/28_column_question_popup_and_l1_color.md)
- [Feature 28既存実施記録](DAVIS-FEAT-028.md)

この文書は、別エージェントが実装・検証を開始できる粒度で、現在のコードとの差分、共通契約、実装ファイル、統計定義、画面連携、受入条件、証跡を固定する。Feature 28は既存の完了記録を尊重し、Feature 27の変更で再発し得る回帰だけを明示的に再検証する。

## 0. 引き継ぎ時点の確認

### 0.1 Feature 27の現在実装

- fullstack/frontend/src/features/pcp/PcpPage.tsx には、jitterEnabled、jitterMode、jitterAmount、jitterSeed、orientation、axis順、ブラシ操作、中央Selection、KeepAlive向けの描画状態がある。
- fullstack/frontend/src/features/pcp/geometry.ts はrowIdとaxis keyを入力にした決定的ノイズを使い、pixel jitterとlegacyRaw jitterを分けている。ジッターは描画座標または正規化前の表示計算へ適用されるが、元データを変更していない。
- fullstack/frontend/src/engine/pcpRenderer.ts、graph.worker.ts、local.ts、Rust graph-coreには、PCPジオメトリ、WASM/local fallback、DPR用canvas描画、選択線、hover、軸ラベルがある。
- fullstack/frontend/src/utils/svgCoordinates.ts はgetScreenCTMを優先し、getBoundingClientRectを使うfallbackを持つ。PCPのブラシ座標はこの共通変換を使う。
- PCPはlines描画が正本であり、ribbonsまたはParallel Setsの表示モードは未実装である。
- PCPの軸ラベルはrenderer内で固定の斜め表示を行う。rotateLabelsのユーザー切替は未定義である。
- fullstack/backend/app/algorithms/models/ にmca.pyはなく、fullstack/backend/app/api/models.py にmodels/mcaルートはない。
- fullstack/frontend/src/features/mca/、McaPage、MCA route、MCA sliceは存在しない。main.tsx、KeepAliveOutlet.tsx、AppShell.tsxへMCAを登録する必要がある。
- 小標本表示はPCPの有効行数をFeature 27の定義で一貫表示する経路が未確定であり、MCA画面とPCP画面で同じeffectiveNを使う必要がある。

### 0.2 Feature 28の現在実装と記録

- tasks/DAVIS-FEAT-028.md は状態を完了とし、2026-09-09の型チェック、限定テスト33件、フロントエンド全体113件、通常/staticビルド、通常/static/Pyodideブラウザ確認を記録している。
- 保存済みCodebookColumn.labelを参照するColumnQuestionTooltip、ColumnSelect、L1ドメイン、20色パレット、PCP/Distribution/Statisticsの共有色経路が実装されている。
- fullstack/frontend/src/theme/useL1ColorDomain.ts が全データ行から欠損を除く観測コードを集計し、numeric/categoricalを問わず1〜20種類を候補にする。
- fullstack/frontend/src/theme/viz.ts のL1色とcomposedColorが、L2グループとの色相×輝度合成を担当する。
- feature/28_column_question_popup_and_l1_color.md の実装済み状態と、既存の実施記録を勝手に未完了へ戻さない。ただしPCP renderer、PcpPage、共通Select、themeを変更した場合はFeature 28の受入条件を再実行する。

### 0.3 守る境界

- 作業ツリーの既存変更をreset、clean、checkout、無関係な削除で失わない。Feature 19〜26、Feature 28の既存変更を保持する。
- Selectionの正本はfullstack/frontend/src/app/store.tsのselectionスライスである。MCA、ribbons、L1から独自の選択stateを公開しない。
- datasetId、__rowId__、dataRevision、schemaRevision、scopeHash、active/selected/sampled row、groups、hoveredRowId、KeepAliveを維持する。
- Feature 27の表示用ジッターは統計値、MCA座標、元の値、rowIdを変更しない。描画上の位置とポインタ座標の関係だけを変える。
- Feature 28の保存済みコードブック参照は現在のdatasetだけに限定し、draftColumnsや編集モーダルの一時状態を参照しない。
- 既存Ant Design、ColumnSelect、ColumnQuestionTooltip、FocusTarget、SelectionMenu、L1Legend、user-select規則を再利用する。独自ナビゲーションや別色体系を追加しない。
- local、WASM、static/Pyodide、run-production.batで結果の意味を変えない。未対応経路は明示的なunsupported状態を返し、静かに別計算へ置換しない。
- コード変更、テスト、ビルド、実ブラウザ確認を同じタスクで記録する。文書作成段階ではコードテストとビルドを実行しない。

## 1. 共通コンテキスト契約

Feature 27/28の分析・描画結果は、Feature 25で定義した共通契約を使用する。Feature 25の移行途中でも、MCAはこの形式を先に採用する。

### 1.1 AnalysisContext

リクエストに次を含める。既存APIのcamelCase/snake_caseの外部表記は保ち、内部で一つのモデルへ正規化する。

    {
      "datasetId": "dataset-uuid",
      "expectedDataRevision": 12,
      "expectedSchemaRevision": 4,
      "scope": "active",
      "rowIds": null,
      "weightColumn": null,
      "missingPolicy": "exclude"
    }

- scopeはall、active、selected、sampled、explicitのいずれかとする。
- scope=explicitのときだけrowIdsを必須にする。重複除去と安定ソートをサーバー側で行う。
- scope=sampledで使用するsampledRowWeightsをsurvey weightへ自動変換しない。
- 期待revisionが現在値と一致しなければHTTP 409、コードANALYSIS_INPUT_STALEで計算を開始しない。
- scopeHashは実際に投入したrowId集合を安定ソートして計算する。

### 1.2 ResultMeta

MCA、ribbon集計、PCP小標本判定に使った結果へ次のメタデータを付ける。

    {
      "meta": {
        "datasetId": "dataset-uuid",
        "dataRevision": 12,
        "schemaRevision": 4,
        "scope": "active",
        "scopeHash": "sha256:...",
        "scopeCount": 240,
        "effectiveN": 228,
        "missingCount": 12,
        "weightApplied": false,
        "algorithmVersion": "mca-indicator-svd-1",
        "isExplorative": false,
        "warnings": []
      }
    }

effectiveNは欠損処理後に実際の計算へ入ったrow数、scopeCountはscope解決直後のrow数とする。0を未定義値の代わりに返さない。

### 1.3 中央Selection

- MCAのrow point、category pointに対応するrowId取得、PCP ribbonのtransition選択はselectionAppliedを通す。
- 集合演算はadd、replace、subtract、toggleの既存brush operationを使用する。
- 表示モード、ジッター強度、MCA軸切替、L1列変更はSelectionを変更しない。
- hoveredRowIdはrow pointのhoverからdispatchし、PCP/Table/他ビューへ伝播する。
- データセットまたはrevisionが変わった後に、古いrowId集合を新しいdatasetへ適用しない。

<a id="feature-27-実装仕様"></a>

## 2. Feature 27 実装仕様

### 2.1 対象範囲と対象外

対象:

- PCP lines/ribbons表示切替
- 決定的ジッター、DPR、スクロール、座標変換、軸ラベル
- Select/Dropdownのportal表示
- effectiveNに基づく小標本警告
- MCAのバックエンド計算、API、フロント画面、矩形選択
- PCP、Table、MCA間のSelection、hover、KeepAlive、dataset切替
- local/WASM/static/Pyodideの計算契約

対象外:

- MCA以外の新しい次元削減法
- survey weightを使ったMCAの推論調整
- 数値列を任意にカテゴリ化する自動binning
- 3変量以上のMCAや、共同編集・権限管理
- 既存PCPの高速化を理由にした無通知の行削除、無通知のサンプリング

### 2.2 PCP状態と描画契約

PcpStateへ次を追加する。既存状態の名称、保存形式、セッション復元を壊さない。

    {
      "displayMode": "lines",
      "rotateLabels": true,
      "jitterEnabled": false,
      "jitterMode": "pixel",
      "jitterAmount": 6,
      "jitterSeed": 20020801
    }

#### 2.2.1 Lines

- 既存lines描画を既定値とする。
- jitterMode=pixelはrowId、axis key、seedから決定的な値を生成し、表示座標へ最大jitterAmount pxを加える。
- jitterMode=legacyRawはnumeric軸だけ、正規化前のraw値へ既存の±0.1相当のノイズを加える。categorical軸へraw jitterを適用しない。
- seed、rowId、axis keyが同じなら、行順、worker/main、再訪、static/localにかかわらず同じ点になる。
- 表示座標へclampしても元のvalues、統計、scopeHash、Selection rowIdは変更しない。
- pointer hitは表示後のgeometryを使う。ただしヒットした結果は元のrowIdを返す。

#### 2.2.2 Ribbons / Parallel Sets

- displayMode=ribbonsは、隣接するcategorical軸間のcategory transitionを集約して帯で描く。
- 少なくとも一つの連続numeric軸を含むときはribbonを選べないか、理由付きでlinesへ戻す。numericを暗黙にbinningしない。
- 集計単位は現在のactive/effective row集合で、transitionごとにunweightedCountを保持する。将来weight対応を追加する場合も、countとunweightedCountを分ける。
- 帯の幅は同一軸位置の合計countに対する比率で決め、categoryOrder、axisOrder、transition keyの安定順で積み上げる。
- 選択中のrowが含まれる帯は枠線、opacity、または選択色で可視化する。色だけに依存しない。
- 帯のクリックは、そのtransitionに属するrowId集合を解決し、SelectionMenuの集合演算へ渡す。部分集合を先に適用してから全件を取得する実装は禁止する。
- ribbon集計は描画用の集約であり、元のrow valuesや分析結果を変更しない。行数が多い場合も、上位だけを表示して残りを黙って捨てない。

#### 2.2.3 軸ラベルとスクロール

- rotateLabels=trueは現在の横方向の斜め表示を維持する。falseは水平表示または垂直方向の既定表示に切り替える。
- ラベルのellipsisは表示だけに適用し、Tooltip、設問文、codebook識別子は完全値を保持する。
- 軸数が多い場合はvirtual plot widthと水平scrollを使う。canvasの最大幅制限を超える1枚canvasを作らない。
- axis order、reverse、MA axis、L1/L2色、Selectionはラベル切替で変わらない。

### 2.3 座標変換、DPR、Portal

#### 2.3.1 CanvasとSVG

- canvasのCSSサイズとdevice pixel sizeをDPRで分ける。DPR 1、1.5、2、3で同じデータ点が同じCSS座標へ対応する。
- SVG overlayのpointer座標はgetScreenCTM().inverse()を優先し、detachedまたはsingular時だけgetBoundingClientRectとviewBoxのfallbackを使う。
- orientation、scrollLeft、scrollTop、FocusModeの拡大、browser zoom、hidden KeepAliveからの復帰で座標がずれない。
- DPRは座標の見た目の密度だけに使い、row値やhit thresholdの論理単位をDPR倍しない。
- WASM geometryとlocal geometryのbounds、axisPos、pointsが同一fixtureで一致する。

#### 2.3.2 Portal

- 既存ColumnSelectとAnt DesignのSelect/Dropdown/Tooltipがdocument.bodyまたは既存の最上位popup containerへ描画され、overflow:hiddenに切られない。
- optionsのvalue、search、keyboard active descendantを変えず、描画部だけに設問文を追加する。
- popup内の説明が開いても、選択、削除、上下キー、Escape、既存のSelection操作を奪わない。
- dataset切替、route移動、scroll、Escapeで開いたpopupを閉じる。

### 2.4 小標本警告

- 警告判定はeffectiveN、すなわちmissingPolicy後の実計算行数に対して行う。
- effectiveN < 30のとき、PCPとMCAの結果領域上部にAnt Design Alertを表示する。
- Alertは推定不安定性を伝え、p値や因果結論を追加しない。n=0、1など計算不能は別エラーまたはEmptyStateとする。
- scopeCount、selected row数、survey weightの合計をeffectiveNの代わりに使わない。
- row selection、jitter、L1変更だけでeffectiveNの警告が変わらない場合は、API metaと画面表示を照合する。

### 2.5 MCAの入力規則

- 通常のnominal、ordinal、binary列だけを入力対象とする。
- interval、ratio、text、identifier、label、ignoredはHTTP 422、MCA_CATEGORY_REQUIREDで拒否する。
- MA親、MA count、未解決のMA派生軸はMCA_MA_UNSUPPORTEDで拒否する。MA子列を通常のbinary列として扱う仕様を追加する場合は、別タスクでcodebookと表示名を定義する。
- row variableの順序、カテゴリの順序、value label、missingCodesは保存済みcodebookを正本とする。
- missingPolicy=excludeは選択変数のいずれかが欠損のrowを除外する。missingPolicy=include_missingは欠損理由ごとにMissing/Not applicableを明示的なカテゴリとして加える。
- 変数、カテゴリが1つしかない、effectiveN < 2、rankが0のケースは計算を成功扱いにしない。
- survey weightはFeature 27のMCAでは適用しない。weightColumnが指定された場合はMCA_WEIGHT_UNSUPPORTEDを返し、無ウェイト計算へ黙ってフォールバックしない。

### 2.6 MCAアルゴリズム

実装は外部のprince依存に固定せず、scipyまたは既存runtimeで再現できるindicator SVDを正本にする。

1. 各rowを、各変数のカテゴリが1になるindicator行列Zへ変換する。列順は変数順×codebook categoryOrderとする。
2. NをeffectiveN、Qをindicator列数としてP=Z/(N×Q)を作る。
3. row mass r=1/N、category mass c=列合計/(N×Q)を作る。
4. S = D_r^-1/2 (P - r c^T) D_c^-1/2 を作り、S=UΣV^Tへ特異値分解する。
5. 固有値はsigmaの二乗、row principal coordinatesはD_r^-1/2 U Σ、category principal coordinatesはD_c^-1/2 V Σとする。
6. contributionはmass×coordinateの二乗/固有値、cos2はcoordinateの二乗/点の全軸距離の二乗とする。0除算はnullまたは0の規則を固定する。
7. rankは有効な非零固有値の数であり、nComponentsは1以上rank以下へ検証する。要求次元がrankを超えるときはMCA_COMPONENTS_UNAVAILABLEを返す。
8. SVDの符号不定性を消すため、各軸のcategory coordinateで最大絶対値の要素を正にする。同率ならcodebook順の先頭を使う。

### 2.7 MCA API

POST /api/v1/models/mca

リクエスト:

    {
      "context": {
        "datasetId": "dataset-uuid",
        "expectedDataRevision": 12,
        "expectedSchemaRevision": 4,
        "scope": "selected",
        "rowIds": ["r-001", "r-002"],
        "weightColumn": null,
        "missingPolicy": "exclude"
      },
      "variables": ["q1", "q2", "q3"],
      "nComponents": 2,
      "includeRowCoordinates": true,
      "rowOffset": 0,
      "rowLimit": 50000
    }

レスポンス:

    {
      "status": "success",
      "meta": {
        "datasetId": "dataset-uuid",
        "dataRevision": 12,
        "schemaRevision": 4,
        "scope": "selected",
        "scopeHash": "sha256:...",
        "scopeCount": 200,
        "effectiveN": 195,
        "missingCount": 5,
        "weightApplied": false,
        "algorithmVersion": "mca-indicator-svd-1",
        "isExplorative": false,
        "warnings": []
      },
      "rank": 2,
      "eigenvalues": [0.45, 0.35],
      "explainedInertia": [0.45, 0.35],
      "explainedInertiaPercent": [45.0, 35.0],
      "categories": [
        {
          "variableId": "q1",
          "variableLabel": "Q1",
          "code": "1",
          "label": "非常に満足",
          "count": 80,
          "coordinates": [1.2, -0.5],
          "contribution": [15.2, 5.1],
          "cos2": [0.6, 0.2]
        }
      ],
      "rowCoordinates": [
        {"rowId": "r-001", "coordinates": [0.8, -0.1]}
      ],
      "rowCoordinatesTotal": 195,
      "rowCoordinatesTruncated": false,
      "excludedCounts": {"ordinaryMissing": 5}
    }

rowCoordinatesはrowLimitでページングできる。表示用ページを省略しても、rectangle selectionは同じdataset、revision、scopeHash、dimensionを指定するサーバー側のrow queryで完全なrowId集合を解決する。最初のページだけでSelectionしてはならない。

### 2.8 MCAバックエンド実装単位

- fullstack/backend/app/algorithms/models/mca.py を新設し、indicator生成、mass、SVD、座標、寄与、cos2、sign canonicalizationを純粋関数へ分離する。
- fullstack/backend/app/api/models.pyへMCARequest、MCAResponse、POST /models/mcaを追加する。
- DatasetStore、CodebookAdapter、analysis column resolverを使い、列名を表示文言から推定しない。
- row query用の補助関数を追加し、MCA結果のrow coordinatesと同じ欠損、scope、revisionを使用する。
- APIはNaN、InfinityをJSONへ出さず、未定義の座標・統計量はnullにする。
- algorithmVersionはindicatorの列順、欠損処理、SVD実装を変更したときに更新する。

### 2.9 MCAフロントエンド実装単位

- fullstack/frontend/src/features/mca/McaPage.tsxを新設する。
- main.tsxのbrowser/hash route、KeepAliveOutlet.tsxのROUTE_COMPONENTS、AppShell.tsxのANALYSIS_NAV_ITEMSへ/mcaを登録する。
- 変数選択はColumnSelectを使い、保存済み設問文、codebook label、尺度、unsupported理由を表示する。
- 結果CardにScree、Dim1/Dim2の寄与率、category point、row point、effectiveN、missingCount、warningを表示する。
- row pointは24px相当のhit領域またはnearest pointを持ち、hoverでrowIdと主要値を表示する。
- category pointのクリックは、そのcategoryに該当するscope内rowIdを取得し、現在のbrush operationでSelectionする。
- row pointのクリックはtoggleまたは選択メニューで指定したoperationを使う。矩形ブラシはSVG最上位レイヤーで表示し、pointerEvents noneを設定する。
- 既存Selectionがある場合はMCA上の点を視覚的に強調し、中央storeだけを更新して画面が変わらない状態にしない。
- 寸法切替、missingPolicy、変数変更、再実行で古い結果を破棄する。KeepAlive復帰では結果と設定を保つが、datasetId変更では安全に初期化する。
- FocusTarget、Ant Design Card/Alert/Tag、既存のTooltip、L1/L2色、キーボード操作へ揃える。

### 2.10 Feature 27受入条件

| ID | 完了条件 | 必須証跡 |
|---|---|---|
| 27-AC01 | linesが既定値として従来どおり描画され、displayMode変更でSelection、axis order、MA axisが変わらない | PcpPage/Vitest |
| 27-AC02 | jitterがrowId、axis key、seedに対して決定的で、WASM/local/worker/mainのgeometryが一致する | geometry parity fixture |
| 27-AC03 | jitterが元データ、統計値、MCA座標、scopeHashを変更せず、pointer hitは表示geometryから元rowIdを返す | unit + browser |
| 27-AC04 | pixel/legacyRawの適用軸、range、clamp、seed入力が固定され、Math.random依存がない | source audit + test |
| 27-AC05 | ribbonsがcategorical隣接軸のtransition countを全件集計し、categoryOrderとstable orderを保つ | ribbon fixture |
| 27-AC06 | ribbonのclickが完全rowId集合を解決し、Add/Replace/Subtract/ToggleとPCP/Tableへ伝播する | pointer E2E |
| 27-AC07 | continuous軸のribbonを暗黙binningせず、理由付きdisabledまたは明示エラーになる | UI/API |
| 27-AC08 | rotateLabels、ellipsis、Tooltip、水平scrollが軸多数・reverse・Focus・KeepAlive復帰で壊れない | browser |
| 27-AC09 | DPR 1/1.5/2/3、browser zoom、scroll、horizontal/verticalでbrush座標が±1 CSS px以内に一致する | coordinate test |
| 27-AC10 | Select/Dropdown/Tooltipがoverflow:hiddenに隠れず、keyboard、Escape、route/dataset切替の挙動を保つ | DOM/browser |
| 27-AC11 | effectiveN<30だけ小標本Alertを表示し、scopeCount、weight合計、jitterで誤判定しない | API/UI fixture |
| 27-AC12 | MCA APIがカテゴリ尺度、codebook order/label、missingPolicy、scope、revisionを検証する | pytest/API |
| 27-AC13 | MCA indicator SVDの固有値、座標、寄与、cos2、説明率が既知fixtureと一致する | numerical reference |
| 27-AC14 | SVD符号canonicalizationとcategory/variable順が同一入力で決定的で、local/static結果が一致する | repeated-run test |
| 27-AC15 | MCAのinvalid scale、MA、weight、空scope、rank超過、stale revisionが固有エラーになる | error matrix |
| 27-AC16 | MCA biplot、Scree、category/row hover、矩形選択、中央Selection、PCP/Table反映が動作する | Vitest + real pointer E2E |
| 27-AC17 | row coordinate pagination/truncated時もrectangle selectionが完全集合を使い、部分ページでSelectionしない | API/E2E |
| 27-AC18 | MCA routeがmain、KeepAlive、AppShellに登録され、dataset切替で古い結果とrowIdを残さない | navigation regression |
| 27-AC19 | local、WASM、static/Pyodide、run-production.batで同じMCA契約を確認し、未対応は明示する | production reports |
| 27-AC20 | 対象pytest、Vitest、TypeScript、実ポインタE2E、Feature 28回帰の証跡が保存される | .temp/feature27-28/ |

<a id="feature-28-実装仕様"></a>

## 3. Feature 28 実装仕様と再確認条件

### 3.1 保存済み設問文

- 設問文は現在datasetの保存済みCodebookColumn.labelから取得する。
- datasetIdが一致しないcodebook、draftColumns、編集途中の値、推測された仮文言は使わない。
- labelが列名と同じでも保存値が存在すれば表示する。空文字・空白だけ、未登録、取得中は追加Tooltipを表示しない。
- 列名、設問文の順で表示し、HTMLとして解釈しない。HTML風文字列はテキストとして表示する。
- 実列に対応しないPC1、Dim1、相関係数、rowId、解析方式、MA countなどへ設問文を付けない。
- 列選択、選択済みtag、Tableヘッダ、HTML/SVGラベル、Canvasのラベルhit領域、解析結果、通知、変数操作ダイアログを対象とする。
- codebook編集モーダル、CSV取込、一括貼付、value label編集などの編集用子画面は対象外とする。
- hoverは約250ms、focusは即時、Escape・scroll・route・dataset切替で閉じる。aria-describedbyとkeyboard focusを保つ。
- Selectの候補検索値、option value、active descendant、選択・削除操作は設問文表示によって変更しない。

### 3.2 L1ドメイン

- 有効な観測値の種類数が1〜20のnumeric/categorical列を候補とする。
- 0種類、21種類以上は候補外。1種類は候補に表示できるが、自動選択では複数値候補を優先する。
- 母集団はdataset全行。active、selected、sampled、Focus、表示範囲では種類数と色番号を再計算しない。
- null、undefined、NaN、Infinity、保存済みmissingCodesは除外する。
- normalizeCodeを使い、numeric 1と文字列1は同じコード、01は別コード、小数丸めと暗黙binningは行わない。
- categoryOrderに存在する観測コードを先に並べ、未掲載コードはnumericなら数値昇順、その他は決定的な自然順で追加する。
- 同じコードは行順、画面、worker/main、selection/samplingに関係なく同じ0始まりslotを持つ。
- 欠損はL1なしとして描画する。Distribution/Statisticsでは欠損グループから消さない。

### 3.3 色、L2、packed契約

- L1は固定20色、light/dark palette、コード/値ラベル凡例を使う。20色の重複なしを自動検証する。
- PcpPage、useRowColorResolver、Distribution、Statisticsは共通L1 domainのindexByCodeを使う。
- L2は既存の輝度ステップで合成し、L1の色相、L2の輝度、選択、hover、Focusの優先順位を変えない。
- packed colorのL1 0〜19、L1なし0xff、L2ビット、context sentinel 0xffffの契約を壊さない。
- L1選択はpcp.colorByを正本とし、解除はnull。手動解除をschema更新で上書きしない。選択列が失効した場合は解除して理由を一度通知し、別列へ自動乗換えしない。
- dataset切替中は旧L1 domain、旧色、旧設問文を新datasetへ一時表示しない。

### 3.4 Feature 28受入条件

| ID | 完了条件 | 必須証跡 |
|---|---|---|
| 28-AC01 | 保存済みlabel、現在dataset、draft除外、空文/未登録/同名labelの分岐が正しい | component tests |
| 28-AC02 | hover、focus、Escape、scroll、route、dataset切替、aria-describedby、keyboardが動作する | browser |
| 28-AC03 | Table、Select候補/選択tag、HTML/SVG、Canvasラベル、通知、操作ダイアログへ適用され、編集画面は除外される | coverage ledger |
| 28-AC04 | option value、search、sort、checkbox、drag、brush、Selection操作がTooltipで誤発火しない | pointer/keyboard E2E |
| 28-AC05 | numeric/categoricalの0、1、2、15、16、20、21種類、missingCodes、NaN、Infinity、空文字を正しく分類する | l1 boundary tests |
| 28-AC06 | categoryOrder、normalizeCode、numeric sort、observed-only、全行母集団が守られ、scope変更でslotが変わらない | domain tests |
| 28-AC07 | PCP、共通row color、Distribution、Statistics、worker/mainで同一codeが同一L1色になる | cross-view fixture |
| 28-AC08 | 20色、欠損色、L2輝度合成、packed bit、context sentinel、選択/hover/Focusが回帰しない | renderer tests |
| 28-AC09 | 手動解除、失効列、schema/data更新、dataset切替、Arrow共有取得が仕様どおりになる | store/API/browser |
| 28-AC10 | local/static/Pyodideと実際にrun-production.batで配信されるdistへ同じ設問文/L1結果が反映される | build/hash/browser |
| 28-AC11 | Feature 27のrenderer、PcpState、ribbon、MCA route追加後もFeature 28の全既存テストと代表ブラウザ操作が通る | regression report |

既存タスク記録にある2026-09-09の検証結果は28-AC01〜10の既存証跡として再利用できる。ただし、Feature 27実装後の28-AC11を満たすまで、共有PCP部分を含む最終完了を再宣言しない。

## 4. 変更対象ファイルと責任範囲

### 4.1 Feature 27

バックエンド:

- fullstack/backend/app/algorithms/models/mca.py（新規、MCA純粋計算）
- fullstack/backend/app/api/models.py（MCA request/response、route、row query）
- fullstack/backend/app/domain/context.py（既存共通モデルを利用。重複モデル禁止）
- fullstack/backend/tests/unit/test_mca.py、tests/api/test_mca_api.py（新規）

フロントエンド:

- fullstack/frontend/src/app/store.ts（PcpState拡張。Selection stateは変更しない）
- fullstack/frontend/src/features/pcp/PcpPage.tsx（表示モード、small-n、label toggle、ribbon入口）
- fullstack/frontend/src/features/pcp/geometry.ts、brush.ts（決定性とhit契約）
- fullstack/frontend/src/engine/pcpRenderer.ts、local.ts、graph.worker.ts（lines/ribbonsとparity）
- fullstack/frontend/src/features/mca/McaPage.tsx、mcaSlice.ts、McaPlot.tsx（新規）
- fullstack/frontend/src/main.tsx、fullstack/frontend/src/app/KeepAliveOutlet.tsx、AppShell.tsx（route/nav）
- fullstack/frontend/src/features/common/ColumnSelect.tsx、SelectionMenu.tsx（既存部品の利用または最小修正）
- fullstack/frontend/tests/mca.test.tsx、pcpFeature27.test.ts、coordinateDpr.test.ts（新規/拡張）

### 4.2 Feature 28

既存の実装を無条件に書き換えず、必要な回帰修正だけを対象にする。

- fullstack/frontend/src/features/common/ColumnQuestionTooltip.tsx
- fullstack/frontend/src/features/common/ColumnSelect.tsx
- fullstack/frontend/src/theme/useL1ColorDomain.ts
- fullstack/frontend/src/theme/useL1Selection.ts
- fullstack/frontend/src/theme/viz.ts
- fullstack/frontend/src/features/pcp/PcpPage.tsx、engine/pcpRenderer.ts
- fullstack/frontend/src/features/dataset/StatisticsPage.tsx、distribution/DistributionPage.tsx、各解析画面の列表示
- tasks/DAVIS-FEAT-028.md と既存証跡は検証記録として保持する

## 5. 実装順序

1. 開始時にbranch、HEAD、git status、Feature 28の既存証跡を記録し、既存の未コミット変更を対象外として保持する。
2. Feature 27の共通context、MCA計算fixture、WASM/localのPCP parity fixtureを先に定義する。
3. 既存PCPのjitter/DPR/hitテストを確認してからdisplayMode、rotateLabels、ribbonを追加する。既存のlinesとL1/L2色を先に壊さない。
4. MCAバックエンド、API、stale/invalid error、static/Pyodide adapterを実装する。
5. MCA画面をmain、KeepAlive、AppShellへ登録し、中央Selection、hover、Focus、実ポインタブラシを接続する。
6. Feature 27限定pytest、Vitest、TypeScript、実ポインタE2Eを通す。
7. Feature 28のTooltip/L1限定テストと既存フロント全体テストを、Feature 27変更後の同じworking treeで再実行する。
8. frontendでlicense check、tsc -b、Vite本番buildを実行する。run-production.ps1はfrontend/dist/index.htmlが存在するとbuildを省略するため、ソース変更後に明示的な本番buildを行う。
9. local/static/Pyodideを起動し、通常版・static版のMCA、PCP、Tooltip、L1を実ブラウザで確認する。配信assetと検証済みbuildのSHA256を記録する。
10. 受入条件を一つずつPass/Partial/Failで判定する。Feature 27の未達、Feature 28回帰、証跡不足が一つでもあれば完了にしない。

## 6. 必須テストと証跡

保存先は .temp/feature27-28/ とする。

- tests/feature27-backend.txt: MCA数値fixture、API、invalid、stale、row query
- tests/feature27-frontend.txt: PCP state、jitter、DPR、ribbon、MCA component
- tests/feature28-regression.txt: Tooltip、L1 boundary、shared color、Selection、dataset切替
- tests/feature27-e2e.txt: 実ポインタのMCA rectangle、ribbon click、PCP/Table反映
- reports/analysis-context-inventory.json: MCAと既存分析のcontext/meta移行状況
- reports/mca-reference.json: fixture入力、期待固有値、符号規則、誤差許容値
- reports/browser-regression.md: datasetId、revision、scope、Selection、route遷移、DPR、static/local
- reports/production.json: 実行日時、dist path、URL、build command、asset hash、未解決事項

Feature 28の既存証跡（feature28-all-tests-final.log、feature28-targeted-verified.log、feature28-build-final.log、feature28-static-final.log、feature28-browser/）は、Feature 27後に再利用または再生成したファイル名を明記する。

## 7. 停止条件

次のいずれかに当たった場合は、仕様を勝手に補完せず、変更を止めて判断事項を記録する。

- MCAのmissing policy、MA子列の扱い、survey weight対応について既存仕様と矛盾する。
- prince等の新依存追加、静的配布用runtime追加、API互換破壊が必要になる。
- ribbonで連続numeric軸を表示するための暗黙binningが必要になる。
- 既存のFeature 28色slot、packed bit、Selection契約を変えないと実装できない。
- run-production.batが参照するdistを更新できない、またはstatic/Pyodideで同じ計算を提供できない。
- 既存の未コミット変更と同じファイルの意味が衝突し、どちらを正本にするか判断できない。

停止報告には、確認済みの事実、変更ファイル、git status、判断点、選択肢、受入条件への影響を記録する。

## 8. 完了判定

Feature 27-AC01〜20とFeature 28-AC01〜11がすべてPassで、local/static/Pyodide、run-production.bat配信物、実ポインタのSelection、KeepAlive、dataset切替、既存Feature 19〜26の回帰証跡が揃った場合だけ、Feature 27/28を完了とする。

Feature 28の既存記録が完了であっても、Feature 27の共有PCP変更後に28-AC11を再確認していない場合は、Feature 28を再検証待ちとして扱う。MCAが動作しても、共通Selection、Tooltip、L1色、古い非同期結果の破棄、static配布物の確認が欠ける場合は未完了である。
