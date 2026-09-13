# DAVIS-FEAT-029–034 共通実装詳細化設計

版1.0／2026-09-12／関連：[共通機能仕様](../feature/00_common_analysis_contract.md)。以下の`fullstack/`はリポジトリルート以下を指す。新規と明記したファイルは提案する実装先であり、既存ファイルではない。

## 1. 既存接続点と実装単位

|区分|確認した既存パス|使い方・注意|
|---|---|---|
|API登録|backend/app/main.py|全て/api/v1配下へrouter登録|
|基本context|backend/app/domain/context.py|collect_revisions/check_revisions/resolve_scope/scope_hashを再利用|
|列選択・MA|backend/app/domain/analysis_columns.py|dependencies解決、MA親全項目でのvalid判定|
|コードブック|backend/app/domain/codebook_adapter.py|normalize_code、missing/reverse。カテゴリにanalysis_seriesを流用しない|
|重み|backend/app/domain/weight_mode.py、survey_weight.py|既存宣言・列role・typeの検証を再利用|
|調査設計|backend/app/algorithms/survey/design.py、covariance.py|公式と境界条件を監査した新ラッパーから使用|
|原データ保存|backend/app/storage/dataset_store.py|lock/get_dataframe/get_meta/load_codebook/commit_data_change|
|来歴|backend/app/domain/provenance.py|operation=calculateによる派生列保存|
|API呼出|frontend/src/api/client.ts|localとstaticの共通入口|
|静的実行|frontend/src/engine/pyodide.worker.ts|同じFastAPIをASGI呼出。別のJS計算法を作らない|
|選択・色|frontend/src/app/store.ts、features/common配下|selectionApplied、hovered、既存L1/色resolver|
|ページ登録|frontend/src/main.tsx、app/KeepAliveOutlet.tsx、app/AppShell.tsx|routes、ROUTE_COMPONENTS、ANALYSIS_NAV_ITEMSの3箇所を変更|

新規共通モジュールは`backend/app/domain/analysis_contracts.py`、`domain/analysis_frame.py`、`domain/analysis_encoding.py`、`algorithms/analysis_numerics.py`、`algorithms/survey/model_covariance.py`、`services/analysis_service.py`、`storage/analysis_result_store.py`、`api/analysis_results.py`とする。`api/models.py`の私有辞書`_results`や`api/multi_response.py`の私有revision helperへの新たな依存は作らない。古い機能の全面移行は別作業とする。

FE共通は`features/analysis/useAnalysisRun.ts`、`AnalysisContextBar.tsx`、`AnalysisResultMeta.tsx`、`FactorMap.tsx`、`AnalysisExport.tsx`、`api/analysis.ts`を新規作成する。数値座標・点の選択と描画を分ける。SVG/Canvasは既存Reactから実装し、現在入っていないD3/Recharts等を導入必須にしない。

## 2. 入力型と境界検証

付属`contracts/analysis_requests.py`はPydantic v2の参照契約である。新規APIのみextra=forbid、型の厳密検証、JSON有限値を採用する。新規`AnalysisContextV2`は既存`AnalysisContext`の項目を維持しweightMode/typeを追加する。既存全APIにstrictをかけて破壊しない。

リクエスト構文の検証はPydantic、版とスコープはdomain/context、コードブックや欠損・重みの意味はanalysis_frame、計算法固有の識別可能性は個別kernelへ分ける。Pydantic ValidationErrorは既存形式のerrorへ整形し`ANALYSIS_REQUEST_INVALID`、HTTP422で返す。独自APIからHTMLや例外tracebackを返さない。

すべての列IDはコードブックで一意に解決し、同じ名前の別列へフォールバックしない。変数指定の順序はモデルの列順でありcache keyに含める。行IDは選択集合と保存順であり、モデル行列のインデックス位置ではない。

## 3. 共有前処理の確定手順

1. dataset lock内でmeta/codebook/maskRevisionを取得し、期待data/schema版を検証する。
2. `resolve_scope`を呼ぶ前にV2のスコープ必須配列を検証する。重複除去後の集合hashを得る。明示行のrequest順ではなくフレーム保存順に並べる。
3. 列計画を作り、モデル変数、__rowId__、全MA親dependencies、目的変数、重み、調査設計、コンジョイントIDをまとめて必要列集合にする。survey分散ではスコープ外の設計行も必要なため、設計用の全行ID/層/PSU/FPCは別に読む。
4. `get_dataframe(datasetId,columns=...)`から必要な不変スナップショットをコピーし、raw/datafingerprintと版を記録してlockを解放する。計算全体でデータ更新lockを握り続けない。
5. カテゴリはnormalize_code→missingCode→有効領域→表示ラベル/順序の順に処理する。有効領域Dはnormalized categoryOrder−missingCodes、Dが非空ならD外をinvalidとする。Dが空なら観測カテゴリを許す。`valueLabels`だけで閉領域を作らない。ordinalのカテゴリ解析は生コード同一性を維持する。
6. 数値は領域・欠損・有限性を判定後にreverseを適用する。reverseで固定尺度範囲がなければ既存CODEBOOK_REVERSE_RANGE_MISSINGを返す。データのscope内min/maxで逆転範囲を変えない。ordinal数値扱いは明示したordered_rankを使う。
7. MA子は親全体を`prepare_classifier`相当で検証しvalid行だけ0/1へ写像する。`AnalysisColumns.prepare`は要求names以外を落とすため、重み・ID・目的変数まで同じ戻りframeに残ると仮定しない。rowIdをキーとしたaligned補助配列を保持する。
8. weightMode解決→重み値の検証→個別手法のタスク/回答者整合性を実施する。weightMode=columnにtypeがなければ保存宣言から解決する。survey/frequencyを自動推測しない。
9. 各行のfirstExclusionReasonを一つ確定し、共通validMaskを全数値・カテゴリ・重み配列へ一度だけ適用する。合計件数の不変条件をassertする。CA表やコンジョイントのタスクルールは個別設計の例外を適用する。
10. 学習用変換、カテゴリ順、基準水準、正規化前の重み、除外理由、原rowId配列をPreparedAnalysisFrameに保存する。

`PreparedAnalysisFrame`はrowIds:list[str]、numeric:float64[n,p]、categorical:int32[n,m]、categoryCatalog、weights:float64[n]、aux、exclusions、snapshot、surveyFrameを持つ。無関係列の値を結果storeへ丸ごと保存しない。

## 4. 学習・結果ID・寿命

`POST /api/v1/models/{method}`は同期レスポンスとする。サーバーでは通常のFastAPI実行、staticでは既存serialQueueを使う。既存jobs/managerの中断状態をこのAPIの中断保証として使わない。

resultIdはUUID、modelFingerprintはSHA256で別に生成する。fingerprintの正規化JSONにはdatasetId/dataRevision/schemaRevision/imputationMaskRevision、元データfingerprint、scopeHash、fitRowIdsの保存順hash、型を保持したeffectiveConfig、カテゴリcatalog、resolvedWeight/type/design、seed、algorithmVersionを入れる。文字列と数値カテゴリをnormalize_codeした後の同一性は既存規則に従う。NaNを正規化してhashへ入れない。JSONはUTF-8、sort_keys=True、ensure_ascii=False、separators=(',',':')、allow_nan=False。float値の再現性が問題になる内部配列はdtype/shape/バイト列hashを記録する。

同一fingerprintの明示再実行はキャッシュを利用できる。UIの色、表示軸、ラベル位置、スクロールはfit fingerprintに入れない。変更の取り消しで既存resultIdを再表示してよい。`algorithmVersion`を変えた場合はcache互換なし。source/runtime版は検証・再現性情報であり、異なるruntimeの結果を同一bit列だと保証しない。

### 4.1 保存形式

`workspace/analysis-results/{resultId}/`にmanifest.json、model.npz、rows.parquet、exclusions.parquet、snapshot_columns.parquetを原子的に保存する。model.npzは数値配列だけ、object配列/pickleは禁止。文字列はJSON/Parquet。manifestはowner datasetId、method、config、meta、capabilities、schemaVersion、各ファイルhashを含む。

全軸の個体座標またはそれを正確に再構築できる変換済み行＋loadingsを保存する。片方を`rowStorage=coordinates|transform_input`で明示する。本版実装はcoordinatesを正本とし、FAMD/MCAの全非零軸を行ごとにParquetへ保存する。FAはq因子、回帰/コンジョイントは診断列を保存する。

ページ離脱で削除しない。明示的な結果削除、dataset削除、利用者のワークスペース初期化でのみ削除する。自動LRU/件数上限でKeepAlive結果を消さない。ローカルメモリにはmanifestだけ保持し、数値は必要時にディスクから読む。staticのIDBFS利用可否はruntimeCapabilitiesに返す。永続化不可なら「このタブ内のみ」と表示し、ブラウザ再読込後の保持を保証しない。IDBFS有効時は保存後syncfsを行い、失敗を警告する。

### 4.2 publishと版競合

計算後、dataset lockを再取得してdata/schema/mask版を確認する。変更されていれば計算結果を新規有効結果として公開せず409 ANALYSIS_INPUT_STALEとする。一時ディレクトリを削除する。変更がなければmanifestを最後にatomic renameして完成扱いにする。半端なmodelだけをGETで見せない。

stale判定は毎回の結果操作で現版と比較する。staleでも閲覧GET/rows/exportは許しmeta.resultState=staleを返す。select/predict/materializeは409。datasetが削除された場合は結果も削除して404。予測先は本版では同じdatasetの現在版に限り、別datasetへの汎用モデル移植は未対応。

## 5. 共通結果API

結果形は`{status:'success', resultId, method, meta, config, capabilities, summary, details, unavailableReasons}`。methodはca/mca/famd/linear_regression/factor_analysis/conjoint。詳細フィールドは`contracts/RESULT_CONTRACT.md`を正本とする。

|メソッド・URL|入力/出力と条件|
|---|---|
|GET /analysis-results/{id}|manifest由来の結果。rowデータは含めない。stale閲覧可|
|GET /analysis-results/{id}/rows?offset=0&limit=5000&axes=1,2|保存順の個体結果。limit 1..10000。rows,total,nextOffset,axes,meta。空末尾はrows=[]、nextOffset=null|
|POST /analysis-results/{id}/select|contextとselector。全保存点からrowIds,matchedCount,fitMatchedCount,contextIntersectionCount,selectionLabel。選択自体はFE storeで行う|
|POST /analysis-results/{id}/predict|contextとoptions。結果はpredictionIdとsummaryを返し、行結果はprediction用GETで取得|
|GET /analysis-results/{id}/predictions/{predictionId}/rows|offset/limit。同じページ仕様、観測yなしでも予測可|
|POST /analysis-results/{id}/materialize|context、source=fitまたはpredictionId、columnsマッピング、idempotencyKey。原子的に派生列保存|
|POST /analysis-results/{id}/export|format=json/csv、table、offset/limit。UTF-8文字列payloadとmime/fileName/nextOffsetを返し、FEがBlob化|
|DELETE /analysis-results/{id}|明示的削除。dataset本体を変更しない。既にない場合も204|

rowsのaxesは1始まりの重複なし昇順でなくても入力順を維持。省略時はmin(2,rank)、FAはmin(2,q)。回帰/CJではaxesを拒否する。最初から全rowsをPOST本文に載せない。GETのpage範囲を推定サンプルの範囲にしない。

### 5.1 select契約

selectorはrectangle、categories、row_ids、respondentsの判別union。rectangle={kind,axes:[a,b]または[a],bounds:[[lo,hi],...]}, boundsは閉区間・有限・lo<=hi。categories={kind,categoryIds,betweenVariables:'and'|'or'}で同一変数内はOR。row_idsは原__rowId__だけ。respondentsはCJ専用。scopeと結果の有効行の共通部分を計算し、FEはさらに現在activeとの交差を行う。

CA表モードではcategoriesの行カテゴリだけを受け付け、返すIDは集計表の行レコード。CA回答者モードは両側のカテゴリ組合せに対応する。回帰のrectangleはaxes指定ではなく`xField/yField`を使う別selector=diagnostic_rectangleとし、許可fieldはfitted/residual/leverage。任意JSON Pathの評価は禁止。

### 5.2 predict契約

共通contextは対象行。fit側のスコープ/欠損数とは別metaを返す。結果ごとのcapabilitiesで禁止機能はANALYSIS_OPERATION_UNSUPPORTED。CAはpredict不可。MCA/FAMD/FAはprojection。回帰はpoint/mean_ci/individual_piの区別、評価yが存在すれば追加指標。CJは学習行形式の予測のみ本APIで扱い、任意プロフィールシミュレーションは`POST /models/conjoint/{id}/simulate`とする。

予測は学習時に保存したcodebook変換を使用する。現スキーマの変更で解釈がずれる場合はstaleとなるため実行不可。行単位の不明値はpredictionStatus=unknown_category/missing/invalid/ok、value=nullで返す。全行失敗でも予測処理自体はsuccessとし、successfulPredictions=0と理由を返す。

### 5.3 materialize契約

columnsは`[{sourceField:'coordinate:1', name:'MCA1', label:'MCA第1軸'}]`等。field allowlistは手法ごとに固定する。新規列のみとし、既存列名/columnIdへの上書きは409 COLUMN_ALREADY_EXISTS。名前は既存の列作成バリデータに従い、空/予約語/制御文字を拒否する。columnIdはサーバー生成。scaleType=interval、role=other、derived originを設定する。

lock内でresult所有dataset一致→idempotencyKeyとpayload照合（既成功なら保存済み応答を返す）→未処理要求だけ版確認→全データへrowId左結合→対象外null→codebookに列追加→schemaRevision+1→operation=calculateのProvenanceStep作成→commit_data_change。dataRevision更新はstoreに任せる。補完maskは再作成しない。paramsにresultId/fingerprint/sourceField/fitScope/hash/configを保存する。

idempotencyはdatasetId+keyを一意に保存し、同じkey/同じpayload再送は以前の結果を返す。異なるpayloadなら409 IDEMPOTENCY_CONFLICT。コミット直後の通信失敗でも二重列作成しない。成功済み同一要求の再送は、元結果が保存によってstaleになっていても以前の成功応答を返す。新しいkeyによる書込みは通常通りstaleを拒否する。idempotency記録を同じコミットの来歴paramsに含め、独立ファイルへの後書きだけに依存しない。保存成功後の元モデルはdataRevisionが変わるためstaleになる。FEは新列と版を再取得し、旧モデルを勝手に新しい版へ付け替えない。

### 5.4 export・描画

現client.downloadBlobはstatic未対応のためそのまま流用しない。JSON/CSVのページを文字列としてapi.postで受け、FEでBlobを作る。CSVは各ページで同じヘッダ契約を使い、結合時は2ページ目以降のヘッダを除く。`table=manifest|eigenvalues|categories|variables|coefficients|diagnostics|rows|utilities`の手法別allowlistを使用。行出力は全件分ページを読む。データセット版が変わっても保存された同一snapshot結果を最後まで出す。

図はFE SVGをシリアライズし、PNGは既存Canvas変換を使う。書出しの倍率指定は描画解像度だけを変える。分析座標をpxから逆算して保存しない。テキストはエスケープし、HTMLラベルをそのまま埋め込まない。

## 6. 数値共通部

`thin_svd(A)`はscipy.linalg.svd(A,full_matrices=False,lapack_driver='gesdd',check_finite=True)。LAPACK収束失敗時のみ同じ行列でgesvdを一度試し、driverとfallback警告を記録する。乱数近似SVDへ変えない。rankTol=max(1e-12,eps*max(A.shape)*s0)、σ>rankTolを有効軸とする。全慣性は||A||F²。eigenvaluesはσ>rankTolの全有効軸のσ²を降順で保持し、長さはrankと一致する（表示軸だけへの切詰めではない）。閾値未満の慣性はdiscardedNumericalInertiaとして示す。各inertiaRatioの分母は切詰め前の全慣性であり、Σeigenvalues+discardedNumericalInertia≈totalInertiaとする。

軸の符号は右特異ベクトルまたは定義された負荷ベクトルの最大絶対成分を正にし、同率は保存列順で選ぶ。許容差1e-10で同一と見なされる固有値群はdegenerateBlocksとして返す。縮退群の軸ごとの位置の完全一致は要求せず、projector/再構成行列/距離で比較する。ユーザーのラベル移動や因子名は符号や縮退軸の識別を自動的に越えて移植しない。

除算はdenominator<=0またはrankTol相当のゼロならnullとする。小さい負固有値を全てabsにすることは禁止。理論上0の範囲に対する丸めのみ、絶対1e-12以内なら0へclipしてnumericalClipsに記録する。寄与・cos2・η²が1を1e-10以上超える場合は実装不整合としてANALYSIS_NUMERICAL_INVARIANT_FAILED。

回帰の最小二乗はlstsq(gelsd)またはQR/SVDで解く。推定のために逆行列(X'WX)^-1を直接生成しない。分散や予測に必要なbreadはSVDの特異値逆数から構成し、rank検証後だけ使用する。

## 7. surveyモデル分散の共通部

今回サポートするのは一段の層化PSU設計によるTaylor線形化。surveyDesignにreplicateWeightColumnIdsがある場合はANALYSIS_SURVEY_REPLICATE_UNSUPPORTEDで拒否し、通常重みだけで十分だと黙認しない。層/PSU/FPC列はcodebookから取得し、FPCは層内母PSU数M_hとして扱う（割合でない）。M_hは層内一定、有限、M_h>=m_h。複数段の指定は本版契約にない。

完全なデータセットの正重み分析単位から設計frameを作る。選択scope外・目的変数等で不使用の単位はscore=0として残す。重みや設計ID自体が欠損した行は完全設計を構成できないためinferenceStatus=unavailableを返し、点推定は利用可能行で継続できる。黙ってPSU数を減らして精密なSEを出さない。

単位iの加重scoreをu_iとし、PSU計T_hg=Σ_i∈hg u_i、層内平均Tbar_hを取る。meat=Σ_h (1−m_h/M_h) m_h/(m_h−1) Σ_g(T_hg−Tbar_h)(...)'。FPCなしは係数1。breadをBとしてV=B meat B'。PSUは(stratum,psu)の組で一意化する。PSUなしなら各回答者/各行をPSUとみなし、層があれば維持する。`designAssumption=independent_units`の注意を返す。

m_h=1でM_h=1と明示された確実抽出層は分散寄与0。他のsingleton層はinferenceStatus=unavailable、SINGLETON_PSU_WITHOUT_CERTAINTY。削除・平均補正を自動選択しない。設計df=D=Σ_h(m_h−1)。回帰はν=D−(p−intercept)、CJはν=Dを採用する。CJのD使用は漸近scoreモデルに対する設計t参照の製品規約で、回帰の残差自由度と混在させない。ν<=0はSEを計算できてもt/p/CIはnull。

既存covariance helperはsingletonを0寄与にする経路、strata/noPSU/FPCの特殊経路があるため、この境界契約の検査なしで呼ばない。新model_covarianceには上式を独立実装し、既存helperの利用は同じfixtureで一致する部分だけに限定する。既存クロス集計などへの変更は回帰テストを付けた別パッチとする。

## 8. FE状態・同時操作・表示

`useAnalysisRun`はdatasetId、datasetEpoch、runSequence、draftConfig、submittedConfig、resultId、status、errorを持つ。実行前にrunSequence++。レスポンスのepoch/sequenceが現在値と一致しなければ破棄する。data/schema変更はstale、dataset変更はreset。失敗した新実行で以前の結果を新設定として表示しない。

status=idle/dirty/running/success/stale/failed/cancelled。dirtyは結果があれば旧結果を保持、running中の設定編集はdraftのみ更新、実行に使用した値を変更しない。二重実行ボタンを無効化する。論理cancel時はsequenceを進めて結果採用だけを停止し、static queueが実際に空いた後に次の要求を流す。worker終了でキャンセルを実現しない。

FactorMapはaxisID/coordinateを受け、表示スケールとhit-testスケールを同じ変換から生成する。DPRは描画密度だけ。rank1は1軸の範囲選択。FocusMode、ブラウザzoom、KeepAlive非表示→再表示、resize、scrollに対応する。選択矩形はデータ座標でAPIへ送り、DOMpxを統計kernelへ渡さない。

## 9. 配布とテストゲート

実装はNumPy/SciPyと既存のPolars/Pydanticで行い、statsmodels、FactoMineR、prince、factor_analyzerをproduction依存に追加しない。これらのうちR/Statsmodelsはoracle用の別環境で使用する。添付requirementsとPyodide同梱版は同じとは限らないためruntime情報を必ず保存する。

静的ビルドではbackend_app.zipに新規api/domain/services/algorithmsを含め、キャッシュversionを更新する。添付`fullstack/scripts/build_static.py`のROOTからのパス連結は配布レイアウトで二重fullstackになり得るため、release作業で実在パスをassertする。変更後にlocal API、frontend型検査、static実機の3段階で確認する。

本体受入テストはbackend/tests/stats_tests配下へ追加、FEは既存frontend/testsに追加する。ネットワーク不要の数値fixtureを常設し、外部oracle値は生成元版・コマンド・データhashを保存する。本配布のvalidationはその準備であり、未実装APIに対して成功したと報告しない。

## 10. 共通操作contextの補足

select/materializeのcontextは対象集合と版検証に使用し、学習済み重み・欠損・変換を再解決しない。effectiveConfigを変更した扱いにしない。materializeはcontextで指定した現在集合とsourceに保存した行集合の共通部分にだけ値を保存する。scope=allならsourceの全行を対象とし、残りはnull。predictは学習時のmissing/encodingを固定し、contextのweight設定はevaluate=true時の評価集計にのみ使用する。射影座標や回帰係数を変えない。MCA/FAMD/FAはoptions.interval=noneのみ、CJもnoneのみとし、未対応区間指定を黙って無視しない。CAは予測そのものが未対応。

## 一次資料との対応

[S-SVD](../references/PRIMARY_SOURCES.md#s-svd)、[S-LSTSQ](../references/PRIMARY_SOURCES.md#s-lstsq)、[S-SURVEY](../references/PRIMARY_SOURCES.md#s-survey)を参照。原文の最小引用・確認対象・本設計との差異は参照資料に記載した。API、閾値、対応範囲、警告方針は本書群で採用した製品設計であり、原典の必須仕様という意味ではない。
