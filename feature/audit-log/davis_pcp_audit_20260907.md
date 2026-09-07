# DAVIS-PCP 静的版 検証報告

評価日：2026年9月7日（日本時間）  
対象：2026-09-07_davis-pcp-static.zip  
SHA-256：`4ec2b614b420bf5c4c978662172883b679783dcd9961ae23b35d3cbd55b7bc82`

## 結論

現状の優先課題は分析メニューの追加より、データの保存、対象集団の一貫性、統計量名と実計算の一致である。実行時例外だけでなく、正常応答に見えて値・列・対象人数・予測結果が変わる不具合を確認したため、この版の結果をそのまま実アンケートの確定結果として使うことは推奨しない。

原典DAVISの全モジュール再現ではなく、アンケートEDAとして評価した。時系列、画像解析、オンラインサーバー機能は不足に数えていない。

## 1. 確認範囲と限界

ブラウザE2Eは未完了。ローカル配信した添付版へPlaywright/Chromiumから遷移したが、実行環境の管理ポリシーで `net::ERR_BLOCKED_BY_ADMINISTRATOR` となった。管理ポリシーは変更していない。従って描画、マウスブラシ、軸ドラッグ、キーボード、画面遷移、実ダウンロード、ブラウザ再起動後のIndexedDB復元について、合否を断定しない。

代わりにZIP同梱のPyodide、NumPy、SciPy、Polars、scikit-learn、wheel、backend_app.zipをNode.jsでそのまま起動した。取込・集計・探索・保存・出力は同梱ASGI要求処理を通し、一部分析は同じWASM内の関数へ直接入力した。Pythonをホスト版へ置換した試験ではない。frontend bundleとWorkerの静的照合も行った。

Node.jsハーネスではパッケージを逐次ロードし、ブラウザのIndexedDBを使用していない。そのためブラウザでの起動時間・メモリ・永続化の検証にはならない。試験記録の日時は実行環境のUTCであり、日本時間では9月7日に当たる。

新しいWASMプロセスでも検証スクリプトを再実行した。`ok:true`は検証用スクリプトが完了した意味で、アプリの合格を意味しない。UUIDや時刻は毎回異なる。

## 2. 正常応答を確認した経路

組込Irisと小規模CSVの読込、明示した3行の集計、行範囲指定、seed付き非復元抽出、名前付きグループの作成/読出し、選択3行のArrow出力と復号、同一WASMプロセス内のセッション保存/読出し/JSON出力を確認した。空CSVと不正な列数は適切にエラーとなった。

5種類の軸順計算、FEDF、共分散、Line MosaicはHTTP応答と結果構造を確認した。ただし、このスモーク試験だけで原典DAVISとの完全一致や全条件での数値正しさを主張しない。Kendall-EMMについては、同順位を含む正相関群と負相関群を検出し、τb=+1と−1がSciPy参照計算と一致した（replay_results/06_emm.json）。

## 3. 修正指摘

P0はデータ・集団・計算結果の信頼性に直結するもの、P1は主要機能の失敗や仕様不整合、P2は再現性等の改善である。優先度は本用途に対する評価で、普遍的な脆弱性評価ではない。

### D01 [P0] 分析列を自動的に行IDへ転用し、明示的なID指定も無視する

確認区分：WASM API。

再現：fixtures/no_id.csvを取込。別途id_option.csvをrowIdColumn="person"で取込。

結果：ageが全件ユニークだとrowIdentity=column:ageとなり、分析列ageが消える。明示指定personも無視されamountがIDになる。

修正：行IDは原則別列として自動生成。既存列の採用は明示確認し、元列を残す。options.rowIdColumnを尊重する。

受入条件：取込前後で分析列数と値が保存され、ID指定personが実際に採用される。

証拠：`02_mining_schema.json: unique_measurement_becomes_id, explicit_id_ignored`。ソース：`app/services/import_service.py:184-199`、`app/api/datasets.py:120-141`、`app/storage/dataset_store.py:129-180`。

### D02 [P0] 数値風の文字列と大きな整数が不可逆に変わる

確認区分：WASM API。

再現：fixtures/survey_edge.csvを取込。

結果：0001が1.0になり、9007199254740993が9007199254740992と同じ値になる。CSV全数値列をFloat64化している。

修正：先頭ゼロのコードは文字列保持。整数はInt64/UInt64または文字列。型確定前の生値を保存する。

受入条件：0001と1、連続する64bit整数が読み書き後も区別される。

証拠：`01_import_export.json: edge_import`。ソース：`app/services/import_service.py:129-141`、`app/services/import_service.py:222-246`。

### D03 [P0] ユーザー指定の欠損値コードを採用しない

確認区分：WASM API。

再現：survey_edge.csvをmissingTokens=["","99"]で取込。

結果：99は実測値として残り、指定にないNAは欠損へ変わる。_parse_valueが固定のMISSING_TOKENSを参照する。

修正：列別の欠損コードをスキーマに保存して解析へ渡す。指定の置換/追加の意味を明確にし、該当なし等を単純欠損と区別する。

受入条件：指定された99だけが指定どおり欠損化され、集計の有効人数・平均と整合する。

証拠：`01_import_export.json: edge_import`。ソース：`app/services/import_service.py:23-41`、`app/services/import_service.py:129-141`。

### D04 [P0] 重複列名の解消処理が別列を上書きする

確認区分：WASM API。

再現：fixtures/duplicate.csv：ヘッダQ,Q,Q_1、データ1,2,3 / 4,5,6。

結果：重複したQをQ_1へ変更した結果、既存Q_1と衝突し、値2,5の列が消失する。

修正：ヘッダ全体の使用済み名称集合を用いて衝突しない名前を発行し、元見出しとの対応を保存する。

受入条件：列は3本保持され、1〜6の入力セルがすべて保存される。

証拠：`01_import_export.json: duplicate_header, duplicate_stored`。ソース：`app/services/import_service.py:222-246`。

### D05 [P1] CP932拡張文字入りCSVが文字化けしたまま成功扱いになる

確認区分：WASM API。

再現：fixtures/cp932.csv：職場、①㈱髙などを含むWindows系CSVを自動判定で取込。

結果：UTF-8→Shift_JIS→Latin-1の判定で、CP932拡張文字を含むファイルがLatin-1になり列名と値が文字化けする。

修正：CP932を候補に追加。明示エンコーディング選択と取込プレビューを設け、無条件Latin-1成功扱いを避ける。

受入条件：職場、①、㈱、髙が完全一致で復元される。

証拠：`01_import_export.json: cp932_auto, cp932_stored`。ソース：`app/services/import_service.py:26-41`、`app/services/import_service.py:204-208`。

### D06 [P0] 補完後に列の役割・順序尺度・列IDが失われる

確認区分：WASM API。

再現：numeric_survey.csvでage=attribute、Q1=question/ordinal、手動カテゴリ順を設定。欠損がないQ2へmean補完をinPlace=trueで実行。

結果：値を変更しない操作でも列IDが再生成され、Q1はnumeric/numeric_axisへ戻り、手動設定が消える。

修正：統計量の再計算と意味スキーマの編集を分離。stable columnId、role、順序、ラベルを継承する。

受入条件：補完・派生列追加等の前後で既存列の意味スキーマとIDが維持される。

証拠：`02_mining_schema.json: schema_patch, schema_after_noop_imputation`。ソース：`app/api/datasets.py:169-188`、`app/api/datasets.py:323-349`。

### D07 [P0] 0行と全体が混同される集計キャッシュ・対象集団処理

確認区分：WASM API。

再現：同じ列に対し/summariesをrowIds未指定で実行後、rowIds=[]で実行。modern-subgroupにもselectedRowIds=[]を指定。

結果：空集合集計にrowCount=80、cacheHit=trueが返る。探索も空リストを無視して全体を使う。選択なし→全体というUI規約とは別に、明示的空集合を区別できていない。

修正：scope=all/active/selected、明示rowIds、Noneと[]の意味を全APIで統一。キャッシュキーにも区別を入れる。

受入条件：全体→0行、0行→全体の両順序で正しい集計。全ビューの対象人数が一致する。

証拠：`05_workflow_smoke.json: summary_all, summary_empty_after_all; 02_mining_schema.json: empty_population`。ソース：`app/api/summaries.py:26-48`、`app/api/mining.py:106-128`。

### D08 [P1] 数値属性だけのアンケートで自動サブグループ探索が候補0件になる

確認区分：WASM API＋フロントエンド静的照合。

再現：numeric_survey.csv：80人、age=20/60、Q1=1/5。/mining/modern-subgroupへ対象変数を明示しない通常要求。

結果：明白な差があるのに候補0件。targetQuestions=[Q1],attributeCols=[age]なら40人ずつの群を発見。role設定後も自動では0件。metadataをcolumnIdで格納し名前で参照し、全数値列を質問とした後に属性プールから除外している。フロントの実行要求にtargetQuestions/attributeColsがない。

修正：列IDと名前の照合を統一し、roleで質問・属性を分離。除外は現在のターゲットまたはEMMの2列のみ。対象列をUIで指定できるようにする。

受入条件：この80人データで自動探索でも期待する差を検出し、ターゲットを説明条件に混入させない。

証拠：`02_mining_schema.json: numeric_auto, numeric_explicit, numeric_auto_after_roles; frontend_snippets.json`。ソース：`app/algorithms/mining/modern_subgroup.py:476-543`。

### D09 [P1] 最小集団サイズを無断で小さくする

確認区分：WASM API。

再現：small_group.csv（20人対40人）をminGroupSize=30で探索。

結果：N<3×minGroupSizeの場合、実効最小サイズがmax(3,N//6)に変わり、20人の群を返す。要求30に対しこの例では10へ緩和。

修正：指定された最低有効人数を両群で厳守する。候補0件なら理由を表示し、変更はユーザー操作とする。

受入条件：minGroupSize=30なら20対40の比較は返らず、設定値と実効値が一致する。

証拠：`02_mining_schema.json: min_size30_return20`。ソース：`app/algorithms/mining/modern_subgroup.py:532-554`。

### D10 [P0] 探索条件の丸めが行集合と保存ルールを不一致にする

確認区分：WASM関数。

再現：x=0.001〜0.009の80件から数値記述子を生成。返却Conditionを再評価してmaskと比較。

結果：x<0.0なのに20件、0.01<=x<0.01なのに20件となる例を確認。判定は精密閾値、返却valueと重複判定ラベルは小数2桁。

修正：条件valueには元の精度を保持。表示だけ整形。canonical keyは厳密な型付き条件で作る。

受入条件：evaluate(returned_rule)のrowIdsが探索時rowIdsと完全一致。狭い区間や負数も試験する。

証拠：`02_mining_schema.json: rounded_rule_mismatch`。ソース：`app/algorithms/mining/modern_subgroup.py:85-139`。

### D11 [P0] CSV出力が引用符と負の数値を壊す

確認区分：WASM API。

再現：survey_edge.csv取込後にCSV出力し、標準csv.readerで再読込。

結果：a"bが適切に二重引用符エスケープされずab"へ変わる。数値-1.0にも数式対策のアポストロフィが付いて文字列になる。

修正：標準CSV writerを使う。数式注入対策はデータ型を認識し、数値の負数へ適用しない。

受入条件：カンマ、引用符、改行、負数、先頭ゼロを含む取込→出力→再取込の型と値が一致する。

証拠：`01_import_export.json: csv_export, csv_roundtrip_parsed`。ソース：`app/api/exports.py:29-68`。

### D12 [P1] 日本語ファイル名からの出力が例外になる

確認区分：WASM API。

再現：fixtures/アンケート.csvを取込後、/exportsでCSV出力。

結果：Content-Dispositionヘッダの日本語をLatin-1でエンコードできずUnicodeEncodeError。ブラウザの保存ダイアログより前の応答作成で失敗する。

修正：ASCII fallbackとUTF-8 filename*の適切なContent-Dispositionを生成する。

受入条件：日本語・空白・記号入りファイル名のCSV/Parquet出力が成功する。

証拠：`01_import_export.json: japanese_filename_export`。ソース：`app/api/exports.py:48-82`。

### D13 [P0] ParquetをWASMブリッジがテキストとして扱う

確認区分：WASM応答変換実行＋フロントエンド静的照合。

再現：/exports format=parquetで同梱_dispatch_asgiの返値を確認し、元bytesと返却textをUTF-8化したbytesを比較。

結果：media type application/vnd.apache.parquetをバイナリと認識せずis_arrow=false。今回1709bytesに置換文字90個が入り、元bytesと不一致。フロントは文字列をtext/csvのBlobへ変換する。実際のブラウザ保存操作は未確認。

修正：バイナリの判定をArrowだけへ限定せず、HTTP response bodyは原則bytesとして伝送しMIME型を維持する。

受入条件：元bytesとダウンロードbytesが同じハッシュとなり、Parquet readerで正しく読める。

証拠：`03_models_robustness.json: parquet_bridge; frontend_snippets.json`。ソース：`app/api/exports.py:65-82`。

### D14 [P0] ロジスティック回帰のL1指定がL2になる

確認区分：WASM関数。

再現：固定seedの合成データ240行・5説明変数でregularization=l1/l2、C=0.01を比較。

結果：両者の全係数が一致。実際のsklearn1.6.1からl1_ratio is only used when penalty is elasticnetという警告。penalty未指定のためl2が使われる。

修正：同梱バージョンに合わせpenalty="l1"を明示。L2も明示。solver対応と収束警告を結果へ返す。

受入条件：L1が真にL1正則化で計算され、参照実装と係数・予測が一致する。

証拠：`03_models_robustness.json: l1_vs_l2`。ソース：`app/algorithms/models/logistic.py:143-171`。

### D15 [P0] 切片なし回帰で学習時と出力時の予測が一致しない

確認区分：WASM関数。

再現：平均100の説明変数120行でintercept=falseを指定。返却係数から学習時の中心化空間の確率を復元。

結果：学習時はX-meanを使用し、出力は元のXへ係数だけ戻す。学習空間の確率約0.260〜0.740に対し、返却確率が全件1.00000。

修正：切片なしの定義を原尺度で統一。切片なしで中心化しない、またはオフセットを厳密に扱う。予測・曲線・尤度を同じモデルから計算する。

受入条件：model.predict_proba相当と出力サンプル・曲線・尤度が同じ予測を使う。

証拠：`03_models_robustness.json: no_intercept_probabilities`。ソース：`app/algorithms/models/logistic.py:115-139`、`app/algorithms/models/logistic.py:200-221`。

### D16 [P0] 感度分析で1人除外後の平均を逆方向に表示する

確認区分：WASM関数。

再現：Q=[1,1,1,5]でKPIのrobustnessを実行。

結果：全体平均2。最大影響者5を除外後の正しい平均は1だが、返却estimate=3。mean向けinfluenceの符号と適用が不一致。

修正：影響量をfull-minus-LOO等の一貫した定義へ統一。群間差では現状別の符号規約なので機械的な全置換をしない。

受入条件：解析的LOOと全行の愚直な再計算を照合し、平均・群間差・欠損で一致する。

証拠：`03_models_robustness.json: robustness`。ソース：`app/algorithms/robustness/engine.py:185-259`。

### D17 [P0] TabDiffという名称・説明と実装が一致しない

確認区分：WASM関数＋ソース照合。

再現：同梱tabdiff_imputeを実行し、関数全体とUI説明を照合。

結果：原著の学習可能なTransformerベース混合型拡散モデルではなく、相関行列からのガウス条件付き平均とカテゴリ別周辺頻度抽出。単一補完列だけを選ぶと他の説明変数を使わない。条件付き数値補完はseed変更でも差約3e-9まで潰れる。wassersteinDistは平均差の絶対値で、実例0.5301に対し真のWasserstein距離3.4383。

修正：検証済み原著実装へ置換するか、独自の実験的補完として正確に改名。補完対象と説明変数を分離。距離は定義どおり計算。プレビューと適用の入力条件を揃える。

受入条件：UI・algorithmVersion・計算法が一致し、元観測値は保持、選択対象だけ補完、診断量が参照計算と一致する。

証拠：`04_imputation_ranking.json: selected_target_ignores_predictors, wasserstein_label; frontend_snippets.json`。ソース：`app/algorithms/imputation/tabdiff.py:69-125`、`app/algorithms/imputation/tabdiff.py:171-213`、`app/algorithms/imputation/tabdiff.py:229-291`。

### D18 [P1] 関連・特徴量ランキングの統計量名と実体が一致しない

確認区分：WASM関数＋ソース照合。

再現：targetなしでx,y=x²,z=3xをランキング。default phik関連分析の関数も実行。

結果：教師なしmutualInfoは平均絶対Pearson相関、教師なしrelieffは単純分散。default phikはCramérのVから独自ノイズ項を引く値で、本来のΦk変換をしていない。教師ありMIは別途sklearn実装を使っており、この指摘は教師なし分岐に限定する。

修正：近似指標には別名・式・単位・適用範囲を明記。標準統計量名を使うなら参照実装と一致させる。

受入条件：相互情報量・ReliefF・Φkを表示する各経路で、名称が計算法と一致する。

証拠：`04_imputation_ranking.json: unsupervised_rank_names, phik_name`。ソース：`app/algorithms/mining/feature_ranking.py:280-322`、`app/algorithms/relationships/surprise.py:160-192`。

### D19 [P1] コピーを作る欠損補完が失敗する

確認区分：WASM API＋UI要求ソース確認。

再現：imputeへinPlace=falseを指定。フロントにinPlace状態を渡す経路も存在。

結果：辞書metaへmeta.nameでアクセスしAttributeError。

修正：meta["name"]へ修正し、コピー先の行ID・意味スキーマ・元データ不変も併せて試験する。

受入条件：元データを変えずに独立した補完済みデータセットができ、ID対応が維持される。

証拠：`01_import_export.json: impute_copy; frontend_snippets.json`。ソース：`app/api/datasets.py:354-361`。

### D20 [P2] 同一内容の再取込でfingerprintが変わる

確認区分：WASM API。

再現：同名・同一CSVを2回取込してデータフレーム一致とfingerprintを比較。

結果：データ内容は一致してもfingerprint不一致。ランダムなcolumnIdをfingerprint材料へ含めている。内容ハッシュとしては使えない。

修正：内容ハッシュ・意味スキーマ版・データセットinstance IDを分離し、ランダムIDを内容ハッシュから外す。

受入条件：同一内容のハッシュは再取込でも同じ。異なる内容・意味スキーマを必要な粒度で検知できる。

証拠：`05_workflow_smoke.json: identical_data_fingerprints`。ソース：`app/api/datasets.py:127-141`、`app/services/import_service.py:184-198`。

### S01 [P1] カテゴリ型の名称がフロントとバックで不一致

確認区分：ソース確認のみ。画面での再現は未実施。

再現：schema semanticTypeとフロントのNominalフィルタ・target candidate判定を照合。

結果：backendはcategorical、フロントの該当判定はnominal/ordinal/text。実際の候補リストがどう見えるかは未確認だが、当該コード経路ではcategoricalが条件に入らない。

修正：共有スキーマとenumを単一化し、境界で正規化。string/categorical/ordinalの契約試験を追加。

受入条件：カテゴリ変数が該当フィルタ・候補選択へ出現することをブラウザ操作で確認。

証拠：`frontend_snippets.json; assets/index-DANYdvju.js文字オフセット1330268周辺、1734059周辺`。ソース：フロントエンド抜粋を参照。

### S02 [P1] 目的変数の欠損を自動的にクラス・数値として学習する

確認区分：WASM関数＋ソース照合。

再現：y=A/B/欠損を含むデータで特徴量ランキングを実行。

結果：分類では欠損を__MISSING__という応答クラスへ変換。回帰分岐は目的変数の欠損を中央値で埋める。欠損を説明する分析と応答内容を説明する分析が分離されていない。

修正：既定では目的変数未観測行を除き人数を表示。欠損発生の分析は明示的な別ターゲットとして提供する。

受入条件：目的変数欠損の取扱いが選択でき、学習対象人数・クラス集合が結果に明示される。

証拠：`04_imputation_ranking.json: ranking_missing_target`。ソース：`app/algorithms/mining/feature_ranking.py:256-274`。

## 4. アンケートEDAとして不足する中核機能

以下は「原典DAVISと違うから不足」ではなく、本用途への追加提案。確認したAPIとバンドルでは、下記の一連のワークフローを完備したものは見当たらない。ブラウザ操作による全メニュー探索はできていないため、不存在の断定範囲はコード照合に限る。

### 4.1 測定尺度・設問を扱うコードブック

数値の物理型とは別に、名義/順序/連続、属性/質問/ID、選択肢ラベルと順序、列別欠損コード、非該当、複数回答セット、逆転項目を保存する。順序はPCPだけでなく相関・探索・回帰候補にも反映する。

現在、schema patchの断片的な対応はあるが、フロントへの橋渡しと変換後の保持が壊れている。新規機能だけでなく既存機能の統合修正が必要。

### 4.2 設問別の母数と選択群/補集合比較

全回答者数、設問の対象者数、有効回答数、欠損数、除外数を区別する。選択群と補集合の回答割合、中央値/IQR、必要に応じ平均、差、元人数を同じカードへ出す。選択なしと空の分析母集団を区別する。

5段階評価ではカテゴリ別割合の横並びや発散積上げ表示をPCPへ連動させると、同じ平均の単峰/二極化を判別できる。表示用jitterを統計量計算に混ぜないことも受入試験にする。

### 4.3 複数回答と尺度得点

One-Hot変換は存在するが、単一回答のOne-Hotと「複数回答設問」の意味は異なる。複数回答では回答者ベース%と総選択肢数ベース%を分け、重複回答者を二重計上しない。未選択と設問非該当を分ける。

派生列式入力だけでなく、逆転項目、複数項目合成、最低回答項目数、欠損時の採点ルールを保存する。α/ωや因子モデルを無条件に増やすより、この得点の定義と履歴を先に固める。

### 4.4 回答者ウェイト

分析用のweight列を指定し、非加重人数と加重割合を併記する。抽出処理が返すsampledRowWeightsやスコア合成のweightsは、調査の回答者ウェイトを各分析で扱う機能とは別である。

初期段階は加重/非加重の記述統計比較だけでもよい。未対応の分析にウェイトを黙って無視させない。母集団推論まで扱う段階で、層/PSU/複製ウェイト等の設計情報も必要になる。

### 4.5 原データを失わない再現パッケージ

原データ、コードブック、変換履歴、補完マスク・seed、分析対象の行集合、推定方法と実装バージョンをまとめて保存する。現状のsession JSONを読めることと、別ブラウザへ自己完結的に分析を復元できることは別である。

## 5. 2026年9月時点の統計知見をどう反映するか

### 5.1 順序尺度を中心に据えるが、平均差を一律禁止しない

Al-Jaishiらの2026年研究は、検討したLikert型データで順序モデル等が有利となる条件を示し、原文は `particularly in the presence of skewed outcome distributions` と限定している。臨床試験での結果を一般アンケートすべての普遍定理とは扱わない。[R1]

一方、Zhangらの2026年チュートリアルにも、多カテゴリの順序項目について `ordinal data may be treated as continuous` との条件付き扱いがある。[R2]

実装提案は、カテゴリ分布を必ず見られること、順序を明示すること、Kendall τbや順位ベースの比較を選べること、平均を使うときは等間隔得点としての解釈を表示すること。多段階回答を二値化するしかないモデルUIは改善対象だが、累積リンクモデルはデータ基盤修正の後でよい。

### 5.2 欠損補完は生成の自然さだけで採用しない

2026年の項目欠損チュートリアルは `the imputation stage, the analysis stage, and the pooling stage` と、多重代入の三段階を区別する。[R2]

本システムの単一補完済み表から出した通常の標準誤差・信頼区間に、補完の不確実性が自動的に入るわけではない。初期EDAにはMI全体の実装を必須にしないが、元の欠損の保存、観測値/補完値の区別、未補完版との比較、採用手法の正確な名称は必須に近い。非該当・設問スキップを通常欠損と同じように埋めない。

### 5.3 原著名を使う場合は原著の計算法に合わせる

TabDiff原著は `TabDiff is parameterized by a transformer` と明記している。[R3] 本版の独自ガウス近似を同名・同説明で提供することは、最新モデルの採用とは評価できない。

Φkの公式説明は分割表統計を `a rotated bi-variate normal distribution` として解釈する手法である。[R4] 独自に補正したCramérのVとは区別が必要。軽い代理指標自体を否定するのではなく、代理指標であることと式を開示する。

### 5.4 探索と確認を混同しない

Libraryの改訂仕様は、全データでの高速EDAと、スコアが有意性・信頼度ではないことを明記している。この方針は維持できる。サブグループの発見・PCP確認のたびに必ずデータ分割する設計を要求しない。

データを見て選んだ群へ同じデータで通常の検定を行うと、選択を無視した評価になる。クラスタリング後推論を扱う一次研究も `Reusing the same dataset for both exploration and testing can lead to massive selection bias` と述べる。[R5] 発見カードは記述的な平均差・割合差・順位相関差として提示し、通常のbootstrapの安定性を「選択後も正しい信頼区間」と呼ばない。有意性や確証を提供する操作だけ、独立確認データ等を使う別経路にする。

### 5.5 外れた回答を低品質と決めない

現在のrobustnessは品質列が未指定だと、先頭8数値列の標準化偏差から低品質を合成する。これでは少数派・強い不満・特異セグメントが機械的に除去対象となる。

品質検査の一次研究は `different indices are needed` と、異なる不注意回答パターンには異なる指標が必要なことを示す。[R6] ここは「数値的に外れた回答を除く感度分析」と正確に改名し、回答時間・注意確認・矛盾回答等の品質指標とは分ける。回答時間は単発の回答メタデータであり、時系列モデルの追加を意味しない。

### 5.6 予測重要度と調査ウェイトを正しく扱う

sklearn公式文書は `Using a held-out set` による重要度評価を説明する。[R7] 本版でMDIと訓練データ上のPermutation Importanceを平均して一つの重要度にする処理は、各指標を分けて表示する。予測性能を論じるときは検証データのスコア・重要度を使い、相関した設問の代理関係も表示する。探索段階の重要度は因果効果ではない。

Pewの2025年調査方法も `Sampling errors and tests of statistical significance take into account the effect of weighting.` と記載する。[R8] ウェイト対応は単純な割合の重み付けだけと、調査設計を反映した標準誤差とを区別する。非確率標本の代表性が、重みを付けるだけで保証されると表示しない。

## 6. 優先する修正順と完了条件

第一段階：D01〜D07、D10〜D13、D19。元データ・列メタデータ・分析母集団・出力の不変条件を修復する。

第二段階：D08〜D09、D14〜D18、S01〜S02。探索と各モデルの実計算を直し、名称と説明を一致させる。

第三段階：コードブック、母数つき回答分布、複数回答、回答者ウェイト、再現パッケージを整備する。高度な推論機能や新規生成モデルはその後でよい。

リリース判定には、引用符/改行/負数/先頭ゼロ/日本語/大整数/欠損コードの往復、明示的0行、変換後の列IDと役割保持、条件再評価とrowIds一致、モデル予測・LOOの参照計算一致を必須とする。その上で、本環境では未実施のブラウザ上のPCPブラシ→テーブル→分布→群保存→出力→再読込を実操作で通す必要がある。この報告をブラウザE2E合格記録として扱ってはならない。

## 参照した一次資料

- [R1] Al-Jaishi et al., Statistical analysis of Likert-based ordinal scales: a guide for clinical trialists. BMC Medical Research Methodology 26, 78 (2026). DOI: 10.1186/s12874-026-02793-5. 出版2026-02-21、版の記録2026-04-08。
- [R2] Zhang, Chen, Shi. Handling Item-Level Missing Data in Linear Regression: A Tutorial. Advances in Methods and Practices in Psychological Science 9(1), 2026-02-18. DOI: 10.1177/25152459261416497。
- [R3] Shi et al., TabDiff: a Mixed-type Diffusion Model for Tabular Data Generation. arXiv:2410.20626。
- [R4] Phi_K correlation library公式ドキュメント。`https://phik.readthedocs.io/`。Baak et al., arXiv:1811.11440 / DOI:10.1016/j.csda.2020.107043。
- [R5] Yun and Barber, Selective inference for clustering with unknown variance. arXiv:2301.12999。
- [R6] Meade and Craig, Identifying careless responses in survey data. Psychological Methods (2012). PMID:22506584。
- [R7] scikit-learn公式ドキュメント「Permutation feature importance」。`https://scikit-learn.org/stable/modules/permutation_importance.html`。
- [R8] Pew Research Center, Social Media Use 2025 — Methodology, 2025-11-20。`https://www.pewresearch.org/internet/2025/11/20/social-media-use-2025-methodology/`。
- [R9] scikit-learn 1.6.1公式LogisticRegression文書。`Only used if penalty='elasticnet'`。`https://scikit-learn.org/1.6/modules/generated/sklearn.linear_model.LogisticRegression.html`。

Libraryからは、改訂Diverse Subgroup Discovery & EMM仕様「貼り付けたマークダウン（1）(9).md」と00_IMPLEMENTATION_POLICY.mdを参照した。古いビルドのFINAL_STATUSを今回の版の合否根拠にはしていない。
