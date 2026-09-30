# Feature 036 実装報告008（REVIEW-007残条件の実ブラウザ検証）

日時: 2026-09-18 JST。対象レビュー: REVIEW-007。基点: master / 70cbfe44。最新ソースへのレビューOKは未取得。コミット・pushなし。

## ソース識別情報

製品コードの変更なし（REPORT-007から同一）。SHA256は下表のとおり。N004-01のviz.css末尾空行除去は維持する。

| 対象 | SHA256 |
|---|---|
| AppShell.tsx | 61c12d3653fec4e0f545015408b1e447c18b865a83c7ab14e3c3acec3dfd8f3a |
| viz.css | 378aff2eb7921ae75b2449e2cf8777dd9c61868df006d4f41382e985b5997acd |
| appNavigation.test.tsx (untracked) | 968b902b74eac4a5b78f85e143faff09f8bddf799a6cd98e05e8b16cb7c70aa4 |
| dist index-CKY31PSW.js | 02781a79b145c01224d2c374ce80b9c7e1ecd647dad5615a768777cee32a0784 |
| dist index-ln5rxMhz.css | d0c199dc0be0016e315437985b11e4254f925e0fafcb3c0d39b576bbd806ab05 |

- `git diff --check -- fullstack/frontend/src/theme/viz.css fullstack/frontend/src/app/AppShell.tsx`: exit 0、警告なし（N004-01維持）。
- 通常ビルド: `npm --prefix fullstack/frontend run build` exit 0。distはindex-CKY31PSW.js / index-ln5rxMhz.css。
- 配信照合: 本番8420の `/` が `assets/index-CKY31PSW.js` を参照し、取得内容がローカルdistと一致（curl確認）。
- 限定テスト: `npm --prefix fullstack/frontend test -- tests/appNavigation.test.tsx tests/keepAlive.test.tsx tests/topKSelectionKeepAlive.test.tsx` → 24 passed / 0 failed。
- 本報告のリンクはすべて `evidence/report008-resume/` からの相対参照である。

## 実ブラウザ検証の前提

- 対象URL: http://127.0.0.1:8420（run-production.bat経由の本番配信。起動serverId: a48f8209-2cd7-4906-bb29-559b560aa98b）。
- 読込bundle: 各runの前提条件ケースで `index-CKY31PSW.js` の読込を記録（A0/S0）。
- 可視タブ・非ゼロ幅を前提条件として記録。今回はすべてvisible/1440（または指定幅）で成立。
- 各ケース独立run ID・独立出力。メニュークリック経路のpathname＋現在地の両方検査で表示中ページを限定した。
- 試験スクリプト: [evidence/report008-resume/run_n007_all.py](evidence/report008-resume/run_n007_all.py)（A〜E: 34ケース）、[evidence/report008-resume/run_n007_state.py](evidence/report008-resume/run_n007_state.py)（S/V08〜V11: 9ケース）。REPORT-007系スクリプトを複写し、N007指摘の判定方式を修正した。今回runの結果JSON・スクリーンショットは同フォルダのrun_all_out/run_state_outに保存し、上書きしていない。

## 指摘別の検証結果

| 指摘 | 判定 | 証拠 |
|---|---|---|
| N007-01（V05・V06: 実ホイール・必須表示幅） | 合格（200%拡大のブラウザ操作は条件付き） | C2: overflow親で末尾「因子分析」へ実クリック到達。scroll容器上にポインタを置いた実ホイール（mouse.wheel×6）でscrollTop 0→8へ変化し、末尾葉の可視・クリック・pathname＋現在地一致を確認。scrollTop直接代入は不使用。W1023/W390: 新規ページで直接開き、パネル→分類→末尾葉「因子分析」へ実操作で到達（pathname＋現在地一致）。W1280: 横スクロールなし。W1280Z: deviceScaleFactor=2の200%相当で横スクロールなし・重なりなし（可視要素のみで判定、非表示の測定用残存ノードを除外）。C7: popupを開いたまま1024→768→1440を実行し、各段階の可視popup数（1→0→0）と復帰後の操作可能性を判定に含めた。ブラウザ自体の200%拡大操作は未実施。 |
| N007-02（V07: overflow幅キーボード） | 合格 | E2: 実Tabで到達したactive elementを起点に矢印キーでoverflow入口へ到達（focus()直接呼び出しは不使用、経路を記録）。E3: 入口Enter後に可視popupの存在を記録したうえでEscape→popup0・入口要素へ復帰（role・名前・可視矩形を記録）。E4: overflow popup内の分類をEnterで開き、子popupの葉（FAMD）へ矢印移動してEnterで選択し、pathname＋IN-MAIN＋popup0を確認。E5: 現在機能（FAMD）の再選択で同一path・履歴不増・IN-MAIN・popup0を確認。focus ringのスクリーンショット（e-open/e-escape/e-leaf-select/e-reselect）を保存。 |
| N007-03（V08） | 合格（V08aは記録扱い） | V08a: 重回帰の入力選択値（目的変数・説明変数の選択表示）と結果タイトルを記録。解析成功・結果値の証明ではない（Pyodide免除の範囲を明示し、成功数には含めない扱いを維持）。V08b: 実Menu往復（重回帰→因子分析→重回帰）で表示テキスト完全一致・pathname両方一致。V08c: PCP→コンジョイント→PCPをメニュークリック経路で往復し、svg・pathnameに加えてPCP軸要素ID・コンジョイント表示要素を記録。因子分析・コンジョイントの個別入力値変更までは実施していない。 |
| N007-04（V09・V10） | 合格（記録範囲を明示） | V09: TableでIRIS-001〜003を3件選択→メニュー経路PCP→Table往復で3件維持。三地点（Table・PCP・復帰後）で選択rowId集合を確認し、PCP滞在中のrowId（IRIS-001,002,003）を記録。中央状態バー（Variables 80/80・ウェイト未選択・Rows Scope・選択3行）の往復前後一致を確認。ウェイトは実操作で設定→クリアし、未選択への復元を確認。変数の個別値変更までは実施していない。V10: 全NaN列を含むn007_allnan（3行、allnan列のmissingCount=3/rowCount=3を列メタデータで証明）へ切替。切替前に旧datasetの選択3件・popup開放状態を作り、切替後に訪問済みTableを再訪して選択行0・可視nav-popup 0を確認。 |
| N007-05（V11） | 合格（記録範囲を明示） | V11: 拡大開始で可視nav-popup閉鎖・dialog開閉後にメニュー操作復旧。共通ヘッダ・右サイドバーの可視を確認。Exportボタンはhoverに加え、Licenseダイアログを実起動（開→閉）して共通操作の復旧を確認。Import/Save等の実起動までは実施していない。 |
| N007-06（V02・V12・タスク整合） | 解消 | B0/B0b: 6分類の開閉をaria-expanded＋可視popupで記録。起動記録は[run_n007_bootlog.txt](evidence/report008-resume/run_n007_bootlog.txt)に起動コマンド・時刻・URL/port・run ID・読込JS/CSS hashを保存。本報告の提出に合わせ、tasks/DAVIS-FEAT-036.mdの先頭状態・再開記録・段階表を残条件に合わせて更新する。S2/S3/S4を完了扱いにしない。失敗run（C2の判定式誤り、V08bの部分一致誤到達、E2のTab到達不可、E3/E5のevaluate構文誤り、B0bのJS内False誤記等）はスクリプト修正履歴として残る。 |
| N004-01（viz.css末尾空行） | 解消（維持） | `git diff --check` exit 0。機能変更なし。 |

## 結果サマリ

- run_all（20260918-194610）: TOTAL 34/34。[結果JSON](evidence/report008-resume/run_all_out/20260918-194610-results.json)
- run_state（20260918-194426）: TOTAL 9/9。[結果JSON](evidence/report008-resume/run_state_out/20260918-194426-results.json)
- 限定テスト: 24 passed / 0 failed。通常ビルド: exit 0。`git diff --check`: exit 0。

## 残事項・確認してほしい点

1. ブラウザ自体の200%拡大操作は未実施（deviceScaleFactor=2での相当確認のみ）。追加確認の要否を判断してほしい。
2. V08aは記録扱いであり、重回帰の解析成功・結果値・計算中状態の保持証明ではない。Pyodide免除の範囲として受入可能か確認してほしい。
3. V09の変数の個別値変更・ウェイト設定変更、V10の旧dataset入力・結果の事前作成の厳密化、V11のImport/Save等の実起動は未実施。今回の記録範囲で受入可能か、追加の証拠が必要か指示してほしい。
4. N007-06の独立した永続起動ログはrun_n007_bootlog.txtで保存した。内容で代替可能か、追加の証拠が必要か指示してほしい。

レビュー文書は編集していない。tasks/DAVIS-FEAT-036.mdとtasks/task-list.mdの更新は本報告のレビュー結果を受けて行う。
