# Feature 036 実装報告009（REVIEW-008残指摘の実ブラウザ検証）

日時: 2026-09-18 JST。対象レビュー: REVIEW-008。基点: master / 70cbfe44。最新ソースへのレビューOKは未取得。コミット・pushなし。

## ソース識別情報

製品コードの変更なし（REPORT-008から同一）。SHA256は下表のとおり。N004-01のviz.css末尾空行除去は維持する。

| 対象 | SHA256 |
|---|---|
| AppShell.tsx | 61c12d3653fec4e0f545015408b1e447c18b865a83c7ab14e3c3acec3dfd8f3a |
| viz.css | 378aff2eb7921ae75b2449e2cf8777dd9c61868df006d4f41382e985b5997acd |
| appNavigation.test.tsx (untracked) | 968b902b74eac4a5b78f85e143faff09f8bddf799a6cd98e05e8b16cb7c70aa4 |
| dist index-CKY31PSW.js | 02781a79b145c01224d2c374ce80b9c7e1ecd647dad5615a768777cee32a0784 |
| dist index-ln5rxMhz.css | d0c199dc0be0016e315437985b11e4254f925e0fafcb3c0d39b576bbd806ab05 |

- `git diff --check -- fullstack/frontend/src/theme/viz.css fullstack/frontend/src/app/AppShell.tsx`: exit 0、警告なし（N004-01維持）。
- 通常ビルド: `npm --prefix fullstack/frontend run build` exit 0（✓ built in 20.24s）。distはindex-CKY31PSW.js / index-ln5rxMhz.css（ビルド前後で同一名・同一hash）。
- 配信照合: 本番8420の `/` が `assets/index-CKY31PSW.js` を参照し（HTTP 200 bytes=394）、配信JSのSHA256がローカルdistと一致（curl確認）。
- 限定テスト: `npm --prefix fullstack/frontend test -- tests/appNavigation.test.tsx tests/keepAlive.test.tsx tests/topKSelectionKeepAlive.test.tsx` → 24 passed / 0 failed。
- 本報告のリンクはすべて `evidence/report009-resume/` からの相対参照である。

## 実ブラウザ検証の前提

- 対象URL: http://127.0.0.1:8420（uvicorn直接起動。run-production.ps1と同等。起動出力・curl応答は[run_n009_bootlog.txt](evidence/report009-resume/run_n009_bootlog.txt)に保存）。
- 読込bundle: 各runの前提条件ケースで `index-CKY31PSW.js` の読込を記録（S0/Z0/V0）。
- 可視タブ・非ゼロ幅を前提条件として記録。今回はすべてvisible/1440（または指定幅）で成立。
- 各ケース独立run ID・独立出力。Menu遷移は実クリック経路（部分一致ではなく完全一致で葉を選択）＋pathname＋現在地の両方検査で表示中ページを限定した。
- 試験スクリプト: [evidence/report009-resume/run_zoom.py](evidence/report009-resume/run_zoom.py)（Z: 5ケース）、[evidence/report009-resume/run_zoom_viewport.py](evidence/report009-resume/run_zoom_viewport.py)（V: 4ケース）、[evidence/report009-resume/run_n009_state.py](evidence/report009-resume/run_n009_state.py)（S/V08〜V11: 15ケース、V08a除外で14ケース）。今回runの結果JSON・スクリーンショットは同フォルダのrun_all_out/run_state_outに保存し、既存runを上書きしていない。

## 指摘別の検証結果

| 指摘 | 判定 | 証拠 |
|---|---|---|
| N008-01（V05: 実ブラウザ200%拡大） | 合格 | Z0: 可視/1280/bundle/DPR1を確認。Z1: CDP Emulation.setPageScaleFactor=2.0を実Chromium headedウィンドウ（1280x800）に適用し、CDP cssVisualViewport.scale==2とwindow.visualViewport.scale==2（640x360）の両方で拡大適用の事実を記録。DPRは1のまま（deviceScaleFactor不使用）、CSS zoom不使用。Z2: 拡大状態のまま実Menu操作（次元削減→因子分析の完全一致クリック）で末尾葉へ到達し、pathname＋現在地一致を確認。Z3: 拡大状態のまま横スクロールなし（bodySW=1280/docCW=1280）・可視Menu項目の重なりなしを確認。Z4: 拡大解除（scale 1）後にMenu操作が復旧することを確認。ブラウザ倍率・実効viewport・スクリーンショット（z-200pct/z-popup/z-factor）・操作結果を同じrun（20260918-212447）に保存。加えて、デスクトップChromeの200%ページズームのレイアウト等価（1280px幅×200%＝640 CSS px相当）を通常DPR=1・deviceScaleFactor不使用の640px viewportで検証し、機能一覧ボタン→分類→末尾葉「因子分析」到達・横スクロールなし（640/640）・重なりなしを確認（20260918-212339、v640-pcp/v640-factor保存）。setPageScaleFactorがpinch-zoom経路でありデスクトップのCtrl+=ページズームと厳密には異なる点は両スクリプトのdocstringに明示した。 |
| N008-02（V08: Pyodide免除の読替え禁止・入力変更の往復） | 合格 | V08aはok:false固定の記録のみとし、合計14/14から除外した（JSONのexcluded_from_passに明示）。V08b1: 重回帰の目的変数（単一Select、実クリック＋scroll後クリック）、重みradio（データ設定→なし、Radio.Group順序で実クリック、input[value]で判定）、対象radio（Active→全体、実クリック）を意図的に変更し、変更前後の選択値・radio値を記録。V08b: 実Menu往復（重回帰→因子分析→重回帰、完全一致クリック）でタブスコープの選択値・表示テキスト完全一致を確認（KeepAliveのdisplay:noneタブをdata-tab-pathで限定。非表示タブの残存option混入を排除）。因子分析側も相関Select（Polychoric→Pearson、実クリック）・重みradio（なし、実クリック）を変更した。V08c: コンジョイントの回答者ID列（単一Select、実クリック）を変更し、PCP→コンジョイント→PCP→コンジョイント往復で選択値一致・svg描画維持（39/53）を確認。Pyodide由来の計算中・結果状態は成功ケースに含めていない。なお、ColumnSelectのmultiple（数値説明変数・因子分析項目）は選択しても選択表示に反映されない既知の挙動のため変更対象から外し、単一Select＋radioを対象とした（スクリプトに明記）。 |
| N008-03（V09: ウェイト・変数・行範囲の変更と保持） | 合格 | s dataset（80行・weight列wあり）を使用。V09b: ウェイト未選択→wへ実クリックで設定し、値が変わったこと（未選択→w — w）を成功条件として確認。可視optionのみを対象にし、dataset-selectorの残存optionと区別した。V09c: 変数popoverのcheckbox先頭を実クリックで外し、3/3→2/3へ変わったことを確認。V09d: 行範囲1-10を選択行へ適用し、ヘッダ正本（globalObservations）の選択:10行で確認。Table横サイドバーはselectionスライスの旧表示でありrange適用が反映されないため、判定はヘッダ正本で行った（スクリプトに明記）。V09e: Table→PCP→Tableの三地点で選択（ヘッダ正本）・ウェイト（w — w）・中央状態バーの一致を確認。V09f: ウェイトクリア→未選択、変数「全選択」ボタン→3/3、ヘッダ解除→選択:0行へ戻したことを確認。 |
| N008-04（V10・V11: 旧状態と共通操作） | 合格 | V10a: 切替前に旧dataset（Iris builtin）で選択2件（checkbox実チェック）・可視popup1（可視化分類を実クリック）を作り、切替直前の前提として記録。V10b: n007_allnanへ切替後、Tableを実Menuで再訪し、選択行0・可視nav-popup0を確認。旧選択2→0・旧popup1→0の消滅に加え、列metadataでallnan列のmissingCount=3/rowCount=3を証明した。V11: 拡大開始でdialog開→拡大解除で閉を確認後、Export dropdownを実クリックで開き（全行CSV等の項目を確認、ダウンロードは開始しない）Escapeで閉鎖、Save modalを実起動（セッション保存タイトルを確認、保存は実行しない）して閉鎖、Importのfile input存在（1件）を確認、Licenseダイアログを開閉し、Menu操作復旧を確認した。いずれもデータを上書きしないopen-only操作である。 |
| N008-05（V12とタスク記録） | 解消 | 起動ログは[run_n009_bootlog.txt](evidence/report009-resume/run_n009_bootlog.txt)に完全なコマンド列、起動確認日時（JST）、起動出力、curl応答（HTTP 200・bundle参照・配信JSのSHA256一致）、JS/CSSのSHA256実測値、run ID・期待値・実測値をrun IDと同じ記録へ保存した。tasks/DAVIS-FEAT-036.mdの先頭状態・再開記録・段階表（S2/S3/S4）・実施記録・レビュー確認記録をREPORT-009のrun ID・結果（zoom 5/5・viewport 4/4・state 14/14・限定24件）に更新し、REPORT-006・run_all 22/22・旧残事項の参照を解消した。レビュー待ちの状態は維持する。失敗run（目的変数選択の直接goto不備、multiple選択の表示未反映、weight-selectの残存option混入、range inputのtestid位置、var復元の全選択切替等）はスクリプト修正履歴として残る。 |
| N004-01（viz.css末尾空行） | 解消（維持） | `git diff --check` exit 0。機能変更なし。 |

## 結果サマリ

- run_zoom（20260918-212447）: TOTAL 5/5。[結果JSON](evidence/report009-resume/run_all_out/20260918-212447-results.json)
- run_zoom_viewport（20260918-212339）: TOTAL 4/4。[結果JSON](evidence/report009-resume/run_all_out/20260918-212339-results.json)
- run_state（20260918-221755）: TOTAL 14/14（V08a除外）。[結果JSON](evidence/report009-resume/run_state_out/20260918-221755-results.json)
- 限定テスト: 24 passed / 0 failed。通常ビルド: exit 0。`git diff --check`: exit 0。

## 残事項・確認してほしい点

1. V08のPyodide由来の計算実行・数値検証は免除範囲として要求していない。入力値の変更・保持のみを検証した。受入可能か確認してほしい。
2. V09の行範囲適用はglobalObservationsスライス（ヘッダ正本）に反映され、Table横サイドバー（selectionスライス旧表示）には反映されない。判定はヘッダ正本で行った。表示の二重性自体は製品の既知の状態であり、本報告では変更していない。受入可能か確認してほしい。
3. ColumnSelectのmultiple選択が選択表示に反映されない既知の挙動は製品の状態であり、本報告では変更していない。単一Select＋radioでの変更・保持で受入可能か確認してほしい。

レビュー文書は編集していない。tasks/DAVIS-FEAT-036.mdとtasks/task-list.mdの更新は本報告の提出に合わせて行う。
