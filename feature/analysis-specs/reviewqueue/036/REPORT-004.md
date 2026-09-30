# Feature 036 実装報告004（N001-01〜04残条件の実ブラウザ検証）

日時: 2026-09-18 JST。対象レビュー: REVIEW-003。基点: master / 70cbfe44。最新ソースへのレビューOKは未取得。コミット・pushなし。

## ソース識別情報

製品コードの変更なし（REPORT-003から同一）。SHA256はREVIEW-003採用値と一致する。

| 対象 | SHA256 |
|---|---|
| AppShell.tsx | 61c12d3653fec4e0f545015408b1e447c18b865a83c7ab14e3c3acec3dfd8f3a |
| viz.css | 1545f863af6ca3ddeca7239f09f5087440665017d7a511eb410b1ce133fa58db |
| appNavigation.test.tsx (untracked) | 968b902b74eac4a5b78f85e143faff09f8bddf799a6cd98e05e8b16cb7c70aa4 |
| dist index-CKY31PSW.js | 02781a79b145c01224d2c374ce80b9c7e1ecd647dad5615a768777cee32a0784 |
| dist index-ln5rxMhz.css | d0c199dc0be0016e315437985b11e4254f925e0fafcb3c0d39b576bbd806ab05 |

- 通常ビルド: `npm --prefix fullstack/frontend run build` exit 0（2026-09-18実施、index-CKY31PSW.js再生成確認）。
- 配信照合: 本番8420の `/` が `assets/index-CKY31PSW.js` / `assets/index-ln5rxMhz.css` を参照し、両assetの取得内容がローカルdistと一致（curl確認）。
- 限定テスト: `npm --prefix fullstack/frontend test -- tests/appNavigation.test.tsx tests/keepAlive.test.tsx tests/topKSelectionKeepAlive.test.tsx` → 24 passed / 0 failed。

## 実ブラウザ検証の前提

- 対象URL: http://127.0.0.1:8420（run-production.bat経由の本番配信。起動serverId: 1f6fc590-249f-4047-87a3-f4c75eebad85）。
- 読込bundle: 各runの前提条件ケースで `index-CKY31PSW.js` の読込を記録（A0/S0）。
- 可視タブ・非ゼロ幅を前提条件として記録。満たさなければ未実施で止める方針で実施し、今回はすべてvisible/1440（または指定幅）で成立。
- 各ケース独立run ID・独立出力。表示中ページはdata-tab-path/data-tab-activeで限定する方針は、メニュークリック経路のpathname＋現在地の両方検査で代替した。
- 試験スクリプト: [evidence/report004-resume/run_all.py](evidence/report004-resume/run_all.py)（A〜D: 21ケース）、[evidence/report004-resume/run_state.py](evidence/report004-resume/run_state.py)（S/V08〜V11: 9ケース）。

## 指摘別の検証結果

| 指摘 | 判定 | 証拠 |
|---|---|---|
| N001-01（低高overflow親の実スクロール・末尾到達） | 合格（条件付き） | C2: 1024幅で標準overflow発生（overflow_rest=1/visible=True、scrollW=clientW=680で横スクロールなし）。overflow→次元削減→FAMDへ実クリック到達しpathname `/models/famd`＋現在地一致。popup内2メニューのscrollH/clientH=48/48・224/224を記録。ただし末尾機能「因子分析」自体のクリックはC6（狭幅）で実施し、低高overflow親での末尾葉クリックはFAMD（5葉中4番目）までの到達である。低高（例: 高さ700）でscrollH>clientHの実スクロール発生は、C2の224pxメニューでは未発生。 |
| N001-02（全機能到達・狭幅・長ラベル・幅往復） | 合格 | B1: 全31機能のpathname＋現在地一致31/31。A4: メニュークリックでコンジョイント遷移。C3〜C6: 768幅で機能一覧ボタン→現在地分類（次元削減）を初期展開→別分類（可視化）切替で同時1展開→末尾「因子分析」へ到達しパネル閉鎖。C7: 1440復帰で通常Menu復帰・popup残存0。B5: 同一機能再選択で履歴不増（38→38）。B6: 戻るで追従。長ラベルは「混合データ因子分析（FAMD）」等の完全一致クリックで到達確認。スクリーンショット: c-1024/c-overflow/c-768/c-narrow-panel/c-narrow-dim等。 |
| N001-03（V08〜V11） | 合格（V08aは記録扱い） | V08b: 重回帰→因子分析→重回帰往復で表示テキスト完全一致（177字）。V08c: PCP→コンジョイント→PCPをメニュークリック経路で往復しsvg 39→53・pathname両方一致。V09: TableでIRIS-001〜003を3件選択→メニュー経路PCP→Table往復で3件維持（rowId表示一致）。V10: b06c_rank(36行)へ切替後に選択行0/active36/全36・現在地維持・可視nav-popup 0（残骸3ノードは0x0 hidden）。V11: 拡大開始で可視nav-popup 1→0・dialog開→戻すで閉→メニュー操作復旧。V08a（重回帰の実行結果）はselects=62・result_like=Trueの記録のみで、解析成功・結果値の証明ではない（Pyodide免除の範囲）。 |
| N001-04（実Tab・Escape・本文フォーカス） | 合格 | D1: 実Tabキー4〜8打鍵でIN-NAV到達。D2: Escapeでpopup閉鎖（0→0）・フォーカスIN-NAV維持（データ・概要）。D3: ArrowDown×6＋Enterで記述統計へ遷移（/statistics）しフォーカスIN-MAIN。body文字列の部分一致は不使用。overflow幅でのEscape復帰は未実施（通常幅のみ）。 |
| N001-05（起動経路・失敗run証拠） | 部分 | ソース・ビルド・配信ハッシュと限定テストログは保存。起動serverIdとbundle照合を記録。本runの失敗run（B1のdiscriminantタイムアウト1件、C5の判定方式誤り、V09のチェックボックス選択子誤り、V10のoption特定・切替確定方式の試行錯誤、V11のdialog方式特定）はスクリプト修正履歴としてrun_state.py/run_all.pyに残るが、失敗JSONの全保存はない。独立した永続起動ログの保存は未完了。 |

## 結果サマリ

- run_all（20260918-130038）: TOTAL 21/21。[結果JSON](evidence/report004-resume/20260918-130038-results.json)
- run_state（20260918-125911）: TOTAL 9/9。[結果JSON](evidence/report004-resume/20260918-125911-results.json)
- 限定テスト: 24 passed / 0 failed。通常ビルド: exit 0。

## 残事項・確認してほしい点

1. N001-01の厳密条件（低高でscrollH>clientHが発生するpopupでの末尾葉到達）は、今回の高さ700・224pxメニューでは未発生のため、レビュー担当の判断を求める。必要なら高さをさらに縮めた条件での追加runを実施する。
2. D2/D3のoverflow幅でのEscape・フォーカスは未実施。通常幅のみの合格であり、overflow幅での追加確認の要否を判断してほしい。
3. V08aは記録扱いであり、重回帰の解析成功・結果値・計算中状態の保持証明ではない。Pyodide免除の範囲として受入可能か確認してほしい。
4. N001-05の独立した永続起動ログ・初回失敗runの完全保存は未完了。今回のスクリプト修正履歴で代替可能か、追加の証拠が必要か指示してほしい。
5. レビュー監視タイマーは未設定。本報告は承認依頼ではなく、REVIEW-003残条件の検証記録として提出する。

レビュー文書は編集していない。tasks/DAVIS-FEAT-036.mdとtasks/task-list.mdの更新は本報告のレビュー結果を受けて行う。
