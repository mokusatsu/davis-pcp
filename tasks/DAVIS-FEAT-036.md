# DAVIS-FEAT-036

状態: レビュー指摘対応中・レビュー待ち（REPORT-009提出。REVIEW-008残条件を再検証 zoom 5/5・viewport 4/4・run_state 14/14・限定24件・通常ビルド成功。製品コード変更なし、コミット・pushなし）

再開記録: [REPORT-009](../feature/analysis-specs/reviewqueue/036/REPORT-009.md)。2026-09-18、REVIEW-008確認済み。N008指摘の判定方式を修正した新規runで再検証し、証拠はreport009-resume/に独立保存した。V08aは成功数から除外、Pyodide数値検証は免除、製品既知の挙動（multiple選択表示・サイドバー二重性）はREPORT-009に明記。レビュー監視タイマーは継続中（Cron 87c06d08）。

## 目的と正本

31機能を6つのMenu／SubMenuへ整理し、現在地と到達性を保ちながらヘッダを縮小する。

- [詳細設計・全機能対応表・検証計画](../feature/36_header_navigation_design.md)
- [設計記録](DAVIS-FEAT-036-DESIGN.md)
- [実装・検証・30分間隔レビュー対応プロンプト](../feature/36_header_navigation_implementation_prompt.md)

実装プロンプトには通常ビルド・本番起動確認とreviewqueue/036でのレビュー対応を含む。プロンプト実行時に適用し、この文書の作成・保存だけでは実装やタイマーを開始しない。

## 変更範囲

AppShellのナビゲーション定義、Menu表示、現在地、開閉、狭幅表示、フォーカス連携、必要な局所CSSと限定テスト。main／KeepAlive／共通操作はルート照合・状態保持の回帰対象とする。

## 禁止事項

分析計算・API・選択の意味・URL・画面ライフサイクルの変更、無関係な既存差分の上書き、機能削除、新規依存関係、独自メニュー基盤、実装前の巨大な全体テスト、未指示のビルド・コミット・push。

## 開始条件

実装指示後にbranch／HEAD／git statusと編集対象の既存差分を記録する。Feature 035とAppShellを同時編集しない担当範囲を確定する。コーディングはAGENTS.mdの委譲規則に従う。

## 段階と状態

| 段階 | 内容 | 状態 |
|---|---|---|
| S0 | 基準・ルート・既存差分確認 | 完了（.temp/header-navigation/baseline-*に記録済み） |
| S1 | 通常Menu／SubMenu・現在地・URL連動 | 完了（単体テスト・実ブラウザ検証合格） |
| S2 | 狭幅inline・overflow・キーボード | レビュー指摘対応中（REPORT-008で実ホイール・W1023/W390到達・E2〜E5採用済み。REPORT-009で200%拡大相当を追加検証: zoom 5/5・viewport 4/4） |
| S3 | KeepAlive・中央選択・dataset・拡大・共通操作回帰 | レビュー指摘対応中（run_state 14/14・V08a除外: V08b重回帰入力変更往復一致・V08cコンジョイント往復・V09ウェイト/変数/行範囲変更保持・V10旧状態消滅+全NaN証明・V11 Export/Save/Import/License実起動。Pyodide数値検証は免除） |
| S4 | 指示に基づくビルド・本番起動・証拠更新 | レビュー指摘対応中（通常ビルドexit 0→8420配信bundle一致確認→zoom 5/5・viewport 4/4・run_state 14/14・限定24件。証拠はreviewqueue/036/evidence/report009-resume/。完全起動ログはrun_n009_bootlog.txt） |

## 完了条件・検証

詳細設計V01〜V12の各項目へ合否と証拠を記録する。限定テスト、実ブラウザ、本番起動を区別する。全31機能へ到達でき、ナビに横スクロールがなく、画面移動で分析・入力・中央状態が失われないことを確認する。

run-production.batが提供するdistに最新変更が反映されていることを必須の提供確認とする。ビルド指示がない場合はV12を未実施とし、製品改修を完了扱いにしない。staticのルーター検証とstatic配布物の検証も区別する。

## 停止条件・残事項

分析／データ契約の変更、互換設計、編集競合が必要な場合は該当変更を止め、理由と影響を示す。ビルドや環境の制約による未実施ゲートは明示する。他タスクの状態を変更しない。

## レビュー確認記録（30分間隔タイマー：Cron 87c06d08、監視先 feature/analysis-specs/reviewqueue/036/）

- 2026-09-18 12:53 JSTに監視フォルダを確認。REVIEW-003.md（2026-09-18 00:10、判定：承認保留）、REPORT-003.md（同 01:35）の2件が処理済み以降の新規文書として存在する。前回REPORT-003提出後に追加されたレビュー文書はなし。レビュー担当の明示的な「レビューOK」は未取得。タイマーは継続する。
- 2026-09-18 13:08 JSTに監視フォルダを再確認。REVIEW-004.md（2026-09-18 12:59、判定：承認保留）、REPORT-004.md（同 13:04）の2件が新規文書として存在する。REVIEW-004はREPORT-003のキーボード再選択修正を採用する一方、N001-01〜04の実ブラウザ残条件およびN004-01（viz.css末尾空行）を残指摘として継続する。レビュー担当の明示的な「レビューOK」は未取得。タイマーは継続する。
- 2026-09-18 13:48 JSTに監視フォルダを確認。前回確認（13:08）以降の新規・更新レビュー文書はなし（REVIEW-004.md 12:59・REPORT-004.md 13:04が最新）。判定は承認保留のまま。レビュー担当の明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。
- 2026-09-18 14:08 JSTに監視フォルダを確認。前回確認（13:48）以降の新規レビュー文書はなし（REVIEW-004.md 12:59が最新レビュー、判定：承認保留）。REPORT-005.md（14:00）は本セッションの対応報告であり、レビュー担当の文書ではない。明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。
- 2026-09-18 16:32 JSTに監視フォルダを確認。REVIEW-005.md（2026-09-18 14:29、判定：承認保留）が新規レビュー文書として存在する。N001系の残指摘をN005-01〜06へ具体化し、V05〜V12の実ブラウザ受入不足を継続指摘する。明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。
- 2026-09-18 17:22 JSTに監視フォルダを確認。前回確認（16:32）以降の新規レビュー文書はなし（REVIEW-005.md 14:29が最新レビュー、判定：承認保留）。REPORT-006.md（16:51）は本セッションの対応報告であり、レビュー担当の文書ではない。明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。
- 2026-09-18 17:27 JSTに監視フォルダを確認。REVIEW-006.md（2026-09-18 17:25、判定：承認保留）が新規レビュー文書として存在する。REPORT-006の条件付き合格を認めず、残指摘をN006-01〜06へ具体化（V05〜V12実ブラウザ受入・タスク状態整合）。明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。
- 2026-09-18 18:22 JSTに監視フォルダを確認。前回確認（17:27）以降の新規レビュー文書はなし（REVIEW-006.md 17:25が最新レビュー、判定：承認保留）。REPORT-007.md（18:20）は本セッションの対応報告であり、レビュー担当の文書ではない。明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。
- 2026-09-18 19:52 JSTに監視フォルダを確認。前回確認（18:22）以降の新規レビュー文書はなし（REVIEW-007.md 18:25が最新レビュー、判定：承認保留）。REPORT-008.md（19:50）は本セッションの対応報告であり、レビュー担当の文書ではない。明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。
- 2026-09-18 20:48 JSTに監視フォルダを確認。前回確認（19:52）以降の新規レビュー文書はなし（REVIEW-007.md 18:25が最新レビュー、判定：承認保留）。REPORT-008.md（19:50）は本セッションの対応報告であり、レビュー担当の文書ではない。明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。
- 2026-09-18 22:25 JSTに監視フォルダを確認。REVIEW-008.md（2026-09-18、判定：承認保留）が新規レビュー文書として存在する。REPORT-008の条件付き合格を認めず、残指摘をN008-01〜05へ具体化（実ブラウザ200%拡大・V08読替え禁止・V09変更保持・V10旧状態/V11共通操作・V12起動ログとタスク整合）。明示的な「レビューOK」は未取得。タイマー（Cron 87c06d08）は継続する。

## 実施記録

- 2026-09-18: REVIEW-008残条件を再検証し、[REPORT-009](../feature/analysis-specs/reviewqueue/036/REPORT-009.md)を提出。製品コード変更なし。
  - run_zoom（本番8420・index-CKY31PSW.js、20260918-212447）: 5/5 PASS（CDP setPageScaleFactor=2.0の実Chromium headed拡大。scale==2記録・末尾葉到達・横スクロールなし・重なりなし・解除復旧）。
  - run_zoom_viewport（20260918-212339）: 4/4 PASS（640 CSS px相当・DPR1・deviceScaleFactor不使用。到達・横スクロールなし・重なりなし）。
  - run_state（20260918-221755）: 14/14 PASS（V08a除外。V08b重回帰入力変更往復一致・V08cコンジョイント往復・V09ウェイト/変数/行範囲変更保持・V10旧状態消滅・V11共通操作実起動）。
  - 限定テスト24件・通常ビルドexit 0・`git diff --check` exit 0。証拠: reviewqueue/036/evidence/report009-resume/（独立保存）。
  - 残事項: Pyodide数値検証の免除、既知の製品挙動（multiple選択表示・サイドバー二重性）はレビュー判断待ち。レビューOK未取得、タイマー継続中。
- 2026-09-18: REVIEW-007残条件を再検証し、[REPORT-008](../feature/analysis-specs/reviewqueue/036/REPORT-008.md)を提出。製品コード変更なし。
  - run_all（本番8420・index-CKY31PSW.js、20260918-194610）: 34/34 PASS（N007指摘の判定方式修正版。実ホイール・W1023/W390到達・W1280Z・E4/E5・B0b開閉）。
  - run_state（20260918-194426）: 9/9 PASS（V08a記録・V08b実Menu往復一致・V09三地点中央状態・V10全NaN証明・V11 License実起動）。
  - 限定テスト24件・通常ビルドexit 0・`git diff --check` exit 0。証拠: reviewqueue/036/evidence/report008-resume/（独立保存）。
  - 残事項: 200%拡大のブラウザ操作・V08a・変数個別変更・Import/Save実起動はレビュー判断待ち。レビューOK未取得、タイマー継続中。
- 2026-09-18: REVIEW-006残条件を再検証し、[REPORT-007](../feature/analysis-specs/reviewqueue/036/REPORT-007.md)を提出。製品コード変更なし。
  - run_all（本番8420・index-CKY31PSW.js、20260918-181401）: 31/31 PASS（N006指摘の判定方式修正版。C1数値比較・C2実スクロールst>0・B0/B0b開閉・W1280/1023/390・C7幅往復・D2要素単位復帰・D4再選択・E2矢印経路/E3復帰）。
  - run_state（20260918-181822）: 9/9 PASS（V08a記録・V08b実Menu往復一致・V08c軸要素・V09中央状態値一致・V10切替後クリア・V11共通操作復旧確認）。
  - 限定テスト24件・通常ビルドexit 0・`git diff --check` exit 0。証拠: reviewqueue/036/evidence/report007-resume/（独立保存）。
  - 残事項: 低高厳密条件の一部・200%拡大・V08a・全NaN証明・Import/Save実起動・独立起動ログはレビュー判断待ち。レビューOK未取得、タイマー継続中。
- 2026-09-18: REVIEW-005残条件を再検証し、[REPORT-006](../feature/analysis-specs/reviewqueue/036/REPORT-006.md)を提出。viz.css末尾空行除去のみ維持（機能変更なし）。
  - run_all（本番8420・index-CKY31PSW.js、20260918-164244）: 22/22 PASS（N005指摘の判定方式修正版。C1数値比較・C2末尾因子分析・B0の6分類開閉・D2要素単位復帰）。
  - run_state（20260918-164848）: 9/9 PASS（V08a記録・V09中央状態値一致・V10切替後クリア・V11共通操作復旧確認）。
  - 限定テスト24件・通常ビルドexit 0・`git diff --check` exit 0。証拠: reviewqueue/036/evidence/report006-resume/（独立保存）。
  - 残事項: 低高厳密条件・1280/200%/390・overflow幅Escape・V08a・全NaN証明・Import/Save実起動・独立起動ログはレビュー判断待ち。レビューOK未取得、タイマー継続中。
- 2026-09-18: REVIEW-004残条件を再検証し、[REPORT-005](../feature/analysis-specs/reviewqueue/036/REPORT-005.md)を提出。N004-01のviz.css末尾空行のみ除去（機能変更なし、CSS hash不変）。
  - run_all（本番8420・index-CKY31PSW.js、20260918-135522）: 21/21 PASS。run_state（20260918-135332）: 9/9 PASS。
  - 限定テスト24件・通常ビルドexit 0・`git diff --check` exit 0。証拠: reviewqueue/036/evidence/report005-resume/（独立保存）。
  - 残事項: 低高実スクロール厳密条件・overflow幅Escape等の要否、V08aの扱い、独立起動ログはレビュー判断待ち。レビューOK未取得、タイマー継続中。
- 2026-09-18: REVIEW-003残条件を実ブラウザで再検証し、[REPORT-004](../feature/analysis-specs/reviewqueue/036/REPORT-004.md)を提出。製品コード変更なし。
  - run_all（本番8420・index-CKY31PSW.js）: 21/21 PASS（全31機能pathname＋現在地一致、overflow経由FAMD到達、狭幅単一展開・末尾因子分析到達、実Tab/Escape/本文フォーカス）。
  - run_state: 9/9 PASS（重回帰往復表示一致、PCP往復描画維持、選択3件維持、b06c_rank切替後選択クリア、拡大popup閉鎖復旧）。
  - 限定テスト24件・通常ビルドexit 0。証拠: reviewqueue/036/evidence/report004-resume/。
  - 残事項: 低高実スクロール厳密条件・overflow幅Escape等の要否、V08aの扱い、独立起動ログはレビュー判断待ち。レビューOK未取得、タイマー未設定。
- 2026-09-17: 実装・検証を実施（REPORT-001を[reviewqueue/036](../feature/analysis-specs/reviewqueue/036/REPORT.md)へ提出）。
  - 変更: AppShell.tsx（2段Segmented→6分類Menu/SubMenu）、viz.css（ナビ限定CSS）、tests/appNavigation.test.tsx（新規22件）。
  - 限定テスト: 22 passed / 0 failed（appNavigation＋keepAlive＋topKSelectionKeepAlive）。
  - 通常ビルド: exit 0。dist= index-C6wkSuw9.js。
  - 実ブラウザ（8420配信、Playwright）: 29/29 PASS（幅別表示・全分類遷移・URL正規化・履歴・キーボード・狭幅単一展開・Escape・フォーカス）。
  - 本番起動確認: 既存8420プロセス（PID 15320）を停止のうえ、run-production.bat経由で新規起動。新プロセスが同一bundle（index-C6wkSuw9.js）を配信し、検証スクリプトも29/29 PASS。
  - 未実施: V06実幅overflow全項目、V08実画面往復、V09選択往復照合、V10旧dataset残存、V11拡大中実画面。
  - 証拠: .temp/header-navigation/（verify_nav_8420.json／各ログ／スクリーンショット）。
