# DAVIS-PCP 評価報告 — 2026年9月7日

## 1. 結論と検証範囲

アンケート中心の探索的データ分析ツールとして、次に優先するべきなのは分析手法の追加ではなく、入力データの保持・変数の意味の維持・分析対象行の統一・手法名称と実装の一致である。単にエラーになるだけでなく、正常応答のまま違う値や分析対象を返す問題を複数再現した。

ただし、公開サイトのブラウザE2E評価は完了していない。指定ブラウザ連携はこのセッションに公開されておらず、別のChromiumでも公開URLとlocalhostの両方が `ERR_BLOCKED_BY_ADMINISTRATOR` で遮断された。これは検証環境の制約であり、サイト自体の不具合と判定していない。

代わりにLibraryの `/DAVIS-PCP/release/2026-09-07_davis-pcp-static.zip` を取得し、同梱のPyodide・WASMパッケージと変更していないPythonバックエンドをNodeで実行した。FastAPI/HTTPXのASGI経由のAPIテストと、配布アルゴリズムへの直接テストを実施した。Python起動処理・WASM向けthreadpool代替は同梱workerから抽出した。Nodeでのパッケージロードは逐次実行に変更しており、ブラウザの起動性能やWorkerの通信経路を検証したものではない。

- 対象ZIPのSHA-256: `4ec2b614b420bf5c4c978662172883b679783dcd9961ae23b35d3cbd55b7bc82`
- 公開サイトとZIPの同一性: 未確認。
- UI描画、PCPブラッシング、Focus/Exclude/Undoの連動、IndexedDB永続化、再読込、ダウンロード操作、モバイル表示: 未検証。
- 合成データのみ使用。公開サイトの保存内容や設定は変更していない。

### 成功したスモークテスト

Health応答、150行のIris取り込み、Orderingのdatabase/componentJar/componentPaper/permute/correlationの5方式、PCA、k-means、GMMのAPI実行に成功した。Orderingは返却軸が入力軸の順列であること、k-means/GMMは150行に150個の3群ラベルが返ることを確認した。PCAの4成分の寄与率は `[0.7296,0.2285,0.0367,0.0052]`。この確認は初版JARとの全互換性や統計的妥当性の全検証を意味しない。

## 2. 優先修正する再現済み不具合

P0: データが失われる、別の意味になる、または誤った分析結果を正常な値として返す問題。P1: 主要機能が使えない、または明確な例外になる問題。

### B01 / P0: 一意な数値列を勝手にIDへ転用し、分析列から落とす

入力: `fixtures/unique_numeric.csv`。age=20,21,22,23、answer=1,1,2,2。

観測: 4行2列の入力に対し、API応答は `columnCount=1`、`rowIdentity="column:age"`、分析列はanswerだけ。ageは内部row IDに転用され、通常の分析対象から消える。

原因: `import_service.py` の型推定で一意列をidentifier候補にし、`assign_row_identity` が採用列をdropする。`api/datasets.py:120-131` は推定を自動採用する。

修正: 一意性は候補表示だけに使う。IDは明示指定を優先し、内部IDに利用しても元列を保持する。`rowIdColumn` を明示した別テストでも、指定したcode_bでなくcode_aが採用されたため、オプションの接続も必要。

証跡: `results_second.json` の `unique_numeric_dropped`, `row_id_option`。

### B02 / P0: 重複列名の自動修正が衝突し、列を消す

入力:
```csv
x,x,x_1
1,2,3
4,5,6
```

観測: 結果はxとx_1の2列だけ。真ん中の2,5が消え、x_1には3,6が入る。

原因: `services/import_service.py:223-253`。重複xをx_1に変えた後、元から存在するx_1と辞書キーが衝突する。

修正: 割当済み名全体に対する一意性を検査する。元の表示名と内部columnIdを分離し、取り込み後の列数一致を必ず確認する。

証跡: `results_first.json` の `duplicate_header`。

### B03 / P0: 先頭ゼロと欠損値ルールが保持されない

観測: コード001,01,1はすべて数値1.0になる。`missingTokens=["999"]` を指定しても999は数値のまま。逆に `missingTokens=[]` でも文字列NAがnullになる。

原因: `services/import_service.py:127-145,205-253`。schema設定前に数値変換し、欠損判定は固定のMISSING_TOKENSを使う。

修正: 文字列原値を保持して型・欠損コードを確定してから変換する。列単位の特別欠損コードを設定可能にする。APIにあるquote/decimalSeparatorも参照されず、独自引用符は行幅エラー、小数コンマは文字列になった。

証跡: `results_first.json` の `leading_zero`, `missing_override`, `missing_literal_NA`, `decimal_comma`, `quote_override`。

### B04 / P0: 欠損を含む相関を0として返す

直接入力: x=[1,2,3,4]、y=[2,4,null,8]。

観測: `[[1,0],[0,0]]` を返す。両方観測されている3組だけを使えばxとyの相関は1であり、「無相関0」ではない。yの自己相関も0となる。

原因: `algorithms/summaries/core.py:54-64`。欠損入り配列をそのまま `np.corrcoef` に渡し、発生したNaNを `np.nan_to_num(...,nan=0)` で0へ変える。

修正: ペアごとの有効データ利用か完全ケース利用かを明示し、有効nと欠損方針を表示する。計算不能はnull/NAで返し、0へ置換しない。ペアごとの相関行列をPCA等へ転用する場合は、同一行集合で計算した行列とは別扱いにする。

付随: 数値1列の相関が1×1行列でなくスカラー1.0になるケースも再現。

証跡: `results_first.json` の `correlation_one_missing`, `correlation_single_column`。

### B05 / P0: 変数型設定が検定・キャッシュ・補完で一貫しない

3つの独立した問題を再現した。

(1) 実際のschema形式で `columnId="col-q",name="q",semanticType="categorical"` と指定しても、サブグループ探索はqをnumericとしてWelchのt検定を選ぶ。同じメタデータからcolumnIdだけを除くとcategoricalとしてカイ二乗検定を選ぶ。

原因: `algorithms/mining/subgroup.py:103-115` 等でcolumnIdを辞書キーにし、後でnameで参照する。modern_subgroupとrelationships/surpriseにも同パターンがある。実行比較したのは通常subgroup。

(2) numericからcategoricalへschemaを変更してもfingerprintが変化せず、変更前の数値集計と相関がcacheHitで返る。`api/datasets.py:169-190` と `api/summaries.py:35-38`。

(3) qをcategoricalへ設定後、別列xだけを平均補完すると、qがnumericへ戻りcolumnIdも変わる。`api/datasets.py:337-348` が全列を再推定するため。

修正: columnIdと表示名を区別する共通schema参照関数を使う。手動の意味型・順序・ラベルを値の変換から保護する。変更にはschemaRevisionを付け、結果・キャッシュの入力識別へ含める。

証跡: `results_second.json` の `mining_schema_with_columnId`, `mining_schema_without_columnId`; firstの `summary_after_schema`; thirdの `schema_patch`, `impute_inplace`。

### B06 / P0: 空の対象行指定が全件に化ける

観測: Iris全件のsummariesを実行後、同条件で `rowIds=[]` を渡すとrowCount=150、cacheHit=true。PCAにも[]を渡すとnSamples=150。modern-subgroupの `selectedRowIds=[]` でも全件の3候補を返す。

原因: summariesは `tuple(sorted(req.rowIds)) if req.rowIds else None` により[]とNoneを同じキャッシュキーにする。PCA等も `or` / truthinessで区別しない。

修正: 「全件」「active」「selected」をscopeとして明示し、指定なしと明示的0件を区別する。0件への集計は空結果、学習系は説明付きの入力エラーにする。UIが「選択なし=全件」とする仕様なら、その意味をscopeへ変換し、0件フィルタ結果と混同させない。

証跡: firstの `summary_empty`; secondの `pca_empty_selection`, `modern_empty_selection`。UI経由の到達性は未確認。

### B07 / P0: CSVの保存と再取り込みで文字列・負数が変わる

入力: `fixtures/csv_roundtrip.csv`。コメントに `said "yes"` と `a,b`、scoreに-1,-2,3。

観測: 出力は `"said "yes""` のように内部引用符をエスケープしない。再取り込みで `said yes""` になる。数値-1.0/-2.0にアポストロフィが付き、score列全体が文字列になる。

原因: `api/exports.py:29-61`。手組みのCSV引用処理と、数式対策 `_neutralize` の無差別適用。

修正: csv.writerを使用する。真の数値と文字列を区別し、数式対策は文字列セルへ適用する。分析データを完全往復させる出力と、表計算ソフト向け安全化出力を必要に応じ分離する。

証跡: `results_second.json` の `csv_export`, `csv_reimport`。

### B08 / P1: 日本語入出力で文字化け・例外

(1) CP932の髙橋・丸数字を含むCSVの自動判定がlatin1へ落ち、ヘッダーもデータも文字化けする。明示cp932指定の成否は今回未検証。`services/import_service.py:26-38`。

(2) アンケート.csvの取り込みは成功するがCSV出力で `UnicodeEncodeError: 'latin-1' codec can't encode characters`。`api/exports.py:61` のContent-Dispositionへ日本語ファイル名を直接設定する経路で発生。

修正: 日本語CSVの自動判定へCP932を追加し、プレビューと明示指定を用意する。出力ヘッダーはASCIIフォールバックとUTF-8のfilename*を使用する。

証跡: firstの `cp932`; secondの `japanese_filename_export`。

### B09 / P1: 原データを残す欠損補完が例外

観測: 平均補完を `inPlace:false` で実行すると `AttributeError: 'dict' object has no attribute 'name'`。

原因: `api/datasets.py:356` の `meta.name`。metaはdict。

修正: `meta["name"]` 等へ修正し、新データセット作成と元データ無変更を回帰テストする。API既定のinPlace=trueは元データを更新するため、原値・補完値の比較を重視する利用には別保存を既定にする案が適切。

証跡: `results_third.json` の `impute_copy`。

### B10 / P1: カテゴリだけのデータではCobweb/DISCを使えない

観測: color=red/blueとchoice=yes/noの6回答について、categoricalColumnsのみでCobwebまたはDISCを指定すると `CLUSTERING_NO_COLUMNS`。「数値軸を含むデータセット」を要求する。

原因: `api/clusters.py:112-118` の共通入口で数値列を必須とし、各カテゴリ対応アルゴリズムへ到達しない。

修正: 入力行の確定と、数値・カテゴリ特徴の組み立てを分離する。数値0本も有効とする。mixed/categoricalモデルの評価を数値部分のEuclidean silhouetteだけで代表させない。

証跡: `results_third.json` の `all_categorical_cobweb`, `all_categorical_disc`。

### B11 / P1: クラスタ数が行数より多い場合のエラー処理が壊れている

観測: 3行にk=5を指定するとNameError。正常な業務エラーにならない。

原因: `api/clusters.py:122,125` のf-string内 `{k}` が未定義。`{req.k}` が必要。同じ条件分岐が重複している。

証跡: `results_second.json` の `clusters_too_many`。

### B12 / P0: Random Forest代表木の一致率が誤る

入力: x=0/1がy=1/2を完全に決める100行。分類、5本、深さ3、seed=42。

観測: 配布APIはforestAgreement=0、全5本のtreeAgreements=0。独立に同じ同梱sklearnで学習し、木のクラスインデックスだけを正しくラベルへ復号すると、全5本とも一致率1、モデルの正答率も1。

原因: `api/models.py:208-228`。個別木のインデックスだけでなく、Forestが返す本物の数値ラベルまで同じ関数でインデックス扱いする。

修正: Forestの実ラベルとtree内部インデックスの復号処理を分離する。文字列、0始まりでない整数ラベル、小数ラベルのテストを追加する。代表木との一致率はForestの予測性能とは別指標として表示する。

証跡: secondの `rf_numeric_labels`; thirdの `rf_oracle`。

## 3. 統計手法名と実装の不一致

ここは「高精度化するとよい」ではなく、現名称では違う統計量・モデルを実行したと誤認させる問題である。

### S01: Φkではなく独自の補正Cramér's V型指標

`algorithms/relationships/surprise.py:174-183` はCramér's V型の値から `0.5*noise_thresh` を引いている。Phi_Kの公式実装にあるchi-squareから二変量正規分布の相関係数への変換を行っていない。公式文書の最小引用: `Correlation coefficient of bivariate gaussian derived from chi2-value`。[S1]

実測でもx=yのテストでphik=0.9を返すが、この数値だけで誤りを判定したのではなく、実装式の相違が根拠。現式を残すなら「独自補正V」と明示するか、標準Phi_Kを実装して参照値と照合する。

### S02: 目的変数なしの「相互情報量」はPearson相関

`algorithms/mining/feature_ranking.py:291-309` は教師なし分岐で絶対Pearson相関の平均を返す。それをmutualInfoとラベル付けしている。x=[-2,-1,0,1,2]、y=x²の繰り返しでは、決定的依存があってもこの実装のmutualInfoは0。

教師ありの分岐はsklearnのMIを呼んでおり、全MI機能が偽物という指摘ではない。教師なしだけ実MI推定へ置き換えるか、UIを「平均絶対相関」に変える。目的変数なしのReliefFも実際には分散へフォールバックするため、同じ名称監査が必要。

### S03: TabDiffという表示と原論文モデルが異なる

ICLR 2025のTabDiffは数値・カテゴリを共同でモデル化する学習モデルで、原文は `parameterized by a transformer` と記述する。[S2]

一方、配布 `algorithms/imputation/tabdiff.py` は数値に相関行列・Gaussian条件付き平均を利用した反復処理を使い、カテゴリには各列の周辺度数に基づく補完を使う。カテゴリ補完は観測済みの他変数で条件付けられていない。原論文のTransformer学習や共同モデルは含まれない。UIでは「観測された特徴量の同時結合条件をスコア関数として学習」と説明しており、実装より強い説明になっている。

この実装を実験機能として残すこと自体は否定しないが、原論文のTabDiff実装とは呼ばず、独自法・近似法であることを表示するべき。さらに同ファイルの `wassersteinDist` は実際には観測値と補完値の平均差の絶対値であり、分布間Wasserstein距離そのものではない。

### S04: Random Forest重要度の意味を分ける

`feature_ranking.py:315-326` はPermutation Importanceを有効にすると、MDIと非負化したPermutationの値を単純平均する。正規化MDIと評価スコアの低下量は別の量であり、混ぜた値をMDIとして見せるのは適切でない。

公式scikit-learn文書もMDIが `favor high cardinality features` と説明し、相関した特徴ではPermutation Importanceも低く見える場合を説明する。[S3]

EDA用途なら学習データ上の重要度表示を一律禁止する必要はない。ただしMDI/Permutationを分離し、評価データ・評価指標・反復ばらつきと「因果効果ではない」を示す。未観測回答者への予測性能を主張する場合に限ってOOBや交差検証などを追加する。

## 4. アンケート分析として不足している共通機能

以下は配布schema/API/バンドル確認に基づく。UIからの全経路探索は未実施のため、すべての画面で絶対に不可能とまでは断定しない。

### 4.1 変数の意味を共有するコードブック

バックエンドColumnSchemaのformalなsemanticTypeはnumeric/categorical/identifier/label/ignoredで、ordinalがない。一方フロントエンドの一部はnominal/ordinal/textを使う。型フィルタでcategoricalを拾わないコード経路があり、実画面での影響は要ブラウザ確認。

必要な最小単位は、数値・名義・順序・二値・IDの区別、コードと表示ラベル、カテゴリ順、欠損コード、対象者条件、安定したcolumnId。たとえば満足度1〜5、性別1/2/3、回答者番号000123を同じ数値として扱わない。

lavaanも `categorical (not continuous)` と区別し、順序型として扱うか数値の共変量として扱うかによってモデル設定を変える。[S4] 5件法の平均を一律禁止するのではなく、数値近似を利用者が選び、各分析へ同じ設定が伝わることを優先する。

### 4.2 複数回答と「割合の分母」

複数回答の0/1列を一つの設問へ束ね、回答者ベースと延べ回答ベースの割合を区別する。未選択0・無回答・スキップを別に扱う。

設計例: 10人中、Aを選んだ人が6人なら回答者ベース60%。全選択数が15件なら延べ回答ベース40%。両者は別の集計であり、軸単位の0/1列だけでは設問全体の意味を保持できない。分布・クロス集計・サブグループ説明へ分母を共通表示する。

### 4.3 調査ウェイト

確認範囲で、回答者のsample weightを共通API入力として扱う経路が見つからない。ランキングの重みや混合距離の重みとは別機能。

第一段階は非加重n、有効回答n、加重平均・加重比率、重み列の明示でよい。母集団への標準誤差・信頼区間まで扱う段階では層・抽出単位も含むsurvey designが必要になる。survey系公式APIもweightsに加えてids/strataを別々に扱う。最小引用: `weights (inverse of probability)`。[S5]

### 4.4 分析対象行の共通契約

PCP・表・集計・PCA・クラスタ・モデル・サブグループ・エクスポートで、同じ対象行集合を共有する。今回の空選択問題に加え、ClusterRequest/ModelRequestに一般的なrowIds指定がない経路がある。

全件、Focus後のactive、選択中、比較対象を区別して表示し、結果にscope/有効n/datasetRevision/schemaRevisionを添える。これは高度な統計追加ではなく、PCP中心の分析の基礎条件である。Libraryの初版JAR解析資料でも、現代化案はgroupIdと一時selected、active、hiddenの分離を推奨している。

### 4.5 原値と補完値の比較

元データを保持し、どのセルを何の方法で補完したかのマスクを保存する。未回答・非該当・選択肢「わからない」を一括補完しない。欠損のある行をPCPで選択し、属性ごとの欠損率と補完前後の結論変化を確認できるようにする。

## 5. 最新の統計・機械学習知見から反映する点

### 5.1 最新モデルの追加より、欠損パターン別検証

2026年2月17日改訂版TabImputeは、42表・`13 new missingness patterns` からなるMissBenchを報告する。[S6] この論文は本アプリでの優位性やブラウザ実行可能性を証明しない。

今回の設計へ取り込むべきなのは、新しいモデル名よりも評価の考え方である。ランダム欠損だけでなく、属性に偏った無回答や設問ブロックの欠損を模した検証を用意し、補完誤差に加えて分布・相関・サブグループ順位がどれだけ変わるかを確認する。調査票のスキップ構造は補完対象にしない。TabImpute等の採用・WASM適合性は別途評価であり、この監査では検証していない。

### 5.2 EDAにholdoutを強制しない。ただし探索結果を確証と呼ばない

PCPで眺めて候補を見つけるたびにデータ分割やSelective Inferenceを必須にする必要はない。主画面は差の大きさ、対象人数、比較対象、分布差を中心にすることを推奨する。

一方、同じデータで条件を探し、そこで得たp値やq値を母集団での確証として表示するのは別の問題である。Dworkらは分析を `interactive and adaptive process` と捉え、結果を見て次の仮説を作る再利用と推論保証を区別する。[S7]

固定した一回の候補群に対する多重比較補正と、対話探索全体を含む保証を混同しない。初期実装では「探索的候補」「検証未実施」を示せばよく、検証モードだけに独立データ、適切な分割などを導入する。この注意点は2026年に生じた新問題ではなく、現在も適用される基礎的知見である。

## 6. 実装順と完了条件

| 順 | 修正対象 | 完了条件 |
|---|---|---|
| 1 | 取り込み・出力の可逆性 | 一意列・重複列名・先頭ゼロ・引用符・負数・日本語を含む入力が、意図しない変更なしに保持される |
| 2 | schemaと対象行の契約 | 型変更が全分析へ伝播し、別列補完で消えず、[]が意図せず全件へ変わらない |
| 3 | 誤った数値と手法表示 | 欠損相関を0にしない。RF一致率オラクル一致。Φk/MI/TabDiff/重要度の名称が計算と一致 |
| 4 | アンケート共通情報 | 順序・ラベル・欠損理由・複数回答分母・調査重みを保持できる |
| 5 | 本来のブラウザE2E | PCP選択→表・分布連動→Focus→解析→Undo→保存→再読込で対象行と設定が一致 |

## 7. 次の改善単位: 小さなアンケート回帰テストを固定する

本監査の合成CSVを、入力の列数・型・値・rowId・scopeを検査する固定テストへ組み込む。正常なIrisだけでなく、実務で起こる数値コード、先頭ゼロ、欠損コード、日本語、複数回答、空選択、手動型変更を常設する。

ブラウザ側では「同じ回答者群・同じ型設定・同じ生データを見ている」ことを各画面の共通不変条件にする。その土台が固まってから、派生分析や最新補完手法を増やす方が、今回再現した種類の誤りを繰り返しにくい。

## 参照した一次情報

[S1] Phi_K公式API文書、phik_from_chi2。`https://phik.readthedocs.io/en/latest/phik.html`

[S2] Shi et al., TabDiff: a Mixed-type Diffusion Model for Tabular Data Generation, ICLR 2025, v3 2025-02-16。`https://arxiv.org/abs/2410.20626`

[S3] scikit-learn公式、Permutation feature importance（特にMDI比較、相関した特徴への注意）。`https://scikit-learn.org/stable/modules/permutation_importance.html`

[S4] lavaan公式、Categorical data。`https://lavaan.ugent.be/tutorial/cat.html`

[S5] srvyr公式R文書、as_survey_design。`https://search.r-project.org/CRAN/refmans/srvyr/html/as_survey_design.html`

[S6] Feitelberg et al., TabImpute: Universal Zero-Shot Imputation for Tabular Data, v4 2026-02-17。`https://arxiv.org/abs/2510.02625`

[S7] Dwork et al., Generalization in Adaptive Data Analysis and Holdout Reuse, 2015。`https://arxiv.org/abs/1506.02629`

Library: `08_初版JAR_バイトコード解析と互換アルゴリズム設計.md`。原典の実装互換と現代版の改善を分ける方針、および共有行状態の設計を参照。原典PDFの全再解析は実施していない。
