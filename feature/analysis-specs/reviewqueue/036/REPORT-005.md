# Feature 036 実装報告005（REVIEW-004残条件の実ブラウザ検証）

日時: 2026-09-18 JST。対象レビュー: REVIEW-004。基点: master / 70cbfe44。最新ソースへのレビューOKは未取得。コミット・pushなし。

## ソース識別情報

N004-01対応としてviz.css末尾の余分な空行のみ除去。機能変更なし。SHA256はREVIEW-004採用値からviz.cssのみ変更。

| 対象 | SHA256 |
|---|---|
| AppShell.tsx | 61c12d3653fec4e0f545015408b1e447c18b865a83c7ab14e3c3acec3dfd8f3a |
| viz.css | 378aff2eb7921ae75b2449e2cf8777dd9c61868df006d4f41382e985b5997acd |
| appNavigation.test.tsx (untracked) | 968b902b74eac4a5b78f85e143faff09f8bddf799a6cd98e05e8b16cb7c70aa4 |
| dist index-CKY31PSW.js | 02781a79b145c01224d2c374ce80b9c7e1ecd647dad5615a768777cee32a0784 |
| dist index-ln5rxMhz.css | d0c199dc0be0016e315437985b11e4254f925e0fafcb3c0d39b576bbd806ab05 |

- `git diff --check -- fullstack/frontend/src/theme/viz.css fullstack/frontend/src/app/AppShell.tsx`: exit 0、警告なし（修正前はviz.css:133の末尾空行を報告）。
- 通常ビルド: `npm --prefix fullstack/frontend run build` exit 0。distはindex-CKY31PSW.js / index-ln5rxMhz.cssを再生成（CSSは空行除去のみでhash不変）。
- 配信照合: 本番8420の `/` が `assets/index-CKY31PSW.js` を参照し、取得内容がローカルdistと一致（curl確認）。
- 限定テスト: `npm --prefix fullstack/frontend test -- tests/appNavigation.test.tsx tests/keepAlive.test.tsx tests/topKSelectionKeepAlive.test.tsx` → 24 passed / 0 failed。
- 本報告のリンクはすべて `evidence/report005-resume/` からの相対参照であり、N001-05のリンク形式は維持する。

## 実ブラウザ検証の前提

- 対象URL: http://127.0.0.1:8420（run-production.bat経由の本番配信。起動serverId: f56af165-ba8d-4e46-a91e-a593020da541）。
- 読込bundle: 各runの前提条件ケースで `index-CKY31PSW.js` の読込を記録（A0/S0）。
- 可視タブ・非ゼロ幅を前提条件として記録。今回はすべてvisible/1440（または指定幅）で成立。
- 各ケース独立run ID・独立出力。メニュークリック経路のpathname＋現在地の両方検査で表示中ページを限定した。
- 試験スクリプトはREPORT-004と同一（[evidence/report004-resume/run_all.py](../036/evidence/report004-resume/run_all.py)、[evidence/report004-resume/run_state.py](../036/evidence/report004-resume/run_state.py)）。今回runの結果JSON・スクリーンショットは[evidence/report005-resume/](evidence/report005-resume/)に保存し、上書きしていない。

## 指摘別の検証結果

| 指摘 | 判定 | 証拠 |
|---|---|---|
| N001-01（低高overflow親の実スクロール・末尾到達） | 合格（条件付き、REPORT-004と同一条件） | C1: 1024幅で標準overflow発生（overflow_rest=1/visible=True、scrollW=clientW=680で横スクロールなし）。C2: overflow→次元削減→FAMDへ実クリック到達しpathname `/models/famd`＋現在地一致。popup内メニューのscrollH/clientH=48/48・224/224を記録。低高（高さ700）でscrollH>clientHの実スクロール発生は、C2の224pxメニューでは未発生。末尾機能「因子分析」自体のクリックはC6（狭幅）で実施。 |
| N001-02（全機能到達・狭幅・長ラベル・幅往復） | 合格 | B1: 全31機能のpathname＋現在地一致31/31。A4: メニュークリックでコンジョイント遷移。C3〜C6: 768幅で機能一覧ボタン→現在地分類を初期展開→別分類切替で同時1展開→末尾「因子分析」へ到達しパネル閉鎖。C7: 1440復帰で通常Menu復帰・popup残存0。B5: 同一機能再選択で履歴不増。B6: 戻るで追従。長ラベルは「混合データ因子分析（FAMD）」等の完全一致クリックで到達確認。 |
| N001-03（V08〜V11） | 合格（V08aは記録扱い） | V08b: 重回帰→因子分析→重回帰往復で表示テキスト完全一致。V08c: PCP→コンジョイント→PCPをメニュークリック経路で往復しsvg・pathname両方一致。V09: TableでIRIS-001〜003を3件選択→メニュー経路PCP→Table往復で3件維持（rowId表示一致）。V10: b06c_rank(36行)へ切替後に選択行0/active36/全36・現在地維持・可視nav-popup 0。V11: 拡大開始で可視nav-popup閉鎖・dialog開閉後にメニュー操作復旧。V08a（重回帰の実行結果）は記録のみで解析成功・結果値の証明ではない（Pyodide免除の範囲）。 |
| N001-04（実Tab・Escape・本文フォーカス） | 合格（通常幅のみ、REPORT-004と同一条件） | D1: 実Tabキー打鍵でIN-NAV到達。D2: Escapeでpopup閉鎖・フォーカスIN-NAV維持。D3: ArrowDown＋Enterで記述統計へ遷移しフォーカスIN-MAIN。body文字列の部分一致は不使用。overflow幅でのEscape復帰は未実施。 |
| N001-05（起動経路・失敗run証拠） | 部分 | ソース・ビルド・配信ハッシュと限定テストログは保存。起動serverId（f56af165-ba8d-4e46-a91e-a593020da541）とbundle照合を記録。独立した永続起動ログの保存は未完了。 |
| N004-01（viz.css末尾空行） | 解消 | `git diff --check` exit 0。機能変更なし、CSS hash不変。 |

## 結果サマリ

- run_all（20260918-135522）: TOTAL 21/21。[結果JSON](evidence/report005-resume/20260918-135522-results.json)
- run_state（20260918-135332）: TOTAL 9/9。[結果JSON](evidence/report005-resume/20260918-135332-results.json)
- 限定テスト: 24 passed / 0 failed。通常ビルド: exit 0。

## 残事項・確認してほしい点

1. N001-01の厳密条件（低高でscrollH>clientHが発生するpopupでの末尾葉到達）は今回も未発生のため、レビュー担当の判断を求める。
2. D2/D3のoverflow幅でのEscape・フォーカスは未実施。通常幅のみの合格であり、追加確認の要否を判断してほしい。
3. V08aは記録扱いであり、重回帰の解析成功・結果値・計算中状態の保持証明ではない。Pyodide免除の範囲として受入可能か確認してほしい。
4. N001-05の独立した永続起動ログの完全保存は未完了。起動serverIdとbundle照合の記録で代替可能か、追加の証拠が必要か指示してほしい。

レビュー文書は編集していない。tasks/DAVIS-FEAT-036.mdの更新は本報告のレビュー結果を受けて行う。
