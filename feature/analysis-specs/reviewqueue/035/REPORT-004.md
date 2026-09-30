# Feature 035 結果報告書（修正版 REPORT-004・最新版は REPORT-005.md を参照）

- Feature番号: 035（35→35a→35bの連続工程）
- 報告版: REPORT-004.md（最新版）
- 日時: 2026-09-15 01:35 JST
- branch: master
- HEAD: 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31
- 状態: 実装・検証済み／レビュー待ち（レビューOKは自己宣言しない）
- snapshot: `feature/audit-log/graph-expansion/source-hashes-4.txt`
- 前版: REPORT-003.md（PCP領域回復・SVG幅追従）、REPORT-002.md（2重スクロール解消）、REPORT.md（初版）

## 今回の修正内容と理由

最大化時にPCP全体が縦横で拡縮を繰り返す振動の指摘を受け、原因を特定し修正した。headlessでの200フレーム追跡では直接の振動は再現しなかったが、最大化サイズで1pxオーバーフロー（viewport scroll 1625×771 対 client 1624×770）が残存していることを突き止めた。スクロールバー出現→ResizeObserver計測→frameSize更新→再描画→寸法変化のフィードバックが振動の経路となる。

### 原因

1. plot-frame の border 2px 分だけ内容（plot-canvas-area・canvas）がはみ出し、viewport にスクロールバーが出る
2. 共通 viewport の ResizeObserver がそれを検知して frameSize を更新し、再描画で寸法が変わる
3. 特に最大化時は小数pxの切り上げも重なり、バー出現・消滅を繰り返す

### 変更ファイル

- `features/pcp/PcpPage.tsx` のみ
  - canvas の CSS 寸法を `width/height − 2px` にし、frame の border 内に収める（描画バッファ自体はフル寸法、論理寸法不変）
  - canvas を `sticky` から `absolute` 配置へ変更し、レイアウトへの寄与をなくす（重なり順・座標変換は維持）
  - plot-canvas-area に `maxWidth:100%` を追加（幅方向のはみ出し止め）

選択・集計・API・色分けの仕様変更なし。サンプルや表示対象の削減なし。

## 再テスト・再build結果

- `npx tsc --noEmit`：成功
- PCP関連unit 4ファイル11テスト合格（pcpGeometryTransition・pcpMissingGap・pointerSelection・graphExpansion）
- 実ブラウザ（5173）：
  - 1440×900・1920×1080で200フレーム追跡 distinct=1（振動なし）
  - viewport scroll＝client 一致（1624×770、1440幅では1144×590）
  - 1920幅での全点矩形選択 150件（座標・選択維持）
- `npm run build`：成功（6.94秒）
  - bundle `dist/assets/index-D2dZy7j0.js`（2,180,378 bytes、sha256 `57373d2b383a10032f152f490ee4b4a4c076a76fa7dd772aa7e88589692d570a`、build 2026-09-15 01:33 JST）
  - `http://127.0.0.1:8420/` が同bundleを200・同サイズ配信
- 前版の未実施事項（V07・V10・V11・V12一部）は本修正でも未実施のまま。テスト完了とは報告しない。

## G・X・Vへの影響

- G・X判定に変更なし
- V02（再マウント0）・V04（端到達）・V05（座標一致）の成立条件に変更なし。canvas の論理寸法・CTM由来の座標変換は維持

## レビュー指摘への対応

- 指摘「最大化でPCP全体が振動」→ 上記の1pxオーバーフロー遮断で対応
- 指摘「PCP縮小・他グラフ」→ REPORT-003で対応済み
- 指摘「2重スクロール」→ REPORT-002で対応済み
- 対応版：REPORT-004（本書）。最新版は本書を参照
