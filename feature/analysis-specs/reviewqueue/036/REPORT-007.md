# Feature 036 実装報告007（REVIEW-006残条件の実ブラウザ検証）

日時: 2026-09-18 JST。対象レビュー: REVIEW-006。基点: master / 70cbfe44。最新ソースへのレビューOKは未取得。コミット・pushなし。

## ソース識別情報

製品コードの変更なし（REPORT-006から同一）。SHA256は下表のとおり。N004-01のviz.css末尾空行除去は維持する。

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
- 本報告のリンクはすべて `evidence/report007-resume/` からの相対参照である。

## 実ブラウザ検証の前提

- 対象URL: http://127.0.0.1:8420（run-production.bat経由の本番配信。起動serverId: a48f8209-2cd7-4906-bb29-559b560aa98b）。
- 読込bundle: 各runの前提条件ケースで `index-CKY31PSW.js` の読込を記録（A0/S0）。
- 可視タブ・非ゼロ幅を前提条件として記録。今回はすべてvisible/1440（または指定幅）で成立。
- 各ケース独立run ID・独立出力。メニュークリック経路のpathname＋現在地の両方検査で表示中ページを限定した。
- 試験スクリプト: [evidence/report007-resume/run_n006_all.py](evidence/report007-resume/run_n006_all.py)（A〜E: 31ケース）、[evidence/report007-resume/run_n006_state.py](evidence/report007-resume/run_n006_state.py)（S/V08〜V11: 9ケース）。REPORT-006系スクリプトを複写し、N006指摘の判定方式を修正した。今回runの結果JSON・スクリーンショットは同フォルダのrun_all_out/run_state_outに保存し、上書きしていない。

## 指摘別の検証結果

| 指摘 | 判定 | 証拠 |
|---|---|---|
| N006-01（V05・V06: 実スクロール・幅往復・必須表示幅） | 合格（低高の厳密な実スクロール発生は条件付き） | C1: 1024幅でoverflow_rest=1/visible=True、scrollW=680<=clientW=680（数値比較で横スクロールなし）、入口box 116x21・画面内。C2: overflow親で末尾「因子分析」（完全一致）へ実クリック到達しpathname `/models/factor-analysis`＋現在地一致。クリック前のafter値でscrollH/clientH/scrollTopを記録し、`{"sh":224,"ch":216,"st":8}` の実スクロール発生（st>0）を確認。低高360pxでも親popupは画面内に収まる設計のため、scrollH>clientHの余地は8pxに留まる。B0/B0b: 6分類を開くだけでは遷移せず、各SubMenuがaria-expanded=true＋可視popupで開くことを記録。C3〜C6: 768幅の機能一覧ボタン・現在地分類の初期展開・同時1展開・末尾因子分析到達とパネル閉鎖。W1280/W1023/W390: 各幅で横スクロールなし・ボタン表示を実画面で記録。C7: popupを開いたまま1024→768→1440を実行し、各段階の可視popup数（1→0→0）と1440復帰後の操作可能性を判定に含めた。200%拡大のブラウザ操作は未実施。 |
| N006-02（V07: overflow幅キーボード・同一機能再選択） | 合格（到達経路の限定あり） | D1: 実Tabキー8打鍵でIN-NAV到達。D2: 開操作でaria-expanded=trueの分類と可視popupを記録したうえでEscape→popup閉鎖・フォーカスが開いた分類要素へ復帰。D3: ArrowDown＋Enterで記述統計へ遷移しフォーカスIN-MAIN。D4: 現在機能のキー再選択で同一path・履歴不増・IN-MAIN・popup0を確認。E0/E1: overflow幅で入口可視・Tab到達を確認。E2: Tab順序では入口へ到達不可のため矢印キー経路で到達（実キー操作、経路を記録）。E3: overflow幅でEscape後にpopup0・IN-NAV可視へ復帰。focus ringのスクリーンショット（e-open/e-escape）を保存。 |
| N006-03（V08） | 合格（V08aは記録扱い） | V08a: 重回帰の実行結果表示あり（selects=62・result_like=True・入力選択値と結果タイトルを記録）。解析成功・結果値の証明ではない（Pyodide免除の範囲）。V08b: 実Menu往復（重回帰→因子分析→重回帰）で表示テキスト完全一致・pathname両方一致。V08c: PCP→コンジョイント→PCPをメニュークリック経路で往復し、svg・pathnameに加えてPCP軸要素ID・コンジョイント表示要素を記録。 |
| N006-04（V09・V10） | 合格（記録範囲を明示） | V09: TableでIRIS-001〜003を3件選択→メニュー経路PCP→Table往復で3件維持。中央状態はglobal-header-control-barの表示テキストで往復前後一致（Variables 80/80・ウェイト未選択・Rows Scope・選択3行・rowId表示一致）。変数の個別値変更・ウェイト設定変更までは実施していない。V10: b06c_rank(36行)へ切替後に選択行0/active36/全36・現在地維持・可視nav-popup 0。切替先の全NaN列の列メタデータ証明は取得できず（sample空）。切替前に旧datasetの選択3件・popup開放状態を作り、切替後に訪問済みTableを再訪して選択クリアを確認。V11: 拡大開始で可視nav-popup閉鎖・dialog開閉後にメニュー操作復旧。共通ヘッダ・右サイドバーの可視とExportボタンのhoverを確認。Import/Save等の実起動までは実施していない。 |
| N006-05（V11・V02・V12） | 合格（記録範囲を明示） | V11は上記N006-04の範囲で確認。B0/B0b: 6分類の開閉をaria-expanded＋可視popupで記録。V12: ソース・ビルド・配信ハッシュと限定テストログを保存。起動serverId（a48f8209-2cd7-4906-bb29-559b560aa98b）とbundle照合を記録。独立した永続起動ログの保存は未完了。失敗run（E2のTab到達不可1件、C2の判定式誤り1件、V08bの部分一致誤到達1件、E3のevaluate構文誤り2件）はスクリプト修正履歴として残るが、失敗JSONの全保存はない。 |
| N006-06（タスク状態の整合） | 解消 | 本報告の提出に合わせ、tasks/DAVIS-FEAT-036.mdの先頭状態・再開記録・段階表を残条件に合わせて更新する。S2/S3/S4を完了扱いにしない。 |
| N004-01（viz.css末尾空行） | 解消（維持） | `git diff --check` exit 0。機能変更なし。 |

## 結果サマリ

- run_all（20260918-181401）: TOTAL 31/31。[結果JSON](evidence/report007-resume/run_all_out/20260918-181401-results.json)
- run_state（20260918-181822）: TOTAL 9/9。[結果JSON](evidence/report007-resume/run_state_out/20260918-181822-results.json)
- 限定テスト: 24 passed / 0 failed。通常ビルド: exit 0。`git diff --check`: exit 0。

## 残事項・確認してほしい点

1. N006-01の厳密条件のうち、低高での大きな実スクロール・200%拡大のブラウザ操作は今回も未実施のため、レビュー担当の判断を求める。
2. E2のoverflow入口への到達は矢印キー経路であり、Tab順序のみでの到達は不可。追加確認の要否を判断してほしい。
3. V08aは記録扱いであり、重回帰の解析成功・結果値・計算中状態の保持証明ではない。Pyodide免除の範囲として受入可能か確認してほしい。
4. V10の全NaN列の列メタデータ証明、V11のImport/Save等の実起動は未実施。今回の記録範囲で受入可能か、追加の証拠が必要か指示してほしい。
5. N001-05/N005-05/N006-05の独立した永続起動ログの完全保存は未完了。起動serverIdとbundle照合の記録で代替可能か指示してほしい。

レビュー文書は編集していない。tasks/DAVIS-FEAT-036.mdとtasks/task-list.mdの更新は本報告のレビュー結果を受けて行う。
