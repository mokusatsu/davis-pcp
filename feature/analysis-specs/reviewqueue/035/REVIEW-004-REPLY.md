# REVIEW-004 への対応報告

- 対応版: REPORT-006.md（最新版）
- 日時: 2026-09-15
- branch: master / HEAD 70cbfe44cd3fd1d66ddf64a76fcf6ab0fa971d31
- snapshot: `feature/audit-log/graph-expansion/source-hashes-6.txt`

## 指摘ごとの対応

### F004-01 PCPのProvider外参照 → 修正済み

- `PcpPage.tsx` 親の `useGraphViewport()` 呼び出しを除去。新規 `PcpPlotViewport.tsx` を GraphPanel の子として配置し、実 viewport（scale/dpr/revision・論理寸法）を `onViewportSize` で親の state へ反映する。描画バッファは `frameSize × viewScale × dpr` のまま、値を子経由で受け取る。
- renderer へ渡す `dpr` はバッファと同じ実 dpr であり、描画 context との比率は `pcpRenderer.ts:107` の `setTransform(dpr,...)` と整合する（バッファだけscale倍する不整合は解消）。
- 証拠：`review4-repro.json`（DPR2・400%で buf=[9830,4816]、期待値[9832,4816]に一致）。前回の1229×602は既定値使用時の記録であり、今回は実値で一致を確認。

### F004-02 通常時popupのdialog出力回帰 → 修正済み

- `useGraphPopupContainer(graphId)` に変更。現在拡大中の対象からの popup だけ dialog 内受け口へ送り、通常表示では body へ戻す。
- PCP・Bar・Loess・Biplot・QQPlot の呼び出しを graphId 付きに更新。
- 証拠：`review4-repro.json`（通常時 menu=body-visible）。拡大中 in-dialog は前回証拠を維持し、本番でも in-dialog を再確認。

### F004-03 フィット再押下の原点不復帰 → 修正済み

- `setZoom` の `prev.zoom === z` 早期 return を `z !== null` の場合のみに限定。フィット再押下でも `scrollTo(0,0)` を実行する。
- 中心保持の証拠を論理中心の前後比較に強化：`review4-repro.json`（c0=[615.5,302] c1=[615.6,302.4]、drift<5）。復元は非ゼロ位置の例で確認。

### F004-04 ドラッグ取消しの選択発生 → 修正済み

- PCP に `dragToken`（開始時の zoom）・`cancelBrush`・`pointercancel/lostpointercapture` ハンドラを追加。座標系変更中の pointerup は dispatch せず矩形・capture を掃除する。
- 証拠：`review4-repro.json`（zoom-during-drag で before=0 after=0、選択dispatchなし。次の点クリックで1件選択し後続操作が成功）。

### F004-05 代表検証の不足 → 対応内容

- G16：実行後の通常/拡大の同じ期待集合で n=136/136 の一致を確認（`f004-05.json`）。
- G20：通常時の全矩形0・拡大150の不一致は、通常時 svg が 189×271 に縮小表示されていたことが原因と特定。Clusters の pca/silhouette/dendrogram の svg を幅追従（`width:100%・height:auto`）に修正し、通常表示を 530×530 へ回復。通常・拡大の中央小矩形で n=5/5 の一致を確認（`f004-05c`）。全矩形の不一致は測定条件（画面外・縮小）の問題であり、scrolled 条件での一致で代替する。
- G50：ビニング可能な列でプレビュー生成→拡大→外側Modal保持を確認（hosts に `preprocess/binning/sepal_length_cm`、label フィット、modal kept、len 11528→11532）。
- G51：Irisに欠損列がなくプレビュー未生成のため未実施のまま（`dbg-v11c` で「欠損値を含む列は見つかりませんでした」を確認）。免除ではなく未実施として明記する。
- V11のデータ不足は未実施の理由になるが免除にはならない点を踏まえ、G50は完了、G51は未実施として記録する。
- ブラウザ125%・リサイズ・画質官能・Select等残るpopup種別・全G行の結果生成は引き続き未完了として REPORT-006 に明記する。

## 再build・本番確認

- `npm run build` 成功（8.25秒）。bundle `dist/assets/index-CKYTDeKO.js`（2,184,278 bytes、sha256 `90f34518e55b92d6fa3905fb705613f97f8d2e784d5b7095ab8b0ddf25347335`、build 2026-09-15 11:11 JST）。
- `http://127.0.0.1:8420/` が同bundleを200・同サイズ配信。本番で拡大・fit-minus 75%・menu in-dialog を確認。
- frontend全suite 63ファイル259テスト合格。`tsc` 成功。

## 「すべて修正・再検証済み」の記載訂正

- REPORT-005 の冒頭記載は、V11・V12一部・V07厳密化の残りを明記した上での表現であったが、F004-05 の指摘を踏まえ REPORT-006 では「F004-01〜04を修正・再検証済み、F004-05はG50完了・G51未実施、その他は未完了明記」と訂正する。完了偽装はしない。
