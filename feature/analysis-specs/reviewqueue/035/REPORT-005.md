# Feature 035 結果報告書（修正版 REPORT-005・最新版は REPORT-006.md を参照）

- Feature番号: 035（35→35a→35bの連続工程）
- 報告版: REPORT-005.md（最新版）
- 日時: 2026-09-15
- branch: master
- HEAD: 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31
- 状態: 実装・検証済み／レビュー待ち（レビューOKは自己宣言しない）
- snapshot: `feature/audit-log/graph-expansion/source-hashes-5.txt`
- 前版: REPORT-004.md（PCP振動）、REPORT-003.md（PCP領域）、REPORT-002.md（二重スクロール）、REPORT.md（初版）
- 対応レビュー: REVIEW-001.md、REVIEW-002.md、REVIEW-003.md（対応報告は REVIEW-001-REPLY.md 等）

## REVIEW-001/002/003 への対応概要

R035-01〜06 のすべてに修正・実ブラウザ再検証・再build・本番確認を実施した。詳細は REVIEW-001-REPLY.md を参照。

- R035-01：Canvas を sticky に戻し、scroll/scale 換算で SVG と原点一致。maxWidth 制限・2px縮小を取り消し。
- R035-02：dialog 内 popup 受け口へ接続（PCP・Bar・Loess・Biplot・QQPlot）。close イベント受信処理を新設し、可視性判定で Escape 二段階を回復。
- R035-03：フィット縮小を75%に修正（75%→50%も確認）。
- R035-04：実 viewport の保存・復元・中央保持・フィット原点を実装。
- R035-05：PCP バッファを frameSize×viewScale×dpr に修正（子Providerから正しく取得）。
- R035-06：V07/V10/V11/V12/V08・G16/G20・StrictMode試験を実測で確定。V11等の一部残りは明記。

## 再テスト・再build結果

- `npx tsc --noEmit`：成功
- `npm run test`：63ファイル259テスト全合格
- 実ブラウザ（5181）：`review-repro2.json` 9/9、`r01-coords.json` 3/3、`review-final.json` 11/11、`r06-rerun.json` は V07/V10/V12/DPR を合格、V11・V08計測条件を切り分け
- G16実行後136件、G20小矩形一致を確認
- `npm run build` 成功（8.18秒）。bundle `dist/assets/index-BBSGnmrA.js`（2,182,485 bytes、sha256 `d24459c2deedb92894a8e4cb4a2d45a5978dc922b1340225d1d84b4a3a3b0475`、build 2026-09-15 10:17 JST）
- `http://127.0.0.1:8420/` が同bundleを200・同サイズ配信。本番で拡大・fit-minus 75%・menu in-dialog を確認

## G・X・Vへの影響

- G・X判定の枠組みに変更なし。G16/G20 は条件付き合格として確定記録へ更新する。
- V07・V10・V12 は限定付きで合格、V11・V12一部・V07厳密化は未完了として明記。テスト完了の偽装はしない。

## 未完了として残す項目

- V11（G50/G51入力保持実操作）：Irisに欠損列なしのため未実施
- V12のブラウザ125%・画面リサイズ・画質官能確認：未実施
- V07の選択dispatch抑止の厳密化：矩形・capture掃除は確認、dispatch抑止は未対応として明記
