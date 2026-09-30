# Feature 035 移行・撤去台帳

[設計書](35_graph_expansion_design.md) / [検証計画](35b_graph_expansion_validation.md)

調査日: 2026-09-14。現行作業ツリーの到達可能な画面と描画実装を対象とする。SVG/Canvas検索に加え、HTML棒、色付き行列、概念木、ダイアログ内プレビューも確認した。旧テストだけに残るRelationshipsのpair-plot/facet一覧は現行対象に含めない。

## 1. 登録規則

- 本表は51件の移行単位。複合図・動的な列別/設問別の実インスタンス数とは一致しない。
- TGTの軸寄与円とStatisticsの点分布は主図と一組。全描画部分を共通配下へ含めるが、独立した拡大入口は作らない。
- graphIdは新しい識別子。旧targetIdを別名として維持しない。動的部分は安定した内部IDを使用する。
- pageKeyは実行時の正規化route。前処理Modalは起動したページのpageKeyとdatasetIdを所有者にする。
- 現行欄は接続状況であり正常動作の証拠ではない。全行の実装・実画面確認は未着手。
- 方式列は描画方式を示す。sizingの初期方針はPCP=responsive、その他=intrinsic。既存のサイズ追従が有効な図だけresponsiveへ変更可。採用した論理寸法・理由を実装記録に残す。
- 通常時に存在する操作だけを維持する。拡大のために選択機能を追加・削除しない。
- 既存の図が条件付きで存在しない場合、拡大ボタンも表示しない。解析結果が生成されてから検証する。
- 表中のソースはfrontend/src/features/を基準とする。所有ページと描画子双方の変更範囲を示す。

## 2. グラフの移行

| ID | graphId / ページ | 対象 | 方式 / 現行target | 変更予定ソース | 移行時に保持する事項 | 段階 |
|---|---|---|---|---|---|---|
| G01 | `pcp/main`<br>/pcp | 平行座標プロット | Canvas+SVG<br>pcp | [pcp/PcpPage.tsx](../fullstack/frontend/src/features/pcp/PcpPage.tsx) | 軸・ブラシ・線・スクロール。virtual寸法と可視寸法を分離 | S1 |
| G02 | `relationships/heatmap`<br>/relationships | 相関ヒートマップ | HTML<br>relationships-heatmap | [relationships/RelationshipsPage.tsx](../fullstack/frontend/src/features/relationships/RelationshipsPage.tsx) | セルから焦点ペアへの連動を維持。Colの外へhostを表示 | S1 |
| G03 | `relationships/pair`<br>/relationships | 焦点ペア散布図 | Canvas<br>relationships-facet | [relationships/RelationshipsPage.tsx](../fullstack/frontend/src/features/relationships/RelationshipsPage.tsx)<br>[relationships/RelationshipCanvas.tsx](../fullstack/frontend/src/features/relationships/RelationshipCanvas.tsx) | X/Y切替・クリック・矩形・右クリック・hoverの現行操作 | S1 |
| G04 | `distribution/boxplot`<br>/distribution | 箱ひげ図 | SVG<br>distribution | [distribution/DistributionPage.tsx](../fullstack/frontend/src/features/distribution/DistributionPage.tsx) | 表示中の箱ひげ図群を一組。列・描画設定を維持 | S2 |
| G05 | `distribution/qq`<br>/distribution | 正規Q-Qプロット | Canvas<br>qqplot | [qqplot/QQPlotView.tsx](../fullstack/frontend/src/features/qqplot/QQPlotView.tsx)<br>[distribution/DistributionPage.tsx](../fullstack/frontend/src/features/distribution/DistributionPage.tsx) | 既存の列切替・選択・hover | S2 |
| G06 | `distribution/question/{columnId}`<br>/distribution | 通常設問の回答分布棒 | HTML<br>なし | [distribution/QuestionCard.tsx](../fullstack/frontend/src/features/distribution/QuestionCard.tsx)<br>[distribution/DistributionPage.tsx](../fullstack/frontend/src/features/distribution/DistributionPage.tsx) | 設問ごと。棒と必要な分母・凡例のみ。表・設問編集を分離 | S2 |
| G07 | `distribution/ma/{groupId}`<br>/distribution | MA設問の選択率棒 | HTML<br>なし | [distribution/MultiResponseCard.tsx](../fullstack/frontend/src/features/distribution/MultiResponseCard.tsx)<br>[distribution/DistributionPage.tsx](../fullstack/frontend/src/features/distribution/DistributionPage.tsx) | 設問ごと。回答選択・ページング・分母表示を維持 | S2 |
| G08 | `statistics/histogram/{columnId}`<br>/statistics | ヒストグラム＋下部の点分布 | SVG<br>histogram-列名 | [dataset/StatisticsPage.tsx](../fullstack/frontend/src/features/dataset/StatisticsPage.tsx) | 一変数の二つの図を一組。同じインスタンスをグリッドから拡大 | S2 |
| G09 | `likert/comparison`<br>/likert | 設問別回答構成比較 | HTML<br>likert | [distribution/LikertComparisonPage.tsx](../fullstack/frontend/src/features/distribution/LikertComparisonPage.tsx) | 表示中の比較一覧を一組。設問別の追加拡大は作らない | S2 |
| G10 | `barchart/main`<br>/barchart | 対話型棒グラフ | SVG<br>barchart-container | [barchart/BarChartPage.tsx](../fullstack/frontend/src/features/barchart/BarChartPage.tsx) | 並び・縦横・集計・既存選択を維持 | S2 |
| G11 | `barchart/ma`<br>/barchart | MA属性別比較棒 | HTML<br>ma-barchart | [barchart/MultiResponseBarChart.tsx](../fullstack/frontend/src/features/barchart/MultiResponseBarChart.tsx)<br>[barchart/BarChartPage.tsx](../fullstack/frontend/src/features/barchart/BarChartPage.tsx) | 現在の設問・属性比較とページを一組。入力値を保持 | S2 |
| G12 | `fedf/main`<br>/fedf | 経験分布関数 | SVG<br>fedf-container | [fedf/FedfPage.tsx](../fullstack/frontend/src/features/fedf/FedfPage.tsx) | 図と凡例・既存の操作を維持 | S2 |
| G13 | `loess/main`<br>/loess | 散布図＋LOESS曲線 | SVG<br>loess-container | [loess/LoessPlotPage.tsx](../fullstack/frontend/src/features/loess/LoessPlotPage.tsx) | 点と曲線を一組。軸・平滑化設定・操作を保持 | S2 |
| G14 | `covariance/matrix`<br>/covariance | 共分散／相関ヒートマップ | HTML<br>状態参照のみ | [covariance/CovariancePage.tsx](../fullstack/frontend/src/features/covariance/CovariancePage.tsx) | 表示モードを保持。新しい入口を図に付与 | S2 |
| G15 | `pca/scree`<br>/pca | スクリープロット・説明分散 | SVG<br>pca-scree | [pca/ScreePlot.tsx](../fullstack/frontend/src/features/pca/ScreePlot.tsx)<br>[pca/PcaPage.tsx](../fullstack/frontend/src/features/pca/PcaPage.tsx) | 一組として拡大。選択機能を追加しない | S2 |
| G16 | `pca/biplot`<br>/pca | バイプロット | Canvas<br>pca-biplot | [pca/BiplotView.tsx](../fullstack/frontend/src/features/pca/BiplotView.tsx)<br>[pca/PcaPage.tsx](../fullstack/frontend/src/features/pca/PcaPage.tsx) | 軸切替・ベクトル表示・既存選択を維持 | S2 |
| G17 | `pca/matrix`<br>/pca | 主成分散布図行列 | Canvas<br>pca-matrix | [pca/PcaMatrixPlot.tsx](../fullstack/frontend/src/features/pca/PcaMatrixPlot.tsx)<br>[pca/PcaPage.tsx](../fullstack/frontend/src/features/pca/PcaPage.tsx) | 行列全体を一組。セル内座標と全体座標を区別 | S2 |
| G18 | `touring/main`<br>/touring | 動的投影散布図＋軸寄与円 | Canvas+SVG<br>tgt-canvas | [tgt/TgtPage.tsx](../fullstack/frontend/src/features/tgt/TgtPage.tsx)<br>[tgt/TgtCanvas.tsx](../fullstack/frontend/src/features/tgt/TgtCanvas.tsx)<br>[tgt/ProjectionCircle.tsx](../fullstack/frontend/src/features/tgt/ProjectionCircle.tsx) | 投影時刻・再生状態を保持。軸寄与円は補助図として同じ対象 | S2 |
| G19 | `mosaic/main`<br>/mosaic | ラインモザイク | Canvas<br>line-mosaic | [mosaic/LineMosaicPage.tsx](../fullstack/frontend/src/features/mosaic/LineMosaicPage.tsx)<br>[mosaic/LineMosaicCanvas.tsx](../fullstack/frontend/src/features/mosaic/LineMosaicCanvas.tsx) | 図・凡例・既存の矩形選択／右クリックを維持 | S2 |
| G20 | `clusters/pca`<br>/clusters | クラスタPCA散布図 | SVG<br>pca | [clustering/ClustersPage.tsx](../fullstack/frontend/src/features/clustering/ClustersPage.tsx) | 他のクラスタ図をアンマウントしない | S3 |
| G21 | `clusters/silhouette`<br>/clusters | シルエット図 | SVG<br>silhouette | [clustering/ClustersPage.tsx](../fullstack/frontend/src/features/clustering/ClustersPage.tsx) | クラスタ選択と長い描画面を維持 | S3 |
| G22 | `clusters/dendrogram`<br>/clusters | デンドログラム | SVG<br>dendrogram | [clustering/ClustersPage.tsx](../fullstack/frontend/src/features/clustering/ClustersPage.tsx) | 枝・葉の既存操作を維持 | S3 |
| G23 | `clusters/cobweb`<br>/clusters | Cobweb概念木 | HTML<br>cobweb-tree | [clustering/ClustersPage.tsx](../fullstack/frontend/src/features/clustering/ClustersPage.tsx)<br>[clustering/CobwebTreeViewer.tsx](../fullstack/frontend/src/features/clustering/CobwebTreeViewer.tsx) | ノードの開閉状態を保持。ツリー展開は拡大撤去と混同しない | S3 |
| G24 | `clusters/disc`<br>/clusters | DISCカテゴリ関係ヒートマップ | HTML<br>disc-matrix | [clustering/ClustersPage.tsx](../fullstack/frontend/src/features/clustering/ClustersPage.tsx)<br>[clustering/DiscCategoryMatrix.tsx](../fullstack/frontend/src/features/clustering/DiscCategoryMatrix.tsx) | クラスタ・属性選択を保持。tableタグでも対象 | S3 |
| G25 | `models/importance`<br>/models | 特徴量重要度棒 | HTML<br>feature-importance | [models/ModelsPage.tsx](../fullstack/frontend/src/features/models/ModelsPage.tsx) | 重要度方式・凡例・既存操作を維持 | S3 |
| G26 | `models/tree`<br>/models | 決定木ダイアグラム | SVG<br>tree | [models/ModelsPage.tsx](../fullstack/frontend/src/features/models/ModelsPage.tsx) | 葉選択・ツールチップ等の既存操作 | S3 |
| G27 | `ranking/metrics`<br>/ranking | 複数指標比較棒 | HTML<br>なし | [mining/FeatureRankingPage.tsx](../fullstack/frontend/src/features/mining/FeatureRankingPage.tsx) | 指標比較を一組。ランキング表は含めない | S3 |
| G28 | `ranking/mrmr`<br>/ranking | 関連度対冗長性散布図 | SVG<br>なし | [mining/FeatureRankingPage.tsx](../fullstack/frontend/src/features/mining/FeatureRankingPage.tsx) | 既存マーク操作を維持。新規選択を追加しない | S3 |
| G29 | `associations/quadrant`<br>/associations | 意外性象限散布図 | SVG<br>surprise-quadrant | [relationships/SurpriseAssociationView.tsx](../fullstack/frontend/src/features/relationships/SurpriseAssociationView.tsx) | 表示モード・ペア選択を保持 | S3 |
| G30 | `associations/heatmap`<br>/associations | 補正Vヒートマップ | HTML<br>surprise-heatmap | [relationships/SurpriseAssociationView.tsx](../fullstack/frontend/src/features/relationships/SurpriseAssociationView.tsx) | 行列のみ。ペア一覧・説明パネルは含めない | S3 |
| G31 | `robustness/tornado`<br>/robustness | 摂動トルネード棒 | HTML<br>robustness-tornado | [robustness/RobustnessPage.tsx](../fullstack/frontend/src/features/robustness/RobustnessPage.tsx) | 既存の値・色・操作を維持。スイープ数値表を分離 | S3 |
| G32 | `key-drivers/importance`<br>/key-drivers | Shapley重要度棒 | HTML<br>kda-importance | [models/kda/KeyDriverAnalysisPage.tsx](../fullstack/frontend/src/features/models/kda/KeyDriverAnalysisPage.tsx) | 既存の重要度表示を維持。比較表を分離 | S3 |
| G33 | `penalty-reward/kano`<br>/penalty-reward | Kano四象限マトリクス | SVG<br>pra-kano | [pra/PenaltyRewardPage.tsx](../fullstack/frontend/src/features/pra/PenaltyRewardPage.tsx) | 点・軸・ラベルを一組 | S3 |
| G34 | `penalty-reward/diverging`<br>/penalty-reward | 非対称インパクト棒 | HTML<br>pra-diverging | [pra/PenaltyRewardPage.tsx](../fullstack/frontend/src/features/pra/PenaltyRewardPage.tsx) | 対比棒と必要な値表示を一組 | S3 |
| G35 | `logistic/sigmoid`<br>/logistic | 予測確率・シグモイド曲線 | SVG<br>なし | [models/LogisticRegressionPage.tsx](../fullstack/frontend/src/features/models/LogisticRegressionPage.tsx) | 軸切替・既存ブラシを維持 | S3 |
| G36 | `logistic/forest`<br>/logistic | オッズ比フォレストプロット | HTML<br>なし | [models/LogisticRegressionPage.tsx](../fullstack/frontend/src/features/models/LogisticRegressionPage.tsx) | CIと基準線を一組。係数詳細表と分離 | S3 |
| G37 | `discriminant/map`<br>/discriminant | 正準判別空間マップ | SVG<br>discriminant-map | [models/DiscriminantAnalysisPage.tsx](../fullstack/frontend/src/features/models/DiscriminantAnalysisPage.tsx) | 既存のグループ・点・ブラシ操作を維持 | S3 |
| G38 | `discriminant/structure`<br>/discriminant | 構造係数バイプロット | SVG<br>なし | [models/DiscriminantAnalysisPage.tsx](../fullstack/frontend/src/features/models/DiscriminantAnalysisPage.tsx) | 独立した図として拡大。表は分離 | S3 |
| G39 | `ca/map`<br>/models/ca | 行・列カテゴリ配置図 | SVG<br>ca（結果全体） | [models/CorrespondenceAnalysisPage.tsx](../fullstack/frontend/src/features/models/CorrespondenceAnalysisPage.tsx)<br>[models/caFigure.tsx](../fullstack/frontend/src/features/models/caFigure.tsx) | 図だけへ対象縮小。軸・表示設定と図への誘導は保持 | S3 |
| G40 | `mca/individuals`<br>/models/mca | 個体図 | SVG<br>mca（結果全体） | [models/MultipleCorrespondencePage.tsx](../fullstack/frontend/src/features/models/MultipleCorrespondencePage.tsx)<br>[models/McaFigure.tsx](../fullstack/frontend/src/features/models/McaFigure.tsx) | 個体図を独立対象。非表示タブの図は開かない | S3 |
| G41 | `mca/categories`<br>/models/mca | カテゴリ図 | SVG<br>mca（結果全体） | [models/MultipleCorrespondencePage.tsx](../fullstack/frontend/src/features/models/MultipleCorrespondencePage.tsx)<br>[models/McaFigure.tsx](../fullstack/frontend/src/features/models/McaFigure.tsx) | カテゴリ図を独立対象。既存カテゴリ操作を維持 | S3 |
| G42 | `famd/individuals`<br>/models/famd | 個体図 | SVG<br>famd（結果全体） | [models/FamdPage.tsx](../fullstack/frontend/src/features/models/FamdPage.tsx)<br>[models/FamdFigure.tsx](../fullstack/frontend/src/features/models/FamdFigure.tsx) | 個体図を独立対象 | S3 |
| G43 | `famd/categories`<br>/models/famd | カテゴリ重心図 | SVG<br>famd（結果全体） | [models/FamdPage.tsx](../fullstack/frontend/src/features/models/FamdPage.tsx)<br>[models/FamdFigure.tsx](../fullstack/frontend/src/features/models/FamdFigure.tsx) | カテゴリ重心図を独立対象 | S3 |
| G44 | `famd/correlation`<br>/models/famd | 相関円 | SVG<br>famd（結果全体） | [models/FamdPage.tsx](../fullstack/frontend/src/features/models/FamdPage.tsx)<br>[models/FamdFigure.tsx](../fullstack/frontend/src/features/models/FamdFigure.tsx) | 相関円を独立対象。選択機能を追加しない | S3 |
| G45 | `famd/relations`<br>/models/famd | 変数関係図 | SVG<br>famd（結果全体） | [models/FamdPage.tsx](../fullstack/frontend/src/features/models/FamdPage.tsx) | 変数関係図を独立対象 | S3 |
| G46 | `linear-regression/diagnostics`<br>/models/linear-regression | 残差診断散布図 | SVG<br>lr-figure | [models/LinearRegressionPage.tsx](../fullstack/frontend/src/features/models/LinearRegressionPage.tsx)<br>[models/LinearRegressionFigure.tsx](../fullstack/frontend/src/features/models/LinearRegressionFigure.tsx) | 診断軸モードを保持。「図へ移動」はタブ表示後に開く | S1 |
| G47 | `factor-analysis/scree`<br>/models/factor-analysis | 固有値・平行分析スクリープロット | SVG<br>なし | [models/FactorAnalysisPage.tsx](../fullstack/frontend/src/features/models/FactorAnalysisPage.tsx) | 一つの図として拡大。分析結果の未追跡ソースを保持 | S3 |
| G48 | `factor-analysis/scores`<br>/models/factor-analysis | 因子得点散布図 | SVG<br>なし | [models/FactorAnalysisPage.tsx](../fullstack/frontend/src/features/models/FactorAnalysisPage.tsx)<br>[models/EfaScoreFigure.tsx](../fullstack/frontend/src/features/models/EfaScoreFigure.tsx) | 既存の得点選択・軸切替・データ取得を維持 | S3 |
| G49 | `conjoint/diagnostics`<br>/models/conjoint | 予測評点／確率と残差／行順の散布図 | SVG<br>cj-figure | [models/ConjointPage.tsx](../fullstack/frontend/src/features/models/ConjointPage.tsx)<br>[models/ConjointFigure.tsx](../fullstack/frontend/src/features/models/ConjointFigure.tsx) | ratings/choice/rankingを同一図のモードとして検証 | S3 |
| G50 | `preprocess/binning/{columnId}`<br>呼出元ページ内 | ビニング分布プレビュー | SVG<br>なし | [dataset/BinningModal.tsx](../fullstack/frontend/src/features/dataset/BinningModal.tsx) | 図だけを拡大。終了で外側Modalの編集中入力へ戻る | S2 |
| G51 | `preprocess/imputation/{columnId}`<br>呼出元ページ内 | 補完前後の分布比較棒 | HTML<br>なし | [dataset/ImputationModal.tsx](../fullstack/frontend/src/features/dataset/ImputationModal.tsx) | 図だけを拡大。プレビュー更新・編集状態を保持 | S2 |

## 3. 撤去・対象外

「撤去」は拡大だけを指す。通常の表・情報表示・操作・保存を削除しない。拡大の存在しない箇所は新たに追加しない。

| ID | 対象 | 所有ファイル | 処置 |
|---|---|---|---|
| X01 | データテーブル | [TablePage.tsx](../fullstack/frontend/src/features/table/TablePage.tsx) | tableの入口・FocusTarget・focused専用分岐を撤去 |
| X02 | 変数一覧・前処理変換表 | [OverviewPage.tsx](../fullstack/frontend/src/features/dataset/OverviewPage.tsx) | overview-tableの拡大撤去。前処理ダイアログと編集は維持 |
| X03 | クロス集計表 | [CrosstabPage.tsx](../fullstack/frontend/src/features/crosstab/CrosstabPage.tsx) | crosstabの拡大撤去。セル選択・残差色・設定・出力は維持 |
| X04 | KDA相関対Shapley比較表 | [KeyDriverAnalysisPage.tsx](../fullstack/frontend/src/features/models/kda/KeyDriverAnalysisPage.tsx) | kda-contrastの拡大撤去。G32は維持 |
| X05 | 感度スイープ数値表 | [RobustnessPage.tsx](../fullstack/frontend/src/features/robustness/RobustnessPage.tsx) | robustness-sweepの拡大撤去。名称は曲線でも実体はTable。曲線への作り替えはしない |
| X06 | サブグループ詳細・グループ比較・分割表/残差表 | [SubgroupMiningPage.tsx](../fullstack/frontend/src/features/mining/SubgroupMiningPage.tsx) | mining-detailの拡大撤去。group-comparison-plotも実体は表。残差の色は表の注釈として維持 |
| X07 | CA結果の表・フォーム | [CorrespondenceAnalysisPage.tsx](../fullstack/frontend/src/features/models/CorrespondenceAnalysisPage.tsx) | caの結果全体ラッパーを解体。G39だけを対象にする |
| X08 | MCA結果の表・フォーム | [MultipleCorrespondencePage.tsx](../fullstack/frontend/src/features/models/MultipleCorrespondencePage.tsx) | mcaの結果全体ラッパーを解体。G40/G41だけを対象にする |
| X09 | FAMD結果の表・フォーム | [FamdPage.tsx](../fullstack/frontend/src/features/models/FamdPage.tsx) | famdの結果全体ラッパーを解体。G42〜G45だけを対象にする |
| X10 | PCA負荷量表、記述統計表、MA統計表 | [LoadingTable.tsx](../fullstack/frontend/src/features/pca/LoadingTable.tsx)、[StatisticsPage.tsx](../fullstack/frontend/src/features/dataset/StatisticsPage.tsx)、[MultiResponseStatistics.tsx](../fullstack/frontend/src/features/dataset/MultiResponseStatistics.tsx) | 新方式の対象外。グラフ移行時に表を巻き込まない |
| X11 | 混同行列・回帰係数・診断・予測・シミュレーション結果表 | models/各Pageおよび[DiscriminantDiagnostics.tsx](../fullstack/frontend/src/features/models/DiscriminantDiagnostics.tsx) | 新方式の対象外。図への誘導は該当GraphPanelへ接続 |
| X12 | 指標カード・品質スコア・進捗・インサイト説明・順位表 | [ModernSubgroupMiningView.tsx](../fullstack/frontend/src/features/mining/ModernSubgroupMiningView.tsx)、[FeatureRankingPage.tsx](../fullstack/frontend/src/features/mining/FeatureRankingPage.tsx)、その他各ページ | グラフではない表示へ拡大を追加しない。既存グラフの棒表現に使うProgressは対象G行に従う |

用途の境界: 相関・共分散・DISC・補正Vの色付き行列は独立した可視化としてG行に含む。クロス集計・混同行列・残差表は表操作/数値参照が主用途のためX行に含む。HTMLタグ名、コンポーネント名、testIdだけで判定しない。

## 4. 共通基盤と横断的な変更先

| ファイル | 変更内容 |
|---|---|
| [main.tsx](../fullstack/frontend/src/main.tsx) | 新Provider接続、旧Provider撤去 |
| [AppShell.tsx](../fullstack/frontend/src/app/AppShell.tsx) | 旧拡大バー・focusedによる全体レイアウト分岐撤去 |
| [KeepAliveOutlet.tsx](../fullstack/frontend/src/app/KeepAliveOutlet.tsx) | route正規化・非表示状態との接続を点検。既存保持仕様は維持し、変更は必要時だけ |
| [FocusMode.tsx](../fullstack/frontend/src/features/common/FocusMode.tsx) | 全呼出元移行後削除。selection関連のdispatchそのものは削除対象ではない |
| [viz.css](../fullstack/frontend/src/theme/viz.css) | focus専用規則を撤去しGraphPanel専用CSSへ。user-selectの通常規則は保持 |
| [SelectionMenu.tsx](../fullstack/frontend/src/features/selection/SelectionMenu.tsx)、[PointerSelectionDropdown.tsx](../fullstack/frontend/src/features/selection/PointerSelectionDropdown.tsx) | 選択仕様は変更しない。popup受け口への対応が必要な場合のみ最小変更 |
| [test_focus_zoom.py](../fullstack/e2e/test_focus_zoom.py)、[test_zoom_mouse_precision.py](../fullstack/e2e/test_zoom_mouse_precision.py) | 現行対象・実座標・rowId検証へ更新 |
| frontend/tests内のFocusModeモック・専用期待値 | 削除ファイルの参照を新共通部へ更新。全てを透過モックにして座標・状態テストを無効化しない |

## 5. 実装記録の記入形式

各G行について、実装タスクに次を記録する。全行の初期状態は「未着手/未検証」。

| 対象ID | 採用sizing・論理寸法 | 既存操作の基準 | 変更ファイル/差分 | テストケース | 証拠パス | 判定 |
|---|---|---|---|---|---|---|
| Gxx | 実装時に記入 | 操作有無・単位・期待rowId集合 | 実装時に記入 | V項目との対応 | 実装時に記入 | 未検証 |

同じ描画子を使う別図もG行ごとに入口・結果生成・タブ到達を確認する。全行を一件の代表テストだけで合格にしない。新たな図がS0で見つかった場合は新IDを末尾に追加し、既存IDを付け替えない。

