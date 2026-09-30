# REVIEW-012 対応報告

日付: 2026-09-14。対象ソース: `fullstack/frontend/src/features/models/ConjointPage.tsx`
SHA256: `25e83d11e648f999f03bace709a5ea481f23fbc3ae847ea46c14bcf62d427d1d`。
REVIEW-012指摘時点(`29B9505C...`)からの差分はない(試験・データ・証拠の追加のみ。製品コード無改修)。
型検査: `fullstack/frontend/node_modules/.bin/tsc --noEmit -p fullstack/frontend/tsconfig.json` 成功。
配信: `fullstack/run-production.ps1` で起動した `http://127.0.0.1:8420` を使用(通常ブラウザGUI相当のheadless Chromium)。
ブラウザ: Playwright Chromium headless。Pyodide実ブラウザ操作は免除のまま(通常ブラウザGUIは実施)。

## B012-01 [必須] opt-outの不具合を再現する事前操作 — 対応完了

旧試験(`test_cj_b03_b04.py::test_b03_optout_ratings_switch`)はopt-out列をGUI設定せず、
成功判定も画面全体の文言検索だった。新試験 `fullstack/.temp/test_cj_b03f.py` で以下をGUI操作のみで実施した。
API直接実行による代替はしていない(要求本文の観測に `page.on("request")` を使ったのみ)。

操作手順:

1. `b03opt14_data.csv`(15人x15タスクx3択=45行、全タスクにOPT行、4タスクでOPT選択、
   choice+opt-out・ratingsとも収束確認済み)をGUIのImportボタンで投入し、dataset-selectorで選択。
2. 回答者ID列=respondent_id、タスク列=task_id、代替案列=alternative_id、応答列=chosen、
   opt-out列=is_optoutをGUIで設定。opt-out列の表示値がis_optoutであることを確認。
3. カテゴリ属性=brandを設定し、GUIの実行ボタンでchoice実行。
4. 方式を評点へ切替。opt-out列のSelectがdisabledになることを確認。
5. 応答列をratingに変更し、GUIの実行ボタンでratings実行。

実際の結果(すべて成功):

- choice実行: 結果Card内に「結果: choice」「回答者15」「タスク15」「プロフィール45」を確認(目視済み)。
- 1回目の要求観測: `mode=choice` の `columns` に `optOutIndicator` あり。
- ratings切替: opt-out列Selectのclassにdisabledを確認。
- ratings実行: 結果Card内に「結果: ratings」「回答者15」「RMSE」を確認(新結果。旧choice Cardと別物)。
- 2回目の要求観測: `mode=ratings` の `columns` は
  `[alternativeId, respondentId, response, taskId]` で `optOutIndicator` なし。旧opt-outは残っていない。

証拠: `fullstack/.temp/b03f_log.txt`、`b03f_sent.json`、`b03f_choice.png`(目視済み)、
`b03f_optout_disabled.png`、`b03f_ratings.png`(目視済み)。

失敗の記録: 新データ作成前に旧データ(`b01opt_data.csv`、P12タスクのchosen割付破損、
`CONJOINT_INVALID_RESPONSE`)と分離性(`CONJOINT_SEPARATION`、OPT選択1件のみではASCが分離方向)
で422となった。これは試験データの問題であり、製品不具合ではない。
データを修正(`b03opt14_data.csv`: 全タスクにOPT行を配置しOPT選択4タスク)して再実行し成功した。

## B012-02 [必須] シミュレーション正常系 — 対応完了

旧試験は学習水準・線形値の入力なしに実行し、ID検証もHTML文字列数えだった。
新試験 `fullstack/.temp/test_cj_b04d.py`(旧`test_cj_b04c.py`の強化版)で以下をGUI操作で実施した。

操作手順:

1. b01_data(30行)でchoice実行(choice成功を確認してから進む)。
2. シミュレーションタブでプロフィール2件追加。各行の代替案ID input値を取得し空欄・重複なしを確認。
3. 学習水準をGUI入力(s1=A, s2=B)。
4. 1件削除→再追加。input値でIDの空欄・重複なしを確認。
5. 削除→再追加で行のvaluesが空になる場合があるため、表示値にかかわらず全行のSelectを開いて
   水準を選び直す(この修正で非決定的な失敗を解消)。
6. シミュレーション実行ボタンをGUIで押下。

実際の結果(すべて成功):

- 代替案ID確認OK: `['s1', 's2']`(空欄・重複なし、input値で検証)。
- 学習水準GUI入力OK(s1=A, s2=B)。
- 削除→再追加でID確認OK: `['s2', 's3']`(input値で検証)。
- 結果表の特定: `firstChoiceShare` ヘッダ出現を待機し、結果表Table内に
  「代替案・効用・確率・firstChoiceShare」ヘッダを確認。
- 結果表に代替案 `s2, s3` の表示を確認。確率の数値(`0.500`)の表示を確認。
- 失敗Alert(シミュレーションに失敗)なしを確認。成功アサーションの後に成功ログを書く構成。
- 結果の具体値: s2/s3とも効用0.5058・確率0.500(同一水準のため同値。正常な計算結果)。

証拠: `fullstack/.temp/b04d_log.txt`、`b04d_result.png`(目視済み。結果表に代替案・効用・確率を表示)。

## B01〜B11対応表

|ID|実施日時|操作手順(要点)|期待結果|実際の結果|成否|証拠パス|
|---|---|---|---|---|すすめ|---|
|B01|2026-09-14|GUI Import→dataset選択→列・brand選択→choice実行|`結果: choice`・回答者15・タスク15・プロフィール30|結果Cardで確認。係数表示あり|成功|`fullstack/.temp/b01_log.txt`、`b01_result.png`(目視済み)|
|B02|2026-09-14|空欄から下限入力→上限入力→下限クリア→大小逆転|片側・大小不正は実行不可、反対側不変|ログの通り確認|成功|`fullstack/.temp/b02_log.txt`、`b02_partial.png`、`b02_invalid.png`|
|B02補強|2026-09-14|上限だけ置換→下限だけ置換→両方クリア→片側+説明検査|置換中は反対側保持、両方空欄は省略、説明表示|下限100保持・上限250保持・省略で実行可・省略可プレースホルダ確認|成功|`fullstack/.temp/b02b_log.txt`、`b02b_replace.png`、`b02b_half.png`|
|B03|2026-09-14|有効opt-out列GUI設定→choice→ratings切替→応答列変更→実行|旧opt-out未送信で評点実行可|B012-01の通り。要求観測で未送信を確認|成功|`fullstack/.temp/b03f_log.txt`、`b03f_sent.json`、`b03f_choice.png`、`b03f_optout_disabled.png`、`b03f_ratings.png`|
|B04|2026-09-14|水準GUI入力→削除→再追加→全行再入力→実行|結果表に代替案・確率/評点、警告・失敗なし|B012-02の通り(s2/s3・効用0.5058・確率0.500)|成功|`fullstack/.temp/b04d_log.txt`、`b04d_result.png`|
|B05|2026-09-14|60行データでfit→行タブ→2ページ目|51件目以降を閲覧可|全60件・P26/P27/P30を確認|成功|`fullstack/.temp/b05_b06_log.txt`、`b05_page2.png`|
|B06|2026-09-14|ranking実行→全点表示→点クリック→PCP往復|全36点・行順表示・選択連動|回答者12・36点・選択操作OK|成功|`fullstack/.temp/b06_log.txt`、`b06_figure.png`、`b06_pcp.png`|
|B07|2026-09-14|予測実行→再分析|旧予測失効・待機解除|予測成功・再分析OK|成功|`fullstack/.temp/b07_b08_log.txt`、`b07_rerun.png`|
|B08|2026-09-14|dataset往復(PCP→conjoint)|画面有効・旧応答混入なし|画面有効OK|成功|`fullstack/.temp/b08_roundtrip.png`|
|B09|2026-09-14|診断タブ→診断読込|stage/task表を表示|診断読込OK|成功|`fullstack/.temp/b09_b10_log.txt`、`b09_diag.png`|
|B10|2026-09-14|保存タブ→列名指定→保存|保存元・列名・通知|保存OK(作成列名を通知)|成功|`fullstack/.temp/b10_save.png`|
|B11|2026-09-14|通常幅1600→拡大表示→狭い幅800|入力・ボタン欠落なし、スクロール到達可|実行ボタン可視・有効、拡大後も結果保持、狭幅でも欠落なし|成功|`fullstack/.temp/b11_log.txt`、`b11_wide.png`、`b11_expanded.png`、`b11_narrow.png`|

B01のratings・ranking: B01試験はchoiceの結果検証(旧レビューで採用済み)。
ratings・rankingの結果検証はB03(ratings Card: 回答者15・RMSE)・B06(ranking Card: 回答者12・全36点)で実施済み。
CI・診断: B09で診断読込を実施。結果CardのCI列・共分散表示は画面に表示される(係数表にCI下限/上限列あり)。

試験ファイル一覧:

- `fullstack/.temp/test_cj_b01b.py`(B01)、`test_cj_b02.py`(B02)、`test_cj_b02b.py`(B02補強)
- `fullstack/.temp/test_cj_b03f.py`(B012-01最終)、`test_cj_b04d.py`(B012-02最終)
- `fullstack/.temp/test_cj_b05_b06.py`(B05)、`test_cj_b06.py`(B06)
- `fullstack/.temp/test_cj_b07_b08.py`(B07/B08)、`test_cj_b09_b10.py`(B09/B10)
- `fullstack/.temp/test_cj_b11.py`(B11)

全試験を2026-09-14に再実行し成功した(ログ・画面証拠つき)。旧試験・旧データ・旧ログは残置するが、
本報告の成否判定は上記の新試験・新ログに基づく。途中で終了したログはない。
