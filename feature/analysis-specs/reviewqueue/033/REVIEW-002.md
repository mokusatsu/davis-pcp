# Feature 033 EFA 実装レビュー 002

判定: **E001〜E005・E007・E010の修正を確認。E006・E008・E009・E011〜E013は一部未解消。**

- 日付: 2026-09-14
- 対象: `REVIEW-001-REPLY.md`（SHA256 `C721E72F8E2895D3C0EB3E708C213F637760C0D6BDA761CEB4B98656447DE696`）。
- 対象版: HEAD `70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31`からの未コミット変更を含む。
- 範囲: 既存13件の修正箇所、追加試験、旧不具合の隔離再現、得点図と永続artifactの追加。

## 解消確認

- **E001**: 反復×行×列の独立置換と感度比較両側の共通置換群を確認。旧再現データで参照分位と観測固有値の最大差は`0.8946346173215033`となり、元相関がそのまま残る問題は解消した。
- **E002**: 列平均補正が加わり、旧fixtureのVarimax目的値は実装`0.22552247251485047`、設計のSVD式`0.22552247190894098`となった。誤った目的関数を最適化する問題は解消。掃引法を維持したことは設計記載のSVD反復と異なるため、実装方式・収束基準の記録にはこの差を残すこと。今回のfixture一致を全条件のoracle合格とは扱わない。
- **E003**: 符号を含むHと最終再構成チェックを確認。旧検証の固定seed・100行列で、成功出力の再構成誤差が1e-8を超えるケースは再現しなかった。
- **E004**: fit_nを得点と独立して主q・候補q等へ渡す。得点regression／noneの両方でML推論がavailableとなった。
- **E005**: 空selectedは422となり、全200行の分析へ変わらない。画面からsampledRowIdsを渡すことも確認した。
- **E007**: 所有dataset・現在版・fit版の照合を追加。旧fitのpredictが409となることと、materializeのロック内照合を確認した。
- **E010**: 保存因子matFactorと列名を分離し、列名末尾から因子を決める経路を除去した。

## E006 [P1] 補完件数の集計が通常のcolumnId指定で0になる

連続項目のmissingCodes修正は確認し、旧検証はfitCount=199・missing=1となった。

ただし`factor_analysis_service.py:353`付近の`specs[name_by_cid[cid]]`は、columnIdをキーにしたspecsを列名で参照する。通常のcolumnId要求でKeyErrorとなり、exceptでuse_col_idsが空集合になる。そのため補完maskの全entryが除外される。使用列・fit行に対応するmask entryを1件注入した隔離検証で、imputedCells=0・imputedRows=0となった（期待1・1）。

specs[cid]から使用列IDを解決し、例外で集計失敗を成功の0件へ置換しないこと。現在の処理はmaskを集計に読むだけで、無回答／非該当の区別や不正値との主除外理由の優先処理も未完了。invalidCountとmissingCountに同一行を二重計上しないこと。

## E008 [P1] 冪等payloadの範囲がまだ不足する

列名変更の同一キー再送がIDEMPOTENCY_CONFLICT・409となること、保存元に応じたprediction rowsの読込、保存時の版を返す修正は確認した。

`api/factor_analysis.py:946`はsourceをキー自体に含めるため、同じ利用者キーで保存元を変えても同じキーの別payloadとして検出しない。941行のpayloadもcontextのscope・rowIds等を含めない。同一キーの要求とpayloadを分けて管理し、保存元や対象範囲が異なる再送を区別すること。現在は同じsource・同じcolumnsでcontextを変えると元の成功応答が再送される。

## E009 [P1] 1因子／因子数変更時の得点図と矩形選択が成立しない

全ページ取得、得点図、中央選択の色、応答反映時のdataset・data/schema・sequence照合は確認した。

`FactorAnalysisPage.tsx:76`〜77でfigY=2を保持したまま、1因子結果を受けても補正しない。280〜281行でYがnullになり点が表示されない。利用者がYをF1へ直しても、203行がaxes=[1,1]を送るため、APIの`efa_select_ids`（637行付近）の重複軸拒否で422となる。画面の「1因子のためX=Yも可」と矛盾する。因子数減少後のmatFactorにも範囲補正がない。

新結果受領時に軸・保存因子を範囲内へ戻し、1因子図では同一軸の矩形を1軸の範囲条件へ変換する等、APIと整合させること。通常ブラウザでの実ポインタ・相互ハイライトはまだ未検証。回答にある「rows取得前に旧rowsを消す」はdataset切替時にはあるが、再分析開始時にはなく、行取得失敗後に旧図が残る。結果IDに一致するrowsだけを描画すること。

## E011 [P1] 永続化は追加されたが中断・独立表示・原子的更新が未完了

attemptをメモリ消去後に取得できる追加試験は成功した。comparisonのdataset削除／版変更を検出する取得処理も追加されている。

一方、回答どおり副解析は同期実行であり、主結果の先行表示・実行中cancelは未実装である。「対応済み」とは判定しない。

また`storage/analysis_result_store.py`のsave_artifactは既存destをrmtreeしてからos.replaceするため、更新途中の読込失敗や置換失敗で旧記録が消える。既存artifactを残したまま原子的にファイルを置換すること。`_remember_attempt`／`_remember_comparison`の保存失敗を黙ってメモリだけの成功にしないこと。終了・失敗の全経路で永続状態を揃え、比較／試行の診断情報と所有datasetの寿命を扱う必要がある。

## E012 [P2] 診断・推論・スクリープロット等の表示が残る

structure、Phi、独自性、相関／再現／残差表と感度差分表、data/schema版によるstale表示は追加された。

回答で未完了とされている分布・対別相関・start履歴・ML参考推論、スクリープロット、因子表示名は引き続き残件。`FactorAnalysisPage.tsx:275`〜276はmaskRevisionを読み捨てており、mask版のstale判定はまだ実装されていない。

## E013 [P1] ordinalをcontinuousと偽装でき、画面も既定で重みを無効にする

名義のcontinuous指定やMA等の拒否は追加された。ただし`factor_analysis_service.py:172`はcontinuous要求に対しscaleType=ordinal・None等を許可する。ordinal列へmeasurement=continuous/treatment=continuousを指定すれば、近似同意・等間隔順位得点の制約を回避できる。隔離データの4列をordinalへ変更し、同意なしcontinuous要求が200・scoreInterpretation=latent_estimateとなることを再現した。

コードブックのordinalは元measurementとして維持し、Pearson利用にはcontinuous_approximationと項目別同意を必須にすること。名義／不明からの指定も、根拠付き指定の正式な契約なしで受け入れないこと。

画面にはdataset／none切替が追加されたが、58行の初期値はnoneのままである。dataset重みが設定済みの利用者が何も変更せず実行すると非加重化される。既定をdatasetにし、有効重みの拒否後に利用者が明示的にnoneを選ぶ経路にすること。

## 検証

- 隔離workspaceのEFA単体／API: **19 passed**。
- frontend全体の`tsc --noEmit`: **成功**。
- `.temp/review-033-check.py`: 旧不具合の修正結果を確認。
- `.temp/review-033-002-check.py`: 補完entry1件が0件になること、ordinalの同意なしcontinuous要求が通ることを確認。実datasetは変更していない。
- 実装修正・ビルド・全体テスト・実ブラウザ操作は行っていない。Pyodide実ブラウザ操作検証は対象外。

polychoric oracleがrtol併用でも未達との訂正を受領した。ULS外部照合、B02/B03不変性、失敗・境界・比較・中断、通常ブラウザ統合、代表サイズ性能も未完了。未達を許容差拡大やテスト件数で解消した扱いにせず、個別の根拠を追加すること。現時点で問題なしとは判定しない。

## ソースSHA256

- api/factor_analysis.py: `0B9C351BB83406B57524FEB160949B76D383CD3870DFD0557764557316C6138C`
- services/factor_analysis_service.py: `EAA9CD37E51B36829542EDC450CB7EF179607BDDA85F8BCFFDBB156D52E8D8B5`
- factor_parallel.py: `84634A0D9C3DF1215611B396D280899795E1202854E2EF6C33D6EBA61B06DADE`
- factor_rotations.py: `CB95B925E314680B9335E04C0AD35EA0CEDAA4DC4B975D3DCCD87B75DD377DBA`
- FactorAnalysisPage.tsx: `292B7AA8304DD6FCCACCABA3CD1F3FD9011DFA60F586FF3ADCEA5615A198DE20`
