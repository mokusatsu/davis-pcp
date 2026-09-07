# DAVIS-PCP監査報告

検証日：2026年9月7日（日本時間）  
主用途：アンケート等の横断的データを対象とする探索的データ解析（EDA）  
対象：ライブラリの2026年9月6日配布 `davis-pcp-static.zip`

## 1. 結論と検証範囲

現段階では、アルゴリズムや画面を追加するより、「入力したデータを失わない」「列の意味と分析対象を一貫して引き継ぐ」「表示した条件・文章・数値が計算結果と一致する」の修正を優先する。

**公開サイトのブラウザE2E検証は未完了である。** 公開URLの取得は遮断され、指定に従ったr.jina.ai経由も取得できなかった。ローカルHTTP・file URLへのChromium遷移も `net::ERR_BLOCKED_BY_ADMINISTRATOR` となった。これをサイト側の障害とは判定していない。公開サイトと配布ZIPの同一性も未確認である。

代わりに、ZIPに実際に同梱されたPythonバックエンドとPyodide/WASMライブラリをNodeで実行した。Pythonアルゴリズムは変更していない。ブラウザの描画、ポインタ操作、IndexedDB永続化、デプロイ設定、実利用ブラウザの性能は検証対象外である。

|検証方法|実施内容と限界|
|---|---|
|同梱WASM実行|取込、行ID、マイニング、Kendall-EMM、補完、頑健性の関数を直接実行。`backend_results.json`。|
|API処理本体の隔離テスト|実際のエンドポイント関数をASTから読み出して実行。ルート登録を除き、保存先のみインメモリのテスト用ストア。HTTPやブラウザは通していない。`additional_results.json`。|
|フロント実装確認|公開用エントリJSを解析。カテゴリ判定式をJavaScriptとして実行。画面操作ではない。`frontend_excerpts.json`。|
|決定木の補助テスト|実際の関数定義をnative scikit-learn 1.8.0で実行。同梱版1.6.1そのものではない点に注意。1.6.1公式仕様とも照合。`tree_results.json`。|

不具合を狙った境界ケースをコード読解後に選定したため、以下の再現件数を「サイト全体の不具合率」と解釈してはならない。

同梱実装では、Irisの150行・4測定列・speciesの取込、同順位を含むKendall τbの+1/-1検出、定数列を含むEMM候補の除外は正常に確認できた。PCP、分布図、Mosaic、Ranking、Mining、Robustness、Models、KDA、Penalty-Reward等の画面実装は存在するが、それぞれのブラウザ動作を保証するものではない。

## 2. 優先修正事項

### A01：一意な測定値がIDと誤認され、分析列から消える【P0／同梱WASMで再現】

再現：`fixtures/unique_measurement.csv`。

```csv
income,satisfaction
100,1
200,2
300,1
```

期待：incomeとsatisfactionを分析列として保持し、必要なら内部行IDを生成する。  
実測：incomeが `__rowId__ = ["100.0","200.0","300.0"]` に転用され、income列が削除された。

原因：`probe_table` が値の一意性だけで `semanticType="identifier"` に変更し、`assign_row_identity` がその列を自動採用・削除する。

位置：`app/services/import_service.py:185`、`app/storage/dataset_store.py:138–160`、`app/api/datasets.py:127–129`。  
修正：一意性は「ID候補」の提示に限定し、自動削除しない。明示指定がない場合は内部行IDを生成する。IDとして採用した元列も任意に表示できるよう残す。`ImportOptions.rowIdColumn` の指定を実処理に接続する。

### A02：重複列名の補正で別の列を上書きする【P0／同梱WASMで再現】

再現：`fixtures/header_collision.csv`。ヘッダ `x,x_1,x`、先頭行 `1,2,3`。

期待：3列を保持するか明示エラー。  
実測：`x=[1,4]`、`x_1=[3,6]` の2列になり、元の第2列 `[2,5]` が消えた。

原因：生成した列名 `x_1` が既存名と衝突し、辞書への代入で上書きされる。  
位置：`app/services/import_service.py:222–246`。  
修正：元の全列名と生成済み列名の両方を避けて採番し、読込後に列数・全列名の一意性を検査する。

### A03：数値らしいIDの表現・精度が失われる【P1／同梱WASMで再現】

再現：`fixtures/large_id.csv`。異なるID `9007199254740992` と `9007199254740993`。

実測：両方が `9007199254740992.0` になった。数値をすべてFloat64に変換することが原因。先頭ゼロのあるIDも、整数として読まれた時点で元表現を失う。

位置：`app/services/import_service.py:133–145,240–245`。  
修正：ID・カテゴリコードは文字列として保持できるようにする。物理型推定より前に列ごとの型指定を適用する。

### A04：利用者指定の欠損コードが適用されない【P1／同梱WASMで再現】

`ImportOptions(missingTokens=["99"])` を渡して `1,99,3` を読み込んでも、99は数値のままで欠損にならなかった。

位置：`app/services/import_service.py:133–145,205–245`、`app/services/dataset_service.py:37–44`。  
修正：列別の欠損コードをパースに適用する。「無回答」「対象外」「回答拒否」等の欠損理由は別途保持し、補完対象か否かを分ける。99を一律に欠損と決めるのではなく、利用者のコードブック設定に従う。

### A05：カテゴリ型の名称不一致で「カテゴリのみ」が正しく働かない【P1／JS判定式を実行】

バックエンドが返す型は `categorical`。フロントのカテゴリ抽出式は `F==="nominal"||F==="ordinal"||F==="text"` であり、`categorical` を受理しない。実際の式を実行すると `false`。

「カテゴリのみ」の簡易選択ではカテゴリ候補が空だと全変数へフォールバックする実装があり、数値列まで選択する経路になる。変数マネージャの型フィルタも同系列の不一致を持つ。画面クリックでの確認は未実施。

位置：`assets/index-CRWRMdEb.js`。厳密な文字位置・周辺コードは `evidence/frontend_excerpts.json`。  
修正：API・Redux・描画・アルゴリズムで尺度型を共通定義にする。空集合を黙って全集合に置き換えない。

### A06：列の役割メタデータがマイニングで参照されない【P1／同梱WASMで再現】

再現：数値コードの属性age_codeと数値質問qを各100行。役割をattribute/questionと指定したメタデータを渡す。

実測：通常の `columnId` を含むスキーマでは質問2列・探索候補0・インサイト0。同じ設定から `columnId` のキーだけを除く対照では質問1列・インサイト2件。

原因：メタデータを `columnId` 優先で辞書化し、その後はDataFrameの列名で検索している。全数値列が質問として推定されると、それらすべてが条件列から除外される。

位置：`app/algorithms/mining/modern_subgroup.py:479–534`。APIは保存スキーマをそのまま渡す。  
修正：列IDと物理列名の対応を明確にする。役割指定を優先し、属性と質問を分離する。全数値のアンケートCSVを回帰テストに追加する。現在のColumnRole列挙もattribute/questionを標準化しておらず、スキーマ全体で整合させる必要がある。

### A07：表示・保存された探索条件と実際の対象行が一致しない【P1／同梱WASMで再現】

xが0.001〜0.012の12行の場合、内部の第1四分位点は0.00375。しかし返すCondition.valueは丸められた0.00。

実測：`x < 0.0` という条件に、0.001、0.002、0.003の3行が含まれた。条件を再評価すれば0行になる。異なる区間が同じラベルになり、候補重複排除にも影響し得る。

位置：`app/algorithms/mining/modern_subgroup.py:91–131`。  
修正：機械可読の閾値は元精度のまま保持し、表示文字列だけを整形する。`evaluate(rule) == coverage.row_ids` を必須テストにする。

### A08：最小集団サイズの明示指定を無断で緩める【P1／同梱WASMで再現】

再現：60行、A群10名/B群50名、`min_group_size=30`。

実測：A群10名も結果に含まれ、B群の比較対象も10名だった。`N < 3*min_group_size` の場合、内部で `max(3,N//6)` に変更される。

位置：`app/algorithms/mining/modern_subgroup.py:537–539`。  
修正：既定では指定値を厳守する。自動調整を残すなら明示的なオプションとし、実効閾値を結果に返す。人数は条件該当数だけでなく、ターゲット観測有効数を両群に表示する。

### A09：インサイトの説明文が効果方向や分散を正しく説明しない【P1／出力で再現】

平均差が-3.00の群に対し、実際の出力は `平均-3.00高く、回答がまとまっています。`。また、分散縮小がない候補にも定型文で「まとまっています」と記載する。

位置：`app/algorithms/mining/modern_subgroup.py:779–786`。  
修正：「高い／低い／差が小さい」「ばらつきが小さい／同程度／大きい」を実測値から分岐する。数値スコアを有意性や確度の意味で説明しない。

### A10：最大影響回答者を除いた平均値の符号が逆【P1／同梱WASMで再現】

再現：q=[1,2,100]。全体平均34.3333、最大影響回答者は100。

期待：100を除いた平均は(1+2)/2=1.5。  
実測：`最大個別影響回答者除外` が67.1667。

原因：KPI平均のinfluenceを「除外後−除外前」で計算しているのに、表示側で引いている。群間差のinfluenceとは符号定義も異なる。

位置：`app/algorithms/robustness/engine.py:191,242`。  
修正：influenceの定義を統一し、直接再計算したleave-one-out推定値との一致を検証する。これは一般的な頑健性理論の論争ではなく計算バグ。

### A11：補完結果を別データセットとして保存できない【P1／API本体の隔離テストで再現】

画面実装には「新しいデータセットとして保存」があり、`inPlace:false` を送る。しかしAPI処理本体は辞書であるmetaに対して `meta.name` とアクセスする。

実測：`AttributeError: 'dict' object has no attribute 'name'`。

位置：`app/api/datasets.py:354–357`。  
修正：`meta["name"]` 等へ修正するだけでなく、派生データ作成時に既存 `__rowId__` を保持する。行ID付与関数へ既存ID入りDataFrameを渡すと、ID列を削除して `ColumnNotFoundError` になることも別テストで確認した。HTTPエラー表示と画面通知は未確認。

### A12：補完を現在データへ適用すると列の意味・IDが失われる【P1／API本体の隔離テストで再現】

補完前：`columnId=col-persistent`, `semanticType=ordinal`, `role=question`, 手動カテゴリ順あり。  
補完後：新しいcolumnId、numeric、numeric_axis、manualCategories=nullになった。

原因：補完後に `probe_table` を再実行し、スキーマ全体を新規生成する。

位置：`app/api/datasets.py:338–345`。  
修正：再計算するのは欠損数・範囲等のデータ依存統計に限定する。列ID、質問役割、尺度、値ラベル、表示順を保持する。原本・補完マスク・変換履歴を残す。

### A13：「TabDiff」と原論文のアルゴリズムが一致しない【P1／コード照合＋同梱WASMテスト】

ICLR 2025の原論文は `TabDiff is parameterized by a transformer` と明記している[参考R1]。一方、同梱コードには該当するモデル学習・Transformerがなく、数値は標本平均・共分散に基づく処理、カテゴリは列単独の経験分布からの補完となっている。

実測：yのみを補完対象にすると、完全観測された説明変数xを変更しても、同じseedの補完結果は全件同一。補完する列と、条件付けに使う列が分離されていない。

さらに `wassersteinDist` は `abs(mean(observed)-mean(imputed))` であり、Wasserstein距離そのものではない。例えば分布{-1,1}と{0,0}は平均差0だが、一次Wasserstein距離は1である。

位置：`app/algorithms/imputation/tabdiff.py:62–88,120–216,236,245–265`。  
修正：独自近似法ならその名称・限界を表示し、論文手法の性能を引き継ぐような説明をしない。原論文方式を使うならモデル・重み・条件付き生成の実装を確認する。補完対象と予測変数を分離し、既知の観測値を隠した検証と、完全ケース／補完後の比較を用意する。対象外回答は自動補完しない。

### A14：「Send to Robustness」が対象の結論を引き継がない【P1／静的コード確認】

Miningからのボタンは `/robustness` へ遷移するだけ。受け側もdatasetIdとbootstrapBのみを送信する。APIは結論が未指定なら先頭の数値列等から別の結論を自動作成する。

したがって、選んだサブグループ・質問・比較条件を検証する契約が成立していない。満足度の発見から移動しても、先頭列の年齢平均等が診断対象になり得る。ブラウザ操作の再現ではなく、両側のコードを照合した指摘である。

位置：`assets/index-CRWRMdEb.js` の該当ボタンと `/robustness/evaluate` 呼出し、`app/api/robustness.py`、`app/algorithms/robustness/engine.py`。  
修正：対象列、対象行、比較群、補集合の基準集合、欠損処理、データrevisionを明示的に渡す。受け側で引き継いだ対象を表示する。

### A15：決定木のクラス人数と内部ノード所属【P2／別環境の補助テスト＋同梱版公式仕様照合】

各クラス2件の4行分類木で、根のクラス人数が0件ずつ、純粋な葉も1件と返る。`tree_.value` の割合をそのまま整数化していることが原因。scikit-learn 1.6.1公式文書の原文は `proportion of samples` [参考R2]。

また `_tree_membership` は `apply(X)` の葉IDだけから全ノードを逆引きするため、内部ノードの所属は空集合になる。現フロントは葉の選択を中心に実装しており、「内部ノードクリックが壊れている」とまでは断定しない。

位置：`app/api/models.py:86–148`。  
修正：人数は必要に応じて実ラベルから数えるか、割合×weighted_n_node_samplesで扱う。内部ノード所属が必要ならdecision_pathを使う。今回の実行環境はnative 1.8.0で、WASM同梱1.6.1での実行は行っていない。

## 3. 機能不足の優先順位

### 3.1 アンケート用の一貫した変数辞書

単なる数値／文字列ではなく、「質問か属性か」「名義／順序／数値尺度」「選択肢のコードとラベル」「順序」「逆転項目」「欠損理由」を、取込・変換・マイニング・可視化で共有する。現在はColumnSchema、ColumnRole、フロント型名、マイニングの期待値が一致していない。

最低限、`age=attribute/numeric`、`prefecture=attribute/nominal`、`Q1=question/ordinal/1…5`、`respondent_id=id/text`を、CSVに付属する小さな辞書として読めればよい。特定の重い統計パッケージへの移行は必要ない。

### 3.2 質問単位の分母と複数回答

単一回答は全対象者数・設問対象者数・有効回答数・無回答数を分ける。複数回答は0/1列の集合を一つの設問として扱い、「回答者を分母にした割合」と「選択数を分母にした割合」を区別する。One-hot変換の存在だけではこの集計契約を満たさない。

割合を100%に揃えることより、分母を明示することを優先する。複数回答の回答者比率合計が100%を超えることをエラーにしない。

### 3.3 ウェイトと母集団の区別

回答者ウェイトを列として指定し、実人数nと加重割合・加重平均を併記する機能を優先する。現実装のクラスタリングの「数値重み」や探索スコアのweightsは回答者の標本ウェイトとは別物。

調査設計に基づく推測まで行うなら、さらに層化・クラスタ・反復ウェイト等が必要となる。公式survey実装も `weights`、`strata`、`ids` を別の設計情報として扱う[参考R3]。初期EDA版で標準誤差の高度な対応を必須にする必要はないが、未対応の推測を対応済みのように表示しない。

### 3.4 原本・補完・選択集合の来歴

原データを変更せず、補完・再符号化は派生データまたは変換履歴として保持する。どのセルを補完したか、どの列の意味を変更したかを追えるようにする。

分析結果には、datasetIdだけでなく、revision、対象行集合、基準集合、質問列、欠損方針、ウェイト、乱数seedを付随させる。PCPのFocus後に別画面だけ全データへ戻るような状態を防ぐ。これは全画面を同じ見た目にする要求ではなく、分析対象を同じ意味で共有する要求である。

## 4. 統計的知見から反映すべき点

### 4.1 「少数派・極端な回答」と「不誠実な回答」を同一視しない

現在のRobustnessは先頭の数値列群の標準化偏差から `quality_vals=1/(1+dev)` を生成し、低い側を「品質下位」と呼ぶ。珍しい有効セグメントを発見するEDAと衝突し得る。

2025年のJournal of Official Statisticsの検証は、不注意と判定した回答の除去が、除去しない場合より推定を悪化させる条件を報告している。原文：`over-detecting legitimate responses` [参考R4]。これは「どんなクリーニングも不要」という主張ではない。

2026年6月公開の研究でも、11手法・6種の模擬異常パターンの比較で `No single algorithm dominated across all types.` とされる[参考R5]。これらは特定の実験条件での結果であり、普遍的なランキングではない。

提案：統計的外れ度、回答時間、注意チェック、longstring等を別々に示す。外れ値フラグだけで自動除外せず、除外前後の結論を比較する。現在の指標を残すなら「数値的外れ度に基づく感度分析」と呼ぶ方が正確。

### 4.2 Likertは順序尺度としての分析経路を維持する

τb-EMMは同順位を含むアンケートに適合する方向であり、今回の基本テストにも合格した。SciPy公式定義では `T` と `U` がそれぞれ片側だけの同順位を数える[参考R6]。

提案：平均差スコアでは「1〜5を等間隔得点とみなす」と明示し、回答分布、Top/Bottom-box、中央値、順位相関も併置する。τbとPCP線分の交差率そのものは同じ量ではなく、ジッタ後の見かけの交差をτbとして説明しない。名義コードの付け替えで結果が変わらないこと、順序尺度の表示順が保持されることを検証する。

### 4.3 探索順位・検証・因果を分ける

現代的マイニングをEDAとして、全データ探索・p/q値なしで提供する方針は維持できる。初期探索に強制holdoutや大規模bootstrapを追加することは、本レビューの必須修正ではない。

ただし「順位が高い」「同じ探索データで差が大きい」「別データでも再現する」「施策で改善できる」は別の主張。信頼区間やRobustnessを後付けしても、探索全体や因果推論まで検証したことにはならない。任意の検証モードは、選択したルールと基準集合を固定して受け渡す。

### 4.4 特徴重要度は指標を混ぜず、何に対する重要度か表示する

現在のRankingは、同じ訓練データで求めたPermutation ImportanceとMDIを平均して返す経路がある。両者は同じ尺度ではないため、平均値を標準的な重要度と見せない。位置：`app/algorithms/mining/feature_ranking.py:309–326`。

scikit-learn公式文書も、重要度を `for a particular model` と説明し、汎化への寄与はholdoutでの評価と区別している[参考R7]。

提案：MDIとPermutation Importanceを別表示し、「訓練データ内」か「検証データ」かを明記する。予測性能を訴求するモードには小さな検証セットまたは交差検証を付けるが、すべての探索操作をそれでブロックしない。KDA/Penalty-Rewardの予測上の関連を施策の因果効果と説明しない。

### 4.5 新手法の名称より、原論文との適合性と実データでの検証を優先する

TabDiffの不一致はA13の通り。2026年のDISC論文にもカテゴリ関係を学習する設計があるが、本レビューではその原式と同梱DISCの全実装の同等性までは検証していない[参考R8]。搭載済みという理由だけで論文の性能数値を引き継がない。

「原論文準拠」「独自近似」「可視化用ヒューリスティック」を分け、バージョン、乱数、前処理、評価条件を記録する。古い確実な方法を明示して使う方が、新しい手法名で異なる計算をするより実務上安全である。

## 5. 追加の静的確認事項

- 親子ルールのID：diversity選択中に親のidを参照するが、id付与は後段の整形処理。`parent_insight_id` が付かない経路がある。位置：modern_subgroup.py:438,752–766。表示上の例外親子リンクは未操作。
- 多様性閾値：全モードに既定値0.3の生の差を使い、数値モードでの全体SDによる尺度調整、二値割合の専用閾値等が実装仕様と一致していない。単位変更で選択候補が変わる可能性は未実行検証。
- 探索範囲：EMMの自動対象は先頭8質問の組合せから先頭15ペア。全質問ペアを見たわけではない。未探索対象と制限を表示する。列順を変えると対象が変わるため、単なる「有力ペア自動抽出」とは区別する。
- カテゴリ一覧：probe_tableは先頭200件から候補カテゴリを取得し、最大100種類に切る。後半だけのカテゴリが辞書から漏れる可能性がある。実際のPCP描画での扱いは未操作。

## 6. 未実施のブラウザE2E受入項目

公開版の一致するビルドを特定した上で、次の流れを確認する。ここに挙げた項目は「合格済み」ではない。

|操作|受入条件|
|---|---|
|CSV投入→Data Table→PCP|列・値・カテゴリ・行数を保持し、問題がある入力は明示エラーにする。|
|PCPブラッシング→Table／分布図|選択行IDと件数が一致する。|
|Focus→Delete→Undo→原集合復帰|対象行集合と元の値を復元し、他ビューの集計対象も一致する。|
|All／Active／Selected／Sampled切替|各分析の基準集合を明示し、空選択を勝手に全体にしない。|
|Mining→PCP→Robustness|同じ質問・同じルール・同じ補集合・同じrevisionを引き継ぐ。|
|補完プレビュー→別データ保存|元データを保持し、新データの行ID・列ID・尺度・値ラベル・補完マスクを維持する。|
|セッション保存→リロード→復元|データ版、軸順、選択集合、フィルタ、派生データの対応を復元する。|
|選択行エクスポート|表示対象・分析対象・出力された行IDが一致する。|

## 7. 推奨する修正順

最初にA01/A02/A03のデータ保全を直す。次に型・役割契約（A05/A06/A12）と、条件・対象の同一性（A07/A14）を直す。その後、計算・表示（A08/A09/A10）と補完の原本保全・名称（A11/A13）を修正する。

機能追加は、その上に変数辞書、質問別分母、複数回答、回答者ウェイトを載せる順序を推奨する。時系列機能は今回の用途では追加対象としない。

最終的な受入基準は、**「同じデータ版・同じ行集合・同じ列定義なら、どの画面でも同じ集計になり、表示した条件から同じ行集合を再現できる」**こと。これを満たすことが、DAVISのlinked interactionを実用的なアンケートEDAへ継承する中核となる。

## 8. 実行方法と同梱物

公開アプリのソース・実行環境全体は再配布していない。手元の同じ静的ビルドを指定する。

```text
node --expose-gc run_audit.cjs <index.htmlとpyodideを含むstaticディレクトリ>
```

これはブラウザE2Eではなく同梱WASMの直接テスト。実行結果は `evidence/` に出力される。問題を再現したテストは `bug_reproduced: true` と記録する診断形式であり、正常系の「テスト合格」と混同しない。出力に既存ファイルがある場合は更新する。

`tree_probe.py` は別途native環境で動かす補助テスト。Python/numpy/scikit-learnが必要で、引数にはbackend_app.zipを展開したルートを指定する。同梱WASMとの差を明記する。

```text
python tests/tree_probe.py <backend_app.zipの展開ディレクトリ>
```

`evidence/snapshot_manifest.json`：ビルド識別用SHA-256。  
`evidence/source_excerpts.txt`：改変していないソースの該当行抜粋。  
`evidence/backend_results.json`：9種類の狙い撃ち再現テスト。  
`evidence/additional_results.json`：API隔離テスト、行ID継承、正常対照。  
`evidence/frontend_excerpts.json`：フロントの判定式・遷移処理。  
`fixtures/`：再投入用の合成データ。実ユーザの回答データは含まない。

## 参考文献（一次資料）

本文の提案は、以下の原著・公式実装文書と、同梱コード・実測結果を区別して記した。最新手法を網羅する調査ではない。

R1. Xuほか、TabDiff、ICLR 2025。引用：`TabDiff is parameterized by a transformer`。  
`https://proceedings.iclr.cc/paper_files/paper/2025/hash/5c882988ce5fac487974ee4f415b96a9-Abstract-Conference.html`

R2. scikit-learn 1.6.1、Understanding the decision tree structure。引用：`proportion of samples`。  
`https://scikit-learn.org/1.6/auto_examples/tree/plot_unveil_tree_structure.html`

R3. survey、svydesign公式文書。引用：`Specify a complex survey design.`。  
`https://search.r-project.org/CRAN/refmans/survey/html/svydesign.html`

R4. Wang・Xiao・Zang、When Cleaning Data Introduces Bias、Journal of Official Statistics、2025。引用：`over-detecting legitimate responses`。  
`https://journals.sagepub.com/doi/10.1177/0282423X251337843`

R5. Ding、Beyond One-Size-Fits-All、Educational and Psychological Measurement、2026年6月1日オンライン公開。引用：`No single algorithm dominated across all types.`。  
`https://journals.sagepub.com/doi/10.1177/00131644261448404`

R6. SciPy、kendalltau公式文書。引用：`T the number of ties only in x, and U the number of ties only in y.`。  
`https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.kendalltau.html`

R7. scikit-learn、Permutation feature importance公式文書。引用：`for a particular model`。  
`https://scikit-learn.org/stable/modules/permutation_importance.html`

R8. Zhaoほか、Break the Tie、AAAI 2026。引用：`learns customized distance metrics`。  
`https://ojs.aaai.org/index.php/AAAI/article/view/40104`

ライブラリ設計資料：`07_PCPクローン_現代GUI設計書.md`、`貼り付けたマークダウン（1）(9).md`。後者の完成条件は「意味の異なる複合セグメントが見つかり、その違いをPCPで素早く確認できること」、初期版の検証基盤は「全データ探索（EDA特化、p/q値なし）」であり、今回の提案もこの用途に合わせた。
