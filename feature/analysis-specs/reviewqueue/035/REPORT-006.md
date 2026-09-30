# Feature 035 結果報告書（修正版 REPORT-006）

- Feature番号: 035（35→35a→35bの連続工程）
- 報告版: REPORT-006.md（最新版）
- 日時: 2026-09-15
- branch: master
- HEAD: 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31
- 状態: 実装・検証済み／レビュー待ち（レビューOKは自己宣言しない）
- snapshot: `feature/audit-log/graph-expansion/source-hashes-6.txt`
- 前版: REPORT-005.md、REPORT-004.md、REPORT-003.md、REPORT-002.md、REPORT.md（初版）
- 対応レビュー: REVIEW-004.md（対応報告は REVIEW-004-REPLY.md）、REVIEW-001〜003.md（対応済み）

## REVIEW-004 への対応概要

F004-01〜04を修正・再検証済み。F004-05はG50完了・G51未実施、その他は未完了明記。詳細は REVIEW-004-REPLY.md を参照。

- F004-01：PcpPlotViewport を新設し実 viewport を子経由で取得。DPR2・400%で期待値一致。
- F004-02：popup container を拡大対象のみ dialog へ。通常時は body へ戻す。
- F004-03：フィット再押下でも原点復帰。論理中心の前後比較で保持を確認。
- F004-04：座標系変更中のドラッグは dispatch せず取消し。次操作の成功を確認。
- F004-05：G16は136/136一致、G20は中央小矩形5/5一致、G50は入力保持確認、G51は欠損条件不足で未実施。

## 再テスト・再build結果

- `npx tsc --noEmit`：成功
- `npm run test`：63ファイル259テスト全合格
- 実ブラウザ（5181）：`review4-repro.json` 6/6、`f004-05.json` G16合格、`f004-05c` G20合格、`g50-test` 合格
- `npm run build` 成功（8.25秒）。bundle `dist/assets/index-CKYTDeKO.js`（2,184,278 bytes、sha256 `90f34518e55b92d6fa3905fb705613f97f8d2e784d5b7095ab8b0ddf25347335`、build 2026-09-15 11:11 JST）
- `http://127.0.0.1:8420/` が同bundleを200・同サイズ配信。本番で拡大・fit-minus 75%・menu in-dialog を確認

## G・X・Vへの影響

- G・X判定の枠組みに変更なし。G20 は通常表示の縮小バグ修正に伴い中央一致で合格条件を満たす。
- V07は取消し条件を実装・確認済み。V10は二段階Escape・起点復帰を確認（focus=BODYの記録は起点ボタン復帰の厳密確認が残る）。V11はG50完了・G51未実施。V12はDPR2・400%を確認、ブラウザ125%・リサイズ・画質官能は未実施。

## 未完了として残す項目

- G51（V11）：Irisに欠損列なしのため未実施
- V12のブラウザ125%・画面リサイズ・画質官能確認：未実施
- Select等残るpopup種別の全種実操作・全G行の結果生成：未完了
- テスト完了の偽装はしない
