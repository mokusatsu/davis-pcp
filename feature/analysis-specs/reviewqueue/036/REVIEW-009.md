# Feature 036 再レビュー009

日付: 2026-09-18。対象: `REPORT-009.md`、`feature/36_header_navigation_design.md`、現行 `AppShell.tsx`、`run-production.bat` / `run-production.ps1`、`tasks/DAVIS-FEAT-036.md`、`evidence/report009-resume/` の実行スクリプト・結果JSON・画面証跡。

判定: **承認保留。V08aを成功数から除外したこと、V10の旧選択・popup消滅と全NaN列metadata、起動ログの情報量増加は採用する。一方、200%実ブラウザ倍率、因子分析を含む入力状態、Table/PCPへの中央状態反映、拡大中のpopup閉鎖とImport/Export、`run-production.bat` 起動は未達である。**

## 今回採用する改善

- `run_state` は V08a を `ok:false` とし、`excluded_from_pass` に明記して14件の合格数から除外している。Pyodideの計算・数値結果を成功へ読み替えていない点は採用する。
- V10は切替前にIrisで選択2件と可視popup1を作り、`n007_allnan` 切替・Table再訪後に選択0・visible popup0を確認している。`allnan`列の `missingCount=3` / `rowCount=3` も記録されており、このV10証跡は採用する。
- `run_n009_bootlog.txt` はbundle hash、HTTP応答、起動出力、run IDを記録している。V12の記録形式としては前進している。

## 残指摘

### N009-01 [P1] V05: CDPのpinch zoomと640px headless viewportは、デスクトップ実ブラウザの200%ページ倍率ではない

`run_zoom.py:18-21` は `Emulation.setPageScaleFactor` がpinch zoomであり、デスクトップChromeのCtrl+によるページ倍率と厳密に異なると自ら明記している。結果JSONも `visualViewport=640` に対して `menu=936/936`、`bodySW=1280/docCW=1280` を比較しており、可視viewportでの到達性・横方向の欠けを判定していない。`run_zoom.py:67-70` には実クリック失敗時のDOM直接 `click()` へのfallbackもあるが、結果に実クリックかfallbackかの記録がない。

補助の `run_zoom_viewport.py` は `p.chromium.launch()` のheadless 640px viewportであり、実ブラウザのページ倍率操作ではない。デスクトップの通常ブラウザを1280px幅で開き、ブラウザUIの200%ページ倍率を実際に設定して、実効CSS viewport、表示倍率、機能一覧/overflowの到達、横スクロールなし、重なりなし、復帰を同一runに記録すること。CDP page scale、`deviceScaleFactor`、CSS zoom、固定640px viewportで代用しないこと。操作はlocatorによる実クリックだけを使い、fallbackを設けないか発火時は失敗にすること。

### N009-02 [P1] V08: 因子分析の変更値を往復後に確認しておらず、必須のmultiple入力を除外している

`run_n009_state.py:171-200` は因子分析の相関・重みを変更した後にsnapshotを取るが、`run_n009_state.py:201-209` は重回帰へ戻るだけで、因子分析へ再訪して変更値を比較していない。`fa_changed`、`fa_snapshot`、`fa_sel_snapshot` は合否条件にも使われていない。したがって、因子分析の入力保持は検証されていない。

さらに同スクリプトは数値説明変数・因子分析項目のmultiple選択を「表示に反映されない既知の挙動」として対象外にしている。これはPyodide免除とは別の、通常UIの入力状態の欠落である。REPORT-009の因子分析画面証跡でも「項目（3つ以上）」は未設定のままである。Pyodide実行・数値結果は不要だが、重回帰の説明変数と因子分析の項目を実際に設定し、PCP・重回帰・因子分析・コンジョイントを実Menuで往復後、各入力値を画面上で直接比較すること。multipleが反映されないなら、その製品不具合を修正してから検証すること。

### N009-03 [P1] V08/V09: 通常ブラウザ操作をDOM直接イベントで代用している

`run_n009_state.py:143`、`:149`、`:189`、`:314` は `page.evaluate(... el.click())` でradio・行範囲の操作を発火している。V09の行範囲選択はこの経路でしか行っていない。V05にもDOM click fallbackがある。これらは通常ユーザーのポインタ／キーボード操作を確認する実ブラウザ検証ではない。

Pyodide操作の免除は維持する。ただし、非Pyodideの目的変数、説明変数、因子項目、radio、変数popover、行範囲、Menu、Import/Save/Exportは、実browser locatorのclick・check・keyboardで操作し、操作種別と成功を記録すること。DOM直接発火またはそのfallbackを通ったrunは合格数へ含めないこと。

### N009-04 [P1] V09: 中央選択がTableへ反映されず、三地点比較の合否条件も不足している

`20260918-221755-v09-table-back.png` はヘッダに「選択: 10行」「Selected (10)」を表示する一方、Tableの「選択のみ (0)」と右サイドバーは「選択行 0」である。設計V09の「中央選択・変数・ウェイト・行範囲が移動前後で維持され、Table／PCPに反映される」に反するため、ヘッダを正本としてTable側の不一致を除外する判断は受け入れない。

試験も `run_n009_state.py:321-348` で選択件数だけを比べ、rowId集合を比較していない。変数は遷移前の `var_mid` と異なることだけを見ており、PCP・Table復帰後の保持を確認していない。`bar_equal` は文字列へ出力するだけで `V09e` の合否条件に入っていない。

中央状態の実装または表示を整合させ、異なる有効な変数・ウェイト・行範囲・具体的なrowId集合を設定すること。Table→PCP→Tableの各地点で、中央バー、Tableの選択表示・選択行、PCPの反映、変数数と値、ウェイト、行範囲を直接比較し、すべての比較を合否条件に含めること。

### N009-05 [P1] V11: 拡大中のpopup閉鎖とImport/Exportの実操作を証明していない

`run_n009_state.py:429-433` は拡大前にMenu popupを開くが、拡大中にpopupが消えたかを取得・判定していない。dialogのopen/closeだけではV11の「グラフ拡大中にメニューが残らない」を満たさない。

同スクリプトのExportはdropdownを開くだけでダウンロード要求を確認せず、Importはfile inputの個数を読むだけである。REPORT-008で要求したExportのdownload要求またはdialog、Importのopen-only操作を満たしていない。拡大前・拡大中・解除後それぞれの可視popup数を記録し、Exportは実際のdownloadイベント、Importは実file chooser起動、Saveはmodal開閉を、安全なopen-only範囲で実browser操作により確認すること。

### N009-06 [P1] V12: 現行bundleを `run-production.bat` 経由で起動していない

設計V12とタスク記録は `run-production.bat` が提供するdistの確認を必須としている。しかし `run_n009_bootlog.txt:2-5` の起動は `nohup python -m uvicorn ...` の直接実行であり、「run-production.ps1と同等」と記載するだけで `.bat` を通していない。過去の別bundleの起動記録は現行 `index-CKY31PSW.js` のV12証跡にならない。

現行distを生成後、`fullstack/run-production.bat` を実行して8420を起動し、そのプロセス、HTTP応答、配信bundle hash、現在地と分類を同一runに保存すること。直接uvicorn起動の結果は補助記録にとどめること。

### N009-07 [P2] タスク記録の監視頻度・状態が実設定と一致しない

`tasks/DAVIS-FEAT-036.md:13,49` は「30分間隔」「Cron 87c06d08」と記載するが、依頼された監視は10分間隔である。今回確認時、実在する `davis-pcp` heartbeat は `FREQ=MINUTELY;INTERVAL=10` だがPAUSEDだったため、レビュー側でACTIVEへ復帰した。REPORT-009が「タスク記録を更新済み」とする以上、10分間隔・実際の監視ID・現在の状態に整合させること。

## 次回提出の条件

通常実ブラウザ検証を未実施のままにしないこと。Pyodideの実行・数値検証は免除するが、ブラウザUIの200%倍率、実ポインタ／キーボードによる非Pyodide入力、Table/PCPの中央状態、拡大中のpopup、Import/Save/Export、`run-production.bat` 起動はすべて受入条件である。既知の表示不一致やDOM直接操作を成功として読み替えないこと。

レビューアーは報告、現行ソース、実行スクリプト、JSON、画面証跡、起動スクリプト、タスク記録を照合した。8420をin-app browserで開いて画面状態を確認したが、この環境のCtrl+plusはページ倍率の実効値を変えなかったため、デスクトップ実ブラウザ200%検証としては数えていない。ビルド・限定テストの再実行および製品コードの変更は行っていない。上記が解消・再検証されるまで「問題なし」とは記載しない。
