# DAVIS-PCP ローカル版：アンケートEDA監査報告

評価日：2026年9月11日（日本時間）  
対象：`davis-pcp-local(1).zip`  
SHA-256：`e3830b16f5012228b9f38380dbdfec6ed2af9bf2fc1c9f612c3fe9b26c0882fc`  
有効フロントエンド：`frontend/dist/assets/index-DoTyKBil.js`

## 結論

アンケート向けのコードブック・複数回答・重み・履歴が増えた方向性はよい。一方、値・設問の意味・分析対象行・重み・履歴が機能間で統一されておらず、例外なく成功したように見えて結果の意味が変わる経路が残る。この版を実回答データの分析結果確定に使う前に、P0と基礎集計関連P1を修正すべきである。

修正単位を45件に整理した（P0=8、P1=30、P2=7）。関連した同じ根本原因を複数の利用者影響に分けたものがあるため、独立した原因の数でも、全不具合の総数でもない。P0/P1/P2は本用途での修正優先度であり、規格化されたセキュリティスコアではない。

P0：データの原本・復元・分析結果の意味を壊すため、対象機能の利用停止または先行修正。P1：主要な集計・選択・分析の契約違反で、実用前に修正。P2：限定条件、表示・取込推定、配布上の不整合。静的確認事項は実行再現と明示的に区別した。

## 検証範囲と限界

今回の添付ZIPを展開し、その`backend/app`をそのまま実行した。過去版のアプリを代替として評価したものではない。フロントエンドは現配布バンドルを構文整形して追跡し、順序尺度の関連関数はNode.jsで直接実行した。

ブラウザによるlocalhostへの遷移は実行環境の管理ポリシーで`net::ERR_BLOCKED_BY_ADMINISTRATOR`となった。設定を回避していない。したがって、PCP実描画・マウスブラシ・軸ドラッグ・実ダウンロード・ブラウザ保存復元・WindowsランチャーはE2E確認済みではない。

この環境には現版のPolars/Arrowのネイティブ依存が揃わず、外部パッケージの取得もできなかったため、過去の静的配布物から「実行用依存パッケージだけ」を借りたPyodide環境で現版ソースを実行した。現版の指定依存バージョンをそのままWindows上で動作確認した結果ではない。

|項目|添付版の指定|再現試験で使用|
|---|---|---|
|Python|ランチャーは3.10以上を探索|Pyodide 0.27.7 / Python 3.12.7|
|Polars|1.43.2|1.18.0|
|NumPy|2.4.6|2.0.2|
|SciPy|1.18.0|1.14.1|
|scikit-learn|1.9.0|1.6.1|
|PyArrow|25.0.1|18.1.0|
|Pydantic|2.13.4|2.10.5|

ASGI経由のimport・集計・コードブック更新・補完・履歴・削除・モデル・探索などと、同じ現版ソースの分析関数を合成データで検証した。WASMにnative threadがないためsync handlerを同一event loop上で実行するテスト用adapterを使用し、PolarsのWASM Parquet native reader未実装部分のみArrow readerへ置換した。添付アプリのロジックは変更していない。このため並行処理・native I/O・性能の評価には使えない。

代替環境での再現値と現版ソースの誤った分岐・引数・数式を両方確認したものを中心に掲載した。指定版ライブラリでの最終回帰試験は残る。順序不定などライブラリ依存のある点は公式資料も照合した。実行環境由来のWASM I/Oエラーをアプリ不具合として数えていない。

## この監査で不足扱いしないもの

時系列・画像・予測サービス運用・原典DAVISの全機能再現は対象外。EDAとして全データで仮説探索を行うことは問題としていない。holdoutや確証的推測を全探索に義務付けない。検証モードを提供するなら、その名称と計算内容が一致する必要がある、という評価である。

## 良くなっている点・通過した確認

重複CSVヘッダは衝突回避され、3列を保存するケースを確認した。値が全件一意というだけで数値列がID扱いになり分析から消える旧挙動も、今回の小規模取込では確認されない。通常のコードブック対応summaryは99欠損を正しく除外する。共通クロス集計APIは古いdataRevisionに409を返す。MAの非加重完全回答の基本集計は試験データと整合する。

補完の表示が「実験的条件付き補完」、補正V等の表現へ整理されている点も旧指摘からの改善として扱った。コードブック・共通context・世代管理が無いのではなく、全経路を統一できていないことが今回の中心課題である。

## 修正一覧

|ID|優先度|領域|指摘|
|---|---|---|---|
|CTX-01|P0|共通コンテキスト|明示的に空のactive/sampledが全件へ戻る|
|CB-01|P1|コードブック|順序尺度の得点が行順・対象行に依存し、PCPとも逆転する|
|CB-02|P1|コードブック|逆転得点の上下限を選択群から再推定する|
|CB-03|P1|コードブック|旧schema更新APIがコードブックの型・roleを破壊する|
|IMP-01|P2|取込|先頭ゼロを保存してもコードを比率尺度として推定する|
|IMP-02|P1|取込|予約列__rowId__が衝突すると元回答が失われる|
|MISS-01|P0|欠損・補完|欠損コード99を平均補完の有効値として使う|
|MISS-02|P1|欠損・補完|FEDF・LOESSがコードブック欠損を無視する|
|IMPUTE-01|P2|欠損・補完|定数2.5の補完が黙って2になる|
|IMPUTE-02|P1|欠損・補完|カテゴリ最頻値補完が最頻値でなく、同seedでも不定になる|
|IMPUTE-03|P1|欠損・補完|補完対象列が条件付け変数も決め、プレビューと適用が別計算になる|
|IMPUTE-04|P1|欠損・補完|別データセットへ補完すると元欠損と操作履歴が失われる|
|HIST-01|P0|保存・履歴|Undo後、実データは戻るのに平均が補完後のままになる|
|HIST-02|P0|保存・履歴|計算列をUndoするとスキーマが戻らず、全列集計が500になる|
|HIST-03|P1|保存・履歴|Undoを2回押すと取り消した補完が復活する|
|HIST-04|P1|保存・履歴|Undoした欠損セルに補完済みマスクが残る|
|HIST-05|P0|保存・履歴|削除成功後も原票・履歴がディスクに残る|
|WEIGHT-01|P0|重み付け|重み列自身の欠損コードを99倍の重みとして採用する|
|WEIGHT-02|P1|重み付け|全員の重みが1でも逆転項目の平均が一致しない|
|WEIGHT-03|P1|重み付け|複数回答だけweightColumnを黙って無視する|
|WEIGHT-04|P1|重み付け|補正重みの倍率だけで有意性が激変する|
|WEIGHT-05|P1|重み付け|クロス表の有効加重母数とweightedNが一致しない|
|XTAB-01|P1|クロス集計・選択連動|未出現の選択肢を追加しただけで統計量がnullになる|
|XTAB-02|P1|クロス集計・選択連動|欠損セルの再取得が0人になる|
|XTAB-03|P1|クロス集計・選択連動|大きなセルを選ぶと元のactive/selected scopeが欠落する|
|SAMPLE-01|P1|サンプリング|復元抽出の重複回数が集計で消える|
|SAMPLE-02|P2|サンプリング|実在しないrowIdを正当な抽出結果として返す|
|SAMPLE-03|P2|サンプリング|10万件超をサンプリングするためのAPI自身が拒否する|
|VERIFY-01|P0|探索・検証|サブグループ差ではなく全員の平均と0を検定する|
|VERIFY-02|P1|探索・検証|固定候補を検証するはずが候補探索をやり直す|
|VERIFY-03|P1|探索・検証|5-fold交差検証が最初の1 foldだけで終わる|
|VERIFY-04|P1|探索・検証|独立データの自動採番ID同士を同一回答者と誤認する|
|VERIFY-05|P1|探索・検証|条件が異なるmodern候補集合で同じhashになる|
|MINING-01|P1|探索・検証|指定した最小群サイズを黙って緩和する|
|SENS-01|P0|感度分析|選択した部分集団を無視し、負の群差を正の全体平均へ取り替える|
|SENS-02|P1|感度分析|平均差の標準誤差に全員平均の式を使う|
|SENS-03|P1|感度分析|bootstrap回数とseedが実計算に使われない|
|KDA-01|P1|モデル|定数の目的変数に重要度100%の最優先ドライバーを付ける|
|KDA-02|P1|モデル|KDAだけ共通scope/revision契約から外れる|
|TREE-01|P1|モデル|決定木のクラス人数を割合から整数化して0/1にする|
|TREE-02|P1|モデル|分岐ノードに所属する回答者が0人と返る|
|FEDF-01|P2|表示意味|同じ回答値に行順で異なる分位座標を付ける|
|TEXT-01|P2|表示意味|差0や負の差を強調する自動説明文が出る|
|SEC-01|P1|ローカル配布・安全性|静的ファイル返却に公開ディレクトリの境界確認がない|
|PKG-01|P2|ローカル配布・安全性|ランチャーが依存バージョン変更を検出せず、空白パスにも弱い|

## 詳細

### CTX-01 [P0] 明示的に空のactive/sampledが全件へ戻る

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：有効行を空配列にして、scope="active", activeRowIds=[]でクロス集計する。共通関数にはscope="sampled", sampledRowIds=[]も入力した。

実際：active=[]のクロス集計がscopeCount=7、effectiveN=6の全件集計になる。resolve_scope([a,b], active=[])とsampled=[]はいずれも[a,b]。selected=[]だけは0件。

期待・影響：未指定と0件を分け、明示的な空配列は0件のまま扱う。全員除外・該当者なしが全件へ戻ってはならない。

修正・受入条件：Noneと[]を区別する。全scopeについて未指定・空・一部・不正IDの契約試験を追加し、PCP/表/集計/探索が同じ対象数になることを受入条件にする。

根拠コード：`backend/app/domain/context.py:95-140`。

実行証拠：`evidence/01_data_contracts.json#scope_empty`、`evidence/03_crosstab.json#active_empty`、`evidence/03_crosstab.json#selected_empty`。

---

### CB-01 [P1] 順序尺度の得点が行順・対象行に依存し、PCPとも逆転する

確認区分：API再現＋フロントエンド静的照合（画面操作未確認）。

再現・確認手順：Q1=[5,1,3]をordinalに変更し、categoryOrderを未指定にする。全件と値1の行だけでanalysis_seriesを比較。フロントの軸生成関数Tse/Q8も同じ入力で実行。

実際：バックエンド得点は[1,2,3]。元の値1は全件で2、単独抽出で1になる。フロントはカテゴリ[1,3,5]へ数値順ソートし、入力[5,1,3]の正規化座標は[1,0,0.5]。

期待・影響：選択肢の意味・順位は回答者の並びや選択群に依存しない。PCPと分析側は同じ固定カテゴリ順を使う。

修正・受入条件：ordinalには固定のカテゴリ順を必須にするか、全データから推定してコードブックへ一度だけ保存する。フィルタ前に得点変換を確定させる。行順入替・部分抽出で同じコードの得点が不変であること。

根拠コード：`backend/app/domain/codebook_adapter.py:132-165`、`backend/app/domain/codebook_adapter.py:199-216`、`frontend.pretty.js:12441-12520`。

実行証拠：`evidence/04_algorithms.json#ordinal_scores_all`、`evidence/04_algorithms.json#ordinal_scores_secondrow_alone`、`evidence/06_frontend.json`。

---

### CB-02 [P1] 逆転得点の上下限を選択群から再推定する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：x=[1,3,5]、isReversed=true、categoryOrder未指定。全件とx=1の1行を比較。

実際：全件では1が5へ逆転する処理だが、x=1だけを選択すると平均1になる。部分集団に観測されたmin/maxを逆転の両端に使っている。

期待・影響：1～5の尺度なら常に6-x。分析対象を狭めても同じ回答は同じ逆転得点を持つ。

修正・受入条件：尺度の理論的下限・上限を保存する。両端未定義なら逆転を拒否または明示的確認にする。subsetでの再推定を禁止する。

根拠コード：`backend/app/domain/codebook_adapter.py:227-248`。

実行証拠：`evidence/04_algorithms.json#reverse_all`、`evidence/04_algorithms.json#reverse_low`。

---

### CB-03 [P1] 旧schema更新APIがコードブックの型・roleを破壊する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：PATCH /datasets/{id}/schemaにcategoryOrder="alphabetical", role="categorical_axis"を渡す。

実際：200で受理され、コードブックのcategoryOrderが配列ではなく文字列になる。その後の分布にa,l,p,h,...という0件の架空カテゴリが現れる。roleもコードブック側enumと不整合。

期待・影響：旧スキーマ値から新コードブック値へ明示変換するか、互換性のない入力を422で拒否する。

修正・受入条件：更新経路を型付きコードブックサービスへ統合する。PATCH後のコードブックを必ず同じPydanticモデルで再検証する。

限定・補足：公開APIとして再現。現画面からこの旧APIを呼ぶ操作は確認できていない。

根拠コード：`backend/app/api/datasets.py:837-900`。

実行証拠：`evidence/04_algorithms.json#schema_patch`、`evidence/04_algorithms.json#codebook_after_patch`、`evidence/04_algorithms.json#summary_after_patch`。

---

### IMP-01 [P2] 先頭ゼロを保存してもコードを比率尺度として推定する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：code列に001,002,003を持つCSVを読み込む。

実際：文字列そのものは保存されるが、semanticType=numeric、scaleType=ratioになり、コード列の平均2が計算される。

期待・影響：文字列保存と分析上の名義尺度判定を分離し、先頭ゼロ付きコードは少なくとも確認対象にする。

修正・受入条件：コード候補フラグを取込プレビューへ出す。自動判定だけで数値の意味を確定しない。ユーザーが尺度を訂正できるためP2とする。

根拠コード：`backend/app/services/import_service.py:132-156`、`backend/app/services/import_service.py:159-219`。

実行証拠：`evidence/01_data_contracts.json#leading_metadata`、`evidence/01_data_contracts.json#leading_summary`。

---

### IMP-02 [P1] 予約列__rowId__が衝突すると元回答が失われる

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：CSVヘッダ__rowId__,Q1、データa,1とa,2を読み込む。

実際：200成功のままa,aがROW-000001,ROW-000002へ置換される。元の__rowId__列は通常列としても残らず、columnCount=1。

期待・影響：内部識別子用の列を利用者の列に上書きしない。予約名衝突はrenameまたは明示的エラーにする。

修正・受入条件：内部rowIdを別構造にするか、取込前に予約名を退避する。重複・空白・明示rowIdColumn指定の全ケースで入力列を保存する。

根拠コード：`backend/app/storage/dataset_store.py:439-458`、`backend/app/api/datasets.py:196-211`。

実行証拠：`evidence/01_data_contracts.json#reserved_import`、`evidence/01_data_contracts.json#reserved_values`。

---

### MISS-01 [P0] 欠損コード99を平均補完の有効値として使う

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：Q1=[1,3,99,NULL]、missingCodes=[99]。平均補完を実行する。

実際：補完前の集計は有効2件・平均2。補完器は99を有効値扱いし、NULLを34.3333で埋める。99自体は残り、補完後のコードブック対応集計は平均12.7778になる。

期待・影響：コードブックで欠損とした値は補完の説明変数・ドナー・平均の母数からも除く。非該当は通常欠損と別扱いにする。

修正・受入条件：補完の前処理を共通AnalysisViewに統合する。上記データで有効ドナーが1と3だけになり、普通の欠損だけが所定の方針で2に補完されること。

根拠コード：`backend/app/api/datasets.py:1059-1087`、`backend/app/algorithms/imputation/core.py:45-173`。

実行証拠：`evidence/01_data_contracts.json#missing_before`、`evidence/01_data_contracts.json#impute_values`、`evidence/01_data_contracts.json#missing_after`。

---

### MISS-02 [P1] FEDF・LOESSがコードブック欠損を無視する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：FEDFでx=[1,1,1,1,99]、99を欠損指定。LOESSでy=[0,1,2,3,4,99]、99を欠損指定。

実際：通常集計はFEDF用xを有効4件・最大1とするが、FEDFは有効5件・最大99。LOESSもy=99を観測値として6点の曲線を作る。

期待・影響：同じ設問・同じ対象行で、図の値と集計の有効値が一致する。欠損コードに引っ張られた分布や回帰線を出さない。

修正・受入条件：分布・回帰APIにもコードブックアダプタとrevision検証を適用する。旧robustnessも生値の数値化経路があるため、同じ検査対象に含める。

根拠コード：`backend/app/api/distribution.py:16-40`、`backend/app/api/regression.py:16-52`。

実行証拠：`evidence/04_algorithms.json#fed_summary`、`evidence/04_algorithms.json#fed_result`、`evidence/04_algorithms.json#loess`。

---

### IMPUTE-01 [P2] 定数2.5の補完が黙って2になる

確認区分：現版ソースの関数再現＋コード照合（代替WASMランタイム）。

再現・確認手順：整数列x=[1,NULL,5]へstrategy=constant、constant_value=2.5を指定。

実際：返却は[1,2,5]。入力した定数ではなく整数へ切り詰められる。

期待・影響：Floatへの昇格か不適合エラーのどちらかにする。無断で値を変えない。

修正・受入条件：整数列＋小数定数、負数、小数桁、オーバーフローの境界試験を追加する。

根拠コード：`backend/app/algorithms/imputation/core.py:139-170`。

実行証拠：`evidence/04_algorithms.json#constant_fraction`。

---

### IMPUTE-02 [P1] カテゴリ最頻値補完が最頻値でなく、同seedでも不定になる

確認区分：現版ソースの関数再現＋コード照合（代替WASMランタイム）。

再現・確認手順：実験的条件付き補完でaが10件、bが1件、NULLが1件。temperature=0、seed=42を固定して12回実行。

実際：補完aが9回、bが3回。diagnosticsのmodeもbになる。value_countsを件数順に並べず、先頭カテゴリをmost_freqとしている。

期待・影響：最頻値は常にa。同じデータ・同じseedで再現できる。頻度が同率の場合だけ明示的なタイ規則を用いる。

修正・受入条件：countのargmaxを使い、サンプリング用のカテゴリ列と確率列を固定順に整列する。Polars公式資料もsort=False時の順を“non-deterministic”と説明する。[R4]

限定・補足：現表示の「実験的条件付き補完」という名称変更自体は妥当。公式TabDiff論文の実装だと誤表示している、という旧指摘は今回繰り返さない。

根拠コード：`backend/app/algorithms/imputation/tabdiff.py:241-277`。

実行証拠：`evidence/04_algorithms.json#tabdiff_categorical_modes`。

---

### IMPUTE-03 [P1] 補完対象列が条件付け変数も決め、プレビューと適用が別計算になる

確認区分：現版ソースの関数再現＋コード照合（代替WASMランタイム）。

再現・確認手順：x=i、y=2i+5の20行で末尾5行のyが欠損。同seedでcolumns=[y]と[x,y]を比較する。

実際：欠損5行は[y]で[12,21,6,29,17]、[x,y]で[27,29,30,32,33]。単列プレビューは[y]だけを渡すため、複数列適用時と入力モデルが変わる。

期待・影響：補完対象と条件付けに使う説明変数を分離する。プレビューは適用時の同一計画・同一結果の部分表示にする。

修正・受入条件：targetColumnsとpredictorColumnsを分ける。全列の補完計画を一度確定してからプレビューする。既観測xを補完対象にチェックする必要がない設計にする。

限定・補足：アルゴリズム関数の差を再現し、単列プレビュー経路をソース照合。ブラウザのプレビュー画面操作自体は未確認。

根拠コード：`backend/app/algorithms/imputation/core.py:176-268`、`backend/app/algorithms/imputation/tabdiff.py:32-130`、`backend/app/api/datasets.py:1045-1087`。

実行証拠：`evidence/04_algorithms.json#tabdiff_y_only`、`evidence/04_algorithms.json#tabdiff_xy`。

---

### IMPUTE-04 [P1] 別データセットへ補完すると元欠損と操作履歴が失われる

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：x=[1,3,NULL]を平均補完し、inPlace=falseで新規データセットへ出力する。

実際：新データセットの補完マスクは空。raw.parquetも[1,3,2]という補完済み値。provenanceの操作はimportで、補完方式・設定が記録されない。

期待・影響：派生データであること、元データとの対応、どのセルをどう補完したかを保持する。原本に戻す機能は元欠損へ戻せるべき。

修正・受入条件：派生元参照だけでなく原本・セルマスク・実行パラメータを承継する。補完済み値を新しいrawにする仕様なら、rawの意味を「派生作成時」に変更し、元原本への別導線を提供する。

根拠コード：`backend/app/api/datasets.py:1076-1143`、`backend/app/api/datasets.py:327-387`。

実行証拠：`evidence/02_history.json#copy_mask`、`evidence/02_history.json#copy_raw`、`evidence/02_history.json#copy_provenance`。

---

### HIST-01 [P0] Undo後、実データは戻るのに平均が補完後のままになる

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：x=[1,3,NULL]を定数9で補完→集計→Undo→集計。

実際：データは[1,3,NULL]へ戻るが、集計は有効3件・平均4.3333のまま。正しくは有効2件・平均2。

期待・影響：値、fingerprint、dataRevision、統計キャッシュが同じ世代を示す。

修正・受入条件：Undo時に値からfingerprintを更新し、キャッシュキーにもdataRevisionを含める。値と集計を別々に確認する回帰テストを追加する。

根拠コード：`backend/app/api/datasets.py:1307-1343`、`backend/app/storage/dataset_store.py:288-320`、`backend/app/api/summaries.py:48-85`。

実行証拠：`evidence/02_history.json#imputed_values`、`evidence/02_history.json#undo1_values`、`evidence/02_history.json#summary_undo1`。

---

### HIST-02 [P0] 計算列をUndoするとスキーマが戻らず、全列集計が500になる

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：x列だけのデータにz=x+1を追加し、Undoする。

実際：実データの列は__rowId__,xに戻るが、メタデータにはzとcolumnCount=2が残る。全列summaryは500。

期待・影響：Undoは値だけでなく列構造・コードブック・列ID・関連グループ定義を同時に復元する。

修正・受入条件：DatasetStateのスナップショットにスキーマとコードブックを含める。列追加/削除/rename/尺度変更のUndo後に全APIが正常に動くことを条件にする。

根拠コード：`backend/app/api/datasets.py:1307-1343`、`backend/app/storage/dataset_store.py:260-272`。

実行証拠：`evidence/02_history.json#calc_columns_actual`、`evidence/02_history.json#calc_schema_after`、`evidence/02_history.json#calc_summary_after`。

---

### HIST-03 [P1] Undoを2回押すと取り消した補完が復活する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：1回の補完操作に対してUndoを2回実行する。

実際：Undo1でNULLへ戻り、Undo2で9が再び入る。Undo操作自体が新しい履歴ノードとなり、その親を次のUndo先にしている。

期待・影響：Undoは過去方向へ進む。取り消した操作の再適用はRedoに限定する。

修正・受入条件：監査ログの追加とユーザー操作履歴カーソルを分離する。Undo/Redo/分岐編集を状態遷移表でテストする。

根拠コード：`backend/app/api/datasets.py:1307-1348`、`backend/app/api/datasets.py:1376-1393`。

実行証拠：`evidence/02_history.json#undo1_values`、`evidence/02_history.json#undo2_values`。

---

### HIST-04 [P1] Undoした欠損セルに補完済みマスクが残る

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：補完→Undo後、値とimputation-maskを読む。

実際：値はNULLなのに、同じセルにmethodId=constantなどの補完マスクが残る。

期待・影響：セルが観測値・補完値・未補完欠損のどれかを、値とマスクが一致して示す。

修正・受入条件：マスクもrevisionごとに保存・復元する。新しいmaskRevisionだけ振って旧マスクを流用しない。

根拠コード：`backend/app/api/datasets.py:1307-1343`、`backend/app/storage/dataset_store.py:288-400`。

実行証拠：`evidence/02_history.json#undo1_values`、`evidence/02_history.json#undo1_mask`。

---

### HIST-05 [P0] 削除成功後も原票・履歴がディスクに残る

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：合成回答者private-a/private-bを含むデータセットを削除する。

実際：DELETEは200だが、*.raw.parquet、*.revisions/、*.provenance.json、*.imputation-mask.jsonが残る。rawから回答者と回答値を再読できた。

期待・影響：「データセットを削除」と表示するなら、保持するものを明示し、原票・履歴・派生キャッシュを含む削除方針を一貫させる。

修正・受入条件：所属ファイル一覧を管理してカスケード削除する。履歴保持型なら論理削除と完全削除を分ける。これはファイル残留の指摘であり、記憶媒体の物理的安全消去まで検証した意味ではない。

根拠コード：`backend/app/storage/dataset_store.py:428-436`、`backend/app/api/datasets.py:1656-1663`。

実行証拠：`evidence/02_history.json#files_after_delete`、`evidence/02_history.json#raw_after_delete`。

---

### WEIGHT-01 [P0] 重み列自身の欠損コードを99倍の重みとして採用する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：x=[0,10]、w=[1,99]。wをweightにし、missingCodes=[99]を指定して加重集計。

実際：weightedN=100、weightedMean=9.9、weightMissingCount=0。コードブック上は欠損の重みが圧倒的な寄与を持つ。

期待・影響：重みが欠損の行は方針に従い除外/拒否し、人数を報告する。本例で除外なら加重平均0。

修正・受入条件：重み抽出にもコードブックのmissingCodes/reasonsを適用する。0・負・NaN・Inf・文字列・欠損コードを区別して検証する。

根拠コード：`backend/app/domain/survey_weight.py:66-107`、`backend/app/api/summaries.py:48-85`。

実行証拠：`evidence/01_data_contracts.json#weight_missing`。

---

### WEIGHT-02 [P1] 全員の重みが1でも逆転項目の平均が一致しない

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：x=[1,1,5]、逆転設定、カテゴリ領域1～5、w=[1,1,1]。

実際：通常平均3.6667に対して加重平均2.3333。加重経路は逆転前の数値を使っている。

期待・影響：同じ得点変換後の値を加重・非加重の双方で利用する。全重み1は非加重と一致する。

修正・受入条件：共通のanalysis_seriesを加重計算にも使い、identity-weight不変条件を全尺度で検証する。

根拠コード：`backend/app/algorithms/summaries/core.py:251-323`。

実行証拠：`evidence/01_data_contracts.json#weight_reverse`。

---

### WEIGHT-03 [P1] 複数回答だけweightColumnを黙って無視する

確認区分：API再現＋フロントエンド静的照合（画面操作未確認）。

再現・確認手順：2回答者がaのみ/bのみを選択、重み9/1。同じSummary画面が送るweightColumnを通常集計とMA集計に渡す。

実際：通常列は加重90%/10%になる一方、MAはpctRespondent=50%/50%。MAの入力型にweightColumnがなく追加フィールドが捨てられる。非対応通知もない。

期待・影響：MAにも回答者重みを適用するか、明示的に非対応と返して画面表示を分ける。

修正・受入条件：対応しない設定はextra=forbidまたはweightStatus=unsupportedで返す。通常設問とMAを同じ加重バッジだけで包まない。

根拠コード：`backend/app/api/multi_response.py:37-43`、`backend/app/api/multi_response.py:218-301`、`frontend.pretty.js:12710-12755`。

実行証拠：`evidence/05_models_and_scope.json#ma_weighted`、`evidence/05_models_and_scope.json#ordinary_weighted`。

---

### WEIGHT-04 [P1] 補正重みの倍率だけで有意性が激変する

確認区分：現版ソースの関数再現＋コード照合（代替WASMランタイム）。

再現・確認手順：2×2度数[[2,1],[1,2]]の6人について、全重み1と全重み100を比較。

実際：回答割合とCramerのV=0.3333は同じなのに、p=0.4142から3.215×10^-16、調整残差0.816から8.165、星なしから***へ変わる。

期待・影響：調査の補正重みと、実際に独立回答者が増える度数重みを区別する。重みの尺度変更を追加標本の証拠にしない。

修正・受入条件：当面は補正重み付きで確証的なp/星を非表示にし、記述集計だけ提供してよい。推測を実装するなら調査設計・分散推定を扱う。survey公式資料のRao-Scott correctionsが比較対象。[R3]

限定・補足：現実装にも「加重度数によるPearson近似、設計効果は推定しない」の警告はある。警告が全くないとは評価していない。度数重みを明示した用途なら倍率で標本数が増えるのは別の意味になる。

根拠コード：`backend/app/algorithms/summaries/crosstab.py:97-201`、`backend/app/algorithms/summaries/crosstab.py:220-324`、`backend/app/api/summaries.py:289-330`。

実行証拠：`evidence/03_crosstab.json#scaled_w1`、`evidence/03_crosstab.json#scaled_w100`。

---

### WEIGHT-05 [P1] クロス表の有効加重母数とweightedNが一致しない

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：有効6人をw=1、クロス表の片方の質問が欠損の1人をw=100にする。

実際：grandTotal.count=6、effectiveN=6だが、トップレベルweightedN=106。欠損除外前の重み合計が混在する。

期待・影響：分析スコープ全体の重み合計と、両設問有効者の重み合計を異なる名前・説明で返す。

修正・受入条件：scopeWeightedNとvalidWeightedNを分ける。表の百分率に使った分母をセル/表で検証できるようにする。

根拠コード：`backend/app/api/summaries.py:236-330`。

実行証拠：`evidence/03_crosstab.json#with_weight`。

---

### XTAB-01 [P1] 未出現の選択肢を追加しただけで統計量がnullになる

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：実データがx/y×u/vの表に、コードブックだけで未出現カテゴリzを追加。

実際：自由度が1から2になり、chi2・pValue・cramersVがnull。期待度数0の行を検定行列に入れ、例外をnull化している。

期待・影響：表示上の0件カテゴリは保持してよいが、検定行列は正の周辺度数を持つ行列にする。

修正・受入条件：表示用カテゴリ領域と推測用有効行列を分離する。未出現ラベルの追加で観測表の統計量が変化しないこと。

根拠コード：`backend/app/algorithms/summaries/crosstab.py:51-66`、`backend/app/algorithms/summaries/crosstab.py:168-201`。

実行証拠：`evidence/03_crosstab.json#zero_category`。

---

### XTAB-02 [P1] 欠損セルの再取得が0人になる

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：missingPolicy=include_missingで欠損カテゴリを表示し、その__missing__セルをcell-row-ids APIで再取得。

実際：集計セルは1人あるが再取得は空。再取得側が生コードを比較し、集計時の合成欠損カテゴリIDを再現していない。

期待・影響：表に計上されたセル所属者と、そのセルから得られる選択行が一致する。

修正・受入条件：セル分類関数を集計と再取得で共有する。非該当や通常欠損も同じ分類規則にする。

限定・補足：少数セルで応答内のrowIdsを直接使う場合には直ちに発現しない。UIはrowIds切捨て時に再取得経路を使う。

根拠コード：`backend/app/algorithms/summaries/crosstab.py:69-94`、`backend/app/api/summaries.py:334-375`。

実行証拠：`evidence/03_crosstab.json#missing_included`、`evidence/03_crosstab.json#missing_cell_lookup`。

---

### XTAB-03 [P1] 大きなセルを選ぶと元のactive/selected scopeが欠落する

確認区分：API再現＋フロントエンド静的照合（画面操作未確認）。

再現・確認手順：フロントのrowIdsTruncated=true時の再取得リクエストを追跡。通常の集計リクエストと比較する。

実際：通常リクエストには対象IDがあるが、再取得ではscope文字列だけでactiveRowIds/selectedRowIds/sampledRowIdsを渡さない。activeなら全件、selectedなら空へずれる。APIでも欠落時の全件化を再現。

期待・影響：表示済みクロス表を作った正確なscopeを、セル所属者取得にも固定して渡す。

修正・受入条件：context全体またはサーバ側スコープトークンを保持する。1万件を超えるセルで、選択群の外の人が混ざらないことをブラウザ回帰試験にする。

限定・補足：1万件超の実マウス選択は未実施。リクエスト構築の静的確認と同等API入力の再現。

根拠コード：`frontend.pretty.js:13950-13984`、`backend/app/api/summaries.py:334-375`、`backend/app/domain/context.py:95-140`。

実行証拠：`evidence/03_crosstab.json#active_relookup_missing_scope_ids`。

---

### SAMPLE-01 [P1] 復元抽出の重複回数が集計で消える

確認区分：API再現＋フロントエンド静的照合（画面操作未確認）。

再現・確認手順：x=[0,10,100]からwith_replacement,size=5,seed=42で抽出し、返されたsampledRowIdsをsummaryへ渡す。

実際：抽出値は[0,100,10,10,10]、正しい抽出平均26。集計は重複IDをis_inで集合化し、3人・平均36.6667になる。sampledRowWeightsは返されるが連動する集計には適用されない。

期待・影響：復元抽出では抽出回数を保持する。ユニーク回答者のビューを示すなら、それは別指標だと明示する。

修正・受入条件：抽出インスタンスIDまたはmultiplicityを分析コンテキストに追加する。調査重みと抽出回数は別フィールドで保持し、両方ある場合の合成規則も明示する。

根拠コード：`backend/app/api/observations.py:34-90`、`backend/app/api/summaries.py:48-85`。

実行証拠：`evidence/08_sampling.json#sample`、`evidence/08_sampling.json#summary`、`evidence/08_sampling.json#expected_sample_mean`。

---

### SAMPLE-02 [P2] 実在しないrowIdを正当な抽出結果として返す

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：activeRowIds=["not-a-real-row"]、非復元1件抽出。

実際：200でsampleSize=1、sampledRowIds=[not-a-real-row]を返す。入力IDがデータセットに所属するか確認していない。

期待・影響：古い選択状態や異なるデータセットのIDを拒否、または除外件数を明示する。

修正・受入条件：実在IDとの照合とrevisionチェックを行う。0件へ落ちた場合に再び全件へ拡大しない。

根拠コード：`backend/app/api/observations.py:34-49`。

実行証拠：`evidence/08_sampling.json#invalid_candidates`。

---

### SAMPLE-03 [P2] 10万件超をサンプリングするためのAPI自身が拒否する

確認区分：静的確認（実操作・本番ランタイム未確認）。

再現・確認手順：sample_observationsの上限とエラーメッセージを確認。

実際：抽出前の候補数が100,000件を超えると413となり、「サンプリング機能を利用してください」と案内する。

期待・影響：大きいデータを減らす目的でサンプリングに入れるか、別の実行可能な縮小手順を提示する。

修正・受入条件：サンプリングは全ID転送なしでサーバ側から実施する。上限が必要なら、対象件数と操作可能な代替経路を説明する。

限定・補足：10万件規模の性能測定は実施していない。分岐と表示文言の静的確認。

根拠コード：`backend/app/api/observations.py:15-47`。

---

### VERIFY-01 [P0] サブグループ差ではなく全員の平均と0を検定する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：A群60人・B群60人、各群に同じ2/3/4の分布を持たせる。探索後にholdout検証、seed=42。

実際：探索の群間効果量は0。それでも検証APIはeffectSize=3.1389、pValue=0、pAdjusted=0、isExploratory=falseを返す。実際の評価部分のA/B平均差は0.00952、Welch検定p=0.97083。

期待・影響：固定された部分集団と比較対象に対し、探索時と同じ推定対象を評価する。全体平均が0と異なることは群間差の検証ではない。

修正・受入条件：当面この検証機能を無効化する。再実装時はrule/target/comparator/effectDefinitionを固定して評価する。単一平均と群間差を取り違えない。[R1][R5]

限定・補足：pValue=0は応答の小数6桁への丸めによる表示であり、真の確率0を実証した意味ではない。EDA全体にholdoutを義務づける指摘ではない。

根拠コード：`backend/app/api/mining.py:229-273`。

実行証拠：`evidence/07_mining_verification.json#exploration`、`evidence/07_mining_verification.json#verification`、`evidence/07_mining_verification.json#correct_eval_group_comparison`。

---

### VERIFY-02 [P1] 固定候補を検証するはずが候補探索をやり直す

確認区分：静的確認（実操作・本番ランタイム未確認）。

再現・確認手順：_verify_subgroupsの候補固定処理と探索時パラメータの受渡しを確認する。

実際：「Never re-discover candidates」とコメントしながらselection側でrun_subgroup_miningを再実行し、min_group_size=30等を固定。連番IDで探索時候補を対応付ける。

期待・影響：探索で採用した実際の条件式・比較群・対象変数・設定を固定して保持する。

修正・受入条件：連番IDだけでなくcanonical ruleを保存・照合する。探索し直すプロトコルなら、その事実を別の検証設計として明記する。

限定・補足：再探索すること自体があらゆる分割法で禁止、という意味ではない。「探索時の固定候補を検証する」という実装契約と食い違う。

根拠コード：`backend/app/api/mining.py:203-228`。

実行証拠：`evidence/07_mining_verification.json#verification`。

---

### VERIFY-03 [P1] 5-fold交差検証が最初の1 foldだけで終わる

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：120人、method=cross_validation,k=5。

実際：selection=96、evaluation=24の1回しか評価しない。コードもfolds[0]のみ。5 foldの集約やout-of-fold全体評価はない。

期待・影響：名称通り全foldを評価・集約するか、単回分割として表示する。

修正・受入条件：検証方法の名称を実処理に一致させる。全foldの評価行が予定どおり使われることを確認する。

根拠コード：`backend/app/api/mining.py:174-181`、`backend/app/api/mining.py:263-273`。

実行証拠：`evidence/07_mining_verification.json#cv_singlefold`。

---

### VERIFY-04 [P1] 独立データの自動採番ID同士を同一回答者と誤認する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：同じ設問構造の別データセットを通常インポートし、independent検証に指定。

実際：各データセットでROW-000001から採番されるため、別データセットなのに同一rowId混入として422。

期待・影響：データセット内rowIdと、データセットをまたぐ回答者識別子を区別する。

修正・受入条件：内部IDは(datasetId,rowId)で名前空間化する。独立性の判定が必要なら、別途「回答者を照合するID列」を明示的に指定する。

限定・補足：同一の分布を持つ合成表を別々に取り込んだ試験。現実の回答者独立性そのものをデータ内容から証明したわけではない。

根拠コード：`backend/app/api/mining.py:182-199`、`backend/app/storage/dataset_store.py:439-458`。

実行証拠：`evidence/07_mining_verification.json#independent_auto_ids`。

---

### VERIFY-05 [P1] 条件が異なるmodern候補集合で同じhashになる

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：同一データ・同一質問で、属性Aのみの探索と属性Bのみの探索をそれぞれtopK=2で実行。

実際：A==a/bとB==c/dという異なるルールなのに、candidateSetHashが両方sha256:518d7f...77022。APIが存在しないitem.conditionを読むため空文字をhashしている。

期待・影響：候補の実条件・対象・比較対象・データ世代が異なれば、同一候補と判定されない。

修正・受入条件：rule.conditionsのcanonical表現とtarget_question/target_pairを含める。属性差替・閾値差替・論理演算子・schema/data revisionでhashが変わる受入試験を追加する。

根拠コード：`backend/app/api/mining.py:378-384`。

実行証拠：`evidence/07_mining_verification.json#modern_A`、`evidence/07_mining_verification.json#modern_B`。

---

### MINING-01 [P1] 指定した最小群サイズを黙って緩和する

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：全20人のデータにminGroupSize=100を指定する。

実際：10人の部分集団が2件返る。小規模データでmin_group_sizeをmax(3,n//6)へ自動で下げる。実効下限は応答で明示されない。

期待・影響：利用者が設定した最小群サイズを守る。条件を満たさない場合は候補0件とし、緩和は明示的操作にする。

修正・受入条件：要求値と実効値を分け、無断で変更しない。小集団の不安定性を避ける設定を実装側で破らない。

根拠コード：`backend/app/algorithms/mining/modern_subgroup.py:649-665`。

実行証拠：`evidence/07_mining_verification.json#modern_minimum_100`。

---

### SENS-01 [P0] 選択した部分集団を無視し、負の群差を正の全体平均へ取り替える

確認区分：API再現＋フロントエンド静的照合（画面操作未確認）。

再現・確認手順：候補群y=[0,1,2,3,4]、補集合y=[10,11,12,13,14]。candidate.type=subgroup_diffと候補群のrowIdsを渡す。

実際：本来の群差は2-12=-10だが、APIは全体平均+7をeffectSizeとして返し、direction=positive、isRobust=true。candidate.rowIdsがあると群指定を消した後、そのID自体を計算へ渡していない。

期待・影響：調べている効果量・比較対象が感度分析へ移動しても変わらない。

修正・受入条件：候補membershipとcomplementを明示的に渡し、baselineが元分析と一致することを必須条件にする。修正前は部分集団候補からの感度分析を無効化する。

根拠コード：`backend/app/api/robustness.py:89-125`、`frontend.pretty.js:13548-13570`。

実行証拠：`evidence/07_mining_verification.json#sensitivity_selected`、`evidence/07_mining_verification.json#sensitivity_group`。

---

### SENS-02 [P1] 平均差の標準誤差に全員平均の式を使う

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：上記2群をgroupColumn/compareGroupsで正しく指定し、区間の計算を照合。

実際：効果量は-10へ戻るが、SEとしてstd(concat(A,B))/sqrt(nA+nB)を使い、区間[-13.3948,-6.6052]を返す。各群n=5、標本分散2.5なので独立群の平均差のSEはsqrt(2.5/5+2.5/5)=1であり、実装の約1.732とは異なる。

期待・影響：平均差の分散は群別分散から計算する。点推定と区間推定で同じ統計量を扱う。

修正・受入条件：Welch等の適切な群間差区間、または正しく定義された再標本化を使う。[R5] 小標本では臨界値1.96固定の妥当性も別途扱う。

限定・補足：1.96を使うかt分布を使うか以前に、ここではSEの式そのものが別の統計量になっている。

根拠コード：`backend/app/algorithms/robustness/sensitivity.py:97-117`。

実行証拠：`evidence/07_mining_verification.json#sensitivity_group`。

---

### SENS-03 [P1] bootstrap回数とseedが実計算に使われない

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：bootstrapB=1,seed=42とbootstrapB=999,seed=123を比較する。

実際：CI・点推定が同じ。コードではseedを捨て、bootstrap_bは応答フィールドに載せるだけで再標本化していない。

期待・影響：実際にbootstrapするか、パラメータ・表示を削除して解析的近似と明示する。

修正・受入条件：ダミー設定をUI/APIへ公開しない。設定値だけを変えて再計算したふりをしない。

根拠コード：`backend/app/algorithms/robustness/sensitivity.py:50-61`、`backend/app/algorithms/robustness/sensitivity.py:97-153`。

実行証拠：`evidence/07_mining_verification.json#sensitivity_group`、`evidence/07_mining_verification.json#sensitivity_group_different_bootstrap`。

---

### KDA-01 [P1] 定数の目的変数に重要度100%の最優先ドライバーを付ける

確認区分：現版ソースの関数再現＋コード照合（代替WASMランタイム）。

再現・確認手順：y=5が10人全員で一定、x=0～9。KDAを実行する。

実際：R²=1、xのimportance_pct=100、最優先キードライバー。ところが係数・傾き・相関はいずれも0。

期待・影響：説明すべき目的変数の変動がないため重要度は算定不可とするか、少なくとも最優先と解釈しない。

修正・受入条件：目的変数分散0を前処理で検出し、NO_TARGET_VARIATIONとして返す。R²の有限値化というライブラリ上の便宜と、説明力の解釈を分離する。

限定・補足：R²=1という数値だけを誤りとした指摘ではない。定数目的変数で重要度100%・最優先という解釈を生成する点が問題。

根拠コード：`backend/app/algorithms/models/kda.py:85-130`、`backend/app/algorithms/models/kda.py:160-241`。

実行証拠：`evidence/05_models_and_scope.json#kda_constant`。

---

### KDA-02 [P1] KDAだけ共通scope/revision契約から外れる

確認区分：API再現＋フロントエンド静的照合（画面操作未確認）。

再現・確認手順：KDAへrowIds=[]、expectedDataRevision=999を送る。UIの送信項目も確認。

実際：200、n_valid=6で全件を分析する。KdaRequestにscope/revision/weightの項目がなく、フロントもdataset/outcome/driversだけを送る。

期待・影響：選択群を対象にしているのか全件なのかを統一・明示する。無視する設定を成功として受け取らない。

修正・受入条件：KDA/FEDF/LOESS等を共通AnalysisContextへ移行する。非対応scopeやweightは422または明確なunsupported状態にする。

根拠コード：`backend/app/api/models.py:382-415`、`frontend.pretty.js:13580-13602`。

実行証拠：`evidence/04_algorithms.json#kda_empty`。

---

### TREE-01 [P1] 決定木のクラス人数を割合から整数化して0/1にする

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：Aが7人、Bが3人の分類木を学習し、モデル構造を取得する。

実際：根のcount=10に対してvaluesはA count=0,ratio=.7、B count=0,ratio=.3。Aだけ7人の葉でもA count=1。

期待・影響：クラス人数とノード総数が整合し、加重数・非加重人数・割合を区別する。

修正・受入条件：tree_.valueが割合である前提に合わせてノード重み数を掛けるか、所属行から実人数を集計する。[R2] 各ノードでクラス人数の和が総人数になること。

根拠コード：`backend/app/api/models.py:112-158`。

実行証拠：`evidence/05_models_and_scope.json#model_full`。

---

### TREE-02 [P1] 分岐ノードに所属する回答者が0人と返る

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：同じ10人の木について内部nodesとleafMembershipを取得。

実際：根はcount=0,rowIds=[]だが、葉は7人/3人。全nodeIdをleafIdの一致だけで判定している。

期待・影響：根は全学習行を含み、各内部ノードの所属者は子の和と一致する。

修正・受入条件：内部ノードはdecision_path、葉だけはapplyで所属を求める。[R2] ノードからPCPへの選択連動に同じmembershipを使う。

限定・補足：APIの内部ノード情報として再現。現画面で根ノードのクリックが提供されるかはブラウザ操作未確認。

根拠コード：`backend/app/api/models.py:161-176`。

実行証拠：`evidence/05_models_and_scope.json#model_full`。

---

### FEDF-01 [P2] 同じ回答値に行順で異なる分位座標を付ける

確認区分：現版ソースの関数再現＋コード照合（代替WASMランタイム）。

再現・確認手順：x=[1,1,1,1,99]のFEDF rowCoordsを確認する。

実際：同じx=1の4人にquantile=.1,.3,.5,.7、folded=.2,.6,1,.6という異なる座標を割り当てる。順位タイをまとめず通し番号を付けている。

期待・影響：同一カテゴリ回答を別の分位位置として解釈させない。タイを分散表示する仕様なら、表示jitterであって統計的差ではないことを明示する。

修正・受入条件：midrank等のタイ規則を固定するか、描画用の分散と分析用座標を分離する。

限定・補足：FEDFに任意の同値展開を許す仕様はあり得るため、普遍的な数学誤りではなく、アンケート回答の解釈と表示の不整合としてP2。

根拠コード：`backend/app/algorithms/distribution/fedf.py:71-108`。

実行証拠：`evidence/04_algorithms.json#fed_result`。

---

### TEXT-01 [P2] 差0や負の差を強調する自動説明文が出る

確認区分：現版ソースのASGI/API再現＋コード照合（代替WASMランタイム）。

再現・確認手順：群差0のclassic探索、およびdelta_mean=-4のmodern探索結果のnarrativeを確認。

実際：差0でも「探索的な差の候補があります」、負の差でも「平均-4.00高く」と出る。数値自体と説明語の整合が悪い。

期待・影響：0/正/負を分け、実質差がない候補はその旨を説明する。

修正・受入条件：差の符号で高い/低いを分け、絶対値で記述する。差なしの専用文言を用意する。説明文のスナップショット試験を追加する。

根拠コード：`backend/app/algorithms/mining/modern_subgroup.py:875-952`。

実行証拠：`evidence/07_mining_verification.json#exploration`、`evidence/07_mining_verification.json#modern_A`。

---

### SEC-01 [P1] 静的ファイル返却に公開ディレクトリの境界確認がない

確認区分：現版ソースの関数再現＋コード照合（代替WASMランタイム）。

再現・確認手順：公開ディレクトリ外に監査用の無害なsentinelファイルを作成し、spa_fallbackを相対パスで直接呼ぶ。

実際：返却FileResponse.pathが公開ディレクトリ外のsentinelを指す。candidate=_frontend_dist/full_path後にis_fileを確認するだけで、resolve後の境界確認がない。

期待・影響：配信対象は設定したfrontend公開ディレクトリ内に限定する。

修正・受入条件：candidate.resolve()とbase.resolve()を比較し、base配下でない場合は拒否する。シンボリックリンクも含める。

限定・補足：ハンドラ単体で外部ファイルを返す指定まで再現。HTTP URLの正規化・ブラウザからの到達・外部攻撃成立は未検証。ローカル起動が127.0.0.1であることはリスクを限定するが、境界不備自体は残る。

根拠コード：`backend/app/main.py:90-110`。

実行証拠：`evidence/05_models_and_scope.json#static_path_boundary`。

---

### PKG-01 [P2] ランチャーが依存バージョン変更を検出せず、空白パスにも弱い

確認区分：静的確認（実操作・本番ランタイム未確認）。

再現・確認手順：run.batの既存.venv判定とPython呼出しを確認。

実際：.installedがあり主要moduleがimportできればrequirements.txtのpin変更を照合しない。PY_CMDに空白を含む実行ファイルパスを格納した分岐でも引用せずに呼ぶ。

期待・影響：配布更新時に依存定義の変更を検出する。実行ファイルパスと引数を別変数で保持する。

修正・受入条件：requirements hashとPythonバージョンをインストール済みマーカーへ保存する。Program Files/ユーザー名の空白を含む実機試験を追加する。

限定・補足：Windows実機では未実行。Python最低バージョンと各pinの対応も実機セットアップ時の残検証であり、ここでは未確認のパッケージ非互換を断定しない。

根拠コード：`run.bat:28-62`、`run.bat:84-144`。

---

## 修正の推奨順序

### 第1段階：誤った結果を出す入口を止める

検証モード（VERIFY-01）、部分集団rowIds経由の感度分析（SENS-01）は、推定対象が違うため修正まで停止する。補完・Undo・完全削除・重み欠損処理を先行修正する。空スコープが全件へ戻る共通処理は、クロス集計単独の修正ではなく全scope利用箇所を点検する。

### 第2段階：分析入力を一度だけ解釈する

各アルゴリズムがraw DataFrame、codebook、scope、weightを独自解釈する状態をやめ、共通AnalysisViewを作る。これは新しい巨大基盤を作る提案ではなく、既存CodebookAdapter/AnalysisContextを計算前の唯一の入口として完成させる方針である。

最低限持つ項目は、datasetIdとdata/schema/mask revision、明示的な対象rowIds、固定されたカテゴリ領域/順序/逆転範囲、設問別の対象・欠損・非該当マスク、分析用変換後の値、調査重みと抽出回数、計算に使った有効人数。集計・モデル・候補詳細・セル選択で同じものを参照する。

### 第3段階：Undoを値ではなくDatasetStateの復元にする

values、schema、codebook、multi-response definitions、imputation-maskを同じスナップショットへ含める。操作の監査ログとUndo/Redo用の位置を分離し、復元後のfingerprint・revision・キャッシュを一致させる。キャッシュの削除だけでは、残ったschemaやmaskの問題を解決できない。

### 第4段階：EDAを保ったまま結果の説明を正す

順序尺度の平均を補助的な等間隔得点平均として使うこと自体は否定しない。ただし得点変換を固定する。加重度数・未加重実人数・有効回答母数は併記する。探索結果は記述的な群差・分布差を中心にし、正しく実装できるまで確証的p/CIのラベルを付けない。

## 主要な受入テスト

|テスト|合格条件|
|---|---|
|対象行0件|全件に戻らず、全機能で0件または明示的エラーになる。|
|欠損コード99|取込後の集計・補完・FEDF・LOESS・モデルで同じ欠損扱い。|
|コードブック固定|同じ回答コードは行順変更・部分抽出後も同じ順位・逆転得点。|
|重み1|全列の加重結果が同じ変換後の非加重結果と一致。|
|補正重みの定数倍|記述割合が不変。定数倍を新しい独立回答者と解釈して推測しない。|
|複数回答の重み|通常設問とMAの重み適用状態・母数表示が一致、非対応なら明示。|
|同じセルの所属者|集計count、inline rowIds、truncated後の再取得が一致。|
|復元抽出|[0,100,10,10,10]の集計は抽出n=5、平均26。ユニーク人数3は別指標。|
|Undo/Redo|値・列・コードブック・マスク・平均が同時に戻り、Undo2がRedo化しない。|
|データ削除|削除方針で定めた原票・履歴・メタデータが一緒に削除される。|
|部分集団の感度分析|baselineの効果量と向きが元分析と一致する。|
|検証モード|比較する群・設問・効果量定義が固定され、差0の試験を0との差へすり替えない。|
|決定木|クラス人数の和、node人数、nodeのrowIds数、子の集合が整合する。|
|候補同一性|条件を変えたらhashが変わり、最小群サイズなど明示設定が守られる。|

これらのAPI/関数テストを指定依存バージョンのWindows環境で実行した後、PCPから表・クロス集計・探索へ移るブラウザE2Eを行う。現時点でブラウザ描画や大規模性能を合格扱いにはしない。

## 残検証と配布上の注意

本配布物にはバックエンドソースはあるが、フロントエンドはビルド済みdistが中心で、TypeScript元ソース・ビルド手順・回帰テスト一式を同梱した開発配布物ではない。これは親リポジトリにソースやテストが存在しないという断定ではない。修正担当へ渡す際は同じbundleを再ビルドできる元ソースのrevisionを紐付けるとよい。

未完了の主な範囲は、実PCP描画・マウス/キーボード操作、Firefoxを含むブラウザ差、ダウンロード/保存復元、Windowsインストール/更新、指定版ライブラリでの全回帰、大規模・多数カテゴリ時の応答性能、並列リクエスト/強制終了時の整合性。これらについて不具合がないと判断したものではない。

## 統計・ライブラリの一次資料

引用は根拠となる最小範囲に限定した。ソフトの不具合自体の根拠は添付ソースと合成データの実行証拠である。

[R1] SciPy公式 `ttest_1samp`。原文：`ONE group of scores`。単一標本平均と指定母平均を比較する検定であり、任意の二群差の検定ではない。参照先：`https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_1samp.html`

[R2] scikit-learn公式 Understanding the decision tree structure。原文：`proportion of samples reaching a node`。クラス割合から人数を得るときはノード重み数との関係を使う。また内部ノードの所属はdecision_path、葉はapplyが対応する。参照先：`https://scikit-learn.org/stable/auto_examples/tree/plot_unveil_tree_structure.html`

[R3] R survey公式 Contingency tables for survey data。原文：`Rao-Scott corrections`。調査重みを用いた表の検定と、単なる加重度数へのPearson検定の違いを確認した。参照先：`https://r-survey.r-forge.r-project.org/survey/html/svychisq.html`

[R4] Polars公式 Series.value_counts。原文：`the order is non-deterministic`。sort=Falseが既定。先頭行を最頻値としてよいという保証はない。参照先：`https://docs.pola.rs/api/python/stable/reference/series/api/polars.Series.value_counts.html`

[R5] SciPy公式 ttest_ind。原文：`difference in population means`。二つの独立標本の母平均差と、その信頼区間を対象にする。参照先：`https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ttest_ind.html`

## 同梱証拠の読み方

`findings.json`は全指摘の機械可読版。`source_excerpts.md`は指摘IDごとの行番号付き原文。`evidence/01_*.json`～`08_*.json`は合成データでの応答。`tests/`は実行した入力生成・API呼出し。`check_evidence.py`は保存済み応答から主要な再現事実を抽出する。`reproduce_native.py`は指定の現版ソースと利用者側Python依存環境で同じ試験を実行するためのランナーで、こちらの環境ではnative依存不足のためnative実行していない（構文検査のみ）。原データや既存workspaceを書き換えないよう、専用の新規テストworkspaceを作る。

フロントエンドの行番号は整形版の行番号であり、元のminify済みファイルの行番号ではない。`frontend_functions.js`は現バンドルから抽出した関数。runtime情報には指定版と実行版の違いを残した。参照用WASMランタイム本体・旧版アプリ・ユーザーの既存アンケートデータは証拠ZIPへ含めていない。

最終判断：不足しているのは時系列機能や追加の高度手法ではなく、「同じ回答者・同じ設問の意味・同じデータ世代を分析する」という土台の一貫性である。ここを修正すれば、追加されたアンケート向け機能を活かせる。
