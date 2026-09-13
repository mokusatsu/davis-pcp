# DAVIS-FEAT-029 通常CA 実装・受入記録

状態: 実装中（共通基盤→kernel→API→画面→検証の順で進行）

開始時: branch=master, HEAD=77030967
既存未コミット変更: feature/27_pcp_mca_ui.md, tasks/task-list.md を保全。feature/analysis-specs/ 以下は設計資料として参照のみ。

## 範囲
- Feature 029（通常CA）+ 成立に必要な共通基盤（V2入力契約・共有前処理・数値共通部・結果store・共通結果API）のみ。
- 対象外: 030〜034分析機能、回帰/因子/コンジョイント専用基盤、既存API全体移行。
- CA未対応（個体座標保存・予測）は capabilities と規定エラーで明示。

## 受入条件（CA01〜CA10 + CA適用COM）
- CA01 [[30,10],[10,30]] λ=0.25, 主座標±0.5, χ²=20
- CA02 回答者展開一致 / CA03 定数倍不変 / CA04 零周辺不変 / CA05 全慣性分母
- CA06 不正セル/欠損セル/二重ウェイト拒否 / CA07 AND/OR選択 / CA08 survey p値なし
- CA09 rank1 / CA10 零慣性
- COM: 版競合409、scope、分類、重み、保存・stale、KeepAlive、export、有限JSON/CSV注入対策

## 変更ファイル
- 共通基盤: fullstack/backend/app/domain/analysis_contracts.py, domain/analysis_frame.py, algorithms/analysis_numerics.py, services/analysis_service.py, storage/analysis_result_store.py
- CA: algorithms/models/correspondence.py, api/correspondence.py (POST /api/v1/models/ca), api/analysis_results.py (GET/DELETE/POST select/predict/materialize/export), main.py ルータ登録
- 画面: frontend/src/features/models/CorrespondenceAnalysisPage.tsx, caTypes.ts, caMap.ts, caApi.ts, caHelp.tsx, caFigure.tsx, caTables.tsx, caExport.ts + main.tsx / KeepAliveOutlet.tsx / AppShell.tsx へ /models/ca 登録
- テスト: backend/tests/stats_tests/test_100_ca.py (6件), frontend/tests/correspondence.test.tsx (2件)

## 検証証拠
- kernel: CA01 [[30,10],[10,30]] λ=0.25, 主座標±0.5, χ²=20, df=1 を確認。定数倍・転置・零周辺不変、零慣性→CA_ZERO_INERTIAを確認。
- API: 分割表frequencyで200・上記数値一致。回答者80行展開と一致（CA02）。frequency weight適用・survey p値なし・survey倍率不変・mass p値なし・二重ウェイト/構造ゼロ/欠損セル/負セル拒否・部分scope・AND=30/OR=50・stale 409・export・predict/materialize 422・削除後404を手動APIで確認。
- 自動テスト: test_100_ca.py 6 passed。対応範囲 backend 22 passed。全体回帰（stats_tests/survey_audit隔離を除外）473 passed。FE全体 248 passed（58ファイル、correspondence 2件含む）。FE型検査 tsc --noEmit エラーなし。
- R/fixture照合: expected_values.json のCA固有値0.25・F/G ±0.5とkernel一致。R oracle実行は未実施。

## 受入対応
- CA01 達成、CA02 達成、CA03 達成、CA04 達成、CA05 達成（全慣性分母・再正規化なし・軸ラベル%表示）、CA06 達成、CA07 達成、CA08 達成、CA09 達成（rank1は1次元表示・第2軸selectなし）、CA10 達成（422 CA_ZERO_INERTIA）
- COM-01 達成（409）、COM-02 達成（scope必須・explicit未知422）、COM-05 達成（weight型ゲート・倍率不変）、COM-07/08 非該当（materialize未対応を422で明示）、COM-09 達成（原子的保存・明示delete）、COM-11 達成（KeepAlive登録・dataset変更リセット・runSequence破棄＋実ブラウザ復帰確認）、COM-12 達成（有限JSON・CSV式注入対策）
- 実ブラウザ確認: 達成（下記）。static/Pyodide実機・外部R oracleは未検証として記録。

## 実ブラウザ確認（2026-09-13、dev :5174＋backend :8420）
- 検証データ ca-ui（80行、brand×need、R1/C1=30、R1/C2=10、R2/C1=10、R2/C2=30）を投入しdataset切替。
- /models/ca で行=need・列=brand（転置入力）を実ポインタ順序dispatchで選択し実行ボタンをクリック。
- 結果: rev 1 / scope active (n=80)、有効80、rank 1、固有値0.25・慣性比100%、χ²=20.000 df=1 p=7.74e-6、行/列カテゴリ±0.5、元表 [[30,10],[10,30]] を画面表示で確認。
- カテゴリ点クリック→「原行IDへ解決して選択 (1)」→select API→一致40/適用40→中央selection 40行を確認。
- PCPへ移動し選択40行の連動を確認。CAへ復帰し結果保持（KeepAlive）を確認。
- 固有値CSVのexport API 200を確認（network log [20900.863]）。
- network log: POST /models/ca 200（[20900.666]/[20900.841]）、POST /select 200（[20900.842]）、export 200。
- 既知の操作性注意: preview_click単独ではantd Selectが開かない場合があり、実ポインタ順序（pointerdown→mousedown→pointerup→mouseup→click）のdispatchで選択できた。dataset-selectorの残存dropdownがCAのdropdownと重なる場合があり、切替直後の操作では注意が必要。
- 画面不具合の修正: ColumnSelectのoption valueを列名に統一（Crosstabと同様）。修正前はcolumnIdのため選択がAPIへ渡らず実行ボタンがdisabledのままだった。修正後に型検査エラーなし。

## 残作業
- [x] static実機相当の確認（`python -m http.server -d dist/static 8421` で配信。到達200、index.htmlがCAバンドル `index-CLX-_kY0.js` を参照、同バンドルに `models/ca` 4件・コレスポンデンス分析2件を含むことを確認。`pyodide/backend_app.zip` 200・300061 bytesで配信されることを確認）
- [x] run-production相当の配信確認（backend :8420で `/` 200・フロントdist配信、openapiに `/models/ca` と `/analysis-results` 6経路を掲載、不正入力に規定422が返ること、回答者80行の本番経路実行でλ=0.25・χ²=20を確認）
- [x] static再配布（`python scripts/build_static.py` をリポジトリルートから実行、exit 0。`dist/static/pyodide/backend_app.zip` にCA8ファイル組込を確認、112 files）
- [x] static同一性確認（再配布ZIP内の `app.algorithms.models.correspondence` を取出し実行し、λ=0.25・主座標±0.5でlocalと一致）
- [x] 外部R oracle照合（`C:\Program Files\R\R-4.6.1\bin\Rscript.exe` で実施。MASS::corresp χ²=20 df=1 p=7.744e-06・正準相関0.5、独立SVD計算で特異値0.5・固有値0.25・全慣性0.25・F=∓0.5・G=∓0.5・行距離0.25・寄与0.5・cos2=1を確認。符号除き本体と一致）
- [x] 本番フロントビルド（許可を得て `npm --prefix fullstack/frontend run build` を実行、exit 0。dist に models/ca を含むことを確認）
- [x] 静的フロント再ビルド（`npm --prefix fullstack/frontend run build:static` を実行、exit 0。`dist/static/assets` に models/ca を3件含むことを確認）

注意: `fullstack/scripts/build_static.py` を直接実行するとROOT解決が `fullstack/` になり backend が空振りする（設計資料の指摘どおり二重fullstack）。正しくはリポジトリルートの `scripts/build_static.py` を使うこと。今回は誤経路で一度空振りした後、正経路で再配布した。

## レビュー指摘12件の修正（2026-09-13）
- P1 保存済み重み: 画面に重み選択（データ設定/none）を追加し、保存済みweightConfigを初期値として使う。分割表＋dataset重みは二重ウェイトで拒否される旨を表示。
- P1 カテゴリID衝突: kindに基づき欠損のみcode=nullとし、通常コード（__a等）を保持。__a選択で40行が戻ることを確認。
- P1 選択のdataset一致: selectでownerDatasetIdとの一致を必須化。別dataset指定は422 ANALYSIS_DATASET_MISMATCH。
- P1 分割表の欠損コード: codebook missingCodesを参照し、欠損セルをCA_TABLE_INVALIDで拒否。
- P1 古い応答の採用: dataset変更でrunSequenceを進め、実行・選択ともdataset・版・世代を確認してから状態更新。
- P2 公開前版再確認: 保存直前にロック内で版を再確認し、変更時は409 ANALYSIS_INPUT_STALE。
- P2 分割表複数行選択: 同側カテゴリを和集合にし、R1+R2で2行が戻ることを確認。
- P2 カテゴリCSV: ラベル・質量・主座標・寄与・cos2を含む座標CSVに変更。分割表CSV（table）も追加。
- P2 GET復元: manifestにsummary/detailsを保存し、GETからCA結果を返す。
- P2 中央selection連動: 中央selectionに対応するカテゴリをmembers連携で強調（選択指定とは別の色）。
- P2 行ラベルtext許可: 行ラベル候補をnominal/ordinal/binary/text/idに拡大。
- P2 欠損方針固定: 分割表ではexclude固定・無効化し、送信値もexcludeに統一。
- 再検証: test_100_ca 6 passed、全体回帰473 passed、FE全体248 passed、tsc エラーなし。本番・static再配布済み。
- 実ブラウザ再確認: ca-rev2（80行）で行=brand・列=needを選択し実行。固有値0.25・χ²=20、点選択→一致40/適用40→selection 40行を確認。分割表モードで欠損方針がexclude固定・無効化されることを確認。
- FactoMineR 2.17照合: CA()で固有値0.25、行R1=0.5・R2=-0.5、列C1=0.5・C2=-0.5。符号除き本体と一致。

## レビュー001の8件修正（2026-09-13）
- R001 通常値と欠損の衝突: 欠損sentinelを内部キー（MISSING_SENTINEL等）に分離し、kind由来のみ変換。通常値__missing__は3方針すべてで通常カテゴリとして保持、真の欠損（null）はexcludeで除外・include系で欠損カテゴリに分離されることを確認。
- R002 ページング: export全テーブルでoffset/limitページングを確認（members 6000件を2ページで全件取得）。画面の中央連動とダウンロードはいずれもnextOffsetがなくなるまで取得し、CSVヘッダ重複除去・JSON統合を行う。
- R003 選択の版再確認: handleSelect開始時のdata/schema revisionを保存し、応答採用時に最新refと比較。遅延応答の書換えを防止。
- R004 stale表示: 結果表示中に10秒間隔で現版をポーリングし、変更時にstale警告と選択無効化。実ブラウザでschemaRev変更→14秒後にstale・警告・選択無効を確認。
- R005 行ラベル欠損: label_spec.missingCodesを判定し、該当行をCA_TABLE_INVALIDで拒否。
- R006 row_ids拒否: capabilities.selectionKindsに従い、CAではcategories以外を422 ANALYSIS_SELECTOR_UNSUPPORTEDで拒否。
- R007 除外優先順位: invalid>missing>missing_weight>zero_weightで決定。行列入替・複合条件で内訳一致を確認。
- R008 補完件数: mask entriesから対象列・scope・fit行のみ集計しmetaへ渡す。10件補完でimputedCellCount=10・imputedRowCount=10を確認（マスクのcolumnIdは列名形式のため両対応）。
- 再検証: test_100_ca 6 passed、全体回帰473 passed、FE全体248 passed、tsc エラーなし。本番・static再配布済み。
- 実ブラウザ再確認: ca-r001（80行）で実行→固有値0.25、点選択→一致40/適用40→selection 40行。Table1行選択→CA復帰で連動強調2点→解除で消去。分割表CSVボタンのexportを確認。版変更後のstale表示・選択無効を確認。

## 追加指摘4件の修正（2026-09-13、コミット 6fd247a0）
- P1 版変更後の古い応答: handleRunの世代確認をref比較（selectionRef・schemaRef）に修正。クロージャの古いdatasetId/dataRevision比較では版変更を取り逃がす問題を解消。
- P2 中央selection強調: members export応答の解析不具合（payload内JSONの二重解析漏れ）を修正。Tableで1行選択→CAに戻って2点に連動強調（#fa8c16）、解除で強調消去を確認。
- P2 切替後の実行中表示: dataset変更時にloading/selecting/linkedをリセット。
- P2 分割表CSV: 画面に分割表CSV/JSONボタンを追加し、export API 200（table表）を確認。
- 再検証: test_100_ca 6 passed、全体回帰473 passed、FE全体248 passed、tsc エラーなし。本番・static再配布済み（backend_app.zipにCA組込、dist/staticにmodels/ca 3件）。

R導入手順とFactoMineR照合（実施済み）:
- `C:\Program Files\R\R-4.6.1\bin\Rscript.exe --version` でR 4.6.1を確認した。
- `install.packages('FactoMineR', repos='https://cloud.r-project.org')` でFactoMineR 2.17を導入した。
- `CA(matrix(c(30,10,10,30),2,byrow=TRUE), graph=FALSE)` で固有値0.25、行座標R1=0.5・R2=-0.5、列座標C1=0.5・C2=-0.5を確認。符号を除き本体と一致。
- baseの `chisq.test`（χ²=20、df=1、p=7.744e-06）・`MASS::corresp`（正準相関0.5）・独立SVD計算でも照合済み。
- static同一コードE2E: 再配布ZIPを取出しASGI実行し、回答者80行でλ=0.25・χ²=20、select 40行、export CSVを確認した（Pyodideブラウザ実機ではなく同一コード実行）。

## 最終受入の未検証2件確認（2026-09-13）
- Pyodide配信: 別ポート8422でstatic配信し、index.html 200、バンドル `index-uGs_xchf.js`（models/ca 3件）、`backend_app.zip` 200・304952 bytesをHTTP取得。取得ZIP内にCA組込（113 files）を確認し、取出しkernel実行でλ=0.25・主座標±0.5を確認。
- run-production相当: backend :8420で `/` 200、openapiに `/models/ca` 掲載、本番経路でλ=0.25・χ²=20を確認。起動バッチ自体は対話pause付きのため直接実行せず、同等条件で確認。
- 残る未検証はPyodideブラウザ実機の全操作のみ（WASM実行環境を含む操作）。同一コードの配信・実行は確認済み。

## レビュー002の残存2件修正（2026-09-13）
- R001 衝突不能キー: 欠損sentinelを固定文字列からfrozen dataclass MissingKeyへ変更。通常値（__missing__・旧内部文字列含む）はcode保持、真の欠損とは別カテゴリ・別membershipになることを確認（通常値2行と欠損1行が分離）。
- R008 分割表の補完件数: 使用セル列・scopeに対応するマスク・版を取得しmetaへ渡す。同一行2セルはcell数とrow数で区別。マスク差し替えの隔離実行でmaskRevision=1・cell=1・row=1を確認。
- 再検証: test_100_ca 6 passed、全体回帰473 passed、FE全体248 passed、tsc エラーなし。本番・static再配布済み。
