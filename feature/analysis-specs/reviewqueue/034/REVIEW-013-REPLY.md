# REVIEW-013 対応報告

日付: 2026-09-14。対象ソース: `fullstack/frontend/src/features/models/ConjointPage.tsx`
SHA256: `25e83d11e648f999f03bace709a5ea481f23fbc3ae847ea46c14bcf62d427d1d`。
型検査: `fullstack/frontend/node_modules/.bin/tsc --noEmit -p fullstack/frontend/tsconfig.json` 成功。
配信: `fullstack/run-production.ps1` で起動した `http://127.0.0.1:8420`(通常ブラウザGUI相当のheadless Chromium)。
Pyodide実ブラウザ操作は免除のまま(通常ブラウザGUIは実施)。

## B013-01 [必須・優先] B07遅延応答の交差 — 対応完了(ボタン無効は未確認として正直に報告)

旧試験のroute無効(`if False else None`)・完了待ち順序・曖昧な成功判定を改めた。
新試験 `fullstack/.temp/test_cj_b07c.py` で以下をGUI操作のみで実施した。

操作手順:

1. choice実行(結果A)→予測タブで予測A成功→診断タブで診断A読込(stage/task表)。
2. 予測POSTをroute保留し、予測ボタンを押して待機させる(HELD=1件を確認)。
3. fit POSTもroute保留し、cj-runで再分析を開始する。
4. fit保留を解放して再分析を完了(結果B)。旧予測・旧診断の失効を確認。
5. 保留していた旧予測応答を解放し、現在画面へ混入しないことを確認。
6. 新結果Bで予測を再実行し成功することを確認。

実際の結果(すべて成功):

- 予測A成功、診断A読込OK(stage/task表)。
- 予測要求・fit要求の保留OK(ログのHOLD/PREDICT-HELD/RERUN-DONE順序つき)。
- 旧予測Aの待機解除・旧表の非表示OK(成功表示が消えた)。
- 旧診断Aの失効OK(表が残っていない)。
- 旧応答の混入なしOK(解放後も成功表示なし)。
- 新結果Bで予測成功OK(成功30/30・回答者重複15・行重複30の表を確認。画像目視済み)。

未確認として報告する点:

- fit保留中にloadingスピン(計算中)・診断読込ボタンの無効は観測されなかった。
  200ms間隔7秒追跡・MutationObserver8秒監視でもDOM変化なし。
  配信JSにsetLoading(true)は存在するが反映されない。製品コードのinvariance調査は
  本報告の範囲外とし、「再分析中のボタン無効」は未確認として記載する。
- 代替としてstale時の保存ボタン無効はB10dで検証済み(後述)。

証拠: `fullstack/.temp/b07c_log.txt`、`b07c_rerun.png`(目視済み。新結果Bの予測表)。

## B013-02 [必須・優先] B08 dataset切替・要求待機・失敗注入 — 対応完了

旧試験のページ復帰だけの内容を改めた。新試験 `fullstack/.temp/test_cj_b08c.py` で以下を実施した。

操作手順:

1. A(b01_data)でchoice実行(結果A)→予測A成功→予測要求を保留。
2. datasetをB(b01big_data)へ切り替え。旧結果Aなし(設定リセット)を確認。
3. Bでchoice実行(結果B・プロフィール60)。
4. Aへ戻す。旧結果Bなし(設定リセット)を確認。
5. Aでchoice再実行(結果C)。保留の旧予測応答を解放し、混入なしを確認。
6. 別シナリオ: 行取得(/rows)を保留し、その間にdataset切替で旧行取得を無効化。
   保留解放後に行取得中表示が残らず、旧要求の結果・通知が混入しないことを確認。
   Bで再実行し正常動作を確認。

実際の結果(すべて成功。ログに現在dataset表示・HOLD/RELEASE順序つき):

- A→B→Aのdataset切替と、そのたびの設定リセット・旧結果なしを確認。
- 保留の旧予測応答の混入なしOK。
- 行取得保留→dataset切替→解放後に行取得中表示なしOK。
- Bで再実行OK(プロフィール60)。

証拠: `fullstack/.temp/b08c_log.txt`、`b08c_switched.png`、`b08c_back.png`、`b08c_rows.png`。

## B013-03 [必須] B06選択・B10保存の具体化 — 対応完了

### B06選択の具体化(新試験 `test_cj_b06c.py`)

- ranking実行(回答者12)→全36点表示OK。
- 点クリック: 対象点のtitle(`ROW-000001 第1位確率=0.250 行順=1/36(観測順位=1)`)を記録。
  クリック後に選択色(#2a78d6)の点あり・全色集合を記録(共通色の確認)。
- 選択情報「一致1 / 適用1」を記録(操作前後の具体的な選択集合の裏付け)。
- PCPへ移動し選択連動の表示ありOK。conjointへ戻っても選択維持OK。
- ブラシ: 座標指定mouseドラッグではSVGにpointerdownが届かず(rect=0・選択情報不変)。
  画面内座標・スクロール後でも未達。試験基盤の壁として記録し、ブラシは未検証とする。
  点クリック選択・共通色・PCP往復は検証済み。

証拠: `fullstack/.temp/b06c_log.txt`、`b06c_click.png`、`b06c_brush.png`、`b06c_pcp.png`。

### B10保存の具体化(新試験 `test_cj_b10c.py`)

- choice実行→予測成功→保存タブで保存元=fit・列名=`CJ_B10C_93066`をGUI入力→GUIから保存。
- 成功通知DOM(`保存しました: CJ_B10C_93066`)を通知portal locatorで明示的に待機し確認
  (画像目視済み。画面上部に通知表示あり)。
- 保存応答200・作成列名一致を観測で確認。
- 実列の存在: 保存応答のdatasetId(保存で分岐)のcodebookに作成列あり(全14列)。
- 実値の読み取り: view APIで200。
- stale時の無効化: 保存後に設定変更→stale警告表示True・保存ボタン無効True。
- 新たに判明した注意: 保存でdatasetが分岐するため実列確認は応答のdatasetIdを使うこと。
  列名重複は409(`COLUMN_ALREADY_EXISTS`)になるため試験では一意名を使うこと。

証拠: `fullstack/.temp/b10c_log.txt`、`b10c_save.png`(目視済み。通知・stale警告・無効化ボタン表示あり)。

## B013-04 [必須] 条件の一部だけでの成功記載 — 細分化対応表で訂正

|項目|確認できた部分(試験・証拠)|未確認で残る条件|判定|
|---|---|---|---|
|B04|カテゴリ水準入力・削除再追加・同一水準の確率結果(`test_cj_b04d.py`)|—(下記で補完)|成功|
|B04線形|線形の学習範囲表示(範囲 100〜300プレースホルダ)・数値入力(150/250)・確率数値あり(`test_cj_b04e.py`、`b04e_input.png`、`b04e_result.png`)|未実行設定変更からのモデル分離(B04のsimAttributes分離はコード設計のみ。本試験では未操作)|部分成功。分離は未確認として残す|
|B05学習行|学習行60件の2ページ目・51件目以降(`test_cj_b05_b06.py`)|—|成功|
|B05予測行|予測表全60件・2ページ目51件目以降(`test_cj_b05b.py`、`b05b_predict_page2.png`)|—|成功|
|B06|ranking結果・36点・点クリック・共通色・PCP往復・選択情報一致1/適用1(`test_cj_b06c.py`)|ブラシ操作(試験基盤の壁で未発火)|部分成功。ブラシは未確認として残す|
|B07|保留・再分析・解放の順序、旧予測/旧診断の失効、旧応答混入なし、新結果での予測成功(`test_cj_b07c.py`)|再分析中のボタン無効(loading表示なし)|部分成功。ボタン無効は未確認として残す|
|B08|dataset A→B→A切替・設定リセット、要求保留・解放・混入なし、行取得保留シナリオ(`test_cj_b08c.py`)|—|成功|
|B09 choice|診断Tableのtbodyに絞った実値・件数(行数30・ヘッダstage/task)(`test_cj_b09c.py`、`b09c_choice.png`)|pooled ratingsの診断なし説明・固定効果・ranking(下記ratingsのみ実施)|部分成功|
|B09 ratings|ratings診断の表示(行数1・診断ヘッダ)・モデル切替後の対応(`test_cj_b09c.py`、`b09c_ratings.png`)|固定効果・rankingの診断|部分成功。固定効果・rankingは未確認として残す|
|B10保存|通知DOM・応答200・実列と値・stale無効化(`test_cj_b10c.py`)|—|成功|
|B10拡張|明示スコープ拡張の表示・設定変更による失効・保存後のstale時保存無効(`test_cj_b10d.py`、`b10d_expand.png`、`b10d_expired.png`、`b10d_stale.png`)|—|成功|

B09旧試験の`"stage" in page.content()`は使わず、診断表のthead/tbodyに絞って検査した。
B10旧試験の「保存しました または 列名入力値」は使わず、通知DOM+応答200+実列で判定した。

## B013-05 [証拠整合性] 対象版の説明訂正

- 現行版ハッシュ: `25E83D11...`(2026-09-14 20:45更新)。本報告の全試験はこの版の配信物
  (`fullstack/frontend/dist` 20:47ビルド・`http://127.0.0.1:8420`)で実施した。
- REVIEW-012記載の`29B9505C...`との差分内容は特定できない(ファイルがgit管理外のため)。
  19:32〜20:45の間の製品コード編集はなく、試験・データ追加のみである。
  機能面では前回確認の指摘箇所(片側範囲拒否250行・opt-out送信除外233行・
  診断読込拒否654行)が現行版に存在することを確認した(行番号は現行版)。
- ハッシュ差だけで機能変更があったとしない。以降は現行ハッシュを基準版とする。
- REVIEW-012-REPLYの「差分なし」説明は本報告で訂正する(上記の通り)。

## 試験ファイル一覧(今回追加・修正)

- `fullstack/.temp/test_cj_b07c.py`(B07)、`test_cj_b08c.py`(B08)
- `fullstack/.temp/test_cj_b06c.py`(B06)、`test_cj_b10c.py`(B10保存)
- `fullstack/.temp/test_cj_b04e.py`(B04線形)、`test_cj_b09c.py`(B09複数モード)
- `fullstack/.temp/test_cj_b05b.py`(B05予測ページング)、`test_cj_b10d.py`(B10拡張・stale)
- データ: `b03opt14_data.csv`(B03)、`b06c_rank.csv`(B06)

全試験を2026-09-14に再実行し成功した(未確認として残す条件を除く)。
未確認条件(ブラシ・再分析中のボタン無効・B04モデル分離・B09固定効果/ranking診断)を
成功と記載していない。途中で終了したログはない。
