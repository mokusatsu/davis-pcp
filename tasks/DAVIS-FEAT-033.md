# DAVIS-FEAT-033 探索的因子分析（EFA）実装・受入記録

状態: 実装済み（検証: kernel単体13件・API 9件の計22件・R oracle照合・FE型検査・production bundle確認まで実施、実ブラウザ試験は並行実施中、Pyodide・全体回帰・性能フル測定は残作業）。レビュー001（E001〜E013）・レビュー002（E006/E008/E009/E011〜E013再指摘）対応済み、レビュー003（E006/E009/E011〜E013残件）対応中。

開始時: branch=master
既存未コミット変更: 保全（feature/analysis-specs文書群・tasks等の他者差分に触れず。共有基盤はEFA必須の追加のみ）。
共有ファイル調整: analysis_contracts.py（EFARequest等を追加のみ・ExportRequestにparallel_analysis/factor_comparisonsを追加）、analysis_results.py（efa rows/select/predict/materialize/export分岐を追加）、main.py（factor_analysis router登録）、storage/analysis_result_store.py（EFA attempt/comparison永続artifactのsave/load追加のみ）。LinearRegressionPage.tsxの差分は本セッションの変更ではない（別作業の未コミット差分として保全・無変更）。

## 範囲
- Feature 033 EFA（新033正本）: Pearson+ML/MINRES、Polychoric(tetrachoric含む)+MINRES、無回転/Varimax/Promax、平行分析、候補比較、Pearson/Polychoric感度比較、Pearson適合解の得点・予測・PCP連携・派生列保存、診断・失敗試行・結果/比較の保存とexport、画面、local検証。
- 対象外: CFA(033c)、PAF、混合相関・polyserial、重み付き推定、pairwise、FIML、内部補完、順序モデルの得点推定。

## 受入条件（EFA-B01〜B22）
- B01 尺度routing: 契約でordinal/continuous/treatment整合を検証（単体+API拒否試験）。
- B02 カテゴリ順序: 閾値がRと一致（全6項目 maxdiff 0.0）、順序保存再符号化の不変性はAPI試験で今後追加。
- B03 逆転・列順: 一度だけ適用・元/適用後順序を保存（実装済み）。符号変換の数値試験は残作業。
- B04 欠損・不正: 完全ケース・invalid/missing分類・行hash一致を実装。連続項目のmissingCodes（コード＋数値）をfit/predict同一判定で適用（修正前は先頭missingCodes行でもfitCount=200のままだった）。mask/補完来歴を共通規約で集計しmetaへ記録（maskRevision・imputedCell/RowCount）。pairwise拒否（契約に項目なし）。
- B05 入力限界: 定数・未観測・n不足・df負を所定コードで拒否（API試験で確認）。
- B06 相関oracle: polycor::polychor(ML=FALSE) pairwiseとρ maxdiff 2.03e-05（5件法）・1.81e-05（2値）、閾値 maxdiff 0.0。初期基準atol1e-5単独では超過のため未達扱いとし、rtol=1e-5併用でも最悪比1.755/1.307で超過。差0.001SE・Δnll≈0の最適点近傍の平坦差であり許容差拡大では通さない（設計変更が必要なら根拠と影響を示して確認する）。
- B07 相関失敗・非正定値: 境界・未収束・非PDで抽出停止・補正なし（実装済み）。
- B08 ULS/ML: 同一Rの目的・制約・u/ψ分離・複数start・全失敗保持。ML目的値はfactanalと差0.0、h2差1e-06。ULS Σhat/h2はpsychと回転規約差を別記（受入許容差atol1e-4の初期目標に対し要追加検証）。
- B09 回転: none/Varimax/Promax、S=ΛΦ、diagΦ=1、h2正解、再構成rtol=1e-9検証（最終出力で再検証）。VarimaxはKaiser列平均補正付き対角掃引（修正前は補正なしで設計不一致）、符号正準化は単一Hでpattern・Phi・structure・変換行列へ一貫適用。斜交の加算寄与なし（Promax時ssLoadings null）。
- B10 不適解: 負ψ・境界u・特異Φ・回転失敗を記録。|pattern|>1単独で不適にしない（実装済み）。
- B11 平行分析: 反復×項目の独立置換（修正前は全列同一置換で帰無が成立せず、200行4列100反復で参照-観測最大差7.2e-16だった）・同相関・全相関固有値・seed再現・候補0許容・失敗反復でnull。感度比較の両側に同一(反復,n,p)置換群を共有。
- B12 候補比較: q別成功/失敗を全件保持、主q失敗の置換なし（実装済み・API試験）。
- B13 得点: 連続regression/Bartlett fit/predict一致・近似ラベル・順序得点拒否・rowId join（API試験で確認）。materializeはfit/prediction保存元を分離、冪等キーはuser key＋resultId＋sourceのみ・payload差はIDEMPOTENCY_CONFLICT、再送応答に保存版を保持（UIの版推測加算を廃止）。
- B14 推論: ULS系のχ²等null、MLのみ033式・適用条件・境界解は理由付きnull。fit集合nを得点計算から分離（修正前はscoreMethod=noneでn=0となりavailableがunavailableに変わった）。
- B15 重み・再現: dataset survey/frequencyをFA_WEIGHT_UNSUPPORTEDで拒否、設定/版/hash/start保存（実装済み）。
- B16 UI/統合: PCP選択・stale・KeepAlive・dataset切替を実装、run-production bundle確認済み。staleは中央data/schema版照合、predict/materializeは古いfitで409（同一payload再送は保存済み応答）。得点図の実ポインタ矩形・点toggle・相互ハイライト・全ページ取得・結果ID/版照合を実装（200行固定上限なし）。保存因子と列名を分離選択。実ブラウザ・staticは残作業。
- B17 実務プロファイル: 5件法N=1000対称で実行確認。N=999/1000や歪度での強制routingなし（実装済み）。
- B18 同条件ペア: fit行・項目・逆転・欠損・q・回転・MINRES固定、Pearson側は最終順位1..K。主ML上書きなし（実装済み）。
- B19 因子整合: 符号付き一対一置換・Φ/structure変換・曖昧対応indeterminate・Procrustes補助のみ（実装済み・単体試験）。
- B20 比較指標: 負荷量/共通性/Φ差・割当変更・PA候補差、異q係数差null（実装済み）。
- B21 判定・失敗: 目安・片側失敗・PA不能・境界解・fallbackなし、同等性証明と表示しない（実装済み）。
- B22 比較保存・性能: attempt/comparisonをworkspace永続artifact化（再起動後も主結果のcomparisonIdが解決可、dataset削除・版driftをstale報告）。cancelは完了/失敗/取消済み以外をcancelledへ永続化し主結果不変。rows/PCP非干渉。性能は代表組合せのN=1000/2000×p=12×PA100が時間超過のため残作業（6項目PA20で7.8秒、6項目poly行列0.31秒を実測）。
- B01/B15 尺度・重み: 名義列のcontinuous指定等をFA_SCALE_UNSUPPORTEDで拒否（コードブック照合・MA除外・順序order一致検証）。コードブックordinalの素のcontinuous指定はFA_APPROXIMATION_ACK_REQUIREDで拒否（Pearson利用は連続近似＋項目別同意が必須）。画面はdataset/none重み選択を提供し、既定はdataset（有効重みはFA_WEIGHT_UNSUPPORTEDで拒否・明示noneは別試行）。空selectedは空のまま（selectedRowIds=[]で200行→422不再現）。画面sampledは中央sampling行IDを送信。
- レビュー002再指摘の対応: E006はspecsキー誤参照を修正（columnIdキーで解決・失敗は例外伝播）し、columnId指定maskでimputedCell/Row=1/1を確認、invalid優先で行二重計上を排除、無回答／非該当をmissingReasonsで区別して分布へ記録。E008は冪等キーをuser key＋resultIdのみとしsource・scope・rowIdsをpayload側で比較（同source・同columnsでもcontext差はconflict、異sourceもconflictを確認）。E009は新結果受領時に旧rows消去・軸／保存因子の範囲補正・1因子単軸矩形・結果ID一致描画。E011はartifactをファイル単位の原子置換にし、永続失敗はANALYSIS_ARTIFACT_PERSIST_FAILEDで伝播、失敗経路の比較診断（失敗側・start・PA状態）を保持、全経路で永続化、cancelはqueuedのみ遷移・主結果不変を明記。E012は分布・対別相関・start履歴・ML参考推論・スクリープロット・mask stale・因子表示名（factorLabels）を追加。全文表示・CFA・Pyodide・全体回帰・実ブラウザ・性能フル測定は残作業。
- レビュー003対応中: E006は連続項目の非該当区分を分離（fit98・内訳invalid0/missing1/NA1、分布もmissing/NA/invalid別件数、共通missing bucketは合算）。E013は名義・水準不明にscaleBasis契約を追加（根拠なしはFA_SCALE_BASIS_REQUIRED、根拠付きはコードブック尺度・根拠をmeasurementResolutionへ保存）。E009は同一因子矩形をX/Y共通部分の単軸条件にし、空共通は空選択。E011は主結果先行公開＋比較バックグラウンド化（chunked進捗・cancel割込み・独立poll/cancel表示）。E012は分布判断材料（カテゴリ件数・割合・最小件数・最大割合・床/天井・歪度）を追加。CFA機能は対象外。

## 変更ファイル
- 新規kernel: fullstack/backend/app/algorithms/models/ordinal_correlations.py（Pearson共有集合・polychoric二段階共有閾値・条件付き1次元積分・境界/未収束診断）、factor_analysis_uls.py（uls_profile_full_v1・L-BFGS-B・解析勾配・複数start・採用規則・u/ψ分離）、factor_analysis_ml.py（Pearson ML完全目的関数・profile勾配・複数start・参考推論・KMO/Bartlett）、factor_rotations.py（Kaiser Varimax対角掃引・Promax power=4・q=1 none・符号正準化・再構成検証・得点）、factor_parallel.py（独立置換・全相関固有値・線形分位・失敗時null）、factor_sensitivity.py（符号付き置換整合・曖昧判定・Procrustes補助・差分・判定）。
- 新規service/API: fullstack/backend/app/services/factor_analysis_service.py（scope・ウェイト拒否・尺度解決・逆転1回・完全ケース・識別・抽出・PA・感度比較）、fullstack/backend/app/api/factor_analysis.py（POST /api/v1/models/factor-analysis、method=efa・schemaVersion=factor_extensions.1、旧入力拒否、attempt/comparison取得・export・cancel、rows/predict/materialize/export/select ids）。
- 共通基盤（EFA必須追加のみ）: domain/analysis_contracts.py（FactorVariable・EFARequest・PA/Sensitivity options・ExportRequestに2表追加）、api/analysis_results.py（efa分岐5箇所）、main.py（router登録）。
- 画面: frontend/src/features/models/FactorAnalysisPage.tsx（/models/factor-analysis「因子分析」: 得点図・structure/Φ/残差・感度差分・重み選択・stale中央照合）、EfaScoreFigure.tsx（実ポインタ矩形・点toggle・相互ハイライト）、efaApi.ts（全ページ取得・source付き保存）＋main.tsx/KeepAliveOutlet.tsx/AppShell.tsxへ登録。
- テスト: backend/tests/unit/test_efa_kernels.py（13件: E001独立置換・E002/E003回転回帰を追加）、backend/tests/api/test_efa_api.py（9件: E004/E005・E007/E008・E011/E013＋E013 ordinal偽装拒否・scaleBasis・連続NA分離回帰を追加）。
- oracle・fixture: fullstack/.temp/efa/oracle/（fixture CSV×3・model・R script・oracle JSON×4・sessionInfo内包）。

## 検証証拠
- kernel/API: 22 passed（EFA単体13＋API 9）。回帰スポット: test_analysis_context・test_covariance 8 passed。FE: tsc -b エラーなし。production bundleにfactor-analysis＋efa-score-figure含有を確認、health 200・openapi登録・SPA fallback 200を確認。
- 指摘再現の解消確認: E001（参照-観測最大差0.183で帰無成立）、E004（noneでavailable）、E005（空selectedで422）、E006（missingCodes行でfit199/missing1、columnId指定maskでimputed 1/1、連続NA分離でfit98・内訳0/1/1）、E007（保存後predict/materialize 409）、E008（同キー別payload・異source・scope差はいずれも409 IDEMPOTENCY_CONFLICT）、E011（メモリ消去後もattempt 200、主結果先行12.1秒・比較running→poll確定、cancel割込み実装）、E013（名義→FA_SCALE_BASIS_REQUIRED、ordinal偽装→FA_APPROXIMATION_ACK_REQUIRED、根拠付きは尺度ゲート通過）。
- R oracle: psych 2.6.5・polycor 0.8.2・GPArotation・R 4.6.1。polychoric pairwise maxdiff 2.03e-05（5件法）・tetrachoric 1.81e-05（2値）、閾値 0.0。ML目的値差0.0（factanal）、h2差1e-06。ULS Σhat/h2のpsych照合は回転規約差のため別記・要追加検証。
- 数値勾配: ULS maxdiff 3.6e-11、ML maxdiff 1.3e-08（有限差分）。
- 実測性能: Pearson+ML(n=300,p=6,PA100) 0.1秒。Polychoric+MINRES(n=500,p=6,PA100+感度) 88.5秒。6項目poly行列0.31秒、PA20反復7.8秒。

## 残作業
- 全体回帰（最初から実行せず対象検証後に実施する方針のため未実施）。
- 実ブラウザ検証（得点選択・相互ハイライト・KeepAliveの実ポインタ操作）。
- Pyodide/static検証（同一kernelの数値・状態・保存）。
- 性能フル測定（N=1000/2000×p=12/30/60×K=5・2/7×PA100/500のlocal/Pyodide別実測、主結果まで・比較完了まで・相関/PA時間・ピークメモリ・中断応答）。
- EFA-B02/B03の数値不変試験の追加、ULS psych照合の追加検証（目的関数・制約差の別記整理）。
