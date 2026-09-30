# Feature 035 結果報告書（修正版 REPORT-002・最新版は REPORT-003.md を参照）

- Feature番号: 035（35→35a→35bの連続工程）
- 報告版: REPORT-002.md（REPORT.mdの最新版）
- 日時: 2026-09-15 00:15 JST
- branch: master
- HEAD: 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31
- 状態: 実装・検証済み／レビュー待ち（レビューOKは自己宣言しない）
- snapshot: `feature/audit-log/graph-expansion/source-hashes-2.txt`（今回修正分の対象ソースhash・bundle hash）
- 前版: REPORT.md（初版 2026-09-14 23:55 JST）

## 今回の修正内容と理由

2重スクロール（共通 viewport と描画子側スクロール容器の併存）の指摘を受け、全GraphPanelを検査し解消した。共通 viewport を唯一のスクロール容器とし、描画子側の `overflow:auto/scroll` を除去した。選択・集計・API・色分けの仕様変更なし。サンプルや表示対象の削減なし。

### 検査結果

- 通常時（1440×900）：内側スクロール付きパネル5件
  - pcp/main（plot-frame）、relationships/heatmap（行列ラッパー）、barchart/main、fedf/main、covariance/matrix
- 拡大400%時も同5件のみ。他の46行に内側スクロール容器なし（`dblscroll-all.json`）
- 内側スクロールが必要な長い図（Clustersシルエット・デンドロ・Cobweb・DISC・Ranking棒・Mosaic等）は `maxHeight` 制限ごと除去し、共通 extent のスクロールへ統合した

### 変更ファイル

- `features/common/graphPanel.css`：surface配下の div/table の overflow を visible へ統一（controls・popup対象外）
- `features/pcp/PcpPage.tsx`：plot-frame / plot-canvas-area を overflow:visible 化。frameSize・スクロールオフセットの取得元を共通 viewport（`graph-viewport-*`）へ切替。plot-frame 自体のスクロールリスナーを共通 viewport のリスナーへ変更
- `features/barchart/BarChartPage.tsx`、`features/covariance/CovariancePage.tsx`、`features/fedf/FedfPage.tsx`、`features/relationships/RelationshipsPage.tsx`、`features/distribution/DistributionPage.tsx`、`features/models/ModelsPage.tsx`（決定木ラッパー）、`features/mosaic/LineMosaicCanvas.tsx`、`features/clustering/ClustersPage.tsx`（シルエット・デンドロ）、`features/clustering/CobwebTreeViewer.tsx`、`features/clustering/DiscCategoryMatrix.tsx`、`features/mining/FeatureRankingPage.tsx`、`features/models/DiscriminantAnalysisPage.tsx`（1D負荷量）、`features/models/LogisticRegressionPage.tsx`（フォレスト）、`features/relationships/SurpriseAssociationView.tsx`（ヒートマップCard）：内側 `overflow:auto/scroll`＋`maxHeight` 制限を除去し共通スクロールへ統合
- 対象外：ページ本体・Modal・凡例・Tooltip・Select・表操作のスクロールは維持

### PCPの扱い

PCPは仮想寸法＋可視窓の設計（canvas上限回避）のため、当初は内部スクロール維持を検討したが、最終的には共通 viewport へ統合した。frameSizeは共通 viewport の実寸、スクロールオフセット（viewportX/Y相当）は共通 viewport の scrollLeft/Topから取得し、描画・座標変換は従来通り。canvas上限のための仮想化・タイル描画の考え方は維持し、データ削減は行っていない。

## 再テスト・再build結果

- `npx tsc --noEmit -p fullstack/frontend/tsconfig.json`：成功
- `npm --prefix fullstack/frontend run test`：63ファイル258テスト全合格
- 二重スクロール検証（`dblscroll-verify.json` 25/25、 devoted 拡大400% `dblscroll-exp2.json` 16/16）：
  - 通常時（wide/narrow）12ルート：内側スクロール0
  - 拡大400%（wide/narrow）：内側スクロール0、端到達OK（例：wide pcp sl4150×st2308、heatmap sl4787×st2528、barchart sl4243×st1935、fedf sl3340×st2483、cov sl3235×st2949）
  - G03全点矩形：通常150＝拡大150でrowId一致
- `npm --prefix fullstack/frontend run build`：成功（8.70秒）
  - bundle `dist/assets/index-C_EZdJlJ.js`（2,180,136 bytes、sha256 `d49373e549b8e614ed329cb3aeb547725cfe3a7c4fe3004dd39336f85a2670a1`、build 2026-09-15 00:12 JST）
  - `http://127.0.0.1:8420/` が同bundleを200・同サイズ配信。本番で pcp/heatmap/barchart の内側スクロール0・拡大を確認（dblscroll-prod）
- 前版の未実施事項（V07・V10・V11・V12一部）は本修正でも未実施のまま。テスト完了とは報告しない。

## G・X・Vへの影響

- G01〜G51・X01〜X12の判定に変更なし（前版REPORT.mdの表を維持）
- V04（端への到達）は今回の再検証で代表7図の400%到達を追加確認。V05はG03の一致を再確認
- 既知の制限（G16/G20の既存由来0件挙動等）に変更なし

## レビュー指摘への対応

- 指摘「2重スクロール多数」→ 上記の全件検査・解消・再テスト・再build・本番確認で対応
- 対応版：REPORT-002（本書）。最新版は本書を参照
