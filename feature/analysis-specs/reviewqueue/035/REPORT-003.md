# Feature 035 結果報告書（修正版 REPORT-003・最新版は REPORT-004.md を参照）

- Feature番号: 035（35→35a→35bの連続工程）
- 報告版: REPORT-003.md（最新版）
- 日時: 2026-09-15 00:55 JST
- branch: master
- HEAD: 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31
- 状態: 実装・検証済み／レビュー待ち（レビューOKは自己宣言しない）
- snapshot: `feature/audit-log/graph-expansion/source-hashes-3.txt`
- 前版: REPORT-002.md（2重スクロール解消）、REPORT.md（初版）

## 今回の修正内容と理由

PCPが小さく表示される問題と、他グラフの同種問題を検査・修正した。原因は2件の重なりである。

1. 共通hostが親の高さを引き継がず、内容高さ（intrinsic相当）に縮んでいた。`graphPanel.css` の host に `flex:1・height:100%` を付与し、親領域をすべて使うようにした。PCPは host 1144×232・viewport高200から host 1144×622・viewport高590・canvas同寸へ回復し、スクリーンショットで全領域描画を確認した。
2. 二重スクロール解消の過程で描画子側のスクロール容器を除去した際、固定寸法SVG（BarChart・FEDF・Loess）が viewport 幅いっぱいに広がらなくなった。各SVGに `viewBox＋width:100%・height:auto` を付与し、縦横比を保ったまま領域幅へ追従させた。BarChartは描画幅（PLOT_WIDTH 500→640）と右余白（240→120）も調整し、値バッジの見切れなく領域を有効利用する。HTMLテーブル（共分散等）は引き伸ばせないため中央寄せで見た目を改善した。

選択・集計・API・色分けの仕様変更なし。サンプルや表示対象の削減なし。

### 変更ファイル

- `features/common/graphPanel.css`：host の `flex:1・height:100%`
- `features/pcp/PcpPage.tsx`：共通 viewport への統合は維持（frameSize・スクロール取得元は共通 viewport）
- `features/barchart/BarChartPage.tsx`：SVGにviewBox＋幅追従、PLOT_WIDTH 640、MARGIN_RIGHT 120
- `features/fedf/FedfPage.tsx`：SVGにviewBox＋幅追従
- `features/loess/LoessPlotPage.tsx`：SVGにviewBox＋幅追従（重複viewBoxの除去含む）
- `features/covariance/CovariancePage.tsx`：表を中央寄せ

### 他グラフの検査結果

1440×900での実測（host×viewport×surface×内容）：

- pcp/main: 1144×622・590・590・590（全領域使用）
- relationships/heatmap・pair：host 566×447、viewport 420前後（2列配置のため。内容は行列・散布図の実寸）
- distribution/boxplot：host 1144×1677・viewport 1622（縦長は箱ひげ群の実寸。スクロールで全到達）
- barchart/main：host 1112×412・viewport 380（SVGは幅追従、3件の棒を全幅で表示）
- fedf/main：host 1112×482・viewport 450・SVG 653×433（5軸の実寸。幅追従で拡大）
- loess/main：host 1112×506・viewport 474・SVG 676×454（幅追従で拡大）
- covariance/matrix：host 1112×392・viewport 360・表483×436（中央寄せ）
- distribution/question：host 566×380・viewport 320（2列カード配置のため。内容220前後のカード実寸）
- models等の結果待ち図は生成後に同型（GraphPanel＋幅追従SVG）で領域を使用する

スクリーンショットでPCP・Relationships・BarChart・Covariance・FEDF・Loess・Distributionを確認した。FEDF/Loessの空表示スクリーンショットはデータセット未ロード時の初期表示であり、Irisロード後は描画を確認している。

## 再テスト・再build結果

- `npx tsc --noEmit`：成功
- `npm run test`：63ファイル258テスト全合格
- 内側スクロール0の再確認は前版の証拠を維持（今回のSVG幅追従は overflow に影響しない）
- `npm run build`：成功（8.22秒）
  - bundle `dist/assets/index-DpbGpzO0.js`（2,180,332 bytes、sha256 `045562dd5d0bf2cb48ac6859b8798948ac98bdad14d0b933b19ffaf079207a14`、build 2026-09-15 00:51 JST）
  - `http://127.0.0.1:8420/` が同bundleを200・同サイズ配信
- 前版の未実施事項（V07・V10・V11・V12一部）は本修正でも未実施のまま。テスト完了とは報告しない。

## G・X・Vへの影響

- G・X判定に変更なし
- V04・V05の成立条件（端到達・座標一致）に変更なし。PCPの回復によりV04の到達寸法は拡大した

## レビュー指摘への対応

- 指摘「PCPが小さく表示・他グラフも同様」→ 上記の領域回復・SVG幅追従・全件検査で対応
- 指摘「2重スクロール」→ REPORT-002で対応済み
- 対応版：REPORT-003（本書）。最新版は本書を参照
